/**
 * GatewayIncidentAdapter — the production IncidentAdapter over the frozen
 * gateway producer HTTP contract (docs/contracts.md §11).
 *
 * All external dependencies are constructor-injected: a native-Fetch-
 * compatible transport, a credential provider (never a record field), a
 * `Clock`, a trusted parsed `RepositoryConfigV1` (repository identity and
 * `provenance.source` are adapter configuration, never wire values) and the
 * bounded restricted local artifact store.
 *
 * Guarantees:
 *
 * - Listing is read-only: no claim/ack/defer endpoint is ever invoked.
 * - A missing/unreachable producer index endpoint (404) is `unavailable`,
 *   never an empty successful page; transport and schema faults are typed.
 * - Never an empty page for a fault: the current target does not implement
 *   the proposed index (m06 is postponed), so live discovery against it is
 *   `unavailable` until the producer exists.
 * - `readIncident` filters the exact frozen incident identity id, then
 *   exhausts the existing replay export (`incident_id` + explicit interval +
 *   `limit=1`) with cursor-cycle/page/response-byte bounds; partial or
 *   malformed responses are explicit typed errors, never clean completions.
 * - Index coverage is aggregated conservatively: any incomplete page keeps the
 *   whole scan incomplete (with its bounded reason/cursor) even when a later
 *   page is complete; a failed/missing page is never an empty success.
 * - The referenced evidence digest is exact: it is required after all
 *   source-expiry filtering, retention and reconciliation, in every branch
 *   including source-lost/early-return branches. An unrelated retained
 *   artifact never satisfies an updated reference, and a digest-null
 *   reference (unbindable capture identity) is reported unavailable instead
 *   of being bound to an older artifact.
 * - The replay export walk bounds the aggregate decoded ciphertext bytes
 *   (store total bound) and capture count (contract artifact-count bound)
 *   before a capture joins the in-memory set; exceeding either stops further
 *   fetches and preserves already retained evidence.
 * - Captures are validated against the exact producer manifest/chunk wire
 *   schema; the SHA-256 of the actual decoded concatenated ciphertext is the
 *   artifact digest. The manifest fingerprint (HMAC identity) is preserved
 *   privately in the store for later trusted decryption; no plaintext and no
 *   key material enters records or public artifacts.
 * - Evidence retention is deterministic and durable: locally retained
 *   artifacts are reused even after the original 48h source expiry, while a
 *   source capture lost before retention is `null` (evidence_expired). The
 *   local reuse requires the exact referenced digest; retained artifacts are
 *   never extended and unrelated ones never satisfy the current reference.
 * - `EncryptedArtifactV1.ciphertextBase64` is canonical base64 of the
 *   retained ciphertext; digest/size/expiry are exact.
 * - `replay` stays null until a trusted sanitized fixture exists; a missing
 *   `failingRevision` stays null and is never guessed.
 */

import { parseIncidentEvidenceV1 } from "../../contracts/incident.ts";
import type { IncidentEvidenceV1 } from "../../contracts/incident.ts";
import type {
  EncryptedArtifactV1,
  IncidentAdapter,
  IncidentPageV1,
} from "../../contracts/ports.ts";
import type { Clock, PortResultV1 } from "../../contracts/ports.ts";
import { portError, portOk } from "../../contracts/ports.ts";
import type { RepositoryConfigV1 } from "../../contracts/repository-config.ts";
import type { IncidentCoverageV1 } from "../../contracts/shared.ts";
import {
  type GatewayAuthProviderV1,
  gatewayRead,
  type GatewayTransportV1,
} from "./http.ts";
import type { ArtifactStoreV1, StoredArtifactV1 } from "./store.ts";
import { parseArtifactRefIdentity } from "./store.ts";
import {
  concatReplayChunks,
  encodeCanonicalBase64,
  GATEWAY_CURSOR_MAX_LENGTH,
  GATEWAY_INCIDENT_ID,
  GATEWAY_INDEX_PAGE_BYTE_CAP,
  GATEWAY_MAX_ARTIFACTS_PER_EVIDENCE,
  GATEWAY_MAX_SCAN_PAGES,
  GATEWAY_RESPONSE_BYTE_CEILING,
  type GatewayIndexPageV1,
  type GatewayIndexRowV1,
  type GatewayReplayCaptureV1,
  gatewayRowToSummary,
  GatewayWireError,
  parseGatewayIndexPageV1,
  parseGatewayReplayPageV1,
} from "./wire.ts";

const INDEX_PATH = "/admin/sentinel/incidents";
const REPLAY_PATH = "/admin/sentinel/replay-captures";
const ARTIFACT_NAMESPACE = "sentinel";
const ARTIFACT_CONTENT_TYPE = "application/octet-stream";
const INDEX_LIMIT_MIN = 1;
const INDEX_LIMIT_MAX = 100;

export interface GatewayIncidentAdapterOptionsV1 {
  /** Trusted parsed repository configuration (never an untrusted wire value). */
  config: RepositoryConfigV1;
  transport: GatewayTransportV1;
  auth: GatewayAuthProviderV1;
  clock: Clock;
  /** Bounded restricted local evidence store (deterministic ingestion). */
  store: ArtifactStoreV1;
}

export class GatewayIncidentAdapter implements IncidentAdapter {
  private readonly config: RepositoryConfigV1;
  private readonly baseUrl: string;
  private readonly transport: GatewayTransportV1;
  private readonly auth: GatewayAuthProviderV1;
  private readonly clock: Clock;
  private readonly store: ArtifactStoreV1;

  constructor(options: GatewayIncidentAdapterOptionsV1) {
    const { config, transport, auth, clock, store } = options;
    if (config.adapter.kind !== "gateway") {
      throw new Error(
        "GatewayIncidentAdapter requires a gateway adapter config",
      );
    }
    // Capture the validated value once instead of re-reading a union member at
    // each call site (no cast).
    const baseUrl = config.adapter.baseUrl;
    if (typeof baseUrl !== "string" || baseUrl.length === 0) {
      throw new Error("GatewayIncidentAdapter requires a configured base URL");
    }
    this.config = config;
    this.baseUrl = baseUrl;
    this.transport = transport;
    this.auth = auth;
    this.clock = clock;
    this.store = store;
  }

  async listUnresolvedIncidents(
    cursor: string | null,
    limit: number,
  ): Promise<PortResultV1<IncidentPageV1>> {
    if (
      !Number.isSafeInteger(limit) || limit < INDEX_LIMIT_MIN ||
      limit > INDEX_LIMIT_MAX
    ) {
      return portError(
        "invalid",
        "gateway page limit is outside the supported 1..100 range",
      );
    }
    if (
      cursor !== null &&
      (cursor.length === 0 || cursor.length > GATEWAY_CURSOR_MAX_LENGTH)
    ) {
      return portError(
        "invalid",
        "gateway cursor is outside the acceptable bounds",
      );
    }
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor !== null) query.set("cursor", cursor);
    const response = await this.requestJson(
      INDEX_PATH,
      query,
      GATEWAY_INDEX_PAGE_BYTE_CAP,
    );
    if (!response.ok) return response;
    let page: GatewayIndexPageV1;
    try {
      page = parseGatewayIndexPageV1(response.value.body);
    } catch (error) {
      return wireFault(error, "gateway index response schema is invalid");
    }
    if (page.rows.length > limit) {
      return portError(
        "invalid",
        "gateway index returned more rows than requested",
      );
    }
    const items = [];
    for (const row of page.rows) {
      try {
        items.push(
          gatewayRowToSummary(row, this.config.repository, page.coverage),
        );
      } catch {
        return portError(
          "invalid",
          "gateway index row failed record validation",
        );
      }
    }
    return portOk({ items, coverage: page.coverage, nextCursor: page.cursor });
  }

  async readIncident(
    incidentId: string,
  ): Promise<PortResultV1<IncidentEvidenceV1 | null>> {
    if (!GATEWAY_INCIDENT_ID.test(incidentId)) {
      return portError(
        "invalid",
        "incident id is not in the frozen provider-UUID format",
      );
    }
    const now = this.now();
    if (!now.ok) return now.error;

    const scan = await this.scanIndexForIncident(incidentId);
    if (!scan.ok) return scan;
    const row = scan.value.row;
    if (row === null) return portOk(null);
    const coverage = scan.value.coverage;

    const artifacts = await this.evidenceArtifacts(row, now.value);
    if (!artifacts.ok) return artifacts;
    if (artifacts.value === null) return portOk(null);

    const evidence: IncidentEvidenceV1 = {
      version: "v1",
      kind: "incident_evidence",
      repository: this.config.repository,
      id: `evidence:${incidentId}`,
      incidentId,
      fingerprint: row.fingerprint,
      failingRevision: row.failingRevision,
      artifacts: artifacts.value.map((artifact) => ({
        ref: artifact.ref,
        digest: artifact.digest,
        sizeBytes: artifact.sizeBytes,
        expiresAt: artifact.expiresAt,
        contentType: artifact.contentType,
      })),
      replay: null,
      provenance: {
        source: "gateway",
        endpoint: row.provenance.endpoint,
        capturedAt: row.provenance.capturedAt,
        capturedBy: row.provenance.capturedBy,
      },
      coverage,
    };
    try {
      return portOk(parseIncidentEvidenceV1(evidence));
    } catch {
      return portError("invalid", "incident evidence failed record validation");
    }
  }

  async readArtifact(
    ref: string,
    maxBytes: number,
  ): Promise<PortResultV1<EncryptedArtifactV1 | null>> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      return portError(
        "invalid",
        "artifact byte bound must be a positive safe integer",
      );
    }
    const now = this.now();
    if (!now.ok) return now.error;
    const local = await this.store.get(ref, now.value);
    if (!local.ok) return storeFault(local.error);
    if (local.value !== null) {
      if (local.value.sizeBytes > maxBytes) {
        return portError(
          "invalid",
          "artifact exceeds the requested byte bound",
        );
      }
      return portOk(toEncryptedArtifact(local.value));
    }
    const identity = parseArtifactRefIdentity(ref);
    if (identity === null) {
      return portError(
        "invalid",
        "artifact ref is not in the resolvable restricted format",
      );
    }
    let found: GatewayReplayCaptureV1 | null = null;
    const walked = await this.walkReplayCaptures(
      identity.incidentId,
      now.value,
      (capture) => {
        if (capture.manifest.captureId === identity.captureId) {
          found = capture;
          return portOk(true); // stop fetching: the exact capture is retained.
        }
        return portOk(false);
      },
    );
    if (!walked.ok) return walked;
    if (found === null) {
      // The referenced capture no longer exists at the source: gone/expired.
      return portOk(null);
    }
    const retained = await this.retainCapture(
      identity.incidentId,
      found,
      now.value,
      maxBytes,
    );
    if (!retained.ok) return retained;
    if (retained.value === null) return portOk(null);
    return portOk(toEncryptedArtifact(retained.value));
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private now(): { ok: true; value: number } | {
    ok: false;
    error: PortResultV1<never>;
  } {
    const now = this.clock.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      return {
        ok: false,
        error: portError("invalid", "injected clock returned an invalid time"),
      };
    }
    return { ok: true, value: now };
  }

  private requestJson(
    path: string,
    query: URLSearchParams,
    byteCap: number,
  ): Promise<PortResultV1<{ status: number; body: unknown }>> {
    return gatewayRead(
      {
        baseUrl: this.baseUrl,
        path,
        query,
        responseByteCap: byteCap,
      },
      this.transport,
      this.auth,
    );
  }

  private async scanIndexForIncident(
    incidentId: string,
  ): Promise<
    PortResultV1<
      { row: GatewayIndexRowV1 | null; coverage: IncidentCoverageV1 }
    >
  > {
    let cursor: string | null = null;
    const seen = new Set<string>();
    let pages = 0;
    let row: GatewayIndexRowV1 | null = null;
    // Conservative aggregation: the first incomplete page's bound stays the
    // overall bound even when a later page reports complete.
    let firstIncomplete: {
      reason: string;
      nextCursor: string | null;
    } | null = null;
    for (;;) {
      if (cursor !== null) {
        if (cursor.length > GATEWAY_CURSOR_MAX_LENGTH) {
          return portError(
            "invalid",
            "gateway cursor exceeds the cursor length bound",
          );
        }
        if (seen.has(cursor)) {
          return portError(
            "invalid",
            "gateway cursor repeated without progress",
          );
        }
        seen.add(cursor);
      }
      pages += 1;
      if (pages > GATEWAY_MAX_SCAN_PAGES) {
        return portError(
          "invalid",
          "gateway index pagination exceeded the page bound",
        );
      }
      const query = new URLSearchParams({
        incident_id: incidentId,
        limit: "1",
      });
      if (cursor !== null) query.set("cursor", cursor);
      const response = await this.requestJson(
        INDEX_PATH,
        query,
        GATEWAY_INDEX_PAGE_BYTE_CAP,
      );
      if (!response.ok) return response;
      let page: GatewayIndexPageV1;
      try {
        page = parseGatewayIndexPageV1(response.value.body);
      } catch (error) {
        return wireFault(error, "gateway index response schema is invalid");
      }
      if (page.rows.length > 1) {
        return portError(
          "invalid",
          "gateway index returned more than one filtered row",
        );
      }
      for (const candidate of page.rows) {
        if (candidate.incidentId !== incidentId) {
          return portError(
            "invalid",
            "gateway index filter returned a different incident",
          );
        }
        if (row !== null) {
          return portError(
            "invalid",
            "gateway index repeated the same filtered row",
          );
        }
        row = candidate;
      }
      if (
        page.coverage.status === "incomplete" && firstIncomplete === null
      ) {
        firstIncomplete = {
          reason: page.coverage.reason,
          nextCursor: page.coverage.nextCursor,
        };
      }
      if (page.cursor === null) break;
      cursor = page.cursor;
    }
    const coverage: IncidentCoverageV1 = firstIncomplete === null
      ? { status: "complete" }
      : {
        status: "incomplete",
        reason: firstIncomplete.reason,
        nextCursor: firstIncomplete.nextCursor,
      };
    return portOk({ row, coverage });
  }

  /**
   * Deterministic ingestion: returns the retained artifacts for the evidence
   * record, refetching from the source only when the exact referenced digest
   * is not already retained locally.
   *
   * The referenced digest is the exact binding identity and is required after
   * all source-expiry filtering, retention and reconciliation, in every branch
   * including early-return and source-lost ones. `null` means the referenced
   * source evidence was lost before retention (evidence_expired) — never a
   * fabricated record and never an unrelated older artifact. A digest-null
   * reference cannot be bound to an exact capture identity and is reported
   * unavailable instead of assuming any older artifact satisfies it.
   *
   * A matched capture is retained as soon as it is found during the bounded
   * replay walk, so a later aggregate-bound violation stops further fetches
   * while preserving exactly what was already retained.
   */
  private async evidenceArtifacts(
    row: GatewayIndexRowV1,
    now: number,
  ): Promise<PortResultV1<StoredArtifactV1[] | null>> {
    const local = await this.store.listByIncident(row.incidentId, now);
    if (!local.ok) return storeFault(local.error);
    const retained = local.value;
    if (row.evidenceRef === null) {
      return portOk(retained);
    }
    const digest = row.evidenceRef.digest;
    if (digest === null) {
      return portError(
        "unavailable",
        "referenced evidence has no digest identity to bind",
      );
    }
    if (retained.some((artifact) => artifact.digest === digest)) {
      // Locally retained referenced evidence: never refetch or extend.
      return portOk(retained);
    }

    let matched = false;
    let candidates = 0;
    const pending: GatewayReplayCaptureV1[] = [];
    const matchedArtifacts: StoredArtifactV1[] = [];
    const walked = await this.walkReplayCaptures(
      row.incidentId,
      now,
      async (capture) => {
        if (capture.manifest.expiresAt <= now) {
          // Source-expired: excluded from the binding pool and from retention.
          return portOk(false);
        }
        candidates += 1;
        const candidate = await captureDigest(capture);
        if (candidate === null) {
          return portError("invalid", "capture digest computation failed");
        }
        if (candidate === digest) {
          matched = true;
          const result = await this.retainCapture(
            row.incidentId,
            capture,
            now,
            this.store.limits.artifactMaxBytes,
          );
          if (!result.ok) return result;
          if (result.value !== null) matchedArtifacts.push(result.value);
        } else {
          // Not retained until the exact digest is confirmed after the walk.
          pending.push(capture);
        }
        return portOk(false);
      },
    );
    if (!walked.ok) return walked;
    if (!matched) {
      if (candidates === 0) {
        // Nothing non-expired at the source and no local match: the referenced
        // evidence was lost before ingestion; never a clean completion.
        return portOk(null);
      }
      return portError(
        "invalid",
        "referenced evidence digest does not match any retained capture",
      );
    }

    const merged = new Map<string, StoredArtifactV1>();
    for (const artifact of [...retained, ...matchedArtifacts]) {
      merged.set(artifact.ref, artifact);
    }
    for (const capture of pending) {
      const result = await this.retainCapture(
        row.incidentId,
        capture,
        now,
        this.store.limits.artifactMaxBytes,
      );
      if (!result.ok) return result;
      if (result.value !== null) merged.set(result.value.ref, result.value);
    }
    const artifacts = [...merged.values()].sort((a, b) =>
      a.ref.localeCompare(b.ref)
    );
    if (!artifacts.some((artifact) => artifact.digest === digest)) {
      // Reconciliation must keep the exact reference: an unrelated artifact can
      // never satisfy an updated reference.
      return portOk(null);
    }
    if (artifacts.length > GATEWAY_MAX_ARTIFACTS_PER_EVIDENCE) {
      return portError(
        "invalid",
        "incident has more retained artifacts than the contract supports",
      );
    }
    return portOk(artifacts);
  }

  /**
   * Exhausts the existing replay export for one incident: explicit interval
   * (`after_ms=0`, `before_ms=now`), `limit=1`, cursor with length/cycle/page
   * bounds. Never assumes a larger page is supported.
   *
   * Aggregate in-memory bounds are enforced BEFORE a capture is handed to
   * `visit`: the decoded ciphertext byte total against the store's total
   * bound (`store.limits.totalMaxBytes`) and the capture count against the
   * contract artifact-count bound. Exceeding either returns an explicit
   * unavailable/invalid result, stops further fetches and preserves
   * everything already retained; a single page is still governed by the
   * response/per-artifact caps.
   *
   * `visit` returns true to stop fetching early (for example when the exact
   * target capture was found).
   */
  private async walkReplayCaptures(
    incidentId: string,
    now: number,
    visit: (
      capture: GatewayReplayCaptureV1,
    ) => PortResultV1<boolean> | Promise<PortResultV1<boolean>>,
  ): Promise<PortResultV1<void>> {
    let cursor: string | null = null;
    const seen = new Set<string>();
    const captureIds = new Set<string>();
    let pages = 0;
    let captures = 0;
    let aggregateBytes = 0;
    for (;;) {
      if (cursor !== null) {
        if (cursor.length > GATEWAY_CURSOR_MAX_LENGTH) {
          return portError(
            "invalid",
            "gateway replay cursor exceeds the cursor length bound",
          );
        }
        if (seen.has(cursor)) {
          return portError(
            "invalid",
            "gateway replay cursor repeated without progress",
          );
        }
        seen.add(cursor);
      }
      pages += 1;
      if (pages > GATEWAY_MAX_SCAN_PAGES) {
        return portError(
          "invalid",
          "replay export pagination exceeded the page bound",
        );
      }
      const query = new URLSearchParams({
        incident_id: incidentId,
        after_ms: "0",
        before_ms: String(now),
        limit: "1",
      });
      if (cursor !== null) query.set("cursor", cursor);
      const byteCap = replayResponseByteCap(this.store.limits.artifactMaxBytes);
      const response = await this.requestJson(REPLAY_PATH, query, byteCap);
      if (!response.ok) return response;
      let page;
      try {
        page = parseGatewayReplayPageV1(response.value.body);
      } catch (error) {
        return wireFault(error, "replay export response schema is invalid");
      }
      if (page.captures.length > 1) {
        return portError(
          "invalid",
          "replay export returned more than one capture per page",
        );
      }
      let stop = false;
      for (const capture of page.captures) {
        if (captureIds.has(capture.manifest.captureId)) {
          return portError(
            "invalid",
            "replay export repeated the same capture",
          );
        }
        if (captures + 1 > GATEWAY_MAX_ARTIFACTS_PER_EVIDENCE) {
          return portError(
            "invalid",
            "replay export exceeds the contract artifact-count bound",
          );
        }
        if (
          aggregateBytes + capture.manifest.ciphertextBytes >
            this.store.limits.totalMaxBytes
        ) {
          return portError(
            "unavailable",
            "replay export exceeds the aggregate evidence byte bound",
          );
        }
        captureIds.add(capture.manifest.captureId);
        captures += 1;
        aggregateBytes += capture.manifest.ciphertextBytes;
        const visited = await visit(capture);
        if (!visited.ok) return visited;
        if (visited.value) {
          stop = true;
          break;
        }
      }
      if (stop || page.cursor === null) break;
      cursor = page.cursor;
    }
    return portOk(undefined);
  }

  /**
   * Validates, digests and durably retains one capture. `null` means the
   * capture was source-expired; a byte bound violation is `invalid`. The
   * produced ref is the frozen deterministic restricted ref naming both the
   * incident and the capture identity.
   */
  private async retainCapture(
    incidentId: string,
    capture: GatewayReplayCaptureV1,
    now: number,
    byteBound: number,
  ): Promise<PortResultV1<StoredArtifactV1 | null>> {
    const { manifest } = capture;
    if (manifest.expiresAt <= now) return portOk(null);
    const ciphertext = concatReplayChunks(capture);
    const digest = await captureDigest(capture);
    if (digest === null) {
      return portError("invalid", "capture digest computation failed");
    }
    if (manifest.ciphertextBytes > byteBound) {
      return portError("invalid", "capture exceeds the evidence byte bound");
    }
    const ref = artifactRef(incidentId, manifest.captureId);
    const retained = await this.store.put({
      ref,
      digest,
      ciphertext,
      incidentId,
      captureId: manifest.captureId,
      fingerprint: manifest.fingerprint,
      caseGroupDigest: manifest.caseGroupDigest,
      sourceCapturedAt: manifest.capturedAt,
      sourceExpiresAt: manifest.expiresAt,
      contentType: ARTIFACT_CONTENT_TYPE,
      manifest,
    }, now);
    if (!retained.ok) return storeFault(retained.error);
    return portOk(retained.value);
  }
}

export function artifactRef(incidentId: string, captureId: string): string {
  if (!GATEWAY_INCIDENT_ID.test(incidentId)) {
    throw new Error("artifact ref requires a frozen incident identity");
  }
  return `artifact://${ARTIFACT_NAMESPACE}/${incidentId}/${captureId}`;
}

function toEncryptedArtifact(
  artifact: StoredArtifactV1,
): EncryptedArtifactV1 {
  return {
    ref: artifact.ref,
    digest: artifact.digest,
    sizeBytes: artifact.sizeBytes,
    expiresAt: artifact.expiresAt,
    ciphertextBase64: encodeCanonicalBase64(artifact.ciphertext),
  };
}

/** SHA-256 of the actual decoded concatenated ciphertext (never guessed). */
async function captureDigest(
  capture: GatewayReplayCaptureV1,
): Promise<string | null> {
  const bytes = concatReplayChunks(capture);
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    return new Uint8Array(digest).reduce(
      (hex, byte) => hex + byte.toString(16).padStart(2, "0"),
      "",
    );
  } catch {
    return null;
  }
}

function replayResponseByteCap(maxBytes: number): number {
  const base = Math.ceil((maxBytes * 4) / 3) + 256 * 1_024;
  return Math.min(base, GATEWAY_RESPONSE_BYTE_CEILING);
}

function wireFault(
  error: unknown,
  detail: string,
): PortResultV1<never> {
  if (error instanceof GatewayWireError) return portError("invalid", detail);
  return portError("invalid", detail);
}

function storeFault(error: {
  kind: "invalid" | "conflict" | "full" | "corrupt" | "unavailable";
  detail: string;
}): PortResultV1<never> {
  if (error.kind === "full") {
    return portError("unavailable", "evidence store capacity is exhausted");
  }
  if (error.kind === "invalid" || error.kind === "conflict") {
    return portError(error.kind, error.detail);
  }
  return portError("unavailable", error.detail);
}
