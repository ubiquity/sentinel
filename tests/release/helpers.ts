// m05 test-only helpers: a scripted stateful transport over the documented
// Deno REST/health endpoints, a controllable receipt resolver, a test clock,
// and real temporary Git state fixtures. No production state branch is
// created anywhere; every write targets disposable local bare repositories.
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { Clock } from "../../src/contracts/ports.ts";
import type { DeploymentIdentityV1 } from "../../src/contracts/shared.ts";
import type { StabilityPolicyV1 } from "../../src/contracts/repository-config.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import { parseReleaseRequestV1 } from "../../src/contracts/release.ts";
import { GitStateStore } from "../../src/state/mod.ts";
import type { GitRunnerV1 } from "../../src/state/mod.ts";
import type { ReleaseTargetConfigV1 } from "../../src/release/config.ts";
import type {
  BuildReceiptLookupV1,
  BuildReceiptResolverV1,
} from "../../src/release/resolver.ts";
import type { PortResultV1 } from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { DenoHttpTransportV1 } from "../../src/release/http.ts";
import {
  gitRun,
  makeRemoteCtx,
  releaseRequest,
  REPO,
  SHA1,
  SHA2,
  T0,
  testGitEnv,
} from "../state/helpers.ts";

export { releaseRequest, REPO, SHA1, SHA2, T0 };

export const DEP_0: DeploymentIdentityV1 = {
  gitSha: SHA2,
  revisionId: "dep-0000",
};
export const DEP_1: DeploymentIdentityV1 = {
  gitSha: SHA1,
  revisionId: "dep-0001",
};
export const DEP_X: DeploymentIdentityV1 = {
  gitSha: "1111111111111111111111111111111111111111" as GitSha,
  revisionId: "dep-0009",
};

export const MANAGED_URL = "https://managed.example";
export const CUSTOM_URL = "https://ai.ubq.fi";
export const API_URL = "https://api.deno.com";
export const PROJECT_ID = "project-ubq";
export const HEALTH_HEADERS = {
  "cache-control": "no-store",
} as const;
export const BODY_MARKER = '"status":"available"';
export const GIT_SHA_HEADER = "x-uos-git-sha";
export const REVISION_HEADER = "x-uos-deployment-id";

export function targetConfig(
  overrides: Partial<ReleaseTargetConfigV1> = {},
): ReleaseTargetConfigV1 {
  return {
    projectId: PROJECT_ID,
    apiBaseUrl: API_URL,
    managedBaseUrl: MANAGED_URL,
    customBaseUrl: CUSTOM_URL,
    acceptance: {
      healthPath: "/health",
      metricsPath: "/health",
      managedBodyMarker: BODY_MARKER,
      managedHeaders: [],
      domain: "ai.ubq.fi",
    },
    identityHeaders: {
      gitSha: GIT_SHA_HEADER,
      revisionId: REVISION_HEADER,
    },
    gitShaLabelKey: "git.sha",
    buildTransactionLabelKey: "sentinel.build_transaction_id",
    timeoutFailureKinds: ["upstream_timeout"],
    upstreamWideFailureKinds: ["upstream_error", "empty_upstream_completion"],
    logsLagMs: 5_000,
    ...overrides,
  };
}

export function stabilityPolicy(
  overrides: Partial<StabilityPolicyV1> = {},
): StabilityPolicyV1 {
  return {
    windowMs: 30 * 60 * 1000,
    sampleIntervalMs: 30 * 1000,
    minSamples: 60,
    minRequests: 50,
    baselineWindowMs: 30 * 60 * 1000,
    baselineMinSamples: 60,
    thresholds: [
      {
        metric: "five_xx_rate",
        maxRate: 0.02,
        maxIncrease: 0.01,
      },
      {
        metric: "timeout_rate",
        maxRate: 0.01,
        maxIncrease: 0.01,
      },
      {
        metric: "stream_failure_rate",
        maxRate: 0.01,
        maxIncrease: 0.01,
      },
    ],
    ...overrides,
  };
}

/** Deterministic test clock; the controller only advances by explicit ticks. */
export class TestClock implements Clock {
  private current = T0;

  constructor(start = T0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  at(ms: number): void {
    this.current = ms;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

// ---------------------------------------------------------------------------
// Scripted transport.
// ---------------------------------------------------------------------------

export interface RouteCallV1 {
  method: string;
  pathname: string;
  search: string;
  authorization: string | null;
}

export type RouteResponseV1 =
  | {
    kind: "response";
    status: number;
    headers?: Record<string, string>;
    body?: string;
  }
  | { kind: "reject" };

export interface RouteV1 {
  method: string;
  /** Exact pathname, or a RegExp.source string starting with "^". */
  pathname: string;
  respond: (url: URL) => RouteResponseV1 | Promise<RouteResponseV1>;
}

/**
 * Stateful scripted transport: routes by method + pathname; queries and the
 * mutable deployed state are visible to route handlers. Every call is
 * recorded (method/path/query/authz) so tests can prove exactly which effects
 * were attempted and how often.
 */
export class ScriptedTransport {
  readonly calls: RouteCallV1[] = [];
  /** Exact identity currently served by the managed/custom domains. */
  deployed: DeploymentIdentityV1 = DEP_0;
  /** Mutable per-test behavior. */
  customStatus: number = 200;
  customCloudflare: boolean = false;
  identityOverride: DeploymentIdentityV1 | null = null;
  customIdentityOverride: DeploymentIdentityV1 | null = null;
  /** When true, the logs endpoint rejects (transport failure). */
  logsReject: boolean = false;
  /** Known succeeded revisions (set by installREST); used by promote routes. */
  revisions: DeploymentIdentityV1[] = [];
  private routes: RouteV1[] = [];

  constructor(readonly config: ReleaseTargetConfigV1 = targetConfig()) {}

  route(entry: RouteV1): this {
    this.routes.push(entry);
    return this;
  }

  any(method: string, pattern: RegExp, respond: RouteV1["respond"]): this {
    this.routes.push({ method, pathname: pattern.source, respond });
    return this;
  }

  private identity(): DeploymentIdentityV1 {
    return this.identityOverride ?? this.deployed;
  }

  /** Managed-domain health: 200 + exact body marker + identity headers. */
  health(path = "/health"): this {
    const managedBase = new URL(this.config.managedBaseUrl);
    const customBase = this.config.customBaseUrl === null
      ? null
      : new URL(this.config.customBaseUrl);
    if (customBase !== null) {
      this.any(
        "GET",
        new RegExp(
          `^${escapeRegExp(customBase.href.slice(0, -1))}${
            escapeRegExp(path)
          }$`,
        ),
        () => this.customHealthResponse(),
      );
    }
    this.any(
      "GET",
      new RegExp(
        `^${escapeRegExp(managedBase.href.slice(0, -1))}${escapeRegExp(path)}$`,
      ),
      () => this.identityHealthResponse(200),
    );
    return this;
  }

  private customHealthResponse(): RouteResponseV1 {
    if (this.customStatus === 403) {
      return {
        kind: "response",
        status: 403,
        headers: this.customCloudflare
          ? { server: "cloudflare", "cf-ray": "abc123" }
          : {},
        body: "Forbidden",
      };
    }
    return this.identityHealthResponse(
      200,
      this.customIdentityOverride ?? this.identity(),
    );
  }

  private identityHealthResponse(
    status: number,
    forced: DeploymentIdentityV1 | null = null,
  ): RouteResponseV1 {
    const identity = forced ?? this.identity();
    return {
      kind: "response",
      status,
      headers: {
        ...HEALTH_HEADERS,
        [GIT_SHA_HEADER]: identity.gitSha,
        [REVISION_HEADER]: identity.revisionId,
      },
      body:
        `{"status":"available","release":{"git_sha":"${identity.gitSha}","deployment_id":"${identity.revisionId}"}}`,
    };
  }

  /** Raw body override for a single pathname (e.g. malformed responses). */
  raw(pathname: string, method: string, respond: RouteV1["respond"]): this {
    this.routes.push({ method, pathname, respond });
    return this;
  }

  /** Reject (transport failure) for one method+pathname. */
  reject(method: string, pattern: RegExp): this {
    this.routes.push({
      method,
      pathname: pattern.source,
      respond: () => ({ kind: "reject" }),
    });
    return this;
  }

  private resolveRoute(method: string, pathname: string): RouteV1 | null {
    // Last registration wins: an override route replaces an earlier one.
    for (let i = this.routes.length - 1; i >= 0; i--) {
      const route = this.routes[i];
      if (route.method !== method) continue;
      if (route.pathname.startsWith("^")) {
        if (new RegExp(route.pathname).test(pathname)) return route;
      } else if (route.pathname === pathname) {
        return route;
      }
    }
    return null;
  }

  callCount(method: string, pathnameRegex: RegExp): number {
    return this.calls.filter((call) =>
      call.method === method && pathnameRegex.test(call.pathname)
    ).length;
  }

  async fetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers ?? {});
    this.calls.push({
      method,
      pathname: url.pathname,
      search: url.search,
      authorization: headers.get("authorization"),
    });
    const route = this.resolveRoute(method, url.pathname) ??
      this.resolveRoute(method, url.href);
    if (route === null) {
      throw new Error(`unexpected transport call: ${method} ${url.pathname}`);
    }
    const outcome = await route.respond(url);
    if (outcome.kind === "reject") {
      throw new Error("synthetic transport failure");
    }
    return new Response(outcome.body ?? null, {
      status: outcome.status,
      headers: outcome.headers ?? {},
    });
  }
}

export const REVISIONS_PATH = `/v2/apps/${PROJECT_ID}/revisions`;
export const PROMOTE_RE = /^\/v2\/revisions\/([^/]+)\/promote$/;
export const REVISION_RE = /^\/v2\/revisions\/([^/]+)$/;
export const TIMELINES_RE = /^\/v2\/revisions\/([^/]+)\/timelines$/;
export const LOGS_RE = /^\/v2\/apps\/[^/]+\/logs$/;

/**
 * Registers a self-consistent Deno REST contract for `deployments`:
 * revisions list (exact SHA+transaction labels), revision resource, and
 * timelines binding the custom domain. The promote route is registered
 * separately through `promoteRoute` so tests can swap its behavior.
 */
export function installREST(
  transport: ScriptedTransport,
  deployments: DeploymentIdentityV1[],
): void {
  transport.revisions = deployments;
  transport.route({
    method: "GET",
    pathname: REVISIONS_PATH,
    respond: (url) => {
      if (url.searchParams.get("status") !== "succeeded") {
        return { kind: "reject" };
      }
      return {
        kind: "response",
        status: 200,
        body: JSON.stringify(
          deployments.map((identity) => ({
            id: identity.revisionId,
            status: "succeeded",
            labels: {
              [transport.config.gitShaLabelKey]: identity.gitSha,
              [transport.config.buildTransactionLabelKey]:
                `txn-${identity.revisionId}`,
              extra: ["legacy-value"],
            },
            created_at: "2026-09-07T00:00:00.000Z",
          })),
        ),
      };
    },
  });
  for (const identity of deployments) {
    transport.route({
      method: "GET",
      pathname: `/v2/revisions/${identity.revisionId}`,
      respond: () => ({
        kind: "response",
        status: 200,
        body: JSON.stringify({
          id: identity.revisionId,
          status: "succeeded",
          labels: {
            [transport.config.gitShaLabelKey]: identity.gitSha,
            [transport.config.buildTransactionLabelKey]:
              `txn-${identity.revisionId}`,
          },
        }),
      }),
    });
    transport.route({
      method: "GET",
      pathname: `/v2/revisions/${identity.revisionId}/timelines`,
      respond: () => ({
        kind: "response",
        status: 200,
        body: JSON.stringify([{
          slug: "production",
          partition: {},
          domains: [{ domain: "ai.ubq.fi" }],
        }]),
      }),
    });
  }
}

export interface PromoteRouteOptionsV1 {
  /** Reject BEFORE the effect (a transport failure; outcome ambiguous). */
  reject?: boolean;
  /** Apply the effect, then lose the response (promotion ambiguous). */
  lost?: boolean;
}

/**
 * Promote route: applies the effect (flips the deployed identity) and returns
 * 204; `lost` applies the effect then rejects the response; `reject` never
 * applies the effect.
 */
export function promoteRoute(
  transport: ScriptedTransport,
  target: DeploymentIdentityV1,
  options: PromoteRouteOptionsV1 = {},
): void {
  transport.any(
    "POST",
    new RegExp("^/v2/revisions/([^/]+)/promote$"),
    (url) => {
      if (options.reject) return { kind: "reject" };
      const id = /^\/v2\/revisions\/([^/]+)\/promote$/.exec(url.pathname)?.[1];
      const revision = transport.revisions.find((entry) =>
        entry.revisionId === id
      );
      if (revision === undefined) return { kind: "reject" };
      if (options.lost && revision.revisionId !== target.revisionId) {
        return { kind: "reject" };
      }
      transport.deployed = revision;
      if (options.lost) return { kind: "reject" };
      return { kind: "response", status: 204 };
    },
  );
}

/**
 * Routes for a full self-consistent Deno REST contract: revisions list for a
 * fixed set, exact revision resources, timelines, and a promote that applies
 * the effect (flips the deployed identity) and returns 204. Additional routes
 * (health, logs) are registered by the caller.
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface LogEventV1 {
  requestId: string;
  status?: number;
  deliveryOutcome?: string;
  stream?: boolean | null;
  streamTerminalType?: string | null;
  failureKind?: string | null;
  gitSha: string;
  revisionId: string;
  timestamp: number;
}

function acceptedMessage(event: LogEventV1): string {
  return JSON.stringify({
    request_id: event.requestId,
    route: "route1",
    git_sha: event.gitSha,
    deno_revision: event.revisionId,
  });
}

function terminalMessage(event: LogEventV1): string {
  return JSON.stringify({
    request_id: event.requestId,
    route: "route1",
    status: event.status ?? 200,
    delivery_outcome: event.deliveryOutcome ?? "delivered",
    stream: event.stream ?? null,
    stream_terminal_type: event.streamTerminalType ?? null,
    failure_kind: event.failureKind ?? null,
    git_sha: event.gitSha,
    deno_revision: event.revisionId,
  });
}

export function acceptedEvent(
  event: Partial<LogEventV1> & { requestId: string; timestamp: number } & {
    identity: DeploymentIdentityV1;
  },
): string {
  return `[ai.ubq.fi] request_accepted ${
    acceptedMessage({
      requestId: event.requestId,
      gitSha: event.identity.gitSha,
      revisionId: event.identity.revisionId,
      timestamp: event.timestamp,
    })
  }`;
}

export function terminalEvent(
  event: Partial<LogEventV1> & { requestId: string; timestamp: number } & {
    identity: DeploymentIdentityV1;
  },
): string {
  return `[ai.ubq.fi] request_terminal ${
    terminalMessage({
      requestId: event.requestId,
      gitSha: event.identity.gitSha,
      revisionId: event.identity.revisionId,
      status: event.status ?? 200,
      deliveryOutcome: event.deliveryOutcome ?? "delivered",
      stream: event.stream ?? null,
      streamTerminalType: event.streamTerminalType ?? null,
      failureKind: event.failureKind ?? null,
      timestamp: event.timestamp,
    })
  }`;
}

/**
 * A logs route serving a deterministic cohort for the exact revision +
 * window: `accept` accepted events and `fails` failing terminals (with the
 * given 5xx/timeout/stream/upstream split), plus optional unreadable entries
 * to force incomplete coverage.
 */
export function logRoute(
  transport: ScriptedTransport,
  options: {
    accept: number;
    fails?: {
      fiveXx?: number;
      timeout?: number;
      stream?: number;
      upstream?: number;
    };
    /** Failures observed for the PRIOR identity (baseline window). */
    baselineFails?: {
      fiveXx?: number;
      timeout?: number;
      stream?: number;
      upstream?: number;
    };
    unreadable?: number;
  },
): void {
  transport.any(
    "GET",
    new RegExp("^/v2/apps/[^/]+/logs$"),
    (url) => {
      if (transport.logsReject) return { kind: "reject" };
      const revisionId = url.searchParams.get("revision_id") ?? "dep-0000";
      const start = Date.parse(url.searchParams.get("start") ?? "0");
      const gitSha = revisionId === DEP_1.revisionId
        ? DEP_1.gitSha
        : DEP_0.gitSha;
      const identity: DeploymentIdentityV1 = { gitSha, revisionId };
      const logs: string[] = [];
      for (let i = 0; i < options.accept; i++) {
        logs.push(
          acceptedEvent({
            requestId: `${revisionId}-acc-${i}`,
            timestamp: start + i,
            identity,
          }),
        );
      }
      const revFailures = revisionId === "dep-0000"
        ? options.baselineFails ?? {}
        : options.fails ?? {};
      const fails = revFailures;
      let failIndex = 0;
      const pushFail = (
        status: number,
        failureKind: string | null,
        stream: boolean | null,
        streamTerminalType: string | null,
      ) => {
        logs.push(
          terminalEvent({
            requestId: `${revisionId}-term-${failIndex++}`,
            timestamp: start + failIndex,
            identity,
            status,
            failureKind,
            stream,
            streamTerminalType,
          }),
        );
      };
      for (let i = 0; i < (fails.fiveXx ?? 0); i++) {
        pushFail(502, null, null, null);
      }
      for (let i = 0; i < (fails.timeout ?? 0); i++) {
        pushFail(200, "upstream_timeout", null, null);
      }
      for (let i = 0; i < (fails.stream ?? 0); i++) {
        pushFail(200, null, true, "error");
      }
      for (let i = 0; i < (fails.upstream ?? 0); i++) {
        pushFail(502, "upstream_error", null, null);
      }
      for (let i = 0; i < (options.unreadable ?? 0); i++) {
        logs.push("[ai.ubq.fi] request_accepted {broken");
      }
      return {
        kind: "response",
        status: 200,
        body: JSON.stringify({
          logs: logs.map((message, index) => ({
            timestamp: new Date(start + index).toISOString(),
            level: "info",
            message,
            revision_id: revisionId,
          })),
          next_cursor: null,
        }),
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Receipt resolver.
// ---------------------------------------------------------------------------

export class ScriptedResolver implements BuildReceiptResolverV1 {
  outcome: PortResultV1<BuildReceiptLookupV1> = portOk({
    status: "found",
    receipt: {
      buildTransactionId: `txn-${DEP_1.revisionId}`,
      identity: DEP_1,
    },
  });

  resolve(): Promise<PortResultV1<BuildReceiptLookupV1>> {
    return Promise.resolve(this.outcome);
  }
}

// ---------------------------------------------------------------------------
// Real temporary Git state fixtures.
// ---------------------------------------------------------------------------

export interface GitCtxV1 {
  tmp: string;
  env: Record<string, string>;
  remoteUrl: string;
  bare: string;
  work: string;
  cleanup(): Promise<void>;
}

export async function makeGitCtx(prefix: string): Promise<GitCtxV1> {
  const here = new URL(import.meta.url);
  if (here.protocol !== "file:") {
    throw new Error("expected a file: test module");
  }
  const root = decodeURIComponent(here.pathname).replace(
    /\/tests\/release\/helpers\.ts$/,
    "",
  );
  const tmp = await Deno.makeTempDir({
    prefix: `sentinel-release-test-${prefix}-`,
    dir: root,
  });
  const env = testGitEnv(`${tmp}/git-home`);
  await Deno.mkdir(`${tmp}/git-home`, { recursive: true });
  const remote = await makeRemoteCtx(tmp, env);
  return {
    tmp,
    env,
    remoteUrl: remote.remoteUrl,
    bare: remote.bare,
    work: remote.work,
    cleanup: async () => {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    },
  };
}

export function storeAt(
  ctx: GitCtxV1,
  name: string,
  role: "repair" | "release",
  runner?: GitRunnerV1,
): GitStateStore {
  return new GitStateStore({
    scratchDir: `${ctx.tmp}/scratch-${name}`,
    remoteUrl: ctx.remoteUrl,
    role,
    runner,
  });
}

/**
 * Publishes one open release request onto the repair state branch using the
 * real repair-role store (branch creation + CAS write), and returns the
 * applied head.
 */
export async function publishRepairRequest(
  ctx: GitCtxV1,
  request: ReleaseRequestV1,
): Promise<GitSha> {
  const repair = storeAt(ctx, "repair", "repair");
  const next = {
    version: "v1" as const,
    kind: "repair_state_snapshot" as const,
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [request],
  };
  const write = await repair.writeRepair(next, null);
  assert.ok(write.ok, "repair request write should succeed");
  if (write.ok) {
    assert.equal(write.value.status, "applied");
    if (write.value.status === "applied") return write.value.head;
  }
  throw new Error("unreachable");
}

export function requestFor(
  id = "release-request-0001",
  overrides: Record<string, unknown> = {},
): ReleaseRequestV1 {
  return parseReleaseRequestV1(
    releaseRequest(id, {
      revision: SHA1,
      source: {
        pullRequest: 1,
        reviewRequestId: "review-req-1",
        reviewReceiptId: null,
        head: SHA1,
        base: SHA2,
      },
      createdAt: T0,
      ...overrides,
    }),
  );
}

export async function remoteHeadJson(
  ctx: GitCtxV1,
  ref: string,
): Promise<string | null> {
  const found = await gitRun(
    ctx.tmp,
    ["--git-dir", ctx.bare, "rev-parse", ref],
    ctx.env,
  );
  if (!found.ok) return null;
  return found.stdout.trim();
}

/** Reads and parses one release record from the release state branch. */
export async function readReleaseRecordsFromStore(
  ctx: GitCtxV1,
): Promise<import("../../src/contracts/release.ts").ReleaseRecordV1[]> {
  const store = storeAt(ctx, "read", "release");
  const read = await store.readRelease();
  if (!read.ok || read.value.status !== "found") return [];
  return read.value.snapshot.releases;
}

export function canonicalRecordText(record: unknown): string {
  return `${canonicalStringify(record)}\n`;
}

/** Wraps a scripted transport into the injected fetch-like function type. */
export function asTransport(t: ScriptedTransport): DenoHttpTransportV1 {
  return (input, init) => t.fetch(input, init);
}
