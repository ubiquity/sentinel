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
import { portError } from "../../src/contracts/ports.ts";
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
import {
  reviewTaskStatementDigest,
  type ReviewTaskStatementV1,
} from "../../src/contracts/review-receipt.ts";
import {
  candidateBranch,
  releaseRequestId,
  reviewOperationKey,
} from "../../src/repair/keys.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
} from "../../src/state/mod.ts";
import {
  applyHostedClosures,
  applyHostedRetirements,
  applyHostedRetries,
  buildHostedReleaseRequest,
  createHostedAutonomyGitHub,
  HOSTED_AUTONOMY_MAX_RETRIES,
  HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS,
  HOSTED_AUTONOMY_RETIRED,
  HOSTED_AUTONOMY_TRUSTED_AUTHORS,
  hostedDeliveryKey,
  hostedIssueKey,
  hostedRepositoryKey,
  isHardAutonomyFailure,
  parseHostedAutonomyPull,
  planHostedClosures,
  planHostedRetirements,
  planHostedRetries,
  revisionIntegratedIntoBase,
  runHostedAutonomy,
} from "../../ops/hosted-autonomy.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedAutonomyPullV1,
  HostedAutonomyResultV1,
} from "../../ops/hosted-autonomy.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import {
  makeRemoteCtx,
  reservation,
  reviewReceipt,
  SHA1,
  T0,
} from "../state/helpers.ts";
import { persistHostedReceipt } from "./hosted-receipt-fixture.ts";

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
/** The foreign target the durable snapshot also carries work for. */
const FOREIGN_REPO = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 7,
} as const;
/** The foreign repository's own default branch, never sentinel's. */
const FOREIGN_BRANCH = "main";
const FOREIGN_TARGET = "issue-ubiquity-ai.ubq.fi-120" as WorkItemId;
const FOREIGN_PR = 375;
const FOREIGN_RECEIPT_ID = `review-receipt:${"b".repeat(64)}`;
/** The same issue number in both repositories: the collision under test. */
const SHARED_ISSUE_NUMBER = 120;
/** The exact trusted self issue statement every self receipt must bind. */
const SELF_TASK_TITLE = "Deliver the reviewed sentinel candidate";
const SELF_TASK_BODY = "The protected maintenance pass must deliver issue 48.";
const SELF_TASK: ReviewTaskStatementV1 = {
  issueNumber: 48,
  title: SELF_TASK_TITLE,
  body: SELF_TASK_BODY,
  digest: await reviewTaskStatementDigest({
    issueNumber: 48,
    title: SELF_TASK_TITLE,
    body: SELF_TASK_BODY,
  }),
};
/** The exact trusted foreign issue statement its own receipt must bind. */
const FOREIGN_TASK_TITLE = "Deliver the reviewed foreign candidate";
const FOREIGN_TASK_BODY = "The foreign repository must deliver its issue 120.";
const FOREIGN_TASK: ReviewTaskStatementV1 = {
  issueNumber: SHARED_ISSUE_NUMBER,
  title: FOREIGN_TASK_TITLE,
  body: FOREIGN_TASK_BODY,
  digest: await reviewTaskStatementDigest({
    issueNumber: SHARED_ISSUE_NUMBER,
    title: FOREIGN_TASK_TITLE,
    body: FOREIGN_TASK_BODY,
  }),
};

/** The trusted statement the live surface returns for one fixture issue. */
function taskFor(issueNumber: number): ReviewTaskStatementV1 | null {
  if (issueNumber === SELF_TASK.issueNumber) return SELF_TASK;
  if (issueNumber === FOREIGN_TASK.issueNumber) return FOREIGN_TASK;
  return null;
}

/** sentinel's own issue 120: the same number, a different repository's task. */
const SELF_TASK_120_TITLE = "Deliver the reviewed sentinel issue 120 candidate";
const SELF_TASK_120_BODY =
  "Sentinel's own issue 120 is distinct from the foreign issue 120.";
const SELF_TASK_120: ReviewTaskStatementV1 = {
  issueNumber: SHARED_ISSUE_NUMBER,
  title: SELF_TASK_120_TITLE,
  body: SELF_TASK_120_BODY,
  digest: await reviewTaskStatementDigest({
    issueNumber: SHARED_ISSUE_NUMBER,
    title: SELF_TASK_120_TITLE,
    body: SELF_TASK_120_BODY,
  }),
};

/**
 * The trusted statement one repository's own surface returns for one issue:
 * the same issue number in two repositories is two different tasks.
 */
function repositoryTask(
  repository: RepositoryIdentityV1,
  issueNumber: number,
): ReviewTaskStatementV1 | null {
  if (
    repository.name === FOREIGN_REPO.name && repository.owner === "ubiquity"
  ) {
    return issueNumber === FOREIGN_TASK.issueNumber ? FOREIGN_TASK : null;
  }
  if (issueNumber === SELF_TASK.issueNumber) return SELF_TASK;
  if (issueNumber === FOREIGN_TASK.issueNumber) return SELF_TASK_120;
  return null;
}

/** The per-record trusted statement map `planHostedClosures` consumes. */
function closureTasks(
  records: readonly WorkRecordV1[],
): Map<string, ReviewTaskStatementV1 | null | "unavailable"> {
  return new Map(records.map((record) => [
    record.id,
    record.related.issueNumber === null
      ? null
      : repositoryTask(record.repository, record.related.issueNumber),
  ]));
}

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

/** The live zombie record: issue 61 closed, pull request 63 closed unmerged. */
const ZOMBIE = "issue-ubiquity-sentinel-61" as WorkItemId;

function zombieRecord(overrides: Record<string, unknown> = {}): WorkRecordV1 {
  return deliveryRecord({
    id: ZOMBIE,
    source: { kind: "issue", id: "61", revision: SHA1 },
    related: { incidentId: null, issueNumber: 61 },
    target: {
      base: BASE,
      branch: "sentinel/repair/issue-ubiquity-sentinel-61",
      checkpoint: null,
      head: HEAD,
      pr: 63,
    },
    counters: { attempts: 2, retries: 0, reviewRounds: 1 },
    ...overrides,
  });
}

/** The settled implementation intent and charge the zombie record carries. */
function zombieIntent() {
  return {
    kind: "implementation",
    key: "implementation:z-2",
    startedAt: T0 + 1000,
    branch: "sentinel/repair/issue-ubiquity-sentinel-61",
    expectedHead: null,
    observedBase: BASE,
    pr: null,
    requestId: "z-2",
    resultId: null,
  };
}

function zombieCharges() {
  return [
    reservation("z-2", {
      taskId: ZOMBIE,
      head: BASE,
      attempt: 2,
      purpose: "implementation",
      outcome: "submitted",
      settledAt: T0 + 2000,
    }),
  ];
}

/** The same zombie already parked on the transient retryable blocker. */
function blockedZombie(): WorkRecordV1 {
  return blockedRecord({
    id: ZOMBIE,
    source: { kind: "issue", id: "61", revision: SHA1 },
    related: { incidentId: null, issueNumber: 61 },
    target: {
      base: BASE,
      branch: "sentinel/repair/issue-ubiquity-sentinel-61",
      checkpoint: null,
      head: HEAD,
      pr: 63,
    },
    counters: { attempts: 2, retries: 0, reviewRounds: 1 },
    intent: zombieIntent(),
  });
}

/**
 * The attempt identities the loop charges at one base: attempt 1 as
 * `implementation` and every later attempt as `retry`.
 */
function chargedAttempts(base: GitSha = BASE) {
  return [1, 2, 3, 4].map((attempt) =>
    reservation(`charged-${attempt}`, {
      taskId: TARGET,
      head: base,
      attempt,
      purpose: attempt === 1 ? "implementation" : "retry",
      outcome: "submitted",
      settledAt: T0 + 2000,
    })
  );
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
    expectedReviewer: "ubiquity-sentinel[bot]",
    observedReviewer: "ubiquity-sentinel[bot]",
    pullRequest: { number: 51, head: HEAD, base: BASE },
    outcome: "completed",
    resultId: "msg_0123456789abcdef",
    completedAt: T0 + 3000,
    unresolvedSeverities: [],
    observedAt: T0 + 4000,
    taskAcceptance: {
      issueNumber: SELF_TASK.issueNumber,
      taskDigest: SELF_TASK.digest,
      verdict: "fulfilled",
      evidence: ["the reviewed candidate satisfies the source issue"],
    },
    ...overrides,
  });
}

/** A foreign record for its OWN repository, carrying the shared issue number. */
function foreignRecord(overrides: Record<string, unknown> = {}): WorkRecordV1 {
  return deliveryRecord({
    repository: FOREIGN_REPO,
    id: FOREIGN_TARGET,
    source: {
      kind: "issue",
      id: String(SHARED_ISSUE_NUMBER),
      revision: SHA1,
    },
    related: { incidentId: null, issueNumber: SHARED_ISSUE_NUMBER },
    target: {
      base: BASE,
      branch: `sentinel/repair/${FOREIGN_TARGET}`,
      checkpoint: null,
      head: HEAD,
      pr: FOREIGN_PR,
    },
    ...overrides,
  });
}

/** The completed receipt bound to the foreign repository/PR/head/base. */
function foreignReceipt(overrides: Record<string, unknown> = {}) {
  return reviewReceipt(FOREIGN_RECEIPT_ID, {
    repository: FOREIGN_REPO,
    expectedReviewer: "ubiquity-sentinel[bot]",
    observedReviewer: "ubiquity-sentinel[bot]",
    pullRequest: { number: FOREIGN_PR, head: HEAD, base: BASE },
    outcome: "completed",
    resultId: "msg_0123456789abcdef",
    completedAt: T0 + 3000,
    unresolvedSeverities: [],
    observedAt: T0 + 4000,
    taskAcceptance: {
      issueNumber: FOREIGN_TASK.issueNumber,
      taskDigest: FOREIGN_TASK.digest,
      verdict: "fulfilled",
      evidence: ["the reviewed candidate satisfies the foreign issue"],
    },
    ...overrides,
  });
}

/** A foreign pull: its OWN repository's base ref, trusted author. */
function foreignPullFacts(
  overrides: Partial<HostedAutonomyPullV1> = {},
): HostedAutonomyPullV1 {
  return pullFacts({
    number: FOREIGN_PR,
    baseRef: FOREIGN_BRANCH,
    ...overrides,
  });
}

/** Base tips keyed by the self repository scope, as the planner consumes them. */
function selfTips(value: string | null): ReadonlyMap<string, string | null> {
  return new Map([[hostedRepositoryKey(SELF_REPO), value]]);
}

/** Closed-issue identities scoped to the self repository. */
function selfClosed(...numbers: number[]): ReadonlySet<string> {
  return new Set(numbers.map((number) => hostedIssueKey(SELF_REPO, number)));
}

/** One check-run payload as the GitHub check-runs endpoint reports it. */
let nextCheckRunId = 1000;
function checkRun(name: string, overrides: Record<string, unknown> = {}) {
  nextCheckRunId++;
  return {
    id: nextCheckRunId,
    name,
    head_sha: HEAD,
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

/** One complete check-runs page: the endpoint reports both fields. */
function checkRunPage(runs: unknown[], totalCount: number) {
  return { total_count: totalCount, check_runs: runs };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

/** True when a request URL addresses the foreign fixture repository. */
function isForeignPath(url: string): boolean {
  return url.includes("/repos/ubiquity/ai.ubq.fi");
}

/** True when a request URL addresses the sentinel self repository. */
function isSelfPath(url: string): boolean {
  return url.includes("/repos/ubiquity/sentinel");
}

/** True for the sentinel self repository identity. */
function isSelfRepository(repository: RepositoryIdentityV1): boolean {
  return repository.installationId === SELF_REPO.installationId &&
    repository.owner === SELF_REPO.owner &&
    repository.name === SELF_REPO.name;
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
  /**
   * Per-repository surface resolver. The default returns the one fake surface
   * for every identity; a test that exercises routing replaces it.
   */
  githubFor: (
    repository: RepositoryIdentityV1,
  ) => HostedAutonomyGitHubV1 | null;
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
    foreignCheckGreen?: boolean;
    defaultBranch?: string | null;
    issueOpen?: boolean | null;
    /** Trusted source-issue statement override, e.g. for body drift. */
    issueTask?: (
      number: number,
    ) => Promise<ReviewTaskStatementV1 | null>;
    mergeResult?: { merged: boolean; sha: string | null } | null;
    afterMerge?: HostedAutonomyPullV1 | null;
    resolver?: (
      repository: RepositoryIdentityV1,
    ) => HostedAutonomyGitHubV1 | null;
    /**
     * Drive the REAL release store to an accepted receipt for this exact
     * reviewed request through the shared legal-lifecycle fixture; no phase,
     * proof or pointer intent is ever hand-written into the store.
     */
    hostedReceipt?: {
      request: ReleaseRequestV1;
      priorRevision: GitSha;
    };
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
  if (options.hostedReceipt !== undefined) {
    // The shared fixture runs the ACTUAL supervisor core over this same real
    // release store until it persists `accepted`, so the consumers below read
    // a genuinely reachable receipt instead of a hand-written phase.
    let receiptNow = T0;
    await persistHostedReceipt({
      release,
      clock: {
        now: () => receiptNow,
        advance: (ms: number) => {
          receiptNow += ms;
        },
      },
      request: options.hostedReceipt.request,
      priorRevision: options.hostedReceipt.priorRevision,
      phase: "accepted",
    });
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
    githubFor: () => github,
    writes: 0,
    merges: 0,
    closed: [],
  };
  let mergedNow = false;
  const github: HostedAutonomyGitHubV1 = {
    readDefaultBranch: () =>
      Promise.resolve(
        options.defaultBranch === undefined ? "main" : options.defaultBranch,
      ),
    readBaseTip: () =>
      Promise.resolve(options.baseTip === undefined ? BASE : options.baseTip),
    hasSuccessfulCheck: () => Promise.resolve(options.checkGreen ?? true),
    hasAllChecksGreen: () => Promise.resolve(options.foreignCheckGreen ?? true),
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
    readIssueOpen: () =>
      Promise.resolve(
        options.issueOpen === undefined ? true : options.issueOpen,
      ),
    readIssueTask: (number: number) =>
      Promise.resolve(
        options.issueTask === undefined
          ? taskFor(number)
          : options.issueTask(number),
      ),
    listParkedRuns: () => Promise.resolve([]),
    approveRun: () => Promise.resolve(true),
    merge: () => {
      rig.merges++;
      mergedNow = true;
      const result = options.mergeResult === undefined
        ? { merged: true, sha: MERGE }
        : options.mergeResult;
      return Promise.resolve(result);
    },
  };
  if (options.resolver !== undefined) rig.githubFor = options.resolver;
  return { rig, github };
}

async function run(
  rig: RigV1,
  github?: HostedAutonomyGitHubV1,
): Promise<HostedAutonomyResultV1> {
  return await runHostedAutonomy({
    state: rig.state,
    githubFor: github === undefined ? rig.githubFor : () => github,
    clock: { now: () => T0 + 5_000_000 },
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
    // The sentinel App bot is now a trusted delivery author; a pull request
    // authored by it must deliver exactly like the native Actions identity.
    const appAuthored = await makeRig("autonomy-app-author", {
      pull: pullFacts({
        state: "open",
        merged: false,
        mergeCommitSha: null,
        author: "ubiquity-sentinel[bot]",
      }),
      afterMerge: pullFacts({ author: "ubiquity-sentinel[bot]" }),
    });
    const foreignResult = await run(foreign.rig, foreign.github);
    assert.equal(foreignResult.status, "skipped");
    assert.equal(foreignResult.reason, "foreign_author");
    assert.equal(foreign.rig.merges, 0);
    assert.equal(foreign.rig.writes, 0);

    // The App-authored pull request is trusted and delivers end to end.
    const appResult = await run(appAuthored.rig, appAuthored.github);
    assert.equal(appResult.status, "applied", JSON.stringify(appResult));
    assert.equal(appAuthored.rig.merges, 1);

    const wrongParents = await makeRig("autonomy-parents", {
      pull: pullFacts({ parents: [BASE] }),
    });
    assert.equal(
      (await run(wrongParents.rig, wrongParents.github)).status,
      "skipped",
    );
    assert.equal(wrongParents.rig.writes, 0);

    await Promise.all(
      [movedBase, pending, foreign, appAuthored, wrongParents].map((entry) =>
        Deno.remove(entry.rig.tmp, { recursive: true })
      ),
    );
  },
);

Deno.test(
  "hosted autonomy: a delivered head authored by the sentinel App login is accepted during the transition",
  async () => {
    assert.deepEqual(
      [...HOSTED_AUTONOMY_TRUSTED_AUTHORS].sort(),
      ["github-actions[bot]", "ubiquity-sentinel[bot]"],
      "the transition set accepts exactly the native and App logins",
    );
    for (const [index, author] of HOSTED_AUTONOMY_TRUSTED_AUTHORS.entries()) {
      const { rig, github } = await makeRig(`autonomy-author-${index}`, {
        pull: pullFacts({ author }),
      });
      try {
        const result = await run(rig, github);
        assert.equal(
          result.status,
          "applied",
          `${author}: ${JSON.stringify(result)}`,
        );
        assert.equal(result.reason, "applied", author);
        assert.equal(rig.writes, 1, author);
        const requests = await readRequests(rig);
        assert.equal(requests.length, 1, author);
        assert.equal(requests[0].revision, MERGE, author);
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    }
  },
);

Deno.test(
  "hosted autonomy: a transient blocker is retried with a closed grant and a preserved budget",
  () => {
    const record = blockedRecord({
      counters: { attempts: 2, retries: 0, reviewRounds: 1 },
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
    const plans = planHostedRetries(
      snapshot,
      T0 + 5000,
    );
    assert.equal(plans.length, 1);
    assert.equal(plans[0].id, TARGET);
    assert.equal(plans[0].nextStep, "work");
    assert.equal(plans[0].reviewRounds, null);
    const next = applyHostedRetries(snapshot, SHA1, plans, T0 + 5000);
    const applied = next.work[0];
    assert.equal(applied.nextStep, "work");
    assert.equal(applied.blocker, null);
    // The preserved counters are history: only the attempt ceiling moves.
    assert.equal(applied.counters.retries, 0);
    assert.equal(applied.counters.attempts, 2);
    assert.equal(applied.counters.reviewRounds, 1);
    assert.equal(next.reservations.length, 2);
    assert.equal(next.sequence, snapshot.sequence + 1);
  },
);

Deno.test(
  "hosted autonomy: the retry budget is closed and non-transient blockers are untouched",
  () => {
    // The cap's unit is durable reservations (every purpose and outcome,
    // including one still `reserved`), not the preserved `retries` counter.
    const capFixture = (count: number) =>
      repairSnapshot(
        [
          blockedRecord({
            counters: { attempts: 2, retries: 0, reviewRounds: 1 },
          }),
        ],
        [authorizingReceipt()],
        [],
        Array.from({ length: count }, (_, index) =>
          reservation(`cap-${index + 1}`, {
            taskId: TARGET,
            head: BASE,
            attempt: index + 1,
            purpose: "continuation",
            outcome: index % 2 === 0 ? "reserved" : "submitted",
            settledAt: index % 2 === 0 ? null : T0 + 2000,
          })),
      );
    // One reservation below the cap still permits a grant; the cap is closed.
    assert.equal(
      planHostedRetries(
        capFixture(HOSTED_AUTONOMY_MAX_RETRIES - 1),
        T0 + 5000,
      ).length,
      1,
    );
    assert.equal(
      planHostedRetries(capFixture(HOSTED_AUTONOMY_MAX_RETRIES), T0 + 5000)
        .length,
      0,
    );

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
    // Every review identity inside the runtime's own round allowance is spent
    // at this head, and the preserved counter is history: without a newer base
    // this pass fails closed instead of zeroing a charged counter or re-using
    // an identity the runtime would refuse as a duplicate.
    assert.equal(planHostedRetries(reviewRounds, T0 + 5000).length, 0);
    const plans = planHostedRetries(reviewRounds, T0 + 5000, selfTips(SHA1));
    assert.equal(plans.length, 1);
    assert.equal(plans[0].nextStep, "review");
    assert.equal(plans[0].advanceBase, true);
    assert.equal(plans[0].reviewRounds, 14);
    const next = applyHostedRetries(reviewRounds, SHA1, plans, T0 + 5000);
    assert.equal(next.work[0].nextStep, "review");
    assert.equal(next.work[0].counters.reviewRounds, 14);

    const budget = repairSnapshot([
      blockedRecord({
        blocker: {
          kind: "review_quota",
          message: "implementation attempt budget exhausted",
          since: T0 + 3000,
        },
        counters: { attempts: 4, retries: 0, reviewRounds: 1 },
      }),
    ]);
    const budgetPlans = planHostedRetries(
      budget,
      T0 + 5000,
    );
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
    assert.equal(planHostedRetries(foreign, T0 + 5000).length, 0);
  },
);

Deno.test(
  "hosted autonomy: a wedged attempt budget advances the base through the runtime's own refresh intent",
  () => {
    // The live shape: attempts 4, retries 3, one review round spent, and every
    // attempt identity at the old base already charged. Incrementing `retries`
    // here used to make every grant invalid; the preserved counter now stays
    // put and only the attempt ceiling is lowered.
    const record = blockedRecord({
      blocker: {
        kind: "review_quota",
        message: "implementation attempt budget exhausted",
        since: T0 + 3000,
      },
      counters: { attempts: 4, retries: 3, reviewRounds: 1 },
      target: {
        base: BASE,
        branch: "sentinel/repair/issue-ubiquity-sentinel-48",
        checkpoint: null,
        head: HEAD,
        pr: 51,
      },
    });
    // The loop charges attempt 1 as `implementation` and every later attempt as
    // `retry`, so these are the identities a real base carries.
    const charges = [1, 2, 3, 4].map((attempt) =>
      reservation(`r-${attempt}`, {
        taskId: TARGET,
        head: BASE,
        attempt,
        purpose: attempt === 1 ? "implementation" : "retry",
        outcome: "submitted",
        settledAt: T0 + 2000,
      })
    );
    const p1Receipt = authorizingReceipt({
      findings: [finding("P1")],
      unresolvedSeverities: ["P1"],
    });
    const snapshot = repairSnapshot(
      [record],
      [p1Receipt],
      [],
      charges,
    );
    const now = T0 + 5000;
    // With no newer base the task stays put: nothing may invent an identity.
    assert.equal(planHostedRetries(snapshot, now, selfTips(BASE)).length, 0);
    // With a newer base the runtime's own refresh gives fresh identities.
    const newerBase = SHA1;
    const plans = planHostedRetries(snapshot, now, selfTips(newerBase));
    assert.equal(plans.length, 1);
    assert.equal(plans[0].advanceBase, true);
    assert.equal(plans[0].grant, 1);
    assert.equal(plans[0].observedBase, newerBase);
    const next = applyHostedRetries(snapshot, SHA1, plans, now);
    const applied = next.work[0];
    assert.equal(applied.nextStep, "work");
    assert.equal(applied.blocker, null);
    // The applied record is valid (the frozen parser accepted it) with only
    // attempts lowered: retries and review rounds are untouched history.
    assert.equal(applied.counters.attempts, 3);
    assert.equal(applied.counters.retries, 3);
    assert.equal(applied.counters.reviewRounds, 1);
    assert.deepEqual(applied.target, record.target);
    assert.deepEqual(applied.evidence, record.evidence);
    assert.deepEqual(next.evidence, snapshot.evidence);
    assert.deepEqual(next.reviews, snapshot.reviews);
    assert.deepEqual(next.reservations, snapshot.reservations);
    assert.equal(
      applied.target.base,
      BASE,
      "the refresh advances the base, not this pass",
    );
    assert.ok(
      applied.intent !== null && applied.intent.kind === "base_refresh",
    );
    assert.equal(applied.intent?.expectedHead, HEAD);
    assert.equal(applied.intent?.observedBase, newerBase);
    assert.equal(applied.intent?.pr, 51);
    assert.equal(
      applied.intent?.key,
      `base_refresh:51:${HEAD}:${newerBase}`,
    );
    assert.equal(next.reservations.length, 4);
  },
);

Deno.test(
  "hosted autonomy: a task whose retries reached its attempts is left alone, never invalid",
  () => {
    const record = blockedRecord({
      blocker: {
        kind: "review_quota",
        message: "implementation attempt budget exhausted",
        since: T0 + 3000,
      },
      counters: { attempts: 4, retries: 4, reviewRounds: 1 },
      target: {
        base: BASE,
        branch: "sentinel/repair/issue-ubiquity-sentinel-48",
        checkpoint: null,
        head: HEAD,
        pr: 51,
      },
    });
    const snapshot = repairSnapshot([record], [authorizingReceipt()]);
    // `retries <= attempts` is a frozen invariant and this pass only lowers
    // attempts, so neither a normal grant nor the base-advance grant that would
    // land at 3 is representable here: the plan refuses instead of writing an
    // invalid snapshot, even with a newer base available.
    assert.equal(planHostedRetries(snapshot, T0 + 5000).length, 0);
    assert.equal(
      planHostedRetries(snapshot, T0 + 5000, selfTips(SHA1)).length,
      0,
    );
    const next = applyHostedRetries(snapshot, SHA1, [], T0 + 5000);
    assert.equal(next.work[0].counters.attempts, 4);
    assert.equal(next.work[0].counters.retries, 4);
  },
);

Deno.test(
  "hosted autonomy: a task whose source issue is closed is never retried",
  () => {
    const record = blockedRecord({
      counters: { attempts: 2, retries: 0, reviewRounds: 1 },
    });
    const snapshot = repairSnapshot([record], [authorizingReceipt()]);
    assert.equal(planHostedRetries(snapshot, T0 + 5000).length, 1);
    assert.equal(
      planHostedRetries(
        snapshot,
        T0 + 5000,
        selfTips(null),
        new Set([hostedIssueKey(SELF_REPO, 48)]),
      ).length,
      0,
    );
    // The same number scoped to ANOTHER repository never stops this retry.
    assert.equal(
      planHostedRetries(
        snapshot,
        T0 + 5000,
        selfTips(null),
        new Set([hostedIssueKey(FOREIGN_REPO, 48)]),
      ).length,
      1,
    );
  },
);

Deno.test(
  "hosted autonomy: a settled three-round review record advances the base instead of re-using a charged identity",
  () => {
    // The live shape: review admissions 1-3 are durably settled at the current
    // candidate head and the review-round counter was reset to 0, so re-entry
    // at the same head can only collide with attempt 1 again.
    const record = blockedRecord({
      blocker: {
        kind: "unavailable",
        message: "review admission already settled without an intent",
        since: T0 + 3000,
      },
      counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      target: {
        base: BASE,
        branch: "sentinel/repair/issue-ubiquity-sentinel-48",
        checkpoint: null,
        head: HEAD,
        pr: 51,
      },
    });
    const charges = [1, 2, 3].map((attempt) =>
      reservation(`review-${attempt}`, {
        taskId: TARGET,
        repository: SELF_REPO,
        head: HEAD,
        attempt,
        purpose: "review_request",
        outcome: "submitted",
        settledAt: T0 + 2000,
      })
    );
    const snapshot = repairSnapshot(
      [record],
      [authorizingReceipt()],
      [],
      charges,
    );
    const now = T0 + 5000;
    // Three charged identities are the whole space at this head and the base
    // has not moved: nothing may invent a fourth round at the same head.
    assert.equal(planHostedRetries(snapshot, now, selfTips(BASE)).length, 0);
    const newerBase = SHA1;
    const plans = planHostedRetries(snapshot, now, selfTips(newerBase));
    assert.equal(plans.length, 1);
    assert.equal(plans[0].nextStep, "review");
    assert.equal(plans[0].advanceBase, true);
    assert.equal(plans[0].observedBase, newerBase);
    // The floor is the highest settled review attempt at the current head,
    // never 0: a charged counter is history and is only ever raised.
    assert.equal(plans[0].reviewRounds, HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS);
    assert.equal(plans[0].grant, 0);
    const next = applyHostedRetries(snapshot, SHA1, plans, now);
    const applied = next.work[0];
    assert.equal(applied.nextStep, "review");
    assert.equal(applied.blocker, null);
    assert.equal(applied.counters.reviewRounds, 3);
    assert.equal(applied.counters.attempts, 1);
    assert.equal(applied.counters.retries, 0);
    // The runtime's own base-refresh intent is persisted against the newer base
    // and the exact publication identity: the refresh supplies the new head and
    // with it the unused review identity.
    assert.ok(
      applied.intent !== null && applied.intent.kind === "base_refresh",
    );
    assert.equal(applied.intent?.key, `base_refresh:51:${HEAD}:${newerBase}`);
    assert.equal(applied.intent?.pr, 51);
    assert.equal(applied.intent?.expectedHead, HEAD);
    assert.equal(applied.intent?.observedBase, newerBase);
    // Charged history is untouched: every reservation, receipt and the target
    // identity stay exactly as they were.
    assert.deepEqual(next.reservations, snapshot.reservations);
    assert.deepEqual(next.reviews, snapshot.reviews);
    assert.deepEqual(applied.target, record.target);
    assert.equal(next.reservations.length, 3);
  },
);

Deno.test(
  "hosted autonomy: a settled ambiguous review intent restores its floor and continues at an unused identity",
  () => {
    // The live shape: one review request was admitted and settled `ambiguous`
    // (charge preserved), its intent is still preserved and the round counter
    // is 0. The floor restored from the settled charge makes the next
    // admission attempt 2, an identity nothing has charged yet.
    const record = blockedRecord({
      blocker: {
        kind: "unavailable",
        message: "review produced no verdict within the bounded review wait",
        since: T0 + 3000,
      },
      counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      target: {
        base: BASE,
        branch: candidateBranch(TARGET),
        checkpoint: null,
        head: HEAD,
        pr: 51,
      },
      intent: {
        kind: "review_request",
        // The canonical production key for the first review round of this
        // exact PR/head, exactly as the runtime persisted it.
        key: reviewOperationKey(51, HEAD),
        startedAt: T0 + 1000,
        branch: candidateBranch(TARGET),
        expectedHead: HEAD,
        // The actual base the production loop observed when it requested this
        // review: the record's own non-null target base.
        observedBase: BASE,
        pr: 51,
        requestId: "review-charge-1",
        resultId: null,
      },
    });
    const charge = reservation("review-charge-1", {
      taskId: TARGET,
      repository: SELF_REPO,
      head: HEAD,
      attempt: 1,
      purpose: "review_request",
      outcome: "ambiguous",
      settledAt: T0 + 2000,
    });
    const snapshot = repairSnapshot(
      [record],
      [authorizingReceipt()],
      [],
      [charge],
    );
    const now = T0 + 5000;
    const plans = planHostedRetries(snapshot, now, selfTips(BASE));
    assert.equal(plans.length, 1);
    assert.equal(plans[0].nextStep, "review");
    assert.equal(plans[0].advanceBase, false);
    assert.equal(plans[0].reviewRounds, 1);
    assert.equal(plans[0].grant, 0);
    const next = applyHostedRetries(snapshot, SHA1, plans, now);
    const applied = next.work[0];
    assert.equal(applied.nextStep, "review");
    assert.equal(applied.blocker, null);
    // The settled intent is closed only because its exact request charge is
    // proven settled; the charge itself stays exactly as it was.
    assert.equal(applied.intent, null);
    assert.equal(applied.counters.reviewRounds, 1);
    assert.equal(applied.counters.attempts, 1);
    assert.deepEqual(next.reservations, snapshot.reservations);
    // Identity 2 at this exact head is unused: the next request is a genuine
    // new admission, never a duplicate of the settled attempt 1.
    assert.ok(
      !next.reservations.some((entry) =>
        entry.taskId === TARGET && entry.head === HEAD &&
        entry.purpose === "review_request" && entry.attempt === 2
      ),
    );
  },
);

Deno.test(
  "hosted autonomy: a review intent is cleared only by its exact publication identity and canonical round key",
  () => {
    const reviewIntent = (overrides: Record<string, unknown> = {}) => ({
      kind: "review_request",
      // The canonical production key for round 1 of this exact PR/head.
      key: reviewOperationKey(51, HEAD),
      startedAt: T0 + 1000,
      branch: candidateBranch(TARGET),
      expectedHead: HEAD,
      observedBase: BASE,
      pr: 51,
      requestId: "review-charge-1",
      resultId: null,
      ...overrides,
    });
    const record = (
      intent: unknown,
      branch = candidateBranch(TARGET),
    ) =>
      blockedRecord({
        blocker: {
          kind: "unavailable",
          message: "review admission already settled without an intent",
          since: T0 + 3000,
        },
        counters: { attempts: 1, retries: 0, reviewRounds: 0 },
        target: {
          base: BASE,
          branch,
          checkpoint: null,
          head: HEAD,
          pr: 51,
        },
        intent,
      });
    const plan = (
      intent: unknown,
      charges: unknown[],
      branch?: string,
    ): number =>
      planHostedRetries(
        repairSnapshot(
          [record(intent, branch)],
          [authorizingReceipt()],
          [],
          charges,
        ),
        T0 + 5000,
        selfTips(BASE),
      ).length;
    /** The exact review charge of one round, settled and still charged. */
    const settledCharge = (attempt = 1) =>
      reservation("review-charge-1", {
        taskId: TARGET,
        repository: SELF_REPO,
        head: HEAD,
        attempt,
        purpose: "review_request",
        outcome: "submitted",
        settledAt: T0 + 2000,
      });

    // Baseline: the exact publication identity the record currently carries and
    // the canonical key of the settled round are closable.
    assert.equal(plan(reviewIntent(), [settledCharge()]), 1);
    // The same binding at a later round stays closable: the key is derived from
    // the settled reservation's own attempt, not from a fixed round.
    assert.equal(
      plan(reviewIntent({ key: reviewOperationKey(51, HEAD, 2) }), [
        settledCharge(2),
      ]),
      1,
    );

    // Still `reserved`: the runtime's uncertainty handler owns that in-flight
    // admission and it must never be cleared or re-planned here.
    assert.equal(
      plan(reviewIntent(), [
        reservation("review-charge-1", {
          taskId: TARGET,
          repository: SELF_REPO,
          head: HEAD,
          attempt: 1,
          purpose: "review_request",
          outcome: "reserved",
        }),
      ]),
      0,
    );
    // The intent's expected head must be the record's current head: a stale
    // intent for another publication is never cleared by a current-head charge.
    assert.equal(
      plan(reviewIntent({ expectedHead: SHA1 }), [settledCharge()]),
      0,
    );
    // The intent's PR must be the record's PR.
    assert.equal(plan(reviewIntent({ pr: 52 }), [settledCharge()]), 0);
    // The intent's branch must be this task's deterministic candidate branch.
    assert.equal(
      plan(reviewIntent({ branch: candidateBranch(ZOMBIE) }), [
        settledCharge(),
      ]),
      0,
    );
    // ...and the record's own branch must be the branch the intent names.
    assert.equal(
      plan(reviewIntent(), [settledCharge()], candidateBranch(ZOMBIE)),
      0,
    );
    // The intent's observed base must be the record's non-null target base: a
    // null or moved base is never cleared by an otherwise matching charge.
    assert.equal(
      plan(reviewIntent({ observedBase: null }), [settledCharge()]),
      0,
    );
    assert.equal(
      plan(reviewIntent({ observedBase: SHA1 }), [settledCharge()]),
      0,
    );
    // The intent key must be the canonical key of the settled round: another
    // round's key (or an unknown key) never proves this admission settled.
    assert.equal(
      plan(reviewIntent({ key: reviewOperationKey(51, HEAD, 2) }), [
        settledCharge(),
      ]),
      0,
    );
    assert.equal(
      plan(reviewIntent({ key: `review:51:${HEAD}:attempt-9` }), [
        settledCharge(),
      ]),
      0,
    );
    // A settled reservation for another round than the key names is a
    // different identity and never settles this intent.
    assert.equal(plan(reviewIntent(), [settledCharge(2)]), 0);
    // A settled reservation bound to a different head proves nothing about
    // THIS head.
    assert.equal(
      plan(reviewIntent(), [
        reservation("review-charge-1", {
          taskId: TARGET,
          repository: SELF_REPO,
          head: SHA1,
          attempt: 1,
          purpose: "review_request",
          outcome: "submitted",
          settledAt: T0 + 2000,
        }),
      ]),
      0,
    );
    // A settled reservation in another repository is never borrowed.
    assert.equal(
      plan(reviewIntent(), [
        reservation("review-charge-1", {
          taskId: TARGET,
          repository: FOREIGN_REPO,
          head: HEAD,
          attempt: 1,
          purpose: "review_request",
          outcome: "submitted",
          settledAt: T0 + 2000,
        }),
      ]),
      0,
    );
    // A settled reservation under a different purpose is not a review charge.
    assert.equal(
      plan(reviewIntent(), [
        reservation("review-charge-1", {
          taskId: TARGET,
          repository: SELF_REPO,
          head: HEAD,
          attempt: 1,
          purpose: "implementation",
          outcome: "submitted",
          settledAt: T0 + 2000,
        }),
      ]),
      0,
    );
    // A settled reservation for another task is never borrowed.
    assert.equal(
      plan(reviewIntent(), [
        reservation("review-charge-1", {
          taskId: ZOMBIE,
          repository: SELF_REPO,
          head: HEAD,
          attempt: 1,
          purpose: "review_request",
          outcome: "submitted",
          settledAt: T0 + 2000,
        }),
      ]),
      0,
    );
    // No matching reservation at all is unknown, not settled.
    assert.equal(plan(reviewIntent({ requestId: "review-charge-9" }), []), 0);
    assert.equal(plan(reviewIntent({ requestId: null }), []), 0);
  },
);

Deno.test(
  "hosted autonomy: a working record whose source issue closed is parked, never retried",
  () => {
    const record = deliveryRecord({
      nextStep: "work",
      target: {
        base: BASE,
        branch: "sentinel/repair/issue-ubiquity-sentinel-48",
        checkpoint: null,
        head: null,
        pr: null,
      },
    });
    const snapshot = repairSnapshot([record], [authorizingReceipt()]);
    assert.deepEqual(
      planHostedRetirements(snapshot, selfClosed(48)),
      [{ id: TARGET, issueNumber: 48, repository: SELF_REPO }],
    );
    // A record with an open pull request still has a delivery path.
    assert.deepEqual(planHostedRetirements(snapshot, new Set()), []);
    const next = applyHostedRetirements(
      snapshot,
      SHA1,
      [{ id: TARGET, issueNumber: 48 }],
      T0 + 5000,
    );
    const parked = next.work[0];
    assert.equal(parked.nextStep, "blocked");
    assert.equal(parked.blocker?.message, HOSTED_AUTONOMY_RETIRED);
    // The retirement reason matches no retryable prefix.
    assert.equal(planHostedRetries(next, T0 + 900000).length, 0);
  },
);

Deno.test(
  "hosted autonomy: only a definitively closed-unmerged pull parks a record that has one",
  () => {
    const snapshot = repairSnapshot([zombieRecord()]);
    // The pull's own state is the new evidence: a closed issue alone is not.
    assert.deepEqual(planHostedRetirements(snapshot, selfClosed(61)), []);
    assert.deepEqual(
      planHostedRetirements(snapshot, selfClosed(61), new Set([ZOMBIE])),
      [{ id: ZOMBIE, issueNumber: 61, repository: SELF_REPO }],
    );
    // A record that produced nothing keeps the existing skip while it is
    // already parked, whatever the closed-unmerged set says.
    const parked = repairSnapshot([
      zombieRecord({
        nextStep: "blocked",
        blocker: {
          kind: "other",
          message: "model run ended without a trusted receipt",
          since: T0 + 3000,
        },
        target: {
          base: BASE,
          branch: "sentinel/repair/issue-ubiquity-sentinel-61",
          checkpoint: null,
          head: null,
          pr: null,
        },
      }),
    ]);
    assert.deepEqual(
      planHostedRetirements(
        parked,
        selfClosed(61),
        new Set([ZOMBIE]),
      ),
      [],
    );
  },
);

Deno.test(
  "hosted autonomy: a closed-unmerged pull parks an already blocked record",
  () => {
    // The record carries a settled implementation intent: retirement may
    // clear it because the runtime already resolved that charge.
    const snapshot = repairSnapshot(
      [blockedZombie()],
      [authorizingReceipt()],
      [],
      zombieCharges(),
    );
    assert.deepEqual(
      planHostedRetirements(snapshot, selfClosed(61), new Set([ZOMBIE])),
      [{ id: ZOMBIE, issueNumber: 61, repository: SELF_REPO }],
    );
  },
);

Deno.test(
  "hosted autonomy: an unsettled implementation intent is never retired",
  () => {
    // The companion baseline: the same closed-unmerged record with a SETTLED
    // implementation reservation is retired (retirement clears that intent).
    const settled = repairSnapshot(
      [zombieRecord({ intent: zombieIntent() })],
      [authorizingReceipt()],
      [],
      zombieCharges(),
    );
    assert.deepEqual(
      planHostedRetirements(settled, selfClosed(61), new Set([ZOMBIE])),
      [{ id: ZOMBIE, issueNumber: 61, repository: SELF_REPO }],
    );

    // A matching reservation that is still `reserved` is not settled.
    const reserved = repairSnapshot(
      [zombieRecord({ intent: zombieIntent() })],
      [authorizingReceipt()],
      [],
      [
        reservation("z-2", {
          taskId: ZOMBIE,
          head: BASE,
          attempt: 2,
          purpose: "implementation",
          outcome: "reserved",
        }),
      ],
    );
    assert.deepEqual(
      planHostedRetirements(reserved, selfClosed(61), new Set([ZOMBIE])),
      [],
    );

    // No matching reservation at all is not settled either.
    const missing = repairSnapshot([zombieRecord({ intent: zombieIntent() })]);
    assert.deepEqual(
      planHostedRetirements(missing, selfClosed(61), new Set([ZOMBIE])),
      [],
    );

    // A non-implementation intent stays retirable: the runtime clears an
    // unprepared base_refresh itself.
    const refreshing = repairSnapshot([
      zombieRecord({
        intent: {
          kind: "base_refresh",
          key: "base-refresh:z-2",
          startedAt: T0 + 1000,
          branch: "sentinel/repair/issue-ubiquity-sentinel-61",
          expectedHead: HEAD,
          observedBase: SHA1,
          pr: 63,
          requestId: null,
          resultId: null,
        },
      }),
    ]);
    assert.deepEqual(
      planHostedRetirements(refreshing, selfClosed(61), new Set([ZOMBIE])),
      [{ id: ZOMBIE, issueNumber: 61, repository: SELF_REPO }],
    );
  },
);

Deno.test(
  "hosted autonomy: a parked deterministic check on the reviewed head is approved",
  async () => {
    const { rig, github } = await makeRig("autonomy-approve", {
      repair: repairSnapshot([deliveryRecord()], [authorizingReceipt()]),
      pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
      checkGreen: false,
    });
    const calls: number[] = [];
    github.listParkedRuns = (head: string) => {
      assert.equal(head, HEAD);
      return Promise.resolve([4242]);
    };
    github.approveRun = (id: number) => {
      calls.push(id);
      return Promise.resolve(true);
    };
    const result = await run(rig, github);
    assert.deepEqual(calls, [4242]);
    assert.ok(result.actions.includes(`approve:${TARGET}:run=4242:approved`));
    await Deno.remove(rig.tmp, { recursive: true });
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
    assert.equal(planHostedRetries(unsettled, T0 + 5000).length, 0);

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
    assert.equal(
      planHostedRetries(
        settled,
        T0 + 5000,
      ).length,
      1,
    );
  },
);

Deno.test(
  "hosted autonomy: an unmerged pull parses without a merge commit and a merged pull still resolves",
  async () => {
    const live = parseHostedAutonomyPull({
      state: "open",
      merged: false,
      merge_commit_sha: null,
      head: { sha: HEAD },
      base: { ref: "development" },
      user: { login: "github-actions[bot]" },
      number: 63,
    });
    assert.deepEqual(live, {
      number: 63,
      state: "open",
      merged: false,
      mergeCommitSha: null,
      headSha: HEAD,
      baseRef: "development",
      author: "github-actions[bot]",
      parents: [],
      revisionOnBaseBranch: false,
    });
    const merged = parseHostedAutonomyPull({
      state: "closed",
      merged: true,
      merge_commit_sha: MERGE,
      head: { sha: HEAD },
      base: { ref: "development" },
      user: { login: "github-actions[bot]" },
      number: 51,
    });
    assert.equal(merged?.merged, true);
    assert.equal(merged?.mergeCommitSha, MERGE);
    assert.equal(merged?.headSha, HEAD);
    assert.equal(merged?.baseRef, "development");
    // A merged pull must still name the merge commit it was merged as.
    assert.equal(
      parseHostedAutonomyPull({
        state: "closed",
        merged: true,
        merge_commit_sha: null,
        head: { sha: HEAD },
        base: { ref: "development" },
        user: { login: "github-actions[bot]" },
        number: 51,
      }),
      null,
    );

    const original = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      const payload = url.includes("/pulls/63")
        ? {
          state: "open",
          merged: false,
          merge_commit_sha: null,
          head: { sha: HEAD },
          base: { ref: "development" },
          user: { login: "github-actions[bot]" },
          number: 63,
        }
        : url.includes("/pulls/51")
        ? {
          state: "closed",
          merged: true,
          merge_commit_sha: MERGE,
          head: { sha: HEAD },
          base: { ref: "development" },
          user: { login: "github-actions[bot]" },
          number: 51,
        }
        : url.includes("/commits/")
        ? { parents: [{ sha: BASE }, { sha: HEAD }] }
        : {
          status: "ahead",
          base_commit: { sha: MERGE },
          merge_base_commit: { sha: MERGE },
        };
      return Promise.resolve(
        new Response(JSON.stringify(payload), { status: 200 }),
      );
    }) as typeof fetch;
    try {
      const github = createHostedAutonomyGitHub("fixture-token", SELF_REPO);
      const unmerged = await github.readPull(63, "development");
      assert.equal(unmerged?.state, "open");
      assert.equal(unmerged?.merged, false);
      assert.equal(unmerged?.mergeCommitSha, null);
      assert.equal(unmerged?.headSha, HEAD);
      assert.equal(unmerged?.baseRef, "development");
      assert.equal(unmerged?.author, "github-actions[bot]");
      assert.equal(requests.length, 1);
      assert.ok(requests[0].includes("/repos/ubiquity/sentinel/pulls/63"));

      const afterMerge = await github.readPull(51, "development");
      if (afterMerge === null) throw new Error("merged pull unreadable");
      assert.equal(afterMerge.merged, true);
      assert.equal(afterMerge.mergeCommitSha, MERGE);
      assert.deepEqual([...afterMerge.parents], [BASE, HEAD]);
      assert.equal(afterMerge.revisionOnBaseBranch, true);
      assert.equal(requests.length, 4);
      assert.ok(requests[3].includes("/repos/ubiquity/sentinel/compare/"));
    } finally {
      globalThis.fetch = original;
    }
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
    assert.equal(record.counters.retries, 0);
    assert.equal(record.counters.attempts, 1);
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
  "hosted autonomy: an unreadable pull skips as a read failure while an open one is still planned",
  async () => {
    const { rig, github } = await makeRig("autonomy-retry-read", {
      repair: repairSnapshot([blockedRecord()], [authorizingReceipt()]),
    });
    const throwing: HostedAutonomyGitHubV1 = {
      ...github,
      readPull: () => Promise.reject(new Error("transient read failure")),
    };
    const thrown = await run(rig, throwing);
    assert.equal(rig.writes, 0);
    assert.ok(
      thrown.actions.some((action) => action.endsWith("pr_read_failed")),
    );
    assert.ok(
      !thrown.actions.some((action) => action.endsWith("pr_not_open")),
    );

    const unreadable: HostedAutonomyGitHubV1 = {
      ...github,
      readPull: () => Promise.resolve(null),
    };
    const unread = await run(rig, unreadable);
    assert.equal(rig.writes, 0);
    assert.ok(
      unread.actions.some((action) => action.endsWith("pr_read_failed")),
    );

    const open: HostedAutonomyGitHubV1 = {
      ...github,
      readPull: () =>
        Promise.resolve(
          pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
        ),
    };
    const retried = await run(rig, open);
    assert.equal(retried.status, "applied");
    assert.equal(retried.reason, "retried");
    assert.equal(rig.writes, 1);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a closed issue with a closed-unmerged pull retires the record",
  async () => {
    const { rig, github } = await makeRig("autonomy-retire-unmerged", {
      repair: repairSnapshot(
        [zombieRecord({ intent: zombieIntent() })],
        [authorizingReceipt()],
        [],
        zombieCharges(),
      ),
      pull: pullFacts({
        number: 63,
        state: "closed",
        merged: false,
        mergeCommitSha: null,
      }),
    });
    github.readIssueOpen = () => Promise.resolve(false);
    const result = await run(rig, github);
    assert.equal(result.status, "applied");
    assert.equal(result.reason, "retired_records");
    assert.equal(rig.writes, 1);
    assert.ok(result.actions.includes(`retire:${ZOMBIE}:issue=61`));
    const read = await rig.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("unreadable");
    }
    const record = read.value.snapshot.work[0];
    assert.equal(record.nextStep, "blocked");
    assert.equal(record.blocker?.message, HOSTED_AUTONOMY_RETIRED);
    assert.equal(record.intent, null);
    // Terminal: the retirement reason matches no retryable prefix.
    assert.equal(planHostedRetries(read.value.snapshot, T0 + 900000).length, 0);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a closed issue with an already blocked closed-unmerged record is parked",
  async () => {
    const { rig, github } = await makeRig("autonomy-retire-blocked", {
      repair: repairSnapshot(
        [blockedZombie()],
        [authorizingReceipt()],
        [],
        zombieCharges(),
      ),
      pull: pullFacts({
        number: 63,
        state: "closed",
        merged: false,
        mergeCommitSha: null,
      }),
    });
    github.readIssueOpen = () => Promise.resolve(false);
    const result = await run(rig, github);
    assert.equal(result.status, "applied");
    assert.equal(result.reason, "retired_records");
    assert.equal(rig.writes, 1);
    assert.ok(result.actions.includes(`retire:${ZOMBIE}:issue=61`));
    const read = await rig.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("unreadable");
    }
    const record = read.value.snapshot.work[0];
    assert.equal(record.nextStep, "blocked");
    assert.equal(record.blocker?.message, HOSTED_AUTONOMY_RETIRED);
    assert.equal(record.intent, null);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a closed issue with an open pull is not retired",
  async () => {
    const { rig, github } = await makeRig("autonomy-retire-open", {
      repair: repairSnapshot([zombieRecord()]),
      pull: pullFacts({
        number: 63,
        state: "open",
        merged: false,
        mergeCommitSha: null,
      }),
    });
    github.readIssueOpen = () => Promise.resolve(false);
    const result = await run(rig, github);
    assert.equal(rig.writes, 0);
    assert.ok(!result.actions.some((action) => action.startsWith("retire:")));
    const read = await rig.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("unreadable");
    }
    const record = read.value.snapshot.work[0];
    assert.equal(record.nextStep, "delivery");
    assert.equal(record.blocker, null);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a closed issue with a merged pull is not retired",
  async () => {
    const { rig, github } = await makeRig("autonomy-retire-merged", {
      repair: repairSnapshot([zombieRecord()]),
      pull: pullFacts({ number: 63, state: "closed", merged: true }),
    });
    github.readIssueOpen = () => Promise.resolve(false);
    const result = await run(rig, github);
    assert.equal(rig.writes, 0);
    assert.ok(!result.actions.some((action) => action.startsWith("retire:")));
    const read = await rig.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("unreadable");
    }
    const record = read.value.snapshot.work[0];
    assert.equal(record.nextStep, "delivery");
    assert.equal(record.blocker, null);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a closed issue with an unreadable pull is not retired",
  async () => {
    const { rig, github } = await makeRig("autonomy-retire-unreadable", {
      repair: repairSnapshot([zombieRecord()]),
    });
    github.readIssueOpen = () => Promise.resolve(false);
    const throwing: HostedAutonomyGitHubV1 = {
      ...github,
      readPull: () => Promise.reject(new Error("transient read failure")),
    };
    const thrown = await run(rig, throwing);
    assert.equal(rig.writes, 0);
    assert.ok(!thrown.actions.some((action) => action.startsWith("retire:")));
    const unreadable: HostedAutonomyGitHubV1 = {
      ...github,
      readPull: () => Promise.resolve(null),
    };
    const unread = await run(rig, unreadable);
    assert.equal(rig.writes, 0);
    assert.ok(!unread.actions.some((action) => action.startsWith("retire:")));
    const read = await rig.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("unreadable");
    }
    const record = read.value.snapshot.work[0];
    assert.equal(record.nextStep, "delivery");
    assert.equal(record.blocker, null);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a closed issue with no pull is still retired by the runner",
  async () => {
    const record = deliveryRecord({
      nextStep: "work",
      target: {
        base: BASE,
        branch: "sentinel/repair/issue-ubiquity-sentinel-48",
        checkpoint: null,
        head: null,
        pr: null,
      },
    });
    const { rig, github } = await makeRig("autonomy-retire-nopr", {
      repair: repairSnapshot([record], [authorizingReceipt()]),
    });
    github.readIssueOpen = () => Promise.resolve(false);
    const result = await run(rig, github);
    assert.equal(result.status, "applied");
    assert.equal(result.reason, "retired_records");
    assert.equal(rig.writes, 1);
    assert.ok(result.actions.includes(`retire:${TARGET}:issue=48`));
    const read = await rig.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("unreadable");
    }
    const parked = read.value.snapshot.work[0];
    assert.equal(parked.nextStep, "blocked");
    assert.equal(parked.blocker?.message, HOSTED_AUTONOMY_RETIRED);
    assert.equal(parked.intent, null);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

async function retirementClosureRig(merged = false, review = foreignReceipt()) {
  const retiring = deliveryRecord({
    nextStep: "work",
    target: {
      base: BASE,
      branch: "sentinel/retiring",
      checkpoint: null,
      head: null,
      pr: null,
    },
  });
  const unrelated = deliveryRecord({
    id: "preserved-unrelated" as WorkItemId,
    source: { kind: "issue", id: "999", revision: SHA1 },
    related: { incidentId: null, issueNumber: 999 },
    nextStep: "done",
  });
  const charge = reservation("preserved-foreign-charge", {
    repository: FOREIGN_REPO,
    taskId: FOREIGN_TARGET,
    head: HEAD,
    outcome: "submitted",
    settledAt: T0 + 2000,
  });
  const { rig, github } = await makeRig("retirement-closure", {
    repair: repairSnapshot(
      [retiring, foreignRecord(), unrelated],
      [review],
      [],
      [charge],
    ),
    pull: foreignPullFacts({
      state: merged ? "closed" : "open",
      merged,
      mergeCommitSha: merged ? MERGE : null,
    }),
    afterMerge: foreignPullFacts(),
  });
  const closedAt: { repository: RepositoryIdentityV1; issueNumber: number }[] =
    [];
  const checkedHeads: string[] = [];
  const foreign = {
    ...github,
    hasAllChecksGreen: (head: string) => {
      checkedHeads.push(head);
      return github.hasAllChecksGreen(head);
    },
    readIssueTask: (number: number) =>
      Promise.resolve(repositoryTask(FOREIGN_REPO, number)),
    closeIssue: (number: number) => {
      closedAt.push({ repository: FOREIGN_REPO, issueNumber: number });
      return github.closeIssue(number);
    },
  };
  rig.githubFor = (repository) =>
    isSelfRepository(repository)
      ? {
        ...github,
        readIssueOpen: () => Promise.resolve(false),
        readIssueTask: (number) =>
          Promise.resolve(repositoryTask(SELF_REPO, number)),
      }
      : foreign;
  return { rig, foreign, closedAt, checkedHeads, retiring, unrelated };
}

Deno.test("hosted autonomy: verified retirement continues foreign closure on the new CAS head", async () => {
  const { rig, closedAt, checkedHeads, retiring, unrelated } =
    await retirementClosureRig();
  try {
    const before = await rig.state.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    if (!before.ok || before.value.status !== "found") {
      throw new Error("unreadable");
    }
    const writes: {
      parent: GitSha | null;
      next: RepairStateSnapshotV1;
      head: GitSha | null;
    }[] = [];
    const write = rig.state.writeRepair.bind(rig.state);
    rig.state.writeRepair = async (next, parent) => {
      const result = await write(next, parent);
      writes.push({
        parent,
        next,
        head: result.ok && result.value.status === "applied"
          ? result.value.head
          : null,
      });
      return result;
    };
    const result = await run(rig);
    const after = await rig.state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    if (!after.ok || after.value.status !== "found") {
      throw new Error("unreadable");
    }
    assert.equal(
      after.value.snapshot.work.find((record) => record.id === retiring.id)
        ?.blocker?.message,
      HOSTED_AUTONOMY_RETIRED,
    );
    assert.equal(
      rig.merges,
      1,
      "the reviewed foreign candidate merged before retirement",
    );
    assert.ok(
      result.actions.includes(`delivery:${FOREIGN_TARGET}:foreign_merged`),
      JSON.stringify(result),
    );
    assert.deepEqual(
      rig.closed,
      [SHARED_ISSUE_NUMBER],
      "verified retirement must not defer the ready foreign closure",
    );
    assert.deepEqual(closedAt, [{
      repository: FOREIGN_REPO,
      issueNumber: SHARED_ISSUE_NUMBER,
    }]);
    assert.deepEqual(checkedHeads, [HEAD, HEAD]);
    assert.equal(result.reason, "closed_issues");
    assert.equal(rig.writes, 2);
    assert.equal(rig.merges, 1);
    assert.deepEqual(writes.map((entry) => entry.parent), [
      before.value.head,
      writes[0].head,
    ]);
    assert.equal(writes[1].next.stateHead, writes[0].head);
    assert.equal(result.beforeHead, writes[0].head);
    assert.equal(result.appliedHead, after.value.head);
    assert.equal(
      after.value.snapshot.sequence,
      before.value.snapshot.sequence + 2,
    );
    const delivered = after.value.snapshot.work.find((record) =>
      record.id === FOREIGN_TARGET
    );
    assert.equal(delivered?.nextStep, "done");
    assert.deepEqual(
      delivered?.target,
      before.value.snapshot.work.find((record) => record.id === FOREIGN_TARGET)
        ?.target,
    );
    assert.deepEqual(
      after.value.snapshot.reviews,
      before.value.snapshot.reviews,
    );
    assert.deepEqual(
      after.value.snapshot.reservations,
      before.value.snapshot.reservations,
    );
    assert.deepEqual(after.value.snapshot.releaseRequests, []);
    assert.deepEqual(
      after.value.snapshot.work.find((record) => record.id === unrelated.id),
      unrelated,
    );
    await run(rig);
    assert.equal(rig.writes, 2);
    assert.equal(rig.merges, 1);
    assert.deepEqual(rig.closed, [SHARED_ISSUE_NUMBER]);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("hosted autonomy: retirement continuation refuses unverified readback and foreign checks", async (t) => {
  for (
    const mode of [
      "unavailable-readback",
      "wrong-head",
      "wrong-snapshot",
      "unavailable-checks",
      "failed-checks",
      "stale-task",
      "adverse-review",
    ]
  ) {
    await t.step(mode, async () => {
      const { rig, foreign } = await retirementClosureRig(
        true,
        mode === "adverse-review"
          ? foreignReceipt({
            findings: [finding("P1")],
            unresolvedSeverities: ["P1"],
          })
          : foreignReceipt(),
      );
      try {
        const read = rig.state.readRepair.bind(rig.state);
        const before = await read();
        assert.ok(before.ok && before.value.status === "found");
        if (!before.ok || before.value.status !== "found") {
          throw new Error("unreadable");
        }
        const beforeSnapshot = before.value.snapshot;
        if (mode === "unavailable-checks") {
          foreign.hasAllChecksGreen = () =>
            Promise.reject(new Error("checks unavailable"));
        } else if (mode === "failed-checks") {
          foreign.hasAllChecksGreen = () => Promise.resolve(false);
        } else if (mode === "stale-task") {
          foreign.readIssueTask = async () => {
            const task = {
              issueNumber: SHARED_ISSUE_NUMBER,
              title: FOREIGN_TASK_TITLE,
              body: FOREIGN_TASK_BODY + " changed",
            };
            return { ...task, digest: await reviewTaskStatementDigest(task) };
          };
        } else if (mode !== "adverse-review") {
          rig.state.readRepair = async () => {
            const actual = await read();
            if (
              rig.writes !== 1 || !actual.ok || actual.value.status !== "found"
            ) {
              return actual;
            }
            if (mode === "unavailable-readback") {
              return portError(
                "unavailable",
                "retirement readback unavailable",
              );
            }
            return {
              ...actual,
              value: {
                ...actual.value,
                ...(mode === "wrong-head"
                  ? { head: BASE }
                  : { snapshot: beforeSnapshot }),
              },
            };
          };
        }
        const result = await run(rig);
        assert.equal(
          result.reason,
          [
              "unavailable-checks",
              "failed-checks",
              "stale-task",
              "adverse-review",
            ].includes(mode)
            ? "retired_records"
            : "readback_unverified",
        );
        assert.equal(rig.writes, 1);
        assert.equal(rig.merges, 0);
        assert.deepEqual(rig.closed, []);
        const after = await read();
        assert.ok(after.ok && after.value.status === "found");
        if (!after.ok || after.value.status !== "found") {
          throw new Error("unreadable");
        }
        assert.equal(
          after.value.snapshot.work.find((record) =>
            record.id === FOREIGN_TARGET
          )?.nextStep,
          "delivery",
        );
        assert.deepEqual(
          after.value.snapshot.reviews,
          before.value.snapshot.reviews,
        );
        assert.deepEqual(
          after.value.snapshot.reservations,
          before.value.snapshot.reservations,
        );
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

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
    const released = new Map([
      [hostedDeliveryKey(SELF_REPO, 51, HEAD, BASE), accepted],
    ]);
    const plans = planHostedClosures(
      snapshot,
      released,
      new Map(),
      closureTasks(snapshot.work),
    );
    assert.deepEqual(plans, [
      { id: TARGET, issueNumber: 48, repository: SELF_REPO },
    ]);
    const next = applyHostedClosures(snapshot, SHA1, plans, T0 + 5000);
    assert.equal(next.work[0].nextStep, "done");
    assert.equal(next.work[0].blocker, null);
    assert.equal(next.work[0].intent, null);
    assert.equal(next.sequence, snapshot.sequence + 1);
    // An accepted release that delivered another head closes nothing.
    assert.deepEqual(
      planHostedClosures(
        snapshot,
        new Map([[hostedDeliveryKey(SELF_REPO, 51, SHA1, BASE), accepted]]),
        new Map(),
        closureTasks(snapshot.work),
      ),
      [],
    );
    // A legacy quality-only receipt never closes a delivered issue, and
    // neither does an unreadable trusted task context.
    const legacy = repairSnapshot(
      [blockedRecord()],
      [authorizingReceipt({ taskAcceptance: null })],
      [request],
    );
    assert.deepEqual(
      planHostedClosures(
        legacy,
        released,
        new Map(),
        closureTasks(legacy.work),
      ),
      [],
    );
    assert.deepEqual(
      planHostedClosures(legacy, released, new Map(), new Map()),
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

Deno.test(
  "hosted autonomy: a parked reviewed head whose review budget is spent is still delivered",
  async () => {
    // The runtime advances to a correction round for ANY unresolved finding,
    // so a P2-only verdict parks a record in `work`/`blocked`. Once every
    // review round is spent that correction can never become a verdict, and
    // the receipt in hand is the only honest basis for delivery.
    const record = blockedRecord({
      blocker: {
        kind: "review_quota",
        message: "implementation attempt budget exhausted",
        since: T0 + 3000,
      },
      counters: { attempts: 4, retries: 1, reviewRounds: 3 },
      target: {
        base: BASE,
        branch: "sentinel/repair/issue-ubiquity-sentinel-48",
        checkpoint: null,
        head: HEAD,
        pr: 51,
      },
    });
    const receipt = authorizingReceipt({
      findings: [finding("P2")],
      unresolvedSeverities: ["P2"],
    });
    const { rig, github } = await makeRig("autonomy-parked-delivery", {
      repair: repairSnapshot([record], [receipt]),
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
  "hosted autonomy: a parked head with a review round left is never delivered early",
  async () => {
    const record = deliveryRecord({
      nextStep: "work",
      blocker: null,
      counters: { attempts: 2, retries: 1, reviewRounds: 1 },
      target: {
        base: BASE,
        branch: "sentinel/repair/issue-ubiquity-sentinel-48",
        checkpoint: null,
        head: HEAD,
        pr: 51,
      },
    });
    const { rig, github } = await makeRig("autonomy-parked-early", {
      repair: repairSnapshot([record], [authorizingReceipt()]),
      pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
      afterMerge: pullFacts(),
    });
    const result = await run(rig, github);
    assert.equal(rig.merges, 0);
    assert.equal(rig.writes, 0);
    assert.notEqual(result.status, "applied");
    assert.equal((await readRequests(rig)).length, 0);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: an attempt-ceiling grant never re-plans a charged retry identity",
  () => {
    // The loop admits corrections with purpose `retry` and identity
    // (task, base, attempt, purpose); attempt 4 at this base is already
    // settled, so a grant of 1 would be refused as a duplicate admission.
    const record = blockedRecord({
      blocker: {
        kind: "review_quota",
        message: "implementation attempt budget exhausted",
        since: T0 + 3000,
      },
      counters: { attempts: 4, retries: 1, reviewRounds: 1 },
    });
    const charged = reservation("charged-retry", {
      taskId: TARGET,
      head: BASE,
      attempt: 4,
      purpose: "retry",
      outcome: "submitted",
      settledAt: T0 + 1000,
    });
    const plans = planHostedRetries(
      repairSnapshot([record], [authorizingReceipt()], [], [charged]),
      T0 + 5000,
    );
    assert.equal(plans.length, 1);
    const remaining = 4 - plans[0].grant;
    assert.equal(remaining, 2);
    assert.notEqual(remaining + 1, 4);
  },
);

Deno.test(
  "hosted autonomy: no attempt-ceiling grant is spent once the review budget is spent",
  () => {
    const record = blockedRecord({
      blocker: {
        kind: "review_quota",
        message: "implementation attempt budget exhausted",
        since: T0 + 3000,
      },
      counters: { attempts: 4, retries: 1, reviewRounds: 3 },
    });
    const snapshot = repairSnapshot([record], [authorizingReceipt()]);
    // Every review round is spent, so another implementation run can never
    // become a reviewed verdict: the grant is provably futile.
    assert.equal(planHostedRetries(snapshot, T0 + 5000).length, 0);
    // With a review round left the same blocker is still retryable.
    const earlier = repairSnapshot(
      [blockedRecord({
        blocker: {
          kind: "review_quota",
          message: "implementation attempt budget exhausted",
          since: T0 + 3000,
        },
        counters: { attempts: 4, retries: 1, reviewRounds: 2 },
      })],
      [authorizingReceipt()],
    );
    assert.equal(planHostedRetries(earlier, T0 + 5000).length, 1);
  },
);

Deno.test(
  "hosted autonomy: a transient blocker at the attempt ceiling advances the base, never a zero grant",
  () => {
    const record = blockedRecord({
      counters: { attempts: 4, retries: 0, reviewRounds: 1 },
      target: {
        base: BASE,
        branch: "sentinel/repair/issue-ubiquity-sentinel-48",
        checkpoint: null,
        head: HEAD,
        pr: 51,
      },
    });
    const snapshot = repairSnapshot(
      [record],
      [authorizingReceipt()],
      [],
      chargedAttempts(),
    );
    const newerBase = SHA1;
    const plans = planHostedRetries(snapshot, T0 + 5000, selfTips(newerBase));
    assert.equal(plans.length, 1);
    // A grant of 0 would leave attempts at 4, exactly where the runtime refuses
    // admission: the grant must land below the ceiling through the runtime's
    // own base refresh instead of re-blocking the record unchanged.
    assert.equal(plans[0].grant, 1);
    assert.equal(plans[0].advanceBase, true);
    assert.equal(plans[0].nextStep, "work");
    const applied = applyHostedRetries(snapshot, SHA1, plans, T0 + 5000)
      .work[0];
    assert.equal(applied.counters.attempts, 3);
    assert.equal(applied.counters.retries, 0);
    assert.ok(
      applied.intent !== null && applied.intent.kind === "base_refresh",
    );
  },
);

Deno.test(
  "hosted autonomy: a work-returning grant is never planned once the review budget is spent",
  () => {
    const target = {
      base: BASE,
      branch: "sentinel/repair/issue-ubiquity-sentinel-48",
      checkpoint: null,
      head: HEAD,
      pr: 51,
    };
    // The transient (non-budget) work rule is retryable while a review round is
    // left, even at the attempt ceiling with every identity charged...
    const earlier = repairSnapshot(
      [blockedRecord({
        counters: { attempts: 4, retries: 0, reviewRounds: 2 },
        target,
      })],
      [authorizingReceipt()],
      [],
      chargedAttempts(),
    );
    assert.equal(
      planHostedRetries(earlier, T0 + 5000, selfTips(SHA1)).length,
      1,
    );
    // ...but once every review round is spent another implementation run can
    // never become a reviewed verdict: no grant, base advance included.
    const spent = repairSnapshot(
      [blockedRecord({
        counters: { attempts: 4, retries: 0, reviewRounds: 3 },
        target,
      })],
      [authorizingReceipt()],
      [],
      chargedAttempts(),
    );
    assert.equal(planHostedRetries(spent, T0 + 5000, selfTips(SHA1)).length, 0);
    assert.equal(planHostedRetries(spent, T0 + 5000, selfTips(BASE)).length, 0);
  },
);

Deno.test(
  "hosted autonomy: a reserved retry identity is occupied while a reserved review request stays reconcilable",
  () => {
    const record = blockedRecord({
      counters: { attempts: 3, retries: 0, reviewRounds: 1 },
    });
    const reservedRetry = reservation("reserved-retry", {
      taskId: TARGET,
      head: BASE,
      attempt: 4,
      purpose: "retry",
      outcome: "reserved",
    });
    const snapshot = repairSnapshot(
      [record],
      [authorizingReceipt()],
      [],
      [reservedRetry],
    );
    const plans = planHostedRetries(snapshot, T0 + 5000);
    assert.equal(plans.length, 1);
    // Identity 4 is already reserved and the runtime refuses that duplicate
    // instead of starting a second session, so the grant must step to identity
    // 3 rather than re-plan 4 forever.
    assert.equal(plans[0].grant, 1);
    const applied = applyHostedRetries(snapshot, SHA1, plans, T0 + 5000)
      .work[0];
    assert.equal(applied.counters.attempts, 2);
    assert.equal(applied.counters.attempts + 1, 3);
    assert.ok(
      !snapshot.reservations.some((entry) =>
        entry.taskId === TARGET && entry.head === BASE &&
        entry.attempt === 3 && entry.purpose === "retry"
      ),
    );

    // Review rounds are spent and the only review admission at this head is
    // still `reserved`: the in-flight identity and its charge stay protected,
    // and only the runtime's own base refresh may continue the record.
    const reviewRecord = blockedRecord({
      blocker: {
        kind: "review_quota",
        message: "review rounds exhausted without an accepted verdict",
        since: T0 + 3000,
      },
      counters: { attempts: 1, retries: 0, reviewRounds: 3 },
    });
    const reservedReview = reservation("reserved-review", {
      taskId: TARGET,
      head: BASE,
      attempt: 2,
      purpose: "review_request",
      outcome: "reserved",
    });
    const reviewSnapshot = repairSnapshot(
      [reviewRecord],
      [authorizingReceipt()],
      [],
      [reservedReview],
    );
    assert.equal(planHostedRetries(reviewSnapshot, T0 + 5000).length, 0);
    const reviewPlans = planHostedRetries(
      reviewSnapshot,
      T0 + 5000,
      selfTips(SHA1),
    );
    assert.equal(reviewPlans.length, 1);
    assert.equal(reviewPlans[0].nextStep, "review");
    assert.equal(reviewPlans[0].advanceBase, true);
    assert.equal(reviewPlans[0].reviewRounds, 3);
    assert.equal(reviewPlans[0].grant, 0);
    const reviewNext = applyHostedRetries(
      reviewSnapshot,
      SHA1,
      reviewPlans,
      T0 + 5000,
    ).work[0];
    assert.equal(reviewNext.counters.reviewRounds, 3);
    assert.equal(reviewNext.counters.attempts, 1);
    assert.equal(reviewNext.counters.retries, 0);
  },
);

Deno.test(
  "hosted autonomy: a foreign record is routed to its own repository surface",
  async () => {
    // The runner resolves the record's OWN identity: the sentinel scope is
    // never even resolved for a foreign record.
    const resolved: string[] = [];
    const { rig, github } = await makeRig("autonomy-foreign-routing", {
      repair: repairSnapshot([foreignRecord()], [foreignReceipt()]),
      pull: foreignPullFacts({
        state: "open",
        merged: false,
        mergeCommitSha: null,
      }),
      afterMerge: foreignPullFacts(),
      resolver: (repository) => {
        resolved.push(hostedRepositoryKey(repository));
        return github;
      },
    });
    const result = await run(rig);
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.equal(rig.merges, 1);
    assert.ok(resolved.length > 0);
    assert.deepEqual([...new Set(resolved)], [
      hostedRepositoryKey(FOREIGN_REPO),
    ]);
    assert.ok(!resolved.includes(hostedRepositoryKey(SELF_REPO)));
    await Deno.remove(rig.tmp, { recursive: true });

    // The real factory builds EVERY REST path for the identity it was given.
    // A sentinel path is not served at all here, so any sentinel read would
    // make this case fail instead of silently succeeding.
    const requests: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (!isForeignPath(url)) {
        return Promise.resolve(new Response("{}", { status: 404 }));
      }
      const payload = url.includes("/pulls/")
        ? {
          state: "open",
          merged: false,
          merge_commit_sha: null,
          head: { sha: HEAD },
          base: { ref: FOREIGN_BRANCH },
          user: { login: "github-actions[bot]" },
          number: FOREIGN_PR,
        }
        : url.includes("/check-runs")
        ? checkRunPage([
          checkRun("validate"),
          checkRun("verify-artifact"),
        ], 2)
        : url.includes("/git/ref/")
        ? { object: { sha: BASE } }
        : url.includes("/issues/")
        ? { state: "open" }
        : { default_branch: FOREIGN_BRANCH };
      return Promise.resolve(jsonResponse(payload));
    }) as typeof fetch;
    try {
      const surface = createHostedAutonomyGitHub("fixture-token", FOREIGN_REPO);
      assert.equal(await surface.readDefaultBranch(), FOREIGN_BRANCH);
      assert.equal(await surface.readBaseTip(FOREIGN_BRANCH), BASE);
      assert.equal(await surface.hasAllChecksGreen(HEAD), true);
      assert.equal(await surface.readIssueOpen(SHARED_ISSUE_NUMBER), true);
      const pull = await surface.readPull(FOREIGN_PR, FOREIGN_BRANCH);
      assert.equal(pull?.number, FOREIGN_PR);
      assert.equal(pull?.baseRef, FOREIGN_BRANCH);
      assert.ok(requests.length >= 5);
      assert.ok(requests.every(isForeignPath));
      assert.ok(!requests.some(isSelfPath));
    } finally {
      globalThis.fetch = original;
    }
  },
);

Deno.test(
  "hosted autonomy: a green foreign head merges and closes its own issue without a release",
  async () => {
    const requests: { method: string; url: string }[] = [];
    const original = globalThis.fetch;
    let mergedNow = false;
    globalThis.fetch = ((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ method, url });
      if (!isForeignPath(url)) {
        return Promise.resolve(new Response("{}", { status: 404 }));
      }
      if (method === "PUT" && url.endsWith(`/pulls/${FOREIGN_PR}/merge`)) {
        mergedNow = true;
        return Promise.resolve(jsonResponse({ merged: true, sha: MERGE }));
      }
      if (
        method === "PATCH" && url.endsWith(`/issues/${SHARED_ISSUE_NUMBER}`)
      ) {
        return Promise.resolve(
          jsonResponse({ state: "closed", number: SHARED_ISSUE_NUMBER }),
        );
      }
      if (url.includes(`/pulls/${FOREIGN_PR}`)) {
        return Promise.resolve(jsonResponse(
          mergedNow
            ? {
              state: "closed",
              merged: true,
              merge_commit_sha: MERGE,
              head: { sha: HEAD },
              base: { ref: FOREIGN_BRANCH },
              user: { login: "ubiquity-sentinel[bot]" },
              number: FOREIGN_PR,
            }
            : {
              state: "open",
              merged: false,
              merge_commit_sha: null,
              head: { sha: HEAD },
              base: { ref: FOREIGN_BRANCH },
              user: { login: "ubiquity-sentinel[bot]" },
              number: FOREIGN_PR,
            },
        ));
      }
      const payload = url.includes("/check-runs")
        ? checkRunPage([
          checkRun("validate"),
          checkRun("verify-artifact"),
        ], 2)
        : url.includes("/commits/")
        ? { parents: [{ sha: BASE }, { sha: HEAD }] }
        : url.includes("/compare/")
        ? {
          status: "ahead",
          base_commit: { sha: MERGE },
          merge_base_commit: { sha: MERGE },
        }
        : url.includes("/git/ref/")
        ? { object: { sha: BASE } }
        : url.includes("/actions/runs")
        ? { workflow_runs: [] }
        : url.includes("/issues/")
        ? {
          state: "open",
          number: SHARED_ISSUE_NUMBER,
          title: FOREIGN_TASK_TITLE,
          body: FOREIGN_TASK_BODY,
        }
        : { default_branch: FOREIGN_BRANCH };
      return Promise.resolve(jsonResponse(payload));
    }) as typeof fetch;
    try {
      const { rig } = await makeRig("autonomy-foreign-green", {
        repair: repairSnapshot([foreignRecord()], [foreignReceipt()]),
        resolver: (repository) =>
          createHostedAutonomyGitHub("fixture-token", repository),
      });
      const result = await run(rig);
      assert.equal(result.status, "applied", JSON.stringify(result));
      assert.equal(result.reason, "closed_issues");
      assert.equal(rig.writes, 1);
      assert.deepEqual([...result.revisions], [MERGE]);
      assert.ok(
        result.actions.includes(`delivery:${FOREIGN_TARGET}:foreign_merged`),
      );
      assert.ok(result.actions.includes(`close:${FOREIGN_TARGET}:issue=120`));
      // Both the merge and the closure went to the record's OWN repository.
      assert.ok(requests.some((entry) =>
        entry.method === "PUT" &&
        entry.url.endsWith(
          `/repos/ubiquity/ai.ubq.fi/pulls/${FOREIGN_PR}/merge`,
        )
      ));
      assert.ok(requests.some((entry) =>
        entry.method === "PATCH" &&
        entry.url.endsWith(`/repos/ubiquity/ai.ubq.fi/issues/120`)
      ));
      assert.ok(!requests.some((entry) => isSelfPath(entry.url)));
      // No release request is ever fabricated for a foreign repository.
      assert.deepEqual(await readRequests(rig), []);
      const read = await rig.state.readRepair();
      if (!read.ok || read.value.status !== "found") {
        throw new Error("unreadable");
      }
      const record = read.value.snapshot.work[0];
      assert.equal(record.nextStep, "done");
      assert.equal(record.blocker, null);
      await Deno.remove(rig.tmp, { recursive: true });
    } finally {
      globalThis.fetch = original;
    }
  },
);

Deno.test(
  "hosted autonomy: a foreign head is green only when every check-run on it succeeded",
  async () => {
    const gate = async (checkRuns: unknown[]): Promise<boolean> => {
      const original = globalThis.fetch;
      globalThis.fetch = (() =>
        Promise.resolve(
          jsonResponse(checkRunPage(checkRuns, checkRuns.length)),
        )) as typeof fetch;
      try {
        return await createHostedAutonomyGitHub("fixture-token", FOREIGN_REPO)
          .hasAllChecksGreen(HEAD);
      } finally {
        globalThis.fetch = original;
      }
    };
    // Zero check-runs is not green: a foreign repository has no other
    // deterministic signal, so an unverified head is never delivered.
    assert.equal(await gate([]), false);
    assert.equal(
      await gate([checkRun("validate", {
        status: "in_progress",
        conclusion: null,
      })]),
      false,
    );
    assert.equal(
      await gate([
        checkRun("validate", { status: "queued", conclusion: null }),
      ]),
      false,
    );
    assert.equal(
      await gate([
        checkRun("validate"),
        checkRun("verify-artifact", { conclusion: "failure" }),
      ]),
      false,
    );
    // A run reported on a different head is not a run on this one.
    assert.equal(await gate([checkRun("validate", { head_sha: SHA1 })]), false);
    // The foreign repository's own names are the gate: both green delivers.
    assert.equal(
      await gate([checkRun("validate"), checkRun("verify-artifact")]),
      true,
    );

    // The pass itself refuses a red or pending foreign head.
    const { rig } = await makeRig("autonomy-foreign-red", {
      repair: repairSnapshot([foreignRecord()], [foreignReceipt()]),
      pull: foreignPullFacts({
        state: "open",
        merged: false,
        mergeCommitSha: null,
      }),
      foreignCheckGreen: false,
    });
    const result = await run(rig);
    assert.equal(result.reason, "checks_pending");
    assert.equal(rig.merges, 0);
    assert.equal(rig.writes, 0);
    assert.equal(rig.closed.length, 0);
    assert.ok(
      result.actions.some((action) => action.endsWith("checks_pending")),
    );
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: issue 120 in two repositories never collides",
  async () => {
    const selfRecord120 = deliveryRecord({
      id: "issue-ubiquity-sentinel-120" as WorkItemId,
      source: {
        kind: "issue",
        id: String(SHARED_ISSUE_NUMBER),
        revision: SHA1,
      },
      related: { incidentId: null, issueNumber: SHARED_ISSUE_NUMBER },
      nextStep: "work",
      target: {
        base: BASE,
        branch: "sentinel/repair/issue-ubiquity-sentinel-120",
        checkpoint: null,
        head: null,
        pr: null,
      },
    });
    const foreignRecord120 = foreignRecord({
      nextStep: "work",
      target: {
        base: BASE,
        branch: `sentinel/repair/${FOREIGN_TARGET}`,
        checkpoint: null,
        head: null,
        pr: null,
      },
    });
    const snapshot = repairSnapshot(
      [selfRecord120, foreignRecord120],
      [authorizingReceipt(), foreignReceipt()],
    );
    // Only the FOREIGN issue 120 is closed: sentinel's own 120 is untouched.
    assert.deepEqual(
      planHostedRetirements(
        snapshot,
        new Set([hostedIssueKey(FOREIGN_REPO, SHARED_ISSUE_NUMBER)]),
      ),
      [{
        id: FOREIGN_TARGET,
        issueNumber: SHARED_ISSUE_NUMBER,
        repository: FOREIGN_REPO,
      }],
    );
    // ...and the reverse: the foreign record survives sentinel's closure.
    assert.deepEqual(
      planHostedRetirements(
        snapshot,
        new Set([hostedIssueKey(SELF_REPO, SHARED_ISSUE_NUMBER)]),
      ),
      [{
        id: "issue-ubiquity-sentinel-120",
        issueNumber: SHARED_ISSUE_NUMBER,
        repository: SELF_REPO,
      }],
    );

    // Closure evidence is scoped the same way: an accepted self release and a
    // foreign merge are each only valid for their OWN repository's record.
    const closable = repairSnapshot(
      [
        deliveryRecord({
          id: "issue-ubiquity-sentinel-120" as WorkItemId,
          source: {
            kind: "issue",
            id: String(SHARED_ISSUE_NUMBER),
            revision: SHA1,
          },
          related: { incidentId: null, issueNumber: SHARED_ISSUE_NUMBER },
          target: {
            base: BASE,
            branch: "sentinel/repair/issue-ubiquity-sentinel-120",
            checkpoint: null,
            head: HEAD,
            pr: 51,
          },
        }),
        foreignRecord(),
      ],
      [
        // Sentinel's own issue 120 accepts ITS OWN task text, not the foreign
        // repository's identically numbered issue.
        authorizingReceipt({
          taskAcceptance: {
            issueNumber: SHARED_ISSUE_NUMBER,
            taskDigest: SELF_TASK_120.digest,
            verdict: "fulfilled",
            evidence: ["sentinel issue 120 is satisfied"],
          },
        }),
        foreignReceipt(),
      ],
    );
    const released = new Map([
      [hostedDeliveryKey(SELF_REPO, 51, HEAD, BASE), {}],
    ]);
    const foreignMerged = new Map([
      [hostedDeliveryKey(FOREIGN_REPO, FOREIGN_PR, HEAD, BASE), {}],
    ]);
    assert.deepEqual(
      planHostedClosures(
        closable,
        released,
        new Map(),
        closureTasks(closable.work),
      ),
      [{
        id: "issue-ubiquity-sentinel-120",
        issueNumber: SHARED_ISSUE_NUMBER,
        repository: SELF_REPO,
      }],
    );
    assert.deepEqual(
      planHostedClosures(
        closable,
        new Map(),
        foreignMerged,
        closureTasks(closable.work),
      ),
      [{
        id: FOREIGN_TARGET,
        issueNumber: SHARED_ISSUE_NUMBER,
        repository: FOREIGN_REPO,
      }],
    );

    // Runner level: closing the foreign issue 120 must not touch sentinel's
    // record for its own issue 120, and vice versa.
    const selfClosedIssues: number[] = [];
    const foreignClosedIssues: number[] = [];
    const { rig, github } = await makeRig("autonomy-issue-collision", {
      repair: repairSnapshot(
        [
          deliveryRecord({
            id: "issue-ubiquity-sentinel-120" as WorkItemId,
            source: {
              kind: "issue",
              id: String(SHARED_ISSUE_NUMBER),
              revision: SHA1,
            },
            related: { incidentId: null, issueNumber: SHARED_ISSUE_NUMBER },
            target: {
              base: BASE,
              branch: "sentinel/repair/issue-ubiquity-sentinel-120",
              checkpoint: null,
              head: HEAD,
              pr: 51,
            },
          }),
          foreignRecord(),
        ],
        // The self record carries no authorizing receipt at all; only the
        // foreign record has the evidence its own repository can supply.
        [foreignReceipt()],
      ),
      pull: foreignPullFacts(),
    });
    rig.githubFor = (repository) =>
      isSelfRepository(repository)
        ? {
          ...github,
          readPull: (number: number) =>
            Promise.resolve(number === 51 ? pullFacts() : null),
          closeIssue: (number: number) => {
            selfClosedIssues.push(number);
            return Promise.resolve(true);
          },
        }
        : {
          ...github,
          readDefaultBranch: () => Promise.resolve(FOREIGN_BRANCH),
          readPull: (number: number) =>
            Promise.resolve(number === FOREIGN_PR ? foreignPullFacts() : null),
          closeIssue: (number: number) => {
            foreignClosedIssues.push(number);
            return Promise.resolve(true);
          },
        };
    const result = await run(rig);
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.equal(result.reason, "closed_issues");
    assert.deepEqual(foreignClosedIssues, [SHARED_ISSUE_NUMBER]);
    assert.deepEqual(selfClosedIssues, []);
    const read = await rig.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("unreadable");
    }
    const foreign = read.value.snapshot.work.find((record) =>
      record.id === FOREIGN_TARGET
    );
    const self = read.value.snapshot.work.find((record) =>
      record.id === "issue-ubiquity-sentinel-120"
    );
    assert.equal(foreign?.nextStep, "done");
    assert.equal(self?.nextStep, "delivery");
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: the check gate reads every page and refuses an incomplete, drifted, duplicated or malformed listing",
  async () => {
    const withFetch = async (
      handler: (url: string) => unknown,
      check: () => Promise<boolean>,
    ): Promise<boolean> => {
      const original = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request) =>
        Promise.resolve(
          jsonResponse(handler(String(input))),
        )) as typeof fetch;
      try {
        return await check();
      } finally {
        globalThis.fetch = original;
      }
    };
    const self = () => createHostedAutonomyGitHub("fixture-token", SELF_REPO);
    const foreign = () =>
      createHostedAutonomyGitHub("fixture-token", FOREIGN_REPO);
    const pageOf = (offset: number) =>
      Array.from(
        { length: 100 },
        (_, index) => checkRun(`run-${offset + index}`),
      );
    const pageNumber = (url: string) =>
      Number(new URL(url).searchParams.get("page"));

    // The named self check is on the SECOND page: only a complete listing finds
    // it, and the read must actually ask for that page.
    const requested: number[] = [];
    const selfFound = await withFetch((url) => {
      const page = pageNumber(url);
      requested.push(page);
      return page === 1
        ? checkRunPage(pageOf(0), 101)
        : checkRunPage([checkRun("test-local")], 101);
    }, () => self().hasSuccessfulCheck(HEAD));
    assert.equal(selfFound, true);
    assert.deepEqual(requested, [1, 2]);

    // A later-page failure makes the whole foreign head not green even when the
    // first page is entirely green.
    assert.equal(
      await withFetch(
        (url) =>
          pageNumber(url) === 1 ? checkRunPage(pageOf(0), 101) : checkRunPage(
            [checkRun("verify-artifact", { conclusion: "failure" })],
            101,
          ),
        () => foreign().hasAllChecksGreen(HEAD),
      ),
      false,
    );
    // Count drift between pages is an unproven listing, never green.
    assert.equal(
      await withFetch(
        (url) =>
          pageNumber(url) === 1
            ? checkRunPage(pageOf(0), 101)
            : checkRunPage([checkRun("validate")], 102),
        () => foreign().hasAllChecksGreen(HEAD),
      ),
      false,
    );
    // A duplicated run id across pages is an unproven listing, never green.
    const duplicate = checkRun("validate");
    assert.equal(
      await withFetch(
        (url) =>
          pageNumber(url) === 1
            ? checkRunPage([...pageOf(0).slice(0, 99), duplicate], 101)
            : checkRunPage([duplicate], 101),
        () => foreign().hasAllChecksGreen(HEAD),
      ),
      false,
    );
    // A listing that promises more runs than it ever returns is incomplete.
    assert.equal(
      await withFetch(
        (url) => checkRunPage(pageNumber(url) === 1 ? pageOf(0) : [], 150),
        () => foreign().hasAllChecksGreen(HEAD),
      ),
      false,
    );
    // A run without a usable id is malformed: the listing is not evidence.
    assert.equal(
      await withFetch(() =>
        checkRunPage([{
          name: "validate",
          head_sha: HEAD,
          status: "completed",
          conclusion: "success",
        }], 1), () => foreign().hasAllChecksGreen(HEAD)),
      false,
    );
    // A missing page count cannot prove completeness: never green.
    assert.equal(
      await withFetch(
        () => ({ check_runs: [checkRun("validate")] }),
        () => foreign().hasAllChecksGreen(HEAD),
      ),
      false,
    );
  },
);

Deno.test(
  "hosted autonomy: a parked approval run on a later page is still listed",
  async () => {
    const runs = (offset: number) =>
      Array.from({ length: 50 }, (_, index) => ({
        id: 10_000 + offset + index,
        head_sha: HEAD,
        conclusion: "success",
      }));
    const parked = {
      id: 20_001,
      head_sha: HEAD,
      conclusion: "action_required",
    };
    const pages: number[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      pages.push(page);
      return Promise.resolve(jsonResponse({
        total_count: 51,
        workflow_runs: page === 1 ? runs(0) : [parked],
      }));
    }) as typeof fetch;
    try {
      const listed = await createHostedAutonomyGitHub(
        "fixture-token",
        SELF_REPO,
      ).listParkedRuns(HEAD);
      assert.deepEqual(listed, [parked.id]);
      assert.deepEqual(pages, [1, 2]);
    } finally {
      globalThis.fetch = original;
    }
  },
);

Deno.test(
  "hosted autonomy: a later-page failed check-run prevents the merge",
  async () => {
    const runs = (offset: number) =>
      Array.from(
        { length: 100 },
        (_, index) => checkRun(`validate-${offset + index}`),
      );
    const pages: number[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input);
      if (!isForeignPath(url)) {
        return Promise.resolve(new Response("{}", { status: 404 }));
      }
      if (url.includes("/check-runs")) {
        const page = Number(new URL(url).searchParams.get("page"));
        pages.push(page);
        return Promise.resolve(jsonResponse(
          page === 1 ? checkRunPage(runs(0), 101) : checkRunPage(
            [checkRun("verify-artifact", { conclusion: "failure" })],
            101,
          ),
        ));
      }
      if (url.includes("/actions/runs")) {
        return Promise.resolve(jsonResponse({
          total_count: 0,
          workflow_runs: [],
        }));
      }
      const payload = url.includes(`/pulls/${FOREIGN_PR}`)
        ? {
          state: "open",
          merged: false,
          merge_commit_sha: null,
          head: { sha: HEAD },
          base: { ref: FOREIGN_BRANCH },
          user: { login: "github-actions[bot]" },
          number: FOREIGN_PR,
        }
        : url.includes("/git/ref/")
        ? { object: { sha: BASE } }
        : url.includes("/issues/")
        ? {
          state: "open",
          number: SHARED_ISSUE_NUMBER,
          title: FOREIGN_TASK_TITLE,
          body: FOREIGN_TASK_BODY,
        }
        : { default_branch: FOREIGN_BRANCH };
      return Promise.resolve(jsonResponse(payload));
    }) as typeof fetch;
    try {
      const { rig } = await makeRig("autonomy-foreign-paged", {
        repair: repairSnapshot([foreignRecord()], [foreignReceipt()]),
        resolver: (repository) =>
          createHostedAutonomyGitHub("fixture-token", repository),
      });
      const result = await run(rig);
      assert.equal(result.reason, "checks_pending", JSON.stringify(result));
      assert.equal(rig.merges, 0);
      assert.deepEqual(pages, [1, 2]);
      await Deno.remove(rig.tmp, { recursive: true });
    } finally {
      globalThis.fetch = original;
    }
  },
);

Deno.test(
  "hosted autonomy: the self target still requires its named check and an accepted release",
  async () => {
    // The self deterministic gate is the named `test-local` check-run: a head
    // that only carries other green checks is not green, and every read stays
    // on the sentinel scope.
    const requests: string[] = [];
    const gate = async (checkRuns: unknown[]): Promise<boolean> => {
      const original = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request) => {
        const url = String(input);
        requests.push(url);
        if (!isSelfPath(url)) {
          return Promise.resolve(new Response("{}", { status: 404 }));
        }
        return Promise.resolve(
          jsonResponse(checkRunPage(checkRuns, checkRuns.length)),
        );
      }) as typeof fetch;
      try {
        return await createHostedAutonomyGitHub("fixture-token", SELF_REPO)
          .hasSuccessfulCheck(HEAD);
      } finally {
        globalThis.fetch = original;
      }
    };
    assert.equal(
      await gate([checkRun("validate"), checkRun("verify-artifact")]),
      false,
    );
    assert.equal(await gate([checkRun("test-local")]), true);
    assert.equal(
      await gate([checkRun("test-local", {
        status: "in_progress",
        conclusion: null,
      })]),
      false,
    );
    assert.equal(
      await gate([checkRun("test-local", { conclusion: "failure" })]),
      false,
    );
    assert.ok(requests.length >= 4);
    assert.ok(requests.every(isSelfPath));

    // A self head with a red deterministic check is never merged.
    const red = await makeRig("autonomy-self-red", {
      repair: repairSnapshot([deliveryRecord()], [authorizingReceipt()]),
      pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
      checkGreen: false,
    });
    const redResult = await run(red.rig, red.github);
    assert.equal(red.rig.merges, 0);
    assert.equal(redResult.reason, "checks_pending");

    // A merged self head with a completed receipt but NO accepted hosted
    // release still writes the exact release request and closes nothing: the
    // trusted release path stays the only closure authority for self.
    const merged = await makeRig("autonomy-self-release-gate", {
      repair: repairSnapshot([deliveryRecord()], [authorizingReceipt()]),
      pull: pullFacts(),
    });
    const mergedResult = await run(merged.rig, merged.github);
    assert.equal(mergedResult.reason, "applied");
    assert.equal((await readRequests(merged.rig)).length, 1);
    assert.equal(merged.rig.closed.length, 0);
    const read = await merged.rig.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("unreadable");
    }
    assert.equal(read.value.snapshot.work[0].nextStep, "delivery");

    await Promise.all(
      [red, merged].map((entry) =>
        Deno.remove(entry.rig.tmp, { recursive: true })
      ),
    );
  },
);

/** Read the current repair snapshot from the real store. */
async function readWork(rig: RigV1): Promise<WorkRecordV1[]> {
  const read = await rig.state.readRepair();
  if (!read.ok || read.value.status !== "found") {
    throw new Error("unreadable repair state");
  }
  return read.value.snapshot.work;
}

/** A self-consistent trusted statement with edited text. */
async function driftedSelfTask(body: string): Promise<ReviewTaskStatementV1> {
  return {
    issueNumber: SELF_TASK.issueNumber,
    title: SELF_TASK_TITLE,
    body,
    digest: await reviewTaskStatementDigest({
      issueNumber: SELF_TASK.issueNumber,
      title: SELF_TASK_TITLE,
      body,
    }),
  };
}

Deno.test(
  "hosted autonomy: a legacy quality-only receipt never merges or records a release",
  async () => {
    const { rig, github } = await makeRig("autonomy-legacy", {
      repair: repairSnapshot([deliveryRecord()], [
        authorizingReceipt({ taskAcceptance: null }),
      ]),
    });
    const result = await run(rig, github);
    assert.equal(rig.merges, 0);
    assert.equal(result.status, "skipped");
    assert.ok(
      result.actions.includes(`delivery:${TARGET}:task_acceptance_refused`),
      JSON.stringify(result.actions),
    );
    assert.equal((await readRequests(rig)).length, 0);
    assert.deepEqual(rig.closed, []);
    assert.equal((await readWork(rig))[0].nextStep, "delivery");
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a receipt bound to a different task digest never merges",
  async () => {
    const { rig, github } = await makeRig("autonomy-digest", {
      repair: repairSnapshot([deliveryRecord()], [
        authorizingReceipt({
          taskAcceptance: {
            issueNumber: SELF_TASK.issueNumber,
            taskDigest: "e".repeat(64),
            verdict: "fulfilled",
            evidence: ["stale task digest"],
          },
        }),
      ]),
    });
    const result = await run(rig, github);
    assert.equal(rig.merges, 0);
    assert.equal(result.status, "skipped");
    assert.ok(
      result.actions.includes(`delivery:${TARGET}:task_acceptance_refused`),
      JSON.stringify(result.actions),
    );
    assert.equal((await readRequests(rig)).length, 0);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a fulfilled verdict for a different issue never merges",
  async () => {
    const { rig, github } = await makeRig("autonomy-issue", {
      repair: repairSnapshot([deliveryRecord()], [
        authorizingReceipt({
          taskAcceptance: {
            issueNumber: SELF_TASK.issueNumber + 1,
            taskDigest: SELF_TASK.digest,
            verdict: "fulfilled",
            evidence: ["another issue"],
          },
        }),
      ]),
    });
    const result = await run(rig, github);
    assert.equal(rig.merges, 0);
    assert.equal(result.status, "skipped");
    assert.ok(
      result.actions.includes(`delivery:${TARGET}:task_acceptance_refused`),
      JSON.stringify(result.actions),
    );
    assert.equal((await readRequests(rig)).length, 0);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: an already-satisfied base is an honest non-delivery",
  async () => {
    const { rig, github } = await makeRig("autonomy-satisfied", {
      repair: repairSnapshot([deliveryRecord()], [
        authorizingReceipt({
          taskAcceptance: {
            issueNumber: SELF_TASK.issueNumber,
            taskDigest: SELF_TASK.digest,
            verdict: "already_satisfied_at_base",
            evidence: ["the recorded base already satisfies the issue"],
          },
        }),
      ]),
    });
    const result = await run(rig, github);
    assert.equal(rig.merges, 0);
    assert.equal(result.status, "skipped");
    assert.ok(
      result.actions.includes(`delivery:${TARGET}:task_acceptance_refused`),
      JSON.stringify(result.actions),
    );
    assert.equal((await readRequests(rig)).length, 0);
    assert.deepEqual(rig.closed, []);
    assert.equal((await readWork(rig))[0].nextStep, "delivery");
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: issue text that drifted before the merge blocks the final action",
  async () => {
    // The first trusted read binds the reviewed text and passes; the live issue
    // moves while the remaining gates are read. The fresh read taken
    // immediately before the merge sees a different task, so the candidate
    // that already passed every other gate is still never merged.
    const drifted = await driftedSelfTask(`${SELF_TASK_BODY} (edited)`);
    let reads = 0;
    const { rig, github } = await makeRig("autonomy-merge-drift", {
      repair: repairSnapshot([deliveryRecord()], [authorizingReceipt()]),
      pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
      afterMerge: pullFacts(),
      issueTask: () => {
        reads++;
        return Promise.resolve(reads === 1 ? SELF_TASK : drifted);
      },
    });
    const result = await run(rig, github);
    assert.ok(reads >= 2, `expected a pre-merge read, got ${reads}`);
    assert.equal(rig.merges, 0);
    assert.equal(result.status, "skipped");
    assert.ok(
      result.actions.includes(`delivery:${TARGET}:task_acceptance_refused`),
      JSON.stringify(result.actions),
    );
    assert.equal((await readRequests(rig)).length, 0);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: issue text that drifted before the closure leaves the issue open",
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
    const drifted = await driftedSelfTask(`${SELF_TASK_BODY} (edited)`);
    const { rig, github } = await makeRig("autonomy-close-drift", {
      repair: repairSnapshot(
        [deliveryRecord()],
        [authorizingReceipt()],
        [request],
      ),
      // The accepted release is produced by the REAL supervisor core over the
      // rig's own release store: the store only ever sees a legal lifecycle.
      hostedReceipt: { request, priorRevision: BASE },
      issueTask: () => Promise.resolve(drifted),
    });
    const result = await run(rig, github);
    assert.deepEqual(rig.closed, []);
    assert.equal(result.status, "skipped");
    assert.equal((await readWork(rig))[0].nextStep, "delivery");
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a legacy quality-only receipt closes nothing even after an accepted release",
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
    const { rig, github } = await makeRig("autonomy-close-legacy", {
      repair: repairSnapshot(
        [deliveryRecord()],
        [authorizingReceipt({ taskAcceptance: null })],
        [request],
      ),
      // The accepted release is produced by the REAL supervisor core over the
      // rig's own release store: the store only ever sees a legal lifecycle.
      hostedReceipt: { request, priorRevision: BASE },
      issueTask: () => Promise.resolve(null),
    });
    const result = await run(rig, github);
    assert.deepEqual(rig.closed, []);
    assert.equal(result.status, "skipped");
    assert.equal((await readWork(rig))[0].nextStep, "delivery");
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a self-consistent alternate reviewer identity never merges",
  async () => {
    const { rig, github } = await makeRig("autonomy-reviewer", {
      repair: repairSnapshot([deliveryRecord()], [
        authorizingReceipt({
          expectedReviewer: "alternate-reviewer[bot]",
          observedReviewer: "alternate-reviewer[bot]",
        }),
      ]),
    });
    const result = await run(rig, github);
    assert.equal(rig.merges, 0);
    assert.equal(result.status, "skipped");
    assert.ok(
      result.actions.includes(`delivery:${TARGET}:task_acceptance_refused`),
      JSON.stringify(result.actions),
    );
    assert.equal((await readRequests(rig)).length, 0);
    assert.deepEqual(rig.closed, []);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a later closure re-reads the issue text changed by the earlier close",
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
    const { rig, github } = await makeRig("autonomy-close-refresh", {
      repair: repairSnapshot(
        [deliveryRecord(), foreignRecord()],
        [authorizingReceipt(), foreignReceipt()],
        [request],
      ),
      // The accepted release is produced by the REAL supervisor core over the
      // rig's own release store: the store only ever sees a legal lifecycle.
      hostedReceipt: { request, priorRevision: BASE },
      pull: foreignPullFacts(),
    });
    // The server-side issue text the surfaces serve. The state layer orders
    // work records by id, so the foreign issue (120) is closed before the
    // self issue (48): the first closure mutates the LATER self issue's text,
    // which the bulk read taken for the plan still holds.
    const drifted = await driftedSelfTask(
      `${SELF_TASK_BODY} (edited by the earlier closure)`,
    );
    const states = new Map<number, ReviewTaskStatementV1 | null>([
      [SELF_TASK.issueNumber, SELF_TASK],
      [FOREIGN_TASK.issueNumber, FOREIGN_TASK],
    ]);
    const selfClosed: number[] = [];
    const foreignClosed: number[] = [];
    rig.githubFor = (repository) =>
      isSelfRepository(repository)
        ? {
          ...github,
          readIssueTask: (number: number) =>
            Promise.resolve(states.get(number) ?? null),
          closeIssue: (number: number) => {
            selfClosed.push(number);
            return Promise.resolve(true);
          },
        }
        : {
          ...github,
          readDefaultBranch: () => Promise.resolve(FOREIGN_BRANCH),
          readIssueTask: (number: number) =>
            Promise.resolve(states.get(number) ?? null),
          readPull: (number: number) =>
            Promise.resolve(number === FOREIGN_PR ? foreignPullFacts() : null),
          closeIssue: (number: number) => {
            foreignClosed.push(number);
            // Closing the first (foreign) issue changes the LATER (self)
            // issue's text: the bulk read taken for the plan is now stale for
            // that issue, whose fresh pre-closure read must therefore refuse.
            states.set(SELF_TASK.issueNumber, drifted);
            return Promise.resolve(true);
          },
        };
    const result = await run(rig);
    assert.equal(result.status, "applied", JSON.stringify(result));
    // The first (foreign) closure happened; the later self closure re-read the
    // changed text and refused, so the self issue stays open and the foreign
    // issue is legitimately done.
    assert.deepEqual(foreignClosed, [FOREIGN_TASK.issueNumber]);
    assert.deepEqual(selfClosed, []);
    assert.deepEqual(
      result.actions.filter((action) => action.startsWith("close:")),
      [
        `close:${FOREIGN_TARGET}:issue=${FOREIGN_TASK.issueNumber}`,
        `close:${TARGET}:issue=${SELF_TASK.issueNumber}:refused`,
      ],
    );
    const work = await readWork(rig);
    assert.equal(
      work.find((record) => record.id === FOREIGN_TARGET)?.nextStep,
      "done",
    );
    assert.equal(
      work.find((record) => record.id === TARGET)?.nextStep,
      "delivery",
    );
    await Deno.remove(rig.tmp, { recursive: true });
  },
);
