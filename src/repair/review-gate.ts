/**
 * m04-repair: the HARD merge invariant and the pluggable review step boundary.
 *
 * Invariant (owner directive): NOTHING may merge without a passing review. A
 * merge is authorized only by a durable `ReviewReceiptV1` that matches the
 * EXACT repository scope, pull request, reviewed head and reviewed base, is
 * `completed`, carries a result id and completion instant, was observed from
 * the trusted reviewer identity and has no unresolved P0/P1. The predicate is
 * shared by the loop's merge step; the GitHub adapter independently
 * re-observes the same authorization before it calls `PUT /merge`.
 *
 * Review step (pluggable): the loop never invokes a reviewer directly. It
 * submits and observes through `GitHubPort.requestReview` /
 * `GitHubPort.observeReview`; the concrete adapter is the review-service
 * transport (`GitHubCodexReviewTransport`), whose `reviewer` option is the
 * `CodexReviewPrepareCapabilityV1` seam. The concrete reviewer is
 * `CodexStructuredReviewer`, wired in `src/host/local.ts`; its
 * `CodexStructuredReviewerOptionsV1.openSession` callback builds the
 * `CodexSubprocessSession({ command: [codexExecutable, "app-server"] })` that
 * is the single review start. To attach the owner's `codex-auto-review` Codex
 * CLI review mode against `https://ai.ubq.fi/v1/`, replace ONLY that
 * `openSession`/`provider`/`model` wiring (or supply an alternate `reviewer`
 * implementing `prepare`): the CLI command, its gateway base URL and token are
 * constructed there. No loop, state or capacity code changes are needed, and
 * the GitHub Codex integration (the subscription-burning GitHub App review)
 * must NOT be wired in.
 */

import type { GitSha } from "../contracts/brands.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";

/** Static, sanitized fail-closed detail for a refused merge. */
export const MERGE_WITHOUT_REVIEW_DETAIL =
  "merge without an accepted current-head review";

/**
 * Exact documentation anchor for where the Codex CLI review call attaches:
 * the transport's reviewer capability is fed to `GitHubCodexReviewTransport`,
 * and the concrete reviewer session is opened by
 * `CodexStructuredReviewerOptionsV1.openSession` in `src/host/local.ts`. Kept
 * as a constant so the wiring point is greppable and testable.
 */
export const REVIEW_STEP_ATTACHMENT =
  "GitHubCodexReviewTransportOptionsV1.reviewer / CodexStructuredReviewerOptionsV1.openSession";

/**
 * The one and only authorization for a merge. Returns true only for a durable
 * completed review receipt that covers the record's exact published identity.
 * Any missing, pending, unavailable, mismatched, untrusted or P0/P1-bearing
 * receipt refuses the merge.
 */
export function reviewAuthorizesMerge(
  receipt: ReviewReceiptV1 | null | undefined,
  record: WorkRecordV1,
  expectedReviewer: string | null = null,
): boolean {
  if (receipt === null || receipt === undefined) return false;
  const { pr, head, base } = record.target;
  if (pr === null || head === null) return false;
  if (receipt.outcome !== "completed") return false;
  if (receipt.repository.owner !== record.repository.owner) return false;
  if (receipt.repository.name !== record.repository.name) return false;
  if (receipt.repository.installationId !== record.repository.installationId) {
    return false;
  }
  if (receipt.pullRequest.number !== pr) return false;
  if (!sameSha(receipt.pullRequest.head, head)) return false;
  if (!sameSha(receipt.pullRequest.base, base)) return false;
  if (receipt.resultId === null) return false;
  if (receipt.completedAt === null) return false;
  if (receipt.observedReviewer === null) return false;
  if (receipt.observedReviewer !== receipt.expectedReviewer) return false;
  if (
    expectedReviewer !== null && receipt.expectedReviewer !== expectedReviewer
  ) {
    return false;
  }
  if (receipt.findingsUncounted !== 0) return false;
  if (
    receipt.unresolvedSeverities.some((severity) =>
      severity === "P0" || severity === "P1"
    )
  ) {
    return false;
  }
  return true;
}

/**
 * The first durable receipt that authorizes this exact merge, or null. Callers
 * MUST fail closed on null; they must never substitute a pending, partial or
 * differently-scoped receipt.
 */
export function authorizingReceipt(
  reviews: readonly ReviewReceiptV1[],
  record: WorkRecordV1,
  expectedReviewer: string | null = null,
): ReviewReceiptV1 | null {
  return reviews.find((receipt) =>
    reviewAuthorizesMerge(receipt, record, expectedReviewer)
  ) ?? null;
}

function sameSha(a: GitSha, b: GitSha): boolean {
  return a === b;
}
