/**
 * Strict producer wire parser tests: the frozen gateway index fixture, exact
 * replay manifest/chunk schema (fail-closed), and byte/chunk-grid rules.
 */

import assert from "node:assert/strict";

import {
  concatReplayChunks,
  gatewayRowToSummary,
  GatewayWireError,
  parseGatewayIndexPageV1,
  parseGatewayIndexRowV1,
  parseGatewayReplayCaptureV1,
  parseGatewayReplayManifestV1,
  parseGatewayReplayPageV1,
} from "../../../src/adapters/gateway/wire.ts";
import { RecordParseError } from "../../../src/contracts/validation.ts";
import {
  b64Url,
  CAPTURE_ID_A,
  FINGERPRINT_A,
  INCIDENT_A,
  makeCapture,
  makeIndexPage,
  makeIndexRow,
  makeManifest,
  makeReplayPage,
  syntheticBytes,
  T0,
} from "./helpers.ts";

Deno.test("wire: frozen gateway index fixture parses and maps", () => {
  const fixture = JSON.parse(
    Deno.readTextFileSync(
      new URL(
        "../../fixtures/contracts/gateway-index-v1.json",
        import.meta.url,
      ),
    ),
  ) as {
    data: Record<string, unknown>[];
    cursor: string | null;
    coverage: { status: string };
  };
  const page = parseGatewayIndexPageV1(fixture);
  assert.equal(page.rows.length, 2);
  assert.equal(page.cursor, null);
  assert.deepEqual(page.coverage, { status: "complete" });
  const first = page.rows[0]!;
  assert.equal(first.incidentId, INCIDENT_A);
  // The fixture's own stable fingerprint is preserved exactly.
  assert.equal(
    first.fingerprint,
    "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00",
  );
  assert.equal(first.severity, "P1");
  assert.equal(first.count, 7);
  assert.equal(
    first.failingRevision,
    "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  );
  assert.equal(first.evidenceExpiresAt, 1_700_172_803_000);
  assert.equal(
    first.evidenceRef?.ref,
    "artifact://sentinel/synth-0001/capture-1.pgp",
  );
  const second = page.rows[1]!;
  assert.equal(second.failingRevision, null);
  assert.equal(second.evidenceRef, null);
  // Repository identity/source are trusted adapter constants (not wire fields);
  // the frozen summary mapping succeeds for both fixture rows.
  for (const row of page.rows) {
    const mapped = gatewayRowToSummary(row, {
      owner: "ubiquity",
      name: "ai.ubq.fi",
      installationId: 12345,
    }, page.coverage);
    assert.equal(mapped.provenance.source, "gateway");
  }
});

Deno.test("wire: index row fails closed on unknown keys and malformed identities", () => {
  const row = makeIndexRow();
  assert.throws(
    () => parseGatewayIndexRowV1({ ...row, claim_url: "https://x" }),
    GatewayWireError,
  );
  assert.throws(
    () =>
      parseGatewayIndexRowV1({ ...row, incident_id: "sentinel-synth-0001" }),
    GatewayWireError,
  );
  assert.throws(
    () => parseGatewayIndexRowV1({ ...row, fingerprint: "not-a-digest" }),
    GatewayWireError,
  );
  assert.throws(
    () => parseGatewayIndexRowV1({ ...row, count: 0 }),
    GatewayWireError,
  );
  assert.throws(
    () => parseGatewayIndexRowV1({ ...row, failing_revision: "zz" }),
    GatewayWireError,
  );
  assert.throws(
    () => parseGatewayIndexRowV1({ ...row, severity: "P5" }),
    GatewayWireError,
  );
  assert.throws(
    () => parseGatewayIndexRowV1({ ...row, last_seen_at_ms: T0 - 1 }),
    GatewayWireError,
  );
  // The frozen restricted-ref rules apply at the summary mapping (the frozen
  // parser is the authority); the row parser keeps type-level checks only.
  const urlRefRow = parseGatewayIndexRowV1({
    ...row,
    evidence_ref: {
      ref: "https://evidence.example/raw",
      digest: "a".repeat(64),
    },
  });
  assert.throws(
    () =>
      gatewayRowToSummary(urlRefRow, {
        owner: "ubiquity",
        name: "ai.ubq.fi",
        installationId: 1,
      }, { status: "complete" }),
    RecordParseError,
  );
});

Deno.test("wire: index page rejects unknown keys, bad cursors and incomplete coverage shapes", () => {
  const page = makeIndexPage([makeIndexRow()]);
  assert.throws(
    () => parseGatewayIndexPageV1({ ...page, unknown: 1 }),
    GatewayWireError,
  );
  assert.throws(
    () => parseGatewayIndexPageV1({ ...page, cursor: "" }),
    GatewayWireError,
  );
  assert.throws(
    () => parseGatewayIndexPageV1({ ...page, cursor: "x".repeat(2_049) }),
    GatewayWireError,
  );
  // Complete coverage with a non-null cursor is normal pagination: the page's
  // source contribution was fully covered while another page remains — the
  // producer reports complete for every successful page read, never
  // incomplete merely because more pages exist.
  const continued = parseGatewayIndexPageV1({
    ...page,
    coverage: { status: "complete" },
    cursor: "p2",
  });
  assert.equal(continued.coverage.status, "complete");
  assert.equal(continued.cursor, "p2");
  // Incomplete coverage with a non-null cursor is representable: the scan was
  // truncated while pagination continues.
  const incomplete = parseGatewayIndexPageV1({
    ...page,
    coverage: {
      status: "incomplete",
      reason: "scan truncated",
      nextCursor: "p2",
    },
    cursor: "p2",
  });
  assert.equal(incomplete.coverage.status, "incomplete");
  assert.equal(incomplete.cursor, "p2");
  // Incomplete coverage with a null cursor is also representable: the scan
  // itself was truncated even though pagination ended.
  const truncated = parseGatewayIndexPageV1({
    ...page,
    coverage: {
      status: "incomplete",
      reason: "scan truncated",
      nextCursor: null,
    },
  });
  assert.equal(truncated.coverage.status, "incomplete");
});

Deno.test("wire: exact producer replay manifest schema is accepted", () => {
  const manifest = makeManifest();
  const parsed = parseGatewayReplayManifestV1(manifest);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.captureId, CAPTURE_ID_A);
  assert.equal(parsed.fingerprint, FINGERPRINT_A);
  assert.equal(parsed.algorithm, "AES-256-GCM");
  assert.equal(parsed.compression, "gzip");
  assert.equal(parsed.chunkCount, 1);
  assert.equal(parsed.ciphertextBytes, 64);
  // IV decodes to exactly 12 bytes.
  const decodedIv = b64Url(new Uint8Array(12).fill(7));
  assert.equal(parsed.iv, decodedIv);
});

Deno.test("wire: multi-page capture matches the producer 48KiB chunk grid", () => {
  const total = 48 * 1_024 + 100;
  const bytes = syntheticBytes(total, 9);
  const capture = makeCapture(bytes);
  const parsed = parseGatewayReplayCaptureV1(capture);
  assert.equal(parsed.manifest.chunkCount, 2);
  assert.equal(parsed.chunks[0]!.byteLength, 48 * 1_024);
  assert.equal(parsed.chunks[1]!.byteLength, 100);
  const concat = concatReplayChunks(parsed);
  assert.deepEqual(Array.from(concat), Array.from(bytes));
});

Deno.test("wire: replay manifest/chunk violations are all fail-closed", () => {
  const base = makeCapture(syntheticBytes(64, 1));
  const cases: {
    name: string;
    mutate: (c: typeof base) => Record<string, unknown>;
  }[] = [
    {
      name: "chunk_count mismatch",
      mutate: (c) => ({ ...c, chunks: [...c.chunks, "AAAA"] }),
    },
    {
      name: "ciphertext_bytes mismatch",
      mutate: (c) => ({
        ...c,
        manifest: { ...c.manifest, ciphertext_bytes: 128 },
      }),
    },
    {
      name: "chunk size mismatch",
      mutate: (c) => ({ ...c, chunks: [b64Url(syntheticBytes(63, 2))] }),
    },
    {
      name: "bad base64url charset",
      mutate: (c) => ({ ...c, chunks: ["a+b/d"] }),
    },
    {
      name: "expiry not after capture",
      mutate: (c) => ({
        ...c,
        manifest: { ...c.manifest, expires_at_ms: T0 },
      }),
    },
    {
      name: "unsupported algorithm",
      mutate: (c) => ({
        ...c,
        manifest: { ...c.manifest, algorithm: "AES-256-CBC" },
      }),
    },
    {
      name: "unsupported compression",
      mutate: (c) => ({
        ...c,
        manifest: { ...c.manifest, compression: "none" },
      }),
    },
    {
      name: "bad iv",
      mutate: (c) => ({
        ...c,
        manifest: { ...c.manifest, iv: b64Url(new Uint8Array(16).fill(1)) },
      }),
    },
    {
      name: "fingerprint not 64 hex",
      mutate: (c) => ({
        ...c,
        manifest: { ...c.manifest, fingerprint: "deadbeef" },
      }),
    },
    {
      name: "unknown manifest key",
      mutate: (c) => ({
        ...c,
        manifest: { ...c.manifest, chunk_checksum: "x" },
      }),
    },
  ];
  for (const item of cases) {
    assert.throws(
      () => parseGatewayReplayCaptureV1(item.mutate(base)),
      GatewayWireError,
      item.name,
    );
  }
  // An empty page is a real value, and a page-level unknown key is rejected.
  const empty = parseGatewayReplayPageV1(makeReplayPage(
    makeCapture(syntheticBytes(64, 1)),
  ));
  assert.equal(empty.captures.length, 1);
  assert.throws(
    () =>
      parseGatewayReplayPageV1(
        {
          ...makeReplayPage(makeCapture(syntheticBytes(64, 1))),
          coverage: { status: "complete" },
        },
      ),
    GatewayWireError,
  );
});

Deno.test("wire: mismatched manifest grid (count too large for bytes) is rejected", () => {
  // 2 chunks but ciphertext_bytes=64 -> the grid requires > 48KiB.
  assert.throws(
    () =>
      parseGatewayReplayManifestV1(
        makeManifest({ chunk_count: 2, ciphertext_bytes: 64 }),
      ),
    GatewayWireError,
  );
  // 1 chunk with fewer than 16 bytes is below the GCM tag size.
  assert.throws(
    () =>
      parseGatewayReplayManifestV1(
        makeManifest({ chunk_count: 1, ciphertext_bytes: 15 }),
      ),
    GatewayWireError,
  );
});
