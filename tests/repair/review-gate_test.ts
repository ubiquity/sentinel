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
import {
  authorizingReceipt,
  MERGE_WITHOUT_REVIEW_DETAIL,
  REVIEW_STEP_ATTACHMENT,
  reviewAuthorizesMerge,
} from "../../src/repair/review-gate.ts";
import {
  clearIntent,
  markBlocked,
  markTerminalBlocked,
} from "../../src/repair/transitions.ts";
import { reviewReceipt, SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";

const REVIEWER = "chatgpt-codex-connector[bot]";

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
    ...overrides,
  });
}

Deno.test("review gate: a completed exact-identity trusted receipt authorizes the merge", () => {
  const receipt = completedReceipt();
  assert.equal(reviewAuthorizesMerge(receipt, record(), REVIEWER), true);
  assert.equal(
    reviewAuthorizesMerge(receipt, record(), null),
    true,
    "no configured reviewer still checks the observed/expected binding",
  );
  assert.deepEqual(authorizingReceipt([receipt], record(), REVIEWER), receipt);
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
      reviewAuthorizesMerge(receipt, base, REVIEWER),
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
  assert.equal(reviewAuthorizesMerge(otherReviewer, base, REVIEWER), false);
  assert.equal(
    authorizingReceipt([completedReceipt(), otherReviewer], base, REVIEWER)
      ?.id,
    "rev-1",
    "the first authorizing receipt is selected",
  );
  assert.equal(
    authorizingReceipt([otherReviewer], base, REVIEWER),
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
