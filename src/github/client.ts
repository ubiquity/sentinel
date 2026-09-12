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

import {
  ACTIONS_RELEASE_BRANCH,
  ACTIONS_RELEASE_JOB_NAME,
  ACTIONS_RELEASE_LOG_MAX_BYTES,
  ACTIONS_RELEASE_LOGIN,
  ACTIONS_RELEASE_REPOSITORY,
  ACTIONS_RELEASE_RUN_MAX,
  ACTIONS_RELEASE_STEP_NAME,
  ACTIONS_RELEASE_TIME_SLACK_MS,
  ACTIONS_RELEASE_WORKFLOW_ID,
  ACTIONS_RELEASE_WORKFLOW_PATH,
  actionsAuthorityFiles,
  actionsOptionalAuthorityFiles,
  actionsReleaseCiApprovalCounts,
  type ActionsReleaseOutcomeV1,
  type ActionsReleaseReceiptV1,
  actionsReleaseTreeEntries,
  parseActionsReleaseReceiptV1,
} from "../contracts/actions-release.ts";
import type { GitSha } from "../contracts/brands.ts";
import { isGitSha } from "../contracts/brands.ts";
import type { GitHubRateLimitV1 } from "../contracts/github-cooldown.ts";
import type {
  Clock,
  GitHubBranchProtectionsV1,
  GitHubChecksV1,
  GitHubCooldownGateV1,
  GitHubIssueRelationsV1,
  GitHubIssueV1,
  GitHubPullRequestV1,
  GitHubRefV1,
  GitHubReviewDecisionV1,
  PortErrorV1,
  PortResultV1,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import {
  expectArray,
  expectBoolean,
  expectCount,
  expectEnum,
  expectExactKeys,
  expectNonEmptyString,
  expectNullableString,
  expectPositiveInt,
  expectRecord,
  fail,
  MaxText,
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

/**
 * Exact self-target CI approval identity. The approval endpoint is exercised
 * only for the scope-0 `ubiquity/sentinel` repository (explicit no-App local
 * credential scope); every identity below is revalidated before any POST.
 */
const CI_REPOSITORY_FULL_NAME = "ubiquity/sentinel";
const CI_REPOSITORY_API_URL = "https://api.github.com/repos/ubiquity/sentinel";
const CI_WORKFLOW_FILE = "ci.yml";
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
const CI_BASE_REF = "development";
const CI_APPROVER_LOGIN = "github-actions[bot]";
/** One page only: a longer or truncated list is never partially approved. */
const CI_APPROVAL_MAX_RUNS = 100;
const CI_APPROVAL_SCOPE =
  "CI approval is restricted to the scope-0 self-target repository";
const CI_APPROVAL_AMBIGUOUS = "CI approval found more than one matching run";
const CI_APPROVAL_BOUND = "CI approval run list exceeded its bound";
const CI_APPROVAL_RECONCILE = "CI approval outcome could not be reconciled";

/** Whole hosted release-reader bound: no new request starts after this. */
const ACTIONS_RELEASE_READ_DEADLINE_MS = 120_000;
const ACTIONS_RELEASE_MAX_CANDIDATES = 3;
/** Safe upper bound on a terminal step_limit count. */
const ACTIONS_RELEASE_MAX_STEPS = 10_000;
const ACTIONS_RELEASE_UNAVAILABLE = "hosted release evidence is unavailable";
const ACTIONS_RELEASE_SCOPE =
  "hosted release evidence is restricted to the scope-0 self request";
const ACTIONS_RELEASE_REDIRECT = "hosted release log redirect is not trusted";
const ACTIONS_RELEASE_LOG_HOST =
  /^productionresultssa[0-9]+\.blob\.core\.windows\.net$/;
const ACTIONS_RELEASE_TIMESTAMP_LINE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (\{.*\})$/;

const REVIEW_DECISION_QUERY = `
  query SentinelPullReviewDecision($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewDecision
      }
    }
  }
`;

/**
 * Native issue dependency read (blockedBy + sub-issue total). The blockedBy
 * connection is read one page of `first: 100`; `hasNextPage` is a hard
 * truncation signal, never a silently ignored continuation.
 */
const ISSUE_RELATIONS_QUERY = `
  query SentinelIssueRelations($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        number
        blockedBy(first: 100) {
          nodes {
            number
            state
            repository {
              nameWithOwner
            }
          }
          pageInfo {
            hasNextPage
          }
        }
        subIssues(first: 1) {
          totalCount
        }
      }
    }
  }
`;

/** Maximum native blockedBy nodes accepted from one relations read. */
const MAX_BLOCKED_BY_NODES = 100;

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
  /**
   * Trusted opt-in: when exactly `true`, `listOpenIssues` and `readIssue`
   * enrich each real REST issue record with native dependency relations
   * (`blockedBy`/sub-issue count). Any other value (including absence) leaves
   * `relations` unknown; it is never synthesized as empty.
   */
  includeIssueRelations?: boolean;
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

/** Exact candidate identity for one self-target CI approval. */
export interface ApproveExactCiRunInputV1 {
  number: number;
  head: GitSha;
  headRef: string;
}

/**
 * Exact approval outcome. `approved` means the approval POST was submitted
 * (201) or an ambiguous response reconciled to a run that is no longer
 * awaiting approval — never that CI passed. `pending` means no qualifying
 * `action_required` run currently exists; nothing was submitted.
 */
export type CiApprovalOutcomeV1 =
  | { status: "approved"; runId: number }
  | { status: "pending" };

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
  private readonly includeIssueRelations: boolean;

  constructor(private readonly options: GitHubApiClientOptionsV1) {
    this.repository = options.repository;
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "");
    this.perPage = options.perPage ?? 100;
    this.maxPages = options.maxPages ?? MAX_OPEN_ISSUE_PAGES;
    this.maxItems = options.maxItems ?? MAX_OPEN_ISSUES;
    this.requestDeadlineMs = options.requestDeadlineMs ??
      DEFAULT_HTTP_DEADLINE_MS;
    // Exactly `true` opts in. Every other value (absent, false, truthy
    // non-boolean) leaves relations unknown: an untrusted or malformed
    // setting can never fabricate an unblocked issue.
    this.includeIssueRelations = options.includeIssueRelations === true;
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
      if (parsed.value.kind === "issue") {
        if (!this.includeIssueRelations) {
          issues.push(parsed.value.issue);
          continue;
        }
        // Trusted enrichment of an actual REST issue record. One relation
        // read failure fails the WHOLE listing: a partially enriched list
        // could otherwise present a blocked issue as unknown/absent.
        const relations = await this.readIssueRelations(
          parsed.value.issue.number,
        );
        if (!relations.ok) return relations;
        issues.push({ ...parsed.value.issue, relations: relations.value });
      }
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
    if (!this.includeIssueRelations) return portOk(parsed.value.issue);
    const relations = await this.readIssueRelations(parsed.value.issue.number);
    if (!relations.ok) return relations;
    return portOk({ ...parsed.value.issue, relations: relations.value });
  }

  /**
   * Native dependency relations for one actual issue. Same authenticated
   * GraphQL transport, whole-operation deadline, cooldown gate and typed
   * error mapping as `readPullRequestReviewDecision`; there is no retry loop
   * and no separate credential path. Every malformed, mismatched or
   * truncated answer is a typed failure — never an empty success.
   */
  private async readIssueRelations(
    issueNumber: number,
  ): Promise<PortResultV1<GitHubIssueRelationsV1>> {
    const raw = await this.sendCore(
      "POST",
      `${this.apiBaseUrl}/graphql`,
      {
        query: ISSUE_RELATIONS_QUERY,
        variables: {
          owner: this.repository.owner,
          name: this.repository.name,
          number: issueNumber,
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
      (value) => parseIssueRelations(value, issueNumber),
    );
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
  // Exact self-target CI approval
  // -------------------------------------------------------------------------

  /**
   * Approve the ONE exact `action_required` CI run for a durable self-target
   * pull request candidate. Read-only until a single POST: the actual PR is
   * read raw (head repository identity included) and the workflow run list is
   * bound to one page. Immediately before the POST the exact run and PR are
   * re-read and every identity is revalidated; an ambiguous or mismatched
   * candidate never submits. A lost response is reconciled by re-reading the
   * same run — this method never issues a second POST. A 201 reports the
   * approval as submitted, never that CI passed.
   */
  async approveExactCiRun(
    input: ApproveExactCiRunInputV1,
  ): Promise<PortResultV1<CiApprovalOutcomeV1>> {
    if (
      this.repository.owner !== "ubiquity" ||
      this.repository.name !== "sentinel" ||
      this.repository.installationId !== 0
    ) {
      return portError("invalid", CI_APPROVAL_SCOPE);
    }
    const invalid = validateCiApprovalInput(input);
    if (invalid !== null) return invalid;
    const repo = repoPath(this.repository);
    const pullPath = `/repos/${repo}/pulls/${input.number}`;

    const firstPull = await this.readExactCiPull(pullPath, input);
    if (!firstPull.ok) return firstPull;
    const repositoryId = firstPull.value.repositoryId;

    const listed = await this.listExactCiRuns(repo, input, repositoryId);
    if (!listed.ok) return listed;
    if (listed.value.length === 0) return portOk({ status: "pending" });
    if (listed.value.length > 1) {
      return portError("unavailable", CI_APPROVAL_AMBIGUOUS);
    }
    const target = listed.value[0]!;
    const runPath = `/repos/${repo}/actions/runs/${target.id}`;

    // Re-read the exact run and PR immediately before the single POST: both
    // must still match the passed identity — including the selected run id and
    // attempt — and the run must still be awaiting approval. A transitioned or
    // changed run is observed, never re-approved here.
    const current = await this.readExactCiRun(
      runPath,
      input,
      target,
      repositoryId,
    );
    if (!current.ok) return current;
    if (!current.value.actionRequired) return portOk({ status: "pending" });
    const currentPull = await this.readExactCiPull(pullPath, input);
    if (!currentPull.ok) return currentPull;

    const raw = await this.sendCore(
      "POST",
      `${this.apiBaseUrl}${runPath}/approve`,
      null,
    );
    if (raw.status === "error") {
      return portError(raw.error.kind, raw.error.detail, raw.error.rateLimit);
    }
    if (raw.status === "lost") {
      // The approval may have applied. Reconcile against the SAME run id and
      // attempt; no second POST is ever submitted by this invocation.
      const observed = await this.readExactCiRun(
        runPath,
        input,
        target,
        repositoryId,
      );
      if (observed.ok && !observed.value.actionRequired) {
        return portOk({ status: "approved", runId: target.id });
      }
      return portError("unavailable", CI_APPROVAL_RECONCILE);
    }
    if (raw.response.status === 201) {
      return portOk({ status: "approved", runId: target.id });
    }
    return portError(...this.mapError(raw.response));
  }

  private async readExactCiPull(
    path: string,
    input: ApproveExactCiRunInputV1,
  ): Promise<PortResultV1<ExactCiPullIdentityV1>> {
    const response = await this.request("GET", path);
    if (!response.ok) return response;
    if (response.value.status !== 200) {
      return portError(...this.mapError(response.value));
    }
    return parseWire(response.value, (value) => parseExactCiPull(value, input));
  }

  private async readExactCiRun(
    path: string,
    input: ApproveExactCiRunInputV1,
    expected: ExactCiRunIdentityV1,
    repositoryId: number,
  ): Promise<PortResultV1<{ actionRequired: boolean }>> {
    const response = await this.request("GET", path);
    if (!response.ok) return response;
    if (response.value.status !== 200) {
      return portError(...this.mapError(response.value));
    }
    return parseWire(response.value, (value) => {
      const run = parseExactCiRun(value, input, repositoryId);
      // Every exact-run read (including lost-response reconciliation) must be
      // the selected run and attempt: a wrong id or changed attempt is never
      // approved and never reported as an approval.
      if (run.id !== expected.id || run.attempt !== expected.attempt) {
        fail("$.id", "invalid_value", "CI run identity mismatch");
      }
      return { actionRequired: run.actionRequired };
    });
  }

  private async listExactCiRuns(
    repo: string,
    input: ApproveExactCiRunInputV1,
    repositoryId: number,
  ): Promise<PortResultV1<ExactCiRunIdentityV1[]>> {
    const response = await this.request(
      "GET",
      `/repos/${repo}/actions/workflows/${CI_WORKFLOW_FILE}/runs`,
      {
        event: "pull_request",
        head_sha: input.head,
        status: "action_required",
        per_page: String(CI_APPROVAL_MAX_RUNS),
      },
    );
    if (!response.ok) return response;
    if (response.value.status !== 200) {
      return portError(...this.mapError(response.value));
    }
    // A next-page link is a hard truncation signal: the approval never
    // continues pagination toward a write.
    if (nextLinkUrl(response.value.headers) !== null) {
      return portError("unavailable", CI_APPROVAL_BOUND);
    }
    return parseWire(response.value, (value) => {
      const obj = expectRecord(value, "$");
      const total = expectCount(obj.total_count, "$.total_count");
      const page = expectArray(
        obj.workflow_runs,
        "$.workflow_runs",
        CI_APPROVAL_MAX_RUNS,
        (item) => item,
      );
      if (total > CI_APPROVAL_MAX_RUNS || page.length !== total) {
        fail(
          "$.total_count",
          "bound_exceeded",
          "CI run list is not a complete bounded page",
        );
      }
      const runs: ExactCiRunIdentityV1[] = [];
      for (const item of page) {
        // Identity mismatches anywhere in the page fail the whole read via
        // the strict parser; only a still-awaiting run is a candidate, and its
        // exact id and attempt are retained for the later exact reads.
        const run = parseExactCiRun(item, input, repositoryId);
        if (run.actionRequired) {
          runs.push({ id: run.id, attempt: run.attempt });
        }
      }
      return runs;
    });
  }

  // -------------------------------------------------------------------------
  // Hosted read-only release evidence (fixed self scope)
  // -------------------------------------------------------------------------

  /**
   * Read the exact hosted release receipt for one scope-0 self production
   * request. Every authority is re-derived from the authenticated API before
   * the log can attest: the merged PR, the merge commit parents, the immutable
   * base/revision task-definition trees, the exact completed workflow attempt,
   * its single `repair` job / `Repair polling run` step and that step's single
   * terminal JSON record. A missing successful run is `null`; every foreign,
   * malformed, truncated, mismatched or inaccessible proof is unavailable.
   * No raw log, URL or credential is ever returned.
   */
  async readActionsRelease(
    request: ReleaseRequestV1,
  ): Promise<PortResultV1<ActionsReleaseReceiptV1 | null>> {
    if (!actionsReleaseIsSelfRequest(request)) {
      return portError("invalid", ACTIONS_RELEASE_SCOPE);
    }
    const deadline = createDeadline(ACTIONS_RELEASE_READ_DEADLINE_MS);
    try {
      const source = await this.readActionsReleaseSource(request, deadline);
      if (!source.ok) return source;
      const candidates = await this.findActionsReleaseCandidates(
        request,
        deadline,
      );
      if (!candidates.ok) return candidates;
      for (const candidate of candidates.value) {
        if (deadline.fired()) return this.actionsReleaseTimeout();
        const execution = await this.readActionsReleaseExecution(
          candidate,
          request,
          deadline,
        );
        if (!execution.ok) return execution;
        const terminal = await this.readActionsReleaseTerminal(
          execution.value,
          request,
          deadline,
        );
        if (!terminal.ok) return terminal;
        const raw = {
          version: "v1" as const,
          kind: "actions_release_receipt" as const,
          request,
          proof: {
            repository: ACTIONS_RELEASE_REPOSITORY,
            workflowId: ACTIONS_RELEASE_WORKFLOW_ID,
            workflowPath: ACTIONS_RELEASE_WORKFLOW_PATH,
            branch: ACTIONS_RELEASE_BRANCH,
            event: candidate.event,
            controllerSha: request.revision,
            baseSha: request.revision,
            runId: execution.value.runId,
            runAttempt: execution.value.runAttempt,
            jobId: execution.value.jobId,
            startedAt: execution.value.startedAt,
            finishedAt: execution.value.finishedAt,
            terminalAt: terminal.value.terminalAt,
            observedAt: this.options.clock.now(),
            outcome: terminal.value.outcome,
            startupReady: true,
            settled: true,
            login: ACTIONS_RELEASE_LOGIN,
            logDigest: terminal.value.logDigest,
          },
        };
        return parseWith(raw, (value) => parseActionsReleaseReceiptV1(value));
      }
      return portOk(null);
    } catch {
      return portError("unavailable", ACTIONS_RELEASE_UNAVAILABLE);
    } finally {
      deadline.dispose();
    }
  }

  private actionsReleaseTimeout(): PortResultV1<never> {
    return portError("unavailable", ACTIONS_RELEASE_UNAVAILABLE);
  }

  private async actionsReleaseGet(
    path: string,
    query: Record<string, string> = {},
    parent?: DeadlineV1,
  ): Promise<PortResultV1<unknown>> {
    const response = await this.request("GET", path, query, parent);
    if (!response.ok) return response;
    if (response.value.status !== 200) {
      return portError(...this.mapError(response.value));
    }
    try {
      return portOk(JSON.parse(response.value.bodyText));
    } catch {
      return portError("invalid", "GitHub API response is malformed");
    }
  }

  private async readActionsReleaseSource(
    request: ReleaseRequestV1,
    deadline: DeadlineV1,
  ): Promise<PortResultV1<void>> {
    if (deadline.fired()) return this.actionsReleaseTimeout();
    const repo = repoPath(this.repository);
    const pull = await this.actionsReleaseGet(
      `/repos/${repo}/pulls/${request.source.pullRequest}`,
      {},
      deadline,
    );
    if (!pull.ok) return pull;
    const parsedPull = parseWith(
      pull.value,
      (value) => parseActionsReleasePull(value, request),
    );
    if (!parsedPull.ok) return parsedPull;

    if (deadline.fired()) return this.actionsReleaseTimeout();
    const commit = await this.actionsReleaseGet(
      `/repos/${repo}/commits/${request.revision}`,
      {},
      deadline,
    );
    if (!commit.ok) return commit;
    const parsedCommit = parseWith(
      commit.value,
      (value) => parseActionsReleaseCommit(value, request),
    );
    if (!parsedCommit.ok) return parsedCommit;

    const baseTree = await this.readActionsReleaseTree(
      request.source.base,
      deadline,
    );
    if (!baseTree.ok) return baseTree;
    const revisionTree = await this.readActionsReleaseTree(
      request.revision,
      deadline,
    );
    if (!revisionTree.ok) return revisionTree;
    if (!actionsTreesEqual(baseTree.value, revisionTree.value)) {
      return portError("unavailable", ACTIONS_RELEASE_UNAVAILABLE);
    }
    return portOk(undefined);
  }

  private async readActionsReleaseTree(
    sha: GitSha,
    deadline: DeadlineV1,
  ): Promise<PortResultV1<Map<string, string>>> {
    if (deadline.fired()) return this.actionsReleaseTimeout();
    const response = await this.actionsReleaseGet(
      `/repos/${repoPath(this.repository)}/git/trees/${sha}`,
      { recursive: "1" },
      deadline,
    );
    if (!response.ok) return response;
    return parseWith(response.value, parseActionsReleaseTree);
  }

  private async findActionsReleaseCandidates(
    request: ReleaseRequestV1,
    deadline: DeadlineV1,
  ): Promise<PortResultV1<ActionsReleaseCandidateV1[]>> {
    if (deadline.fired()) return this.actionsReleaseTimeout();
    const response = await this.request(
      "GET",
      `/repos/${repoPath(this.repository)}/actions/workflows/${
        String(ACTIONS_RELEASE_WORKFLOW_ID)
      }/runs`,
      {
        head_sha: request.revision,
        branch: ACTIONS_RELEASE_BRANCH,
        per_page: String(ACTIONS_RELEASE_RUN_MAX),
      },
      deadline,
    );
    if (!response.ok) return response;
    if (response.value.status !== 200) {
      return portError(...this.mapError(response.value));
    }
    if (nextLinkUrl(response.value.headers) !== null) {
      return portError("unavailable", ACTIONS_RELEASE_UNAVAILABLE);
    }
    return parseWire(
      response.value,
      (value) => parseActionsReleaseRuns(value, request),
    );
  }

  private async readActionsReleaseExecution(
    candidate: ActionsReleaseCandidateV1,
    request: ReleaseRequestV1,
    deadline: DeadlineV1,
  ): Promise<PortResultV1<ActionsReleaseExecutionV1>> {
    if (deadline.fired()) return this.actionsReleaseTimeout();
    const repo = repoPath(this.repository);
    const attemptResponse = await this.request(
      "GET",
      `/repos/${repo}/actions/runs/${candidate.runId}/attempts/${candidate.runAttempt}`,
      {},
      deadline,
    );
    if (!attemptResponse.ok) return attemptResponse;
    if (attemptResponse.value.status !== 200) {
      return portError(...this.mapError(attemptResponse.value));
    }
    const attempt = parseWire(
      attemptResponse.value,
      (value) => parseActionsReleaseAttempt(value, candidate, request),
    );
    if (!attempt.ok) return attempt;

    if (deadline.fired()) return this.actionsReleaseTimeout();
    const jobsResponse = await this.request(
      "GET",
      `/repos/${repo}/actions/runs/${candidate.runId}/attempts/${candidate.runAttempt}/jobs`,
      { per_page: String(ACTIONS_RELEASE_RUN_MAX) },
      deadline,
    );
    if (!jobsResponse.ok) return jobsResponse;
    if (jobsResponse.value.status !== 200) {
      return portError(...this.mapError(jobsResponse.value));
    }
    if (nextLinkUrl(jobsResponse.value.headers) !== null) {
      return portError("unavailable", ACTIONS_RELEASE_UNAVAILABLE);
    }
    return parseWire(
      jobsResponse.value,
      (value) =>
        parseActionsReleaseJobs(value, candidate, request, attempt.value),
    );
  }

  private async readActionsReleaseTerminal(
    execution: ActionsReleaseExecutionV1,
    request: ReleaseRequestV1,
    deadline: DeadlineV1,
  ): Promise<PortResultV1<ActionsReleaseTerminalV1>> {
    if (deadline.fired()) return this.actionsReleaseTimeout();
    const raw = await this.sendCore(
      "GET",
      `${this.apiBaseUrl}/repos/${
        repoPath(this.repository)
      }/actions/jobs/${execution.jobId}/logs`,
      null,
      "manual",
      deadline,
    );
    if (raw.status === "error") {
      return portError(raw.error.kind, raw.error.detail, raw.error.rateLimit);
    }
    if (raw.status === "lost") {
      return portError("unavailable", ACTIONS_RELEASE_UNAVAILABLE);
    }
    if (raw.response.status !== 302) {
      return portError("unavailable", ACTIONS_RELEASE_UNAVAILABLE);
    }
    const location = raw.response.headers.get("location");
    if (location === null) {
      return portError("unavailable", ACTIONS_RELEASE_REDIRECT);
    }
    const signedUrl = trustedActionsLogUrl(location);
    if (signedUrl === null) {
      return portError("unavailable", ACTIONS_RELEASE_REDIRECT);
    }
    if (deadline.fired()) return this.actionsReleaseTimeout();
    let logResponse: HttpResponseV1;
    try {
      const signedCall = Promise.resolve().then(() =>
        this.options.http({
          method: "GET",
          url: signedUrl,
          // The signed URL is pre-authenticated: never send the API token,
          // never follow a redirect and never reuse the gate for it.
          headers: new Map<string, string>(),
          body: null,
          redirect: "error",
        })
      );
      signedCall.catch(() => {});
      logResponse = await deadline.race(signedCall);
    } catch {
      return portError("unavailable", ACTIONS_RELEASE_UNAVAILABLE);
    }
    if (logResponse.status !== 200) {
      return portError("unavailable", ACTIONS_RELEASE_UNAVAILABLE);
    }
    if (
      new TextEncoder().encode(logResponse.bodyText).length >
        ACTIONS_RELEASE_LOG_MAX_BYTES
    ) {
      return portError("unavailable", ACTIONS_RELEASE_UNAVAILABLE);
    }
    let terminal: { terminalAt: number; outcome: ActionsReleaseOutcomeV1 };
    try {
      terminal = parseActionsReleaseLogText(
        logResponse.bodyText,
        execution,
        request,
      );
    } catch {
      return portError("unavailable", ACTIONS_RELEASE_UNAVAILABLE);
    }
    const logDigest = await sha256Hex(logResponse.bodyText);
    return portOk({ ...terminal, logDigest });
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
    parent?: DeadlineV1,
  ): Promise<PortResultV1<HttpResponseV1>> {
    const sent = await this.send(method, path, query, null, parent);
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
    parent?: DeadlineV1,
  ): Promise<PortResultV1<HttpResponseV1>> {
    const queryText = new URLSearchParams(query).toString();
    const url = `${this.apiBaseUrl}${path}${
      queryText.length === 0 ? "" : `?${queryText}`
    }`;
    return this.sendCore(method, url, body, undefined, parent).then((raw) => {
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
    redirect?: "error" | "manual",
    parent?: DeadlineV1,
  ): Promise<RawSendResult> {
    // One finite whole-operation deadline starts before authentication,
    // covers the gate reads, the HTTP request and the body read. A hung
    // injected gate or auth provider cannot block the operation beyond it.
    // An optional shared parent bound (the hosted reader's whole-operation
    // limit) is combined in without ever being disposed from here.
    const deadline = combineDeadline(
      createDeadline(this.requestDeadlineMs),
      parent,
    );
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
              redirect: redirect ?? "error",
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

/**
 * Strict parser for the native issue-relations GraphQL response. Fails
 * closed on a non-empty `errors` array, a missing/mismatched issue identity,
 * a truncated blockedBy page, an invalid blocker repository identity, state
 * or number, or an invalid sub-issue count. Closed native blockers are
 * dropped (closed state is authoritative for the dependency); open blockers
 * are retained regardless of repository, so a cross-repository blocker still
 * gates. An empty result is only ever returned after all of those checks
 * passed on a complete, untruncated page.
 */
function parseIssueRelations(
  input: unknown,
  issueNumber: number,
): GitHubIssueRelationsV1 {
  const obj = expectRecord(input, "$");
  const errors = obj.errors;
  if (errors !== undefined && errors !== null) {
    const list = expectArray(errors, "$.errors", 100, (value) => value);
    if (list.length > 0) {
      fail("$.errors", "invalid_value", "GraphQL response contains errors");
    }
  }
  const data = expectRecord(obj.data, "$.data");
  const repository = expectRecord(data.repository, "$.data.repository");
  const rawIssue = repository.issue;
  if (rawIssue === null || rawIssue === undefined) {
    fail(
      "$.data.repository.issue",
      "invalid_value",
      "GraphQL response has no issue",
    );
  }
  const issuePath = "$.data.repository.issue";
  const issue = expectRecord(rawIssue, issuePath);
  const number = expectPositiveInt(issue.number, `${issuePath}.number`);
  if (number !== issueNumber) {
    fail(
      `${issuePath}.number`,
      "invalid_value",
      "GraphQL issue identity does not match the requested number",
    );
  }
  const blockedBy = expectRecord(issue.blockedBy, `${issuePath}.blockedBy`);
  const nodes = expectArray(
    blockedBy.nodes,
    `${issuePath}.blockedBy.nodes`,
    MAX_BLOCKED_BY_NODES,
    (value) => value,
  );
  const pageInfo = expectRecord(
    blockedBy.pageInfo,
    `${issuePath}.blockedBy.pageInfo`,
  );
  const hasNextPage = pageInfo.hasNextPage;
  if (hasNextPage !== false) {
    if (hasNextPage === true) {
      fail(
        `${issuePath}.blockedBy.pageInfo.hasNextPage`,
        "bound_exceeded",
        "blockedBy page exceeded the read bound",
      );
    }
    fail(
      `${issuePath}.blockedBy.pageInfo.hasNextPage`,
      "invalid_boolean",
      "expected boolean",
    );
  }
  const subIssues = expectRecord(issue.subIssues, `${issuePath}.subIssues`);
  const subIssueCount = expectCount(
    subIssues.totalCount,
    `${issuePath}.subIssues.totalCount`,
  );

  const openBlockers: GitHubIssueRelationsV1["openBlockers"] = [];
  const seenBlockers = new Set<string>();
  for (let index = 0; index < nodes.length; index++) {
    const nodePath = `${issuePath}.blockedBy.nodes[${index}]`;
    const node = expectRecord(nodes[index], nodePath);
    const blockerNumber = expectPositiveInt(node.number, `${nodePath}.number`);
    const state = expectEnum(
      node.state,
      ["OPEN", "CLOSED"] as const,
      `${nodePath}.state`,
    );
    const blockerRepository = expectRecord(
      node.repository,
      `${nodePath}.repository`,
    );
    const nameWithOwner = expectNonEmptyString(
      blockerRepository.nameWithOwner,
      `${nodePath}.repository.nameWithOwner`,
      MaxText.owner + 1 + MaxText.name,
    );
    const separator = nameWithOwner.indexOf("/");
    const owner = separator === -1 ? "" : nameWithOwner.slice(0, separator);
    const name = separator === -1 ? "" : nameWithOwner.slice(separator + 1);
    if (
      owner.length === 0 || name.length === 0 || name.includes("/") ||
      owner.length > MaxText.owner || name.length > MaxText.name
    ) {
      fail(
        `${nodePath}.repository.nameWithOwner`,
        "invalid_pattern",
        "expected owner/name repository identity",
      );
    }
    // Closed native blockers are authoritative as satisfied and excluded;
    // open blockers are retained even when they live in another repository.
    if (state === "CLOSED") continue;
    const blockerKey = `${owner}\u0000${name}\u0000${blockerNumber}`;
    if (seenBlockers.has(blockerKey)) continue;
    seenBlockers.add(blockerKey);
    openBlockers.push({ owner, name, number: blockerNumber });
  }
  return { openBlockers, subIssueCount };
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

/**
 * Combine one request-local deadline with an optional shared parent bound.
 * Expiry of either bound stops the operation; the shared parent is never
 * disposed by a request that borrowed it.
 */
function combineDeadline(own: DeadlineV1, parent?: DeadlineV1): DeadlineV1 {
  if (parent === undefined) return own;
  return {
    race<T>(promise: Promise<T>): Promise<T> {
      return parent.race(own.race(promise));
    },
    fired(): boolean {
      return own.fired() || parent.fired();
    },
    dispose(): void {
      own.dispose();
    },
  };
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

// ---------------------------------------------------------------------------
// Exact self-target CI approval wire validation
// ---------------------------------------------------------------------------

/** Selected run identity retained from the bounded list and revalidated. */
interface ExactCiRunIdentityV1 {
  id: number;
  attempt: number;
}

interface ExactCiRunV1 {
  id: number;
  attempt: number;
  actionRequired: boolean;
}

/** Raw PR repository identity bound into every run association. */
interface ExactCiPullIdentityV1 {
  repositoryId: number;
}

function validateCiApprovalInput(
  input: ApproveExactCiRunInputV1,
): PortResultV1<never> | null {
  if (!Number.isSafeInteger(input.number) || input.number < 1) {
    return portError("invalid", "invalid pull request number");
  }
  if (typeof input.head !== "string" || !isGitSha(input.head)) {
    return portError("invalid", "invalid candidate head");
  }
  if (
    typeof input.headRef !== "string" || input.headRef.length === 0 ||
    input.headRef.length > MaxText.branch || /[\r\n]/.test(input.headRef)
  ) {
    return portError("invalid", "invalid candidate head ref");
  }
  return null;
}

/**
 * Raw PR identity: open, trusted author, exact head/base ref and repository.
 * The authenticated self repository is bound by its real numeric id (never
 * hard-coded): head/base repository ids must agree.
 */
function parseExactCiPull(
  value: unknown,
  input: ApproveExactCiRunInputV1,
): ExactCiPullIdentityV1 {
  const obj = expectRecord(value, "$");
  const number = expectPositiveInt(obj.number, "$.number");
  if (number !== input.number) {
    fail("$.number", "invalid_value", "pull request number mismatch");
  }
  expectEnum(obj.state, ["open"], "$.state");
  const user = expectRecord(obj.user, "$.user");
  if (
    expectNonEmptyString(user.login, "$.user.login", MaxText.login) !==
      CI_APPROVER_LOGIN
  ) {
    fail("$.user.login", "invalid_value", "unexpected pull request author");
  }
  const head = expectRecord(obj.head, "$.head");
  expectExactCiHead(head, input, "$.head");
  const headRepositoryId = parsePullRepository(head.repo, "$.head.repo");
  const base = expectRecord(obj.base, "$.base");
  if (
    expectNonEmptyString(base.ref, "$.base.ref", MaxText.branch) !== CI_BASE_REF
  ) {
    fail("$.base.ref", "invalid_value", "unexpected pull request base ref");
  }
  const baseRepositoryId = parsePullRepository(base.repo, "$.base.repo");
  if (headRepositoryId !== baseRepositoryId) {
    fail(
      "$.head.repo.id",
      "invalid_value",
      "pull request repository identity disagrees",
    );
  }
  return { repositoryId: headRepositoryId };
}

/**
 * Raw PR repository: full repository object, exact self full name plus the
 * numeric id the run associations are bound to.
 */
function parsePullRepository(value: unknown, path: string): number {
  const repo = expectRecord(value, path);
  if (
    expectNonEmptyString(
      repo.full_name,
      `${path}.full_name`,
      MaxText.owner + 1 + MaxText.name,
    ) !== CI_REPOSITORY_FULL_NAME
  ) {
    fail(`${path}.full_name`, "invalid_value", "unexpected repository");
  }
  return expectPositiveInt(repo.id, `${path}.id`);
}

/** One workflow run: exact identity plus whether it still needs approval. */
function parseExactCiRun(
  value: unknown,
  input: ApproveExactCiRunInputV1,
  repositoryId: number,
): ExactCiRunV1 {
  const obj = expectRecord(value, "$");
  const id = expectPositiveInt(obj.id, "$.id");
  const attempt = expectPositiveInt(obj.run_attempt, "$.run_attempt");
  expectEnum(obj.event, ["pull_request"], "$.event");
  if (
    expectNonEmptyString(obj.path, "$.path", MaxText.path) !== CI_WORKFLOW_PATH
  ) {
    fail("$.path", "invalid_value", "unexpected workflow path");
  }
  expectExactCiHead(
    { sha: obj.head_sha, ref: obj.head_branch },
    input,
    "$",
  );
  expectSelfRepository(obj.head_repository, "$.head_repository");
  expectCiActor(obj.actor, "$.actor");
  expectCiActor(obj.triggering_actor, "$.triggering_actor");
  const status = expectEnum(
    obj.status,
    ["queued", "in_progress", "completed", "requested", "waiting", "pending"],
    "$.status",
  );
  const conclusion = expectNullableString(
    obj.conclusion,
    "$.conclusion",
    MaxText.token,
  );
  const actionRequired = status === "completed" &&
    conclusion === "action_required";
  const pulls = expectArray(
    obj.pull_requests,
    "$.pull_requests",
    1,
    (item) => item,
  );
  if (pulls.length !== 1) {
    fail(
      "$.pull_requests",
      "invalid_value",
      "expected exactly one associated pull request",
    );
  }
  const pullPath = "$.pull_requests[0]";
  const pull = expectRecord(pulls[0], pullPath);
  const number = expectPositiveInt(pull.number, `${pullPath}.number`);
  if (number !== input.number) {
    fail(`${pullPath}.number`, "invalid_value", "run PR association mismatch");
  }
  const head = expectRecord(pull.head, `${pullPath}.head`);
  expectExactCiHead(head, input, `${pullPath}.head`);
  expectAssociationRepository(
    head.repo,
    `${pullPath}.head.repo`,
    repositoryId,
  );
  const base = expectRecord(pull.base, `${pullPath}.base`);
  if (
    expectNonEmptyString(base.ref, `${pullPath}.base.ref`, MaxText.branch) !==
      CI_BASE_REF
  ) {
    fail(`${pullPath}.base.ref`, "invalid_value", "unexpected run base ref");
  }
  expectAssociationRepository(
    base.repo,
    `${pullPath}.base.repo`,
    repositoryId,
  );
  return { id, attempt, actionRequired };
}

function expectExactCiHead(
  value: Record<string, unknown>,
  input: ApproveExactCiRunInputV1,
  path: string,
): void {
  const sha = expectNonEmptyString(value.sha, `${path}.sha`, 40);
  if (!isGitSha(sha) || sha !== input.head) {
    fail(`${path}.sha`, "invalid_value", "head SHA mismatch");
  }
  if (
    expectNonEmptyString(value.ref, `${path}.ref`, MaxText.branch) !==
      input.headRef
  ) {
    fail(`${path}.ref`, "invalid_value", "head ref mismatch");
  }
}

function expectSelfRepository(value: unknown, path: string): void {
  const repo = expectRecord(value, path);
  if (
    expectNonEmptyString(
      repo.full_name,
      `${path}.full_name`,
      MaxText.owner + 1 + MaxText.name,
    ) !== CI_REPOSITORY_FULL_NAME
  ) {
    fail(`${path}.full_name`, "invalid_value", "unexpected repository");
  }
}

/**
 * Workflow-run PR association repository: the real minimal API shape
 * (`{ id, name, url }`), bound to the raw PR's authenticated repository id.
 */
function expectAssociationRepository(
  value: unknown,
  path: string,
  repositoryId: number,
): void {
  const repo = expectRecord(value, path);
  const id = expectPositiveInt(repo.id, `${path}.id`);
  if (id !== repositoryId) {
    fail(`${path}.id`, "invalid_value", "repository ID mismatch");
  }
  if (
    expectNonEmptyString(repo.name, `${path}.name`, MaxText.name) !== "sentinel"
  ) {
    fail(`${path}.name`, "invalid_value", "unexpected repository name");
  }
  if (
    expectNonEmptyString(repo.url, `${path}.url`, MaxText.url) !==
      CI_REPOSITORY_API_URL
  ) {
    fail(`${path}.url`, "invalid_value", "unexpected repository URL");
  }
}

function expectCiActor(value: unknown, path: string): void {
  const actor = expectRecord(value, path);
  if (
    expectNonEmptyString(actor.login, `${path}.login`, MaxText.login) !==
      CI_APPROVER_LOGIN
  ) {
    fail(`${path}.login`, "invalid_value", "unexpected run actor");
  }
}

// ---------------------------------------------------------------------------
// Hosted read-only release evidence wire validation
// ---------------------------------------------------------------------------

interface ActionsReleaseCandidateV1 {
  runId: number;
  runAttempt: number;
  event: "schedule" | "workflow_dispatch";
}

interface ActionsReleaseAttemptV1 {
  startedAt: number;
  finishedAt: number;
}

interface ActionsReleaseExecutionV1 {
  runId: number;
  runAttempt: number;
  jobId: number;
  startedAt: number;
  finishedAt: number;
  stepStartedAt: number;
  stepFinishedAt: number;
}

interface ActionsReleaseTerminalV1 {
  terminalAt: number;
  outcome: ActionsReleaseOutcomeV1;
  logDigest: string;
}

function actionsReleaseIsSelfRequest(request: ReleaseRequestV1): boolean {
  const repository = request.target.repository;
  return repository.installationId === 0 && repository.owner === "ubiquity" &&
    repository.name === "sentinel" &&
    request.target.environment === "production" &&
    request.status === "open" &&
    request.source.reviewReceiptId !== null;
}

/** ISO-8601 UTC timestamp with millisecond precision, as milliseconds. */
function expectIsoMs(value: unknown, path: string): number {
  const text = expectNonEmptyString(value, path, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text)) {
    fail(path, "invalid_timestamp", "expected ISO-8601 UTC timestamp");
  }
  const ms = Date.parse(text);
  if (!Number.isSafeInteger(ms) || ms < 0) {
    fail(path, "invalid_timestamp", "expected a valid timestamp");
  }
  return ms;
}

/** Merged self PR bound to the exact request source base/head/revision. */
function parseActionsReleasePull(
  value: unknown,
  request: ReleaseRequestV1,
): void {
  const obj = expectRecord(value, "$");
  if (
    expectPositiveInt(obj.number, "$.number") !== request.source.pullRequest
  ) {
    fail("$.number", "invalid_value", "pull request number mismatch");
  }
  expectEnum(obj.state, ["closed"], "$.state");
  if (expectBoolean(obj.merged, "$.merged") !== true) {
    fail("$.merged", "invalid_value", "pull request is not merged");
  }
  if (
    expectNonEmptyString(obj.merge_commit_sha, "$.merge_commit_sha", 40) !==
      request.revision
  ) {
    fail(
      "$.merge_commit_sha",
      "invalid_value",
      "merge commit does not match the request revision",
    );
  }
  const head = expectRecord(obj.head, "$.head");
  if (
    expectNonEmptyString(head.sha, "$.head.sha", 40) !== request.source.head
  ) {
    fail("$.head.sha", "invalid_value", "pull request head mismatch");
  }
  expectSelfRepository(head.repo, "$.head.repo");
  const base = expectRecord(obj.base, "$.base");
  if (
    expectNonEmptyString(base.ref, "$.base.ref", MaxText.branch) !==
      ACTIONS_RELEASE_BRANCH
  ) {
    fail("$.base.ref", "invalid_value", "unexpected pull request base ref");
  }
  expectSelfRepository(base.repo, "$.base.repo");
}

/** Exact merge commit whose two parents are the request base and head. */
function parseActionsReleaseCommit(
  value: unknown,
  request: ReleaseRequestV1,
): void {
  const obj = expectRecord(value, "$");
  if (
    expectNonEmptyString(obj.sha, "$.sha", 40) !== request.revision
  ) {
    fail("$.sha", "invalid_value", "commit does not match the revision");
  }
  const parents = expectArray(obj.parents, "$.parents", 2, (item) => item);
  if (parents.length !== 2) {
    fail("$.parents", "invalid_value", "merge commit requires two parents");
  }
  const shas = parents.map((parent, index) =>
    expectNonEmptyString(
      expectRecord(parent, `$.parents[${index}]`).sha,
      `$.parents[${index}].sha`,
      40,
    )
  );
  if (
    !shas.includes(request.source.base) ||
    !shas.includes(request.source.head)
  ) {
    fail(
      "$.parents",
      "invalid_value",
      "merge parents do not contain the request source",
    );
  }
}

/** Authority-file map (mode:type:sha) from one complete untruncated tree. */
function parseActionsReleaseTree(value: unknown): Map<string, string> {
  const obj = expectRecord(value, "$");
  if (expectBoolean(obj.truncated, "$.truncated") !== false) {
    fail("$.truncated", "bound_exceeded", "authority tree is truncated");
  }
  const entries = actionsReleaseTreeEntries(obj.tree, "$.tree");
  const map = new Map<string, string>();
  for (const [index, item] of entries.entries()) {
    const path = `$.tree[${index}]`;
    const entry = expectRecord(item, path);
    const entryPath = expectNonEmptyString(
      entry.path,
      `${path}.path`,
      MaxText.path,
    );
    if (
      !actionsAuthorityFiles().includes(entryPath) &&
      !actionsOptionalAuthorityFiles().includes(entryPath)
    ) {
      continue;
    }
    const mode = expectNonEmptyString(entry.mode, `${path}.mode`, 6);
    const type = expectNonEmptyString(entry.type, `${path}.type`, 6);
    const sha = expectNonEmptyString(entry.sha, `${path}.sha`, 40);
    if (type !== "blob" || mode !== "100644") {
      fail(
        `${path}.type`,
        "invalid_value",
        "authority entry is not a regular blob",
      );
    }
    map.set(entryPath, `${mode}:${type}:${sha}`);
  }
  return map;
}

/**
 * The task-definition authority must be identical at the immutable base and
 * the request revision; optional authority files are either absent from both
 * trees or equal regular blobs in both.
 */
function actionsTreesEqual(
  base: Map<string, string>,
  revision: Map<string, string>,
): boolean {
  for (const file of actionsAuthorityFiles()) {
    const atBase = base.get(file);
    const atRevision = revision.get(file);
    if (atBase === undefined || atRevision === undefined) return false;
    if (atBase !== atRevision) return false;
  }
  for (const file of actionsOptionalAuthorityFiles()) {
    const atBase = base.get(file);
    const atRevision = revision.get(file);
    if ((atBase === undefined) !== (atRevision === undefined)) return false;
    if (atBase !== undefined && atBase !== atRevision) return false;
  }
  return true;
}

/** One list entry: exact identity, or null when it is not a success. */
function parseActionsReleaseRun(
  value: unknown,
  request: ReleaseRequestV1,
  path: string,
): ActionsReleaseCandidateV1 | null {
  const obj = expectRecord(value, path);
  const runId = expectPositiveInt(obj.id, `${path}.id`);
  const runAttempt = expectPositiveInt(obj.run_attempt, `${path}.run_attempt`);
  if (
    expectPositiveInt(obj.workflow_id, `${path}.workflow_id`) !==
      ACTIONS_RELEASE_WORKFLOW_ID
  ) {
    fail(`${path}.workflow_id`, "invalid_value", "unexpected workflow id");
  }
  if (
    expectNonEmptyString(obj.path, `${path}.path`, MaxText.path) !==
      ACTIONS_RELEASE_WORKFLOW_PATH
  ) {
    fail(`${path}.path`, "invalid_value", "unexpected workflow path");
  }
  if (
    expectNonEmptyString(obj.head_sha, `${path}.head_sha`, 40) !==
      request.revision
  ) {
    fail(`${path}.head_sha`, "invalid_value", "run head mismatch");
  }
  if (
    expectNonEmptyString(
      obj.head_branch,
      `${path}.head_branch`,
      MaxText.branch,
    ) !==
      ACTIONS_RELEASE_BRANCH
  ) {
    fail(`${path}.head_branch`, "invalid_value", "run branch mismatch");
  }
  const event = expectEnum(
    obj.event,
    ["schedule", "workflow_dispatch"],
    `${path}.event`,
  );
  const status = expectEnum(
    obj.status,
    ["queued", "in_progress", "completed", "requested", "waiting", "pending"],
    `${path}.status`,
  );
  const conclusion = expectNullableString(
    obj.conclusion,
    `${path}.conclusion`,
    MaxText.token,
  );
  expectSelfRepository(obj.repository, `${path}.repository`);
  expectSelfRepository(obj.head_repository, `${path}.head_repository`);
  if (status !== "completed" || conclusion !== "success") return null;
  return { runId, runAttempt, event };
}

/** Deterministic ascending candidate list, capped at the bounded maximum. */
function parseActionsReleaseRuns(
  value: unknown,
  request: ReleaseRequestV1,
): ActionsReleaseCandidateV1[] {
  const obj = expectRecord(value, "$");
  const total = expectCount(obj.total_count, "$.total_count");
  const runs = expectArray(
    obj.workflow_runs,
    "$.workflow_runs",
    ACTIONS_RELEASE_RUN_MAX,
    (item) => item,
  );
  if (total > ACTIONS_RELEASE_RUN_MAX || runs.length !== total) {
    fail(
      "$.total_count",
      "bound_exceeded",
      "run list is not a complete bounded page",
    );
  }
  const candidates: ActionsReleaseCandidateV1[] = [];
  for (const [index, item] of runs.entries()) {
    const candidate = parseActionsReleaseRun(
      item,
      request,
      `$.workflow_runs[${index}]`,
    );
    if (candidate !== null) candidates.push(candidate);
  }
  candidates.sort((left, right) => left.runId - right.runId);
  return candidates.slice(0, ACTIONS_RELEASE_MAX_CANDIDATES);
}

/** Exact completed successful attempt for the selected run identity. */
function parseActionsReleaseAttempt(
  value: unknown,
  candidate: ActionsReleaseCandidateV1,
  request: ReleaseRequestV1,
): ActionsReleaseAttemptV1 {
  const obj = expectRecord(value, "$");
  if (expectPositiveInt(obj.id, "$.id") !== candidate.runId) {
    fail("$.id", "invalid_value", "attempt run id mismatch");
  }
  if (
    expectPositiveInt(obj.run_attempt, "$.run_attempt") !== candidate.runAttempt
  ) {
    fail("$.run_attempt", "invalid_value", "attempt number mismatch");
  }
  if (
    expectPositiveInt(obj.workflow_id, "$.workflow_id") !==
      ACTIONS_RELEASE_WORKFLOW_ID
  ) {
    fail("$.workflow_id", "invalid_value", "unexpected workflow id");
  }
  if (
    expectNonEmptyString(obj.path, "$.path", MaxText.path) !==
      ACTIONS_RELEASE_WORKFLOW_PATH
  ) {
    fail("$.path", "invalid_value", "unexpected workflow path");
  }
  if (
    expectNonEmptyString(obj.head_sha, "$.head_sha", 40) !== request.revision
  ) {
    fail("$.head_sha", "invalid_value", "attempt head mismatch");
  }
  if (
    expectNonEmptyString(obj.head_branch, "$.head_branch", MaxText.branch) !==
      ACTIONS_RELEASE_BRANCH
  ) {
    fail("$.head_branch", "invalid_value", "attempt branch mismatch");
  }
  expectEnum(
    obj.event,
    ["schedule", "workflow_dispatch"],
    "$.event",
  );
  expectEnum(obj.status, ["completed"], "$.status");
  if (
    expectNullableString(obj.conclusion, "$.conclusion", MaxText.token) !==
      "success"
  ) {
    fail("$.conclusion", "invalid_value", "attempt is not successful");
  }
  expectSelfRepository(obj.repository, "$.repository");
  expectSelfRepository(obj.head_repository, "$.head_repository");
  const startedAt = expectIsoMs(obj.run_started_at, "$.run_started_at");
  const finishedAt = expectIsoMs(obj.updated_at, "$.updated_at");
  if (startedAt > finishedAt) {
    fail("$.updated_at", "invalid_lifecycle", "attempt times are inverted");
  }
  return { startedAt, finishedAt };
}

/** The single repair job and Repair polling run step, with server times. */
function parseActionsReleaseJobs(
  value: unknown,
  candidate: ActionsReleaseCandidateV1,
  request: ReleaseRequestV1,
  attempt: ActionsReleaseAttemptV1,
): ActionsReleaseExecutionV1 {
  const obj = expectRecord(value, "$");
  const total = expectCount(obj.total_count, "$.total_count");
  const jobs = expectArray(
    obj.jobs,
    "$.jobs",
    ACTIONS_RELEASE_RUN_MAX,
    (item) => item,
  );
  if (total > ACTIONS_RELEASE_RUN_MAX || jobs.length !== total) {
    fail("$.total_count", "bound_exceeded", "job list is not a bounded page");
  }
  const matches: Array<{ job: Record<string, unknown>; path: string }> = [];
  for (const [index, item] of jobs.entries()) {
    const path = `$.jobs[${index}]`;
    const job = expectRecord(item, path);
    if (
      expectNonEmptyString(job.name, `${path}.name`, MaxText.label) !==
        ACTIONS_RELEASE_JOB_NAME
    ) {
      continue;
    }
    if (
      expectPositiveInt(job.run_id, `${path}.run_id`) !== candidate.runId ||
      expectPositiveInt(job.run_attempt, `${path}.run_attempt`) !==
        candidate.runAttempt ||
      expectNonEmptyString(job.head_sha, `${path}.head_sha`, 40) !==
        request.revision
    ) {
      fail(`${path}.run_id`, "invalid_value", "job identity mismatch");
    }
    matches.push({ job, path });
  }
  if (matches.length !== 1) {
    fail("$.jobs", "invalid_value", "expected exactly one repair job");
  }
  const { job, path } = matches[0]!;
  expectEnum(job.status, ["completed"], `${path}.status`);
  if (
    expectNullableString(
      job.conclusion,
      `${path}.conclusion`,
      MaxText.token,
    ) !==
      "success"
  ) {
    fail(`${path}.conclusion`, "invalid_value", "job is not successful");
  }
  const jobId = expectPositiveInt(job.id, `${path}.id`);
  const startedAt = expectIsoMs(job.started_at, `${path}.started_at`);
  const finishedAt = expectIsoMs(job.completed_at, `${path}.completed_at`);
  if (
    startedAt < attempt.startedAt ||
    finishedAt > attempt.finishedAt + ACTIONS_RELEASE_TIME_SLACK_MS ||
    startedAt > finishedAt
  ) {
    fail(`${path}.started_at`, "invalid_lifecycle", "job window is invalid");
  }

  const steps = expectArray(
    job.steps,
    `${path}.steps`,
    ACTIONS_RELEASE_RUN_MAX,
    (item) => item,
  );
  const stepMatches: Array<{ step: Record<string, unknown>; path: string }> =
    [];
  for (const [index, item] of steps.entries()) {
    const stepPath = `${path}.steps[${index}]`;
    const step = expectRecord(item, stepPath);
    if (
      expectNonEmptyString(step.name, `${stepPath}.name`, MaxText.label) ===
        ACTIONS_RELEASE_STEP_NAME
    ) {
      stepMatches.push({ step, path: stepPath });
    }
  }
  if (stepMatches.length !== 1) {
    fail(`${path}.steps`, "invalid_value", "expected exactly one repair step");
  }
  const { step, path: stepPath } = stepMatches[0]!;
  expectEnum(step.status, ["completed"], `${stepPath}.status`);
  if (
    expectNullableString(
      step.conclusion,
      `${stepPath}.conclusion`,
      MaxText.token,
    ) !== "success"
  ) {
    fail(`${stepPath}.conclusion`, "invalid_value", "step is not successful");
  }
  const stepStartedAt = expectIsoMs(step.started_at, `${stepPath}.started_at`);
  const stepFinishedAt = expectIsoMs(
    step.completed_at,
    `${stepPath}.completed_at`,
  );
  if (
    stepStartedAt < startedAt || stepFinishedAt > finishedAt ||
    stepStartedAt > stepFinishedAt
  ) {
    fail(
      `${stepPath}.started_at`,
      "invalid_lifecycle",
      "step window is outside the job window",
    );
  }
  return {
    runId: candidate.runId,
    runAttempt: candidate.runAttempt,
    jobId,
    startedAt,
    finishedAt,
    stepStartedAt,
    stepFinishedAt,
  };
}

/**
 * The single terminal JSON record in the job log: only full
 * timestamp-prefixed lines are parsed, so a quoted JSON substring can never
 * attest. Any additional object carrying a `status` key is a duplicate.
 */
function parseActionsReleaseLogText(
  text: string,
  execution: ActionsReleaseExecutionV1,
  request: ReleaseRequestV1,
): { terminalAt: number; outcome: ActionsReleaseOutcomeV1 } {
  let terminal:
    | { terminalAt: number; outcome: ActionsReleaseOutcomeV1 }
    | null = null;
  for (const line of text.split(/\r?\n/)) {
    const match = ACTIONS_RELEASE_TIMESTAMP_LINE.exec(line);
    if (match === null) continue;
    let value: unknown;
    try {
      value = JSON.parse(match[2]);
    } catch {
      // A malformed/truncated line that visibly begins as a terminal record is
      // ambiguous evidence: never silently ignore it beside a valid line.
      if (/^\{\s*"status"\s*:\s*"ran"/.test(match[2])) {
        fail("$", "invalid_value", "malformed terminal-looking record");
      }
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const record = value as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, "status")) continue;
    if (terminal !== null) {
      fail("$", "invalid_lifecycle", "duplicate terminal record");
    }
    terminal = parseActionsReleaseTerminal(
      record,
      match[1],
      execution,
      request,
    );
  }
  if (terminal === null) {
    fail("$", "missing_field", "no terminal record found");
  }
  return terminal;
}

function parseActionsReleaseTerminal(
  record: Record<string, unknown>,
  timestamp: string,
  execution: ActionsReleaseExecutionV1,
  request: ReleaseRequestV1,
): { terminalAt: number; outcome: ActionsReleaseOutcomeV1 } {
  const allowed = [
    "status",
    "outcome",
    "controllerSha",
    "baseSha",
    "login",
    "startupReady",
    "ciApproval",
  ];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      fail(`$.${key}`, "unknown_key", "unexpected terminal key");
    }
  }
  for (
    const key of [
      "status",
      "outcome",
      "controllerSha",
      "baseSha",
      "login",
      "startupReady",
    ]
  ) {
    if (
      !Object.prototype.hasOwnProperty.call(record, key) ||
      record[key] === undefined
    ) {
      fail(`$.${key}`, "missing_field", "missing terminal key");
    }
  }
  expectEnum(record.status, ["ran"], "$.status");
  const outcome = expectRecord(record.outcome, "$.outcome");
  const outcomeStatus = expectEnum(
    outcome.status,
    ["idle", "margin", "step_limit"],
    "$.outcome.status",
  );
  // The actual RepairCycleOutcomeV1 union: idle/margin carry a bounded detail,
  // step_limit carries a bounded step count and never a detail.
  if (outcomeStatus === "step_limit") {
    expectExactKeys(outcome, ["status", "steps"], "$.outcome");
    const steps = expectCount(outcome.steps, "$.outcome.steps");
    if (steps > ACTIONS_RELEASE_MAX_STEPS) {
      fail("$.outcome.steps", "bound_exceeded", "step count exceeds the bound");
    }
  } else {
    expectExactKeys(outcome, ["status", "detail"], "$.outcome");
    expectNonEmptyString(outcome.detail, "$.outcome.detail", MaxText.detail);
  }
  if (
    expectNonEmptyString(record.controllerSha, "$.controllerSha", 40) !==
      request.revision
  ) {
    fail("$.controllerSha", "invalid_value", "terminal controller mismatch");
  }
  if (
    expectNonEmptyString(record.baseSha, "$.baseSha", 40) !==
      request.revision
  ) {
    fail("$.baseSha", "invalid_value", "terminal base mismatch");
  }
  if (
    expectNonEmptyString(record.login, "$.login", MaxText.login) !==
      ACTIONS_RELEASE_LOGIN
  ) {
    fail("$.login", "invalid_value", "unexpected terminal login");
  }
  if (expectBoolean(record.startupReady, "$.startupReady") !== true) {
    fail(
      "$.startupReady",
      "invalid_lifecycle",
      "terminal record did not prove model startup",
    );
  }
  if (Object.prototype.hasOwnProperty.call(record, "ciApproval")) {
    actionsReleaseCiApprovalCounts(record.ciApproval, "$.ciApproval");
  }
  const terminalAt = Date.parse(timestamp);
  if (!Number.isSafeInteger(terminalAt) || terminalAt < 0) {
    fail("$", "invalid_timestamp", "invalid terminal timestamp");
  }
  if (
    terminalAt < execution.stepStartedAt - ACTIONS_RELEASE_TIME_SLACK_MS ||
    terminalAt > execution.stepFinishedAt + ACTIONS_RELEASE_TIME_SLACK_MS
  ) {
    fail(
      "$",
      "invalid_lifecycle",
      "terminal record is outside the repair step window",
    );
  }
  return { terminalAt, outcome: outcomeStatus };
}

/** Only the fixed HTTPS results host, no userinfo, no fragment, port 443. */
function trustedActionsLogUrl(location: string): string | null {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hash !== "") return null;
  if (url.port !== "") return null;
  if (!ACTIONS_RELEASE_LOG_HOST.test(url.hostname)) return null;
  return url.toString();
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
