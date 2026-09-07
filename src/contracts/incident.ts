/**
 * IncidentSummaryV1 and IncidentEvidenceV1.
 *
 * Summary records are produced by unresolved-discovery scans (with inherent
 * coverage/pagination provenance); evidence records describe the restricted
 * encrypted artifacts captured per incident and the replay metadata. Raw
 * evidence payloads never appear here: only bounded sanitized context plus
 * restricted artifact refs with digest/size/expiry.
 */

import {
  asEncryptedArtifactDigest,
  asFixtureDigest,
  asIncidentFingerprint,
} from "./brands.ts";
import type {
  CommandId,
  EncryptedArtifactDigest,
  FixtureDigest,
  GitSha,
  IncidentFingerprint,
} from "./brands.ts";
import {
  expectRestrictedRef,
  parseIncidentCoverage,
  parseRepositoryIdentity,
  parseSeverity,
} from "./shared.ts";
import type {
  IncidentCoverageV1,
  RepositoryIdentityV1,
  SeverityV1,
} from "./shared.ts";
import {
  describeValue,
  expectArray,
  expectCommandId,
  expectCount,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectNullableString,
  expectPattern,
  expectRecord,
  expectSha256Hex,
  expectStringArray,
  expectTimestamp,
  expectVersion,
  fail,
  MaxItems,
  MaxText,
} from "./validation.ts";

export interface IncidentArtifactRefV1 {
  /** Restricted storage ref; never a public URL to raw evidence. */
  ref: string;
  digest: EncryptedArtifactDigest;
  sizeBytes: number;
  expiresAt: number;
  contentType: string;
}

export interface ReplayMetadataV1 {
  fixtureRef: string;
  fixtureDigest: FixtureDigest | null;
  /** Whether the upstream response was captured (and thus a replay is possible). */
  upstreamCaptured: boolean;
  commandId: CommandId;
  reproducedAt: number | null;
}

export interface IncidentProvenanceV1 {
  source: "gateway";
  endpoint: string;
  capturedAt: number;
  capturedBy: string | null;
}

export interface IncidentSummaryV1 {
  version: "v1";
  kind: "incident_summary";
  /** Repository the incident was discovered in (identity, not just endpoint). */
  repository: RepositoryIdentityV1;
  id: string;
  fingerprint: IncidentFingerprint;
  severity: SeverityV1;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  failingRevision: GitSha | null;
  errorType: string;
  /** Bounded sanitized context; plaintext secrets are never stored here. */
  context: { message: string; location: string | null; sample: string[] };
  provenance: IncidentProvenanceV1;
  /** Result of the discovery scan that produced this summary. */
  coverage: IncidentCoverageV1;
  /** Pointer to the restricted evidence record; null when none was retained. */
  evidenceRef: { ref: string; digest: EncryptedArtifactDigest | null } | null;
}

export interface IncidentEvidenceV1 {
  version: "v1";
  kind: "incident_evidence";
  /** Repository the evidence was captured in (identity, not just endpoint). */
  repository: RepositoryIdentityV1;
  id: string;
  incidentId: string;
  fingerprint: IncidentFingerprint;
  failingRevision: GitSha | null;
  artifacts: IncidentArtifactRefV1[];
  replay: ReplayMetadataV1 | null;
  provenance: IncidentProvenanceV1;
  coverage: IncidentCoverageV1;
}

const SUMMARY_KEYS = [
  "version",
  "kind",
  "repository",
  "id",
  "fingerprint",
  "severity",
  "firstSeenAt",
  "lastSeenAt",
  "count",
  "failingRevision",
  "errorType",
  "context",
  "provenance",
  "coverage",
  "evidenceRef",
] as const;
const CONTEXT_KEYS = ["message", "location", "sample"] as const;
const PROVENANCE_KEYS = [
  "source",
  "endpoint",
  "capturedAt",
  "capturedBy",
] as const;
const EVIDENCE_REF_KEYS = ["ref", "digest"] as const;
const ARTIFACT_KEYS = [
  "ref",
  "digest",
  "sizeBytes",
  "expiresAt",
  "contentType",
] as const;
const REPLAY_KEYS = [
  "fixtureRef",
  "fixtureDigest",
  "upstreamCaptured",
  "commandId",
  "reproducedAt",
] as const;
const EVIDENCE_KEYS = [
  "version",
  "kind",
  "repository",
  "id",
  "incidentId",
  "fingerprint",
  "failingRevision",
  "artifacts",
  "replay",
  "provenance",
  "coverage",
] as const;

export function parseIncidentSummaryV1(input: unknown): IncidentSummaryV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, SUMMARY_KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, ["incident_summary"], "$.kind");

  const repository = parseRepositoryIdentity(obj.repository, "$.repository");
  const id = expectNonEmptyString(obj.id, "$.id", MaxText.recordId);
  const fingerprint = asIncidentFingerprint(
    expectSha256Hex(obj.fingerprint, "$.fingerprint"),
  );
  const severity = parseSeverity(obj.severity, "$.severity");
  const firstSeenAt = expectTimestamp(obj.firstSeenAt, "$.firstSeenAt");
  const lastSeenAt = expectTimestamp(obj.lastSeenAt, "$.lastSeenAt");
  if (firstSeenAt > lastSeenAt) {
    fail(
      "$.firstSeenAt",
      "invalid_lifecycle",
      "firstSeenAt cannot be after lastSeenAt",
    );
  }
  const count = expectCount(obj.count, "$.count");
  if (count < 1) {
    fail("$.count", "invalid_count", "incident count must be at least 1");
  }
  const failingRevision = expectNullable(
    obj.failingRevision,
    "$.failingRevision",
    expectGitSha,
  );
  const errorType = expectNonEmptyString(
    obj.errorType,
    "$.errorType",
    MaxText.label,
  );

  const contextObj = expectRecord(obj.context, "$.context");
  expectExactKeys(contextObj, CONTEXT_KEYS, "$.context");
  const context = {
    message: expectNonEmptyString(
      contextObj.message,
      "$.context.message",
      MaxText.context,
    ),
    location: expectNullableString(
      contextObj.location,
      "$.context.location",
      MaxText.path,
    ),
    sample: expectStringArray(
      contextObj.sample,
      "$.context.sample",
      MaxItems.contextLines,
      MaxItems.contextLineChars,
    ),
  };

  const provenance = parseProvenance(obj.provenance, "$.provenance");
  const coverage = parseIncidentCoverage(obj.coverage, "$.coverage");

  const evidenceRef = expectNullable(
    obj.evidenceRef,
    "$.evidenceRef",
    (value, path) => {
      const refObj = expectRecord(value, path);
      expectExactKeys(refObj, EVIDENCE_REF_KEYS, path);
      return {
        ref: expectRestrictedRef(refObj.ref, `${path}.ref`),
        digest: expectNullable(
          refObj.digest,
          `${path}.digest`,
          (v, p) => asEncryptedArtifactDigest(expectSha256Hex(v, p)),
        ),
      };
    },
  );

  return {
    version: "v1",
    kind: "incident_summary",
    repository,
    id,
    fingerprint,
    severity,
    firstSeenAt,
    lastSeenAt,
    count,
    failingRevision,
    errorType,
    context,
    provenance,
    coverage,
    evidenceRef,
  };
}

export function parseIncidentEvidenceV1(input: unknown): IncidentEvidenceV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, EVIDENCE_KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, ["incident_evidence"], "$.kind");

  const repository = parseRepositoryIdentity(obj.repository, "$.repository");
  const id = expectNonEmptyString(obj.id, "$.id", MaxText.recordId);
  const incidentId = expectNonEmptyString(
    obj.incidentId,
    "$.incidentId",
    MaxText.recordId,
  );
  const fingerprint = asIncidentFingerprint(
    expectSha256Hex(obj.fingerprint, "$.fingerprint"),
  );
  const failingRevision = expectNullable(
    obj.failingRevision,
    "$.failingRevision",
    expectGitSha,
  );
  const artifacts = expectArray(
    obj.artifacts,
    "$.artifacts",
    MaxItems.artifacts,
    parseArtifactRef,
  );
  const replay = expectNullable(obj.replay, "$.replay", parseReplayMetadata);
  const provenance = parseProvenance(obj.provenance, "$.provenance");
  const coverage = parseIncidentCoverage(obj.coverage, "$.coverage");

  // Artifact refs are exact storage pointers, never multiply-claimable: a
  // duplicate ref inside one evidence record is invalid on every path —
  // initial snapshot creation, existing-state transitions and raw remote
  // reads — never only a transition-time guard.
  const seenArtifactRefs = new Set<string>();
  for (const [index, artifact] of artifacts.entries()) {
    if (artifact.expiresAt < provenance.capturedAt) {
      fail(
        `$.artifacts[${index}]`,
        "invalid_lifecycle",
        "artifact cannot expire before capture",
      );
    }
    if (seenArtifactRefs.has(artifact.ref)) {
      fail(
        `$.artifacts[${index}].ref`,
        "invalid_lifecycle",
        "duplicate artifact ref",
      );
    }
    seenArtifactRefs.add(artifact.ref);
  }

  return {
    version: "v1",
    kind: "incident_evidence",
    repository,
    id,
    incidentId,
    fingerprint,
    failingRevision,
    artifacts,
    replay,
    provenance,
    coverage,
  };
}

function parseProvenance(input: unknown, path: string): IncidentProvenanceV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, PROVENANCE_KEYS, path);
  expectEnum(obj.source, ["gateway"], `${path}.source`);
  const endpoint = expectPattern(
    obj.endpoint,
    `${path}.endpoint`,
    /^https?:\/\/[^ /]+(?::\d+)?(?:\/[^ ]*)?$/,
    "invalid_pattern",
    "expected http(s) endpoint URL",
    MaxText.url,
  );
  return {
    source: "gateway",
    endpoint,
    capturedAt: expectTimestamp(obj.capturedAt, `${path}.capturedAt`),
    capturedBy: expectNullableString(
      obj.capturedBy,
      `${path}.capturedBy`,
      MaxText.login,
    ),
  };
}

function parseArtifactRef(input: unknown, path: string): IncidentArtifactRefV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, ARTIFACT_KEYS, path);
  const ref = expectRestrictedRef(obj.ref, `${path}.ref`);
  const digest = asEncryptedArtifactDigest(
    expectSha256Hex(obj.digest, `${path}.digest`),
  );
  const sizeBytes = expectCount(obj.sizeBytes, `${path}.sizeBytes`);
  const expiresAt = expectTimestamp(obj.expiresAt, `${path}.expiresAt`);
  const contentType = expectNonEmptyString(
    obj.contentType,
    `${path}.contentType`,
    MaxText.contentType,
  );
  return { ref, digest, sizeBytes, expiresAt, contentType };
}

function parseReplayMetadata(input: unknown, path: string): ReplayMetadataV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, REPLAY_KEYS, path);
  const fixtureRef = expectRestrictedRef(obj.fixtureRef, `${path}.fixtureRef`);
  const fixtureDigest = expectNullable(
    obj.fixtureDigest,
    `${path}.fixtureDigest`,
    (v, p) => asFixtureDigest(expectSha256Hex(v, p)),
  );
  const upstreamCaptured = expectBooleanOf(
    obj.upstreamCaptured,
    `${path}.upstreamCaptured`,
  );
  const commandId = expectCommandId(obj.commandId, `${path}.commandId`);
  const reproducedAt = expectNullable(
    obj.reproducedAt,
    `${path}.reproducedAt`,
    expectTimestamp,
  );
  if (upstreamCaptured && fixtureDigest === null) {
    fail(
      `${path}.fixtureDigest`,
      "invalid_lifecycle",
      "captured upstream requires a fixture digest",
    );
  }
  if (!upstreamCaptured && fixtureDigest !== null) {
    fail(
      `${path}.fixtureDigest`,
      "invalid_lifecycle",
      "no upstream capture, so no fixture digest",
    );
  }
  if (reproducedAt !== null && fixtureDigest === null) {
    fail(
      `${path}.reproducedAt`,
      "invalid_lifecycle",
      "reproduction requires a fixture",
    );
  }
  return {
    fixtureRef,
    fixtureDigest,
    upstreamCaptured,
    commandId,
    reproducedAt,
  };
}

function expectBooleanOf(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    fail(
      path,
      "invalid_boolean",
      `expected boolean, got ${describeValue(value)}`,
    );
  }
  return value;
}
