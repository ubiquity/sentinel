/**
 * m19 matrix plan/cell/result contracts.
 *
 * The trusted planner writes ONE immutable plan per wave; every matrix cell
 * receives exactly one `MatrixCellGrantV1` and emits one
 * `MatrixCellResultV1`. These records are identity/binding carriers only: the
 * embedded `ModelRunRequestV1`/`ModelRunReceiptV1` are parsed strictly here,
 * but no field is acceptance authority. The trusted ingester re-reads
 * authoritative state, re-verifies the receipt projection against the exact
 * request, and reuses the production receipt/candidate consumers.
 *
 * Bounded at `MAX_MATRIX_CELLS` (the native platform matrix ceiling; never a
 * lower artificial throttle). No durable state-store field or ref is added:
 * plan/result artifacts live in the runner workspace and Actions artifacts.
 */
import type { GitSha, WorkItemId } from "./brands.ts";
import { canonicalStringify } from "./canonical.ts";
import type {
  CandidateOutcomeV1,
  ModelRunReceiptV1,
  ModelRunRequestV1,
} from "./ports.ts";
import {
  parseEvidenceRef,
  parseRepositoryIdentity,
  type RepositoryIdentityV1,
} from "./shared.ts";
import {
  expectArray,
  expectCount,
  expectEnum,
  expectExactKeys,
  expectExactKeysWithOptional,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectPattern,
  expectPositiveInt,
  expectRecord,
  expectSha256Hex,
  expectString,
  expectTimestamp,
  expectVersion,
  fail,
  type ParseRecordResult,
  tryParse,
} from "./validation.ts";

export const MATRIX_PLAN_VERSION = "v1" as const;
export const MATRIX_CELL_RESULT_VERSION = "v1" as const;
/** Native GitHub Actions matrix ceiling; the planner never throttles below it. */
export const MAX_MATRIX_CELLS = 256;

/**
 * Fixed launcher artifact paths, relative to the dispatched runner workspace:
 * the planner output, the per-cell grant input and one result file per cell.
 */
export const MATRIX_PLAN_PATH = ".sentinel-matrix/plan.json";
export const MATRIX_CELL_PATH = ".sentinel-matrix/cell.json";
export const MATRIX_RESULT_PATH = ".sentinel-matrix/result.json";
export const MATRIX_RESULTS_DIR = ".sentinel-matrix/results";
/** Bound on one result artifact so a hostile file cannot exhaust the ingester. */
export const MAX_MATRIX_ARTIFACT_BYTES = 2 * 1024 * 1024;
/** Shared producer/importer bound on one candidate Git bundle. */
export const MAX_MATRIX_BUNDLE_BYTES = 64 * 1024 * 1024;
/** Finite allowance for two ZIP headers, metadata and deflate/stored framing. */
export const MAX_MATRIX_ARCHIVE_OVERHEAD_BYTES = 1024 * 1024;
/** One bundle plus one result JSON, including bounded ZIP overhead. */
export const MAX_MATRIX_ARCHIVE_BYTES = MAX_MATRIX_BUNDLE_BYTES +
  MAX_MATRIX_ARTIFACT_BYTES + MAX_MATRIX_ARCHIVE_OVERHEAD_BYTES;

const MAX_ID_CHARS = 256;
const MAX_TEXT_CHARS = 100_000;
const MAX_ERROR_CHARS = 8192;
const MAX_CHANGED_PATHS = 4096;
const MAX_PATH_CHARS = 1024;
const MAX_EVIDENCE_REFS = 64;
const MAX_REVIEW_FINDINGS = 128;

const REQUEST_REQUIRED = [
  "taskId",
  "repository",
  "base",
  "issue",
  "evidence",
  "model",
  "reasoning",
  "maxDurationMs",
  "maxOutputChars",
] as const;
const REQUEST_OPTIONAL = ["checkoutBase", "reviewFindings"] as const;
const FINDING_KEYS = ["severity", "path", "message"] as const;
const RUN_KEYS = ["runId", "runAttempt", "launcherSha"] as const;
const CELL_KEYS = [
  "cellId",
  "taskId",
  "repository",
  "reservationId",
  "intentKey",
  "expectedBase",
  "runtimeSha",
  "generation",
  "requestDigest",
  "request",
] as const;
const PLAN_KEYS = [
  "version",
  "kind",
  "waveId",
  "run",
  "plannedAt",
  "cells",
] as const;
const RESULT_KEYS = [
  "version",
  "kind",
  "waveId",
  "cellId",
  "taskId",
  "repository",
  "run",
  "runtimeSha",
  "generation",
  "reservationId",
  "intentKey",
  "requestDigest",
  "status",
  "receipt",
  "bundle",
  "detail",
  "completedAt",
] as const;
const BUNDLE_KEYS = ["file", "digest", "head", "checkpointSha"] as const;
const RECEIPT_KEYS = [
  "invocationId",
  "outcome",
  "actual",
  "candidate",
  "error",
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
const CANDIDATE_KEYS = ["head", "checkpointSha", "changedPaths"] as const;
/** Literal tuple so enum inference stays the exact union, never `string`. */
const TERMINAL_STATUSES = ["completed", "interrupted", "failed"] as const;

/** Exact workflow run/attempt and launcher revision that owns the wave. */
export interface MatrixRunIdentityV1 {
  runId: number;
  runAttempt: number;
  launcherSha: GitSha;
}

/** One admitted implementation start: the exact grant a cell may execute. */
export interface MatrixCellPlanV1 {
  /** Stable wave+task identity; unique per task/repository/admission. */
  cellId: string;
  taskId: WorkItemId;
  repository: RepositoryIdentityV1;
  /** Durable reservation that admitted this exact start. */
  reservationId: string;
  /** Durable implementation intent key on the work record. */
  intentKey: string;
  /** Exact planned checkout base (re-verified before the model starts). */
  expectedBase: GitSha;
  /** Trusted runtime implementation revision the wave is running. */
  runtimeSha: GitSha;
  /** Trusted hosted runtime pointer generation the wave is running. */
  generation: number;
  /** Canonical digest of `request`; a cell refuses any mismatch. */
  requestDigest: string;
  /** Exact secret-free request the cell runs once. */
  request: ModelRunRequestV1;
}

export interface MatrixPlanV1 {
  version: typeof MATRIX_PLAN_VERSION;
  kind: "matrix_plan";
  waveId: string;
  run: MatrixRunIdentityV1;
  plannedAt: number;
  cells: MatrixCellPlanV1[];
}

/** One cell's input artifact: the wave identity plus its single grant. */
export interface MatrixCellGrantV1 {
  waveId: string;
  run: MatrixRunIdentityV1;
  cell: MatrixCellPlanV1;
}

/**
 * Trusted actual identity of the running cell, derived by the host from the
 * dispatched workflow run and the hosted runtime pointer. It is NEVER read
 * from the untrusted grant artifact.
 */
export interface MatrixCellActualIdentityV1 {
  run: MatrixRunIdentityV1;
  runtimeSha: GitSha;
  generation: number;
}

export type MatrixCellResultStatusV1 = "completed" | "failed" | "not_started";

/**
 * Bounded candidate Git bundle produced by one cell. It carries only the
 * objects between the planned base and the candidate head, so the trusted
 * ingester can verify and import the exact candidate into its own mirror
 * before the existing preservation/publication consumers run. `file` is a safe
 * basename inside the wave results/bundles directory.
 */
export interface MatrixCellBundleV1 {
  /** Safe basename: the 64-hex cell id plus ".bundle". */
  file: string;
  /** SHA-256 of the exact bundle bytes. */
  digest: string;
  /** Exact candidate head the bundle must contain. */
  head: GitSha;
  /** Durable checkpoint SHA carried by the bundle, or null. */
  checkpointSha: GitSha | null;
}

/** One cell's output artifact; untrusted until trusted ingestion validates it. */
export interface MatrixCellResultV1 {
  version: typeof MATRIX_CELL_RESULT_VERSION;
  kind: "matrix_cell_result";
  waveId: string;
  cellId: string;
  taskId: WorkItemId;
  repository: RepositoryIdentityV1;
  run: MatrixRunIdentityV1;
  runtimeSha: GitSha;
  generation: number;
  reservationId: string;
  intentKey: string;
  requestDigest: string;
  status: MatrixCellResultStatusV1;
  /** Present exactly for a completed status; validated by production consumers. */
  receipt: ModelRunReceiptV1 | null;
  /** Candidate object carrier; required for a completed receipt with a head. */
  bundle: MatrixCellBundleV1 | null;
  /** Static sanitized detail for a non-completed status. */
  detail: string | null;
  completedAt: number;
}

/** Deterministic bundle basename for one cell: the opaque cell id + suffix. */
export function matrixBundleFileNameV1(cellId: string): string {
  return `${cellId}.bundle`;
}

/**
 * Stable opaque per-cell identity derived from the exact bound wave, task and
 * admission reservation. It is 64 lowercase hex characters so it is safe as a
 * native artifact/upload name (never a colon-delimited task id).
 */
export function matrixCellIdV1(
  waveId: string,
  taskId: string,
  reservationId: string,
): Promise<string> {
  return matrixDigestV1({ waveId, taskId, reservationId });
}

/** Canonical SHA-256 digest binding the exact planned request bytes. */
export async function matrixDigestV1(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalStringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Strict parsers (identical rules at plan write and result read)
// ---------------------------------------------------------------------------

export function parseMatrixRunIdentityV1(
  input: unknown,
  path: string,
): MatrixRunIdentityV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, RUN_KEYS, path);
  return {
    runId: expectPositiveInt(obj.runId, `${path}.runId`),
    runAttempt: expectPositiveInt(obj.runAttempt, `${path}.runAttempt`),
    launcherSha: expectGitSha(obj.launcherSha, `${path}.launcherSha`),
  };
}

function parseFinding(
  input: unknown,
  path: string,
): { severity: string; path: string | null; message: string } {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, FINDING_KEYS, path);
  return {
    severity: expectNonEmptyString(obj.severity, `${path}.severity`, 64),
    path: expectNullable(
      obj.path,
      `${path}.path`,
      (value, at) => expectNonEmptyString(value, at, MAX_PATH_CHARS),
    ),
    message: expectNonEmptyString(
      obj.message,
      `${path}.message`,
      MAX_ERROR_CHARS,
    ),
  };
}

function parseCandidateOutcome(
  input: unknown,
  path: string,
): CandidateOutcomeV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, CANDIDATE_KEYS, path);
  return {
    head: expectNullable(obj.head, `${path}.head`, expectGitSha),
    checkpointSha: expectNullable(
      obj.checkpointSha,
      `${path}.checkpointSha`,
      expectGitSha,
    ),
    changedPaths: expectArray(
      obj.changedPaths,
      `${path}.changedPaths`,
      MAX_CHANGED_PATHS,
      (value, at) => expectNonEmptyString(value, at, MAX_PATH_CHARS),
    ),
  };
}

/** Strict parse of one bounded model run request. */
export function parseMatrixModelRequestV1(
  input: unknown,
  path: string,
): ModelRunRequestV1 {
  const obj = expectRecord(input, path);
  expectExactKeysWithOptional(obj, REQUEST_REQUIRED, REQUEST_OPTIONAL, path);
  const issue = expectNullable(
    obj.issue,
    `${path}.issue`,
    (value, at) => {
      const item = expectRecord(value, at);
      expectExactKeys(item, ["number", "title", "body"], at);
      return {
        number: expectPositiveInt(item.number, `${at}.number`),
        title: expectString(item.title, `${at}.title`, MAX_TEXT_CHARS),
        body: expectString(item.body, `${at}.body`, MAX_TEXT_CHARS),
      };
    },
  );
  const evidence = expectArray(
    obj.evidence,
    `${path}.evidence`,
    MAX_EVIDENCE_REFS,
    parseEvidenceRef,
  );
  const reviewFindings = obj.reviewFindings === undefined
    ? undefined
    : expectArray(
      obj.reviewFindings,
      `${path}.reviewFindings`,
      MAX_REVIEW_FINDINGS,
      parseFinding,
    );
  const checkoutBase = obj.checkoutBase === undefined
    ? undefined
    : expectGitSha(obj.checkoutBase, `${path}.checkoutBase`);
  if (obj.reasoning !== "max") {
    fail(`${path}.reasoning`, "invalid_enum", "reasoning must be max");
  }
  return {
    taskId: expectPattern(
      obj.taskId,
      `${path}.taskId`,
      /^[A-Za-z0-9._:-]{1,256}$/,
      "invalid_pattern",
      "expected a bounded work id",
      MAX_ID_CHARS,
    ) as WorkItemId,
    repository: parseRepositoryIdentity(obj.repository, `${path}.repository`),
    base: expectGitSha(obj.base, `${path}.base`),
    ...(checkoutBase === undefined ? {} : { checkoutBase }),
    issue,
    evidence,
    ...(reviewFindings === undefined ? {} : { reviewFindings }),
    model: expectNonEmptyString(obj.model, `${path}.model`, MAX_ID_CHARS),
    reasoning: "max",
    maxDurationMs: expectPositiveInt(
      obj.maxDurationMs,
      `${path}.maxDurationMs`,
    ),
    maxOutputChars: expectPositiveInt(
      obj.maxOutputChars,
      `${path}.maxOutputChars`,
    ),
  };
}

/** Strict parse of one model run receipt projection. */
export function parseMatrixModelReceiptV1(
  input: unknown,
  path: string,
): ModelRunReceiptV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, RECEIPT_KEYS, path);
  const actual = expectRecord(obj.actual, `${path}.actual`);
  expectExactKeys(actual, ACTUAL_KEYS, `${path}.actual`);
  if (actual.evidenceKind !== "request-runtime") {
    fail(
      `${path}.actual.evidenceKind`,
      "invalid_enum",
      "evidenceKind must be request-runtime",
    );
  }
  const outcome = expectEnum(
    obj.outcome,
    ["completed", "failed", "interrupted"],
    `${path}.outcome`,
  );
  const terminalOrigin = expectEnum(
    actual.terminalOrigin,
    ["runtime", "host-timeout"],
    `${path}.actual.terminalOrigin`,
  );
  const observedTerminalStatus = expectNullable(
    actual.observedTerminalStatus,
    `${path}.actual.observedTerminalStatus`,
    (value, at) => expectEnum(value, TERMINAL_STATUSES, at),
  );
  // Terminal-origin semantics are preserved exactly: a runtime origin must
  // carry an observed terminal; a host timeout must never claim one.
  if (terminalOrigin === "runtime" && observedTerminalStatus === null) {
    fail(
      `${path}.actual.observedTerminalStatus`,
      "invalid_lifecycle",
      "a runtime terminal origin requires an observed terminal status",
    );
  }
  if (terminalOrigin === "host-timeout" && observedTerminalStatus !== null) {
    fail(
      `${path}.actual.observedTerminalStatus`,
      "invalid_lifecycle",
      "a host timeout cannot claim an observed terminal status",
    );
  }
  if (outcome === "completed" && observedTerminalStatus !== "completed") {
    fail(
      `${path}.outcome`,
      "invalid_lifecycle",
      "a completed outcome requires an observed completed terminal",
    );
  }
  const candidate = expectNullable(
    obj.candidate,
    `${path}.candidate`,
    parseCandidateOutcome,
  );
  if (outcome === "completed" && candidate === null) {
    fail(
      `${path}.candidate`,
      "missing_field",
      "a completed outcome requires a candidate outcome block",
    );
  }
  if (outcome !== "completed" && candidate !== null) {
    fail(
      `${path}.candidate`,
      "invalid_lifecycle",
      "a non-completed outcome cannot carry a candidate",
    );
  }
  return {
    invocationId: expectNonEmptyString(
      obj.invocationId,
      `${path}.invocationId`,
      MAX_ID_CHARS,
    ),
    outcome,
    actual: {
      evidenceKind: "request-runtime",
      provider: expectNonEmptyString(
        actual.provider,
        `${path}.actual.provider`,
        MAX_ID_CHARS,
      ),
      threadId: expectNonEmptyString(
        actual.threadId,
        `${path}.actual.threadId`,
        MAX_ID_CHARS,
      ),
      turnId: expectNonEmptyString(
        actual.turnId,
        `${path}.actual.turnId`,
        MAX_ID_CHARS,
      ),
      terminalOrigin,
      observedTerminalStatus,
      observedModel: expectNonEmptyString(
        actual.observedModel,
        `${path}.actual.observedModel`,
        MAX_ID_CHARS,
      ),
      observedReasoning: expectNonEmptyString(
        actual.observedReasoning,
        `${path}.actual.observedReasoning`,
        64,
      ),
      durationMs: expectCount(actual.durationMs, `${path}.actual.durationMs`),
      outputChars: expectCount(
        actual.outputChars,
        `${path}.actual.outputChars`,
      ),
    },
    candidate,
    error: expectNullable(
      obj.error,
      `${path}.error`,
      (value, at) => expectString(value, at, MAX_ERROR_CHARS),
    ),
  };
}

export function parseMatrixCellPlanV1(
  input: unknown,
  path: string,
): MatrixCellPlanV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, CELL_KEYS, path);
  return {
    cellId: expectNonEmptyString(obj.cellId, `${path}.cellId`, MAX_ID_CHARS),
    taskId: expectPattern(
      obj.taskId,
      `${path}.taskId`,
      /^[A-Za-z0-9._:-]{1,256}$/,
      "invalid_pattern",
      "expected a bounded work id",
      MAX_ID_CHARS,
    ) as WorkItemId,
    repository: parseRepositoryIdentity(obj.repository, `${path}.repository`),
    reservationId: expectNonEmptyString(
      obj.reservationId,
      `${path}.reservationId`,
      MAX_ID_CHARS,
    ),
    intentKey: expectNonEmptyString(
      obj.intentKey,
      `${path}.intentKey`,
      MAX_ID_CHARS,
    ),
    expectedBase: expectGitSha(obj.expectedBase, `${path}.expectedBase`),
    runtimeSha: expectGitSha(obj.runtimeSha, `${path}.runtimeSha`),
    generation: expectPositiveInt(obj.generation, `${path}.generation`),
    requestDigest: expectNonEmptyString(
      obj.requestDigest,
      `${path}.requestDigest`,
      MAX_ID_CHARS,
    ),
    request: parseMatrixModelRequestV1(obj.request, `${path}.request`),
  };
}

export function parseMatrixPlanV1(input: unknown): MatrixPlanV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, PLAN_KEYS, "$");
  expectVersion(obj.version, "$.version");
  if (obj.kind !== "matrix_plan") {
    fail("$.kind", "invalid_enum", "kind must be matrix_plan");
  }
  const cells = expectArray(
    obj.cells,
    "$.cells",
    MAX_MATRIX_CELLS,
    parseMatrixCellPlanV1,
  );
  return {
    version: MATRIX_PLAN_VERSION,
    kind: "matrix_plan",
    waveId: expectNonEmptyString(obj.waveId, "$.waveId", MAX_ID_CHARS),
    run: parseMatrixRunIdentityV1(obj.run, "$.run"),
    plannedAt: expectTimestamp(obj.plannedAt, "$.plannedAt"),
    cells,
  };
}

export function parseMatrixCellResultV1(input: unknown): MatrixCellResultV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, RESULT_KEYS, "$");
  expectVersion(obj.version, "$.version");
  if (obj.kind !== "matrix_cell_result") {
    fail("$.kind", "invalid_enum", "kind must be matrix_cell_result");
  }
  const status = expectEnum(
    obj.status,
    ["completed", "failed", "not_started"],
    "$.status",
  );
  const receipt = expectNullable(
    obj.receipt,
    "$.receipt",
    parseMatrixModelReceiptV1,
  );
  if (status === "completed" && receipt === null) {
    fail("$.receipt", "missing_field", "a completed result requires a receipt");
  }
  if (status !== "completed" && receipt !== null) {
    fail(
      "$.receipt",
      "invalid_lifecycle",
      "a non-completed result cannot carry a receipt",
    );
  }
  const bundle = expectNullable(
    obj.bundle,
    "$.bundle",
    (value, at) => {
      const item = expectRecord(value, at);
      expectExactKeys(item, BUNDLE_KEYS, at);
      const file = expectPattern(
        item.file,
        `${at}.file`,
        /^[0-9a-f]{64}\.bundle$/,
        "invalid_pattern",
        "expected a 64-hex cell id plus .bundle",
        80,
      );
      return {
        file,
        digest: expectSha256Hex(item.digest, `${at}.digest`),
        head: expectGitSha(item.head, `${at}.head`),
        checkpointSha: expectNullable(
          item.checkpointSha,
          `${at}.checkpointSha`,
          expectGitSha,
        ),
      };
    },
  );
  if (status !== "completed" && bundle !== null) {
    fail(
      "$.bundle",
      "invalid_lifecycle",
      "a non-completed result cannot carry a candidate bundle",
    );
  }
  const candidateHead = receipt?.candidate?.head ?? null;
  if (status === "completed" && candidateHead !== null) {
    if (bundle === null) {
      fail(
        "$.bundle",
        "missing_field",
        "a completed result with a candidate head requires its bundle",
      );
    }
    if (bundle.head !== candidateHead) {
      fail(
        "$.bundle.head",
        "invalid_lifecycle",
        "the bundle must carry the exact receipt candidate head",
      );
    }
    if (bundle.checkpointSha !== (receipt?.candidate?.checkpointSha ?? null)) {
      fail(
        "$.bundle.checkpointSha",
        "invalid_lifecycle",
        "the bundle checkpoint identity must match the receipt",
      );
    }
  }
  const detail = expectNullable(
    obj.detail,
    "$.detail",
    (value, at) => expectString(value, at, MAX_ERROR_CHARS),
  );
  if (status !== "completed" && detail === null) {
    fail(
      "$.detail",
      "missing_field",
      "a non-completed result requires a detail",
    );
  }
  return {
    version: MATRIX_CELL_RESULT_VERSION,
    kind: "matrix_cell_result",
    waveId: expectNonEmptyString(obj.waveId, "$.waveId", MAX_ID_CHARS),
    cellId: expectNonEmptyString(obj.cellId, "$.cellId", MAX_ID_CHARS),
    taskId: expectPattern(
      obj.taskId,
      "$.taskId",
      /^[A-Za-z0-9._:-]{1,256}$/,
      "invalid_pattern",
      "expected a bounded work id",
      MAX_ID_CHARS,
    ) as WorkItemId,
    repository: parseRepositoryIdentity(obj.repository, "$.repository"),
    run: parseMatrixRunIdentityV1(obj.run, "$.run"),
    runtimeSha: expectGitSha(obj.runtimeSha, "$.runtimeSha"),
    generation: expectPositiveInt(obj.generation, "$.generation"),
    reservationId: expectNonEmptyString(
      obj.reservationId,
      "$.reservationId",
      MAX_ID_CHARS,
    ),
    intentKey: expectNonEmptyString(obj.intentKey, "$.intentKey", MAX_ID_CHARS),
    requestDigest: expectNonEmptyString(
      obj.requestDigest,
      "$.requestDigest",
      MAX_ID_CHARS,
    ),
    status,
    receipt,
    bundle,
    detail,
    completedAt: expectTimestamp(obj.completedAt, "$.completedAt"),
  };
}

export function tryParseMatrixPlanV1(
  input: unknown,
): ParseRecordResult<MatrixPlanV1> {
  return tryParse(parseMatrixPlanV1, input);
}

export function tryParseMatrixCellResultV1(
  input: unknown,
): ParseRecordResult<MatrixCellResultV1> {
  return tryParse(parseMatrixCellResultV1, input);
}

export function tryParseMatrixCellGrantV1(
  input: unknown,
): ParseRecordResult<MatrixCellGrantV1> {
  return tryParse((value) => {
    const obj = expectRecord(value, "$");
    expectExactKeys(obj, ["waveId", "run", "cell"], "$");
    return {
      waveId: expectNonEmptyString(obj.waveId, "$.waveId", MAX_ID_CHARS),
      run: parseMatrixRunIdentityV1(obj.run, "$.run"),
      cell: parseMatrixCellPlanV1(obj.cell, "$.cell"),
    };
  }, input);
}
