/**
 * m04-repair selection tests: the frozen plan priority order, WIP cap,
 * dependency and wait/terminal/blocked skipping, plus stable repo/source
 * tie-breaks. Pure functions only; no ports, no Git, no model calls.
 */
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  countUnfinishedPullRequests,
  isEligible,
  MAX_UNFINISHED_PRS,
  rankEligibleWork,
  RETIRED_MERGED_MESSAGE,
} from "../../src/repair/selection.ts";
import {
  applyHostedRetirements,
  HOSTED_AUTONOMY_RETIRED,
  planHostedRetirements,
} from "../../ops/hosted-autonomy.ts";
import { SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";
import { repairConfigs } from "./helpers.ts";

const NOW = T0 + 60_000;

function snapshot(
  work: WorkRecordV1[],
  extra: Partial<RepairStateSnapshotV1> = {},
): RepairStateSnapshotV1 {
  return {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work,
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    ...extra,
  };
}

function work(id: string, overrides: Record<string, unknown> = {}) {
  return workRecord(id, overrides);
}

Deno.test("selection: delivery bookkeeping outranks new incident work", () => {
  const delivery = work("issue-1", {
    nextStep: "delivery",
    target: { base: SHA1, branch: "b", checkpoint: null, head: SHA2, pr: 7 },
  });
  const incident = work("incident-2", {
    source: { kind: "incident", id: "inc-2", revision: SHA2 },
    related: { incidentId: "inc-2", issueNumber: null },
    fingerprint: "d".repeat(64),
    urgency: {
      activeProduction: true,
      reproducible5xx: false,
      severeSecurityOrDataLoss: false,
    },
  });
  const ranked = rankEligibleWork(
    snapshot([delivery, incident]),
    repairConfigs(),
    NOW,
  );
  assert.deepEqual(ranked.ordered, [delivery.id, incident.id]);
});

Deno.test("selection: delivery updates use numeric ordering across digit boundaries", () => {
  const updatedNine = work("delivery-9", {
    nextStep: "delivery",
    createdAt: 0,
    updatedAt: 9,
  });
  const updatedTen = work("delivery-10", {
    nextStep: "delivery",
    createdAt: 0,
    updatedAt: 10,
  });
  const ranked = rankEligibleWork(
    snapshot([updatedTen, updatedNine]),
    repairConfigs(),
    NOW,
  );
  assert.deepEqual(ranked.ordered, [updatedNine.id, updatedTen.id]);
});

Deno.test("selection: active incidents by severity then oldest first seen", () => {
  const p0 = work("incident-p0", {
    source: { kind: "incident", id: "p0", revision: SHA2 },
    related: { incidentId: "p0", issueNumber: null },
    fingerprint: "a".repeat(64),
    classification: { severity: "P0", priority: null },
    urgency: {
      activeProduction: true,
      reproducible5xx: false,
      severeSecurityOrDataLoss: false,
    },
    firstSeenAt: T0 + 100,
  });
  const p1 = work("incident-p1", {
    source: { kind: "incident", id: "p1", revision: SHA2 },
    related: { incidentId: "p1", issueNumber: null },
    fingerprint: "b".repeat(64),
    classification: { severity: "P1", priority: null },
    urgency: {
      activeProduction: true,
      reproducible5xx: false,
      severeSecurityOrDataLoss: false,
    },
    firstSeenAt: T0,
  });
  const ranked = rankEligibleWork(snapshot([p1, p0]), repairConfigs(), NOW);
  assert.deepEqual(ranked.ordered, [p0.id, p1.id]);
});

Deno.test("selection: P0/P1 correction ranks before reproducible 5xx and backlog", () => {
  const p1 = work("issue-p1", {
    source: { kind: "issue", id: "p1", revision: SHA2 },
    classification: { severity: "P1", priority: null },
    urgency: {
      activeProduction: false,
      reproducible5xx: false,
      severeSecurityOrDataLoss: false,
    },
  });
  const fivexx = work("issue-5xx", {
    source: { kind: "issue", id: "5xx", revision: SHA2 },
    classification: { severity: "P2", priority: null },
    urgency: {
      activeProduction: false,
      reproducible5xx: true,
      severeSecurityOrDataLoss: false,
    },
  });
  const backlog = work("issue-1", {
    source: { kind: "issue", id: "1", revision: SHA2 },
    classification: { severity: "P3", priority: 42 },
  });
  const ranked = rankEligibleWork(
    snapshot([backlog, fivexx, p1]),
    repairConfigs(),
    NOW,
  );
  assert.deepEqual(ranked.ordered, [p1.id, fivexx.id, backlog.id]);
});

Deno.test("selection: numeric priority descending, missing priority last", () => {
  const high = work("issue-7", {
    source: { kind: "issue", id: "7", revision: SHA2 },
    classification: { severity: "P2", priority: 7 },
    firstSeenAt: T0 + 200,
  });
  const low = work("issue-3", {
    source: { kind: "issue", id: "3", revision: SHA2 },
    classification: { severity: "P2", priority: 3 },
    firstSeenAt: T0,
  });
  const none = work("issue-0", {
    source: { kind: "issue", id: "0", revision: SHA2 },
    classification: { severity: "P2", priority: null },
    firstSeenAt: T0 + 50,
  });
  const ranked = rankEligibleWork(
    snapshot([none, low, high]),
    repairConfigs(),
    NOW,
  );
  assert.deepEqual(ranked.ordered, [high.id, low.id, none.id]);
});

Deno.test("selection: priority ordering supports contract-safe values above one million", () => {
  const maximum = work("issue-maximum", {
    classification: { severity: "P2", priority: Number.MAX_SAFE_INTEGER },
  });
  const aboveMillion = work("issue-1000002", {
    classification: { severity: "P2", priority: 1_000_002 },
  });
  const millionAndOne = work("issue-1000001", {
    classification: { severity: "P2", priority: 1_000_001 },
  });
  const minimum = work("issue-minimum", {
    classification: { severity: "P2", priority: 1 },
  });
  const none = work("issue-missing", {
    classification: { severity: "P2", priority: null },
  });
  const ranked = rankEligibleWork(
    snapshot([none, millionAndOne, maximum, minimum, aboveMillion]),
    repairConfigs(),
    NOW,
  );
  assert.deepEqual(ranked.ordered, [
    maximum.id,
    aboveMillion.id,
    millionAndOne.id,
    minimum.id,
    none.id,
  ]);
});

Deno.test("selection: stable repository/source tie-break, never selection by list order", () => {
  const a = work("issue-1", {
    source: { kind: "issue", id: "a", revision: SHA2 },
    classification: { severity: "P3", priority: 1 },
    firstSeenAt: T0,
  });
  const b = work("issue-2", {
    source: { kind: "issue", id: "b", revision: SHA2 },
    classification: { severity: "P3", priority: 1 },
    firstSeenAt: T0 + 1,
  });
  const ranked = rankEligibleWork(snapshot([b, a]), repairConfigs(), NOW);
  assert.deepEqual(ranked.ordered, [a.id, b.id]);
});

Deno.test("selection: waiting, blocked, terminal and dependency records are skipped", () => {
  const waiting = work("issue-9", {
    source: { kind: "issue", id: "9", revision: SHA2 },
    nextStep: "review",
    wait: { reason: "review_pending", since: T0, until: NOW + 1000 },
    target: { base: SHA1, branch: "b", checkpoint: null, head: SHA2, pr: 7 },
  });
  const blocked = work("issue-8", {
    source: { kind: "issue", id: "8", revision: SHA2 },
    nextStep: "blocked",
    blocker: {
      kind: "missing_evidence",
      message: "missing fixture",
      since: T0,
    },
  });
  const done = work("issue-7", {
    source: { kind: "issue", id: "7", revision: SHA2 },
    nextStep: "done",
  });
  const dependent = work("issue-6", {
    source: { kind: "issue", id: "6", revision: SHA2 },
    dependencies: ["issue-5"],
    classification: { severity: "P1", priority: null },
  });
  const eligible = work("issue-1", {
    source: { kind: "issue", id: "1", revision: SHA2 },
    classification: { severity: "P2", priority: 5 },
  });
  const ranked = rankEligibleWork(
    snapshot([waiting, blocked, done, dependent, eligible]),
    repairConfigs(),
    NOW,
  );
  assert.deepEqual(ranked.ordered, [eligible.id]);
  assert.equal(ranked.skipped[waiting.id], "waiting");
  assert.equal(ranked.skipped[blocked.id], "blocked");
  assert.equal(ranked.skipped[done.id], "terminal");
  assert.equal(ranked.skipped[dependent.id], "dependency");
});

Deno.test("selection: WIP cap skips fresh publications at three unfinished PRs", () => {
  const fresh = work("issue-1", {
    source: { kind: "issue", id: "1", revision: SHA2 },
    classification: { severity: "P2", priority: 9 },
  });
  const prs = Array.from(
    { length: MAX_UNFINISHED_PRS },
    (_, index) =>
      work(`issue-${index + 10}`, {
        source: { kind: "issue", id: `${index + 10}`, revision: SHA2 },
        nextStep: "review",
        wait: { reason: "review_pending", since: T0, until: NOW + 100000 },
        target: {
          base: SHA1,
          branch: "b",
          checkpoint: null,
          head: SHA2 as GitSha,
          pr: index + 20,
        },
      }),
  );
  const ranked = rankEligibleWork(
    snapshot([fresh, ...prs]),
    repairConfigs(),
    NOW,
  );
  assert.deepEqual(ranked.ordered, []);
  assert.equal(ranked.skipped[fresh.id], "wip");
});

Deno.test("selection: an existing-PR correction is never WIP-skipped", () => {
  const correction = work("issue-1", {
    source: { kind: "issue", id: "1", revision: SHA2 },
    classification: { severity: "P2", priority: 9 },
    nextStep: "work",
    target: {
      base: SHA1,
      branch: "b",
      checkpoint: null,
      head: SHA2 as GitSha,
      pr: 7,
    },
  });
  const prs = Array.from(
    { length: MAX_UNFINISHED_PRS },
    (_, index) =>
      work(`issue-${index + 10}`, {
        source: { kind: "issue", id: `${index + 10}`, revision: SHA2 },
        nextStep: "review",
        wait: { reason: "review_pending", since: T0, until: NOW + 100000 },
        target: {
          base: SHA1,
          branch: "b",
          checkpoint: null,
          head: SHA2 as GitSha,
          pr: index + 20,
        },
      }),
  );
  const ranked = rankEligibleWork(
    snapshot([correction, ...prs]),
    repairConfigs(),
    NOW,
  );
  assert.deepEqual(
    ranked.ordered,
    [correction.id],
    "the correction of an already-owned PR remains eligible at the cap",
  );
  assert.equal(ranked.skipped[correction.id], undefined);
});

// ---------------------------------------------------------------------------
// M15 V1 candidate state: candidate presence alone never excludes a record.
// WIP, dependency, terminal/blocked and wait rules still apply to candidates.
// ---------------------------------------------------------------------------

const CANDIDATE_REF = `refs/heads/sentinel-candidates/${"ab".repeat(32)}`;
const PRODUCING_RESERVATION = "cd".repeat(32);

function candidateStateFor(
  base: GitSha,
  head: GitSha | null,
): Record<string, unknown> {
  return head === null ? { preserved: null, publishedHead: null } : {
    preserved: {
      operationKey: `impl:${PRODUCING_RESERVATION}`,
      base,
      head,
      ref: CANDIDATE_REF,
    },
    publishedHead: head,
  };
}

function candidateTarget(
  head: GitSha | null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    base: SHA1,
    branch: "sentinel/repair/candidate",
    checkpoint: null,
    head,
    pr: head === null ? null : 7,
    candidateState: candidateStateFor(SHA1, head),
    ...overrides,
  };
}

function candidateWork(id: string, overrides: Record<string, unknown> = {}) {
  return workRecord(id, {
    source: { kind: "issue", id, revision: SHA2 },
    related: { incidentId: null, issueNumber: 1 },
    ...overrides,
  });
}

Deno.test("selection: candidate state alone never excludes an eligible record", () => {
  const workPhase = candidateWork("candidate-work", {
    nextStep: "work",
    target: candidateTarget(SHA2),
  });
  const reviewElapsed = candidateWork("candidate-review", {
    nextStep: "review",
    wait: { reason: "review_pending", since: T0, until: NOW - 1 },
    target: candidateTarget(SHA2, { pr: 8 }),
  });
  const delivery = candidateWork("candidate-delivery", {
    nextStep: "delivery",
    target: candidateTarget(SHA2, { pr: 9 }),
  });
  // A null-preserved descriptor is not "no candidate state": the record is a
  // normal eligible record and its lifecycle step performs the safe deferral.
  const nullPreserved = candidateWork("candidate-null", {
    nextStep: "work",
    target: candidateTarget(SHA2, {
      branch: "sentinel/repair/candidate-null",
      pr: 11,
      candidateState: { preserved: null, publishedHead: null },
    }),
  });
  const legacy = workRecord("legacy", {
    classification: { severity: "P2", priority: 5 },
    target: { base: SHA1, branch: "b", checkpoint: null, head: SHA2, pr: 10 },
  });
  const records = [workPhase, reviewElapsed, delivery, nullPreserved, legacy];
  const snap = snapshot(records);
  const ranked = rankEligibleWork(snap, repairConfigs(), NOW);
  assert.equal(ranked.ordered.length, records.length);
  for (const record of records) {
    assert.equal(ranked.skipped[record.id], undefined, record.id);
    assert.equal(isEligible(record, snap, NOW), true, record.id);
    assert.ok(ranked.ordered.includes(record.id), record.id);
  }
});

Deno.test("selection: candidate records still obey WIP, dependency, wait and terminal rules", () => {
  const candidatePrs = Array.from(
    { length: MAX_UNFINISHED_PRS },
    (_, index) =>
      candidateWork(`candidate-pr-${index}`, {
        source: { kind: "issue", id: `p${index}`, revision: SHA2 },
        related: { incidentId: null, issueNumber: 10 + index },
        nextStep: "review",
        wait: { reason: "review_pending", since: T0, until: NOW + 100000 },
        target: candidateTarget(SHA2, { pr: 20 + index }),
      }),
  );
  const fresh = workRecord("fresh", {
    classification: { severity: "P2", priority: 9 },
  });
  const dependent = workRecord("dependent", {
    dependencies: ["candidate-pr-0"],
    classification: { severity: "P1", priority: null },
  });
  const waiting = candidateWork("candidate-waiting", {
    nextStep: "work",
    wait: { reason: "unavailable", since: T0, until: NOW + 1000 },
    target: candidateTarget(SHA2, { pr: 30 }),
  });
  const done = candidateWork("candidate-done", {
    nextStep: "done",
    target: candidateTarget(SHA2, { pr: 31 }),
  });
  const blocked = candidateWork("candidate-blocked", {
    nextStep: "blocked",
    blocker: { kind: "missing_evidence", message: "blocked", since: T0 },
    target: candidateTarget(null, {
      branch: "sentinel/repair/candidate-blocked",
    }),
  });
  const snap = snapshot([
    ...candidatePrs,
    fresh,
    dependent,
    waiting,
    done,
    blocked,
  ]);
  const ranked = rankEligibleWork(snap, repairConfigs(), NOW);
  assert.deepEqual(ranked.ordered, []);
  for (const record of candidatePrs) {
    assert.equal(ranked.skipped[record.id], "waiting", record.id);
  }
  assert.equal(
    ranked.skipped[fresh.id],
    "wip",
    "three unfinished candidate PRs still occupy the cap",
  );
  assert.equal(
    ranked.skipped[dependent.id],
    "dependency",
    "an unfinished candidate dependency still gates its dependent",
  );
  assert.equal(ranked.skipped[waiting.id], "waiting");
  assert.equal(ranked.skipped[done.id], "terminal");
  assert.equal(ranked.skipped[blocked.id], "blocked");
});

// ---------------------------------------------------------------------------
// Retired PR WIP: the EXACT hosted retirement disposition — source issue
// closed, pull request definitively closed unmerged, parked by
// applyHostedRetirements with kind `other`, the static retirement message and
// intent/wait cleared — no longer occupies one of the three unfinished-PR
// slots. Every other blocked, open or waiting pull request still does.
// ---------------------------------------------------------------------------

const RETIRED_ISSUES = new Set([120, 61]);

function prRecord(
  id: string,
  issueNumber: number,
  pr: number,
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return work(id, {
    source: { kind: "issue", id: String(issueNumber), revision: SHA2 },
    related: { incidentId: null, issueNumber },
    classification: { severity: "P2", priority: 9 },
    target: {
      base: SHA1,
      branch: `sentinel/repair/${id}`,
      checkpoint: null,
      head: SHA2,
      pr,
    },
    nextStep: "review",
    wait: { reason: "review_pending", since: T0, until: T0 + 3_600_000 },
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    ...overrides,
  });
}

function freshIssue(id: string, issueNumber: number): WorkRecordV1 {
  return work(id, {
    source: { kind: "issue", id: String(issueNumber), revision: SHA2 },
    related: { incidentId: null, issueNumber },
    classification: { severity: "P2", priority: 9 },
  });
}

Deno.test(
  "retired PR WIP: exact retirements stop consuming the cap while a merged unaccepted PR still does",
  () => {
    const ai120 = prRecord("issue-ubiquity-ai.ubq.fi-120", 120, 375);
    const sentinel61 = prRecord("issue-ubiquity-sentinel-61", 61, 63);
    // ai#264 / PR393: human-merged but unaccepted, so it is NOT the retirement
    // disposition and must keep occupying its slot.
    const humanMerged264 = prRecord(
      "issue-ubiquity-ai.ubq.fi-264",
      264,
      393,
      { nextStep: "delivery" },
    );
    const fresh = freshIssue("issue-ubiquity-ai.ubq.fi-999", 999);
    const initial = snapshot([ai120, sentinel61, humanMerged264, fresh]);
    const plans = planHostedRetirements(
      initial,
      RETIRED_ISSUES,
      new Set([ai120.id, sentinel61.id]),
    );
    assert.deepEqual(
      plans.map((plan) => plan.id).sort(),
      [ai120.id, sentinel61.id].sort(),
      "both closed-unmerged PRs are retired by the actual helper",
    );
    const retired = applyHostedRetirements(initial, SHA1, plans, NOW);
    for (const id of [ai120.id, sentinel61.id]) {
      const record = retired.work.find((item) => item.id === id);
      assert.ok(record, id);
      assert.equal(record.nextStep, "blocked");
      assert.equal(record.blocker?.kind, "other");
      assert.equal(record.blocker?.message, HOSTED_AUTONOMY_RETIRED);
      assert.equal(record.wait, null);
      assert.equal(record.intent, null);
      assert.equal(record.target.pr !== null, true, `${id} retains its PR`);
      assert.equal(record.target.head, SHA2, `${id} retains its head`);
      assert.equal(record.counters.reviewRounds, 1, `${id} keeps its counters`);
    }
    const ranked = rankEligibleWork(retired, repairConfigs(), NOW);
    // Two retired PRs plus one real unfinished PR is two counted slots, so the
    // fresh issue is admitted. Before the fix the count is three and this is [].
    assert.deepEqual(ranked.ordered, [fresh.id]);
    assert.equal(ranked.skipped[fresh.id], undefined);
    assert.equal(ranked.skipped[ai120.id], "blocked");
    assert.equal(ranked.skipped[sentinel61.id], "blocked");
    assert.equal(ranked.skipped[humanMerged264.id], "waiting");
  },
);

Deno.test(
  "retired PR WIP: arbitrary blocked, open and waiting PRs still consume the cap",
  () => {
    const genericBlocked = prRecord(
      "issue-ubiquity-ai.ubq.fi-301",
      301,
      401,
      {
        nextStep: "blocked",
        wait: null,
        blocker: {
          kind: "other",
          message: "model run ended without a trusted receipt",
          since: T0,
        },
      },
    );
    const unavailableBlocked = prRecord(
      "issue-ubiquity-ai.ubq.fi-302",
      302,
      402,
      {
        nextStep: "blocked",
        wait: null,
        blocker: {
          kind: "unavailable",
          message: "review transport unavailable",
          since: T0,
        },
      },
    );
    const openWaiting = prRecord("issue-ubiquity-ai.ubq.fi-303", 303, 403);
    const fresh = freshIssue("issue-ubiquity-ai.ubq.fi-999", 999);
    const ranked = rankEligibleWork(
      snapshot([genericBlocked, unavailableBlocked, openWaiting, fresh]),
      repairConfigs(),
      NOW,
    );
    assert.deepEqual(ranked.ordered, []);
    assert.equal(ranked.skipped[fresh.id], "wip");
    assert.equal(ranked.skipped[genericBlocked.id], "blocked");
    assert.equal(ranked.skipped[unavailableBlocked.id], "blocked");
    assert.equal(ranked.skipped[openWaiting.id], "waiting");
  },
);

Deno.test(
  "selection: a repair whose own PR was merged outside the trusted path stops consuming the WIP cap",
  () => {
    const merged = work("issue-77", {
      target: {
        base: SHA1,
        branch: "sentinel/repair/issue-77",
        checkpoint: null,
        head: SHA2,
        pr: 7,
      },
      nextStep: "blocked",
      blocker: { kind: "other", message: RETIRED_MERGED_MESSAGE, since: T0 },
      intent: null,
      wait: null,
    });
    assert.equal(countUnfinishedPullRequests([merged]), 0);
    // Control: the identical record with only its durable blocker message
    // changed still consumes one slot.
    const open = work("issue-78", {
      target: {
        base: SHA1,
        branch: "sentinel/repair/issue-78",
        checkpoint: null,
        head: SHA2,
        pr: 8,
      },
      nextStep: "blocked",
      blocker: { kind: "other", message: "some other refusal", since: T0 },
      intent: null,
      wait: null,
    });
    assert.equal(countUnfinishedPullRequests([open]), 1);
    assert.equal(countUnfinishedPullRequests([merged, open]), 1);
  },
);

/** Backlog record with an exact age, so oldest-first ordering is explicit. */
function agedIssue(
  id: string,
  issueNumber: number,
  firstSeenAt: number,
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return work(id, {
    source: { kind: "issue", id: String(issueNumber), revision: SHA2 },
    related: { incidentId: null, issueNumber },
    classification: { severity: "P2", priority: 9 },
    firstSeenAt,
    createdAt: firstSeenAt,
    counters: { attempts: 0, retries: 0, reviewRounds: 0 },
    ...overrides,
  });
}

/**
 * The documented per-record no-progress budget. Pinned as a literal so this
 * case can be run against a revision without the budget and fail on ORDERING
 * (a setup/import error would prove nothing).
 */
const BUDGET = 3;

Deno.test(
  "no-progress budget: a stalled oldest record yields to a younger record that advanced",
  () => {
    const older = agedIssue("issue-1", 1, T0 - 900_000, {
      counters: {
        attempts: 0,
        retries: 0,
        reviewRounds: 0,
        stalled: BUDGET,
      },
    });
    const younger = agedIssue("issue-2", 2, T0 - 60_000);
    const ranked = rankEligibleWork(
      snapshot([older, younger]),
      repairConfigs(),
      NOW,
    );
    assert.deepEqual(ranked.ordered, [younger.id, older.id]);
    assert.equal(
      ranked.skipped[older.id],
      undefined,
      "demotion is ordering, never a skip",
    );

    // Boundary: one execution under the budget keeps the oldest-first order,
    // so the budget is a bound and not a blanket reordering.
    const withinBudget = agedIssue("issue-1", 1, T0 - 900_000, {
      counters: {
        attempts: 0,
        retries: 0,
        reviewRounds: 0,
        stalled: BUDGET - 1,
      },
    });
    const bounded = rankEligibleWork(
      snapshot([withinBudget, younger]),
      repairConfigs(),
      NOW,
    );
    assert.deepEqual(bounded.ordered, [withinBudget.id, younger.id]);
  },
);

Deno.test(
  "no-progress budget: demotion never crosses a plan bucket",
  () => {
    const stalledDelivery = prRecord("issue-1", 1, 7, {
      nextStep: "delivery",
      wait: null,
      counters: {
        attempts: 1,
        retries: 0,
        reviewRounds: 1,
        stalled: BUDGET + 4,
      },
    });
    const advancing = agedIssue("issue-2", 2, T0 - 60_000);
    const ranked = rankEligibleWork(
      snapshot([stalledDelivery, advancing]),
      repairConfigs(),
      NOW,
    );
    assert.deepEqual(
      ranked.ordered,
      [stalledDelivery.id, advancing.id],
      "delivery bookkeeping stays ahead of new work even when demoted",
    );
  },
);
