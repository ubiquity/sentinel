/**
 * Distinct, non-interchangeable identity brands.
 *
 * The four digest/SHA identity kinds are intentionally mutually exclusive:
 * - GitSha: exactly 40 lowercase hex chars (Git commit SHA-1).
 * - SourceSnapshotDigest, FixtureDigest, EncryptedArtifactDigest, incident and
 *   finding fingerprints: exactly 64 lowercase hex chars (SHA-256).
 *
 * A 40-hex value can never validate as a digest and a 64-hex value can never
 * validate as a Git SHA, so the digest/sha confusion failures are rejected at
 * parse time; the TypeScript brands additionally make them non-assignable at
 * compile time. The 64-hex brands share a shape but are named fields in each
 * record (sourceSnapshotDigest, fixtureDigest, encrypted artifact digest, ...)
 * and are documented in docs/contracts.md; never assign one brand's value into
 * another brand's field.
 */

/** An exact Git commit SHA-1 (40 lowercase hex characters). */
export type GitSha = string & { readonly __brand: "sentinel/GitSha" };

/** SHA-256 digest of a captured source tree snapshot. */
export type SourceSnapshotDigest = string & {
  readonly __brand: "sentinel/SourceSnapshotDigest";
};

/** SHA-256 digest of a sanitized fixture (request/upstream/output material). */
export type FixtureDigest = string & {
  readonly __brand: "sentinel/FixtureDigest";
};

/** SHA-256 digest of an encrypted restricted artifact (raw evidence payload). */
export type EncryptedArtifactDigest = string & {
  readonly __brand: "sentinel/EncryptedArtifactDigest";
};

/** SHA-256 digest identifying one incident (stable dedupe identity). */
export type IncidentFingerprint = string & {
  readonly __brand: "sentinel/IncidentFingerprint";
};

/** SHA-256 digest of the canonical form of one review finding. */
export type FindingFingerprint = string & {
  readonly __brand: "sentinel/FindingFingerprint";
};

/** Identifier of a trusted, credential-free configured command. */
export type CommandId = string & { readonly __brand: "sentinel/CommandId" };

/** Deterministic, unique work item identity (task/branch/PR source). */
export type WorkItemId = string & { readonly __brand: "sentinel/WorkItemId" };

/** Contract version one of every record and snapshot. */
export type Version1 = "v1";

export const VERSION1 = "v1" as const;

const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const COMMAND_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;
const WORK_ITEM_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;

export function isGitSha(value: unknown): value is GitSha {
  return typeof value === "string" && GIT_SHA_RE.test(value);
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_RE.test(value);
}

export function isSourceSnapshotDigest(
  value: unknown,
): value is SourceSnapshotDigest {
  return isSha256Hex(value);
}

export function isFixtureDigest(value: unknown): value is FixtureDigest {
  return isSha256Hex(value);
}

export function isEncryptedArtifactDigest(
  value: unknown,
): value is EncryptedArtifactDigest {
  return isSha256Hex(value);
}

export function isIncidentFingerprint(
  value: unknown,
): value is IncidentFingerprint {
  return isSha256Hex(value);
}

export function isFindingFingerprint(
  value: unknown,
): value is FindingFingerprint {
  return isSha256Hex(value);
}

export function isCommandId(value: unknown): value is CommandId {
  return typeof value === "string" && COMMAND_ID_RE.test(value);
}

export function isWorkItemId(value: unknown): value is WorkItemId {
  return typeof value === "string" && WORK_ITEM_ID_RE.test(value);
}

/**
 * Branded casts for values that already passed a checked predicate (only use
 * inside record parsers directly behind expectSha256Hex / expectGitSha).
 */
export function asGitSha(hex: string): GitSha {
  return hex as GitSha;
}

export function asSourceSnapshotDigest(hex: string): SourceSnapshotDigest {
  return hex as SourceSnapshotDigest;
}

export function asFixtureDigest(hex: string): FixtureDigest {
  return hex as FixtureDigest;
}

export function asEncryptedArtifactDigest(
  hex: string,
): EncryptedArtifactDigest {
  return hex as EncryptedArtifactDigest;
}

export function asIncidentFingerprint(hex: string): IncidentFingerprint {
  return hex as IncidentFingerprint;
}

export function asFindingFingerprint(hex: string): FindingFingerprint {
  return hex as FindingFingerprint;
}

export function asCommandId(value: string): CommandId {
  return value as CommandId;
}

export function asWorkItemId(value: string): WorkItemId {
  return value as WorkItemId;
}
