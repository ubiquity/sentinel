/**
 * Review normalization: turns machine-verifiable review evidence into the
 * frozen `ReviewObservationV1` and, from that, a `ReviewReceiptV1`.
 *
 * Rules (fail closed, never manufacture):
 *
 * - A completed observation requires ALL of: service terminal turn succeeded
 *   with output present and a result id; the service's trusted receipt
 *   binding the exact repository/PR/head/base/reviewer/operation key and the
 *   exact GitHub review id; a GitHub review by the EXPECTED reviewer with
 *   exactly that review id on exactly that head; and a complete, fully parsed
 *   finding set. Anything less is `pending` or `unavailable` — nothing is
 *   inferred from silence, reactions, other bots (CodeRabbit), a bare
 *   COMMENTED/APPROVED, clean text without terminal provenance, missing
 *   findings, stale heads, wrong authors, wrong operation keys or wrong
 *   request/result ids.
 * - The authoritative GitHub review is the one with the exact id from the
 *   service receipt — never "latest by time". Any later review by the
 *   expected reviewer on the same head (any state) makes the recorded result
 *   non-authoritative and the observation unavailable.
 * - `observedBase` is ALWAYS the base recorded in the original service
 *   receipt, never the current PR base (which may have moved after review).
 * - Findings are parsed deterministically from GitHub review comments and
 *   review-body marker lines (`- [P1] ...`, `[P1] ...`, `P1: ...`,
 *   `P1 - ...`, `**P1** ...` forms, with optional markdown list/bold/quote
 *   prefixes) and preserve the FULL original message. A line or comment that
 *   carries a finding label but cannot be fully parsed (unsupported shape,
 *   missing message, image-badge form) makes the finding set incomplete:
 *   the observation is unavailable and the unknown count is preserved — a
 *   completed verdict with an empty finding set is never inferred.
 * - Text overflow beyond contract bounds is incomplete/unavailable, never
 *   silent truncation.
 * - The receipt is derived only from the observation plus the exact
 *   submission record (operation key, submittedAt, PR/head/base/reviewer) and
 *   is validated by the frozen `parseReviewReceiptV1` — the single authority.
 */

import { asFindingFingerprint } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringifySha256 } from "../contracts/canonical.ts";
import type {
  GitHubPullRequestV1,
  ReviewObservationRequestV1,
  ReviewObservationV1,
} from "../contracts/ports.ts";
import { portOk } from "../contracts/ports.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import {
  deriveUnresolvedSeverities,
  parseReviewReceiptV1,
} from "../contracts/review-receipt.ts";
import type {
  ReviewReceiptV1,
  ReviewStatusV1,
} from "../contracts/review-receipt.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { SeverityV1 } from "../contracts/shared.ts";
import { tryParse } from "../contracts/validation.ts";
import type { GitHubReviewCommentWireV1, GitHubReviewWireV1 } from "./wire.ts";
import { UNRESOLVED_REQUEST_ID } from "./review-service.ts";
import type { ReviewServiceReadV1 } from "./review-service.ts";

export const MAX_FINDING_MESSAGE = 8192;
/** Review body summary bound (a longer body is incomplete evidence). */
export const MAX_REVIEW_BODY = 4096;

export interface ParsedFindingV1 {
  id: string;
  severity: SeverityV1;
  path: string | null;
  message: string;
}

export interface ReviewNormalizationV1 {
  status: ReviewStatusV1;
  requestId: string;
  reviewer: string | null;
  resultId: string | null;
  completedAt: number | null;
  observedHead: GitSha | null;
  observedBase: GitSha | null;
  summary: string | null;
  findings: ParsedFindingV1[];
  /** Findings that carried a label but could not be fully retained. */
  findingsUncounted: number;
}

export interface ReviewNormalizationInputV1 {
  request: ReviewObservationRequestV1;
  service: ReviewServiceReadV1;
  /** The port's own exact repository (never supplied by the caller). */
  repository: RepositoryIdentityV1;
  /** The canonical operation key of the submission being observed (the port
   * derives it from its own trusted record; the caller's request key alone is
   * not authority). */
  expectedOperationKey: string;
  pullRequest: GitHubPullRequestV1 | null;
  reviews: GitHubReviewWireV1[];
  comments: GitHubReviewCommentWireV1[];
  expectedReviewer: string;
  findingCap: number;
  receivedAt: number;
}

// ---------------------------------------------------------------------------
// Severity label parsing (deterministic, strict forms only)
// ---------------------------------------------------------------------------

/**
 * Leading markdown prefix that a finding label may sit behind: list bullets
 * (`- | * | + `), numbered lists (`1. `) and blockquotes (`> `). The full
 * original text is preserved — the prefix is only skipped for label
 * detection, never removed from the finding message.
 */
const LEADING_PREFIX_RE = /^(?:\s*(?:[-*+]\s+|\d+\.\s+|>\s*))*/;

const SEVERITY_LABEL_RE =
  /^(?:\*\*)?(?:\[(P[0-3])\]|(P[0-3])(?::|\s+[.:-]?|\s*$|\*\*))/;

export function parseFindingSeverityLabel(
  text: string,
): { severity: SeverityV1; rest: string } | null {
  const prefixMatch = LEADING_PREFIX_RE.exec(text);
  const label = SEVERITY_LABEL_RE.exec(
    prefixMatch === null ? text : text.slice(prefixMatch[0].length),
  );
  if (label === null) return null;
  const severity = (label[1] ?? label[2]) as SeverityV1;
  const rest = text.slice(
    (prefixMatch === null ? 0 : prefixMatch[0].length) + label[0].length,
  ).trim();
  if (rest.length === 0) return null;
  return { severity, rest };
}

/**
 * A finding-style label that could NOT be fully parsed: the text starts
 * (after the same optional prefixes) with a `[P1 ...]`, `![P1 ...]` badge or
 * `P1`-style marker that the strict parser rejected. Such evidence must make
 * the finding set incomplete — the unknown count is preserved and no clean
 * verdict is inferred.
 */
export function hasUnparsedFindingMarker(text: string): boolean {
  const prefixMatch = LEADING_PREFIX_RE.exec(text);
  const body = prefixMatch === null ? text : text.slice(prefixMatch[0].length);
  return /^(?:\*\*)?(?:\[P[0-9]|!\[P[0-9]|P[0-9](?::|\s|$))/.test(body);
}

// ---------------------------------------------------------------------------
// Finding extraction
// ---------------------------------------------------------------------------

interface FindingItem {
  parsed: ParsedFindingV1 | null;
  /** True when the item structurally looks like it must have been a finding. */
  overBound: boolean;
  /** True when the item carries a finding label that could not be parsed. */
  unparsedMarker: boolean;
}

function commentFinding(
  comment: GitHubReviewCommentWireV1,
): FindingItem {
  const label = parseFindingSeverityLabel(comment.body);
  if (label === null) {
    return {
      parsed: null,
      overBound: false,
      unparsedMarker: hasUnparsedFindingMarker(comment.body),
    };
  }
  if (comment.body.length > MAX_FINDING_MESSAGE) {
    return { parsed: null, overBound: true, unparsedMarker: false };
  }
  return {
    parsed: {
      id: `github-comment-${comment.id}`,
      severity: label.severity,
      path: comment.path,
      // Full original message, prefixes and label included.
      message: comment.body,
    },
    overBound: false,
    unparsedMarker: false,
  };
}

function reviewBodyFinding(
  review: GitHubReviewWireV1,
  lineIndex: number,
  line: string,
): FindingItem {
  const label = parseFindingSeverityLabel(line);
  if (label === null) {
    return {
      parsed: null,
      overBound: false,
      unparsedMarker: hasUnparsedFindingMarker(line),
    };
  }
  return {
    parsed: {
      id: `github-review-${review.id}-line-${lineIndex}`,
      severity: label.severity,
      path: null,
      message: line,
    },
    overBound: false,
    unparsedMarker: false,
  };
}

export interface FindingExtractionV1 {
  complete: boolean;
  findings: ParsedFindingV1[];
  /** Label-bearing items that could not be fully retained. */
  uncounted: number;
}

/**
 * Full finding set from the reviewer's GitHub evidence on the exact head.
 * `complete` is false (and the observation must be unavailable) when any
 * item is over-bound, any item's finding label could not be fully parsed,
 * or the cap was exceeded — the uncounted count is preserved so the unknown
 * findings are never silently zeroed.
 */
function extractFindings(
  comments: GitHubReviewCommentWireV1[],
  author: string,
  head: GitSha,
  authoritative: GitHubReviewWireV1,
  cap: number,
): FindingExtractionV1 {
  const candidates: FindingItem[] = [];
  for (const comment of comments) {
    if (comment.author !== author || comment.commitSha !== head) continue;
    candidates.push(commentFinding(comment));
  }
  if (authoritative.body !== null) {
    const lines = authoritative.body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      candidates.push(reviewBodyFinding(authoritative, i, lines[i]));
    }
  }
  const findings: ParsedFindingV1[] = [];
  let uncounted = 0;
  for (const item of candidates) {
    if (item.overBound) {
      uncounted++;
      continue;
    }
    if (item.unparsedMarker) {
      uncounted++;
      continue;
    }
    if (item.parsed !== null) findings.push(item.parsed);
  }
  if (uncounted > 0) return { complete: false, findings, uncounted };
  if (findings.length > cap) {
    return {
      complete: false,
      findings: findings.slice(0, cap),
      uncounted: findings.length - cap,
    };
  }
  return { complete: true, findings, uncounted: 0 };
}

export function latestReview(
  reviews: GitHubReviewWireV1[],
): GitHubReviewWireV1 | null {
  let latest: GitHubReviewWireV1 | null = null;
  for (const review of reviews) {
    if (latest === null) {
      latest = review;
      continue;
    }
    if (isLaterReview(review, latest)) latest = review;
  }
  return latest;
}

function isLaterReview(
  candidate: GitHubReviewWireV1,
  current: GitHubReviewWireV1,
): boolean {
  const a = candidate.submittedAt ?? 0;
  const b = current.submittedAt ?? 0;
  return a > b || (a === b && candidate.id > current.id);
}

// ---------------------------------------------------------------------------
// Observation normalization
// ---------------------------------------------------------------------------

export async function normalizeReviewObservation(
  input: ReviewNormalizationInputV1,
): Promise<PortResultV1<ReviewObservationV1>> {
  const { request, service, pullRequest, expectedReviewer, findingCap } = input;
  const requestId = service.requestId ?? UNRESOLVED_REQUEST_ID;
  const observedHead = pullRequest?.head ?? null;
  // The reviewed base comes from the ORIGINAL service record — the current
  // PR base is never relabeled as the reviewed base.
  const reviewedBase = service.expectedBase;

  const unavailable = async (
    resultId: string | null,
    summary: string | null,
    findings: ParsedFindingV1[] = [],
  ): Promise<ReviewObservationV1> => ({
    status: "unavailable",
    requestId,
    reviewer: null,
    resultId,
    completedAt: null,
    observedHead,
    observedBase: reviewedBase,
    findings: await toReviewFindings(findings),
    summary,
    receivedAt: input.receivedAt,
  });

  // 1. The service receipt must bind the exact submission identity the port
  // observed: repository, PR, head, base, reviewer and operation key. A
  // missing or contradictory binding is unavailable, never a verdict.
  const binding = checkServiceBinding(input);
  if (!binding.ok) {
    return portOk(await unavailable(null, binding.reason));
  }

  if (service.status === "pending") {
    if (service.requestId === null) {
      // No request id means the request cannot be verified: fail closed.
      return portOk(await unavailable(null, null));
    }
    return portOk({
      status: "pending",
      requestId,
      reviewer: null,
      resultId: null,
      completedAt: null,
      observedHead,
      observedBase: reviewedBase,
      findings: [],
      summary: null,
      receivedAt: input.receivedAt,
    });
  }
  if (service.status === "unavailable") {
    return portOk(await unavailable(null, null));
  }

  // The service claims completion; verify every machine-verifiable part.
  const verifiableCompletion = service.requestId !== null &&
    service.resultId !== null &&
    service.completedAt !== null &&
    service.terminalTurnSucceeded === true &&
    service.outputPresent === true;
  if (!verifiableCompletion) {
    return portOk(await unavailable(null, service.summary));
  }
  if (service.completedAt! > input.receivedAt) {
    // A completion in the future is unverifiable under this clock.
    return portOk(await unavailable(null, service.summary));
  }
  if (pullRequest === null || pullRequest.head !== request.head) {
    // Stale head: the completed review cannot bind to the observed head.
    return portOk(await unavailable(service.resultId, service.summary));
  }

  const allByAuthorOnHead = input.reviews.filter(
    (review) =>
      review.author === expectedReviewer &&
      review.commitSha === pullRequest.head,
  );
  // 2. The authoritative review is the exact GitHub review id from the
  // service receipt — never "latest by time" on a different review.
  if (service.githubReviewId === null) {
    return portOk(await unavailable(service.resultId, service.summary));
  }
  const authoritative = allByAuthorOnHead.find(
    (review) => review.id === service.githubReviewId,
  );
  if (authoritative === undefined) {
    return portOk(await unavailable(service.resultId, service.summary));
  }
  // Any review by the same reviewer on the same head that is later than the
  // recorded result (any state, including dismissed/pending) makes the
  // result non-authoritative: the verdict is not standing.
  const latestAll = latestReview(allByAuthorOnHead);
  if (latestAll !== null && isLaterReview(latestAll, authoritative)) {
    return portOk(await unavailable(service.resultId, service.summary));
  }
  if (
    authoritative.state === "dismissed" || authoritative.state === "pending"
  ) {
    return portOk(await unavailable(service.resultId, service.summary));
  }
  if (authoritative.submittedAt === null) {
    // A review without a submission time is not completion evidence.
    return portOk(await unavailable(service.resultId, service.summary));
  }

  const extracted = extractFindings(
    input.comments,
    expectedReviewer,
    pullRequest.head,
    authoritative,
    findingCap,
  );
  if (!extracted.complete) {
    // Unsupported/over-bound/unparsed finding evidence: the unknown count is
    // preserved and no completed verdict is inferred (never empty-findings
    // clean).
    return portOk(
      await unavailable(
        service.resultId,
        service.summary,
        extracted.findings,
      ),
    );
  }
  if (
    authoritative.state === "changes_requested" &&
    extracted.findings.length === 0
  ) {
    // Changes were requested but the findings cannot be read from the
    // evidence: missing findings never yield a completed result.
    return portOk(await unavailable(service.resultId, service.summary));
  }
  if (
    authoritative.body !== null && authoritative.body.length > MAX_REVIEW_BODY
  ) {
    return portOk(await unavailable(service.resultId, service.summary));
  }

  return portOk({
    status: "completed",
    requestId,
    reviewer: expectedReviewer,
    resultId: service.resultId,
    completedAt: service.completedAt,
    observedHead,
    observedBase: reviewedBase,
    findings: await toReviewFindings(extracted.findings),
    summary: authoritative.body,
    receivedAt: input.receivedAt,
  });
}

/**
 * Exact service-receipt binding: the operation key, repository, PR number,
 * head, base and reviewer recorded by the trusted service must match the
 * port's own configuration and the caller's request exactly.
 */
function checkServiceBinding(input: ReviewNormalizationInputV1): {
  ok: boolean;
  reason: string | null;
} {
  const { service, request, repository, expectedOperationKey } = input;
  if (service.operationKey !== expectedOperationKey) {
    return { ok: false, reason: "operation key mismatch" };
  }
  if (
    service.repository === null ||
    service.repository.owner !== repository.owner ||
    service.repository.name !== repository.name
  ) {
    return { ok: false, reason: "repository binding mismatch" };
  }
  if (service.prNumber !== request.prNumber) {
    return { ok: false, reason: "pull request number mismatch" };
  }
  if (service.expectedHead !== request.head) {
    return { ok: false, reason: "head binding mismatch" };
  }
  if (service.expectedBase === null) {
    return { ok: false, reason: "base binding missing" };
  }
  if (service.expectedReviewer !== input.expectedReviewer) {
    return { ok: false, reason: "reviewer binding mismatch" };
  }
  return { ok: true, reason: null };
}

function toReviewFindings(
  findings: ParsedFindingV1[],
): Promise<ReviewObservationV1["findings"]> {
  return Promise.all(
    findings.map(async (finding) => {
      const fingerprint = asFindingFingerprint(
        await canonicalStringifySha256({
          id: finding.id,
          severity: finding.severity,
          path: finding.path,
          message: finding.message,
        }),
      );
      return {
        id: finding.id,
        severity: finding.severity,
        path: finding.path,
        message: finding.message,
        fingerprint,
        resolved: false,
        resolutionEvidence: null,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Receipt derivation
// ---------------------------------------------------------------------------

export interface ReviewSubmissionRecordV1 {
  operationKey: string;
  submittedAt: number;
  prNumber: number;
  expectedHead: GitSha;
  expectedBase: GitSha;
  expectedReviewer: string;
}

export function reviewRecordId(operationKey: string): string {
  return `review-${operationKey}`.slice(0, 256);
}

/** Map a derived receipt id back to the operation key it was derived from. */
export function operationKeyOfReceiptId(recordId: string): string {
  return recordId.startsWith("review-")
    ? recordId.slice("review-".length)
    : recordId;
}

/**
 * Derive the strict `ReviewReceiptV1` for an observation. The receipt is
 * validated by the frozen parser, which is the only authority on lifecycle
 * shape; an inconsistency (for example the service completion predating the
 * recorded submission, or an id mismatch) is a thrown parse error, never a
 * silent normalization. `unknownFindingsCount` carries the count of finding
 * evidence that could not be retained; the frozen parser rejects a receipt
 * that would claim clean zero findings while an unknown count exists, so an
 * observation with unknown findings but no retained findings can never be
 * derived into a receipt at all.
 */
export function deriveReviewReceiptV1(
  observation: ReviewObservationV1,
  submission: ReviewSubmissionRecordV1,
  repository: RepositoryIdentityV1,
  unknownFindingsCount = 0,
): ReviewReceiptV1 {
  const parsed = tryParse(parseReviewReceiptV1, {
    version: "v1",
    kind: "review_receipt",
    id: reviewRecordId(submission.operationKey),
    requestId: observation.requestId,
    expectedReviewer: submission.expectedReviewer,
    observedReviewer: observation.reviewer,
    repository,
    pullRequest: {
      number: submission.prNumber,
      head: submission.expectedHead,
      base: submission.expectedBase,
    },
    outcome: observation.status,
    resultId: observation.status === "completed" ? observation.resultId : null,
    summary: observation.summary,
    findings: observation.findings,
    findingsUncounted: unknownFindingsCount,
    unresolvedSeverities: deriveUnresolvedSeverities(observation.findings),
    submittedAt: submission.submittedAt,
    completedAt: observation.status === "completed"
      ? observation.completedAt
      : null,
    observedAt: observation.receivedAt,
  });
  if (!parsed.ok) {
    throw Object.assign(new Error("review receipt derivation failed"), {
      issues: parsed.issues,
    });
  }
  return parsed.value;
}

/** Compare a fresh completed normalization against a merge-request receipt. */
export function completedReviewMatchesReceipt(
  normalized: ReviewNormalizationV1,
  receipt: ReviewReceiptV1,
): boolean {
  if (normalized.status !== "completed") return false;
  if (normalized.requestId !== receipt.requestId) return false;
  if (normalized.resultId !== receipt.resultId) return false;
  if (normalized.completedAt !== receipt.completedAt) return false;
  if (normalized.reviewer !== receipt.observedReviewer) return false;
  if (normalized.observedHead !== receipt.pullRequest.head) return false;
  if (normalized.observedBase !== receipt.pullRequest.base) return false;
  const current = normalized.findings.map((finding) =>
    `${finding.id}\u0000${finding.severity}\u0000${
      finding.path ?? ""
    }\u0000${finding.message}`
  );
  const recorded = receipt.findings.map((finding) =>
    `${finding.id}\u0000${finding.severity}\u0000${
      finding.path ?? ""
    }\u0000${finding.message}`
  );
  return JSON.stringify(current) === JSON.stringify(recorded);
}
