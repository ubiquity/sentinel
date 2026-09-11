/**
 * Sanitized fixture bundle machinery (m03-owned).
 *
 * A replay fixture bundle is a set of trusted files at fixed safe relative
 * paths inside the checked-out repository — the sanitized regression test
 * plus the recorded upstream data it replays. The resolver is injected and
 * trusted: it supplies the fixed relative entry paths, the test identity the
 * bundle exercises and the expected before-failure signature taken from the
 * trusted replay policy. The port never accepts a fixture, a path, an argv
 * or a matcher from the model/request; request values only bind the
 * `fixtureRef` + `fixtureDigest` to what the trusted resolver returns.
 *
 * Integrity: the digest is computed over the ACTUAL bundle bytes with
 * `computeReplayFixtureDigest` and must equal the request digest before any
 * command runs. Output digests and the bundle digest are SHA-256 values and
 * are never interchangeable with Git SHAs (separate contract brands).
 *
 * Safety: entries must be relative, dot-segment-free, control-character-free
 * paths inside the bundle scopes, outside the configured protected paths,
 * free of symlink ancestors at materialization time, text content without
 * secret-shaped material, and within the explicit byte bounds. These are
 * deterministic NEGATIVE checks; they are not proof of general semantic
 * sanitization. The positive statement is the trusted provenance attestation:
 * a bundle without `sanitized: true` and a deterministic provenance ref is
 * refused before any target-controlled command runs. A bundle attested as a
 * redaction of the original carries the `fixture_redacted` limitation.
 */

import { asFixtureDigest } from "../contracts/brands.ts";
import type { FixtureDigest } from "../contracts/brands.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import type { GatewayCausalProofV1 } from "./causal-proof.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One bundle file at a fixed safe root-relative path. Never a symlink. */
export interface ReplayFixtureEntryV1 {
  path: string;
  bytes: Uint8Array;
}

/**
 * Trusted sanitization/provenance attestation. `sanitized: true` is required
 * before any target-controlled command runs; `redacted: true` records that
 * the original material was redacted (limitation `fixture_redacted`).
 */
export interface FixtureProvenanceV1 {
  sanitized: boolean;
  /** Identity of the trusted sanitization source. */
  sanitizer: string;
  /** Deterministic restricted reference to the provenance record. */
  provenanceRef: string;
  /** True when the trusted sanitizer redacted/limited the original material. */
  redacted: boolean;
  /** Bounded human-readable note (kept out of raw payloads). */
  note: string;
}

/** Expected before-failure signature from the trusted replay policy. */
export type ExpectedFailureMatchV1 =
  | { kind: "contains"; text: string }
  | { kind: "regex"; source: string };

export interface ExpectedFailureV1 {
  /** Human description of the intended before-failure reason. */
  reason: string;
  /** Deterministic matcher applied to the bounded command output. */
  match: ExpectedFailureMatchV1;
}

export interface ResolvedFixtureV1 {
  /** Trusted test identity attested by the resolver/policy. */
  testIds: string[];
  /** Trusted before-failure signature. */
  expectedFailure: ExpectedFailureV1;
  /** Entries at fixed safe relative paths (never symlinks). */
  entries: ReplayFixtureEntryV1[];
  /** Trusted sanitization/provenance attestation. */
  provenance: FixtureProvenanceV1;
  /**
   * Optional trusted causal proof attached by the trusted fixture
   * composition. Structural sanitization stays separate from causal
   * verification: a redacted fixture keeps `redacted: true`, and the replay
   * consuming boundary may suppress `fixture_redacted` ONLY when this proof
   * re-validates against the resolved fixture, the actual bundle digest and
   * the request/config identities.
   */
  causalProof?: GatewayCausalProofV1;
}

export interface FixtureResolverV1 {
  resolveFixture(ref: string): Promise<PortResultV1<ResolvedFixtureV1>>;
}

/** Test-execution proof extracted from the bounded command output. */
export interface ReplayProofV1 {
  /** True when at least one test identity was observed in the output. */
  parsed: boolean;
  /** Observed test identities in first-observed order. */
  testIds: string[];
}

/**
 * Trusted proof parser for the configured command protocol. Production was
 * built for Deno test runs, so the concrete exported parser reads the
 * `sentinel-replay-test:<id>` marker lines that each bundled test prints from
 * inside its body (the marker is a fixed protocol the trusted bundle
 * follows, not a request-supplied executable or shell command).
 */
export interface ReplayProofParserV1 {
  parse(output: string): ReplayProofV1;
}

export function markerProofParser(): ReplayProofParserV1 {
  const marker = /^sentinel-replay-test:([A-Za-z0-9._:-]{1,64})$/;
  return {
    parse(output: string): ReplayProofV1 {
      const testIds: string[] = [];
      const seen = new Set<string>();
      for (const line of output.split("\n")) {
        const match = marker.exec(line.trimEnd());
        if (match === null) continue;
        const id = match[1];
        if (!seen.has(id)) {
          seen.add(id);
          testIds.push(id);
        }
      }
      return { parsed: testIds.length > 0, testIds };
    },
  };
}

/** Trusted bundle policy: allowed write scope, byte bounds, proof parser. */
export interface ReplayPolicyV1 {
  /** Root-relative entry scopes, each with a trailing slash (e.g. "tests/"). */
  bundleScopes: string[];
  /** Maximum total bundle bytes (sum of entries). */
  maxFixtureBytes: number;
  /** Maximum bytes of one entry. */
  maxEntryBytes: number;
  /** Proof parser for the configured command protocol. */
  proof: ReplayProofParserV1;
}

export interface BundleCheckOk {
  ok: true;
}
export interface BundleCheckFail {
  ok: false;
  reason: string;
}
export type BundleCheckV1 = BundleCheckOk | BundleCheckFail;

// ---------------------------------------------------------------------------
// Deterministic bundle digest
// ---------------------------------------------------------------------------

/**
 * SHA-256 over the canonical concatenation of the bundle: entries sorted by
 * path, each encoded as `<path>\n<byteLength>\n` followed by the raw bytes.
 * The length prefix removes any ambiguity between entries. The digest is a
 * FixtureDigest brand and is never a Git SHA.
 */
export async function computeReplayFixtureDigest(
  entries: readonly ReplayFixtureEntryV1[],
): Promise<FixtureDigest> {
  const sorted = [...entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const entry of sorted) {
    const head = new TextEncoder().encode(
      `${entry.path}\n${entry.bytes.byteLength}\n`,
    );
    parts.push(head, entry.bytes);
    total += head.byteLength + entry.bytes.byteLength;
  }
  const concatenated = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    concatenated.set(part, offset);
    offset += part.byteLength;
  }
  const digest = await crypto.subtle.digest("SHA-256", concatenated);
  return asFixtureDigest(
    Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  );
}

// ---------------------------------------------------------------------------
// Deterministic negative checks
// ---------------------------------------------------------------------------

const PATH_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX_PATH_BYTES = 512;
const MAX_BUNDLE_ENTRIES = 256;
const MAX_TEST_IDS = 64;
const MAX_TEST_ID_BYTES = 128;
const MAX_SCOPE_BYTES = 128;

/**
 * Fixed safe root-relative path: ASCII letter/digit leading segments without
 * `.`/`..`, absolute prefixes, backslashes, empty segments or control chars.
 */
export function isSafeBundlePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_BYTES) return false;
  if (path.startsWith("/")) return false;
  if (path.includes("\\")) return false;
  for (const ch of path) {
    const code = ch.codePointAt(0);
    if (code !== undefined && (code < 0x20 || code === 0x7f)) return false;
  }
  return path.split("/").every((segment) => PATH_SEGMENT_RE.test(segment));
}

/**
 * Deterministic secret-shape negative scan over the UTF-8 text of an entry
 * (entries must be text). This is a negative heuristic only; the positive
 * sanitization statement is the provenance attestation. Raw originals are
 * never logged or passed anywhere else by the port.
 */
export function containsSecretShapedText(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return true;
  }
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (
      code !== undefined && code < 0x20 && ch !== "\t" && ch !== "\n" &&
      ch !== "\r"
    ) {
      return true;
    }
  }
  const patterns = [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
    /-----BEGIN OPENSSH PRIVATE KEY-----/i,
    /gh[pousr]_[A-Za-z0-9_]{20,}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /xox[baprs]-[A-Za-z0-9-]{10,}/,
    /AKIA[0-9A-Z]{16}/,
    /sk-[A-Za-z0-9_-]{20,}/,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Full fail-closed bundle validation: attestation, path safety, scopes,
 * protected-path overlap, byte bounds, duplicates, test identity and the
 * expected-failure matcher. Returns a bounded reason for the port error.
 */
export function checkResolvedFixture(
  resolved: ResolvedFixtureV1,
  policy: ReplayPolicyV1,
  protectedPaths: readonly string[],
): BundleCheckV1 {
  if (resolved.provenance === null || resolved.provenance.sanitized !== true) {
    return {
      ok: false,
      reason: "fixture bundle lacks a trusted sanitization attestation",
    };
  }
  for (const scope of policy.bundleScopes) {
    if (!isSafeBundlePath(scope.slice(0, -1) + "x")) {
      return { ok: false, reason: "invalid bundle scope in trusted policy" };
    }
    if (scope.length > MAX_SCOPE_BYTES) {
      return { ok: false, reason: "bundle scope exceeds the byte bound" };
    }
  }
  if (resolved.testIds.length === 0 || resolved.testIds.length > MAX_TEST_IDS) {
    return { ok: false, reason: "fixture test identity is empty or too large" };
  }
  const seenTestIds = new Set<string>();
  for (const id of resolved.testIds) {
    if (id.length === 0 || id.length > MAX_TEST_ID_BYTES) {
      return { ok: false, reason: "fixture test id exceeds the byte bound" };
    }
    if (seenTestIds.has(id)) {
      return { ok: false, reason: "duplicate fixture test id" };
    }
    seenTestIds.add(id);
  }
  const expected = resolved.expectedFailure;
  if (
    expected === null || typeof expected.reason !== "string" ||
    expected.reason.length === 0 || expected.reason.length > 512 ||
    /[\r\n\t]/.test(expected.reason)
  ) {
    return { ok: false, reason: "invalid expected-failure reason" };
  }
  if (expected.match.kind === "contains") {
    if (
      typeof expected.match.text !== "string" ||
      expected.match.text.length === 0 || expected.match.text.length > 512
    ) {
      return { ok: false, reason: "invalid expected-failure matcher text" };
    }
  } else if (expected.match.kind === "regex") {
    if (
      typeof expected.match.source !== "string" ||
      expected.match.source.length === 0 ||
      expected.match.source.length > 256
    ) {
      return { ok: false, reason: "invalid expected-failure matcher regex" };
    }
    try {
      new RegExp(expected.match.source, "m");
    } catch {
      return { ok: false, reason: "expected-failure matcher regex is invalid" };
    }
  } else {
    return { ok: false, reason: "invalid expected-failure matcher kind" };
  }
  if (
    resolved.entries.length === 0 ||
    resolved.entries.length > MAX_BUNDLE_ENTRIES
  ) {
    return { ok: false, reason: "fixture bundle has no entries or too many" };
  }
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  for (const entry of resolved.entries) {
    if (!isSafeBundlePath(entry.path)) {
      return { ok: false, reason: `unsafe fixture entry path: ${entry.path}` };
    }
    if (seenPaths.has(entry.path)) {
      return { ok: false, reason: "duplicate fixture entry path" };
    }
    seenPaths.add(entry.path);
    if (!pathInScopes(entry.path, policy.bundleScopes)) {
      return {
        ok: false,
        reason: "fixture entry outside trusted bundle scope",
      };
    }
    if (pathUnderProtected(entry.path, protectedPaths)) {
      return { ok: false, reason: "fixture entry targets a protected path" };
    }
    if (entry.bytes.byteLength > policy.maxEntryBytes) {
      return { ok: false, reason: "fixture entry exceeds the byte bound" };
    }
    if (containsSecretShapedText(entry.bytes)) {
      return { ok: false, reason: "fixture entry contains secret-shaped text" };
    }
    totalBytes += entry.bytes.byteLength;
  }
  if (totalBytes > policy.maxFixtureBytes) {
    return { ok: false, reason: "fixture bundle exceeds the byte bound" };
  }
  return { ok: true };
}

function pathInScopes(path: string, scopes: readonly string[]): boolean {
  return scopes.some((scope) =>
    path.startsWith(scope) && path.length > scope.length
  );
}

function pathUnderProtected(
  path: string,
  protectedPaths: readonly string[],
): boolean {
  return protectedPaths.some((protectedPath) => {
    const prefix = protectedPath.endsWith("/")
      ? protectedPath
      : `${protectedPath}/`;
    return path === protectedPath || path.startsWith(prefix);
  });
}
