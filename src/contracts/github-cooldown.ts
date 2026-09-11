/**
 * GitHub rate-limit observation and durable cooldown fragments (Octokit-derived
 * slice). The observed classification is carried as strict structured
 * metadata — never hidden inside error strings — and the durable cooldown
 * fragment persisted on the repair state branch is a plain data record with no
 * version/kind fields (the enclosing snapshot carries the version).
 *
 * Fail-closed rules: `retryNotBefore: null` explicitly means no trustworthy
 * server deadline is available (manual fail-closed or unrepresentable value);
 * it is never a fallback computation and never means "retry now". `fallback`
 * is true only when a bounded fallback deadline was computed for a confirmed
 * secondary limit without a usable server hint.
 */

import {
  describeValue,
  expectBoolean,
  expectEnum,
  expectExactKeys,
  expectRecord,
  expectSha256Hex,
  expectTimestamp,
  fail,
} from "./validation.ts";

export type GitHubRateLimitKindV1 = "primary" | "secondary";

/**
 * One observed authenticated GitHub rate-limit response. `observedAt` is the
 * moment the limit was observed and the nonnull `retryNotBefore` is the
 * deadline honored from applicable server hints, never clamped earlier to fit
 * a run. A generic authorization denial is not a rate limit and is never
 * represented by this record.
 */
export interface GitHubRateLimitV1 {
  kind: GitHubRateLimitKindV1;
  /** When the rate-limit response was observed; nonnegative integer ms. */
  observedAt: number;
  /**
   * Earliest time a request may be retried; null explicitly means the server
   * deadline is missing/unrepresentable (manual fail-closed), never fallback.
   * When present it must not precede `observedAt`.
   */
  retryNotBefore: number | null;
  /** Exact observation identity: 64 lowercase hex chars. */
  observationId: string;
  /**
   * True only for a confirmed secondary limit whose deadline was computed by
   * the bounded fallback policy: finite, at least 60 000 ms after
   * `observedAt`. Never true for primary limits or null deadlines.
   */
  fallback: boolean;
}

const RATE_LIMIT_KEYS = [
  "kind",
  "observedAt",
  "retryNotBefore",
  "observationId",
  "fallback",
] as const;

/** Minimum secondary-limit fallback backoff (GitHub-documented one minute). */
export const GITHUB_FALLBACK_MIN_BACKOFF_MS = 60_000;

export function parseGitHubRateLimitV1(input: unknown): GitHubRateLimitV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, RATE_LIMIT_KEYS, "$");
  const kind = expectEnum(obj.kind, ["primary", "secondary"], "$.kind");
  const observedAt = expectTimestamp(obj.observedAt, "$.observedAt");
  const retryNotBefore = expectNullableTimestamp(
    obj.retryNotBefore,
    "$.retryNotBefore",
  );
  if (retryNotBefore !== null && retryNotBefore < observedAt) {
    fail(
      "$.retryNotBefore",
      "invalid_lifecycle",
      "retry-not-before cannot precede the observation time",
    );
  }
  const observationId = expectSha256Hex(obj.observationId, "$.observationId");
  const fallback = expectBoolean(obj.fallback, "$.fallback");
  if (fallback) {
    if (
      kind !== "secondary" || retryNotBefore === null ||
      retryNotBefore < observedAt + GITHUB_FALLBACK_MIN_BACKOFF_MS
    ) {
      fail(
        "$.fallback",
        "invalid_lifecycle",
        "fallback requires a secondary limit with a finite deadline at least 60s after the observation",
      );
    }
  }
  return { kind, observedAt, retryNotBefore, observationId, fallback };
}

/**
 * Durable GitHub cooldown fragment. Deliberately carries no version/kind
 * fields: it is a data record inside the versioned repair snapshot, never a
 * self-describing envelope. `retryNotBefore: null` is the durable manual
 * fail-closed state and must survive as an explicit null, never be silently
 * converted to a deadline.
 */
export interface GitHubCooldownV1 {
  /**
   * Affected GitHub installation scope; positive safe integers are App
   * installations and 0 is the explicit no-App local owner scope.
   */
  installationId: number;
  /** Earliest allowed request time; null means manual fail-closed hold. */
  retryNotBefore: number | null;
  /** When the cooldown was recorded; nonnegative integer ms. */
  observedAt: number;
  /** Origin observation identity: 64 lowercase hex chars. */
  observationId: string;
  /** Bounded fallback backoff index used (0 = server hint, 1..10 = fallback). */
  secondaryBackoff: number;
}

const COOLDOWN_KEYS = [
  "installationId",
  "retryNotBefore",
  "observedAt",
  "observationId",
  "secondaryBackoff",
] as const;

export function parseGitHubCooldownV1(input: unknown): GitHubCooldownV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, COOLDOWN_KEYS, "$");
  const installationId = expectInstallationId(
    obj.installationId,
    "$.installationId",
  );
  const retryNotBefore = expectNullableTimestamp(
    obj.retryNotBefore,
    "$.retryNotBefore",
  );
  const observedAt = expectTimestamp(obj.observedAt, "$.observedAt");
  if (retryNotBefore !== null && retryNotBefore < observedAt) {
    fail(
      "$.retryNotBefore",
      "invalid_lifecycle",
      "retry-not-before cannot precede the observation time",
    );
  }
  const observationId = expectSha256Hex(obj.observationId, "$.observationId");
  const secondaryBackoff = expectBackoffIndex(
    obj.secondaryBackoff,
    "$.secondaryBackoff",
  );
  return {
    installationId,
    retryNotBefore,
    observedAt,
    observationId,
    secondaryBackoff,
  };
}

/**
 * Installation scope: 0 is the explicit no-App local owner scope; positive
 * safe integers are GitHub App installation ids.
 */
function expectInstallationId(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(
      path,
      "invalid_count",
      `expected nonnegative safe installation id, got ${describeValue(value)}`,
    );
  }
  return value;
}

function expectNullableTimestamp(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (value === undefined) {
    fail(
      path,
      "invalid_nullability",
      "expected explicit null or value, got undefined",
    );
  }
  return expectTimestamp(value, path);
}

/** Fallback backoff index: a safe integer in the inclusive 0..10 range. */
function expectBackoffIndex(value: unknown, path: string): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 ||
    value > 10
  ) {
    fail(
      path,
      "invalid_count",
      `expected safe integer in 0..10, got ${describeValue(value)}`,
    );
  }
  return value;
}
