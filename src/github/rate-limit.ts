/**
 * GitHub rate-limit response classifier.
 *
 * Classification idea adapted from Octokit's plugin-throttling.js (pinned
 * commit eb4215edcd97f20ade800b18d964bf798e0d70b7, src/index.ts); the
 * implementation here is original to this project.
 *
 * Fail-closed contract (mirrors the GitHub cooldown contract): a null
 * `retryNotBefore` is an explicit manual fail-closed state — missing or
 * unrepresentable server deadline — and never a fallback; `fallback` is true
 * only for a confirmed secondary limit without a usable server hint, using
 * the bounded one-minute backoff.
 */

import {
  GITHUB_FALLBACK_MIN_BACKOFF_MS,
  type GitHubRateLimitV1,
  parseGitHubRateLimitV1,
} from "../contracts/github-cooldown.ts";
import type { HttpResponseV1 } from "./http.ts";

/** Header carrying GitHub's per-request correlation id. */
const GITHUB_REQUEST_ID_HEADER = "x-github-request-id";

/** Marker patterns GitHub emits for bounded secondary limits. */
const SECONDARY_MARKER = /secondary rate limit|abuse detection mechanism/i;

/** Strict nonnegative decimal integer grammar (no sign, fraction, exponent). */
const DECIMAL_INTEGER = /^[0-9]+$/;

/** Bound on the response body text inspected for the secondary marker. */
const MAX_BODY_CHARS = 64 * 1024;

const HTTP_DATE_WEEKDAY = "Mon|Tue|Wed|Thu|Fri|Sat|Sun";
const HTTP_DATE_WEEKDAY_FULL =
  "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday";
const HTTP_DATE_MONTH = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";

/**
 * Recognizable HTTP-date grammars before `Date.parse` is allowed: IMF-fixdate,
 * obsolete RFC-850 and asctime forms (RFC 9110 §5.6.7). Arbitrary numeric
 * strings never reach `Date.parse`, so they are never read as dates.
 */
const HTTP_DATE = new RegExp(
  "^(?:" +
    `(?:${HTTP_DATE_WEEKDAY}), \\d{2} (?:${HTTP_DATE_MONTH}) \\d{4} ` +
    `\\d{2}:\\d{2}:\\d{2} GMT` +
    "|" +
    `(?:${HTTP_DATE_WEEKDAY_FULL}), \\d{2}-(?:${HTTP_DATE_MONTH})-\\d{2} ` +
    `\\d{2}:\\d{2}:\\d{2} GMT` +
    "|" +
    `(?:${HTTP_DATE_WEEKDAY}) (?:${HTTP_DATE_MONTH}) (?:[0-3]\\d| \\d) ` +
    `\\d{2}:\\d{2}:\\d{2} \\d{4}` +
    ")$",
);

/** Outcome of evaluating one server hint header. */
type HintResult =
  | { kind: "valid"; deadline: number }
  | { kind: "malformed" }
  | { kind: "unrepresentable" };

/**
 * Classify one GitHub rate-limit response, or return null when it is not a
 * rate-limit observation (any status other than 403/429, or a generic 403).
 *
 * `observedAt` must be a safe nonnegative integer (epoch ms); an invalid
 * clock is rejected synchronously with a TypeError, never retried or
 * tolerated. Only the observation sha256 is returned — no body, header or
 * request-id value ever escapes this function.
 */
export async function classifyGitHubRateLimit(
  response: HttpResponseV1,
  observedAt: number,
): Promise<GitHubRateLimitV1 | null> {
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
    throw new TypeError("observedAt must be a safe nonnegative integer");
  }

  if (response.status !== 403 && response.status !== 429) return null;

  const header = (name: string): string | null => {
    const raw = response.headers.get(name);
    if (raw === null) return null;
    const trimmed = raw.trim();
    return trimmed === "" ? null : trimmed;
  };

  const remaining = header("x-ratelimit-remaining");
  const retryAfter = header("retry-after");
  const reset = header("x-ratelimit-reset");
  const requestId = header(GITHUB_REQUEST_ID_HEADER) ?? header("x-request-id");

  const primary = remaining !== null && remainingIsZero(remaining);

  let kind: GitHubRateLimitV1["kind"];
  if (primary) {
    kind = "primary";
  } else if (response.status === 429) {
    kind = "secondary";
  } else {
    const body = response.bodyText.slice(0, MAX_BODY_CHARS);
    if (!SECONDARY_MARKER.test(body)) return null;
    kind = "secondary";
  }

  const hints: HintResult[] = [];
  if (retryAfter !== null) hints.push(evalRetryAfter(retryAfter, observedAt));
  if (primary && reset !== null) hints.push(evalEpochSeconds(reset));

  let retryNotBefore: number | null = null;
  let fallback = false;

  if (hints.some((hint) => hint.kind === "unrepresentable")) {
    // A syntactically valid hint outside the safe range overrides every other
    // hint: a server deadline is never clamped to fit representable limits.
  } else {
    const deadlines: number[] = [];
    for (const hint of hints) {
      if (hint.kind === "valid") deadlines.push(hint.deadline);
    }
    if (deadlines.length > 0) {
      retryNotBefore = Math.max(observedAt, ...deadlines);
    } else if (kind === "secondary") {
      const fallbackDeadline = observedAt + GITHUB_FALLBACK_MIN_BACKOFF_MS;
      if (Number.isSafeInteger(fallbackDeadline)) {
        retryNotBefore = fallbackDeadline;
        fallback = true;
      }
      // An overflowing fallback deadline stays manual (null, fallback false).
    }
  }

  const observationId = await observationIdFor(
    response.status,
    observedAt,
    [retryAfter, reset],
    requestId,
  );

  return parseGitHubRateLimitV1({
    kind,
    observedAt,
    retryNotBefore,
    observationId,
    fallback,
  });
}

/** True iff the remaining-count header is exactly the decimal value 0. */
function remainingIsZero(value: string): boolean {
  if (!DECIMAL_INTEGER.test(value)) return false;
  const remaining = Number(value);
  return Number.isSafeInteger(remaining) && remaining === 0;
}

/**
 * Evaluate a Retry-After value: nonnegative integer seconds (a delta from
 * `observedAt`) or a recognizable HTTP-date (absolute deadline). Strict
 * decimal grammar only; no floating coercion.
 */
function evalRetryAfter(value: string, observedAt: number): HintResult {
  if (DECIMAL_INTEGER.test(value)) {
    return evalSecondsDelta(value, observedAt);
  }
  if (HTTP_DATE.test(value)) {
    const deadline = Date.parse(value);
    if (Number.isNaN(deadline)) return { kind: "malformed" };
    if (!Number.isSafeInteger(deadline)) {
      return { kind: "unrepresentable" };
    }
    return { kind: "valid", deadline };
  }
  return { kind: "malformed" };
}

/** Evaluate a strict decimal seconds delta; huge values are unrepresentable. */
function evalSecondsDelta(value: string, observedAt: number): HintResult {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) return { kind: "unrepresentable" };
  const deadline = seconds * 1000 + observedAt;
  if (!Number.isSafeInteger(deadline)) return { kind: "unrepresentable" };
  return { kind: "valid", deadline };
}

/** Evaluate a GitHub `x-ratelimit-reset` epoch-seconds value. */
function evalEpochSeconds(value: string): HintResult {
  if (!DECIMAL_INTEGER.test(value)) return { kind: "malformed" };
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) return { kind: "unrepresentable" };
  const deadline = seconds * 1000;
  if (!Number.isSafeInteger(deadline)) return { kind: "unrepresentable" };
  return { kind: "valid", deadline };
}

/**
 * SHA-256 observation identity over the sanitized fixed shape
 * `{ status, observedAt, hints, requestId }`. The response body (including the
 * marker text) is never part of the identity, and only the resulting hash is
 * ever returned.
 */
async function observationIdFor(
  status: number,
  observedAt: number,
  hints: [string | null, string | null],
  requestId: string | null,
): Promise<string> {
  const identity = JSON.stringify({ status, observedAt, hints, requestId });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identity),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
