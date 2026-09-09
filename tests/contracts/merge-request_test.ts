// MergeRequestV1 parser tests: a valid completed receipt binds the exact
// PR/head/base with zero uncounted findings and no unresolved P0/P1; any
// unknown/missing field, stale/pending/unavailable/mismatched review,
// repository or reviewer policy mismatch, uncounted finding or unresolved
// P0/P1 fails closed. The parser never grants authority by itself.
import assert from "node:assert/strict";

import {
  parseMergeRequestV1,
  parseReviewReceiptV1,
  RecordParseError,
} from "../../src/contracts/mod.ts";
import type {
  MergeRequestPolicyV1,
  MergeRequestV1,
} from "../../src/contracts/mod.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/mod.ts";

const HEAD = "aafb7ee0598699bb7fb8a72ea133693ed64462da";
const BASE = "aafb7ee0598699bb7fb8a72ea133693ed64462da";
const OTHER_SHA = "6dc35d06e757107b91eb58232bd15e5f671d79b4";
const REVIEWER = "chatgpt-codex-connector[bot]";
const FINGERPRINT = "d".repeat(64);

const POLICY: MergeRequestPolicyV1 = {
  repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 7 },
  expectedReviewer: REVIEWER,
};

/** Completed review parsed through the frozen review parser. */
function completedReceipt(
  overrides: Record<string, unknown> = {},
): ReviewReceiptV1 {
  return parseReviewReceiptV1({
    version: "v1",
    kind: "review_receipt",
    id: "review-1",
    requestId: "req-1",
    expectedReviewer: REVIEWER,
    observedReviewer: REVIEWER,
    repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 7 },
    pullRequest: { number: 12, head: HEAD, base: BASE },
    outcome: "completed",
    resultId: "result-1",
    summary: null,
    findings: [],
    findingsUncounted: 0,
    unresolvedSeverities: [],
    submittedAt: 1786000000000,
    completedAt: 1786000001000,
    observedAt: 1786000002000,
    ...overrides,
  });
}

/** Valid merge request input plus the completed receipt. */
function validRequest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    pullRequestNumber: 12,
    expectedHead: HEAD,
    expectedBase: BASE,
    review: completedReceipt(),
    ...overrides,
  };
}

/** Raw merge request input with a receipt carrying fresh overrides (unparsed). */
function requestWithReview(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return validRequest({ review: completedReceipt(overrides) });
}

function expectParseFailure(
  input: unknown,
  policy: MergeRequestPolicyV1,
  pattern: { code?: string; path?: string; message?: RegExp },
): void {
  try {
    parseMergeRequestV1(input, policy);
  } catch (error) {
    assert.ok(error instanceof RecordParseError, "expected RecordParseError");
    const issue = error.issues[0];
    assert.ok(issue, "expected at least one issue");
    if (pattern.code !== undefined) assert.equal(issue.code, pattern.code);
    if (pattern.path !== undefined) assert.equal(issue.path, pattern.path);
    if (pattern.message !== undefined) {
      assert.match(issue.message, pattern.message);
    }
    return;
  }
  assert.fail("expected the parser to reject the input");
}

Deno.test("merge request: valid completed receipt with exact PR/head/base parses", () => {
  const parsed: MergeRequestV1 = parseMergeRequestV1(validRequest(), POLICY);
  assert.equal(parsed.pullRequestNumber, 12);
  assert.equal(parsed.expectedHead, HEAD);
  assert.equal(parsed.expectedBase, BASE);
  assert.equal(parsed.review.outcome, "completed");
  assert.equal(parsed.review.observedReviewer, REVIEWER);
  assert.equal(parsed.review.resultId, "result-1");
  assert.equal(parsed.review.findingsUncounted, 0);
  assert.deepEqual(parsed.review.unresolvedSeverities, []);
  // The parsed record is itself strict-parseable (stable shape).
  assert.equal(
    parseMergeRequestV1(parsed, POLICY).pullRequestNumber,
    12,
  );
});

Deno.test("merge request: unresolved P2/P3 findings do not block merge", () => {
  const parsed = parseMergeRequestV1(
    requestWithReview({
      findings: [{
        id: "f1",
        severity: "P3",
        path: "src/main.ts",
        message: "minor note",
        fingerprint: FINGERPRINT,
        resolved: false,
        resolutionEvidence: null,
      }, {
        id: "f2",
        severity: "P2",
        path: null,
        message: "resolved suggestion",
        fingerprint: "e".repeat(64),
        resolved: true,
        resolutionEvidence: {
          authorizingIdentity: "trusted-human",
          reference: "artifact://dispute/f2",
        },
      }],
      unresolvedSeverities: ["P3"],
    }),
    POLICY,
  );
  assert.equal(parsed.review.findings.length, 2);
  assert.deepEqual(parsed.review.unresolvedSeverities, ["P3"]);
});

Deno.test("merge request: unknown or missing fields are rejected", () => {
  expectParseFailure(validRequest({ extra: "x" }), POLICY, {
    code: "unknown_key",
    path: "$.extra",
  });
  expectParseFailure(validRequest({ review: undefined }), POLICY, {
    code: "missing_field",
    path: "$.review",
  });
  expectParseFailure(validRequest({ expectedBase: undefined }), POLICY, {
    code: "missing_field",
    path: "$.expectedBase",
  });
  expectParseFailure(
    {
      pullRequestNumber: 12,
      expectedHead: HEAD,
      expectedBase: BASE,
      review: null,
    },
    POLICY,
    { code: "wrong_type", path: "$" },
  );
});

Deno.test("merge request: pending, unavailable and malformed reviews fail", () => {
  expectParseFailure(
    requestWithReview({
      outcome: "pending",
      completedAt: null,
      observedReviewer: null,
    }),
    POLICY,
    { code: "invalid_lifecycle", path: "$.review.outcome" },
  );
  expectParseFailure(
    requestWithReview({
      outcome: "unavailable",
      completedAt: null,
      observedReviewer: null,
      resultId: null,
    }),
    POLICY,
    { code: "invalid_lifecycle", path: "$.review.outcome" },
  );
  // A "completed" receipt without machine-verifiable completion proof is
  // rejected by the embedded review parser, not accepted as completed. It is
  // built outside the frozen review parser so the violation reaches the
  // embedded validation inside the merge parser.
  expectParseFailure(
    validRequest({
      review: { ...completedReceipt(), resultId: null, completedAt: null },
    }),
    POLICY,
    { code: "invalid_lifecycle", path: "$.resultId" },
  );
  // Completed by a reviewer that is not the expected one: identity mismatch.
  expectParseFailure(
    validRequest({
      review: {
        ...completedReceipt(),
        observedReviewer: "someone-else",
        resultId: "result-2",
      },
    }),
    POLICY,
    { code: "invalid_lifecycle", path: "$.observedReviewer" },
  );
});

Deno.test("merge request: PR/head/base mismatches fail closed", () => {
  expectParseFailure(
    requestWithReview({
      pullRequest: { number: 13, head: HEAD, base: BASE },
    }),
    POLICY,
    { code: "invalid_lifecycle", path: "$.review.pullRequest.number" },
  );
  expectParseFailure(
    requestWithReview({
      pullRequest: { number: 12, head: OTHER_SHA, base: BASE },
    }),
    POLICY,
    { code: "invalid_lifecycle", path: "$.review.pullRequest.head" },
  );
  expectParseFailure(
    requestWithReview({
      pullRequest: { number: 12, head: HEAD, base: OTHER_SHA },
    }),
    POLICY,
    { code: "invalid_lifecycle", path: "$.review.pullRequest.base" },
  );
  // The merged-against base must also be the request's expectedBase.
  expectParseFailure(
    validRequest({ expectedBase: OTHER_SHA }),
    POLICY,
    { code: "invalid_lifecycle", path: "$.review.pullRequest.base" },
  );
});

Deno.test("merge request: repository and reviewer must match trusted adapter policy, never the request", () => {
  expectParseFailure(
    requestWithReview({
      repository: {
        owner: "ubiquity",
        name: "other-repo",
        installationId: 7,
      },
    }),
    POLICY,
    { code: "invalid_lifecycle", path: "$.review.repository" },
  );
  expectParseFailure(
    validRequest({
      review: {
        ...completedReceipt(),
        expectedReviewer: "some-other-reviewer[bot]",
        observedReviewer: "some-other-reviewer[bot]",
      },
    }),
    POLICY,
    { code: "invalid_lifecycle", path: "$.review.expectedReviewer" },
  );
  // A caller-selected reviewer in the policy is not the trusted policy: the
  // completed receipt can never match a different expected reviewer.
  expectParseFailure(
    validRequest(),
    {
      repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 7 },
      expectedReviewer: "caller-selected[bot]",
    },
    { code: "invalid_lifecycle", path: "$.review.expectedReviewer" },
  );
  // The policy input itself is validated strictly.
  expectParseFailure(
    validRequest(),
    {
      repository: { owner: "bad owner!", name: "x", installationId: 1 },
      expectedReviewer: REVIEWER,
    },
    { code: "invalid_pattern", path: "$.policy.repository.owner" },
  );
  expectParseFailure(
    validRequest(),
    { ...POLICY, expectedReviewer: "" },
    { code: "invalid_pattern", path: "$.policy.expectedReviewer" },
  );
});

Deno.test("merge request: uncounted findings and unresolved P0/P1 block merge", () => {
  // Uncounted findings with a non-empty unresolved set pass the review parser
  // (completeness is unknown, not false) but still fail the merge parser.
  expectParseFailure(
    requestWithReview({
      findings: [{
        id: "f1",
        severity: "P3",
        path: null,
        message: "minor note",
        fingerprint: "e".repeat(64),
        resolved: false,
        resolutionEvidence: null,
      }],
      unresolvedSeverities: ["P3"],
      findingsUncounted: 1,
    }),
    POLICY,
    { code: "invalid_lifecycle", path: "$.review.findingsUncounted" },
  );
  expectParseFailure(
    requestWithReview({
      findings: [{
        id: "f1",
        severity: "P1",
        path: null,
        message: "unresolved critical",
        fingerprint: FINGERPRINT,
        resolved: false,
        resolutionEvidence: null,
      }],
      unresolvedSeverities: ["P1"],
    }),
    POLICY,
    { code: "invalid_lifecycle", path: "$.review.unresolvedSeverities" },
  );
  expectParseFailure(
    requestWithReview({
      findings: [{
        id: "f1",
        severity: "P0",
        path: null,
        message: "unresolved blocker",
        fingerprint: FINGERPRINT,
        resolved: false,
        resolutionEvidence: null,
      }],
      unresolvedSeverities: ["P0"],
    }),
    POLICY,
    { code: "invalid_lifecycle", path: "$.review.unresolvedSeverities" },
  );
});
