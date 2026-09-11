/**
 * Typed operational ports. Every port returns explicit results: unavailable,
 * ambiguous or blocked outcomes are distinct values and are never represented
 * as an empty list, a null, a success or a thrown exception. Transports are
 * injected through these interfaces; product logic never lives in test fakes.
 */

import type {
  CommandId,
  EncryptedArtifactDigest,
  FixtureDigest,
  GitSha,
  WorkItemId,
} from "./brands.ts";
import { parseGitHubRateLimitV1 } from "./github-cooldown.ts";
import type { GitHubRateLimitV1 } from "./github-cooldown.ts";
import type { IncidentEvidenceV1, IncidentSummaryV1 } from "./incident.ts";
import type { ReplayLimitationV1 } from "./replay-result.ts";
import type {
  ReviewFindingV1,
  ReviewReceiptV1,
  ReviewStatusV1,
} from "./review-receipt.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "./state-snapshots.ts";
import type {
  DeploymentIdentityV1,
  EvidenceRefV1,
  IncidentCoverageV1,
  MetricsSampleV1,
  RepositoryIdentityV1,
} from "./shared.ts";

export type { DeploymentIdentityV1, MetricsSampleV1 };

export type PortErrorKindV1 =
  | "unavailable"
  | "auth_failed"
  | "rate_limited"
  | "not_found"
  | "conflict"
  | "invalid";

export interface PortErrorV1 {
  kind: PortErrorKindV1;
  detail: string;
  /**
   * Structured rate-limit metadata, present only on rate_limited errors.
   * Rate limiting is never encoded inside `detail` strings.
   */
  rateLimit?: GitHubRateLimitV1;
}

export type PortResultV1<T> = { ok: true; value: T } | {
  ok: false;
  error: PortErrorV1;
};

export function portOk<T>(value: T): PortResultV1<T> {
  return { ok: true, value };
}

export function portError(
  kind: PortErrorKindV1,
  detail: string,
  rateLimit?: GitHubRateLimitV1,
): PortResultV1<never> {
  if (rateLimit !== undefined) {
    if (kind !== "rate_limited") {
      throw new TypeError(
        "rate-limit metadata is only valid for rate_limited errors",
      );
    }
    // Validate through the strict parser so a caller-supplied plain object
    // cannot smuggle unvalidated metadata into an error.
    parseGitHubRateLimitV1(rateLimit);
  }
  return {
    ok: false,
    error: rateLimit === undefined
      ? { kind, detail }
      : { kind, detail, rateLimit },
  };
}

/**
 * A write whose external effect could not be confirmed. Distinguish from
 * failure: "ambiguous" means the effect may have been applied; the caller
 * must reconcile against exact authoritative state before repeating.
 */
export type WriteOutcomeV1 = "applied" | "ambiguous";

// ---------------------------------------------------------------------------
// GitHubPort (m01): authenticated reads, exact-head writes, review observation.
// Each instance targets exactly one configured repository. Model candidates
// are locally validated commits; the trusted GitHub writer publishes them.
// ---------------------------------------------------------------------------

/**
 * Native GitHub issue dependency metadata as observed at read time.
 *
 * `openBlockers` contains only blockers whose native state is currently open
 * (closed blockers are excluded because closed native state is authoritative
 * for the dependency) and retains cross-repository blockers: an open blocker
 * in another repository still blocks this issue. `subIssueCount` is the total
 * native sub-issue count, not a page slice.
 */
export interface GitHubIssueRelationsV1 {
  openBlockers: {
    owner: string;
    name: string;
    number: number;
  }[];
  subIssueCount: number;
}

export interface GitHubIssueV1 {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  author: string | null;
  labels: string[];
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  /**
   * Native dependency relations. Absence means unknown, NOT empty: a caller
   * that requires dependency gating must treat a missing value as a source
   * failure rather than an unblocked issue.
   */
  relations?: GitHubIssueRelationsV1;
}

export interface GitHubPullRequestV1 {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  head: GitSha;
  base: GitSha;
  /** Delivered merge SHA; temporary unmerged test-merge SHAs are discarded. */
  mergeSha: GitSha | null;
  headRef: string;
  baseRef: string;
  author: string | null;
  createdAt: number;
  updatedAt: number;
  mergedAt: number | null;
  reviewDecision: GitHubReviewDecisionV1;
}

export type GitHubReviewDecisionV1 =
  | "approved"
  | "changes_requested"
  | "review_required"
  | "none";

export interface GitHubCheckV1 {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion:
    | "success"
    | "failure"
    | "cancelled"
    | "skipped"
    | "timed_out"
    | "neutral"
    | "action_required"
    | null;
  head: GitSha;
  startedAt: number | null;
  completedAt: number | null;
}

export interface GitHubChecksV1 {
  head: GitSha;
  /** Empty means no checks recorded — a real state, distinct from unavailable. */
  checks: GitHubCheckV1[];
}

export interface GitHubBranchProtectionsV1 {
  branch: string;
  protected: boolean;
  requiredStatusChecks: string[];
  requiredApprovingReviewCount: number;
  requireBranchUpToDate: boolean;
  enforceAdmins: boolean;
}

export interface GitHubRefV1 {
  ref: string;
  sha: GitSha;
}

export interface PullRequestCreateV1 {
  title: string;
  headRef: string;
  baseRef: string;
  body: string;
  /**
   * Base head the trusted caller observed as the integration precondition.
   * GitHub REST has no atomic base CAS: this is not an in-API guarantee
   * against base movement — the precondition is re-observed both before and
   * after publication, and the final merge rechecks the current base/head
   * against effective strict protections. A created PR after an ambiguous
   * response stays reconcilable and can never merge without exact current
   * validation.
   */
  expectedBase: GitSha;
  /** Expected head of the new branch; null means the branch must not exist. */
  expectedHeadRef: GitSha | null;
}

export interface PullRequestPublishV1 {
  outcome: WriteOutcomeV1;
  number: number | null;
  head: GitSha | null;
}

/**
 * Review submission carries the exact PR/head/base identity plus a
 * deterministic operation key, so recovery works even when the request
 * response (and its request id) is lost. `latestStartAt` is the last absolute
 * instant at which the single model start may be admitted and `settleBy` the
 * absolute instant by which the whole review (including interrupt and close)
 * must settle; both are bounded by the original run's model cutoff and the
 * loop deadline minus the full review bound and finalization margin.
 */
export interface ReviewSubmissionV1 {
  prNumber: number;
  expectedHead: GitSha;
  expectedBase: GitSha;
  expectedReviewer: string;
  operationKey: string;
  latestStartAt: number;
  settleBy: number;
}

export interface ReviewRequestOutcomeV1 {
  outcome: WriteOutcomeV1;
  requestId: string | null;
  requestedAt: number;
}

// ---------------------------------------------------------------------------
// Review drain: bounded lifecycle finalization of every owned review
// operation. A `ready` durable journal awaiting publication is
// restart-recoverable; an operation whose owned producer process was not
// proved settled, or whose durable fault is sanitized below, is faulted.
// ---------------------------------------------------------------------------

export type ReviewDrainOutcomeV1 = "settled" | "recoverable" | "faulted";

export interface ReviewDrainOperationV1 {
  operationKey: string;
  outcome: ReviewDrainOutcomeV1;
  /** True when no owned producer process for this operation remains live. */
  processSettled: boolean;
  /** True when a durable ready journal records the operation's result. */
  durable: boolean;
  /** Journalled lifecycle phase observed at drain time. */
  phase: "none" | "intent" | "running" | "ready" | "published";
  /** Static sanitized fault code; null unless the outcome is faulted. */
  fault: string | null;
}

export interface ReviewDrainReportV1 {
  /** True only when no owned operation is faulted. */
  ok: boolean;
  operations: ReviewDrainOperationV1[];
  /** Bounded static sanitized fault codes (never raw transport detail). */
  faults: string[];
  /** Absolute deadline the drain was bounded by. */
  deadline: number;
  interrupted: boolean;
  completedAt: number;
}

export interface ReviewDrainRequestV1 {
  /** Absolute deadline; the drain never exceeds it. */
  deadline: number;
  /** Interrupt owned producer sessions that are still running. */
  interrupt: boolean;
}

/** Review observation is addressed by operation key + PR/head, never by id alone. */
export interface ReviewObservationRequestV1 {
  operationKey: string;
  prNumber: number;
  head: GitSha;
}

export interface ReviewObservationV1 {
  status: ReviewStatusV1;
  requestId: string;
  /** Actual reviewer identity observed; binds the receipt to who reviewed. */
  reviewer: string | null;
  resultId: string | null;
  completedAt: number | null;
  observedHead: GitSha | null;
  observedBase: GitSha | null;
  /** Full findings exactly as delivered; never trimmed. */
  findings: ReviewFindingV1[];
  summary: string | null;
  /** When the observation was made; completion is never inferred later. */
  receivedAt: number;
}

export type MergeOutcomeV1 =
  | { outcome: "merged"; head: GitSha; mergeSha: GitSha }
  | { outcome: "ambiguous"; head: GitSha | null; mergeSha: GitSha | null }
  | {
    outcome: "blocked";
    reason:
      | "conflict"
      | "checks_pending"
      | "checks_failed"
      | "protection_required"
      | "head_mismatch"
      | "base_mismatch"
      | "review_required";
    head: GitSha | null;
  };

/**
 * Exact-identity merge authorization, trusted-controller-only. The request
 * carries the PR number, the exact head, the exact integrated validated base
 * and a completed ReviewReceiptV1 binding the same PR/head/base.
 *
 * REST has no atomic base CAS: `expectedBase` is a precondition the adapter
 * re-validates immediately before an expected-head merge, not an API
 * guarantee. Effective strict server-enforced protections (requiring up-to-
 * date branches with no applicable token bypass) plus candidate ancestry
 * containing `expectedBase` are required; a moved base then makes the
 * candidate outdated and the server blocks the merge (base_mismatch) until
 * the exact current base is integrated and validated again. The review
 * receipt is identity/cleanliness evidence only — it is never current CI,
 * protection or authenticity evidence, so the adapter must re-observe the
 * authoritative review by exact identifiers and verify trusted resolution
 * authorization and repository/reviewer binding against its configuration
 * before merging; a caller-supplied receipt never grants authority.
 */
export interface MergeRequestV1 {
  pullRequestNumber: number;
  /** Exact head required; a mismatch must fail closed, never merge stale work. */
  expectedHead: GitSha;
  /** Exact integrated validated base the candidate must contain as ancestor. */
  expectedBase: GitSha;
  /** Completed review receipt; no unresolved P0/P1, zero uncounted findings. */
  review: ReviewReceiptV1;
}

export type IssueCloseOutcomeV1 = "closed" | "already_closed";

export interface GitHubPort {
  /**
   * Exact trusted review publisher identity configured for this port. The
   * repair loop uses this value for every review request and receipt binding;
   * there is no hardcoded connector default.
   */
  readonly reviewerIdentity: string;
  readIssue(issueNumber: number): Promise<PortResultV1<GitHubIssueV1 | null>>;
  listOpenIssues(): Promise<PortResultV1<GitHubIssueV1[]>>;
  /** Find the PR for a deterministic head branch; null when none exists. */
  findPullRequestByHeadRef(
    headRef: string,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>>;
  readPullRequest(
    number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>>;
  readChecks(head: GitSha): Promise<PortResultV1<GitHubChecksV1>>;
  readProtections(
    baseBranch: string,
  ): Promise<PortResultV1<GitHubBranchProtectionsV1>>;
  /** Observe the current head of a ref (exact identity, not list order). */
  readRef(ref: string): Promise<PortResultV1<GitHubRefV1 | null>>;
  /** Pushes the trusted candidate commit; the model never publishes itself. */
  pushHead(
    ref: string,
    sha: GitSha,
    expectedRef: GitSha | null,
  ): Promise<PortResultV1<WriteOutcomeV1>>;
  createPullRequest(
    request: PullRequestCreateV1,
  ): Promise<PortResultV1<PullRequestPublishV1>>;
  requestReview(
    request: ReviewSubmissionV1,
  ): Promise<PortResultV1<ReviewRequestOutcomeV1>>;
  observeReview(
    request: ReviewObservationRequestV1,
  ): Promise<PortResultV1<ReviewObservationV1>>;
  mergePullRequest(
    request: MergeRequestV1,
  ): Promise<PortResultV1<MergeOutcomeV1>>;
  closeIssue(issueNumber: number): Promise<PortResultV1<IssueCloseOutcomeV1>>;
  /**
   * Bounded lifecycle finalization forwarded to the SAME review-service
   * transport instance the port submits through: admission stops, owned
   * review operations are awaited or interrupted, and every journal is
   * reconciled inside the supplied deadline. Never starts a model, never
   * reserves budget and never writes repair state.
   */
  drainReviews(
    request: ReviewDrainRequestV1,
  ): Promise<PortResultV1<ReviewDrainReportV1>>;
}

// ---------------------------------------------------------------------------
// GitHubCooldownGateV1: durable cooldown in front of every authenticated
// request. beforeRequest must be checked before any read or write for an
// affected installation credential (intake included, before a work record
// exists), and recordRateLimit persists an observed limit before any later
// request. The production adapter and repair-loop wiring follow this contract
// freeze; no fake production default is defined here.
// ---------------------------------------------------------------------------

export interface GitHubCooldownGateV1 {
  beforeRequest(installationId: number): Promise<PortResultV1<void>>;
  recordRateLimit(
    installationId: number,
    rateLimit: GitHubRateLimitV1,
  ): Promise<PortResultV1<void>>;
}

// ---------------------------------------------------------------------------
// IncidentAdapter (m02): unresolved discovery, incident evidence and bounded
// retrieval of restricted encrypted artifacts.
// ---------------------------------------------------------------------------

export interface IncidentPageV1 {
  items: IncidentSummaryV1[];
  /**
   * Coverage of the discovery scan that produced this page, independent of
   * whether items is empty: an empty page may be incomplete coverage, and a
   * failed source read is never a successful empty page.
   */
  coverage: IncidentCoverageV1;
  /** Cursor of the next page; null when pagination was exhausted. */
  nextCursor: string | null;
}

export interface EncryptedArtifactV1 {
  ref: string;
  digest: EncryptedArtifactDigest;
  sizeBytes: number;
  expiresAt: number;
  /** Canonical base64 ciphertext; never plaintext evidence. */
  ciphertextBase64: string;
}

export interface IncidentAdapter {
  listUnresolvedIncidents(
    cursor: string | null,
    limit: number,
  ): Promise<PortResultV1<IncidentPageV1>>;
  readIncident(
    incidentId: string,
  ): Promise<PortResultV1<IncidentEvidenceV1 | null>>;
  /**
   * null means the artifact is gone/expired (evidence_expired blocker), which
   * is distinct from a transport failure (ok:false, unavailable).
   */
  readArtifact(
    ref: string,
    maxBytes: number,
  ): Promise<PortResultV1<EncryptedArtifactV1 | null>>;
}

// ---------------------------------------------------------------------------
// ReplayPort (m03): one exact isolated validation run against the configured
// command; the module orchestrates before/after and writes ReplayResultV1.
// ---------------------------------------------------------------------------

export interface ReplayRunRequestV1 {
  taskId: WorkItemId;
  repository: RepositoryIdentityV1;
  /** Exact checkout revision; never selected by time or list order. */
  revision: GitSha;
  /** Trusted credential-free configured command (never model-supplied). */
  commandId: CommandId;
  fixtureRef: string;
  fixtureDigest: FixtureDigest;
  testIds: string[];
  outputLimitBytes: number;
}

export interface IsolatedReplayResultV1 {
  outcome: "passed" | "failed" | "unavailable";
  exitCode: number | null;
  output: {
    stdoutDigest: FixtureDigest | null;
    stderrDigest: FixtureDigest | null;
    truncated: boolean;
  } | null;
  /** null unless the run failed; "intended" says whether it failed for the expected reason. */
  failure: { intended: boolean; reason: string } | null;
  limitations: ReplayLimitationV1[];
  startedAt: number;
  endedAt: number;
}

export interface ReplayPort {
  runReplay(
    request: ReplayRunRequestV1,
  ): Promise<PortResultV1<IsolatedReplayResultV1>>;
}

// ---------------------------------------------------------------------------
// ImplementationPort (m04): bounded pinned model session with a secret-free
// checkout; the receipt records trusted request/runtime evidence — the exact
// submitted provider/model/effort configuration bound to the exact
// invocation/thread/turn and runtime routing/terminal events — never the CLI
// label alone and never a backend-observed provider attestation. A model
// candidate is a locally validated commit; only the trusted GitHub writer
// publishes it.
// ---------------------------------------------------------------------------

export type ModelIdV1 = "gpt-5.6-luna";
export type ReasoningEffortV1 = "max";

export interface ModelRunRequestV1 {
  taskId: WorkItemId;
  repository: RepositoryIdentityV1;
  /** Secret-free checkout base; no credential or state-write fields exist. */
  base: GitSha;
  issue: { number: number; title: string; body: string } | null;
  evidence: EvidenceRefV1[];
  model: ModelIdV1;
  reasoning: ReasoningEffortV1;
  maxDurationMs: number;
  maxOutputChars: number;
}

export interface CandidateOutcomeV1 {
  /** Locally validated candidate commit; push/publication is the writer's job. */
  head: GitSha | null;
  /** Durable checkpoint SHA produced before termination, if any. */
  checkpointSha: GitSha | null;
  /** Bounded changed path list (paths only, never payloads). */
  changedPaths: string[];
}

/**
 * Receipt of ONE bounded model run. The `actual` block is explicit
 * request/runtime evidence: `evidenceKind: "request-runtime"` labels trusted
 * submitted provider/model/effort configuration bound to the exact
 * invocation/thread/turn identity and runtime routing/terminal events. It is
 * NEVER a backend-observed provider attestation. The old field names are the
 * existing contract; `observedModel`/`observedReasoning` document the
 * acknowledged request/runtime metadata, not backend observation.
 */
export interface ModelRunReceiptV1 {
  invocationId: string;
  outcome: "completed" | "failed" | "interrupted";
  actual: {
    /** Evidence class: request/runtime evidence, never backend attestation. */
    evidenceKind: "request-runtime";
    /** Acknowledged provider configuration submitted with the run. */
    provider: string;
    /** Exact app-server thread identity acknowledged for the run. */
    threadId: string;
    /** Exact app-server turn identity acknowledged for the run. */
    turnId: string;
    /**
     * Terminal evidence origin: `runtime` means a correlated runtime terminal
     * event was actually observed for the exact thread/turn; `host-timeout`
     * means the host's own bounds elapsed without any runtime terminal and the
     * receipt is failed ACCOUNTING only — the run never claims an observed
     * terminal.
     */
    terminalOrigin: "runtime" | "host-timeout";
    /**
     * Observed runtime terminal status: `completed`/`interrupted`/`failed`
     * when a correlated runtime terminal event was actually observed for the
     * exact thread/turn, and null on a host timeout. The exact runtime status
     * is preserved even when the host's own loop stop yields `interrupted`
     * accounting over a completed terminal; null never pretends a terminal
     * was observed.
     */
    observedTerminalStatus: "completed" | "interrupted" | "failed" | null;
    /** Acknowledged model (request/runtime metadata, not backend observation). */
    observedModel: string;
    /** Acknowledged reasoning effort (request/runtime metadata, not observation). */
    observedReasoning: string;
    durationMs: number;
    outputChars: number;
  };
  candidate: CandidateOutcomeV1 | null;
  error: string | null;
}

export interface ImplementationPort {
  runModel(
    request: ModelRunRequestV1,
  ): Promise<PortResultV1<ModelRunReceiptV1>>;
}

// ---------------------------------------------------------------------------
// DenoReleasePort (m05): exact build discovery, current identity, promotion
// (which requires HTTP 204) and health/metrics sampling. The Git SHA and the
// Deno revision id are a single typed DeploymentIdentityV1; the build
// transaction id stays a separate exact identity.
// ---------------------------------------------------------------------------

export interface DenoBuildV1 {
  projectId: string;
  buildTransactionId: string;
  identity: DeploymentIdentityV1;
  status: "succeeded" | "failed" | "running" | "unknown";
  createdAt: number;
}

/** Exactly-one-candidate lookup: several records mean "ambiguous", not "found". */
export type BuildLookupV1 =
  | { status: "found"; build: DenoBuildV1 }
  | { status: "none" }
  | { status: "ambiguous" };

export interface DenoDeploymentV1 {
  projectId: string;
  /** Observed deployed identity; null means it could not be determined. */
  identity: DeploymentIdentityV1 | null;
  domain: string | null;
  status: "live" | "not_deployed" | "unknown";
  updatedAt: number | null;
}

export interface DenoPromotionRequestV1 {
  projectId: string;
  identity: DeploymentIdentityV1;
}

export const DENO_PROMOTION_REQUIRED_STATUS = 204;

export type DenoPromotionOutcomeV1 =
  | {
    outcome: "promoted";
    statusCode: 204;
    observedIdentity: DeploymentIdentityV1 | null;
  }
  | { outcome: "rejected"; statusCode: number; detail: string }
  | { outcome: "ambiguous"; statusCode: number | null; detail: string };

export interface HealthSampleConfigV1 {
  baseUrl: string;
  healthPath: string;
  managedBodyMarker: string;
  /** Non-secret identity headers that must match the managed deployment. */
  managedHeaders: { name: string; value: string }[];
  domain: string | null;
}

export interface HealthSampleV1 {
  at: number;
  status: "healthy" | "degraded" | "unreachable";
  httpStatus: number | null;
  bodyMarkerPresent: boolean | null;
  headersMatch: boolean | null;
  /** Observed exact deployed identity; null means it could not be determined. */
  identity: DeploymentIdentityV1 | null;
  domain: string | null;
}

export interface MetricsSampleConfigV1 {
  baseUrl: string;
  metricsPath: string;
  /**
   * Exact deployment identity (Git SHA + revision id) the window belongs to;
   * a sample window is never inferred from the current wall clock on resume.
   */
  identity: DeploymentIdentityV1;
  /** Inclusive start of the exact telemetry window; nonnegative. */
  windowStart: number;
  /** Exclusive end of the telemetry window; windowStart < windowEnd. */
  windowEnd: number;
  domain: string | null;
}

export interface DenoReleasePort {
  /**
   * Exact lookup by merged Git SHA, build transaction id AND the exact Deno
   * revision id from the authenticated build-receipt resolver. The revision id
   * is the required selector: two builds for the same SHA must never bind the
   * wrong accepted build receipt, and the platform never carries the Git SHA
   * or transaction id as a label. The transaction id is provenance supplied by
   * the trusted receipt resolver, never inferred from platform data.
   */
  findBuiltCandidate(
    projectId: string,
    revision: GitSha,
    buildTransactionId: string,
    revisionId: string,
  ): Promise<PortResultV1<BuildLookupV1>>;
  readCurrentDeployment(
    projectId: string,
  ): Promise<PortResultV1<DenoDeploymentV1>>;
  promote(
    request: DenoPromotionRequestV1,
  ): Promise<PortResultV1<DenoPromotionOutcomeV1>>;
  sampleHealth(
    config: HealthSampleConfigV1,
  ): Promise<PortResultV1<HealthSampleV1>>;
  sampleMetrics(
    config: MetricsSampleConfigV1,
  ): Promise<PortResultV1<MetricsSampleV1>>;
}

// ---------------------------------------------------------------------------
// StateStore: separate repair/release snapshot branches with strict
// expected-head compare-and-swap. Only repair writes work/budget/release
// requests; only release writes release records. The read-only view is
// separate from the writer capabilities so a release consumer never receives
// repair write capability (or vice versa); StateStore combines them for tests.
// ---------------------------------------------------------------------------

export type StateReadResultV1<T> =
  | { status: "found"; snapshot: T; head: GitSha; ref: string | null }
  | { status: "absent"; currentHead: GitSha | null; ref: string | null };

export type StateWriteResultV1 =
  | { status: "applied"; head: GitSha }
  | { status: "conflict"; currentHead: GitSha | null }
  | { status: "ambiguous"; currentHead: GitSha | null };

export interface StateReadView {
  readRepair(): Promise<PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>>;
  readRelease(): Promise<
    PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>>
  >;
}

export interface RepairStateWriter {
  writeRepair(
    next: RepairStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>>;
}

export interface ReleaseStateWriter {
  writeRelease(
    next: ReleaseStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>>;
}

export interface StateStore
  extends StateReadView, RepairStateWriter, ReleaseStateWriter {}

// ---------------------------------------------------------------------------
// Clock: testable time for deterministic tests.
// ---------------------------------------------------------------------------

export interface Clock {
  /** Current millisecond epoch. */
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}
