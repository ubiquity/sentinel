/**
 * Fail-closed validation core.
 *
 * Every record parser below is built only from these primitives. The invariant
 * is: nothing is coerced. A string is accepted only where a string is expected,
 * an integer where an integer is expected, an explicit `null` only where the
 * field is declared nullable, and unknown keys are rejected. The first
 * violation aborts the parse with a typed `RecordParseError`.
 */

import { isGitSha } from "./brands.ts";
import type { CommandId, GitSha, Version1 } from "./brands.ts";

/** Every text field is bounded; these are the per-domain bounds. */
export const MaxText: {
  owner: number;
  name: number;
  login: number;
  label: number;
  branch: number;
  ref: number;
  path: number;
  url: number;
  recordId: number;
  token: number;
  message: number;
  summary: number;
  context: number;
  body: number;
  detail: number;
  env: number;
  headerName: number;
  headerValue: number;
  contentType: number;
  base64MaxChars: number;
  arg: number;
  executable: number;
} = {
  owner: 39,
  name: 100,
  login: 128,
  label: 64,
  branch: 256,
  ref: 512,
  path: 512,
  url: 1024,
  recordId: 256,
  token: 256,
  message: 2048,
  summary: 4096,
  context: 8192,
  body: 16384,
  detail: 4096,
  env: 64,
  headerName: 128,
  headerValue: 512,
  contentType: 128,
  base64MaxChars: Math.ceil((4 * 1024 * 1024) / 3) * 4,
  arg: 1024,
  executable: 256,
};

/** Every array field is bounded; these are the per-domain bounds. */
export const MaxItems: {
  protectedPaths: number;
  findings: number;
  evidenceRefs: number;
  artifacts: number;
  checks: number;
  thresholds: number;
  contextLines: number;
  contextLineChars: number;
  testIds: number;
  managedHeaders: number;
  limitations: number;
  snapshotRecords: number;
  changedPaths: number;
  incidentRefs: number;
  commandArgs: number;
  metricsSamples: number;
  dependencies: number;
  resolutionEvidence: number;
} = {
  protectedPaths: 512,
  findings: 256,
  evidenceRefs: 64,
  artifacts: 16,
  checks: 128,
  thresholds: 8,
  contextLines: 8,
  contextLineChars: 1024,
  testIds: 64,
  managedHeaders: 16,
  limitations: 16,
  snapshotRecords: 2048,
  changedPaths: 256,
  incidentRefs: 64,
  commandArgs: 32,
  metricsSamples: 4096,
  dependencies: 64,
  resolutionEvidence: 16,
};

export type ParseIssueCode =
  | "unknown_key"
  | "missing_field"
  | "wrong_type"
  | "invalid_enum"
  | "invalid_version"
  | "invalid_sha"
  | "invalid_digest"
  | "invalid_pattern"
  | "bound_exceeded"
  | "invalid_number"
  | "invalid_timestamp"
  | "invalid_count"
  | "invalid_boolean"
  | "invalid_nullability"
  | "invalid_base64"
  | "invalid_lifecycle"
  | "invalid_array"
  | "invalid_value";

export interface ParseIssue {
  path: string;
  code: ParseIssueCode;
  message: string;
}

export class RecordParseError extends Error {
  readonly issues: readonly ParseIssue[];

  constructor(issues: readonly ParseIssue[]) {
    const first = issues[0];
    super(
      `contract validation failed at ${first?.path ?? "$"}: ${
        first?.message ?? "invalid record"
      }`,
    );
    this.name = "RecordParseError";
    this.issues = issues;
  }
}

export type ParseRecordResult<T> = { ok: true; value: T } | {
  ok: false;
  issues: ParseIssue[];
};

/** Run a parser, converting its fail-closed rejection into a result value. */
export function tryParse<T>(
  parser: (input: unknown) => T,
  input: unknown,
): ParseRecordResult<T> {
  try {
    return { ok: true, value: parser(input) };
  } catch (error) {
    if (error instanceof RecordParseError) {
      return { ok: false, issues: [...error.issues] };
    }
    throw error;
  }
}

export function fail(
  path: string,
  code: ParseIssueCode,
  message: string,
): never {
  throw new RecordParseError([{ path, code, message }]);
}

/** A record must be a non-null, non-array plain object. */
export function expectRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "wrong_type", `expected object, got ${describe(value)}`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail(path, "wrong_type", "expected plain object");
  }
  return value as Record<string, unknown>;
}

/**
 * Reject unknown keys and report missing required keys. Presence means the
 * key exists with a defined value; JSON cannot represent undefined, so an
 * injected `undefined` counts as missing (never as an explicit null).
 */
export function expectExactKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const known = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      fail(`${path}.${key}`, "unknown_key", "unknown key");
    }
  }
  for (const key of allowed) {
    if (
      !Object.prototype.hasOwnProperty.call(obj, key) || obj[key] === undefined
    ) {
      fail(`${path}.${key}`, "missing_field", `missing required key "${key}"`);
    }
  }
}

export function expectString(
  value: unknown,
  path: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    fail(path, "wrong_type", `expected string, got ${describe(value)}`);
  }
  if (value.length > maxLength) {
    fail(
      path,
      "bound_exceeded",
      `string of ${value.length} chars exceeds ${maxLength}`,
    );
  }
  return value;
}

export function expectNonEmptyString(
  value: unknown,
  path: string,
  maxLength: number,
): string {
  const text = expectString(value, path, maxLength);
  if (text.length === 0) {
    fail(path, "invalid_pattern", "expected non-empty string");
  }
  return text;
}

/** Strings must match an explicit pattern; no coercion or trimming. */
export function expectPattern(
  value: unknown,
  path: string,
  pattern: RegExp,
  code: "invalid_pattern" | "invalid_sha" | "invalid_digest",
  message: string,
  maxLength: number,
): string {
  const text = expectString(value, path, maxLength);
  if (!pattern.test(text)) fail(path, code, message);
  return text;
}

export function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    fail(path, "invalid_boolean", `expected boolean, got ${describe(value)}`);
  }
  return value;
}

/** Nonnegative safe integer (counts, sequence numbers, page sizes). */
export function expectCount(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(
      path,
      "invalid_count",
      `expected nonnegative safe integer, got ${describe(value)}`,
    );
  }
  return value;
}

/** Positive safe integer (durations, sample counts, byte limits). */
export function expectPositiveInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail(
      path,
      "invalid_count",
      `expected positive safe integer, got ${describe(value)}`,
    );
  }
  return value;
}

/** Millisecond epoch timestamp: finite nonnegative safe integer; no coercion from strings. */
export function expectTimestamp(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(
      path,
      "invalid_timestamp",
      `expected nonnegative integer timestamp, got ${describe(value)}`,
    );
  }
  return value;
}

/** Finite JSON number (rates/probabilities); rejects NaN/Infinity and strings. */
export function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(
      path,
      "invalid_number",
      `expected finite number, got ${describe(value)}`,
    );
  }
  return value;
}

/** Rate in the inclusive 0..1 range. */
export function expectRate(value: unknown, path: string): number {
  const number = expectFiniteNumber(value, path);
  if (number < 0 || number > 1) {
    fail(
      path,
      "invalid_value",
      `expected rate in [0,1], got ${describe(value)}`,
    );
  }
  return number;
}

/** Exact enum membership; no case folding or string coercion. */
export function expectEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(
      path,
      "invalid_enum",
      `expected one of ${allowed.map((v) => `"${v}"`).join(", ")}, got ${
        describe(value)
      }`,
    );
  }
  return value as T;
}

export function expectVersion(value: unknown, path: string): Version1 {
  if (value !== "v1") {
    fail(
      path,
      "invalid_version",
      `expected version "v1", got ${describe(value)}`,
    );
  }
  return "v1";
}

export function expectGitSha(value: unknown, path: string): GitSha {
  if (!isGitSha(value)) {
    fail(
      path,
      "invalid_sha",
      `expected full 40-hex commit SHA, got ${describe(value)}`,
    );
  }
  return value;
}

/** 64 lowercase hex chars; the caller applies the exact digest brand. */
export function expectSha256Hex(value: unknown, path: string): string {
  const text = expectString(value, path, 64);
  if (!/^[0-9a-f]{64}$/.test(text)) {
    fail(
      path,
      "invalid_digest",
      `expected full 64-hex SHA-256 digest, got ${describe(text)}`,
    );
  }
  return text;
}

export function expectCommandId(value: unknown, path: string): CommandId {
  const text = expectPattern(
    value,
    path,
    /^[a-z][a-z0-9_]{0,63}$/,
    "invalid_pattern",
    "expected command id matching ^[a-z][a-z0-9_]{0,63}$",
    MaxText.token,
  );
  return text as CommandId;
}

/**
 * Explicit nullability: the key must exist (checked by expectExactKeys), and
 * `null` is the only null representation; undefined and other values are
 * rejected by the inner parser.
 */
export function expectNullable<T>(
  value: unknown,
  path: string,
  parse: (value: unknown, path: string) => T,
): T | null {
  if (value === null) return null;
  if (value === undefined) {
    fail(
      path,
      "invalid_nullability",
      `expected explicit null or value, got undefined`,
    );
  }
  return parse(value, path);
}

export function expectNullableString(
  value: unknown,
  path: string,
  maxLength: number,
): string | null {
  return expectNullable(value, path, (v, p) => expectString(v, p, maxLength));
}

export function expectNullableNonEmptyString(
  value: unknown,
  path: string,
  maxLength: number,
): string | null {
  return expectNullable(
    value,
    path,
    (v, p) => expectNonEmptyString(v, p, maxLength),
  );
}

export function expectArray<T>(
  value: unknown,
  path: string,
  maxItems: number,
  parseItem: (value: unknown, path: string) => T,
): T[] {
  if (!Array.isArray(value)) {
    fail(path, "wrong_type", `expected array, got ${describe(value)}`);
  }
  if (value.length > maxItems) {
    fail(
      path,
      "bound_exceeded",
      `array of ${value.length} items exceeds ${maxItems}`,
    );
  }
  // Sparse arrays are rejected: mapping would silently skip holes and
  // downstream JSON would turn them into nulls, colliding with real values.
  for (let i = 0; i < value.length; i++) {
    if (!(i in value)) {
      fail(path, "invalid_array", `sparse array (hole at index ${i})`);
    }
  }
  return value.map((item, index) => parseItem(item, `${path}[${index}]`));
}

export function expectStringArray(
  value: unknown,
  path: string,
  maxItems: number,
  maxChars: number,
): string[] {
  return expectArray(
    value,
    path,
    maxItems,
    (item, itemPath) => expectNonEmptyString(item, itemPath, maxChars),
  );
}

/** Canonical base64: 4-char groups, standard alphabet, correct padding. */
export function expectCanonicalBase64(
  value: unknown,
  path: string,
  maxChars: number,
): string {
  const text = expectString(value, path, maxChars);
  const canonical =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      text,
    );
  if (!canonical || text.length % 4 !== 0) {
    fail(
      path,
      "invalid_base64",
      "expected canonical base64 with standard alphabet and padding",
    );
  }
  return text;
}

/**
 * Type/length-only description of an invalid input. Parse error messages must
 * never echo input values (which may be arbitrary secrets); they report the
 * path, code and shape/length only.
 */
export function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array of length ${value.length}`;
  switch (typeof value) {
    case "string":
      return `string of length ${value.length}`;
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "undefined":
      return "undefined";
    case "symbol":
      return "symbol";
    case "function":
      return "function";
    case "bigint":
      return "bigint";
    default:
      return typeof value;
  }
}

function describe(value: unknown): string {
  return describeValue(value);
}
