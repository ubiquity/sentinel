/**
 * DenoReleasePort implementation over the documented Deno REST API plus the
 * managed/custom domain health endpoints.
 *
 * Endpoints and resource identity fields (no invented API):
 * - GET  /v2/apps/{app}/revisions?status=succeeded&limit=N[&cursor=...]
 *   → RevisionListItem[] (id, status, labels, created_at); pagination
 *   continuation is the rel=next Link response header, whose cursor is
 *   extracted and replayed on the configured API origin
 * - GET  /v2/revisions/{revision}                            → Revision
 * - POST /v2/revisions/{revision}/promote                    → 204 No Content
 * - GET  /v2/apps/{app}/logs?start&end&revision_id&limit&cursor
 *   → { logs:[{timestamp,level,message,revision_id}], next_cursor }
 *
 * Identity is always the pair {gitSha, revisionId}; a revision id alone, a
 * timestamp or the latest list item is never a substitute. The candidate
 * lookup takes the EXACT revision id from the authenticated build-receipt
 * resolver and proves its membership in the configured app by bounded page
 * traversal (never time/list-order selection) plus the exact revision
 * resource. Two same-SHA builds never bind the wrong receipt: the revision id
 * is the unique platform selector and the build transaction id remains
 * resolver-provided provenance that this module never infers or labels.
 *
 * The client is constructed with trusted config (project id, identity header
 * names, log classification, bounds) plus injected transports, auth and
 * clock; no environment variable or CLI surface exists.
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
  DENO_MANAGED_HOST_RE,
  DENO_MAX_LOG_PAGE_BYTES,
  DENO_MAX_LOG_PAGES,
  DENO_MAX_RESPONSE_BYTES,
  DENO_REVISION_CURSOR_MAX_CHARS,
  DENO_REVISION_TRAVERSAL_MAX_PAGES,
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

/** Validated exact Git SHA (40 lower-hex) accepted as the receipt revision. */
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
/**
 * Validated exact Deno revision id charset for the immutable hostname form:
 * the id is used as a single hostname label, so dots (subdomain boundaries)
 * are never accepted. Bounded by the local implementation constant.
 */
const DENO_REVISION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Aggregate entry bound across one page traversal (page size x pages). */
const DENO_REVISION_TRAVERSAL_MAX_ENTRIES = DENO_REVISIONS_PAGE_LIMIT *
  DENO_REVISION_TRAVERSAL_MAX_PAGES;
/** Official console origin whose Link header form is the only accepted one. */
const DENO_CONSOLE_ORIGIN = "https://console.deno.com";

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
  // Candidate build lookup: exact receipt revision, no list-order selection.
  // -------------------------------------------------------------------------

  async findBuiltCandidate(
    projectId: string,
    revision: GitSha,
    buildTransactionId: string,
    revisionId: string,
  ): Promise<PortResultV1<BuildLookupV1>> {
    if (projectId !== this.config.projectId) {
      return portError(
        "invalid",
        "candidate project does not match the configured target",
      );
    }
    if (!GIT_SHA_RE.test(revision)) {
      return portError("invalid", "candidate revision is not a valid Git SHA");
    }
    if (!DENO_REVISION_ID_RE.test(revisionId)) {
      return portError(
        "invalid",
        "candidate revision id cannot form an immutable hostname",
      );
    }
    const items = await this.listSucceededRevisions(projectId);
    if (!items.ok) return items;

    // The receipt selects the EXACT revision id. A different build for the
    // same SHA is irrelevant; a duplicate exact id is never "found"; the
    // transaction id is receipt provenance only (not a platform label).
    const matches = items.value.filter((item) => item.id === revisionId);
    if (matches.length > 1) {
      return portOk({ status: "ambiguous" as const });
    }
    if (matches.length === 0) {
      // The exact receipt revision is not a succeeded build of the configured
      // app: not built (or not visible) yet. Never an order/time substitution.
      return portOk({ status: "none" as const });
    }
    const item = matches[0];
    const resource = await this.readRevision(item.id);
    if (!resource.ok) return resource;
    if (
      resource.value.id !== item.id ||
      resource.value.status !== "succeeded"
    ) {
      return portOk({ status: "ambiguous" as const });
    }

    // The immutable deployment host is derived from the trusted managed base
    // URL (never from any platform-supplied URL) and must serve the exact
    // receipt identity in both body and headers with an available status.
    const immutableBase = immutableManagedBaseUrl(
      this.config.managedBaseUrl,
      revisionId,
    );
    if (immutableBase === null) {
      return portError(
        "invalid",
        "managed host cannot form an immutable health URL",
      );
    }
    const health = await this.sampleHealth({
      baseUrl: immutableBase,
      healthPath: this.config.acceptance.healthPath,
      managedBodyMarker: this.config.acceptance.managedBodyMarker,
      managedHeaders: [
        ...this.config.acceptance.managedHeaders,
        { name: this.config.identityHeaders.gitSha, value: revision },
        {
          name: this.config.identityHeaders.revisionId,
          value: revisionId,
        },
      ],
      domain: null,
    });
    if (
      !health.ok ||
      health.value.httpStatus !== 200 ||
      health.value.status !== "healthy" ||
      health.value.identity === null ||
      health.value.identity.gitSha !== revision ||
      health.value.identity.revisionId !== revisionId
    ) {
      // Missing/failed/wrong immutable identity must never yield "found".
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
  // Current deployment: strict managed health identity, then exact app
  // membership/resource verification, then a stable recheck. No timeline
  // enumeration and no label/order/time inference of the pinned revision.
  // -------------------------------------------------------------------------

  async readCurrentDeployment(
    projectId: string,
  ): Promise<PortResultV1<DenoDeploymentV1>> {
    if (projectId !== this.config.projectId) {
      return portError(
        "invalid",
        "deployment project does not match the configured target",
      );
    }
    const domain = this.config.acceptance.domain ??
      new URL(this.config.managedBaseUrl).host;
    const healthConfig = this.managedHealthConfig(null);
    const observed = await this.sampleHealth(healthConfig);
    if (
      !observed.ok ||
      observed.value.httpStatus !== 200 ||
      observed.value.status !== "healthy" ||
      observed.value.identity === null
    ) {
      // Unknown or unavailable health is never claimed healthy or as a
      // positive not-deployed result; no identity is inferred from it.
      return portOk({
        projectId,
        identity: null,
        domain,
        status: "unknown",
        updatedAt: null,
      });
    }
    const identity = observed.value.identity;

    const items = await this.listSucceededRevisions(projectId);
    if (!items.ok) return items;
    const matches = items.value.filter(
      (item) => item.id === identity.revisionId,
    );
    if (matches.length !== 1) {
      // Absent or duplicated exact membership: the platform cannot
      // corroborate the observed deployment. Never select by position/order.
      return portOk({
        projectId,
        identity: null,
        domain,
        status: "unknown",
        updatedAt: null,
      });
    }
    const item = matches[0];
    const resource = await this.readRevision(item.id);
    if (!resource.ok) return resource;
    if (
      resource.value.id !== item.id ||
      resource.value.status !== "succeeded"
    ) {
      return portOk({
        projectId,
        identity: null,
        domain,
        status: "unknown",
        updatedAt: null,
      });
    }

    // Stable recheck: the identity must be unchanged across the verification
    // steps, otherwise the deployment moved and no live claim is made.
    const recheck = await this.sampleHealth(healthConfig);
    if (
      !recheck.ok ||
      recheck.value.httpStatus !== 200 ||
      recheck.value.status !== "healthy" ||
      recheck.value.identity === null ||
      !sameIdentity(recheck.value.identity, identity)
    ) {
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
      identity,
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
  // Health sampling: parsed available JSON body + exact body/header identity.
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
    // The verified identity requires BOTH the validated identity headers and
    // the parsed body `release.git_sha`/`release.deployment_id` to present
    // the same exact identity with an available status. Any missing,
    // malformed or contradictory body/header identity is degraded with no
    // verified identity; it is never healthy and never an inference.
    const verifiedIdentity = this.verifiedBodyIdentity(bodyText, headers);
    const healthy = bodyMarkerPresent && headersMatch &&
      verifiedIdentity !== null;
    return portOk({
      at: this.clock.now(),
      status: healthy ? "healthy" : "degraded",
      httpStatus: status,
      bodyMarkerPresent,
      headersMatch,
      identity: healthy ? verifiedIdentity : null,
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

  /** Managed stable health config derived from the trusted target config. */
  private managedHealthConfig(domain: string | null): HealthSampleConfigV1 {
    return {
      baseUrl: this.config.managedBaseUrl,
      healthPath: this.config.acceptance.healthPath,
      managedBodyMarker: this.config.acceptance.managedBodyMarker,
      managedHeaders: [...this.config.acceptance.managedHeaders],
      domain,
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

  /**
   * Verified identity of one 200 health response: the parsed JSON body must
   * report `status: "available"` and `release.git_sha`/`release.deployment_id`
   * equal to the validated identity headers. Missing, malformed or
   * contradictory body/header identity yields null — never an inference.
   */
  private verifiedBodyIdentity(
    bodyText: string,
    headers: Headers,
  ): DeploymentIdentityV1 | null {
    const headerIdentity = this.identityFromHeaders(headers);
    if (headerIdentity === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return null;
    }
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.status !== "available") return null;
    const release = obj.release;
    if (
      typeof release !== "object" || release === null || Array.isArray(release)
    ) {
      return null;
    }
    const releaseObj = release as Record<string, unknown>;
    const gitSha = releaseObj.git_sha;
    const revisionId = releaseObj.deployment_id;
    if (
      typeof gitSha !== "string" || typeof revisionId !== "string" ||
      !GIT_SHA_RE.test(gitSha) ||
      revisionId.length === 0 ||
      revisionId.length > 256
    ) {
      return null;
    }
    const bodyIdentity: DeploymentIdentityV1 = {
      gitSha: gitSha as GitSha,
      revisionId,
    };
    if (
      bodyIdentity.gitSha !== headerIdentity.gitSha ||
      bodyIdentity.revisionId !== headerIdentity.revisionId
    ) {
      return null;
    }
    return bodyIdentity;
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
    const items: RevisionListItemV1[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      pages++;
      if (pages > DENO_REVISION_TRAVERSAL_MAX_PAGES) {
        return portError(
          "invalid",
          "revision listing exceeded the page bound",
        );
      }
      const page = await this.readRevisionPage(projectId, cursor);
      if (!page.ok) return page;
      for (const item of page.value.items) {
        if (seenIds.has(item.id)) {
          // A repeated exact id across pages makes the listing inconsistent:
          // no single entry can be bound.
          return portError(
            "invalid",
            "revision listing contains a duplicate exact id",
          );
        }
        seenIds.add(item.id);
        items.push(item);
        if (items.length > DENO_REVISION_TRAVERSAL_MAX_ENTRIES) {
          return portError(
            "invalid",
            "revision listing exceeded the entry bound",
          );
        }
      }
      if (page.value.nextCursor === null) {
        if (page.value.items.length >= DENO_REVISIONS_PAGE_LIMIT) {
          // A full page with no usable continuation is inconclusive: the
          // exact membership proof is incomplete and fails closed.
          return portError(
            "invalid",
            "revision listing is inconclusive at the page bound",
          );
        }
        // A normal final shorter page without a continuation is exhausted.
        return portOk(items);
      }
      if (seenCursors.has(page.value.nextCursor)) {
        return portError(
          "invalid",
          "revision listing repeated a pagination cursor",
        );
      }
      seenCursors.add(page.value.nextCursor);
      cursor = page.value.nextCursor;
    }
  }

  private async readRevisionPage(
    projectId: string,
    cursor: string | null,
  ): Promise<
    PortResultV1<{ items: RevisionListItemV1[]; nextCursor: string | null }>
  > {
    const params = new URLSearchParams({
      status: "succeeded",
      limit: String(DENO_REVISIONS_PAGE_LIMIT),
    });
    if (cursor !== null) params.set("cursor", cursor);
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
    const items: RevisionListItemV1[] = [];
    for (const raw of parsed) {
      const item = parseRevisionListItem(raw);
      if (item === null) {
        return portError("invalid", "revision listing has a malformed entry");
      }
      items.push(item);
    }
    const headers = new Headers();
    for (const [name, value] of call.value.headers) {
      headers.set(name, value);
    }
    const parsedLink = parseNextLinkCursor(
      headers.get("link") ?? null,
      projectId,
      this.config.apiBaseUrl,
    );
    if (!parsedLink.ok) return parsedLink;
    return portOk({ items, nextCursor: parsedLink.value });
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

function sameIdentity(
  a: DeploymentIdentityV1,
  b: DeploymentIdentityV1,
): boolean {
  return a.gitSha === b.gitSha && a.revisionId === b.revisionId;
}

/**
 * Derives the immutable health base URL for one exact revision from the
 * trusted configured managed base URL. Only the config-validated root HTTPS
 * shape is accepted (https, no credentials, default port, no path/query/
 * fragment, hostname ending in `.deno.net` — the actual two-label target is
 * `<project>.<organization>.deno.net`), and the FIRST hostname label is
 * replaced with `label-<revisionId>` while every other label stays (Deno's
 * immutable hostname form). The first label need not equal the configured
 * project id; no platform-supplied URL is ever consumed.
 */
function immutableManagedBaseUrl(
  managedBaseUrl: string,
  revisionId: string,
): string | null {
  if (!DENO_REVISION_ID_RE.test(revisionId)) return null;
  let url: URL;
  try {
    url = new URL(managedBaseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.port !== "") return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  if (url.search !== "" || url.hash !== "") return null;
  const hostname = url.hostname;
  if (!DENO_MANAGED_HOST_RE.test(hostname)) return null;
  const dotIndex = hostname.indexOf(".");
  if (dotIndex <= 0) return null;
  const firstLabel = hostname.slice(0, dotIndex);
  const immutableHost = `${firstLabel}-${revisionId}${
    hostname.slice(firstLabel.length)
  }`;
  return `${url.protocol}//${immutableHost}`;
}

const LINK_VALUE_RE = /^<([^>]*)>([\s\S]*)$/;
const LINK_REL_RE = /^rel\s*=\s*(?:"([^"]*)"|([^\s;]+))$/i;

/**
 * Parses the rel=next Link header of one revision page. Returns the single
 * validated continuation cursor or null when the page has no rel=next link.
 * Multiple/conflicting next links, malformed link-values and any next link
 * that is not for the configured project on the configured API origin or the
 * official Deno console origin are rejected. The returned cursor is replayed
 * on the configured API origin by the caller; the Link URL is never fetched.
 */
function parseNextLinkCursor(
  linkHeader: string | null,
  projectId: string,
  apiBaseUrl: string,
): PortResultV1<string | null> {
  if (linkHeader === null) return portOk(null);
  const linkValues = linkHeader.split(",");
  let nextUrl: string | null = null;
  let malformed = false;
  for (const part of linkValues) {
    const value = part.trim();
    if (value.length === 0) {
      malformed = true;
      continue;
    }
    const parsed = parseLinkValue(value);
    if (parsed === null) {
      malformed = true;
      continue;
    }
    if (!parsed.isNext) continue;
    if (nextUrl !== null) {
      return portError(
        "invalid",
        "revision listing has multiple or conflicting next links",
      );
    }
    nextUrl = parsed.url;
  }
  if (malformed) {
    return portError("invalid", "revision listing has a malformed Link header");
  }
  if (nextUrl === null) return portOk(null);
  return parseNextLinkUrl(nextUrl, projectId, apiBaseUrl);
}

function parseLinkValue(raw: string): { url: string; isNext: boolean } | null {
  const match = LINK_VALUE_RE.exec(raw);
  if (match === null) return null;
  const params = match[2];
  let isNext = false;
  if (params.length > 0) {
    for (const param of params.split(";")) {
      const trimmed = param.trim();
      if (trimmed.length === 0) continue;
      const relMatch = LINK_REL_RE.exec(trimmed);
      if (relMatch === null) continue;
      const rel = (relMatch[1] ?? relMatch[2] ?? "").toLowerCase();
      if (rel.split(/\s+/).includes("next")) isNext = true;
    }
  }
  return { url: match[1], isNext };
}

function parseNextLinkUrl(
  rawUrl: string,
  projectId: string,
  apiBaseUrl: string,
): PortResultV1<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return portError("invalid", "revision next link is not a valid URL");
  }
  if (url.username !== "" || url.password !== "") {
    return portError("invalid", "revision next link carries credentials");
  }
  if (url.hash !== "") {
    return portError("invalid", "revision next link carries a fragment");
  }
  const accepted = (url.origin === new URL(apiBaseUrl).origin &&
    url.pathname === `/v2/apps/${projectId}/revisions`) ||
    (url.origin === DENO_CONSOLE_ORIGIN &&
      url.pathname === `/api/v2/apps/${projectId}/revisions`);
  if (!accepted) {
    return portError(
      "invalid",
      "revision next link is not for the configured project",
    );
  }
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (seen.has(key)) {
      return portError(
        "invalid",
        "revision next link repeats a query parameter",
      );
    }
    seen.add(key);
    if (key === "cursor") continue;
    if (key === "status" && url.searchParams.get("status") === "succeeded") {
      continue;
    }
    if (
      key === "limit" &&
      url.searchParams.get("limit") === String(DENO_REVISIONS_PAGE_LIMIT)
    ) {
      continue;
    }
    return portError(
      "invalid",
      "revision next link changes the listing semantics",
    );
  }
  const cursors = url.searchParams.getAll("cursor");
  if (cursors.length !== 1) {
    return portError(
      "invalid",
      "revision next link has an absent or duplicate cursor",
    );
  }
  const cursor = cursors[0];
  if (cursor.length === 0 || cursor.length > DENO_REVISION_CURSOR_MAX_CHARS) {
    return portError("invalid", "revision next link has an invalid cursor");
  }
  return portOk(cursor);
}

function toRfc3339(ms: number): string {
  return new Date(ms).toISOString();
}

function parseIsoMs(text: string): number | null {
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}
