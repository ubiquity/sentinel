/**
 * ReviewReceiptV1: strict normalized evidence of one Codex review request.
 * Completion is never inferred from silence or reactions — the receipt only
 * records a machine-verifiable completed outcome; anything else is pending or
 * unavailable. The receipt binds the exact PR head and observed base.
 */

import { asFindingFingerprint } from "./brands.ts";
import type { FindingFingerprint, GitSha } from "./brands.ts";
import { canonicalStringifySha256 } from "./canonical.ts";
import {
  parseRepositoryIdentity,
  parseSeverity,
  SEVERITIES,
} from "./shared.ts";
import type { RepositoryIdentityV1, SeverityV1 } from "./shared.ts";
import {
  expectArray,
  expectBoolean,
  expectCount,
  expectEnum,
  expectExactKeys,
  expectExactKeysWithOptional,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectNullableString,
  expectPattern,
  expectPositiveInt,
  expectRecord,
  expectSha256Hex,
  expectString,
  expectTimestamp,
  expectVersion,
  fail,
  MaxItems,
  MaxText,
} from "./validation.ts";

export type ReviewStatusV1 = "completed" | "pending" | "unavailable";

/**
 * Bounded exact task statement an independent review is judged against: the
 * live source issue the candidate must fulfill. The digest is a canonical
 * SHA-256 over `{issueNumber, title, body}` and binds the review acceptance to
 * this exact text; it never carries credentials or host paths.
 */
export interface ReviewTaskStatementV1 {
  issueNumber: number;
  title: string;
  body: string;
  /** Canonical SHA-256 over `{issueNumber, title, body}`. */
  digest: string;
}

/** Canonical digest binding one exact task statement. */
export function reviewTaskStatementDigest(
  task: { issueNumber: number; title: string; body: string },
): Promise<string> {
  return canonicalStringifySha256({
    issueNumber: task.issueNumber,
    title: task.title,
    body: task.body,
  });
}

/** One source-issue task title bound (chars). */
export const MAX_REVIEW_TASK_TITLE = MaxText.message;
/** One source-issue task body bound (chars). */
export const MAX_REVIEW_TASK_BODY = MaxText.body;
/** Static sanitized refusal of a malformed/over-bound task statement. */
export const REVIEW_TASK_SHAPE_DETAIL =
  "review task statement is malformed or over bound";
/** Static sanitized refusal of a task statement whose digest does not bind it. */
export const REVIEW_TASK_DIGEST_DETAIL =
  "review task statement digest does not bind its text";

export type ReviewTaskStatementCheckV1 =
  | { ok: true; statement: ReviewTaskStatementV1 }
  | { ok: false; detail: string };

/** True only for text without NUL/other C0 controls (tab and LF allowed). */
function isBoundedTaskText(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string" || value.length > maxLength) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x09 || code === 0x0a) continue;
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/**
 * Strict bounded check of one submitted task statement, including the digest
 * binding: the caller-supplied digest must equal the canonical digest of the
 * exact text, so a receipt can never be bound to a digest that does not
 * describe the task the reviewer was shown.
 */
export async function checkReviewTaskStatement(
  input: unknown,
): Promise<ReviewTaskStatementCheckV1> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, detail: REVIEW_TASK_SHAPE_DETAIL };
  }
  const record = input as Record<string, unknown>;
  const issueNumber = record.issueNumber;
  if (
    typeof issueNumber !== "number" || !Number.isSafeInteger(issueNumber) ||
    issueNumber < 1
  ) {
    return { ok: false, detail: REVIEW_TASK_SHAPE_DETAIL };
  }
  const title = record.title;
  if (
    !isBoundedTaskText(title, MAX_REVIEW_TASK_TITLE) || title.length === 0
  ) {
    return { ok: false, detail: REVIEW_TASK_SHAPE_DETAIL };
  }
  const body = record.body;
  if (!isBoundedTaskText(body, MAX_REVIEW_TASK_BODY)) {
    return { ok: false, detail: REVIEW_TASK_SHAPE_DETAIL };
  }
  const digest = record.digest;
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
    return { ok: false, detail: REVIEW_TASK_SHAPE_DETAIL };
  }
  const expected = await reviewTaskStatementDigest({
    issueNumber,
    title,
    body,
  });
  if (expected !== digest) {
    return { ok: false, detail: REVIEW_TASK_DIGEST_DETAIL };
  }
  return { ok: true, statement: { issueNumber, title, body, digest } };
}

/**
 * Static, sanitized semantic-refusal details shared by every authorization
 * surface (repair merge gate, GitHub adapter, hosted copies). Each one is a
 * terminal no-delivery disposition: the candidate is never merged, released or
 * closed as a new repair, and no task or model text is ever echoed.
 */
export const TASK_ACCEPTANCE_MISSING_DETAIL =
  "task acceptance missing: a change-only review cannot authorize delivery";
export const TASK_ACCEPTANCE_MISMATCH_DETAIL =
  "task acceptance is bound to a different source issue";
export const TASK_ACCEPTANCE_DIGEST_DETAIL =
  "task acceptance is not bound to the current source-issue text";
export const TASK_ACCEPTANCE_CONTEXT_DETAIL =
  "source issue task context is unavailable";
export const TASK_ACCEPTANCE_UNBOUND_DETAIL =
  "task acceptance present for work without a source issue";
export const TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL =
  "task already satisfied at base: no new repair is delivered";
export const TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL =
  "task acceptance not fulfilled: the candidate does not satisfy the source issue";
export const TASK_ACCEPTANCE_UNCERTAIN_DETAIL =
  "task acceptance uncertain: insufficient evidence for the source issue";

/**
 * The one semantic acceptance predicate shared by every authorization surface.
 *
 * `task` is the TRUSTED statement independently read from the live source
 * issue at authorization time (never the model's echoed digest and never
 * equality between two copied receipts), or the literal `"unavailable"` when
 * that context could not be read or bounded. Returns null only for a positive,
 * exactly bound `fulfilled` acceptance of the record's own issue; every other
 * combination is a static refusal. Work without a source issue accepts only a
 * matching absence (no invented acceptance), so incident work keeps its
 * existing change-only contract.
 */
export function reviewTaskAcceptanceRefusal(input: {
  /** The record's own source issue number, or null for incident work. */
  issueNumber: number | null;
  /** Trusted live task statement, or "unavailable" when it cannot be read. */
  task: ReviewTaskStatementV1 | null | "unavailable";
  /** The acceptance carried by the durable review receipt, or null. */
  acceptance: ReviewTaskAcceptanceV1 | null;
}): string | null {
  const { issueNumber, task, acceptance } = input;
  if (issueNumber === null) {
    return task === null && acceptance === null
      ? null
      : TASK_ACCEPTANCE_UNBOUND_DETAIL;
  }
  if (task === "unavailable" || task === null) {
    return TASK_ACCEPTANCE_CONTEXT_DETAIL;
  }
  if (task.issueNumber !== issueNumber) {
    return TASK_ACCEPTANCE_CONTEXT_DETAIL;
  }
  if (acceptance === null) return TASK_ACCEPTANCE_MISSING_DETAIL;
  if (acceptance.issueNumber !== issueNumber) {
    return TASK_ACCEPTANCE_MISMATCH_DETAIL;
  }
  // The acceptance must bind the EXACT live source-issue text, not merely a
  // digest the reviewer copied: a same-issue/same-head receipt judged against
  // changed issue text is a different task and never authorizes this delivery.
  if (acceptance.taskDigest !== task.digest) {
    return TASK_ACCEPTANCE_DIGEST_DETAIL;
  }
  switch (acceptance.verdict) {
    case "fulfilled":
      return null;
    case "already_satisfied_at_base":
      return TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL;
    case "not_fulfilled":
      return TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL;
    case "uncertain":
      return TASK_ACCEPTANCE_UNCERTAIN_DETAIL;
  }
}

/**
 * The reviewer's positive verdict on the ORIGINAL issue acceptance. A
 * code-quality-only pass is not a task verdict: a change-only review carries
 * no acceptance at all and can never authorize delivery.
 */
export type TaskAcceptanceVerdictV1 =
  | "fulfilled"
  | "not_fulfilled"
  | "already_satisfied_at_base"
  | "uncertain";

/** One finite evidence item bound (chars). */
export const MAX_TASK_ACCEPTANCE_EVIDENCE_CHARS = 1024;
/** Finite acceptance evidence count. */
export const MAX_TASK_ACCEPTANCE_EVIDENCE = 4;

/**
 * Reviewer-generated task acceptance bound to the exact reviewed task. The
 * verdict is the reviewer's own semantic judgment; the identity fields bind it
 * to the one task statement that was submitted with this exact review.
 */
export interface ReviewTaskAcceptanceV1 {
  /** Source issue number the judgment is about. */
  issueNumber: number;
  /** Digest of the exact task statement the reviewer judged. */
  taskDigest: string;
  verdict: TaskAcceptanceVerdictV1;
  /** Concrete acceptance evidence; empty only for `uncertain`. */
  evidence: string[];
}

/** Strict bounded parse of one task acceptance carried by a review. */
export function parseReviewTaskAcceptance(
  input: unknown,
  path: string,
): ReviewTaskAcceptanceV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(
    obj,
    ["issueNumber", "taskDigest", "verdict", "evidence"],
    path,
  );
  const issueNumber = expectPositiveInt(obj.issueNumber, `${path}.issueNumber`);
  const taskDigest = expectSha256Hex(obj.taskDigest, `${path}.taskDigest`);
  const verdict = expectEnum(
    obj.verdict,
    ["fulfilled", "not_fulfilled", "already_satisfied_at_base", "uncertain"],
    `${path}.verdict`,
  );
  const evidence = expectArray(
    obj.evidence,
    `${path}.evidence`,
    MAX_TASK_ACCEPTANCE_EVIDENCE,
    (item, itemPath) =>
      expectNonEmptyString(
        item,
        itemPath,
        MAX_TASK_ACCEPTANCE_EVIDENCE_CHARS,
      ),
  );
  // A non-uncertain verdict claims a concrete judgment; an empty evidence list
  // would make that claim unverifiable, so it is refused.
  if (verdict !== "uncertain" && evidence.length === 0) {
    fail(
      `${path}.evidence`,
      "invalid_lifecycle",
      "a definitive task acceptance requires at least one evidence item",
    );
  }
  return { issueNumber, taskDigest, verdict, evidence };
}

/**
 * Authorizing evidence for marking a finding resolved. An agent-set
 * `resolved: true` alone never removes a P0/P1; only a trusted human dispute
 * or a changed reviewed head can do so, recorded here with the authorizing
 * identity and a machine-verifiable reference.
 */
export interface FindingResolutionEvidenceV1 {
  authorizingIdentity: string;
  reference: string;
}

export interface ReviewFindingV1 {
  id: string;
  severity: SeverityV1;
  path: string | null;
  message: string;
  /** SHA-256 over the canonical form of this finding (id/severity/path/message). */
  fingerprint: FindingFingerprint;
  resolved: boolean;
  /** Required exactly when resolved; never present on an unresolved finding. */
  resolutionEvidence: FindingResolutionEvidenceV1 | null;
}

export interface ReviewReceiptV1 {
  version: "v1";
  kind: "review_receipt";
  id: string;
  requestId: string;
  expectedReviewer: string;
  /** Reviewer identity actually observed; must match when completed. */
  observedReviewer: string | null;
  repository: RepositoryIdentityV1;
  pullRequest: { number: number; head: GitSha; base: GitSha };
  outcome: ReviewStatusV1;
  resultId: string | null;
  summary: string | null;
  /** Full original findings, never trimmed after the fact. */
  findings: ReviewFindingV1[];
  /** Findings that could not be retained (bounded cap); completeness is never claimed. */
  findingsUncounted: number;
  /** Distinct unresolved severities, derived from unresolved findings. */
  unresolvedSeverities: SeverityV1[];
  /**
   * Positive task acceptance evidence, or null. Legacy/change-only receipts
   * carry null and can never authorize an issue-backed delivery.
   */
  taskAcceptance: ReviewTaskAcceptanceV1 | null;
  submittedAt: number;
  completedAt: number | null;
  observedAt: number;
}

const KEYS = [
  "version",
  "kind",
  "id",
  "requestId",
  "expectedReviewer",
  "observedReviewer",
  "repository",
  "pullRequest",
  "outcome",
  "resultId",
  "summary",
  "findings",
  "findingsUncounted",
  "unresolvedSeverities",
  "submittedAt",
  "completedAt",
  "observedAt",
] as const;
/**
 * Additive optional key: a receipt written before the semantic acceptance
 * boundary existed parses with `taskAcceptance: null`, which the merge gate
 * refuses for issue-backed work. The key is never silently defaulted to a
 * passing acceptance.
 */
const OPTIONAL_KEYS = ["taskAcceptance"] as const;
const PULL_REQUEST_KEYS = ["number", "head", "base"] as const;
const FINDING_KEYS = [
  "id",
  "severity",
  "path",
  "message",
  "fingerprint",
  "resolved",
  "resolutionEvidence",
] as const;
const RESOLUTION_KEYS = ["authorizingIdentity", "reference"] as const;

export function parseReviewReceiptV1(input: unknown): ReviewReceiptV1 {
  const obj = expectRecord(input, "$");
  expectExactKeysWithOptional(obj, KEYS, OPTIONAL_KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, ["review_receipt"], "$.kind");

  const id = expectNonEmptyString(obj.id, "$.id", MaxText.recordId);
  const requestId = expectNonEmptyString(
    obj.requestId,
    "$.requestId",
    MaxText.recordId,
  );
  const expectedReviewer = expectPattern(
    obj.expectedReviewer,
    "$.expectedReviewer",
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}(?:\[bot\])?$/,
    "invalid_pattern",
    "expected reviewer identity",
    MaxText.label,
  );
  const observedReviewer = expectNullable(
    obj.observedReviewer,
    "$.observedReviewer",
    (v, p) =>
      expectPattern(
        v,
        p,
        /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}(?:\[bot\])?$/,
        "invalid_pattern",
        "expected reviewer identity",
        MaxText.label,
      ),
  );
  const repository = parseRepositoryIdentity(obj.repository, "$.repository");

  const prObj = expectRecord(obj.pullRequest, "$.pullRequest");
  expectExactKeys(prObj, PULL_REQUEST_KEYS, "$.pullRequest");
  const pullRequest = {
    number: expectPositiveInt(prObj.number, "$.pullRequest.number"),
    head: expectGitSha(prObj.head, "$.pullRequest.head"),
    base: expectGitSha(prObj.base, "$.pullRequest.base"),
  };

  const outcome = expectEnum(
    obj.outcome,
    ["completed", "pending", "unavailable"],
    "$.outcome",
  );
  const resultId = expectNullableString(
    obj.resultId,
    "$.resultId",
    MaxText.recordId,
  );
  const summary = expectNullableString(
    obj.summary,
    "$.summary",
    MaxText.summary,
  );
  const findings = expectArray(
    obj.findings,
    "$.findings",
    MaxItems.findings,
    parseFinding,
  );
  const findingsUncounted = expectCount(
    obj.findingsUncounted,
    "$.findingsUncounted",
  );

  const unresolvedSeverities = parseUnresolvedSeverities(
    obj.unresolvedSeverities,
    "$.unresolvedSeverities",
  );
  // An absent key (a receipt written before this boundary) parses as null;
  // every other value must be the strict bounded acceptance.
  const taskAcceptance = obj.taskAcceptance === undefined
    ? null
    : expectNullable(
      obj.taskAcceptance,
      "$.taskAcceptance",
      parseReviewTaskAcceptance,
    );

  const submittedAt = expectTimestamp(obj.submittedAt, "$.submittedAt");
  const completedAt = expectNullable(
    obj.completedAt,
    "$.completedAt",
    expectTimestamp,
  );
  const observedAt = expectTimestamp(obj.observedAt, "$.observedAt");

  // Fail-closed: completion requires machine-verifiable identity and time proof.
  if (outcome === "completed") {
    if (resultId === null) {
      fail(
        "$.resultId",
        "invalid_lifecycle",
        "completed review requires a result id",
      );
    }
    if (completedAt === null) {
      fail(
        "$.completedAt",
        "invalid_lifecycle",
        "completed review requires a completion time",
      );
    }
    if (completedAt < submittedAt) {
      fail(
        "$.completedAt",
        "invalid_lifecycle",
        "completion cannot precede submission",
      );
    }
    if (observedAt < completedAt) {
      fail(
        "$.observedAt",
        "invalid_lifecycle",
        "observation cannot precede completion",
      );
    }
    // The actual reviewer identity must bind to the expected one; a completed
    // review by another identity is a mismatch, not acceptance evidence.
    if (observedReviewer !== expectedReviewer) {
      fail(
        "$.observedReviewer",
        "invalid_lifecycle",
        "completed review requires the observed reviewer to match the expected reviewer",
      );
    }
  } else {
    if (completedAt !== null) {
      fail(
        "$.completedAt",
        "invalid_lifecycle",
        "non-completed review cannot record completion",
      );
    }
    // Only a completed review can carry a task verdict; a pending/unavailable
    // receipt claiming acceptance would be completion evidence without a
    // completed review.
    if (taskAcceptance !== null) {
      fail(
        "$.taskAcceptance",
        "invalid_lifecycle",
        "non-completed review cannot carry a task acceptance",
      );
    }
    if (outcome === "unavailable" && resultId !== null) {
      fail(
        "$.resultId",
        "invalid_lifecycle",
        "unavailable review has no result id",
      );
    }
    if (observedReviewer !== null) {
      fail(
        "$.observedReviewer",
        "invalid_lifecycle",
        "non-completed review has no observed reviewer",
      );
    }
  }

  const derived = deriveUnresolvedSeverities(findings);
  if (JSON.stringify(derived) !== JSON.stringify(unresolvedSeverities)) {
    fail(
      "$.unresolvedSeverities",
      "invalid_lifecycle",
      `unresolved severities must be derived from findings (expected ${
        JSON.stringify(derived)
      })`,
    );
  }
  // Truncated findings mean completeness is unknown; an empty unresolved list
  // would claim clean review evidence that was never fully observed.
  if (findingsUncounted > 0 && unresolvedSeverities.length === 0) {
    fail(
      "$.unresolvedSeverities",
      "invalid_lifecycle",
      "cannot claim no unresolved findings while findings were uncounted",
    );
  }

  return {
    version: "v1",
    kind: "review_receipt",
    id,
    requestId,
    expectedReviewer,
    observedReviewer,
    repository,
    pullRequest,
    outcome,
    resultId,
    summary,
    findings,
    findingsUncounted,
    unresolvedSeverities,
    taskAcceptance,
    submittedAt,
    completedAt,
    observedAt,
  };
}

function parseFinding(input: unknown, path: string): ReviewFindingV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, FINDING_KEYS, path);
  const id = expectNonEmptyString(obj.id, `${path}.id`, MaxText.recordId);
  const severity = parseSeverity(obj.severity, `${path}.severity`);
  const findingPath = expectNullableString(
    obj.path,
    `${path}.path`,
    MaxText.path,
  );
  const message = expectString(obj.message, `${path}.message`, MaxText.context);
  const fingerprint = asFindingFingerprint(
    expectSha256Hex(obj.fingerprint, `${path}.fingerprint`),
  );
  const resolved = expectBoolean(obj.resolved, `${path}.resolved`);
  const resolutionEvidence = expectNullable(
    obj.resolutionEvidence,
    `${path}.resolutionEvidence`,
    parseResolutionEvidence,
  );
  if (resolved && resolutionEvidence === null) {
    fail(
      `${path}.resolutionEvidence`,
      "invalid_lifecycle",
      "resolved finding requires authorizing resolution evidence",
    );
  }
  if (!resolved && resolutionEvidence !== null) {
    fail(
      `${path}.resolutionEvidence`,
      "invalid_lifecycle",
      "unresolved finding cannot carry resolution evidence",
    );
  }
  return {
    id,
    severity,
    path: findingPath,
    message,
    fingerprint,
    resolved,
    resolutionEvidence,
  };
}

function parseResolutionEvidence(
  input: unknown,
  path: string,
): FindingResolutionEvidenceV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, RESOLUTION_KEYS, path);
  return {
    authorizingIdentity: expectPattern(
      obj.authorizingIdentity,
      `${path}.authorizingIdentity`,
      /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}(?:\[bot\])?$/,
      "invalid_pattern",
      "expected authorizing identity",
      MaxText.label,
    ),
    reference: expectNonEmptyString(
      obj.reference,
      `${path}.reference`,
      MaxText.ref,
    ),
  };
}

/** Severity order used for the derived unresolved list. */
const SEVERITY_ORDER: Record<SeverityV1, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

export function deriveUnresolvedSeverities(
  findings: ReviewFindingV1[],
): SeverityV1[] {
  const set = new Set<SeverityV1>();
  for (const finding of findings) {
    if (!finding.resolved) set.add(finding.severity);
  }
  return SEVERITIES.filter((severity) => set.has(severity));
}

function parseUnresolvedSeverities(value: unknown, path: string): SeverityV1[] {
  return expectArray(value, path, 4, (item, itemPath) => {
    const severity = parseSeverity(item, itemPath);
    return severity;
  }).sort((a, b) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b]);
}
