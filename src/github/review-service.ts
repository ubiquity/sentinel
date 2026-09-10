/**
 * Review service transport boundary.
 *
 * `requestReview` and `observeReview` in the GitHubPort do NOT talk to GitHub:
 * they go through this narrow injected transport, which is the trusted host's
 * authenticated review service (production: an explicitly configured service
 * whose completion is machine-verifiable — terminal turn succeeded plus output
 * present). The port never starts a model: model-start admission is the
 * caller's budgeted operation performed before `requestReview` is called.
 *
 * Submission records a deterministic operation key alongside the exact
 * PR/head/base/reviewer identity and starts exactly one request; a lost
 * submission response is `ambiguous` and the same operation key reconciles
 * later through `readReview` (the service/transport remembers or can find the
 * request by key). `readReview` reports only machine-verifiable states;
 * completion is never inferred from silence, missing output or a non-success
 * terminal turn.
 *
 * The read result carries the service's own trusted record of the submission
 * and terminal result (`ReviewServiceReceiptV1`): the exact repository,
 * PR number, base and head the request was submitted for, the expected
 * reviewer, the operation key, the opaque request id and the exact GitHub
 * review id the completed result is bound to. The port binds the normalized
 * observation to those exact identities — a missing or contradictory receipt
 * is unavailable, never a completed verdict.
 */

import type { FindingFingerprint, GitSha } from "../contracts/brands.ts";
import type {
  PortResultV1,
  ReviewDrainReportV1,
  ReviewDrainRequestV1,
} from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";

export interface ReviewRequestSubmitV1 {
  operationKey: string;
  prNumber: number;
  expectedHead: GitSha;
  expectedBase: GitSha;
  expectedReviewer: string;
  /** Absolute ms: no model start may be admitted at or after this instant. */
  latestStartAt: number;
  /** Absolute ms: the whole review, including close, must settle by this. */
  settleBy: number;
}

export type ReviewSubmitOutcomeV1 =
  | { status: "submitted"; requestId: string; requestedAt: number }
  | { status: "ambiguous" }
  | { status: "rejected" };

export interface ReviewRequestReadV1 {
  /** Read by operation key (recovery from a lost submission response) or by
   * exact request id (merge re-observation); at least one is required. */
  operationKey: string | null;
  requestId: string | null;
  /**
   * Exact pull request number the observation is scoped to. Both the
   * observation path and the merge re-observation path supply it so restart
   * recovery never needs an in-memory PR index.
   */
  prNumber: number;
}

/**
 * The service's trusted receipt: the exact identities the original
 * submission and the terminal result are bound to. Every field is
 * machine-typed and checked by the port against its own configuration and
 * the caller's request; `null` means the service could not produce that
 * binding, which the port treats as unavailable (never as a completion).
 */
export interface ReviewServiceReceiptV1 {
  /** Operation key of the submission this result belongs to. */
  operationKey: string | null;
  /** Exact GitHub review id the completed result refers to. */
  githubReviewId: number | null;
  /** Repository the request was submitted for (exact owner/name). */
  repository: RepositoryIdentityV1 | null;
  /** Pull request number the request was submitted for. */
  prNumber: number | null;
  /** Head the review was requested and performed against. */
  expectedHead: GitSha | null;
  /** Base the review was requested against (never relabeled from current). */
  expectedBase: GitSha | null;
  /** Reviewer identity the request was submitted for. */
  expectedReviewer: string | null;
}

export interface ReviewServiceReadV1 extends ReviewServiceReceiptV1 {
  status: "pending" | "completed" | "unavailable";
  requestId: string | null;
  resultId: string | null;
  completedAt: number | null;
  summary: string | null;
  /**
   * Canonical digest of the completed structured result as recorded by the
   * service (the durable journal's `resultDigest`). `null` means the service
   * could not produce the binding; the consumer then never completes.
   */
  resultDigest: string | null;
  /** Terminal turn reached a successful terminal state (machine-verifiable). */
  terminalTurnSucceeded: boolean;
  /** A completed review output/result was actually delivered. */
  outputPresent: boolean;
}

/**
 * Narrow review-service transport. The injected instance is pre-authenticated
 * (production supports only an explicitly configured authenticated service);
 * this module never supplies credentials to it.
 */
export interface ReviewServiceTransportV1 {
  submitReview(
    request: ReviewRequestSubmitV1,
  ): Promise<PortResultV1<ReviewSubmitOutcomeV1>>;
  readReview(
    request: ReviewRequestReadV1,
  ): Promise<PortResultV1<ReviewServiceReadV1>>;
  /**
   * Bounded lifecycle finalization: stop accepting submissions, await or
   * interrupt every owned review operation and reconcile its journal inside
   * the supplied absolute deadline. Never starts a model, reserves no budget
   * and writes no repair state.
   */
  drain(
    request: ReviewDrainRequestV1,
  ): Promise<ReviewDrainReportV1>;
}

/** Sentinel marker for a request id that could not be recovered. */
export const UNRESOLVED_REQUEST_ID = "unresolved";

// ---------------------------------------------------------------------------
// Human resolution verification (trusted authenticated resolver)
// ---------------------------------------------------------------------------

/**
 * The exact immutable resolution reference a trusted human resolver
 * authenticated, bound to the repository, PR number, head commit and exact
 * finding fingerprint. A caller-supplied `resolved: true` plus an allowed
 * author name is NOT authentication: only this concrete integration can
 * prove that a human resolution really authorizes this exact finding on this
 * exact head. When the integration is absent, every resolved finding fail
 * closes (the port never merges).
 */
export interface ResolutionEvidenceCheckV1 {
  repository: RepositoryIdentityV1;
  prNumber: number;
  head: GitSha;
  /** Finding identity the resolution refers to (canonical finding SHA-256). */
  findingFingerprint: FindingFingerprint;
  /** The authorizing identity recorded on the finding resolution evidence. */
  authorizingIdentity: string;
  /** The immutable machine-verifiable reference of the human resolution. */
  reference: string;
}

export interface ResolutionVerificationV1 {
  verified: boolean;
  /** Identity the resolver authenticated for the exact reference; when the
   * resolution is verified this must equal the recorded authorizing identity. */
  authorizingIdentity: string | null;
}

/**
 * Narrow injected trusted resolver. The resolver authenticates the exact
 * reference (never by mere author allowlist), and the port additionally
 * requires the authenticated identity to be in the configured allowlist.
 */
export interface HumanResolutionVerifierV1 {
  verifyResolution(
    check: ResolutionEvidenceCheckV1,
  ): Promise<PortResultV1<ResolutionVerificationV1>>;
}
