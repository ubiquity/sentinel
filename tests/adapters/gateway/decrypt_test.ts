/**
 * Retained-capture decryption boundary tests (Wave C integration writer).
 *
 * The success path connects the ACTUAL producer-generated golden capture
 * through the ACTUAL `LocalArtifactStore` put/get into
 * `decryptRetainedGatewayCapture`, proving the exact original request and
 * observations round trip. Every tamper/bound case uses public synthetic
 * bytes and the public synthetic key only; failures return static sanitized
 * typed errors with no plaintext or key leakage, and caller-owned buffers are
 * never mutated. No model/network calls, no Deno KV access, no target source
 * imports; the crafted envelopes for deeper validation implement the
 * producer protocol independently inside this test file.
 */

import assert from "node:assert/strict";

import {
  decryptRetainedGatewayCapture,
  type RetainedCaptureErrorV1,
  type RetainedCaptureResultV1,
} from "../../../src/adapters/gateway/decrypt.ts";
import {
  type ArtifactStoreLimitsV1,
  LocalArtifactStore,
  type StoredArtifactV1,
} from "../../../src/adapters/gateway/store.ts";
import {
  decodeBase64Url,
  type GatewayReplayManifestV1,
  parseGatewayReplayManifestV1,
  replayManifestToWire,
} from "../../../src/adapters/gateway/wire.ts";
import { b64Url, sha256hex } from "./helpers.ts";

const GOLDEN_URL = new URL(
  "../../fixtures/gateway/producer-golden-v1.json",
  import.meta.url,
);
const RECORDED_SOURCE_SHA = "9331946ef10d3b7259b5ca4933598dd380c1d794";
const INCIDENT_ID = "provider-00000000-0000-4000-8000-000000000001";
const STORE_LIMITS: ArtifactStoreLimitsV1 = {
  totalMaxBytes: 64 * 1_024 * 1_024,
  artifactMaxBytes: 64 * 1_024 * 1_024,
  retentionMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
};

interface GoldenFixture {
  sourceSha: string;
  syntheticKeyHex: string;
  exported: {
    manifest: Record<string, unknown>;
    chunks: string[];
  };
  expected: Record<string, unknown>;
}

function readGolden(): GoldenFixture {
  return JSON.parse(
    Deno.readTextFileSync(GOLDEN_URL),
  ) as GoldenFixture;
}

function goldenKey(): Uint8Array<ArrayBuffer> {
  return hexToBytes(readGolden().syntheticKeyHex);
}

function goldenManifest(): GatewayReplayManifestV1 {
  return parseGatewayReplayManifestV1(readGolden().exported.manifest);
}

/** Exact concatenated ciphertext of the golden capture (wire chunk grid). */
function goldenCiphertext(): Uint8Array<ArrayBuffer> {
  const chunks = readGolden().exported.chunks.map((encoded) => {
    const decoded = decodeBase64Url(encoded);
    assert.notEqual(decoded, null);
    return decoded!;
  });
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function artifactRef(captureId: string): string {
  return `artifact://sentinel/${INCIDENT_ID}/${captureId}`;
}

function makeArtifact(
  ciphertext: Uint8Array<ArrayBuffer>,
  manifest: GatewayReplayManifestV1,
  digest: string,
): StoredArtifactV1 {
  return {
    ref: artifactRef(manifest.captureId),
    digest: digest as unknown as StoredArtifactV1["digest"],
    sizeBytes: ciphertext.byteLength,
    expiresAt: manifest.capturedAt + STORE_LIMITS.retentionMaxAgeMs,
    retainedAt: manifest.capturedAt,
    sourceExpiresAt: manifest.expiresAt,
    sourceCapturedAt: manifest.capturedAt,
    incidentId: INCIDENT_ID,
    captureId: manifest.captureId,
    fingerprint: manifest.fingerprint,
    caseGroupDigest: manifest.caseGroupDigest,
    contentType: "application/octet-stream",
    ciphertext,
    manifest,
  };
}

async function makeStore(
  limits: ArtifactStoreLimitsV1 = STORE_LIMITS,
): Promise<{ store: LocalArtifactStore; cleanup: () => Promise<void> }> {
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-gateway-decrypt-",
  });
  const store = new LocalArtifactStore({ root, limits });
  const opened = await store.open();
  assert.deepEqual(opened, { ok: true, value: undefined });
  return {
    store,
    cleanup: async () => {
      await Deno.remove(root, { recursive: true });
    },
  };
}

/**
 * Retain a capture through the ACTUAL local store; the returned artifact is
 * the exact object the store persisted and re-validated.
 */
async function retainThroughStore(
  ciphertext: Uint8Array<ArrayBuffer>,
  manifest: GatewayReplayManifestV1,
  nowMs: number,
): Promise<{ artifact: StoredArtifactV1; cleanup: () => Promise<void> }> {
  const { store, cleanup } = await makeStore();
  const digest = await sha256hex(ciphertext);
  const result = await store.put({
    ref: artifactRef(manifest.captureId),
    digest,
    ciphertext,
    incidentId: INCIDENT_ID,
    captureId: manifest.captureId,
    fingerprint: manifest.fingerprint,
    caseGroupDigest: manifest.caseGroupDigest,
    sourceCapturedAt: manifest.capturedAt,
    sourceExpiresAt: manifest.expiresAt,
    contentType: "application/octet-stream",
    manifest,
  }, nowMs);
  assert.equal(result.ok, true, "store put should succeed");
  const got = await store.get(artifactRef(manifest.captureId), nowMs);
  assert.equal(got.ok, true, "store get should succeed");
  assert.notEqual(got.value, null, "retained artifact must exist");
  return { artifact: got.value!, cleanup };
}

/** Independent producer-compatible envelope: gzip + AES-GCM under HKDF. */
async function craftEnvelope(
  plaintext: Uint8Array<ArrayBuffer>,
  fingerprint: string,
  keyBytes: Uint8Array<ArrayBuffer>,
): Promise<
  { ciphertext: Uint8Array<ArrayBuffer>; iv: Uint8Array<ArrayBuffer> }
> {
  const enc = new TextEncoder();
  const salt = enc.encode("uos-sentinel-replay-v1");
  const material = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    "HKDF",
    false,
    [
      "deriveBits",
    ],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("encryption") },
    material,
    256,
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    derived,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const compressed = new Uint8Array(
    await new Response(
      new Blob([plaintext]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = enc.encode(
    `uos-sentinel-replay-v1\u0000${fingerprint}`,
  );
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData },
      aesKey,
      compressed,
    ),
  );
  compressed.fill(0);
  return { ciphertext: encrypted, iv };
}

/** 4-byte big-endian metadata length + metadata JSON + body (producer layout). */
function encodeEnvelope(
  metadata: Record<string, unknown>,
  body: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, metadataBytes.byteLength, false);
  const output = new Uint8Array(4 + metadataBytes.byteLength + body.byteLength);
  output.set(size, 0);
  output.set(metadataBytes, 4);
  output.set(body, 4 + metadataBytes.byteLength);
  return output;
}

function baseMetadata(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    captured_at_ms: readGolden().expected.captured_at_ms,
    endpoint: "/v1/responses",
    method: "POST",
    content_type: "application/json",
    compatibility_headers: { accept: "text/event-stream" },
    failure_signature:
      '{"status":502,"stream":true,"completed":false,"terminal_type":null,"failure_kind":"missing_sse_terminal","framing_valid":true,"provider_route":"synthetic"}',
    observation: {
      status: 502,
      stream: true,
      completed: false,
      terminal_type: null,
      failure_kind: "missing_sse_terminal",
      synthetic_terminal_type: null,
      provider_route: "synthetic",
    },
    client_observation: {
      status: 502,
      stream: true,
      completed: false,
      terminal_type: null,
      failure_kind: "missing_sse_terminal",
      framing_valid: true,
      provider_route: "synthetic",
    },
    request_id: "synthetic-request-1",
    git_sha: "1".repeat(40),
    deno_revision: "synthetic-revision-1",
    ...overrides,
  };
}

function manifestWith(
  overrides: Record<string, unknown>,
  ciphertextBytes: number,
  iv: Uint8Array,
): GatewayReplayManifestV1 {
  const golden = readGolden().exported.manifest as Record<string, unknown>;
  return parseGatewayReplayManifestV1({
    ...golden,
    iv: b64Url(iv),
    ciphertext_bytes: ciphertextBytes,
    ...overrides,
  });
}

function expectStaticFailure(
  result: RetainedCaptureResultV1,
  kind: RetainedCaptureErrorV1["kind"],
  detail: string,
): void {
  assert.equal(result.ok, false, `expected ${kind} failure`);
  assert.deepEqual(
    result.ok ? null : result.error,
    { kind, detail },
    "failure must be the exact static sanitized error",
  );
  if (!result.ok) {
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("synthetic-model"), "body leaked");
    assert.ok(!serialized.includes("/v1/responses"), "endpoint leaked");
    assert.ok(
      !serialized.includes(
        readGolden().exported.manifest.fingerprint as string,
      ),
      "fingerprint leaked",
    );
  }
}

function assertBuffersUnchanged(
  beforeKey: Uint8Array,
  beforeCiphertext: Uint8Array,
  keyBytes: Uint8Array,
  ciphertext: Uint8Array<ArrayBuffer>,
): void {
  assert.deepEqual(keyBytes, beforeKey, "key bytes were mutated");
  assert.deepEqual(
    ciphertext,
    beforeCiphertext,
    "ciphertext bytes were mutated",
  );
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

Deno.test("gateway decrypt: producer golden round-trips through the actual store", async () => {
  const golden = readGolden();
  assert.equal(
    golden.sourceSha,
    RECORDED_SOURCE_SHA,
    "fixture must come from the recorded producer source",
  );
  const manifest = goldenManifest();
  const ciphertext = goldenCiphertext();
  assert.equal(ciphertext.byteLength, manifest.ciphertextBytes);
  const keyBytes = goldenKey();
  const beforeKey = new Uint8Array(keyBytes);
  const beforeCiphertext = new Uint8Array(ciphertext);

  const { artifact, cleanup } = await retainThroughStore(
    ciphertext,
    manifest,
    manifest.capturedAt,
  );
  try {
    const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
    assert.equal(result.ok, true, "golden capture must decrypt");
    if (!result.ok) return;
    const value = result.value;
    const expected = golden.expected;
    assert.equal(value.version, expected.version);
    assert.equal(value.captureId, manifest.captureId);
    assert.equal(value.fingerprint, manifest.fingerprint);
    assert.equal(value.caseGroupDigest, manifest.caseGroupDigest);
    assert.equal(value.capturedAt, expected.captured_at_ms);
    assert.equal(value.expiresAt, manifest.expiresAt);
    assert.equal(value.requestId, expected.request_id);
    assert.equal(value.gitSha, expected.git_sha);
    assert.equal(value.denoRevision, expected.deno_revision);
    assert.equal(value.endpoint, expected.endpoint);
    assert.equal(value.method, expected.method);
    assert.equal(value.contentType, expected.content_type);
    assert.deepEqual(
      value.compatibilityHeaders,
      expected.compatibility_headers,
    );
    assert.equal(value.failureSignature, expected.failure_signature);
    assert.deepEqual(value.observation, {
      status: 502,
      stream: true,
      completed: false,
      terminalType: null,
      failureKind: "missing_sse_terminal",
      syntheticTerminalType: null,
      providerRoute: "synthetic",
    });
    assert.deepEqual(value.clientObservation, {
      status: 502,
      stream: true,
      completed: false,
      terminalType: null,
      failureKind: "missing_sse_terminal",
      framingValid: true,
      providerRoute: "synthetic",
    });
    assert.equal(
      new TextDecoder().decode(value.body),
      expected.body,
      "exact original request body must round trip",
    );
    assertBuffersUnchanged(
      beforeKey,
      beforeCiphertext,
      keyBytes,
      ciphertext,
    );
  } finally {
    await cleanup();
  }
});

Deno.test("gateway decrypt: wrong key fails closed without plaintext leakage", async () => {
  const manifest = goldenManifest();
  const { artifact, cleanup } = await retainThroughStore(
    goldenCiphertext(),
    manifest,
    manifest.capturedAt,
  );
  try {
    const wrongKey: Uint8Array<ArrayBuffer> = new Uint8Array(32).map(
      (_value, index) => index + 32,
    );
    const beforeKey = new Uint8Array(wrongKey);
    const beforeCiphertext = new Uint8Array(artifact.ciphertext);
    const result = await decryptRetainedGatewayCapture(artifact, wrongKey);
    expectStaticFailure(
      result,
      "authentication_failed",
      "retained capture failed authenticated decryption",
    );
    assertBuffersUnchanged(
      beforeKey,
      beforeCiphertext,
      wrongKey,
      artifact.ciphertext,
    );
  } finally {
    await cleanup();
  }
});

Deno.test("gateway decrypt: non-32-byte key is rejected before crypto", async () => {
  const manifest = goldenManifest();
  const { artifact, cleanup } = await retainThroughStore(
    goldenCiphertext(),
    manifest,
    manifest.capturedAt,
  );
  try {
    const shortKey = new Uint8Array(31);
    const result = await decryptRetainedGatewayCapture(artifact, shortKey);
    expectStaticFailure(
      result,
      "invalid_key",
      "retained capture key must be 32 bytes",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("gateway decrypt: ciphertext tampering fails the retained digest check", async () => {
  const manifest = goldenManifest();
  const ciphertext = goldenCiphertext();
  const goldenDigest = await sha256hex(ciphertext);
  const tampered = new Uint8Array(ciphertext);
  tampered[tampered.byteLength - 1] ^= 0x01;
  // Direct construction: the store can never retain mismatched bytes/digest.
  const artifact = makeArtifact(tampered, manifest, goldenDigest);
  const before = new Uint8Array(artifact.ciphertext);
  const keyBytes = goldenKey();
  const beforeKey = new Uint8Array(keyBytes);
  const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
  expectStaticFailure(
    result,
    "tampered_ciphertext",
    "retained capture ciphertext does not match its digest",
  );
  assertBuffersUnchanged(beforeKey, before, keyBytes, artifact.ciphertext);
});

Deno.test("gateway decrypt: ciphertext tampering with re-digested bytes fails authentication", async () => {
  const manifest = goldenManifest();
  const ciphertext = goldenCiphertext();
  const tampered = new Uint8Array(ciphertext);
  tampered[10] ^= 0x80;
  const { artifact, cleanup } = await retainThroughStore(
    tampered,
    manifest,
    manifest.capturedAt,
  );
  try {
    const result = await decryptRetainedGatewayCapture(
      artifact,
      goldenKey(),
    );
    expectStaticFailure(
      result,
      "authentication_failed",
      "retained capture failed authenticated decryption",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("gateway decrypt: AAD tampering (changed manifest fingerprint) fails authentication", async () => {
  const manifest = goldenManifest();
  const ciphertext = goldenCiphertext();
  const withOverrides = manifestWith(
    {
      fingerprint: "e".repeat(64),
      capture_id: manifest.captureId,
      case_group_digest: manifest.caseGroupDigest,
      captured_at_ms: manifest.capturedAt,
      expires_at_ms: manifest.expiresAt,
      ciphertext_bytes: ciphertext.byteLength,
    },
    ciphertext.byteLength,
    decodeBase64Url(manifest.iv)!,
  );
  const { artifact, cleanup } = await retainThroughStore(
    ciphertext,
    withOverrides,
    manifest.capturedAt,
  );
  try {
    const result = await decryptRetainedGatewayCapture(artifact, goldenKey());
    expectStaticFailure(
      result,
      "authentication_failed",
      "retained capture failed authenticated decryption",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("gateway decrypt: case-group HMAC tampering fails as tampered_manifest", async () => {
  const manifest = goldenManifest();
  const ciphertext = goldenCiphertext();
  const tamperedManifest = manifestWith(
    {
      fingerprint: manifest.fingerprint,
      capture_id: manifest.captureId,
      captured_at_ms: manifest.capturedAt,
      expires_at_ms: manifest.expiresAt,
      ciphertext_bytes: ciphertext.byteLength,
      case_group_digest: "a".repeat(64),
    },
    ciphertext.byteLength,
    decodeBase64Url(manifest.iv)!,
  );
  const { artifact, cleanup } = await retainThroughStore(
    ciphertext,
    tamperedManifest,
    manifest.capturedAt,
  );
  try {
    const result = await decryptRetainedGatewayCapture(artifact, goldenKey());
    expectStaticFailure(
      result,
      "tampered_manifest",
      "retained capture HMAC identity does not match its manifest",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("gateway decrypt: client observation tampering fails the failure-signature identity", async () => {
  const keyBytes = goldenKey();
  const manifest = goldenManifest();
  const metadata = baseMetadata({
    client_observation: {
      status: 503,
      stream: true,
      completed: false,
      terminal_type: null,
      failure_kind: "missing_sse_terminal",
      framing_valid: true,
      provider_route: "synthetic",
    },
  });
  const body = new TextEncoder().encode(readGolden().expected.body as string);
  const plaintext = encodeEnvelope(metadata, body);
  const { ciphertext, iv } = await craftEnvelope(
    plaintext,
    manifest.fingerprint,
    keyBytes,
  );
  const crafted = manifestWith(
    {
      fingerprint: manifest.fingerprint,
      capture_id: manifest.captureId,
      case_group_digest: manifest.caseGroupDigest,
      captured_at_ms: manifest.capturedAt,
      expires_at_ms: manifest.expiresAt,
      ciphertext_bytes: ciphertext.byteLength,
    },
    ciphertext.byteLength,
    iv,
  );
  const { artifact, cleanup } = await retainThroughStore(
    ciphertext,
    crafted,
    manifest.capturedAt,
  );
  try {
    const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
    expectStaticFailure(
      result,
      "tampered_manifest",
      "retained capture HMAC identity does not match its manifest",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("gateway decrypt: capture-time tampering fails against the manifest", async () => {
  const keyBytes = goldenKey();
  const manifest = goldenManifest();
  const shifted = manifest.capturedAt + 60_000;
  // Tamper only the authenticated plaintext: the manifest stays untouched, so
  // the producer capture-time identity check must reject the discrepancy.
  const metadata = baseMetadata({ captured_at_ms: shifted });
  const body = new TextEncoder().encode(readGolden().expected.body as string);
  const plaintext = encodeEnvelope(metadata, body);
  const { ciphertext, iv } = await craftEnvelope(
    plaintext,
    manifest.fingerprint,
    keyBytes,
  );
  const crafted = manifestWith(
    {
      fingerprint: manifest.fingerprint,
      capture_id: manifest.captureId,
      case_group_digest: manifest.caseGroupDigest,
      captured_at_ms: manifest.capturedAt,
      expires_at_ms: manifest.expiresAt,
      ciphertext_bytes: ciphertext.byteLength,
    },
    ciphertext.byteLength,
    iv,
  );
  const { artifact, cleanup } = await retainThroughStore(
    ciphertext,
    crafted,
    manifest.capturedAt,
  );
  try {
    const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
    expectStaticFailure(
      result,
      "tampered_manifest",
      "retained capture HMAC identity does not match its manifest",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("gateway decrypt: envelope length prefix beyond the buffer fails as invalid_envelope", async () => {
  const keyBytes = goldenKey();
  const manifest = goldenManifest();
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, 1_000, false);
  const junk = new Uint8Array(8).fill(0x41);
  const plaintext = new Uint8Array(12);
  plaintext.set(size, 0);
  plaintext.set(junk, 4);
  const { ciphertext, iv } = await craftEnvelope(
    plaintext,
    manifest.fingerprint,
    keyBytes,
  );
  const crafted = manifestWith(
    {
      fingerprint: manifest.fingerprint,
      capture_id: manifest.captureId,
      case_group_digest: manifest.caseGroupDigest,
      captured_at_ms: manifest.capturedAt,
      expires_at_ms: manifest.expiresAt,
      ciphertext_bytes: ciphertext.byteLength,
    },
    ciphertext.byteLength,
    iv,
  );
  const { artifact, cleanup } = await retainThroughStore(
    ciphertext,
    crafted,
    manifest.capturedAt,
  );
  try {
    const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
    expectStaticFailure(
      result,
      "invalid_envelope",
      "retained capture envelope is malformed",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("gateway decrypt: oversized gzip expansion fails bounded", async () => {
  const keyBytes = goldenKey();
  const manifest = goldenManifest();
  const oversized = new Uint8Array(34 * 1_024 * 1_024);
  const { ciphertext, iv } = await craftEnvelope(
    oversized,
    manifest.fingerprint,
    keyBytes,
  );
  const crafted = manifestWith(
    {
      fingerprint: manifest.fingerprint,
      capture_id: manifest.captureId,
      case_group_digest: manifest.caseGroupDigest,
      captured_at_ms: manifest.capturedAt,
      expires_at_ms: manifest.expiresAt,
      ciphertext_bytes: ciphertext.byteLength,
    },
    ciphertext.byteLength,
    iv,
  );
  const { artifact, cleanup } = await retainThroughStore(
    ciphertext,
    crafted,
    manifest.capturedAt,
  );
  try {
    const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
    expectStaticFailure(
      result,
      "oversized_plaintext",
      "retained capture plaintext exceeds its size bound",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("gateway decrypt: invalid metadata JSON fails closed", async () => {
  const keyBytes = goldenKey();
  const manifest = goldenManifest();
  const plaintext = new TextEncoder().encode(
    "\u0000\u0000\u0000\u000anot-json!!",
  );
  const { ciphertext, iv } = await craftEnvelope(
    plaintext,
    manifest.fingerprint,
    keyBytes,
  );
  const crafted = manifestWith(
    {
      fingerprint: manifest.fingerprint,
      capture_id: manifest.captureId,
      case_group_digest: manifest.caseGroupDigest,
      captured_at_ms: manifest.capturedAt,
      expires_at_ms: manifest.expiresAt,
      ciphertext_bytes: ciphertext.byteLength,
    },
    ciphertext.byteLength,
    iv,
  );
  const { artifact, cleanup } = await retainThroughStore(
    ciphertext,
    crafted,
    manifest.capturedAt,
  );
  try {
    const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
    expectStaticFailure(
      result,
      "invalid_plaintext",
      "retained capture plaintext metadata is invalid",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("gateway decrypt: retained identity mismatch fails as tampered_metadata", async () => {
  const manifest = goldenManifest();
  const ciphertext = goldenCiphertext();
  const goldenDigest = await sha256hex(ciphertext);
  const artifact = makeArtifact(ciphertext, manifest, goldenDigest);
  // The retained metadata must name the exact object it claims to retain.
  artifact.captureId = "other-capture-id";
  const result = await decryptRetainedGatewayCapture(artifact, goldenKey());
  expectStaticFailure(
    result,
    "tampered_metadata",
    "retained capture metadata does not match its manifest",
  );
});

Deno.test("gateway decrypt: non-conforming manifest fails as invalid_manifest", async () => {
  const manifest = goldenManifest();
  const ciphertext = goldenCiphertext();
  const goldenDigest = await sha256hex(ciphertext);
  const artifact = makeArtifact(ciphertext, {
    ...manifest,
    iv: "AA",
  }, goldenDigest);
  const result = await decryptRetainedGatewayCapture(artifact, goldenKey());
  expectStaticFailure(
    result,
    "invalid_manifest",
    "retained capture manifest is not the supported producer shape",
  );
});

Deno.test("gateway decrypt: manifest re-validation preserves exact wire identity", () => {
  // The boundary must hold the frozen wire contract, not a looser local type.
  const manifest = goldenManifest();
  const wire = replayManifestToWire(manifest);
  assert.deepEqual(wire, readGolden().exported.manifest);
});
