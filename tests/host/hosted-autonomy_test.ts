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
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  matrixCellIdV1,
  type MatrixCellResultV1,
  matrixDigestV1,
  type MatrixPlanV1,
} from "../../src/contracts/matrix.ts";
import {
  createActionsMatrixArtifactHttpTransport,
  createActionsMatrixArtifactTransport,
} from "../../src/host/matrix-artifacts.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { HostedRepairCooldownGate } from "../../src/host/hosted-cooldown.ts";
import {
  HISTORICAL_MATRIX_QUARANTINE,
  type HistoricalMatrixQuarantineDepsV1,
  runActionsMatrixAggregateCycles,
  runHistoricalMatrixQuarantine,
} from "../../src/host/matrix-actions.ts";
import {
  runHostedSupervisorFinalize,
  runHostedSupervisorPrepare,
} from "../../src/host/actions-supervisor.ts";
import {
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
} from "../repair/helpers.ts";
import { repositoryConfig } from "../budget/helpers.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import type { HostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import { parseHostedExecutionSettlementV1 } from "../../src/contracts/hosted-supervisor.ts";

import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import type {
  RepairStateWriter,
  StateReadView,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
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
  candidatePreservationRef,
  implementationIntentKey,
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
  createHostedHistoricalMatrixQuarantine,
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
  runHostedAutonomyMain,
} from "../../ops/hosted-autonomy.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedAutonomyPullV1,
  HostedAutonomyResultV1,
} from "../../ops/hosted-autonomy.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import {
  gitRun,
  makeRemoteCtx,
  reservation,
  reviewReceipt,
  SHA1,
  T0,
  workRecord,
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
    /** Scoped archive fixtures use the repository's existing CI read scope. */
    fixtureDir?: string;
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
  const tmp = await Deno.makeTempDir({
    prefix: `sentinel-${prefix}-`,
    dir: options.fixtureDir,
  });
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
      readReleaseAt: (input: { commit: GitSha; expectedHead: GitSha }) =>
        release.readReleaseAt!(input),
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

Deno.test("hosted autonomy: a damaged foreign merged PR is recovered only for verified closure", async () => {
  const original = foreignRecord();
  const receipt = foreignReceipt();
  const record = foreignRecord({
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: "pull request was merged outside the trusted review path",
      since: T0 + 4000,
    },
    target: {
      ...original.target,
      pr: null,
      candidateState: {
        preserved: {
          ref: await candidatePreservationRef(
            original.repository,
            original.id,
            `base_refresh:${FOREIGN_PR}:${HEAD}:${BASE}`,
          ),
          head: HEAD,
          base: BASE,
          operationKey: `base_refresh:${FOREIGN_PR}:${HEAD}:${BASE}`,
        },
        publishedHead: HEAD,
      },
    },
    evidence: [{
      kind: "review_receipt",
      ref: `artifact:review-receipt/${receipt.id}`,
    }],
  });
  const charge = reservation("retained-foreign-charge", {
    taskId: record.id,
    outcome: "submitted",
    settledAt: T0 + 3000,
  });
  const { rig, github } = await makeRig("foreign-damaged-pr", {
    repair: repairSnapshot([record], [receipt], [], [charge]),
    pull: {
      ...foreignPullFacts({ author: "ubiquity-sentinel[bot]" }),
      mergedBy: "ubiquity-sentinel[bot]",
    } as HostedAutonomyPullV1,
  });
  try {
    const result = await run(rig, github);
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.deepEqual(rig.closed, [FOREIGN_TASK.issueNumber]);
    assert.equal(rig.merges, 0);
    assert.equal(rig.writes, 1, "recovery and closure share the existing CAS");
    const read = await rig.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (!read.ok || read.value.status !== "found") {
      throw new Error("no repair state");
    }
    const state = read.value.snapshot;
    assert.equal(state.work[0].nextStep, "done");
    assert.deepEqual(state.work[0].target, {
      ...record.target,
      pr: FOREIGN_PR,
    });
    assert.deepEqual(state.work[0].source, record.source);
    assert.deepEqual(state.work[0].counters, record.counters);
    assert.deepEqual(state.work[0].evidence, record.evidence);
    assert.deepEqual(state.reviews, [receipt]);
    assert.deepEqual(state.reservations, [charge]);
    assert.deepEqual(state.releaseRequests, []);
    const again = await run(rig, github);
    assert.equal(again.status, "skipped");
    assert.equal(rig.closed.length, 1);
    assert.equal(rig.writes, 1);
    for (
      const control of [
        "missing-receipt",
        "ambiguous-pr",
        "wrong-scope",
        "wrong-review-head",
        "wrong-review-base",
        "wrong-task",
        "wrong-reviewer",
        "quality-only",
        "p1",
        "missing-merger",
        "alternate-merger",
        "alternate-author",
        "wrong-pr",
        "wrong-pull-head",
        "wrong-parents",
        "not-integrated",
        "unmerged",
        "wrong-branch",
        "red-checks",
        "unavailable-checks",
        "task-drift",
        "unavailable-task",
        "unsettled-intent",
        "missing-preservation",
        "unpublished-head",
        "wrong-preserved-ref",
        "unrelated-blocker",
        "self-scope",
      ]
    ) {
      let damaged = record;
      let reviews = [receipt];
      const pull: HostedAutonomyPullV1 = {
        ...foreignPullFacts({ author: "ubiquity-sentinel[bot]" }),
        mergedBy: "ubiquity-sentinel[bot]",
      };
      const reviewOverrides: Record<string, unknown> = {};
      if (control === "missing-receipt") reviews = [];
      if (control === "ambiguous-pr") {
        const other = foreignReceipt({
          id: `review-receipt:${"c".repeat(64)}`,
          pullRequest: { ...receipt.pullRequest, number: FOREIGN_PR + 1 },
        });
        reviews.push(other);
        damaged = foreignRecord({
          ...record,
          evidence: [...record.evidence, {
            kind: "review_receipt",
            ref: `artifact:review-receipt/${other.id}`,
          }],
        });
      }
      if (control === "wrong-scope") {
        reviewOverrides.repository = { ...FOREIGN_REPO, installationId: 8 };
      }
      if (control === "wrong-review-head") {
        reviewOverrides.pullRequest = { ...receipt.pullRequest, head: SHA1 };
      }
      if (control === "wrong-review-base") {
        reviewOverrides.pullRequest = { ...receipt.pullRequest, base: SHA1 };
      }
      if (control === "wrong-task") {
        reviewOverrides.taskAcceptance = {
          ...receipt.taskAcceptance!,
          issueNumber: 121,
        };
      }
      if (control === "wrong-reviewer") {
        reviewOverrides.expectedReviewer = "github-actions[bot]";
        reviewOverrides.observedReviewer = "github-actions[bot]";
      }
      if (control === "quality-only") reviewOverrides.taskAcceptance = null;
      if (control === "p1") {
        reviewOverrides.findings = [finding("P1")];
        reviewOverrides.unresolvedSeverities = ["P1"];
      }
      if (Object.keys(reviewOverrides).length > 0) {
        reviews = [foreignReceipt(reviewOverrides)];
      }
      if (control === "missing-merger") delete pull.mergedBy;
      if (control === "alternate-merger") pull.mergedBy = "0x4007";
      if (control === "alternate-author") pull.author = "github-actions[bot]";
      if (control === "wrong-pr") pull.number++;
      if (control === "wrong-pull-head") pull.headSha = SHA1;
      if (control === "wrong-parents") pull.parents = [BASE, SHA1];
      if (control === "not-integrated") pull.revisionOnBaseBranch = false;
      if (control === "unmerged") {
        pull.merged = false;
        pull.mergeCommitSha = null;
      }
      if (control === "wrong-branch") pull.baseRef = "other";
      if (control === "unsettled-intent") {
        damaged = foreignRecord({
          ...record,
          intent: {
            kind: "implementation",
            key: "implementation:unsettled",
            startedAt: T0,
            branch: record.target.branch,
            expectedHead: HEAD,
            observedBase: BASE,
            pr: null,
            requestId: "unknown-reservation",
            resultId: null,
          },
        });
      }
      if (control === "missing-preservation") {
        damaged = foreignRecord({
          ...record,
          target: {
            ...record.target,
            candidateState: { preserved: null, publishedHead: HEAD },
          },
        });
      }
      if (control === "unpublished-head") {
        damaged = foreignRecord({
          ...record,
          target: {
            ...record.target,
            candidateState: {
              ...record.target.candidateState!,
              publishedHead: null,
            },
          },
        });
      }
      if (control === "wrong-preserved-ref") {
        damaged = foreignRecord({
          ...record,
          target: {
            ...record.target,
            candidateState: {
              ...record.target.candidateState!,
              preserved: {
                ...record.target.candidateState!.preserved!,
                ref: `refs/heads/sentinel-candidates/${"f".repeat(64)}`,
              },
            },
          },
        });
      }
      if (control === "unrelated-blocker") {
        damaged = foreignRecord({
          ...record,
          blocker: {
            kind: "other",
            message: "unrelated terminal blocker",
            since: T0,
          },
        });
      }
      if (control === "self-scope") {
        damaged = foreignRecord({
          ...record,
          repository: SELF_REPO,
          target: {
            ...record.target,
            candidateState: {
              ...record.target.candidateState!,
              preserved: {
                ...record.target.candidateState!.preserved!,
                ref: await candidatePreservationRef(
                  SELF_REPO,
                  record.id,
                  record.target.candidateState!.preserved!.operationKey,
                ),
              },
            },
          },
        });
        reviews = [foreignReceipt({ repository: SELF_REPO })];
      }
      const negative = await makeRig(`foreign-damaged-${control}`, {
        repair: repairSnapshot([damaged], reviews, [], [charge]),
        pull,
        foreignCheckGreen: control !== "red-checks",
        issueTask: control === "unavailable-task"
          ? () => Promise.resolve(null)
          : control === "task-drift"
          ? () =>
            Promise.resolve({
              ...FOREIGN_TASK,
              digest: "d".repeat(64) as never,
            })
          : undefined,
      });
      const reads: number[] = [];
      const readPull = negative.github.readPull;
      negative.github.readPull = (number, branch) => {
        reads.push(number);
        return number === FOREIGN_PR
          ? readPull(number, branch)
          : Promise.resolve(null);
      };
      if (control === "unavailable-checks") {
        negative.github.hasAllChecksGreen = () =>
          Promise.reject(new Error("unavailable checks"));
      }
      try {
        const before = await negative.rig.state.readRepair();
        await run(negative.rig, negative.github);
        assert.deepEqual(negative.rig.closed, [], control);
        assert.equal(negative.rig.merges, 0, control);
        assert.equal(negative.rig.writes, 0, control);
        assert.deepEqual(
          await negative.rig.state.readRepair(),
          before,
          control,
        );
        assert.ok(reads.every((number) => number === FOREIGN_PR), control);
      } finally {
        await Deno.remove(negative.rig.tmp, { recursive: true });
      }
    }
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

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
      merged_by: { login: "ubiquity-sentinel[bot]" },
    });
    assert.equal(merged?.merged, true);
    assert.equal(merged?.mergeCommitSha, MERGE);
    assert.equal(merged?.headSha, HEAD);
    assert.equal(merged?.baseRef, "development");
    assert.equal(merged?.mergedBy, "ubiquity-sentinel[bot]");
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

/** Sanitized advancing admissions, immutable native archives and actual protected maintenance. */
async function historicalMalformedRig(
  includeSibling = true,
  historicalCount = 17,
) {
  const launcher = "1".repeat(40) as GitSha;
  const revision = "2".repeat(40) as GitSha;
  const run = { runId: 71, runAttempt: 2, launcherSha: launcher };
  const execution = {
    id: "71:2:repair",
    ...run,
    purpose: "ordinary" as const,
    revision,
    generation: 1,
    releaseId: null,
    createdAt: T0,
  };
  const clock = { now: () => T0 + 60_000 };
  const records = Array.from({
    length: historicalCount + (includeSibling ? 1 : 0),
  }, (_, i) => {
    const id = `historical-${i}` as WorkItemId;
    const requestId = (i + 1).toString(16).padStart(64, "0");
    return workRecord(id, {
      repository: SELF_REPO,
      related: { incidentId: null, issueNumber: i + 1 },
      counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      target: {
        base: BASE,
        head: null,
        pr: null,
        branch: candidateBranch(id),
        checkpoint: null,
      },
      intent: {
        kind: "implementation",
        key: implementationIntentKey(requestId),
        startedAt: T0 + i + 1,
        branch: candidateBranch(id),
        expectedHead: null,
        observedBase: BASE,
        pr: null,
        requestId,
        resultId: null,
      },
      updatedAt: T0 + i + 1,
    });
  });
  const charges = records.map((record, i) =>
    reservation(record.intent!.requestId!, {
      repository: SELF_REPO,
      taskId: record.id,
      head: BASE,
      attempt: 1,
      createdAt: T0 + i + 1,
    })
  );
  const release = releaseSnapshot();
  release.hostedRuntimes = [{
    version: "v1",
    kind: "hosted_runtime",
    id: "ubiquity/sentinel:0:production",
    activeRevision: revision,
    generation: 1,
    lastHealthyProof: null,
    lastExecutionProof: null,
    nextOrdinaryAt: T0,
    execution,
    createdAt: T0,
    updatedAt: T0,
  }];
  const { rig, github } = await makeRig("historical-malformed", {
    fixtureDir: decodeURIComponent(new URL("../../", import.meta.url).pathname),
    repair: repairSnapshot(records, [], [], charges),
    release,
    pull: null,
    issueOpen: null,
    baseTip: BASE,
  });
  const checkout = `${rig.tmp}/checkout`;
  const cloned = await gitRun(rig.tmp, [
    "clone",
    "-q",
    "--branch",
    "sentinel-state/repair",
    `${rig.tmp}/remote.git`,
    checkout,
  ], ENV);
  assert(cloned.ok, cloned.stderr);
  const artifacts: Record<string, unknown>[] = [];
  const archives = new Map<number, Uint8Array>();
  const logs = new Map<number, string>();
  const iso = (at: number) => new Date(at).toISOString();
  async function archived(id: number, name: string, value: unknown) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {
      useWebWorkers: false,
    });
    await writer.add(
      name.startsWith("sentinel-matrix-plan") ? "plan.json" : "result.json",
      new Uint8ArrayReader(new TextEncoder().encode(canonicalStringify(value))),
      { unixMode: 0o100600 },
    );
    const bytes = await writer.close();
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())),
    )
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    archives.set(id, bytes);
    artifacts.push({
      id,
      name,
      size_in_bytes: bytes.length,
      expired: false,
      digest: `sha256:${digest}`,
      workflow_run: {
        id: run.runId,
        repository_id: 123,
        head_repository_id: 123,
        head_branch: "sentinel-supervisor",
        head_sha: launcher,
      },
    });
  }
  const cells = await Promise.all(
    records.slice(0, historicalCount).map(async (record) => {
      const request = {
        taskId: record.id,
        repository: SELF_REPO,
        base: BASE,
        issue: {
          number: record.related.issueNumber!,
          title: "sanitized",
          body: "sanitized",
        },
        evidence: [],
        model: "gpt-reserve",
        reasoning: "max" as const,
        maxDurationMs: 10_000,
        maxOutputChars: 10_000,
      };
      return {
        cellId: await matrixCellIdV1(
          execution.id,
          record.id,
          record.intent!.requestId!,
        ),
        taskId: record.id,
        repository: SELF_REPO,
        reservationId: record.intent!.requestId!,
        intentKey: record.intent!.key,
        expectedBase: BASE,
        runtimeSha: revision,
        generation: 1,
        requestDigest: await matrixDigestV1(request),
        request,
      };
    }),
  );
  const plan: MatrixPlanV1 = {
    version: "v1",
    kind: "matrix_plan",
    waveId: execution.id,
    run,
    plannedAt: T0,
    cells,
  };
  const job = (id: number, name: string, step: string, failed = false) => ({
    id,
    name,
    run_id: run.runId,
    run_attempt: run.runAttempt,
    head_sha: launcher,
    status: "completed",
    conclusion: failed ? "failure" : "success",
    started_at: iso(T0),
    completed_at: iso(T0 + 30_000),
    steps: [{
      name: step,
      number: 1,
      status: "completed",
      conclusion: failed ? "failure" : "success",
      started_at: iso(T0),
      completed_at: iso(T0 + 30_000),
    }],
  });
  const jobs = [
    job(401, "matrix_plan", "Plan isolated issue matrix"),
    job(499, "repair", "Run selected Sentinel runtime", true),
  ];
  logs.set(499, `${iso(T0 + 30_000)} child exited before terminal\n`);
  async function refreshPlan() {
    artifacts.splice(0, artifacts.length);
    await archived(501, "sentinel-matrix-plan-71-2", plan);
    logs.set(
      401,
      `${iso(T0 + 25_000)} ${
        JSON.stringify({
          kind: "sentinel_matrix_plan",
          waveId: execution.id,
          run,
          runtimeSha: revision,
          generation: 1,
          planDigest: await matrixDigestV1(plan),
          prepared: cells.length,
        })
      }\n`,
    );
    for (const [i, cell] of cells.entries()) {
      const result: MatrixCellResultV1 = {
        version: "v1",
        kind: "matrix_cell_result",
        waveId: execution.id,
        run,
        runtimeSha: revision,
        generation: 1,
        cellId: cell.cellId,
        taskId: cell.taskId,
        repository: SELF_REPO,
        reservationId: cell.reservationId,
        intentKey: cell.intentKey,
        requestDigest: cell.requestDigest,
        status: "not_started",
        receipt: null,
        bundle: null,
        detail: "sanitized no start",
        completedAt: T0 + 29_000,
      };
      await archived(
        502 + i,
        `sentinel-matrix-cell-71-2-${cell.cellId}`,
        result,
      );
      logs.set(
        402 + i,
        `${iso(T0 + 29_000)} ${
          JSON.stringify({
            kind: "sentinel_matrix_cell",
            run,
            runtimeSha: revision,
            generation: 1,
            cellId: cell.cellId,
            reservationId: cell.reservationId,
            resultDigest: await matrixDigestV1(result),
            bundleDigest: null,
            status: "not_started",
          })
        }\n`,
      );
    }
  }
  jobs.push(
    ...cells.map((cell, i) =>
      job(402 + i, `matrix_cell (${cell.cellId})`, "Run isolated issue cell")
    ),
  );
  await refreshPlan();
  let fault: "auth" | "outage" | "missing" | "pending" | null = null;
  const calls: { url: string; authorization: string | undefined }[] = [];
  const http = createActionsMatrixArtifactHttpTransport((url, init) => {
    calls.push({ url, authorization: init?.headers?.authorization });
    const parsed = new URL(url);
    if (fault === "outage") {
      return Promise.resolve(new Response("", { status: 503 }));
    }
    const reply = (value: unknown) =>
      Promise.resolve(new Response(JSON.stringify(value)));
    if (parsed.hostname.endsWith("blob.core.windows.net")) {
      assert.equal(init?.headers?.authorization, undefined);
      assert.equal(init?.redirect, "error");
      const id = Number(parsed.pathname.split("/").at(-1));
      return Promise.resolve(
        new Response(
          parsed.pathname.startsWith("/archive/")
            ? archives.get(id)!.slice()
            : logs.get(id)!,
        ),
      );
    }
    assert.equal(init?.headers?.authorization, "Bearer offline-native-token");
    assert(["manual", "error"].includes(init?.redirect ?? ""));
    if (parsed.pathname.endsWith("/attempts/2")) {
      return reply({
        id: run.runId,
        run_attempt: run.runAttempt,
        workflow_id: 357012162,
        path: ".github/workflows/supervisor.yml",
        event: "workflow_dispatch",
        head_branch: "sentinel-supervisor",
        head_sha: fault === "auth" ? BASE : launcher,
        repository: { id: 123, full_name: "ubiquity/sentinel" },
        head_repository: { id: 123, full_name: "ubiquity/sentinel" },
        status: "completed",
        conclusion: "failure",
        run_started_at: iso(T0),
        updated_at: iso(T0 + 30_000),
      });
    }
    if (parsed.pathname.endsWith("/jobs")) {
      return reply({
        total_count: jobs.length,
        jobs: fault === "pending"
          ? jobs.map((row) =>
            row.name === "repair"
              ? {
                ...row,
                status: "in_progress",
                conclusion: null,
                completed_at: null,
              }
              : row
          )
          : jobs,
      });
    }
    if (parsed.pathname.endsWith("/artifacts")) {
      return reply({
        total_count: fault === "missing" ? 0 : artifacts.length,
        artifacts: fault === "missing" ? [] : artifacts,
      });
    }
    const archive = parsed.pathname.match(/\/artifacts\/(\d+)\/zip$/);
    const log = parsed.pathname.match(/\/jobs\/(\d+)\/logs$/);
    if (archive || log) {
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: {
            location: `https://productionresultssa1.blob.core.windows.net/${
              archive ? "archive" : "log"
            }/${(archive ?? log)![1]}`,
          },
        }),
      );
    }
    throw new Error("unscripted offline route");
  });
  const client = new GitHubApiClient({
    repository: SELF_REPO,
    apiBaseUrl: "https://api.github.com",
    clock,
    http,
    auth: {
      authorizationHeader: () =>
        Promise.resolve(portOk("Bearer offline-native-token")),
    },
    cooldownGate: new HostedRepairCooldownGate({ state: rig.state, clock }),
  });
  const historicalMatrix = {
    state: rig.state,
    clock,
    budget: new RollingStartBudget({ state: rig.state, clock, configs: [] }),
    readExecution: (saved: typeof execution) =>
      client.readHostedExecution(saved),
    transport: createActionsMatrixArtifactTransport({
      state: rig.state,
      clock,
      token: "offline-native-token",
      artifactRoot: `${rig.tmp}/artifacts`,
      http,
    }),
  };
  const deps = {
    state: rig.state,
    githubFor: rig.githubFor,
    clock,
    historicalMatrix,
  };
  const checkoutHead = await gitRun(checkout, ["rev-parse", "HEAD"], ENV);
  assert(checkoutHead.ok);
  const mainEnv = {
    GITHUB_REPOSITORY: "ubiquity/sentinel",
    GITHUB_REF: "refs/heads/sentinel-supervisor",
    GITHUB_JOB: "maintenance",
    GITHUB_RUN_ID: "900",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF:
      "ubiquity/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor",
    GITHUB_SHA: checkoutHead.stdout.trim(),
    GITHUB_WORKFLOW_SHA: checkoutHead.stdout.trim(),
    GITHUB_TOKEN: "offline-native-token",
  };
  return {
    rig,
    github,
    clock,
    records,
    charges,
    historicalMatrix,
    plan,
    cells,
    refreshPlan,
    http,
    client,
    execution,
    nativeRun: run,
    artifacts,
    archives,
    logs,
    jobs,
    checkout,
    setFault: (next: typeof fault) => {
      fault = next;
    },
    calls,
    runMain: async () => {
      const prior = Deno.cwd();
      Deno.chdir(checkout);
      try {
        return await runHostedAutonomyMain({ env: mainEnv, deps });
      } finally {
        Deno.chdir(prior);
      }
    },
    run: async () => {
      const prior = Deno.cwd();
      Deno.chdir(checkout);
      try {
        return await runHostedAutonomy(deps);
      } finally {
        Deno.chdir(prior);
      }
    },
  };
}

Deno.test("historical malformed wave: protected maintenance quarantines seventeen charged intents", async () => {
  const f = await historicalMalformedRig();
  try {
    const before = await f.rig.state.readRepair();
    assert(before.ok && before.value.status === "found");
    const result = await f.run();
    assert(result.actions.includes("historical-matrix:quarantined:17"));
    const after = await f.rig.state.readRepair();
    assert(after.ok && after.value.status === "found");
    for (let i = 0; i < 17; i++) {
      const original = f.records[i];
      const work: WorkRecordV1 = after.value.snapshot.work.find((row) =>
        row.id === original.id
      )!;
      assert.equal(work.nextStep, "blocked");
      assert.equal(
        work.blocker?.message,
        "authenticated historical matrix manifest rejected: reservation_after_manifest; model outcome uncertain",
      );
      assert.deepEqual({
        ...work,
        nextStep: original.nextStep,
        blocker: original.blocker,
        wait: original.wait,
        updatedAt: original.updatedAt,
      }, original);
      const charge: ReturnType<typeof reservation> = after.value.snapshot
        .reservations.find((row) => row.id === f.charges[i].id)!;
      assert.equal(charge.outcome, "ambiguous");
      assert.equal(charge.proofRef, null);
      assert.deepEqual({
        ...charge,
        outcome: f.charges[i].outcome,
        settledAt: f.charges[i].settledAt,
      }, f.charges[i]);
    }
    assert.deepEqual(
      after.value.snapshot.work.find((row) => row.id === f.records[17].id),
      f.records[17],
    );
    assert.deepEqual(
      after.value.snapshot.reservations.find((row) =>
        row.id === f.charges[17].id
      ),
      f.charges[17],
    );
    assert.equal(f.rig.merges, 0);
    assert.deepEqual(f.rig.closed, []);
    assert.equal(f.plan.plannedAt, T0);
    assert(
      f.charges.slice(0, 17).every((row) => row.createdAt > f.plan.plannedAt),
    );
    const repeat = await f.run();
    assert(
      !repeat.actions.some((action) =>
        action.startsWith("historical-matrix:quarantined:")
      ),
    );
    const repeated = await f.rig.state.readRepair();
    assert(repeated.ok && repeated.value.status === "found");
    assert.deepEqual(repeated.value.snapshot.work, after.value.snapshot.work);
    assert.deepEqual(
      repeated.value.snapshot.reservations,
      after.value.snapshot.reservations,
    );
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("historical malformed wave: authentication outage and future manifest refuse quarantine", async () => {
  for (const fault of ["auth", "outage", "future", "pending"] as const) {
    const f = await historicalMalformedRig();
    try {
      if (fault === "future") {
        f.plan.plannedAt = f.clock.now() + 2_000;
        await f.refreshPlan();
      } else f.setFault(fault);
      const before = await f.rig.state.readRepair();
      await assert.rejects(f.run);
      if (fault === "pending") assert.equal(await f.runMain(), 1);
      const after = await f.rig.state.readRepair();
      assert.deepEqual(after, before);
      assert.equal(f.rig.merges, 0);
    } finally {
      await Deno.remove(f.rig.tmp, { recursive: true });
    }
  }
});

Deno.test("historical malformed wave: settlement CAS and drift preserve charged identity", async () => {
  for (const mode of ["settlement", "cas", "drift", "custody"] as const) {
    const f = await historicalMalformedRig();
    try {
      const write = f.rig.state.writeRepair.bind(f.rig.state);
      const settle = f.historicalMatrix.budget.settleModelStart.bind(
        f.historicalMatrix.budget,
      );
      if (mode === "settlement") {
        f.historicalMatrix.budget.settleModelStart = () =>
          Promise.resolve({
            status: "unavailable",
            detail: "injected offline refusal",
          });
      } else if (mode === "cas") {
        f.rig.state.writeRepair = (next, expected) =>
          next.work.some((row) => row.nextStep === "blocked")
            ? Promise.resolve(
              portOk({ status: "conflict", currentHead: expected }),
            )
            : write(next, expected);
      } else if (mode === "custody") {
        f.historicalMatrix.budget.settleModelStart = async (request) => {
          const result = await settle(request);
          f.rig.state.readRelease = () =>
            Promise.resolve(
              portError("unavailable", "injected saved proof loss"),
            );
          return result;
        };
      } else {
        f.historicalMatrix.budget.settleModelStart = async (request) => {
          const result = await settle(request);
          const read = await f.rig.state.readRepair();
          assert(read.ok && read.value.status === "found");
          const snapshot = read.value.snapshot;
          const changed = await write({
            ...snapshot,
            stateHead: read.value.head,
            sequence: snapshot.sequence + 1,
            updatedAt: f.clock.now(),
            work: snapshot.work.map((row) =>
              row.id === f.records[0].id
                ? {
                  ...row,
                  counters: {
                    ...row.counters,
                    retries: row.counters.retries + 1,
                  },
                  updatedAt: f.clock.now(),
                }
                : row
            ),
          }, read.value.head);
          assert(changed.ok && changed.value.status === "applied");
          return result;
        };
      }
      const before = await f.rig.state.readRepair();
      await assert.rejects(f.run);
      const after = await f.rig.state.readRepair();
      assert(after.ok && after.value.status === "found");
      assert(after.value.snapshot.work.every((row) => row.nextStep === "work"));
      if (mode === "settlement") assert.deepEqual(after, before);
      else {
        assert.equal(after.value.snapshot.reservations[0].outcome, "ambiguous");
        assert.equal(
          after.value.snapshot.work[0].counters.retries,
          mode === "drift" ? 1 : 0,
        );
        assert.deepEqual(
          after.value.snapshot.work[0].intent,
          f.records[0].intent,
        );
      }
      if (mode === "cas") {
        f.rig.state.writeRepair = write;
        const retry = await f.run();
        assert(retry.actions.includes("historical-matrix:quarantined:17"));
        const recovered = await f.rig.state.readRepair();
        assert(recovered.ok && recovered.value.status === "found");
        assert.equal(
          recovered.value.snapshot.reservations[0].settledAt,
          after.value.snapshot.reservations[0].settledAt,
        );
        assert.equal(
          recovered.value.snapshot.work.filter((row) =>
            row.nextStep === "blocked"
          ).length,
          17,
        );
      }
    } finally {
      await Deno.remove(f.rig.tmp, { recursive: true });
    }
  }
});

Deno.test("historical malformed wave: actual maintenance entrypoint blocks prepare on incomplete quarantine", async () => {
  const f = await historicalMalformedRig();
  try {
    f.setFault("auth");
    const before = await f.rig.state.readRepair();
    assert.equal(await f.runMain(), 1);
    assert.deepEqual(await f.rig.state.readRepair(), before);
    const workflow = await Deno.readTextFile(
      new URL("../../.github/workflows/supervisor.yml", import.meta.url),
    );
    assert.match(
      workflow,
      /prepare:\s*\n\s*needs: maintenance\s*\n\s*if: always\(\) && needs\.maintenance\.result == 'success'/,
    );
    assert.equal(
      isHardAutonomyFailure("historical_quarantine_incomplete"),
      true,
    );
    f.setFault(null);
    assert.equal(await f.runMain(), 0);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("historical malformed wave: missing archive and malformed parser never quarantine", async () => {
  for (
    const mode of [
      "missing",
      "parser",
      "missing-proof",
      "valid-applicable",
    ] as const
  ) {
    const f = await historicalMalformedRig();
    try {
      const before = await f.rig.state.readRepair();
      if (mode === "missing") {
        f.setFault("missing");
        assert.equal(await f.runMain(), 1);
        await assert.rejects(f.run);
      } else if (mode === "missing-proof") {
        f.historicalMatrix.state = {
          ...f.rig.state,
          readRelease: async () => {
            const read = await f.rig.state.readRelease();
            if (!read.ok || read.value.status !== "found") return read;
            return portOk({
              ...read.value,
              snapshot: { ...read.value.snapshot, hostedRuntimes: [] },
            });
          },
        };
        assert.equal(await f.runMain(), 1);
        await assert.rejects(f.run);
        assert.equal(f.calls.length, 0);
      } else if (mode === "valid-applicable") {
        f.plan.plannedAt = T0 + 1000;
        await f.refreshPlan();
        assert.equal(await f.runMain(), 1);
        await assert.rejects(f.run);
      } else {
        Object.assign(f.plan, { kind: "invalid_fixture_kind" });
        await f.refreshPlan();
        await assert.rejects(f.run);
      }
      assert.deepEqual(await f.rig.state.readRepair(), before);
      const workflow = await Deno.readTextFile(
        new URL("../../.github/workflows/supervisor.yml", import.meta.url),
      );
      assert.match(
        workflow,
        /prepare:\s*\n\s*needs: maintenance\s*\n\s*if: always\(\) && needs\.maintenance\.result == 'success'/,
      );
    } finally {
      await Deno.remove(f.rig.tmp, { recursive: true });
    }
  }
});

Deno.test("historical malformed wave: successor bootstrap overwrites proof and aggregate excludes old rows", async () => {
  const f = await historicalMalformedRig();
  try {
    await f.run();
    const quarantined = await f.rig.state.readRepair();
    assert(quarantined.ok && quarantined.value.status === "found");
    const release = createReleaseStateStore({
      scratchDir: `${f.rig.tmp}/successor-release`,
      remoteUrl: `${f.rig.tmp}/remote.git`,
    });
    const evidence = {
      readExecution: f.client.readHostedExecution.bind(f.client),
      verifyRevision: () => Promise.resolve(portOk(true)),
      verifyRequest: () => Promise.resolve(portOk(false)),
    };
    const settled = await runHostedSupervisorFinalize({
      state: release,
      clock: f.clock,
      run: f.nativeRun,
      evidence,
    });
    assert.equal(settled.status, "idle");
    const successorRun = {
      runId: 72,
      runAttempt: 1,
      launcherSha: "3".repeat(40) as GitSha,
    };
    const prepared = await runHostedSupervisorPrepare({
      state: release,
      clock: f.clock,
      run: successorRun,
      evidence,
    });
    assert(prepared.status === "run", JSON.stringify(prepared));
    assert.equal(prepared.execution.purpose, "bootstrap");
    assert.notEqual(prepared.execution.launcherSha, f.execution.launcherSha);
    await assert.rejects(f.run);
    const sibling = f.records[17];
    const request = {
      taskId: sibling.id,
      repository: sibling.repository,
      base: BASE,
      issue: { number: 18, title: "sanitized", body: "sanitized" },
      evidence: [],
      model: "gpt-reserve",
      reasoning: "max" as const,
      maxDurationMs: 10_000,
      maxOutputChars: 10_000,
    };
    const cell = {
      cellId: await matrixCellIdV1(
        prepared.execution.id,
        sibling.id,
        sibling.intent!.requestId!,
      ),
      taskId: sibling.id,
      repository: sibling.repository,
      reservationId: sibling.intent!.requestId!,
      intentKey: sibling.intent!.key,
      expectedBase: BASE,
      runtimeSha: prepared.execution.revision,
      generation: prepared.execution.generation,
      requestDigest: await matrixDigestV1(request),
      request,
    };
    const plan: MatrixPlanV1 = {
      version: "v1",
      kind: "matrix_plan",
      waveId: prepared.execution.id,
      run: successorRun,
      plannedAt: f.clock.now(),
      cells: [cell],
    };
    const result: MatrixCellResultV1 = {
      version: "v1",
      kind: "matrix_cell_result",
      waveId: plan.waveId,
      run: successorRun,
      runtimeSha: cell.runtimeSha,
      generation: cell.generation,
      cellId: cell.cellId,
      taskId: cell.taskId,
      repository: cell.repository,
      reservationId: cell.reservationId,
      intentKey: cell.intentKey,
      requestDigest: cell.requestDigest,
      status: "not_started",
      receipt: null,
      bundle: null,
      detail: "deterministic bootstrap",
      completedAt: f.clock.now(),
    };
    const archives = new Map<number, Uint8Array>();
    const rows: Record<string, unknown>[] = [];
    for (
      const [id, name, filename, value] of [
        [1501, "sentinel-matrix-plan-72-1", "plan.json", plan],
        [
          1502,
          `sentinel-matrix-cell-72-1-${cell.cellId}`,
          "result.json",
          result,
        ],
      ] as const
    ) {
      const writer = new ZipWriter(new Uint8ArrayWriter(), {
        useWebWorkers: false,
      });
      await writer.add(
        filename,
        new Uint8ArrayReader(
          new TextEncoder().encode(canonicalStringify(value)),
        ),
        { unixMode: 0o100600 },
      );
      const bytes = await writer.close();
      archives.set(id, bytes);
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())),
      )
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
      rows.push({
        id,
        name,
        expired: false,
        size_in_bytes: bytes.length,
        digest: `sha256:${hash}`,
        workflow_run: {
          id: 72,
          repository_id: 123,
          head_repository_id: 123,
          head_branch: "sentinel-supervisor",
          head_sha: successorRun.launcherSha,
        },
      });
    }
    const iso = new Date(f.clock.now()).toISOString();
    const job = (id: number, name: string, step: string) => ({
      id,
      name,
      run_id: 72,
      run_attempt: 1,
      head_sha: successorRun.launcherSha,
      status: "completed",
      conclusion: "success",
      started_at: iso,
      completed_at: iso,
      steps: [{
        name: step,
        number: 1,
        status: "completed",
        conclusion: "success",
        started_at: iso,
        completed_at: iso,
      }],
    });
    const jobs = [
      job(1401, "matrix_plan", "Plan isolated issue matrix"),
      job(1402, `matrix_cell (${cell.cellId})`, "Run isolated issue cell"),
      job(1499, "repair", "Run selected Sentinel runtime"),
    ];
    const logs = new Map([
      [
        1401,
        `${iso} ${
          JSON.stringify({
            kind: "sentinel_matrix_plan",
            waveId: plan.waveId,
            run: successorRun,
            runtimeSha: cell.runtimeSha,
            generation: cell.generation,
            planDigest: await matrixDigestV1(plan),
            prepared: 1,
          })
        }\n`,
      ],
      [
        1402,
        `${iso} ${
          JSON.stringify({
            kind: "sentinel_matrix_cell",
            run: successorRun,
            runtimeSha: cell.runtimeSha,
            generation: cell.generation,
            cellId: cell.cellId,
            reservationId: cell.reservationId,
            resultDigest: await matrixDigestV1(result),
            bundleDigest: null,
            status: "not_started",
          })
        }\n`,
      ],
      [
        1499,
        `${iso} ${
          JSON.stringify({
            version: "v1",
            kind: "hosted_runtime_terminal",
            execution: prepared.execution,
            controllerSha: cell.runtimeSha,
            startedAt: f.clock.now(),
            finishedAt: f.clock.now(),
            outcome: "healthy",
            startupReady: true,
            settled: true,
            baseSha: BASE,
          })
        }\n`,
      ],
    ]);
    const currentHttp: HttpTransportV1 = (request) => {
      const url = new URL(request.url);
      const response = (value: unknown) =>
        Promise.resolve({
          status: 200,
          headers: new Headers(),
          bodyText: typeof value === "string" ? value : JSON.stringify(value),
        });
      if (url.pathname.endsWith("/runs/72/attempts/1")) {
        return response({
          id: 72,
          run_attempt: 1,
          workflow_id: 357012162,
          path: ".github/workflows/supervisor.yml",
          event: "workflow_dispatch",
          head_branch: "sentinel-supervisor",
          head_sha: successorRun.launcherSha,
          repository: { id: 123, full_name: "ubiquity/sentinel" },
          head_repository: { id: 123, full_name: "ubiquity/sentinel" },
          status: "completed",
          conclusion: "success",
          run_started_at: iso,
          updated_at: iso,
        });
      }
      if (url.pathname.endsWith("/runs/72/attempts/1/jobs")) {
        return response({ total_count: jobs.length, jobs });
      }
      if (url.pathname.endsWith("/artifacts")) {
        return response({
          total_count: rows.length + f.artifacts.length,
          artifacts: [...f.artifacts, ...rows],
        });
      }
      const archive = url.pathname.match(/\/artifacts\/(150[12])\/zip$/);
      const log = url.pathname.match(/\/jobs\/(1401|1402|1499)\/logs$/);
      if (archive || log) {
        return Promise.resolve({
          status: 302,
          headers: new Headers({
            location:
              `https://productionresultssa1.blob.core.windows.net/successor/${
                archive ? "archive" : "log"
              }/${(archive ?? log)![1]}`,
          }),
          bodyText: "",
        });
      }
      if (url.pathname.startsWith("/successor/")) {
        assert.equal(request.headers.size, 0);
        assert.equal(request.redirect, "error");
        const id = Number(url.pathname.split("/").at(-1));
        return url.pathname.includes("/archive/")
          ? Promise.resolve({
            status: 200,
            headers: new Headers(),
            bodyText: "",
            bodyBytes: archives.get(id)!,
          })
          : response(logs.get(id)!);
      }
      return f.http(request);
    };
    const transport = createActionsMatrixArtifactTransport({
      state: f.rig.state,
      clock: f.clock,
      token: "offline-native-token",
      artifactRoot: `${f.rig.tmp}/current-artifacts`,
      http: currentHttp,
    });
    const config = repositoryConfig(undefined, undefined, {
      repository: SELF_REPO,
      adapter: { kind: "github" },
      liveStartLimits: { perHour: null, perSevenDays: null },
    });
    const model = new FakeModel();
    const github = new FakeGithub({ baseSha: BASE, openIssues: [] });
    const oldPlanReads = f.calls.filter((call) =>
      call.url.endsWith("/artifacts/501/zip")
    ).length;
    const prior = Deno.cwd();
    Deno.chdir(f.checkout);
    try {
      const aggregate = await runActionsMatrixAggregateCycles(
        {
          clock: f.clock,
          state: f.rig.state,
          configs: [config],
          controllerSha: cell.runtimeSha,
          githubCooldown: new HostedRepairCooldownGate({
            state: f.rig.state,
            clock: f.clock,
          }),
          incidents: new FakeIncidents(),
          replay: new FakeReplay(),
          model,
          budget: f.historicalMatrix.budget,
          deadline: f.clock.now() + 60_000,
          stepLimit: 1,
          modelStartsEnabled: false,
          composeGithub: () => github,
          host: {
            execution: prepared.execution,
            run: successorRun,
            artifactRoot: `${f.rig.tmp}/current-artifacts`,
            sourcePathFor: () => f.checkout,
            expectedProvider: "test",
            createArtifactTransport: () => Promise.resolve(transport),
          },
        },
        transport,
        { planDigest: await matrixDigestV1(plan) },
      );
      assert.deepEqual(aggregate.failed, []);
    } finally {
      Deno.chdir(prior);
    }
    assert.deepEqual(model.requests, []);
    assert.equal(github.pushes.length, 0);
    assert.equal(
      f.calls.filter((call) => call.url.endsWith("/artifacts/501/zip")).length,
      oldPlanReads,
    );
    const currentClient = new GitHubApiClient({
      repository: SELF_REPO,
      apiBaseUrl: "https://api.github.com",
      http: currentHttp,
      clock: f.clock,
      auth: {
        authorizationHeader: () =>
          Promise.resolve(portOk("Bearer offline-native-token")),
      },
      cooldownGate: new HostedRepairCooldownGate({
        state: f.rig.state,
        clock: f.clock,
      }),
    });
    const finalized = await runHostedSupervisorFinalize({
      state: release,
      clock: f.clock,
      run: successorRun,
      evidence: {
        ...evidence,
        readExecution: currentClient.readHostedExecution.bind(currentClient),
      },
    });
    assert.equal(finalized.status, "idle");
    const freshRelease = await release.readRelease();
    assert(freshRelease.ok && freshRelease.value.status === "found");
    assert.equal(
      freshRelease.value.snapshot.hostedRuntimes[0].lastExecutionProof
        ?.execution.id,
      "72:1:repair",
    );
    assert.equal(
      freshRelease.value.snapshot.hostedRuntimes[0].lastHealthyProof?.execution
        .id,
      "72:1:repair",
    );
    await f.run();
    const after = await f.rig.state.readRepair();
    assert(after.ok && after.value.status === "found");
    assert.deepEqual(
      after.value.snapshot.work.filter((row) => row.id !== sibling.id),
      quarantined.value.snapshot.work.filter((row) => row.id !== sibling.id),
    );
    assert.deepEqual(
      after.value.snapshot.reservations.slice(0, 17),
      quarantined.value.snapshot.reservations.slice(0, 17),
    );
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

async function historicalWithNewerCurrent(
  mode = "settled",
  overwritten = false,
) {
  const f = await historicalMalformedRig();
  const release = createReleaseStateStore({
    scratchDir: `${f.rig.tmp}/newer-release`,
    remoteUrl: `${f.rig.tmp}/remote.git`,
  });
  const evidence = {
    readExecution: f.client.readHostedExecution.bind(f.client),
    verifyRevision: () => Promise.resolve(portOk(true)),
    verifyRequest: () => Promise.resolve(portOk(false)),
  };
  assert.equal(
    (await runHostedSupervisorFinalize({
      state: release,
      clock: f.clock,
      run: f.nativeRun,
      evidence,
    })).status,
    "idle",
  );
  const saved = await release.readRelease();
  assert(saved.ok && saved.value.status === "found");
  f.clock.now = () => T0 + 70_000;
  let current = {
    ...f.execution,
    id: "73:1:repair",
    runId: 73,
    runAttempt: 1,
    launcherSha: "4".repeat(40) as GitSha,
    createdAt: T0 + 61_000,
  };
  const seeded = await release.writeRelease({
    ...saved.value.snapshot,
    stateHead: saved.value.head,
    sequence: saved.value.snapshot.sequence + 1,
    updatedAt: f.clock.now(),
    hostedRuntimes: [{
      ...saved.value.snapshot.hostedRuntimes[0],
      execution: current,
      updatedAt: f.clock.now(),
    }],
  }, saved.value.head);
  assert(seeded.ok && seeded.value.status === "applied");
  if (overwritten) {
    const latest = await release.readRelease();
    assert(latest.ok && latest.value.status === "found");
    const old = saved.value.snapshot.hostedRuntimes[0].lastExecutionProof!;
    assert(old.outcome !== "not_started");
    const settled = await release.writeRelease({
      ...latest.value.snapshot,
      stateHead: latest.value.head,
      sequence: latest.value.snapshot.sequence + 1,
      updatedAt: f.clock.now(),
      hostedRuntimes: [{
        ...latest.value.snapshot.hostedRuntimes[0],
        execution: null,
        lastExecutionProof: {
          ...old,
          execution: current,
          startedAt: T0 + 62_000,
          finishedAt: T0 + 65_000,
          observedAt: f.clock.now(),
          terminalAt: old.terminalAt === null ? null : T0 + 65_000,
          logDigest: "9".repeat(64),
        },
      }],
    }, latest.value.head);
    assert(
      settled.ok && settled.value.status === "applied",
      JSON.stringify(settled),
    );
    const idle = await release.readRelease();
    assert(idle.ok && idle.value.status === "found");
    current = {
      ...current,
      id: "75:1:repair",
      runId: 75,
      createdAt: T0 + 66_000,
    };
    const started = await release.writeRelease({
      ...idle.value.snapshot,
      stateHead: idle.value.head,
      sequence: idle.value.snapshot.sequence + 1,
      updatedAt: f.clock.now(),
      hostedRuntimes: [{
        ...idle.value.snapshot.hostedRuntimes[0],
        execution: current,
      }],
    }, idle.value.head);
    assert(started.ok && started.value.status === "applied");
  }
  const iso = (at: number) => new Date(at).toISOString();
  const jobs = ["maintenance", "prepare", "matrix_plan"].map((name, i) => ({
    id: 2401 + i,
    name,
    run_id: mode === "wrong-job" && i === 2 ? 99 : current.runId,
    run_attempt: 1,
    head_sha: current.launcherSha,
    status: mode === "pending" && i === 2 ? "in_progress" : "completed",
    conclusion: mode === "pending" && i === 2
      ? null
      : i === 2
      ? "cancelled"
      : "success",
    started_at: iso(T0 + (overwritten ? 67_000 : 62_000)),
    completed_at: mode === "pending" && i === 2
      ? null
      : iso(T0 + (overwritten ? 68_000 : 65_000)),
    steps: [],
  }));
  const currentHttp: HttpTransportV1 = (request) => {
    const url = new URL(request.url);
    if (url.pathname.includes(`/runs/${current.runId}/`)) {
      assert.equal(
        request.headers.get("authorization"),
        "Bearer offline-native-token",
      );
      if (mode === "unavailable") {
        return Promise.resolve({
          status: 503,
          headers: new Headers(),
          bodyText: "",
        });
      }
      const value = url.pathname.endsWith("/jobs")
        ? {
          total_count: mode === "truncated" ? jobs.length + 1 : jobs.length,
          jobs: mode === "duplicate" ? [jobs[0], jobs[1], jobs[0]] : jobs,
        }
        : {
          id: current.runId,
          run_attempt: 1,
          workflow_id: 357012162,
          path: ".github/workflows/supervisor.yml",
          event: "workflow_dispatch",
          head_branch: "sentinel-supervisor",
          head_sha: mode === "foreign" ? BASE : current.launcherSha,
          repository: { id: 123, full_name: "ubiquity/sentinel" },
          head_repository: { id: 123, full_name: "ubiquity/sentinel" },
          status: mode === "pending" ? "in_progress" : "completed",
          conclusion: mode === "pending" ? null : "cancelled",
          run_started_at: iso(current.createdAt),
          updated_at: iso(T0 + (overwritten ? 68_000 : 65_000)),
        };
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        bodyText: JSON.stringify(value),
      });
    }
    return f.http(request);
  };
  const reader = new GitHubApiClient({
    repository: SELF_REPO,
    apiBaseUrl: "https://api.github.com",
    http: currentHttp,
    clock: f.clock,
    auth: {
      authorizationHeader: () =>
        Promise.resolve(portOk("Bearer offline-native-token")),
    },
    cooldownGate: new HostedRepairCooldownGate({
      state: f.rig.state,
      clock: f.clock,
    }),
  });
  const observed: number[] = [];
  f.historicalMatrix.readExecution = async (execution) => {
    observed.push(execution.runId);
    const result = await reader.readHostedExecution(execution);
    if (
      execution.runId === current.runId && mode === "wrong-binding" &&
      result.ok &&
      result.value !== null
    ) {
      return portOk({ ...result.value, execution: f.execution });
    }
    if (execution.runId === current.runId && mode === "custody") {
      f.rig.state.readRelease = () =>
        Promise.resolve(
          portError("unavailable", "injected current custody drift"),
        );
    }
    if (execution.runId === current.runId && mode === "old-proof-missing") {
      f.rig.state.readRelease = async () => {
        const read = await release.readRelease();
        if (!read.ok || read.value.status !== "found") return read;
        return portOk({
          ...read.value,
          snapshot: {
            ...read.value.snapshot,
            hostedRuntimes: read.value.snapshot.hostedRuntimes.map((row) => ({
              ...row,
              lastExecutionProof: null,
            })),
          },
        });
      };
    }
    return result;
  };
  f.historicalMatrix.transport = createActionsMatrixArtifactTransport({
    state: f.rig.state,
    clock: f.clock,
    token: "offline-native-token",
    artifactRoot: `${f.rig.tmp}/artifacts`,
    http: currentHttp,
  });
  return {
    ...f,
    release,
    reader,
    current,
    currentHttp,
    observed,
    evidence,
    witness: saved.value,
  };
}

Deno.test("historical release witness: overwritten ordinary proof still quarantines exact old wave", async () => {
  const f = await historicalWithNewerCurrent("settled", true);
  const priorCwd = Deno.cwd();
  Deno.chdir(f.checkout);
  try {
    const proof = f.witness.snapshot.hostedRuntimes[0].lastExecutionProof!;
    assert(proof.outcome !== "not_started");
    const historicalMatrix = createHostedHistoricalMatrixQuarantine({
      state: f.rig.state,
      clock: f.clock,
      token: "offline-native-token",
      artifactRoot: `${f.rig.tmp}/witness-artifacts`,
      http: f.currentHttp,
      artifactHttp: f.currentHttp,
      historicalReleaseWitnesses: [{
        commit: f.witness.head,
        executionId: proof.execution.id,
        logDigest: proof.logDigest,
        reservationIds: f.charges.slice(0, 17).map((row) => row.id),
      }],
    });
    const before = await f.release.readRelease();
    const repairBefore = await f.rig.state.readRepair();
    await assert.rejects(() =>
      runHistoricalMatrixQuarantine({
        ...historicalMatrix,
        historicalReleaseWitnesses: undefined,
      }), /historical matrix native settlement unavailable/);
    assert.deepEqual(await f.rig.state.readRepair(), repairBefore);
    await assert.rejects(
      () => runHistoricalMatrixQuarantine(historicalMatrix),
      /historical matrix native settlement unavailable/,
    );
    const afterOld = await f.rig.state.readRepair();
    assert(afterOld.ok && afterOld.value.status === "found");
    assert.deepEqual(
      afterOld.value.snapshot.work.find((row) => row.id === f.records[17].id),
      f.records[17],
    );
    assert(
      afterOld.value.snapshot.reservations.slice(0, 17).every((row) =>
        row.outcome === "ambiguous"
      ),
    );
    const requestId = "e".repeat(64);
    const later = workRecord("later-normal", {
      ...f.records[17],
      id: "later-normal",
      source: { ...f.records[17].source, id: "later-normal" },
      related: { incidentId: null, issueNumber: 19 },
      target: {
        ...f.records[17].target,
        branch: candidateBranch("later-normal" as WorkItemId),
      },
      intent: {
        ...f.records[17].intent!,
        requestId,
        key: implementationIntentKey(requestId),
        branch: candidateBranch("later-normal" as WorkItemId),
        startedAt: T0 + 62_001,
      },
      updatedAt: T0 + 62_001,
    });
    const charge = reservation(requestId, {
      repository: SELF_REPO,
      taskId: later.id,
      head: BASE,
      createdAt: T0 + 62_001,
    });
    const added = await f.rig.state.writeRepair({
      ...afterOld.value.snapshot,
      stateHead: afterOld.value.head,
      sequence: afterOld.value.snapshot.sequence + 1,
      updatedAt: f.clock.now(),
      work: [...afterOld.value.snapshot.work, later],
      reservations: [...afterOld.value.snapshot.reservations, charge],
    }, afterOld.value.head);
    assert(added.ok && added.value.status === "applied");
    const latest = before.ok && before.value.status === "found"
      ? before.value.snapshot.hostedRuntimes[0].lastExecutionProof!
      : null;
    assert(latest && latest.outcome !== "not_started");
    const readExecution = historicalMatrix.readExecution;
    historicalMatrix.readExecution = (execution) =>
      execution.id === latest.execution.id
        ? Promise.resolve(portOk(latest))
        : readExecution(execution);
    const request = {
      ...f.plan.cells[0].request,
      taskId: later.id,
      issue: { number: 19, title: "later", body: "later" },
    };
    let normalCalls = 0;
    historicalMatrix.transport.rejectHistorical = async ({ proof }) => {
      assert.equal(proof.execution.id, latest.execution.id);
      normalCalls++;
      return [{
        reason: "reservation_after_manifest",
        proof,
        planDigest: "d".repeat(64),
        plannerJobId: 2501,
        affected: [{
          request,
          requestDigest: await matrixDigestV1(request),
          work: later,
          workDigest: await matrixDigestV1(later),
          reservation: charge,
          reservationDigest: await matrixDigestV1(charge),
        }],
      }];
    };
    const result = await runHostedAutonomy({
      state: f.rig.state,
      githubFor: f.rig.githubFor,
      clock: f.clock,
      historicalMatrix,
    });
    assert(result.actions.includes("historical-matrix:quarantined:1"));
    assert.equal(normalCalls, 1);
    const afterLater = await f.rig.state.readRepair();
    assert(afterLater.ok && afterLater.value.status === "found");
    assert.equal(
      afterLater.value.snapshot.work.find((row) => row.id === later.id)
        ?.nextStep,
      "blocked",
    );
    assert.deepEqual(
      afterLater.value.snapshot.work.find((row) => row.id === f.records[17].id),
      f.records[17],
    );
    assert.deepEqual(await f.release.readRelease(), before);
    console.log(`historical witness native requests: ${f.calls.length}`);
  } finally {
    Deno.chdir(priorCwd);
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

async function historicalMultiWaveRig(
  historicalCount = 17,
  currentCount = 3,
  finalizeCurrent = true,
) {
  const f = await historicalMalformedRig(false, historicalCount);
  const release = createReleaseStateStore({
    scratchDir: `${f.rig.tmp}/multi-release`,
    remoteUrl: `${f.rig.tmp}/remote.git`,
  });
  f.clock.now = () => T0 + 30_000;
  const originalEvidence = {
    readExecution: f.client.readHostedExecution.bind(f.client),
    verifyRevision: () => Promise.resolve(portOk(true)),
    verifyRequest: () => Promise.resolve(portOk(false)),
  };
  assert.equal(
    (await runHostedSupervisorFinalize({
      state: release,
      clock: f.clock,
      run: f.nativeRun,
      evidence: originalEvidence,
    })).status,
    "idle",
  );
  const witness = await release.readRelease();
  assert(witness.ok && witness.value.status === "found");
  const proof = witness.value.snapshot.hostedRuntimes[0].lastExecutionProof!;
  assert(proof.outcome !== "not_started");
  const run = {
    runId: 73,
    runAttempt: 1,
    launcherSha: "4".repeat(40) as GitSha,
  };
  const execution = {
    ...f.execution,
    ...run,
    id: "73:1:repair",
    createdAt: T0 + 31_000,
  };
  f.clock.now = () => T0 + 31_000;
  const started = await release.writeRelease({
    ...witness.value.snapshot,
    stateHead: witness.value.head,
    sequence: witness.value.snapshot.sequence + 1,
    updatedAt: f.clock.now(),
    hostedRuntimes: [{
      ...witness.value.snapshot.hostedRuntimes[0],
      execution,
      updatedAt: f.clock.now(),
    }],
  }, witness.value.head);
  assert(started.ok && started.value.status === "applied");
  const records = Array.from({ length: currentCount }, (_, i) => {
    const id = `multi-current-${i}` as WorkItemId;
    const requestId = `${i + 1}`.repeat(64);
    return workRecord(id, {
      ...f.records[0],
      id,
      source: { ...f.records[0].source, id },
      related: { incidentId: null, issueNumber: 101 + i },
      target: { ...f.records[0].target, branch: candidateBranch(id) },
      intent: {
        ...f.records[0].intent!,
        branch: candidateBranch(id),
        key: implementationIntentKey(requestId),
        requestId,
        startedAt: T0 + 32_001 + i,
      },
      createdAt: T0 + 32_000,
      updatedAt: T0 + 32_001 + i,
    });
  });
  const charges = records.map((row, i) =>
    reservation(row.intent!.requestId!, {
      repository: SELF_REPO,
      taskId: row.id,
      head: BASE,
      createdAt: T0 + 32_001 + i,
    })
  );
  const repair = await f.rig.state.readRepair();
  assert(repair.ok && repair.value.status === "found");
  f.clock.now = () => T0 + 33_000;
  const added = await f.rig.state.writeRepair({
    ...repair.value.snapshot,
    stateHead: repair.value.head,
    sequence: repair.value.snapshot.sequence + 1,
    updatedAt: f.clock.now(),
    work: [...repair.value.snapshot.work, ...records],
    reservations: [...repair.value.snapshot.reservations, ...charges],
  }, repair.value.head);
  assert(added.ok && added.value.status === "applied");
  const cells = await Promise.all(records.map(async (row) => {
    const request = {
      ...f.plan.cells[0].request,
      taskId: row.id,
      issue: {
        number: row.related.issueNumber!,
        title: "sanitized",
        body: "sanitized",
      },
    };
    return {
      ...f.plan.cells[0],
      cellId: await matrixCellIdV1(
        execution.id,
        row.id,
        row.intent!.requestId!,
      ),
      taskId: row.id,
      reservationId: row.intent!.requestId!,
      intentKey: row.intent!.key,
      requestDigest: await matrixDigestV1(request),
      request,
    };
  }));
  const plan: MatrixPlanV1 = {
    ...f.plan,
    waveId: execution.id,
    run,
    plannedAt: T0 + 32_000,
    cells,
  };
  const iso = (at: number) => new Date(at).toISOString();
  const archives = new Map<number, Uint8Array>();
  const artifacts: Record<string, unknown>[] = [];
  const logs = new Map<number, string>();
  async function archived(
    id: number,
    name: string,
    filename: string,
    value: unknown,
  ) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {
      useWebWorkers: false,
    });
    await writer.add(
      filename,
      new Uint8ArrayReader(new TextEncoder().encode(canonicalStringify(value))),
      { unixMode: 0o100600 },
    );
    const bytes = await writer.close();
    const digest = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())),
    ].map((value) => value.toString(16).padStart(2, "0")).join("");
    archives.set(id, bytes);
    artifacts.push({
      id,
      name,
      size_in_bytes: bytes.length,
      expired: false,
      digest: `sha256:${digest}`,
      workflow_run: {
        id: run.runId,
        repository_id: 123,
        head_repository_id: 123,
        head_branch: "sentinel-supervisor",
        head_sha: run.launcherSha,
      },
    });
  }
  await archived(901, "sentinel-matrix-plan-73-1", "plan.json", plan);
  logs.set(
    801,
    `${iso(T0 + 49_000)} ${
      JSON.stringify({
        kind: "sentinel_matrix_plan",
        waveId: execution.id,
        run,
        runtimeSha: execution.revision,
        generation: execution.generation,
        planDigest: await matrixDigestV1(plan),
        prepared: cells.length,
      })
    }\n`,
  );
  logs.set(899, `${iso(T0 + 50_000)} child exited before terminal\n`);
  for (const [i, cell] of cells.entries()) {
    const result: MatrixCellResultV1 = {
      version: "v1",
      kind: "matrix_cell_result",
      waveId: execution.id,
      run,
      runtimeSha: execution.revision,
      generation: execution.generation,
      cellId: cell.cellId,
      taskId: cell.taskId,
      repository: SELF_REPO,
      reservationId: cell.reservationId,
      intentKey: cell.intentKey,
      requestDigest: cell.requestDigest,
      status: "not_started",
      receipt: null,
      bundle: null,
      detail: "sanitized no start",
      completedAt: T0 + 49_000,
    };
    await archived(
      902 + i,
      `sentinel-matrix-cell-73-1-${cell.cellId}`,
      "result.json",
      result,
    );
    logs.set(
      802 + i,
      `${iso(T0 + 49_000)} ${
        JSON.stringify({
          kind: "sentinel_matrix_cell",
          run,
          runtimeSha: execution.revision,
          generation: execution.generation,
          cellId: cell.cellId,
          reservationId: cell.reservationId,
          resultDigest: await matrixDigestV1(result),
          bundleDigest: null,
          status: "not_started",
        })
      }\n`,
    );
  }
  const jobs = [
    { id: 801, name: "matrix_plan", step: "Plan isolated issue matrix" },
    { id: 899, name: "repair", step: "Run selected Sentinel runtime" },
    ...cells.map((cell, i) => ({
      id: 802 + i,
      name: `matrix_cell (${cell.cellId})`,
      step: "Run isolated issue cell",
    })),
  ].map((row) => ({
    id: row.id,
    name: row.name,
    run_id: run.runId,
    run_attempt: 1,
    head_sha: run.launcherSha,
    status: "completed",
    conclusion: row.id === 899 ? "failure" : "success",
    started_at: iso(T0 + 31_000),
    completed_at: iso(T0 + 50_000),
    steps: [{
      name: row.step,
      number: 1,
      status: "completed",
      conclusion: row.id === 899 ? "failure" : "success",
      started_at: iso(T0 + 31_000),
      completed_at: iso(T0 + 50_000),
    }],
  }));
  let missingPlan = false;
  let bootstrap:
    | { execution: HostedExecutionIntentV1; run: typeof run }
    | null = null;
  const response = (value: unknown) =>
    Promise.resolve({
      status: 200,
      headers: new Headers(),
      bodyText: typeof value === "string" ? value : JSON.stringify(value),
    });
  const http: HttpTransportV1 = (request) => {
    const url = new URL(request.url);
    if (bootstrap && url.pathname.includes(`/runs/${bootstrap.run.runId}/`)) {
      const saved = bootstrap;
      const job = {
        ...jobs[1],
        id: 999,
        run_id: saved.run.runId,
        head_sha: saved.run.launcherSha,
        conclusion: "success",
        started_at: iso(f.clock.now()),
        completed_at: iso(f.clock.now()),
        steps: [{
          ...jobs[1].steps[0],
          conclusion: "success",
          started_at: iso(f.clock.now()),
          completed_at: iso(f.clock.now()),
        }],
      };
      return response(
        url.pathname.endsWith("/jobs") ? { total_count: 1, jobs: [job] } : {
          id: saved.run.runId,
          run_attempt: 1,
          workflow_id: 357012162,
          path: ".github/workflows/supervisor.yml",
          event: "workflow_dispatch",
          head_branch: "sentinel-supervisor",
          head_sha: saved.run.launcherSha,
          repository: { id: 123, full_name: "ubiquity/sentinel" },
          head_repository: { id: 123, full_name: "ubiquity/sentinel" },
          status: "completed",
          conclusion: "success",
          run_started_at: iso(f.clock.now()),
          updated_at: iso(f.clock.now()),
        },
      );
    }
    if (bootstrap && url.pathname.endsWith("/jobs/999/logs")) {
      logs.set(
        999,
        `${iso(f.clock.now())} ${
          JSON.stringify({
            version: "v1",
            kind: "hosted_runtime_terminal",
            execution: bootstrap.execution,
            controllerSha: bootstrap.execution.revision,
            startedAt: f.clock.now(),
            finishedAt: f.clock.now(),
            outcome: "healthy",
            startupReady: true,
            settled: true,
            baseSha: BASE,
          })
        }\n`,
      );
    }
    if (url.pathname.includes("/runs/73/")) {
      assert.equal(
        request.headers.get("authorization"),
        "Bearer offline-native-token",
      );
      if (url.pathname.endsWith("/jobs")) {
        return response({ total_count: jobs.length, jobs });
      }
      if (url.pathname.endsWith("/artifacts")) {
        return response({
          total_count: missingPlan ? 0 : artifacts.length,
          artifacts: missingPlan ? [] : artifacts,
        });
      }
      return response({
        id: 73,
        run_attempt: 1,
        workflow_id: 357012162,
        path: ".github/workflows/supervisor.yml",
        event: "workflow_dispatch",
        head_branch: "sentinel-supervisor",
        head_sha: run.launcherSha,
        repository: { id: 123, full_name: "ubiquity/sentinel" },
        head_repository: { id: 123, full_name: "ubiquity/sentinel" },
        status: "completed",
        conclusion: "failure",
        run_started_at: iso(T0 + 31_000),
        updated_at: iso(T0 + 50_000),
      });
    }
    const archive = url.pathname.match(/\/artifacts\/(90[1-4])\/zip$/);
    const log = url.pathname.match(/\/jobs\/(80[1-4]|899|999)\/logs$/);
    if (archive || log) {
      return Promise.resolve({
        status: 302,
        headers: new Headers({
          location:
            `https://productionresultssa1.blob.core.windows.net/multiwave/${
              archive ? "archive" : "log"
            }/${(archive ?? log)![1]}`,
        }),
        bodyText: "",
      });
    }
    if (url.pathname.startsWith("/multiwave/")) {
      assert.equal(request.headers.size, 0);
      assert.equal(request.redirect, "error");
      const id = Number(url.pathname.split("/").at(-1));
      return url.pathname.includes("/archive/")
        ? Promise.resolve({
          status: 200,
          headers: new Headers(),
          bodyText: "",
          bodyBytes: archives.get(id)!,
        })
        : response(logs.get(id)!);
    }
    return f.http(request);
  };
  const client = new GitHubApiClient({
    repository: SELF_REPO,
    apiBaseUrl: "https://api.github.com",
    http,
    clock: f.clock,
    auth: {
      authorizationHeader: () =>
        Promise.resolve(portOk("Bearer offline-native-token")),
    },
    cooldownGate: new HostedRepairCooldownGate({
      state: f.rig.state,
      clock: f.clock,
    }),
  });
  const evidence = {
    ...originalEvidence,
    readExecution: client.readHostedExecution.bind(client),
  };
  f.clock.now = () => T0 + 60_000;
  if (finalizeCurrent) {
    assert.equal(
      (await runHostedSupervisorFinalize({
        state: release,
        clock: f.clock,
        run,
        evidence,
      })).status,
      "idle",
    );
  }
  Object.assign(
    f.historicalMatrix,
    createHostedHistoricalMatrixQuarantine({
      state: f.rig.state,
      clock: f.clock,
      token: "offline-native-token",
      artifactRoot: `${f.rig.tmp}/multi-artifacts`,
      http,
      artifactHttp: http,
      historicalReleaseWitnesses: [{
        commit: witness.value.head,
        executionId: proof.execution.id,
        logDigest: proof.logDigest,
        reservationIds: f.charges.slice(0, 17).map((row) => row.id),
      }],
    }),
  );
  return {
    ...f,
    release,
    records,
    charges,
    evidence,
    witness: witness.value,
    setMissing: (value: boolean) => {
      missingPlan = value;
    },
    setBootstrap: (
      value: { execution: HostedExecutionIntentV1; run: typeof run },
    ) => {
      bootstrap = value;
    },
  };
}

Deno.test("historical closed list: three distinct witnesses then current, retirement and selected missing custody", async () => {
  for (const mode of ["selected", "retired", "missing"]) {
    const f = await historicalMultiWaveRig(3, 1);
    const previousCwd = Deno.cwd();
    Deno.chdir(f.checkout);
    try {
      const before = await f.rig.state.readRepair();
      assert(before.ok && before.value.status === "found");
      const old = f.witness.snapshot.hostedRuntimes[0].lastExecutionProof!;
      assert(old.outcome !== "not_started");
      const witnesses = f.plan.cells.map((cell, i) => ({
        commit: `${i + 6}`.repeat(40) as GitSha,
        proof: {
          ...old,
          execution: {
            ...old.execution,
            id: `${101 + i}:1:repair`,
            runId: 101 + i,
            runAttempt: 1,
          },
        },
        cell,
      }));
      const order: number[] = [];
      f.rig.state.readReleaseAt = (input) => {
        if (mode === "retired") {
          throw new Error("completed witness reader must not run");
        }
        if (mode === "missing") {
          return Promise.resolve(
            portError("unavailable", "selected witness missing"),
          );
        }
        const witness = witnesses.find((row) => row.commit === input.commit)!;
        return Promise.resolve(portOk({
          status: "found",
          head: witness.commit,
          ref: null,
          snapshot: {
            ...f.witness.snapshot,
            hostedRuntimes: [{
              ...f.witness.snapshot.hostedRuntimes[0],
              lastExecutionProof: witness.proof,
            }],
          },
        }));
      };
      const readExecution = f.evidence.readExecution;
      const rejectCurrent = f.historicalMatrix.transport.rejectHistorical!;
      const deps: HistoricalMatrixQuarantineDepsV1 = {
        ...f.historicalMatrix,
        readExecution: (execution) => {
          const witness = witnesses.find((row) =>
            row.proof.execution.id === execution.id
          );
          if (!witness) return readExecution(execution);
          if (mode === "retired") {
            throw new Error("completed witness native read must not run");
          }
          return Promise.resolve(portOk(witness.proof));
        },
        transport: {
          ...f.historicalMatrix.transport,
          rejectHistorical: (input) => {
            order.push(input.proof.execution.runId);
            return rejectCurrent(input);
          },
        },
        historicalReleaseWitnesses: witnesses.map((witness) => ({
          commit: witness.commit,
          executionId: witness.proof.execution.id,
          logDigest: witness.proof.logDigest,
          reservationIds: [witness.cell.reservationId],
          reject: async (proof) => {
            if (mode === "retired") {
              throw new Error("completed witness archive must not run");
            }
            order.push(proof.execution.runId);
            const read = await f.rig.state.readRepair();
            assert(read.ok && read.value.status === "found");
            const work = read.value.snapshot.work.find((row) =>
              row.id === witness.cell.taskId
            )!;
            const charge = read.value.snapshot.reservations.find((row) =>
              row.id === witness.cell.reservationId
            )!;
            return [{
              reason: "reservation_after_manifest",
              proof,
              planDigest: "d".repeat(64),
              plannerJobId: 1000 + proof.execution.runId,
              affected: [{
                request: witness.cell.request,
                requestDigest: witness.cell.requestDigest,
                work,
                workDigest: await matrixDigestV1(work),
                reservation: charge,
                reservationDigest: await matrixDigestV1(charge),
              }],
            }];
          },
        })),
      };
      if (mode === "retired") {
        const ids = witnesses.map((row) => row.cell.reservationId);
        const blocked = await f.rig.state.writeRepair({
          ...before.value.snapshot,
          stateHead: before.value.head,
          sequence: before.value.snapshot.sequence + 1,
          updatedAt: f.clock.now(),
          work: before.value.snapshot.work.map((row) =>
            ids.includes(row.intent?.requestId ?? "")
              ? {
                ...row,
                nextStep: "blocked",
                blocker: {
                  kind: "other",
                  message: HISTORICAL_MATRIX_QUARANTINE,
                  since: f.clock.now(),
                },
                wait: null,
                updatedAt: f.clock.now(),
              }
              : row
          ),
        }, before.value.head);
        assert(blocked.ok && blocked.value.status === "applied");
      }
      if (mode === "missing") {
        await assert.rejects(
          () => runHistoricalMatrixQuarantine(deps),
          /release witness unavailable/,
        );
        assert.deepEqual(await f.rig.state.readRepair(), before);
        assert.deepEqual(order, []);
      } else {
        assert.equal(
          await runHistoricalMatrixQuarantine(deps),
          mode === "selected" ? 4 : 1,
        );
        assert.deepEqual(
          order,
          mode === "selected" ? [101, 102, 103, 73] : [73],
        );
      }
    } finally {
      Deno.chdir(previousCwd);
      await Deno.remove(f.rig.tmp, { recursive: true });
    }
  }
});

Deno.test("historical verification: healthy bootstrap preserves thirteen unrelated intents", async () => {
  for (
    const purpose of [
      "bootstrap",
      "prior",
      "candidate",
      "rollback",
      "failed-candidate",
    ] as const
  ) {
    const f = await historicalMalformedRig(false, 13);
    const previousCwd = Deno.cwd();
    Deno.chdir(f.checkout);
    try {
      const failed = purpose === "failed-candidate";
      const verificationPurpose = failed ? "candidate" : purpose;
      const execution: HostedExecutionIntentV1 = {
        ...f.execution,
        purpose: verificationPurpose,
        releaseId: verificationPurpose === "bootstrap"
          ? null
          : "verification-release",
      };
      const job = f.jobs.find((row) => row.id === 499)!;
      job.conclusion = failed ? "failure" : "success";
      job.steps[0].conclusion = job.conclusion;
      f.logs.set(
        499,
        `${new Date(T0 + 30_000).toISOString()} ${
          JSON.stringify({
            version: "v1",
            kind: "hosted_runtime_terminal",
            execution,
            controllerSha: execution.revision,
            startedAt: T0,
            finishedAt: T0 + 30_000,
            outcome: failed ? "failed" : "healthy",
            startupReady: !failed,
            settled: true,
            baseSha: BASE,
          })
        }\n`,
      );
      const native = await f.client.readHostedExecution(execution);
      assert(
        native.ok && native.value !== null &&
          native.value.outcome === (failed ? "failed" : "healthy"),
      );
      const release = await f.rig.state.readRelease();
      assert(release.ok && release.value.status === "found");
      const snapshot = parseReleaseStateSnapshotV1({
        ...release.value.snapshot,
        hostedRuntimes: [{
          ...release.value.snapshot.hostedRuntimes[0],
          execution: null,
          lastExecutionProof: native.value,
          lastHealthyProof: failed ? null : native.value,
        }],
      });
      f.rig.state.readRelease = () =>
        Promise.resolve(portOk({ ...release.value, snapshot }));
      f.rig.state.writeRepair = () => {
        throw new Error("unexpected task write");
      };
      f.historicalMatrix.budget.settleModelStart = () => {
        throw new Error("unexpected charge settlement");
      };
      const before = await f.rig.state.readRepair();
      assert.equal(
        await runHistoricalMatrixQuarantine({
          ...f.historicalMatrix,
          historicalReleaseWitnesses: [],
        }),
        0,
      );
      assert.deepEqual(await f.rig.state.readRepair(), before);
    } finally {
      Deno.chdir(previousCwd);
      await Deno.remove(f.rig.tmp, { recursive: true });
    }
  }
});

Deno.test("historical verification: missing proof ordinary pending mismatch and drift remain incomplete", async () => {
  for (
    const fault of [
      "missing",
      "ordinary-artifact",
      "active-ordinary",
      "notstarted-ordinary",
      "pending",
      "mismatch",
      "release-drift",
      "repair-drift",
    ]
  ) {
    const f = await historicalMalformedRig(false, 1);
    const previousCwd = Deno.cwd();
    Deno.chdir(f.checkout);
    try {
      const purpose = fault === "ordinary-artifact" ? "ordinary" : "bootstrap";
      const execution = {
        ...f.execution,
        purpose: purpose as "ordinary" | "bootstrap",
      };
      const job = f.jobs.find((row) => row.id === 499)!;
      job.conclusion = "success";
      job.steps[0].conclusion = "success";
      f.logs.set(
        499,
        `${new Date(T0 + 30_000).toISOString()} ${
          JSON.stringify({
            version: "v1",
            kind: "hosted_runtime_terminal",
            execution,
            controllerSha: execution.revision,
            startedAt: T0,
            finishedAt: T0 + 30_000,
            outcome: "healthy",
            startupReady: true,
            settled: true,
            baseSha: BASE,
          })
        }\n`,
      );
      const native = await f.client.readHostedExecution(execution);
      assert(
        native.ok && native.value !== null &&
          native.value.outcome === "healthy",
      );
      const release = await f.rig.state.readRelease();
      assert(release.ok && release.value.status === "found");
      const active = {
        ...f.execution,
        id: "72:1:repair",
        runId: 72,
        runAttempt: 1,
        createdAt: T0 + 31_000,
      };
      const snapshot = parseReleaseStateSnapshotV1({
        ...release.value.snapshot,
        hostedRuntimes: [{
          ...release.value.snapshot.hostedRuntimes[0],
          execution:
            fault === "active-ordinary" || fault === "notstarted-ordinary"
              ? active
              : null,
          lastExecutionProof: fault === "missing" ? null : native.value,
          lastHealthyProof: native.value,
        }],
      });
      f.rig.state.readRelease = () =>
        Promise.resolve(portOk({ ...release.value, snapshot }));
      f.rig.state.writeRepair = () => {
        throw new Error("unexpected task write");
      };
      f.historicalMatrix.budget.settleModelStart = () => {
        throw new Error("unexpected charge settlement");
      };
      const before = await f.rig.state.readRepair();
      assert(before.ok && before.value.status === "found");
      const repairBefore = before.value;
      if (fault === "ordinary-artifact") f.setFault("missing");
      if (fault === "pending") f.setFault("pending");
      if (fault === "notstarted-ordinary") {
        f.historicalMatrix.transport.confirmCompletedExecution = () =>
          Promise.resolve(true);
        f.historicalMatrix.readExecution = () =>
          Promise.resolve(portOk(parseHostedExecutionSettlementV1({
            execution: active,
            workflowId: 357012162,
            workflowPath: ".github/workflows/supervisor.yml",
            repository: "ubiquity/sentinel",
            ref: "refs/heads/sentinel-supervisor",
            jobId: null,
            outcome: "not_started",
            finishedAt: T0 + 40_000,
            observedAt: f.clock.now(),
            evidenceDigest: "b".repeat(64),
          })));
      }
      if (
        fault === "mismatch" || fault === "release-drift" ||
        fault === "repair-drift"
      ) {
        const read = f.historicalMatrix.readExecution;
        f.historicalMatrix.readExecution = async (input) => {
          const observed = await read(input);
          if (fault === "release-drift") {
            f.rig.state.readRelease = () =>
              Promise.resolve(
                portOk({
                  ...release.value,
                  snapshot,
                  head: "f".repeat(40) as GitSha,
                }),
              );
          }
          if (fault === "repair-drift") {
            f.rig.state.readRepair = () =>
              Promise.resolve(
                portOk({
                  ...repairBefore,
                  snapshot: {
                    ...repairBefore.snapshot,
                    work: repairBefore.snapshot.work.map((row) => ({
                      ...row,
                      updatedAt: row.updatedAt + 1,
                    })),
                  },
                }),
              );
          }
          return fault === "mismatch" && observed.ok &&
              observed.value !== null &&
              observed.value.outcome !== "not_started"
            ? portOk({ ...observed.value, logDigest: "a".repeat(64) })
            : observed;
        };
      }
      await assert.rejects(
        () =>
          runHistoricalMatrixQuarantine({
            ...f.historicalMatrix,
            historicalReleaseWitnesses: [],
          }),
        /historical matrix|matrix artifact/,
      );
    } finally {
      Deno.chdir(previousCwd);
      await Deno.remove(f.rig.tmp, { recursive: true });
    }
  }
});

Deno.test("historical multiwave: first maintenance drains old seventeen and newer three before bootstrap", async () => {
  const f = await historicalMultiWaveRig(17, 3, false);
  const previousCwd = Deno.cwd();
  Deno.chdir(f.checkout);
  try {
    const releaseBefore = await f.release.readRelease();
    assert(releaseBefore.ok && releaseBefore.value.status === "found");
    const current = releaseBefore.value.snapshot.hostedRuntimes[0].execution!;
    assert.equal(current.runId, 73);
    assert.equal(
      releaseBefore.value.snapshot.hostedRuntimes[0].lastExecutionProof
        ?.execution.runId,
      71,
    );
    assert.equal(
      await f.historicalMatrix.transport.confirmCompletedExecution!(current),
      true,
    );
    const native = await f.evidence.readExecution(current);
    assert(
      native.ok && native.value !== null && native.value.outcome === "failed",
    );
    const before = await f.rig.state.readRepair();
    assert(before.ok && before.value.status === "found");
    assert.equal(
      before.value.snapshot.work.filter((row) =>
        row.intent?.kind === "implementation"
      ).length,
      20,
    );
    const result = await f.run();
    assert(
      result.actions.includes("historical-matrix:quarantined:20"),
      JSON.stringify(result.actions),
    );
    assert.deepEqual(await f.release.readRelease(), releaseBefore);
    const after = await f.rig.state.readRepair();
    assert(after.ok && after.value.status === "found");
    assert.equal(
      after.value.snapshot.work.filter((row) => row.nextStep === "blocked")
        .length,
      20,
    );
    assert(
      after.value.snapshot.reservations.every((row) =>
        row.outcome === "ambiguous"
      ),
    );
    const successor = {
      runId: 74,
      runAttempt: 1,
      launcherSha: "5".repeat(40) as GitSha,
    };
    f.clock.now = () => T0 + 70_000;
    const prepared = await runHostedSupervisorPrepare({
      state: f.release,
      clock: f.clock,
      run: successor,
      evidence: f.evidence,
    });
    assert(prepared.status === "run", JSON.stringify(prepared));
    assert.equal(prepared.execution.purpose, "bootstrap");
    f.setBootstrap({ execution: prepared.execution, run: successor });
    assert.equal(
      (await runHostedSupervisorFinalize({
        state: f.release,
        clock: f.clock,
        run: successor,
        evidence: f.evidence,
      })).status,
      "idle",
    );
    assert(
      !((await f.run()).actions.some((action) =>
        action.startsWith("historical-matrix:quarantined:")
      )),
    );
    assert.deepEqual(await f.rig.state.readRepair(), after);
  } finally {
    Deno.chdir(previousCwd);
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("historical multiwave: missing newer manifest blocks prepare and retry preserves historical charges", async () => {
  const f = await historicalMultiWaveRig();
  try {
    f.setMissing(true);
    const releaseBefore = await f.release.readRelease();
    assert.equal(await f.runMain(), 1);
    assert.deepEqual(await f.release.readRelease(), releaseBefore);
    const partial = await f.rig.state.readRepair();
    assert(partial.ok && partial.value.status === "found");
    assert.equal(
      partial.value.snapshot.work.filter((row) => row.nextStep === "blocked")
        .length,
      17,
    );
    for (const charge of f.charges) {
      assert.equal(
        partial.value.snapshot.reservations.find((row) => row.id === charge.id)
          ?.outcome,
        "reserved",
      );
    }
    f.setMissing(false);
    const resumed = await f.run();
    assert(resumed.actions.includes("historical-matrix:quarantined:3"));
    const after = await f.rig.state.readRepair();
    assert(after.ok && after.value.status === "found");
    assert.equal(
      after.value.snapshot.work.filter((row) => row.nextStep === "blocked")
        .length,
      20,
    );
    for (
      const charge of partial.value.snapshot.reservations.filter((row) =>
        row.outcome === "ambiguous"
      )
    ) {
      assert.deepEqual(
        after.value.snapshot.reservations.find((row) => row.id === charge.id),
        charge,
      );
    }
    assert.deepEqual(await f.release.readRelease(), releaseBefore);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("historical newer current: settled cancellation protects separately saved older wave before prepare", async () => {
  const f = await historicalWithNewerCurrent();
  try {
    const releaseBefore = await f.release.readRelease();
    const outcome = await f.run();
    assert(outcome.actions.includes("historical-matrix:quarantined:17"));
    assert.deepEqual(f.observed, [73, 71]);
    assert.deepEqual(await f.release.readRelease(), releaseBefore);
    const after = await f.rig.state.readRepair();
    assert(after.ok && after.value.status === "found");
    for (let i = 0; i < 17; i++) {
      const original = f.records[i];
      const work: WorkRecordV1 = after.value.snapshot.work.find((row) =>
        row.id === original.id
      )!;
      assert.equal(work.nextStep, "blocked");
      assert.deepEqual({
        ...work,
        nextStep: original.nextStep,
        blocker: original.blocker,
        wait: original.wait,
        updatedAt: original.updatedAt,
      }, original);
      const charge: ReturnType<typeof reservation> = after.value.snapshot
        .reservations.find((row) => row.id === f.charges[i].id)!;
      assert.equal(charge.outcome, "ambiguous");
      assert.deepEqual({
        ...charge,
        outcome: f.charges[i].outcome,
        settledAt: null,
      }, f.charges[i]);
    }
    const prepared = await runHostedSupervisorPrepare({
      state: f.release,
      clock: f.clock,
      run: { runId: 74, runAttempt: 1, launcherSha: f.current.launcherSha },
      evidence: {
        ...f.evidence,
        readExecution: f.reader.readHostedExecution.bind(f.reader),
      },
    });
    assert.equal(prepared.status, "run", JSON.stringify(prepared));
    const replaced = await f.release.readRelease();
    assert(replaced.ok && replaced.value.status === "found");
    assert.equal(
      replaced.value.snapshot.hostedRuntimes[0].lastExecutionProof?.execution
        .id,
      "73:1:repair",
    );
    assert.deepEqual(await f.rig.state.readRepair(), after);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("historical release witness: refusal and partial CAS retry preserve exact charged custody", async () => {
  for (
    const fault of [
      "active",
      "pin",
      "native",
      "missing",
      "outage",
      "drift",
      "cas",
    ]
  ) {
    const f = await historicalWithNewerCurrent(
      fault === "active" ? "pending" : "settled",
      true,
    );
    const previousCwd = Deno.cwd();
    Deno.chdir(f.checkout);
    try {
      if (fault === "missing" || fault === "outage") f.setFault(fault);
      const proof = f.witness.snapshot.hostedRuntimes[0].lastExecutionProof!;
      assert(proof.outcome !== "not_started");
      const deps = createHostedHistoricalMatrixQuarantine({
        state: f.rig.state,
        clock: f.clock,
        token: "offline-native-token",
        artifactRoot: `${f.rig.tmp}/refusal-artifacts`,
        http: f.currentHttp,
        artifactHttp: f.currentHttp,
        historicalReleaseWitnesses: [{
          commit: f.witness.head,
          executionId: proof.execution.id,
          logDigest: fault === "pin" ? "a".repeat(64) : proof.logDigest,
          reservationIds: f.charges.slice(0, 17).map((row) => row.id),
        }],
      });
      const originalWrite = f.rig.state.writeRepair;
      if (fault === "native") {
        const read = deps.readExecution;
        deps.readExecution = async (execution) => {
          const result = await read(execution);
          return execution.id === proof.execution.id && result.ok &&
              result.value !== null && result.value.outcome !== "not_started"
            ? portOk({ ...result.value, logDigest: "b".repeat(64) })
            : result;
        };
      }
      if (fault === "cas") {
        f.rig.state.writeRepair = (next, expected) =>
          next.work.some((row) => row.nextStep === "blocked")
            ? Promise.resolve(
              portOk({ status: "conflict", currentHead: expected }),
            )
            : originalWrite(next, expected);
      }
      if (fault === "drift") {
        const settle = deps.budget.settleModelStart.bind(deps.budget);
        deps.budget.settleModelStart = async (request) => {
          const result = await settle(request);
          const current = await f.release.readRelease();
          assert(current.ok && current.value.status === "found");
          const moved = await f.release.writeRelease({
            ...current.value.snapshot,
            stateHead: current.value.head,
            sequence: current.value.snapshot.sequence + 1,
            updatedAt: f.clock.now(),
            hostedRuntimes: current.value.snapshot.hostedRuntimes.map((
              row,
            ) => ({ ...row, nextOrdinaryAt: row.nextOrdinaryAt + 1 })),
          }, current.value.head);
          assert(moved.ok && moved.value.status === "applied");
          return result;
        };
      }
      const before = await f.rig.state.readRepair();
      await assert.rejects(
        () => runHistoricalMatrixQuarantine(deps),
        /historical matrix|matrix artifact/,
      );
      const after = await f.rig.state.readRepair();
      assert(after.ok && after.value.status === "found");
      assert(after.value.snapshot.work.every((row) => row.nextStep === "work"));
      if (fault === "cas" || fault === "drift") {
        assert.equal(after.value.snapshot.reservations[0].outcome, "ambiguous");
        if (fault === "cas") {
          f.rig.state.writeRepair = originalWrite;
          await assert.rejects(
            () => runHistoricalMatrixQuarantine(deps),
            /historical matrix native settlement unavailable/,
          );
          const retry = await f.rig.state.readRepair();
          assert(retry.ok && retry.value.status === "found");
          assert.equal(
            retry.value.snapshot.reservations[0].settledAt,
            after.value.snapshot.reservations[0].settledAt,
          );
        }
      } else assert.deepEqual(after, before);
    } finally {
      Deno.chdir(previousCwd);
      await Deno.remove(f.rig.tmp, { recursive: true });
    }
  }
});

Deno.test("historical newer current: unfinished foreign unavailable or drifting current cannot write", async () => {
  for (
    const mode of [
      "pending",
      "unavailable",
      "foreign",
      "wrong-job",
      "wrong-binding",
      "custody",
      "truncated",
      "duplicate",
      "old-proof-missing",
    ]
  ) {
    const f = await historicalWithNewerCurrent(mode);
    try {
      const before = await f.rig.state.readRepair();
      assert.equal(await f.runMain(), 1);
      assert.deepEqual(await f.rig.state.readRepair(), before);
      assert(!f.observed.includes(71));
      assert.equal(f.rig.merges, 0);
    } finally {
      await Deno.remove(f.rig.tmp, { recursive: true });
    }
  }
});
