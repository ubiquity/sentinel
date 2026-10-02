/**
 * m04-repair: the HARD merge invariant, the pluggable review-step anchor and
 * the terminal-block transition semantics.
 *
 * The merge gate must refuse every receipt that is not a completed,
 * exact-identity, trusted, P0/P1-free authorization for the record's current
 * published head. The terminal-block transition must clear a dead publication
 * identity (stale `target.pr` and any residual non-construction intent) while
 * preserving the candidate head/base/branch and counters.
 */
import assert from "node:assert/strict";

import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { ReviewTaskStatementV1 } from "../../src/contracts/review-receipt.ts";
import {
  authorizingReceipt,
  MERGE_WITHOUT_REVIEW_DETAIL,
  REVIEW_STEP_ATTACHMENT,
  reviewAuthorizesMerge,
  TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL,
  TASK_ACCEPTANCE_CONTEXT_DETAIL,
  TASK_ACCEPTANCE_DIGEST_DETAIL,
  TASK_ACCEPTANCE_MISMATCH_DETAIL,
  TASK_ACCEPTANCE_MISSING_DETAIL,
  TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL,
  TASK_ACCEPTANCE_UNCERTAIN_DETAIL,
  taskAcceptanceRefusal,
} from "../../src/repair/review-gate.ts";
import {
  clearIntent,
  markBlocked,
  markTerminalBlocked,
} from "../../src/repair/transitions.ts";
import { reviewReceipt, SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";

const REVIEWER = "chatgpt-codex-connector[bot]";

/**
 * The TRUSTED live task statement independently read at authorization time.
 * Authorization compares the receipt's acceptance digest against THIS digest,
 * never against a digest the model echoed back.
 */
const TRUSTED_TASK: ReviewTaskStatementV1 = {
  issueNumber: 1,
  title: "start the service with the selected release configuration",
  body: "load the selected release config, import map, lockfile and launcher",
  digest: "b".repeat(64),
};

function record(overrides: Partial<WorkRecordV1> = {}): WorkRecordV1 {
  return workRecord("issue-12", {
    target: {
      base: SHA2,
      branch: "sentinel/repair/issue-12",
      checkpoint: null,
      head: SHA1,
      pr: 12,
    },
    nextStep: "delivery",
    ...overrides,
  });
}

function completedReceipt(
  overrides: Record<string, unknown> = {},
): ReturnType<typeof reviewReceipt> {
  return reviewReceipt("rev-1", {
    expectedReviewer: REVIEWER,
    observedReviewer: REVIEWER,
    outcome: "completed",
    resultId: "result-1",
    completedAt: T0 + 2000,
    pullRequest: { number: 12, head: SHA1, base: SHA2 },
    // The record's source issue is #1: a completed verdict without this
    // positive, exactly bound acceptance is never task completion.
    taskAcceptance: fulfilledAcceptance(1),
    ...overrides,
  });
}

/** The reviewer's positive acceptance of one exact source issue. */
function fulfilledAcceptance(
  issueNumber: number,
  taskDigest = TRUSTED_TASK.digest,
) {
  return {
    issueNumber,
    taskDigest,
    verdict: "fulfilled" as const,
    evidence: ["the exact candidate change satisfies the source issue"],
  };
}

Deno.test("review gate: a completed exact-identity trusted receipt authorizes the merge", () => {
  const receipt = completedReceipt();
  assert.equal(
    reviewAuthorizesMerge(receipt, record(), REVIEWER, TRUSTED_TASK),
    true,
  );
  assert.equal(
    reviewAuthorizesMerge(receipt, record(), null, TRUSTED_TASK),
    true,
    "no configured reviewer still checks the observed/expected binding",
  );
  assert.deepEqual(
    authorizingReceipt([receipt], record(), REVIEWER, TRUSTED_TASK),
    receipt,
  );
  // Omitting the trusted statement (or supplying an unreadable one) fails
  // closed for an issue-backed record.
  assert.equal(reviewAuthorizesMerge(receipt, record(), REVIEWER), false);
  assert.equal(
    reviewAuthorizesMerge(receipt, record(), REVIEWER, "unavailable"),
    false,
  );
});

function finding(
  severity: "P0" | "P1" | "P3",
): {
  id: string;
  severity: "P0" | "P1" | "P3";
  path: null;
  message: string;
  fingerprint: string;
  resolved: false;
  resolutionEvidence: null;
} {
  return {
    id: `f-${severity}`,
    severity,
    path: null,
    message: `${severity} finding`,
    fingerprint: "e".repeat(64),
    resolved: false,
    resolutionEvidence: null,
  };
}

Deno.test("review gate: an issue-backed delivery requires the exact bound positive acceptance", () => {
  const base = record();
  const cases: [string, ReturnType<typeof reviewReceipt>, string][] = [
    [
      "legacy change-only receipt",
      completedReceipt({ taskAcceptance: undefined }),
      TASK_ACCEPTANCE_MISSING_DETAIL,
    ],
    [
      "explicit null acceptance (legacy decode)",
      completedReceipt({ taskAcceptance: null }),
      TASK_ACCEPTANCE_MISSING_DETAIL,
    ],
    [
      "acceptance for another issue",
      completedReceipt({ taskAcceptance: fulfilledAcceptance(2) }),
      TASK_ACCEPTANCE_MISMATCH_DETAIL,
    ],
    [
      // Same issue, same head, but judged against DIFFERENT issue text: the
      // trusted live digest is what authorizes, never the echoed copy.
      "same-issue acceptance against changed task text",
      completedReceipt({
        taskAcceptance: fulfilledAcceptance(1, "a".repeat(64)),
      }),
      TASK_ACCEPTANCE_DIGEST_DETAIL,
    ],
    [
      "explicitly not fulfilled",
      completedReceipt({
        taskAcceptance: {
          issueNumber: 1,
          taskDigest: TRUSTED_TASK.digest,
          verdict: "not_fulfilled",
          evidence: ["the changed file is unrelated to the task"],
        },
      }),
      TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL,
    ],
    [
      "already satisfied at base",
      completedReceipt({
        taskAcceptance: {
          issueNumber: 1,
          taskDigest: TRUSTED_TASK.digest,
          verdict: "already_satisfied_at_base",
          evidence: ["the base already implements the required behavior"],
        },
      }),
      TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL,
    ],
    [
      "uncertain",
      completedReceipt({
        taskAcceptance: {
          issueNumber: 1,
          taskDigest: TRUSTED_TASK.digest,
          verdict: "uncertain",
          evidence: [],
        },
      }),
      TASK_ACCEPTANCE_UNCERTAIN_DETAIL,
    ],
  ];
  for (const [label, receipt, detail] of cases) {
    assert.equal(
      taskAcceptanceRefusal(receipt, base, TRUSTED_TASK),
      detail,
      `${label} carries its exact static refusal`,
    );
    assert.equal(
      reviewAuthorizesMerge(receipt, base, REVIEWER, TRUSTED_TASK),
      false,
      `${label} never authorizes a merge`,
    );
  }
  // The persisted legacy shape decodes with the key ABSENT — injecting an
  // explicit null would change the record's canonical bytes — and an absent
  // field is not evidence of acceptance either.
  const absentAcceptance = completedReceipt({ taskAcceptance: undefined });
  assert.equal(
    Object.prototype.hasOwnProperty.call(absentAcceptance, "taskAcceptance"),
    false,
    "an absent legacy task acceptance must stay absent after decoding",
  );
  assert.equal(
    taskAcceptanceRefusal(absentAcceptance, base, TRUSTED_TASK),
    TASK_ACCEPTANCE_MISSING_DETAIL,
  );
  assert.equal(
    reviewAuthorizesMerge(absentAcceptance, base, REVIEWER, TRUSTED_TASK),
    false,
  );
  // An unreadable or wrong trusted context fails closed even for a receipt
  // whose own copied fields are internally consistent.
  for (
    const task of ["unavailable", null, {
      ...TRUSTED_TASK,
      issueNumber: 2,
    }] as const
  ) {
    assert.equal(
      taskAcceptanceRefusal(completedReceipt(), base, task),
      TASK_ACCEPTANCE_CONTEXT_DETAIL,
    );
    assert.equal(
      reviewAuthorizesMerge(completedReceipt(), base, REVIEWER, task),
      false,
    );
  }
  // The positive control: the same completed receipt WITH the bound fulfilled
  // acceptance authorizes, and the existing P0/P1 strength is untouched.
  assert.equal(
    taskAcceptanceRefusal(completedReceipt(), base, TRUSTED_TASK),
    null,
  );
  assert.equal(
    reviewAuthorizesMerge(completedReceipt(), base, REVIEWER, TRUSTED_TASK),
    true,
  );
  assert.equal(
    reviewAuthorizesMerge(
      completedReceipt({
        findings: [finding("P0")],
        unresolvedSeverities: ["P0"],
      }),
      base,
      REVIEWER,
      TRUSTED_TASK,
    ),
    false,
    "a positive acceptance never weakens the P0 gate",
  );
});

Deno.test("review gate: work without a source issue keeps the change-only contract", () => {
  const incident = record({
    source: { kind: "incident", id: "inc-1", revision: SHA1 },
    related: { incidentId: "inc-1", issueNumber: null },
    fingerprint: "d".repeat(64) as WorkRecordV1["fingerprint"],
  });
  assert.equal(incident.related.issueNumber, null);
  assert.equal(
    taskAcceptanceRefusal(
      completedReceipt({ taskAcceptance: undefined }),
      incident,
      null,
    ),
    null,
    "there is no issue acceptance to judge",
  );
  assert.equal(
    reviewAuthorizesMerge(
      completedReceipt({ taskAcceptance: undefined }),
      incident,
      REVIEWER,
      null,
    ),
    true,
  );
  // An acceptance for work with no source issue is an invented/unbound claim.
  assert.equal(
    taskAcceptanceRefusal(completedReceipt(), incident, null),
    "task acceptance present for work without a source issue",
  );
  assert.equal(
    reviewAuthorizesMerge(completedReceipt(), incident, REVIEWER, null),
    false,
  );
});

Deno.test("review gate: every non-authorizing receipt fails closed", () => {
  const base = record();
  const cases: [string, ReturnType<typeof reviewReceipt> | null][] = [
    ["absent", null],
    ["pending", reviewReceipt("rev-pending")],
    [
      "uncounted findings",
      completedReceipt({
        findings: [finding("P3")],
        unresolvedSeverities: ["P3"],
        findingsUncounted: 1,
      }),
    ],
    [
      "unresolved P0",
      completedReceipt({
        findings: [finding("P0")],
        unresolvedSeverities: ["P0"],
      }),
    ],
    [
      "unresolved P1",
      completedReceipt({
        findings: [finding("P1")],
        unresolvedSeverities: ["P1"],
      }),
    ],
    [
      "wrong head",
      completedReceipt({
        pullRequest: { number: 12, head: SHA2, base: SHA2 },
      }),
    ],
    [
      "wrong pr",
      completedReceipt({
        pullRequest: { number: 99, head: SHA1, base: SHA2 },
      }),
    ],
    [
      "wrong base",
      completedReceipt({
        pullRequest: { number: 12, head: SHA1, base: SHA1 },
      }),
    ],
  ];
  for (const [label, receipt] of cases) {
    assert.equal(
      reviewAuthorizesMerge(receipt, base, REVIEWER, TRUSTED_TASK),
      false,
      `${label} must not authorize`,
    );
  }
  // A receipt observed from a different reviewer than the adapter policy.
  const otherReviewer = reviewReceipt("rev-other", {
    expectedReviewer: "someone-else[bot]",
    observedReviewer: "someone-else[bot]",
    outcome: "completed",
    resultId: "result-x",
    completedAt: T0 + 2000,
    pullRequest: { number: 12, head: SHA1, base: SHA2 },
  });
  assert.equal(
    reviewAuthorizesMerge(otherReviewer, base, REVIEWER, TRUSTED_TASK),
    false,
  );
  assert.equal(
    authorizingReceipt(
      [completedReceipt(), otherReviewer],
      base,
      REVIEWER,
      TRUSTED_TASK,
    )?.id,
    "rev-1",
    "the first authorizing receipt is selected",
  );
  assert.equal(
    authorizingReceipt([otherReviewer], base, REVIEWER, TRUSTED_TASK),
    null,
    "no authorizing receipt means no merge",
  );
});

Deno.test("review gate: the pluggable CLI attachment point is documented and greppable", () => {
  assert.match(REVIEW_STEP_ATTACHMENT, /reviewer/);
  assert.equal(
    MERGE_WITHOUT_REVIEW_DETAIL,
    "merge without an accepted current-head review",
  );
});

Deno.test("terminal block clears the dead PR and residual intent but keeps the candidate", () => {
  const withResidual = workRecord("issue-12", {
    target: {
      base: SHA2,
      branch: "sentinel/repair/issue-12",
      checkpoint: null,
      head: SHA1,
      pr: 12,
    },
    nextStep: "review",
    intent: {
      kind: "review_request",
      key: `review:12:${SHA1}`,
      startedAt: T0,
      branch: "sentinel/repair/issue-12",
      expectedHead: SHA1,
      observedBase: SHA2,
      pr: 12,
      requestId: null,
      resultId: null,
    },
    counters: { attempts: 2, retries: 1, reviewRounds: 3 },
  });
  const terminal = markTerminalBlocked(
    withResidual,
    "unavailable",
    "review admission refused: disabled",
    T0 + 5000,
  );
  assert.equal(terminal.nextStep, "blocked");
  assert.equal(terminal.target.pr, null, "the stale PR is cleared");
  assert.equal(terminal.intent, null, "the residual intent is cleared");
  assert.equal(terminal.target.head, SHA1, "the candidate head is retained");
  assert.equal(terminal.target.base, SHA2, "the candidate base is retained");
  assert.equal(
    terminal.target.branch,
    "sentinel/repair/issue-12",
    "the deterministic branch is retained",
  );
  assert.deepEqual(terminal.counters, {
    attempts: 2,
    retries: 1,
    reviewRounds: 3,
  });
});

Deno.test("ordinary block retains a residual review intent; clearing it is explicit", () => {
  const withResidual = workRecord("issue-12", {
    target: {
      base: SHA2,
      branch: "sentinel/repair/issue-12",
      checkpoint: null,
      head: SHA1,
      pr: 12,
    },
    nextStep: "review",
    intent: {
      kind: "review_request",
      key: `review:12:${SHA1}`,
      startedAt: T0,
      branch: "sentinel/repair/issue-12",
      expectedHead: SHA1,
      observedBase: SHA2,
      pr: 12,
      requestId: null,
      resultId: null,
    },
  });
  const blocked = markBlocked(
    withResidual,
    "unavailable",
    "review wait",
    T0 + 1,
  );
  assert.equal(blocked.nextStep, "blocked");
  assert.equal(
    blocked.target.pr,
    12,
    "the publication identity is retained for a retryable/infrastructure block",
  );
  assert.equal(
    blocked.intent?.kind,
    "review_request",
    "a plain block preserves the residual intent (the legacy-loss bridge depends on it)",
  );
  // The review-round-exhausted terminal path clears the dead request explicitly
  // while keeping the published PR for supervisor delivery / one fresh grant.
  const exhausted = markBlocked(
    clearIntent(withResidual, T0 + 1),
    "review_quota",
    "review rounds exhausted",
    T0 + 1,
  );
  assert.equal(exhausted.target.pr, 12, "the published PR is retained");
  assert.equal(exhausted.intent, null, "the dead review request is cleared");
});
