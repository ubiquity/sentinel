/**
 * Concrete local restricted artifact store used by the gateway incident
 * adapter for deterministic evidence retention.
 *
 * Properties enforced here:
 *
 * - Constructor-supplied `root` plus explicit total/per-artifact/age bounds.
 *   No process-environment lookup, no external credentials.
 * - Every entry is a ciphertext blob plus canonical metadata on disk; the
 *   AES-GCM/gzip producer manifest is preserved privately for later trusted
 *   decryption. No plaintext and no key material ever reaches the store.
 * - Exact deterministic path mapping: `entries/<sha256(ref)>.json` (metadata)
 *   and `entries/<sha256(ref)>.bin` (ciphertext). A ref can never traverse;
 *   symlinks are rejected at every level (root, directory, files).
 * - Writes are atomic (temp file + rename) with owner-only permissions
 *   (0o700 directories, 0o600 files).
 * - A ref is immutable in the strongest sense: same ref + different bytes is
 *   a `conflict`; same ref + same digest is an idempotent no-op.
 * - Total-capacity exhaustion is a `full` error: active evidence is never
 *   deleted to make room.
 * - Expiry is explicit: each entry stores `sourceExpiresAt` (the producer
 *   manifest expiry) and `expiresAt` (the accepted local retention bound,
 *   `retainedAt + retentionMaxAgeMs`). An entry past `expiresAt` is purged on
 *   access and reads as absent (`null`), never served beyond its bound.
 * - Metadata is persisted so a restarted store instance observes the same
 *   retained evidence; totals are re-derived from disk at construction.
 */

import { asEncryptedArtifactDigest } from "../../contracts/brands.ts";
import type { EncryptedArtifactDigest } from "../../contracts/brands.ts";
import { canonicalStringify } from "../../contracts/canonical.ts";
import {
  GATEWAY_INCIDENT_ID,
  type GatewayReplayManifestV1,
  parseGatewayReplayManifestV1,
  replayManifestToWire,
} from "./wire.ts";

export interface ArtifactStoreLimitsV1 {
  /** Total ciphertext byte bound across every retained artifact. */
  totalMaxBytes: number;
  /** Maximum ciphertext bytes of one retained artifact. */
  artifactMaxBytes: number;
  /** Accepted local retention window; entries expire at retain + this. */
  retentionMaxAgeMs: number;
}

export type ArtifactStoreErrorV1 =
  | { kind: "invalid"; detail: string }
  | { kind: "conflict"; detail: string }
  | { kind: "full"; detail: string }
  | { kind: "corrupt"; detail: string }
  | { kind: "unavailable"; detail: string };

export type ArtifactStoreResultV1<T> =
  | { ok: true; value: T }
  | { ok: false; error: ArtifactStoreErrorV1 };

export interface ArtifactStorePutV1 {
  /** Exact deterministic restricted ref naming incident + capture identity. */
  ref: string;
  /** SHA-256 of `ciphertext`; verified by the store, never trusted blindly. */
  digest: string;
  /** Raw concatenated encrypted chunk bytes (never plaintext). */
  ciphertext: Uint8Array<ArrayBuffer>;
  incidentId: string;
  captureId: string;
  /** Producer manifest HMAC identity (never the ciphertext digest). */
  fingerprint: string;
  caseGroupDigest: string | null;
  sourceCapturedAt: number;
  /** Producer manifest `expires_at_ms` — source expiry, never extended. */
  sourceExpiresAt: number;
  contentType: string;
  /** Exact producer manifest; preserved for later trusted decryption. */
  manifest: GatewayReplayManifestV1;
}

export interface StoredArtifactV1 {
  ref: string;
  digest: EncryptedArtifactDigest;
  sizeBytes: number;
  /** Accepted local retention expiry (`retainedAt + retentionMaxAgeMs`). */
  expiresAt: number;
  retainedAt: number;
  sourceExpiresAt: number;
  sourceCapturedAt: number;
  incidentId: string;
  captureId: string;
  fingerprint: string;
  caseGroupDigest: string | null;
  contentType: string;
  ciphertext: Uint8Array<ArrayBuffer>;
  manifest: GatewayReplayManifestV1;
}

export interface ArtifactStoreV1 {
  readonly limits: ArtifactStoreLimitsV1;
  put(
    input: ArtifactStorePutV1,
    nowMs: number,
  ): Promise<ArtifactStoreResultV1<StoredArtifactV1>>;
  /** Absent/expired after purge -> null; corruption and I/O are typed errors. */
  get(
    ref: string,
    nowMs: number,
  ): Promise<ArtifactStoreResultV1<StoredArtifactV1 | null>>;
  listByIncident(
    incidentId: string,
    nowMs: number,
  ): Promise<ArtifactStoreResultV1<StoredArtifactV1[]>>;
  /** Current retained ciphertext bytes and artifact count. */
  stats(): Promise<
    ArtifactStoreResultV1<{ totalBytes: number; count: number }>
  >;
}

/** Never an artifact on its own; refs are frozen storage pointers. */
const METADATA_VERSION = "v1";
const METADATA_KIND = "artifact_entry";
const ARTIFACT_REF_AUTHORITY = /^[A-Za-z0-9_.-]+$/;
const CAPTURE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const UNSAFE_SEGMENT = /(^|\/)\.{1,2}(\/|$)/;

/** Parse the frozen `artifact://<namespace>/<incident_id>/<capture_id>` ref. */
export function parseArtifactRefIdentity(
  ref: string,
): { namespace: string; incidentId: string; captureId: string } | null {
  if (UNSAFE_SEGMENT.test(ref)) return null;
  if (!ref.startsWith("artifact://")) return null;
  const rest = ref.slice("artifact://".length);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  const authority = rest.slice(0, slash);
  const segments = rest.slice(slash + 1).split("/");
  if (!ARTIFACT_REF_AUTHORITY.test(authority)) return null;
  if (segments.length !== 2) return null;
  const [incidentId, captureId] = segments;
  if (
    incidentId === undefined || captureId === undefined ||
    !GATEWAY_INCIDENT_ID.test(incidentId) || !CAPTURE_ID.test(captureId)
  ) {
    return null;
  }
  return { namespace: authority, incidentId, captureId };
}

interface MetadataRecordV1 {
  version: "v1";
  kind: "artifact_entry";
  ref: string;
  digest: string;
  sizeBytes: number;
  contentType: string;
  incidentId: string;
  captureId: string;
  fingerprint: string;
  caseGroupDigest: string | null;
  sourceCapturedAt: number;
  sourceExpiresAt: number;
  retainedAt: number;
  expiresAt: number;
  /** Exact producer wire manifest (snake_case); validated on every read. */
  manifest: Record<string, unknown>;
}

const METADATA_KEYS = [
  "version",
  "kind",
  "ref",
  "digest",
  "sizeBytes",
  "contentType",
  "incidentId",
  "captureId",
  "fingerprint",
  "caseGroupDigest",
  "sourceCapturedAt",
  "sourceExpiresAt",
  "retainedAt",
  "expiresAt",
  "manifest",
] as const;

function parseMetadataRecord(
  value: unknown,
  refHint: string,
): MetadataRecordV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ArtifactStoreFailure(
      "invalid",
      "entry metadata is not an object",
    );
  }
  const obj = value as Record<string, unknown>;
  const known = new Set<string>(METADATA_KEYS);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      throw new ArtifactStoreFailure(
        "corrupt",
        "entry metadata has an unknown key",
      );
    }
  }
  for (const key of METADATA_KEYS) {
    if (!Object.hasOwn(obj, key)) {
      throw new ArtifactStoreFailure(
        "corrupt",
        "entry metadata is missing a key",
      );
    }
  }
  if (obj.version !== METADATA_VERSION || obj.kind !== METADATA_KIND) {
    throw new ArtifactStoreFailure(
      "corrupt",
      "entry metadata version mismatch",
    );
  }
  const ref = expectText(obj.ref, "ref");
  if (refHint.length > 0 && ref !== refHint) {
    throw new ArtifactStoreFailure("corrupt", "entry metadata ref mismatch");
  }
  const digest = expectText(obj.digest, "digest");
  if (!SHA256_HEX.test(digest)) {
    throw new ArtifactStoreFailure(
      "corrupt",
      "entry metadata digest is invalid",
    );
  }
  const sizeBytes = expectSafeInt(obj.sizeBytes, "sizeBytes");
  const incidentId = expectText(obj.incidentId, "incidentId");
  const captureId = expectText(obj.captureId, "captureId");
  const identity = parseArtifactRefIdentity(ref);
  if (
    identity === null || identity.incidentId !== incidentId ||
    identity.captureId !== captureId
  ) {
    throw new ArtifactStoreFailure("corrupt", "entry ref identity mismatch");
  }
  const fingerprint = expectText(obj.fingerprint, "fingerprint");
  if (!SHA256_HEX.test(fingerprint)) {
    throw new ArtifactStoreFailure("corrupt", "entry fingerprint is invalid");
  }
  let caseGroupDigest: string | null = null;
  if (obj.caseGroupDigest !== null) {
    caseGroupDigest = expectText(obj.caseGroupDigest, "caseGroupDigest");
    if (!SHA256_HEX.test(caseGroupDigest)) {
      throw new ArtifactStoreFailure(
        "corrupt",
        "entry case group digest is invalid",
      );
    }
  }
  const sourceCapturedAt = expectSafeInt(
    obj.sourceCapturedAt,
    "sourceCapturedAt",
  );
  const sourceExpiresAt = expectSafeInt(obj.sourceExpiresAt, "sourceExpiresAt");
  const retainedAt = expectSafeInt(obj.retainedAt, "retainedAt");
  const expiresAt = expectSafeInt(obj.expiresAt, "expiresAt");
  const contentType = expectText(obj.contentType, "contentType");
  if (
    sourceExpiresAt <= sourceCapturedAt || expiresAt <= retainedAt ||
    sizeBytes < 1
  ) {
    throw new ArtifactStoreFailure("corrupt", "entry lifecycle is invalid");
  }
  // Re-validate the preserved producer manifest with the strict wire parser.
  parseGatewayReplayManifestV1(obj.manifest);
  const manifestValue = obj.manifest;
  if (
    manifestValue === null || typeof manifestValue !== "object" ||
    Array.isArray(manifestValue)
  ) {
    throw new ArtifactStoreFailure("corrupt", "entry manifest is invalid");
  }
  return {
    version: METADATA_VERSION,
    kind: METADATA_KIND,
    ref,
    digest,
    sizeBytes,
    contentType,
    incidentId,
    captureId,
    fingerprint,
    caseGroupDigest,
    sourceCapturedAt,
    sourceExpiresAt,
    retainedAt,
    expiresAt,
    manifest: manifestValue as Record<string, unknown>,
  };
}

function expectText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ArtifactStoreFailure("corrupt", `entry ${field} is invalid`);
  }
  return value;
}

function expectSafeInt(value: unknown, field: string): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
  ) {
    throw new ArtifactStoreFailure("corrupt", `entry ${field} is invalid`);
  }
  return value;
}

export class ArtifactStoreFailure extends Error {
  readonly kind: ArtifactStoreErrorV1["kind"];

  constructor(kind: ArtifactStoreErrorV1["kind"], detail: string) {
    super(detail);
    this.name = "ArtifactStoreFailure";
    this.kind = kind;
  }
}

function failStore(
  kind: ArtifactStoreErrorV1["kind"],
  detail: string,
): ArtifactStoreResultV1<never> {
  return { ok: false, error: { kind, detail } };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return new Uint8Array(digest).reduce(
    (hex, byte) => hex + byte.toString(16).padStart(2, "0"),
    "",
  );
}

export class LocalArtifactStore implements ArtifactStoreV1 {
  readonly limits: ArtifactStoreLimitsV1;
  private readonly root: string;
  private readonly entriesDir: string;
  private usedBytes = 0;

  constructor(options: {
    root: string;
    limits: ArtifactStoreLimitsV1;
  }) {
    const { root, limits } = options;
    validateLimits(limits);
    this.limits = limits;
    this.root = root;
    this.entriesDir = `${root}/entries`;
  }

  /** Creates/verifies the layout and re-derives the byte total from disk. */
  async open(): Promise<ArtifactStoreResultV1<void>> {
    try {
      await ensureRealDirectory(this.root, 0o700);
      await ensureRealDirectory(this.entriesDir, 0o700);
      // Restrictive permissions are enforced on existing trees too: an
      // inherited umask or a reused root never widens the store.
      await Deno.chmod(this.root, 0o700);
      await Deno.chmod(this.entriesDir, 0o700);
      this.usedBytes = 0;
      for await (const entry of Deno.readDir(this.entriesDir)) {
        if (!entry.isFile || !entry.name.endsWith(".json")) continue;
        const metaPath = `${this.entriesDir}/${entry.name}`;
        const metadata = await this.readMetadata(metaPath);
        const binPath = await metadataBinPath(this.entriesDir, metadata);
        const binStat = await Deno.lstat(binPath);
        if (!isRegularNonLink(binStat)) {
          throw new ArtifactStoreFailure(
            "corrupt",
            "retained artifact bytes are missing or not a regular file",
          );
        }
        this.usedBytes += metadata.sizeBytes;
      }
      return { ok: true, value: undefined };
    } catch (error) {
      return wrapStoreFailure(error);
    }
  }

  async put(
    input: ArtifactStorePutV1,
    nowMs: number,
  ): Promise<ArtifactStoreResultV1<StoredArtifactV1>> {
    try {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        return failStore("invalid", "retention time is invalid");
      }
      if (
        input.manifest.captureId !== input.captureId ||
        input.manifest.fingerprint !== input.fingerprint ||
        input.manifest.ciphertextBytes !== input.ciphertext.byteLength ||
        input.manifest.capturedAt !== input.sourceCapturedAt ||
        input.manifest.expiresAt !== input.sourceExpiresAt
      ) {
        return failStore(
          "invalid",
          "artifact input does not match its manifest",
        );
      }
      const identity = parseArtifactRefIdentity(input.ref);
      if (
        identity === null ||
        identity.incidentId !== input.incidentId ||
        identity.captureId !== input.captureId
      ) {
        return failStore("invalid", "artifact ref identity is invalid");
      }
      if (input.ciphertext.byteLength < 1) {
        return failStore("invalid", "artifact ciphertext is empty");
      }
      if (input.ciphertext.byteLength > this.limits.artifactMaxBytes) {
        return failStore(
          "invalid",
          "artifact exceeds the per-artifact byte bound",
        );
      }
      if (input.ciphertext.byteLength > this.limits.totalMaxBytes) {
        return failStore(
          "full",
          "artifact cannot fit the total capacity bound",
        );
      }
      if (
        !SHA256_HEX.test(input.digest) ||
        !SHA256_HEX.test(input.fingerprint) ||
        (input.caseGroupDigest !== null &&
          !SHA256_HEX.test(input.caseGroupDigest))
      ) {
        return failStore("invalid", "artifact digest identities are invalid");
      }
      if (
        !Number.isSafeInteger(input.sourceCapturedAt) ||
        input.sourceCapturedAt < 0 ||
        !Number.isSafeInteger(input.sourceExpiresAt) ||
        input.sourceExpiresAt <= input.sourceCapturedAt
      ) {
        return failStore("invalid", "artifact source lifecycle is invalid");
      }
      const actualDigest = await sha256Hex(input.ciphertext);
      if (actualDigest !== input.digest) {
        return failStore("invalid", "artifact digest does not match its bytes");
      }
      const key = await entryKey(input.ref);
      const metaPath = `${this.entriesDir}/${key}.json`;
      const binPath = `${this.entriesDir}/${key}.bin`;
      const existing = await this.readOrNull(metaPath);
      if (existing !== null) {
        if (
          existing.digest === input.digest &&
          existing.sizeBytes === input.ciphertext.byteLength
        ) {
          const stored = await this.loadEntry(existing, binPath, nowMs);
          if (stored === null) {
            return failStore(
              "corrupt",
              "retained artifact is expired or missing",
            );
          }
          return { ok: true, value: stored };
        }
        return failStore(
          "conflict",
          "a different artifact is already retained at this ref",
        );
      }
      if (await this.exists(binPath)) {
        return failStore(
          "corrupt",
          "orphaned artifact bytes exist without metadata",
        );
      }
      if (
        this.usedBytes + input.ciphertext.byteLength > this.limits.totalMaxBytes
      ) {
        return failStore("full", "evidence store capacity is exhausted");
      }
      const retainedAt = nowMs;
      const expiresAt = retainedAt + this.limits.retentionMaxAgeMs;
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= retainedAt) {
        return failStore("invalid", "retention window overflows");
      }
      const metadata: MetadataRecordV1 = {
        version: METADATA_VERSION,
        kind: METADATA_KIND,
        ref: input.ref,
        digest: input.digest,
        sizeBytes: input.ciphertext.byteLength,
        contentType: input.contentType,
        incidentId: input.incidentId,
        captureId: input.captureId,
        fingerprint: input.fingerprint,
        caseGroupDigest: input.caseGroupDigest,
        sourceCapturedAt: input.sourceCapturedAt,
        sourceExpiresAt: input.sourceExpiresAt,
        retainedAt,
        expiresAt,
        manifest: replayManifestToWire(input.manifest),
      };
      await this.writeAtomic(binPath, input.ciphertext);
      try {
        await this.writeAtomic(
          metaPath,
          new TextEncoder().encode(`${canonicalStringify(metadata)}\n`),
        );
      } catch (error) {
        // Never keep orphan bytes that claim durable retention.
        await Deno.remove(binPath).catch(() => {});
        throw error;
      }
      this.usedBytes += input.ciphertext.byteLength;
      const stored = await this.loadEntry(metadata, binPath, nowMs);
      if (stored === null) {
        // Retained with an already-elapsed bound: purge and report the entry.
        await this.removeEntry(metadata);
        return failStore("invalid", "retention window elapsed at write time");
      }
      return { ok: true, value: stored };
    } catch (error) {
      return wrapStoreFailure(error);
    }
  }

  async get(
    ref: string,
    nowMs: number,
  ): Promise<ArtifactStoreResultV1<StoredArtifactV1 | null>> {
    try {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        return failStore("invalid", "retention time is invalid");
      }
      if (parseArtifactRefIdentity(ref) === null) {
        return failStore("invalid", "artifact ref identity is invalid");
      }
      const key = await entryKey(ref);
      const metadata = await this.readOrNull(`${this.entriesDir}/${key}.json`);
      if (metadata === null) return { ok: true, value: null };
      const stored = await this.loadEntry(
        metadata,
        `${this.entriesDir}/${key}.bin`,
        nowMs,
      );
      if (stored === null) {
        // Expired: purge the entry so capacity is reclaimed deterministically.
        await this.removeEntry(metadata);
        return { ok: true, value: null };
      }
      return { ok: true, value: stored };
    } catch (error) {
      return wrapStoreFailure(error);
    }
  }

  async listByIncident(
    incidentId: string,
    nowMs: number,
  ): Promise<ArtifactStoreResultV1<StoredArtifactV1[]>> {
    try {
      if (!GATEWAY_INCIDENT_ID.test(incidentId)) {
        return failStore("invalid", "incident id is not in the frozen format");
      }
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        return failStore("invalid", "retention time is invalid");
      }
      const artifacts: StoredArtifactV1[] = [];
      for await (const entry of Deno.readDir(this.entriesDir)) {
        if (!entry.isFile || !entry.name.endsWith(".json")) continue;
        const metadata = await this.readMetadata(
          `${this.entriesDir}/${entry.name}`,
        );
        if (metadata.incidentId !== incidentId) continue;
        const stored = await this.loadEntry(
          metadata,
          await metadataBinPath(this.entriesDir, metadata),
          nowMs,
        );
        if (stored === null) {
          await this.removeEntry(metadata);
          continue;
        }
        artifacts.push(stored);
      }
      artifacts.sort((left, right) => left.ref.localeCompare(right.ref));
      return { ok: true, value: artifacts };
    } catch (error) {
      return wrapStoreFailure(error);
    }
  }

  async stats(): Promise<
    ArtifactStoreResultV1<{ totalBytes: number; count: number }>
  > {
    try {
      let totalBytes = 0;
      let count = 0;
      for await (const entry of Deno.readDir(this.entriesDir)) {
        if (!entry.isFile || !entry.name.endsWith(".json")) continue;
        const metadata = await this.readMetadata(
          `${this.entriesDir}/${entry.name}`,
        );
        totalBytes += metadata.sizeBytes;
        count += 1;
      }
      return { ok: true, value: { totalBytes, count } };
    } catch (error) {
      return wrapStoreFailure(error);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async loadEntry(
    metadata: MetadataRecordV1,
    binPath: string,
    nowMs: number,
  ): Promise<StoredArtifactV1 | null> {
    if (nowMs >= metadata.expiresAt) return null;
    const stat = await Deno.lstat(binPath);
    if (!isRegularNonLink(stat)) {
      throw new ArtifactStoreFailure(
        "corrupt",
        "retained artifact bytes are not a regular file",
      );
    }
    const bytes = new Uint8Array(await Deno.readFile(binPath));
    if (bytes.byteLength !== metadata.sizeBytes) {
      throw new ArtifactStoreFailure(
        "corrupt",
        "retained artifact size mismatch",
      );
    }
    const digest = await sha256Hex(bytes);
    if (digest !== metadata.digest) {
      throw new ArtifactStoreFailure(
        "corrupt",
        "retained artifact digest mismatch",
      );
    }
    return {
      ref: metadata.ref,
      digest: asEncryptedArtifactDigest(metadata.digest),
      sizeBytes: metadata.sizeBytes,
      expiresAt: metadata.expiresAt,
      retainedAt: metadata.retainedAt,
      sourceExpiresAt: metadata.sourceExpiresAt,
      sourceCapturedAt: metadata.sourceCapturedAt,
      incidentId: metadata.incidentId,
      captureId: metadata.captureId,
      fingerprint: metadata.fingerprint,
      caseGroupDigest: metadata.caseGroupDigest,
      contentType: metadata.contentType,
      ciphertext: bytes,
      manifest: parseGatewayReplayManifestV1(metadata.manifest),
    };
  }

  private async readMetadata(metaPath: string): Promise<MetadataRecordV1> {
    const stat = await Deno.lstat(metaPath);
    if (!isRegularNonLink(stat)) {
      throw new ArtifactStoreFailure(
        "corrupt",
        "entry metadata is not a regular file",
      );
    }
    const text = await Deno.readTextFile(metaPath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ArtifactStoreFailure(
        "corrupt",
        "entry metadata is not valid JSON",
      );
    }
    // The metadata records the exact frozen ref; the path mapping is verified
    // separately below (exact ref-to-digest path mapping).
    const metadata = parseMetadataRecord(parsed, "");
    const expectedKey = await entryKey(metadata.ref);
    if (entryKeyRef(metaPath) !== expectedKey) {
      throw new ArtifactStoreFailure(
        "corrupt",
        "entry path does not map to its ref",
      );
    }
    return metadata;
  }

  private async readOrNull(metaPath: string): Promise<MetadataRecordV1 | null> {
    try {
      return await this.readMetadata(metaPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await Deno.lstat(path);
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  }

  private async removeEntry(metadata: MetadataRecordV1): Promise<void> {
    try {
      this.usedBytes = Math.max(0, this.usedBytes - metadata.sizeBytes);
      const key = await entryKey(metadata.ref);
      await removeIfPresent(`${this.entriesDir}/${key}.json`);
      await removeIfPresent(`${this.entriesDir}/${key}.bin`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }

  private async writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
    const parent = path.slice(0, path.lastIndexOf("/"));
    await ensureRealDirectory(parent, 0o700);
    if (await this.exists(path)) {
      const stat = await Deno.lstat(path);
      if (!isRegularNonLink(stat)) {
        throw new ArtifactStoreFailure(
          "invalid",
          "target path is not a regular file",
        );
      }
    }
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const tmpPath = path + `.tmp-${nonce}`;
    try {
      const file = await Deno.open(tmpPath, {
        create: true,
        write: true,
        truncate: true,
        mode: 0o600,
      });
      try {
        await file.write(bytes);
      } finally {
        file.close();
      }
      await Deno.rename(tmpPath, path);
    } catch (error) {
      await removeIfPresent(tmpPath);
      throw error;
    }
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

function entryKey(ref: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(ref));
}

function entryKeyRef(metaPath: string): string {
  const name = metaPath.slice(metaPath.lastIndexOf("/") + 1);
  return name.endsWith(".json") ? name.slice(0, -".json".length) : name;
}

async function metadataBinPath(
  entriesDir: string,
  metadata: MetadataRecordV1,
): Promise<string> {
  return `${entriesDir}/${await entryKey(metadata.ref)}.bin`;
}

function validateLimits(limits: ArtifactStoreLimitsV1): void {
  for (
    const [name, value] of [
      ["totalMaxBytes", limits.totalMaxBytes],
      ["artifactMaxBytes", limits.artifactMaxBytes],
      ["retentionMaxAgeMs", limits.retentionMaxAgeMs],
    ] as const
  ) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ArtifactStoreFailure(
        "invalid",
        `store bound ${name} must be a positive safe integer`,
      );
    }
  }
}

async function ensureRealDirectory(path: string, mode: number): Promise<void> {
  try {
    const stat = await Deno.lstat(path);
    if (stat.isSymlink || !stat.isDirectory) {
      throw new ArtifactStoreFailure(
        "invalid",
        "store path component is not a real directory",
      );
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      await Deno.mkdir(path, { recursive: true, mode });
      const created = await Deno.lstat(path);
      if (created.isSymlink || !created.isDirectory) {
        throw new ArtifactStoreFailure(
          "invalid",
          "store path component is not a real directory",
        );
      }
      return;
    }
    throw error;
  }
}

function isRegularNonLink(stat: Deno.FileInfo): boolean {
  return !stat.isSymlink && stat.isFile;
}

function wrapStoreFailure(
  error: unknown,
): ArtifactStoreResultV1<never> {
  if (error instanceof ArtifactStoreFailure) {
    return failStore(
      error.kind,
      error.kind === "corrupt" || error.kind === "unavailable"
        ? "evidence store state is unusable"
        : error.message,
    );
  }
  if (error instanceof Deno.errors.NotFound) {
    return failStore("unavailable", "evidence store path is missing");
  }
  if (error instanceof Deno.errors.PermissionDenied) {
    return failStore("unavailable", "evidence store access is denied");
  }
  return failStore("unavailable", "evidence store I/O failure");
}
