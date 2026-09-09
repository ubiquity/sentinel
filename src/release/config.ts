/**
 * m05-owned release configuration: the exact target identity, health
 * verification shape, log classification rule and bounded transport limits.
 *
 * This configuration is constructed by the trusted host (Wave C) from
 * RepositoryConfigV1.build.* plus the m05-specific seams. There is no
 * environment variable, CLI flag or secret-literal surface here: credentials
 * are injected through constructor auth providers and never appear in
 * contract records or logs. Every limit below is a private finite constant
 * (or a required configured value); no live threshold is guessed.
 */

import type {
  AcceptanceIdentityV1,
  StabilityPolicyV1,
} from "../contracts/repository-config.ts";
import {
  expectNonEmptyString,
  expectPattern,
  expectPositiveInt,
  expectRecord,
  expectString,
  fail,
  MaxText,
} from "../contracts/validation.ts";

/** Plan-mandated acceptance window: 30 continuous minutes. */
export const RELEASE_WINDOW_MS = 30 * 60 * 1000;
/** Plan-mandated sampling interval: one sample every 30 seconds. */
export const RELEASE_SAMPLE_INTERVAL_MS = 30 * 1000;
/** Samples the plan-mandated window/interval imply. */
export const RELEASE_EXPECTED_SAMPLES = RELEASE_WINDOW_MS /
  RELEASE_SAMPLE_INTERVAL_MS;

/** Default whole-operation deadline for one Deno REST call, in ms. */
export const DENO_DEFAULT_TIMEOUT_MS = 30_000;
/** Hard cap on one REST response body (revision detail/log page), in bytes. */
export const DENO_MAX_RESPONSE_BYTES = 1_048_576;
/** Hard cap on one log page response body, in bytes. */
export const DENO_MAX_LOG_PAGE_BYTES = 1_048_576;
/** Documented maximum page size of the Deno logs API. */
export const DENO_LOGS_PAGE_LIMIT = 1000;
/** Documented maximum page size of the revisions list API. */
export const DENO_REVISIONS_PAGE_LIMIT = 100;
/**
 * Finite cap on revision-list page traversals for one exact membership proof.
 * A pending continuation after this many pages is incomplete traversal, never
 * success; this is a deterministic local implementation bound, not a new
 * environment/CLI surface.
 */
export const DENO_REVISION_TRAVERSAL_MAX_PAGES = 128;
/**
 * Finite cap on one pagination cursor extracted from a rel=next Link header.
 * A larger or empty cursor is rejected before it is used; this is a
 * deterministic local implementation bound, not a new environment/CLI surface.
 */
export const DENO_REVISION_CURSOR_MAX_CHARS = 2048;
/**
 * Finite cap on pagination steps for one window sample. A pending cursor after
 * this many pages is incomplete coverage, never success.
 */
export const DENO_MAX_LOG_PAGES = 256;
/**
 * Finite cap on metric slots collected in one controller run. A larger
 * backlog is an interrupted monitor and restarts the window instead of
 * collecting unbounded work.
 */
export const RELEASE_MAX_SLOTS_PER_RUN = 64;
/** Maximum length of one log message accepted for cohort parsing. */
export const DENO_MAX_LOG_MESSAGE_CHARS = 16384;
/** Maximum characters of a log entry timestamp accepted as RFC3339. */
export const DENO_MAX_LOG_TIMESTAMP_CHARS = 64;
/**
 * Exact release target configuration. Every field is required and validated
 * at construction time; an invalid configuration is a typed fault, never a
 * partially applied release policy.
 */
export interface ReleaseTargetConfigV1 {
  /** Exact Deno Deploy app id or slug for this target. */
  projectId: string;
  /** Deno REST base URL (e.g. https://api.deno.com). */
  apiBaseUrl: string;
  /**
   * Trusted managed host base URL that serves the deployed application. It
   * must be a root HTTPS URL with a hostname ending in `.deno.net` — the
   * actual two-label shape is `<project>.<organization>.deno.net` (e.g.
   * `ai-ubq-fi.ubiquity-dao.deno.net`): the immutable health URL for an exact
   * revision is derived by replacing the FIRST hostname label with
   * `label-<revisionId>` (Deno's immutable hostname form). A generic host has
   * no trusted immutable form and is rejected.
   */
  managedBaseUrl: string;
  /** Custom domain base URL to probe; null when no custom domain exists. */
  customBaseUrl: string | null;
  /**
   * Health verification shape (paths, body marker, managed header values,
   * custom domain) — the foundation acceptance identity.
   */
  acceptance: AcceptanceIdentityV1;
  /**
   * Response header names carrying the exact deployment identity. The values
   * are what the managed deployment reports (Git SHA / Deno revision id), the
   * exact proof of a promotion — never a timestamp or latest list item.
   */
  identityHeaders: { gitSha: string; revisionId: string };
  /**
   * Owner-declared `failure_kind` values classified as timeouts (target
   * telemetry rule; no universal guessing).
   */
  timeoutFailureKinds: string[];
  /**
   * Owner-declared `failure_kind` values classified as upstream-wide faults
   * (target telemetry rule; no universal guessing).
   */
  upstreamWideFailureKinds: string[];
  /**
   * Required minimum source lag before a log window may be sampled, in ms.
   * This is the trusted explicit coverage policy: a window is not due until
   * `windowEnd + logsLagMs <= now`, so missing in-flight telemetry cannot be
   * read as a complete zero-count sample.
   */
  logsLagMs: number;
}

const URL_RE = /^https?:\/\/[^ /]+(?::\d+)?(?:\/[^ ]*)?$/;
/** One DNS hostname label (RFC-952-style, case-insensitive). */
const DNS_LABEL_RE = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
/**
 * Trusted Deno managed hostname: one or more DNS labels before the fixed
 * `.deno.net` root. The actual production target uses the two-label shape
 * (`ai-ubq-fi.ubiquity-dao.deno.net`); any trailing foreign suffix is
 * rejected by the anchored `.deno.net` end.
 */
export const DENO_MANAGED_HOST_RE = new RegExp(
  `^(?:${DNS_LABEL_RE}\\.)+deno\\.net$`,
);

/**
 * Parses one configured base URL and requires a complete root HTTPS URL:
 * scheme https, no credentials, only the default (or no) port, an empty or
 * "/" pathname (the normal optional trailing slash), and no query or
 * fragment. A base with any other component cannot be safely appended to —
 * an immutable URL is derived from it — and is rejected before use.
 */
function parseRootHttpsUrl(value: string, path: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(path, "invalid_pattern", `expected ${label} URL`);
  }
  if (url.protocol !== "https:") {
    fail(path, "invalid_pattern", `expected https ${label} URL`);
  }
  if (url.username !== "" || url.password !== "") {
    fail(path, "invalid_pattern", `expected ${label} URL without credentials`);
  }
  if (url.port !== "") {
    fail(
      path,
      "invalid_pattern",
      `expected ${label} URL without a nondefault port`,
    );
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    fail(path, "invalid_pattern", `expected root ${label} URL without a path`);
  }
  if (url.search !== "" || url.hash !== "") {
    fail(
      path,
      "invalid_pattern",
      `expected ${label} URL without query or fragment`,
    );
  }
  return url;
}

/** Validates and normalizes one release target configuration. */
export function validateReleaseTargetConfig(
  input: unknown,
): ReleaseTargetConfigV1 {
  const obj = expectRecord(input, "$");
  const projectId = expectNonEmptyString(
    obj.projectId,
    "$.projectId",
    MaxText.token,
  );
  const apiBaseUrl = expectPattern(
    obj.apiBaseUrl,
    "$.apiBaseUrl",
    URL_RE,
    "invalid_pattern",
    "expected http(s) API base URL",
    MaxText.url,
  );
  if (!apiBaseUrl.startsWith("https://")) {
    fail(
      "$.apiBaseUrl",
      "invalid_pattern",
      "expected an https API base URL",
    );
  }
  const managedBaseUrl = expectPattern(
    obj.managedBaseUrl,
    "$.managedBaseUrl",
    URL_RE,
    "invalid_pattern",
    "expected http(s) managed base URL",
    MaxText.url,
  );
  {
    const managed = parseRootHttpsUrl(
      managedBaseUrl,
      "$.managedBaseUrl",
      "managed base",
    );
    if (!DENO_MANAGED_HOST_RE.test(managed.hostname)) {
      fail(
        "$.managedBaseUrl",
        "invalid_pattern",
        "expected an https managed host ending in .deno.net",
      );
    }
  }
  const customBaseUrl = obj.customBaseUrl === null ? null : expectPattern(
    obj.customBaseUrl,
    "$.customBaseUrl",
    URL_RE,
    "invalid_pattern",
    "expected http(s) custom base URL or null",
    MaxText.url,
  );

  const acceptanceObj = expectRecord(obj.acceptance, "$.acceptance");
  const acceptance = parseAcceptanceShape(acceptanceObj, "$.acceptance");

  const identityObj = expectRecord(obj.identityHeaders, "$.identityHeaders");
  const identityHeaders = {
    gitSha: expectNonEmptyString(
      identityObj.gitSha,
      "$.identityHeaders.gitSha",
      64,
    ),
    revisionId: expectNonEmptyString(
      identityObj.revisionId,
      "$.identityHeaders.revisionId",
      64,
    ),
  };

  const timeoutFailureKinds = expectLabelSet(
    obj.timeoutFailureKinds,
    "$.timeoutFailureKinds",
  );
  const upstreamWideFailureKinds = expectLabelSet(
    obj.upstreamWideFailureKinds,
    "$.upstreamWideFailureKinds",
  );
  for (const kind of timeoutFailureKinds) {
    if (upstreamWideFailureKinds.includes(kind)) {
      fail(
        "$.timeoutFailureKinds",
        "invalid_lifecycle",
        "a failure kind cannot be both timeout and upstream-wide",
      );
    }
  }

  const logsLagMs = expectPositiveInt(obj.logsLagMs, "$.logsLagMs");

  return {
    projectId,
    apiBaseUrl,
    managedBaseUrl,
    customBaseUrl,
    acceptance,
    identityHeaders,
    timeoutFailureKinds,
    upstreamWideFailureKinds,
    logsLagMs,
  };
}

/**
 * Strict acceptance-shape validation (module-local copy of the foundation
 * AcceptanceIdentityV1 rules; the contract parser is not exported for this
 * fragment, so the module validates the fields it consumes).
 */
function parseAcceptanceShape(
  obj: Record<string, unknown>,
  path: string,
): AcceptanceIdentityV1 {
  for (const key of ["healthPath", "metricsPath"]) {
    expectPattern(
      obj[key],
      `${path}.${key}`,
      /^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,254})?$/,
      "invalid_pattern",
      "expected absolute endpoint path",
      MaxText.path,
    );
  }
  const managedBodyMarker = expectNonEmptyString(
    obj.managedBodyMarker,
    `${path}.managedBodyMarker`,
    MaxText.message,
  );
  if (!Array.isArray(obj.managedHeaders) || obj.managedHeaders.length > 16) {
    fail(
      `${path}.managedHeaders`,
      "bound_exceeded",
      "expected 0-16 managed header entries",
    );
  }
  const managedHeaders = obj.managedHeaders.map(
    (entry: unknown, index: number): { name: string; value: string } => {
      const header = expectRecord(entry, `${path}.managedHeaders[${index}]`);
      return {
        name: expectNonEmptyString(
          header.name,
          `${path}.managedHeaders[${index}].name`,
          MaxText.headerName,
        ),
        value: expectNonEmptyString(
          header.value,
          `${path}.managedHeaders[${index}].value`,
          MaxText.headerValue,
        ),
      };
    },
  );
  const domain = obj.domain === null
    ? null
    : expectNonEmptyString(obj.domain, `${path}.domain`, MaxText.url);
  return {
    healthPath: obj.healthPath as string,
    metricsPath: obj.metricsPath as string,
    managedBodyMarker,
    managedHeaders,
    domain,
  };
}

function expectLabelSet(input: unknown, path: string): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 32) {
    fail(path, "bound_exceeded", "expected 1-32 failure kinds");
  }
  const seen = new Set<string>();
  return input.map((value: unknown) => {
    const text = expectString(value, path, 64);
    if (seen.has(text)) {
      fail(path, "invalid_lifecycle", "duplicate failure kind");
    }
    seen.add(text);
    return text;
  });
}

export type StabilityPolicyCheckV1 =
  | { ok: true }
  | { ok: false; detail: string };

/**
 * Compatibility check for the enabled owner stability policy. The plan
 * mandates a 30-minute window with 30-second samples; an enabled policy that
 * configures any other window/interval, or whose minimums cannot be met by
 * that schedule, is incompatible and rejected before any release action.
 * No live threshold is guessed: every rate/limit comes from the policy.
 */
export function validateStabilityPolicy(
  policy: StabilityPolicyV1 | null,
): StabilityPolicyCheckV1 {
  if (policy === null) {
    return {
      ok: false,
      detail: "release stability policy is not enabled",
    };
  }
  if (policy.windowMs !== RELEASE_WINDOW_MS) {
    return {
      ok: false,
      detail: `release window must be ${RELEASE_WINDOW_MS}ms`,
    };
  }
  if (policy.sampleIntervalMs !== RELEASE_SAMPLE_INTERVAL_MS) {
    return {
      ok: false,
      detail: `release sample interval must be ${RELEASE_SAMPLE_INTERVAL_MS}ms`,
    };
  }
  const expectedSamples = RELEASE_WINDOW_MS / RELEASE_SAMPLE_INTERVAL_MS;
  if (
    policy.minSamples !== expectedSamples ||
    policy.minSamples <= 0
  ) {
    return {
      ok: false,
      detail: `release minSamples must be exactly ${expectedSamples}`,
    };
  }
  if (
    policy.baselineWindowMs <= 0 ||
    policy.baselineWindowMs % RELEASE_SAMPLE_INTERVAL_MS !== 0 ||
    policy.baselineWindowMs / RELEASE_SAMPLE_INTERVAL_MS !==
      policy.baselineMinSamples
  ) {
    return {
      ok: false,
      detail:
        "baseline window must be aligned to 30s samples with baselineMinSamples equal to the slot count",
    };
  }
  for (const threshold of policy.thresholds) {
    if (threshold.maxRate < 0 || threshold.maxRate > 1) {
      return { ok: false, detail: "threshold maxRate must be in [0,1]" };
    }
    if (threshold.maxIncrease < 0 || threshold.maxIncrease > 1) {
      return { ok: false, detail: "threshold maxIncrease must be in [0,1]" };
    }
  }
  return { ok: true };
}
