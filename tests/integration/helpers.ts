/**
 * Wave C integration test helpers.
 *
 * These helpers compose the ACTUAL production entrypoints (`src/main.ts`,
 * `src/release-main.ts`) with the real module constructors over fake
 * external transports and disposable real local Git repositories:
 *
 * - repair rig: real GitStateStore (repair + release roles on one disposable
 *   remote), real RollingStartBudget (same store), m04 module fakes for the
 *   GitHub/Incident/Replay/Implementation ports, and `runRepairEntrypoint`.
 * - release rig: real GitStateStore (release role, same remote), real
 *   DenoReleaseRESTClient over the m05 scripted transport, scripted receipt
 *   resolver, and `runReleaseEntrypoint`.
 * - gateway rig: real GatewayIncidentAdapter + real LocalArtifactStore over
 *   the m02 scripted recording transport, driven through the repair
 *   entrypoint.
 *
 * No product logic lives here; fakes/transports come from each module's own
 * test helpers. No network, no model call, no credentials.
 */
import assert from "node:assert/strict";

import {
  recordingTransport,
  validConfig,
} from "../adapters/gateway/helpers.ts";
import { GatewayIncidentAdapter } from "../../src/adapters/gateway/incident-adapter.ts";
import type { GatewayAuthProviderV1 } from "../../src/adapters/gateway/http.ts";
import {
  type ArtifactStoreLimitsV1,
  type ArtifactStoreV1,
  LocalArtifactStore,
} from "../../src/adapters/gateway/store.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { PortResultV1 } from "../../src/contracts/ports.ts";
import type { ReleaseRecordV1 } from "../../src/contracts/release.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { parseRepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { ReleaseCycleResultV1 } from "../../src/release/controller.ts";
import { DenoReleaseRESTClient } from "../../src/release/port.ts";
import type { BuildReceiptResolverV1 } from "../../src/release/resolver.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
} from "../../src/state/mod.ts";
import { runRepairEntrypoint } from "../../src/main.ts";
import { runReleaseEntrypoint } from "../../src/release-main.ts";
import type { GitCtxV1 } from "../release/helpers.ts";
import {
  acceptedEvent,
  asTransport,
  installREST,
  type logRoute,
  PROMOTE_RE,
  promoteRoute,
  type ScriptedResolver,
  ScriptedTransport,
  stabilityPolicy,
  storeAt,
  T0 as RELEASE_T0,
  targetConfig,
  terminalEvent,
  TestClock,
} from "../release/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  repairConfigs,
} from "../repair/helpers.ts";
import {
  DEP_0,
  DEP_2,
  incidentEvidence,
  incidentSummary,
  makeRemoteCtx,
  REPO,
  SHA1,
  SHA2,
  SHA3,
  T0,
  testGitEnv,
} from "../state/helpers.ts";

export {
  DEP_2,
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  REPO,
  SHA1,
  SHA2,
  SHA3,
  T0,
};
export type { BuildReceiptResolverV1 };

export const FINGERPRINT = "d".repeat(64);

/** One disposable remote shared by the repair and release state roles. */
export type IntegrationCtxV1 = GitCtxV1;

export async function makeIntegrationCtx(
  prefix: string,
): Promise<IntegrationCtxV1> {
  const tmp = await Deno.makeTempDir({
    prefix: `sentinel-integration-test-${prefix}-`,
    dir: Deno.cwd(),
  });
  const env = testGitEnv(`${tmp}/git-home`);
  await Deno.mkdir(`${tmp}/git-home`, { recursive: true });
  const remote = await makeRemoteCtx(tmp, env);
  return {
    tmp,
    env,
    remoteUrl: remote.remoteUrl,
    bare: remote.bare,
    work: remote.work,
    cleanup: async () => {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    },
  };
}

export function summaryFixture(): ReturnType<typeof incidentSummary> {
  return incidentSummary("inc-a", {
    fingerprint: FINGERPRINT,
    severity: "P1",
    failingRevision: SHA2,
    evidenceRef: {
      ref: "artifact://inbox/inc-a.pgp",
      digest: "e".repeat(64),
    },
  });
}

export function evidenceFixture(): ReturnType<typeof incidentEvidence> {
  return incidentEvidence("inc-a", {
    incidentId: "inc-a",
    fingerprint: FINGERPRINT,
    failingRevision: SHA2,
    replay: {
      fixtureRef: "fixture://sentinel/regression.json",
      fixtureDigest: "f".repeat(64) as never,
      upstreamCaptured: true,
      commandId: "replay_capture",
      reproducedAt: T0,
    },
  });
}

// ---------------------------------------------------------------------------
// Repair rig: actual entrypoint + real Git state/budget + module fakes.
// ---------------------------------------------------------------------------

export interface RepairRigV1 {
  ctx: IntegrationCtxV1;
  clock: FakeClock;
  store: ReturnType<typeof createRepairStateStore>;
  releaseStore: ReturnType<typeof createReleaseStateStore>;
  github: FakeGithub;
  incidents: FakeIncidents;
  replay: FakeReplay;
  model: FakeModel;
  run(
    deadlineMs?: number,
  ): Promise<Awaited<ReturnType<typeof runRepairEntrypoint>>>;
  snapshot(): Promise<RepairStateSnapshotV1>;
  sequence(): Promise<number>;
}

export async function makeRepairRig(
  prefix: string,
  options: {
    summaries?: boolean;
    github?: ConstructorParameters<typeof FakeGithub>[0];
    model?: ConstructorParameters<typeof FakeModel>[0];
    replay?: ConstructorParameters<typeof FakeReplay>[0];
    configOverrides?: Record<string, unknown>;
  } = {},
): Promise<RepairRigV1> {
  const ctx = await makeIntegrationCtx(prefix);
  const clock = new FakeClock(T0);
  const store = createRepairStateStore({
    scratchDir: `${ctx.tmp}/scratch-repair`,
    remoteUrl: ctx.remoteUrl,
  });
  const releaseStore = createReleaseStateStore({
    scratchDir: `${ctx.tmp}/scratch-release`,
    remoteUrl: ctx.remoteUrl,
  });
  const configs = repairConfigs({
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
    ...options.configOverrides,
  });
  const budget = new RollingStartBudget({ clock, state: store, configs });
  const github = new FakeGithub({ baseSha: SHA1, ...options.github });
  const incidents = new FakeIncidents({
    summaries: options.summaries === false ? [] : [summaryFixture()],
    evidence: options.summaries === false ? null : evidenceFixture(),
  });
  const replay = new FakeReplay(options.replay);
  const model = new FakeModel({
    head: SHA3,
    changedPaths: ["src/app.ts"],
    ...options.model,
  });
  const run = (deadlineMs = 600_000) =>
    runRepairEntrypoint({
      clock,
      state: store,
      configs,
      controllerSha: SHA1,
      github,
      incidents,
      replay,
      model,
      budget,
    }, {
      deadline: clock.now() + deadlineMs,
      stepLimit: 16,
    });
  const snapshot = async () => {
    const read = await store.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (!read.ok || read.value.status !== "found") {
      throw new Error("no repair state");
    }
    return read.value.snapshot;
  };
  const sequence = async () => (await snapshot()).sequence;
  return {
    ctx,
    clock,
    store,
    releaseStore,
    github,
    incidents,
    replay,
    model,
    run,
    snapshot,
    sequence,
  };
}

// ---------------------------------------------------------------------------
// Release rig: actual entrypoint + real Git release state + real m05 client.
// ---------------------------------------------------------------------------

/**
 * Logs route for the integration lifecycle: same cohort protocol as the m05
 * fixture, but with an EXACT revision-id → identity map covering the
 * lifecycle candidate (DEP_2 = merged SHA3) and its prior (DEP_0). The m05
 * module route only knows its own DEP_0/DEP_1 pair; a wrong Git SHA would
 * make every window sample incomplete, which must never happen here.
 */
export function integrationLogRoute(
  transport: ScriptedTransport,
  options: {
    accept: number;
    fails?: {
      fiveXx?: number;
      timeout?: number;
      stream?: number;
      upstream?: number;
    };
    baselineFails?: {
      fiveXx?: number;
      timeout?: number;
      stream?: number;
      upstream?: number;
    };
  },
): void {
  transport.any(
    "GET",
    new RegExp("^/v2/apps/[^/]+/logs$"),
    (url) => {
      const revisionId = url.searchParams.get("revision_id") ?? "dep-0000";
      const start = Date.parse(url.searchParams.get("start") ?? "0");
      const identity = revisionId === DEP_2.revisionId ? DEP_2 : DEP_0;
      const logs: string[] = [];
      for (let i = 0; i < options.accept; i++) {
        logs.push(
          acceptedEvent({
            requestId: `${revisionId}-acc-${i}`,
            timestamp: start + i,
            identity,
          }),
        );
      }
      const fails = revisionId === DEP_0.revisionId
        ? options.baselineFails ?? {}
        : options.fails ?? {};
      let failIndex = 0;
      const pushFail = (
        status: number,
        failureKind: string | null,
        stream: boolean | null,
        streamTerminalType: string | null,
      ) => {
        logs.push(
          terminalEvent({
            requestId: `${revisionId}-term-${failIndex++}`,
            timestamp: start + failIndex,
            identity,
            status,
            failureKind,
            stream,
            streamTerminalType,
          }),
        );
      };
      for (let i = 0; i < (fails.fiveXx ?? 0); i++) {
        pushFail(502, null, null, null);
      }
      for (let i = 0; i < (fails.timeout ?? 0); i++) {
        pushFail(200, "upstream_timeout", null, null);
      }
      for (let i = 0; i < (fails.stream ?? 0); i++) {
        pushFail(200, null, true, "error");
      }
      for (let i = 0; i < (fails.upstream ?? 0); i++) {
        pushFail(502, "upstream_error", null, null);
      }
      return {
        kind: "response",
        status: 200,
        body: JSON.stringify({
          logs: logs.map((message, index) => ({
            timestamp: new Date(start + index).toISOString(),
            level: "info",
            message,
            revision_id: revisionId,
          })),
          next_cursor: null,
        }),
      };
    },
  );
}

export interface ReleaseRigV1 {
  clock: TestClock;
  transport: ScriptedTransport;
  /** The injected resolver; undefined when the production default is active. */
  resolver: ScriptedResolver | undefined;
  run(): Promise<PortResultV1<ReleaseCycleResultV1>>;
  records(): Promise<ReleaseRecordV1[]>;
  promoteCalls(): number;
}

export interface ReleaseRigOptionsV1 {
  /**
   * When omitted, the entrypoint injects UnavailableBuildReceiptResolver
   * (the production default): the controller waits and never promotes.
   * Supply a scripted resolver to prove the trusted-receipt path.
   */
  resolver?: ScriptedResolver;
  logs?: Parameters<typeof logRoute>[1];
  /** null skips the promote route (a hard rejection). */
  promote?: Parameters<typeof promoteRoute>[2] | null;
}

export function makeReleaseRig(
  ctx: IntegrationCtxV1,
  options: ReleaseRigOptionsV1 = {},
): ReleaseRigV1 {
  const config = targetConfig();
  const transport = new ScriptedTransport(config);
  installREST(transport, [DEP_0, DEP_2]);
  transport.health();
  integrationLogRoute(
    transport,
    options.logs ??
      { accept: 100, fails: { fiveXx: 1 } },
  );
  const promote = options.promote === undefined ? {} : options.promote;
  if (promote !== null) promoteRoute(transport, DEP_2, promote);
  const clock = new TestClock(RELEASE_T0);
  const store = storeAt(ctx, "release-rig", "release");
  const deno = new DenoReleaseRESTClient({
    transport: asTransport(transport),
    auth: {
      bearerToken: () =>
        Promise.resolve(
          {
            ok: true,
            value: "synthetic-token",
          } as const,
        ),
    },
    config,
    clock,
  });
  const run = () =>
    runReleaseEntrypoint({
      clock,
      stateRead: store,
      stateWrite: store,
      repository: REPO,
      environment: "production",
      target: config,
      policy: stabilityPolicy(),
      deno,
      // Only an explicitly injected resolver is passed; otherwise the
      // entrypoint's production default (unavailable) is active.
      resolver: options.resolver,
    });
  const records = async (): Promise<ReleaseRecordV1[]> => {
    const read = await store.readRelease();
    if (!read.ok || read.value.status !== "found") return [];
    return read.value.snapshot.releases;
  };
  return {
    clock,
    transport,
    resolver: options.resolver,
    run,
    records,
    promoteCalls: () => transport.callCount("POST", PROMOTE_RE),
  };
}

/**
 * Collect every due monitor slot in one deterministic controller run
 * (the run cap covers the full 60-slot window; each slot keeps its exact
 * persisted window).
 */
export async function runReleaseWindowToEnd(rig: ReleaseRigV1): Promise<void> {
  const records = await rig.records();
  const record = records[0];
  if (record.monitoring.startedAt === null) {
    throw new Error("missing window start");
  }
  const startedAt = record.monitoring.startedAt;
  rig.clock.at(startedAt + 35_000 + 59 * 30_000);
  await rig.run();
}

// ---------------------------------------------------------------------------
// Gateway rig: real adapter + real artifact store, scripted producer wire.
// ---------------------------------------------------------------------------

export interface GatewayRigV1 {
  adapter: GatewayIncidentAdapter;
  store: ArtifactStoreV1;
  clock: FakeClock;
  root: string;
  transport: ReturnType<typeof recordingTransport>;
  cleanup(): Promise<void>;
}

export function gatewayLimits(): ArtifactStoreLimitsV1 {
  return {
    totalMaxBytes: 1_000_000,
    artifactMaxBytes: 100_000,
    retentionMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
  };
}

export function gatewayAuth(): GatewayAuthProviderV1 {
  return {
    headers: () =>
      Promise.resolve(
        {
          ok: true,
          value: { Authorization: "Bearer synthetic-token" },
        } as const,
      ),
  };
}

export async function makeGatewayRig(
  responder: (url: URL) => Response | Promise<Response>,
  options: { clock?: FakeClock; root?: string } = {},
): Promise<GatewayRigV1> {
  const root = options.root ??
    await Deno.makeTempDir({
      dir: Deno.cwd(),
      prefix: "sentinel-integration-test-gateway-",
    });
  const store = new LocalArtifactStore({
    root,
    limits: gatewayLimits(),
  });
  const opened = await store.open();
  assert.ok(opened.ok, `store open failed: ${JSON.stringify(opened)}`);
  const transport = recordingTransport(responder);
  const clock = options.clock ?? new FakeClock(T0);
  const adapter = new GatewayIncidentAdapter({
    config: validConfig(),
    transport,
    auth: gatewayAuth(),
    clock,
    store,
  });
  return {
    adapter,
    store,
    clock,
    root,
    transport,
    cleanup: async () => {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

export type { ReleaseStateSnapshotV1, RepositoryConfigV1 };
export { repairConfigs };
export type { GitSha };
export { parseRepositoryConfigV1 };
export { recordingTransport, validConfig };
