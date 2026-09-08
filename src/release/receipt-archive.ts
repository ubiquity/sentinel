/**
 * Bounded synchronous reader for the single-entry build receipt archive used
 * by the m05 deno release pipeline. The archive contains exactly one file,
 * `sentinel-build-receipt.json`, stored or deflated.
 *
 * Caller requirement: this module performs no authentication and no
 * integrity check. It must be called only after the trusted GitHub transport
 * has verified the archive's authenticated digest and exact size; the small
 * container framing checks here are not a substitute for that verification,
 * and no CRC is implemented.
 */

import { inflateRawSync } from "node:zlib";
import { portError, portOk, type PortResultV1 } from "../contracts/ports.ts";

const RECEIPT_NAME = "sentinel-build-receipt.json";

/** Hard input bound; larger archives are rejected before any framing read. */
const MAX_ARCHIVE_BYTES = 262144;
/** Hard decoded receipt bound; larger output is rejected immediately. */
const MAX_RECEIPT_BYTES = 8192;

/** ZIP64 size/offset sentinels; a real value of 0xffffffff means zip64. */
const ZIP64_SENTINEL = 0xffffffff;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;

const EOCD_FIXED_BYTES = 22;
const CENTRAL_FIXED_BYTES = 46;
const LOCAL_FIXED_BYTES = 30;

const ENCRYPTION_FLAG = 0x0001;
const DATA_DESCRIPTOR_FLAG = 0x0008;
/** Flag bits the framing relies on; local and central headers must agree. */
const RELEVANT_FLAGS = ENCRYPTION_FLAG | DATA_DESCRIPTOR_FLAG;

const STORED = 0;
const DEFLATED = 8;

/** Fixed-shape framing fields needed to locate and bound the entry payload. */
interface ArchiveFraming {
  payloadStart: number;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
}

function invalidBuildReceiptArchive(): PortResultV1<never> {
  return portError("invalid", "build receipt archive is invalid");
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

/** Exact UTF-8 read with fatal decoding; null when the bytes are invalid. */
function readExactUtf8(
  bytes: Uint8Array,
  offset: number,
  length: number,
): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(offset, offset + length),
    );
  } catch {
    return null;
  }
}

/**
 * Small fixed-shape container checks for this single-file upload artifact.
 * This is deliberately not a general ZIP implementation: one ordinary
 * single-disk archive, one central entry, one local entry at offset 0, no
 * comment, no ZIP64, no encryption, exact receipt name everywhere, and the
 * central directory must immediately follow the entry payload (a standard
 * optional data descriptor is allowed only with flag bit 3). Returns the
 * fields needed to decode the payload, or null when the framing is invalid.
 */
function parseArchiveFraming(bytes: Uint8Array): ArchiveFraming | null {
  const length = bytes.length;
  if (length < EOCD_FIXED_BYTES) return null;

  // End-of-central-directory: signature must be exactly the last 22 bytes.
  const eocdOffset = length - EOCD_FIXED_BYTES;
  if (readU32(bytes, eocdOffset) !== EOCD_SIGNATURE) return null;
  if (readU16(bytes, eocdOffset + 4) !== 0) return null; // this disk
  if (readU16(bytes, eocdOffset + 6) !== 0) return null; // cd start disk
  if (readU16(bytes, eocdOffset + 8) !== 1) return null; // entries on this disk
  if (readU16(bytes, eocdOffset + 10) !== 1) return null; // total entries
  const centralSize = readU32(bytes, eocdOffset + 12);
  const centralOffset = readU32(bytes, eocdOffset + 16);
  if (readU16(bytes, eocdOffset + 20) !== 0) return null; // no comment
  if (
    centralSize === ZIP64_SENTINEL || centralOffset === ZIP64_SENTINEL
  ) {
    return null;
  }
  if (centralOffset + centralSize !== eocdOffset) return null;
  if (centralSize < CENTRAL_FIXED_BYTES) return null;

  // Central directory: exactly one entry whose recorded length fills the
  // whole central directory.
  const central = centralOffset;
  if (readU32(bytes, central) !== CENTRAL_SIGNATURE) return null;
  const centralFlags = readU16(bytes, central + 8);
  if ((centralFlags & ENCRYPTION_FLAG) !== 0) return null;
  const method = readU16(bytes, central + 10);
  if (method !== STORED && method !== DEFLATED) return null;
  const compressedSize = readU32(bytes, central + 20);
  const uncompressedSize = readU32(bytes, central + 24);
  if (
    compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL
  ) {
    return null;
  }
  if (uncompressedSize > MAX_RECEIPT_BYTES) return null;
  const nameLength = readU16(bytes, central + 28);
  const extraLength = readU16(bytes, central + 30);
  const commentLength = readU16(bytes, central + 32);
  if (readU16(bytes, central + 34) !== 0) return null; // disk number start
  if (readU32(bytes, central + 42) !== 0) return null; // local header offset
  if (
    CENTRAL_FIXED_BYTES + nameLength + extraLength + commentLength !==
      centralSize
  ) {
    return null;
  }
  if (
    readExactUtf8(bytes, central + CENTRAL_FIXED_BYTES, nameLength) !==
      RECEIPT_NAME
  ) {
    return null;
  }

  // Local header must be at offset 0 and match the central entry.
  if (length < LOCAL_FIXED_BYTES) return null;
  if (readU32(bytes, 0) !== LOCAL_SIGNATURE) return null;
  const localFlags = readU16(bytes, 6);
  if ((localFlags & ENCRYPTION_FLAG) !== 0) return null;
  if (
    (localFlags & RELEVANT_FLAGS) !== (centralFlags & RELEVANT_FLAGS)
  ) {
    return null;
  }
  if (readU16(bytes, 8) !== method) return null;
  const localCompressedSize = readU32(bytes, 18);
  const localUncompressedSize = readU32(bytes, 22);
  if (
    localCompressedSize === ZIP64_SENTINEL ||
    localUncompressedSize === ZIP64_SENTINEL
  ) {
    return null;
  }
  const localNameLength = readU16(bytes, 26);
  const localExtraLength = readU16(bytes, 28);
  const payloadStart = LOCAL_FIXED_BYTES + localNameLength + localExtraLength;
  if (payloadStart > length) return null;
  if (
    readExactUtf8(bytes, LOCAL_FIXED_BYTES, localNameLength) !==
      RECEIPT_NAME
  ) {
    return null;
  }
  if (method === STORED && compressedSize !== uncompressedSize) return null;
  const hasDataDescriptor = (localFlags & DATA_DESCRIPTOR_FLAG) !== 0;
  const payloadEnd = payloadStart + compressedSize;
  if (payloadEnd > centralOffset) return null;
  if (!hasDataDescriptor) {
    if (
      localCompressedSize !== compressedSize ||
      localUncompressedSize !== uncompressedSize
    ) {
      return null;
    }
  }
  // Between payload end and the central directory only a standard optional
  // data descriptor may appear (with or without its signature), and only
  // when flag bit 3 is set. Its compressed/uncompressed sizes must match the
  // central directory; the CRC is not verified (the authenticated digest
  // remains the caller's duty).
  const gap = centralOffset - payloadEnd;
  if (gap !== 0) {
    if (!hasDataDescriptor) return null;
    let descriptorCompressed: number;
    let descriptorUncompressed: number;
    if (gap === 16) {
      if (readU32(bytes, payloadEnd) !== DATA_DESCRIPTOR_SIGNATURE) {
        return null;
      }
      descriptorCompressed = readU32(bytes, payloadEnd + 8);
      descriptorUncompressed = readU32(bytes, payloadEnd + 12);
    } else if (gap === 12) {
      descriptorCompressed = readU32(bytes, payloadEnd + 4);
      descriptorUncompressed = readU32(bytes, payloadEnd + 8);
    } else {
      return null;
    }
    if (
      descriptorCompressed !== compressedSize ||
      descriptorUncompressed !== uncompressedSize
    ) {
      return null;
    }
  }
  return { payloadStart, compressedSize, uncompressedSize, method };
}

/**
 * Decode the single-entry build receipt archive into its exact receipt
 * object. Pure and synchronous: no filesystem, network, environment,
 * subprocess or authentication is touched and the input bytes are never
 * modified. Every malformed, unsupported or oversize input returns
 * `portError("invalid", "build receipt archive is invalid")`.
 */
export function decodeBuildReceiptArchive(
  bytes: Uint8Array,
): PortResultV1<unknown> {
  if (bytes.length === 0 || bytes.length > MAX_ARCHIVE_BYTES) {
    return invalidBuildReceiptArchive();
  }
  const framing = parseArchiveFraming(bytes);
  if (framing === null) return invalidBuildReceiptArchive();

  const payload = bytes.subarray(
    framing.payloadStart,
    framing.payloadStart + framing.compressedSize,
  );
  let output: Uint8Array;
  if (framing.method === STORED) {
    output = payload;
  } else {
    let decoded: { buffer: Uint8Array; engine: { bytesWritten: number } };
    try {
      // Runtime shape verified: info reports the input bytes the deflate
      // stream consumed; maxOutputLength makes an oversized decode throw.
      decoded = inflateRawSync(payload, {
        maxOutputLength: MAX_RECEIPT_BYTES,
        info: true,
      } as never) as unknown as {
        buffer: Uint8Array;
        engine: { bytesWritten: number };
      };
    } catch {
      return invalidBuildReceiptArchive();
    }
    if (decoded.engine.bytesWritten !== framing.compressedSize) {
      return invalidBuildReceiptArchive();
    }
    output = decoded.buffer;
  }
  if (output.length !== framing.uncompressedSize) {
    return invalidBuildReceiptArchive();
  }
  if (output.length > MAX_RECEIPT_BYTES) {
    return invalidBuildReceiptArchive();
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    return invalidBuildReceiptArchive();
  }
  try {
    return portOk(JSON.parse(text) as unknown);
  } catch {
    return invalidBuildReceiptArchive();
  }
}
