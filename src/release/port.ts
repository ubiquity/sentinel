/**
 * DenoReleasePort implementation over the documented Deno REST API plus the
 * managed/custom domain health endpoints.
 *
 * Endpoints and resource identity fields (no invented API):
 * - GET  /v2/apps/{app}/revisions?status=succeeded&limit=N   → RevisionListItem[]
 *   (id, status, labels, created_at)
 * - GET  /v2/revisions/{revision}                            → Revision
 * - GET  /v2/revisions/{revision}/timelines                  → Timeline[]
 *   ({slug, partition, domains:[{domain}]})
 * - POST /v2/revisions/{revision}/promote                    → 204 No Content
 * - GET  /v2/apps/{app}/logs?start&end&revision_id&limit&cursor
 *   → { logs:[{timestamp,level,message,revision_id}], next_cursor }
 *
 * Identity is always the pair {gitSha, revisionId}; a revision id alone, a
 * timestamp or the latest list item is never a substitute. The revision list
 * response is a bare array with a documented cursor/limit but no documented
 * envelope, so a full page is inconclusive and the lookup fails closed
 * instead of guessing.
 *
 * The client is constructed with trusted config (project id, label keys,
 * identity header names, log classification, bounds) plus injected transports,
 * auth and clock; no environment variable or CLI surface exists.
 */

import type { Clock } from "../contracts/ports.ts";
import {
  type BuildLookupV1,
  DENO_PROMOTION_REQUIRED_STATUS,
  type DenoDeploymentV1,
  type DenoPromotionOutcomeV1,
  type DenoPromotionRequestV1,
  type DenoReleasePort,
  type HealthSampleConfigV1,
  type HealthSampleV1,
  type MetricsSampleConfigV1,
  type MetricsSampleV1,
  type PortResultV1,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { DeploymentIdentityV1 } from "../contracts/shared.ts";
import type { GitSha } from "../contracts/brands.ts";
import {
  DENO_LOGS_PAGE_LIMIT,
  DENO_MAX_LOG_PAGE_BYTES,
  DENO_MAX_LOG_PAGES,
  DENO_MAX_RESPONSE_BYTES,
  DENO_REVISIONS_PAGE_LIMIT,
} from "./config.ts";
import type { ReleaseTargetConfigV1 } from "./config.ts";
import {
  type DenoAuthProviderV1,
  type DenoHttpTransportV1,
  denoRestCall,
} from "./http.ts";
import { CohortAccumulatorV1, parseCohortMessage } from "./log-cohort.ts";

/** Finite deadline for one unauthenticated health probe, in ms. */
const DENO_HEALTH_TIMEOUT_MS = 5_000;

export interface DenoReleasePortOptions {
  /** Injected native-fetch-compatible transport (production: `fetch`). */
  transport: DenoHttpTransportV1;
  /** Constructor-injected Deno REST credential source. */
  auth: DenoAuthProviderV1;
  /** Trusted m05 target configuration. */
  config: ReleaseTargetConfigV1;
  /** Clock for sample timestamps. */
  clock: Clock;
}

interface RevisionListItemV1 {
  id: string;
  status: string;
  labels: Record<string, string | string[]>;
  createdAt: number | null;
}

interface RevisionResourceV1 {
  id: string;
  status: string;
  labels: Record<string, string | string[]>;
}

export class DenoReleaseRESTClient implements DenoReleasePort {
  private readonly transport: DenoHttpTransportV1;
  private readonly auth: DenoAuthProviderV1;
  private readonly config: ReleaseTargetConfigV1;
  private readonly clock: Clock;

  constructor(options: DenoReleasePortOptions) {
    this.transport = options.transport;
    this.auth = options.auth;
    this.config = options.config;
    this.clock = options.clock;
  }

  // -------------------------------------------------------------------------
  // Candidate build lookup: exact SHA+transaction, no list-order selection.
  // -------------------------------------------------------------------------

  async findBuiltCandidate(
    projectId: string,
    revision: GitSha,
    buildTransactionId: string,
  ): Promise<PortResultV1<BuildLookupV1>> {
    const page = await this.listSucceededRevisions(projectId);
    if (!page.ok) return page;
    const items = page.value;

    const shaMatches: RevisionListItemV1[] = [];
    const matches: RevisionListItemV1[] = [];
    for (const item of items) {
      const shaLabel = stringLabel(item.labels, this.config.gitShaLabelKey);
      const txnLabel = stringLabel(
        item.labels,
        this.config.buildTransactionLabelKey,
      );
      if (shaLabel === revision) {
        shaMatches.push(item);
        if (txnLabel === buildTransactionId) matches.push(item);
      }
    }
    if (matches.length > 1) {
      // Several builds claim the exact same SHA AND transaction: the binding
      // is ambiguous, never "found".
      return portOk({ status: "ambiguous" as const });
    }
    if (matches.length === 0) {
      if (shaMatches.length > 0) {
        // A build for this exact SHA exists, but none carries the recorded
        // transaction: the receipt cannot be bound to a unique build.
        return portOk({ status: "ambiguous" as const });
      }
      return portOk({ status: "none" as const });
    }

    const item = matches[0];
    const resource = await this.readRevision(item.id);
    if (!resource.ok) return resource;
    if (
      resource.value.id !== item.id || resource.value.status !== "succeeded" ||
      stringLabel(resource.value.labels, this.config.gitShaLabelKey) !==
        revision ||
      stringLabel(
          resource.value.labels,
          this.config.buildTransactionLabelKey,
        ) !== buildTransactionId
    ) {
      return portOk({ status: "ambiguous" as const });
    }
    return portOk({
      status: "found",
      build: {
        projectId,
        buildTransactionId,
        identity: { gitSha: revision, revisionId: item.id },
        status: "succeeded",
        createdAt: item.createdAt ?? 0,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Current deployment: exact enumeration without time/list-order guessing.
  // -------------------------------------------------------------------------

  async readCurrentDeployment(
    projectId: string,
  ): Promise<PortResultV1<DenoDeploymentV1>> {
    const domain = this.config.acceptance.domain ??
      new URL(this.config.managedBaseUrl).host;
    const page = await this.listSucceededRevisions(projectId);
    if (!page.ok) return page;

    const bound: RevisionListItemV1[] = [];
    for (const item of page.value) {
      const timelines = await this.readTimelines(item.id);
      if (!timelines.ok) return timelines;
      if (
        timelines.value.some((timeline) => timeline.domains.includes(domain))
      ) {
        bound.push(item);
      }
    }
    if (bound.length === 0) {
      return portOk({
        projectId,
        identity: null,
        domain,
        status: "not_deployed",
        updatedAt: null,
      });
    }
    if (bound.length > 1) {
      // Several succeeded revisions claim the hostname and the API does not
      // expose the production pin: the current identity is not determinable.
      // This is never resolved by latest-list-item or timestamp choice.
      return portOk({
        projectId,
        identity: null,
        domain,
        status: "unknown",
        updatedAt: null,
      });
    }
    const item = bound[0];
    const gitSha = stringLabel(item.labels, this.config.gitShaLabelKey);
    if (gitSha === null) {
      return portOk({
        projectId,
        identity: null,
        domain,
        status: "unknown",
        updatedAt: null,
      });
    }
    return portOk({
      projectId,
      identity: { gitSha: gitSha as GitSha, revisionId: item.id },
      domain,
      status: "live",
      updatedAt: item.createdAt,
    });
  }

  // -------------------------------------------------------------------------
  // Promotion: POST /v2/revisions/{revision}/promote, HTTP 204 required.
  // -------------------------------------------------------------------------

  async promote(
    request: DenoPromotionRequestV1,
  ): Promise<PortResultV1<DenoPromotionOutcomeV1>> {
    const path = `/v2/revisions/${
      encodeURIComponent(request.identity.revisionId)
    }/promote`;
    const call = await denoRestCall(
      {
        baseUrl: this.config.apiBaseUrl,
        path,
        method: "POST",
        responseByteCap: DENO_MAX_RESPONSE_BYTES,
      },
      this.transport,
      this.auth,
    );
    if (!call.ok) {
      if (call.error.kind === "auth_failed") return call;
      // Transport/timeout/byte-bound failure: the effect may or may not have
      // been applied. Reconciliation observes the deployment; it never
      // blindly repeats the POST.
      return portOk({
        outcome: "ambiguous",
        statusCode: null,
        detail: "promotion outcome is unknown",
      });
    }
    const statusCode = call.value.status;
    if (statusCode !== DENO_PROMOTION_REQUIRED_STATUS) {
      return portOk({
        outcome: "rejected",
        statusCode,
        detail: "promotion did not return 204",
      });
    }
    // A 204 has no content; the post-effect identity proof is the controller's
    // managed-domain observation, never the response body itself.
    if (call.value.body.byteLength > 0) {
      return portOk({
        outcome: "ambiguous",
        statusCode,
        detail: "promotion returned 204 with an unexpected body",
      });
    }
    return portOk({
      outcome: "promoted",
      statusCode: DENO_PROMOTION_REQUIRED_STATUS,
      observedIdentity: null,
    });
  }

  // -------------------------------------------------------------------------
  // Health sampling: managed body/headers plus exact deployment identity.
  // -------------------------------------------------------------------------

  async sampleHealth(
    config: HealthSampleConfigV1,
  ): Promise<PortResultV1<HealthSampleV1>> {
    const response = await this.unauthenticatedGet(
      config.baseUrl,
      config.healthPath,
    );
    if (!response.ok) {
      return portOk({
        at: this.clock.now(),
        status: "unreachable",
        httpStatus: null,
        bodyMarkerPresent: null,
        headersMatch: null,
        identity: null,
        domain: config.domain,
      });
    }
    const status = response.value.status;
    const bodyText = new TextDecoder().decode(response.value.body);
    const headers = new Headers();
    for (const [name, value] of response.value.headers) {
      headers.set(name, value);
    }
    if (status !== 200) {
      const verifiedCloudflare = status === 403
        ? isVerifiedCloudflareChallenge(headers)
        : false;
      return portOk({
        at: this.clock.now(),
        status: "degraded",
        httpStatus: status,
        bodyMarkerPresent: null,
        // For a 403 this reports whether the response is the target's
        // identified Cloudflare Bot Fight Mode challenge (server: cloudflare,
        // cf-mitigated: challenge, cf-ray present). Any other non-200 keeps
        // the null sentinel (no header verification was possible).
        headersMatch: status === 403 ? verifiedCloudflare : null,
        identity: null,
        domain: config.domain,
      });
    }
    const bodyMarkerPresent = bodyText.includes(
      config.managedBodyMarker,
    );
    const headersMatch = config.managedHeaders.every((entry) =>
      headerEquals(headers, entry.name, entry.value)
    );
    const identity = this.identityFromHeaders(headers);
    const healthy = bodyMarkerPresent && headersMatch && identity !== null;
    return portOk({
      at: this.clock.now(),
      status: healthy ? "healthy" : "degraded",
      httpStatus: status,
      bodyMarkerPresent,
      headersMatch,
      identity,
      domain: config.domain,
    });
  }

  // -------------------------------------------------------------------------
  // Metrics sampling: exact revision + explicit window over the logs resource.
  // -------------------------------------------------------------------------

  async sampleMetrics(
    config: MetricsSampleConfigV1,
  ): Promise<PortResultV1<MetricsSampleV1>> {
    if (config.windowStart >= config.windowEnd) {
      return portError("invalid", "metrics window is inverted");
    }
    if (config.windowEnd > this.clock.now()) {
      return portError(
        "invalid",
        "a telemetry window cannot end in the future",
      );
    }
    if (config.windowEnd + this.config.logsLagMs > this.clock.now()) {
      // Trusted explicit coverage policy: a window is only due after the
      // source lag allowance, so missing in-flight telemetry is never read
      // as a complete zero-count sample.
      return portOk(
        this.missingSample(config, "log source lag has not elapsed"),
      );
    }

    const accumulator = new CohortAccumulatorV1();
    const kinds = {
      timeoutFailureKinds: this.config.timeoutFailureKinds,
      upstreamWideFailureKinds: this.config.upstreamWideFailureKinds,
    };
    let cursor: string | null = null;
    let pages = 0;
    let reason: string | null = null;
    for (;;) {
      pages++;
      if (pages > DENO_MAX_LOG_PAGES) {
        reason = "log pagination exceeded the page bound";
        break;
      }
      const page = await this.readLogPage(config, cursor);
      if (!page.ok) {
        if (cursor === null && pages === 1) return page;
        reason = "log pagination was interrupted";
        break;
      }
      const parsed = page.value;
      for (const entry of parsed.entries) {
        accumulator.add(
          parseCohortMessage(entry.message, config.identity),
          kinds,
        );
      }
      for (let i = 0; i < parsed.unreadableEntries; i++) {
        accumulator.add({ kind: "unreadable" }, kinds);
      }
      if (parsed.nextCursor === null) {
        cursor = null;
        break;
      }
      cursor = parsed.nextCursor;
    }

    const counts = accumulator.counts();
    if (reason === null && counts.unreadableCount > 0) {
      reason = "log scan contained unreadable entries";
    }
    if (reason === null && counts.unresolvedOutcomeCount > 0) {
      // A terminal whose accepted event is outside this exact window is a
      // request outcome we cannot safely join to this sample. Preserve the
      // gap explicitly; silently dropping it would make a long-running
      // failure disappear from acceptance telemetry.
      reason = "log scan contained unresolved request outcomes";
    }
    if (reason !== null) {
      // The observed aggregates are preserved with the incompleteness made
      // explicit; a partial scan is never a complete zero-count sample and a
      // missing scan is all-null.
      if (counts.acceptedCount === 0) {
        return portOk(this.missingSample(config, reason));
      }
      return portOk({
        identity: config.identity,
        windowStart: config.windowStart,
        windowEnd: config.windowEnd,
        sampledAt: this.clock.now(),
        domain: config.domain,
        requestCount: counts.acceptedCount,
        fiveXxCount: counts.fiveXxCount,
        timeoutCount: counts.timeoutCount,
        streamFailureCount: counts.streamFailureCount,
        upstreamWideFault: counts.upstreamWideCount > 0,
        coverage: { status: "incomplete", reason, nextCursor: null },
      });
    }

    return portOk({
      identity: config.identity,
      windowStart: config.windowStart,
      windowEnd: config.windowEnd,
      sampledAt: this.clock.now(),
      domain: config.domain,
      requestCount: counts.acceptedCount,
      fiveXxCount: counts.fiveXxCount,
      timeoutCount: counts.timeoutCount,
      streamFailureCount: counts.streamFailureCount,
      upstreamWideFault: counts.upstreamWideCount > 0,
      coverage: { status: "complete" },
    });
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------

  private missingSample(
    config: MetricsSampleConfigV1,
    detail: string,
  ): MetricsSampleV1 {
    return {
      identity: config.identity,
      windowStart: config.windowStart,
      windowEnd: config.windowEnd,
      sampledAt: this.clock.now(),
      domain: config.domain,
      requestCount: null,
      fiveXxCount: null,
      timeoutCount: null,
      streamFailureCount: null,
      upstreamWideFault: null,
      coverage: { status: "incomplete", reason: detail, nextCursor: null },
    };
  }

  private identityFromHeaders(headers: Headers): DeploymentIdentityV1 | null {
    const gitSha = headers.get(this.config.identityHeaders.gitSha) ?? null;
    const revisionId = headers.get(this.config.identityHeaders.revisionId) ??
      null;
    if (gitSha === null || revisionId === null) return null;
    if (!/^[0-9a-f]{40}$/.test(gitSha)) return null;
    if (revisionId.length === 0 || revisionId.length > 256) return null;
    return { gitSha: gitSha as GitSha, revisionId };
  }

  private async unauthenticatedGet(
    baseUrl: string,
    path: string,
  ): Promise<
    PortResultV1<
      { status: number; body: Uint8Array; headers: [string, string][] }
    >
  > {
    // Finite whole-operation deadline plus a streaming byte cap: the health
    // probe cannot hang the release loop on a stuck peer.
    const controller = new AbortController();
    let expired = false;
    let resolveHappened: () => void = () => {};
    const happened = new Promise<void>((resolve) => {
      resolveHappened = resolve;
    });
    const timer = setTimeout(() => {
      expired = true;
      try {
        controller.abort();
      } catch {
        // Best-effort teardown.
      }
      resolveHappened();
    }, DENO_HEALTH_TIMEOUT_MS);
    try {
      const response = await Promise.race([
        this.transport(`${baseUrl}${path}`, {
          method: "GET",
          redirect: "error",
          signal: controller.signal,
        }),
        happened.then((): never => {
          throw new Error("health deadline");
        }),
      ]);
      const headers: [string, string][] = [];
      response.headers.forEach((value, name) => headers.push([name, value]));
      if (response.body === null) {
        return portOk({
          status: response.status,
          body: new Uint8Array(),
          headers,
        });
      }
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const outcome = await Promise.race([
          reader.read().then(
            (result) => ({ kind: "chunk" as const, result }),
            (): { kind: "failed" } => ({ kind: "failed" as const }),
          ),
          happened.then((): { kind: "expired" } => ({
            kind: "expired" as const,
          })),
        ]);
        if (expired || outcome.kind === "expired") {
          return portError(
            "unavailable",
            "health endpoint exceeded the time bound",
          );
        }
        if (outcome.kind === "failed") {
          return portError(
            "unavailable",
            "health response body could not be read",
          );
        }
        if (outcome.result.done) break;
        if (outcome.result.value.byteLength > DENO_MAX_RESPONSE_BYTES - total) {
          return portError("invalid", "health response exceeds the byte bound");
        }
        total += outcome.result.value.byteLength;
        parts.push(new Uint8Array(outcome.result.value));
      }
      const body = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        body.set(part, offset);
        offset += part.byteLength;
      }
      return portOk({ status: response.status, body, headers });
    } catch {
      return portError("unavailable", "health endpoint is unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  private async listSucceededRevisions(
    projectId: string,
  ): Promise<PortResultV1<RevisionListItemV1[]>> {
    const params = new URLSearchParams({
      status: "succeeded",
      limit: String(DENO_REVISIONS_PAGE_LIMIT),
    });
    const call = await denoRestCall(
      {
        baseUrl: this.config.apiBaseUrl,
        path: `/v2/apps/${encodeURIComponent(projectId)}/revisions`,
        query: params,
        method: "GET",
        responseByteCap: DENO_MAX_RESPONSE_BYTES,
      },
      this.transport,
      this.auth,
    );
    if (!call.ok) return call;
    if (call.value.status !== 200) {
      return portError("unavailable", "revision listing is unavailable");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(call.value.body));
    } catch {
      return portError("invalid", "revision listing is not valid JSON");
    }
    if (!Array.isArray(parsed)) {
      return portError("invalid", "revision listing has an unexpected shape");
    }
    if (parsed.length >= DENO_REVISIONS_PAGE_LIMIT) {
      // The documented response envelope is a bare array with no cursor
      // field, so a full page cannot be proven complete. Fail closed instead
      // of guessing that a match does or does not exist beyond it.
      return portError(
        "invalid",
        "revision listing is inconclusive at the page bound",
      );
    }
    const items: RevisionListItemV1[] = [];
    for (const raw of parsed) {
      const item = parseRevisionListItem(raw);
      if (item === null) {
        return portError("invalid", "revision listing has a malformed entry");
      }
      items.push(item);
    }
    return portOk(items);
  }

  private async readRevision(
    revisionId: string,
  ): Promise<PortResultV1<RevisionResourceV1>> {
    const call = await denoRestCall(
      {
        baseUrl: this.config.apiBaseUrl,
        path: `/v2/revisions/${encodeURIComponent(revisionId)}`,
        method: "GET",
        responseByteCap: DENO_MAX_RESPONSE_BYTES,
      },
      this.transport,
      this.auth,
    );
    if (!call.ok) return call;
    if (call.value.status !== 200) {
      return portError("unavailable", "revision resource is unavailable");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(call.value.body));
    } catch {
      return portError("invalid", "revision resource is not valid JSON");
    }
    const item = parseRevisionResource(parsed);
    if (item === null) {
      return portError("invalid", "revision resource has a malformed shape");
    }
    return portOk(item);
  }

  private async readTimelines(
    revisionId: string,
  ): Promise<PortResultV1<{ domains: string[] }[]>> {
    const call = await denoRestCall(
      {
        baseUrl: this.config.apiBaseUrl,
        path: `/v2/revisions/${encodeURIComponent(revisionId)}/timelines`,
        method: "GET",
        responseByteCap: DENO_MAX_RESPONSE_BYTES,
      },
      this.transport,
      this.auth,
    );
    if (!call.ok) return call;
    if (call.value.status !== 200) {
      return portError("unavailable", "revision timelines are unavailable");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(call.value.body));
    } catch {
      return portError("invalid", "revision timelines are not valid JSON");
    }
    if (!Array.isArray(parsed)) {
      return portError(
        "invalid",
        "revision timelines have an unexpected shape",
      );
    }
    const timelines: { domains: string[] }[] = [];
    for (const raw of parsed) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return portError("invalid", "revision timeline has a malformed entry");
      }
      const domains = (raw as Record<string, unknown>).domains;
      if (!Array.isArray(domains)) {
        return portError("invalid", "revision timeline is missing domains");
      }
      const hostnames: string[] = [];
      for (const entry of domains) {
        if (
          typeof entry !== "object" || entry === null || Array.isArray(entry)
        ) {
          return portError(
            "invalid",
            "revision timeline has a malformed domain",
          );
        }
        const domainValue = (entry as Record<string, unknown>).domain;
        if (typeof domainValue !== "string" || domainValue.length === 0) {
          return portError(
            "invalid",
            "revision timeline has a malformed domain",
          );
        }
        hostnames.push(domainValue);
      }
      timelines.push({ domains: hostnames });
    }
    return portOk(timelines);
  }

  private async readLogPage(
    config: MetricsSampleConfigV1,
    cursor: string | null,
  ): Promise<
    PortResultV1<{
      entries: { message: string }[];
      unreadableEntries: number;
      nextCursor: string | null;
    }>
  > {
    const query = new URLSearchParams({
      start: toRfc3339(config.windowStart),
      end: toRfc3339(config.windowEnd),
      revision_id: config.identity.revisionId,
      limit: String(DENO_LOGS_PAGE_LIMIT),
    });
    if (cursor !== null) query.set("cursor", cursor);
    const call = await denoRestCall(
      {
        baseUrl: this.config.apiBaseUrl,
        path: `/v2/apps/${
          encodeURIComponent(
            this.config.projectId,
          )
        }/logs`,
        query,
        method: "GET",
        responseByteCap: DENO_MAX_LOG_PAGE_BYTES,
      },
      this.transport,
      this.auth,
    );
    if (!call.ok) return call;
    if (call.value.status !== 200) {
      return portError("unavailable", "log resource is unavailable");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(call.value.body));
    } catch {
      return portError("invalid", "log response is not valid JSON");
    }
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      return portError("invalid", "log response has an unexpected shape");
    }
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.logs)) {
      return portError("invalid", "log response is missing the logs array");
    }
    const entries: { message: string }[] = [];
    let unreadableEntries = 0;
    for (const raw of obj.logs) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        unreadableEntries++;
        continue;
      }
      const entry = raw as Record<string, unknown>;
      const revisionId = entry.revision_id;
      const message = entry.message;
      if (
        typeof revisionId !== "string" ||
        revisionId !== config.identity.revisionId ||
        typeof message !== "string"
      ) {
        unreadableEntries++;
        continue;
      }
      entries.push({ message });
    }
    const rawNextCursor = obj.next_cursor;
    if (rawNextCursor === null) {
      return portOk({ entries, unreadableEntries, nextCursor: null });
    }
    if (typeof rawNextCursor !== "string" || rawNextCursor.length === 0) {
      return portError("invalid", "log response has a malformed next cursor");
    }
    const nextCursor = rawNextCursor;
    return portOk({ entries, unreadableEntries, nextCursor });
  }
}

// ---------------------------------------------------------------------------
// Shape parsers (local, sanitized; no platform payload echoing).
// ---------------------------------------------------------------------------

function parseRevisionListItem(
  input: unknown,
): RevisionListItemV1 | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const obj = input as Record<string, unknown>;
  const id = obj.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 256) {
    return null;
  }
  const status = obj.status;
  if (typeof status !== "string" || status !== "succeeded") return null;
  const labels = parseLabels(obj.labels);
  if (labels === null) return null;
  const createdAt = typeof obj.created_at === "string"
    ? parseIsoMs(obj.created_at)
    : null;
  return { id, status, labels, createdAt };
}

function parseRevisionResource(
  input: unknown,
): RevisionResourceV1 | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const obj = input as Record<string, unknown>;
  const id = obj.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 256) {
    return null;
  }
  const status = obj.status;
  if (typeof status !== "string") return null;
  const labels = parseLabels(obj.labels);
  if (labels === null) return null;
  return { id, status, labels };
}

function parseLabels(input: unknown): Record<string, string | string[]> | null {
  if (input === null || input === undefined) return {};
  if (typeof input !== "object" || Array.isArray(input)) return null;
  const labels: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") {
      labels[key] = value;
      continue;
    }
    if (
      Array.isArray(value) && value.every((item) => typeof item === "string")
    ) {
      labels[key] = value as string[];
      continue;
    }
    return null;
  }
  return labels;
}

function stringLabel(
  labels: Record<string, string | string[]>,
  key: string,
): string | null {
  const value = labels[key];
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

function headerEquals(
  headers: Headers,
  name: string,
  value: string,
): boolean {
  return (headers.get(name) ?? null) === value;
}

/**
 * The target's identified Cloudflare warning exception: an HTTP 403 that is
 * demonstrably a Cloudflare Bot Fight Mode challenge (the gateway runner was
 * challenged, not the application). Identification requires the Cloudflare
 * `server` and `cf-mitigated: challenge` headers plus a non-empty `cf-ray`;
 * a 403 without all three is an application/origin 403 and is never
 * claimed to be a Cloudflare challenge.
 */
function isVerifiedCloudflareChallenge(headers: Headers): boolean {
  const server = headers.get("server")?.trim().toLowerCase() ?? "";
  const mitigation = headers.get("cf-mitigated")?.trim().toLowerCase() ?? "";
  const ray = headers.get("cf-ray")?.trim() ?? "";
  return server === "cloudflare" && mitigation === "challenge" &&
    ray.length > 0;
}

function toRfc3339(ms: number): string {
  return new Date(ms).toISOString();
}

function parseIsoMs(text: string): number | null {
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}
