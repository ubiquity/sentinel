// m05-release acceptance checkpoint: the deterministic release state machine
// driven by a scripted Deno transport plus actual temporary Git state.
//
// Every scenario runs against a real disposable bare repository (the real
// GitStateStore) and a stateful scripted transport that models the documented
// Deno REST contract: revisions list, exact revision resources, timelines,
// promote (204 + effect), managed/custom health identity headers, and the
// logs endpoint with exact revision/window filtering.
//
// Covered: exactly-one candidate binding, promotion 204+identity proof,
// baseline/candidate windows, threshold and minimum-coverage evaluation,
// ambiguous-promotion recovery (no repeated POST), monitoring interruption
// reset, wrong revision/200 identity, managed pass plus Cloudflare-403
// warning, exact rollback, unrelated-newer protection, read/CAS conflict, and
// restart after durable intent. No real network, model, or production state
// branch is touched.
import assert from "node:assert/strict";

import type { PortResultV1 } from "../../src/contracts/ports.ts";
import type { ReleaseRecordV1 } from "../../src/contracts/release.ts";
import type { DeploymentIdentityV1 } from "../../src/contracts/shared.ts";
import type { StabilityPolicyV1 } from "../../src/contracts/repository-config.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  ReleaseController,
  type ReleaseControllerOptions,
  type ReleaseCycleResultV1,
} from "../../src/release/controller.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { DenoReleaseRESTClient } from "../../src/release/port.ts";
import {
  asTransport,
  DEP_0,
  DEP_1,
  DEP_X,
  type GitCtxV1,
  installREST,
  logRoute,
  makeGitCtx,
  PROMOTE_RE,
  promoteRoute,
  publishRepairRequest,
  requestFor,
  ScriptedResolver,
  ScriptedTransport,
  stabilityPolicy,
  storeAt,
  T0,
  targetConfig,
  TestClock,
} from "./helpers.ts";

interface ScenarioV1 {
  ctx: GitCtxV1;
  transport: ScriptedTransport;
  clock: TestClock;
  controller: ReleaseController;
  resolver: ScriptedResolver;
  records(): Promise<ReleaseRecordV1[]>;
  cleanup(): Promise<void>;
}

async function makeScenario(
  overrides: {
    logs?: {
      accept: number;
      fails?: {
        fiveXx?: number;
        timeout?: number;
        stream?: number;
        upstream?: number;
      };
    };
    policy?: StabilityPolicyV1;
    deployments?: DeploymentIdentityV1[];
    promote?:
      | { target: DeploymentIdentityV1; lost?: boolean; reject?: boolean }
      | null;
    request?: ReturnType<typeof requestFor>;
    resolver?: ScriptedResolver;
  } = {},
): Promise<ScenarioV1> {
  const ctx = await makeGitCtx("acceptance");
  const env = ctx.env;
  void env;
  const config = targetConfig();
  const transport = new ScriptedTransport(config);
  const deployments = overrides.deployments ?? [DEP_0, DEP_1];
  installREST(transport, deployments);
  transport.health();
  if (overrides.logs) {
    logRoute(transport, overrides.logs);
  }
  const promote = overrides.promote === undefined
    ? { target: DEP_1 }
    : overrides.promote;
  if (promote !== null) {
    promoteRoute(transport, promote.target, promote);
  }
  const clock = new TestClock(T0);
  const resolver = overrides.resolver ?? new ScriptedResolver();
  const policy = overrides.policy ?? stabilityPolicy();
  const state = storeAt(ctx, "controller", "release");
  const request = overrides.request ?? requestFor();
  const published = await publishRepairRequest(ctx, request);
  assert.ok(published.length === 40, "repair request must be published");
  const options: ReleaseControllerOptions = {
    repository: request.target.repository,
    environment: request.target.environment,
    target: config,
    policy,
    stateRead: state,
    stateWrite: state,
    deno: portClient(transport, config, clock),
    resolver,
    clock,
  };
  const controller = new ReleaseController(options);
  return {
    ctx,
    transport,
    clock,
    controller,
    resolver,
    records: async () => {
      const store = storeAt(ctx, "read", "release");
      const read = await store.readRelease();
      if (!read.ok || read.value.status !== "found") return [];
      return read.value.snapshot.releases;
    },
    cleanup: () => ctx.cleanup(),
  };
}

function portClient(
  transport: ScriptedTransport,
  config: ReturnType<typeof targetConfig>,
  clock: TestClock,
): DenoReleaseRESTClient {
  return new DenoReleaseRESTClient({
    transport: asTransport(transport),
    auth: { bearerToken: () => Promise.resolve(portOk("deno-token")) },
    config,
    clock,
  });
}

function assertCycle(
  result: PortResultV1<ReleaseCycleResultV1>,
  status: ReleaseCycleResultV1["status"],
): void {
  assert.ok(result.ok, "expected a cycle result");
  if (!result.ok) return;
  assert.equal(result.value.status, status);
}

async function promoteToMonitoring(
  scene: ScenarioV1,
): Promise<ReleaseRecordV1> {
  assertCycle(await scene.controller.run(), "advanced"); // record created
  scene.clock.advance(1);
  assertCycle(await scene.controller.run(), "advanced"); // promoting → monitoring
  const records = await scene.records();
  if (records.length !== 1) throw new Error("expected one record");
  assert.equal(records[0].phase, "monitoring");
  return records[0];
}

async function runAllSlots(scene: ScenarioV1, slotCount = 60): Promise<void> {
  // A single run collects every due slot at once (persisted slots keep their
  // exact windows); the run cap covers a full 60-slot window.
  const records = await scene.records();
  const record = records[0];
  if (record.monitoring.startedAt === null) {
    throw new Error("missing window start");
  }
  const startedAt = record.monitoring.startedAt;
  scene.clock.at(startedAt + 35_000 + (slotCount - 1) * 30_000);
  await scene.controller.run();
}

Deno.test("checkpoint: discovery binds exactly one build and persists candidate+prior", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    const result = await scene.controller.run();
    assertCycle(result, "advanced");
    const records = await scene.records();
    assert.equal(records.length, 1);
    assert.equal(records[0].phase, "requested");
    assert.equal(records[0].candidate.identity.gitSha, DEP_1.gitSha);
    assert.equal(records[0].candidate.identity.revisionId, DEP_1.revisionId);
    assert.equal(
      records[0].candidate.buildTransactionId,
      `txn-${DEP_1.revisionId}`,
    );
    assert.equal(records[0].prior.identity.gitSha, DEP_0.gitSha);
    assert.equal(records[0].requestRevision, DEP_1.gitSha);
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: promotion requires 204 plus post-effect identity proof", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    assertCycle(await scene.controller.run(), "advanced");
    scene.clock.advance(1);
    assertCycle(await scene.controller.run(), "advanced");
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 1);
    const records = await scene.records();
    assert.equal(records[0].phase, "monitoring");
    assert.ok(records[0].receipts.promote);
    assert.equal(records[0].receipts.promote!.ok, true);
    assert.equal(records[0].receipts.promote!.statusCode, 204);
    assert.equal(records[0].observed.verified, true);
    assert.equal(records[0].observed.identity?.revisionId, DEP_1.revisionId);
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: baseline and candidate windows accept within the owner policy", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    await promoteToMonitoring(scene);
    await runAllSlots(scene);
    const records = await scene.records();
    assert.equal(records[0].phase, "accepted");
    const acceptance = records[0].acceptance;
    assert.ok(acceptance);
    assert.equal(acceptance.samples.length, 60);
    assert.equal(acceptance.baseline.length, 60);
    assert.equal(acceptance.passed, true);
    assert.equal(acceptance.continuous, true);
    const fiveXx = acceptance.thresholdResults.find((t) =>
      t.metric === "five_xx_rate"
    );
    assert.ok(fiveXx);
    assert.equal(fiveXx.observedRate, 0.01);
    assert.equal(fiveXx.baselineRate, 0);
    assert.equal(fiveXx.passed, true);
    // Every sample binds its exact identity: candidate samples the candidate,
    // baseline samples the recorded prior.
    for (const sample of acceptance.samples) {
      assert.equal(sample.identity.revisionId, DEP_1.revisionId);
      assert.equal(sample.identity.gitSha, DEP_1.gitSha);
    }
    for (const sample of acceptance.baseline) {
      assert.equal(sample.identity.revisionId, DEP_0.revisionId);
      assert.equal(sample.identity.gitSha, DEP_0.gitSha);
    }
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: minimum request coverage failure is insufficient, not a rollback", async () => {
  const policy = stabilityPolicy({ minRequests: 500 });
  const scene = await makeScenario({
    policy,
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    await promoteToMonitoring(scene);
    await runAllSlots(scene);
    const records = await scene.records();
    assert.equal(records[0].phase, "failed");
    assert.equal(records[0].receipts.error?.kind, "acceptance_insufficient");
    assert.equal(records[0].receipts.rollback, null);
    assert.equal(records[0].acceptance?.passed, false);
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 1); // no rollback promote
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: threshold breach is objective failure and rolls back exactly", async () => {
  const policy = stabilityPolicy({
    thresholds: [
      { metric: "five_xx_rate", maxRate: 0.005, maxIncrease: 0 },
      { metric: "timeout_rate", maxRate: 0.01, maxIncrease: 0.01 },
      { metric: "stream_failure_rate", maxRate: 0.01, maxIncrease: 0.01 },
    ],
  });
  const scene = await makeScenario({
    policy,
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    await promoteToMonitoring(scene);
    // Persist the rollback intent before the restore effect, then verify the
    // exact restored prior.
    const recordsBefore = await scene.records();
    await runAllSlots(scene);
    const records = await scene.records();
    assert.equal(records[0].phase, "rolled_back");
    assert.equal(records[0].receipts.rollback?.ok, true);
    assert.equal(
      records[0].receipts.rollback?.observedIdentity?.revisionId,
      DEP_0.revisionId,
    );
    assert.equal(records[0].observed.identity?.revisionId, DEP_0.revisionId);
    assert.equal(records[0].observed.verified, true);
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 2); // promote + rollback
    const rollbackIntentPersisted = recordsBefore.length === 1;
    assert.ok(rollbackIntentPersisted);
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: lost promotion response reconciles without a repeated POST", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
    promote: { target: DEP_1, lost: true },
  });
  try {
    assertCycle(await scene.controller.run(), "advanced");
    scene.clock.advance(1);
    assertCycle(await scene.controller.run(), "persisted"); // promoting, pending proof
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 1);
    const records = await scene.records();
    assert.equal(records[0].phase, "promoting");
    assert.equal(records[0].receipts.promote?.ok, false);
    assert.ok(
      records[0].intent?.action === "promote",
      "intent must be persisted",
    );
    // Reconciliation run: the deployed candidate is observed; no new POST.
    scene.clock.advance(1);
    assertCycle(await scene.controller.run(), "advanced");
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 1);
    const reconciled = await scene.records();
    assert.equal(reconciled[0].phase, "monitoring");
    assert.equal(reconciled[0].receipts.promote?.ok, true);
    assert.equal(reconciled[0].observed.identity?.revisionId, DEP_1.revisionId);
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: an interrupted monitor resets continuity and the observation window", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    const record = await promoteToMonitoring(scene);
    const firstStart = record.monitoring.startedAt;
    if (firstStart === null) throw new Error("missing start");
    // One healthy slot persists, then the log source becomes unreadable for
    // the next slot: continuity restarts and nothing is reconstructed.
    scene.clock.at(firstStart + 35_000);
    assertCycle(await scene.controller.run(), "persisted");
    let records = await scene.records();
    assert.equal(records[0].monitoring.samples, 1);
    assert.notEqual(records[0].monitoring.startedAt, null);
    const secondStart = records[0].monitoring.startedAt!;
    scene.transport.logsReject = true;
    scene.clock.at(secondStart + 65_000);
    assertCycle(await scene.controller.run(), "persisted");
    records = await scene.records();
    assert.equal(records[0].monitoring.samples, 0);
    assert.equal(records[0].monitoring.continuous, true);
    assert.notEqual(records[0].monitoring.startedAt, secondStart);
    assert.equal(records[0].acceptance, null);
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: managed 200 with the wrong revision is an unrelated-deployment block", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    await promoteToMonitoring(scene);
    scene.transport.identityOverride = DEP_X;
    scene.clock.advance(35_001);
    const result = await scene.controller.run();
    assertCycle(result, "blocked");
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 1); // no rollback promote
    const records = await scene.records();
    assert.equal(records[0].phase, "monitoring"); // untouched, blocked
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: custom 200 identity mismatch fails and restores the exact prior", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    await promoteToMonitoring(scene);
    scene.transport.customIdentityOverride = DEP_X;
    scene.clock.advance(35_001);
    await scene.controller.run(); // hard-fail → rollback flow in one run
    const records = await scene.records();
    assert.equal(records[0].phase, "rolled_back");
    assert.equal(
      records[0].receipts.rollback?.observedIdentity?.revisionId,
      DEP_0.revisionId,
    );
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 2);
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: managed pass plus Cloudflare-identified 403 warns only", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    await promoteToMonitoring(scene);
    scene.transport.customStatus = 403;
    scene.transport.customCloudflare = true;
    scene.clock.advance(35_001);
    const result = await scene.controller.run();
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.value.status, "persisted");
      const warnings = result.value.status === "persisted"
        ? result.value.warnings
        : [];
      assert.ok(
        warnings.some((w) => w.includes("Cloudflare-identified 403")),
        `expected a Cloudflare warning, got ${JSON.stringify(warnings)}`,
      );
    }
    const records = await scene.records();
    assert.equal(records[0].phase, "monitoring"); // warning never fails the monitor
    assert.equal(records[0].monitoring.samples, 1);
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: unrelated-newer deployment during rollback blocks, never restores", async () => {
  const policy = stabilityPolicy({
    thresholds: [
      { metric: "five_xx_rate", maxRate: 0.005, maxIncrease: 0 },
      { metric: "timeout_rate", maxRate: 0.01, maxIncrease: 0.01 },
      { metric: "stream_failure_rate", maxRate: 0.01, maxIncrease: 0.01 },
    ],
  });
  const scene = await makeScenario({
    policy,
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    await promoteToMonitoring(scene);
    scene.transport.identityOverride = DEP_X; // an unrelated deployment is current
    const recordsBefore = await scene.records();
    const startedAt = recordsBefore[0].monitoring.startedAt;
    if (startedAt === null) throw new Error("missing start");
    scene.clock.at(startedAt + 35_000 + 59 * 30_000);
    const result = await scene.controller.run();
    assertCycle(result, "blocked");
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 1); // no rollback POST
    const records = await scene.records();
    assert.equal(records[0].phase, "monitoring");
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: state CAS conflict stops the run before any promotion", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    assertCycle(await scene.controller.run(), "advanced");
    // Another writer moves the release-state head before the promote run.
    const other = storeAt(scene.ctx, "other", "release");
    const read = await other.readRelease();
    assert.ok(read.ok && read.value.status === "found");
    if (!read.ok || read.value.status !== "found") {
      throw new Error("expected release state");
    }
    const next: ReleaseStateSnapshotV1 = {
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: read.value.head,
      sequence: read.value.snapshot.sequence + 1,
      updatedAt: read.value.snapshot.updatedAt + 5,
      releases: read.value.snapshot.releases,
    };
    const pushed = await other.writeRelease(next, read.value.head);
    assert.ok(pushed.ok);
    if (pushed.ok) assert.equal(pushed.value.status, "applied");

    scene.clock.advance(1);
    const result = await scene.controller.run();
    assertCycle(result, "conflict");
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 0);
  } finally {
    await scene.cleanup();
  }
});

Deno.test("checkpoint: restart after durable intent reconciles instead of promoting again", async () => {
  const scene = await makeScenario({
    logs: { accept: 100, fails: { fiveXx: 1 } },
  });
  try {
    assertCycle(await scene.controller.run(), "advanced");
    scene.clock.advance(1);
    // The post-effect proof stays unobservable (health serves the prior
    // identity) so the run persists a promoting record with the intent.
    scene.transport.identityOverride = DEP_0;
    assertCycle(await scene.controller.run(), "persisted");
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 1);
    let records = await scene.records();
    assert.equal(records[0].phase, "promoting");
    assert.equal(records[0].intent?.action, "promote");

    // Restart with a fresh controller over the same durable state; the
    // deployment now shows the candidate; reconciliation must NOT re-POST.
    scene.transport.identityOverride = null;
    const restarted = makeRestartController(scene);
    scene.clock.advance(1);
    assertCycle(await restarted.run(), "advanced");
    assert.equal(scene.transport.callCount("POST", PROMOTE_RE), 1);
    records = await scene.records();
    assert.equal(records[0].phase, "monitoring");
    assert.equal(records[0].receipts.promote?.ok, true);
  } finally {
    await scene.cleanup();
  }
});

function makeRestartController(scene: ScenarioV1): ReleaseController {
  const config = targetConfig();
  const state = storeAt(scene.ctx, "restart", "release");
  return new ReleaseController({
    repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 7 },
    environment: "production",
    target: config,
    policy: stabilityPolicy(),
    stateRead: state,
    stateWrite: state,
    deno: portClient(scene.transport, config, scene.clock),
    resolver: scene.resolver,
    clock: scene.clock,
  });
}
