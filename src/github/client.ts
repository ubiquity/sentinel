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
import { canonicalStringify } from "../contracts/canonical.ts";
import {
  HOSTED_RUNTIME_STEP_NAME,
  parseHostedRuntimeTerminalV1,
} from "../contracts/hosted-execution.ts";
import type { HostedRuntimeTerminalV1 } from "../contracts/hosted-execution.ts";
import {
  HOSTED_ACTIONS_CLOCK_TOLERANCE_MS,
  HOSTED_SUPERVISOR_REF,
  HOSTED_SUPERVISOR_REPOSITORY,
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
  parseHostedExecutionIntentV1,
  parseHostedNotStartedProofV1,
  parseHostedRunProofV1,
} from "../contracts/hosted-supervisor.ts";
import type {
  HostedExecutionIntentV1,
  HostedExecutionSettlementV1,
  HostedNotStartedProofV1,
} from "../contracts/hosted-supervisor.ts";
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
import { parseReleaseRequestV1 } from "../contracts/release.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import {
  expectArray,
  expectBoolean,
  expectCount,
  expectEnum,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
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

/** Development ref compared by the hosted supervisor evidence reads. */
const ACTIONS_RELEASE_BRANCH = "development";
/** Bounded signed job-log read for the hosted runtime terminal. */
const ACTIONS_RELEASE_LOG_MAX_BYTES = 8 * 1024 * 1024;
const ACTIONS_RELEASE_LOG_HOST =
  /^productionresultssa[0-9]+\.blob\.core\.windows\.net$/;

/** Hosted supervisor execution reader: one bounded whole-operation window. */
const HOSTED_EXECUTION_READ_DEADLINE_MS = 120_000;
const HOSTED_EXECUTION_MAX_JOBS = 100;
const HOSTED_EXECUTION_BRANCH = "sentinel-supervisor";
const HOSTED_EXECUTION_UNAVAILABLE = "hosted execution evidence is unavailable";
const HOSTED_EXECUTION_SCOPE =
  "hosted execution evidence is restricted to the scope-0 self repository";
const HOSTED_EXECUTION_REDIRECT =
  "hosted execution log redirect is not trusted";
const HOSTED_EXECUTION_METADATA = "hosted execution metadata is invalid";
const HOSTED_EXECUTION_TERMINAL = "hosted runtime terminal evidence is invalid";
/** Full timestamp-prefixed line; the whole remainder is captured. */
const HOSTED_EXECUTION_TERMINAL_LINE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (.*)$/;
/** Truncated terminal text still names the trusted record kind anywhere. */
const HOSTED_EXECUTION_TERMINAL_LOOKING =
  /"kind"\s*:\s*"hosted_runtime_terminal"/;

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

  /** Authenticated JSON GET used by the hosted supervisor evidence reads. */

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

  // -------------------------------------------------------------------------
  // Hosted supervisor execution evidence (read-only, scope-0 self only)
  // -------------------------------------------------------------------------

  private isHostedSelfScope(): boolean {
    const repository = this.repository;
    return repository.installationId === 0 && repository.owner === "ubiquity" &&
      repository.name === "sentinel";
  }

  private hostedExecutionTimeout(): PortResultV1<never> {
    return portError("unavailable", HOSTED_EXECUTION_UNAVAILABLE);
  }

  /**
   * Ancestry check for one exact revision against the moving development ref:
   * the ref is never selected as an execution. Only an ahead/identical compare
   * whose base and merge base are the requested SHA is accepted.
   */
  async verifyHostedRevision(
    revision: GitSha,
  ): Promise<PortResultV1<boolean>> {
    if (!this.isHostedSelfScope() || !isGitSha(revision)) {
      return portError("invalid", HOSTED_EXECUTION_SCOPE);
    }
    const deadline = createDeadline(HOSTED_EXECUTION_READ_DEADLINE_MS);
    try {
      const response = await this.request(
        "GET",
        `/repos/${
          repoPath(this.repository)
        }/compare/${revision}...${ACTIONS_RELEASE_BRANCH}`,
        {},
        deadline,
      );
      if (!response.ok) return response;
      if (response.value.status !== 200) {
        return portError(...this.mapError(response.value));
      }
      return parseWire(
        response.value,
        (value) => parseHostedCompare(value, revision),
      );
    } catch {
      return portError("unavailable", HOSTED_EXECUTION_UNAVAILABLE);
    } finally {
      deadline.dispose();
    }
  }

  /**
   * Exact self production open request: the merged PR and its two-parent merge
   * commit are revalidated, then the requested revision must be an ancestor of
   * the current development ref within the SAME deadline. No workflow listing
   * and no authority-tree comparison.
   */
  async verifyHostedReleaseRequest(
    request: ReleaseRequestV1,
  ): Promise<PortResultV1<boolean>> {
    if (!this.isHostedSelfScope()) {
      return portError("invalid", HOSTED_EXECUTION_SCOPE);
    }
    const parsed = tryParse(parseReleaseRequestV1, request);
    if (!parsed.ok || !hostedSelfRequest(parsed.value)) return portOk(false);
    const frozen = parsed.value;
    const deadline = createDeadline(HOSTED_EXECUTION_READ_DEADLINE_MS);
    try {
      const repo = repoPath(this.repository);
      const pull = await this.actionsReleaseGet(
        `/repos/${repo}/pulls/${frozen.source.pullRequest}`,
        {},
        deadline,
      );
      if (!pull.ok) return pull;
      const parsedPull = tryParse(
        (value) => parseActionsReleasePull(value, frozen),
        pull.value,
      );
      if (!parsedPull.ok) return portOk(false);
      if (deadline.fired()) return this.hostedExecutionTimeout();
      const commit = await this.actionsReleaseGet(
        `/repos/${repo}/commits/${frozen.revision}`,
        {},
        deadline,
      );
      if (!commit.ok) return commit;
      const parsedCommit = tryParse(
        (value) => parseActionsReleaseCommit(value, frozen),
        commit.value,
      );
      if (!parsedCommit.ok) return portOk(false);
      if (deadline.fired()) return this.hostedExecutionTimeout();
      const compare = await this.request(
        "GET",
        `/repos/${repo}/compare/${frozen.revision}...${ACTIONS_RELEASE_BRANCH}`,
        {},
        deadline,
      );
      if (!compare.ok) return compare;
      if (compare.value.status !== 200) {
        return portError(...this.mapError(compare.value));
      }
      return parseWire(
        compare.value,
        (value) => parseHostedCompare(value, frozen.revision),
      );
    } catch {
      return portError("unavailable", HOSTED_EXECUTION_UNAVAILABLE);
    } finally {
      deadline.dispose();
    }
  }

  /**
   * Exact authenticated settlement of one saved hosted execution intent:
   * attempt + complete one-page jobs listing + (for a completed runtime step)
   * the trusted signed job log carrying exactly one runtime terminal. A missing
   * or not-yet-complete repair job is `null` (pending); an exact completed
   * skip/absence is an explicit not_started settlement. Nothing is inferred
   * from a green workflow alone.
   */
  async readHostedExecution(
    intent: HostedExecutionIntentV1,
  ): Promise<PortResultV1<HostedExecutionSettlementV1 | null>> {
    if (!this.isHostedSelfScope()) {
      return portError("invalid", HOSTED_EXECUTION_SCOPE);
    }
    const parsedIntent = tryParse(parseHostedExecutionIntentV1, intent);
    if (!parsedIntent.ok) return portError("invalid", HOSTED_EXECUTION_SCOPE);
    const saved = parsedIntent.value;
    const deadline = createDeadline(HOSTED_EXECUTION_READ_DEADLINE_MS);
    try {
      const repo = repoPath(this.repository);
      const attemptRaw = await this.actionsReleaseGet(
        `/repos/${repo}/actions/runs/${saved.runId}/attempts/${saved.runAttempt}`,
        {},
        deadline,
      );
      if (!attemptRaw.ok) return attemptRaw;
      const observedAt = this.options.clock.now();
      const attempt = parseWith(
        attemptRaw.value,
        (value) => parseHostedAttempt(value, saved, observedAt),
      );
      if (!attempt.ok) return attempt;
      const jobs = await this.readHostedAttemptJobs(saved, deadline);
      if (!jobs.ok) return jobs;
      const evidenceDigest = await sha256Hex(
        canonicalStringify({
          attempt: attemptRaw.value,
          jobs: jobs.value.raw,
        }),
      );
      const repair = jobs.value.repair;
      if (repair === null) {
        if (
          attempt.value.status !== "completed" ||
          attempt.value.completedAt === null
        ) {
          return portOk(null);
        }
        return this.hostedNotStarted(
          saved,
          null,
          attempt.value.completedAt,
          evidenceDigest,
        );
      }
      if (repair.status !== "completed" || repair.completedAt === null) {
        return portOk(null);
      }
      if (repair.conclusion === "skipped") {
        return this.hostedNotStarted(
          saved,
          repair.id,
          repair.completedAt,
          evidenceDigest,
        );
      }
      const step = repair.runtimeStep;
      if (step === null) {
        return portError("unavailable", HOSTED_EXECUTION_METADATA);
      }
      if (step.status === "completed" && step.conclusion === "skipped") {
        return this.hostedNotStarted(
          saved,
          repair.id,
          repair.completedAt,
          evidenceDigest,
        );
      }
      if (repair.conclusion !== "success" && repair.conclusion !== "failure") {
        return portError("unavailable", HOSTED_EXECUTION_METADATA);
      }
      if (
        step.status !== "completed" ||
        (step.conclusion !== "success" && step.conclusion !== "failure") ||
        repair.startedAt === null || step.startedAt === null ||
        step.completedAt === null
      ) {
        return portError("unavailable", HOSTED_EXECUTION_METADATA);
      }
      // Actual (non-skipped) metadata must be coherent and not future.
      const tolerance = HOSTED_ACTIONS_CLOCK_TOLERANCE_MS;
      if (
        step.startedAt + tolerance < repair.startedAt ||
        step.completedAt > repair.completedAt + tolerance ||
        repair.completedAt > observedAt + tolerance ||
        step.completedAt > observedAt + tolerance
      ) {
        return portError("unavailable", HOSTED_EXECUTION_METADATA);
      }
      const log = await this.readHostedRuntimeLog(repair.id, deadline);
      if (!log.ok) return log;
      const parsedTerminal = parseHostedRuntimeTerminalLog(
        log.value,
        saved,
        repair,
        step,
        observedAt,
      );
      if (!parsedTerminal.ok) return parsedTerminal;
      const terminal = parsedTerminal.value.terminal;
      // A healthy terminal with a failed job or runtime step is contradictory:
      // it is never rewritten into a failed proof.
      if (
        terminal.outcome === "healthy" &&
        (repair.conclusion !== "success" || step.conclusion !== "success")
      ) {
        return portError("unavailable", HOSTED_EXECUTION_METADATA);
      }
      return parseWith({
        execution: saved,
        workflowId: HOSTED_SUPERVISOR_WORKFLOW_ID,
        workflowPath: HOSTED_SUPERVISOR_WORKFLOW_PATH,
        repository: HOSTED_SUPERVISOR_REPOSITORY,
        ref: HOSTED_SUPERVISOR_REF,
        jobId: repair.id,
        startedAt: repair.startedAt,
        finishedAt: repair.completedAt,
        observedAt,
        outcome: terminal.outcome === "healthy" ? "healthy" : "failed",
        startupReady: terminal.startupReady,
        settled: true,
        baseSha: terminal.baseSha,
        terminalAt: parsedTerminal.value.terminalAt,
        logDigest: await sha256Hex(log.value),
      }, parseHostedRunProofV1);
    } catch {
      return portError("unavailable", HOSTED_EXECUTION_UNAVAILABLE);
    } finally {
      deadline.dispose();
    }
  }

  private hostedNotStarted(
    intent: HostedExecutionIntentV1,
    jobId: number | null,
    finishedAt: number,
    evidenceDigest: string,
  ): PortResultV1<HostedNotStartedProofV1> {
    return parseWith({
      execution: intent,
      workflowId: HOSTED_SUPERVISOR_WORKFLOW_ID,
      workflowPath: HOSTED_SUPERVISOR_WORKFLOW_PATH,
      repository: HOSTED_SUPERVISOR_REPOSITORY,
      ref: HOSTED_SUPERVISOR_REF,
      jobId,
      finishedAt,
      observedAt: this.options.clock.now(),
      outcome: "not_started",
      evidenceDigest,
    }, parseHostedNotStartedProofV1);
  }

  /** One complete bounded jobs page; duplicates/identity mismatches fail. */
  private async readHostedAttemptJobs(
    intent: HostedExecutionIntentV1,
    deadline: DeadlineV1,
  ): Promise<
    PortResultV1<{ raw: unknown; repair: HostedRepairJobV1 | null }>
  > {
    if (deadline.fired()) return this.hostedExecutionTimeout();
    const repo = repoPath(this.repository);
    const response = await this.request(
      "GET",
      `/repos/${repo}/actions/runs/${intent.runId}/attempts/${intent.runAttempt}/jobs`,
      { per_page: String(HOSTED_EXECUTION_MAX_JOBS) },
      deadline,
    );
    if (!response.ok) return response;
    if (response.value.status !== 200) {
      return portError(...this.mapError(response.value));
    }
    if (nextLinkUrl(response.value.headers) !== null) {
      return portError("unavailable", HOSTED_EXECUTION_METADATA);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(response.value.bodyText);
    } catch {
      return portError("invalid", "GitHub API response is malformed");
    }
    const parsed = parseWith(
      raw,
      (value) => parseHostedJobs(value, intent),
    );
    if (!parsed.ok) return parsed;
    return portOk({ raw, repair: parsed.value.repair });
  }

  /** Trusted signed job log, bounded and read without any credential. */
  private async readHostedRuntimeLog(
    jobId: number,
    deadline: DeadlineV1,
  ): Promise<PortResultV1<string>> {
    if (deadline.fired()) return this.hostedExecutionTimeout();
    const raw = await this.sendCore(
      "GET",
      `${this.apiBaseUrl}/repos/${
        repoPath(this.repository)
      }/actions/jobs/${jobId}/logs`,
      null,
      "manual",
      deadline,
    );
    if (raw.status === "error") {
      return portError(raw.error.kind, raw.error.detail, raw.error.rateLimit);
    }
    if (raw.status === "lost") {
      return portError("unavailable", HOSTED_EXECUTION_UNAVAILABLE);
    }
    if (raw.response.status !== 302) {
      return portError("unavailable", HOSTED_EXECUTION_UNAVAILABLE);
    }
    const location = raw.response.headers.get("location");
    if (location === null) {
      return portError("unavailable", HOSTED_EXECUTION_REDIRECT);
    }
    const signedUrl = trustedActionsLogUrl(location);
    if (signedUrl === null) {
      return portError("unavailable", HOSTED_EXECUTION_REDIRECT);
    }
    if (deadline.fired()) return this.hostedExecutionTimeout();
    let logResponse: HttpResponseV1;
    try {
      const signedCall = Promise.resolve().then(() =>
        this.options.http({
          method: "GET",
          url: signedUrl,
          headers: new Map<string, string>(),
          body: null,
          redirect: "error",
        })
      );
      signedCall.catch(() => {});
      logResponse = await deadline.race(signedCall);
    } catch {
      return portError("unavailable", HOSTED_EXECUTION_UNAVAILABLE);
    }
    if (logResponse.status !== 200) {
      return portError("unavailable", HOSTED_EXECUTION_UNAVAILABLE);
    }
    if (
      new TextEncoder().encode(logResponse.bodyText).length >
        ACTIONS_RELEASE_LOG_MAX_BYTES
    ) {
      return portError("unavailable", HOSTED_EXECUTION_UNAVAILABLE);
    }
    return portOk(logResponse.bodyText);
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

// ---------------------------------------------------------------------------
// Hosted supervisor execution wire validation
// ---------------------------------------------------------------------------

interface HostedAttemptV1 {
  status: string;
  completedAt: number | null;
}

interface HostedRuntimeStepV1 {
  status: string | null;
  conclusion: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

interface HostedRepairJobV1 {
  id: number;
  status: string;
  conclusion: string | null;
  startedAt: number | null;
  completedAt: number | null;
  runtimeStep: HostedRuntimeStepV1 | null;
}

interface HostedJobsV1 {
  repair: HostedRepairJobV1 | null;
}

/** Exact scope-0 production open reviewed request. */
function hostedSelfRequest(request: ReleaseRequestV1): boolean {
  const repository = request.target.repository;
  return repository.installationId === 0 && repository.owner === "ubiquity" &&
    repository.name === "sentinel" &&
    request.target.environment === "production" &&
    request.status === "open" && request.source.reviewReceiptId !== null;
}

/**
 * Compare wire (real GitHub shape, no head_commit): the requested SHA must be
 * the compare base AND the merge base, counters must be consistent, and only
 * ahead/identical are positive; behind/diverged are definitive negatives.
 */
function parseHostedCompare(value: unknown, revision: GitSha): boolean {
  const obj = expectRecord(value, "$");
  const status = expectEnum(
    obj.status,
    ["ahead", "behind", "diverged", "identical"],
    "$.status",
  );
  const baseCommit = expectRecord(obj.base_commit, "$.base_commit");
  const baseSha = expectGitSha(baseCommit.sha, "$.base_commit.sha");
  const mergeCommit = expectRecord(
    obj.merge_base_commit,
    "$.merge_base_commit",
  );
  const mergeSha = expectGitSha(mergeCommit.sha, "$.merge_base_commit.sha");
  const aheadBy = expectCount(obj.ahead_by, "$.ahead_by");
  const behindBy = expectCount(obj.behind_by, "$.behind_by");
  const totalCommits = expectCount(obj.total_commits, "$.total_commits");
  if (totalCommits !== aheadBy + behindBy) {
    fail(
      "$.total_commits",
      "invalid_value",
      "compare counters are inconsistent",
    );
  }
  if (status === "identical") {
    if (aheadBy !== 0 || behindBy !== 0 || totalCommits !== 0) {
      fail(
        "$.status",
        "invalid_value",
        "identical compare must have zero counters",
      );
    }
    return baseSha === revision && mergeSha === revision;
  }
  if (status === "ahead") {
    if (aheadBy === 0 || behindBy !== 0) {
      fail(
        "$.status",
        "invalid_value",
        "ahead compare counters are inconsistent",
      );
    }
    return baseSha === revision && mergeSha === revision;
  }
  // behind/diverged: definitive negatives; malformed counters already failed.
  if (behindBy === 0) {
    fail(
      "$.status",
      "invalid_value",
      "behind/diverged compare counters are inconsistent",
    );
  }
  return false;
}

/** Exact attempt identity; completion instant required only when completed. */
function parseHostedAttempt(
  value: unknown,
  intent: HostedExecutionIntentV1,
  observedAt: number,
): HostedAttemptV1 {
  const obj = expectRecord(value, "$");
  if (expectPositiveInt(obj.id, "$.id") !== intent.runId) {
    fail("$.id", "invalid_value", "attempt run id mismatch");
  }
  if (
    expectPositiveInt(obj.run_attempt, "$.run_attempt") !== intent.runAttempt
  ) {
    fail("$.run_attempt", "invalid_value", "attempt number mismatch");
  }
  if (
    expectPositiveInt(obj.workflow_id, "$.workflow_id") !==
      HOSTED_SUPERVISOR_WORKFLOW_ID
  ) {
    fail("$.workflow_id", "invalid_value", "unexpected workflow id");
  }
  if (
    expectNonEmptyString(obj.path, "$.path", MaxText.path) !==
      HOSTED_SUPERVISOR_WORKFLOW_PATH
  ) {
    fail("$.path", "invalid_value", "unexpected workflow path");
  }
  expectEnum(obj.event, ["workflow_dispatch"], "$.event");
  if (
    expectNonEmptyString(obj.head_branch, "$.head_branch", MaxText.branch) !==
      HOSTED_EXECUTION_BRANCH
  ) {
    fail("$.head_branch", "invalid_value", "unexpected workflow branch");
  }
  if (
    expectNonEmptyString(obj.head_sha, "$.head_sha", 40) !== intent.launcherSha
  ) {
    fail("$.head_sha", "invalid_value", "attempt launcher mismatch");
  }
  expectSelfRepository(obj.repository, "$.repository");
  expectSelfRepository(obj.head_repository, "$.head_repository");
  const status = expectEnum(
    obj.status,
    ["queued", "in_progress", "completed", "requested", "waiting", "pending"],
    "$.status",
  );
  const runStartedAt = expectNullable(
    obj.run_started_at,
    "$.run_started_at",
    expectIsoMs,
  );
  const completedAt = expectNullable(
    obj.updated_at,
    "$.updated_at",
    expectIsoMs,
  );
  if (
    completedAt !== null &&
    completedAt > observedAt + HOSTED_ACTIONS_CLOCK_TOLERANCE_MS
  ) {
    fail(
      "$.updated_at",
      "invalid_lifecycle",
      "attempt update is after the observation time",
    );
  }
  if (
    runStartedAt !== null && completedAt !== null &&
    runStartedAt > completedAt
  ) {
    fail(
      "$.updated_at",
      "invalid_lifecycle",
      "attempt times are inverted",
    );
  }
  if (
    status === "completed" && (runStartedAt === null || completedAt === null)
  ) {
    fail(
      "$.updated_at",
      "invalid_lifecycle",
      "a completed attempt requires its start and completion instants",
    );
  }
  return { status, completedAt };
}

/** Exactly one bounded complete page with at most one total repair job. */
function parseHostedJobs(
  value: unknown,
  intent: HostedExecutionIntentV1,
): HostedJobsV1 {
  const obj = expectRecord(value, "$");
  const total = expectCount(obj.total_count, "$.total_count");
  const jobs = expectArray(
    obj.jobs,
    "$.jobs",
    HOSTED_EXECUTION_MAX_JOBS,
    (item) => item,
  );
  if (total > HOSTED_EXECUTION_MAX_JOBS || jobs.length !== total) {
    fail("$.total_count", "bound_exceeded", "job list is not a complete page");
  }
  const matches: Array<{ job: Record<string, unknown>; path: string }> = [];
  for (const [index, item] of jobs.entries()) {
    const path = `$.jobs[${index}]`;
    const job = expectRecord(item, path);
    if (
      expectNonEmptyString(job.name, `${path}.name`, MaxText.label) !== "repair"
    ) {
      continue;
    }
    matches.push({ job, path });
  }
  if (matches.length > 1) {
    fail("$.jobs", "invalid_value", "expected at most one repair job");
  }
  if (matches.length === 0) return { repair: null };
  const { job, path } = matches[0]!;
  const id = expectPositiveInt(job.id, `${path}.id`);
  if (
    expectPositiveInt(job.run_id, `${path}.run_id`) !== intent.runId ||
    expectPositiveInt(job.run_attempt, `${path}.run_attempt`) !==
      intent.runAttempt ||
    expectNonEmptyString(job.head_sha, `${path}.head_sha`, 40) !==
      intent.launcherSha
  ) {
    fail(`${path}.run_id`, "invalid_value", "repair job identity mismatch");
  }
  const status = expectEnum(
    job.status,
    ["queued", "in_progress", "completed", "requested", "waiting", "pending"],
    `${path}.status`,
  );
  const conclusion = expectNullableString(
    job.conclusion,
    `${path}.conclusion`,
    MaxText.token,
  );
  const startedAt = expectNullable(
    job.started_at,
    `${path}.started_at`,
    expectIsoMs,
  );
  const completedAt = expectNullable(
    job.completed_at,
    `${path}.completed_at`,
    expectIsoMs,
  );
  // A completed job always carries its authenticated completion instant; a
  // skipped job may legitimately have no start timestamp.
  if (status === "completed" && completedAt === null) {
    fail(
      `${path}.completed_at`,
      "invalid_lifecycle",
      "a completed repair job requires its completion instant",
    );
  }
  if (startedAt !== null && completedAt !== null && startedAt > completedAt) {
    fail(
      `${path}.completed_at`,
      "invalid_lifecycle",
      "repair job times are inverted",
    );
  }
  const steps = expectArray(
    job.steps,
    `${path}.steps`,
    HOSTED_EXECUTION_MAX_JOBS,
    (item) => item,
  );
  const stepMatches: Array<{ step: Record<string, unknown>; path: string }> =
    [];
  for (const [index, item] of steps.entries()) {
    const stepPath = `${path}.steps[${index}]`;
    const step = expectRecord(item, stepPath);
    if (
      expectNonEmptyString(step.name, `${stepPath}.name`, MaxText.path) ===
        HOSTED_RUNTIME_STEP_NAME
    ) {
      stepMatches.push({ step, path: stepPath });
    }
  }
  if (stepMatches.length > 1) {
    fail(`${path}.steps`, "invalid_value", "expected at most one runtime step");
  }
  let runtimeStep: HostedRuntimeStepV1 | null = null;
  if (stepMatches.length === 1) {
    const { step, path: stepPath } = stepMatches[0]!;
    const stepStatus = expectNullableString(
      step.status,
      `${stepPath}.status`,
      MaxText.token,
    );
    const stepConclusion = expectNullableString(
      step.conclusion,
      `${stepPath}.conclusion`,
      MaxText.token,
    );
    const stepStartedAt = expectNullable(
      step.started_at,
      `${stepPath}.started_at`,
      expectIsoMs,
    );
    const stepCompletedAt = expectNullable(
      step.completed_at,
      `${stepPath}.completed_at`,
      expectIsoMs,
    );
    // Only an actual non-skipped run needs full start/finish evidence.
    if (
      stepStatus === "completed" && stepConclusion !== "skipped" &&
      (stepStartedAt === null || stepCompletedAt === null)
    ) {
      fail(
        `${stepPath}.completed_at`,
        "invalid_lifecycle",
        "a completed non-skipped runtime step requires its timestamps",
      );
    }
    if (
      stepStartedAt !== null && stepCompletedAt !== null &&
      stepStartedAt > stepCompletedAt
    ) {
      fail(
        `${stepPath}.completed_at`,
        "invalid_lifecycle",
        "runtime step times are inverted",
      );
    }
    runtimeStep = {
      status: stepStatus,
      conclusion: stepConclusion,
      startedAt: stepStartedAt,
      completedAt: stepCompletedAt,
    };
  }
  return {
    repair: { id, status, conclusion, startedAt, completedAt, runtimeStep },
  };
}

/**
 * Exactly one outer runtime terminal in the bounded raw log. Full
 * timestamp-prefixed lines only; a malformed terminal-looking line is
 * ambiguous evidence even beside a valid one. The terminal must bind the full
 * saved intent and the exact controller, and its window must fit the runtime
 * step and job boundaries.
 */
function parseHostedRuntimeTerminalLog(
  text: string,
  intent: HostedExecutionIntentV1,
  job: HostedRepairJobV1,
  step: HostedRuntimeStepV1,
  observedAt: number,
): PortResultV1<{ terminal: HostedRuntimeTerminalV1; terminalAt: number }> {
  const tolerance = HOSTED_ACTIONS_CLOCK_TOLERANCE_MS;
  let found: { terminal: HostedRuntimeTerminalV1; terminalAt: number } | null =
    null;
  for (const line of text.split(/\r?\n/)) {
    const match = HOSTED_EXECUTION_TERMINAL_LINE.exec(line);
    if (match === null) continue;
    let value: unknown;
    try {
      value = JSON.parse(match[2]);
    } catch {
      if (HOSTED_EXECUTION_TERMINAL_LOOKING.test(match[2])) {
        return portError("unavailable", HOSTED_EXECUTION_TERMINAL);
      }
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    if ((value as Record<string, unknown>).kind !== "hosted_runtime_terminal") {
      continue;
    }
    if (found !== null) {
      return portError("unavailable", HOSTED_EXECUTION_TERMINAL);
    }
    const parsed = tryParse(parseHostedRuntimeTerminalV1, value);
    if (!parsed.ok) {
      return portError("unavailable", HOSTED_EXECUTION_TERMINAL);
    }
    if (
      canonicalStringify(parsed.value.execution) !== canonicalStringify(intent)
    ) {
      return portError("unavailable", HOSTED_EXECUTION_TERMINAL);
    }
    if (parsed.value.controllerSha !== intent.revision) {
      return portError("unavailable", HOSTED_EXECUTION_TERMINAL);
    }
    const terminalAt = Date.parse(match[1]);
    if (!Number.isSafeInteger(terminalAt) || terminalAt < 0) {
      return portError("unavailable", HOSTED_EXECUTION_TERMINAL);
    }
    found = { terminal: parsed.value, terminalAt };
  }
  if (found === null) {
    return portError("unavailable", HOSTED_EXECUTION_TERMINAL);
  }
  if (
    job.startedAt === null || job.completedAt === null ||
    step.startedAt === null || step.completedAt === null
  ) {
    return portError("unavailable", HOSTED_EXECUTION_TERMINAL);
  }
  const terminal = found.terminal;
  if (
    terminal.startedAt + tolerance < step.startedAt ||
    terminal.finishedAt > step.completedAt + tolerance ||
    terminal.startedAt + tolerance < job.startedAt ||
    terminal.finishedAt > job.completedAt + tolerance ||
    // The authenticated log instant must follow the terminal's own finish.
    found.terminalAt + tolerance < terminal.finishedAt ||
    found.terminalAt > terminal.finishedAt + tolerance ||
    observedAt + tolerance < terminal.finishedAt
  ) {
    return portError("unavailable", HOSTED_EXECUTION_TERMINAL);
  }
  return portOk(found);
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
