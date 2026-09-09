/**
 * Wave C top-level trusted-host assembly tests (`src/host/host.ts` plus the
 * provider adapters in `src/host/providers.ts`).
 *
 * Covered:
 * - the complete assembly composes all three existing host seams
 *   (GitHub / repair / release) side-effect free and returns the EXACT repair
 *   and release entrypoint dependency sets with instance identity preserved
 *   (one clock, one composed GitHub port, one repository binding);
 * - ONE shared durable GitHub cooldown gate reaches both the GitHub port's
 *   authentication paths and the repair deps — no second gate exists;
 * - repair/release role separation survives at the type boundary
 *   (`@ts-expect-error` fences) and at the value boundary (the repair deps
 *   carry no release writer/Deno port; the release deps carry no repair
 *   writer/model/budget/cooldown);
 * - an omitted build-receipt resolver stays the unavailable default, and a
 *   false or absent restricted-execution attestation is refused with one
 *   static non-echoing TypeError before construction;
 * - the credential/header closure adapters map thrown and malformed values to
 *   the existing typed fail-closed results without echoing any value and
 *   without any downstream transport call; a hostile accessor or
 *   property-enumeration fault inside the adapters is the same typed
 *   fail-closed result, never a raw escape;
 * - malformed/mismatched repository identities, an unconfigured composed
 *   repository, an invalid controller SHA and an invalid release environment
 *   are rejected with static non-echoing TypeErrors before construction;
 * - malformed top-level clock / cooldown-gate shapes and hostile accessor or
 *   property-enumeration faults inside the nested shape validators are
 *   rejected with the same static non-echoing TypeErrors before construction,
 *   and no input-derived text is ever echoed;
 * - one bounded composed repair/release pass over disposable local Git and
 *   fake transports: idle repair with no model session and no gateway write,
 *   waiting release with no Deno call, no promotion and no release record.
 *
 * No network, no model call, no credentials, no GitHub writes, no
 * deployment; git is disposable local state and every transport is synthetic.
 */
import assert from "node:assert/strict";

import type { CommandId } from "../../src/contracts/brands.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { DenoGitExecutor } from "../../src/github/git-executor.ts";
import {
  composeGitHubHost,
  type GitHubHostOptionsV1,
  type GitHubHostResultV1,
} from "../../src/host/github.ts";
import {
  assembleTrustedHost,
  type TrustedHostOptionsV1,
} from "../../src/host/host.ts";
import {
  createDenoAuthProvider,
  createGatewayAuthProvider,
  createGitHubAuthProvider,
  createReplayIsolationHost,
} from "../../src/host/providers.ts";
import { gatewayRead } from "../../src/adapters/gateway/http.ts";
import { denoRestCall } from "../../src/release/http.ts";
import { UnavailableBuildReceiptResolver } from "../../src/release/resolver.ts";
import { markerProofParser } from "../../src/replay/fixture.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import type { RepairEntrypointDepsV1 } from "../../src/main.ts";
import { runRepairEntrypoint } from "../../src/main.ts";
import type { ReleaseEntrypointDepsV1 } from "../../src/release-main.ts";
import { runReleaseEntrypoint } from "../../src/release-main.ts";
import {
  FakeCooldownGate,
  FakeReviewService,
  httpRespond,
  PR_AUTHOR,
  REVIEWER,
  ScriptedHttpTransport,
} from "../github/helpers.ts";
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
  targetConfig,
} from "../release/helpers.ts";
import {
  FakeClock,
  makeIntegrationCtx,
  repairConfigs,
  REPO,
  SHA1,
  T0,
} from "./helpers.ts";

const GATEWAY_COMMAND = "replay_capture" as CommandId;
const TEST_IDS = ["repair:host-wiring-regression"] as const;
const EXPECTED_FAILURE = {
  reason: "fixture reproduced the recorded upstream failure",
  match: { kind: "contains" as const, text: "upstream terminated" },
};
const ISSUES_PATH =
  "/repos/ubiquity/ai.ubq.fi/issues?state=open&per_page=100&page=1";

/** A gateway store that must never be written by the idle wiring pass. */
class CountingStore {
  readonly limits = {
    totalMaxBytes: 1_000_000,
    artifactMaxBytes: 100_000,
    retentionMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
  };
  calls: string[] = [];
  put(): Promise<never> {
    this.calls.push("put");
    return Promise.reject(new Error("store must not be used"));
  }
  get(): Promise<never> {
    this.calls.push("get");
    return Promise.reject(new Error("store must not be used"));
  }
  listByIncident(): Promise<never> {
    this.calls.push("listByIncident");
    return Promise.reject(new Error("store must not be used"));
  }
  stats(): Promise<never> {
    this.calls.push("stats");
    return Promise.reject(new Error("store must not be used"));
  }
}

interface WiringRigV1 {
  clock: FakeClock;
  gate: FakeCooldownGate;
  githubTransport: ScriptedHttpTransport;
  gatewayTransport: ReturnType<typeof recordingTransport>;
  denoTransport: ScriptedTransport;
  releaseStore: ReturnType<typeof storeAt>;
  options: TrustedHostOptionsV1;
  publishReleaseRequest(id: string): Promise<unknown>;
  sessionCalls(): number;
  cleanup(): Promise<void>;
}

/**
 * One complete trusted-host capability set over a disposable local Git remote
 * and synthetic transports; the assembly itself performs zero I/O until an
 * entrypoint runs.
 */
async function makeWiringRig(prefix: string): Promise<WiringRigV1> {
  const ctx = await makeIntegrationCtx(`host-wiring-${prefix}`);
  const clock = new FakeClock(T0);
  const repairStore = createRepairStateStore({
    scratchDir: `${ctx.tmp}/scratch-repair`,
    remoteUrl: ctx.remoteUrl,
  });
  const releaseStore = storeAt(ctx, "wiring-release", "release");
  const gate = new FakeCooldownGate();
  const githubTransport = new ScriptedHttpTransport([
    httpRespond("GET", ISSUES_PATH, 200, []),
  ]);
  const gatewayTransport = recordingTransport(
    () => jsonResponse(makeIndexPage([], null, { status: "complete" })),
  );
  const denoTransport = new ScriptedTransport(targetConfig());
  let openedSessions = 0;
  const options: TrustedHostOptionsV1 = {
    clock,
    githubCooldown: gate,
    github: {
      repository: REPO,
      http: githubTransport.fetch.bind(githubTransport) as HttpTransportV1,
      auth: createGitHubAuthProvider(
        () => "Bearer ghs_synthetic_token_0001",
      ),
      reviewService: new FakeReviewService(),
      trustedPrAuthor: PR_AUTHOR,
      trustedReviewer: REVIEWER,
      trustedResolutionAuthors: ["sentinel-approver"],
      git: { localDir: `${ctx.tmp}/git-work`, remoteUrl: ctx.remoteUrl },
    },
    repair: {
      configs: repairConfigs({ liveStartLimits: null, sessionBound: null }),
      controllerSha: SHA1,
      state: repairStore,
      gateway: {
        repository: REPO,
        transport: gatewayTransport,
        auth: createGatewayAuthProvider(
          () => ({ Authorization: "Bearer synthetic-token" }),
        ),
        store: new CountingStore(),
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
          return Promise.reject(
            new Error("no live Codex session in wiring tests"),
          );
        },
        checkoutDir: `${ctx.tmp}/model-checkout`,
      },
    },
    release: {
      stateRead: releaseStore,
      stateWrite: releaseStore,
      repository: REPO,
      environment: "production",
      target: targetConfig(),
      policy: stabilityPolicy(),
      deno: {
        transport: asTransport(denoTransport),
        auth: createDenoAuthProvider(() => "synthetic-token"),
      },
    },
  };
  return {
    clock,
    gate,
    githubTransport,
    gatewayTransport,
    denoTransport,
    releaseStore,
    options,
    publishReleaseRequest: (id: string) =>
      publishRepairRequest(ctx, requestFor(id)),
    sessionCalls: () => openedSessions,
    cleanup: () => ctx.cleanup(),
  };
}

Deno.test(
  "host assembly: complete composition calls all three seams side-effect free with exact instance identity",
  async () => {
    const rig = await makeWiringRig("composition");
    try {
      const assembly = assembleTrustedHost(rig.options);

      // Construction performed zero I/O: no GitHub/gateway/Deno transport
      // request, no credential use, no cooldown check, no review call, no
      // model session and no state write.
      assert.equal(rig.githubTransport.requests.length, 0);
      assert.equal(rig.gatewayTransport.requests.length, 0);
      assert.equal(rig.denoTransport.calls.length, 0);
      assert.deepEqual(rig.gate.beforeRequests, []);
      assert.equal(rig.sessionCalls(), 0);

      // The exact repair deps from the repair host seam.
      assert.equal(assembly.repair.clock, rig.clock);
      assert.equal(assembly.repair.state, rig.options.repair.state);
      assert.equal(assembly.repair.github, assembly.github.port);
      assert.equal(assembly.repair.githubCooldown, rig.gate);
      assert.equal(typeof assembly.repair.model.runModel, "function");
      assert.equal(typeof assembly.repair.budget.reserveModelStart, "function");

      // The exact release deps from the release host seam.
      assert.equal(assembly.release.clock, rig.clock);
      assert.equal(assembly.release.stateRead, rig.releaseStore);
      assert.equal(assembly.release.stateWrite, rig.releaseStore);
      assert.deepEqual(assembly.release.repository, REPO);
      assert.equal(assembly.release.environment, "production");
      assert.ok(
        assembly.release.resolver instanceof UnavailableBuildReceiptResolver,
        "the omitted resolver keeps the production unavailable default",
      );

      // The GitHub host result: the exact executor identity the port
      // publishes through, and no second gate anywhere.
      assert.ok(assembly.github.git instanceof DenoGitExecutor);
      assert.ok("port" in assembly.github);
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "host assembly: one shared cooldown gate reaches GitHub authentication and the repair deps; no second gate",
  async () => {
    const rig = await makeWiringRig("cooldown");
    try {
      const assembly = assembleTrustedHost(rig.options);
      assert.equal(assembly.repair.githubCooldown, rig.gate);
      assert.equal(rig.gate.beforeRequests.length, 0);

      // The composed REAL GitHub port checks exactly this injected instance
      // before authentication and before the request (a parallel gate inside
      // the seam would leave the injected one untouched).
      const issues = await assembly.github.port.listOpenIssues();
      assert.ok(issues.ok, JSON.stringify(issues));
      assert.deepEqual(rig.gate.beforeRequests, [
        REPO.installationId,
        REPO.installationId,
      ]);
      assert.equal(rig.githubTransport.requests.length, 1);
      assert.equal(
        rig.githubTransport.requests[0].url,
        `https://api.github.com${ISSUES_PATH}`,
        "the port is bound to the exact composed repository identity",
      );
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "host assembly: repair/release role separation survives the type and value boundaries",
  async () => {
    const rig = await makeWiringRig("roles");
    try {
      const assembly = assembleTrustedHost(rig.options);
      const repairFence = (deps: RepairEntrypointDepsV1) => {
        // @ts-expect-error release write capability is never part of the repair set
        void deps.stateWrite;
        // @ts-expect-error the Deno release port is never part of the repair set
        void deps.deno;
        // @ts-expect-error build receipts are never part of the repair set
        void deps.resolver;
      };
      const releaseFence = (deps: ReleaseEntrypointDepsV1) => {
        // @ts-expect-error the repair writer is never part of the release set
        void deps.state;
        // @ts-expect-error work records never reach the release set
        void deps.configs;
        // @ts-expect-error the model port never reaches the release set
        void deps.model;
        // @ts-expect-error model admission never reaches the release set
        void deps.budget;
      };
      assert.equal(typeof repairFence, "function");
      assert.equal(typeof releaseFence, "function");

      for (const key of ["stateWrite", "deno", "resolver"]) {
        assert.ok(
          !Object.hasOwn(assembly.repair, key),
          `repair deps must not carry ${key}`,
        );
      }
      for (
        const key of [
          "state",
          "configs",
          "controllerSha",
          "github",
          "githubCooldown",
          "incidents",
          "replay",
          "model",
          "budget",
        ]
      ) {
        assert.ok(
          !Object.hasOwn(assembly.release, key),
          `release deps must not carry ${key}`,
        );
      }
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "host assembly: omitted resolver stays unavailable; false or absent restricted execution is refused",
  async () => {
    const rig = await makeWiringRig("fail-closed");
    try {
      const assembly = assembleTrustedHost(rig.options);
      assert.ok(
        assembly.release.resolver instanceof UnavailableBuildReceiptResolver,
      );

      // False restricted execution: static TypeError, nothing echoed.
      const falseIsolation: TrustedHostOptionsV1 = {
        ...rig.options,
        repair: {
          ...rig.options.repair,
          replay: {
            ...rig.options.repair.replay,
            isolation: {
              attestation: {
                version: "v1",
                host: "harness",
                restrictedExecution: false,
                boundary: "bounded test host",
                attestationRef: "attestation://harness/v1",
              },
            },
          },
        },
      };
      assert.throws(
        () => assembleTrustedHost(falseIsolation),
        (error: unknown) =>
          error instanceof TypeError &&
          error.message.startsWith(
            "replay isolation host rejected: the attestation does not prove restricted execution",
          ),
      );

      // Absent attestation: also a static TypeError (clearEnv is not a sandbox).
      const absentIsolation = {
        ...rig.options,
        repair: {
          ...rig.options.repair,
          replay: {
            ...rig.options.repair.replay,
            isolation: null,
          },
        },
      } as unknown as TrustedHostOptionsV1;
      assert.throws(
        () => assembleTrustedHost(absentIsolation),
        TypeError,
      );

      // The helper itself never manufactures an attestation either.
      assert.throws(
        () => createReplayIsolationHost({ version: "v1", host: "h" }),
        TypeError,
      );
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "provider adapters: thrown/malformed closures map to typed fail-closed results, no echo, no downstream call",
  async () => {
    // --- GitHub: thrown closure through the real GitHub port.
    let githubFetches = 0;
    const githubHttp = (() => {
      githubFetches += 1;
      return Promise.reject(new Error("must never be reached"));
    }) as unknown as HttpTransportV1;
    const githubHost: GitHubHostResultV1 = composeGitHubHost({
      repository: REPO,
      http: githubHttp,
      auth: createGitHubAuthProvider(() => {
        throw new Error("SUPER-SECRET-VALUE");
      }),
      cooldownGate: new FakeCooldownGate(),
      clock: { now: () => T0 },
      reviewService: new FakeReviewService(),
      trustedPrAuthor: PR_AUTHOR,
      trustedReviewer: REVIEWER,
      trustedResolutionAuthors: [],
      git: {
        localDir: "/synthetic/git/work",
        remoteUrl: "/synthetic/git/remote.git",
      },
    } as GitHubHostOptionsV1);
    const failed = await githubHost.port.listOpenIssues();
    assert.equal(failed.ok, false);
    if (failed.ok) return;
    assert.equal(failed.error.kind, "auth_failed");
    assert.equal(failed.error.detail, "provider credentials are unavailable");
    assert.ok(!failed.error.detail.includes("SUPER-SECRET-VALUE"));
    assert.equal(githubFetches, 0, "no GitHub transport call after the fault");

    // --- GitHub: malformed header value (header injection attempt).
    const malformedHeader = createGitHubAuthProvider(
      () => "Bearer token\nInjected: yes",
    );
    const malformedOutcome = await malformedHeader.authorizationHeader();
    assert.equal(malformedOutcome.ok, false);
    if (!malformedOutcome.ok) {
      assert.equal(malformedOutcome.error.kind, "invalid");
      assert.equal(
        malformedOutcome.error.detail,
        "provider credentials are malformed",
      );
    }

    // --- Gateway: thrown closure through the real gateway read.
    let gatewayFetches = 0;
    const gatewayReadOutcome = await gatewayRead(
      {
        baseUrl: "https://gateway.local",
        path: "/admin/sentinel/incidents",
        query: new URLSearchParams(),
        responseByteCap: 4096,
      },
      () => {
        gatewayFetches += 1;
        return Promise.reject(new Error("must never be reached"));
      },
      createGatewayAuthProvider(() => {
        throw new Error("SUPER-SECRET-VALUE");
      }),
    );
    assert.equal(gatewayReadOutcome.ok, false);
    if (!gatewayReadOutcome.ok) {
      assert.equal(gatewayReadOutcome.error.kind, "auth_failed");
      assert.ok(
        !gatewayReadOutcome.error.detail.includes("SUPER-SECRET-VALUE"),
      );
    }
    assert.equal(
      gatewayFetches,
      0,
      "no gateway transport call after the fault",
    );

    // --- Gateway: malformed header record is rejected by the adapter.
    const gatewayHeaders = await createGatewayAuthProvider(
      () => ({ Authorization: "Bearer a\nInjected: yes" }),
    ).headers();
    assert.equal(gatewayHeaders.ok, false);
    if (!gatewayHeaders.ok) {
      assert.equal(gatewayHeaders.error.kind, "auth_failed");
      assert.equal(
        gatewayHeaders.error.detail,
        "gateway auth provider returned malformed headers",
      );
    }

    // --- Deno: injected control characters never reach a Headers constructor.
    let denoFetches = 0;
    const denoOutcome = await denoRestCall(
      {
        baseUrl: "https://api.deno.com",
        path: "/v2/apps/x",
        query: new URLSearchParams(),
        method: "GET",
        responseByteCap: 4096,
      },
      () => {
        denoFetches += 1;
        return Promise.reject(new Error("must never be reached"));
      },
      createDenoAuthProvider(() => "token\nInjected: yes"),
    );
    assert.equal(denoOutcome.ok, false);
    if (!denoOutcome.ok) {
      assert.equal(denoOutcome.error.kind, "auth_failed");
    }
    assert.equal(denoFetches, 0, "no Deno transport call after the fault");

    // --- Deno: an empty token keeps the existing typed empty-token detail.
    const emptyToken = await createDenoAuthProvider(() => "").bearerToken();
    assert.equal(emptyToken.ok, false);
    if (!emptyToken.ok) {
      assert.equal(emptyToken.error.kind, "auth_failed");
      assert.equal(
        emptyToken.error.detail,
        "deno auth provider returned an empty token",
      );
    }
  },
);

Deno.test(
  "provider adapters: hostile accessor or enumeration faults stay inside the typed fail-closed boundary",
  async () => {
    // --- Gateway: a throwing ownKeys trap (property enumeration) is the
    // existing typed malformed-record failure, never a raw error or echo.
    const enumeratingHeaders = new Proxy(
      { Authorization: "Bearer synthetic-token" },
      {
        ownKeys() {
          throw new Error("EXOTIC-ENUMERATION-FAULT");
        },
      },
    ) as unknown as Record<string, string>;
    const enumerated = await createGatewayAuthProvider(
      () => enumeratingHeaders,
    ).headers();
    assert.equal(enumerated.ok, false);
    if (!enumerated.ok) {
      assert.equal(enumerated.error.kind, "auth_failed");
      assert.equal(
        enumerated.error.detail,
        "gateway auth provider returned malformed headers",
      );
      assert.ok(
        !enumerated.error.detail.includes("EXOTIC-ENUMERATION-FAULT"),
        "no raw enumeration fault is echoed",
      );
    }

    // --- Gateway: a throwing get trap during the same enumeration is also
    // the existing typed malformed-record failure, no echo.
    const throwingGetterHeaders = new Proxy(
      { Authorization: "Bearer synthetic-token" },
      {
        get(target, key) {
          if (key === "Authorization") throw new Error("EXOTIC-HEADER-READ");
          return Reflect.get(target, key);
        },
      },
    ) as unknown as Record<string, string>;
    const getterOutcome = await createGatewayAuthProvider(
      () => throwingGetterHeaders,
    ).headers();
    assert.equal(getterOutcome.ok, false);
    if (!getterOutcome.ok) {
      assert.equal(getterOutcome.error.kind, "auth_failed");
      assert.equal(
        getterOutcome.error.detail,
        "gateway auth provider returned malformed headers",
      );
      assert.ok(
        !getterOutcome.error.detail.includes("EXOTIC-HEADER-READ"),
        "no raw accessor fault is echoed",
      );
    }

    // --- Isolation: a hostile attestation accessor is the same static
    // non-echoing TypeError, never the raw thrown value.
    const hostileAttestation = new Proxy(
      {
        version: "v1",
        restrictedExecution: true,
        host: "harness",
        boundary: "bounded test host",
        attestationRef: "attestation://harness/v1",
      },
      {
        get(target, key) {
          if (key === "restrictedExecution") {
            throw new Error("EXOTIC-ATTESTATION-READ");
          }
          return Reflect.get(target, key);
        },
      },
    );
    assert.throws(
      () => createReplayIsolationHost(hostileAttestation),
      (error: unknown) =>
        error instanceof TypeError &&
        error.message.startsWith(
          "replay isolation host rejected: the attestation does not prove restricted execution",
        ) &&
        !error.message.includes("EXOTIC-ATTESTATION-READ"),
    );
  },
);

Deno.test(
  "host assembly: malformed/mismatched identities and invalid capability shapes fail with static non-echoing TypeErrors",
  async () => {
    const rig = await makeWiringRig("rejections");
    try {
      const expectRejection = (
        options: TrustedHostOptionsV1,
        message: string,
      ) => {
        assert.throws(
          () => assembleTrustedHost(options),
          (error: unknown) =>
            error instanceof TypeError && error.message === message,
        );
      };

      // GitHub host repository must equal the gateway repository exactly.
      expectRejection(
        {
          ...rig.options,
          github: {
            ...rig.options.github,
            repository: { ...REPO, name: "other" },
          },
        },
        "trusted host assembly rejected: the github host repository does not match the repair gateway repository",
      );

      // The composed repository must appear exactly once in the config set.
      expectRejection(
        {
          ...rig.options,
          github: {
            ...rig.options.github,
            repository: { owner: "other", name: "repo", installationId: 9 },
          },
          repair: {
            ...rig.options.repair,
            gateway: {
              ...rig.options.repair.gateway,
              repository: { owner: "other", name: "repo", installationId: 9 },
            },
          },
        },
        "trusted host assembly rejected: the composed repository is not among the configured repositories",
      );

      // The release controller must own the same exact repository.
      expectRejection(
        {
          ...rig.options,
          release: {
            ...rig.options.release,
            repository: { ...REPO, name: "other" },
          },
        },
        "trusted host assembly rejected: the release repository does not match the composed repair repository",
      );

      // Malformed controller SHA: static text, never the supplied value.
      expectRejection(
        {
          ...rig.options,
          repair: {
            ...rig.options.repair,
            controllerSha: "not-a-sha" as never,
          },
        },
        "trusted host assembly rejected: controller SHA is not an exact lowercase 40-hex commit SHA",
      );

      // Malformed repository identity (installation id 0): static, no echo.
      expectRejection(
        {
          ...rig.options,
          github: {
            ...rig.options.github,
            repository: {
              owner: "ubiquity",
              name: "ai.ubq.fi",
              installationId: 0,
            },
          },
        },
        "trusted host assembly rejected: github host repository identity is invalid",
      );

      // Invalid release environment: static, no echo.
      expectRejection(
        {
          ...rig.options,
          release: { ...rig.options.release, environment: "staging" as never },
        },
        "trusted host assembly rejected: release environment is invalid",
      );

      // Missing required capability shapes: a non-callable session opener.
      expectRejection(
        {
          ...rig.options,
          repair: {
            ...rig.options.repair,
            model: {
              ...rig.options.repair.model,
              openSession: "nope" as never,
            },
          },
        },
        "trusted host assembly rejected: model session opener shape is invalid",
      );
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "host assembly: malformed top-level clock or cooldown gate fails before any seam constructor",
  async () => {
    const rig = await makeWiringRig("clock-gate");
    try {
      const expectRejection = (
        options: TrustedHostOptionsV1,
        message: string,
      ) => {
        assert.throws(
          () => assembleTrustedHost(options),
          (error: unknown) =>
            error instanceof TypeError && error.message === message,
        );
      };

      // Wrong clock shape: the clock is an explicit capability, never a
      // default; no downstream seam may see it.
      expectRejection(
        { ...rig.options, clock: { tick: () => 1 } as never },
        "trusted host assembly rejected: clock shape is invalid",
      );

      // Malformed cooldown gate: the required gate methods are missing.
      expectRejection(
        { ...rig.options, githubCooldown: {} as never },
        "trusted host assembly rejected: github cooldown gate shape is invalid",
      );

      // Hostile clock accessor: the SAME static error, nothing echoed.
      const hostileClock = new Proxy(rig.options.clock, {
        get(target, key) {
          if (key === "now") throw new Error("EXOTIC-CLOCK-VALUE");
          return Reflect.get(target, key);
        },
      }) as never;
      expectRejection(
        { ...rig.options, clock: hostileClock },
        "trusted host assembly rejected: clock shape is invalid",
      );

      // Hostile gate accessor: the SAME static error, nothing echoed.
      const hostileGate = new Proxy(rig.gate, {
        get(target, key) {
          if (key === "beforeRequest") throw new Error("EXOTIC-GATE-VALUE");
          return Reflect.get(target, key);
        },
      }) as never;
      expectRejection(
        { ...rig.options, githubCooldown: hostileGate },
        "trusted host assembly rejected: github cooldown gate shape is invalid",
      );

      // Every rejection happened before construction: no transport, gate,
      // credential or model capability was touched.
      assert.equal(rig.githubTransport.requests.length, 0);
      assert.equal(rig.gatewayTransport.requests.length, 0);
      assert.equal(rig.denoTransport.calls.length, 0);
      assert.deepEqual(rig.gate.beforeRequests, []);
      assert.equal(rig.sessionCalls(), 0);
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "host assembly: hostile accessor and enumeration faults inside nested shape validation become static non-echoing TypeErrors",
  async () => {
    const rig = await makeWiringRig("accessor-faults");
    try {
      const expectRejection = (
        options: TrustedHostOptionsV1,
        message: string,
      ) => {
        assert.throws(
          () => assembleTrustedHost(options),
          (error: unknown) =>
            error instanceof TypeError && error.message === message,
        );
      };

      // Gateway transport: a throwing accessor is the transport shape error.
      const hostileGateway = new Proxy(rig.options.repair.gateway, {
        get(target, key) {
          if (key === "transport") {
            throw new Error("EXOTIC-GATEWAY-TRANSPORT");
          }
          return Reflect.get(target, key);
        },
      }) as never;
      expectRejection(
        {
          ...rig.options,
          repair: { ...rig.options.repair, gateway: hostileGateway },
        },
        "trusted host assembly rejected: gateway transport shape is invalid",
      );

      // Repair state read: a throwing accessor is the repair state error.
      const hostileState = new Proxy(rig.options.repair.state, {
        get(target, key) {
          if (key === "readRepair") throw new Error("EXOTIC-REPAIR-STATE");
          return Reflect.get(target, key);
        },
      }) as never;
      expectRejection(
        {
          ...rig.options,
          repair: { ...rig.options.repair, state: hostileState },
        },
        "trusted host assembly rejected: repair state capability shape is invalid",
      );

      // Replay source kind: a throwing accessor is the replay source error.
      const hostileSource = new Proxy(rig.options.repair.replay.source, {
        get(target, key) {
          if (key === "kind") throw new Error("EXOTIC-SOURCE-KIND");
          return Reflect.get(target, key);
        },
      }) as never;
      expectRejection(
        {
          ...rig.options,
          repair: {
            ...rig.options.repair,
            replay: { ...rig.options.repair.replay, source: hostileSource },
          },
        },
        "trusted host assembly rejected: replay source shape is invalid",
      );

      // Model session opener: a throwing accessor is the model session error.
      const hostileModel = new Proxy(rig.options.repair.model, {
        get(target, key) {
          if (key === "openSession") throw new Error("EXOTIC-MODEL-SESSION");
          return Reflect.get(target, key);
        },
      }) as never;
      expectRejection(
        {
          ...rig.options,
          repair: { ...rig.options.repair, model: hostileModel },
        },
        "trusted host assembly rejected: model session opener shape is invalid",
      );

      // GitHub review service: a throwing accessor is the review shape error.
      const hostileGithub = new Proxy(rig.options.github, {
        get(target, key) {
          if (key === "reviewService") {
            throw new Error("EXOTIC-REVIEW-SERVICE");
          }
          return Reflect.get(target, key);
        },
      }) as never;
      expectRejection(
        { ...rig.options, github: hostileGithub },
        "trusted host assembly rejected: github review service shape is invalid",
      );

      // Release Deno auth: a throwing accessor is the release Deno error.
      const hostileDeno = new Proxy(rig.options.release.deno, {
        get(target, key) {
          if (key === "auth") throw new Error("EXOTIC-DENO-AUTH");
          return Reflect.get(target, key);
        },
      }) as never;
      expectRejection(
        {
          ...rig.options,
          release: { ...rig.options.release, deno: hostileDeno },
        },
        "trusted host assembly rejected: release Deno capability shape is invalid",
      );

      // Hostile property enumeration on the github seam: the static github
      // input error, never the raw trap error, and no constructor has run.
      const enumeratingGithub = new Proxy(rig.options.github, {
        ownKeys() {
          throw new Error("EXOTIC-ENUMERATION");
        },
      }) as never;
      expectRejection(
        { ...rig.options, github: enumeratingGithub },
        "trusted host assembly rejected: github host inputs are invalid",
      );

      assert.equal(rig.githubTransport.requests.length, 0);
      assert.equal(rig.gatewayTransport.requests.length, 0);
      assert.equal(rig.denoTransport.calls.length, 0);
      assert.deepEqual(rig.gate.beforeRequests, []);
      assert.equal(rig.sessionCalls(), 0);
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "host assembly: one bounded composed repair/release pass with no model session, promotion or network",
  async () => {
    const rig = await makeWiringRig("composed-pass");
    try {
      const assembly = assembleTrustedHost(rig.options);

      // One open release request on the shared disposable remote, published
      // before the repair run (the release controller also reads it through
      // the read-only view).
      await rig.publishReleaseRequest("release-request-wiring-0001");

      // Repair entrypoint over the assembled deps: exactly one gateway index
      // read, one GitHub issues read, no model session, no gateway write.
      const outcome = await runRepairEntrypoint(assembly.repair, {
        deadline: rig.clock.now() + 600_000,
        stepLimit: 16,
      });
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      assert.equal(rig.sessionCalls(), 0, "no model session was opened");
      assert.equal(
        (rig.options.repair.gateway.store as CountingStore).calls.length,
        0,
        "no gateway artifact write",
      );
      assert.equal(rig.gatewayTransport.requests.length, 1);
      assert.equal(rig.githubTransport.requests.length, 1);
      rig.gatewayTransport.assertReadOnly(["/admin/sentinel/incidents"]);
      rig.gatewayTransport.assertNoWriteEndpoints();
      const read = await rig.options.repair.state.readRepair();
      assert.ok(read.ok && read.value.status === "found", JSON.stringify(read));

      // Release entrypoint over the assembled deps with the unavailable
      // resolver default: no Deno call, no credential use, no promotion, no
      // release record.
      const released = await runReleaseEntrypoint(assembly.release);
      assert.ok(released.ok, JSON.stringify(released));
      if (released.ok) {
        assert.equal(released.value.status, "waiting");
        assert.equal(released.value.detail, "build receipt is unavailable");
      }
      assert.equal(rig.denoTransport.calls.length, 0, "no Deno platform call");
      assert.equal(
        rig.denoTransport.calls.some((call) => call.method === "POST"),
        false,
        "no promotion effect was attempted",
      );
      const records = await rig.releaseStore.readRelease();
      assert.ok(records.ok, JSON.stringify(records));
      const releases = records.ok && records.value.status === "found"
        ? records.value.snapshot.releases
        : [];
      assert.equal(releases.length, 0, "no release record was created");
    } finally {
      await rig.cleanup();
    }
  },
);
