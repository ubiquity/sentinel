/**
 * MergeRequestV1 strict parser: exact-identity merge authorization,
 * trusted-controller-only. The record type lives in ports.ts with the GitHub
 * merge port; this module owns its runtime validation and the trusted adapter
 * policy it is checked against.
 *
 * The request binds a pull request to the exact head, the exact integrated
 * validated base and one completed ReviewReceiptV1 for the same PR/head/base.
 * The strict parser refuses any missing/unknown field and any stale, pending,
 * unavailable or mismatched review; a review with uncounted findings or with
 * unresolved P0/P1 findings is never merge authorization.
 *
 * Parsing alone never grants authority: repository binding and reviewer
 * identity must match the trusted adapter policy passed by the caller, so a
 * request can never name a different repository or select a trusted reviewer.
 * The receipt is identity/cleanliness evidence only — the adapter must
 * re-observe the authoritative review by exact identifiers and verify trusted
 * resolution authorization, current CI/protections and base ancestry before an
 * expected-head merge; see MergeRequestV1 in ports.ts.
 */

import type { MergeRequestV1 } from "./ports.ts";
import { parseReviewReceiptV1 } from "./review-receipt.ts";
import { parseRepositoryIdentity } from "./shared.ts";
import type { RepositoryIdentityV1, SeverityV1 } from "./shared.ts";
import {
  expectExactKeys,
  expectGitSha,
  expectPattern,
  expectPositiveInt,
  expectRecord,
  fail,
  MaxText,
} from "./validation.ts";

/**
 * Trusted adapter policy the merge request is checked against: the exact
 * repository this adapter instance serves and the expected reviewer identity
 * from adapter configuration. These are never supplied by the merge request.
 */
export interface MergeRequestPolicyV1 {
  repository: RepositoryIdentityV1;
  expectedReviewer: string;
}

const KEYS = [
  "pullRequestNumber",
  "expectedHead",
  "expectedBase",
  "review",
] as const;
const REVIEWER_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}(?:\[bot\])?$/;

export function parseMergeRequestV1(
  input: unknown,
  policy: MergeRequestPolicyV1,
): MergeRequestV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, KEYS, "$");

  const pullRequestNumber = expectPositiveInt(
    obj.pullRequestNumber,
    "$.pullRequestNumber",
  );
  const expectedHead = expectGitSha(obj.expectedHead, "$.expectedHead");
  const expectedBase = expectGitSha(obj.expectedBase, "$.expectedBase");

  const policyRepository = parseRepositoryIdentity(
    policy.repository,
    "$.policy.repository",
  );
  const expectedReviewer = expectPattern(
    policy.expectedReviewer,
    "$.policy.expectedReviewer",
    REVIEWER_RE,
    "invalid_pattern",
    "expected reviewer identity",
    MaxText.label,
  );

  // The embedded review is validated by the frozen review parser itself: full
  // strict shape, derivation of unresolved severities and lifecycle proof of a
  // machine-verifiable completion.
  const review = parseReviewReceiptV1(obj.review);

  if (review.outcome !== "completed") {
    fail(
      "$.review.outcome",
      "invalid_lifecycle",
      "merge requires a completed review; pending/unavailable is not authorization",
    );
  }
  if (
    review.repository.owner !== policyRepository.owner ||
    review.repository.name !== policyRepository.name ||
    review.repository.installationId !== policyRepository.installationId
  ) {
    fail(
      "$.review.repository",
      "invalid_lifecycle",
      "review repository must match the trusted adapter policy repository",
    );
  }
  // A completed receipt already binds observedReviewer to expectedReviewer;
  // additionally the expected reviewer itself must be the adapter-configured
  // identity — the request can never select a trusted reviewer.
  if (review.expectedReviewer !== expectedReviewer) {
    fail(
      "$.review.expectedReviewer",
      "invalid_lifecycle",
      "review reviewer must match the trusted adapter policy reviewer",
    );
  }
  if (review.pullRequest.number !== pullRequestNumber) {
    fail(
      "$.review.pullRequest.number",
      "invalid_lifecycle",
      "review PR number must equal the merge request PR number",
    );
  }
  if (review.pullRequest.head !== expectedHead) {
    fail(
      "$.review.pullRequest.head",
      "invalid_lifecycle",
      "review head must equal the exact expected head",
    );
  }
  if (review.pullRequest.base !== expectedBase) {
    fail(
      "$.review.pullRequest.base",
      "invalid_lifecycle",
      "review base must equal the exact integrated validated base",
    );
  }
  if (review.findingsUncounted !== 0) {
    fail(
      "$.review.findingsUncounted",
      "invalid_lifecycle",
      "merge requires zero uncounted findings",
    );
  }
  if (hasUnresolvedP0P1(review.unresolvedSeverities)) {
    fail(
      "$.review.unresolvedSeverities",
      "invalid_lifecycle",
      "merge requires no unresolved P0/P1 findings",
    );
  }

  return {
    pullRequestNumber,
    expectedHead,
    expectedBase,
    review,
  } satisfies MergeRequestV1;
}

function hasUnresolvedP0P1(severities: readonly SeverityV1[]): boolean {
  return severities.includes("P0") || severities.includes("P1");
}

export type { MergeRequestV1 };
