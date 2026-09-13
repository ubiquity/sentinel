/**
 * GitHubPort implementation (m01).
 *
 * Composition: an authenticated GitHub REST client (default HTTP path),
 * a trusted bounded Git executor (push publication + ancestry), an injected
 * review-service transport (model starts remain caller-budgeted; this module
 * only submits/observes), an injected Clock, and trusted adapter policy
 * (expected reviewer, trusted PR author, trusted human resolution authors).
 *
 * Safety invariants implemented here:
 * - Every write is exact-identity checked before and reconciled after an
 *   ambiguous response; nothing is retried blindly.
 * - Pushes are ordinary fast-forwards only, never forced; a new deterministic
 *   branch cannot overwrite an existing ref.
 * - PR creation reuses only the exact own PR; foreign/human-owned PRs block.
 * - Review completion is never inferred from silence, reactions, other bots,
 *   bare approvals or clean text without machine-verifiable terminal
 *   provenance; stale heads, wrong authors and missing findings fail closed.
 * - Merges re-observe the authoritative current PR/review/checks/protections,
 *   require the candidate to contain the exact expected base as ancestor and
 *   require effective strict server-enforced up-to-date protections with no
 *   applicable bypass; REST's non-atomic base handling is compensated by
 *   those protections plus the exact pre-merge re-observation, and a rejected
 *   merge is reconciled against the re-observed PR.
 * - Issue closure is idempotent.
 */

import type { GitSha } from "../contracts/brands.ts";
import { asFindingFingerprint } from "../contracts/brands.ts";
import { canonicalStringifySha256 } from "../contracts/canonical.ts";
import { parseMergeRequestV1 } from "../contracts/merge-request.ts";
import type {
  Clock,
  GitHubBranchProtectionsV1,
  GitHubChecksV1,
  GitHubCheckV1,
  GitHubCooldownGateV1,
  GitHubPort,
  GitHubRefV1,
  IssueCloseOutcomeV1,
  MergeOutcomeV1,
  MergeRequestV1,
  PortErrorV1,
  PortResultV1,
  PullRequestCreateV1,
  PullRequestPublishV1,
  ReviewDrainReportV1,
  ReviewDrainRequestV1,
  ReviewObservationRequestV1,
  ReviewObservationV1,
  ReviewRequestOutcomeV1,
  ReviewSubmissionV1,
  WriteOutcomeV1,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { GitHubIssueV1, GitHubPullRequestV1 } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import {
  expectNonEmptyString,
  MaxText,
  tryParse,
} from "../contracts/validation.ts";
import type { GitHubAuthProviderV1 } from "./auth.ts";
import { GitHubApiClient } from "./client.ts";
import type { GitExecutorV1 } from "./git-executor.ts";
import type { HttpTransportV1 } from "./http.ts";
import { sanitizeAutoCloseKeywords } from "./text.ts";
import {
  completedReviewMatchesReceipt,
  normalizeReviewObservation,
} from "./review-normalize.ts";
import { reviewOperationKey } from "../repair/keys.ts";
import type { ReviewNormalizationV1 } from "./review-normalize.ts";
import type {
  HumanResolutionVerifierV1,
  ReviewServiceTransportV1,
} from "./review-service.ts";
import { parsePullRequestRule, parseRequiredStatusRule } from "./wire.ts";
import type {
  GitHubReviewCommentWireV1,
  GitHubReviewWireV1,
  GitHubRuleSetWireV1,
} from "./wire.ts";

export interface GitHubPortOptionsV1 {
  repository: RepositoryIdentityV1;
  /** REST API base; default `https://api.github.com`. */
  apiBaseUrl?: string;
  http: HttpTransportV1;
  /** Installation token provider (injected; never created here). */
  auth: GitHubAuthProviderV1;
  /**
   * Durable cooldown gate in front of every authenticated request. Required
   * trusted capability: no permissive production default exists.
   */
  cooldownGate: GitHubCooldownGateV1;
  clock: Clock;
  /** Trusted git executor for push publication and base ancestry. */
  git: GitExecutorV1;
  /** Narrow injected review-service transport. */
  reviewService: ReviewServiceTransportV1;
  /** Actor login that authors Sentinel-owned PRs (e.g. `sentinel[bot]`). */
  trustedPrAuthor: string;
  /** Expected reviewer identity (e.g. `chatgpt-codex-connector[bot]`). */
  trustedReviewer: string;
  /** Humans authorized to resolve review findings (merge gate). This is a
   * secondary constraint only: an allowlist alone never authenticates a
   * resolution — `resolutionVerifier` must prove it. */
  trustedResolutionAuthors: string[];
  /**
   * Trusted authenticated human-resolution resolver. Required for merging
   * with resolved findings: the resolver authenticates the exact immutable
   * resolution reference bound to repo/PR/head/finding fingerprint and the
   * expected author. When absent, any resolved finding fail closes.
   */
  resolutionVerifier?: HumanResolutionVerifierV1;
  /** Paged read bounds. */
  perPage?: number;
  maxPages?: number;
  maxItems?: number;
  /**
   * Trusted opt-in: when exactly `true`, issue reads are enriched with native
   * dependency relations (`blockedBy`/sub-issue count). Absence leaves
   * relations unknown — never an empty list.
   */
  includeIssueRelations?: boolean;
  /** Finite whole-operation HTTP deadline (auth + request + body read). */
  requestDeadlineMs?: number;
  /** Finding normalization cap (default the contract 256). */
  findingCap?: number;
}

const DEFAULT_FINDING_CAP = 256;

export interface GitHubEffectiveProtectionsV1 {
  branch: string;
  /** Every active rule type that applies to the branch (sorted, unique). */
  activeRuleTypes: string[];
  /** Active rules the expected-head merge path cannot safely enforce. */
  unsupportedRuleTypes: string[];
  /** True when an active ruleset requires merge-queue merge semantics. */
  mergeQueueActive: boolean;
  /** Exact required status-check contexts from the active rules rule. */
  requiredCheckNames: string[];
  /** strict_required_status_checks_policy from the active rules rule. */
  strictRequiredChecks: boolean;
  /** required_approving_review_count from the active pull_request rule. */
  requiredApprovingReviewCount: number;
  /** True when the pull_request rule requires thread resolution we cannot
   * verify (unsupported requirement). */
  pullRequestThreadResolutionRequired: boolean;
  /** True when any contributing ruleset's bypass policy could not be read. */
  bypassUnknown: boolean;
  /** Bypass actors actually configured on contributing rulesets. */
  bypassActors: { actorType: string; actorId: number | null }[];
}

/**
 * Rules parsed from the actual branch-rules response that the expected-head
 * merge path can enforce: the merge is only ever checked against these.
 */
const SUPPORTED_MERGE_RULE_TYPES = new Set([
  "pull_request",
  "required_status_checks",
  "non_fast_forward",
  "creation",
  "deletion",
  "update",
]);

export class GitHubPortImpl implements GitHubPort {
  /**
   * Exact trusted review publisher identity configured for this port. The
   * repair loop reads this value for every review request/receipt binding;
   * there is no hardcoded connector default.
   */
  readonly reviewerIdentity: string;
  private readonly repository: RepositoryIdentityV1;
  private readonly client: GitHubApiClient;
  private readonly clock: Clock;
  private readonly git: GitExecutorV1;
  private readonly reviewService: ReviewServiceTransportV1;
  private readonly trustedPrAuthor: string;
  private readonly trustedReviewer: string;
  private readonly trustedResolutionAuthors: ReadonlySet<string>;
  private readonly resolutionVerifier: HumanResolutionVerifierV1 | null;
  private readonly findingCap: number;
  private readonly cooldownGate: GitHubCooldownGateV1;

  constructor(options: GitHubPortOptionsV1) {
    this.repository = options.repository;
    this.clock = options.clock;
    this.git = options.git;
    this.reviewService = options.reviewService;
    this.trustedPrAuthor = expectNonEmptyString(
      options.trustedPrAuthor,
      "trustedPrAuthor",
      MaxText.login,
    );
    this.trustedReviewer = expectNonEmptyString(
      options.trustedReviewer,
      "trustedReviewer",
      MaxText.login,
    );
    this.reviewerIdentity = this.trustedReviewer;
    this.trustedResolutionAuthors = new Set(options.trustedResolutionAuthors);
    this.resolutionVerifier = options.resolutionVerifier ?? null;
    this.findingCap = options.findingCap ?? DEFAULT_FINDING_CAP;
    this.cooldownGate = options.cooldownGate;
    this.client = new GitHubApiClient({
      repository: options.repository,
      apiBaseUrl: options.apiBaseUrl ?? "https://api.github.com",
      http: options.http,
      auth: options.auth,
      cooldownGate: options.cooldownGate,
      clock: options.clock,
      perPage: options.perPage,
      maxPages: options.maxPages,
      maxItems: options.maxItems,
      includeIssueRelations: options.includeIssueRelations,
      requestDeadlineMs: options.requestDeadlineMs,
    });
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  readIssue(
    issueNumber: number,
  ): Promise<PortResultV1<GitHubIssueV1 | null>> {
    return this.client.readIssue(issueNumber);
  }

  listOpenIssues(): Promise<PortResultV1<GitHubIssueV1[]>> {
    return this.client.listOpenIssues();
  }

  async findPullRequestByHeadRef(
    headRef: string,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    const listed = await this.client.listPullRequestsByHeadRef(headRef);
    if (!listed.ok) return listed;
    const pulls = listed.value;
    const open = pulls.filter((pull) => pull.state === "open");
    if (open.length === 1) return portOk(open[0]);
    if (open.length > 1) {
      return portError(
        "conflict",
        "multiple open pull requests share the head ref",
      );
    }
    if (pulls.length === 1) return portOk(pulls[0]);
    if (pulls.length === 0) return portOk(null);
    return portError("conflict", "multiple pull requests share the head ref");
  }

  readPullRequest(
    number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    return this.client.readPullRequest(number);
  }

  readChecks(head: GitSha): Promise<PortResultV1<GitHubChecksV1>> {
    return this.client.readChecks(head);
  }

  readProtections(
    baseBranch: string,
  ): Promise<PortResultV1<GitHubBranchProtectionsV1>> {
    return this.client.readProtections(baseBranch);
  }

  readRef(ref: string): Promise<PortResultV1<GitHubRefV1 | null>> {
    return this.client.readRef(ref);
  }

  // -------------------------------------------------------------------------
  // pushHead
  // -------------------------------------------------------------------------

  async pushHead(
    ref: string,
    sha: GitSha,
    expectedRef: GitSha | null,
  ): Promise<PortResultV1<WriteOutcomeV1>> {
    // 1. Exact expected-ref check against the authoritative remote identity.
    const current = await this.gatedRemoteCall(() =>
      this.git.readRemoteRef(ref)
    );
    if (!current.ok) return current;
    if (expectedRef === null) {
      // A new deterministic head ref cannot overwrite a conflicting existing ref.
      if (current.value !== null) {
        return portError("conflict", "head ref already exists");
      }
    } else {
      if (current.value === null) {
        return portError("conflict", "expected head ref is absent");
      }
      if (current.value !== expectedRef) {
        return portError("conflict", "head ref moved");
      }
    }
    // 2. The authenticated remote already advertises exactly this candidate:
    // the prior publication is proven by that observation alone. No local
    // ancestry check, no push and no model work; a conflicting or absent ref
    // was already rejected above.
    if (current.value === sha) return portOk("applied");
    // 3. Ordinary fast-forward only: the candidate must descend from the
    // current head when the branch exists.
    if (current.value !== null) {
      const ancestor = await this.git.isAncestor(current.value, sha);
      if (!ancestor.ok) return ancestor;
      if (!ancestor.value) {
        return portError("conflict", "push would not be a fast-forward");
      }
    }
    // 4. Publish through the trusted executor (never forced). The executor
    // atomically guards the exact advertised ref inside the push transaction;
    // a remote movement after this precheck is rejected, never applied.
    const pushed = await this.gatedRemoteCall(() =>
      this.git.push(ref, sha, expectedRef)
    );
    if (!pushed.ok) return pushed;
    switch (pushed.value.status) {
      case "applied":
        return portOk("applied");
      case "non_fast_forward":
        return portError("conflict", "push rejected as non-fast-forward");
      case "missing_object":
        return portError("invalid", "candidate commit is not available");
      case "rejected":
        return portError("conflict", "push was rejected");
      case "ambiguous":
        break;
    }
    // 4. Ambiguous effect: reread the exact remote identity and reconcile.
    // A cooldown denial or a failed reread keeps the effect unconfirmed: the
    // outcome stays ambiguous, never failed/applied, and the push is never
    // repeated.
    const after = await this.gatedRemoteCall(() => this.git.readRemoteRef(ref));
    if (!after.ok) {
      // The reread itself failed: the effect remains unconfirmed.
      return portOk("ambiguous");
    }
    if (after.value === sha) return portOk("applied");
    return portOk("ambiguous");
  }

  // -------------------------------------------------------------------------
  // createPullRequest
  // -------------------------------------------------------------------------

  async createPullRequest(
    request: PullRequestCreateV1,
  ): Promise<PortResultV1<PullRequestPublishV1>> {
    if (
      request.headRef.length === 0 || request.headRef.length > MaxText.branch
    ) {
      return portError("invalid", "invalid head branch");
    }
    if (
      request.baseRef.length === 0 || request.baseRef.length > MaxText.branch
    ) {
      return portError("invalid", "invalid base branch");
    }
    if (request.title.length > MaxText.message) {
      return portError(
        "invalid",
        "pull request title exceeds the contract bound",
      );
    }
    if (request.body.length > MaxText.body) {
      return portError(
        "invalid",
        "pull request body exceeds the contract bound",
      );
    }
    // 1. The deterministic head branch must exist and carry exactly the
    // expected candidate, or the publication precondition fails closed.
    const branch = await this.client.readRef(`heads/${request.headRef}`);
    if (!branch.ok) return branch;
    if (branch.value === null || branch.value.sha !== request.expectedHeadRef) {
      return portError(
        "conflict",
        "head branch does not exist or does not carry the expected candidate",
      );
    }
    // 2. Discover existing PRs on the exact head ref; reuse only the exact own
    // open PR, block foreign/human-owned PRs and collisions.
    const existing = await this.client.listPullRequestsByHeadRef(
      request.headRef,
    );
    if (!existing.ok) return existing;
    const open = existing.value.filter((pull) => pull.state === "open");
    if (open.length > 1) {
      return portError(
        "conflict",
        "multiple open pull requests share the head ref",
      );
    }
    if (open.length === 1) {
      const owned = open[0];
      if (owned.head !== request.expectedHeadRef) {
        return portError("conflict", "existing pull request head differs");
      }
      if (owned.base !== request.expectedBase) {
        // The base precondition is re-observed after publication: a moved
        // base means the publish precondition no longer holds.
        return portError("conflict", "pull request base moved");
      }
      if (owned.author !== this.trustedPrAuthor) {
        return portError(
          "conflict",
          "pull request is not owned by the trusted actor",
        );
      }
      return portOk({
        outcome: "applied",
        number: owned.number,
        head: owned.head,
      });
    }
    // 3. Publish with the auto-close keywords removed (source body preserved
    // otherwise), then reconcile a duplicate response against authoritative
    // state instead of guessing from the HTTP status.
    const created = await this.client.createPull({
      title: request.title,
      headRef: request.headRef,
      baseRef: request.baseRef,
      body: sanitizeAutoCloseKeywords(request.body),
    });
    if (!created.ok) return created;
    if (created.value.status === "created") {
      if (created.value.pr.base !== request.expectedBase) {
        // The base precondition is re-observed after publication: a moved
        // base means the published PR is not the exact candidate.
        return portError("conflict", "pull request base moved");
      }
      return portOk({
        outcome: "applied",
        number: created.value.pr.number,
        head: created.value.pr.head,
      });
    }
    const reread = await this.client.listPullRequestsByHeadRef(request.headRef);
    if (!reread.ok) return reread;
    const rereadOpen = reread.value.filter((pull) => pull.state === "open");
    if (rereadOpen.length === 1) {
      const owned = rereadOpen[0];
      if (
        owned.head === request.expectedHeadRef &&
        owned.author === this.trustedPrAuthor &&
        owned.base === request.expectedBase
      ) {
        return portOk({
          outcome: "applied",
          number: owned.number,
          head: owned.head,
        });
      }
      return portError("conflict", "existing pull request collision");
    }
    return portOk({ outcome: "ambiguous", number: null, head: null });
  }

  // -------------------------------------------------------------------------
  // requestReview / observeReview
  // -------------------------------------------------------------------------

  async requestReview(
    request: ReviewSubmissionV1,
  ): Promise<PortResultV1<ReviewRequestOutcomeV1>> {
    if (request.operationKey.length === 0) {
      return portError("invalid", "operation key is required");
    }
    if (request.expectedReviewer !== this.trustedReviewer) {
      return portError(
        "invalid",
        "reviewer identity is not the trusted reviewer",
      );
    }
    const pull = await this.client.readPullRequest(request.prNumber);
    if (!pull.ok) return pull;
    if (pull.value === null) {
      return portError("not_found", "pull request not found");
    }
    if (pull.value.head !== request.expectedHead) {
      return portError(
        "conflict",
        "pull request head differs from the expected head",
      );
    }
    if (pull.value.base !== request.expectedBase) {
      return portError(
        "conflict",
        "pull request base differs from the expected base",
      );
    }
    if (pull.value.state !== "open") {
      return portError("conflict", "pull request is not open");
    }
    if (
      !Number.isSafeInteger(request.latestStartAt) ||
      !Number.isSafeInteger(request.settleBy) ||
      request.settleBy <= request.latestStartAt
    ) {
      return portError("invalid", "review deadline bounds are invalid");
    }
    // Exactly one transport submission; a lost response stays ambiguous and is
    // reconciled later by the operation key.
    const submitted = await this.gatedRemoteCall(() =>
      this.reviewService.submitReview({
        operationKey: request.operationKey,
        prNumber: request.prNumber,
        expectedHead: request.expectedHead,
        expectedBase: request.expectedBase,
        expectedReviewer: request.expectedReviewer,
        latestStartAt: request.latestStartAt,
        settleBy: request.settleBy,
      })
    );
    if (!submitted.ok) return submitted;
    switch (submitted.value.status) {
      case "submitted":
        return portOk({
          outcome: "applied",
          requestId: submitted.value.requestId,
          requestedAt: submitted.value.requestedAt,
        });
      case "ambiguous":
        return portOk({
          outcome: "ambiguous",
          requestId: null,
          requestedAt: this.clock.now(),
        });
      case "rejected":
        return portError("conflict", "review request was rejected");
    }
  }

  async observeReview(
    request: ReviewObservationRequestV1,
  ): Promise<PortResultV1<ReviewObservationV1>> {
    if (request.operationKey.length === 0) {
      return portError("invalid", "operation key is required");
    }
    const pull = await this.client.readPullRequest(request.prNumber);
    if (!pull.ok) return pull;
    const service = await this.gatedRemoteCall(() =>
      this.reviewService.readReview({
        operationKey: request.operationKey,
        requestId: null,
        prNumber: request.prNumber,
      })
    );
    if (!service.ok) return service;
    let reviews: GitHubReviewWireV1[] = [];
    let comments: GitHubReviewCommentWireV1[] = [];
    if (pull.value !== null) {
      const readReviews = await this.client.readReviews(request.prNumber);
      if (!readReviews.ok) return readReviews;
      reviews = readReviews.value;
      const readComments = await this.client.readReviewComments(
        request.prNumber,
      );
      if (!readComments.ok) return readComments;
      comments = readComments.value;
    }
    return normalizeReviewObservation({
      request,
      service: service.value,
      repository: this.repository,
      expectedOperationKey: request.operationKey,
      pullRequest: pull.value,
      reviews,
      comments,
      expectedReviewer: this.trustedReviewer,
      findingCap: this.findingCap,
      receivedAt: this.clock.now(),
    });
  }

  // -------------------------------------------------------------------------
  // drainReviews
  // -------------------------------------------------------------------------

  /**
   * Forward the bounded review-lifecycle drain to the SAME review-service
   * transport instance this port submits through. Never starts a model,
   * never reserves budget and never writes repair state.
   */
  async drainReviews(
    request: ReviewDrainRequestV1,
  ): Promise<PortResultV1<ReviewDrainReportV1>> {
    if (
      typeof request !== "object" || request === null ||
      !Number.isSafeInteger(request.deadline) ||
      typeof request.interrupt !== "boolean"
    ) {
      return portError("invalid", "review drain request is invalid");
    }
    try {
      const report = await this.reviewService.drain({
        deadline: request.deadline,
        interrupt: request.interrupt,
      });
      return portOk(report);
    } catch {
      // A thrown drain is reported as sanitized unavailable, never as raw
      // transport detail; the entrypoint owns the typed drain failure.
      return portError("unavailable", "review drain failed");
    }
  }

  // -------------------------------------------------------------------------
  // mergePullRequest
  // -------------------------------------------------------------------------

  async mergePullRequest(
    request: MergeRequestV1,
  ): Promise<PortResultV1<MergeOutcomeV1>> {
    // 1. Strict parse against the trusted adapter policy: the request can
    // never name another repository or select the trusted reviewer.
    const parsed = tryParse(
      (value: unknown) =>
        parseMergeRequestV1(value, {
          repository: this.repository,
          expectedReviewer: this.trustedReviewer,
        }),
      request,
    );
    if (!parsed.ok) {
      return portError("invalid", "merge request is malformed");
    }
    const merge = parsed.value;
    // 2. Current authoritative PR and exact identities.
    const pull = await this.client.readPullRequest(merge.pullRequestNumber);
    if (!pull.ok) return pull;
    if (pull.value === null) {
      return portError("not_found", "pull request not found");
    }
    if (pull.value.state === "merged") {
      if (pull.value.head !== merge.expectedHead) {
        return blocked("head_mismatch", null);
      }
      return portOk({
        outcome: "merged",
        head: pull.value.head,
        mergeSha: pull.value.mergeSha!,
      });
    }
    if (pull.value.state === "closed") {
      return blocked("conflict", pull.value.head);
    }
    if (pull.value.head !== merge.expectedHead) {
      return blocked("head_mismatch", pull.value.head);
    }
    if (pull.value.base !== merge.expectedBase) {
      return blocked("base_mismatch", pull.value.head);
    }
    // Never merge human-owned/unassigned target work.
    if (pull.value.author !== this.trustedPrAuthor) {
      return blocked("conflict", pull.value.head);
    }
    // 3. Re-observe the authoritative current review by exact request id; the
    // caller-supplied receipt never grants authority by itself.
    const normalizedRes = await this.currentReviewEvidence(
      merge.pullRequestNumber,
      merge,
    );
    if (!normalizedRes.ok) {
      // The existing error object is returned as-is: rate-limit metadata
      // must survive every reconstruction.
      return { ok: false, error: normalizedRes.error };
    }
    const normalized = normalizedRes.normalized;
    if (normalized === null) {
      return blocked("review_required", pull.value.head);
    }
    if (!completedReviewMatchesReceipt(normalized, merge.review)) {
      return blocked("review_required", pull.value.head);
    }
    // Human resolution authorization: a trusted authenticated resolver must
    // prove each resolved finding's immutable reference against the exact
    // repo/PR/head/fingerprint/author; a caller-supplied resolved:true with an
    // allowlisted author name is never authentication by itself.
    if (!(await this.resolutionsTrusted(merge.review, pull.value))) {
      return blocked("review_required", pull.value.head);
    }
    // 4. Effective protections are the ACTIVE branch rules (branch-rules
    // response plus per-ruleset bypass policy) — classic branch protection
    // alone never proves effective server-enforced strict checks. Unreadable,
    // unsupported, merge-queue or bypassable policies block.
    const protections = await this.readEffectiveProtections(pull.value.baseRef);
    if (!protections.ok) return blocked("protection_required", pull.value.head);
    if (!evaluateEffectiveProtections(protections.value).ok) {
      return blocked("protection_required", pull.value.head);
    }
    // 5. Required checks all passing on the exact head.
    const checks = await this.client.readChecks(merge.expectedHead);
    if (!checks.ok) return blocked("protection_required", pull.value.head);
    if (checks.value.head !== merge.expectedHead) {
      return blocked("protection_required", pull.value.head);
    }
    const checkState = requiredChecksState(
      protections.value.requiredCheckNames,
      checks.value.checks,
    );
    if (checkState === "pending") {
      return blocked("checks_pending", pull.value.head);
    }
    if (checkState === "failed") {
      return blocked("checks_failed", pull.value.head);
    }
    // 6. Required GitHub approvals (distinct from the review receipt). The
    // REST pull response does not carry the authoritative approval state;
    // read the exact GraphQL field only when branch policy requires it.
    if (protections.value.requiredApprovingReviewCount > 0) {
      const approval = await this.client.readPullRequestReviewDecision(
        merge.pullRequestNumber,
      );
      if (!approval.ok || approval.value !== "approved") {
        return blocked("review_required", pull.value.head);
      }
    }
    // 7. Candidate ancestry: the candidate must contain the exact integrated
    // validated base as ancestor.
    const ancestor = await this.git.isAncestor(
      merge.expectedBase,
      merge.expectedHead,
    );
    if (!ancestor.ok) return ancestor;
    if (!ancestor.value) {
      return blocked("base_mismatch", pull.value.head);
    }
    // 8. Expected-head merge. REST has no atomic base CAS: the strict
    // up-to-date protection is what rejects a base movement after this last
    // precheck; a rejection is reconciled against the re-observed PR.
    const merged = await this.client.mergePull(
      merge.pullRequestNumber,
      merge.expectedHead,
    );
    if (!merged.ok) return merged;
    if (merged.value.status === "merged") {
      return portOk({
        outcome: "merged",
        head: merge.expectedHead,
        mergeSha: merged.value.mergeSha,
      });
    }
    if (merged.value.status === "ambiguous") {
      // The merge response was lost; report ambiguous unless the exact PR
      // proves the merge happened. Never a blind retry, and never pretend
      // "no effect": when the reconcile observation itself is unavailable the
      // effect stays ambiguous.
      const check = await this.client.readPullRequest(merge.pullRequestNumber);
      if (!check.ok) {
        return portOk({ outcome: "ambiguous", head: null, mergeSha: null });
      }
      if (
        check.value !== null && check.value.state === "merged" &&
        check.value.head === merge.expectedHead
      ) {
        return portOk({
          outcome: "merged",
          head: check.value.head,
          mergeSha: check.value.mergeSha!,
        });
      }
      return portOk({ outcome: "ambiguous", head: null, mergeSha: null });
    }
    const after = await this.client.readPullRequest(merge.pullRequestNumber);
    if (!after.ok) return after;
    if (after.value === null) return blocked("protection_required", null);
    if (after.value.state === "merged") {
      if (after.value.head !== merge.expectedHead) {
        return blocked("head_mismatch", after.value.head);
      }
      return portOk({
        outcome: "merged",
        head: after.value.head,
        mergeSha: after.value.mergeSha!,
      });
    }
    if (after.value.state === "closed") {
      return blocked("conflict", after.value.head);
    }
    if (after.value.head !== merge.expectedHead) {
      return blocked("head_mismatch", after.value.head);
    }
    if (after.value.base !== merge.expectedBase) {
      return blocked("base_mismatch", after.value.head);
    }
    const checksAfter = await this.client.readChecks(merge.expectedHead);
    if (checksAfter.ok && checksAfter.value.head === merge.expectedHead) {
      const stateAfter = requiredChecksState(
        protections.value.requiredCheckNames,
        checksAfter.value.checks,
      );
      if (stateAfter === "pending") {
        return blocked("checks_pending", after.value.head);
      }
      if (stateAfter === "failed") {
        return blocked("checks_failed", after.value.head);
      }
    }
    return blocked("protection_required", after.value.head);
  }

  // -------------------------------------------------------------------------
  // closeIssue
  // -------------------------------------------------------------------------

  async closeIssue(
    issueNumber: number,
  ): Promise<PortResultV1<IssueCloseOutcomeV1>> {
    const current = await this.client.readIssue(issueNumber);
    if (!current.ok) return current;
    if (current.value === null) {
      return portError("not_found", "issue not found");
    }
    if (current.value.state === "closed") {
      return portOk("already_closed");
    }
    const closed = await this.client.closeIssue(issueNumber);
    if (!closed.ok) {
      // The patch may still have applied (lost response): reconcile.
      const after = await this.client.readIssue(issueNumber);
      if (!after.ok) return after;
      if (after.value !== null && after.value.state === "closed") {
        return portOk("closed");
      }
      return closed;
    }
    if (closed.value.state !== "closed") {
      return portError("conflict", "issue closure was not applied");
    }
    return portOk("closed");
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * One narrow guard for the remote invocations that bypass the HTTP client's
   * own gate (trusted git transport and injected review-service transport).
   * The durable cooldown gate is checked immediately before the actual remote
   * call, and a typed rate-limited result is settled into the gate before the
   * error is returned. Gate throws are sanitized to unavailable; the remote
   * operation is never retried or mutated, and a gate denial is returned
   * as-is.
   */
  private async gatedRemoteCall<T>(
    operation: () => Promise<PortResultV1<T>>,
  ): Promise<PortResultV1<T>> {
    let granted: PortResultV1<void>;
    try {
      granted = await this.cooldownGate.beforeRequest(
        this.repository.installationId,
      );
    } catch {
      return portError("unavailable", "cooldown gate unavailable");
    }
    if (!granted.ok) return granted;
    const result = await operation();
    if (result.ok) return result;
    if (
      result.error.kind !== "rate_limited" ||
      result.error.rateLimit === undefined
    ) {
      return result;
    }
    let recorded: PortResultV1<void>;
    try {
      recorded = await this.cooldownGate.recordRateLimit(
        this.repository.installationId,
        result.error.rateLimit,
      );
    } catch {
      return portError("unavailable", "cooldown gate unavailable");
    }
    if (!recorded.ok) {
      return portError("unavailable", "cooldown gate unavailable");
    }
    return result;
  }

  private async currentReviewEvidence(
    prNumber: number,
    merge: {
      expectedHead: GitSha;
      review: { requestId: string; id: string };
    },
  ): Promise<
    | { ok: true; normalized: ReviewNormalizationV1 | null }
    | { ok: false; error: PortErrorV1 }
  > {
    const service = await this.gatedRemoteCall(() =>
      this.reviewService.readReview({
        operationKey: null,
        requestId: merge.review.requestId,
        prNumber,
      })
    );
    if (!service.ok) {
      return { ok: false, error: service.error };
    }
    const pull = await this.client.readPullRequest(prNumber);
    if (!pull.ok) {
      return { ok: false, error: pull.error };
    }
    const reviews = await this.client.readReviews(prNumber);
    if (!reviews.ok) {
      return { ok: false, error: reviews.error };
    }
    const comments = await this.client.readReviewComments(prNumber);
    if (!comments.ok) {
      return { ok: false, error: comments.error };
    }
    // The service must answer for the EXACT submission this receipt records:
    // derive the operation key from the exact PR/head, never by reversing the
    // opaque storage receipt id (which does not encode the operation key).
    const operationKey = reviewOperationKey(prNumber, merge.expectedHead);
    const observation = await normalizeReviewObservation({
      request: {
        operationKey,
        prNumber,
        head: merge.expectedHead,
      },
      service: service.value,
      repository: this.repository,
      expectedOperationKey: operationKey,
      pullRequest: pull.value,
      reviews: reviews.value,
      comments: comments.value,
      expectedReviewer: this.trustedReviewer,
      findingCap: this.findingCap,
      receivedAt: this.clock.now(),
    });
    if (!observation.ok) {
      return {
        ok: false,
        error: observation.error,
      };
    }
    if (observation.value.status !== "completed") {
      // Pending/unavailable/stale/completed-for-another-head: no merge
      // authorization from this request.
      return { ok: true, normalized: null };
    }
    return {
      ok: true,
      normalized: {
        status: observation.value.status,
        requestId: observation.value.requestId,
        reviewer: observation.value.reviewer,
        resultId: observation.value.resultId,
        completedAt: observation.value.completedAt,
        observedHead: observation.value.observedHead,
        observedBase: observation.value.observedBase,
        summary: observation.value.summary,
        findings: observation.value.findings.map((finding) => ({
          id: finding.id,
          severity: finding.severity,
          path: finding.path,
          message: finding.message,
        })),
        // Completed normalization is only reachable with a complete finding
        // set; the residual unknown count is a per-observation value.
        findingsUncounted: 0,
      },
    };
  }

  /**
   * Every resolved finding must be authenticated by the trusted resolver for
   * the exact immutable resolution reference bound to this repository, PR,
   * head and finding fingerprint, and the authenticated identity must be in
   * the configured allowlist. Without the concrete verifier integration, any
   * resolved finding fail closes.
   */
  private async resolutionsTrusted(
    receipt: MergeRequestV1["review"],
    pull: GitHubPullRequestV1,
  ): Promise<boolean> {
    const verifier = this.resolutionVerifier;
    if (verifier === null) {
      return receipt.findings.every((finding) => !finding.resolved);
    }
    for (const finding of receipt.findings) {
      if (!finding.resolved) continue;
      if (finding.resolutionEvidence === null) return false;
      // The exact finding identity is recomputed and must equal the recorded
      // fingerprint: a forged caller-supplied fingerprint never binds.
      const fingerprint = asFindingFingerprint(
        await canonicalStringifySha256({
          id: finding.id,
          severity: finding.severity,
          path: finding.path,
          message: finding.message,
        }),
      );
      if (fingerprint !== finding.fingerprint) return false;
      const verified = await verifier.verifyResolution({
        repository: this.repository,
        prNumber: pull.number,
        head: pull.head,
        findingFingerprint: finding.fingerprint,
        authorizingIdentity: finding.resolutionEvidence.authorizingIdentity,
        reference: finding.resolutionEvidence.reference,
      });
      if (!verified.ok) return false;
      if (!verified.value.verified) return false;
      if (
        verified.value.authorizingIdentity !==
          finding.resolutionEvidence.authorizingIdentity
      ) {
        return false;
      }
      if (
        !this.trustedResolutionAuthors.has(
          finding.resolutionEvidence.authorizingIdentity,
        )
      ) {
        return false;
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Effective protections (active repository/organization branch rules)
  // -------------------------------------------------------------------------

  /**
   * Authoritative effective protections for the configured base branch from
   * the actual GitHub rules API: all active matching rules (paginated) plus
   * the per-ruleset bypass policy (list with includes_parents, exact ruleset
   * details as needed). `bypass_actors` is omitted without adequate
   * permissions — omitted bypass policy is unknown and blocks.
   */
  async readEffectiveProtections(
    branch: string,
  ): Promise<PortResultV1<GitHubEffectiveProtectionsV1>> {
    const rules = await this.client.readBranchRules(branch);
    if (!rules.ok) return rules;
    const ruleSets = await this.client.readRepositoryRuleSets();
    if (!ruleSets.ok) return ruleSets;

    const activeRules = rules.value;
    const activeRuleTypes = uniqueSorted(rules.value.map((rule) => rule.type));
    const unsupportedRuleTypes = activeRuleTypes.filter(
      (type) => !SUPPORTED_MERGE_RULE_TYPES.has(type),
    );

    // Exact required status checks / pull-request requirement rules. A rule
    // of a known type with unreadable parameters is unreadable policy: fail
    // closed (never guessed).
    const statusRule = rules.value.find(
      (rule) => rule.type === "required_status_checks",
    );
    const pullRule = rules.value.find((rule) => rule.type === "pull_request");
    let requiredCheckNames: string[] = [];
    let strictRequiredChecks = false;
    let requiredApprovingReviewCount = 0;
    let pullRequestThreadResolutionRequired = false;
    if (statusRule !== undefined) {
      const parsed = tryParse(parseRequiredStatusRule, statusRule);
      if (!parsed.ok) {
        return portError(
          "invalid",
          "required status-checks rule parameters are unreadable",
        );
      }
      strictRequiredChecks = parsed.value.strict;
      requiredCheckNames = parsed.value.checkNames;
    }
    if (pullRule !== undefined) {
      const parsed = tryParse(parsePullRequestRule, pullRule);
      if (!parsed.ok) {
        return portError(
          "invalid",
          "pull_request rule parameters are unreadable",
        );
      }
      requiredApprovingReviewCount = parsed.value.requiredApprovingReviewCount;
      pullRequestThreadResolutionRequired =
        parsed.value.requiredReviewThreadResolution;
    }

    // Bypass policy for every ruleset that contributed an active rule. An
    // active rule whose ruleset identity or source binding is missing (or
    // contradicted by its evidence, or whose ruleset is not found / not
    // actively enforcing) makes the bypass policy unavailable/unknown:
    // unidentified active rules are never dropped from bypass verification,
    // and contradictory/missing enforcement evidence is never treated as
    // active non-bypassable policy.
    const byId = new Map(
      ruleSets.value.map((ruleSet) => [ruleSet.id, ruleSet]),
    );
    const detailCache = new Map<number, GitHubRuleSetWireV1>();
    let bypassUnknown = false;
    const bypassActors: { actorType: string; actorId: number | null }[] = [];
    for (const rule of activeRules) {
      const ruleSetId = rule.rulesetId;
      const sourceType = rule.rulesetSourceType;
      const source = rule.rulesetSource;
      if (ruleSetId === null || sourceType === null || source === null) {
        // An active rule without exact ruleset identity/source binding cannot
        // be bound to bypass evidence: its policy is unknown.
        bypassUnknown = true;
        continue;
      }
      let evidence = byId.get(ruleSetId) ?? null;
      if (evidence === null) {
        // An active rule whose ruleset cannot be found: unknown policy.
        bypassUnknown = true;
        continue;
      }
      if (
        !ruleSetEvidenceMatches(evidence, ruleSetId, sourceType, source) ||
        evidence.enforcement !== "active"
      ) {
        // Contradictory identity/source binding or non-active enforcement
        // cannot prove active non-bypassable policy.
        bypassUnknown = true;
        continue;
      }
      if (
        evidence.bypassActors === null ||
        evidence.currentUserCanBypass === null
      ) {
        evidence = detailCache.get(ruleSetId) ?? null;
        if (evidence === null) {
          const fetched = await this.client.readRepositoryRuleSet(ruleSetId);
          if (!fetched.ok) {
            bypassUnknown = true;
            continue;
          }
          evidence = fetched.value;
          detailCache.set(ruleSetId, evidence);
        }
      }
      if (
        !ruleSetEvidenceMatches(evidence, ruleSetId, sourceType, source) ||
        evidence.enforcement !== "active"
      ) {
        // The exact detail must be the requested ruleset with the same source
        // binding and active enforcement; anything else is contradictory.
        bypassUnknown = true;
        continue;
      }
      if (evidence.bypassActors === null) {
        // Omitted without adequate permissions: the policy is unknown.
        bypassUnknown = true;
        continue;
      }
      if (evidence.currentUserCanBypass === null) {
        bypassUnknown = true;
        continue;
      }
      if (evidence.currentUserCanBypass !== "never") {
        // The caller (or an unknown actor) can bypass: server enforcement
        // cannot be relied on.
        bypassUnknown = true;
        continue;
      }
      for (const actor of evidence.bypassActors) {
        bypassActors.push({
          actorType: actor.actorType,
          actorId: actor.actorId,
        });
      }
    }

    return portOk({
      branch,
      activeRuleTypes,
      unsupportedRuleTypes,
      mergeQueueActive: activeRuleTypes.includes("merge_queue"),
      requiredCheckNames,
      strictRequiredChecks,
      requiredApprovingReviewCount,
      pullRequestThreadResolutionRequired,
      bypassUnknown,
      bypassActors,
    });
  }
}

export function createGitHubPort(options: GitHubPortOptionsV1): GitHubPort {
  return new GitHubPortImpl(options);
}

/**
 * Effective strict server-enforced protections required for a merge, from
 * the active branch rules: a pull_request rule and a strict
 * required_status_checks rule with a non-empty check list must be active,
 * no unsupported/merge-queue rule may be active, the pull_request rule must
 * not require something we cannot verify (thread resolution), and the
 * per-ruleset bypass policy must be fully read and inapplicable. Unprotected,
 * unreadable, unsupported, incomplete or bypassable policy blocks.
 */
export function evaluateEffectiveProtections(
  protections: GitHubEffectiveProtectionsV1,
): { ok: true } | { ok: false; reason: string } {
  if (protections.unsupportedRuleTypes.length > 0) {
    return {
      ok: false,
      reason: `unsupported active rules: ${
        protections.unsupportedRuleTypes.join(", ")
      }`,
    };
  }
  if (protections.mergeQueueActive) {
    return { ok: false, reason: "merge queue rules are active" };
  }
  if (!protections.strictRequiredChecks) {
    return { ok: false, reason: "strict up-to-date checks are not enforced" };
  }
  if (protections.requiredCheckNames.length === 0) {
    return { ok: false, reason: "no required status checks are bound" };
  }
  if (!protections.activeRuleTypes.includes("pull_request")) {
    return { ok: false, reason: "pull_request rule is not active" };
  }
  if (protections.pullRequestThreadResolutionRequired) {
    return {
      ok: false,
      reason: "required review thread resolution cannot be verified",
    };
  }
  if (protections.bypassUnknown) {
    return { ok: false, reason: "bypass policy is unknown" };
  }
  if (protections.bypassActors.length > 0) {
    return { ok: false, reason: "bypass actors are configured" };
  }
  return { ok: true };
}

function uniqueSorted(names: string[]): string[] {
  return [...new Set(names)].sort();
}

/**
 * Exact ruleset evidence match: the evidence must be the requested ruleset
 * (id) with the same source binding as the contributing rule (`source_type`
 * + `source`). Anything else is contradictory evidence, never proof of
 * active non-bypassable policy.
 */
function ruleSetEvidenceMatches(
  evidence: GitHubRuleSetWireV1,
  ruleSetId: number,
  sourceType: "Repository" | "Organization",
  source: string,
): boolean {
  return evidence.id === ruleSetId &&
    evidence.sourceType === sourceType &&
    evidence.source === source;
}

type RequiredChecksState = "pass" | "pending" | "failed";

/**
 * Exact-name required checks on the exact head: commit-status contexts and
 * check runs share the same required name space. A missing or not-completed
 * observation is pending; any failed conclusion (including skipped, neutral,
 * timed_out, cancelled or action_required) is failed; only completed
 * `success` observations pass. GitHub returns historical observations for a
 * context, so only the newest observation (by its completion/start time) is
 * evaluated; an older pending or failed status must not override a newer pass.
 */
export function requiredChecksState(
  requiredNames: string[],
  checks: GitHubCheckV1[],
): RequiredChecksState {
  const latest = latestChecksByName(checks);
  let pending = false;
  for (const name of requiredNames) {
    const run = latest.get(name);
    if (run === undefined) {
      pending = true;
      continue;
    }
    if (run.status !== "completed" || run.conclusion === null) {
      pending = true;
      continue;
    }
    if (run.conclusion !== "success") return "failed";
  }
  return pending ? "pending" : "pass";
}

/**
 * Collapse historical check observations to one current value per context.
 * Commit statuses are returned newest-first, while check runs expose explicit
 * timestamps; the timestamp provides the same rule across both APIs. Equal
 * timestamps keep the first observation, preserving GitHub's newest-first
 * ordering without inventing a tie-breaker.
 */
function latestChecksByName(
  checks: GitHubCheckV1[],
): Map<string, GitHubCheckV1> {
  const latest = new Map<string, GitHubCheckV1>();
  for (const check of checks) {
    const previous = latest.get(check.name);
    if (
      previous === undefined ||
      checkObservationTime(check) > checkObservationTime(previous)
    ) {
      latest.set(check.name, check);
    }
  }
  return latest;
}

function checkObservationTime(check: GitHubCheckV1): number {
  return check.completedAt ?? check.startedAt ?? -1;
}

function blocked(
  reason: Extract<MergeOutcomeV1, { outcome: "blocked" }>["reason"],
  head: GitSha | null,
): PortResultV1<MergeOutcomeV1> {
  return portOk({ outcome: "blocked", reason, head });
}
