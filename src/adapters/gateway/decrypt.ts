/**
 * Trusted decryption boundary for retained gateway replay captures.
 *
 * The producer (`ai.ubq.fi/src/sentinel_replay_capture.ts` at the recorded
 * snapshot) encrypts each failed-request capture with AES-256-GCM under an
 * HKDF-SHA256-derived key, then publishes a manifest whose `fingerprint` is an
 * HMAC identity over the request (method/endpoint/compatibility headers/body +
 * failure signature) and whose `case_group_digest` is the same HMAC minus the
 * signature. This module is the deterministic inverse: it consumes a
 * `StoredArtifactV1` retained by the local restricted store and the existing
 * key bytes supplied by its caller (never a key source, credential loader or
 * configuration surface).
 *
 * Verification performed here, in order, each fail-closed:
 *
 * - key length is exactly the producer's 32 bytes;
 * - the preserved producer manifest re-parses under the frozen wire parser;
 * - the retained metadata identities match the manifest (capture id,
 *   fingerprint, case-group digest, capture/expiry times, byte counts);
 * - SHA-256 of the actual ciphertext equals the retained encrypted-artifact
 *   digest (reader-side integrity);
 * - AES-GCM decryption under HKDF-SHA256 (salt `uos-sentinel-replay-v1`,
 *   purpose `encryption`), the 12-byte manifest IV and the exact producer AAD
 *   `uos-sentinel-replay-v1\0<fingerprint>` (authenticity);
 * - bounded streaming gzip expansion (never Response.arrayBuffer());
 * - the 4-byte big-endian metadata-length envelope, request-body bound and
 *   strict producer metadata v2 shape (request plus the private upstream
 *   trace; v1 request-only plaintext is an explicit unsupported version);
 * - both producer HMAC identities (`fingerprint` now framed with canonical
 *   upstream JSON under `uos-sentinel-replay-v2`, `case-group` unchanged as
 *   the request-only v1 identity), the failure signature recomputed from the
 *   client observation, and the capture time.
 *
 * Every failure returns a static sanitized typed error: no thrown messages,
 * payload excerpts, trace bytes or key material ever cross this boundary.
 * Caller-owned key and ciphertext buffers are never mutated, and temporary
 * plaintext/crypto buffers are zeroed after use. The returned plaintext and
 * private upstream trace are explicitly restricted: they are not sanitized
 * and never a replay fixture, and this module makes no sanitization,
 * provenance or complete-coverage claims (`ReplayMetadataV1.upstreamCaptured`
 * and fixture digests remain out of scope).
 */

import type { StoredArtifactV1 } from "./store.ts";
import {
  decodeBase64Url,
  type GatewayReplayManifestV1,
  parseGatewayReplayManifestV1,
  replayManifestToWire,
} from "./wire.ts";

/** Producer HKDF/AAD namespace (source: sentinel_replay_capture.ts, frozen). */
const RETAINED_NAMESPACE = "uos-sentinel-replay-v1";
/** v2 fingerprint frame namespace (frozen upstream capture cutover). */
const RETAINED_FINGERPRINT_NAMESPACE = "uos-sentinel-replay-v2";
const RETAINED_KEY_BYTES = 32;
const RETAINED_IV_BYTES = 12;
/** Private plaintext metadata version after the upstream capture cutover. */
const RETAINED_METADATA_VERSION = 2;
/** The v1 request-only metadata version: unsupported, never upstream proof. */
const RETAINED_LEGACY_METADATA_VERSION = 1;
/** Frozen private upstream snapshot version. */
const RETAINED_UPSTREAM_VERSION = 1;
/** Aggregate upstream capture bounds (frozen; once hit the producer truncates). */
const RETAINED_UPSTREAM_MAX_ATTEMPTS = 8;
const RETAINED_UPSTREAM_MAX_DECODED_BYTES = 131_072;
const RETAINED_UPSTREAM_MAX_CHUNKS = 256;
/** Producer `MAX_REPLAY_METADATA_BYTES`. */
const RETAINED_METADATA_MAX_BYTES = 256 * 1_024;
/** Producer `MAX_ACCEPTED_JSON_BODY_BYTES`. */
const RETAINED_BODY_MAX_BYTES = 32 * 1_024 * 1_024;
/** Producer `MAX_REPLAY_PLAINTEXT_BYTES`. */
const RETAINED_PLAINTEXT_MAX_BYTES = RETAINED_BODY_MAX_BYTES +
  RETAINED_METADATA_MAX_BYTES +
  4;
const KEY_DERIVATION_SALT = new TextEncoder().encode(RETAINED_NAMESPACE);
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** Exact producer compatibility-header allow list (frozen in capture.ts). */
const COMPATIBILITY_HEADER_NAMES = [
  "accept",
  "openai-beta",
  "openai-organization",
  "openai-project",
  "originator",
  "user-agent",
  "x-codex-client-version",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
] as const;
const COMPATIBILITY_HEADER_NAME_SET = new Set<string>(
  COMPATIBILITY_HEADER_NAMES,
);

/** Exact producer metadata key sets (strict; unknown keys are rejected). */
const METADATA_KEYS = [
  "version",
  "captured_at_ms",
  "endpoint",
  "method",
  "content_type",
  "compatibility_headers",
  "failure_signature",
  "observation",
  "client_observation",
  "request_id",
  "git_sha",
  "deno_revision",
  "upstream",
] as const;
const OBSERVATION_KEYS = [
  "status",
  "stream",
  "completed",
  "terminal_type",
  "failure_kind",
  "synthetic_terminal_type",
  "provider_route",
] as const;
const CLIENT_OBSERVATION_KEYS = [
  "status",
  "stream",
  "completed",
  "terminal_type",
  "failure_kind",
  "framing_valid",
  "provider_route",
] as const;

/** Frozen private upstream envelope keys (docs/contracts.md §12). */
const UPSTREAM_KEYS = [
  "version",
  "attempts",
  "attempts_truncated",
  "bytes_truncated",
  "chunks_truncated",
] as const;
const UPSTREAM_ATTEMPT_KEYS = [
  "provider",
  "status",
  "content_type",
  "chunks_base64",
  "terminal",
] as const;
const UPSTREAM_PROVIDERS = [
  "chatgpt_codex",
  "surplus",
  "metered",
  "cerebras",
] as const;
const UPSTREAM_CONTENT_TYPES = [
  "text/event-stream",
  "application/json",
  "other",
] as const;
const UPSTREAM_TERMINALS = [
  "pending",
  "fetch_error",
  "eof",
  "read_error",
  "cancelled",
] as const;
const UPSTREAM_PROVIDER_SET = new Set<string>(UPSTREAM_PROVIDERS);
const UPSTREAM_CONTENT_TYPE_SET = new Set<string>(UPSTREAM_CONTENT_TYPES);
const UPSTREAM_TERMINAL_SET = new Set<string>(UPSTREAM_TERMINALS);

type RetainedUpstreamProvider = (typeof UPSTREAM_PROVIDERS)[number];
type RetainedUpstreamContentType = (typeof UPSTREAM_CONTENT_TYPES)[number];
type RetainedUpstreamTerminal = (typeof UPSTREAM_TERMINALS)[number];

/** One authenticated provider dispatch attempt (frozen snake_case). */
interface RetainedUpstreamAttemptWire {
  provider: RetainedUpstreamProvider;
  /** null until headers; otherwise an HTTP status code. */
  status: number | null;
  /** null before headers; otherwise the normalized MIME literal. */
  content_type: RetainedUpstreamContentType | null;
  /** Canonical padded standard-base64 chunk strings, in consumed order. */
  chunks_base64: string[];
  terminal: RetainedUpstreamTerminal;
}

/** Authenticated private upstream trace (frozen snake_case, no extras). */
interface RetainedUpstreamWire {
  version: 1;
  attempts: RetainedUpstreamAttemptWire[];
  attempts_truncated: boolean;
  bytes_truncated: boolean;
  chunks_truncated: boolean;
}

/** Producer internal failure observation (snake_case wire shape). */
interface RetainedObservationWire {
  status: number;
  stream: boolean | null;
  completed: boolean;
  terminal_type: string | null;
  failure_kind: string | null;
  synthetic_terminal_type: string | null;
  provider_route: string;
}

/** Producer client body observation (snake_case wire shape). */
interface RetainedClientObservationWire {
  status: number;
  stream: boolean;
  completed: boolean;
  terminal_type: string | null;
  failure_kind: string | null;
  framing_valid: boolean;
  provider_route: string;
}

/**
 * Private captured request/observation fields, authenticated against the
 * producer manifest. `body` is plaintext and intentionally NOT sanitized:
 * callers treat the whole value as restricted.
 */
export interface RetainedGatewayObservationV1 {
  status: number;
  stream: boolean | null;
  completed: boolean;
  terminalType: string | null;
  failureKind: string | null;
  syntheticTerminalType: string | null;
  providerRoute: string;
}

/** Authenticated client-side body observation (SSE framing facts). */
export interface RetainedGatewayClientObservationV1 {
  status: number;
  stream: boolean;
  completed: boolean;
  terminalType: string | null;
  failureKind: string | null;
  framingValid: boolean;
  providerRoute: string;
}

/** One authenticated upstream dispatch attempt (frozen snake_case names). */
export interface RetainedGatewayUpstreamAttemptV1 {
  provider: "chatgpt_codex" | "surplus" | "metered" | "cerebras";
  status: number | null;
  content_type: "text/event-stream" | "application/json" | "other" | null;
  chunks_base64: readonly string[];
  terminal: "pending" | "fetch_error" | "eof" | "read_error" | "cancelled";
}

/**
 * Required private upstream trace, returned exactly as validated. No
 * `complete`/`sanitized` flags are invented here: truthfulness is carried by
 * the frozen terminals and truncation booleans only.
 */
export interface RetainedGatewayUpstreamV1 {
  version: 1;
  attempts: readonly RetainedGatewayUpstreamAttemptV1[];
  attempts_truncated: boolean;
  bytes_truncated: boolean;
  chunks_truncated: boolean;
}

/**
 * The authenticated private-capture result: exactly the request and
 * observation fields the producer stored, plus the manifest identity that
 * authenticated them. No sanitization, provenance or upstream-capture fields
 * are invented here.
 */
export interface RetainedGatewayCaptureV1 {
  version: 1;
  captureId: string;
  /** Producer HMAC identity over the authenticated request + failure signature. */
  fingerprint: string;
  /** Producer HMAC identity over the authenticated request. */
  caseGroupDigest: string;
  capturedAt: number;
  expiresAt: number;
  requestId: string;
  gitSha: string;
  denoRevision: string;
  endpoint: string;
  method: string;
  contentType: string | null;
  compatibilityHeaders: Readonly<Record<string, string>>;
  /** Exact producer failure signature; bound by the fingerprint HMAC. */
  failureSignature: string;
  observation: RetainedGatewayObservationV1;
  clientObservation: RetainedGatewayClientObservationV1;
  /**
   * Private raw upstream trace (frozen snake_case), authenticated by the
   * v2 fingerprint HMAC. Traces and request bytes stay restricted: never
   * sanitized and never a replay fixture.
   */
  upstream: RetainedGatewayUpstreamV1;
  /** Private plaintext request body; never sanitized, never a replay fixture. */
  body: Uint8Array<ArrayBuffer>;
}

/** Static sanitized failure; `detail` is a fixed literal, never input data. */
export type RetainedCaptureErrorV1 =
  | { kind: "invalid_key"; detail: "retained capture key must be 32 bytes" }
  | {
    kind: "invalid_manifest";
    detail: "retained capture manifest is not the supported producer shape";
  }
  | {
    kind: "tampered_metadata";
    detail: "retained capture metadata does not match its manifest";
  }
  | {
    kind: "tampered_ciphertext";
    detail: "retained capture ciphertext does not match its digest";
  }
  | {
    kind: "authentication_failed";
    detail: "retained capture failed authenticated decryption";
  }
  | {
    kind: "invalid_envelope";
    detail: "retained capture envelope is malformed";
  }
  | {
    kind: "oversized_plaintext";
    detail: "retained capture plaintext exceeds its size bound";
  }
  | {
    kind: "invalid_plaintext";
    detail: "retained capture plaintext metadata is invalid";
  }
  | {
    kind: "unsupported_metadata_version";
    detail: "retained capture metadata version is unsupported";
  }
  | {
    kind: "tampered_manifest";
    detail: "retained capture HMAC identity does not match its manifest";
  };

export type RetainedCaptureResultV1 =
  | { ok: true; value: RetainedGatewayCaptureV1 }
  | { ok: false; error: RetainedCaptureErrorV1 };

/**
 * Authenticate and decrypt one retained capture. Caller supplies the existing
 * producer key bytes; verified 32-byte length, then every producer identity is
 * recomputed. The caller-owned key and ciphertext buffers are never mutated.
 */
export async function decryptRetainedGatewayCapture(
  artifact: StoredArtifactV1,
  keyBytes: Uint8Array<ArrayBuffer>,
): Promise<RetainedCaptureResultV1> {
  if (keyBytes.byteLength !== RETAINED_KEY_BYTES) {
    return fail("invalid_key");
  }
  const manifest = validateManifest(artifact.manifest);
  if (manifest === null) return fail("invalid_manifest");
  if (!matchesRetainedIdentity(artifact, manifest)) {
    return fail("tampered_metadata");
  }
  if (artifact.ciphertext.byteLength !== manifest.ciphertextBytes) {
    return fail("tampered_metadata");
  }
  if (await sha256Hex(artifact.ciphertext) !== artifact.digest) {
    return fail("tampered_ciphertext");
  }
  const iv = decodeBase64Url(manifest.iv);
  if (iv === null || iv.byteLength !== RETAINED_IV_BYTES) {
    // The wire parser already enforces this; stay fail-closed regardless.
    return fail("invalid_manifest");
  }

  let compressed: Uint8Array<ArrayBuffer> | null = null;
  let plaintext: Uint8Array<ArrayBuffer> | null = null;
  try {
    const aesResult = await aesGcmDecrypt(
      keyBytes,
      iv,
      artifact.ciphertext,
      manifest.fingerprint,
    );
    if (aesResult === null) return fail("authentication_failed");
    compressed = aesResult;

    const gunzipResult = await gunzipBounded(compressed);
    if (!gunzipResult.ok) {
      return fail(
        gunzipResult.reason === "oversized"
          ? "oversized_plaintext"
          : "invalid_envelope",
      );
    }
    plaintext = gunzipResult.value;

    const envelope = decodeEnvelope(plaintext);
    if (!envelope.ok) return fail(envelope.reason);

    const metadata = envelope.metadata;

    const hmacResult = await verifyProducerIdentities(
      keyBytes,
      metadata,
      manifest,
    );
    if (!hmacResult) return fail("tampered_manifest");

    return {
      ok: true,
      value: {
        version: 1,
        captureId: manifest.captureId,
        fingerprint: manifest.fingerprint,
        caseGroupDigest: manifest.caseGroupDigest,
        capturedAt: manifest.capturedAt,
        expiresAt: manifest.expiresAt,
        requestId: metadata.request_id,
        gitSha: metadata.git_sha,
        denoRevision: metadata.deno_revision,
        endpoint: metadata.endpoint,
        method: metadata.method,
        contentType: metadata.content_type,
        compatibilityHeaders: metadata.compatibility_headers,
        failureSignature: metadata.failure_signature,
        observation: mapObservation(metadata.observation),
        clientObservation: mapClientObservation(metadata.client_observation),
        upstream: mapUpstream(metadata.upstream),
        body: cloneBytes(metadata.bodyBytes),
      },
    };
  } finally {
    compressed?.fill(0);
    plaintext?.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Manifest and retained-metadata identity
// ---------------------------------------------------------------------------

/**
 * Re-parse the preserved producer manifest through the frozen wire parser:
 * every structural rule (version, IV, chunk grid, byte bounds, lifetime) is
 * enforced again at the decryption boundary.
 */
function validateManifest(
  manifest: GatewayReplayManifestV1,
): GatewayReplayManifestV1 | null {
  try {
    return parseGatewayReplayManifestV1(replayManifestToWire(manifest));
  } catch {
    return null;
  }
}

/** Stored metadata must name the exact object it claims to retain. */
function matchesRetainedIdentity(
  artifact: StoredArtifactV1,
  manifest: GatewayReplayManifestV1,
): boolean {
  if (artifact.captureId !== manifest.captureId) return false;
  if (artifact.fingerprint !== manifest.fingerprint) return false;
  if (artifact.caseGroupDigest !== manifest.caseGroupDigest) return false;
  if (artifact.sourceCapturedAt !== manifest.capturedAt) return false;
  if (artifact.sourceExpiresAt !== manifest.expiresAt) return false;
  if (artifact.sizeBytes !== manifest.ciphertextBytes) return false;
  return true;
}

// ---------------------------------------------------------------------------
// AES-GCM decryption and bounded gzip expansion
// ---------------------------------------------------------------------------

async function deriveKeyBytes(
  keyBytes: Uint8Array<ArrayBuffer>,
  purpose: "encryption" | "fingerprint" | "case-group",
): Promise<Uint8Array<ArrayBuffer>> {
  const material = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: KEY_DERIVATION_SALT,
      info: TEXT_ENCODER.encode(purpose),
    },
    material,
    256,
  );
  return new Uint8Array(bits);
}

async function importAesKey(
  keyBytes: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const derived = await deriveKeyBytes(keyBytes, "encryption");
  try {
    return await crypto.subtle.importKey(
      "raw",
      derived,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
  } finally {
    derived.fill(0);
  }
}

async function aesGcmDecrypt(
  keyBytes: Uint8Array<ArrayBuffer>,
  iv: Uint8Array<ArrayBuffer>,
  ciphertext: Uint8Array<ArrayBuffer>,
  fingerprint: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const key = await importAesKey(keyBytes);
  try {
    const additionalData = TEXT_ENCODER.encode(
      `${RETAINED_NAMESPACE}\u0000${fingerprint}`,
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData },
      key,
      ciphertext,
    );
    return new Uint8Array(decrypted);
  } catch {
    return null;
  }
}

type GunzipResult =
  | { ok: true; value: Uint8Array<ArrayBuffer> }
  | { ok: false; reason: "invalid" | "oversized" };

/**
 * Streaming bounded decompression — never `Response.arrayBuffer()` on the
 * expanded body. The bound is the exact producer plaintext maximum; every
 * collected partial chunk is zeroed on any failure, the over-bound chunk is
 * cleared, and an early failure cancels the stream before the reader lock is
 * released so the producer pipeline settles (no lingering plaintext).
 */
async function gunzipBounded(
  compressed: Uint8Array<ArrayBuffer>,
): Promise<GunzipResult> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const stream = new Blob([compressed]).stream().pipeThrough(
      new DecompressionStream("gzip"),
    );
    reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RETAINED_PLAINTEXT_MAX_BYTES) {
        zeroAll(parts);
        value.fill(0);
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "oversized" };
      }
      parts.push(cloneBytes(value));
      value.fill(0);
    }
    const output = concatBytes(parts);
    zeroAll(parts);
    return { ok: true, value: output };
  } catch {
    zeroAll(parts);
    await reader?.cancel().catch(() => {});
    return { ok: false, reason: "invalid" };
  } finally {
    reader?.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Envelope and producer metadata parsing
// ---------------------------------------------------------------------------

type EnvelopeResult =
  | {
    ok: true;
    metadata: ParsedRetainedMetadata;
  }
  | {
    ok: false;
    reason:
      | "invalid_envelope"
      | "oversized_plaintext"
      | "invalid_plaintext"
      | "unsupported_metadata_version";
  };

interface ParsedRetainedMetadata {
  version: number;
  captured_at_ms: number;
  endpoint: string;
  method: string;
  content_type: string | null;
  compatibility_headers: Record<string, string>;
  failure_signature: string;
  observation: RetainedObservationWire;
  client_observation: RetainedClientObservationWire;
  request_id: string;
  git_sha: string;
  deno_revision: string;
  upstream: RetainedUpstreamWire;
  /** Exact body slice of the envelope buffer (view, not a copy). */
  bodyBytes: Uint8Array<ArrayBuffer>;
}

/**
 * Provenance-free envelope layout: 4-byte big-endian metadata length,
 * metadata JSON, then the exact request bytes (producer `decodePlaintext`).
 */
function decodeEnvelope(
  bytes: Uint8Array<ArrayBuffer>,
): EnvelopeResult {
  if (
    bytes.byteLength < 4 || bytes.byteLength > RETAINED_PLAINTEXT_MAX_BYTES
  ) {
    return { ok: false, reason: "invalid_envelope" };
  }
  const metadataLength = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    4,
  ).getUint32(0, false);
  if (metadataLength > RETAINED_METADATA_MAX_BYTES) {
    return { ok: false, reason: "invalid_envelope" };
  }
  const bodyOffset = 4 + metadataLength;
  if (bodyOffset > bytes.byteLength) {
    return { ok: false, reason: "invalid_envelope" };
  }
  if (bytes.byteLength - bodyOffset > RETAINED_BODY_MAX_BYTES) {
    return { ok: false, reason: "oversized_plaintext" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      TEXT_DECODER.decode(bytes.subarray(4, bodyOffset)),
    );
  } catch {
    return { ok: false, reason: "invalid_plaintext" };
  }
  const metadata = parseMetadataObject(parsed);
  if (!metadata.ok) {
    return { ok: false, reason: metadata.reason };
  }
  return {
    ok: true,
    metadata: {
      ...metadata.value,
      bodyBytes: bytes.subarray(bodyOffset),
    },
  };
}

function parseMetadataObject(
  value: unknown,
):
  | { ok: true; value: Omit<ParsedRetainedMetadata, "bodyBytes"> }
  | {
    ok: false;
    reason: "invalid_plaintext" | "unsupported_metadata_version";
  } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "invalid_plaintext" };
  }
  const obj = value as Record<string, unknown>;
  // Hard cutover: request-only v1 plaintext is unsupported and never counts
  // as upstream evidence; check the version before shape validation so the
  // real v1 golden gets the explicit unsupported error.
  if (obj.version === RETAINED_LEGACY_METADATA_VERSION) {
    return { ok: false, reason: "unsupported_metadata_version" };
  }
  if (obj.version !== RETAINED_METADATA_VERSION) {
    return { ok: false, reason: "invalid_plaintext" };
  }
  if (!hasExactKeys(obj, METADATA_KEYS)) {
    return { ok: false, reason: "invalid_plaintext" };
  }
  if (
    !Number.isSafeInteger(obj.captured_at_ms) ||
    (obj.captured_at_ms as number) < 0
  ) {
    return { ok: false, reason: "invalid_plaintext" };
  }
  if (obj.endpoint === null || typeof obj.endpoint !== "string") {
    return { ok: false, reason: "invalid_plaintext" };
  }
  if (obj.method === null || typeof obj.method !== "string") {
    return { ok: false, reason: "invalid_plaintext" };
  }
  if (
    obj.content_type !== null && typeof obj.content_type !== "string"
  ) {
    return { ok: false, reason: "invalid_plaintext" };
  }
  if (!isCompatibilityHeaders(obj.compatibility_headers)) {
    return { ok: false, reason: "invalid_plaintext" };
  }
  if (
    obj.failure_signature === null || typeof obj.failure_signature !== "string"
  ) {
    return { ok: false, reason: "invalid_plaintext" };
  }
  const observation = parseObservation(obj.observation);
  if (observation === null) {
    return { ok: false, reason: "invalid_plaintext" };
  }
  const clientObservation = parseClientObservation(obj.client_observation);
  if (clientObservation === null) {
    return { ok: false, reason: "invalid_plaintext" };
  }
  for (const key of ["request_id", "git_sha", "deno_revision"] as const) {
    if (obj[key] === null || typeof obj[key] !== "string") {
      return { ok: false, reason: "invalid_plaintext" };
    }
  }
  const upstream = parseUpstream(obj.upstream);
  if (upstream === null) {
    return { ok: false, reason: "invalid_plaintext" };
  }
  return {
    ok: true,
    value: {
      version: obj.version as number,
      captured_at_ms: obj.captured_at_ms as number,
      endpoint: obj.endpoint as string,
      method: obj.method as string,
      content_type: obj.content_type as string | null,
      compatibility_headers: obj.compatibility_headers as Record<
        string,
        string
      >,
      failure_signature: obj.failure_signature as string,
      observation,
      client_observation: clientObservation,
      request_id: obj.request_id as string,
      git_sha: obj.git_sha as string,
      deno_revision: obj.deno_revision as string,
      upstream,
    },
  };
}

function parseObservation(
  value: unknown,
): RetainedObservationWire | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (!hasExactKeys(obj, OBSERVATION_KEYS)) return null;
  if (!Number.isSafeInteger(obj.status)) return null;
  if (obj.stream !== null && typeof obj.stream !== "boolean") return null;
  if (typeof obj.completed !== "boolean") return null;
  for (
    const key of [
      "terminal_type",
      "failure_kind",
      "synthetic_terminal_type",
    ] as const
  ) {
    if (obj[key] !== null && typeof obj[key] !== "string") return null;
  }
  if (typeof obj.provider_route !== "string") return null;
  return {
    status: obj.status as number,
    stream: obj.stream as boolean | null,
    completed: obj.completed as boolean,
    terminal_type: obj.terminal_type as string | null,
    failure_kind: obj.failure_kind as string | null,
    synthetic_terminal_type: obj.synthetic_terminal_type as string | null,
    provider_route: obj.provider_route as string,
  };
}

function parseClientObservation(
  value: unknown,
): RetainedClientObservationWire | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (!hasExactKeys(obj, CLIENT_OBSERVATION_KEYS)) return null;
  if (!Number.isSafeInteger(obj.status)) return null;
  if (typeof obj.stream !== "boolean") return null;
  if (typeof obj.completed !== "boolean") return null;
  for (const key of ["terminal_type", "failure_kind"] as const) {
    if (obj[key] !== null && typeof obj[key] !== "string") return null;
  }
  if (typeof obj.framing_valid !== "boolean") return null;
  if (typeof obj.provider_route !== "string") return null;
  return {
    status: obj.status as number,
    stream: obj.stream as boolean,
    completed: obj.completed as boolean,
    terminal_type: obj.terminal_type as string | null,
    failure_kind: obj.failure_kind as string | null,
    framing_valid: obj.framing_valid as boolean,
    provider_route: obj.provider_route as string,
  };
}

// ---------------------------------------------------------------------------
// Private upstream trace parsing (docs/contracts.md §12)
// ---------------------------------------------------------------------------

/**
 * Strict internal snapshot parser. Crypto-authenticated JSON is still
 * untrusted input: exact keys, frozen enums, canonical padded base64, the
 * aggregate decoded-byte/chunk/attempt bounds and every frozen cross-field
 * relation are enforced before the trace is canonicalized or used.
 */
function parseUpstream(value: unknown): RetainedUpstreamWire | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (!hasExactKeys(obj, UPSTREAM_KEYS)) return null;
  if (obj.version !== RETAINED_UPSTREAM_VERSION) return null;
  for (
    const key of [
      "attempts_truncated",
      "bytes_truncated",
      "chunks_truncated",
    ] as const
  ) {
    if (typeof obj[key] !== "boolean") return null;
  }
  if (!Array.isArray(obj.attempts)) return null;
  if (obj.attempts.length > RETAINED_UPSTREAM_MAX_ATTEMPTS) return null;
  const attempts: RetainedUpstreamAttemptWire[] = [];
  let decodedBytes = 0;
  let chunkCount = 0;
  for (const item of obj.attempts) {
    const parsed = parseUpstreamAttempt(item);
    if (parsed === null) return null;
    attempts.push(parsed.attempt);
    decodedBytes += parsed.decodedBytes;
    chunkCount += parsed.chunkCount;
    if (decodedBytes > RETAINED_UPSTREAM_MAX_DECODED_BYTES) return null;
    if (chunkCount > RETAINED_UPSTREAM_MAX_CHUNKS) return null;
  }
  return {
    version: 1,
    attempts,
    attempts_truncated: obj.attempts_truncated as boolean,
    bytes_truncated: obj.bytes_truncated as boolean,
    chunks_truncated: obj.chunks_truncated as boolean,
  };
}

interface ParsedUpstreamAttempt {
  attempt: RetainedUpstreamAttemptWire;
  decodedBytes: number;
  chunkCount: number;
}

function parseUpstreamAttempt(value: unknown): ParsedUpstreamAttempt | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (!hasExactKeys(obj, UPSTREAM_ATTEMPT_KEYS)) return null;
  if (typeof obj.provider !== "string") return null;
  if (!UPSTREAM_PROVIDER_SET.has(obj.provider)) return null;
  if (typeof obj.terminal !== "string") return null;
  if (!UPSTREAM_TERMINAL_SET.has(obj.terminal)) return null;
  let status: number | null;
  if (obj.status === null) {
    status = null;
  } else if (
    Number.isSafeInteger(obj.status) &&
    (obj.status as number) >= 100 &&
    (obj.status as number) <= 599
  ) {
    status = obj.status as number;
  } else {
    return null;
  }
  let contentType: RetainedUpstreamContentType | null;
  if (obj.content_type === null) {
    contentType = null;
  } else if (typeof obj.content_type === "string") {
    if (!UPSTREAM_CONTENT_TYPE_SET.has(obj.content_type)) return null;
    contentType = obj.content_type as RetainedUpstreamContentType;
  } else {
    return null;
  }
  // Frozen header state: status and content_type are null together.
  if ((status === null) !== (contentType === null)) return null;
  if (!Array.isArray(obj.chunks_base64)) return null;
  const decoded: Uint8Array<ArrayBuffer>[] = [];
  let decodedBytes = 0;
  try {
    for (const encoded of obj.chunks_base64) {
      if (typeof encoded !== "string") return null;
      const bytes = decodeCanonicalBase64(encoded);
      if (bytes === null) return null;
      decoded.push(bytes);
      decodedBytes += bytes.byteLength;
    }
    // Before-header attempts have no chunks; a fetch_error never got headers.
    if (status === null && decoded.length !== 0) return null;
    if (obj.terminal === "fetch_error" && status !== null) return null;
    // Header-bearing read_error/cancelled/eof require a status (frozen §12).
    if (
      status === null &&
      (obj.terminal === "eof" ||
        obj.terminal === "read_error" ||
        obj.terminal === "cancelled")
    ) {
      return null;
    }
    return {
      attempt: {
        provider: obj.provider as RetainedUpstreamProvider,
        status,
        content_type: contentType,
        chunks_base64: obj.chunks_base64 as string[],
        terminal: obj.terminal as RetainedUpstreamTerminal,
      },
      decodedBytes,
      chunkCount: decoded.length,
    };
  } finally {
    // Decoded chunk buffers exist only for validation/bounds; zero them.
    zeroAll(decoded);
  }
}

const CANONICAL_PADDED_BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const STANDARD_BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Strict canonical padded standard-base64 decode: exact alphabet, `%4 === 0`
 * padded form with `=` only trailing, and zero pad bits (a re-encoding must
 * return the identical string). Empty strings are not chunks (never valid).
 */
function decodeCanonicalBase64(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length === 0 || !CANONICAL_PADDED_BASE64_RE.test(text)) {
    return null;
  }
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  let lastDataChar = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "=") continue;
    lastDataChar = char;
    const decoded = STANDARD_BASE64_ALPHABET.indexOf(char);
    if (decoded === -1) return null;
    value = (value << 6) | decoded;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  const lastValue = STANDARD_BASE64_ALPHABET.indexOf(lastDataChar);
  if (text.endsWith("==")) {
    // 8 bits from 12: the last 4 bits must be zero.
    if ((lastValue & 0x0f) !== 0) return null;
  } else if (text.endsWith("=")) {
    // 16 bits from 18: the last 2 bits must be zero.
    if ((lastValue & 0x03) !== 0) return null;
  }
  return new Uint8Array(bytes);
}

// ---------------------------------------------------------------------------
// Canonical upstream JSON (fingerprint frame, docs/contracts.md §12)
// ---------------------------------------------------------------------------

/**
 * Frozen upstream frame: recursive lexicographic (UTF-16 code-unit) object-key
 * sort, preserved array order, JSON.stringify primitive/string encoding and no
 * whitespace. Only called after strict validation, so every value is a
 * validated JSON primitive/array/plain object.
 */
function canonicalUpstreamJson(upstream: RetainedUpstreamWire): string {
  return canonicalJson(upstream);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error("non-finite number in canonical upstream JSON");
      }
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (Array.isArray(value)) {
        const items = value.map((item) => canonicalJson(item));
        return `[${items.join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const fields = keys.map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key])}`
      );
      return `{${fields.join(",")}}`;
    }
    default:
      throw new Error(`cannot canonically serialize ${typeof value}`);
  }
}

function isCompatibilityHeaders(
  value: unknown,
): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  for (const [name, headerValue] of Object.entries(value)) {
    if (!COMPATIBILITY_HEADER_NAME_SET.has(name)) return false;
    if (typeof headerValue !== "string") return false;
    if (headerValue.length === 0 || headerValue.trim() !== headerValue) {
      return false;
    }
  }
  return true;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size) return false;
  for (const key of actual) {
    if (!expected.has(key)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Producer identity recomputation (source: fingerprintParts, frozen)
// ---------------------------------------------------------------------------

/** Exact producer `sentinelFailureSignature` (field order is significant). */
function sentinelFailureSignature(
  observation: RetainedClientObservationWire,
): string {
  return JSON.stringify({
    status: observation.status,
    stream: observation.stream,
    completed: observation.completed,
    terminal_type: observation.terminal_type,
    failure_kind: observation.failure_kind,
    framing_valid: observation.framing_valid,
    provider_route: observation.provider_route,
  });
}

/** Exact producer `stableHeaderText` (sorted name:value lines). */
function stableHeaderText(headers: Record<string, string>): string {
  return Object.entries(headers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}`)
    .join("\n");
}

/**
 * Exact producer `fingerprintParts` message: 8-byte big-endian length frame
 * around [purpose label, method, endpoint, stable headers, body] plus, for the
 * fingerprint purpose only, the framed failure signature and one final frame
 * of canonical upstream JSON under the v2 namespace. The case-group purpose
 * stays exactly the v1 request-only identity.
 */
function fingerprintParts(
  metadata: ParsedRetainedMetadata,
  purpose: "fingerprint" | "case-group",
  upstreamFrame: Uint8Array<ArrayBuffer> | null,
): Uint8Array<ArrayBuffer>[] {
  const frame = (value: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>[] => {
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(
      0,
      BigInt(value.byteLength),
      false,
    );
    return [length, value];
  };
  const namespace = purpose === "fingerprint"
    ? `${RETAINED_FINGERPRINT_NAMESPACE}:fingerprint`
    : `${RETAINED_NAMESPACE}:case-group`;
  const common = [
    ...frame(TEXT_ENCODER.encode(namespace)),
    ...frame(TEXT_ENCODER.encode(metadata.method)),
    ...frame(TEXT_ENCODER.encode(metadata.endpoint)),
    ...frame(
      TEXT_ENCODER.encode(stableHeaderText(metadata.compatibility_headers)),
    ),
  ];
  return purpose === "fingerprint"
    ? [
      ...common,
      ...frame(metadata.bodyBytes),
      ...frame(TEXT_ENCODER.encode(metadata.failure_signature)),
      ...frame(upstreamFrame!),
    ]
    : [...common, ...frame(metadata.bodyBytes)];
}

async function hmacHex(
  keyBytes: Uint8Array<ArrayBuffer>,
  purpose: "fingerprint" | "case-group",
  parts: readonly Uint8Array<ArrayBuffer>[],
): Promise<string> {
  const derived = await deriveKeyBytes(keyBytes, purpose);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      derived,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } finally {
    derived.fill(0);
  }
  const message = concatBytes(parts);
  try {
    const digest = await crypto.subtle.sign("HMAC", key, message);
    return toHex(new Uint8Array(digest));
  } finally {
    message.fill(0);
  }
}

/**
 * Recompute both producer HMAC identities plus the failure signature and
 * capture time against the manifest. `fingerprint` binds the failure signature
 * (it is framed into the message) and `captured_at_ms` is compared directly.
 */
async function verifyProducerIdentities(
  keyBytes: Uint8Array<ArrayBuffer>,
  metadata: ParsedRetainedMetadata,
  manifest: GatewayReplayManifestV1,
): Promise<boolean> {
  const upstreamFrame = TEXT_ENCODER.encode(
    canonicalUpstreamJson(metadata.upstream),
  );
  let fingerprint: string;
  try {
    fingerprint = await hmacHex(
      keyBytes,
      "fingerprint",
      fingerprintParts(metadata, "fingerprint", upstreamFrame),
    );
  } finally {
    // The canonical frame embeds private base64 trace bytes: zero it.
    upstreamFrame.fill(0);
  }
  const caseGroupDigest = await hmacHex(
    keyBytes,
    "case-group",
    fingerprintParts(metadata, "case-group", null),
  );
  if (fingerprint !== manifest.fingerprint) return false;
  if (caseGroupDigest !== manifest.caseGroupDigest) return false;
  if (metadata.captured_at_ms !== manifest.capturedAt) return false;
  if (
    sentinelFailureSignature(metadata.client_observation) !==
      metadata.failure_signature
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Mapping and byte helpers
// ---------------------------------------------------------------------------

function mapObservation(
  observation: RetainedObservationWire,
): RetainedGatewayObservationV1 {
  return {
    status: observation.status,
    stream: observation.stream,
    completed: observation.completed,
    terminalType: observation.terminal_type,
    failureKind: observation.failure_kind,
    syntheticTerminalType: observation.synthetic_terminal_type,
    providerRoute: observation.provider_route,
  };
}

function mapClientObservation(
  observation: RetainedClientObservationWire,
): RetainedGatewayClientObservationV1 {
  return {
    status: observation.status,
    stream: observation.stream,
    completed: observation.completed,
    terminalType: observation.terminal_type,
    failureKind: observation.failure_kind,
    framingValid: observation.framing_valid,
    providerRoute: observation.provider_route,
  };
}

/** Private raw trace: passthrough with frozen snake_case names, no extras. */
function mapUpstream(
  upstream: RetainedUpstreamWire,
): RetainedGatewayUpstreamV1 {
  return {
    version: upstream.version,
    attempts: upstream.attempts.map((attempt) => ({
      provider: attempt.provider,
      status: attempt.status,
      content_type: attempt.content_type,
      chunks_base64: attempt.chunks_base64,
      terminal: attempt.terminal,
    })),
    attempts_truncated: upstream.attempts_truncated,
    bytes_truncated: upstream.bytes_truncated,
    chunks_truncated: upstream.chunks_truncated,
  };
}

function fail(
  kind: RetainedCaptureErrorV1["kind"],
): RetainedCaptureResultV1 {
  const error = ERROR_DETAILS[kind];
  return {
    ok: false,
    error: { kind, detail: error } as RetainedCaptureErrorV1,
  };
}

const ERROR_DETAILS: Record<RetainedCaptureErrorV1["kind"], string> = {
  invalid_key: "retained capture key must be 32 bytes",
  invalid_manifest:
    "retained capture manifest is not the supported producer shape",
  tampered_metadata: "retained capture metadata does not match its manifest",
  tampered_ciphertext: "retained capture ciphertext does not match its digest",
  authentication_failed: "retained capture failed authenticated decryption",
  invalid_envelope: "retained capture envelope is malformed",
  oversized_plaintext: "retained capture plaintext exceeds its size bound",
  invalid_plaintext: "retained capture plaintext metadata is invalid",
  unsupported_metadata_version:
    "retained capture metadata version is unsupported",
  tampered_manifest:
    "retained capture HMAC identity does not match its manifest",
};

function cloneBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}

function concatBytes(
  parts: readonly Uint8Array[],
): Uint8Array<ArrayBuffer> {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function zeroAll(parts: readonly Uint8Array[]): void {
  for (const part of parts) part.fill(0);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
