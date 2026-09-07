/**
 * Test-only helpers for the gateway adapter module (m02-evidence).
 *
 * These helpers hold no product logic: the recording transport only records
 * calls and returns scripted canned responses; builders produce the exact
 * frozen producer wire shapes (docs/contracts.md §11). Synthetic fixtures
 * only — no private capture data.
 */

import assert from "node:assert/strict";

import type { Clock } from "../../../src/contracts/ports.ts";
import type {
  RepositoryConfigV1,
} from "../../../src/contracts/repository-config.ts";
import { parseRepositoryConfigV1 } from "../../../src/contracts/repository-config.ts";
import type { GatewayTransportV1 } from "../../../src/adapters/gateway/http.ts";

export const REPOSITORY = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 12345,
} as const;

export const INCIDENT_A = "provider-00000000-0000-4000-8000-000000000001";
export const INCIDENT_B = "provider-00000000-0000-4000-8000-000000000002";
export const CAPTURE_ID_A = "0c0ffee0-1234-4abc-8def-000000000001";
export const CAPTURE_ID_B = "0c0ffee0-1234-4abc-8def-000000000002";

export const T0 = 1_700_000_000_000;
export const SOURCE_TTL_MS = 48 * 60 * 60 * 1_000;

/** Same provider-UUID shape as the producer; only never-colliding constants. */
export const FINGERPRINT_A = "a".repeat(64);
export const FINGERPRINT_B = "b".repeat(64);

export class FakeClock implements Clock {
  private current: number;
  constructor(start: number) {
    this.current = start;
  }
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export interface RecordedRequestV1 {
  url: string;
  method: string;
  headers: Headers;
  /** Exact `RequestInit.redirect`; null when the caller did not set it. */
  redirect: "follow" | "error" | "manual" | null;
  /** Abort signal passed to the transport; null when none was supplied. */
  signal: AbortSignal | null;
}

export interface RecordingTransportV1 extends GatewayTransportV1 {
  readonly requests: RecordedRequestV1[];
  /** Every request must be a GET against one of the listed read paths. */
  assertReadOnly(allowPaths: readonly string[]): void;
  /** No hidden claim/ack/defer endpoint may ever be invoked. */
  assertNoWriteEndpoints(): void;
}

/**
 * Native-Fetch-compatible recording transport. The responder receives the
 * request URL and returns the canned Response; every call is recorded.
 */
export function recordingTransport(
  responder: (url: URL) => Response | Promise<Response>,
): RecordingTransportV1 {
  const requests: RecordedRequestV1[] = [];
  const transport: RecordingTransportV1 = Object.assign(
    async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      const headers = new Headers(init?.headers);
      requests.push({
        url,
        method: init?.method ?? "GET",
        headers,
        redirect: init?.redirect ?? null,
        signal: init?.signal ?? null,
      });
      return await responder(new URL(url));
    },
    {
      requests,
      assertReadOnly(allowPaths: readonly string[]): void {
        for (const request of requests) {
          assert.equal(
            request.method,
            "GET",
            `expected GET, got ${request.method}`,
          );
          const path = new URL(request.url).pathname;
          assert.ok(
            allowPaths.includes(path),
            `unexpected outbound path: ${path}`,
          );
        }
      },
      assertNoWriteEndpoints(): void {
        for (const request of requests) {
          const path = new URL(request.url).pathname;
          assert.ok(
            !/\/claim|\/ack|\/defer/.test(path),
            `hidden write endpoint invoked: ${path}`,
          );
        }
      },
    },
  );
  return transport;
}

export function jsonResponse(
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Producer `utils.ts` base64url encoding (unpadded URL-safe base64). */
export function b64Url(bytes: Uint8Array): string {
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

/** Deterministic synthetic ciphertext bytes (never real payloads). */
export function syntheticBytes(
  length: number,
  seed: number,
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = (index * 31 + seed * 17) & 0xff;
  }
  return bytes;
}

export async function sha256hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return new Uint8Array(digest).reduce(
    (hex, byte) => hex + byte.toString(16).padStart(2, "0"),
    "",
  );
}

/** Producer manifest builder (exact frozen wire shape). */
export function makeManifest(
  overrides: Partial<{
    version: number;
    capture_id: string;
    fingerprint: string;
    case_group_digest: string;
    captured_at_ms: number;
    expires_at_ms: number;
    algorithm: string;
    compression: string;
    iv: string;
    chunk_count: number;
    ciphertext_bytes: number;
  }> = {},
): Record<string, unknown> {
  const capturedAt = overrides.captured_at_ms ?? T0;
  const ciphertextBytes = overrides.ciphertext_bytes ?? 64;
  const chunkCount = overrides.chunk_count ?? 1;
  return {
    version: 1,
    capture_id: CAPTURE_ID_A,
    fingerprint: FINGERPRINT_A,
    case_group_digest: "c".repeat(64),
    captured_at_ms: capturedAt,
    expires_at_ms: capturedAt + SOURCE_TTL_MS,
    algorithm: "AES-256-GCM",
    compression: "gzip",
    iv: b64Url(new Uint8Array(12).fill(7)),
    chunk_count: chunkCount,
    ciphertext_bytes: ciphertextBytes,
    ...overrides,
  };
}

/**
 * Exact producer chunk grid: every non-final chunk is 48 KiB; the final chunk
 * is the exact remainder of `ciphertext_bytes`.
 */
export function chunkBytes(
  ciphertextBytes: number,
  index: number,
  chunkCount: number,
): number {
  return index < chunkCount - 1
    ? 48 * 1_024
    : ciphertextBytes - (chunkCount - 1) * 48 * 1_024;
}

export function makeCapture(
  ciphertext: Uint8Array,
  overrides: Partial<Record<string, unknown>> = {},
): { manifest: Record<string, unknown>; chunks: string[] } {
  const chunkSize = 48 * 1_024;
  const chunks: string[] = [];
  for (let offset = 0; offset < ciphertext.byteLength; offset += chunkSize) {
    chunks.push(b64Url(ciphertext.subarray(offset, offset + chunkSize)));
  }
  const manifest = makeManifest({
    ...overrides,
    ciphertext_bytes: ciphertext.byteLength,
    chunk_count: chunks.length,
  });
  return { manifest, chunks };
}

/** Wire replay page: `{ data: [{ manifest, chunks }], cursor }`. */
export function makeReplayPage(
  capture: { manifest: Record<string, unknown>; chunks: string[] },
  cursor: string | null = null,
): Record<string, unknown> {
  return { data: [capture], cursor };
}

/** Wire index row (exact frozen snake_case keys). */
export function makeIndexRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    incident_id: INCIDENT_A,
    fingerprint: FINGERPRINT_A,
    severity: "P1",
    first_seen_at_ms: T0,
    last_seen_at_ms: T0 + 3_000,
    count: 7,
    failing_revision: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    error_type: "GatewayError",
    context: {
      message: "upstream terminated without completion",
      location: "src/handler.ts:104",
      sample: ["upstream terminated without completion"],
    },
    provenance: {
      endpoint: "https://ai.ubq.fi",
      captured_at_ms: T0,
      captured_by: "gateway",
    },
    evidence_ref: null,
    evidence_expires_at_ms: null,
    ...overrides,
  };
}

export function makeIndexPage(
  rows: Record<string, unknown>[],
  cursor: string | null = null,
  coverage: Record<string, unknown> = { status: "complete" },
): Record<string, unknown> {
  return { data: rows, cursor, coverage };
}

export function validConfig(): RepositoryConfigV1 {
  const raw = JSON.parse(
    Deno.readTextFileSync(
      new URL(
        "../../fixtures/contracts/valid/repository-config-v1.json",
        import.meta.url,
      ),
    ),
  );
  return parseRepositoryConfigV1(raw);
}
