/**
 * Hosted supervisor core: real temporary Git release-state store with an
 * injected evidence port. No model, network, GitHub or deployment calls; the
 * runtime execution itself is later acceptance, not claimed here.
 */
import assert from "node:assert/strict";
import { GitHubApiClient } from "../../src/github/client.ts";
import type { HttpResponseV1 } from "../../src/github/http.ts";

import type { GitSha } from "../../src/contracts/brands.ts";
import {
  parseHostedExecutionIntentV1,
  parseHostedNotStartedProofV1,
  parseHostedReleaseRecordV1,
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
import {
  parseReviewReceiptV1,
  reviewTaskStatementDigest,
  type ReviewTaskStatementV1,
} from "../../src/contracts/review-receipt.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  runHostedSupervisorFinalize,
  runHostedSupervisorHost,
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
import {
  gitRun,
  makeRemoteCtx,
  sha256Hex,
  T0,
  testGitEnv,
} from "../state/helpers.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { HOSTED_RUNTIME_ID } from "../../src/contracts/hosted-supervisor.ts";
import { planOwnerDevelopmentInstall } from "../../src/host/owner-development-install.ts";
import { runActionsTargetCycles } from "../../src/host/actions.ts";
import {
  createLocalRepositoryConfig,
  unavailableIncidents,
  unavailableReplay,
} from "../../src/host/local.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/host\/hosted-supervisor_test\.ts$/,
  "",
);

const LAUNCHER = "1".repeat(40) as GitSha;
const CANDIDATE = "2".repeat(40) as GitSha;
const DIGEST = "a".repeat(64);
const RECOVERY_REVISION = "c79b2b87a6a2dd0adc201895af10806ef7a9c600" as GitSha;
const RECOVERY_OLD_LAUNCHER =
  "6468457a7b293ec489b6e00fa9fef062f7914abe" as GitSha;
const RECOVERY_HEALTH_LAUNCHER =
  "bf1d0300f9634feb6541f2d7e96cbfe4bba7dfe0" as GitSha;
const RECOVERY_HEALTH_DIGEST =
  "c031f4a39f3eac1ff64c8f6bce28eb733ff4dfe1ea5d813dcfb31d08ffce1cf3";
const SELF = { owner: "ubiquity", name: "sentinel", installationId: 0 };
/** The exact source issue the fixture release request delivers. */
const ISSUE = 48;
const TASK_TITLE = "Deliver the reviewed hosted supervisor candidate";
const TASK_BODY = "The protected supervisor must select this release request.";
const TASK_DIGEST = await reviewTaskStatementDigest({
  issueNumber: ISSUE,
  title: TASK_TITLE,
  body: TASK_BODY,
});
const TASK: ReviewTaskStatementV1 = {
  issueNumber: ISSUE,
  title: TASK_TITLE,
  body: TASK_BODY,
  digest: TASK_DIGEST,
};

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
  /** Per-issue trusted statements; an absent entry is the bound fixture task. */
  readonly tasks = new Map<number, ReviewTaskStatementV1 | null>();
  readFail = false;
  revisionFail = false;
  requestFail = false;
  taskFail = false;
  taskCalls = 0;
  readonly matrixCalls: GitSha[] = [];
  completed = true;
  readonly completionCalls: HostedExecutionIntentV1[] = [];

  confirmCompletedExecution(intent: HostedExecutionIntentV1): Promise<boolean> {
    this.completionCalls.push(intent);
    return Promise.resolve(this.completed);
  }

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

  verifyMatrixOrdinaryRevision(
    revision: GitSha,
  ): Promise<PortResultV1<boolean>> {
    this.matrixCalls.push(revision);
    return Promise.resolve(portOk(true));
  }

  verifyRequest(request: ReleaseRequestV1): Promise<PortResultV1<boolean>> {
    if (this.requestFail) {
      return Promise.resolve(portError("unavailable", "request unavailable"));
    }
    return Promise.resolve(portOk(this.requests.has(request.id)));
  }

  readIssueTask(
    issueNumber: number,
  ): Promise<PortResultV1<ReviewTaskStatementV1 | null>> {
    this.taskCalls++;
    if (this.taskFail) {
      return Promise.resolve(portError("unavailable", "issue unavailable"));
    }
    const task = this.tasks.get(issueNumber);
    return Promise.resolve(portOk(task === undefined ? TASK : task));
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
    expectedReviewer: "ubiquity-sentinel[bot]",
    observedReviewer: "ubiquity-sentinel[bot]",
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
    taskAcceptance: {
      issueNumber: ISSUE,
      taskDigest: TASK_DIGEST,
      verdict: "fulfilled",
      evidence: ["the reviewed candidate satisfies the source issue"],
    },
    ...overrides,
  });
}

/**
 * The exact EXISTING work record that published the request. The supervisor
 * binds the trusted issue read to this record's own source issue; without it
 * no release is selectable.
 */
function workRecordFor(
  request: ReleaseRequestV1,
  overrides: Record<string, unknown> = {},
) {
  return parseWorkRecordV1({
    version: "v1",
    kind: "work",
    repository: { ...SELF },
    id: `issue-ubiquity-sentinel-${ISSUE}`,
    source: { kind: "issue", id: String(ISSUE), revision: LAUNCHER },
    related: { incidentId: null, issueNumber: ISSUE },
    fingerprint: null,
    failingRevision: null,
    sourceSnapshotDigest: null,
    classification: { severity: "P2", priority: null },
    urgency: {
      activeProduction: false,
      reproducible5xx: false,
      severeSecurityOrDataLoss: false,
    },
    dependencies: [],
    controller: { sha: LAUNCHER },
    target: {
      base: request.source.base,
      branch: `sentinel/repair/issue-ubiquity-sentinel-${ISSUE}`,
      checkpoint: null,
      head: request.source.head,
      pr: request.source.pullRequest,
    },
    nextStep: "delivery",
    wait: null,
    blocker: null,
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    evidence: [{
      kind: "review_receipt",
      ref: `artifact:${request.source.reviewReceiptId ?? "none"}`,
    }],
    intent: null,
    firstSeenAt: T0,
    createdAt: T0,
    updatedAt: T0,
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
    overrides?: Record<string, unknown>,
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
    seedRepair: async (requests, reviews, overrides = {}) => {
      const current = await repair.readRepair();
      const existing: RepairStateSnapshotV1 | null =
        current.ok && current.value.status === "found"
          ? current.value.snapshot
          : null;
      const head: GitSha | null = current.ok && current.value.status === "found"
        ? current.value.head
        : null;
      const sequence = (existing?.sequence ?? 0) + 1;
      // Real repair writers only append or update records in place. Seeding
      // preserves every durable record and replaces a record only under its
      // own id, so the store's immutable-identity and terminal-state guards
      // stay in force instead of being bypassed.
      const mergeById = <T extends { id: string }>(
        prior: readonly T[],
        next: readonly T[],
      ): T[] => {
        const merged = [...prior];
        for (const record of next) {
          const at = merged.findIndex((item) => item.id === record.id);
          if (at === -1) merged.push(record);
          else merged[at] = record;
        }
        return merged;
      };
      const seed = parseRepairStateSnapshotV1({
        version: "v1",
        kind: "repair_state_snapshot",
        stateHead: head,
        sequence,
        updatedAt: T0 + sequence,
        incidents: existing?.incidents ?? [],
        evidence: existing?.evidence ?? [],
        work: mergeById(
          existing?.work ?? [],
          requests.map((request) => workRecordFor(request, overrides)),
        ),
        reservations: existing?.reservations ?? [],
        reviews: mergeById(existing?.reviews ?? [], reviews),
        replays: existing?.replays ?? [],
        releaseRequests: mergeById(existing?.releaseRequests ?? [], requests),
        githubCooldowns: existing?.githubCooldowns ?? [],
      });
      const written = await repair.writeRepair(seed, head);
      if (!written.ok) {
        throw new Error(
          `repair seed transport failed: ${written.error.kind}: ${written.error.detail}`,
        );
      }
      assert.equal(
        written.value.status,
        "applied",
        `repair seed refused: ${JSON.stringify(written.value)}`,
      );
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

async function recoveryRig(overrides: Record<string, unknown> = {}) {
  const root = await Deno.makeTempDir({
    prefix: "same-pointer-recovery-",
    dir: ROOT,
  });
  const env = testGitEnv(`${root}/git-home`);
  await Deno.mkdir(`${root}/git-home`);
  const remote = await makeRemoteCtx(root, env);
  const prior = runProof(
    execution({
      id: "37134515396:1:repair",
      runId: 37134515396,
      launcherSha: RECOVERY_HEALTH_LAUNCHER,
      revision: RECOVERY_REVISION,
      generation: 59,
    }),
    "healthy",
    { logDigest: RECOVERY_HEALTH_DIGEST, jobId: 111236538381 },
  );
  const skipped = skippedProof(
    execution({
      id: "37148984941:1:repair",
      runId: 37148984941,
      launcherSha: RECOVERY_OLD_LAUNCHER,
      revision: RECOVERY_REVISION,
      generation: 59,
      purpose: "ordinary",
      createdAt: T0 + 4000,
    }),
  );
  const snapshot = parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0 + 6000,
    releases: [],
    hostedReleases: [],
    githubCooldowns: [],
    hostedRuntimes: [{
      version: "v1",
      kind: "hosted_runtime",
      id: HOSTED_RUNTIME_ID,
      activeRevision: RECOVERY_REVISION,
      generation: 59,
      execution: null,
      lastHealthyProof: prior,
      lastExecutionProof: skipped,
      nextOrdinaryAt: T0,
      createdAt: T0,
      updatedAt: T0 + 6000,
      ...overrides,
    }],
  });
  const files = {
    "manifest.json": canonicalStringify({
      version: "v1",
      kind: "release_state_manifest",
      stateHead: null,
      sequence: 1,
      updatedAt: snapshot.updatedAt,
    }) + "\n",
    [`hostedRuntimes/${await sha256Hex(HOSTED_RUNTIME_ID)}.json`]:
      canonicalStringify(snapshot.hostedRuntimes[0]) + "\n",
  };
  for (const [path, text] of Object.entries(files)) {
    await Deno.mkdir(
      `${remote.work}/${path}`.slice(
        0,
        `${remote.work}/${path}`.lastIndexOf("/"),
      ),
      { recursive: true },
    );
    await Deno.writeTextFile(`${remote.work}/${path}`, text);
  }
  for (
    const args of [["add", "-A"], [
      "commit",
      "-qm",
      "parsed historical quarantine fixture",
    ], ["push", "-q", "origin", "HEAD:refs/heads/sentinel-state/release"]]
  ) {
    const result = await gitRun(remote.work, args, env);
    assert.equal(result.code, 0, result.stderr);
  }
  const state = createReleaseStateStore({
    scratchDir: `${root}/scratch`,
    remoteUrl: remote.remoteUrl,
  });
  const repair = createRepairStateStore({
    scratchDir: `${root}/repair-scratch`,
    remoteUrl: remote.remoteUrl,
  });
  const seededRepair = await repair.writeRepair(
    parseRepairStateSnapshotV1({
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0 + 6000,
      incidents: [],
      evidence: [],
      work: [],
      reservations: [],
      reviews: [],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
    }),
    null,
  );
  assert.ok(
    seededRepair.ok && seededRepair.value.status === "applied",
    JSON.stringify(seededRepair),
  );
  const evidence = new FakeEvidence();
  const clock = new FakeClock(T0 + 10000);
  const latest = snapshot.hostedRuntimes[0].lastExecutionProof;
  if (latest !== null) {
    evidence.settlements.set(latest.execution.id, {
      ...latest,
      observedAt: latest.observedAt + 1,
    });
  }
  const read = async () => {
    const result = await state.readRelease();
    if (!result.ok || result.value.status !== "found") {
      throw new Error("missing recovery state");
    }
    return result.value;
  };
  return {
    root,
    state,
    evidence,
    clock,
    prior,
    skipped,
    read,
    prepare: (identity = run(72)) =>
      runHostedSupervisorPrepare({ state, evidence, clock, run: identity }),
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

Deno.test("same-pointer recovery: exact canceled71 admits one model-disabled bootstrap and healthy finalization restores installer eligibility", async () => {
  const rig = await recoveryRig();
  try {
    const planned = requireRun(await rig.prepare());
    assert.equal(planned.purpose, "bootstrap");
    assert.equal(planned.revision, RECOVERY_REVISION);
    assert.equal(planned.generation, 59);
    const started = (await rig.read()).snapshot.hostedRuntimes[0];
    assert.deepEqual(started.lastHealthyProof, rig.prior);
    assert.deepEqual(started.lastExecutionProof, rig.skipped);
    assert.equal(requireRun(await rig.prepare()).id, planned.id);
    assert.equal((await rig.prepare(run(73))).status, "pending");
    rig.evidence.settlements.set(planned.id, runProof(planned, "healthy"));
    rig.clock.advance(4000);
    const finalized = await runHostedSupervisorFinalize({
      state: rig.state,
      evidence: rig.evidence,
      clock: rig.clock,
      run: run(72),
    });
    assert.equal(finalized.status, "idle");
    const healthy = (await rig.read()).snapshot;
    assert.equal(healthy.hostedRuntimes[0].activeRevision, RECOVERY_REVISION);
    assert.equal(healthy.hostedRuntimes[0].generation, 59);
    assert.equal(healthy.hostedRuntimes[0].execution, null);
    assert.equal(
      healthy.hostedRuntimes[0].lastHealthyProof?.execution.id,
      planned.id,
    );
    assert.equal(
      planOwnerDevelopmentInstall(healthy, rig.clock.now()).status,
      "install",
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("same-pointer recovery: a freshly authenticated newer failed old-controller ordinary admits bootstrap without changing proofs", async () => {
  const failed = runProof(
    execution({
      id: "37156933037:1:repair",
      runId: 37156933037,
      launcherSha: RECOVERY_OLD_LAUNCHER,
      revision: RECOVERY_REVISION,
      generation: 59,
      purpose: "ordinary",
      createdAt: T0 + 4000,
    }),
    "failed",
  );
  const rig = await recoveryRig({ lastExecutionProof: failed });
  try {
    const planned = requireRun(await rig.prepare());
    assert.equal(planned.purpose, "bootstrap");
    assert.equal(planned.revision, RECOVERY_REVISION);
    assert.equal(planned.generation, 59);
    const after = (await rig.read()).snapshot.hostedRuntimes[0];
    assert.deepEqual(after.lastHealthyProof, rig.prior);
    assert.deepEqual(after.lastExecutionProof, failed);
    assert.deepEqual(rig.evidence.completionCalls, [failed.execution]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("same-pointer recovery: missing incomplete unavailable or changed native proof refuses without a state write", async () => {
  for (
    const control of [
      "missing",
      "incomplete",
      "unavailable",
      "absent",
      "digest",
      "binding",
      "backward",
      "cursor",
    ]
  ) {
    const rig = await recoveryRig();
    try {
      const evidence: HostedSupervisorEvidencePortV1 = rig.evidence;
      if (control === "missing") evidence.confirmCompletedExecution = undefined;
      if (control === "incomplete") rig.evidence.completed = false;
      if (control === "unavailable") {
        evidence.confirmCompletedExecution = () =>
          Promise.reject(new Error("offline incomplete native response"));
      }
      const fresh = { ...rig.skipped, observedAt: rig.skipped.observedAt + 1 };
      if (control === "absent") {
        rig.evidence.settlements.set(fresh.execution.id, null);
      }
      if (control === "digest") {
        rig.evidence.settlements.set(fresh.execution.id, {
          ...fresh,
          evidenceDigest: "b".repeat(64),
        });
      }
      if (control === "binding") {
        rig.evidence.settlements.set(fresh.execution.id, {
          ...fresh,
          execution: { ...fresh.execution, launcherSha: LAUNCHER },
        });
      }
      if (control === "backward") {
        rig.evidence.settlements.set(fresh.execution.id, {
          ...fresh,
          observedAt: rig.skipped.observedAt - 1,
        });
      }
      let completed = false;
      if (control === "cursor") {
        evidence.confirmCompletedExecution = () => {
          completed = true;
          return Promise.resolve(true);
        };
      }
      const before = await rig.read();
      const state: StateReadView & ReleaseStateWriter = {
        readRepair: rig.state.readRepair.bind(rig.state),
        readRelease: async () => {
          const read = await rig.state.readRelease();
          return completed && read.ok && read.value.status === "found"
            ? portOk({ ...read.value, head: CANDIDATE })
            : read;
        },
        writeRelease: rig.state.writeRelease.bind(rig.state),
      };
      const outcome = await runHostedSupervisorPrepare({
        state,
        evidence,
        clock: rig.clock,
        run: run(72),
      });
      assert.equal(outcome.status, "pending", control);
      assert.deepEqual(await rig.read(), before, control);
    } finally {
      await rig.cleanup();
    }
  }
});

Deno.test("same-pointer recovery: wrong proof identity and failed verification refuse repeated broken ordinary", async () => {
  for (
    const mutation of [
      { lastExecutionProof: null },
      { lastHealthyProof: null },
      { generation: 60 },
      { activeRevision: CANDIDATE, generation: 60 },
      {
        lastExecutionProof: skippedProof(
          execution({
            id: "37148984942:1:repair",
            runId: 37148984942,
            launcherSha: RECOVERY_OLD_LAUNCHER,
            revision: RECOVERY_REVISION,
            generation: 59,
            purpose: "ordinary",
          }),
        ),
      },
      {
        lastHealthyProof: runProof(
          execution({
            id: "37134515396:1:repair",
            runId: 37134515396,
            launcherSha: RECOVERY_HEALTH_LAUNCHER,
            revision: RECOVERY_REVISION,
            generation: 59,
          }),
          "healthy",
        ),
      },
      {
        lastExecutionProof: skippedProof(
          execution({
            id: "37148984941:2:repair",
            runId: 37148984941,
            runAttempt: 2,
            launcherSha: RECOVERY_OLD_LAUNCHER,
            revision: RECOVERY_REVISION,
            generation: 59,
            purpose: "ordinary",
          }),
        ),
      },
      {
        lastExecutionProof: skippedProof(
          execution({
            id: "37148984941:1:repair",
            runId: 37148984941,
            launcherSha: LAUNCHER,
            revision: RECOVERY_REVISION,
            generation: 59,
            purpose: "ordinary",
          }),
        ),
      },
      {
        lastExecutionProof: runProof(
          execution({
            id: "72:1:repair",
            runId: 72,
            revision: RECOVERY_REVISION,
            generation: 59,
          }),
          "failed",
        ),
      },
    ]
  ) {
    const rig = await recoveryRig(mutation);
    try {
      assert.equal((await rig.prepare(run(73))).status, "pending");
      assert.equal(
        (await rig.read()).snapshot.hostedRuntimes[0].execution,
        null,
      );
    } finally {
      await rig.cleanup();
    }
  }
});

for (const nativeCompletion of [false, true]) {
  Deno.test(`same-pointer recovery: ${nativeCompletion ? "native completion transport" : "real protected host"} emits false model permission and honors native source and cursor checks`, async () => {
    const nativeIntent = execution({
      id: "37163248125:1:repair",
      runId: 37163248125,
      launcherSha: RECOVERY_OLD_LAUNCHER,
      revision: RECOVERY_REVISION,
      generation: 59,
      purpose: "ordinary",
      createdAt: T0 + 4000,
    });
    const attempt = {
      id: nativeIntent.runId,
      run_attempt: 1,
      workflow_id: 357012162,
      path: ".github/workflows/supervisor.yml",
      event: "workflow_dispatch",
      head_branch: "sentinel-supervisor",
      head_sha: RECOVERY_OLD_LAUNCHER,
      repository: { id: 1, full_name: "ubiquity/sentinel" },
      head_repository: { id: 1, full_name: "ubiquity/sentinel" },
      status: "completed",
      run_started_at: new Date(T0 + 4000).toISOString(),
      updated_at: new Date(T0 + 4500).toISOString(),
    };
    const jobs = { total_count: 0, jobs: [] };
    const latest = parseHostedNotStartedProofV1({
      ...skippedProof(nativeIntent),
      evidenceDigest: await sha256Hex(canonicalStringify({ attempt, jobs })),
    });
    const rig = await recoveryRig({ lastExecutionProof: latest });
    try {
      const outputs = new Map<string, string>();
      const treeIds = ["a", "b", "c", "d"].map((letter) => letter.repeat(40));
      const http: Parameters<typeof runHostedSupervisorHost>[0]["http"] = (
        request,
      ) => {
        const path = new URL(request.url).pathname;
        let body: unknown;
        if (path.endsWith(`/runs/${nativeIntent.runId}/attempts/1/jobs`)) {
          body = jobs;
        } else if (path.endsWith(`/runs/${nativeIntent.runId}/attempts/1`)) {
          body = attempt;
        } else if (path.endsWith(`/git/commits/${RECOVERY_REVISION}`)) {
          body = { sha: RECOVERY_REVISION, tree: { sha: treeIds[0] } };
        } else {
          const at = treeIds.indexOf(path.split("/").at(-1)!);
          assert.ok(at >= 0 && at < 3, path);
          body = {
            sha: treeIds[at],
            truncated: false,
            tree: [{
              path: ["src", "host", "matrix-actions.ts"][at],
              type: at === 2 ? "blob" : "tree",
              mode: at === 2 ? "100644" : "040000",
              sha: treeIds[at + 1],
            }],
          };
        }
        return Promise.resolve({
          status: 200,
          headers: new Headers(),
          bodyText: JSON.stringify(body),
        });
      };
      const process: Parameters<typeof runHostedSupervisorHost>[0]["process"] =
        {
          run: (input) => {
            assert.ok(
              input.executable === "git" || input.executable === "/usr/bin/git",
            );
            const text = input.args.includes("rev-parse")
              ? `${LAUNCHER}\n`
              : "";
            return Promise.resolve({
              outcome: "exited",
              exitCode: 0,
              signal: null,
              stdout: new TextEncoder().encode(text),
              stderr: new Uint8Array(),
              truncated: false,
              settled: true,
              durationMs: 0,
              detail: "offline source identity",
            });
          },
        };
      const hostInput: Parameters<typeof runHostedSupervisorHost>[0] = {
        sourceDir: rig.root,
        clock: rig.clock,
        state: rig.state,
        http,
        process,
        ...(nativeCompletion ? {} : {
          matrixArtifacts: {
            confirmCompletedExecution: rig.evidence.confirmCompletedExecution
              .bind(rig.evidence),
          },
        }),
        env: {
          GITHUB_REPOSITORY: "ubiquity/sentinel",
          GITHUB_REF: "refs/heads/sentinel-supervisor",
          GITHUB_JOB: "prepare",
          GITHUB_RUN_ID: "72",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_SHA: LAUNCHER,
          GITHUB_WORKFLOW_SHA: LAUNCHER,
          GITHUB_WORKFLOW_REF:
            "ubiquity/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor",
          GITHUB_TOKEN: "offline-native-token-value",
        },
        writeOutput: (name, value) => {
          outputs.set(name, value);
          return Promise.resolve();
        },
      };
      const originalCwd = Deno.cwd();
      let result: Awaited<ReturnType<typeof runHostedSupervisorHost>>;
      try {
        if (nativeCompletion) Deno.chdir(rig.root);
        result = await runHostedSupervisorHost(hostInput);
      } finally {
        if (nativeCompletion) Deno.chdir(originalCwd);
      }
      assert.equal(result.execution?.purpose, "bootstrap");
      assert.equal(outputs.get("modelStartsEnabled"), "false");
      assert.equal(outputs.get("revision"), RECOVERY_REVISION);
      assert.equal(result.execution?.generation, 59);
      await assert.rejects(() =>
        runHostedSupervisorHost({
          ...hostInput,
          env: { ...hostInput.env, GITHUB_WORKFLOW_SHA: CANDIDATE },
        })
      );
      await assert.rejects(() =>
        runHostedSupervisorHost({
          ...hostInput,
          env: { ...hostInput.env, GITHUB_JOB: "repair" },
        })
      );
      assert.deepEqual(
        (await rig.read()).snapshot.hostedRuntimes[0].lastHealthyProof,
        rig.prior,
      );
      let cycles = 0;
      let modelStarts = 0;
      const capability = {} as never;
      const aggregate = await runActionsTargetCycles({
        clock: rig.clock,
        state: capability,
        configs: [createLocalRepositoryConfig()],
        controllerSha: RECOVERY_REVISION,
        githubCooldown: capability,
        incidents: unavailableIncidents,
        replay: unavailableReplay,
        model: capability,
        budget: capability,
        deadline: rig.clock.now() + 60000,
        stepLimit: 1,
        modelStartsEnabled: outputs.get("modelStartsEnabled") === "true",
        composeGithub: () => capability,
        runCycle: (_deps, options) => {
          cycles++;
          if (options.modelStartsEnabled) modelStarts++;
          assert.equal(options.modelStartsEnabled, false);
          return Promise.resolve(
            { status: "idle", detail: "offline verification cycle" } as const,
          );
        },
      });
      assert.equal(cycles, 1);
      assert.equal(modelStarts, 0);
      assert.equal(aggregate.addressed.length, 1);
    } finally {
      await rig.cleanup();
    }
  });
}

Deno.test("same-pointer recovery: owner release cooldown capability cursor CAS and no-loop controls refuse unsafe admission", async () => {
  for (
    const control of [
      "owner",
      "release",
      "cooldown",
      "capability",
      "cursor",
      "cas",
      "failed",
      "not_started",
      "healthy",
    ]
  ) {
    const owner = execution({
      id: "74:1:repair",
      runId: 74,
      revision: RECOVERY_REVISION,
      generation: 59,
      purpose: "ordinary",
    });
    const rig = await recoveryRig(
      control === "owner" ? { execution: owner } : {},
    );
    try {
      if (
        control === "failed" || control === "not_started" ||
        control === "healthy"
      ) {
        const admitted = requireRun(await rig.prepare());
        const settlement = control === "not_started"
          ? skippedProof(admitted)
          : runProof(admitted, control === "healthy" ? "healthy" : "failed");
        rig.evidence.settlements.set(admitted.id, settlement);
        rig.clock.advance(4000);
        await runHostedSupervisorFinalize({
          state: rig.state,
          evidence: rig.evidence,
          clock: rig.clock,
          run: run(72),
        });
        const next = await rig.prepare(run(73));
        if (control === "healthy") {
          assert.equal(requireRun(next).purpose, "ordinary");
        } else {
          assert.equal(next.status, "pending");
          assert.equal(
            (await rig.read()).snapshot.hostedRuntimes[0].execution,
            null,
          );
        }
        assert.deepEqual(
          (await rig.read()).snapshot.hostedRuntimes[0].lastExecutionProof,
          settlement,
        );
        continue;
      }
      let sourceRead = false;
      if (control === "capability" || control === "cursor") {
        rig.evidence.verifyMatrixOrdinaryRevision = () => {
          sourceRead = true;
          return Promise.resolve(portOk(control !== "capability"));
        };
      }
      const state: StateReadView & ReleaseStateWriter = {
        readRepair: rig.state.readRepair.bind(rig.state),
        readRelease: async () => {
          const read = await rig.state.readRelease();
          if (!read.ok || read.value.status !== "found") return read;
          let snapshot = read.value.snapshot;
          if (control === "cooldown") {
            snapshot = parseReleaseStateSnapshotV1({
              ...snapshot,
              githubCooldowns: [{
                installationId: 0,
                retryNotBefore: rig.clock.now() + 60000,
                observedAt: T0,
                observationId: DIGEST,
                secondaryBackoff: 0,
              }],
            });
          }
          if (control === "release") {
            const request = releaseRequest();
            snapshot = parseReleaseStateSnapshotV1({
              ...snapshot,
              hostedReleases: [parseHostedReleaseRecordV1({
                version: "v1",
                kind: "hosted_release",
                id: request.id,
                request,
                priorRevision: RECOVERY_REVISION,
                phase: "requested",
                priorProof: null,
                candidateProof: null,
                rollbackProof: null,
                pointerIntent: null,
                createdAt: T0,
                updatedAt: T0,
              })],
            });
          }
          return portOk({
            ...read.value,
            snapshot,
            head: control === "cursor" && sourceRead
              ? "f".repeat(40) as GitSha
              : read.value.head,
          });
        },
        writeRelease: control === "cas"
          ? () =>
            Promise.resolve(
              portOk<StateWriteResultV1>({
                status: "conflict",
                currentHead: null,
              }),
            )
          : rig.state.writeRelease.bind(rig.state),
      };
      const result = await runHostedSupervisorPrepare({
        state,
        evidence: rig.evidence,
        clock: rig.clock,
        run: run(72),
      });
      assert.notEqual(result.status, "run", control);
      assert.deepEqual(
        (await rig.read()).snapshot.hostedRuntimes[0].execution,
        control === "owner" ? owner : null,
      );
      assert.deepEqual(
        (await rig.read()).snapshot.hostedRuntimes[0].lastHealthyProof,
        rig.prior,
      );
    } finally {
      await rig.cleanup();
    }
  }
});

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

Deno.test("hosted supervisor core: ordinary cadence advances on each dispatch with no duplicate execution", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const identity = run(2);
    // No artificial hour cooldown: once the prior execution actually settled,
    // the next scheduled dispatch is immediately due for ordinary work.
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
      ordinary.createdAt,
    );
    rig.evidence.settlements.set(ordinary.id, runProof(ordinary, "healthy"));
    assert.equal((await rig.finalize(identity)).status, "idle");
    // A legacy one-hour due timestamp cannot restore a retired cadence limit.
    // Keep the exact settled proof and pointer while writing that old schema
    // value through the real Git state store, then dispatch before one minute.
    const current = await rig.release.readRelease();
    assert.ok(current.ok && current.value.status === "found");
    if (!current.ok || current.value.status !== "found") {
      throw new Error("missing legacy cadence fixture state");
    }
    rig.clock.advance(1);
    const legacy = parseReleaseStateSnapshotV1({
      ...current.value.snapshot,
      stateHead: current.value.head,
      sequence: current.value.snapshot.sequence + 1,
      updatedAt: rig.clock.now(),
      hostedRuntimes: current.value.snapshot.hostedRuntimes.map((runtime) => ({
        ...runtime,
        nextOrdinaryAt: ordinary.createdAt + 3_600_000,
        updatedAt: rig.clock.now(),
      })),
    });
    const written = await rig.release.writeRelease(legacy, current.value.head);
    assert.ok(written.ok && written.value.status === "applied");
    assert.ok(rig.clock.now() < ordinary.createdAt + 60_000);
    // Same run/attempt cannot start a second execution even when due.
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
    // The candidate settles into acceptance; with no hour cooldown the same
    // dispatch then starts the next ordinary execution.
    const settledOrdinary = requireRun(await rig.prepare(run(4)));
    assert.equal(settledOrdinary.purpose, "ordinary");
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
    // The rollback settles; with no hour cooldown the same dispatch then
    // starts the next ordinary execution.
    const settledOrdinary = requireRun(await rig.prepare(run(6)));
    assert.equal(settledOrdinary.purpose, "ordinary");
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
    // No completed review receipt -> not selectable; the now-immediately-due
    // ordinary work is what the dispatch starts instead.
    await rig.seedRepair([request], []);
    const dueOrdinary = requireRun(await rig.prepare(run(2)));
    assert.equal(dueOrdinary.purpose, "ordinary");
    rig.evidence.settlements.set(
      dueOrdinary.id,
      runProof(dueOrdinary, "healthy"),
    );
    assert.equal((await rig.finalize(run(2))).status, "idle");
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
    // Ordinary work is due on the next dispatch, with no hour cooldown.
    const ordinary = requireRun(await rig.prepare(identity));
    const originalDue = (await rig.snapshot()).hostedRuntimes[0].nextOrdinaryAt;
    assert.equal(originalDue, ordinary.createdAt);
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
    // Same run/attempt cannot resubmit.
    assert.equal((await rig.prepare(identity)).status, "idle");
    // A later run/attempt at the restored due instant retries.
    rig.clock.advance(skipped.observedAt - rig.clock.now() + 1);
    assert.ok(rig.clock.now() >= state.hostedRuntimes[0].nextOrdinaryAt);
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

/** A self-consistent statement whose text drifted from the reviewed task. */
async function driftedTask(body: string): Promise<ReviewTaskStatementV1> {
  return {
    issueNumber: ISSUE,
    title: TASK_TITLE,
    body,
    digest: await reviewTaskStatementDigest({
      issueNumber: ISSUE,
      title: TASK_TITLE,
      body,
    }),
  };
}

/**
 * One distinct self-open request + completed receipt pair per refusal below.
 * Every variant owns its own immutable ids, so seeding never rewrites an
 * already-completed receipt or a frozen request identity: separate review
 * cycles look exactly like this to the real repair store.
 */
function variantRequest(
  slug: string,
  receiptOverrides: Record<string, unknown> = {},
): { request: ReleaseRequestV1; receipt: ReviewReceiptV1 } {
  const request = releaseRequest({
    id: `release-${slug}`,
    source: {
      pullRequest: 5,
      reviewRequestId: `review-req-${slug}`,
      reviewReceiptId: `review-receipt-${slug}`,
      head: CANDIDATE,
      base: LAUNCHER,
    },
  });
  return { request, receipt: reviewReceipt(request, receiptOverrides) };
}

Deno.test("hosted supervisor core: legacy, wrong-task or unreadable acceptance never selects a release", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    let nextRun = 2;
    const refuse = async (
      slug: string,
      receiptOverrides: Record<string, unknown> = {},
    ): Promise<void> => {
      const variant = variantRequest(slug, receiptOverrides);
      rig.evidence.requests.add(variant.request.id);
      await rig.seedRepair([variant.request], [variant.receipt]);
      const identity = run(nextRun);
      nextRun++;
      // The refused request never selects a release; with no hour cooldown the
      // dispatch starts the immediately-due ordinary work instead.
      const ordinary = requireRun(await rig.prepare(identity));
      assert.equal(ordinary.purpose, "ordinary");
      rig.evidence.settlements.set(ordinary.id, runProof(ordinary, "healthy"));
      assert.equal((await rig.finalize(identity)).status, "idle");
      const state = await rig.snapshot();
      assert.equal(state.hostedReleases.length, 0);
      assert.equal(state.hostedRuntimes[0].activeRevision, LAUNCHER);
    };
    // A legacy quality-only receipt parses and is otherwise green, yet it can
    // never select a release.
    await refuse("legacy", { taskAcceptance: null });
    // A fulfilled verdict bound to a digest that is not this issue's text.
    await refuse("wrong-digest", {
      taskAcceptance: {
        issueNumber: ISSUE,
        taskDigest: "e".repeat(64),
        verdict: "fulfilled",
        evidence: ["different task digest"],
      },
    });
    // An honest already-satisfied-at-base verdict is a non-delivery too.
    await refuse("satisfied", {
      taskAcceptance: {
        issueNumber: ISSUE,
        taskDigest: TASK_DIGEST,
        verdict: "already_satisfied_at_base",
        evidence: ["the base already satisfies the issue"],
      },
    });
    // A receipt for another issue number is refused as well.
    await refuse("other-issue", {
      taskAcceptance: {
        issueNumber: ISSUE + 1,
        taskDigest: TASK_DIGEST,
        verdict: "fulfilled",
        evidence: ["another issue"],
      },
    });
    // A self-consistent but non-App reviewer identity refuses as well.
    await refuse("other-reviewer", {
      expectedReviewer: "alternate-reviewer[bot]",
      observedReviewer: "alternate-reviewer[bot]",
    });
    // The exact-bound positive acceptance selects the release normally.
    const request = releaseRequest();
    rig.evidence.requests.add(request.id);
    await rig.seedRepair([request], [reviewReceipt(request)]);
    const prior = requireRun(await rig.prepare(run(nextRun)));
    assert.equal(prior.purpose, "prior");
    const state = await rig.snapshot();
    assert.equal(state.hostedReleases.length, 1);
    assert.equal(state.hostedReleases[0].phase, "requested");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: an unreadable trusted task context never selects a release", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const request = releaseRequest();
    await rig.seedRepair([request], [reviewReceipt(request)]);
    rig.evidence.requests.add(request.id);
    // Transmission failure and an explicit null read both fail closed; the
    // immediately-due ordinary work is what each dispatch starts instead, so
    // the release pointer never moves.
    rig.evidence.taskFail = true;
    const firstOrdinary = requireRun(await rig.prepare(run(2)));
    assert.equal(firstOrdinary.purpose, "ordinary");
    rig.evidence.settlements.set(
      firstOrdinary.id,
      runProof(firstOrdinary, "healthy"),
    );
    assert.equal((await rig.finalize(run(2))).status, "idle");
    assert.equal((await rig.snapshot()).hostedReleases.length, 0);
    rig.evidence.taskFail = false;
    rig.evidence.tasks.set(ISSUE, null);
    const secondOrdinary = requireRun(await rig.prepare(run(3)));
    assert.equal(secondOrdinary.purpose, "ordinary");
    rig.evidence.settlements.set(
      secondOrdinary.id,
      runProof(secondOrdinary, "healthy"),
    );
    assert.equal((await rig.finalize(run(3))).status, "idle");
    assert.equal((await rig.snapshot()).hostedReleases.length, 0);
    rig.evidence.tasks.delete(ISSUE);
    assert.equal(requireRun(await rig.prepare(run(4))).purpose, "prior");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: promotion preflight rechecks the trusted acceptance immediately before promotion", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const request = releaseRequest();
    await rig.seedRepair([request], [reviewReceipt(request)]);
    rig.evidence.requests.add(request.id);
    const prior = requireRun(await rig.prepare(run(2)));
    assert.equal(prior.purpose, "prior");
    rig.evidence.settlements.set(prior.id, runProof(prior, "healthy"));
    // The live issue text moved after the prior verification: the frozen
    // request no longer binds the current task and the promote intent must not
    // be persisted.
    rig.evidence.tasks.set(ISSUE, await driftedTask(`${TASK_BODY} (edited)`));
    const before = await rig.snapshot();
    assert.equal((await rig.prepare(run(3))).status, "pending");
    const after = await rig.snapshot();
    assert.deepEqual(after.hostedReleases, before.hostedReleases);
    assert.equal(after.hostedRuntimes[0].execution?.id, prior.id);
    assert.equal(after.hostedRuntimes[0].activeRevision, LAUNCHER);
    // An unavailable trusted read refuses the same promotion: the frozen
    // receipt and request records stay untouched and no intent is persisted.
    rig.evidence.tasks.set(ISSUE, null);
    assert.equal((await rig.prepare(run(4))).status, "pending");
    assert.deepEqual(
      (await rig.snapshot()).hostedReleases,
      before.hostedReleases,
    );
    // The exact reviewed text and receipt still promote normally.
    rig.evidence.tasks.delete(ISSUE);
    const candidate = requireRun(await rig.prepare(run(5)));
    assert.equal(candidate.purpose, "candidate");
    assert.equal(candidate.revision, CANDIDATE);
    const promoted = await rig.snapshot();
    assert.equal(promoted.hostedReleases[0].phase, "verifying");
    assert.equal(promoted.hostedReleases[0].priorProof?.execution.id, prior.id);
    assert.equal(promoted.hostedRuntimes[0].activeRevision, CANDIDATE);
    assert.equal(promoted.hostedRuntimes[0].generation, 2);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: issue text that drifts while the source verifier runs never promotes", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const request = releaseRequest();
    await rig.seedRepair([request], [reviewReceipt(request)]);
    rig.evidence.requests.add(request.id);
    const prior = requireRun(await rig.prepare(run(2)));
    assert.equal(prior.purpose, "prior");
    rig.evidence.settlements.set(prior.id, runProof(prior, "healthy"));
    // The live issue text changes exactly WHILE the trusted source verifier is
    // in flight: the authorization that permits the pointer move is the read
    // taken after that verifier settles, so this drift must refuse the
    // promotion and leave the durable state untouched.
    const drifted = await driftedTask(
      `${TASK_BODY} (edited during verification)`,
    );
    const verify = rig.evidence.verifyRequest.bind(rig.evidence);
    let driftedDuringVerify = false;
    rig.evidence.verifyRequest = (request) => {
      if (!driftedDuringVerify) {
        driftedDuringVerify = true;
        rig.evidence.tasks.set(ISSUE, drifted);
      }
      return verify(request);
    };
    const before = await rig.snapshot();
    assert.equal((await rig.prepare(run(3))).status, "pending");
    assert.equal(driftedDuringVerify, true);
    const after = await rig.snapshot();
    assert.deepEqual(after.hostedReleases, before.hostedReleases);
    assert.equal(after.hostedRuntimes[0].execution?.id, prior.id);
    assert.equal(after.hostedRuntimes[0].activeRevision, LAUNCHER);
    assert.equal(after.hostedRuntimes[0].generation, 1);
    // The exact unchanged positive still promotes normally.
    rig.evidence.tasks.delete(ISSUE);
    const candidate = requireRun(await rig.prepare(run(4)));
    assert.equal(candidate.purpose, "candidate");
    assert.equal(candidate.revision, CANDIDATE);
    const promoted = await rig.snapshot();
    assert.equal(promoted.hostedRuntimes[0].activeRevision, CANDIDATE);
    assert.equal(promoted.hostedRuntimes[0].generation, 2);
    assert.equal(promoted.hostedReleases[0].phase, "verifying");
    assert.equal(promoted.hostedReleases[0].priorProof?.execution.id, prior.id);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: a missing current health proof plans model-disabled verification and the next dispatch is due for ordinary work", async () => {
  const rig = await makeRig();
  try {
    rig.evidence.revisions.add(LAUNCHER);
    // The only legally reachable runtime without a current health proof is the
    // first generation: the store correctly refuses to clear a persisted
    // healthy proof, so the gap is exercised at its real origin rather than by
    // hand-clearing one.
    const planned = requireRun(await rig.prepare(run(1)));
    // Model work is started only by an `ordinary` execution.
    assert.notEqual(planned.purpose, "ordinary");
    assert.equal(planned.purpose, "bootstrap");
    assert.equal(planned.revision, LAUNCHER);
    let state = await rig.snapshot();
    const due = state.hostedRuntimes[0].nextOrdinaryAt;
    // No artificial cooldown is stamped: the verified gap, not the clock,
    // controls when ordinary work becomes due.
    assert.ok(due <= rig.clock.now());
    assert.equal(state.hostedRuntimes[0].lastHealthyProof, null);
    assert.equal(state.hostedRuntimes[0].execution?.id, planned.id);
    // A healthy verification settles and the next dispatch runs ordinary work
    // immediately; the verification neither consumes nor defers the cadence.
    rig.evidence.settlements.set(planned.id, runProof(planned, "healthy"));
    const ordinary = requireRun(await rig.prepare(run(2)));
    assert.equal(ordinary.purpose, "ordinary");
    assert.equal(ordinary.revision, LAUNCHER);
    state = await rig.snapshot();
    assert.equal(
      state.hostedRuntimes[0].lastHealthyProof?.execution.id,
      planned.id,
    );
    assert.equal(state.hostedRuntimes[0].nextOrdinaryAt, ordinary.createdAt);
    // Same run/attempt cannot start a second execution; a different run
    // cannot start one while the ordinary execution is active.
    assert.equal(requireRun(await rig.prepare(run(2))).id, ordinary.id);
    assert.equal((await rig.prepare(run(3))).status, "pending");
    assert.equal(
      (await rig.snapshot()).hostedRuntimes[0].execution?.id,
      ordinary.id,
    );
  } finally {
    await rig.cleanup();
  }
});

/**
 * Persist the exact RESUMED promote intent by running the real core once and
 * refusing only its second (pointer-movement) CAS write: the durable state
 * stays at the already-persisted `promoting` intent with the real healthy
 * prior proof that authorized it, exactly what a later prepare resumes.
 * Nothing is fabricated and no lifecycle transition is hand-written.
 */
async function persistPromotingIntent(
  rig: RigV1,
  identity: HostedSupervisorRunIdentityV1,
): Promise<void> {
  let writes = 0;
  const state: StateReadView & ReleaseStateWriter = {
    readRelease: rig.release.readRelease.bind(rig.release),
    readRepair: rig.release.readRepair.bind(rig.release),
    writeRelease: async (next, expectedHead) => {
      writes++;
      if (writes === 2) {
        return portOk<StateWriteResultV1>({
          status: "conflict",
          currentHead: null,
        });
      }
      return await rig.release.writeRelease(next, expectedHead);
    },
  };
  const outcome = await runHostedSupervisorPrepare({
    clock: rig.clock,
    state,
    run: identity,
    evidence: rig.evidence,
  });
  assert.equal(outcome.status, "pending", JSON.stringify(outcome));
  const read = await rig.release.readRelease();
  assert.ok(read.ok && read.value.status === "found");
  if (!read.ok || read.value.status !== "found") {
    throw new Error("release state unreadable");
  }
  assert.equal(read.value.snapshot.hostedReleases[0]?.phase, "promoting");
  assert.notEqual(read.value.snapshot.hostedReleases[0]?.pointerIntent, null);
  assert.equal(read.value.snapshot.hostedRuntimes[0]?.activeRevision, LAUNCHER);
  assert.equal(read.value.snapshot.hostedRuntimes[0]?.generation, 1);
  assert.equal(read.value.snapshot.hostedRuntimes[0]?.execution, null);
  assert.equal(
    read.value.snapshot.hostedRuntimes[0]?.lastHealthyProof?.outcome,
    "healthy",
  );
}

Deno.test("hosted supervisor core: a persisted promote intent is re-authorized immediately before the pointer moves", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const request = releaseRequest();
    await rig.seedRepair([request], [reviewReceipt(request)]);
    rig.evidence.requests.add(request.id);
    const prior = requireRun(await rig.prepare(run(2)));
    assert.equal(prior.purpose, "prior");
    rig.evidence.settlements.set(prior.id, runProof(prior, "healthy"));
    // The real core persists the intent, then its pointer write is refused:
    // the durable state is the exact resumed intent a later prepare sees.
    await persistPromotingIntent(rig, run(3));
    // The live issue text changed after the intent was persisted: the resumed
    // prepare must not move the active revision or clear the old intent.
    rig.evidence.tasks.set(ISSUE, await driftedTask(`${TASK_BODY} (edited)`));
    const before = await rig.snapshot();
    assert.equal((await rig.prepare(run(4))).status, "pending");
    const after = await rig.snapshot();
    assert.equal(after.hostedRuntimes[0].activeRevision, LAUNCHER);
    assert.equal(after.hostedRuntimes[0].generation, 1);
    assert.equal(after.hostedReleases[0].phase, "promoting");
    assert.notEqual(after.hostedReleases[0].pointerIntent, null);
    assert.deepEqual(after.hostedReleases, before.hostedReleases);
    // An unavailable trusted read refuses the same move and keeps the intent.
    rig.evidence.tasks.delete(ISSUE);
    rig.evidence.taskFail = true;
    assert.equal((await rig.prepare(run(5))).status, "pending");
    rig.evidence.taskFail = false;
    assert.deepEqual(
      (await rig.snapshot()).hostedReleases,
      before.hostedReleases,
    );
    // The exact unchanged positive still promotes through the persisted intent.
    const candidate = requireRun(await rig.prepare(run(6)));
    assert.equal(candidate.purpose, "candidate");
    assert.equal(candidate.revision, CANDIDATE);
    const promoted = await rig.snapshot();
    assert.equal(promoted.hostedRuntimes[0].activeRevision, CANDIDATE);
    assert.equal(promoted.hostedRuntimes[0].generation, 2);
    assert.equal(promoted.hostedReleases[0].phase, "verifying");
    assert.equal(promoted.hostedReleases[0].pointerIntent, null);
    assert.equal(promoted.hostedReleases[0].priorProof?.execution.id, prior.id);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: a supported review_quota wait survives readRepair and prepare while an unknown reason refuses", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const request = releaseRequest();
    // The installed runtime's own bounded quota wait: nextStep review with a
    // budget-bound review_quota reason, exactly as the captured repair record
    // carries it.
    await rig.seedRepair([request], [reviewReceipt(request)], {
      nextStep: "review",
      wait: { reason: "review_quota", since: T0, until: T0 + 60_000 },
    });
    rig.evidence.requests.add(request.id);
    const before = await rig.repair.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    if (!before.ok || before.value.status !== "found") {
      throw new Error("repair state unreadable");
    }
    const seeded = before.value.snapshot.work[0];
    assert.equal(seeded.nextStep, "review");
    assert.equal(seeded.wait?.reason, "review_quota");
    assert.equal(seeded.wait?.until, T0 + 60_000);
    // The real readRepair view + prepare consume the supported wait without a
    // parser refusal, and leave the budget-bound wait untouched.
    assert.equal(
      requireRun(await rig.prepare(run(2))).purpose,
      "prior",
    );
    const after = await rig.repair.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    if (!after.ok || after.value.status !== "found") {
      throw new Error("repair state unreadable");
    }
    const held = after.value.snapshot.work[0];
    assert.equal(held.nextStep, "review");
    assert.equal(held.wait?.reason, "review_quota");
    assert.equal(held.wait?.until, T0 + 60_000);
    assert.equal(held.wait?.since, T0);
    // Any other wait reason is still refused by the frozen parser.
    assert.throws(() =>
      parseWorkRecordV1({
        ...workRecordFor(request),
        nextStep: "review",
        wait: { reason: "quota", since: T0, until: null },
      })
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("ordinary matrix capability: verified old healthy runtime waits for owner installation without a new intent", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const before = await rig.snapshot();
    const calls: GitSha[] = [];
    Object.assign(rig.evidence, {
      verifyMatrixOrdinaryRevision: (revision: GitSha) => {
        calls.push(revision);
        return Promise.resolve(portOk(false));
      },
    });
    const decision = await rig.prepare(run(2));
    assert.equal(
      decision.status,
      "idle",
      "verified old runtime must wait for the owner's capable installation",
    );
    assert.deepEqual(calls, [before.hostedRuntimes[0].activeRevision]);
    assert.deepEqual(
      await rig.snapshot(),
      before,
      "capability refusal cannot save an intent or admission",
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("ordinary matrix capability: missing unavailable malformed or thrown proof stays pending without a new intent", async (t) => {
  for (const mode of ["missing", "unavailable", "unknown", "null", "throw"]) {
    await t.step(mode, async () => {
      const rig = await makeRig();
      try {
        await bootstrapHealthy(rig);
        const before = await rig.snapshot();
        Object.assign(rig.evidence, {
          verifyMatrixOrdinaryRevision: mode === "missing" ? undefined : () => {
            if (mode === "throw") throw new Error("private failure");
            return Promise.resolve(
              mode === "null"
                ? null
                : mode === "unavailable"
                ? portError("unavailable", "unproven")
                : portOk("unknown"),
            );
          },
        });
        assert.equal((await rig.prepare(run(2))).status, "pending");
        assert.deepEqual(await rig.snapshot(), before);
      } finally {
        await rig.cleanup();
      }
    });
  }
});

Deno.test("ordinary matrix capability: actual client immutable source proof gates real controller admission", async (t) => {
  for (const capable of [false, true]) {
    await t.step(String(capable), async () => {
      const rig = await makeRig();
      try {
        await bootstrapHealthy(rig);
        const before = await rig.snapshot();
        const root = "a".repeat(40),
          src = "b".repeat(40),
          host = "c".repeat(40);
        const requests: string[] = [];
        const client = new GitHubApiClient({
          repository: SELF,
          apiBaseUrl: "https://api.github.com",
          clock: rig.clock,
          auth: {
            authorizationHeader: () =>
              Promise.resolve(portOk("Bearer fixture")),
          },
          cooldownGate: {
            beforeRequest: () => Promise.resolve(portOk(undefined)),
            recordRateLimit: () => Promise.resolve(portOk(undefined)),
          },
          http: (request) => {
            const path = new URL(request.url).pathname;
            requests.push(path);
            const entries = path.endsWith(root)
              ? [{ path: "src", type: "tree", mode: "040000", sha: src }]
              : path.endsWith(src)
              ? [{ path: "host", type: "tree", mode: "040000", sha: host }]
              : capable
              ? [{
                path: "matrix-actions.ts",
                type: "blob",
                mode: "100644",
                sha: "d".repeat(40),
              }]
              : [];
            const body = path.includes("/git/commits/")
              ? { sha: LAUNCHER, tree: { sha: root } }
              : {
                sha: path.split("/").at(-1),
                truncated: false,
                tree: entries,
              };
            return Promise.resolve(
              {
                status: 200,
                headers: new Headers(),
                bodyText: JSON.stringify(body),
              } satisfies HttpResponseV1,
            );
          },
        });
        rig.evidence.verifyMatrixOrdinaryRevision = (revision) =>
          client.verifyMatrixOrdinaryRevision(revision);
        const decision = await rig.prepare(run(2));
        assert.equal(decision.status, capable ? "run" : "idle");
        assert.equal(
          requests[0],
          "/repos/ubiquity/sentinel/git/commits/" +
            before.hostedRuntimes[0].activeRevision,
        );
        assert.ok(requests.every((path) => !path.includes("development")));
        if (capable) {
          const ordinary = requireRun(decision);
          assert.equal(ordinary.purpose, "ordinary");
          assert.equal(
            ordinary.revision,
            before.hostedRuntimes[0].activeRevision,
          );
        } else assert.deepEqual(await rig.snapshot(), before);
      } finally {
        await rig.cleanup();
      }
    });
  }
});

Deno.test("ordinary matrix capability: pointer movement during source proof refuses stale admission", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    let concurrentId: string | null = null;
    rig.evidence.verifyMatrixOrdinaryRevision = async (revision) => {
      assert.equal(revision, LAUNCHER);
      // A real concurrent release saves its prior proof and promotion intent.
      // The fixture never bypasses the state writer's pointer guards.
      rig.evidence.verifyMatrixOrdinaryRevision = () =>
        Promise.resolve(portOk(true));
      const request = releaseRequest();
      await rig.seedRepair([request], [reviewReceipt(request)]);
      rig.evidence.requests.add(request.id);
      const prior = requireRun(await rig.prepare(run(98)));
      assert.equal(prior.purpose, "prior");
      rig.evidence.settlements.set(prior.id, runProof(prior, "healthy"));
      const concurrent = requireRun(await rig.prepare(run(99)));
      assert.equal(concurrent.purpose, "candidate");
      concurrentId = concurrent.id;
      return portOk(true);
    };
    assert.equal((await rig.prepare(run(2))).status, "pending");
    const snapshot = await rig.snapshot();
    assert.equal(snapshot.hostedRuntimes[0].activeRevision, CANDIDATE);
    assert.equal(snapshot.hostedRuntimes[0].generation, 2);
    assert.equal(snapshot.hostedRuntimes[0].execution?.id, concurrentId);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("ordinary matrix capability: bootstrap prior candidate and rollback retain repair verification without the gate", async () => {
  const rig = await makeRig();
  try {
    rig.evidence.verifyMatrixOrdinaryRevision = () => {
      throw new Error("verification must not call ordinary capability");
    };
    const advanced = await advanceToCandidate(rig);
    assert.equal(advanced.prior.purpose, "prior");
    assert.equal(advanced.candidate.purpose, "candidate");
    rig.evidence.settlements.set(
      advanced.candidate.id,
      runProof(advanced.candidate, "failed"),
    );
    const rollback = requireRun(await rig.prepare(run(4)));
    assert.equal(rollback.purpose, "rollback");
    assert.equal(rollback.revision, LAUNCHER);
    assert.equal(rig.evidence.matrixCalls.length, 0);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("ordinary matrix capability: settled candidate verification reaches only the ordinary gate", async () => {
  const rig = await makeRig();
  try {
    const calls: GitSha[] = [];
    rig.evidence.verifyMatrixOrdinaryRevision = (revision) => {
      calls.push(revision);
      return Promise.resolve(portOk(false));
    };
    const { candidate } = await advanceToCandidate(rig);
    assert.deepEqual(
      calls,
      [],
      "bootstrap/prior/candidate cannot use the ordinary gate",
    );
    rig.evidence.settlements.set(candidate.id, runProof(candidate, "healthy"));
    const decision = await rig.prepare(run(4));
    assert.equal(decision.status, "idle");
    assert.deepEqual(calls, [CANDIDATE]);
    const snapshot = await rig.snapshot();
    assert.equal(snapshot.hostedRuntimes[0].activeRevision, CANDIDATE);
    assert.equal(snapshot.hostedRuntimes[0].execution, null);
    assert.equal(snapshot.hostedReleases[0].phase, "accepted");
  } finally {
    await rig.cleanup();
  }
});
