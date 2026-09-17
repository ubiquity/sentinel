/**
 * Focused suite for the bounded hosted autonomy pass (transient-failure retry
 * and autonomous delivery) that the protected maintenance job runs before
 * `prepare`.
 *
 * The runner core is exercised credential-free against the ACTUAL production
 * repair/release GitStateStores over disposable local bare repositories, with a
 * fake GitHub surface. Fixtures are minimal sanitized records built through the
 * frozen parsers; no production snapshot, token, path or private payload is
 * committed or read.
 */
import assert from "node:assert/strict";

import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import type {
  RepairStateWriter,
  StateReadView,
} from "../../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { releaseRequestId } from "../../src/repair/keys.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
} from "../../src/state/mod.ts";
import {
  applyHostedClosures,
  applyHostedRetries,
  buildHostedReleaseRequest,
  HOSTED_AUTONOMY_MAX_RETRIES,
  isHardAutonomyFailure,
  planHostedClosures,
  planHostedRetries,
  revisionIntegratedIntoBase,
  runHostedAutonomy,
} from "../../ops/hosted-autonomy.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedAutonomyPullV1,
  HostedAutonomyResultV1,
} from "../../ops/hosted-autonomy.ts";
import {
  makeRemoteCtx,
  reservation,
  reviewReceipt,
  SHA1,
  T0,
} from "../state/helpers.ts";

const HEAD = "ae6ff044280a04803958fcd1f6f9304bb894249e" as GitSha;
const BASE = "f1b5a86b80ca4759ab37307484b223907bd1b1d6" as GitSha;
const MERGE = "9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293" as GitSha;
const TARGET = "issue-ubiquity-sentinel-48" as WorkItemId;
const RECEIPT_ID = `review-receipt:${"a".repeat(64)}`;
const SELF_REPO = {
  owner: "ubiquity",
  name: "sentinel",
  installationId: 0,
} as const;

const ENV: Record<string, string> = {
  PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
  HOME: "/tmp",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "sentinel-test",
  GIT_AUTHOR_EMAIL: "sentinel-test@example.invalid",
  GIT_COMMITTER_NAME: "sentinel-test",
  GIT_COMMITTER_EMAIL: "sentinel-test@example.invalid",
};

function deliveryRecord(
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return parseWorkRecordV1({
    version: "v1",
    kind: "work",
    repository: SELF_REPO,
    id: TARGET,
    source: { kind: "issue", id: "48", revision: SHA1 },
    related: { incidentId: null, issueNumber: 48 },
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
    controller: { sha: SHA1 },
    target: {
      base: BASE,
      branch: "sentinel/repair/issue-ubiquity-sentinel-48",
      checkpoint: null,
      head: HEAD,
      pr: 51,
    },
    nextStep: "delivery",
    wait: null,
    blocker: null,
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    evidence: [{ kind: "review_receipt", ref: `artifact:${RECEIPT_ID}` }],
    intent: null,
    firstSeenAt: T0,
    createdAt: T0 + 100,
    updatedAt: T0 + 2000,
    ...overrides,
  });
}

function blockedRecord(overrides: Record<string, unknown> = {}): WorkRecordV1 {
  return deliveryRecord({
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: "model run ended without a trusted receipt",
      since: T0 + 3000,
    },
    ...overrides,
  });
}

function finding(severity: "P1" | "P2") {
  return {
    id: "github-review-1-finding-0",
    fingerprint: "f".repeat(64),
    severity,
    path: "src/github/text.ts",
    message: `${severity} finding`,
    resolutionEvidence: null,
    resolved: false,
  };
}

function authorizingReceipt(overrides: Record<string, unknown> = {}) {
  return reviewReceipt(RECEIPT_ID, {
    repository: SELF_REPO,
    expectedReviewer: "github-actions[bot]",
    observedReviewer: "github-actions[bot]",
    pullRequest: { number: 51, head: HEAD, base: BASE },
    outcome: "completed",
    resultId: "msg_0123456789abcdef",
    completedAt: T0 + 3000,
    unresolvedSeverities: [],
    observedAt: T0 + 4000,
    ...overrides,
  });
}

function repairSnapshot(
  records: WorkRecordV1[] = [deliveryRecord()],
  reviews: unknown[] = [authorizingReceipt()],
  releaseRequests: unknown[] = [],
  reservations: unknown[] = [],
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: records,
    reservations,
    reviews,
    replays: [],
    releaseRequests,
    githubCooldowns: [],
  });
}

function releaseSnapshot(
  hostedReleases: unknown[] = [],
): ReleaseStateSnapshotV1 {
  return parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    releases: [],
    hostedRuntimes: [],
    hostedReleases,
    githubCooldowns: [],
  });
}

function pullFacts(
  overrides: Partial<HostedAutonomyPullV1> = {},
): HostedAutonomyPullV1 {
  return {
    number: 51,
    state: "closed",
    merged: true,
    mergeCommitSha: MERGE,
    headSha: HEAD,
    baseRef: "development",
    author: "github-actions[bot]",
    parents: [BASE, HEAD],
    revisionOnBaseBranch: true,
    ...overrides,
  };
}

interface RigV1 {
  readonly tmp: string;
  readonly state: StateReadView & RepairStateWriter;
  writes: number;
  merges: number;
  closed: number[];
}

/** Minimal valid healthy candidate proof for an accepted hosted release. */
function healthyProof(
  revision: string,
  generation: number,
  releaseId: string,
  purpose: "prior" | "candidate" = "candidate",
) {
  return {
    execution: {
      id: "35273273110:1:repair",
      runId: 35273273110,
      runAttempt: 1,
      launcherSha: SHA1,
      purpose,
      revision,
      generation,
      releaseId,
      createdAt: T0 + 3000,
    },
    workflowId: 357012162,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: "ubiquity/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: 1,
    startedAt: T0 + 3100,
    finishedAt: T0 + 3200,
    observedAt: T0 + 3300,
    outcome: "healthy" as const,
    startupReady: true,
    settled: true,
    baseSha: BASE,
    terminalAt: T0 + 3200,
    logDigest: "d".repeat(64),
  };
}

async function makeRig(
  prefix: string,
  options: {
    repair?: RepairStateSnapshotV1;
    release?: ReleaseStateSnapshotV1;
    pull?: HostedAutonomyPullV1 | null;
    baseTip?: string | null;
    checkGreen?: boolean;
    mergeResult?: { merged: boolean; sha: string | null } | null;
    afterMerge?: HostedAutonomyPullV1 | null;
  } = {},
): Promise<{ rig: RigV1; github: HostedAutonomyGitHubV1 }> {
  const tmp = await Deno.makeTempDir({ prefix: `sentinel-${prefix}-` });
  const ctx = await makeRemoteCtx(tmp, ENV);
  const repair = createRepairStateStore({
    scratchDir: `${tmp}/repair`,
    remoteUrl: ctx.remoteUrl,
  });
  const release = createReleaseStateStore({
    scratchDir: `${tmp}/release`,
    remoteUrl: ctx.remoteUrl,
  });
  const repairSeed = await repair.writeRepair(
    options.repair ?? repairSnapshot(),
    null,
  );
  if (!repairSeed.ok || repairSeed.value.status !== "applied") {
    throw new Error(
      `repair fixture seed failed: ${JSON.stringify(repairSeed)}`,
    );
  }
  const releaseSeed = await release.writeRelease(
    options.release ?? releaseSnapshot(),
    null,
  );
  if (!releaseSeed.ok || releaseSeed.value.status !== "applied") {
    throw new Error(
      `release fixture seed failed: ${JSON.stringify(releaseSeed)}`,
    );
  }
  const rig: RigV1 = {
    tmp,
    state: {
      readRepair: () => repair.readRepair(),
      readRelease: () => release.readRelease(),
      writeRepair: (
        next: RepairStateSnapshotV1,
        expectedHead: GitSha | null,
      ) => {
        rig.writes++;
        return repair.writeRepair(next, expectedHead);
      },
    } as unknown as StateReadView & RepairStateWriter,
    writes: 0,
    merges: 0,
    closed: [],
  };
  let mergedNow = false;
  const github: HostedAutonomyGitHubV1 = {
    readBaseTip: () =>
      Promise.resolve(options.baseTip === undefined ? BASE : options.baseTip),
    hasSuccessfulCheck: () => Promise.resolve(options.checkGreen ?? true),
    readPull: () =>
      Promise.resolve(
        mergedNow && options.afterMerge !== undefined
          ? options.afterMerge
          : options.pull === undefined
          ? pullFacts()
          : options.pull,
      ),
    closeIssue: (number: number) => {
      rig.closed.push(number);
      return Promise.resolve(true);
    },
    merge: () => {
      rig.merges++;
      mergedNow = true;
      const result = options.mergeResult === undefined
        ? { merged: true, sha: MERGE }
        : options.mergeResult;
      return Promise.resolve(result);
    },
  };
  return { rig, github };
}

async function run(
  rig: RigV1,
  github: HostedAutonomyGitHubV1,
): Promise<HostedAutonomyResultV1> {
  return await runHostedAutonomy({
    state: rig.state,
    github,
    clock: { now: () => T0 + 5000 },
  });
}

async function readRequests(rig: RigV1) {
  const read = await rig.state.readRepair();
  if (!read.ok || read.value.status !== "found") throw new Error("unreadable");
  return read.value.snapshot.releaseRequests;
}

Deno.test(
  "hosted autonomy: a merged reviewed head records the deterministic release request",
  async () => {
    const { rig, github } = await makeRig("autonomy-request");
    const result = await run(rig, github);
    assert.equal(result.status, "applied");
    assert.equal(result.reason, "applied");
    assert.deepEqual([...result.revisions], [MERGE]);
    assert.equal(rig.writes, 1);
    const requests = await readRequests(rig);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].id, await releaseRequestId(SELF_REPO, MERGE, 51));
    assert.equal(requests[0].revision, MERGE);
    assert.equal(requests[0].source.head, HEAD);
    assert.equal(requests[0].source.base, BASE);
    assert.equal(requests[0].source.reviewReceiptId, RECEIPT_ID);
    assert.equal(requests[0].target.environment, "production");
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: an open reviewed head is merged and then recorded once",
  async () => {
    const { rig, github } = await makeRig("autonomy-merge", {
      pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
      afterMerge: pullFacts(),
    });
    const result = await run(rig, github);
    assert.equal(rig.merges, 1);
    assert.equal(result.status, "applied");
    assert.ok(result.actions.some((action) => action.startsWith("merge:")));
    assert.equal((await readRequests(rig)).length, 1);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: an already recorded delivery is never duplicated",
  async () => {
    const existing = await buildHostedReleaseRequest(
      SELF_REPO,
      MERGE,
      HEAD,
      BASE,
      51,
      authorizingReceipt(),
      T0 + 2000,
    );
    if (existing === null) throw new Error("fixture request invalid");
    const { rig, github } = await makeRig("autonomy-idempotent", {
      repair: repairSnapshot([deliveryRecord()], [authorizingReceipt()], [
        existing,
      ]),
    });
    const result = await run(rig, github);
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "already_recorded");
    assert.equal(rig.writes, 0);
    assert.equal(rig.merges, 0);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: only a receipt with no unresolved P0/P1 authorizes delivery",
  async () => {
    const blocked = await makeRig("autonomy-p1", {
      repair: repairSnapshot([deliveryRecord()], [
        authorizingReceipt({
          findings: [finding("P1")],
          unresolvedSeverities: ["P1"],
        }),
      ]),
    });
    assert.equal((await run(blocked.rig, blocked.github)).status, "skipped");
    assert.equal(blocked.rig.writes, 0);
    assert.equal(blocked.rig.merges, 0);

    const allowed = await makeRig("autonomy-p2", {
      repair: repairSnapshot([deliveryRecord()], [
        authorizingReceipt({
          findings: [finding("P2")],
          unresolvedSeverities: ["P2"],
        }),
      ]),
    });
    assert.equal((await run(allowed.rig, allowed.github)).status, "applied");

    const otherHead = await makeRig("autonomy-other-head", {
      repair: repairSnapshot([deliveryRecord()], [
        authorizingReceipt({
          pullRequest: { number: 51, head: SHA1, base: BASE },
        }),
      ]),
    });
    assert.equal(
      (await run(otherHead.rig, otherHead.github)).status,
      "skipped",
    );
    assert.equal(otherHead.rig.writes, 0);

    await Promise.all(
      [blocked, allowed, otherHead].map((entry) =>
        Deno.remove(entry.rig.tmp, { recursive: true })
      ),
    );
  },
);

Deno.test(
  "hosted autonomy: a moved base, a pending check, a foreign author or an unproven merge never delivers",
  async () => {
    const openPull = pullFacts({
      state: "open",
      merged: false,
      mergeCommitSha: null,
    });
    const movedBase = await makeRig("autonomy-base", {
      pull: openPull,
      baseTip: SHA1,
    });
    const movedResult = await run(movedBase.rig, movedBase.github);
    assert.equal(movedBase.rig.merges, 0);
    assert.ok(
      movedResult.actions.some((action) => action.endsWith("base_moved")),
    );

    const pending = await makeRig("autonomy-checks", {
      pull: openPull,
      checkGreen: false,
    });
    const pendingResult = await run(pending.rig, pending.github);
    assert.equal(pending.rig.merges, 0);
    assert.ok(
      pendingResult.actions.some((action) => action.endsWith("checks_pending")),
    );

    const foreign = await makeRig("autonomy-author", {
      pull: pullFacts({ author: "someone-else" }),
    });
    const foreignResult = await run(foreign.rig, foreign.github);
    assert.equal(foreignResult.status, "skipped");
    assert.equal(foreignResult.reason, "foreign_author");
    assert.equal(foreign.rig.merges, 0);
    assert.equal(foreign.rig.writes, 0);

    const wrongParents = await makeRig("autonomy-parents", {
      pull: pullFacts({ parents: [BASE] }),
    });
    assert.equal(
      (await run(wrongParents.rig, wrongParents.github)).status,
      "skipped",
    );
    assert.equal(wrongParents.rig.writes, 0);

    await Promise.all(
      [movedBase, pending, foreign, wrongParents].map((entry) =>
        Deno.remove(entry.rig.tmp, { recursive: true })
      ),
    );
  },
);

Deno.test(
  "hosted autonomy: a transient blocker is retried with a closed grant and a preserved budget",
  () => {
    const record = blockedRecord({
      counters: { attempts: 2, retries: 0, reviewRounds: 3 },
    });
    const snapshot = repairSnapshot([record], [authorizingReceipt()], [], [
      reservation("r-1", {
        taskId: TARGET,
        head: BASE,
        attempt: 1,
        purpose: "implementation",
        outcome: "submitted",
        settledAt: T0 + 2000,
      }),
      reservation("r-2", {
        taskId: TARGET,
        head: BASE,
        attempt: 2,
        purpose: "implementation",
        outcome: "ambiguous",
        settledAt: T0 + 2000,
      }),
    ]);
    const plans = planHostedRetries(snapshot);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].id, TARGET);
    assert.equal(plans[0].nextStep, "work");
    assert.equal(plans[0].resetReviewRounds, false);
    const next = applyHostedRetries(snapshot, SHA1, plans, T0 + 5000);
    const applied = next.work[0];
    assert.equal(applied.nextStep, "work");
    assert.equal(applied.blocker, null);
    assert.equal(applied.counters.retries, 1);
    assert.equal(applied.counters.attempts, 2);
    assert.equal(applied.counters.reviewRounds, 3);
    assert.equal(next.reservations.length, 2);
    assert.equal(next.sequence, snapshot.sequence + 1);
  },
);

Deno.test(
  "hosted autonomy: the retry budget is closed and non-transient blockers are untouched",
  () => {
    const exhausted = repairSnapshot([
      blockedRecord({
        counters: {
          attempts: 4,
          retries: HOSTED_AUTONOMY_MAX_RETRIES,
          reviewRounds: 1,
        },
      }),
    ]);
    assert.equal(planHostedRetries(exhausted).length, 0);

    const reviewRounds = repairSnapshot([
      blockedRecord({
        blocker: {
          kind: "review_quota",
          message:
            "review rounds exhausted without an accepted verdict (structured review unavailable)",
          since: T0 + 3000,
        },
        counters: { attempts: 1, retries: 0, reviewRounds: 14 },
      }),
    ]);
    const plans = planHostedRetries(reviewRounds);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].nextStep, "review");
    assert.equal(plans[0].resetReviewRounds, true);
    const next = applyHostedRetries(reviewRounds, SHA1, plans, T0 + 5000);
    assert.equal(next.work[0].nextStep, "review");
    assert.equal(next.work[0].counters.reviewRounds, 0);

    const budget = repairSnapshot([
      blockedRecord({
        blocker: {
          kind: "review_quota",
          message: "implementation attempt budget exhausted",
          since: T0 + 3000,
        },
        counters: { attempts: 4, retries: 0, reviewRounds: 5 },
      }),
    ]);
    const budgetPlans = planHostedRetries(budget);
    assert.equal(budgetPlans.length, 1);
    assert.equal(budgetPlans[0].grant, 1);
    const budgetNext = applyHostedRetries(budget, SHA1, budgetPlans, T0 + 5000);
    assert.equal(budgetNext.work[0].counters.attempts, 3);

    const foreign = repairSnapshot([
      blockedRecord({
        blocker: {
          kind: "missing_evidence",
          message: "something else entirely",
          since: T0 + 3000,
        },
      }),
    ]);
    assert.equal(planHostedRetries(foreign).length, 0);
  },
);

Deno.test(
  "hosted autonomy: an unsettled implementation intent is never cleared",
  () => {
    const unsettled = repairSnapshot(
      [
        blockedRecord({
          intent: {
            kind: "implementation",
            key: "implementation:r-9",
            startedAt: T0 + 1000,
            branch: "sentinel/repair/issue-ubiquity-sentinel-48",
            expectedHead: null,
            observedBase: BASE,
            pr: null,
            requestId: "r-9",
            resultId: null,
          },
          counters: { attempts: 1, retries: 0, reviewRounds: 1 },
        }),
      ],
      [authorizingReceipt()],
      [],
      [
        reservation("r-9", {
          taskId: TARGET,
          head: BASE,
          attempt: 1,
          purpose: "implementation",
          outcome: "reserved",
        }),
      ],
    );
    assert.equal(planHostedRetries(unsettled).length, 0);

    const settled = repairSnapshot(
      [
        blockedRecord({
          intent: {
            kind: "implementation",
            key: "implementation:r-9",
            startedAt: T0 + 1000,
            branch: "sentinel/repair/issue-ubiquity-sentinel-48",
            expectedHead: null,
            observedBase: BASE,
            pr: null,
            requestId: "r-9",
            resultId: null,
          },
          counters: { attempts: 1, retries: 0, reviewRounds: 1 },
        }),
      ],
      [authorizingReceipt()],
      [],
      [
        reservation("r-9", {
          taskId: TARGET,
          head: BASE,
          attempt: 1,
          purpose: "implementation",
          outcome: "submitted",
          settledAt: T0 + 2000,
        }),
      ],
    );
    assert.equal(planHostedRetries(settled).length, 1);
  },
);

Deno.test(
  "hosted autonomy: a blocked task with an open pull request is retried in one write",
  async () => {
    const { rig, github } = await makeRig("autonomy-retry", {
      repair: repairSnapshot([blockedRecord()], [authorizingReceipt()]),
      pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
    });
    const result = await run(rig, github);
    assert.equal(result.status, "applied");
    assert.equal(result.reason, "retried");
    assert.notEqual(result.appliedHead, null);
    assert.equal(rig.writes, 1);
    const read = await rig.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("unreadable");
    }
    const record = read.value.snapshot.work[0];
    assert.equal(record.nextStep, "work");
    assert.equal(record.blocker, null);
    assert.equal(record.counters.retries, 1);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a blocked task whose pull request is already merged is not retried",
  async () => {
    const { rig, github } = await makeRig("autonomy-merged-blocked", {
      repair: repairSnapshot([blockedRecord()], [authorizingReceipt()]),
      pull: pullFacts(),
    });
    const result = await run(rig, github);
    assert.equal(rig.writes, 0);
    assert.ok(
      result.actions.some((action) => action.endsWith("pr_not_open")),
    );
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: an accepted release closes the delivered issue and marks the record done",
  async () => {
    const request = await buildHostedReleaseRequest(
      SELF_REPO,
      MERGE,
      HEAD,
      BASE,
      51,
      authorizingReceipt(),
      T0 + 2000,
    );
    if (request === null) throw new Error("fixture request invalid");
    const { parseHostedReleaseRecordV1 } = await import(
      "../../src/contracts/hosted-supervisor.ts"
    );
    const accepted = parseHostedReleaseRecordV1({
      version: "v1",
      kind: "hosted_release",
      id: request.id,
      request,
      phase: "accepted",
      priorRevision: BASE,
      priorProof: healthyProof(BASE, 17, request.id, "prior"),
      candidateProof: healthyProof(MERGE, 18, request.id),
      rollbackProof: null,
      pointerIntent: null,
      createdAt: T0 + 2500,
      updatedAt: T0 + 3000,
    });
    const snapshot = repairSnapshot([blockedRecord()], [authorizingReceipt()], [
      request,
    ]);
    const released = new Map([[`51:${HEAD}`, accepted]]);
    const plans = planHostedClosures(snapshot, released);
    assert.deepEqual(plans, [{ id: TARGET, issueNumber: 48 }]);
    const next = applyHostedClosures(snapshot, SHA1, plans, T0 + 5000);
    assert.equal(next.work[0].nextStep, "done");
    assert.equal(next.work[0].blocker, null);
    assert.equal(next.work[0].intent, null);
    assert.equal(next.sequence, snapshot.sequence + 1);
    // An accepted release that delivered another head closes nothing.
    assert.deepEqual(
      planHostedClosures(snapshot, new Map([[`51:${SHA1}`, accepted]])),
      [],
    );
  },
);

Deno.test(
  "hosted autonomy: integration evidence mirrors the runtime verifier",
  () => {
    const revision = MERGE;
    const shape = (status: string, baseSha: string, mergeSha: string) => ({
      status,
      base_commit: { sha: baseSha },
      merge_base_commit: { sha: mergeSha },
    });
    assert.equal(
      revisionIntegratedIntoBase(shape("ahead", revision, revision), revision),
      true,
    );
    assert.equal(
      revisionIntegratedIntoBase(
        shape("identical", revision, revision),
        revision,
      ),
      true,
    );
    assert.equal(
      revisionIntegratedIntoBase(shape("behind", revision, revision), revision),
      false,
    );
    assert.equal(
      revisionIntegratedIntoBase(
        shape("diverged", revision, revision),
        revision,
      ),
      false,
    );
    assert.equal(
      revisionIntegratedIntoBase(shape("ahead", SHA1, revision), revision),
      false,
    );
    assert.equal(revisionIntegratedIntoBase(null, revision), false);
    assert.equal(
      revisionIntegratedIntoBase({ status: "ahead" }, revision),
      false,
    );
    assert.equal(isHardAutonomyFailure("identity_rejected"), true);
    assert.equal(isHardAutonomyFailure("unexpected_failure"), true);
    assert.equal(isHardAutonomyFailure("write_conflict"), false);
    assert.equal(isHardAutonomyFailure("merge_refused"), false);
  },
);

Deno.test(
  "hosted autonomy: a non-terminal hosted release defers every pass",
  async () => {
    const pendingRequest = await buildHostedReleaseRequest(
      SELF_REPO,
      MERGE,
      HEAD,
      BASE,
      51,
      authorizingReceipt(),
      T0 + 2000,
    );
    if (pendingRequest === null) throw new Error("fixture request invalid");
    const { parseHostedReleaseRecordV1 } = await import(
      "../../src/contracts/hosted-supervisor.ts"
    );
    const { rig, github } = await makeRig("autonomy-release", {
      repair: repairSnapshot([blockedRecord()], [authorizingReceipt()]),
      release: releaseSnapshot([
        parseHostedReleaseRecordV1({
          version: "v1",
          kind: "hosted_release",
          id: pendingRequest.id,
          request: pendingRequest,
          phase: "requested",
          priorRevision: BASE,
          priorProof: null,
          candidateProof: null,
          rollbackProof: null,
          pointerIntent: null,
          createdAt: T0 + 2500,
          updatedAt: T0 + 2500,
        }),
      ]),
    });
    const result = await run(rig, github);
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "release_not_terminal");
    assert.equal(rig.writes, 0);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);
