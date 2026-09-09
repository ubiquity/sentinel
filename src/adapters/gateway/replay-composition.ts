/**
 * Wave C: gateway capture → trusted fixture → replay composition.
 *
 * This is the only gateway-specific composition: it wraps an existing
 * `IncidentAdapter` (discovery/retention stay delegated and read-only) and a
 * trusted `ArtifactStoreV1`, and it implements both the `FixtureResolverV1`
 * consumed by the ReplayPort and the read-only `resolveTestIds(fixtureRef,
 * fixtureDigest)` identity shape consumed by `src/repair/loop.ts`. It adds no
 * key loader, env var, flag, network or model call and no second general
 * framework.
 *
 * Pipeline (deterministic, no caching, no plaintext/key persistence):
 *
 * 1. `readIncident` delegates to the wrapped adapter first. The returned
 *    evidence is re-bound to the trusted composition identities: exact
 *    requested incident id, exact repository identity and (when replay
 *    metadata already exists) the existing replay identity is never replaced.
 * 2. The exact retained artifact is selected from `evidence.artifacts`: its
 *    ref must parse to the exact incident/capture identity, the retained
 *    store entry must carry the exact advertised encrypted-artifact digest,
 *    and the authenticated capture must bind the exact evidence fingerprint
 *    (the producer's incident group identity is the captured manifest HMAC
 *    fingerprint) and failing revision (the captured `git_sha`). Captures
 *    that do not bind those identities are skipped; when no capture binds
 *    them the result is a static typed `invalid` error, never a fixture.
 * 3. The capture is authenticated with `decryptRetainedGatewayCapture` under
 *    the caller-supplied existing 32-byte key capability (copied at
 *    construction; caller buffers and the retained ciphertext are never
 *    mutated) and converted with `sanitizeGatewayReplay` under the
 *    caller-supplied fixed host policy.
 * 4. A fixture is only produced when the authenticated upstream trace is
 *    complete and truthful: at least one attempt, every truncation flag
 *    false, and every attempt terminal `eof` with valid headers/status and a
 *    supported body, or an allowed bodyless response (204/205/304 with no
 *    chunks). No upstream, partial/truncated, `fetch_error`/`read_error`/
 *    `cancelled`/`pending` traces keep `replay: null` — a typed
 *    missing-evidence result — and never invent a fixture.
 * 5. The `ResolvedFixtureV1` is materialized at fixed safe
 *    `tests/fixtures/gateway-replay/<incidentId>/<captureId>/` entry paths
 *    whose bytes are the canonical JSON of the sanitized request envelope and
 *    the sanitized upstream payload, with caller-supplied trusted test ids,
 *    `ExpectedFailureV1` and the frozen provenance
 *    `{sanitized: true, sanitizer: "gateway-structural-v1",
 *    provenanceRef: <fixture ref>, redacted: true, note: <static text>}`.
 * 6. The opaque restricted fixture ref is derived deterministically from the
 *    incident id, the capture id and the ReplayPort bundle digest computed
 *    with `computeReplayFixtureDigest` (distinct from the encrypted-artifact
 *    digest and from the sanitizer's restricted payload digest). Resolution
 *    re-reads the retained artifact, decrypts and sanitizes again and
 *    rejects malformed refs, digest mismatches, expired/missing/tampered
 *    artifacts, wrong incident identity and unsafe fixture data with static
 *    typed errors; a fresh composition instance over the same store root
 *    rehydrates the identical fixture.
 *
 * Private request bytes, upstream traces and the sanitizer's restricted
 * provenance never appear in public errors, evidence records or fixture
 * bundle bytes.
 */

import {
  asFixtureDigest,
  isCommandId,
  isFixtureDigest,
} from "../../contracts/brands.ts";
import type { CommandId, FixtureDigest } from "../../contracts/brands.ts";
import { canonicalStringify } from "../../contracts/canonical.ts";
import { parseIncidentEvidenceV1 } from "../../contracts/incident.ts";
import type { IncidentEvidenceV1 } from "../../contracts/incident.ts";
import { portError, portOk } from "../../contracts/ports.ts";
import type {
  Clock,
  EncryptedArtifactV1,
  IncidentAdapter,
  IncidentPageV1,
  PortResultV1,
} from "../../contracts/ports.ts";
import { expectRestrictedRef } from "../../contracts/shared.ts";
import type { RepositoryIdentityV1 } from "../../contracts/shared.ts";
import {
  computeReplayFixtureDigest,
  containsSecretShapedText,
  isSafeBundlePath,
} from "../../replay/fixture.ts";
import type {
  ExpectedFailureV1,
  FixtureResolverV1,
  ReplayFixtureEntryV1,
  ResolvedFixtureV1,
} from "../../replay/fixture.ts";
import { decryptRetainedGatewayCapture } from "./decrypt.ts";
import type {
  RetainedCaptureErrorV1,
  RetainedGatewayCaptureV1,
  RetainedGatewayUpstreamV1,
} from "./decrypt.ts";
import { artifactRef } from "./incident-adapter.ts";
import { sanitizeGatewayReplay } from "./sanitize.ts";
import type {
  GatewaySanitizerPolicyV1,
  SanitizedGatewayFixtureV1,
  SanitizedGatewayReplayV1,
} from "./sanitize.ts";
import { parseArtifactRefIdentity } from "./store.ts";
import type {
  ArtifactStoreErrorV1,
  ArtifactStoreV1,
  StoredArtifactV1,
} from "./store.ts";
import { GATEWAY_INCIDENT_ID } from "./wire.ts";

// ---------------------------------------------------------------------------
// Options and identity source
// ---------------------------------------------------------------------------

/** Caller-supplied trusted inputs for the gateway replay composition. */
export interface GatewayReplayCompositionOptionsV1 {
  /** Wrapped incident adapter; discovery/retention stay delegated/read-only. */
  adapter: IncidentAdapter;
  /**
   * Trusted restricted evidence store. Must be the same store the wrapped
   * adapter retained into (or another instance over the same store root).
   */
  store: ArtifactStoreV1;
  /** Exact trusted repository identity the evidence must belong to. */
  repository: RepositoryIdentityV1;
  /**
   * Existing producer key capability (exactly 32 bytes); copied at
   * construction, never persisted and never mutated.
   */
  keyBytes: Uint8Array<ArrayBuffer>;
  /** Fixed trusted host sanitizer policy; copied at construction. */
  policy: GatewaySanitizerPolicyV1;
  /** Trusted replay command id recorded in ReplayMetadataV1. */
  commandId: CommandId;
  /** Trusted replay test identity attested by the fixture. */
  testIds: readonly string[];
  /** Trusted before-failure signature attested by the fixture. */
  expectedFailure: ExpectedFailureV1;
  /** Clock for expiry checks; tests inject a fixed clock. */
  clock: Clock;
}

/**
 * Read-only trusted identity lookup paired with the concrete resolver
 * (structural match with the shape consumed by src/repair/loop.ts).
 */
export interface ReplayFixtureTestIdentityV1 {
  resolveTestIds(
    fixtureRef: string,
    fixtureDigest: FixtureDigest,
  ): Promise<PortResultV1<readonly string[]>>;
}

// ---------------------------------------------------------------------------
// Fixed safe fixture layout and static error text (no input-derived text)
// ---------------------------------------------------------------------------

const FIXTURE_NAMESPACE = "gateway-replay";
const FIXTURE_REF_PREFIX = `fixture://${FIXTURE_NAMESPACE}/`;
/** Fixed safe root-relative fixture entry scope (trailing slash). */
const FIXTURE_SCOPE = "tests/fixtures/";
const FIXTURE_ROOT = "tests/fixtures/gateway-replay";
const FIXTURE_REQUEST_PATH = "request.json";
const FIXTURE_UPSTREAM_PATH = "upstream.json";
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const MAX_TEST_IDS = 64;
const TEST_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_FAILURE_REASON_BYTES = 512;
const MAX_MATCH_TEXT_BYTES = 512;
const MAX_MATCH_REGEX_BYTES = 256;
const CAPTURE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const LOWERCASE_HEX_64 = /^[0-9a-f]{64}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const STATIC_INVALID_CLOCK = "injected clock returned an invalid time";
const STATIC_WRONG_INCIDENT =
  "incident evidence does not match the requested incident identity";
const STATIC_WRONG_REPOSITORY =
  "incident evidence does not belong to the configured repository";
const STATIC_WRONG_ARTIFACT =
  "retained artifact does not match the incident evidence artifact identity";
const STATIC_STORE_IDENTITY = "retained artifact identity cannot be verified";
const STATIC_STORE_UNAVAILABLE = "retained evidence store is unavailable";
const STATIC_DECRYPT_KEY = "retained capture decryption key is not usable";
const STATIC_DECRYPT_IDENTITY =
  "retained capture failed the authenticated identity check";
const STATIC_TRACE_INCOMPLETE =
  "retained upstream trace is not complete and truthful";
const STATIC_UNSAFE_BUNDLE = "replay fixture bundle contains unsafe data";
const STATIC_BUNDLE_BOUNDS = "replay fixture bundle exceeds the safe bounds";
const STATIC_SANITIZE_POLICY =
  "gateway replay cannot be sanitized under the trusted policy";
const STATIC_SANITIZE_UNAVAILABLE =
  "gateway replay sanitization is unavailable";
const STATIC_EVIDENCE_INVALID = "incident evidence failed record validation";
const STATIC_ARTIFACT_MISSING = "retained artifact is missing or expired";
const STATIC_BINDING_MISMATCH =
  "retained capture does not match the exact incident identity";
const STATIC_MALFORMED_REF =
  "fixture reference is not a supported gateway replay reference";
const STATIC_INVALID_DIGEST =
  "fixture digest is not a supported 64-hex SHA-256 identity";
const STATIC_DIGEST_MISMATCH =
  "fixture bundle digest does not match the reference identity";
const STATIC_PROVENANCE_NOTE =
  "gateway capture redacted; request and upstream re-encoded to a fixed protocol vocabulary";

/** One composed fixture result: resolved bundle plus its deterministic identity. */
interface ComposedFixtureV1 {
  resolved: ResolvedFixtureV1;
  bundleDigest: FixtureDigest;
  fixtureRef: string;
}

/** Parsed opaque fixture reference identity. */
interface ParsedFixtureRefV1 {
  incidentId: string;
  captureId: string;
  bundleDigest: FixtureDigest;
}

/** Derived opaque restricted fixture ref from incident, capture and digest. */
function composeFixtureRef(
  incidentId: string,
  captureId: string,
  bundleDigest: FixtureDigest,
): string {
  return `${FIXTURE_REF_PREFIX}${incidentId}/${captureId}/${bundleDigest}`;
}

/** Strict parse of the opaque restricted fixture reference. */
function parseFixtureRef(ref: string): ParsedFixtureRefV1 | null {
  if (!ref.startsWith(FIXTURE_REF_PREFIX)) return null;
  const segments = ref.slice(FIXTURE_REF_PREFIX.length).split("/");
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

/** Exact repository identity match (owner/name/installationId are one). */
function sameRepositoryIdentity(
  a: RepositoryIdentityV1,
  b: RepositoryIdentityV1,
): boolean {
  return a.owner === b.owner && a.name === b.name &&
    a.installationId === b.installationId;
}

/** Whether one upstream attempt is an allowed bodyless response. */
function isBodylessStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

/**
 * Complete and truthful upstream trace (frozen §12): attempts exist, no
 * truncation flag, and every attempt terminated at "eof" with valid
 * headers/status and a supported body, or an allowed bodyless response with
 * no chunks. Matches exactly what the accepted upstream sanitizer accepts.
 */
function isCompleteTruthfulUpstream(
  upstream: RetainedGatewayUpstreamV1,
): boolean {
  if (upstream.attempts.length === 0) return false;
  if (
    upstream.attempts_truncated || upstream.bytes_truncated ||
    upstream.chunks_truncated
  ) {
    return false;
  }
  for (const attempt of upstream.attempts) {
    if (attempt.terminal !== "eof") return false;
    if (attempt.status === null || attempt.content_type === null) return false;
    if (isBodylessStatus(attempt.status)) {
      if (attempt.chunks_base64.length !== 0) return false;
      continue;
    }
    if (
      attempt.content_type !== "application/json" &&
      attempt.content_type !== "text/event-stream"
    ) {
      return false;
    }
    if (attempt.chunks_base64.length === 0) return false;
  }
  return true;
}

/** Deep-copy the trusted host policy (no reference to caller state). */
function copyPolicy(
  policy: GatewaySanitizerPolicyV1,
): GatewaySanitizerPolicyV1 {
  const publicModels = [...policy.publicModels];
  const publicHeaders: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(policy.publicHeaders)) {
    publicHeaders[name] = [...values];
  }
  return { publicModels, publicHeaders };
}

function copyExpectedFailure(expected: ExpectedFailureV1): ExpectedFailureV1 {
  return expected.match.kind === "contains"
    ? { ...expected, match: { kind: "contains", text: expected.match.text } }
    : { ...expected, match: { kind: "regex", source: expected.match.source } };
}

/** Deterministic negative bundle checks; returns a static reason or null. */
function validateFixtureEntries(
  entries: readonly ReplayFixtureEntryV1[],
): string | null {
  if (entries.length !== 2) return STATIC_BUNDLE_BOUNDS;
  const seen = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    if (!isSafeBundlePath(entry.path)) return STATIC_UNSAFE_BUNDLE;
    if (!entry.path.startsWith(FIXTURE_SCOPE)) return STATIC_UNSAFE_BUNDLE;
    if (seen.has(entry.path)) return STATIC_BUNDLE_BOUNDS;
    seen.add(entry.path);
    if (
      entry.bytes.byteLength === 0 || entry.bytes.byteLength > MAX_ENTRY_BYTES
    ) {
      return STATIC_BUNDLE_BOUNDS;
    }
    if (containsSecretShapedText(entry.bytes)) return STATIC_UNSAFE_BUNDLE;
    total += entry.bytes.byteLength;
  }
  if (total > MAX_TOTAL_BYTES) return STATIC_BUNDLE_BOUNDS;
  return null;
}

/** Store fault mapping to static typed port errors. */
function storeErrorToPort(error: ArtifactStoreErrorV1): PortResultV1<never> {
  if (
    error.kind === "corrupt" || error.kind === "invalid" ||
    error.kind === "conflict"
  ) {
    return portError("invalid", STATIC_STORE_IDENTITY);
  }
  return portError("unavailable", STATIC_STORE_UNAVAILABLE);
}

/** Decryption fault mapping to static typed port errors. */
function decryptErrorToPort(
  error: RetainedCaptureErrorV1,
): PortResultV1<never> {
  if (error.kind === "invalid_key") {
    return portError("unavailable", STATIC_DECRYPT_KEY);
  }
  return portError("invalid", STATIC_DECRYPT_IDENTITY);
}

/** Sanitizer fault mapping to static typed port errors. */
function sanitizeErrorToPort(
  result: Extract<PortResultV1<SanitizedGatewayReplayV1>, { ok: false }>,
): PortResultV1<never> {
  if (result.error.kind === "invalid") {
    return portError("invalid", STATIC_SANITIZE_POLICY);
  }
  return portError("unavailable", STATIC_SANITIZE_UNAVAILABLE);
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export class GatewayReplayComposition
  implements IncidentAdapter, FixtureResolverV1, ReplayFixtureTestIdentityV1 {
  private readonly adapter: IncidentAdapter;
  private readonly store: ArtifactStoreV1;
  private readonly keyBytes: Uint8Array<ArrayBuffer>;
  private readonly policy: GatewaySanitizerPolicyV1;
  private readonly repository: RepositoryIdentityV1;
  private readonly commandId: CommandId;
  private readonly testIds: string[];
  private readonly expectedFailure: ExpectedFailureV1;
  private readonly clock: Clock;

  constructor(options: GatewayReplayCompositionOptionsV1) {
    const keyBytes = options.keyBytes;
    if (!(keyBytes instanceof Uint8Array) || keyBytes.byteLength !== 32) {
      throw new TypeError(
        "GatewayReplayComposition requires an existing 32-byte key capability",
      );
    }
    if (!isCommandId(options.commandId)) {
      throw new TypeError(
        "GatewayReplayComposition requires a trusted replay command id",
      );
    }
    const repository = options.repository;
    if (
      repository === null || typeof repository !== "object" ||
      typeof repository.owner !== "string" ||
      typeof repository.name !== "string" ||
      !Number.isSafeInteger(repository.installationId) ||
      repository.installationId < 1
    ) {
      throw new TypeError(
        "GatewayReplayComposition requires an exact repository identity",
      );
    }
    const testIds = options.testIds;
    if (
      !Array.isArray(testIds) || testIds.length === 0 ||
      testIds.length > MAX_TEST_IDS
    ) {
      throw new TypeError(
        "GatewayReplayComposition requires a non-empty trusted test identity",
      );
    }
    const seen = new Set<string>();
    for (const id of testIds) {
      if (typeof id !== "string" || !TEST_ID_RE.test(id) || seen.has(id)) {
        throw new TypeError(
          "GatewayReplayComposition test ids must be unique bounded identifiers",
        );
      }
      seen.add(id);
    }
    validateExpectedFailure(options.expectedFailure);
    const policy = copyPolicy(options.policy);
    validatePolicyShape(policy);
    this.adapter = options.adapter;
    this.store = options.store;
    // Copy the caller's key capability: caller buffers are never mutated and
    // no key material is ever persisted.
    this.keyBytes = new Uint8Array(keyBytes);
    this.policy = policy;
    this.repository = repository;
    this.commandId = options.commandId;
    this.testIds = [...testIds];
    this.expectedFailure = copyExpectedFailure(options.expectedFailure);
    this.clock = options.clock;
  }

  // -------------------------------------------------------------------------
  // Read-only delegation
  // -------------------------------------------------------------------------

  listUnresolvedIncidents(
    cursor: string | null,
    limit: number,
  ): Promise<PortResultV1<IncidentPageV1>> {
    return this.adapter.listUnresolvedIncidents(cursor, limit);
  }

  readArtifact(
    ref: string,
    maxBytes: number,
  ): Promise<PortResultV1<EncryptedArtifactV1 | null>> {
    return this.adapter.readArtifact(ref, maxBytes);
  }

  // -------------------------------------------------------------------------
  // readIncident: delegate, re-bind, select, sanitize, attach replay metadata
  // -------------------------------------------------------------------------

  async readIncident(
    incidentId: string,
  ): Promise<PortResultV1<IncidentEvidenceV1 | null>> {
    const read = await this.adapter.readIncident(incidentId);
    if (!read.ok || read.value === null) return read;
    const evidence = read.value;
    if (evidence.incidentId !== incidentId) {
      return portError("invalid", STATIC_WRONG_INCIDENT);
    }
    if (!sameRepositoryIdentity(evidence.repository, this.repository)) {
      return portError("invalid", STATIC_WRONG_REPOSITORY);
    }
    // An existing replay identity is never replaced or recomputed.
    if (evidence.replay !== null) return portOk(evidence);
    // Missing failing revision or retained artifacts at discovery time:
    // replay stays null (typed missing evidence), never invented.
    if (evidence.failingRevision === null || evidence.artifacts.length === 0) {
      return portOk(evidence);
    }
    const now = this.safeNow();
    if (!now.ok) return now.error;

    let identityMismatch = 0;
    for (const artifact of evidence.artifacts) {
      const identity = parseArtifactRefIdentity(artifact.ref);
      if (identity === null || identity.incidentId !== evidence.incidentId) {
        return portError("invalid", STATIC_WRONG_ARTIFACT);
      }
      const loaded = await this.loadCapture(
        evidence.incidentId,
        identity.captureId,
        now.value,
      );
      if (loaded.status === "missing") continue;
      if (loaded.status === "failed") return loaded.error;
      if (
        loaded.stored.digest !== artifact.digest ||
        loaded.stored.captureId !== identity.captureId
      ) {
        return portError("invalid", STATIC_WRONG_ARTIFACT);
      }
      const capture = loaded.capture;
      if (
        capture.fingerprint !== evidence.fingerprint ||
        capture.gitSha !== evidence.failingRevision
      ) {
        identityMismatch += 1;
        continue;
      }
      // A partial/truncated/error/cancelled trace is NOT a fixture source:
      // keep the typed missing-evidence result (replay null) and never fail
      // the whole read over it — the evidence record itself is valid.
      if (!isCompleteTruthfulUpstream(capture.upstream)) {
        continue;
      }
      const composed = await this.composeFixture(
        evidence.incidentId,
        identity.captureId,
        capture,
      );
      if (!composed.ok) return composed;
      const updated: IncidentEvidenceV1 = {
        ...evidence,
        replay: {
          fixtureRef: composed.value.fixtureRef,
          fixtureDigest: composed.value.bundleDigest,
          upstreamCaptured: true,
          commandId: this.commandId,
          reproducedAt: null,
        },
      };
      try {
        return portOk(parseIncidentEvidenceV1(updated));
      } catch {
        return portError("invalid", STATIC_EVIDENCE_INVALID);
      }
    }
    if (identityMismatch > 0) {
      return portError("invalid", STATIC_BINDING_MISMATCH);
    }
    // Nothing retained for the exact evidence identity: typed missing evidence.
    return portOk(evidence);
  }

  // -------------------------------------------------------------------------
  // Fixture resolver and repair-loop test identity source
  // -------------------------------------------------------------------------

  async resolveFixture(
    fixtureRef: string,
  ): Promise<PortResultV1<ResolvedFixtureV1>> {
    const parsed = parseFixtureRef(fixtureRef);
    if (parsed === null) return portError("invalid", STATIC_MALFORMED_REF);
    const composed = await this.composeForRef(parsed);
    if (!composed.ok) return composed;
    if (composed.value.bundleDigest !== parsed.bundleDigest) {
      return portError("invalid", STATIC_DIGEST_MISMATCH);
    }
    return portOk(composed.value.resolved);
  }

  async resolveTestIds(
    fixtureRef: string,
    fixtureDigest: FixtureDigest,
  ): Promise<PortResultV1<readonly string[]>> {
    if (!isFixtureDigest(fixtureDigest)) {
      return portError("invalid", STATIC_INVALID_DIGEST);
    }
    const resolved = await this.resolveFixture(fixtureRef);
    if (!resolved.ok) return resolved;
    const computed = await computeReplayFixtureDigest(resolved.value.entries);
    if (computed !== fixtureDigest) {
      return portError("invalid", STATIC_DIGEST_MISMATCH);
    }
    return portOk([...resolved.value.testIds]);
  }

  // -------------------------------------------------------------------------
  // Internal pipeline
  // -------------------------------------------------------------------------

  private safeNow(): { ok: true; value: number } | {
    ok: false;
    error: PortResultV1<never>;
  } {
    const now = this.clock.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      return {
        ok: false,
        error: portError("invalid", STATIC_INVALID_CLOCK),
      };
    }
    return { ok: true, value: now };
  }

  private async composeForRef(
    parsed: ParsedFixtureRefV1,
  ): Promise<PortResultV1<ComposedFixtureV1>> {
    const now = this.safeNow();
    if (!now.ok) return now.error;
    const loaded = await this.loadCapture(
      parsed.incidentId,
      parsed.captureId,
      now.value,
    );
    if (loaded.status === "missing") {
      return portError("not_found", STATIC_ARTIFACT_MISSING);
    }
    if (loaded.status === "failed") return loaded.error;
    return this.composeFixture(
      parsed.incidentId,
      parsed.captureId,
      loaded.capture,
    );
  }

  /**
   * Load and authenticate one retained capture by its exact ref.
   * `status: "missing"` is the store's null (gone/expired), distinct from a
   * transport/store failure (`status: "failed"`).
   */
  private async loadCapture(
    incidentId: string,
    captureId: string,
    nowMs: number,
  ): Promise<
    | {
      status: "loaded";
      stored: StoredArtifactV1;
      capture: RetainedGatewayCaptureV1;
    }
    | { status: "missing" }
    | { status: "failed"; error: PortResultV1<never> }
  > {
    const ref = artifactRef(incidentId, captureId);
    const storedResult = await this.store.get(ref, nowMs);
    if (!storedResult.ok) {
      return { status: "failed", error: storeErrorToPort(storedResult.error) };
    }
    if (storedResult.value === null) return { status: "missing" };
    const stored = storedResult.value;
    if (stored.incidentId !== incidentId || stored.captureId !== captureId) {
      return {
        status: "failed",
        error: portError("invalid", STATIC_WRONG_ARTIFACT),
      };
    }
    const decrypted = await decryptRetainedGatewayCapture(
      stored,
      this.keyBytes,
    );
    if (!decrypted.ok) {
      return {
        status: "failed",
        error: decryptErrorToPort(decrypted.error),
      };
    }
    return { status: "loaded", stored, capture: decrypted.value };
  }

  /** Complete/truthful check, sanitize and deterministic fixture composition. */
  private async composeFixture(
    incidentId: string,
    captureId: string,
    capture: RetainedGatewayCaptureV1,
  ): Promise<PortResultV1<ComposedFixtureV1>> {
    if (!isCompleteTruthfulUpstream(capture.upstream)) {
      return portError("invalid", STATIC_TRACE_INCOMPLETE);
    }
    const sanitized = await sanitizeGatewayReplay(capture, this.policy);
    if (!sanitized.ok) return sanitizeErrorToPort(sanitized);
    const entries = fixtureEntries(
      incidentId,
      captureId,
      sanitized.value.fixture,
    );
    const boundsError = validateFixtureEntries(entries);
    if (boundsError !== null) return portError("invalid", boundsError);
    const bundleDigest = await computeReplayFixtureDigest(entries);
    const fixtureRef = composeFixtureRef(incidentId, captureId, bundleDigest);
    const resolved: ResolvedFixtureV1 = {
      testIds: [...this.testIds],
      expectedFailure: copyExpectedFailure(this.expectedFailure),
      entries,
      provenance: {
        sanitized: true,
        sanitizer: "gateway-structural-v1",
        provenanceRef: fixtureRef,
        redacted: true,
        note: STATIC_PROVENANCE_NOTE,
      },
    };
    return portOk({ resolved, bundleDigest, fixtureRef });
  }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

function fixtureEntries(
  incidentId: string,
  captureId: string,
  fixture: SanitizedGatewayFixtureV1,
): ReplayFixtureEntryV1[] {
  const dir = `${FIXTURE_ROOT}/${incidentId}/${captureId}`;
  return [
    {
      path: `${dir}/${FIXTURE_REQUEST_PATH}`,
      bytes: new TextEncoder().encode(canonicalStringify(fixture.request)),
    },
    {
      path: `${dir}/${FIXTURE_UPSTREAM_PATH}`,
      bytes: new TextEncoder().encode(canonicalStringify(fixture.upstream)),
    },
  ];
}

function validateExpectedFailure(expected: ExpectedFailureV1): void {
  if (
    expected === null || typeof expected.reason !== "string" ||
    expected.reason.length === 0 ||
    expected.reason.length > MAX_FAILURE_REASON_BYTES ||
    /[\r\n\t]/.test(expected.reason)
  ) {
    throw new TypeError(
      "GatewayReplayComposition requires a bounded expected-failure reason",
    );
  }
  if (expected.match.kind === "contains") {
    if (
      typeof expected.match.text !== "string" ||
      expected.match.text.length === 0 ||
      expected.match.text.length > MAX_MATCH_TEXT_BYTES
    ) {
      throw new TypeError(
        "GatewayReplayComposition requires a bounded expected-failure matcher",
      );
    }
    return;
  }
  if (expected.match.kind === "regex") {
    if (
      typeof expected.match.source !== "string" ||
      expected.match.source.length === 0 ||
      expected.match.source.length > MAX_MATCH_REGEX_BYTES
    ) {
      throw new TypeError(
        "GatewayReplayComposition requires a bounded expected-failure matcher",
      );
    }
    try {
      new RegExp(expected.match.source, "m");
    } catch {
      throw new TypeError(
        "GatewayReplayComposition expected-failure matcher is invalid",
      );
    }
    return;
  }
  throw new TypeError(
    "GatewayReplayComposition requires a supported expected-failure matcher",
  );
}

function validatePolicyShape(policy: GatewaySanitizerPolicyV1): void {
  if (!Array.isArray(policy.publicModels) || policy.publicModels.length === 0) {
    throw new TypeError(
      "GatewayReplayComposition requires a fixed public model allowlist",
    );
  }
  for (const model of policy.publicModels) {
    if (typeof model !== "string" || !MODEL_PATTERN.test(model)) {
      throw new TypeError(
        "GatewayReplayComposition public model allowlist is invalid",
      );
    }
  }
  for (const values of Object.values(policy.publicHeaders)) {
    if (
      !Array.isArray(values) || values.length === 0 ||
      values.some((value) => typeof value !== "string")
    ) {
      throw new TypeError(
        "GatewayReplayComposition header policy is invalid",
      );
    }
  }
}
