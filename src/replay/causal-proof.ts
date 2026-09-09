/**
 * Trusted causal-proof boundary (plan 01).
 *
 * Structural sanitization and causal verification stay SEPARATE. A redacted
 * fixture remains `redacted: true` for provenance/privacy forever; the
 * `fixture_redacted` limitation may only be suppressed at the replay
 * consuming boundary after a fully bound trusted causal proof establishes
 * that the original captured request and the sanitized fixture produced the
 * SAME intended failure at the same original Git SHA under the configured
 * trusted oracle. This module owns the narrow proof type, its strict
 * structural validator and the canonical failure-signature identity; it never
 * accepts an unbound boolean, caller/model-supplied success, a stale proof,
 * a mismatched identity or matching nonzero exits alone.
 *
 * The proof binds, at minimum: version/kind and the fixed verifier identity;
 * a safe restricted proof reference; the exact repository
 * owner/name/installation identity; the incident id and capture id; the
 * authenticated encrypted-artifact digest; the original Git SHA; the exact
 * fixture reference and the actual bundle digest; the trusted replay command
 * id and the trusted target-test command id; the exact test-id list; the
 * exact expected-failure matcher/reason; and two non-secret failure-signature
 * digests proving both observations were intended failures of the same
 * expected failure identity.
 *
 * The fixture-reference grammar is the fixed gateway replay protocol
 * (`fixture://gateway-replay/<incidentId>/<captureId>/<bundleDigest>`); the
 * proof reference is the sibling restricted grammar
 * (`fixture://proof/gateway-causal/<incidentId>/<captureId>/<bundleDigest>`).
 * Both are deterministic, non-secret and never carry raw payloads.
 */

import {
  asEncryptedArtifactDigest,
  asFixtureDigest,
  asGitSha,
  isCommandId,
  isEncryptedArtifactDigest,
  isFixtureDigest,
  isGitSha,
} from "../contracts/brands.ts";
import type {
  CommandId,
  EncryptedArtifactDigest,
  FixtureDigest,
  GitSha,
} from "../contracts/brands.ts";
import { canonicalStringifySha256 } from "../contracts/canonical.ts";
import { expectRestrictedRef } from "../contracts/shared.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { ExpectedFailureV1 } from "./fixture.ts";

/** Fixed trusted verifier identity; the only verifier id a proof may carry. */
export const GATEWAY_CAUSAL_VERIFIER_ID = "gateway-trusted-oracle-v1";

const PROOF_SCHEME_PREFIX = "fixture://proof/gateway-causal/";
const FIXTURE_SCHEME_PREFIX = "fixture://gateway-replay/";
const LOWERCASE_HEX_64 = /^[0-9a-f]{64}$/;
/** Frozen gateway incident identity grammar (see adapters/gateway/wire.ts). */
const GATEWAY_INCIDENT_ID =
  /^provider-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAPTURE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TEST_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_TEST_IDS = 64;
const MAX_FAILURE_REASON_BYTES = 512;
const MAX_MATCH_TEXT_BYTES = 512;
const MAX_MATCH_REGEX_BYTES = 256;

const PROOF_KEYS = [
  "version",
  "kind",
  "verifier",
  "proofRef",
  "repository",
  "incidentId",
  "captureId",
  "artifactDigest",
  "originalGitSha",
  "fixtureRef",
  "bundleDigest",
  "replayCommandId",
  "testCommandId",
  "testIds",
  "expectedFailure",
  "originalObservation",
  "fixtureObservation",
] as const;
const OBSERVATION_KEYS = ["intended", "signature"] as const;
const EXPECTED_FAILURE_KEYS = ["reason", "match"] as const;
const MATCH_KEYS = ["kind", "text"] as const;
const REGEX_MATCH_KEYS = ["kind", "source"] as const;

/** One trusted observation: an intended failure with its signature identity. */
export interface CausalFailureObservationV1 {
  intended: true;
  /** Non-secret lowercase 64-hex failure-signature identity. */
  signature: string;
}

/**
 * The narrow trusted causal-proof record. Fully bound: every field is
 * validated and the consuming boundary re-checks every identity it can
 * observe before the proof may suppress `fixture_redacted`.
 */
export interface GatewayCausalProofV1 {
  version: "v1";
  kind: "gateway_causal_proof";
  /** Exact fixed verifier identity (`GATEWAY_CAUSAL_VERIFIER_ID`). */
  verifier: string;
  /** Safe restricted deterministic proof reference (never raw payloads). */
  proofRef: string;
  repository: RepositoryIdentityV1;
  incidentId: string;
  captureId: string;
  /** Authenticated encrypted-artifact digest (distinct from the fixture digest). */
  artifactDigest: EncryptedArtifactDigest;
  /** Original failing Git SHA the capture was recorded at. */
  originalGitSha: GitSha;
  fixtureRef: string;
  bundleDigest: FixtureDigest;
  replayCommandId: CommandId;
  testCommandId: CommandId;
  testIds: string[];
  expectedFailure: ExpectedFailureV1;
  originalObservation: CausalFailureObservationV1;
  fixtureObservation: CausalFailureObservationV1;
}

/** Identities the consuming boundary re-checks against the proof. */
export interface GatewayCausalProofBoundaryV1 {
  repository: RepositoryIdentityV1;
  /** Optional capture-level identities (composition side only). */
  incidentId?: string;
  captureId?: string;
  artifactDigest?: EncryptedArtifactDigest;
  originalGitSha?: GitSha;
  fixtureRef: string;
  bundleDigest: FixtureDigest;
  replayCommandId: CommandId;
  testCommandId: CommandId;
  testIds: readonly string[];
  expectedFailure: ExpectedFailureV1;
}

/** Strict parse of the fixed gateway fixture-reference grammar. */
export interface GatewayFixtureRefIdentityV1 {
  incidentId: string;
  captureId: string;
  bundleDigest: FixtureDigest;
}

/**
 * Canonical non-secret expected-failure identity: SHA-256 over the canonical
 * form of `{version, kind, intended: true, reason, matcher}`. Both trusted
 * observations sign the SAME identity, and the consuming boundary re-derives
 * it from the resolved fixture's expected failure and demands equality, so a
 * caller/model assertion, a stale proof or a changed matcher/reason can never
 * mask a mismatch.
 */
export async function deriveFailureSignatureIdentity(
  expected: ExpectedFailureV1,
): Promise<string> {
  const matcher = expected.match.kind === "contains"
    ? { kind: "contains", text: expected.match.text }
    : { kind: "regex", source: expected.match.source };
  return await canonicalStringifySha256({
    version: "v1",
    kind: "causal-failure-signature",
    intended: true,
    reason: expected.reason,
    match: matcher,
  });
}

/** Deterministic restricted proof reference for an exact capture/bundle. */
export function gatewayCausalProofRef(
  incidentId: string,
  captureId: string,
  bundleDigest: FixtureDigest,
): string {
  return `${PROOF_SCHEME_PREFIX}${incidentId}/${captureId}/${bundleDigest}`;
}

/** Deterministic parse of the fixed gateway fixture-reference grammar. */
export function gatewayFixtureRefIdentity(
  ref: string,
): GatewayFixtureRefIdentityV1 | null {
  if (typeof ref !== "string" || !ref.startsWith(FIXTURE_SCHEME_PREFIX)) {
    return null;
  }
  const segments = ref.slice(FIXTURE_SCHEME_PREFIX.length).split("/");
  if (segments.length !== 3) return null;
  const [incidentId, captureId, digest] = segments;
  if (incidentId === undefined || captureId === undefined) return null;
  if (digest === undefined || !LOWERCASE_HEX_64.test(digest)) return null;
  if (!GATEWAY_INCIDENT_ID.test(incidentId)) return null;
  if (!CAPTURE_ID_RE.test(captureId)) return null;
  try {
    expectRestrictedRef(ref, "$.fixtureRef");
  } catch {
    return null;
  }
  return {
    incidentId,
    captureId,
    bundleDigest: asFixtureDigest(digest),
  };
}

/**
 * Strict structural proof validation: exact keys, bounded shapes, the fixed
 * verifier identity, restricted refs, internal reference consistency
 * (incident/capture/digest of the fixture ref match the proof fields), the
 * expected proof reference, command/test identities, the expected-failure
 * shape and both observations as intended failures with equal 64-hex
 * signatures equal to the canonically derived identity. Returns null on any
 * violation; no proof is ever partially trusted.
 */
export async function validateGatewayCausalProof(
  input: unknown,
): Promise<GatewayCausalProofV1 | null> {
  const obj = asRecord(input);
  if (obj === null) return null;
  if (!hasExactKeys(obj, PROOF_KEYS)) return null;
  if (obj.version !== "v1") return null;
  if (obj.kind !== "gateway_causal_proof") return null;
  if (obj.verifier !== GATEWAY_CAUSAL_VERIFIER_ID) return null;

  const repository = asRepositoryIdentity(obj.repository);
  if (repository === null) return null;

  const incidentId = obj.incidentId;
  const captureId = obj.captureId;
  if (typeof incidentId !== "string" || !GATEWAY_INCIDENT_ID.test(incidentId)) {
    return null;
  }
  if (typeof captureId !== "string" || !CAPTURE_ID_RE.test(captureId)) {
    return null;
  }
  const artifactDigest = obj.artifactDigest;
  if (!isEncryptedArtifactDigest(artifactDigest)) return null;
  const originalGitSha = obj.originalGitSha;
  if (!isGitSha(originalGitSha)) return null;
  const fixtureRef = obj.fixtureRef;
  if (typeof fixtureRef !== "string") return null;
  const fixtureIdentity = gatewayFixtureRefIdentity(fixtureRef);
  if (fixtureIdentity === null) return null;
  if (fixtureIdentity.incidentId !== incidentId) return null;
  if (fixtureIdentity.captureId !== captureId) return null;
  const bundleDigest = obj.bundleDigest;
  if (!isFixtureDigest(bundleDigest)) return null;
  if (fixtureIdentity.bundleDigest !== bundleDigest) return null;

  const proofRef = obj.proofRef;
  if (typeof proofRef !== "string") return null;
  if (proofRef !== gatewayCausalProofRef(incidentId, captureId, bundleDigest)) {
    return null;
  }

  const replayCommandId = obj.replayCommandId;
  const testCommandId = obj.testCommandId;
  if (!isCommandId(replayCommandId) || !isCommandId(testCommandId)) {
    return null;
  }
  const testIds = obj.testIds;
  if (
    !Array.isArray(testIds) || testIds.length === 0 ||
    testIds.length > MAX_TEST_IDS
  ) {
    return null;
  }
  const seen = new Set<string>();
  for (const id of testIds) {
    if (typeof id !== "string" || !TEST_ID_RE.test(id) || seen.has(id)) {
      return null;
    }
    seen.add(id);
  }

  const expectedFailure = parseExpectedFailure(obj.expectedFailure);
  if (expectedFailure === null) return null;

  const originalObservation = parseObservation(obj.originalObservation);
  if (originalObservation === null) return null;
  const fixtureObservation = parseObservation(obj.fixtureObservation);
  if (fixtureObservation === null) return null;
  if (
    originalObservation.signature !== fixtureObservation.signature ||
    originalObservation.signature !==
      await deriveFailureSignatureIdentity(expectedFailure)
  ) {
    return null;
  }

  return {
    version: "v1",
    kind: "gateway_causal_proof",
    verifier: GATEWAY_CAUSAL_VERIFIER_ID,
    proofRef,
    repository,
    incidentId,
    captureId,
    artifactDigest: asEncryptedArtifactDigest(artifactDigest),
    originalGitSha: asGitSha(originalGitSha),
    fixtureRef,
    bundleDigest: asFixtureDigest(bundleDigest),
    replayCommandId,
    testCommandId,
    testIds: [...testIds],
    expectedFailure,
    originalObservation,
    fixtureObservation,
  };
}

/** Exact boundary binding: every observable identity must match exactly. */
export function gatewayCausalProofMatches(
  proof: GatewayCausalProofV1,
  boundary: GatewayCausalProofBoundaryV1,
): boolean {
  if (!sameRepositoryIdentity(proof.repository, boundary.repository)) {
    return false;
  }
  if (
    boundary.incidentId !== undefined &&
    proof.incidentId !== boundary.incidentId
  ) {
    return false;
  }
  if (
    boundary.captureId !== undefined && proof.captureId !== boundary.captureId
  ) {
    return false;
  }
  if (
    boundary.artifactDigest !== undefined &&
    proof.artifactDigest !== boundary.artifactDigest
  ) {
    return false;
  }
  if (
    boundary.originalGitSha !== undefined &&
    proof.originalGitSha !== boundary.originalGitSha
  ) {
    return false;
  }
  if (proof.fixtureRef !== boundary.fixtureRef) return false;
  if (proof.bundleDigest !== boundary.bundleDigest) return false;
  if (proof.replayCommandId !== boundary.replayCommandId) return false;
  if (proof.testCommandId !== boundary.testCommandId) return false;
  if (!sameStringArray(proof.testIds, boundary.testIds)) return false;
  if (!sameExpectedFailure(proof.expectedFailure, boundary.expectedFailure)) {
    return false;
  }
  return true;
}

/**
 * One trusted end-to-end proof check used by the trusted composition and the
 * replay consuming boundary: strict structural validation plus the exact
 * caller-observed boundary. Returns the proof only when BOTH hold.
 */
export async function bindGatewayCausalProof(
  input: unknown,
  boundary: GatewayCausalProofBoundaryV1,
): Promise<GatewayCausalProofV1 | null> {
  const parsed = await validateGatewayCausalProof(input);
  if (parsed === null) return null;
  return gatewayCausalProofMatches(parsed, boundary) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Strict structural helpers (no input-derived error text).
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  if (own.length !== keys.length) return false;
  const expected = new Set(keys);
  return own.every((key) => expected.has(key));
}

function asRepositoryIdentity(
  value: unknown,
): RepositoryIdentityV1 | null {
  const obj = asRecord(value);
  if (obj === null) return null;
  if (!hasExactKeys(obj, ["owner", "name", "installationId"])) return null;
  const { owner, name, installationId } = obj;
  if (typeof owner !== "string" || owner.length === 0) return null;
  if (typeof name !== "string" || name.length === 0) return null;
  if (
    typeof installationId !== "number" ||
    !Number.isSafeInteger(installationId) ||
    installationId < 1
  ) {
    return null;
  }
  return { owner, name, installationId };
}

function parseExpectedFailure(
  value: unknown,
): ExpectedFailureV1 | null {
  const obj = asRecord(value);
  if (obj === null) return null;
  if (!hasExactKeys(obj, EXPECTED_FAILURE_KEYS)) return null;
  const reason = obj.reason;
  if (
    typeof reason !== "string" || reason.length === 0 ||
    reason.length > MAX_FAILURE_REASON_BYTES || /[\r\n\t]/.test(reason)
  ) {
    return null;
  }
  const match = asRecord(obj.match);
  if (match === null) return null;
  if (match.kind === "contains") {
    if (!hasExactKeys(match, MATCH_KEYS)) return null;
    const text = match.text;
    if (
      typeof text !== "string" || text.length === 0 ||
      text.length > MAX_MATCH_TEXT_BYTES
    ) {
      return null;
    }
    return { reason, match: { kind: "contains", text } };
  }
  if (match.kind === "regex") {
    if (!hasExactKeys(match, REGEX_MATCH_KEYS)) return null;
    const source = match.source;
    if (
      typeof source !== "string" || source.length === 0 ||
      source.length > MAX_MATCH_REGEX_BYTES
    ) {
      return null;
    }
    try {
      new RegExp(source, "m");
    } catch {
      return null;
    }
    return { reason, match: { kind: "regex", source } };
  }
  return null;
}

function parseObservation(value: unknown): CausalFailureObservationV1 | null {
  const obj = asRecord(value);
  if (obj === null) return null;
  if (!hasExactKeys(obj, OBSERVATION_KEYS)) return null;
  if (obj.intended !== true) return null;
  const signature = obj.signature;
  if (typeof signature !== "string" || !LOWERCASE_HEX_64.test(signature)) {
    return null;
  }
  return { intended: true, signature };
}

function sameRepositoryIdentity(
  a: RepositoryIdentityV1,
  b: RepositoryIdentityV1,
): boolean {
  return a.owner === b.owner && a.name === b.name &&
    a.installationId === b.installationId;
}

function sameStringArray(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameExpectedFailure(
  a: ExpectedFailureV1,
  b: ExpectedFailureV1,
): boolean {
  if (a.reason !== b.reason) return false;
  if (a.match.kind !== b.match.kind) return false;
  if (a.match.kind === "contains") {
    return b.match.kind === "contains" && a.match.text === b.match.text;
  }
  return b.match.kind === "regex" && a.match.source === b.match.source;
}
