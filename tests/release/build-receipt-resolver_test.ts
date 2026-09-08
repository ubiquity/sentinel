// m05-release: permanent tests for the concrete authenticated GitHub build
// receipt resolver against actual GitHub REST response shapes.
//
// The exact producer receipt is immutable fixture truth
// (tests/fixtures/release/build-receipt-upload-v1.json): zip bytes, size,
// sha256 digest and all receipt fields come from the fixture; the GitHub API
// responses mirror official REST shapes (repository inside base.repo, no
// top-level `repository`, run_attempt, no invented `attempt` field). Every
// scenario drives the real class with a scripted fetch. No network, no ZIP
// generation at runtime.

import assert from "node:assert/strict";

import type { PortResultV1 } from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import {
  GithubBuildReceiptResolver,
  type GithubBuildReceiptResolverAuthV1,
} from "../../src/release/build-receipt-resolver.ts";
import type { BuildReceiptLookupV1 } from "../../src/release/resolver.ts";

// ---------------------------------------------------------------------------
// Immutable fixture truth.
// ---------------------------------------------------------------------------

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../fixtures/release/build-receipt-upload-v1.json",
      import.meta.url,
    ),
  ),
) as {
  producerCommit: string;
  workflowBlobSha: string;
  archiveSize: number;
  archiveDigest: string;
  archiveBase64: string;
  receipt: {
    repository: string;
    run_id: string;
    run_attempt: string;
    workflow_ref: string;
    git_sha: string;
    project: string;
    revision_id: string;
    build_transaction_id: string;
  };
};

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const REVISION = fixture.producerCommit as GitSha; // 79ca71...
const WORKFLOW_SHA = fixture.workflowBlobSha as GitSha; // 24d741...
const ARCHIVE_BYTES = decodeBase64(fixture.archiveBase64);
const ARCHIVE_SIZE = fixture.archiveSize; // 404
const ARCHIVE_DIGEST = fixture.archiveDigest; // sha256:a598...

const REPO_FULL = "ubiquity/ai.ubq.fi";
const REPO_ID = 111;
const WORKFLOW_ID = 9999;
const RUN_ID = 12345;
const ATTEMPT = 2;
const PR_NUMBER = 321;
const HEAD_SHA = "1111111111111111111111111111111111111111" as GitSha;
const BASE_BRANCH = "development";
const NOW_MS = 1_700_000_000_000;
const EXPIRES_AT = "2099-01-01T00:00:00Z";
const STORAGE_URL =
  "https://objects.githubusercontent.com/github-production-release-asset/123/zip?X-Amz-Signature=deadbeef";
const ARTIFACT_ID = 9001;
const TARGET_NAME = `sentinel-build-receipt-${RUN_ID}-${ATTEMPT}`;
const AUTH_HEADER = "Bearer test-token";

const EXPECTED_RECEIPT = {
  status: "found",
  receipt: {
    buildTransactionId: "github-actions:ubiquity/ai.ubq.fi:12345:2",
    identity: { gitSha: REVISION, revisionId: "synthetic-r123" },
  },
};

// ---------------------------------------------------------------------------
// Static resolver error texts (asserted exactly, never echoed).
// ---------------------------------------------------------------------------

const ERR_CONFIG = "resolver configuration is invalid";
const ERR_TIMEOUT = "build receipt resolution timed out";
const ERR_TRANSPORT = "GitHub API request failed";
const ERR_AUTH = "GitHub API authentication failed";
const ERR_RATE = "GitHub API rate limit exceeded";
const ERR_NOT_FOUND = "GitHub API resource not found";
const ERR_PR = "GitHub pull request response is invalid";
const ERR_WORKFLOW = "GitHub workflow response is invalid";
const ERR_RUNS = "GitHub workflow runs response is invalid";
const ERR_RUNS_PAGINATION = "GitHub workflow runs pagination is invalid";
const ERR_ATTEMPT = "GitHub workflow run attempt response is invalid";
const ERR_ARTIFACTS = "GitHub workflow run artifacts response is invalid";
const ERR_ARTIFACTS_PAGINATION =
  "GitHub workflow run artifacts pagination is invalid";
const ERR_ARTIFACT = "build receipt artifact is invalid";
const ERR_ARTIFACT_EXPIRED = "build receipt artifact is expired";
const ERR_ARTIFACT_SIZE = "build receipt artifact size mismatch";
const ERR_ARTIFACT_DIGEST = "build receipt artifact digest mismatch";
const ERR_SIGNED_URL = "build receipt artifact download URL is invalid";
const ERR_STORAGE = "build receipt artifact download failed";
const ERR_RERUN = "build workflow run attempt changed during resolution";

// ---------------------------------------------------------------------------
// Scripted transport.
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: URL;
  init: RequestInit;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FetchOverrides {
  prPayload?: unknown;
  prStatus?: number;
  contentsPayload?: unknown;
  workflowPayload?: unknown;
  runsPayload?: (url: URL) => unknown;
  attemptPayload?: unknown;
  artifactsPayload?: (url: URL) => unknown;
  zipStatus?: number;
  zipLocation?: string | null;
  storageBody?: BodyInit;
  storageStatus?: number;
  recheckPayload?: unknown;
  /** Pathname suffix that resolves only after delayMs (deadline scenarios). */
  slow?: { pathSuffix: string; delayMs: number; response: Response };
}

/** Actual GitHub-shaped success responses, with per-route overrides. */
function successFetch(overrides: FetchOverrides = {}) {
  return (url: URL, _init: RequestInit): Response | Promise<Response> => {
    const p = url.pathname;
    if (overrides.slow && p.endsWith(overrides.slow.pathSuffix)) {
      return new Promise<Response>((resolve) => {
        setTimeout(
          () => resolve(overrides.slow!.response),
          overrides.slow!.delayMs,
        );
      });
    }
    if (p.endsWith(`/pulls/${PR_NUMBER}`)) {
      if (overrides.prStatus !== undefined) {
        return new Response(null, { status: overrides.prStatus });
      }
      return jsonResponse(overrides.prPayload ?? prPayload());
    }
    if (p.endsWith("/contents/.github/workflows/deno-deploy.yml")) {
      return jsonResponse(
        overrides.contentsPayload ?? {
          type: "file",
          path: ".github/workflows/deno-deploy.yml",
          sha: WORKFLOW_SHA,
        },
      );
    }
    if (p.endsWith("/actions/workflows/deno-deploy.yml")) {
      return jsonResponse(
        overrides.workflowPayload ?? {
          id: WORKFLOW_ID,
          path: ".github/workflows/deno-deploy.yml",
          name: "deno-deploy",
        },
      );
    }
    if (/\/workflows\/[0-9]+\/runs$/.test(p)) {
      return jsonResponse(
        overrides.runsPayload
          ? overrides.runsPayload(url)
          : { total_count: 1, workflow_runs: [runItem()] },
      );
    }
    if (p.endsWith(`/actions/runs/${RUN_ID}/attempts/${ATTEMPT}`)) {
      return jsonResponse(overrides.attemptPayload ?? runItem());
    }
    if (p.endsWith(`/actions/runs/${RUN_ID}/artifacts`)) {
      return jsonResponse(
        overrides.artifactsPayload
          ? overrides.artifactsPayload(url)
          : { total_count: 1, artifacts: [receiptArtifact()] },
      );
    }
    if (p.endsWith(`/actions/artifacts/${ARTIFACT_ID}/zip`)) {
      const status = overrides.zipStatus ?? 302;
      const headers: Record<string, string> =
        overrides.zipLocation === undefined
          ? { location: STORAGE_URL }
          : overrides.zipLocation === null
          ? {}
          : { location: overrides.zipLocation };
      return new Response(null, { status, headers });
    }
    if (p.endsWith("/github-production-release-asset/123/zip")) {
      if (overrides.storageStatus !== undefined) {
        return new Response(null, { status: overrides.storageStatus });
      }
      return new Response(
        (overrides.storageBody ?? ARCHIVE_BYTES) as BodyInit,
        { status: 200 },
      );
    }
    if (p.endsWith(`/actions/runs/${RUN_ID}`)) {
      return jsonResponse(overrides.recheckPayload ?? runItem());
    }
    throw new Error(`unexpected fetch: ${url.href}`);
  };
}

function scriptedFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): { fetchImpl: typeof globalThis.fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(handler(url, init ?? {}));
  };
  return { fetchImpl: fetchImpl as typeof globalThis.fetch, calls };
}

// ---------------------------------------------------------------------------
// Actual GitHub REST response shapes; `base.sha` is allowed to move.
// ---------------------------------------------------------------------------

function prPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number: PR_NUMBER,
    state: "closed",
    merged: true,
    merge_commit_sha: REVISION,
    head: { sha: HEAD_SHA },
    base: {
      ref: BASE_BRANCH,
      sha: "3333333333333333333333333333333333333333",
      repo: { id: REPO_ID, full_name: REPO_FULL },
    },
    ...overrides,
  };
}

function runItem(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: RUN_ID,
    run_attempt: ATTEMPT,
    event: "push",
    status: "completed",
    conclusion: "success",
    head_sha: REVISION,
    head_branch: BASE_BRANCH,
    workflow_id: WORKFLOW_ID,
    repository: { id: REPO_ID, full_name: REPO_FULL },
    head_repository: { id: REPO_ID, full_name: REPO_FULL },
    ...overrides,
  };
}

function receiptArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: ARTIFACT_ID,
    name: TARGET_NAME,
    size_in_bytes: ARCHIVE_SIZE,
    digest: ARCHIVE_DIGEST,
    expired: false,
    expires_at: EXPIRES_AT,
    workflow_run: {
      id: RUN_ID,
      repository_id: REPO_ID,
      head_repository_id: REPO_ID,
      head_sha: REVISION,
      head_branch: BASE_BRANCH,
    },
    ...overrides,
  };
}

/** Unrelated artifact types: legitimately larger, expired, without digest. */
function unrelatedArtifact(id: number, name: string): Record<string, unknown> {
  return {
    id,
    name,
    size_in_bytes: 5_000_000,
    digest: null,
    expired: true,
    expires_at: "2000-01-01T00:00:00Z",
    workflow_run: {
      id: RUN_ID,
      repository_id: REPO_ID,
      head_repository_id: REPO_ID,
      head_sha: REVISION,
      head_branch: BASE_BRANCH,
    },
  };
}

// ---------------------------------------------------------------------------
// World.
// ---------------------------------------------------------------------------

interface World {
  resolver: GithubBuildReceiptResolver;
  calls: RecordedCall[];
  authCalls: { count: number };
  request: ReleaseRequestV1;
}

function baseRequest(): ReleaseRequestV1 {
  return {
    version: "v1",
    kind: "release_request",
    id: "req-1",
    target: {
      repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
      environment: "production",
    },
    revision: REVISION,
    source: {
      pullRequest: PR_NUMBER,
      reviewRequestId: "rev-1",
      reviewReceiptId: null,
      head: HEAD_SHA,
      // The request base is historical; the PR base.sha above has moved.
      base: "2222222222222222222222222222222222222222" as GitSha,
    },
    status: "open",
    failureReason: null,
    createdAt: NOW_MS,
  };
}

const GOOD_AUTH: GithubBuildReceiptResolverAuthV1 = {
  authorizationHeader: (): Promise<PortResultV1<string>> =>
    Promise.resolve(portOk(AUTH_HEADER)),
};

function buildWorld(opts: {
  fetch?: (url: URL, init: RequestInit) => Response | Promise<Response>;
  auth?: GithubBuildReceiptResolverAuthV1;
  request?: ReleaseRequestV1;
  timeoutMs?: number;
  baseBranch?: string;
  clockNow?: number;
} = {}): World {
  const { fetchImpl, calls } = scriptedFetch(opts.fetch ?? successFetch());
  const auth = opts.auth ?? GOOD_AUTH;
  const authCalls = { count: 0 };
  if (opts.auth === undefined) {
    const original = auth.authorizationHeader;
    auth.authorizationHeader = () => {
      authCalls.count += 1;
      return original();
    };
  }
  const resolver = new GithubBuildReceiptResolver({
    repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
    environment: "production",
    project: "ai-ubq-fi",
    baseBranch: opts.baseBranch ?? BASE_BRANCH,
    workflowBlobSha: WORKFLOW_SHA,
    clock: { now: () => opts.clockNow ?? NOW_MS },
    auth,
    fetch: fetchImpl,
    timeoutMs: opts.timeoutMs ?? 2000,
  });
  return { resolver, calls, authCalls, request: opts.request ?? baseRequest() };
}

function resolve(
  world: World,
): Promise<PortResultV1<BuildReceiptLookupV1>> {
  return world.resolver.resolve(world.request);
}

function expectError(
  result: PortResultV1<unknown>,
  kind: string,
  detail: string,
): void {
  if (result.ok) assert.fail("expected a typed error, got a success");
  assert.equal(result.error.kind, kind);
  assert.equal(result.error.detail, detail);
}

function expectFound(result: PortResultV1<BuildReceiptLookupV1>): void {
  if (!result.ok || result.value.status !== "found") {
    assert.fail("expected a found receipt");
  }
  assert.deepStrictEqual(result.value, EXPECTED_RECEIPT);
}

function assertAbsent(result: PortResultV1<BuildReceiptLookupV1>): void {
  if (!result.ok || result.value.status !== "absent") {
    assert.fail("expected absent");
  }
}

function assertAmbiguous(
  result: PortResultV1<BuildReceiptLookupV1>,
  detail: string,
): void {
  if (
    !result.ok || result.value.status !== "ambiguous" ||
    result.value.detail !== detail
  ) {
    assert.fail("expected ambiguous: " + detail);
  }
}

function headersOf(init: RequestInit): Headers {
  return new Headers(init.headers as HeadersInit | undefined);
}

const API_CALL_PATHS = [
  `/repos/ubiquity/ai.ubq.fi/pulls/${PR_NUMBER}`,
  "/repos/ubiquity/ai.ubq.fi/contents/.github/workflows/deno-deploy.yml",
  "/repos/ubiquity/ai.ubq.fi/actions/workflows/deno-deploy.yml",
  `/repos/ubiquity/ai.ubq.fi/actions/workflows/${WORKFLOW_ID}/runs`,
  `/repos/ubiquity/ai.ubq.fi/actions/runs/${RUN_ID}/attempts/${ATTEMPT}`,
  `/repos/ubiquity/ai.ubq.fi/actions/runs/${RUN_ID}/artifacts`,
  `/repos/ubiquity/ai.ubq.fi/actions/artifacts/${ARTIFACT_ID}/zip`,
  "/github-production-release-asset/123/zip",
  `/repos/ubiquity/ai.ubq.fi/actions/runs/${RUN_ID}`,
];

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

Deno.test("finds the exact fixture receipt through all nine calls", async () => {
  const world = buildWorld();
  const result = await resolve(world);
  expectFound(result);

  assert.equal(world.calls.length, API_CALL_PATHS.length);
  API_CALL_PATHS.forEach((path, index) => {
    assert.equal(world.calls[index].url.pathname, path);
  });
  // Runs listing carries the exact identity filters, complete pagination.
  const runs = world.calls[3].url.searchParams;
  assert.equal(runs.get("head_sha"), REVISION);
  assert.equal(runs.get("event"), "push");
  assert.equal(runs.get("branch"), BASE_BRANCH);
  assert.equal(runs.get("per_page"), "100");
  assert.equal(runs.get("page"), "1");
  assert.equal(world.calls[5].url.searchParams.get("per_page"), "100");

  // Auth isolation: exactly one auth call, only api.github.com receives it.
  assert.equal(world.authCalls.count, 1);
  for (const [index, call] of world.calls.entries()) {
    if (index === 7) continue;
    assert.equal(call.url.origin, "https://api.github.com");
    assert.equal(headersOf(call.init).get("authorization"), AUTH_HEADER);
    assert.equal(
      headersOf(call.init).get("accept"),
      "application/vnd.github+json",
    );
  }
  // The 302 zip read is manual-redirect; the storage GET never sees auth.
  assert.equal(world.calls[6].init.redirect, "manual");
  assert.equal(
    world.calls[7].url.origin,
    "https://objects.githubusercontent.com",
  );
  assert.equal(headersOf(world.calls[7].init).has("authorization"), false);
  assert.equal(world.calls[7].init.redirect, "error");
  assert.equal(world.calls[7].init.credentials, "omit");
});

Deno.test("allows a failed promotion and a moved base", async () => {
  const world = buildWorld({
    fetch: successFetch({
      runsPayload: () => ({
        total_count: 1,
        workflow_runs: [runItem({ conclusion: "failure" })],
      }),
      attemptPayload: runItem({ conclusion: "failure" }),
      recheckPayload: runItem({ conclusion: "failure" }),
    }),
  });
  // request.source.base (2222...) differs from the PR base.sha (3333...).
  const result = await resolve(world);
  expectFound(result);
});

Deno.test("rejects wrong PR/head/merge/base/repo identity", async (t) => {
  const cases: [string, FetchOverrides, string][] = [
    [
      "wrong pull request number",
      { prPayload: prPayload({ number: 999 }) },
      ERR_PR,
    ],
    [
      "wrong head sha",
      { prPayload: prPayload({ head: { sha: HEAD_SHA + "0" } }) },
      ERR_PR,
    ],
    [
      "wrong merge commit",
      {
        prPayload: prPayload({
          merge_commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }),
      },
      ERR_PR,
    ],
    [
      "wrong base ref",
      { prPayload: prPayload({ base: { ref: "main" } }) },
      ERR_PR,
    ],
    [
      "wrong base repository full name",
      {
        prPayload: prPayload({
          base: {
            ref: BASE_BRANCH,
            repo: { id: REPO_ID, full_name: "ubiquity/other" },
          },
        }),
      },
      ERR_PR,
    ],
    [
      "missing base.repo (no top-level repository exists)",
      {
        prPayload: {
          number: PR_NUMBER,
          merged: true,
          merge_commit_sha: REVISION,
          head: { sha: HEAD_SHA },
          base: {
            ref: BASE_BRANCH,
            sha: "3333333333333333333333333333333333333333",
          },
        },
      },
      ERR_PR,
    ],
  ];
  for (const [name, overrides, detail] of cases) {
    await t.step(name, async () => {
      const world = buildWorld({ fetch: successFetch(overrides) });
      expectError(await resolve(world), "invalid", detail);
    });
  }
});

Deno.test("binds the repository id from base.repo against the runs", async () => {
  // A base.repo.id drift is caught by the same-repo check on the run listing.
  const world = buildWorld({
    fetch: successFetch({
      prPayload: prPayload({
        base: {
          ref: BASE_BRANCH,
          repo: { id: 777, full_name: REPO_FULL },
        },
      }),
    }),
  });
  expectError(await resolve(world), "invalid", ERR_RUNS);
});

Deno.test("binds the workflow identity from the trusted workflow response", async () => {
  for (
    const payload of [
      { id: WORKFLOW_ID, path: ".github/workflows/other.yml" },
      { id: WORKFLOW_ID },
      { id: 1, path: ".github/workflows/other.yml" },
    ]
  ) {
    const world = buildWorld({
      fetch: successFetch({ workflowPayload: payload }),
    });
    expectError(await resolve(world), "invalid", ERR_WORKFLOW);
  }
  // The response's workflow id drives the runs listing; none means absent.
  const derived = buildWorld({
    fetch: successFetch({
      workflowPayload: { id: 4242, path: ".github/workflows/deno-deploy.yml" },
      runsPayload: (url) => {
        assert.equal(
          url.pathname,
          "/repos/ubiquity/ai.ubq.fi/actions/workflows/4242/runs",
        );
        return { total_count: 0, workflow_runs: [] };
      },
    }),
  });
  assertAbsent(await resolve(derived));
});

Deno.test("rejects wrong run identity", async (t) => {
  const cases: [string, Record<string, unknown>][] = [
    ["wrong head_sha", {
      head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }],
    ["wrong head_branch", { head_branch: "main" }],
    ["wrong workflow_id", { workflow_id: 1 }],
    ["wrong repository id", { repository: { id: 777, full_name: REPO_FULL } }],
    [
      "wrong head_repository id",
      { head_repository: { id: 777, full_name: REPO_FULL } },
    ],
    ["wrong event", { event: "pull_request" }],
  ];
  for (const [name, overrides] of cases) {
    await t.step(name, async () => {
      const world = buildWorld({
        fetch: successFetch({
          runsPayload: () => ({
            total_count: 1,
            workflow_runs: [runItem(overrides)],
          }),
        }),
      });
      expectError(await resolve(world), "invalid", ERR_RUNS);
    });
  }
});

Deno.test("rejects a wrong run attempt", async (t) => {
  const cases: [string, Record<string, unknown>][] = [
    ["wrong run_attempt", { run_attempt: 3 }],
    ["wrong run id", { id: RUN_ID + 1 }],
    ["missing run_attempt", { run_attempt: undefined }],
    ["wrong conclusion", { conclusion: "cancelled" }],
  ];
  for (const [name, overrides] of cases) {
    await t.step(name, async () => {
      const world = buildWorld({
        fetch: successFetch({ attemptPayload: runItem(overrides) }),
      });
      expectError(await resolve(world), "invalid", ERR_ATTEMPT);
    });
  }
});

Deno.test("empty runs or only unrelated artifacts mean absent", async () => {
  const emptyRuns = buildWorld({
    fetch: successFetch({
      runsPayload: () => ({ total_count: 0, workflow_runs: [] }),
    }),
  });
  assertAbsent(await resolve(emptyRuns));
  assert.equal(emptyRuns.calls.length, 4);

  const notTerminal = buildWorld({
    fetch: successFetch({
      runsPayload: () => ({
        total_count: 1,
        workflow_runs: [runItem({ status: "queued", conclusion: null })],
      }),
    }),
  });
  assertAbsent(await resolve(notTerminal));

  const unrelatedOnly = buildWorld({
    fetch: successFetch({
      artifactsPayload: () => ({
        total_count: 1,
        artifacts: [unrelatedArtifact(500, "coverage-report")],
      }),
    }),
  });
  assertAbsent(await resolve(unrelatedOnly));
});

Deno.test("multiple matching runs are ambiguous, never an order choice", async () => {
  const world = buildWorld({
    fetch: successFetch({
      runsPayload: () => ({
        total_count: 2,
        workflow_runs: [
          runItem({ id: RUN_ID }),
          runItem({ id: RUN_ID + 1 }),
        ],
      }),
    }),
  });
  assertAmbiguous(await resolve(world), "multiple matching workflow runs");
});

Deno.test("completes bounded pagination across pages with consistent totals", async (t) => {
  await t.step("runs across two pages", async () => {
    const world = buildWorld({
      fetch: successFetch({
        runsPayload: (url) => ({
          total_count: 2,
          workflow_runs: url.searchParams.get("page") === "1"
            ? [runItem({ id: RUN_ID })]
            : [runItem({ id: RUN_ID + 1 })],
        }),
      }),
    });
    assertAmbiguous(await resolve(world), "multiple matching workflow runs");
    assert.equal(world.calls.length, 5);
  });

  await t.step("artifact on a later page", async () => {
    const world = buildWorld({
      fetch: successFetch({
        artifactsPayload: (url) => ({
          total_count: 2,
          artifacts: url.searchParams.get("page") === "1"
            ? [unrelatedArtifact(500, "coverage-report")]
            : [receiptArtifact()],
        }),
      }),
    });
    expectFound(await resolve(world));
  });

  await t.step(
    "inconsistent runs totals are an error, not absence",
    async () => {
      const world = buildWorld({
        fetch: successFetch({
          runsPayload: (url) => ({
            total_count: url.searchParams.get("page") === "1" ? 2 : 1,
            workflow_runs: [runItem({ id: RUN_ID })],
          }),
        }),
      });
      expectError(await resolve(world), "invalid", ERR_RUNS_PAGINATION);
    },
  );

  await t.step("empty artifact page is an error, not absence", async () => {
    const world = buildWorld({
      fetch: successFetch({
        artifactsPayload: (url) => ({
          total_count: 2,
          artifacts: url.searchParams.get("page") === "1"
            ? [unrelatedArtifact(500, "coverage-report")]
            : [],
        }),
      }),
    });
    expectError(await resolve(world), "invalid", ERR_ARTIFACTS_PAGINATION);
  });
});

Deno.test("unrelated artifacts never block the valid receipt", async () => {
  const world = buildWorld({
    fetch: successFetch({
      artifactsPayload: () => ({
        total_count: 3,
        artifacts: [
          unrelatedArtifact(500, "deploy-bundle"),
          // An earlier attempt publishes its own receipt-named artifact.
          receiptArtifact({
            id: 502,
            name: `sentinel-build-receipt-${RUN_ID}-1`,
          }),
          receiptArtifact(),
        ],
      }),
    }),
  });
  expectFound(await resolve(world));
});

Deno.test("duplicate target names are ambiguous; duplicate ids are invalid", async (t) => {
  await t.step("two receipt-named artifacts", async () => {
    const world = buildWorld({
      fetch: successFetch({
        artifactsPayload: () => ({
          total_count: 2,
          artifacts: [
            receiptArtifact({ id: ARTIFACT_ID }),
            receiptArtifact({ id: ARTIFACT_ID + 1 }),
          ],
        }),
      }),
    });
    assertAmbiguous(
      await resolve(world),
      "multiple matching receipt artifacts",
    );
  });

  await t.step("repeated artifact id", async () => {
    const world = buildWorld({
      fetch: successFetch({
        artifactsPayload: () => ({
          total_count: 2,
          artifacts: [
            unrelatedArtifact(500, "coverage-report"),
            unrelatedArtifact(500, "deploy-bundle"),
          ],
        }),
      }),
    });
    expectError(await resolve(world), "invalid", ERR_ARTIFACTS);
  });

  await t.step("structurally malformed entry", async () => {
    const world = buildWorld({
      fetch: successFetch({
        artifactsPayload: () => ({
          total_count: 2,
          artifacts: [
            { id: 500, size_in_bytes: 1 },
            receiptArtifact(),
          ],
        }),
      }),
    });
    expectError(await resolve(world), "invalid", ERR_ARTIFACTS);
  });
});

Deno.test("rejects receipt-specific metadata only on the selected artifact", async (t) => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["expired flag", { expired: true }, ERR_ARTIFACT_EXPIRED],
    [
      "expires_at in the past",
      { expired: false, expires_at: "2000-01-01T00:00:00Z" },
      ERR_ARTIFACT_EXPIRED,
    ],
    ["oversize for a receipt", { size_in_bytes: 9_999_999 }, ERR_ARTIFACTS],
    [
      "digest without sha256 prefix",
      { digest: "sha256:deadbeef" },
      ERR_ARTIFACTS,
    ],
    ["wrong workflow_run", { workflow_run: { id: 1 } }, ERR_ARTIFACTS],
    ["malformed expires_at", { expires_at: "not-a-date" }, ERR_ARTIFACTS],
  ];
  for (const [name, overrides, detail] of cases) {
    await t.step(name, async () => {
      const world = buildWorld({
        fetch: successFetch({
          artifactsPayload: () => ({
            total_count: 1,
            artifacts: [receiptArtifact(overrides)],
          }),
        }),
      });
      expectError(await resolve(world), "invalid", detail);
    });
  }
});

Deno.test("rejects a size or digest mismatch of the download", async (t) => {
  await t.step("size mismatch", async () => {
    const world = buildWorld({
      fetch: successFetch({
        artifactsPayload: () => ({
          total_count: 1,
          artifacts: [receiptArtifact({ size_in_bytes: ARCHIVE_SIZE + 1 })],
        }),
      }),
    });
    expectError(await resolve(world), "invalid", ERR_ARTIFACT_SIZE);
  });

  await t.step("digest mismatch", async () => {
    const world = buildWorld({
      fetch: successFetch({
        artifactsPayload: () => ({
          total_count: 1,
          artifacts: [
            receiptArtifact({
              digest: `sha256:${"0".repeat(64)}`,
            }),
          ],
        }),
      }),
    });
    expectError(await resolve(world), "invalid", ERR_ARTIFACT_DIGEST);
  });

  await t.step("oversize storage body is an invalid artifact", async () => {
    const world = buildWorld({
      fetch: successFetch({
        storageBody: new Uint8Array(262_145),
      }),
    });
    expectError(await resolve(world), "invalid", ERR_ARTIFACT);
  });

  await t.step("truncated download", async () => {
    const world = buildWorld({
      fetch: successFetch({
        storageBody: ARCHIVE_BYTES.slice(0, ARCHIVE_SIZE - 1),
      }),
    });
    expectError(await resolve(world), "invalid", ERR_ARTIFACT_SIZE);
  });
});

Deno.test("rejects a changed final latest attempt", async () => {
  const world = buildWorld({
    fetch: successFetch({
      recheckPayload: runItem({ run_attempt: ATTEMPT + 1 }),
    }),
  });
  expectError(await resolve(world), "unavailable", ERR_RERUN);
});

Deno.test("API errors are errors, never successful absence", async (t) => {
  const cases: [string, FetchOverrides, string, string][] = [
    ["PR 404", { prStatus: 404 }, "not_found", ERR_NOT_FOUND],
    ["PR 500", { prStatus: 500 }, "unavailable", ERR_TRANSPORT],
    ["PR 429", { prStatus: 429 }, "rate_limited", ERR_RATE],
    ["PR 401", { prStatus: 401 }, "auth_failed", ERR_AUTH],
    ["zip 500", { zipStatus: 500 }, "unavailable", ERR_TRANSPORT],
    [
      "storage 403",
      { storageStatus: 403 },
      "unavailable",
      ERR_STORAGE,
    ],
    ["zip missing location", { zipLocation: null }, "invalid", ERR_SIGNED_URL],
  ];
  for (const [name, overrides, kind, detail] of cases) {
    await t.step(name, async () => {
      const world = buildWorld({ fetch: successFetch(overrides) });
      expectError(await resolve(world), kind, detail);
    });
  }

  await t.step("zip 404/410 means the artifact is gone", async () => {
    const world = buildWorld({ fetch: successFetch({ zipStatus: 404 }) });
    assertAbsent(await resolve(world));
  });
});

Deno.test("rejects every invalid signed storage URL", async (t) => {
  const badLocations = [
    "http://objects.githubusercontent.com/x",
    "https://localhost/x",
    "https://localhost./x",
    "https://sub.localhost/x",
    "https://127.0.0.1/x",
    "https://127.0.0.1./x",
    "https://[::1]/x",
    "https://user@objects.githubusercontent.com/x",
    "https://objects.githubusercontent.com/x#",
    "https://objects.githubusercontent.com/x#section",
    "https://objects.githubusercontent.com/pa\u007fth",
    "https://storage/x",
    "",
  ];
  for (const location of badLocations) {
    await t.step(JSON.stringify(location), async () => {
      const world = buildWorld({
        fetch: successFetch({ zipLocation: location }),
      });
      expectError(await resolve(world), "invalid", ERR_SIGNED_URL);
    });
  }
});

Deno.test("auth errors are static typed results, never escaped", async (t) => {
  await t.step("rejected auth", async () => {
    const world = buildWorld({
      auth: {
        authorizationHeader: () =>
          Promise.reject(new Error("secret-token leaked in an exception")),
      },
    });
    expectError(await resolve(world), "auth_failed", ERR_AUTH);
    assert.equal(world.calls.length, 0);
  });

  await t.step("synchronously thrown auth", async () => {
    const world = buildWorld({
      auth: {
        authorizationHeader: () => {
          throw new Error("boom");
        },
      },
    });
    expectError(await resolve(world), "auth_failed", ERR_AUTH);
    assert.equal(world.calls.length, 0);
  });

  await t.step("empty auth result", async () => {
    const world = buildWorld({
      auth: {
        authorizationHeader: (): Promise<PortResultV1<string>> =>
          Promise.resolve(portOk("")),
      },
    });
    expectError(await resolve(world), "auth_failed", ERR_AUTH);
    assert.equal(world.calls.length, 0);
  });

  await t.step("hanging auth is bounded by the whole deadline", async () => {
    const world = buildWorld({
      auth: {
        authorizationHeader: () => new Promise(() => {}),
      },
      timeoutMs: 30,
    });
    const started = Date.now();
    expectError(await resolve(world), "unavailable", ERR_TIMEOUT);
    assert.ok(Date.now() - started < 1000);
    assert.equal(world.calls.length, 0);
  });
});

Deno.test("never-settling stream reads and cancels stay bounded", async () => {
  let cancelCalled = false;
  const storageBody = new ReadableStream<Uint8Array>({
    start() {},
    cancel() {
      cancelCalled = true;
      return new Promise<void>(() => {});
    },
  });
  const world = buildWorld({
    fetch: successFetch({ storageBody }),
    timeoutMs: 30,
  });
  const started = Date.now();
  expectError(await resolve(world), "unavailable", ERR_TIMEOUT);
  assert.ok(Date.now() - started < 1000);
  assert.equal(cancelCalled, true);
  assert.equal(storageBody.locked, false);
});

Deno.test("late fetch bodies are cancelled even when the signal is ignored", async () => {
  let bodyCancelled = false;
  const lateBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("late"));
    },
    cancel() {
      bodyCancelled = true;
    },
  });
  const delayed = new Promise<Response>((resolve) => {
    setTimeout(() => {
      resolve(new Response(lateBody, { status: 200 }));
    }, 150);
  });
  const world = buildWorld({
    fetch: (url) => {
      if (url.pathname.endsWith(`/pulls/${PR_NUMBER}`)) return delayed;
      return successFetch()(url, {});
    },
    timeoutMs: 30,
  });
  const started = Date.now();
  expectError(await resolve(world), "unavailable", ERR_TIMEOUT);
  assert.ok(Date.now() - started < 1000);
  assert.equal(world.calls[0].init.signal?.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(bodyCancelled, true);
});

Deno.test("the whole deadline spans expensive steps before the return", async () => {
  const world = buildWorld({
    fetch: successFetch({
      slow: {
        pathSuffix: `/actions/runs/${RUN_ID}`,
        delayMs: 150,
        response: jsonResponse(runItem()),
      },
    }),
    timeoutMs: 30,
  });
  const started = Date.now();
  expectError(await resolve(world), "unavailable", ERR_TIMEOUT);
  assert.ok(Date.now() - started < 1000);
  assert.equal(world.calls.length, API_CALL_PATHS.length);
  await new Promise((resolve) => setTimeout(resolve, 250));
});

Deno.test("strict config rejects controls, trailing whitespace and bad clocks", async (t) => {
  for (
    const baseBranch of [
      `${BASE_BRANCH}\n`,
      `${BASE_BRANCH} `,
      `${BASE_BRANCH}\t`,
      `\u0000${BASE_BRANCH}`,
    ]
  ) {
    await t.step(`baseBranch ${JSON.stringify(baseBranch)}`, async () => {
      const world = buildWorld({ baseBranch });
      expectError(await resolve(world), "invalid", ERR_CONFIG);
      assert.equal(world.calls.length, 0);
    });
  }
  for (const clockNow of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
    await t.step(`clock ${String(clockNow)}`, async () => {
      const world = buildWorld({ clockNow });
      expectError(await resolve(world), "invalid", ERR_CONFIG);
      assert.equal(world.calls.length, 0);
    });
  }
});

Deno.test("exact installation scope: environment/project mapping", async (t) => {
  await t.step(
    "isolated request against production config is rejected",
    async () => {
      const world = buildWorld();
      const request: ReleaseRequestV1 = {
        ...world.request,
        target: {
          repository: {
            owner: "ubiquity",
            name: "ai.ubq.fi",
            installationId: 1,
          },
          environment: "isolated",
        },
      };
      const result = await world.resolver.resolve(request);
      expectError(
        result,
        "invalid",
        "release request environment does not match the configured environment",
      );
      assert.equal(world.calls.length, 0);
    },
  );

  await t.step(
    "isolated config binds project p-ai-ubq-fi end to end",
    async () => {
      const { fetchImpl, calls } = scriptedFetch(successFetch());
      const resolver = new GithubBuildReceiptResolver({
        repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
        environment: "isolated",
        project: "p-ai-ubq-fi",
        baseBranch: BASE_BRANCH,
        workflowBlobSha: WORKFLOW_SHA,
        clock: { now: () => NOW_MS },
        auth: GOOD_AUTH,
        fetch: fetchImpl,
      });
      const request: ReleaseRequestV1 = {
        ...baseRequest(),
        target: {
          repository: {
            owner: "ubiquity",
            name: "ai.ubq.fi",
            installationId: 1,
          },
          environment: "isolated",
        },
      };
      // The whole binding resolves; only the production fixture receipt is
      // rejected for project p-ai-ubq-fi, never a wrong project accepted.
      const result = await resolver.resolve(request);
      expectError(result, "invalid", "build receipt payload is invalid");
      // Receipt validation happens after the storage download, before recheck.
      assert.equal(calls.length, 8);
    },
  );
});
