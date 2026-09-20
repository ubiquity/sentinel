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
  applyHostedRetirements,
  applyHostedRetries,
  buildHostedReleaseRequest,
  createHostedAutonomyGitHub,
  HOSTED_AUTONOMY_MAX_RETRIES,
  HOSTED_AUTONOMY_RETIRED,
  HOSTED_AUTONOMY_TRUSTED_AUTHORS,
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
    readIssueOpen: () => Promise.resolve(true),
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
  return { rig, github };
}

async function run(
  rig: RigV1,
  github: HostedAutonomyGitHubV1,
): Promise<HostedAutonomyResultV1> {
  return await runHostedAutonomy({
    state: rig.state,
    github,
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
    assert.equal(plans[0].resetReviewRounds, false);
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
    const plans = planHostedRetries(
      reviewRounds,
      T0 + 5000,
    );
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
    assert.equal(planHostedRetries(snapshot, now, BASE).length, 0);
    // With a newer base the runtime's own refresh gives fresh identities.
    const newerBase = SHA1;
    const plans = planHostedRetries(snapshot, now, newerBase);
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
    assert.equal(planHostedRetries(snapshot, T0 + 5000, SHA1).length, 0);
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
      planHostedRetries(snapshot, T0 + 5000, null, new Set([48])).length,
      0,
    );
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
      planHostedRetirements(snapshot, new Set([48])),
      [{ id: TARGET, issueNumber: 48 }],
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
    assert.deepEqual(planHostedRetirements(snapshot, new Set([61])), []);
    assert.deepEqual(
      planHostedRetirements(snapshot, new Set([61]), new Set([ZOMBIE])),
      [{ id: ZOMBIE, issueNumber: 61 }],
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
        new Set([61]),
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
      planHostedRetirements(snapshot, new Set([61]), new Set([ZOMBIE])),
      [{ id: ZOMBIE, issueNumber: 61 }],
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
      planHostedRetirements(settled, new Set([61]), new Set([ZOMBIE])),
      [{ id: ZOMBIE, issueNumber: 61 }],
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
      planHostedRetirements(reserved, new Set([61]), new Set([ZOMBIE])),
      [],
    );

    // No matching reservation at all is not settled either.
    const missing = repairSnapshot([zombieRecord({ intent: zombieIntent() })]);
    assert.deepEqual(
      planHostedRetirements(missing, new Set([61]), new Set([ZOMBIE])),
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
      planHostedRetirements(refreshing, new Set([61]), new Set([ZOMBIE])),
      [{ id: ZOMBIE, issueNumber: 61 }],
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
      const github = createHostedAutonomyGitHub("fixture-token");
      const unmerged = await github.readPull(63);
      assert.equal(unmerged?.state, "open");
      assert.equal(unmerged?.merged, false);
      assert.equal(unmerged?.mergeCommitSha, null);
      assert.equal(unmerged?.headSha, HEAD);
      assert.equal(unmerged?.baseRef, "development");
      assert.equal(unmerged?.author, "github-actions[bot]");
      assert.equal(requests.length, 1);

      const afterMerge = await github.readPull(51);
      if (afterMerge === null) throw new Error("merged pull unreadable");
      assert.equal(afterMerge.merged, true);
      assert.equal(afterMerge.mergeCommitSha, MERGE);
      assert.deepEqual([...afterMerge.parents], [BASE, HEAD]);
      assert.equal(afterMerge.revisionOnBaseBranch, true);
      assert.equal(requests.length, 4);
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
    const plans = planHostedRetries(snapshot, T0 + 5000, newerBase);
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
    assert.equal(planHostedRetries(earlier, T0 + 5000, SHA1).length, 1);
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
    assert.equal(planHostedRetries(spent, T0 + 5000, SHA1).length, 0);
    assert.equal(planHostedRetries(spent, T0 + 5000, BASE).length, 0);
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

    // A reserved review_request is the one identity the review step still
    // reconciles, so it stays eligible exactly as before.
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
    const reviewPlans = planHostedRetries(reviewSnapshot, T0 + 5000);
    assert.equal(reviewPlans.length, 1);
    assert.equal(reviewPlans[0].nextStep, "review");
    assert.equal(reviewPlans[0].grant, 0);
    assert.equal(reviewPlans[0].resetReviewRounds, true);
    const reviewNext = applyHostedRetries(
      reviewSnapshot,
      SHA1,
      reviewPlans,
      T0 + 5000,
    ).work[0];
    assert.equal(reviewNext.counters.reviewRounds, 0);
    assert.equal(reviewNext.counters.attempts, 1);
    assert.equal(reviewNext.counters.retries, 0);
  },
);
