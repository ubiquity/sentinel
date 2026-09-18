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

const RFC850_DATE = new RegExp(
  `^(${HTTP_DATE_WEEKDAY_FULL}), (\\d{2})-(${HTTP_DATE_MONTH})-(\\d{2}) ` +
    `(\\d{2}):(\\d{2}):(\\d{2}) GMT$`,
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
    return parseHttpDate(value, observedAt);
  }
  return { kind: "malformed" };
}

/**
 * Parse HTTP-date, resolving obsolete RFC-850 years relative to observedAt.
 * A past current-century interpretation stays past; only an interpretation
 * more than 50 years ahead is moved back by one century.
 */
function parseHttpDate(value: string, observedAt: number): HintResult {
  const match = RFC850_DATE.exec(value);
  if (match === null) {
    const deadline = Date.parse(value);
    if (Number.isNaN(deadline)) return { kind: "malformed" };
    if (!Number.isSafeInteger(deadline)) return { kind: "unrepresentable" };
    return { kind: "valid", deadline };
  }

  const observedDate = new Date(observedAt);
  // Date's range is narrower than the classifier's accepted safe-integer
  // range. A valid hint outside Date's range is unrepresentable, not malformed
  // (and must not enable the secondary fallback).
  if (Number.isNaN(observedDate.getTime())) {
    return { kind: "unrepresentable" };
  }

  const observedYear = observedDate.getUTCFullYear();
  const [, weekday, day, month, year, hours, minutes, seconds] = match;
  const baseYear = Math.floor(observedYear / 100) * 100 + Number(year);
  const monthIndex = HTTP_DATE_MONTH.split("|").indexOf(month);
  const dayNumber = Number(day);
  const hourNumber = Number(hours);
  const minuteNumber = Number(minutes);
  const secondNumber = Number(seconds);
  const parseYear = (candidateYear: number): number =>
    Date.parse(
      `${weekday}, ${day}-${month}-${candidateYear} ` +
        `${hours}:${minutes}:${seconds} GMT`,
    );
  const baseDeadline = parseYear(baseYear);
  if (
    Number.isNaN(baseDeadline) &&
    !isValidDateParts(
      baseYear,
      monthIndex,
      dayNumber,
      hourNumber,
      minuteNumber,
      secondNumber,
    )
  ) {
    return { kind: "malformed" };
  }

  const deadlineYear = isMoreThanFiftyYearsAhead(
      baseYear,
      monthIndex,
      dayNumber,
      hourNumber,
      minuteNumber,
      secondNumber,
      observedDate,
    )
    ? baseYear - 100
    : baseYear;
  const deadline = deadlineYear === baseYear
    ? baseDeadline
    : parseYear(deadlineYear);
  if (Number.isNaN(deadline)) {
    return isValidDateParts(
        deadlineYear,
        monthIndex,
        dayNumber,
        hourNumber,
        minuteNumber,
        secondNumber,
      )
      ? { kind: "unrepresentable" }
      : { kind: "malformed" };
  }

  if (!Number.isSafeInteger(deadline)) return { kind: "unrepresentable" };
  return { kind: "valid", deadline };
}

/** Compare an RFC-850 candidate with the observation plus fifty calendar years. */
function isMoreThanFiftyYearsAhead(
  candidateYear: number,
  candidateMonth: number,
  candidateDay: number,
  candidateHours: number,
  candidateMinutes: number,
  candidateSeconds: number,
  observedDate: Date,
): boolean {
  const cutoffYear = observedDate.getUTCFullYear() + 50;
  if (candidateYear !== cutoffYear) return candidateYear > cutoffYear;

  const candidateParts = [
    candidateMonth,
    candidateDay,
    candidateHours,
    candidateMinutes,
    candidateSeconds,
    0,
  ];
  const observedParts = [
    observedDate.getUTCMonth(),
    observedDate.getUTCDate(),
    observedDate.getUTCHours(),
    observedDate.getUTCMinutes(),
    observedDate.getUTCSeconds(),
    observedDate.getUTCMilliseconds(),
  ];
  for (let i = 0; i < candidateParts.length; i++) {
    if (candidateParts[i] !== observedParts[i]) {
      return candidateParts[i] > observedParts[i];
    }
  }
  return false;
}

/** Distinguish an invalid calendar date from a valid date outside Date's range. */
function isValidDateParts(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  seconds: number,
): boolean {
  if (
    month < 0 ||
    day < 1 ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 59
  ) {
    return false;
  }
  const daysInMonth = [
    31,
    (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month];
  return daysInMonth !== undefined && day <= daysInMonth;
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
