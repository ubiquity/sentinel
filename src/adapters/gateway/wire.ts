/**
 * Strict wire parsers for the gateway producer HTTP contract
 * (docs/contracts.md §11, frozen).
 *
 * Two wire surfaces are parsed here:
 *
 * 1. The PROPOSED unresolved-discovery index
 *    `GET /admin/sentinel/incidents` -> { data, cursor, coverage }. The
 *    current target does not implement this endpoint (m06 is postponed);
 *    the adapter maps a missing endpoint to `unavailable`, never to an empty
 *    success.
 * 2. The EXISTING replay export
 *    `GET /admin/sentinel/replay-captures` -> { data: [{ manifest, chunks }],
 *    cursor }. The manifest/chunk schema below is the exact wire schema of
 *    `src/sentinel_replay_capture.ts` at the recorded target snapshot
 *    `aafb7ee0598699bb7fb8a72ea133693ed64462da` (read-only inspection): one
 *    `manifest` with `version: 1`, `capture_id`, HMAC-based `fingerprint`
 *    (never a ciphertext digest), `case_group_digest`, `captured_at_ms`,
 *    `expires_at_ms`, `algorithm: "AES-256-GCM"`, `compression: "gzip"`,
 *    base64url `iv` (12 bytes), `chunk_count` and `ciphertext_bytes`, plus
 *    `chunks` — `chunk_count` unpadded base64url strings whose decoded byte
 *    lengths are exactly `SENTINEL_REPLAY_CHUNK_BYTES` (48 KiB) except the
 *    final chunk, which is the exact remainder of `ciphertext_bytes`.
 *
 * Every parser fails closed: unknown keys, missing keys, out-of-format
 * identities, malformed values and length violations are rejected with a
 * typed `GatewayWireError` whose `detail` never echoes the invalid input
 * (values may be arbitrary secrets). The frozen contract parsers
 * (`parseIncidentSummaryV1`) remain the authority for the mapped record.
 */

import {
  asEncryptedArtifactDigest,
  asIncidentFingerprint,
  type EncryptedArtifactDigest,
  type GitSha,
  type IncidentFingerprint,
} from "../../contracts/brands.ts";
import { parseIncidentSummaryV1 } from "../../contracts/incident.ts";
import type { IncidentSummaryV1 } from "../../contracts/incident.ts";
import { parseIncidentCoverage } from "../../contracts/shared.ts";
import type {
  IncidentCoverageV1,
  RepositoryIdentityV1,
} from "../../contracts/shared.ts";

/** The target's existing incident identity format (frozen, see docs §11). */
export const GATEWAY_INCIDENT_ID =
  /^provider-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Producer replay chunk size, exactly `SENTINEL_REPLAY_CHUNK_BYTES` at the
 * recorded snapshot. Every non-final chunk decodes to exactly this many bytes. */
export const GATEWAY_REPLAY_CHUNK_BYTES = 48 * 1_024;

/**
 * Exact producer lifetime: `expires_at_ms === captured_at_ms +
 * SENTINEL_REPLAY_TTL_MS` (capture.ts at the recorded snapshot). A manifest
 * with any other lifetime never comes from the current producer.
 */
export const GATEWAY_REPLAY_TTL_MS = 48 * 60 * 60 * 1_000;

/**
 * Exact producer bounds (capture.ts at the recorded snapshot): the replay
 * body cap is `MAX_ACCEPTED_JSON_BODY_BYTES` (32 MiB, request.ts), plaintext
 * adds 256 KiB metadata + 4 length bytes, ciphertext adds 1 MiB and the
 * 16-byte GCM tag; `MAX_REPLAY_CHUNKS` is the ceiling of that over the chunk
 * size. Manifests outside these bounds never come from the current producer.
 */
export const GATEWAY_REPLAY_MAX_CIPHERTEXT_BYTES = 32 * 1_024 * 1_024 +
  256 * 1_024 + 4 + 1_024 * 1_024 + 16;
export const GATEWAY_REPLAY_MAX_CHUNKS = Math.ceil(
  GATEWAY_REPLAY_MAX_CIPHERTEXT_BYTES / GATEWAY_REPLAY_CHUNK_BYTES,
);

/** Encryption/gzip metadata the producer always writes (frozen). */
export const GATEWAY_REPLAY_ALGORITHM = "AES-256-GCM";
export const GATEWAY_REPLAY_COMPRESSION = "gzip";
export const GATEWAY_REPLAY_ENVELOPE_VERSION = 1;
export const GATEWAY_REPLAY_IV_BYTES = 12;

/** Structural bounds independent of any data emptiness. */
export const GATEWAY_CURSOR_MAX_LENGTH = 2_048;
export const GATEWAY_INDEX_PAGE_BYTE_CAP = 1 * 1_024 * 1_024;
export const GATEWAY_RESPONSE_BYTE_CEILING = 64 * 1_024 * 1_024;
export const GATEWAY_MAX_SCAN_PAGES = 128;
export const GATEWAY_MAX_ARTIFACTS_PER_EVIDENCE = 16;

const REPLAY_CHUNK_RE = /^[A-Za-z0-9_-]+$/;
/** Exact producer cursor charset (`KV_CURSOR` in the recorded snapshot). */
const REPLAY_EXPORT_CURSOR = /^[A-Za-z0-9_-]+={0,2}$/;
const REPLAY_CAPTURE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const IV_TEXT = /^[A-Za-z0-9_-]{16,24}$/;

/** Typed wire failure; `detail` is always a static sanitized string. */
export class GatewayWireError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "GatewayWireError";
    this.code = code;
  }
}

function expectRecordWithKeys(
  value: unknown,
  keys: readonly string[],
  context: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayWireError(
      "wire_invalid_shape",
      `${context} must be a plain object`,
    );
  }
  const obj = value as Record<string, unknown>;
  const known = new Set(keys);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      throw new GatewayWireError(
        "wire_unknown_key",
        `${context} contains an unknown key`,
      );
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(obj, key)) {
      throw new GatewayWireError(
        "wire_missing_key",
        `${context} is missing a required key`,
      );
    }
  }
  return obj;
}

function expectString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GatewayWireError(
      "wire_invalid_value",
      `${context} must be a non-empty string`,
    );
  }
  return value;
}

function expectSafeInt(value: unknown, context: string): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
  ) {
    throw new GatewayWireError(
      "wire_invalid_value",
      `${context} must be a nonnegative safe integer`,
    );
  }
  return value;
}

function expectNullableString(value: unknown, context: string): string | null {
  if (value === null) return null;
  return expectString(value, context);
}

// ---------------------------------------------------------------------------
// Proposed unresolved-discovery index (docs/contracts.md §11).
// ---------------------------------------------------------------------------

export const GATEWAY_INDEX_ROW_KEYS = [
  "incident_id",
  "fingerprint",
  "severity",
  "first_seen_at_ms",
  "last_seen_at_ms",
  "count",
  "failing_revision",
  "error_type",
  "context",
  "provenance",
  "evidence_ref",
  "evidence_expires_at_ms",
] as const;
export const GATEWAY_CONTEXT_KEYS = ["message", "location", "sample"] as const;
export const GATEWAY_PROVENANCE_KEYS = [
  "endpoint",
  "captured_at_ms",
  "captured_by",
] as const;
export const GATEWAY_EVIDENCE_REF_KEYS = ["ref", "digest"] as const;
export const GATEWAY_INDEX_PAGE_KEYS = ["data", "cursor", "coverage"] as const;

export interface GatewayIndexRowV1 {
  incidentId: string;
  fingerprint: IncidentFingerprint;
  severity: "P0" | "P1" | "P2" | "P3";
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  failingRevision: GitSha | null;
  errorType: string;
  context: { message: string; location: string | null; sample: string[] };
  provenance: {
    endpoint: string;
    capturedAt: number;
    capturedBy: string | null;
  };
  evidenceRef: { ref: string; digest: EncryptedArtifactDigest | null } | null;
  /** Source capture expiry; consumed by the evidence stage, never the summary. */
  evidenceExpiresAt: number | null;
}

export interface GatewayIndexPageV1 {
  rows: GatewayIndexRowV1[];
  cursor: string | null;
  coverage: IncidentCoverageV1;
}

/** Strict wire row → typed row; the frozen record parser stays the authority. */
export function parseGatewayIndexRowV1(input: unknown): GatewayIndexRowV1 {
  const row = expectRecordWithKeys(
    input,
    GATEWAY_INDEX_ROW_KEYS,
    "gateway index row",
  );
  const incidentId = expectString(row.incident_id, "incident_id");
  if (!GATEWAY_INCIDENT_ID.test(incidentId)) {
    throw new GatewayWireError(
      "wire_invalid_identity",
      "incident_id is not in the frozen provider-UUID format",
    );
  }
  const fingerprintText = expectString(row.fingerprint, "fingerprint");
  if (!SHA256_HEX.test(fingerprintText)) {
    throw new GatewayWireError(
      "wire_invalid_digest",
      "fingerprint must be a 64-hex SHA-256 identity",
    );
  }
  const severity = expectString(row.severity, "severity");
  if (
    severity !== "P0" && severity !== "P1" && severity !== "P2" &&
    severity !== "P3"
  ) {
    throw new GatewayWireError(
      "wire_invalid_enum",
      "severity must be one of P0/P1/P2/P3",
    );
  }
  const firstSeenAt = expectSafeInt(row.first_seen_at_ms, "first_seen_at_ms");
  const lastSeenAt = expectSafeInt(row.last_seen_at_ms, "last_seen_at_ms");
  const count = expectSafeInt(row.count, "count");
  if (lastSeenAt < firstSeenAt || count < 1) {
    throw new GatewayWireError(
      "wire_invalid_value",
      "last_seen_at_ms/count violate the frozen row rules",
    );
  }
  let failingRevision: GitSha | null = null;
  if (row.failing_revision !== null) {
    const text = expectString(row.failing_revision, "failing_revision");
    if (!GIT_SHA.test(text)) {
      throw new GatewayWireError(
        "wire_invalid_identity",
        "failing_revision must be a 40-hex Git SHA",
      );
    }
    failingRevision = text as GitSha;
  }
  const errorType = expectString(row.error_type, "error_type");

  const context = expectRecordWithKeys(
    row.context,
    GATEWAY_CONTEXT_KEYS,
    "gateway index context",
  );
  const sampleValue = context.sample;
  if (!Array.isArray(sampleValue)) {
    throw new GatewayWireError(
      "wire_invalid_value",
      "context.sample must be an array",
    );
  }
  const sample: string[] = [];
  for (const item of sampleValue) {
    if (typeof item !== "string" || item.length === 0) {
      throw new GatewayWireError(
        "wire_invalid_value",
        "context.sample entries must be non-empty strings",
      );
    }
    sample.push(item);
  }

  const provenance = expectRecordWithKeys(
    row.provenance,
    GATEWAY_PROVENANCE_KEYS,
    "gateway index provenance",
  );
  const endpoint = expectString(provenance.endpoint, "provenance.endpoint");
  const capturedAt = expectSafeInt(
    provenance.captured_at_ms,
    "provenance.captured_at_ms",
  );
  const capturedBy = expectNullableString(
    provenance.captured_by,
    "provenance.captured_by",
  );

  let evidenceRef:
    | { ref: string; digest: EncryptedArtifactDigest | null }
    | null = null;
  if (row.evidence_ref !== null) {
    const evidence = expectRecordWithKeys(
      row.evidence_ref,
      GATEWAY_EVIDENCE_REF_KEYS,
      "gateway index evidence_ref",
    );
    const ref = expectString(evidence.ref, "evidence_ref.ref");
    let digest: EncryptedArtifactDigest | null = null;
    if (evidence.digest !== null) {
      const digestText = expectString(evidence.digest, "evidence_ref.digest");
      if (!SHA256_HEX.test(digestText)) {
        throw new GatewayWireError(
          "wire_invalid_digest",
          "evidence_ref.digest must be 64-hex",
        );
      }
      digest = asEncryptedArtifactDigest(digestText);
    }
    evidenceRef = { ref, digest };
  }

  let evidenceExpiresAt: number | null = null;
  if (row.evidence_expires_at_ms !== null) {
    evidenceExpiresAt = expectSafeInt(
      row.evidence_expires_at_ms,
      "evidence_expires_at_ms",
    );
  }

  return {
    incidentId,
    fingerprint: asIncidentFingerprint(fingerprintText),
    severity,
    firstSeenAt,
    lastSeenAt,
    count,
    failingRevision,
    errorType,
    context: {
      message: expectString(context.message, "context.message"),
      location: expectNullableString(context.location, "context.location"),
      sample,
    },
    provenance: { endpoint, capturedAt, capturedBy },
    evidenceRef,
    evidenceExpiresAt,
  };
}

export function parseGatewayIndexPageV1(
  input: unknown,
): GatewayIndexPageV1 {
  const page = expectRecordWithKeys(
    input,
    GATEWAY_INDEX_PAGE_KEYS,
    "gateway index page",
  );
  const data = page.data;
  if (!Array.isArray(data)) {
    throw new GatewayWireError(
      "wire_invalid_shape",
      "gateway index data must be an array",
    );
  }
  let cursor: string | null = null;
  if (page.cursor !== null) {
    cursor = expectString(page.cursor, "index cursor");
    if (cursor.length > GATEWAY_CURSOR_MAX_LENGTH) {
      throw new GatewayWireError(
        "wire_bound_exceeded",
        "index cursor exceeds the cursor length bound",
      );
    }
  }
  const coverage = parseIncidentCoverage(page.coverage, "coverage");
  if (coverage.status === "complete" && cursor !== null) {
    // A complete scan cannot continue to another page: contradictory producer
    // data, not a clean completion.
    throw new GatewayWireError(
      "wire_invalid_coverage",
      "complete coverage with a non-null cursor is contradictory",
    );
  }
  const rows: GatewayIndexRowV1[] = [];
  for (const item of data) rows.push(parseGatewayIndexRowV1(item));
  return { rows, cursor, coverage };
}

/**
 * Map one wire row into the frozen summary. Repository identity and
 * `provenance.source` are trusted adapter configuration/constants; the row
 * supplies only `endpoint`/`captured_at_ms`/`captured_by`; the page coverage
 * belongs to every summary of that page; `evidence_expires_at_ms` is consumed
 * by the evidence stage and never carried on the summary.
 */
export function gatewayRowToSummary(
  row: GatewayIndexRowV1,
  repository: RepositoryIdentityV1,
  coverage: IncidentCoverageV1,
): IncidentSummaryV1 {
  const summary: Record<string, unknown> = {
    version: "v1",
    kind: "incident_summary",
    repository,
    id: row.incidentId,
    fingerprint: row.fingerprint,
    severity: row.severity,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    count: row.count,
    failingRevision: row.failingRevision,
    errorType: row.errorType,
    context: row.context,
    provenance: {
      source: "gateway",
      endpoint: row.provenance.endpoint,
      capturedAt: row.provenance.capturedAt,
      capturedBy: row.provenance.capturedBy,
    },
    coverage,
    evidenceRef: row.evidenceRef,
  };
  // The frozen parser is the authority: every value is re-validated here.
  return parseIncidentSummaryV1(summary);
}

// ---------------------------------------------------------------------------
// Existing replay export (producer `src/sentinel_replay_capture.ts`, frozen).
// ---------------------------------------------------------------------------

export const GATEWAY_REPLAY_MANIFEST_KEYS = [
  "version",
  "capture_id",
  "fingerprint",
  "case_group_digest",
  "captured_at_ms",
  "expires_at_ms",
  "algorithm",
  "compression",
  "iv",
  "chunk_count",
  "ciphertext_bytes",
] as const;
export const GATEWAY_REPLAY_PAGE_KEYS = ["data", "cursor"] as const;
export const GATEWAY_REPLAY_CAPTURE_KEYS = ["manifest", "chunks"] as const;

export interface GatewayReplayManifestV1 {
  version: 1;
  captureId: string;
  /** HMAC identity of the capture, never a ciphertext digest. */
  fingerprint: string;
  caseGroupDigest: string;
  capturedAt: number;
  expiresAt: number;
  algorithm: "AES-256-GCM";
  compression: "gzip";
  /** Base64url (unpadded) 12-byte AES-GCM IV. */
  iv: string;
  chunkCount: number;
  ciphertextBytes: number;
}

export interface GatewayReplayCaptureV1 {
  manifest: GatewayReplayManifestV1;
  /**
   * Decoded chunk bytes, in order. Each chunk is exactly
   * `GATEWAY_REPLAY_CHUNK_BYTES` except the last, whose length is the exact
   * remainder of `ciphertextBytes`.
   */
  chunks: Uint8Array<ArrayBuffer>[];
}

export interface GatewayReplayPageV1 {
  captures: GatewayReplayCaptureV1[];
  cursor: string | null;
}

/** Strict manifest parser; every structural rule of the producer is enforced. */
export function parseGatewayReplayManifestV1(
  input: unknown,
): GatewayReplayManifestV1 {
  const value = expectRecordWithKeys(
    input,
    GATEWAY_REPLAY_MANIFEST_KEYS,
    "replay manifest",
  );
  if (value.version !== GATEWAY_REPLAY_ENVELOPE_VERSION) {
    throw new GatewayWireError(
      "wire_invalid_version",
      "replay manifest version is not the supported envelope version",
    );
  }
  const captureId = expectString(value.capture_id, "capture_id");
  if (!REPLAY_CAPTURE_ID.test(captureId)) {
    throw new GatewayWireError(
      "wire_invalid_identity",
      "capture_id is outside the producer capture identity format",
    );
  }
  const fingerprint = expectString(value.fingerprint, "fingerprint");
  if (!SHA256_HEX.test(fingerprint)) {
    throw new GatewayWireError(
      "wire_invalid_digest",
      "manifest fingerprint must be a 64-hex HMAC identity",
    );
  }
  const caseGroupDigest = expectString(
    value.case_group_digest,
    "case_group_digest",
  );
  if (!SHA256_HEX.test(caseGroupDigest)) {
    throw new GatewayWireError(
      "wire_invalid_digest",
      "manifest case_group_digest must be 64-hex",
    );
  }
  const capturedAt = expectSafeInt(value.captured_at_ms, "captured_at_ms");
  const expiresAt = expectSafeInt(value.expires_at_ms, "expires_at_ms");
  const expectedExpiry = capturedAt + GATEWAY_REPLAY_TTL_MS;
  if (!Number.isSafeInteger(expectedExpiry) || expiresAt !== expectedExpiry) {
    throw new GatewayWireError(
      "wire_invalid_lifecycle",
      "manifest expiry must be the exact producer capture lifetime",
    );
  }
  if (value.algorithm !== GATEWAY_REPLAY_ALGORITHM) {
    throw new GatewayWireError(
      "wire_invalid_metadata",
      "unsupported replay encryption algorithm",
    );
  }
  if (value.compression !== GATEWAY_REPLAY_COMPRESSION) {
    throw new GatewayWireError(
      "wire_invalid_metadata",
      "unsupported replay compression",
    );
  }
  const iv = expectString(value.iv, "iv");
  if (
    !IV_TEXT.test(iv) ||
    decodeBase64Url(iv)?.byteLength !== GATEWAY_REPLAY_IV_BYTES
  ) {
    throw new GatewayWireError(
      "wire_invalid_metadata",
      "replay IV must be a 12-byte base64url value",
    );
  }
  const chunkCount = expectSafeInt(value.chunk_count, "chunk_count");
  if (chunkCount < 1 || chunkCount > GATEWAY_REPLAY_MAX_CHUNKS) {
    throw new GatewayWireError(
      "wire_invalid_count",
      "chunk_count is outside the producer chunk bound",
    );
  }
  const ciphertextBytes = expectSafeInt(
    value.ciphertext_bytes,
    "ciphertext_bytes",
  );
  if (
    ciphertextBytes < 16 ||
    ciphertextBytes > GATEWAY_REPLAY_MAX_CIPHERTEXT_BYTES
  ) {
    throw new GatewayWireError(
      "wire_invalid_count",
      "ciphertext_bytes is outside the producer byte bound",
    );
  }
  // Exact producer rule: the byte count must fit the chunk grid and can never
  // exceed the sum of the declared chunk capacities.
  const minimumBytes = (chunkCount - 1) * GATEWAY_REPLAY_CHUNK_BYTES + 1;
  if (
    ciphertextBytes < minimumBytes ||
    ciphertextBytes > chunkCount * GATEWAY_REPLAY_CHUNK_BYTES
  ) {
    throw new GatewayWireError(
      "wire_invalid_count",
      "ciphertext_bytes does not fit the declared chunk grid",
    );
  }
  return {
    version: 1,
    captureId,
    fingerprint,
    caseGroupDigest,
    capturedAt,
    expiresAt,
    algorithm: "AES-256-GCM",
    compression: "gzip",
    iv,
    chunkCount,
    ciphertextBytes,
  };
}

export function parseGatewayReplayCaptureV1(
  input: unknown,
): GatewayReplayCaptureV1 {
  const capture = expectRecordWithKeys(
    input,
    GATEWAY_REPLAY_CAPTURE_KEYS,
    "replay capture",
  );
  const manifest = parseGatewayReplayManifestV1(capture.manifest);
  const chunksValue = capture.chunks;
  if (
    !Array.isArray(chunksValue) || chunksValue.length !== manifest.chunkCount
  ) {
    throw new GatewayWireError(
      "wire_invalid_count",
      "chunks length does not match the manifest chunk_count",
    );
  }
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let index = 0; index < chunksValue.length; index++) {
    const encoded = chunksValue[index];
    if (typeof encoded !== "string" || !REPLAY_CHUNK_RE.test(encoded)) {
      throw new GatewayWireError(
        "wire_invalid_encoding",
        "chunk is not an unpadded base64url string",
      );
    }
    const decoded = decodeBase64Url(encoded);
    if (decoded === null) {
      throw new GatewayWireError(
        "wire_invalid_encoding",
        "chunk decoding failed",
      );
    }
    const expected = expectedChunkBytes(manifest, index);
    if (decoded.byteLength !== expected) {
      throw new GatewayWireError(
        "wire_invalid_size",
        "chunk byte length does not match the manifest chunk grid",
      );
    }
    chunks.push(decoded);
  }
  return { manifest, chunks };
}

export function parseGatewayReplayPageV1(input: unknown): GatewayReplayPageV1 {
  const page = expectRecordWithKeys(
    input,
    GATEWAY_REPLAY_PAGE_KEYS,
    "replay page",
  );
  const data = page.data;
  if (!Array.isArray(data)) {
    throw new GatewayWireError(
      "wire_invalid_shape",
      "replay page data must be an array",
    );
  }
  let cursor: string | null = null;
  if (page.cursor !== null) {
    cursor = expectString(page.cursor, "replay cursor");
    if (
      cursor.length > GATEWAY_CURSOR_MAX_LENGTH ||
      !REPLAY_EXPORT_CURSOR.test(cursor)
    ) {
      throw new GatewayWireError(
        "wire_bound_exceeded",
        "replay cursor exceeds the producer cursor format",
      );
    }
  }
  const captures: GatewayReplayCaptureV1[] = [];
  for (const item of data) captures.push(parseGatewayReplayCaptureV1(item));
  return { captures, cursor };
}

function expectedChunkBytes(
  manifest: GatewayReplayManifestV1,
  index: number,
): number {
  return index < manifest.chunkCount - 1
    ? GATEWAY_REPLAY_CHUNK_BYTES
    : manifest.ciphertextBytes -
      (manifest.chunkCount - 1) * GATEWAY_REPLAY_CHUNK_BYTES;
}

/**
 * Exact producer wire form of a parsed manifest, used for private retention
 * metadata (later trusted decryption needs the authentic producer object).
 */
export function replayManifestToWire(
  manifest: GatewayReplayManifestV1,
): Record<string, unknown> {
  return {
    version: manifest.version,
    capture_id: manifest.captureId,
    fingerprint: manifest.fingerprint,
    case_group_digest: manifest.caseGroupDigest,
    captured_at_ms: manifest.capturedAt,
    expires_at_ms: manifest.expiresAt,
    algorithm: manifest.algorithm,
    compression: manifest.compression,
    iv: manifest.iv,
    chunk_count: manifest.chunkCount,
    ciphertext_bytes: manifest.ciphertextBytes,
  };
}

/** Concatenate the validated chunks into the exact ciphertext byte string. */
export function concatReplayChunks(
  capture: GatewayReplayCaptureV1,
): Uint8Array<ArrayBuffer> {
  if (capture.chunks.length !== capture.manifest.chunkCount) {
    throw new GatewayWireError(
      "wire_invalid_count",
      "chunk count does not match the manifest",
    );
  }
  const output: Uint8Array<ArrayBuffer> = new Uint8Array(
    capture.manifest.ciphertextBytes,
  );
  let offset = 0;
  for (let index = 0; index < capture.chunks.length; index++) {
    const chunk = capture.chunks[index];
    if (chunk.byteLength !== expectedChunkBytes(capture.manifest, index)) {
      throw new GatewayWireError(
        "wire_invalid_size",
        "chunk byte length does not match the manifest chunk grid",
      );
    }
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== capture.manifest.ciphertextBytes) {
    throw new GatewayWireError(
      "wire_invalid_size",
      "reconstructed ciphertext length does not match the manifest",
    );
  }
  return output;
}

// ---------------------------------------------------------------------------
// Base64url helpers (producer `utils.ts` shape: unpadded URL-safe base64).
// ---------------------------------------------------------------------------

const BASE64_URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function decodeBase64Url(
  text: string,
): Uint8Array<ArrayBuffer> | null {
  if (
    text.length === 0 || text.length % 4 === 1 || !REPLAY_CHUNK_RE.test(text)
  ) {
    return null;
  }
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text) {
    const index = BASE64_URL_ALPHABET.indexOf(char);
    if (index === -1) return null;
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/** Canonical base64 (standard alphabet, padded) — the `ciphertextBase64` form. */
export function encodeCanonicalBase64(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const remaining = bytes.byteLength - offset;
    const a = bytes[offset]!;
    const b = remaining > 1 ? bytes[offset + 1]! : 0;
    const c = remaining > 2 ? bytes[offset + 2]! : 0;
    output += alphabet[a >> 2]!;
    output += alphabet[((a & 0x03) << 4) | (b >> 4)]!;
    output += remaining > 1 ? alphabet[((b & 0x0f) << 2) | (c >> 6)]! : "=";
    output += remaining > 2 ? alphabet[c & 0x3f]! : "=";
  }
  return output;
}
