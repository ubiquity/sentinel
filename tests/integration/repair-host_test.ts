/**
 * Wave C host-assembly seam tests: the trusted repair host composition
 * factory (`src/host/repair.ts`).
 *
 * Covered:
 * - instance identity: the composed GatewayReplayComposition is exactly the
 *   IncidentAdapter AND the fixture-identity source, the ReplayPortImpl is
 *   constructed with that exact composition as its fixture resolver, and the
 *   model/budget capabilities are the concrete module instances.
 * - host-boundary identity: the controller SHA must be an exact lowercase
 *   40-hex commit SHA; malformed values (including secret-like markers) are
 *   rejected with one static non-echoing TypeError before any capability is
 *   constructed, with no state/store/transport/model capability touched.
 * - static fail-closed rejection: an invalid config set, an invalid gateway
 *   repository identity, an unconfigured repository and an ambiguous match
 *   are rejected with static TypeError text before any instance exists.
 * - preserved trust boundaries: the replay isolation capability is still
 *   required, the model receipt stays unavailable without a host verifier
 *   (no session is ever opened), the missing gateway index stays a source
 *   fault, and direct execution of the repair entrypoint stays a static
 *   fault.
 * - an idle no-inference run through `runRepairEntrypoint` with the REAL
 *   GitStateStore over a disposable local remote and credential-free fake
 *   gateway transports.
 *
 * No network, no model call, no credentials, no GitHub writes, no
 * deployment; every state/transport interaction is local and disposable.
 */
import assert from "node:assert/strict";

import { RollingStartBudget } from "../../src/budget/mod.ts";
import type {
  CommandId,
  GitSha,
  WorkItemId,
} from "../../src/contracts/brands.ts";
import type { ModelRunRequestV1 } from "../../src/contracts/ports.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import { GatewayReplayComposition } from "../../src/adapters/gateway/replay-composition.ts";
import type { ArtifactStoreV1 } from "../../src/adapters/gateway/store.ts";
import {
  composeRepairHost,
  type RepairHostOptionsV1,
} from "../../src/host/repair.ts";
import { runRepairEntrypoint } from "../../src/main.ts";
import { markerProofParser } from "../../src/replay/fixture.ts";
import {
  ReplayPortImpl,
  type ReplayPortOptions,
} from "../../src/replay/port.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { CodexImplementationPort } from "../../src/repair/model-port.ts";
import type {
  CodexServerNotificationV1,
  CodexSessionV1,
} from "../../src/repair/codex-transport.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import type { RepairGitStateStore } from "../../src/state/mod.ts";
import {
  FakeClock,
  FakeGithub,
  gatewayAuth,
  type IntegrationCtxV1,
  makeIntegrationCtx,
  repairConfigs,
  REPO,
  SHA1,
  SHA3,
  T0,
} from "./helpers.ts";
import {
  jsonResponse,
  makeIndexPage,
  recordingTransport,
} from "../adapters/gateway/helpers.ts";

const GATEWAY_COMMAND = "replay_capture" as CommandId;
const TEST_IDS = ["repair:host-regression"] as const;
const EXPECTED_FAILURE = {
  reason: "fixture reproduced the recorded upstream failure",
  match: { kind: "contains" as const, text: "upstream terminated" },
};
const UNVERIFIED_RECEIPT_DETAIL =
  "model receipt unavailable: actual provider model/effort could not be verified at this boundary";
const REPLAY_ISOLATION_DETAIL =
  "ReplayPort requires an injected trusted isolation capability " +
  "attesting restricted execution on the host (clearEnv is not a " +
  "sandbox; target-controlled commands need the restricted host)";

/** In-memory store that must never be touched by these tests. */
class CountingStore implements ArtifactStoreV1 {
  readonly limits = {
    totalMaxBytes: 1_000_000,
    artifactMaxBytes: 100_000,
    retentionMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
  };
  calls: string[] = [];

  put(): Promise<never> {
    this.calls.push("put");
    return Promise.reject(new Error("store must not be used in these tests"));
  }

  get(): Promise<never> {
    this.calls.push("get");
    return Promise.reject(new Error("store must not be used in these tests"));
  }

  listByIncident(): Promise<never> {
    this.calls.push("listByIncident");
    return Promise.reject(new Error("store must not be used in these tests"));
  }

  stats(): Promise<never> {
    this.calls.push("stats");
    return Promise.reject(new Error("store must not be used in these tests"));
  }
}

/**
 * A durable-state wrapper that counts every capability call. A rejected host
 * composition must never touch the repair state store (neither read, write
 * nor budget step), so these counters stay empty.
 */
function spyState(inner: RepairGitStateStore): {
  state: RepairGitStateStore;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    state: {
      readRepair: (...args: Parameters<RepairGitStateStore["readRepair"]>) => {
        calls.push("readRepair");
        return inner.readRepair(...args);
      },
      readRelease: (
        ...args: Parameters<RepairGitStateStore["readRelease"]>
      ) => {
        calls.push("readRelease");
        return inner.readRelease(...args);
      },
      writeRepair: (
        ...args: Parameters<RepairGitStateStore["writeRepair"]>
      ) => {
        calls.push("writeRepair");
        return inner.writeRepair(...args);
      },
    },
  };
}

/** A fully valid host capability set; tests override individual fields. */
interface HostFixtureV1 {
  ctx: IntegrationCtxV1;
  options: RepairHostOptionsV1;
  transport: ReturnType<typeof recordingTransport>;
  gatewayStore: CountingStore;
  github: FakeGithub;
  sessionCalls(): number;
  cleanup(): Promise<void>;
}

async function makeHostFixture(
  responder?: (url: URL) => Response | Promise<Response>,
): Promise<HostFixtureV1> {
  const ctx = await makeIntegrationCtx("host-repair");
  const clock = new FakeClock(T0);
  const state = createRepairStateStore({
    scratchDir: `${ctx.tmp}/scratch-repair`,
    remoteUrl: ctx.remoteUrl,
  });
  const github = new FakeGithub({ baseSha: SHA1 });
  const gatewayStore = new CountingStore();
  const transport = recordingTransport(
    responder ??
      (() => jsonResponse(makeIndexPage([], null, { status: "complete" }))),
  );
  let openedSessions = 0;
  const options: RepairHostOptionsV1 = {
    configs: repairConfigs({ liveStartLimits: null, sessionBound: null }),
    controllerSha: SHA1,
    clock,
    state,
    github,
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    gateway: {
      repository: REPO,
      transport,
      auth: gatewayAuth(),
      store: gatewayStore,
      keyBytes: new Uint8Array(32),
      policy: {
        publicModels: ["gpt-5.6-luna"],
        publicHeaders: { authorization: ["Bearer synthetic-token"] },
      },
      commandId: GATEWAY_COMMAND,
      testIds: TEST_IDS,
      expectedFailure: EXPECTED_FAILURE,
    },
    replay: {
      source: { kind: "local", path: `${ctx.tmp}/replay-source` },
      scratchDir: `${ctx.tmp}/replay-scratch`,
      policy: {
        bundleScopes: ["tests/"],
        maxFixtureBytes: 512 * 1024,
        maxEntryBytes: 256 * 1024,
        proof: markerProofParser(),
      },
      isolation: {
        attestation: {
          version: "v1",
          host: "harness",
          restrictedExecution: true,
          boundary: "bounded test host",
          attestationRef: "attestation://harness/v1",
        },
      },
    },
    model: {
      openSession: () => {
        openedSessions += 1;
        return Promise.reject(new Error("no live Codex session in host tests"));
      },
      checkoutDir: `${ctx.tmp}/model-checkout`,
    },
  };
  return {
    ctx,
    options,
    transport,
    gatewayStore,
    github,
    sessionCalls: () => openedSessions,
    cleanup: () => ctx.cleanup(),
  };
}

/** A helper that leaves the isolation attestation without real restricted execution. */
function unverifiedIsolation(): RepairHostOptionsV1["replay"]["isolation"] {
  return {
    attestation: {
      version: "v1",
      host: "harness",
      restrictedExecution: false,
      boundary: "clearEnv only",
      attestationRef: "attestation://harness/unrestricted",
    },
  };
}

/**
 * In-process fake Codex session that acknowledges the requested provider/
 * model/effort exactly and emits genuine correlated output before a completed
 * terminal (mirrors the real app-server event order).
 */
class HostAckSession implements CodexSessionV1 {
  readonly sent: { method: string; params: unknown }[] = [];
  closeCalls = 0;
  private notifications:
    | ((event: CodexServerNotificationV1) => void)
    | null = null;
  private turnStarted = false;

  open(): void {}

  send(method: string, params: unknown): Promise<unknown> {
    this.sent.push({ method, params });
    switch (method) {
      case "initialize":
        return Promise.resolve({ userAgent: "codex-app-server/0.153.4" });
      case "thread/start":
        return Promise.resolve({
          thread: { id: "thread-1" },
          model: "gpt-5.6-luna",
          reasoningEffort: "max",
          modelProvider: "sentinel-host",
        });
      case "turn/start":
        this.turnStarted = true;
        return Promise.resolve({ turn: { id: "turn-1" } });
      case "turn/interrupt":
        return Promise.resolve({});
      default:
        return Promise.resolve({});
    }
  }

  notify(): void {}

  onServerRequest(): void {}

  onNotification(handler: (event: CodexServerNotificationV1) => void): void {
    this.notifications = handler;
    if (this.turnStarted) {
      queueMicrotask(() => {
        this.notifications?.({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "ok-output",
              type: "fileChange",
              status: "completed",
              changes: [{
                path: "src/app.ts",
                kind: { type: "update" },
                diff:
                  "@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n",
              }],
            },
          },
        });
        this.notifications?.({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", durationMs: 5 },
          },
        });
      });
    }
  }

  close(): Promise<void> {
    this.closeCalls++;
    return Promise.resolve();
  }
}

Deno.test(
  "host factory: preserves exact instance identity of every composed capability",
  async () => {
    const fixture = await makeHostFixture();
    try {
      const deps = composeRepairHost(fixture.options);
      // The composition is BOTH the IncidentAdapter handed to the loop and
      // the fixture-identity source: one exact instance, not two adapters.
      assert.ok(deps.incidents instanceof GatewayReplayComposition);
      assert.equal(deps.fixtureIdentities, deps.incidents);
      // The replay port is the concrete implementation and its fixture
      // resolver is that exact composition instance.
      assert.ok(deps.replay instanceof ReplayPortImpl);
      assert.equal(
        (deps.replay as unknown as { options: ReplayPortOptions }).options
          .fixtures,
        deps.incidents,
      );
      // The replay port is configured with the matched repository config.
      assert.deepEqual(
        (deps.replay as unknown as { options: ReplayPortOptions }).options
          .config.repository,
        REPO,
      );
      // Model and budget are the concrete module instances, and the shared
      // capability fields pass through unchanged.
      assert.ok(deps.model instanceof CodexImplementationPort);
      assert.ok(deps.budget instanceof RollingStartBudget);
      assert.equal(deps.clock, fixture.options.clock);
      assert.equal(deps.state, fixture.options.state);
      assert.equal(deps.github, fixture.options.github);
      assert.equal(deps.githubCooldown, fixture.options.githubCooldown);
      assert.equal(deps.controllerSha, SHA1);
      assert.equal(deps.configs.length, 1);
      assert.deepEqual(deps.configs[0].repository, REPO);
      // The factory constructs no transport, store or session itself.
      assert.equal(fixture.transport.requests.length, 0);
      assert.deepEqual(fixture.gatewayStore.calls, []);
      assert.equal(fixture.sessionCalls(), 0);
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "host factory: rejects invalid configs and repository mismatch with static TypeErrors before construction",
  async () => {
    const fixture = await makeHostFixture();
    try {
      const poisonIsolation = unverifiedIsolation();
      // 1. A config that fails the frozen parser is rejected before any
      //    instance construction (even the invalid isolation input is never
      //    reached).
      const invalidConfig = {
        ...fixture.options.configs[0],
        repository: null,
      } as unknown as RepositoryConfigV1;
      assert.throws(
        () =>
          composeRepairHost({
            ...fixture.options,
            configs: [invalidConfig],
            replay: {
              ...fixture.options.replay,
              isolation: poisonIsolation,
            },
          }),
        {
          name: "TypeError",
          message:
            "repair host configuration rejected: a repository configuration is invalid",
        },
      );
      // 2. An invalid gateway repository identity is rejected statically.
      assert.throws(
        () =>
          composeRepairHost({
            ...fixture.options,
            gateway: {
              ...fixture.options.gateway,
              repository: {
                owner: "ubiquity",
                name: "ai.ubq.fi",
                installationId: 0,
              },
            },
            replay: {
              ...fixture.options.replay,
              isolation: poisonIsolation,
            },
          }),
        {
          name: "TypeError",
          message:
            "repair host configuration rejected: the gateway adapter repository identity is invalid",
        },
      );
      // 3. A well-formed repository that is not among the configured set is
      //    rejected before construction (the same installation-id identity
      //    rule: a different installation is a different repository scope).
      const unconfigured: RepositoryIdentityV1 = {
        owner: "ubiquity",
        name: "ai.ubq.fi",
        installationId: 999,
      };
      assert.throws(
        () =>
          composeRepairHost({
            ...fixture.options,
            gateway: { ...fixture.options.gateway, repository: unconfigured },
            replay: {
              ...fixture.options.replay,
              isolation: poisonIsolation,
            },
          }),
        {
          name: "TypeError",
          message:
            "repair host configuration rejected: the gateway adapter repository is not among the configured repositories",
        },
      );
      // 4. A duplicated configured repository identity is an ambiguous match
      //    and is rejected instead of silently choosing one.
      assert.throws(
        () =>
          composeRepairHost({
            ...fixture.options,
            configs: [...fixture.options.configs, fixture.options.configs[0]],
          }),
        {
          name: "TypeError",
          message:
            "repair host configuration rejected: the gateway adapter repository matches more than one configured repository",
        },
      );
      // None of the rejected compositions touched the transport or the store.
      assert.equal(fixture.transport.requests.length, 0);
      assert.deepEqual(fixture.gatewayStore.calls, []);
      assert.equal(fixture.sessionCalls(), 0);
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "host factory: rejects malformed controllerSha before any capability construction with one static non-echoing TypeError",
  async () => {
    const fixture = await makeHostFixture();
    try {
      const stateSpy = spyState(fixture.options.state);
      // Malformed controller identities: uppercase hex, wrong lengths (39/41
      // and a SHA-256 digest-shaped 64), a non-hex character, values carrying
      // a secret-like marker, and non-string input. None is an exact
      // lowercase 40-hex commit SHA.
      const malformedShas: unknown[] = [
        "A".repeat(40),
        SHA1.toUpperCase(),
        "f".repeat(39),
        "f".repeat(41),
        "f".repeat(64),
        `z${"f".repeat(39)}`,
        "ghp_0123456789abcdef0123456789abcdef012345",
        "authorization: Bearer 0123456789abcdef0123456789abcdef",
        0x1234,
        null,
      ];
      for (const controllerSha of malformedShas) {
        // The poison isolation would throw its own TypeError if any instance
        // were constructed first; the controllerSha reject must win.
        assert.throws(
          () =>
            composeRepairHost({
              ...fixture.options,
              controllerSha: controllerSha as GitSha,
              state: stateSpy.state,
              replay: {
                ...fixture.options.replay,
                isolation: unverifiedIsolation(),
              },
            }),
          {
            name: "TypeError",
            message:
              "repair host configuration rejected: controller SHA is not an exact lowercase 40-hex commit SHA",
          },
        );
      }
      // The reject is static: its text never echoes the supplied value,
      // including a secret-like marker.
      const secretLike = "ghp_0123456789abcdef0123456789abcdef012345";
      let secretError: unknown;
      try {
        composeRepairHost({
          ...fixture.options,
          controllerSha: secretLike as GitSha,
        });
        assert.fail("expected a static TypeError for the secret-like marker");
      } catch (error) {
        secretError = error;
      }
      assert.ok(secretError instanceof TypeError);
      const secretMessage = (secretError as TypeError).message;
      assert.equal(
        secretMessage,
        "repair host configuration rejected: controller SHA is not an exact lowercase 40-hex commit SHA",
      );
      assert.ok(
        !secretMessage.includes(secretLike),
        `reject text echoes the supplied value: ${secretMessage}`,
      );
      assert.ok(
        !secretMessage.includes("ghp_"),
        `reject text echoes a secret-like marker: ${secretMessage}`,
      );
      // No capability was constructed or touched: no transport request, no
      // gateway store call, no durable state read/write and no model session.
      assert.equal(fixture.transport.requests.length, 0);
      assert.deepEqual(fixture.gatewayStore.calls, []);
      assert.deepEqual(stateSpy.calls, []);
      assert.equal(fixture.sessionCalls(), 0);
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "host factory: replay isolation requirement is preserved (target commands cannot run without it)",
  async () => {
    const fixture = await makeHostFixture();
    try {
      assert.throws(
        () =>
          composeRepairHost({
            ...fixture.options,
            replay: {
              ...fixture.options.replay,
              isolation: unverifiedIsolation(),
            },
          }),
        {
          name: "TypeError",
          message: REPLAY_ISOLATION_DETAIL,
        },
      );
      // Nothing was constructed for the rejected composition either.
      assert.equal(fixture.sessionCalls(), 0);
      assert.deepEqual(fixture.gatewayStore.calls, []);
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "host factory: model receipt stays unavailable without a host verifier and no session opens",
  async () => {
    const fixture = await makeHostFixture();
    try {
      const deps = composeRepairHost(fixture.options);
      const request: ModelRunRequestV1 = {
        taskId: "host-repair-1" as WorkItemId,
        repository: REPO,
        base: SHA1,
        issue: null,
        evidence: [],
        model: "gpt-5.6-luna",
        reasoning: "max",
        maxDurationMs: 5_000,
        maxOutputChars: 1_000,
      };
      const result = await deps.model.runModel(request);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.error.kind, "unavailable");
      assert.equal(result.error.detail, UNVERIFIED_RECEIPT_DETAIL);
      // The fail-closed receipt check happens before any session work: the
      // poison openSession was never called and no model receipt was claimed.
      assert.equal(fixture.sessionCalls(), 0);
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "host factory: a custom verifier never enables a missing model provider and no session opens",
  async () => {
    const fixture = await makeHostFixture();
    try {
      const deps = composeRepairHost({
        ...fixture.options,
        model: {
          ...fixture.options.model,
          // A verifier callback is only an ADDITIONAL restriction after the
          // concrete core request/runtime checks; without an explicit
          // modelProvider the port stays unavailable BEFORE any session opens.
          receiptVerifier: () => ({
            provider: "sentinel-host",
            observedModel: "gpt-5.6-luna",
            observedReasoning: "max",
          }),
        },
      });
      const request: ModelRunRequestV1 = {
        taskId: "host-repair-2" as WorkItemId,
        repository: REPO,
        base: SHA1,
        issue: null,
        evidence: [],
        model: "gpt-5.6-luna",
        reasoning: "max",
        maxDurationMs: 5_000,
        maxOutputChars: 1_000,
      };
      const result = await deps.model.runModel(request);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.error.kind, "unavailable");
      assert.equal(result.error.detail, UNVERIFIED_RECEIPT_DETAIL);
      // The provider gate happens before any session work: the poison
      // openSession was never called.
      assert.equal(fixture.sessionCalls(), 0);
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "host factory: selected provider constructs the concrete request/runtime producer",
  async () => {
    const fixture = await makeHostFixture();
    try {
      const session = new HostAckSession();
      const deps = composeRepairHost({
        ...fixture.options,
        model: {
          ...fixture.options.model,
          // A selected provider with NO injected verifier must construct the
          // real request/runtime receipt producer inside the port.
          modelProvider: "sentinel-host",
          openSession: () => Promise.resolve(session),
          // The in-process fake session produces no real worktree, so the
          // deterministic candidate identity comes from the checkout resolver
          // and the commit step is acknowledged (same seam as the composed
          // lifecycle fixture).
          commitCandidate: { commit: () => Promise.resolve(true) },
          checkout: {
            resolve: () =>
              Promise.resolve({
                head: SHA3,
                checkpointSha: null,
                changedPaths: ["src/app.ts"],
              }),
          },
        },
      });
      const result = await deps.model.runModel({
        taskId: "host-runtime-receipt" as WorkItemId,
        repository: REPO,
        base: SHA1,
        issue: null,
        evidence: [],
        model: "gpt-5.6-luna",
        reasoning: "max",
        maxDurationMs: 5_000,
        maxOutputChars: 10_000,
      });
      assert.ok(result.ok, JSON.stringify(result));
      if (!result.ok) return;
      assert.equal(result.value.outcome, "completed");
      assert.equal(result.value.candidate?.head, SHA3);
      assert.equal(result.value.actual.evidenceKind, "request-runtime");
      assert.equal(result.value.actual.provider, "sentinel-host");
      assert.equal(result.value.actual.threadId, "thread-1");
      assert.equal(result.value.actual.turnId, "turn-1");
      assert.equal(result.value.actual.terminalOrigin, "runtime");
      assert.equal(result.value.actual.observedTerminalStatus, "completed");
      assert.equal(result.value.actual.observedModel, "gpt-5.6-luna");
      assert.equal(result.value.actual.observedReasoning, "max");
      assert.equal(session.closeCalls, 1);
      const threadStart = session.sent.find(
        (frame) => frame.method === "thread/start",
      );
      assert.ok(threadStart, "thread/start was sent");
      assert.equal(
        (threadStart?.params as Record<string, unknown>).modelProvider,
        "sentinel-host",
        "the composed host submits the selected provider explicitly on thread/start",
      );
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "host composition: idle no-inference run through runRepairEntrypoint with real Git state",
  async () => {
    const fixture = await makeHostFixture();
    try {
      const deps = composeRepairHost(fixture.options);
      const outcome = await runRepairEntrypoint(deps, {
        deadline: fixture.options.clock.now() + 600_000,
        stepLimit: 16,
      });
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      // The durable repair branch was seeded exactly once; no inference, no
      // sessions, no model budget reservation.
      const read = await deps.state.readRepair();
      assert.ok(read.ok);
      if (!read.ok) return;
      assert.equal(read.value.status, "found");
      if (read.value.status !== "found") return;
      assert.equal(read.value.snapshot.sequence, 1);
      assert.equal(read.value.snapshot.reservations.length, 0);
      assert.equal(fixture.sessionCalls(), 0);
      assert.deepEqual(fixture.gatewayStore.calls, []);
      // The gateway index was read once, as a read-only authenticated GET
      // (no claim/ack/defer endpoint and never a write).
      assert.equal(fixture.transport.requests.length, 1);
      fixture.transport.assertReadOnly(["/admin/sentinel/incidents"]);
      fixture.transport.assertNoWriteEndpoints();
      // No GitHub publication path was exercised.
      assert.ok(
        fixture.github.calls.every((call) =>
          call === "listOpenIssues" || call.startsWith("readRef:")
        ),
        `unexpected github calls: ${fixture.github.calls.join(", ")}`,
      );
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "host composition: missing gateway index stays fail-closed (source_error, no inference)",
  async () => {
    const fixture = await makeHostFixture(
      () => new Response(null, { status: 404 }),
    );
    try {
      const deps = composeRepairHost(fixture.options);
      const outcome = await runRepairEntrypoint(deps, {
        deadline: fixture.options.clock.now() + 600_000,
        stepLimit: 16,
      });
      // A missing producer index is a typed source fault, never an empty
      // successful page; the run reports the fail-closed source error.
      assert.equal(outcome.status, "source_error", JSON.stringify(outcome));
      if (outcome.status !== "source_error") return;
      assert.equal(outcome.detail, "incident source unavailable: unavailable");
      // No inference and no fabricated fixture followed the source fault.
      assert.equal(fixture.sessionCalls(), 0);
      assert.deepEqual(fixture.gatewayStore.calls, []);
      fixture.transport.assertNoWriteEndpoints();
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "direct repair entrypoint execution stays a static fail-closed fault",
  async () => {
    // The host factory ships no capability wiring: executing src/main.ts
    // directly must still terminate with the static fault, and the repository
    // must never present a live activation path.
    const command = new Deno.Command("deno", {
      args: ["run", "--quiet", "src/main.ts"],
      cwd: Deno.cwd(),
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    assert.notEqual(result.code, 0);
    const output = new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr);
    assert.ok(
      output.includes("requires injected trusted capabilities"),
      `unexpected direct-execution output: ${output}`,
    );
  },
);
