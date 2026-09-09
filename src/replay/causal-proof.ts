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
 * structural validator and the canonical expected-failure identity; it never
 * accepts an unbound boolean, caller/model-supplied success, a stale proof,
 * a mismatched identity or matching nonzero exits alone.
 *
 * The proof binds, at minimum: version/kind and the fixed verifier identity;
 * a safe restricted proof reference; the exact repository
 * owner/name/installation identity; the incident id and capture id; the
 * authenticated encrypted-artifact digest; the original Git SHA; the exact
 * fixture reference and the actual bundle digest; the trusted replay command
 * id, the trusted target-test command id and the fixed trusted-consumer
 * command identity; the exact test-id list; the exact expected-failure
 * matcher/reason plus its canonical identity; and, per execution, the
 * OBSERVED execution evidence: the observed exit code 1, the observed test
 * identity actually printed by the consumer, the observed digest of the
 * exact fixed safe consumer output protocol (stdout only, empty stderr) and
 * the intended-failure classification.
 *
 * The expected-failure identity is a canonical classification label derived
 * from the configured reason+matcher. It is NOT an observed execution
 * signature and it is NOT authentication of any execution: the observations
 * carry observed-output digests of what the consumer actually printed. The
 * consumer protocol is the EXACT fixed safe failure protocol (one
 * `sentinel-replay-test:<id>\n` line per trusted id in order plus the single
 * fixed `sentinel-causal-failure:stream terminated unexpectedly\n` line on
 * stdout, empty stderr, exit code 1), so those digests are computed only
 * over validated fixed public protocol bytes — arbitrary or private
 * diagnostics are never accepted and never hashed. Raw private output,
 * request or upstream bytes never enter a proof and never leave the trusted
 * verifier boundary: only fixed safe failure identity after exact-protocol
 * classification plus observed execution bindings (exit code, test identity,
 * output digest) cross this boundary.
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

/**
 * Fixed trusted verifier identity; the only verifier id a proof may carry.
 * The concrete verifier is the trusted local Deno consumer executor
 * (`GatewayLocalCausalVerifier`); a proof is never produced by a caller
 * supplied oracle or by a model.
 */
export const GATEWAY_CAUSAL_VERIFIER_ID = "gateway-causal-consumer-v1";

/**
 * Fixed trusted-consumer command identity executed by the trusted verifier.
 * This is a protocol constant (like the verifier id), never caller- or
 * model-supplied; the consumer is the committed trusted script invoked with
 * the fixed local Deno protocol, not a target `deno task`.
 */
export const CAUSAL_CONSUMER_COMMAND_ID: CommandId =
  "causal_consumer" as CommandId;

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
  "consumerCommandId",
  "testIds",
  "expectedFailure",
  "expectedFailureIdentity",
  "originalObservation",
  "sanitizedObservation",
] as const;
const OBSERVATION_KEYS = [
  "intended",
  "outputDigest",
  "observedTestIds",
  "exitCode",
] as const;
const EXPECTED_FAILURE_KEYS = ["reason", "match"] as const;
const MATCH_KEYS = ["kind", "text"] as const;
const REGEX_MATCH_KEYS = ["kind", "source"] as const;

/**
 * One trusted observation: the concrete consumer actually exited 1 and
 * printed the EXACT fixed safe failure protocol (one
 * `sentinel-replay-test:<id>\n` line per trusted id in order plus the single
 * fixed `sentinel-causal-failure:stream terminated unexpectedly\n` line on
 * stdout, empty stderr). Only fixed safe failure identity plus observed
 * execution bindings cross the proof boundary — never raw output, request or
 * upstream bytes and never a hash of the expected matcher presented as a
 * signature.
 */
export interface CausalExecutionObservationV1 {
  /** The trusted verifier classified this execution as the intended failure. */
  intended: true;
  /**
   * SHA-256 over the exact validated safe consumer failure protocol observed
   * (stdout only; the protocol requires empty stderr): one
   * `sentinel-replay-test:<id>` line per trusted id in order plus the single
   * fixed `sentinel-causal-failure:stream terminated unexpectedly` line.
   * Only those fixed public protocol bytes are ever hashed; arbitrary or
   * private diagnostics are never accepted and never digested. The digest is
   * an observed-execution binding, never a signature identity.
   */
  outputDigest: string;
  /** Test identity actually observed in the consumer output (fixed protocol). */
  observedTestIds: string[];
  /** Observed nonzero exit code of the consumer execution. */
  exitCode: number;
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
  /** Fixed trusted-consumer command identity (`CAUSAL_CONSUMER_COMMAND_ID`). */
  consumerCommandId: CommandId;
  testIds: string[];
  expectedFailure: ExpectedFailureV1;
  /** Canonical expected-failure identity; a classification label, never an
   * observed execution signature. */
  expectedFailureIdentity: string;
  originalObservation: CausalExecutionObservationV1;
  sanitizedObservation: CausalExecutionObservationV1;
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
 * Canonical non-secret EXPECTED-FAILURE identity: SHA-256 over the canonical
 * form of `{version, kind, intended: true, reason, matcher}`. This is a
 * classification label for the intended failure configured by the trusted
 * host policy. It is NOT an observed execution signature and it is NOT
 * authentication of an execution: proof observations carry their own
 * non-secret output digests and observed test identity. The consuming
 * boundary re-derives this identity from the resolved fixture's expected
 * failure and demands equality, so a caller/model assertion, a stale proof or
 * a changed matcher/reason can never mask a mismatch.
 */
export async function deriveExpectedFailureIdentity(
  expected: ExpectedFailureV1,
): Promise<string> {
  const matcher = expected.match.kind === "contains"
    ? { kind: "contains", text: expected.match.text }
    : { kind: "regex", source: expected.match.source };
  return await canonicalStringifySha256({
    version: "v1",
    kind: "causal-expected-failure-identity",
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
 * verifier identity, the fixed trusted-consumer command identity, restricted
 * refs, internal reference consistency (incident/capture/digest of the
 * fixture ref match the proof fields), the expected proof reference,
 * command/test identities, the expected-failure shape plus its canonical
 * expected-failure identity and both observations as intended failures with
 * observed nonzero exit codes, non-secret output digests and the exact
 * observed test identity. Returns null on any violation; no proof is ever
 * partially trusted.
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
  const consumerCommandId = obj.consumerCommandId;
  if (
    !isCommandId(replayCommandId) || !isCommandId(testCommandId) ||
    !isCommandId(consumerCommandId)
  ) {
    return null;
  }
  if (consumerCommandId !== CAUSAL_CONSUMER_COMMAND_ID) return null;
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
  const expectedFailureIdentity = obj.expectedFailureIdentity;
  if (
    typeof expectedFailureIdentity !== "string" ||
    !LOWERCASE_HEX_64.test(expectedFailureIdentity) ||
    expectedFailureIdentity !==
      await deriveExpectedFailureIdentity(expectedFailure)
  ) {
    return null;
  }

  const originalObservation = parseObservation(obj.originalObservation, seen);
  if (originalObservation === null) return null;
  const sanitizedObservation = parseObservation(
    obj.sanitizedObservation,
    seen,
  );
  if (sanitizedObservation === null) return null;

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
    consumerCommandId,
    testIds: [...testIds],
    expectedFailure,
    expectedFailureIdentity,
    originalObservation,
    sanitizedObservation,
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

/**
 * One observed execution: intended failure, exit code 1, output digest over
 * the exact fixed safe protocol and the EXACT observed test identity (a
 * subset of the proof test identity; the trusted verifier runs the same
 * fixed consumer that prints them). Never a matcher hash presented as an
 * execution signature.
 */
function parseObservation(
  value: unknown,
  proofTestIds: ReadonlySet<string>,
): CausalExecutionObservationV1 | null {
  const obj = asRecord(value);
  if (obj === null) return null;
  if (!hasExactKeys(obj, OBSERVATION_KEYS)) return null;
  if (obj.intended !== true) return null;
  const outputDigest = obj.outputDigest;
  if (
    typeof outputDigest !== "string" || !LOWERCASE_HEX_64.test(outputDigest)
  ) {
    return null;
  }
  const exitCode = obj.exitCode;
  if (
    typeof exitCode !== "number" || !Number.isSafeInteger(exitCode) ||
    exitCode < 1 || exitCode > 255
  ) {
    return null;
  }
  const observedTestIds = obj.observedTestIds;
  if (
    !Array.isArray(observedTestIds) || observedTestIds.length === 0 ||
    observedTestIds.length > MAX_TEST_IDS
  ) {
    return null;
  }
  const observed = new Set<string>();
  for (const id of observedTestIds) {
    if (typeof id !== "string" || !TEST_ID_RE.test(id) || observed.has(id)) {
      return null;
    }
    if (!proofTestIds.has(id)) return null;
    observed.add(id);
  }
  // An observation must carry the trusted test identity actually executed;
  // an empty or partial identity can never be an intended regression run.
  if (!setsEqual(observed, proofTestIds)) return null;
  return {
    intended: true,
    outputDigest,
    observedTestIds: [...observedTestIds],
    exitCode,
  };
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
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
