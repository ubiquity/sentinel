/**
 * Strict wire parsers for the default GitHub REST HTTP path.
 *
 * These parsers consume the actual GitHub API JSON shapes and normalize them
 * into the frozen port identity types. Rules (fail closed, never silent):
 *
 * - Consumed fields are validated exactly: full 40-hex SHAs, millisecond
 *   epoch timestamps parsed from ISO-8601, closed enums, explicit nulls.
 *   Extra wire fields are tolerated (GitHub adds fields across versions) but
 *   an unknown value for a consumed field, a wrong type or a missing
 *   required field is invalid.
 * - Issue-vs-PR distinction: a `/issues` response carrying `pull_request` is
 *   a PR, not an issue; issue listings exclude those records.
 * - Merged state is derived from `merged_at` plus a required merge commit
 *   identity. GitHub can expose a temporary `merge_commit_sha` for an
 *   unmerged test merge; that value is not a delivery identity and is ignored.
 * - Text bound overflow is unavailable/incomplete: a body beyond the contract
 *   bound makes the whole value invalid rather than silently truncated.
 */

import { asGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import type {
  GitHubBranchProtectionsV1,
  GitHubChecksV1,
  GitHubCheckV1,
  GitHubIssueV1,
  GitHubPullRequestV1,
  GitHubRefV1,
  GitHubReviewDecisionV1,
} from "../contracts/ports.ts";
import {
  expectBoolean,
  expectCount,
  expectEnum,
  expectNonEmptyString,
  expectPositiveInt,
  expectRecord,
  expectString,
  expectStringArray,
  fail,
  MaxText,
} from "../contracts/validation.ts";

export const MAX_ISSUE_BODY = MaxText.body;
export const MAX_PULL_BODY = MaxText.body;
/** Wire-level sanity bound; contract bounds are applied at normalization. */
export const MAX_WIRE_TEXT = 1_000_000;

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** Strict GitHub ISO-8601 timestamp (`2024-01-01T00:00:00Z`, optional
 * milliseconds) -> millisecond epoch; any other form fails closed. */
const GITHUB_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function expectIsoTimestamp(value: unknown, path: string): number {
  const text = expectNonEmptyString(value, path, MaxText.token);
  if (!GITHUB_ISO_RE.test(text)) {
    fail(path, "invalid_timestamp", "expected ISO-8601 UTC timestamp");
  }
  const parsed = Date.parse(text);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail(path, "invalid_timestamp", "expected valid ISO-8601 timestamp");
  }
  return parsed;
}

function expectIsoTimestampNullable(
  value: unknown,
  path: string,
): number | null {
  if (value === null) return null;
  return expectIsoTimestamp(value, path);
}

function expectWireSha(value: unknown, path: string): GitSha {
  const text = expectNonEmptyString(value, path, 40);
  if (!/^[0-9a-f]{40}$/.test(text)) {
    fail(path, "invalid_sha", "expected full 40-hex commit SHA");
  }
  return asGitSha(text);
}

function expectWireShaNullable(value: unknown, path: string): GitSha | null {
  if (value === null) return null;
  return expectWireSha(value, path);
}

function expectLogin(value: unknown, path: string): string | null {
  if (value === null) return null;
  const obj = expectRecord(value, path);
  return expectNullableLogin(obj.login, `${path}.login`);
}

function expectNullableLogin(value: unknown, path: string): string | null {
  if (value === null) return null;
  return expectNonEmptyString(value, path, MaxText.login);
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export type IssueWireResultV1 =
  | { kind: "issue"; issue: GitHubIssueV1 }
  | { kind: "pull_request" };

export function parseIssueWire(
  input: unknown,
  path: string,
): IssueWireResultV1 {
  const obj = expectRecord(input, path);
  if ("pull_request" in obj) return { kind: "pull_request" };
  const number = expectPositiveInt(obj.number, `${path}.number`);
  const title = expectString(obj.title, `${path}.title`, MaxText.message);
  const body = expectIssueBody(obj.body, `${path}.body`);
  const state = expectEnum(obj.state, ["open", "closed"], `${path}.state`);
  const author = expectLogin(obj.user, `${path}.user`);
  const labels = parseLabels(obj.labels, `${path}.labels`);
  const createdAt = expectIsoTimestamp(obj.created_at, `${path}.created_at`);
  const updatedAt = expectIsoTimestamp(obj.updated_at, `${path}.updated_at`);
  const closedAt = expectIsoTimestampNullable(
    obj.closed_at,
    `${path}.closed_at`,
  );
  if (closedAt !== null && closedAt < createdAt) {
    fail(
      `${path}.closed_at`,
      "invalid_timestamp",
      "close time precedes creation",
    );
  }
  return {
    kind: "issue",
    issue: {
      number,
      title,
      body,
      state,
      author,
      labels,
      createdAt,
      updatedAt,
      closedAt,
    },
  };
}

function expectIssueBody(value: unknown, path: string): string {
  if (value === null) return "";
  const text = expectString(value, path, MAX_ISSUE_BODY);
  return text;
}

function parseLabels(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    fail(path, "wrong_type", "expected array, got null");
  }
  if (value.length > 64) {
    fail(path, "bound_exceeded", "too many labels");
  }
  return value.map((item, index) => {
    const obj = expectRecord(item, `${path}[${index}]`);
    return expectNonEmptyString(
      obj.name,
      `${path}[${index}].name`,
      MaxText.label,
    );
  });
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export function parsePullWire(
  input: unknown,
  path: string,
): GitHubPullRequestV1 {
  const obj = expectRecord(input, path);
  const number = expectPositiveInt(obj.number, `${path}.number`);
  const title = expectString(obj.title, `${path}.title`, MaxText.message);
  const body = pullBody(obj.body, `${path}.body`);
  const state = expectEnum(obj.state, ["open", "closed"], `${path}.state`);
  const headObj = expectRecord(obj.head, `${path}.head`);
  const baseObj = expectRecord(obj.base, `${path}.base`);
  const headRef = expectBranchRef(headObj.ref, `${path}.head.ref`);
  const baseRef = expectBranchRef(baseObj.ref, `${path}.base.ref`);
  const head = expectWireSha(headObj.sha, `${path}.head.sha`);
  const base = expectWireSha(baseObj.sha, `${path}.base.sha`);
  const author = expectLogin(obj.user, `${path}.user`);
  const createdAt = expectIsoTimestamp(obj.created_at, `${path}.created_at`);
  const updatedAt = expectIsoTimestamp(obj.updated_at, `${path}.updated_at`);
  const mergedAt = expectIsoTimestampNullable(
    obj.merged_at,
    `${path}.merged_at`,
  );
  const observedMergeSha = expectWireShaNullable(
    obj.merge_commit_sha,
    `${path}.merge_commit_sha`,
  );
  // GitHub may populate merge_commit_sha for an unmerged test merge. Only a
  // non-null merged_at marks delivery; the merge SHA is required in that
  // case, and an unmerged test SHA is deliberately not exposed as delivery
  // identity to callers.
  const merged = mergedAt !== null;
  if (merged && observedMergeSha === null) {
    fail(
      `${path}.merge_commit_sha`,
      "invalid_value",
      "merged pull request carries no merge commit sha",
    );
  }
  const mergeSha = merged ? observedMergeSha : null;
  const reviewDecision = parseReviewDecision(
    obj.review_decision,
    `${path}.review_decision`,
  );
  return {
    number,
    title,
    body,
    state: merged ? "merged" : state,
    head,
    base,
    mergeSha,
    headRef,
    baseRef,
    author,
    createdAt,
    updatedAt,
    mergedAt,
    reviewDecision,
  };
}

function pullBody(value: unknown, path: string): string {
  if (value === null) return "";
  return expectString(value, path, MAX_PULL_BODY);
}

function expectBranchRef(value: unknown, path: string): string {
  return expectNonEmptyString(value, path, MaxText.branch);
}

export function parseReviewDecision(
  value: unknown,
  path: string,
): GitHubReviewDecisionV1 {
  if (value === null || value === undefined) return "none" as const;
  return expectEnum(
    value,
    ["approved", "changes_requested", "review_required", "none"],
    path,
  );
}

/** Parse the authoritative GraphQL pull-request approval response. */
export function parsePullReviewDecisionWire(
  input: unknown,
  path: string,
): GitHubReviewDecisionV1 {
  const obj = expectRecord(input, path);
  if (obj.errors !== undefined) {
    const errors = expectExistingArray(obj.errors, `${path}.errors`);
    if (errors.length > 0) {
      fail(path, "invalid_value", "GraphQL response contains errors");
    }
  }
  const data = expectRecord(obj.data, `${path}.data`);
  const repository = expectRecord(data.repository, `${path}.data.repository`);
  const pullRequest = repository.pullRequest;
  if (pullRequest === null || pullRequest === undefined) {
    fail(
      `${path}.data.repository.pullRequest`,
      "invalid_value",
      "GraphQL response has no pull request",
    );
  }
  const pull = expectRecord(
    pullRequest,
    `${path}.data.repository.pullRequest`,
  );
  const decisionPath = `${path}.data.repository.pullRequest.reviewDecision`;
  const decision = pull.reviewDecision;
  if (decision === null) return "none";
  const normalized = decision === "APPROVED"
    ? "approved"
    : decision === "CHANGES_REQUESTED"
    ? "changes_requested"
    : decision === "REVIEW_REQUIRED"
    ? "review_required"
    : decision;
  return parseReviewDecision(normalized, decisionPath);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const CHECK_STATUSES = ["queued", "in_progress", "completed"] as const;
const CHECK_CONCLUSIONS = [
  "success",
  "failure",
  "cancelled",
  "skipped",
  "timed_out",
  "neutral",
  "action_required",
] as const;

export function parseCheckRunWire(input: unknown, path: string): GitHubCheckV1 {
  const obj = expectRecord(input, path);
  const name = expectNonEmptyString(obj.name, `${path}.name`, MaxText.label);
  const status = expectEnum(obj.status, CHECK_STATUSES, `${path}.status`);
  const conclusion = obj.conclusion === null
    ? null
    : expectEnum(obj.conclusion, CHECK_CONCLUSIONS, `${path}.conclusion`);
  const head = expectWireSha(obj.head_sha, `${path}.head_sha`);
  const startedAt = expectIsoTimestampNullable(
    obj.started_at,
    `${path}.started_at`,
  );
  const completedAt = expectIsoTimestampNullable(
    obj.completed_at,
    `${path}.completed_at`,
  );
  return { name, status, conclusion, head, startedAt, completedAt };
}

/** Normalize one commit-status context into the shared exact-head check type. */
export function parseCommitStatusWire(
  input: unknown,
  path: string,
  head: GitSha,
): GitHubCheckV1 {
  const obj = expectRecord(input, path);
  const name = expectNonEmptyString(
    obj.context,
    `${path}.context`,
    MaxText.label,
  );
  const state = expectEnum(
    obj.state,
    ["error", "failure", "pending", "success"],
    `${path}.state`,
  );
  const createdAt = expectIsoTimestamp(obj.created_at, `${path}.created_at`);
  const updatedAt = expectIsoTimestamp(obj.updated_at, `${path}.updated_at`);
  if (updatedAt < createdAt) {
    fail(
      `${path}.updated_at`,
      "invalid_timestamp",
      "status update precedes creation",
    );
  }
  if (state === "pending") {
    return {
      name,
      status: "in_progress",
      conclusion: null,
      head,
      startedAt: createdAt,
      completedAt: null,
    };
  }
  return {
    name,
    status: "completed",
    conclusion: state === "success" ? "success" : "failure",
    head,
    startedAt: createdAt,
    completedAt: updatedAt,
  };
}

export function parseCheckRunsPage(
  body: unknown,
  path: string,
): GitHubCheckV1[] {
  const obj = expectRecord(body, path);
  const runs = expectExistingArray(obj.check_runs, `${path}.check_runs`);
  const checks = runs.map((run, index) =>
    parseCheckRunWire(run, `${path}.check_runs[${index}]`)
  );
  // The head of the collection is the identity every run is bound to; a
  // mixed-head page is invalid, never a partial success.
  const head = checks[0]?.head ?? null;
  if (head !== null) {
    for (const check of checks) {
      if (check.head !== head) {
        fail(`${path}.check_runs`, "invalid_lifecycle", "mixed check heads");
      }
    }
  }
  return checks;
}

export function checksOf(head: GitSha, runs: GitHubCheckV1[]): GitHubChecksV1 {
  return { head, checks: runs };
}

function expectExistingArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(path, "wrong_type", "expected array");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Branch protection
// ---------------------------------------------------------------------------

export function parseProtectionWire(
  input: unknown,
  branch: string,
): GitHubBranchProtectionsV1 {
  const obj = expectRecord(input, "$");
  const required = obj.required_status_checks;
  let requireBranchUpToDate = false;
  let requiredStatusChecks: string[] = [];
  if (required !== null && required !== undefined) {
    const checks = expectRecord(required, "$.required_status_checks");
    requireBranchUpToDate = expectBoolean(
      checks.strict,
      "$.required_status_checks.strict",
    );
    // Both `contexts` (legacy) and `checks` (modern) carry the same required
    // name list; the modern list wins when the legacy one is empty.
    const contextsValue = checks.contexts === undefined ? [] : checks.contexts;
    const contexts = expectStringArray(
      contextsValue,
      "$.required_status_checks.contexts",
      512,
      MaxText.label,
    );
    const checksValue = checks.checks === undefined ? [] : checks.checks;
    const checkEntries = expectExistingArray(
      checksValue,
      "$.required_status_checks.checks",
    ).map((entry, index) =>
      expectNonEmptyString(
        expectRecord(entry, "$.required_status_checks.checks")
          .context,
        `$.required_status_checks.checks[${index}].context`,
        MaxText.label,
      )
    );
    requiredStatusChecks = contexts.length > 0 ? contexts : checkEntries;
  }
  let enforceAdmins = false;
  if (obj.enforce_admins !== null && obj.enforce_admins !== undefined) {
    const admins = expectRecord(obj.enforce_admins, "$.enforce_admins");
    enforceAdmins = expectBoolean(admins.enabled, "$.enforce_admins.enabled");
  }
  let requiredApprovingReviewCount = 0;
  if (
    obj.required_pull_request_reviews !== null &&
    obj.required_pull_request_reviews !== undefined
  ) {
    const reviews = expectRecord(
      obj.required_pull_request_reviews,
      "$.required_pull_request_reviews",
    );
    requiredApprovingReviewCount = expectCount(
      reviews.required_approving_review_count,
      "$.required_pull_request_reviews.required_approving_review_count",
    );
  }
  return {
    branch,
    protected: true,
    requiredStatusChecks,
    requiredApprovingReviewCount,
    requireBranchUpToDate,
    enforceAdmins,
  };
}

export function unprotectedProtection(
  branch: string,
): GitHubBranchProtectionsV1 {
  return {
    branch,
    protected: false,
    requiredStatusChecks: [],
    requiredApprovingReviewCount: 0,
    requireBranchUpToDate: false,
    enforceAdmins: false,
  };
}

// ---------------------------------------------------------------------------
// Git refs
// ---------------------------------------------------------------------------

export function parseRefWire(input: unknown, path: string): GitHubRefV1 {
  const obj = expectRecord(input, path);
  const ref = expectNonEmptyString(obj.ref, `${path}.ref`, MaxText.ref);
  const object = expectRecord(obj.object, `${path}.object`);
  const sha = expectWireSha(object.sha, `${path}.object.sha`);
  return { ref, sha };
}

// ---------------------------------------------------------------------------
// Reviews and review comments (review normalization evidence)
// ---------------------------------------------------------------------------

export type GitHubReviewStateWireV1 =
  | "approved"
  | "changes_requested"
  | "commented"
  | "dismissed"
  | "pending";

export interface GitHubReviewWireV1 {
  id: number;
  state: GitHubReviewStateWireV1;
  body: string | null;
  author: string | null;
  commitSha: GitSha | null;
  submittedAt: number | null;
}

export function parseReviewWire(
  input: unknown,
  path: string,
): GitHubReviewWireV1 {
  const obj = expectRecord(input, path);
  const id = expectPositiveInt(obj.id, `${path}.id`);
  const state = expectEnum(
    obj.state,
    ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"],
    `${path}.state`,
  ) as string;
  const body = expectNullableBoundedString(
    obj.body,
    `${path}.body`,
    MAX_WIRE_TEXT,
  );
  const author = expectLogin(obj.user, `${path}.user`);
  const commitSha = obj.commit_id === null
    ? null
    : expectWireSha(obj.commit_id, `${path}.commit_id`);
  const submittedAt = obj.submitted_at === null
    ? null
    : expectIsoTimestamp(obj.submitted_at, `${path}.submitted_at`);
  return {
    id,
    state: state.toLowerCase() as GitHubReviewStateWireV1,
    body,
    author,
    commitSha,
    submittedAt,
  };
}

export interface GitHubReviewCommentWireV1 {
  id: number;
  reviewId: number | null;
  path: string | null;
  body: string;
  author: string | null;
  commitSha: GitSha | null;
  createdAt: number;
}

export function parseReviewCommentWire(
  input: unknown,
  path: string,
): GitHubReviewCommentWireV1 {
  const obj = expectRecord(input, path);
  const id = expectPositiveInt(obj.id, `${path}.id`);
  const reviewId = obj.pull_request_review_id === null ||
      obj.pull_request_review_id === undefined
    ? null
    : expectPositiveInt(
      obj.pull_request_review_id,
      `${path}.pull_request_review_id`,
    );
  const filePath = obj.path === null
    ? null
    : expectNonEmptyString(obj.path, `${path}.path`, MaxText.path);
  const body = expectBoundedNonEmpty(obj.body, `${path}.body`, MAX_WIRE_TEXT);
  const author = expectLogin(obj.user, `${path}.user`);
  const commitSha = obj.commit_id === null
    ? null
    : expectWireSha(obj.commit_id, `${path}.commit_id`);
  const createdAt = expectIsoTimestamp(obj.created_at, `${path}.created_at`);
  return {
    id,
    reviewId,
    path: filePath,
    body,
    author,
    commitSha,
    createdAt,
  };
}

function expectNullableBoundedString(
  value: unknown,
  path: string,
  max: number,
): string | null {
  if (value === null) return null;
  return expectString(value, path, max);
}

function expectBoundedNonEmpty(
  value: unknown,
  path: string,
  max: number,
): string {
  return expectNonEmptyString(value, path, max);
}

// ---------------------------------------------------------------------------
// Merge response
// ---------------------------------------------------------------------------

export interface MergeResponseWireV1 {
  status: "merged";
  mergeSha: GitSha;
}

export function parseMergeResponseWire(
  input: unknown,
  path: string,
): MergeResponseWireV1 {
  const obj = expectRecord(input, path);
  const merged = expectBoolean(obj.merged, `${path}.merged`);
  if (merged !== true) {
    fail(path, "invalid_lifecycle", "merge response did not confirm a merge");
  }
  const mergeSha = expectWireSha(obj.sha, `${path}.sha`);
  return { status: "merged", mergeSha };
}

// ---------------------------------------------------------------------------
// Repository rules and rulesets (effective-protection authority)
// ---------------------------------------------------------------------------
// Shapes per the official GitHub OpenAPI:
//   GET /repos/{owner}/{repo}/rules/branches/{branch}    -> repository-rule-detailed[]
//   GET /repos/{owner}/{repo}/rulesets?includes_parents  -> repository-ruleset[]
//   GET /repos/{owner}/{repo}/rulesets/{ruleset_id}      -> repository-ruleset
// The rule `type` drives enforcement; unknown types are retained (never
// rejected) so the merge gate can fail closed on unsupported active rules.

export const BRANCH_RULE_TYPES = [
  "creation",
  "update",
  "deletion",
  "required_linear_history",
  "merge_queue",
  "required_deployments",
  "required_signatures",
  "pull_request",
  "required_status_checks",
  "non_fast_forward",
  "commit_message_pattern",
  "commit_author_email_pattern",
  "committer_email_pattern",
  "branch_name_pattern",
  "tag_name_pattern",
  "required_workflows",
  "code_scanning",
  "copilot_code_review",
  "license_compliance_scanning",
  "file_path_restriction",
  "max_file_path_length",
  "file_extension_restriction",
  "max_file_size",
] as const;

export interface GitHubBranchRuleWireV1 {
  id: number | null;
  type: string;
  name: string | null;
  rulesetSourceType: "Repository" | "Organization" | null;
  rulesetSource: string | null;
  rulesetId: number | null;
  parameters: Record<string, unknown> | null;
}

export function parseBranchRuleWire(
  input: unknown,
  path: string,
): GitHubBranchRuleWireV1 {
  const obj = expectRecord(input, path);
  const id = obj.id === null || obj.id === undefined
    ? null
    : expectPositiveInt(obj.id, `${path}.id`);
  const type = expectNonEmptyString(obj.type, `${path}.type`, MaxText.label);
  const name = obj.name === null || obj.name === undefined
    ? null
    : expectNonEmptyString(obj.name, `${path}.name`, MaxText.label);
  const rulesetSourceType = obj.ruleset_source_type === null ||
      obj.ruleset_source_type === undefined
    ? null
    : expectEnum(
      obj.ruleset_source_type,
      ["Repository", "Organization"],
      `${path}.ruleset_source_type`,
    );
  const rulesetSource = obj.ruleset_source === null ||
      obj.ruleset_source === undefined
    ? null
    : expectNonEmptyString(
      obj.ruleset_source,
      `${path}.ruleset_source`,
      MaxText.label,
    );
  const rulesetId = obj.ruleset_id === null || obj.ruleset_id === undefined
    ? null
    : expectPositiveInt(obj.ruleset_id, `${path}.ruleset_id`);
  const parameters = obj.parameters === null || obj.parameters === undefined
    ? null
    : expectRecord(obj.parameters, `${path}.parameters`);
  return {
    id,
    type,
    name,
    rulesetSourceType,
    rulesetSource,
    rulesetId,
    parameters,
  };
}

export type GitHubBypassActorWireV1 = {
  actorType:
    | "Integration"
    | "OrganizationAdmin"
    | "RepositoryRole"
    | "Team"
    | "DeployKey"
    | "User";
  actorId: number | null;
  bypassMode: "always" | "pull_request" | "exempt";
};

export type GitHubCurrentUserBypassV1 =
  | "always"
  | "pull_requests_only"
  | "never"
  | "exempt";

export interface GitHubRuleSetWireV1 {
  id: number;
  name: string;
  target: "branch" | "tag" | "push" | "repository" | null;
  sourceType: "Repository" | "Organization" | "Enterprise" | null;
  source: string | null;
  enforcement: "active" | "evaluate" | "disabled";
  /**
   * `null` when the API omitted it — the caller (our App installation token)
   * may lack write access to the ruleset. Omitted bypass policy is unknown
   * and blocks; never treated as "no bypass actors".
   */
  bypassActors: GitHubBypassActorWireV1[] | null;
  /** `null` when the API omitted it (unknown whether the caller can bypass). */
  currentUserCanBypass: GitHubCurrentUserBypassV1 | null;
  /** Rule list when the response carried it; `null` when details are needed. */
  rules: GitHubBranchRuleWireV1[] | null;
}

export function parseRuleSetWire(
  input: unknown,
  path: string,
): GitHubRuleSetWireV1 {
  const obj = expectRecord(input, path);
  const id = expectPositiveInt(obj.id, `${path}.id`);
  const name = expectNonEmptyString(obj.name, `${path}.name`, MaxText.label);
  const target = obj.target === null || obj.target === undefined
    ? null
    : expectEnum(
      obj.target,
      ["branch", "tag", "push", "repository"],
      `${path}.target`,
    );
  const sourceType = obj.source_type === null || obj.source_type === undefined
    ? null
    : expectEnum(
      obj.source_type,
      ["Repository", "Organization", "Enterprise"],
      `${path}.source_type`,
    );
  const source = obj.source === null || obj.source === undefined
    ? null
    : expectNonEmptyString(obj.source, `${path}.source`, MaxText.label);
  const enforcement = expectEnum(
    obj.enforcement,
    ["active", "evaluate", "disabled"],
    `${path}.enforcement`,
  );
  const bypassActors = obj.bypass_actors === null ||
      obj.bypass_actors === undefined
    ? null
    : expectExistingArray(obj.bypass_actors, `${path}.bypass_actors`).map(
      (actor, index) =>
        parseBypassActorWire(actor, `${path}.bypass_actors[${index}]`),
    );
  const currentUserCanBypass = obj.current_user_can_bypass === null ||
      obj.current_user_can_bypass === undefined
    ? null
    : expectEnum(
      obj.current_user_can_bypass,
      ["always", "pull_requests_only", "never", "exempt"],
      `${path}.current_user_can_bypass`,
    );
  const rules = obj.rules === null || obj.rules === undefined
    ? null
    : expectExistingArray(obj.rules, `${path}.rules`).map(
      (rule, index) => parseBranchRuleWire(rule, `${path}.rules[${index}]`),
    );
  return {
    id,
    name,
    target,
    sourceType,
    source,
    enforcement,
    bypassActors,
    currentUserCanBypass,
    rules,
  };
}

function parseBypassActorWire(
  input: unknown,
  path: string,
): GitHubBypassActorWireV1 {
  const obj = expectRecord(input, path);
  const actorId = obj.actor_id === null || obj.actor_id === undefined
    ? null
    : expectPositiveInt(obj.actor_id, `${path}.actor_id`);
  return {
    actorType: expectEnum(
      obj.actor_type,
      [
        "Integration",
        "OrganizationAdmin",
        "RepositoryRole",
        "Team",
        "DeployKey",
        "User",
      ],
      `${path}.actor_type`,
    ),
    actorId,
    bypassMode: obj.bypass_mode === null || obj.bypass_mode === undefined
      ? "always"
      : expectEnum(
        obj.bypass_mode,
        ["always", "pull_request", "exempt"],
        `${path}.bypass_mode`,
      ),
  };
}

/** Required status-check rule parameters (exact binding for merge checks). */
export function parseRequiredStatusRule(input: unknown): {
  strict: boolean;
  checkNames: string[];
} {
  const parameters = requiredParameters(input, "required_status_checks");
  const strict = expectBoolean(
    parameters.strict_required_status_checks_policy,
    "$.parameters.strict_required_status_checks_policy",
  );
  const checks = expectExistingArray(
    parameters.required_status_checks,
    "$.parameters.required_status_checks",
  ).map((entry) =>
    expectNonEmptyString(
      expectRecord(entry, "$.parameters.required_status_checks").context,
      "$.parameters.required_status_checks.context",
      MaxText.label,
    )
  );
  return { strict, checkNames: checks };
}

/** pull_request rule parameters (required approvals; thread resolution). */
export function parsePullRequestRule(input: unknown): {
  requiredApprovingReviewCount: number;
  requiredReviewThreadResolution: boolean;
} {
  const parameters = requiredParameters(input, "pull_request");
  const requiredApprovingReviewCount = expectCount(
    parameters.required_approving_review_count,
    "$.parameters.required_approving_review_count",
  );
  const requiredReviewThreadResolution = expectBoolean(
    parameters.required_review_thread_resolution,
    "$.parameters.required_review_thread_resolution",
  );
  return { requiredApprovingReviewCount, requiredReviewThreadResolution };
}

function requiredParameters(
  input: unknown,
  ruleType: string,
): Record<string, unknown> {
  const rule = expectRecord(input, "$");
  const parameters = rule.parameters ?? null;
  if (parameters === null) {
    fail(
      "$.parameters",
      "invalid_value",
      `${ruleType} rule parameters are missing`,
    );
  }
  return expectRecord(parameters, "$.parameters");
}
