/**
 * Strict structured review-result and review-journal codec.
 *
 * The review journal is the durable operation record kept in the body of an
 * authenticated pending GitHub review: a deterministic human-readable
 * rendering plus hidden canonical metadata. One renderer/parser pair owns the
 * format; consumers never fall back to prose-as-clean and never truncate.
 *
 * Fail-closed rules shared by every parser here:
 *
 * - The strict result is exactly `{verdict, summary, findings}` with the exact
 *   keys (unknown fields are rejected), finite bounded text, bounded finding
 *   count, exact priority range and valid line ranges. `clean` requires an
 *   empty finding list, `findings` requires a non-empty one and `unavailable`
 *   also requires an empty one — a result can never smuggle partially
 *   accepted findings.
 * - Every text field has a hard bound (summary 4096 chars, finding combined
 *   title+body+location message 8192 chars, path 512 chars); a contract-bound
 *   overflow is an `unavailable` disposition (issue code `bound_exceeded`),
 *   never a truncation and never a partial clean.
 * - Paths are relative: no absolute paths, no drive letters, no backslashes,
 *   no `.`/`..` segments and no control characters.
 * - The journal metadata is canonical JSON (via `canonicalStringify`) encoded
 *   in standard base64 and hidden in a fixed HTML comment. Because base64
 *   contains no `<`, `>` or `-` and the human rendering HTML-escapes `&`,
 *   `<` and `>` of the untrusted text, human body text can never terminate or
 *   forge the metadata region. The JSON text parser rejects duplicate object
 *   keys (never silently keeping a last value) while accepting any key order
 *   and whitespace.
 * - `parseReviewJournalBody` consumes the full expected body: byte-bound,
 *   strict metadata, result-digest verification over the canonical structured
 *   result and exact byte equality with re-rendering. Any added, ignored,
 *   altered or reordered text fails.
 * - All errors are static sanitized messages; no unknown body text, URL,
 *   header or token value is ever echoed.
 *
 * Phase shapes (common identity fields at the top level):
 * - intent: identity only (no review id, no execution).
 * - running: identity + positive reviewId + execution
 *   (ownerRunId/invocationId/threadId/submittedProvider/model/reasoning/
 *   startMayOccur=true; no turn id yet — a turn is never invented).
 * - ready: identity + positive reviewId + completedAt + result + resultDigest
 *   + execution, where execution is either null (only for verdict
 *   `unavailable`, so no runtime completion is ever fabricated) or the
 *   running fields plus turnId/resultId/actual request-runtime receipt.
 *   `clean`/`findings` require a non-null execution with runtime terminal
 *   origin, completed observed terminal status and matching IDs.
 */

import type { GitSha } from "../contracts/brands.ts";
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../contracts/canonical.ts";
import {
  expectArray,
  expectBoolean,
  expectCanonicalBase64,
  expectCount,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectPositiveInt,
  expectRecord,
  expectSha256Hex,
  expectString,
  expectTimestamp,
  fail,
  MaxItems,
  MaxText,
  RecordParseError,
} from "../contracts/validation.ts";

// ---------------------------------------------------------------------------
// Bounds and frozen runtime identity
// ---------------------------------------------------------------------------

/** Structured result summary bound (chars). */
export const MAX_RESULT_SUMMARY = MaxText.summary;
/** Individual finding title bound (chars; multiline titles are rejected). */
export const MAX_FINDING_TITLE = MaxText.message;
/** Individual finding body bound (chars; full multiline body preserved). */
export const MAX_FINDING_BODY = 8192;
/** Finding path bound (chars). */
export const MAX_FINDING_PATH = MaxText.path;
/** Combined normalized finding message (title + full body + location). */
export const MAX_FINDING_MESSAGE = 8192;
/** One finite maximum finding count (never greater than 256). */
export const MAX_FINDINGS = MaxItems.findings;
/** Full rendered journal bound in UTF-8 bytes; overflow is unavailable. */
export const MAX_JOURNAL_BYTES = 60_000;

/** Runtime implementation model (frozen; no fallback). */
export const REVIEW_MODEL = "gpt-reserve";
/** Runtime reasoning effort (frozen). */
export const REVIEW_REASONING = "max";

// ---------------------------------------------------------------------------
// Structured model result
// ---------------------------------------------------------------------------

export type ReviewVerdictV1 = "clean" | "findings" | "unavailable";
export type FindingPriorityV1 = 0 | 1 | 2 | 3;

export interface ReviewFindingV1 {
  priority: FindingPriorityV1;
  title: string;
  body: string;
  path: string;
  lineStart: number;
  lineEnd: number;
}

export interface ReviewResultV1 {
  verdict: ReviewVerdictV1;
  summary: string;
  findings: ReviewFindingV1[];
}

/** The exact output schema bound to the structured result parsers. */
export const REVIEW_RESULT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["clean", "findings", "unavailable"] },
    summary: { type: "string", minLength: 1, maxLength: MAX_RESULT_SUMMARY },
    findings: {
      type: "array",
      maxItems: MAX_FINDINGS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["priority", "title", "body", "path", "lineStart", "lineEnd"],
        properties: {
          priority: { type: "integer", enum: [0, 1, 2, 3] },
          title: { type: "string", minLength: 1, maxLength: MAX_FINDING_TITLE },
          body: { type: "string", maxLength: MAX_FINDING_BODY },
          path: { type: "string", minLength: 1, maxLength: MAX_FINDING_PATH },
          lineStart: { type: "integer", minimum: 1 },
          lineEnd: { type: "integer", minimum: 1 },
        },
      },
    },
  },
} as const;

const RESULT_KEYS = ["verdict", "summary", "findings"] as const;
const FINDING_KEYS = [
  "priority",
  "title",
  "body",
  "path",
  "lineStart",
  "lineEnd",
] as const;

/**
 * Narrow exact-key guard used at every journal/result boundary. The global
 * validator reflects an unknown key name into the issue path and therefore
 * into the error message; this local guard rejects unknown keys first with
 * the fixed schema path and a static message, so a hostile unknown key is
 * never echoed into diagnostics. Missing-field diagnosis is delegated to the
 * global validator unchanged.
 */
function expectJournalExactKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const known = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      fail(path, "unknown_key", "unknown key");
    }
  }
  expectExactKeys(obj, allowed, path);
}

/** Required location text of one finding (`path:lineStart-lineEnd`). */
export function findingLocation(finding: ReviewFindingV1): string {
  return `${finding.path}:${finding.lineStart}-${finding.lineEnd}`;
}

/** Complete normalized finding message (title + full body + location). */
export function findingMessage(finding: ReviewFindingV1): string {
  return `${finding.title}\n\n${finding.body}\n\n${findingLocation(finding)}`;
}

/**
 * Parse the strict structured result from an already-parsed value. Throws
 * `RecordParseError`; a `bound_exceeded` issue is the unavailable disposition
 * (see `isJournalBoundExceeded`).
 */
export function parseReviewResultV1(input: unknown): ReviewResultV1 {
  const obj = expectRecord(input, "$");
  expectJournalExactKeys(obj, RESULT_KEYS, "$");
  const verdict = expectEnum(
    obj.verdict,
    ["clean", "findings", "unavailable"],
    "$.verdict",
  );
  const summary = expectHumanText(obj.summary, "$.summary", MAX_RESULT_SUMMARY);
  if (summary.length === 0) {
    fail("$.summary", "invalid_pattern", "expected non-empty summary");
  }
  const findings = expectArray(
    obj.findings,
    "$.findings",
    MAX_FINDINGS,
    parseFinding,
  );
  if (verdict === "clean" && findings.length !== 0) {
    fail("$", "invalid_value", "clean verdict carries findings");
  }
  if (verdict === "findings" && findings.length === 0) {
    fail("$", "invalid_value", "findings verdict carries no findings");
  }
  if (verdict === "unavailable" && findings.length !== 0) {
    fail("$", "invalid_value", "unavailable verdict carries findings");
  }
  const seen = new Set<string>();
  for (const finding of findings) {
    const key = findingKey(finding);
    if (seen.has(key)) {
      fail("$.findings", "invalid_array", "duplicate findings are rejected");
    }
    seen.add(key);
  }
  return { verdict, summary, findings };
}

function parseFinding(input: unknown, path: string): ReviewFindingV1 {
  const obj = expectRecord(input, path);
  expectJournalExactKeys(obj, FINDING_KEYS, path);
  const priority = parsePriority(obj.priority, `${path}.priority`);
  const title = expectSingleLineText(
    obj.title,
    `${path}.title`,
    MAX_FINDING_TITLE,
  );
  if (title.length === 0) {
    fail(`${path}.title`, "invalid_pattern", "expected non-empty title");
  }
  const body = expectMultilineText(obj.body, `${path}.body`, MAX_FINDING_BODY);
  const pathText = parseReviewPath(obj.path, `${path}.path`);
  const lineStart = expectPositiveInt(obj.lineStart, `${path}.lineStart`);
  const lineEnd = expectPositiveInt(obj.lineEnd, `${path}.lineEnd`);
  if (lineEnd < lineStart) {
    fail(`${path}.lineEnd`, "invalid_value", "line end precedes line start");
  }
  const finding: ReviewFindingV1 = {
    priority,
    title,
    body,
    path: pathText,
    lineStart,
    lineEnd,
  };
  if (findingMessage(finding).length > MAX_FINDING_MESSAGE) {
    fail(
      path,
      "bound_exceeded",
      `finding message exceeds ${MAX_FINDING_MESSAGE}`,
    );
  }
  return finding;
}

function parsePriority(value: unknown, path: string): FindingPriorityV1 {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(path, "invalid_enum", "expected one of 0, 1, 2, 3");
  }
  if (value < 0 || value > 3) {
    fail(path, "invalid_enum", "expected one of 0, 1, 2, 3");
  }
  return value as FindingPriorityV1;
}

function findingKey(finding: ReviewFindingV1): string {
  return [
    String(finding.priority),
    finding.title,
    finding.body,
    finding.path,
    String(finding.lineStart),
    String(finding.lineEnd),
  ].join("\u0000");
}

/**
 * Parse the strict structured result from its exact JSON text (the model
 * output). Rejects prose, fences, trailing content, truncated JSON and
 * duplicate object keys; the text itself is never echoed.
 */
export function parseReviewResultJson(text: string): ReviewResultV1 {
  if (utf8Length(text) > MAX_JOURNAL_BYTES) {
    fail(
      "$",
      "bound_exceeded",
      `result JSON exceeds ${MAX_JOURNAL_BYTES} bytes`,
    );
  }
  const value = expectStrictJson(text, "$");
  return parseReviewResultV1(value);
}

/** Canonical SHA-256 digest over the structured result. */
export function reviewResultDigest(result: ReviewResultV1): Promise<string> {
  return canonicalStringifySha256(result);
}

// ---------------------------------------------------------------------------
// Journal phases
// ---------------------------------------------------------------------------

export type ReviewJournalPhaseV1 = "intent" | "running" | "ready";

export interface ReviewJournalRepositoryV1 {
  owner: string;
  name: string;
}

export interface ReviewJournalExecutionV1 {
  ownerRunId: string;
  invocationId: string;
  threadId: string;
  submittedProvider: string;
  model: typeof REVIEW_MODEL;
  reasoning: typeof REVIEW_REASONING;
  /** Explicit durable marker: a model start may occur after running readback. */
  startMayOccur: true;
}

export interface ReviewJournalRuntimeActualV1 {
  /** Request/runtime evidence class — never a backend provider attestation. */
  evidenceKind: "request-runtime";
  provider: string;
  threadId: string;
  turnId: string;
  terminalOrigin: "runtime" | "host-timeout";
  observedTerminalStatus: "completed" | "interrupted" | "failed" | null;
  observedModel: typeof REVIEW_MODEL;
  observedReasoning: typeof REVIEW_REASONING;
  durationMs: number;
  outputChars: number;
}

export interface ReviewJournalReadyExecutionV1
  extends ReviewJournalExecutionV1 {
  turnId: string;
  resultId: string;
  actual: ReviewJournalRuntimeActualV1;
}

export interface ReviewJournalIntentV1 {
  version: "v1";
  phase: "intent";
  repository: ReviewJournalRepositoryV1;
  prNumber: number;
  expectedHead: GitSha;
  expectedBase: GitSha;
  operationKey: string;
  publisher: string;
  requestId: string;
  requestedAt: number;
}

export interface ReviewJournalRunningV1
  extends Omit<ReviewJournalIntentV1, "phase"> {
  phase: "running";
  reviewId: number;
  execution: ReviewJournalExecutionV1;
}

export interface ReviewJournalReadyV1
  extends Omit<ReviewJournalIntentV1, "phase"> {
  phase: "ready";
  reviewId: number;
  completedAt: number;
  result: ReviewResultV1;
  resultDigest: string;
  execution: ReviewJournalReadyExecutionV1 | null;
}

export type ReviewJournalV1 =
  | ReviewJournalIntentV1
  | ReviewJournalRunningV1
  | ReviewJournalReadyV1;

const INTENT_KEYS = [
  "version",
  "phase",
  "repository",
  "prNumber",
  "expectedHead",
  "expectedBase",
  "operationKey",
  "publisher",
  "requestId",
  "requestedAt",
] as const;

const RUNNING_EXTRA_KEYS = ["reviewId", "execution"] as const;
const READY_EXTRA_KEYS = [
  "reviewId",
  "completedAt",
  "result",
  "resultDigest",
  "execution",
] as const;

const EXECUTION_KEYS = [
  "ownerRunId",
  "invocationId",
  "threadId",
  "submittedProvider",
  "model",
  "reasoning",
  "startMayOccur",
] as const;

const READY_EXECUTION_KEYS = [
  ...EXECUTION_KEYS,
  "turnId",
  "resultId",
  "actual",
] as const;

const ACTUAL_KEYS = [
  "evidenceKind",
  "provider",
  "threadId",
  "turnId",
  "terminalOrigin",
  "observedTerminalStatus",
  "observedModel",
  "observedReasoning",
  "durationMs",
  "outputChars",
] as const;

/**
 * Parse the strict journal record from its canonical JSON text (metadata
 * only; the whole-body parser is `parseReviewJournalBody`). Throws
 * `RecordParseError`; `bound_exceeded` is the unavailable disposition.
 */
export function parseReviewJournalMetadata(json: string): ReviewJournalV1 {
  const value = expectStrictJson(json, "$");
  return parseReviewJournalValue(value);
}

function parseReviewJournalValue(input: unknown): ReviewJournalV1 {
  const obj = expectRecord(input, "$");
  const phase = expectEnum(
    obj.phase,
    ["intent", "running", "ready"],
    "$.phase",
  );
  if (phase === "intent") {
    expectJournalExactKeys(obj, INTENT_KEYS, "$");
    return { ...parseCommon(obj), phase: "intent" };
  }
  if (phase === "running") {
    expectJournalExactKeys(obj, [...INTENT_KEYS, ...RUNNING_EXTRA_KEYS], "$");
    const common = parseCommon(obj);
    return {
      ...common,
      phase: "running",
      reviewId: expectPositiveInt(obj.reviewId, "$.reviewId"),
      execution: parseExecution(obj.execution, "$.execution"),
    };
  }
  expectJournalExactKeys(obj, [...INTENT_KEYS, ...READY_EXTRA_KEYS], "$");
  const common = parseCommon(obj);
  const completedAt = expectTimestamp(obj.completedAt, "$.completedAt");
  if (completedAt < common.requestedAt) {
    fail(
      "$.completedAt",
      "invalid_lifecycle",
      "completion precedes request time",
    );
  }
  const result = parseReviewResultV1(obj.result);
  const resultDigest = expectSha256Hex(obj.resultDigest, "$.resultDigest");
  const execution = obj.execution === null
    ? null
    : parseReadyExecution(obj.execution, "$.execution");
  if (result.verdict !== "unavailable") {
    if (execution === null) {
      fail(
        "$.execution",
        "invalid_lifecycle",
        "completed verdict requires execution evidence",
      );
    }
    if (
      execution.actual.terminalOrigin !== "runtime" ||
      execution.actual.observedTerminalStatus !== "completed"
    ) {
      fail(
        "$.execution",
        "invalid_lifecycle",
        "completed verdict requires observed runtime completion",
      );
    }
  }
  return {
    ...common,
    phase: "ready",
    reviewId: expectPositiveInt(obj.reviewId, "$.reviewId"),
    completedAt,
    result,
    resultDigest,
    execution,
  };
}

function parseCommon(obj: Record<string, unknown>): ReviewJournalIntentV1 {
  const version = expectEnum(obj.version, ["v1"], "$.version");
  const repository = expectRecord(obj.repository, "$.repository");
  expectJournalExactKeys(repository, ["owner", "name"], "$.repository");
  const owner = expectString(
    repository.owner,
    "$.repository.owner",
    MaxText.owner,
  );
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
    fail("$.repository.owner", "invalid_pattern", "expected GitHub owner name");
  }
  const name = expectString(repository.name, "$.repository.name", MaxText.name);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
    fail(
      "$.repository.name",
      "invalid_pattern",
      "expected GitHub repository name",
    );
  }
  return {
    version,
    phase: "intent",
    repository: { owner, name },
    prNumber: expectPositiveInt(obj.prNumber, "$.prNumber"),
    expectedHead: expectGitSha(obj.expectedHead, "$.expectedHead"),
    expectedBase: expectGitSha(obj.expectedBase, "$.expectedBase"),
    operationKey: expectBoundedId(
      obj.operationKey,
      "$.operationKey",
      MaxText.recordId,
    ),
    publisher: expectBoundedId(obj.publisher, "$.publisher", MaxText.login),
    requestId: expectBoundedId(obj.requestId, "$.requestId", MaxText.recordId),
    requestedAt: expectTimestamp(obj.requestedAt, "$.requestedAt"),
  };
}

function parseExecution(
  input: unknown,
  path: string,
): ReviewJournalExecutionV1 {
  const obj = expectRecord(input, path);
  expectJournalExactKeys(obj, EXECUTION_KEYS, path);
  return parseExecutionFields(obj, path);
}

function parseExecutionFields(
  obj: Record<string, unknown>,
  path: string,
): ReviewJournalExecutionV1 {
  const model = expectEnum(obj.model, [REVIEW_MODEL], `${path}.model`);
  const reasoning = expectEnum(
    obj.reasoning,
    [REVIEW_REASONING],
    `${path}.reasoning`,
  );
  const startMayOccur = expectBoolean(
    obj.startMayOccur,
    `${path}.startMayOccur`,
  );
  if (startMayOccur !== true) {
    fail(`${path}.startMayOccur`, "invalid_value", "start marker must be true");
  }
  return {
    ownerRunId: expectBoundedId(
      obj.ownerRunId,
      `${path}.ownerRunId`,
      MaxText.recordId,
    ),
    invocationId: expectBoundedId(
      obj.invocationId,
      `${path}.invocationId`,
      MaxText.recordId,
    ),
    threadId: expectBoundedId(
      obj.threadId,
      `${path}.threadId`,
      MaxText.recordId,
    ),
    submittedProvider: expectBoundedId(
      obj.submittedProvider,
      `${path}.submittedProvider`,
      MaxText.token,
    ),
    model,
    reasoning,
    startMayOccur,
  };
}

function parseReadyExecution(
  input: unknown,
  path: string,
): ReviewJournalReadyExecutionV1 {
  const obj = expectRecord(input, path);
  expectJournalExactKeys(obj, READY_EXECUTION_KEYS, path);
  const execution = parseExecutionFields(obj, path);
  const turnId = expectBoundedId(
    obj.turnId,
    `${path}.turnId`,
    MaxText.recordId,
  );
  const resultId = expectBoundedId(
    obj.resultId,
    `${path}.resultId`,
    MaxText.recordId,
  );
  const actual = parseActual(obj.actual, `${path}.actual`, execution, turnId);
  return { ...execution, turnId, resultId, actual };
}

function parseActual(
  input: unknown,
  path: string,
  execution: ReviewJournalExecutionV1,
  turnId: string,
): ReviewJournalRuntimeActualV1 {
  const obj = expectRecord(input, path);
  expectJournalExactKeys(obj, ACTUAL_KEYS, path);
  const evidenceKind = expectEnum(
    obj.evidenceKind,
    ["request-runtime"],
    `${path}.evidenceKind`,
  );
  const provider = expectBoundedId(
    obj.provider,
    `${path}.provider`,
    MaxText.token,
  );
  const threadId = expectBoundedId(
    obj.threadId,
    `${path}.threadId`,
    MaxText.recordId,
  );
  const actualTurnId = expectBoundedId(
    obj.turnId,
    `${path}.turnId`,
    MaxText.recordId,
  );
  if (provider !== execution.submittedProvider) {
    fail(
      `${path}.provider`,
      "invalid_value",
      "provider does not match submitted configuration",
    );
  }
  if (threadId !== execution.threadId) {
    fail(
      `${path}.threadId`,
      "invalid_value",
      "thread identity does not match execution",
    );
  }
  if (actualTurnId !== turnId) {
    fail(
      `${path}.turnId`,
      "invalid_value",
      "turn identity does not match execution",
    );
  }
  const terminalOrigin = expectEnum(
    obj.terminalOrigin,
    ["runtime", "host-timeout"],
    `${path}.terminalOrigin`,
  );
  const observedTerminalStatus = obj.observedTerminalStatus === null
    ? null
    : expectEnum(
      obj.observedTerminalStatus,
      ["completed", "interrupted", "failed"],
      `${path}.observedTerminalStatus`,
    );
  if (terminalOrigin === "runtime" && observedTerminalStatus === null) {
    fail(
      `${path}.observedTerminalStatus`,
      "invalid_value",
      "runtime terminal requires an observed status",
    );
  }
  if (terminalOrigin === "host-timeout" && observedTerminalStatus !== null) {
    fail(
      `${path}.observedTerminalStatus`,
      "invalid_value",
      "host timeout carries no observed runtime terminal",
    );
  }
  const observedModel = expectEnum(
    obj.observedModel,
    [REVIEW_MODEL],
    `${path}.observedModel`,
  );
  const observedReasoning = expectEnum(
    obj.observedReasoning,
    [REVIEW_REASONING],
    `${path}.observedReasoning`,
  );
  if (observedModel !== execution.model) {
    fail(
      `${path}.observedModel`,
      "invalid_value",
      "model does not match submitted configuration",
    );
  }
  if (observedReasoning !== execution.reasoning) {
    fail(
      `${path}.observedReasoning`,
      "invalid_value",
      "reasoning does not match submitted configuration",
    );
  }
  return {
    evidenceKind,
    provider,
    threadId,
    turnId: actualTurnId,
    terminalOrigin,
    observedTerminalStatus,
    observedModel,
    observedReasoning,
    durationMs: expectCount(obj.durationMs, `${path}.durationMs`),
    outputChars: expectCount(obj.outputChars, `${path}.outputChars`),
  };
}

// ---------------------------------------------------------------------------
// Rendering / full-body parsing
// ---------------------------------------------------------------------------

const METADATA_MARKER = "<!--sentinel-review-journal-v1";
const METADATA_TERMINATOR = "-->";

/**
 * Deterministic render of the full journal body: hidden canonical metadata
 * (base64-encoded canonical JSON in a fixed HTML comment, immune to `--` and
 * `-->` in any text) followed by the escaped human-readable section. Throws
 * `RecordParseError` with `bound_exceeded` when the rendered body exceeds
 * `MAX_JOURNAL_BYTES` — the producer maps that to `unavailable`, never a
 * partial body.
 */
export function renderReviewJournalBody(journal: ReviewJournalV1): string {
  const metadata = encodeJournalMetadata(journal);
  const human = renderHumanSection(journal);
  const body =
    `${METADATA_MARKER}\n${metadata}\n${METADATA_TERMINATOR}\n\n${human}`;
  if (utf8Length(body) > MAX_JOURNAL_BYTES) {
    fail(
      "$",
      "bound_exceeded",
      `rendered journal exceeds ${MAX_JOURNAL_BYTES} bytes`,
    );
  }
  return body;
}

/**
 * Parse the full journal body. Verifies the byte bound, the strict complete
 * metadata (duplicate-key-rejecting canonical JSON), the result digest and
 * exact byte equality with re-rendering. Throws `RecordParseError`;
 * `bound_exceeded` is the unavailable disposition, every other issue is
 * invalid evidence.
 */
export async function parseReviewJournalBody(
  body: string,
): Promise<ReviewJournalV1> {
  if (utf8Length(body) > MAX_JOURNAL_BYTES) {
    fail(
      "$",
      "bound_exceeded",
      `journal body exceeds ${MAX_JOURNAL_BYTES} bytes`,
    );
  }
  const metadata = extractMetadata(body);
  const journal = parseReviewJournalMetadata(metadata);
  if (journal.phase === "ready") {
    const digest = await canonicalStringifySha256(journal.result);
    if (digest !== journal.resultDigest) {
      fail("$.resultDigest", "invalid_digest", "result digest mismatch");
    }
  }
  if (renderReviewJournalBody(journal) !== body) {
    fail("$", "invalid_value", "journal body does not match its metadata");
  }
  return journal;
}

/** True when a codec failure is a contract-bound overflow (unavailable). */
export function isJournalBoundExceeded(error: unknown): boolean {
  return error instanceof RecordParseError &&
    error.issues.some((issue) => issue.code === "bound_exceeded");
}

function extractMetadata(body: string): string {
  const marker = `${METADATA_MARKER}\n`;
  if (!body.startsWith(marker)) {
    fail("$", "invalid_value", "expected journal metadata marker");
  }
  const afterMarker = body.slice(marker.length);
  const end = afterMarker.indexOf(`\n${METADATA_TERMINATOR}`);
  if (end === -1) {
    fail("$", "invalid_value", "expected journal metadata terminator");
  }
  const encoded = afterMarker.slice(0, end);
  if (encoded === "" || encoded.includes("\n")) {
    fail("$", "invalid_value", "journal metadata is malformed");
  }
  try {
    // Standard base64: only [A-Za-z0-9+/=], so the metadata region can never
    // contain an HTML comment terminator no matter what the record says.
    const canonical = expectCanonicalBase64(
      encoded,
      "$",
      4 * MAX_JOURNAL_BYTES,
    );
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(canonical), (char) => char.charCodeAt(0)),
    );
    return decoded;
  } catch (error) {
    if (error instanceof RecordParseError) throw error;
    fail("$", "invalid_value", "journal metadata is malformed");
  }
}

function encodeJournalMetadata(journal: ReviewJournalV1): string {
  const json = canonicalStringify(journal);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function renderHumanSection(journal: ReviewJournalV1): string {
  if (journal.phase === "intent") {
    return [
      "# Model review intent",
      "",
      `A code review is requested for pull request ${journal.prNumber} by ${
        escapeHuman(journal.publisher)
      }.`,
      "",
    ].join("\n");
  }
  if (journal.phase === "running") {
    return [
      "# Model review in progress",
      "",
      `Review ${journal.reviewId} is running for pull request ${journal.prNumber} by ${
        escapeHuman(journal.publisher)
      }.`,
      "",
    ].join("\n");
  }
  const lines: string[] = [
    `# Model review: ${journal.result.verdict}`,
    "",
    "Summary:",
    escapeHuman(journal.result.summary),
    "",
  ];
  if (journal.result.verdict === "findings") {
    lines.push(`Findings (${journal.result.findings.length}):`, "");
    for (const finding of journal.result.findings) {
      lines.push(`- [P${finding.priority}] ${escapeHuman(finding.title)}`);
      for (const line of finding.body.split("\n")) {
        lines.push(`  ${escapeHuman(line)}`);
      }
      lines.push(
        `  ${escapeHuman(findingLocation(finding))}`,
        "",
      );
    }
  }
  return lines.join("\n");
}

/**
 * Deterministic escaping of untrusted text for the human section. `&` is
 * escaped first; the result can never form `<`, `-->` or any raw comment
 * delimiter, and the same function is applied on every render, so the parser
 * round-trip is exact.
 */
function escapeHuman(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  );
}

// ---------------------------------------------------------------------------
// Shared text primitives
// ---------------------------------------------------------------------------

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Human text (summary/body): control chars rejected except tab/newline. */
function expectHumanText(value: unknown, path: string, max: number): string {
  return expectMultilineText(value, path, max);
}

function expectMultilineText(
  value: unknown,
  path: string,
  max: number,
): string {
  const text = expectString(value, path, max);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7F) {
      if (code !== 0x09 && code !== 0x0A) {
        fail(path, "invalid_pattern", "control character in text");
      }
    }
  }
  return text;
}

/** Single-line text (title, ids): no control characters at all. */
function expectSingleLineText(
  value: unknown,
  path: string,
  max: number,
): string {
  const text = expectString(value, path, max);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7F) {
      fail(path, "invalid_pattern", "control character in text");
    }
  }
  return text;
}

function expectBoundedId(value: unknown, path: string, max: number): string {
  const text = expectSingleLineText(value, path, max);
  if (text.length === 0) {
    fail(path, "invalid_pattern", "expected non-empty string");
  }
  return text;
}

function parseReviewPath(value: unknown, path: string): string {
  const text = expectSingleLineText(value, path, MAX_FINDING_PATH);
  if (text.length === 0) {
    fail(path, "invalid_pattern", "expected a non-empty relative path");
  }
  if (text.startsWith("/")) {
    fail(path, "invalid_pattern", "expected a relative path");
  }
  if (/^[A-Za-z]:[\\/]/.test(text)) {
    fail(path, "invalid_pattern", "expected a relative path");
  }
  if (text.includes("\\")) {
    fail(path, "invalid_pattern", "expected a relative path");
  }
  for (const segment of text.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      fail(
        path,
        "invalid_pattern",
        "expected a path without traversal segments",
      );
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// Strict JSON (duplicate-key rejecting, full consumption)
// ---------------------------------------------------------------------------

class JsonSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonSyntaxError";
  }
}

function expectStrictJson(text: string, path: string): unknown {
  try {
    return parseJsonStrict(text);
  } catch {
    // Static sanitized failure; the input is never echoed.
    fail(path, "invalid_value", "expected complete strict JSON");
  }
}

function parseJsonStrict(text: string): unknown {
  const parser = new StrictJsonParser(text);
  const value = parser.parse();
  return value;
}

class StrictJsonParser {
  private index = 0;
  private readonly length: number;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
    this.length = text.length;
  }

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.length) {
      throw new JsonSyntaxError("unexpected trailing content");
    }
    return value;
  }

  private parseValue(): unknown {
    const char = this.peek();
    if (char === "{") return this.parseObject();
    if (char === "[") return this.parseArray();
    if (char === '"') return this.parseString();
    if (char === "t") {
      this.expectLiteral("true");
      return true;
    }
    if (char === "f") {
      this.expectLiteral("false");
      return false;
    }
    if (char === "n") {
      this.expectLiteral("null");
      return null;
    }
    if (char === "-" || isDigit(char)) return this.parseNumber();
    throw new JsonSyntaxError("expected JSON value");
  }

  private parseObject(): unknown {
    this.expect("{");
    const result: Record<string, unknown> = {};
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.index++;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.peek() !== '"') {
        throw new JsonSyntaxError("expected object key");
      }
      const key = this.parseString();
      if (Object.prototype.hasOwnProperty.call(result, key)) {
        // Duplicate keys are never silently resolved to the last value.
        throw new JsonSyntaxError("duplicate object key");
      }
      this.skipWhitespace();
      this.expect(":");
      this.skipWhitespace();
      const value = this.parseValue();
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.skipWhitespace();
      const char = this.peek();
      if (char === "}") {
        this.index++;
        return result;
      }
      if (char !== ",") {
        throw new JsonSyntaxError("expected comma or closing brace");
      }
      this.index++;
    }
  }

  private parseArray(): unknown {
    this.expect("[");
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.peek() === "]") {
      this.index++;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      result.push(this.parseValue());
      this.skipWhitespace();
      const char = this.peek();
      if (char === "]") {
        this.index++;
        return result;
      }
      if (char !== ",") {
        throw new JsonSyntaxError("expected comma or closing bracket");
      }
      this.index++;
    }
  }

  private parseString(): string {
    this.expect('"');
    let result = "";
    for (;;) {
      if (this.index >= this.length) {
        throw new JsonSyntaxError("unterminated string");
      }
      const char = this.text[this.index];
      if (char === '"') {
        this.index++;
        return result;
      }
      if (char === "\\") {
        this.index++;
        if (this.index >= this.length) {
          throw new JsonSyntaxError("unterminated escape");
        }
        const escape = this.text[this.index++];
        switch (escape) {
          case '"':
            result += '"';
            break;
          case "\\":
            result += "\\";
            break;
          case "/":
            result += "/";
            break;
          case "b":
            result += "\b";
            break;
          case "f":
            result += "\f";
            break;
          case "n":
            result += "\n";
            break;
          case "r":
            result += "\r";
            break;
          case "t":
            result += "\t";
            break;
          case "u": {
            const hex = this.text.slice(this.index, this.index + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new JsonSyntaxError("invalid unicode escape");
            }
            this.index += 4;
            result += String.fromCharCode(Number.parseInt(hex, 16));
            break;
          }
          default:
            throw new JsonSyntaxError("invalid string escape");
        }
        continue;
      }
      const code = char.charCodeAt(0);
      if (code < 0x20) {
        // A raw control character inside a string is not valid JSON.
        throw new JsonSyntaxError("unescaped control character in string");
      }
      result += char;
      this.index++;
    }
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.text.slice(this.index),
    );
    if (match === null) {
      throw new JsonSyntaxError("invalid number");
    }
    this.index += match[0].length;
    return Number(match[0]);
  }

  private expectLiteral(literal: string): void {
    if (!this.text.startsWith(literal, this.index)) {
      throw new JsonSyntaxError("invalid literal");
    }
    this.index += literal.length;
  }

  private skipWhitespace(): void {
    while (this.index < this.length) {
      const char = this.text[this.index];
      if (char === " " || char === "\t" || char === "\n" || char === "\r") {
        this.index++;
        continue;
      }
      break;
    }
  }

  private expect(char: string): void {
    if (this.peek() !== char) {
      throw new JsonSyntaxError(`expected "${char}"`);
    }
    this.index++;
  }

  private peek(): string {
    if (this.index >= this.length) {
      throw new JsonSyntaxError("unexpected end of input");
    }
    return this.text[this.index];
  }
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}
