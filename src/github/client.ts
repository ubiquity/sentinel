/**
 * GitHub REST client: the default authenticated HTTP path behind the port.
 *
 * Reads use the actual API endpoints with exhaustive pagination and explicit
 * bounds: a page-size/cycle/edge cut is `unavailable`, never a partial
 * success. Writes return raw non-2xx outcomes to the port so the port can
 * reconcile ambiguous effects against authoritative state instead of guessing
 * from an HTTP status alone.
 *
 * Error discipline: every failure is a sanitized typed port error — no
 * response body, URL, header or token value is ever echoed into `detail`.
 */

import type { GitSha } from "../contracts/brands.ts";
import { isGitSha } from "../contracts/brands.ts";
import type { GitHubRateLimitV1 } from "../contracts/github-cooldown.ts";
import type {
  Clock,
  GitHubBranchProtectionsV1,
  GitHubChecksV1,
  GitHubCooldownGateV1,
  GitHubIssueV1,
  GitHubPullRequestV1,
  GitHubRefV1,
  GitHubReviewDecisionV1,
  PortErrorV1,
  PortResultV1,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import {
  expectArray,
  expectRecord,
  tryParse,
} from "../contracts/validation.ts";
import type { GitHubAuthProviderV1 } from "./auth.ts";
import {
  createDeadline,
  type DeadlineV1,
  DEFAULT_HTTP_DEADLINE_MS,
} from "./http.ts";
import type { HttpRequestV1, HttpResponseV1, HttpTransportV1 } from "./http.ts";
import { classifyGitHubRateLimit } from "./rate-limit.ts";
import { MAX_JOURNAL_BYTES } from "./review-journal.ts";
import {
  parseBranchRuleWire,
  parseCheckRunWire,
  parseCommitStatusWire,
  parseIssueWire,
  parseMergeResponseWire,
  parseProtectionWire,
  parsePullReviewDecisionWire,
  parsePullWire,
  parseRefWire,
  parseReviewCommentWire,
  parseReviewWire,
  parseRuleSetWire,
  unprotectedProtection,
} from "./wire.ts";
import type {
  GitHubBranchRuleWireV1,
  GitHubReviewCommentWireV1,
  GitHubReviewWireV1,
  GitHubRuleSetWireV1,
} from "./wire.ts";

export const MAX_OPEN_ISSUES = 10_000;
export const MAX_OPEN_ISSUE_PAGES = 500;

const REVIEW_DECISION_QUERY = `
  query SentinelPullReviewDecision($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewDecision
      }
    }
  }
`;

export interface GitHubApiClientOptionsV1 {
  repository: RepositoryIdentityV1;
  apiBaseUrl: string;
  http: HttpTransportV1;
  auth: GitHubAuthProviderV1;
  /**
   * Durable cooldown gate in front of every authenticated request. Required
   * trusted capability: no permissive production default exists.
   */
  cooldownGate: GitHubCooldownGateV1;
  /** Injectable clock for rate-limit observation timestamps. */
  clock: Clock;
  /** Paged read bounds (safety limits; exceeding them is unavailable). */
  perPage?: number;
  maxPages?: number;
  maxItems?: number;
  /**
   * Finite whole-operation deadline in ms, beginning before authentication
   * and covering the HTTP request and body read (default
   * `DEFAULT_HTTP_DEADLINE_MS`). Injected auth/transport/body reads that
   * ignore abort signals still cannot block indefinitely.
   */
  requestDeadlineMs?: number;
}

export type CreatePullWireV1 =
  | { status: "created"; pr: GitHubPullRequestV1 }
  | { status: "exists" };

export type MergePutWireV1 =
  | { status: "merged"; mergeSha: GitSha }
  | { status: "rejected" }
  | { status: "ambiguous" };

/**
 * Mutating review-operation outcome. `ambiguous` means the request was
 * submitted but its response was lost — the write may have applied and the
 * caller must reconcile against exact authoritative state; it never retries
 * and never creates a second object.
 */
export type ReviewMutationOutcomeV1 =
  | { status: "applied"; review: GitHubReviewWireV1 }
  | { status: "ambiguous" };

/**
 * Raw transport outcome: `lost` means no response reached the caller at all
 * (a write may have applied); `response` carries a status even when it is
 * 5xx (a definite server answer); `error` is an auth/transport boundary
 * failure where absolutely nothing was written.
 */
type RawSendResult =
  | { status: "response"; response: HttpResponseV1 }
  | { status: "lost" }
  | { status: "error"; error: PortErrorV1 };

export class GitHubApiClient {
  private readonly repository: RepositoryIdentityV1;
  private readonly apiBaseUrl: string;
  private readonly perPage: number;
  private readonly maxPages: number;
  private readonly maxItems: number;
  private readonly requestDeadlineMs: number;

  constructor(private readonly options: GitHubApiClientOptionsV1) {
    this.repository = options.repository;
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "");
    this.perPage = options.perPage ?? 100;
    this.maxPages = options.maxPages ?? MAX_OPEN_ISSUE_PAGES;
    this.maxItems = options.maxItems ?? MAX_OPEN_ISSUES;
    this.requestDeadlineMs = options.requestDeadlineMs ??
      DEFAULT_HTTP_DEADLINE_MS;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async listOpenIssues(): Promise<PortResultV1<GitHubIssueV1[]>> {
    const collected = await this.collectPages(
      `/repos/${repoPath(this.repository)}/issues`,
      { state: "open", per_page: String(this.perPage) },
      // GitHub's REST `/issues` endpoint returns a top-level array. The
      // object envelope used by search is a different API shape and must not
      // be accepted here because it would hide a provider contract drift.
      (body) => expectArray(body, "$", this.maxItems, (v) => v) as unknown[],
    );
    if (!collected.ok) return collected;
    const issues: GitHubIssueV1[] = [];
    for (const item of collected.value) {
      // Issue-vs-PR distinction: `/issues` lists pull requests too and GitHub
      // marks them with a `pull_request` key; a PR is never an issue here.
      const parsed = parseWith(item, (v) => parseIssueWire(v, "$"));
      if (!parsed.ok) return parsed;
      if (parsed.value.kind === "issue") issues.push(parsed.value.issue);
    }
    return portOk(issues);
  }

  async readIssue(
    issueNumber: number,
  ): Promise<PortResultV1<GitHubIssueV1 | null>> {
    const response = await this.request(
      "GET",
      `/repos/${repoPath(this.repository)}/issues/${issueNumber}`,
    );
    if (!response.ok) return response;
    if (response.value.status === 404) return portOk(null);
    const parsed = parseWire(response.value, (v) => parseIssueWire(v, "$"));
    if (!parsed.ok) return parsed;
    if (parsed.value.kind === "pull_request") {
      // A pull request is not an issue; the caller's issue does not exist as
      // one. Distinct from a transport failure, never a fabricated issue.
      return portOk(null);
    }
    return portOk(parsed.value.issue);
  }

  /** Raw open/closed PR list for a head ref (discovery; exact match later). */
  async listPullRequestsByHeadRef(
    headRef: string,
  ): Promise<PortResultV1<GitHubPullRequestV1[]>> {
    const collected = await this.collectPages(
      `/repos/${repoPath(this.repository)}/pulls`,
      {
        head: `${this.repository.owner}:${headRef}`,
        state: "all",
        per_page: String(this.perPage),
      },
      (body) => expectArray(body, "$", this.maxItems, (v) => v) as unknown[],
    );
    if (!collected.ok) return collected;
    const pulls: GitHubPullRequestV1[] = [];
    for (const item of collected.value) {
      const parsed = parseWith(item, (v) => parsePullWire(v, "$"));
      if (!parsed.ok) return parsed;
      if (parsed.value.headRef === headRef) pulls.push(parsed.value);
    }
    return portOk(pulls);
  }

  async readPullRequest(
    number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    const response = await this.request(
      "GET",
      `/repos/${repoPath(this.repository)}/pulls/${number}`,
    );
    if (!response.ok) return response;
    if (response.value.status === 404) return portOk(null);
    const parsed = parseWire(response.value, (v) => parsePullWire(v, "$"));
    if (!parsed.ok) return parsed;
    return portOk(parsed.value);
  }

  /** Read approval from GitHub's authoritative GraphQL field. */
  async readPullRequestReviewDecision(
    number: number,
  ): Promise<PortResultV1<GitHubReviewDecisionV1>> {
    const raw = await this.sendCore(
      "POST",
      `${this.apiBaseUrl}/graphql`,
      {
        query: REVIEW_DECISION_QUERY,
        variables: {
          owner: this.repository.owner,
          name: this.repository.name,
          number,
        },
      },
    );
    if (raw.status === "error") {
      return portError(raw.error.kind, raw.error.detail, raw.error.rateLimit);
    }
    if (raw.status === "lost") {
      return portError("unavailable", "GitHub API request failed");
    }
    if (raw.response.status !== 200) {
      return portError(...this.mapError(raw.response));
    }
    return parseWire(
      raw.response,
      (value) => parsePullReviewDecisionWire(value, "$"),
    );
  }

  async readChecks(sha: GitSha): Promise<PortResultV1<GitHubChecksV1>> {
    const collected = await this.collectPages(
      `/repos/${repoPath(this.repository)}/commits/${sha}/check-runs`,
      { per_page: String(this.perPage) },
      (body) => {
        const obj = expectRecord(body, "$");
        return expectArray(
          obj.check_runs,
          "$.check_runs",
          this.maxItems,
          (v) => v,
        ) as unknown[];
      },
    );
    if (!collected.ok) return collected;
    const checks = [];
    for (const item of collected.value) {
      const parsed = parseWith(item, (v) => parseCheckRunWire(v, "$"));
      if (!parsed.ok) return parsed;
      // Every run must be bound to the exact requested head: a run recorded
      // for a different commit is not evidence for this head, and accepting
      // it would let a stale run satisfy a required check.
      if (parsed.value.head !== sha) {
        return portError(
          "unavailable",
          "checks collection does not match the requested head",
        );
      }
      checks.push(parsed.value);
    }
    const statusesCollected = await this.collectPages(
      `/repos/${repoPath(this.repository)}/commits/${sha}/statuses`,
      { per_page: String(this.perPage) },
      (body) => {
        return expectArray(
          body,
          "$",
          this.maxItems,
          (v) => v,
        ) as unknown[];
      },
    );
    if (!statusesCollected.ok) return statusesCollected;
    for (const item of statusesCollected.value) {
      const parsed = parseWith(item, (v) => parseCommitStatusWire(v, "$", sha));
      if (!parsed.ok) return parsed;
      checks.push(parsed.value);
    }
    if (checks.length > this.maxItems) {
      return portError(
        "unavailable",
        "GitHub API checks collection size bound exceeded",
      );
    }
    return portOk({ head: sha, checks });
  }

  async readProtections(
    branch: string,
  ): Promise<PortResultV1<GitHubBranchProtectionsV1>> {
    const response = await this.request(
      "GET",
      `/repos/${repoPath(this.repository)}/branches/${
        encodeURIComponent(branch)
      }/protection`,
    );
    if (!response.ok) return response;
    if (response.value.status === 404) {
      // Unprotected branch (or absent branch): a real observed value, never
      // an error and never "protected".
      return portOk(unprotectedProtection(branch));
    }
    const parsed = parseWire(
      response.value,
      (v) => parseProtectionWire(v, branch),
    );
    if (!parsed.ok) return parsed;
    return portOk(parsed.value);
  }

  async readRef(inputRef: string): Promise<PortResultV1<GitHubRefV1 | null>> {
    const ref = inputRef.startsWith("refs/")
      ? inputRef.slice("refs/".length)
      : inputRef;
    const response = await this.request(
      "GET",
      `/repos/${repoPath(this.repository)}/git/ref/${ref}`,
    );
    if (!response.ok) return response;
    if (response.value.status === 404) return portOk(null);
    const parsed = parseWire(response.value, (v) => parseRefWire(v, "$"));
    if (!parsed.ok) return parsed;
    if (parsed.value.ref !== `refs/${ref}`) {
      return portError("invalid", "GitHub API response is malformed");
    }
    return portOk(parsed.value);
  }

  async readReviews(
    number: number,
  ): Promise<PortResultV1<GitHubReviewWireV1[]>> {
    const collected = await this.collectPages(
      `/repos/${repoPath(this.repository)}/pulls/${number}/reviews`,
      { per_page: String(this.perPage) },
      (body) => expectArray(body, "$", this.maxItems, (v) => v) as unknown[],
    );
    if (!collected.ok) return collected;
    const reviews: GitHubReviewWireV1[] = [];
    for (const item of collected.value) {
      const parsed = parseWith(item, (v) => parseReviewWire(v, "$"));
      if (!parsed.ok) return parsed;
      reviews.push(parsed.value);
    }
    return portOk(reviews);
  }

  async readReviewComments(
    number: number,
  ): Promise<PortResultV1<GitHubReviewCommentWireV1[]>> {
    const collected = await this.collectPages(
      `/repos/${repoPath(this.repository)}/pulls/${number}/comments`,
      { per_page: String(this.perPage) },
      (body) => expectArray(body, "$", this.maxItems, (v) => v) as unknown[],
    );
    if (!collected.ok) return collected;
    const comments: GitHubReviewCommentWireV1[] = [];
    for (const item of collected.value) {
      const parsed = parseWith(item, (v) => parseReviewCommentWire(v, "$"));
      if (!parsed.ok) return parsed;
      comments.push(parsed.value);
    }
    return portOk(comments);
  }

  /**
   * All active rules that apply to the branch (repository + organization
   * level), exhausted with the same bounds as every other paged read.
   */
  async readBranchRules(
    branch: string,
  ): Promise<PortResultV1<GitHubBranchRuleWireV1[]>> {
    const collected = await this.collectPages(
      `/repos/${repoPath(this.repository)}/rules/branches/${
        encodeURIComponent(branch)
      }`,
      { per_page: String(this.perPage) },
      (body) => expectArray(body, "$", this.maxItems, (v) => v) as unknown[],
    );
    if (!collected.ok) return collected;
    const rules: GitHubBranchRuleWireV1[] = [];
    for (const item of collected.value) {
      const parsed = parseWith(item, (v) => parseBranchRuleWire(v, "$"));
      if (!parsed.ok) return parsed;
      rules.push(parsed.value);
    }
    return portOk(rules);
  }

  /** Repository rulesets including parent (organization) rulesets that apply. */
  async readRepositoryRuleSets(): Promise<PortResultV1<GitHubRuleSetWireV1[]>> {
    const collected = await this.collectPages(
      `/repos/${repoPath(this.repository)}/rulesets`,
      {
        includes_parents: "true",
        per_page: String(this.perPage),
      },
      (body) => expectArray(body, "$", this.maxItems, (v) => v) as unknown[],
    );
    if (!collected.ok) return collected;
    const rulesets: GitHubRuleSetWireV1[] = [];
    for (const item of collected.value) {
      const parsed = parseWith(item, (v) => parseRuleSetWire(v, "$"));
      if (!parsed.ok) return parsed;
      rulesets.push(parsed.value);
    }
    return portOk(rulesets);
  }

  /** Exact ruleset details (rules and bypass policy for one ruleset). */
  async readRepositoryRuleSet(
    ruleSetId: number,
  ): Promise<PortResultV1<GitHubRuleSetWireV1>> {
    const response = await this.request(
      "GET",
      `/repos/${repoPath(this.repository)}/rulesets/${ruleSetId}`,
    );
    if (!response.ok) return response;
    const parsed = parseWire(response.value, (v) => parseRuleSetWire(v, "$"));
    if (!parsed.ok) return parsed;
    return portOk(parsed.value);
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async createPull(create: {
    title: string;
    headRef: string;
    baseRef: string;
    body: string;
  }): Promise<PortResultV1<CreatePullWireV1>> {
    const raw = await this.sendCore(
      "POST",
      `${this.apiBaseUrl}/repos/${repoPath(this.repository)}/pulls`,
      {
        title: create.title,
        head: `${this.repository.owner}:${create.headRef}`,
        base: create.baseRef,
        body: create.body,
      },
    );
    if (raw.status === "error") {
      return portError(raw.error.kind, raw.error.detail, raw.error.rateLimit);
    }
    if (raw.status === "lost") {
      // The response was lost; the pull may have been created. The port
      // reconciles through exact discovery before concluding anything.
      return portOk({ status: "exists" });
    }
    const response = raw.response;
    if (response.status === 201) {
      const parsed = parseWire(
        response,
        (v) => parsePullWire(v, "$"),
      );
      if (!parsed.ok) return parsed;
      return portOk({ status: "created", pr: parsed.value });
    }
    if (response.status === 422 || response.status === 409) {
      return portOk({ status: "exists" });
    }
    return portError(...this.mapError(response));
  }

  async mergePull(
    number: number,
    sha: GitSha,
  ): Promise<PortResultV1<MergePutWireV1>> {
    const raw = await this.sendCore(
      "PUT",
      `${this.apiBaseUrl}/repos/${
        repoPath(this.repository)
      }/pulls/${number}/merge`,
      { sha },
    );
    if (raw.status === "error") {
      return portError(raw.error.kind, raw.error.detail, raw.error.rateLimit);
    }
    if (raw.status === "lost") {
      // The response was lost; the merge may have been applied. The port
      // re-observes the exact PR before reporting.
      return portOk({ status: "ambiguous" });
    }
    const response = raw.response;
    if (response.status === 200) {
      const parsed = parseWire(
        response,
        (v) => parseMergeResponseWire(v, "$"),
      );
      if (!parsed.ok) return parsed;
      return portOk({ status: "merged", mergeSha: parsed.value.mergeSha });
    }
    if (
      response.status === 405 || response.status === 409 ||
      response.status === 422
    ) {
      // Known non-merge states: the port re-observes the exact PR to
      // determine the blocked reason rather than guessing from the status.
      return portOk({ status: "rejected" });
    }
    return portError(...this.mapError(response));
  }

  async closeIssue(issueNumber: number): Promise<PortResultV1<GitHubIssueV1>> {
    const response = await this.send(
      "PATCH",
      `/repos/${repoPath(this.repository)}/issues/${issueNumber}`,
      {},
      { state: "closed" },
    );
    if (!response.ok) return response;
    if (response.value.status === 200) {
      const parsed = parseWire(response.value, (v) => parseIssueWire(v, "$"));
      if (!parsed.ok) return parsed;
      if (parsed.value.kind === "pull_request") {
        return portError("invalid", "GitHub API response is malformed");
      }
      return portOk(parsed.value.issue);
    }
    return portError(...this.mapError(response.value));
  }

  // -------------------------------------------------------------------------
  // Review journal operations (pending-draft lifecycle)
  // -------------------------------------------------------------------------
  // The review body is the durable operation journal; all four operations go
  // through the same authenticated gate/deadline/cooldown path as every other
  // client call. There is no automatic retry of a mutating call and no create
  // on ambiguity: the caller reconciles the exact review id first.

  /** Read the exact review for the PR (404 is a real observed null). */
  async readPullReview(
    number: number,
    reviewId: number,
  ): Promise<PortResultV1<GitHubReviewWireV1 | null>> {
    const invalid = validateReviewOperationInput(
      { prNumber: number, reviewId },
      ["reviewId"],
    );
    if (invalid !== null) return portError(invalid.kind, invalid.detail);
    const response = await this.request(
      "GET",
      `/repos/${repoPath(this.repository)}/pulls/${number}/reviews/${reviewId}`,
    );
    if (!response.ok) return response;
    if (response.value.status === 404) return portOk(null);
    return parseWire(response.value, (v) => parseReviewWire(v, "$"));
  }

  /** Create a PENDING review on the exact head (no event is ever sent). */
  async createPendingReview(
    number: number,
    head: GitSha,
    body: string,
  ): Promise<PortResultV1<ReviewMutationOutcomeV1>> {
    const invalid = validateReviewOperationInput(
      { prNumber: number, head, body },
      ["head", "body"],
    );
    if (invalid !== null) return portError(invalid.kind, invalid.detail);
    const raw = await this.sendCore(
      "POST",
      `${this.apiBaseUrl}/repos/${
        repoPath(this.repository)
      }/pulls/${number}/reviews`,
      { commit_id: head, body },
    );
    return this.reviewMutationOutcome(raw, "pending");
  }

  /** Replace the body of the exact pending review (no event is ever sent). */
  async updatePendingReview(
    number: number,
    reviewId: number,
    body: string,
  ): Promise<PortResultV1<ReviewMutationOutcomeV1>> {
    const invalid = validateReviewOperationInput(
      { prNumber: number, reviewId, body },
      ["reviewId", "body"],
    );
    if (invalid !== null) return portError(invalid.kind, invalid.detail);
    const raw = await this.sendCore(
      "PUT",
      `${this.apiBaseUrl}/repos/${
        repoPath(this.repository)
      }/pulls/${number}/reviews/${reviewId}`,
      { body },
    );
    return this.reviewMutationOutcome(raw, "pending");
  }

  /**
   * Submit the exact review with event COMMENT. APPROVE is never sent: the
   * publisher is the PR author identity and must not approve its own work.
   */
  async submitReview(
    number: number,
    reviewId: number,
    body: string,
  ): Promise<PortResultV1<ReviewMutationOutcomeV1>> {
    const invalid = validateReviewOperationInput(
      { prNumber: number, reviewId, body },
      ["reviewId", "body"],
    );
    if (invalid !== null) return portError(invalid.kind, invalid.detail);
    const raw = await this.sendCore(
      "POST",
      `${this.apiBaseUrl}/repos/${
        repoPath(this.repository)
      }/pulls/${number}/reviews/${reviewId}/events`,
      { event: "COMMENT", body },
    );
    return this.reviewMutationOutcome(raw, "commented");
  }

  private reviewMutationOutcome(
    raw: RawSendResult,
    expectedState: "pending" | "commented",
  ): PortResultV1<ReviewMutationOutcomeV1> {
    if (raw.status === "error") {
      // Typed auth/rate-limit errors (including metadata) are preserved.
      return portError(raw.error.kind, raw.error.detail, raw.error.rateLimit);
    }
    if (raw.status === "lost") {
      // The request may have applied; reconciliation is the caller's job. No
      // second request is issued by this method.
      return portOk({ status: "ambiguous" });
    }
    if (raw.response.status !== 200 && raw.response.status !== 201) {
      return portError(...this.mapError(raw.response));
    }
    const parsed = parseWire(raw.response, (v) => parseReviewWire(v, "$"));
    if (!parsed.ok) return parsed;
    if (parsed.value.state !== expectedState) {
      return portError("invalid", "GitHub API response is malformed");
    }
    return portOk({ status: "applied", review: parsed.value });
  }

  // -------------------------------------------------------------------------
  // Transport plumbing
  // -------------------------------------------------------------------------

  private async request(
    method: HttpRequestV1["method"],
    path: string,
    query: Record<string, string> = {},
  ): Promise<PortResultV1<HttpResponseV1>> {
    const sent = await this.send(method, path, query, null);
    if (!sent.ok) return sent;
    if (sent.value.status >= 200 && sent.value.status < 300) return sent;
    if (sent.value.status === 404) {
      // 404 is a real observed value ("absent") for the read callers; they
      // decide whether that means null or not_found.
      return sent;
    }
    return portError(...this.mapError(sent.value));
  }

  private send(
    method: HttpRequestV1["method"],
    path: string,
    query: Record<string, string>,
    body: Record<string, unknown> | null,
  ): Promise<PortResultV1<HttpResponseV1>> {
    const queryText = new URLSearchParams(query).toString();
    const url = `${this.apiBaseUrl}${path}${
      queryText.length === 0 ? "" : `?${queryText}`
    }`;
    return this.sendCore(method, url, body).then((raw) => {
      if (raw.status === "response") return portOk(raw.response);
      if (raw.status === "lost") {
        return portError("unavailable", "GitHub API request failed");
      }
      return portError(raw.error.kind, raw.error.detail, raw.error.rateLimit);
    });
  }

  private async sendCore(
    method: HttpRequestV1["method"],
    url: string,
    body: Record<string, unknown> | null,
  ): Promise<RawSendResult> {
    // One finite whole-operation deadline starts before authentication,
    // covers the gate reads, the HTTP request and the body read. A hung
    // injected gate or auth provider cannot block the operation beyond it.
    const deadline = createDeadline(this.requestDeadlineMs);
    try {
      // Durable cooldown gate before authentication: a blocked installation
      // never reaches the provider or the network, and its typed error is
      // preserved (including rate-limit metadata).
      const before = await this.requestGate(deadline);
      if (before !== null) return before;
      let header: PortResultV1<string>;
      try {
        const authPromise = Promise.resolve().then(() =>
          this.options.auth.authorizationHeader()
        );
        // The auth promise may settle after the deadline fired; it must never
        // surface as an unhandled rejection.
        authPromise.catch(() => {});
        header = await deadline.race(authPromise);
      } catch {
        // The auth provider threw or hung without ever completing: no request
        // was issued, so no write was submitted. Sanitized typed failure.
        return {
          status: "error",
          error: {
            kind: "auth_failed",
            detail: "GitHub API authentication failed",
          },
        };
      }
      if (!header.ok) {
        // Auth can fail with typed rate-limit metadata (token refresh was
        // throttled): the observation is durably recorded before the error
        // propagates. Duplicate identity recording is safe — the real gate is
        // idempotent — and a recording failure overrides with unavailable.
        const recorded = await this.recordGateRateLimit(
          deadline,
          header.error.rateLimit,
        );
        if (recorded !== null) return recorded;
        return { status: "error", error: header.error };
      }
      if (header.value.includes("\r") || header.value.includes("\n")) {
        return {
          status: "error",
          error: { kind: "invalid", detail: "invalid authorization header" },
        };
      }
      // The gate is re-checked immediately before the request, and an expired
      // whole-operation deadline never submits HTTP.
      const again = await this.requestGate(deadline);
      if (again !== null) return again;
      let response: HttpResponseV1;
      try {
        response = await deadline.race(
          Promise.resolve().then(() =>
            this.options.http({
              method,
              url,
              headers: new Map<string, string>([
                ["authorization", header.value],
                ["accept", "application/vnd.github+json"],
                ["x-github-api-version", "2022-11-28"],
              ]),
              body: body === null ? null : JSON.stringify(body),
            })
          ),
        );
      } catch {
        // The deadline fired or the transport rejected/throw before a
        // response was received: the effect of a write is unknown (it may
        // have been submitted), a read is unavailable.
        return { status: "lost" };
      }
      // Classification is intercepted here, before mapError: a confirmed
      // rate-limit observation is durably recorded before any typed error
      // leaves this method, and no request starts while persistence is
      // unsettled. A thrown classifier (or recordRateLimit) never escapes;
      // it becomes the sanitized static unavailable failure.
      let rateLimit: GitHubRateLimitV1 | null;
      try {
        rateLimit = await classifyGitHubRateLimit(
          response,
          this.options.clock.now(),
        );
      } catch {
        return unavailable();
      }
      if (rateLimit !== null) {
        const recorded = await this.recordGateRateLimit(deadline, rateLimit);
        if (recorded !== null) return recorded;
        return {
          status: "error",
          error: {
            kind: "rate_limited",
            detail: "GitHub API rate limit exceeded",
            rateLimit,
          },
        };
      }
      return { status: "response", response };
    } finally {
      deadline.dispose();
    }
  }

  /**
   * Await the durable gate read, bounded by the whole-operation deadline. A
   * thrown gate, an expired bound or a late resolution is the sanitized
   * static unavailable failure — never an escaped error, never a request. A
   * real gate answer (blocked) is preserved as-is and prevents HTTP.
   */
  private async requestGate(
    deadline: DeadlineV1,
  ): Promise<RawSendResult | null> {
    let result: PortResultV1<void>;
    try {
      const gatePromise = Promise.resolve().then(() =>
        this.options.cooldownGate.beforeRequest(this.repository.installationId)
      );
      // A gate that settles after the deadline fired must never surface as an
      // unhandled rejection.
      gatePromise.catch(() => {});
      result = await deadline.race(gatePromise);
    } catch {
      return unavailable();
    }
    if (deadline.fired()) return unavailable();
    if (!result.ok) return { status: "error", error: result.error };
    return null;
  }

  /**
   * Durably record a rate-limit observation. Persistence is awaited to
   * settlement directly — never raced against the operation deadline, so a
   * record cannot be abandoned mid-write while a later request proceeds.
   * Returns null on success (or when there is no observation); a
   * thrown/rejected gate or failed persistence overrides with the sanitized
   * static unavailable failure and prevents any further request. The
   * deadline is checked only after persistence has settled: an expired bound
   * after a completed record is still unavailable, but it can never make
   * this method return before persistence completes.
   */
  private async recordGateRateLimit(
    deadline: DeadlineV1,
    rateLimit: GitHubRateLimitV1 | undefined,
  ): Promise<RawSendResult | null> {
    if (rateLimit === undefined) return null;
    try {
      const result = await Promise.resolve().then(() =>
        this.options.cooldownGate.recordRateLimit(
          this.repository.installationId,
          rateLimit,
        )
      );
      if (deadline.fired()) return unavailable();
      if (!result.ok) return unavailable();
      return null;
    } catch {
      return unavailable();
    }
  }

  private mapError(response: HttpResponseV1): [PortErrorV1["kind"], string] {
    if (response.status === 401) {
      return ["auth_failed", "GitHub API authentication failed"];
    }
    if (response.status === 403) {
      if (response.headers.get("x-ratelimit-remaining") === "0") {
        return ["rate_limited", "GitHub API rate limit exceeded"];
      }
      return ["auth_failed", "GitHub API request was forbidden"];
    }
    if (response.status === 404) {
      return ["not_found", "GitHub resource not found"];
    }
    if (response.status === 429) {
      return ["rate_limited", "GitHub API rate limit exceeded"];
    }
    return ["unavailable", "GitHub API request failed"];
  }

  private async collectPages<T>(
    path: string,
    query: Record<string, string>,
    extract: (body: unknown) => unknown[],
  ): Promise<PortResultV1<T[]>> {
    const queryText = new URLSearchParams({ ...query, page: "1" }).toString();
    let url = `${this.apiBaseUrl}${path}?${queryText}`;
    const seen = new Set<string>([url]);
    const items: T[] = [];
    for (let page = 1; page <= this.maxPages; page++) {
      const sent = await this.sendCore("GET", url, null);
      if (sent.status === "lost") {
        return portError("unavailable", "GitHub API request failed");
      }
      if (sent.status === "error") {
        return portError(
          sent.error.kind,
          sent.error.detail,
          sent.error.rateLimit,
        );
      }
      const response = sent.response;
      if (response.status !== 200) {
        return portError(...this.mapError(response));
      }
      const body = parseWire(response, (v) => v);
      if (!body.ok) return body;
      const parsed = parseWith(body.value, extract);
      if (!parsed.ok) return parsed;
      items.push(...(parsed.value as T[]));
      if (items.length > this.maxItems) {
        return portError(
          "unavailable",
          "GitHub API pagination size bound exceeded",
        );
      }
      const next = nextLinkUrl(response.headers);
      if (next === null) return portOk(items);
      if (!sameOrigin(url, next)) {
        // The bearer token must never follow a Link outside the API origin.
        return portError("invalid", "GitHub API response is malformed");
      }
      if (seen.has(next)) {
        return portError("unavailable", "GitHub API pagination cycle detected");
      }
      seen.add(next);
      url = next;
    }
    return portError(
      "unavailable",
      "GitHub API pagination page bound exceeded",
    );
  }
}

function repoPath(repository: RepositoryIdentityV1): string {
  return `${repository.owner}/${repository.name}`;
}

type RequiredReviewOperationSlotV1 = "reviewId" | "head" | "body";

const REQUIRED_REVIEW_DETAILS: Record<RequiredReviewOperationSlotV1, string> = {
  reviewId: "invalid review id",
  head: "invalid review head",
  body: "invalid review body",
};

interface ReviewOperationInputV1 {
  prNumber: number;
  reviewId?: number;
  head?: GitSha;
  body?: string;
}

/**
 * Input validation before any review request: positive safe-integer ids,
 * exact 40-hex head and a finite non-empty body within the journal byte
 * bound. The slots the operation requires are mandatory even when a runtime
 * caller violates TypeScript: an absent/undefined required value is the same
 * static invalid as a wrong-type one, and no request is ever issued.
 * Failures are static sanitized caller errors; nothing is echoed.
 */
function validateReviewOperationInput(
  input: ReviewOperationInputV1,
  required: readonly RequiredReviewOperationSlotV1[],
): PortErrorV1 | null {
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber < 1) {
    return { kind: "invalid", detail: "invalid pull request number" };
  }
  for (const slot of required) {
    if (input[slot] === undefined) {
      return { kind: "invalid", detail: REQUIRED_REVIEW_DETAILS[slot] };
    }
  }
  if (
    input.reviewId !== undefined &&
    (!Number.isSafeInteger(input.reviewId) || input.reviewId < 1)
  ) {
    return { kind: "invalid", detail: "invalid review id" };
  }
  if (input.head !== undefined && !isGitSha(input.head)) {
    return { kind: "invalid", detail: "invalid review head" };
  }
  if (input.body !== undefined) {
    if (
      typeof input.body !== "string" || input.body.length === 0 ||
      new TextEncoder().encode(input.body).length > MAX_JOURNAL_BYTES
    ) {
      return { kind: "invalid", detail: "invalid review body" };
    }
  }
  return null;
}

/** Sanitized static transport-boundary failure (no status/body/URL echoed). */
function unavailable(): RawSendResult {
  return {
    status: "error",
    error: { kind: "unavailable", detail: "GitHub API request failed" },
  };
}

function parseWire<T>(
  response: HttpResponseV1,
  parser: (value: unknown) => T,
): PortResultV1<T> {
  let body: unknown;
  try {
    body = JSON.parse(response.bodyText);
  } catch {
    return portError("invalid", "GitHub API response is malformed");
  }
  return parseWith(body, parser);
}

/**
 * One strict wire value. A contract-bound overflow (> max text) is
 * unavailable/incomplete — never a truncated value and never a malformed
 * shape; any other violation is invalid (fail closed).
 */
function parseWith<T>(
  value: unknown,
  parser: (value: unknown) => T,
): PortResultV1<T> {
  const parsed = tryParse(parser, value);
  if (!parsed.ok) {
    if (parsed.issues.some((issue) => issue.code === "bound_exceeded")) {
      return portError(
        "unavailable",
        "GitHub API response exceeds contract bounds",
      );
    }
    return portError("invalid", "GitHub API response is malformed");
  }
  return portOk(parsed.value);
}

function sameOrigin(first: string, second: string): boolean {
  try {
    return new URL(first).origin === new URL(second).origin;
  } catch {
    return false;
  }
}

function nextLinkUrl(headers: Headers): string | null {
  const link = headers.get("link");
  if (link === null) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match !== null) return match[1];
  }
  return null;
}
