/**
 * Shared contract fragments: severities, record kind discriminants, repository
 * identity, evidence references and inherent coverage status.
 */

import { asEncryptedArtifactDigest, asFixtureDigest } from "./brands.ts";
import type {
  EncryptedArtifactDigest,
  FixtureDigest,
  GitSha,
} from "./brands.ts";
import {
  describeValue,
  expectArray,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectNullableString,
  expectPattern,
  expectRecord,
  expectSha256Hex,
  expectString,
  fail,
  MaxText,
} from "./validation.ts";

export type SeverityV1 = "P0" | "P1" | "P2" | "P3";
export const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;

export type RecordKindV1 =
  | "repository_config"
  | "work"
  | "incident_summary"
  | "incident_evidence"
  | "review_receipt"
  | "budget_reservation"
  | "replay_result"
  | "release_request"
  | "release_record"
  | "repair_state_snapshot"
  | "release_state_snapshot";

/** Repository identity plus the GitHub App installation reference. */
export interface RepositoryIdentityV1 {
  owner: string;
  name: string;
  installationId: number;
}

const REPOSITORY_IDENTITY_KEYS = ["owner", "name", "installationId"] as const;

export function parseRepositoryIdentity(
  input: unknown,
  path: string,
): RepositoryIdentityV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, REPOSITORY_IDENTITY_KEYS, path);
  const owner = expectPattern(
    obj.owner,
    `${path}.owner`,
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/,
    "invalid_pattern",
    "expected GitHub owner (1-39 chars, letters/digits/hyphens)",
    MaxText.owner,
  );
  const name = expectPattern(
    obj.name,
    `${path}.name`,
    /^[A-Za-z0-9._-]{1,100}$/,
    "invalid_pattern",
    "expected GitHub repository name",
    MaxText.name,
  );
  const installationId = expectPositiveInstallationId(
    obj.installationId,
    `${path}.installationId`,
  );
  return { owner, name, installationId };
}

/** GitHub App installation ids are positive integers; 0 is not a valid id. */
function expectPositiveInstallationId(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail(
      path,
      "invalid_count",
      `expected positive installation id, got ${describeValue(value)}`,
    );
  }
  return value;
}

/**
 * Exact Deno deployment identity: the Git SHA and the deployment's own
 * revision id are distinct values that must both be preserved together.
 * `revisionId` is never an arbitrary revision choice; it is the identity the
 * platform reported for the exact Git SHA.
 */
export interface DeploymentIdentityV1 {
  gitSha: GitSha;
  /** Exact platform deployment id (e.g. Deno revision id). */
  revisionId: string;
}

const DEPLOYMENT_IDENTITY_KEYS = ["gitSha", "revisionId"] as const;

export function parseDeploymentIdentity(
  input: unknown,
  path: string,
): DeploymentIdentityV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, DEPLOYMENT_IDENTITY_KEYS, path);
  return {
    gitSha: expectGitSha(obj.gitSha, `${path}.gitSha`),
    revisionId: expectNonEmptyString(
      obj.revisionId,
      `${path}.revisionId`,
      MaxText.recordId,
    ),
  };
}

/**
 * One actual telemetry sample for an exact deployment identity and exact
 * telemetry window. The sample carries the DeploymentIdentityV1 it proves
 * (gitSha + revisionId are one identity, never alternatives), the explicit
 * windowStart/windowEnd it covers (never inferred from the current wall clock
 * on resume), and the coverage of the source scan that produced it. The
 * denominator `requestCount` plus the failure counts are all bounded by the
 * denominator, plus the upstream-wide fault flag. Missing telemetry is an
 * explicit null (or a whole unavailable port result) — never silently
 * reported as a 0-rate sample. No raw request data.
 */
export interface MetricsSampleV1 {
  /** Exact deployment identity this sample was observed against. */
  identity: DeploymentIdentityV1;
  /** Inclusive start of the exact telemetry window; nonnegative. */
  windowStart: number;
  /** Exclusive end of the exact telemetry window; windowStart < windowEnd. */
  windowEnd: number;
  /** When the observation was made; it never predates the window end. */
  sampledAt: number;
  domain: string | null;
  requestCount: number | null;
  fiveXxCount: number | null;
  timeoutCount: number | null;
  streamFailureCount: number | null;
  /** True when the failure was upstream-wide, not a per-request defect. */
  upstreamWideFault: boolean | null;
  /** Coverage of the source scan producing this sample. */
  coverage: IncidentCoverageV1;
}

const METRICS_SAMPLE_KEYS = [
  "identity",
  "windowStart",
  "windowEnd",
  "sampledAt",
  "domain",
  "requestCount",
  "fiveXxCount",
  "timeoutCount",
  "streamFailureCount",
  "upstreamWideFault",
  "coverage",
] as const;

/** Parse one metrics sample with fail-closed count/denominator/window rules. */
export function parseMetricsSample(
  input: unknown,
  path: string,
): MetricsSampleV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, METRICS_SAMPLE_KEYS, path);
  const identity = parseDeploymentIdentity(obj.identity, `${path}.identity`);
  const windowStart = expectTimestampOf(
    obj.windowStart,
    `${path}.windowStart`,
  );
  const windowEnd = expectTimestampOf(obj.windowEnd, `${path}.windowEnd`);
  if (windowEnd <= windowStart) {
    fail(
      `${path}.windowEnd`,
      "invalid_lifecycle",
      "window end must follow the window start",
    );
  }
  const sampledAt = expectTimestampOf(obj.sampledAt, `${path}.sampledAt`);
  if (sampledAt < windowEnd) {
    fail(
      `${path}.sampledAt`,
      "invalid_lifecycle",
      "sample time cannot precede the recorded window end",
    );
  }
  const coverage = parseIncidentCoverage(obj.coverage, `${path}.coverage`);
  const domain = expectNullableString(
    obj.domain,
    `${path}.domain`,
    MaxText.url,
  );
  const requestCount = expectNullableCount(
    obj.requestCount,
    `${path}.requestCount`,
  );
  const fiveXxCount = expectNullableCount(
    obj.fiveXxCount,
    `${path}.fiveXxCount`,
  );
  const timeoutCount = expectNullableCount(
    obj.timeoutCount,
    `${path}.timeoutCount`,
  );
  const streamFailureCount = expectNullableCount(
    obj.streamFailureCount,
    `${path}.streamFailureCount`,
  );
  const upstreamWideFault = expectNullableBoolean(
    obj.upstreamWideFault,
    `${path}.upstreamWideFault`,
  );
  // Counts are bounded by the denominator. Missing telemetry means the whole
  // sample is null, never a 0-rate picture.
  if (requestCount === null) {
    if (
      fiveXxCount !== null || timeoutCount !== null ||
      streamFailureCount !== null || upstreamWideFault !== null
    ) {
      fail(
        `${path}.requestCount`,
        "invalid_lifecycle",
        "missing denominator requires all counts and flag to be null",
      );
    }
  } else {
    for (
      const [name, count] of [
        ["fiveXxCount", fiveXxCount],
        ["timeoutCount", timeoutCount],
        ["streamFailureCount", streamFailureCount],
      ] as const
    ) {
      if (count !== null && count > requestCount) {
        fail(
          `${path}.${name}`,
          "invalid_lifecycle",
          "failure count cannot exceed the request denominator",
        );
      }
    }
  }
  return {
    identity,
    windowStart,
    windowEnd,
    sampledAt,
    domain,
    requestCount,
    fiveXxCount,
    timeoutCount,
    streamFailureCount,
    upstreamWideFault,
    coverage,
  };
}

function expectTimestampOf(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(
      path,
      "invalid_timestamp",
      `expected nonnegative integer timestamp, got ${describeValue(value)}`,
    );
  }
  return value;
}

function expectNullableCount(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(
      path,
      "invalid_count",
      `expected nonnegative safe integer or null, got ${describeValue(value)}`,
    );
  }
  return value;
}

function expectNullableBoolean(value: unknown, path: string): boolean | null {
  if (value === null) return null;
  if (typeof value !== "boolean") {
    fail(
      path,
      "invalid_boolean",
      `expected boolean or null, got ${describeValue(value)}`,
    );
  }
  return value;
}

/**
 * Restricted storage/credential reference: an opaque storage record name,
 * never a network URL, absolute filesystem path or traversal. A signed
 * credential URL, query string, fragment or userinfo is never a reference —
 * those would leak secrets into public Git state; actual URL endpoints belong
 * in configured adapter URLs, never in secret/artifact refs. Only the opaque
 * storage schemes `artifact`, `fixture` and `secret` may use the
 * `scheme://` authority form, and the authority is an opaque storage
 * namespace name that may not carry a port (so no host:port endpoint form).
 * `.`/`..` segments (including after an opaque scheme delimiter) are
 * rejected, so a reference can never traverse outside its storage root. Pattern allows A-Za-z0-9 plus
 * `._:/+-` only; query/fragment/userinfo characters are outside it.
 */
const RESTRICTED_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,511}$/;
const OPAQUE_REF_SCHEMES = ["artifact", "fixture", "secret"] as const;
const OPAQUE_AUTHORITY_RE = /^[A-Za-z0-9_.-]+$/;

export function expectRestrictedRef(value: unknown, path: string): string {
  const text = expectPattern(
    value,
    path,
    RESTRICTED_REF_RE,
    "invalid_pattern",
    "expected restricted storage reference (no URL/query/userinfo)",
    MaxText.ref,
  );
  expectRestrictedRefShape(text, path);
  return text;
}

function expectRestrictedRefShape(text: string, path: string): void {
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(text);
  let segments: string[];
  let authoritySegment: string | null = null;
  if (schemeMatch === null) {
    segments = text.split("/");
  } else {
    const scheme = schemeMatch[1].toLowerCase();
    if (!(OPAQUE_REF_SCHEMES as readonly string[]).includes(scheme)) {
      fail(
        path,
        "invalid_pattern",
        "expected an opaque storage reference scheme, not a URL or file scheme",
      );
    }
    const rest = text.slice(schemeMatch[0].length);
    if (rest.length === 0) {
      fail(path, "invalid_pattern", "expected a non-empty reference body");
    }
    if (rest.startsWith("//")) {
      // Authority form: an opaque storage namespace name. A port-bearing or
      // colon-containing authority is a network endpoint — never a ref.
      const slash = rest.indexOf("/", 2);
      const authority = slash === -1 ? rest.slice(2) : rest.slice(2, slash);
      if (
        !OPAQUE_AUTHORITY_RE.test(authority) || authority.includes(":")
      ) {
        fail(
          path,
          "invalid_pattern",
          "expected an opaque storage authority name",
        );
      }
      segments = slash === -1 ? [] : rest.slice(slash + 1).split("/");
      authoritySegment = authority;
    } else if (rest.startsWith("/")) {
      // scheme:/ absolute filesystem form; a ref is never a file path.
      fail(
        path,
        "invalid_pattern",
        "expected an opaque reference without an absolute path",
      );
    } else {
      segments = rest.split("/");
    }
  }
  const checkSegments = authoritySegment === null
    ? segments
    : [authoritySegment, ...segments];
  for (const segment of checkSegments) {
    if (segment === "." || segment === "..") {
      fail(
        path,
        "invalid_pattern",
        "expected a reference without . or .. path segments",
      );
    }
  }
}

/**
 * Evidence references. The digest brand is fixed by the branch kind, so an
 * artifact digest can never be placed in a fixture slot and vice versa.
 */
export type EvidenceRefV1 =
  | { kind: "incident_evidence"; ref: string; digest: EncryptedArtifactDigest }
  | { kind: "fixture"; ref: string; digest: FixtureDigest }
  | { kind: "replay_result"; ref: string }
  | { kind: "review_receipt"; ref: string };

export function parseEvidenceRef(input: unknown, path: string): EvidenceRefV1 {
  const obj = expectRecord(input, path);
  const kind = expectEnum(obj.kind, [
    "incident_evidence",
    "fixture",
    "replay_result",
    "review_receipt",
  ], `${path}.kind`);
  const ref = expectRestrictedRef(obj.ref, `${path}.ref`);
  switch (kind) {
    case "incident_evidence": {
      expectExactKeys(obj, ["kind", "ref", "digest"], path);
      const digest = asEncryptedArtifactDigest(
        expectSha256Hex(obj.digest, `${path}.digest`),
      );
      return { kind, ref, digest };
    }
    case "fixture": {
      expectExactKeys(obj, ["kind", "ref", "digest"], path);
      const digest = asFixtureDigest(
        expectSha256Hex(obj.digest, `${path}.digest`),
      );
      return { kind, ref, digest };
    }
    case "replay_result":
    case "review_receipt": {
      expectExactKeys(obj, ["kind", "ref"], path);
      return { kind, ref };
    }
  }
}

export function parseEvidenceRefs(
  input: unknown,
  path: string,
): EvidenceRefV1[] {
  return expectArray(input, path, 64, parseEvidenceRef);
}

/**
 * Inherent coverage status of an incident discovery scan: "complete" means
 * pagination was exhausted; "incomplete" carries the concrete reason. A failed
 * source read is never a successful empty result, so neither value represents
 * "unavailable" (that stays a port error).
 */
export type IncidentCoverageV1 =
  | { status: "complete" }
  | { status: "incomplete"; reason: string; nextCursor: string | null };

export function parseIncidentCoverage(
  input: unknown,
  path: string,
): IncidentCoverageV1 {
  const obj = expectRecord(input, path);
  const status = expectEnum(
    obj.status,
    ["complete", "incomplete"],
    `${path}.status`,
  );
  if (status === "complete") {
    expectExactKeys(obj, ["status"], path);
    return { status: "complete" };
  }
  expectExactKeys(obj, ["status", "reason", "nextCursor"], path);
  const reason = expectNonEmptyString(
    obj.reason,
    `${path}.reason`,
    MaxText.message,
  );
  const nextCursor = expectNullableString(
    obj.nextCursor,
    `${path}.nextCursor`,
    MaxText.token,
  );
  return { status: "incomplete", reason, nextCursor };
}

export function parseSeverity(input: unknown, path: string): SeverityV1 {
  return expectEnum(input, SEVERITIES, path);
}

/** Bounded label matching explicit identifiers; used for reviewers and env names. */
export function expectLabel(value: unknown, path: string): string {
  return expectString(value, path, MaxText.label);
}

export { expectNonEmptyString, expectPattern };
