/**
 * Hosted supervisor core: real temporary Git release-state store with an
 * injected evidence port. No model, network, GitHub or deployment calls; the
 * runtime execution itself is later acceptance, not claimed here.
 */
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import {
  parseHostedExecutionIntentV1,
  parseHostedNotStartedProofV1,
  parseHostedRunProofV1,
} from "../../src/contracts/hosted-supervisor.ts";
import type {
  HostedExecutionIntentV1,
  HostedExecutionSettlementV1,
} from "../../src/contracts/hosted-supervisor.ts";
import type {
  Clock,
  PortResultV1,
  ReleaseStateWriter,
  StateReadView,
  StateWriteResultV1,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { parseReleaseRequestV1 } from "../../src/contracts/release.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  runHostedSupervisorFinalize,
  runHostedSupervisorPrepare,
} from "../../src/host/actions-supervisor.ts";
import type {
  HostedSupervisorEvidencePortV1,
  HostedSupervisorOutcomeV1,
  HostedSupervisorRunIdentityV1,
} from "../../src/host/actions-supervisor.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
} from "../../src/state/mod.ts";
import { makeRemoteCtx, T0, testGitEnv } from "../state/helpers.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/host\/hosted-supervisor_test\.ts$/,
  "",
);

const HOUR_MS = 3_600_000;
const LAUNCHER = "1".repeat(40) as GitSha;
const CANDIDATE = "2".repeat(40) as GitSha;
const DIGEST = "a".repeat(64);
const SELF = { owner: "ubiquity", name: "sentinel", installationId: 0 };

class FakeClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

class FakeEvidence implements HostedSupervisorEvidencePortV1 {
  readonly settlements = new Map<string, HostedExecutionSettlementV1 | null>();
  readonly revisions = new Set<string>();
  readonly requests = new Set<string>();
  readFail = false;
  revisionFail = false;
  requestFail = false;

  readExecution(
    savedIntent: HostedExecutionIntentV1,
  ): Promise<PortResultV1<HostedExecutionSettlementV1 | null>> {
    if (this.readFail) {
      return Promise.resolve(portError("unavailable", "evidence unavailable"));
    }
    return Promise.resolve(
      portOk(this.settlements.get(savedIntent.id) ?? null),
    );
  }

  verifyRevision(revision: GitSha): Promise<PortResultV1<boolean>> {
    if (this.revisionFail) {
      return Promise.resolve(portError("unavailable", "revision unavailable"));
    }
    return Promise.resolve(portOk(this.revisions.has(revision)));
  }

  verifyRequest(request: ReleaseRequestV1): Promise<PortResultV1<boolean>> {
    if (this.requestFail) {
      return Promise.resolve(portError("unavailable", "request unavailable"));
    }
    return Promise.resolve(portOk(this.requests.has(request.id)));
  }
}

function execution(
  overrides: Record<string, unknown> = {},
): HostedExecutionIntentV1 {
  return parseHostedExecutionIntentV1({
    id: "1:1:repair",
    runId: 1,
    runAttempt: 1,
    launcherSha: LAUNCHER,
    purpose: "bootstrap",
    revision: LAUNCHER,
    generation: 1,
    releaseId: null,
    createdAt: T0,
    ...overrides,
  });
}

function runProof(
  intent: HostedExecutionIntentV1,
  outcome: "healthy" | "failed",
  overrides: Record<string, unknown> = {},
) {
  const healthy = outcome === "healthy";
  return parseHostedRunProofV1({
    execution: intent,
    workflowId: 357012162,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: "ubiquity/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: 7,
    startedAt: intent.createdAt + 1000,
    finishedAt: intent.createdAt + 2000,
    observedAt: intent.createdAt + 3000,
    outcome,
    startupReady: healthy,
    settled: true,
    baseSha: healthy ? intent.revision : null,
    terminalAt: healthy ? intent.createdAt + 1500 : null,
    logDigest: DIGEST,
    ...overrides,
  });
}

function skippedProof(intent: HostedExecutionIntentV1) {
  return parseHostedNotStartedProofV1({
    execution: intent,
    workflowId: 357012162,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: "ubiquity/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: null,
    finishedAt: intent.createdAt + 500,
    observedAt: intent.createdAt + 1000,
    outcome: "not_started",
    evidenceDigest: DIGEST,
  });
}

function releaseRequest(
  overrides: Record<string, unknown> = {},
): ReleaseRequestV1 {
  return parseReleaseRequestV1({
    version: "v1",
    kind: "release_request",
    id: "release-1",
    target: { repository: { ...SELF }, environment: "production" },
    revision: CANDIDATE,
    source: {
      pullRequest: 5,
      reviewRequestId: "review-req-1",
      reviewReceiptId: "review-receipt-1",
      head: CANDIDATE,
      base: LAUNCHER,
    },
    status: "open",
    failureReason: null,
    createdAt: T0 - 5000,
    ...overrides,
  });
}

function reviewReceipt(
  request: ReleaseRequestV1,
  overrides: Record<string, unknown> = {},
): ReviewReceiptV1 {
  return parseReviewReceiptV1({
    version: "v1",
    kind: "review_receipt",
    id: request.source.reviewReceiptId,
    requestId: request.source.reviewRequestId,
    expectedReviewer: "chatgpt-codex-connector[bot]",
    observedReviewer: "chatgpt-codex-connector[bot]",
    repository: { ...SELF },
    pullRequest: {
      number: request.source.pullRequest,
      head: request.source.head,
      base: request.source.base,
    },
    outcome: "completed",
    resultId: "result-1",
    summary: null,
    findings: [],
    findingsUncounted: 0,
    unresolvedSeverities: [],
    submittedAt: T0 - 2000,
    completedAt: T0 - 1000,
    observedAt: T0 - 500,
    ...overrides,
  });
}

function run(runId: number): HostedSupervisorRunIdentityV1 {
  return { runId, runAttempt: 1, launcherSha: LAUNCHER };
}

interface RigV1 {
  clock: FakeClock;
  evidence: FakeEvidence;
  release: ReturnType<typeof createReleaseStateStore>;
  repair: ReturnType<typeof createRepairStateStore>;
  prepare(
    run: HostedSupervisorRunIdentityV1,
  ): Promise<HostedSupervisorOutcomeV1>;
  finalize(
    run: HostedSupervisorRunIdentityV1,
  ): Promise<HostedSupervisorOutcomeV1>;
  snapshot(): Promise<ReleaseStateSnapshotV1>;
  seedRepair(
    requests: ReleaseRequestV1[],
    reviews: ReviewReceiptV1[],
  ): Promise<void>;
  cleanup(): Promise<void>;
}

async function makeRig(): Promise<RigV1> {
  const tmp = await Deno.makeTempDir({
    prefix: "sentinel-hosted-core-",
    dir: ROOT,
  });
  const env = testGitEnv(`${tmp}/git-home`);
  await Deno.mkdir(`${tmp}/git-home`, { recursive: true });
  const remote = await makeRemoteCtx(tmp, env);
  const release = createReleaseStateStore({
    scratchDir: `${tmp}/release-scratch`,
    remoteUrl: remote.remoteUrl,
  });
  const repair = createRepairStateStore({
    scratchDir: `${tmp}/repair-scratch`,
    remoteUrl: remote.remoteUrl,
  });
  const clock = new FakeClock(T0);
  const evidence = new FakeEvidence();
  return {
    clock,
    evidence,
    release,
    repair,
    prepare: (identity) =>
      runHostedSupervisorPrepare({
        clock,
        state: release,
        run: identity,
        evidence,
      }),
    finalize: (identity) =>
      runHostedSupervisorFinalize({
        clock,
        state: release,
        run: identity,
        evidence,
      }),
    snapshot: async () => {
      const read = await release.readRelease();
      assert.ok(read.ok && read.value.status === "found");
      if (!read.ok || read.value.status !== "found") {
        throw new Error("missing release state");
      }
      return read.value.snapshot;
    },
    seedRepair: async (requests, reviews) => {
      const current = await repair.readRepair();
      let head: GitSha | null = null;
      let sequence = 1;
      if (current.ok && current.value.status === "found") {
        head = current.value.head;
        sequence = current.value.snapshot.sequence + 1;
      }
      const seed = parseRepairStateSnapshotV1({
        version: "v1",
        kind: "repair_state_snapshot",
        stateHead: head,
        sequence,
        updatedAt: T0 + sequence,
        incidents: [],
        evidence: [],
        work: [],
        reservations: [],
        reviews,
        replays: [],
        releaseRequests: requests,
        githubCooldowns: [],
      });
      const written = await repair.writeRepair(seed, head);
      assert.ok(written.ok && written.value.status === "applied");
    },
    cleanup: async () => {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    },
  };
}

function requireRun(
  outcome: HostedSupervisorOutcomeV1,
): HostedExecutionIntentV1 {
  assert.equal(outcome.status, "run", JSON.stringify(outcome));
  if (outcome.status !== "run") throw new Error("expected a run decision");
  return outcome.execution;
}

/** Bootstrap the generation-1 pointer and settle one healthy bootstrap run. */
async function bootstrapHealthy(rig: RigV1): Promise<HostedExecutionIntentV1> {
  rig.evidence.revisions.add(LAUNCHER);
  const identity = run(1);
  const boot = requireRun(await rig.prepare(identity));
  rig.evidence.settlements.set(
    boot.id,
    runProof(boot, "healthy"),
  );
  assert.equal((await rig.finalize(identity)).status, "idle");
  return boot;
}

/** Drive bootstrap -> requested receipt -> healthy prior -> candidate run. */
async function advanceToCandidate(
  rig: RigV1,
): Promise<
  { candidate: HostedExecutionIntentV1; prior: HostedExecutionIntentV1 }
> {
  await bootstrapHealthy(rig);
  const request = releaseRequest();
  await rig.seedRepair([request], [reviewReceipt(request)]);
  rig.evidence.requests.add(request.id);
  const prior = requireRun(await rig.prepare(run(2)));
  assert.equal(prior.purpose, "prior");
  rig.evidence.settlements.set(prior.id, runProof(prior, "healthy"));
  const candidate = requireRun(await rig.prepare(run(3)));
  assert.equal(candidate.purpose, "candidate");
  return { candidate, prior };
}

Deno.test("hosted supervisor core: bootstrap is written once, replayed and settled exactly", async () => {
  const rig = await makeRig();
  try {
    rig.evidence.revisions.add(LAUNCHER);
    const identity = run(1);
    const first = requireRun(await rig.prepare(identity));
    assert.equal(first.purpose, "bootstrap");
    assert.equal(first.revision, LAUNCHER);
    assert.equal(first.generation, 1);
    // Exact same-run replay returns the same saved decision.
    assert.deepEqual(await rig.prepare(identity), {
      status: "run",
      execution: first,
    });
    // Missing evidence settles nothing.
    const before = await rig.snapshot();
    assert.equal((await rig.finalize(identity)).status, "pending");
    assert.deepEqual(await rig.snapshot(), before);
    rig.evidence.settlements.set(first.id, runProof(first, "healthy"));
    assert.equal((await rig.finalize(identity)).status, "idle");
    const after = await rig.snapshot();
    assert.equal(after.hostedRuntimes[0].execution, null);
    assert.equal(
      after.hostedRuntimes[0].lastExecutionProof?.outcome,
      "healthy",
    );
    assert.equal(
      after.hostedRuntimes[0].lastHealthyProof?.execution.id,
      first.id,
    );
    // A settled current run/attempt never schedules a second execution.
    assert.equal((await rig.prepare(identity)).status, "idle");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: ordinary cadence advances once per hour with no duplicate execution", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const identity = run(2);
    assert.equal((await rig.prepare(identity)).status, "idle");
    rig.clock.advance(HOUR_MS);
    const ordinary = requireRun(await rig.prepare(identity));
    assert.equal(ordinary.purpose, "ordinary");
    assert.equal(ordinary.revision, LAUNCHER);
    assert.deepEqual(await rig.prepare(identity), {
      status: "run",
      execution: ordinary,
    });
    const state = await rig.snapshot();
    assert.equal(
      state.hostedRuntimes[0].nextOrdinaryAt,
      ordinary.createdAt + HOUR_MS,
    );
    rig.evidence.settlements.set(ordinary.id, runProof(ordinary, "healthy"));
    assert.equal((await rig.finalize(identity)).status, "idle");
    // Same run/attempt cannot start a second execution even when due.
    rig.clock.advance(HOUR_MS);
    assert.equal((await rig.prepare(identity)).status, "idle");
    assert.equal(requireRun(await rig.prepare(run(3))).purpose, "ordinary");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: a lost write response is reconciled by exact reread", async () => {
  const rig = await makeRig();
  try {
    rig.evidence.revisions.add(LAUNCHER);
    let writes = 0;
    const state: StateReadView & ReleaseStateWriter = {
      readRelease: rig.release.readRelease.bind(rig.release),
      readRepair: rig.release.readRepair.bind(rig.release),
      writeRelease: async (next, expectedHead) => {
        writes++;
        const result = await rig.release.writeRelease(next, expectedHead);
        if (writes === 2) {
          return portOk<StateWriteResultV1>({
            status: "ambiguous",
            currentHead: null,
          });
        }
        return result;
      },
    };
    const result = await runHostedSupervisorPrepare({
      clock: rig.clock,
      state,
      run: run(1),
      evidence: rig.evidence,
    });
    const executionIntent = requireRun(result);
    assert.equal(writes, 2);
    const snapshot = await rig.snapshot();
    assert.equal(snapshot.hostedRuntimes[0].execution?.id, executionIntent.id);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: healthy prior promotes and a healthy candidate is accepted with times preserved", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const request = releaseRequest();
    await rig.seedRepair([request], [reviewReceipt(request)]);
    rig.evidence.requests.add(request.id);
    const prior = requireRun(await rig.prepare(run(2)));
    let state = await rig.snapshot();
    assert.equal(state.hostedReleases[0].phase, "requested");
    assert.equal(state.hostedReleases[0].priorRevision, LAUNCHER);
    const receiptCreatedAt = state.hostedReleases[0].createdAt;
    rig.evidence.settlements.set(prior.id, runProof(prior, "healthy"));
    const candidate = requireRun(await rig.prepare(run(3)));
    assert.equal(candidate.purpose, "candidate");
    assert.equal(candidate.revision, CANDIDATE);
    assert.equal(candidate.generation, 2);
    state = await rig.snapshot();
    assert.equal(state.hostedRuntimes[0].activeRevision, CANDIDATE);
    assert.equal(state.hostedRuntimes[0].generation, 2);
    assert.equal(
      state.hostedRuntimes[0].lastHealthyProof?.execution.id,
      prior.id,
    );
    assert.equal(state.hostedReleases[0].phase, "verifying");
    assert.equal(state.hostedReleases[0].priorProof?.execution.id, prior.id);
    rig.evidence.settlements.set(candidate.id, runProof(candidate, "healthy"));
    assert.equal((await rig.prepare(run(4))).status, "idle");
    state = await rig.snapshot();
    assert.equal(state.hostedReleases[0].phase, "accepted");
    assert.equal(
      state.hostedReleases[0].candidateProof?.execution.id,
      candidate.id,
    );
    assert.equal(state.hostedReleases[0].priorProof?.execution.id, prior.id);
    assert.equal(state.hostedReleases[0].createdAt, receiptCreatedAt);
    assert.equal(
      state.hostedRuntimes[0].lastHealthyProof?.execution.id,
      candidate.id,
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: failed candidate rolls back exactly and a later healthy rollback closes", async () => {
  const rig = await makeRig();
  try {
    const { candidate, prior } = await advanceToCandidate(rig);
    const receiptCreatedAt = (await rig.snapshot()).hostedReleases[0].createdAt;
    rig.evidence.settlements.set(candidate.id, runProof(candidate, "failed"));
    const rollback = requireRun(await rig.prepare(run(4)));
    assert.equal(rollback.purpose, "rollback");
    assert.equal(rollback.revision, LAUNCHER);
    assert.equal(rollback.generation, 3);
    let state = await rig.snapshot();
    assert.equal(state.hostedReleases[0].phase, "rollback_verifying");
    assert.equal(state.hostedReleases[0].candidateProof?.outcome, "failed");
    assert.equal(state.hostedReleases[0].rollbackProof, null);
    assert.equal(state.hostedRuntimes[0].activeRevision, LAUNCHER);
    assert.equal(state.hostedRuntimes[0].generation, 3);
    // A failed rollback keeps the healthy slot and retries on a later run.
    rig.evidence.settlements.set(rollback.id, runProof(rollback, "failed"));
    const retry = requireRun(await rig.prepare(run(5)));
    assert.equal(retry.purpose, "rollback");
    state = await rig.snapshot();
    assert.equal(state.hostedReleases[0].phase, "rollback_verifying");
    assert.equal(state.hostedReleases[0].rollbackProof, null);
    assert.equal(
      state.hostedRuntimes[0].lastHealthyProof?.execution.id,
      prior.id,
    );
    rig.evidence.settlements.set(retry.id, runProof(retry, "healthy"));
    assert.equal((await rig.prepare(run(6))).status, "idle");
    state = await rig.snapshot();
    assert.equal(state.hostedReleases[0].phase, "rolled_back");
    assert.equal(
      state.hostedReleases[0].rollbackProof?.execution.id,
      retry.id,
    );
    assert.equal(state.hostedReleases[0].priorProof?.execution.id, prior.id);
    assert.equal(state.hostedReleases[0].createdAt, receiptCreatedAt);
    assert.equal(
      state.hostedRuntimes[0].lastHealthyProof?.execution.id,
      retry.id,
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: missing, foreign or contradictory evidence never clears the intent", async () => {
  const rig = await makeRig();
  try {
    rig.evidence.revisions.add(LAUNCHER);
    const boot = requireRun(await rig.prepare(run(1)));
    const before = await rig.snapshot();
    const identity = run(2);
    // Missing settlement.
    assert.equal((await rig.prepare(identity)).status, "pending");
    assert.deepEqual(await rig.snapshot(), before);
    // Foreign settlement bound to a different execution.
    const foreign = runProof(
      execution({
        runId: 9,
        id: "9:1:repair",
        purpose: "ordinary",
        releaseId: null,
      }),
      "healthy",
    );
    rig.evidence.settlements.set(boot.id, foreign);
    assert.equal((await rig.prepare(identity)).status, "pending");
    assert.deepEqual(await rig.snapshot(), before);
    // Contradictory/malformed settlement for the saved execution.
    rig.evidence.settlements.set(boot.id, {
      ...runProof(boot, "healthy"),
      workflowId: 1,
    });
    assert.equal((await rig.prepare(identity)).status, "pending");
    assert.deepEqual(await rig.snapshot(), before);
    // Port failure is pending, never a clean empty success.
    rig.evidence.readFail = true;
    assert.equal((await rig.prepare(identity)).status, "pending");
    rig.evidence.readFail = false;
    assert.deepEqual(await rig.snapshot(), before);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: skipped execution settles as not_started and retries on a later run", async () => {
  const rig = await makeRig();
  try {
    rig.evidence.revisions.add(LAUNCHER);
    const identity = run(1);
    const boot = requireRun(await rig.prepare(identity));
    rig.evidence.settlements.set(boot.id, skippedProof(boot));
    assert.equal((await rig.finalize(identity)).status, "idle");
    let state = await rig.snapshot();
    assert.equal(
      state.hostedRuntimes[0].lastExecutionProof?.outcome,
      "not_started",
    );
    assert.equal(state.hostedRuntimes[0].lastHealthyProof, null);
    assert.equal(state.hostedRuntimes[0].activeRevision, LAUNCHER);
    assert.equal(state.hostedRuntimes[0].generation, 1);
    // No same-run resubmission; a later run/attempt retries the bootstrap.
    assert.equal((await rig.prepare(identity)).status, "idle");
    const retry = requireRun(await rig.prepare(run(2)));
    assert.equal(retry.id, "2:1:repair");
    assert.equal(retry.purpose, "bootstrap");
    state = await rig.snapshot();
    assert.equal(state.hostedRuntimes[0].execution?.id, retry.id);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: unreviewed or unverified requests never move the pointer", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const request = releaseRequest();
    const before = await rig.snapshot();
    // No completed review receipt -> not selectable.
    await rig.seedRepair([request], []);
    assert.equal((await rig.prepare(run(2))).status, "idle");
    let state = await rig.snapshot();
    assert.equal(state.hostedReleases.length, 0);
    assert.equal(
      state.hostedRuntimes[0].activeRevision,
      before.hostedRuntimes[0].activeRevision,
    );
    assert.equal(
      state.hostedRuntimes[0].generation,
      before.hostedRuntimes[0].generation,
    );
    // A completed review exists but the source verifier refuses.
    await rig.seedRepair([request], [reviewReceipt(request)]);
    assert.equal((await rig.prepare(run(3))).status, "pending");
    state = await rig.snapshot();
    assert.equal(state.hostedReleases.length, 0);
    // Verifier transport failure is pending too.
    rig.evidence.requestFail = true;
    assert.equal((await rig.prepare(run(4))).status, "pending");
    state = await rig.snapshot();
    assert.equal(state.hostedReleases.length, 0);
    assert.equal(state.hostedRuntimes[0].activeRevision, LAUNCHER);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: a competing CAS write is never overwritten", async () => {
  const rig = await makeRig();
  try {
    rig.evidence.revisions.add(LAUNCHER);
    let writes = 0;
    const state: StateReadView & ReleaseStateWriter = {
      readRelease: rig.release.readRelease.bind(rig.release),
      readRepair: rig.release.readRepair.bind(rig.release),
      writeRelease: async (next, expectedHead) => {
        writes++;
        if (writes === 2) {
          const read = await rig.release.readRelease();
          if (read.ok && read.value.status === "found") {
            const current = read.value.snapshot;
            await rig.release.writeRelease({
              ...current,
              sequence: current.sequence + 1,
              updatedAt: current.updatedAt + 1,
              stateHead: read.value.head,
            }, read.value.head);
          }
        }
        return rig.release.writeRelease(next, expectedHead);
      },
    };
    const result = await runHostedSupervisorPrepare({
      clock: rig.clock,
      state,
      run: run(1),
      evidence: rig.evidence,
    });
    assert.equal(result.status, "pending");
    const snapshot = await rig.snapshot();
    // The unrelated competing snapshot survives; no execution was written.
    assert.equal(snapshot.sequence, 2);
    assert.equal(snapshot.hostedRuntimes[0].execution, null);
    assert.equal(snapshot.hostedRuntimes[0].activeRevision, LAUNCHER);
    assert.equal(snapshot.hostedRuntimes[0].generation, 1);
    // The competing snapshot is one millisecond newer; the monotonic clock
    // must have advanced before the next write.
    rig.clock.advance(1);
    // A later clean prepare creates the bootstrap execution normally.
    assert.equal(requireRun(await rig.prepare(run(2))).purpose, "bootstrap");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: an exact ordinary not_started settlement restores due eligibility", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const identity = run(2);
    rig.clock.advance(HOUR_MS);
    const ordinary = requireRun(await rig.prepare(identity));
    const originalDue = (await rig.snapshot()).hostedRuntimes[0].nextOrdinaryAt;
    assert.equal(originalDue, ordinary.createdAt + HOUR_MS);
    const skipped = skippedProof(ordinary);
    rig.evidence.settlements.set(ordinary.id, skipped);
    assert.equal((await rig.finalize(identity)).status, "idle");
    let state = await rig.snapshot();
    assert.equal(
      state.hostedRuntimes[0].lastExecutionProof?.outcome,
      "not_started",
    );
    assert.equal(state.hostedRuntimes[0].lastHealthyProof?.outcome, "healthy");
    assert.equal(state.hostedRuntimes[0].nextOrdinaryAt, skipped.observedAt);
    assert.ok(state.hostedRuntimes[0].nextOrdinaryAt < originalDue);
    // Same run/attempt cannot resubmit.
    assert.equal((await rig.prepare(identity)).status, "idle");
    // A later run/attempt before the original hour deadline retries.
    rig.clock.advance(skipped.observedAt - rig.clock.now() + 1);
    assert.ok(rig.clock.now() < originalDue);
    const retry = requireRun(await rig.prepare(run(3)));
    assert.equal(retry.purpose, "ordinary");
    state = await rig.snapshot();
    assert.equal(state.hostedRuntimes[0].execution?.id, retry.id);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: promotion preflight requires the exact frozen source request", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const request = releaseRequest();
    await rig.seedRepair([request], [reviewReceipt(request)]);
    rig.evidence.requests.add(request.id);
    const prior = requireRun(await rig.prepare(run(2)));
    rig.evidence.settlements.set(prior.id, runProof(prior, "healthy"));
    // The repair-side source is cancelled; the frozen hosted request no
    // longer canonical-equals it, so the promote intent must not persist.
    const cancelled = releaseRequest({
      status: "cancelled",
      failureReason: "cancelled by owner",
    });
    await rig.seedRepair([cancelled], [reviewReceipt(cancelled)]);
    const before = await rig.snapshot();
    assert.equal((await rig.prepare(run(3))).status, "pending");
    const after = await rig.snapshot();
    assert.deepEqual(after.hostedReleases, before.hostedReleases);
    assert.equal(after.hostedRuntimes[0].execution?.id, prior.id);
    assert.equal(after.hostedRuntimes[0].activeRevision, LAUNCHER);
    assert.equal(after.hostedRuntimes[0].generation, 1);
  } finally {
    await rig.cleanup();
  }
});
