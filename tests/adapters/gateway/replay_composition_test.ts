/**
 * Gateway capture → trusted fixture → replay composition tests (Wave C
 * integration writer).
 *
 * The positive path uses the ACTUAL recording gateway transport, the actual
 * GatewayIncidentAdapter, the actual LocalArtifactStore and the actual
 * producer-golden-v2 decrypt/sanitize path: composition.readIncident returns
 * the updated IncidentEvidenceV1 with ReplayMetadataV1, and
 * resolveFixture/resolveTestIds return a deterministic trusted
 * ResolvedFixtureV1. A fresh composition instance over the same store root
 * rehydrates the identical fixture (no plaintext storage), and an actual
 * ReplayPort run resolves the composition's fixture and executes the
 * configured credential-free command.
 *
 * Negative cases all fail closed: no-upstream, truncated, non-eof terminals
 * (cancelled/read_error/fetch_error/pending), wrong fingerprint/revision/
 * repository/artifact identity, missing, expired and tampered artifacts,
 * malformed fixture refs and bundle-digest mismatches — replay stays null or
 * a static typed invalid/unavailable/not_found result, never an invented
 * fixture. The transport must stay GET-only with no claim/ack/defer endpoint,
 * caller key buffers must be unchanged, and no private marker may appear in
 * fixture JSON or error text.
 *
 * Public synthetic data only (the recorded producer golden and independently
 * crafted producer-protocol captures with synthetic bytes); no model, network
 * or paid calls.
 */

import assert from "node:assert/strict";

import { GatewayReplayComposition } from "../../../src/adapters/gateway/replay-composition.ts";
import { GatewayIncidentAdapter } from "../../../src/adapters/gateway/incident-adapter.ts";
import type { GatewayAuthProviderV1 } from "../../../src/adapters/gateway/http.ts";
import {
  type ArtifactStoreLimitsV1,
  LocalArtifactStore,
} from "../../../src/adapters/gateway/store.ts";
import { decodeBase64Url } from "../../../src/adapters/gateway/wire.ts";
import { canonicalStringifySha256 } from "../../../src/contracts/canonical.ts";
import { parseIncidentEvidenceV1 } from "../../../src/contracts/incident.ts";
import { isFixtureDigest, isGitSha } from "../../../src/contracts/brands.ts";
import type {
  CommandId,
  FixtureDigest,
  WorkItemId,
} from "../../../src/contracts/brands.ts";
import { parseRepositoryConfigV1 } from "../../../src/contracts/repository-config.ts";
import type { RepositoryConfigV1 } from "../../../src/contracts/repository-config.ts";
import {
  computeReplayFixtureDigest,
  markerProofParser,
} from "../../../src/replay/fixture.ts";
import type { ResolvedFixtureV1 } from "../../../src/replay/fixture.ts";
import { ReplayPortImpl } from "../../../src/replay/port.ts";
import type { ReplayPolicyV1 } from "../../../src/replay/fixture.ts";
import {
  commitWith,
  gitRun,
  revParse,
  testGitEnv,
  TOY_REPOSITORY,
  toyIsolation,
} from "../../replay/helpers.ts";
import { artifactRef } from "../../../src/adapters/gateway/incident-adapter.ts";

import {
  FakeClock,
  INCIDENT_A,
  jsonResponse,
  makeIndexPage,
  makeIndexRow,
  makeReplayPage,
  recordingTransport,
  sha256hex,
  validConfig,
} from "./helpers.ts";

const INDEX_PATH = "/admin/sentinel/incidents";
const REPLAY_PATH = "/admin/sentinel/replay-captures";
const LIMITS: ArtifactStoreLimitsV1 = {
  totalMaxBytes: 1_000_000,
  artifactMaxBytes: 100_000,
  retentionMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
};

const GOLDEN_V2_URL = new URL(
  "../../fixtures/gateway/producer-golden-v2.json",
  import.meta.url,
);
const CAPTURE_ID_V2 = "synthetic-capture-2";
const GIT_SHA = "1".repeat(40);
const CAPTURED_AT_V2 = 1_788_811_200_000;
const RETAINED_TTL_MS = 48 * 60 * 60 * 1_000;

const TEST_ID = "gateway:complete-upstream";
const COMMAND_ID = "replay" as CommandId;
const TEST_IDS = [TEST_ID];
const EXPECTED_FAILURE = {
  reason: "gateway upstream trace completed without the expected failure",
  match: { kind: "contains" as const, text: "completed without" },
};
const SANITIZER_POLICY = {
  publicModels: ["synthetic-model"],
  publicHeaders: { accept: ["text/event-stream"] },
};

/** Private markers that must never appear in public fixture JSON/errors
 * (the incident fingerprint and failing revision are public evidence
 * identities and are deliberately excluded). */
const PRIVATE_MARKERS = [
  "public regression fixture",
  "variant synthetic fixture",
  "public-synthetic-response",
  "synthetic-request-2",
  "missing_sse_terminal",
  "synthetic-revision-2",
];

interface GoldenV2Fixture {
  sourceSha: string;
  syntheticKeyHex: string;
  exported: { manifest: Record<string, unknown>; chunks: string[] };
  expected: Record<string, unknown>;
}

function readGolden(): GoldenV2Fixture {
  return JSON.parse(
    Deno.readTextFileSync(GOLDEN_V2_URL),
  ) as GoldenV2Fixture;
}

// ---------------------------------------------------------------------------
// Producer-side crafting helpers (independent of the decryptor: frozen
// HKDF/AES-GCM/gzip framing and HMAC identities over public synthetic bytes)
// ---------------------------------------------------------------------------

const RETAINED_NAMESPACE = "uos-sentinel-replay-v1";
const RETAINED_FINGERPRINT_NAMESPACE = "uos-sentinel-replay-v2:fingerprint";
const RETAINED_CASE_GROUP_NAMESPACE = "uos-sentinel-replay-v1:case-group";
const TEXT_ENCODER = new TextEncoder();

function standardBase64(bytes: Uint8Array): string {
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

function decodeStandardBase64(text: string): Uint8Array {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text) {
    if (char === "=") continue;
    const decoded = alphabet.indexOf(char);
    assert.notEqual(decoded, -1);
    value = (value << 6) | decoded;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      return `{${
        Object.keys(record).sort().map((key) =>
          `${JSON.stringify(key)}:${canonicalJson(record[key])}`
        ).join(",")
      }}`;
    }
    default:
      throw new Error(`cannot canonically serialize ${typeof value}`);
  }
}

function stableHeaderText(headers: Record<string, string>): string {
  return Object.entries(headers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}`)
    .join("\n");
}

function frameParts(value: Uint8Array): Uint8Array[] {
  const length = new Uint8Array(8);
  new DataView(length.buffer).setBigUint64(0, BigInt(value.byteLength), false);
  return [length, value];
}

function concatParts(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

async function hmacHex(
  keyBytes: Uint8Array<ArrayBuffer>,
  purpose: "fingerprint" | "case-group",
  parts: readonly Uint8Array[],
): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: TEXT_ENCODER.encode(RETAINED_NAMESPACE),
      info: TEXT_ENCODER.encode(purpose),
    },
    material,
    256,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, concatParts(parts));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function v2Fingerprint(
  keyBytes: Uint8Array<ArrayBuffer>,
  metadata: Record<string, unknown>,
  body: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const parts = [
    ...frameParts(TEXT_ENCODER.encode(RETAINED_FINGERPRINT_NAMESPACE)),
    ...frameParts(TEXT_ENCODER.encode(metadata.method as string)),
    ...frameParts(TEXT_ENCODER.encode(metadata.endpoint as string)),
    ...frameParts(
      TEXT_ENCODER.encode(
        stableHeaderText(
          metadata.compatibility_headers as Record<string, string>,
        ),
      ),
    ),
    ...frameParts(body),
    ...frameParts(TEXT_ENCODER.encode(metadata.failure_signature as string)),
    ...frameParts(TEXT_ENCODER.encode(canonicalJson(metadata.upstream))),
  ];
  return hmacHex(keyBytes, "fingerprint", parts);
}

function v2CaseGroup(
  keyBytes: Uint8Array<ArrayBuffer>,
  metadata: Record<string, unknown>,
  body: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const parts = [
    ...frameParts(TEXT_ENCODER.encode(RETAINED_CASE_GROUP_NAMESPACE)),
    ...frameParts(TEXT_ENCODER.encode(metadata.method as string)),
    ...frameParts(TEXT_ENCODER.encode(metadata.endpoint as string)),
    ...frameParts(
      TEXT_ENCODER.encode(
        stableHeaderText(
          metadata.compatibility_headers as Record<string, string>,
        ),
      ),
    ),
    ...frameParts(body),
  ];
  return hmacHex(keyBytes, "case-group", parts);
}

async function craftEnvelope(
  plaintext: Uint8Array<ArrayBuffer>,
  fingerprint: string,
  keyBytes: Uint8Array<ArrayBuffer>,
): Promise<
  { ciphertext: Uint8Array<ArrayBuffer>; iv: Uint8Array<ArrayBuffer> }
> {
  const material = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: TEXT_ENCODER.encode(RETAINED_NAMESPACE),
      info: TEXT_ENCODER.encode("encryption"),
    },
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
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: TEXT_ENCODER.encode(
          `${RETAINED_NAMESPACE}\u0000${fingerprint}`,
        ),
      },
      aesKey,
      compressed,
    ),
  );
  compressed.fill(0);
  return { ciphertext: encrypted, iv };
}

function encodeEnvelope(
  metadata: Record<string, unknown>,
  body: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const metadataBytes = TEXT_ENCODER.encode(JSON.stringify(metadata));
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, metadataBytes.byteLength, false);
  const output = new Uint8Array(4 + metadataBytes.byteLength + body.byteLength);
  output.set(size, 0);
  output.set(metadataBytes, 4);
  output.set(body, 4 + metadataBytes.byteLength);
  return output;
}

function v2Attempt(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    provider: "surplus",
    status: 200,
    content_type: "text/event-stream",
    chunks_base64: [] as string[],
    terminal: "eof",
    ...overrides,
  };
}

function v2Upstream(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    attempts: [] as Record<string, unknown>[],
    attempts_truncated: false,
    bytes_truncated: false,
    chunks_truncated: false,
    ...overrides,
  };
}

function v2Body(): Uint8Array<ArrayBuffer> {
  return TEXT_ENCODER.encode(
    '{"model":"synthetic-model","input":"variant synthetic fixture","stream":true}',
  );
}

function baseMetadata(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 2,
    captured_at_ms: CAPTURED_AT_V2,
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
    request_id: "synthetic-request-2",
    git_sha: GIT_SHA,
    deno_revision: "synthetic-revision-2",
    upstream: v2Upstream(),
    ...overrides,
  };
}

interface CraftedWireCaptureV1 {
  manifest: Record<string, unknown>;
  chunks: string[];
  ciphertext: Uint8Array<ArrayBuffer>;
  digest: string;
}

/** Craft one producer-protocol v2 capture and its exact wire replay form. */
async function craftWireCapture(
  keyBytes: Uint8Array<ArrayBuffer>,
  metadata: Record<string, unknown>,
  body: Uint8Array<ArrayBuffer>,
): Promise<CraftedWireCaptureV1> {
  const fingerprint = await v2Fingerprint(keyBytes, metadata, body);
  const caseGroupDigest = await v2CaseGroup(keyBytes, metadata, body);
  const plaintext = encodeEnvelope(metadata, body);
  const { ciphertext, iv } = await craftEnvelope(
    plaintext,
    fingerprint,
    keyBytes,
  );
  const manifestRecord = {
    version: 1,
    capture_id: CAPTURE_ID_V2,
    fingerprint,
    case_group_digest: caseGroupDigest,
    captured_at_ms: CAPTURED_AT_V2,
    expires_at_ms: CAPTURED_AT_V2 + RETAINED_TTL_MS,
    algorithm: "AES-256-GCM",
    compression: "gzip",
    iv: toBase64Url(iv),
    chunk_count: 1,
    ciphertext_bytes: ciphertext.byteLength,
  };
  return {
    manifest: manifestRecord,
    chunks: [toBase64Url(ciphertext)],
    ciphertext,
    digest: await sha256hex(ciphertext),
  };
}

function toBase64Url(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const remaining = bytes.byteLength - offset;
    const a = bytes[offset]!;
    const b = remaining > 1 ? bytes[offset + 1]! : 0;
    const c = remaining > 2 ? bytes[offset + 2]! : 0;
    output += alphabet[a >> 2]!;
    output += alphabet[((a & 0x03) << 4) | (b >> 4)]!;
    output += remaining > 1 ? alphabet[((b & 0x0f) << 2) | (c >> 6)]! : "";
    output += remaining > 2 ? alphabet[c & 0x3f]! : "";
  }
  return output;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Rig builders
// ---------------------------------------------------------------------------

function authProvider(): GatewayAuthProviderV1 {
  return {
    headers: () =>
      Promise.resolve({
        ok: true as const,
        value: { Authorization: "Bearer synthetic-token" },
      }),
  };
}

interface CompositionRigV1 {
  store: LocalArtifactStore;
  clock: FakeClock;
  root: string;
  transport: ReturnType<typeof recordingTransport>;
  composition: GatewayReplayComposition;
  keyBytes: Uint8Array<ArrayBuffer>;
}

async function makeRig(
  responder: (url: URL) => Response | Promise<Response>,
  overrides: {
    clockStart?: number;
    storeRoot?: string;
    repository?: { owner: string; name: string; installationId: number };
    keyBytes?: Uint8Array<ArrayBuffer>;
  } = {},
): Promise<CompositionRigV1> {
  const root = overrides.storeRoot ??
    await Deno.makeTempDir({
      dir: Deno.cwd(),
      prefix: "sentinel-wave-c-composition-",
    });
  const store = new LocalArtifactStore({ root, limits: LIMITS });
  const opened = await store.open();
  assert.ok(opened.ok, `store open failed: ${JSON.stringify(opened)}`);
  const transport = recordingTransport(responder);
  const clock = new FakeClock(overrides.clockStart ?? CAPTURED_AT_V2);
  const config = validConfig();
  const adapter = new GatewayIncidentAdapter({
    config,
    transport,
    auth: authProvider(),
    clock,
    store,
  });
  const keyBytes = overrides.keyBytes ??
    hexToBytes(readGolden().syntheticKeyHex);
  const composition = new GatewayReplayComposition({
    adapter,
    store,
    repository: overrides.repository ?? config.repository,
    keyBytes,
    policy: SANITIZER_POLICY,
    commandId: COMMAND_ID,
    testIds: TEST_IDS,
    expectedFailure: EXPECTED_FAILURE,
    clock,
  });
  return {
    store,
    clock,
    root,
    transport,
    composition,
    keyBytes,
  };
}

/** Exact concatenated golden ciphertext (public fixture bytes). */
function goldenCiphertext(): Uint8Array<ArrayBuffer> {
  const golden = readGolden();
  const chunks = golden.exported.chunks.map((encoded) => {
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

/** Exact index row bound to the golden capture (public synthetic identities). */
function goldenRow(digest: string): Record<string, unknown> {
  const manifest = readGolden().exported.manifest as {
    fingerprint: string;
    expires_at_ms: number;
  };
  return makeIndexRow({
    incident_id: INCIDENT_A,
    fingerprint: manifest.fingerprint,
    failing_revision: GIT_SHA,
    provenance: {
      endpoint: "https://ai.ubq.fi",
      captured_at_ms: CAPTURED_AT_V2,
      captured_by: "gateway",
    },
    evidence_ref: {
      ref: artifactRef(INCIDENT_A, CAPTURE_ID_V2),
      digest,
    },
    evidence_expires_at_ms: manifest.expires_at_ms,
  });
}

/** Golden-v2 responder: the actual recorded producer capture. */
async function goldenResponder(
  rowOverride: Record<string, unknown> = {},
): Promise<(url: URL) => Response> {
  const golden = readGolden();
  const digest = await sha256hex(await goldenCiphertext());
  return (url: URL) => {
    if (url.pathname === INDEX_PATH) {
      return jsonResponse(
        makeIndexPage([{ ...goldenRow(digest), ...rowOverride }]),
      );
    }
    return jsonResponse(makeReplayPage({
      manifest: golden.exported.manifest,
      chunks: golden.exported.chunks,
    }));
  };
}

async function removeRoot(root: string): Promise<void> {
  await Deno.remove(root, { recursive: true }).catch(() => {});
}

/** Serialize a fixture request/upstream entry to a JSON value for asserts. */
function parseEntry(
  resolved: ResolvedFixtureV1,
  name: "request" | "upstream",
): Record<string, unknown> {
  const entry = resolved.entries.find((item) =>
    item.path.endsWith(`/${name}.json`)
  );
  assert.notEqual(entry, undefined, `expected ${name}.json entry`);
  return JSON.parse(new TextDecoder().decode(entry!.bytes)) as Record<
    string,
    unknown
  >;
}

async function countStoreBinFiles(root: string): Promise<number> {
  let count = 0;
  for await (const entry of Deno.readDir(`${root}/entries`)) {
    if (entry.name.endsWith(".bin")) count += 1;
  }
  return count;
}

async function walkFiles(dir: string, out: string[] = []): Promise<string[]> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) await walkFiles(path, out);
    else out.push(path);
  }
  return out;
}

function assertNoPrivateMarkers(value: unknown): void {
  const text = JSON.stringify(value);
  for (const marker of PRIVATE_MARKERS) {
    assert.ok(
      !text.includes(marker as string),
      `private marker leaked: ${marker}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Positive: actual adapter → retained store → authenticated decrypt →
// positive sanitizer → resolver rehydration; read-only and buffer-safe.
// ---------------------------------------------------------------------------

Deno.test("composition: actual golden capture becomes replay metadata plus a deterministic trusted fixture", async () => {
  const { composition, store, root, transport, keyBytes } = await makeRig(
    await goldenResponder(),
  );
  try {
    const beforeKey = new Uint8Array(keyBytes);

    const read = await composition.readIncident(INCIDENT_A);
    assert.ok(read.ok, `readIncident must succeed: ${JSON.stringify(read)}`);
    if (!read.ok) return;
    const evidence = read.value!;
    assert.notEqual(evidence, null);
    assert.equal(evidence.incidentId, INCIDENT_A);
    assert.equal(evidence.failingRevision, GIT_SHA);
    const replay = evidence.replay;
    assert.notEqual(replay, null, "replay metadata must be attached");
    if (replay === null) return;
    assert.equal(replay.upstreamCaptured, true);
    assert.equal(replay.commandId, COMMAND_ID);
    assert.equal(replay.reproducedAt, null);
    assert.ok(
      isFixtureDigest(replay.fixtureDigest),
      "fixture digest must be 64-hex",
    );
    const fixtureRef = replay.fixtureRef;
    assert.match(
      fixtureRef,
      new RegExp(
        `^fixture://gateway-replay/${INCIDENT_A}/${CAPTURE_ID_V2}/[0-9a-f]{64}$`,
      ),
    );
    const artifactDigest = evidence.artifacts[0]!.digest;
    assert.notEqual(
      replay.fixtureDigest,
      artifactDigest,
      "bundle digest must differ from the encrypted-artifact digest",
    );
    // The strict record parser accepts the updated evidence verbatim.
    const parsed = parseIncidentEvidenceV1(evidence);
    assert.equal(parsed.replay?.fixtureRef, fixtureRef);

    // Resolver: deterministic fixture over the exact stored artifact.
    const resolvedResult = await composition.resolveFixture(fixtureRef);
    assert.ok(resolvedResult.ok, JSON.stringify(resolvedResult));
    if (!resolvedResult.ok) return;
    const resolved = resolvedResult.value;
    assert.deepEqual(resolved.testIds, TEST_IDS);
    assert.deepEqual(resolved.expectedFailure, EXPECTED_FAILURE);
    assert.deepEqual(resolved.provenance, {
      sanitized: true,
      sanitizer: "gateway-structural-v1",
      provenanceRef: fixtureRef,
      redacted: true,
      note:
        "gateway capture redacted; request and upstream re-encoded to a fixed protocol vocabulary",
    });
    assert.deepEqual(
      resolved.entries.map((entry) => entry.path).sort(),
      [
        `tests/fixtures/gateway-replay/${INCIDENT_A}/${CAPTURE_ID_V2}/request.json`,
        `tests/fixtures/gateway-replay/${INCIDENT_A}/${CAPTURE_ID_V2}/upstream.json`,
      ],
    );
    // The replay bundle digest is recomputed over the ACTUAL entry bytes.
    const bundleDigest = await computeReplayFixtureDigest(resolved.entries);
    assert.equal(bundleDigest, replay.fixtureDigest);

    // Sanitized request: fixed vocabulary, no private request material.
    const requestValue = parseEntry(resolved, "request");
    assert.equal(requestValue.endpoint, "/v1/responses");
    assert.equal(requestValue.method, "POST");
    assert.equal(requestValue.contentType, "application/json");
    assert.deepEqual(requestValue.compatibilityHeaders, {
      accept: "text/event-stream",
    });
    const requestBody = JSON.parse(requestValue.body as string) as Record<
      string,
      unknown
    >;
    assert.deepEqual(requestBody, {
      input: "fixture text",
      model: "synthetic-model",
      stream: true,
    });
    // Sanitized upstream: original SSE data is re-encoded with fixture ids.
    const upstreamValue = parseEntry(resolved, "upstream");
    assert.equal(upstreamValue.version, 1);
    const attempts = upstreamValue.attempts as Array<Record<string, unknown>>;
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.provider, "chatgpt_codex");
    assert.equal(attempts[0]!.status, 200);
    assert.equal(attempts[0]!.content_type, "text/event-stream");
    assert.equal(attempts[0]!.terminal, "eof");
    const chunkBytes = decodeStandardBase64(
      (attempts[0]!.chunks_base64 as string[])[0]!,
    );
    assert.equal(
      new TextDecoder().decode(chunkBytes),
      'data: {"type":"response.created","response":{"id":"fixture_id_1"}}\n\n',
    );
    // The bundle digest is also distinct from the sanitizer payload digest
    // (public fixture envelope), never interchangeable.
    const payloadDigest = await canonicalStringifySha256({
      version: 1,
      request: requestValue,
      upstream: upstreamValue,
    });
    assert.notEqual(payloadDigest, bundleDigest);
    assert.notEqual(payloadDigest, artifactDigest);

    // The trusted id source matches the fixture bundle exactly.
    const idsResult = await composition.resolveTestIds(
      fixtureRef,
      replay.fixtureDigest!,
    );
    assert.ok(idsResult.ok, JSON.stringify(idsResult));
    if (idsResult.ok) assert.deepEqual(idsResult.value, TEST_IDS);

    // No private markers anywhere in the public fixture bytes or evidence.
    const fixtureJson = JSON.stringify({
      request: requestValue,
      upstream: upstreamValue,
    });
    assertNoPrivateMarkers({ fixture: fixtureJson });
    assertNoPrivateMarkers(evidence);

    // Read-only: GET only against the index/replay paths, no write endpoints.
    transport.assertReadOnly([INDEX_PATH, REPLAY_PATH]);
    transport.assertNoWriteEndpoints();

    // Caller key buffer is unchanged; the store holds exactly the golden
    // ciphertext and no plaintext fixture files.
    assert.deepEqual(keyBytes, beforeKey, "key bytes were mutated");
    const stats = await store.stats();
    assert.ok(stats.ok && stats.value.count === 1);
    assert.equal(
      stats.value!.totalBytes,
      (await goldenCiphertext()).byteLength,
    );
    assert.equal(await countStoreBinFiles(root), 1);
    const allFiles = await walkFiles(root);
    assert.ok(
      allFiles.every((path) => path.includes("/entries/")),
      `only store entries may exist on disk, got: ${allFiles.join(", ")}`,
    );
  } finally {
    await removeRoot(root);
  }
});

Deno.test("composition: repeated readIncident is deterministic and never replaces the replay identity", async () => {
  const { composition, store, root, transport } = await makeRig(
    await goldenResponder(),
  );
  try {
    const first = await composition.readIncident(INCIDENT_A);
    assert.ok(first.ok && first.value !== null);
    const replay = first.value!.replay;
    assert.notEqual(replay, null);
    const second = await composition.readIncident(INCIDENT_A);
    assert.ok(second.ok && second.value !== null);
    assert.deepEqual(second.value, first.value);
    assert.equal(second.value!.replay?.fixtureRef, replay!.fixtureRef);
    assert.equal(
      second.value!.replay?.fixtureDigest,
      replay!.fixtureDigest,
    );
    // The retained artifact was not refetched: only the index was scanned.
    assert.equal(
      transport.requests.filter(
        (r) => new URL(r.url).pathname === REPLAY_PATH,
      ).length,
      1,
    );
    // Existing non-null replay identity is never recomputed/replaced and the
    // resolver is deterministic.
    assert.deepEqual(
      await composition.resolveFixture(replay!.fixtureRef),
      await composition.resolveFixture(replay!.fixtureRef),
      "resolver must be deterministic",
    );
    const stats = await store.stats();
    assert.ok(stats.ok && stats.value.count === 1);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("composition: fresh instance over the same store rehydrates the identical fixture", async () => {
  const { composition, root, keyBytes } = await makeRig(
    await goldenResponder(),
  );
  try {
    const read = await composition.readIncident(INCIDENT_A);
    assert.ok(read.ok && read.value !== null);
    const replay = read.value!.replay!;
    const original = await composition.resolveFixture(replay.fixtureRef);
    assert.ok(original.ok);

    // A fresh store instance over the same root plus a fresh composition.
    const freshStore = new LocalArtifactStore({ root, limits: LIMITS });
    assert.ok((await freshStore.open()).ok);
    const config = validConfig();
    const fresh = new GatewayReplayComposition({
      adapter: new GatewayIncidentAdapter({
        config,
        transport: recordingTransport(() => {
          throw new Error(
            "fresh composition must never refetch from the transport",
          );
        }),
        auth: authProvider(),
        clock: new FakeClock(CAPTURED_AT_V2),
        store: freshStore,
      }),
      store: freshStore,
      repository: config.repository,
      keyBytes,
      policy: SANITIZER_POLICY,
      commandId: COMMAND_ID,
      testIds: TEST_IDS,
      expectedFailure: EXPECTED_FAILURE,
      clock: new FakeClock(CAPTURED_AT_V2),
    });
    const rehydrated = await fresh.resolveFixture(replay.fixtureRef);
    assert.ok(rehydrated.ok, JSON.stringify(rehydrated));
    if (!rehydrated.ok) return;
    assert.deepEqual(rehydrated.value, original.value);
    assert.equal(
      await computeReplayFixtureDigest(rehydrated.value.entries),
      replay.fixtureDigest,
    );
    const ids = await fresh.resolveTestIds(
      replay.fixtureRef,
      replay.fixtureDigest!,
    );
    assert.ok(ids.ok);
    if (ids.ok) assert.deepEqual(ids.value, TEST_IDS);
    // Rehydration came from retained ciphertext only: no plaintext on disk.
    const statsResult = await freshStore.stats();
    assert.ok(statsResult.ok);
    if (statsResult.ok) assert.ok(statsResult.value.totalBytes > 0);
  } finally {
    await removeRoot(root);
  }
});

// ---------------------------------------------------------------------------
// Positive: actual ReplayPort resolves the composition fixture and executes
// the configured credential-free command; fresh instance rehydration.
// ---------------------------------------------------------------------------

const FIXTURE_REPLAY_SCRIPT =
  `const incident = "provider-00000000-0000-4000-8000-000000000001";
const capture = "synthetic-capture-2";
const base = "tests/fixtures/gateway-replay/" + incident + "/" + capture;
const request = JSON.parse(await Deno.readTextFile(base + "/request.json"));
const upstream = JSON.parse(await Deno.readTextFile(base + "/upstream.json"));
console.log("sentinel-replay-test:gateway:complete-upstream");
const body = JSON.parse(request.body);
if (body.model !== "synthetic-model") Deno.exit(1);
if (!upstream.attempts.every((a: { terminal: string }) => a.terminal === "eof")) {
  Deno.exit(1);
}
`;

Deno.test("composition: actual ReplayPort fixture resolution from the composition and a fresh instance", async () => {
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-wave-c-replay-port-",
  });
  let storeRoot: string | null = null;
  try {
    // Minimal credential-free target repo with the configured replay command.
    const repoRoot = `${root}/fixture-repo`;
    await Deno.mkdir(repoRoot);
    const env = testGitEnv(`${root}/home`);
    await gitRun(repoRoot, ["init", "-q", "-b", "main"], env);
    await commitWith(
      repoRoot,
      env,
      {
        "deno.json": JSON.stringify(
          {
            tasks: {
              replay: "deno run --allow-read=tests/ scripts/replay.ts",
            },
          },
          null,
          2,
        ) + "\n",
        "scripts/replay.ts": FIXTURE_REPLAY_SCRIPT,
      },
      "target: gateway replay command",
    );
    const repoSha = await revParse(repoRoot, env);
    assert.ok(isGitSha(repoSha));

    const rig = await makeRig(await goldenResponder());
    const composition = rig.composition;
    storeRoot = rig.root;
    const keyBytes = rig.keyBytes;
    const read = await composition.readIncident(INCIDENT_A);
    assert.ok(read.ok && read.value !== null);
    const replay = read.value!.replay!;

    const config = replayConfig();
    const policy: ReplayPolicyV1 = {
      bundleScopes: ["tests/"],
      maxFixtureBytes: 512 * 1024,
      maxEntryBytes: 256 * 1024,
      proof: markerProofParser(),
    };
    const makePort = (fixtures: GatewayReplayComposition): ReplayPortImpl =>
      new ReplayPortImpl({
        config,
        source: { kind: "local", path: repoRoot },
        scratchDir: `${root}/scratch`,
        fixtures,
        policy,
        isolation: toyIsolation(),
      });
    const request = {
      taskId: "incident:gateway-0001" as WorkItemId,
      repository: TOY_REPOSITORY,
      revision: repoSha,
      commandId: "replay" as CommandId,
      fixtureRef: replay.fixtureRef,
      fixtureDigest: replay.fixtureDigest!,
      testIds: TEST_IDS,
      outputLimitBytes: 262144,
    };

    const first = await makePort(composition).runReplay(request);
    assert.ok(first.ok, `runReplay must succeed: ${JSON.stringify(first)}`);
    if (!first.ok) return;
    assert.equal(first.value.outcome, "passed");
    assert.equal(first.value.exitCode, 0);
    assert.equal(first.value.failure, null);
    assert.ok(first.value.output?.stdoutDigest !== null);
    // The trusted fixture provenance is redacted: the limitation is truthful.
    assert.deepEqual(first.value.limitations, ["fixture_redacted"]);

    // Rehydration: a fresh composition instance over the same store root.
    const freshStore = new LocalArtifactStore({
      root: storeRoot,
      limits: LIMITS,
    });
    assert.ok((await freshStore.open()).ok);
    const fresh = new GatewayReplayComposition({
      adapter: new GatewayIncidentAdapter({
        config: validConfig(),
        transport: recordingTransport(() => {
          throw new Error("fresh composition must never refetch");
        }),
        auth: authProvider(),
        clock: new FakeClock(CAPTURED_AT_V2),
        store: freshStore,
      }),
      store: freshStore,
      repository: validConfig().repository,
      keyBytes,
      policy: SANITIZER_POLICY,
      commandId: COMMAND_ID,
      testIds: TEST_IDS,
      expectedFailure: EXPECTED_FAILURE,
      clock: new FakeClock(CAPTURED_AT_V2),
    });
    const ids = await fresh.resolveTestIds(
      replay.fixtureRef,
      replay.fixtureDigest!,
    );
    assert.ok(ids.ok);
    if (ids.ok) assert.deepEqual(ids.value, TEST_IDS);
    const second = await makePort(fresh).runReplay(request);
    assert.ok(second.ok, JSON.stringify(second));
    if (second.ok) {
      assert.equal(second.value.outcome, "passed");
      assert.equal(
        second.value.output?.stdoutDigest,
        first.value.output?.stdoutDigest,
      );
    }

    // No plaintext fixture files inside the store; source repo untouched;
    // the disposable scratch was cleaned by the port.
    assert.equal(await countStoreBinFiles(storeRoot), 1);
    const allFiles = await walkFiles(storeRoot);
    assert.ok(
      allFiles.every((path) => path.includes("/entries/")),
      `only store entries may exist on disk, got: ${allFiles.join(", ")}`,
    );
    const status = await gitRun(repoRoot, ["status", "--porcelain"], env);
    assert.equal(status.stdout.trim(), "");
    assert.equal(await revParse(repoRoot, env), repoSha);
    const scratchLeft: string[] = [];
    try {
      for await (const entry of Deno.readDir(`${root}/scratch`)) {
        scratchLeft.push(entry.name);
      }
    } catch {
      // scratch dir may not exist; no leftovers then
    }
    assert.deepEqual(scratchLeft, []);
  } finally {
    await removeRoot(root);
    if (storeRoot !== null) await removeRoot(storeRoot);
  }
});

function replayConfig(): RepositoryConfigV1 {
  return parseRepositoryConfigV1({
    version: "v1",
    kind: "repository_config",
    repository: TOY_REPOSITORY,
    baseBranch: "main",
    adapter: { kind: "gateway", baseUrl: "https://ai.ubq.fi" },
    commands: { replay: "replay", test: "test" },
    commandRegistry: {
      version: "v1",
      commands: {
        replay: {
          executable: "deno",
          args: ["task", "replay"],
          maxDurationMs: 30000,
          maxOutputBytes: 262144,
        },
        test: {
          executable: "deno",
          args: ["eval", "true"],
          maxDurationMs: 30000,
          maxOutputBytes: 262144,
        },
      },
    },
    protectedPaths: ["src/"],
    build: { projectId: null, acceptance: null },
    secretRef: null,
    liveStartLimits: null,
    sessionBound: null,
    retention: null,
    stabilityPolicy: null,
  });
}

// ---------------------------------------------------------------------------
// Negative: no upstream / partial / non-eof traces keep replay null
// ---------------------------------------------------------------------------

async function readCrafted(
  metadata: Record<string, unknown>,
  keyBytes: Uint8Array<ArrayBuffer>,
): Promise<{
  read: Promise<Awaited<ReturnType<GatewayReplayComposition["readIncident"]>>>;
  cleanup: () => Promise<void>;
}> {
  const crafted = await craftWireCapture(keyBytes, metadata, v2Body());
  const responder = (url: URL): Response => {
    if (url.pathname === INDEX_PATH) {
      return jsonResponse(makeIndexPage([
        makeIndexRow({
          incident_id: INCIDENT_A,
          fingerprint: crafted.manifest.fingerprint as string,
          failing_revision: GIT_SHA,
          provenance: {
            endpoint: "https://ai.ubq.fi",
            captured_at_ms: CAPTURED_AT_V2,
            captured_by: "gateway",
          },
          evidence_ref: {
            ref: artifactRef(INCIDENT_A, CAPTURE_ID_V2),
            digest: crafted.digest,
          },
          evidence_expires_at_ms: crafted.manifest.expires_at_ms as number,
        }),
      ]));
    }
    return jsonResponse(makeReplayPage({
      manifest: crafted.manifest,
      chunks: crafted.chunks,
    }));
  };
  const { composition, root } = await makeRig(responder, { keyBytes });
  return {
    read: composition.readIncident(INCIDENT_A),
    cleanup: () => removeRoot(root),
  };
}

Deno.test("composition: no upstream trace keeps replay null and never invents a fixture", async () => {
  const keyBytes = hexToBytes(readGolden().syntheticKeyHex);
  const fabricated = await readCrafted(
    baseMetadata({ upstream: v2Upstream({ attempts: [] }) }),
    keyBytes,
  );
  try {
    const read = await fabricated.read;
    assert.ok(read.ok, JSON.stringify(read));
    if (read.ok && read.value !== null) {
      assert.equal(read.value.replay, null);
      assert.equal(read.value.artifacts.length, 1);
      assertNoPrivateMarkers(read.value);
    }
  } finally {
    await fabricated.cleanup();
  }
});

Deno.test("composition: truncated traces keep replay null", async () => {
  const keyBytes = hexToBytes(readGolden().syntheticKeyHex);
  const variants = [
    v2Upstream({ attempts: [v2Attempt()], attempts_truncated: true }),
    v2Upstream({ attempts: [v2Attempt()], bytes_truncated: true }),
    v2Upstream({ attempts: [v2Attempt()], chunks_truncated: true }),
  ];
  for (const [index, upstream] of variants.entries()) {
    const fabricated = await readCrafted(
      baseMetadata({ upstream }),
      keyBytes,
    );
    try {
      const read = await fabricated.read;
      assert.ok(read.ok, `variant ${index}: ${JSON.stringify(read)}`);
      if (read.ok && read.value !== null) {
        assert.equal(
          read.value.replay,
          null,
          `variant ${index} must stay null`,
        );
      }
    } finally {
      await fabricated.cleanup();
    }
  }
});

Deno.test("composition: non-eof terminals (cancelled/read_error/fetch_error/pending) keep replay null", async () => {
  const keyBytes = hexToBytes(readGolden().syntheticKeyHex);
  const variants: Array<Record<string, unknown>> = [
    v2Attempt({
      provider: "cerebras",
      status: 200,
      content_type: "application/json",
      chunks_base64: [],
      terminal: "cancelled",
    }),
    v2Attempt({
      provider: "metered",
      status: 503,
      content_type: "other",
      chunks_base64: [standardBase64(TEXT_ENCODER.encode("partial"))],
      terminal: "read_error",
    }),
    v2Attempt({
      provider: "surplus",
      status: null,
      content_type: null,
      chunks_base64: [],
      terminal: "fetch_error",
    }),
    v2Attempt({
      provider: "cerebras",
      status: 200,
      content_type: "application/json",
      chunks_base64: [],
      terminal: "pending",
    }),
  ];
  for (const [index, attempt] of variants.entries()) {
    const fabricated = await readCrafted(
      baseMetadata({ upstream: v2Upstream({ attempts: [attempt] }) }),
      keyBytes,
    );
    try {
      const read = await fabricated.read;
      assert.ok(read.ok, `variant ${index}: ${JSON.stringify(read)}`);
      if (read.ok && read.value !== null) {
        assert.equal(
          read.value.replay,
          null,
          `variant ${index} must stay null`,
        );
      }
    } finally {
      await fabricated.cleanup();
    }
  }
});

// ---------------------------------------------------------------------------
// Negative: wrong fingerprint/revision/repository/missing-revision bindings
// ---------------------------------------------------------------------------

Deno.test("composition: wrong fingerprint/revision/repository bindings are rejected with static typed errors", async () => {
  const wrongFingerprint = await makeRig(
    await goldenResponder({ fingerprint: "a".repeat(64) }),
  );
  try {
    const read = await wrongFingerprint.composition.readIncident(INCIDENT_A);
    assert.ok(!read.ok && read.error.kind === "invalid");
    assert.equal(
      (read as { error: { detail: string } }).error.detail,
      "retained capture does not match the exact incident identity",
    );
    assertNoPrivateMarkers(read);
  } finally {
    await removeRoot(wrongFingerprint.root);
  }

  const wrongRevision = await makeRig(
    await goldenResponder({ failing_revision: "2".repeat(40) }),
  );
  try {
    const read = await wrongRevision.composition.readIncident(INCIDENT_A);
    assert.ok(!read.ok && read.error.kind === "invalid");
    assertNoPrivateMarkers(read);
  } finally {
    await removeRoot(wrongRevision.root);
  }

  const wrongRepository = await makeRig(await goldenResponder(), {
    repository: { owner: "other", name: "other-repo", installationId: 7 },
  });
  try {
    const read = await wrongRepository.composition.readIncident(INCIDENT_A);
    assert.ok(!read.ok && read.error.kind === "invalid");
    assert.equal(
      (read as { error: { detail: string } }).error.detail,
      "incident evidence does not belong to the configured repository",
    );
    assertNoPrivateMarkers(read);
  } finally {
    await removeRoot(wrongRepository.root);
  }
});

Deno.test("composition: missing failing revision leaves replay null", async () => {
  const { composition, root } = await makeRig(
    await goldenResponder({ failing_revision: null }),
  );
  try {
    const read = await composition.readIncident(INCIDENT_A);
    assert.ok(read.ok && read.value !== null);
    if (read.ok && read.value !== null) {
      assert.equal(read.value.replay, null);
    }
  } finally {
    await removeRoot(root);
  }
});

// ---------------------------------------------------------------------------
// Negative: missing, expired and tampered artifacts; malformed refs; digests
// ---------------------------------------------------------------------------

Deno.test("composition: missing artifact and expired artifact fail closed", async () => {
  const { composition, root } = await makeRig(await goldenResponder());
  try {
    const read = await composition.readIncident(INCIDENT_A);
    assert.ok(read.ok && read.value !== null);
    const replay = read.value!.replay!;
    // Remove the retained entry from disk: the store no longer holds it.
    for await (const entry of Deno.readDir(`${root}/entries`)) {
      await Deno.remove(`${root}/entries/${entry.name}`);
    }
    const missing = await composition.resolveFixture(replay.fixtureRef);
    assert.ok(!missing.ok && missing.error.kind === "not_found");
    assert.equal(
      (missing as { error: { detail: string } }).error.detail,
      "retained artifact is missing or expired",
    );
    assertNoPrivateMarkers(missing);
  } finally {
    await removeRoot(root);
  }

  // Expired: the accepted retention boundary passed, so the retained entry is
  // purged and the source capture is also expired: the evidence read is the
  // typed null (evidence_expired), never an invented fixture.
  const expired = await makeRig(await goldenResponder(), {
    clockStart: CAPTURED_AT_V2 + LIMITS.retentionMaxAgeMs + 1,
  });
  try {
    const read = await expired.composition.readIncident(INCIDENT_A);
    assert.ok(read.ok);
    if (read.ok) assert.equal(read.value, null);
  } finally {
    await removeRoot(expired.root);
  }
});

Deno.test("composition: tampered artifact bytes and wrong artifact identity fail closed with static invalid errors", async () => {
  const { composition, root } = await makeRig(await goldenResponder());
  try {
    const read = await composition.readIncident(INCIDENT_A);
    assert.ok(read.ok && read.value !== null);
    const replay = read.value!.replay!;

    // Tampered ciphertext bytes at the exact retained ref.
    const entryKey = await sha256hex(
      TEXT_ENCODER.encode(artifactRef(INCIDENT_A, CAPTURE_ID_V2)),
    );
    const binPath = `${root}/entries/${entryKey}.bin`;
    const bin = await Deno.readFile(binPath);
    bin[0] = (bin[0]! + 1) & 0xff;
    await Deno.writeFile(binPath, bin);
    const tampered = await composition.resolveFixture(replay.fixtureRef);
    assert.ok(!tampered.ok && tampered.error.kind === "invalid");
    assert.equal(
      (tampered as { error: { detail: string } }).error.detail,
      "retained artifact identity cannot be verified",
    );
    assertNoPrivateMarkers(tampered);
    // Restore the original bytes before the identity tamper below.
    bin[0] = (bin[0]! - 1) & 0xff;
    await Deno.writeFile(binPath, bin);

    // Wrong artifact identity: metadata names a different capture id.
    const metaPath = `${root}/entries/${entryKey}.json`;
    const metadata = JSON.parse(
      await Deno.readTextFile(metaPath),
    ) as Record<string, unknown>;
    metadata.captureId = "different-capture-identity";
    await Deno.writeTextFile(metaPath, JSON.stringify(metadata));
    const wrongIdentity = await composition.resolveFixture(replay.fixtureRef);
    assert.ok(!wrongIdentity.ok && wrongIdentity.error.kind === "invalid");
    assertNoPrivateMarkers(wrongIdentity);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("composition: malformed fixture refs and bundle-digest mismatches are rejected with static errors", async () => {
  const { composition, root } = await makeRig(await goldenResponder());
  try {
    const read = await composition.readIncident(INCIDENT_A);
    assert.ok(read.ok && read.value !== null);
    const replay = read.value!.replay!;

    for (
      const malformed of [
        "",
        "artifact://sentinel/provider-00000000-0000-4000-8000-000000000001/synthetic-capture-2",
        "fixture://gateway-replay/not-an-incident/synthetic-capture-2/" +
        "a".repeat(64),
        "fixture://gateway-replay/provider-00000000-0000-4000-8000-000000000001/synthetic-capture-2/" +
        "a".repeat(63),
        "fixture://gateway-replay/provider-00000000-0000-4000-8000-000000000001/../../etc/" +
        "a".repeat(64),
      ]
    ) {
      const result = await composition.resolveFixture(malformed);
      assert.ok(!result.ok && result.error.kind === "invalid", malformed);
      assert.equal(
        (result as { error: { detail: string } }).error.detail,
        "fixture reference is not a supported gateway replay reference",
      );
    }

    // Bundle-digest mismatch: one hex digit of the embedded digest changed.
    const corruptedDigest = `${replay.fixtureRef.slice(0, -1)}${
      replay.fixtureRef.endsWith("0") ? "1" : "0"
    }`;
    const mismatch = await composition.resolveFixture(corruptedDigest);
    assert.ok(!mismatch.ok && mismatch.error.kind === "invalid");
    assert.equal(
      (mismatch as { error: { detail: string } }).error.detail,
      "fixture bundle digest does not match the reference identity",
    );
    assertNoPrivateMarkers(mismatch);

    // resolveTestIds also rejects a supplied digest that does not match.
    const wrongDigest = replay.fixtureDigest!.startsWith("0")
      ? `1${replay.fixtureDigest!.slice(1)}`
      : `0${replay.fixtureDigest!.slice(1)}`;
    const idsMismatch = await composition.resolveTestIds(
      replay.fixtureRef,
      wrongDigest as FixtureDigest,
    );
    assert.ok(!idsMismatch.ok && idsMismatch.error.kind === "invalid");
    assert.equal(
      (idsMismatch as { error: { detail: string } }).error.detail,
      "fixture bundle digest does not match the reference identity",
    );

    const idsBadDigest = await composition.resolveTestIds(
      replay.fixtureRef,
      "zz" as unknown as FixtureDigest,
    );
    assert.ok(!idsBadDigest.ok && idsBadDigest.error.kind === "invalid");
  } finally {
    await removeRoot(root);
  }
});

// ---------------------------------------------------------------------------
// Wiring sanity: malformed caller-supplied capabilities are refused at
// construction (fail fast, before any artifact is touched).
// ---------------------------------------------------------------------------

Deno.test("composition: refuses caller-supplied capabilities that violate the trusted shape", () => {
  assert.throws(
    () =>
      new GatewayReplayComposition({
        adapter: {} as never,
        store: {} as never,
        repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
        keyBytes: new Uint8Array(16),
        policy: SANITIZER_POLICY,
        commandId: COMMAND_ID,
        testIds: TEST_IDS,
        expectedFailure: EXPECTED_FAILURE,
        clock: new FakeClock(0),
      }),
    /32-byte key/,
  );
  assert.throws(
    () =>
      new GatewayReplayComposition({
        adapter: {} as never,
        store: {} as never,
        repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
        keyBytes: new Uint8Array(32),
        policy: SANITIZER_POLICY,
        commandId: "not allowed" as CommandId,
        testIds: TEST_IDS,
        expectedFailure: EXPECTED_FAILURE,
        clock: new FakeClock(0),
      }),
    /replay command id/,
  );
  assert.throws(
    () =>
      new GatewayReplayComposition({
        adapter: {} as never,
        store: {} as never,
        repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
        keyBytes: new Uint8Array(32),
        policy: SANITIZER_POLICY,
        commandId: COMMAND_ID,
        testIds: [],
        expectedFailure: EXPECTED_FAILURE,
        clock: new FakeClock(0),
      }),
    /test identity/,
  );
});
