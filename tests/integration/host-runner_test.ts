/**
 * Wave C trusted-host RUNNER seam tests (`src/host/run.ts`): the typed
 * wrappers that compose the host factories and then invoke the real injected
 * production entrypoints.
 *
 * Covered:
 * - the repair runner reaches the existing idle path through
 *   `runComposedRepairHost` with the real host factory, a disposable local
 *   Git remote and fake gateway transports: no model session, no gateway
 *   store write, no outbound write endpoint.
 * - a missing producer index is still a typed source fault through the
 *   runner, with no inference and no fabricated fixture.
 * - the release runner uses the production unavailable-resolver default
 *   through `runComposedReleaseHost`: the controller waits, performs no Deno
 *   platform call and no promotion, and creates no release record.
 * - both wrappers pass the exact injected clock/state/transport through to
 *   the entrypoints: identity is proven indirectly through the observable
 *   effects of the injected instances (request records + auth header,
 *   state snapshot timestamps/sequence through the injected store, read-only
 *   GitHub call list) and by trace equivalence with the direct
 *   compose+entrypoint path on identical injected capabilities.
 *
 * Direct entrypoint fail-closed execution stays covered by the existing
 * repair-host test (an actual `deno run src/main.ts` must still fail closed);
 * no model call, no network, no credentials, no GitHub write, no deployment.
 */
import assert from "node:assert/strict";

import type { CommandId } from "../../src/contracts/brands.ts";
import type { PortResultV1 } from "../../src/contracts/ports.ts";
import type { ArtifactStoreV1 } from "../../src/adapters/gateway/store.ts";
import type { RepairHostOptionsV1 } from "../../src/host/repair.ts";
import { composeRepairHost } from "../../src/host/repair.ts";
import type { ReleaseHostOptionsV1 } from "../../src/host/release.ts";
import { composeReleaseHost } from "../../src/host/release.ts";
import {
  runComposedReleaseHost,
  runComposedRepairHost,
} from "../../src/host/run.ts";
import { runRepairEntrypoint } from "../../src/main.ts";
import { runReleaseEntrypoint } from "../../src/release-main.ts";
import { markerProofParser } from "../../src/replay/fixture.ts";
import { toyIsolation } from "../replay/helpers.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import {
  FakeClock,
  FakeGithub,
  gatewayAuth,
  makeIntegrationCtx,
  repairConfigs,
  REPO,
  SHA1,
  T0,
} from "./helpers.ts";
import {
  jsonResponse,
  makeIndexPage,
  recordingTransport,
} from "../adapters/gateway/helpers.ts";
import {
  asTransport,
  publishRepairRequest,
  requestFor,
  ScriptedTransport,
  stabilityPolicy,
  storeAt,
  T0 as RELEASE_T0,
  targetConfig,
  TestClock,
} from "../release/helpers.ts";

const GATEWAY_COMMAND = "replay_capture" as CommandId;
const TEST_IDS = ["repair:host-runner-regression"] as const;
const EXPECTED_FAILURE = {
  reason: "fixture reproduced the recorded upstream failure",
  match: { kind: "contains" as const, text: "upstream terminated" },
};

/** In-memory gateway store that must never be written by these tests. */
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

interface RepairRunnerFixtureV1 {
  clock: FakeClock;
  options: RepairHostOptionsV1;
  transport: ReturnType<typeof recordingTransport>;
  gatewayStore: CountingStore;
  github: FakeGithub;
  sessionCalls(): number;
  cleanup(): Promise<void>;
}

/**
 * One real-host repair capability set over a disposable local Git remote and
 * a fake gateway transport (the same real factories the entrypoint consumes).
 */
async function makeRepairRunnerFixture(
  responder?: (url: URL) => Response | Promise<Response>,
  clockStart = T0,
): Promise<RepairRunnerFixtureV1> {
  const ctx = await makeIntegrationCtx("host-runner-repair");
  const clock = new FakeClock(clockStart);
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
      isolation: toyIsolation(),
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
    clock,
    options,
    transport,
    gatewayStore,
    github,
    sessionCalls: () => openedSessions,
    cleanup: () => ctx.cleanup(),
  };
}

interface ReleaseRunnerFixtureV1 {
  clock: TestClock;
  transport: ScriptedTransport;
  store: ReturnType<typeof storeAt>;
  denoAuthCalls(): number;
  options: ReleaseHostOptionsV1;
}

/**
 * One real-host release capability set over a disposable local Git remote
 * that already carries one open release request (published through a DIFFERENT
 * store instance over the same remote), and a recording Deno transport.
 */
async function makeReleaseRunnerFixture(): Promise<
  ReleaseRunnerFixtureV1 & { cleanup(): Promise<void> }
> {
  const ctx = await makeIntegrationCtx("host-runner-release");
  await publishRepairRequest(ctx, requestFor("release-request-runner-0001"));
  const config = targetConfig();
  const transport = new ScriptedTransport(config);
  const clock = new TestClock(RELEASE_T0);
  const store = storeAt(ctx, "runner-release", "release");
  let authCalls = 0;
  const options: ReleaseHostOptionsV1 = {
    clock,
    stateRead: store,
    stateWrite: store,
    repository: REPO,
    environment: "production",
    target: config,
    policy: stabilityPolicy(),
    deno: {
      transport: asTransport(transport),
      auth: {
        bearerToken: (): Promise<PortResultV1<string>> => {
          authCalls += 1;
          return Promise.resolve(
            { ok: true, value: "synthetic-token" } as const,
          );
        },
      },
    },
  };
  return {
    clock,
    transport,
    store,
    denoAuthCalls: () => authCalls,
    options,
    cleanup: () => ctx.cleanup(),
  };
}

/** The observable idle-path trace of one repair runner entrypoint run. */
async function assertIdleRepairTrace(
  fixture: RepairRunnerFixtureV1,
  clockStart: number,
): Promise<void> {
  const outcome = await runRepairEntrypoint(
    composeRepairHost(fixture.options),
    { deadline: fixture.clock.now() + 600_000, stepLimit: 16 },
  );
  assert.equal(outcome.status, "idle", JSON.stringify(outcome));
  assert.equal(fixture.sessionCalls(), 0, "no model session was opened");
  assert.deepEqual(fixture.gatewayStore.calls, [], "no gateway store write");
  const read = await fixture.options.state.readRepair();
  assert.ok(read.ok && read.value.status === "found", JSON.stringify(read));
  if (!read.ok || read.value.status !== "found") return;
  assert.equal(read.value.snapshot.sequence, 1, "one durable seed transition");
  assert.equal(
    read.value.snapshot.updatedAt,
    clockStart,
    "the durable snapshot carries the injected clock's time",
  );
  assert.equal(read.value.snapshot.reservations.length, 0, "no reservation");
  assert.equal(fixture.transport.requests.length, 1, "one gateway index read");
  fixture.transport.assertReadOnly(["/admin/sentinel/incidents"]);
  fixture.transport.assertNoWriteEndpoints();
  assert.ok(
    fixture.github.calls.every((call) =>
      call === "listOpenIssues" || call.startsWith("readRef:")
    ),
    `unexpected github calls: ${fixture.github.calls.join(", ")}`,
  );
}

Deno.test(
  "host runner: repair wrapper reaches the idle path with no model session and no writes",
  async () => {
    const fixture = await makeRepairRunnerFixture();
    try {
      const outcome = await runComposedRepairHost(fixture.options, {
        deadline: fixture.clock.now() + 600_000,
        stepLimit: 16,
      });
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      // No model session, no gateway/artifact write, read-only gateway calls.
      assert.equal(fixture.sessionCalls(), 0);
      assert.deepEqual(fixture.gatewayStore.calls, []);
      const read = await fixture.options.state.readRepair();
      assert.ok(read.ok && read.value.status === "found", JSON.stringify(read));
      if (!read.ok || read.value.status !== "found") return;
      assert.equal(read.value.snapshot.sequence, 1);
      assert.equal(read.value.snapshot.reservations.length, 0);
      assert.equal(fixture.transport.requests.length, 1);
      fixture.transport.assertReadOnly(["/admin/sentinel/incidents"]);
      fixture.transport.assertNoWriteEndpoints();
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
  "host runner: missing gateway index stays a source fault with no inference",
  async () => {
    const fixture = await makeRepairRunnerFixture(
      () => new Response(null, { status: 404 }),
    );
    try {
      const outcome = await runComposedRepairHost(fixture.options, {
        deadline: fixture.clock.now() + 600_000,
        stepLimit: 16,
      });
      assert.equal(outcome.status, "source_error", JSON.stringify(outcome));
      if (outcome.status !== "source_error") return;
      assert.equal(outcome.detail, "incident source unavailable: unavailable");
      assert.equal(fixture.sessionCalls(), 0, "no inference after the fault");
      assert.deepEqual(fixture.gatewayStore.calls, [], "no fabricated fixture");
      fixture.transport.assertNoWriteEndpoints();
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "host runner: release wrapper uses the unavailable resolver default and performs no promotion",
  async () => {
    const rig = await makeReleaseRunnerFixture();
    try {
      const result = await runComposedReleaseHost(rig.options);
      assert.ok(result.ok, JSON.stringify(result));
      if (!result.ok) return;
      assert.equal(result.value.status, "waiting");
      assert.equal(result.value.detail, "build receipt is unavailable");
      assert.equal(
        rig.transport.calls.length,
        0,
        "no Deno platform call without an available receipt",
      );
      assert.equal(rig.denoAuthCalls(), 0, "no credential use before receipt");
      assert.ok(
        rig.transport.calls.every((call) => call.method !== "POST"),
        "no promotion effect was attempted",
      );
      const read = await rig.store.readRelease();
      assert.ok(read.ok, JSON.stringify(read));
      const records = read.ok && read.value.status === "found"
        ? read.value.snapshot.releases
        : [];
      assert.equal(records.length, 0, "no release record was created");
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "host runner: wrappers pass through the injected clock/state/transport identity (observable trace)",
  async () => {
    // Repair: every observable effect lands on the exact injected instances
    // and the direct compose+entrypoint path produces the identical trace.
    // A distinct clock start makes the injected clock's identity observable
    // in the durable snapshot; the injected transport records the gateway
    // read with the injected auth provider's header.
    const DISTINCT_CLOCK = T0 + 123_456_789;
    const repaired = await makeRepairRunnerFixture(undefined, DISTINCT_CLOCK);
    try {
      const outcome = await runComposedRepairHost(repaired.options, {
        deadline: repaired.clock.now() + 600_000,
        stepLimit: 16,
      });
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      assert.equal(repaired.transport.requests.length, 1);
      assert.equal(
        new URL(repaired.transport.requests[0]!.url).pathname,
        "/admin/sentinel/incidents",
      );
      assert.equal(
        repaired.transport.requests[0]!.headers.get("authorization"),
        "Bearer synthetic-token",
        "the injected auth provider reached the injected transport",
      );
      const read = await repaired.options.state.readRepair();
      assert.ok(read.ok && read.value.status === "found", JSON.stringify(read));
      if (!read.ok || read.value.status !== "found") return;
      assert.equal(read.value.snapshot.updatedAt, DISTINCT_CLOCK);
      assert.ok(
        repaired.github.calls.every((call) =>
          call === "listOpenIssues" || call.startsWith("readRef:")
        ),
        `unexpected github calls: ${repaired.github.calls.join(", ")}`,
      );
      assert.equal(repaired.sessionCalls(), 0);
      assert.deepEqual(repaired.gatewayStore.calls, []);
    } finally {
      await repaired.cleanup();
    }
    const direct = await makeRepairRunnerFixture(undefined, DISTINCT_CLOCK);
    try {
      await assertIdleRepairTrace(direct, DISTINCT_CLOCK);
    } finally {
      await direct.cleanup();
    }

    // Release: the waiting outcome is only possible when the injected
    // stateRead sees the open request published on the same disposable remote
    // through a DIFFERENT store instance; the injected transport/auth record
    // zero calls (the unavailable default binds them but never uses them),
    // and the direct compose+entrypoint path yields the identical trace.
    const wrappedRelease = await makeReleaseRunnerFixture();
    try {
      const result = await runComposedReleaseHost(wrappedRelease.options);
      assert.ok(result.ok, JSON.stringify(result));
      if (result.ok) {
        assert.equal(result.value.status, "waiting");
        assert.equal(result.value.detail, "build receipt is unavailable");
      }
      assert.equal(wrappedRelease.transport.calls.length, 0);
      assert.equal(wrappedRelease.denoAuthCalls(), 0);
      assert.equal(wrappedRelease.clock.now(), RELEASE_T0);
    } finally {
      await wrappedRelease.cleanup();
    }
    const directRelease = await makeReleaseRunnerFixture();
    try {
      const deps = composeReleaseHost(directRelease.options);
      const result = await runReleaseEntrypoint(deps);
      assert.ok(result.ok, JSON.stringify(result));
      if (result.ok) {
        assert.equal(result.value.status, "waiting");
        assert.equal(result.value.detail, "build receipt is unavailable");
      }
      assert.equal(directRelease.transport.calls.length, 0);
      assert.equal(directRelease.denoAuthCalls(), 0);
      assert.equal(directRelease.clock.now(), RELEASE_T0);
    } finally {
      await directRelease.cleanup();
    }
  },
);
