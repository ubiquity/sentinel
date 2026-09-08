/**
 * Bounded synchronous archive reader tests for the m05 release lane.
 * The committed fixture is the immutable primary artifact (gateway emitter
 * output produced by the pinned actions/upload-artifact archiver 7.0.1);
 * the synthetic format cases are immutable generated archives covering the
 * accepted layouts and the rejected variants.
 */

import uploadFixture from "../fixtures/release/build-receipt-upload-v1.json" with {
  type: "json",
};
import zipCases from "../fixtures/release/receipt-zip-cases-v1.json" with {
  type: "json",
};
import { decodeBuildReceiptArchive } from "../../src/release/receipt-archive.ts";
import type { PortResultV1 } from "../../src/contracts/ports.ts";

const INVALID_DETAIL = "build receipt archive is invalid";

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Convert a named immutable fixture case to a fresh input buffer. */
function archiveOf(name: keyof typeof zipCases.archives): Uint8Array {
  return base64ToBytes(zipCases.archives[name]);
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function decodePreservingInput(input: Uint8Array): PortResultV1<unknown> {
  const snapshot = input.slice();
  const result = decodeBuildReceiptArchive(input);
  if (input.length !== snapshot.length) {
    throw new Error(
      `input length changed (${input.length} != ${snapshot.length})`,
    );
  }
  for (let i = 0; i < input.length; i++) {
    if (input[i] !== snapshot[i]) throw new Error(`input byte ${i} changed`);
  }
  return result;
}

function expectOk(result: PortResultV1<unknown>): unknown {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.kind}`);
  return result.value;
}

function expectInvalid(result: PortResultV1<unknown>): void {
  if (result.ok) throw new Error("expected invalid, got ok");
  if (
    result.error.kind !== "invalid" || result.error.detail !== INVALID_DETAIL
  ) {
    throw new Error(`unexpected error ${JSON.stringify(result.error)}`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown): void {
  if (actual === expected) return;
  if (
    typeof actual !== "object" || typeof expected !== "object" ||
    actual === null || expected === null
  ) {
    throw new Error(
      `deep mismatch: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`,
    );
  }
  const actualRecord = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  const actualKeys = Object.keys(actualRecord);
  const expectedKeys = Object.keys(expectedRecord);
  if (actualKeys.length !== expectedKeys.length) {
    throw new Error(
      `key count mismatch: ${JSON.stringify(actual)} vs ${
        JSON.stringify(expected)
      }`,
    );
  }
  for (const key of actualKeys) {
    if (!(key in expectedRecord)) throw new Error(`missing key ${key}`);
    assertDeepEqual(actualRecord[key], expectedRecord[key]);
  }
}

Deno.test("decodes the committed fixture to exactly its receipt", () => {
  const archive = base64ToBytes(uploadFixture.archiveBase64);
  if (archive.length !== uploadFixture.archiveSize) {
    throw new Error(
      `fixture archive size mismatch: ${archive.length} != ${uploadFixture.archiveSize}`,
    );
  }
  const fixtureBefore = JSON.stringify(uploadFixture);
  const result = decodePreservingInput(archive);
  assertDeepEqual(expectOk(result), uploadFixture.receipt);
  if (JSON.stringify(uploadFixture) !== fixtureBefore) {
    throw new Error("fixture object mutated by decoding");
  }
});

Deno.test("accepts stored and deflated single-entry archives", () => {
  for (const name of ["stored", "deflated"] as const) {
    assertDeepEqual(
      expectOk(decodePreservingInput(archiveOf(name))),
      zipCases.receipt,
    );
  }
});

Deno.test("rejects an archive with an extra entry", () => {
  expectInvalid(decodePreservingInput(archiveOf("extra")));
});

Deno.test("rejects non-exact entry names (path and directory)", () => {
  expectInvalid(decodePreservingInput(archiveOf("nested")));
  expectInvalid(decodePreservingInput(archiveOf("directory")));
});

Deno.test("rejects missing or truncated end-of-central-directory", () => {
  const archive = archiveOf("stored");
  expectInvalid(decodePreservingInput(archive.slice(0, archive.length - 5)));
  expectInvalid(decodePreservingInput(archive.slice(0, 8)));
});

Deno.test("rejects the encryption flag", () => {
  const archive = archiveOf("stored");
  const patched = archive.slice();
  patched[6] |= 0x01; // encryption bit in the local header flags
  const centralOffset = readU32(patched, patched.length - 22 + 16);
  patched[centralOffset + 8] |= 0x01; // encryption bit in the central flags
  expectInvalid(decodePreservingInput(patched));
});

Deno.test("rejects invalid UTF-8 receipt bytes", () => {
  expectInvalid(decodePreservingInput(archiveOf("invalidUtf8")));
});

Deno.test("rejects receipt bytes that are not JSON", () => {
  expectInvalid(decodePreservingInput(archiveOf("invalidJson")));
});

Deno.test("rejects a decoded receipt over 8192 bytes", () => {
  expectInvalid(decodePreservingInput(archiveOf("oversized")));
});

Deno.test("rejects empty and oversized input buffers", () => {
  expectInvalid(decodePreservingInput(new Uint8Array(0)));
  expectInvalid(decodePreservingInput(new Uint8Array(262145)));
});

Deno.test("rejects an archive with no entries", () => {
  expectInvalid(decodePreservingInput(archiveOf("empty")));
});

Deno.test("rejects a local header name that differs from the central name", () => {
  const archive = archiveOf("stored");
  const patched = archive.slice();
  patched[30] = 0x78; // 's' -> 'x' in the local header name
  expectInvalid(decodePreservingInput(patched));
});

Deno.test("rejects a deflated entry whose declared uncompressed size is zero", () => {
  const archive = archiveOf("deflated");
  const patched = archive.slice();
  const centralOffset = readU32(patched, patched.length - 22 + 16);
  writeU32(patched, 22, 0); // local uncompressed size
  writeU32(patched, centralOffset + 24, 0); // central uncompressed size
  expectInvalid(decodePreservingInput(patched));
});

Deno.test("rejects an actually oversize receipt even when the declared sizes are patched below the limit", () => {
  const archive = archiveOf("oversized");
  const patched = archive.slice();
  const centralOffset = readU32(patched, patched.length - 22 + 16);
  writeU32(patched, 22, 8191); // local uncompressed size below the limit
  writeU32(patched, centralOffset + 24, 8191); // central uncompressed size
  expectInvalid(decodePreservingInput(patched));
});

Deno.test("rejects trailing compressed bytes after the deflate stream", () => {
  const archive = archiveOf("deflated");
  const centralOffset = readU32(archive, archive.length - 22 + 16);
  const compressedSize = readU32(archive, centralOffset + 20);
  const payloadStart = 30 + readU16(archive, 26) + readU16(archive, 28);
  const patched = new Uint8Array(archive.length + 1);
  patched.set(archive.subarray(0, payloadStart + compressedSize), 0);
  patched.set(
    archive.subarray(payloadStart + compressedSize),
    payloadStart + compressedSize + 1,
  );
  writeU32(patched, 18, compressedSize + 1); // local compressed size
  writeU32(patched, centralOffset + 1 + 20, compressedSize + 1); // central
  writeU32(patched, patched.length - 22 + 16, centralOffset + 1); // cd offset
  expectInvalid(decodePreservingInput(patched));
});
