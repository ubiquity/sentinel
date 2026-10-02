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
import {
  reviewTaskAcceptanceRefusal,
  type ReviewTaskStatementV1,
  TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL,
  TASK_ACCEPTANCE_CONTEXT_DETAIL,
  TASK_ACCEPTANCE_DIGEST_DETAIL,
  TASK_ACCEPTANCE_MISMATCH_DETAIL,
  TASK_ACCEPTANCE_MISSING_DETAIL,
  TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL,
  TASK_ACCEPTANCE_UNCERTAIN_DETAIL,
} from "../contracts/review-receipt.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";

/** Static, sanitized fail-closed detail for a refused merge. */
export const MERGE_WITHOUT_REVIEW_DETAIL =
  "merge without an accepted current-head review";

/**
 * Static, sanitized semantic-refusal details. Each one is a terminal
 * no-delivery disposition: the candidate is never merged and an issue-backed
 * task is never closed. The durable review receipt (with its bounded evidence)
 * remains the owner-facing evidence; these strings never echo task or model
 * text. The authoritative definitions live in the shared review contract so
 * every authorization surface (repair gate, GitHub adapter, hosted copies)
 * refuses with the exact same bytes.
 */
export {
  TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL,
  TASK_ACCEPTANCE_CONTEXT_DETAIL,
  TASK_ACCEPTANCE_DIGEST_DETAIL,
  TASK_ACCEPTANCE_MISMATCH_DETAIL,
  TASK_ACCEPTANCE_MISSING_DETAIL,
  TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL,
  TASK_ACCEPTANCE_UNCERTAIN_DETAIL,
};

/**
 * The one semantic acceptance invariant. A completed review authorizes an
 * issue-backed delivery only when it carries a positive task acceptance bound
 * to the record's exact source issue AND to the trusted live task statement
 * independently read at authorization time. `task` is that trusted statement
 * (never the model's echoed digest and never equality between two copied
 * receipts), or `"unavailable"` when it cannot be read or bounded — which
 * fails closed. A record without a source issue keeps the existing
 * change-only review gate.
 */
export function taskAcceptanceRefusal(
  receipt: ReviewReceiptV1,
  record: WorkRecordV1,
  task: ReviewTaskStatementV1 | null | "unavailable" = "unavailable",
): string | null {
  return reviewTaskAcceptanceRefusal({
    issueNumber: record.related.issueNumber,
    task,
    acceptance: receipt.taskAcceptance,
  });
}

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
 * completed review receipt that covers the record's exact published identity
 * AND whose task acceptance is positively, exactly bound to the TRUSTED live
 * task statement passed by the caller. Any missing, pending, unavailable,
 * mismatched, untrusted or P0/P1-bearing receipt refuses the merge; omitting
 * the trusted statement fails closed for issue-backed records.
 */
export function reviewAuthorizesMerge(
  receipt: ReviewReceiptV1 | null | undefined,
  record: WorkRecordV1,
  expectedReviewer: string | null = null,
  task: ReviewTaskStatementV1 | null | "unavailable" = "unavailable",
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
  // Task completion is a SEPARATE proof from a clean code review: an
  // issue-backed delivery additionally requires the reviewer's positive task
  // acceptance, exactly bound to this record's source issue AND to the trusted
  // live task statement. A nonempty diff and a code-quality-only pass never
  // establish completion, and a receipt the model echoed back never binds the
  // live context by itself.
  if (taskAcceptanceRefusal(receipt, record, task) !== null) return false;
  return true;
}

/**
 * The first durable receipt that authorizes this exact merge, or null. Callers
 * MUST fail closed on null; they must never substitute a pending, partial or
 * differently-scoped receipt, and they must pass the trusted live task
 * statement (omission fails closed for issue-backed records).
 */
export function authorizingReceipt(
  reviews: readonly ReviewReceiptV1[],
  record: WorkRecordV1,
  expectedReviewer: string | null = null,
  task: ReviewTaskStatementV1 | null | "unavailable" = "unavailable",
): ReviewReceiptV1 | null {
  return reviews.find((receipt) =>
    reviewAuthorizesMerge(receipt, record, expectedReviewer, task)
  ) ?? null;
}

function sameSha(a: GitSha, b: GitSha): boolean {
  return a === b;
}
