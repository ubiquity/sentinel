/**
 * Hosted read-only release receipt boundaries.
 *
 * These tests drive the REAL `readActionsReleaseReceipt` helper and the REAL
 * `GitHubApiClient` over a scripted in-memory transport with the actual API
 * shapes (run repositories as full_name objects, job run_attempt/head_sha,
 * raw timestamp-prefixed log lines). No network, no model, no real token.
 */
import assert from "node:assert/strict";

import type { PortResultV1 } from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { GitHubCooldownGateV1 } from "../../src/contracts/ports.ts";
import type { GitHubRateLimitV1 } from "../../src/contracts/github-cooldown.ts";
import { parseReleaseRequestV1 } from "../../src/contracts/release.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import { parseActionsReleaseReceiptV1 } from "../../src/contracts/actions-release.ts";
import type {
  HttpRequestV1,
  HttpResponseV1,
  HttpTransportV1,
} from "../../src/github/http.ts";
import { readActionsReleaseReceipt } from "../../src/host/actions-release.ts";
import { FakeClock } from "../repair/helpers.ts";
import { SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";

const API_BASE = "https://api.github.com";
const REPO = "ubiquity/sentinel";
const REVISION = SHA2;
const BASE = SHA1;
const HEAD = SHA3;
const PR_NUMBER = 30;
const RUN_ID = 347_224_080_66;
const RUN_ATTEMPT = 1;
const JOB_ID = 103_628_114_113;
const WORKFLOW_ID = 353_743_354;
const WORKFLOW_PATH = ".github/workflows/repair.yml";
const LOGIN = "github-actions[bot]";
const SIGNED_HOST = "https://productionresultssa17.blob.core.windows.net";
const SIGNED_PATH = "/logs/abcdef";
const SIGNED_URL = `${SIGNED_HOST}${SIGNED_PATH}?sv=2024&sig=xyz`;
const PULL_PATH = `/repos/${REPO}/pulls/${PR_NUMBER}`;
const COMMIT_PATH = `/repos/${REPO}/commits/${REVISION}`;
const BASE_TREE_PATH = `/repos/${REPO}/git/trees/${BASE}`;
const REVISION_TREE_PATH = `/repos/${REPO}/git/trees/${REVISION}`;
const RUNS_PATH = `/repos/${REPO}/actions/workflows/${WORKFLOW_ID}/runs`;
const ATTEMPT_PATH =
  `/repos/${REPO}/actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}`;
const JOBS_PATH = `${ATTEMPT_PATH}/jobs`;
const JOB_LOG_PATH = `/repos/${REPO}/actions/jobs/${JOB_ID}/logs`;

const JOB_STARTED = T0 + 1_000;
const JOB_FINISHED = T0 + 3_000;
const STEP_STARTED = T0 + 1_500;
const STEP_FINISHED = T0 + 2_500;
const TERMINAL_AT = T0 + 2_000;

const AUTHORITY = [
  ".github/workflows/repair.yml",
  "deno.json",
  "src/host/actions.ts",
  "src/host/actions-preflight.ts",
  "src/host/local.ts",
  "src/main.ts",
].map((path, index) => ({
  path,
  mode: "100644",
  type: "blob",
  sha: String(index + 11).padStart(40, "0"),
}));

const request: ReleaseRequestV1 = parseReleaseRequestV1({
  version: "v1",
  kind: "release_request",
  id: "release-actions-1",
  target: {
    repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
    environment: "production",
  },
  revision: REVISION,
  source: {
    pullRequest: PR_NUMBER,
    reviewRequestId: "review-req-1",
    reviewReceiptId: "review-receipt-1",
    head: HEAD,
    base: BASE,
  },
  status: "open",
  failureReason: null,
  createdAt: T0,
});

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponseV1 {
  return {
    status,
    headers: new Headers(headers),
    bodyText: typeof body === "string" ? body : JSON.stringify(body),
  };
}

type Handler = (
  request: HttpRequestV1,
) => HttpResponseV1 | Promise<HttpResponseV1>;

class ScriptedHttp {
  readonly calls: HttpRequestV1[] = [];
  private readonly routes = new Map<string, Handler>();
  on(method: string, path: string, handler: Handler): void {
    this.routes.set(`${method} ${path}`, handler);
  }
  readonly transport: HttpTransportV1 = (request) => {
    this.calls.push(request);
    const url = new URL(request.url);
    const handler = this.routes.get(`${request.method} ${url.pathname}`);
    if (handler === undefined) return Promise.reject(new Error("unscripted"));
    return Promise.resolve(handler(request));
  };
  callsTo(path: string): HttpRequestV1[] {
    return this.calls.filter((call) => new URL(call.url).pathname === path);
  }
}

class FakeGate implements GitHubCooldownGateV1 {
  readonly admissions: number[] = [];
  readonly recorded: GitHubRateLimitV1[] = [];
  deny = false;
  beforeRequest(installationId: number): Promise<PortResultV1<void>> {
    this.admissions.push(installationId);
    return Promise.resolve(
      this.deny
        ? portError("rate_limited", "installation is cooling down")
        : portOk(undefined),
    );
  }
  recordRateLimit(
    _installationId: number,
    rateLimit: GitHubRateLimitV1,
  ): Promise<PortResultV1<void>> {
    this.recorded.push(rateLimit);
    return Promise.resolve(portOk(undefined));
  }
}

function pullBody(): unknown {
  return {
    number: PR_NUMBER,
    state: "closed",
    merged: true,
    merge_commit_sha: REVISION,
    head: {
      sha: HEAD,
      ref: "sentinel/repair/issue-1",
      repo: { full_name: REPO },
    },
    base: { ref: "development", repo: { full_name: REPO } },
  };
}

function commitBody(): unknown {
  return {
    sha: REVISION,
    parents: [{ sha: BASE }, { sha: HEAD }],
  };
}

function treeBody(entries = AUTHORITY) {
  return { sha: REVISION, truncated: false, tree: entries };
}

function runBody(
  overrides: {
    id?: number;
    attempt?: number;
    event?: string;
    status?: string;
    conclusion?: string | null;
    workflowId?: number;
    path?: string;
    headSha?: string;
    headBranch?: string;
    repo?: string;
  } = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? RUN_ID,
    run_attempt: overrides.attempt ?? RUN_ATTEMPT,
    workflow_id: overrides.workflowId ?? WORKFLOW_ID,
    path: overrides.path ?? WORKFLOW_PATH,
    head_sha: overrides.headSha ?? REVISION,
    head_branch: overrides.headBranch ?? "development",
    event: overrides.event ?? "schedule",
    status: overrides.status ?? "completed",
    conclusion: overrides.conclusion === undefined
      ? "success"
      : overrides.conclusion,
    repository: { full_name: overrides.repo ?? REPO },
    head_repository: { full_name: overrides.repo ?? REPO },
  };
}

function attemptBody(
  overrides: {
    id?: number;
    attempt?: number;
    status?: string;
    conclusion?: string | null;
    startedAt?: number;
    updatedAt?: number;
  } = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? RUN_ID,
    run_attempt: overrides.attempt ?? RUN_ATTEMPT,
    workflow_id: WORKFLOW_ID,
    path: WORKFLOW_PATH,
    head_sha: REVISION,
    head_branch: "development",
    event: "schedule",
    status: overrides.status ?? "completed",
    conclusion: overrides.conclusion === undefined
      ? "success"
      : overrides.conclusion,
    repository: { full_name: REPO },
    head_repository: { full_name: REPO },
    run_started_at: iso(overrides.startedAt ?? JOB_STARTED),
    updated_at: iso(overrides.updatedAt ?? JOB_FINISHED),
  };
}

function jobBody(
  overrides: {
    id?: number;
    name?: string;
    runId?: number;
    attempt?: number;
    headSha?: string;
    status?: string;
    conclusion?: string | null;
    startedAt?: number;
    completedAt?: number;
    steps?: Array<Record<string, unknown>>;
  } = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? JOB_ID,
    name: overrides.name ?? "repair",
    run_id: overrides.runId ?? RUN_ID,
    run_attempt: overrides.attempt ?? RUN_ATTEMPT,
    head_sha: overrides.headSha ?? REVISION,
    status: overrides.status ?? "completed",
    conclusion: overrides.conclusion === undefined
      ? "success"
      : overrides.conclusion,
    started_at: iso(overrides.startedAt ?? JOB_STARTED),
    completed_at: iso(overrides.completedAt ?? JOB_FINISHED),
    steps: overrides.steps ?? [
      {
        name: "Repair polling run",
        status: "completed",
        conclusion: "success",
        started_at: iso(STEP_STARTED),
        completed_at: iso(STEP_FINISHED),
      },
    ],
  };
}

function jobsBody(jobs: unknown[], total = jobs.length): unknown {
  return { total_count: total, jobs };
}

function runsBody(runs: unknown[], total = runs.length): unknown {
  return { total_count: total, workflow_runs: runs };
}

function terminalLine(
  record: Record<string, unknown>,
  at: number = TERMINAL_AT,
): string {
  return `${iso(at)} ${JSON.stringify(record)}`;
}

function terminalRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: "ran",
    outcome: {
      status: "idle",
      detail: "2 records: 0 terminal, 2 blocked, 0 waiting",
    },
    controllerSha: REVISION,
    baseSha: REVISION,
    login: LOGIN,
    startupReady: true,
    ...overrides,
  };
}

const VALID_LOG = `2026-09-12T21:59:59.0000000Z Starting job\n${
  terminalLine(terminalRecord())
}\n2026-09-12T22:00:24.0000000Z done\n`;

interface RigV1 {
  gate: FakeGate;
  http: ScriptedHttp;
  read(): Promise<PortResultV1<unknown>>;
}

function makeRig(logText: string = VALID_LOG): RigV1 {
  const gate = new FakeGate();
  const http = new ScriptedHttp();
  http.on("GET", PULL_PATH, () => response(200, pullBody()));
  http.on("GET", COMMIT_PATH, () => response(200, commitBody()));
  http.on("GET", BASE_TREE_PATH, () => response(200, treeBody()));
  http.on("GET", REVISION_TREE_PATH, () => response(200, treeBody()));
  http.on("GET", RUNS_PATH, () => response(200, runsBody([runBody()])));
  http.on("GET", ATTEMPT_PATH, () => response(200, attemptBody()));
  http.on("GET", JOBS_PATH, () => response(200, jobsBody([jobBody()])));
  http.on(
    "GET",
    JOB_LOG_PATH,
    () => response(302, "", { location: SIGNED_URL }),
  );
  http.on("GET", SIGNED_PATH, () => response(200, logText));
  return {
    gate,
    http,
    read: () =>
      readActionsReleaseReceipt(
        {
          gate,
          http: http.transport,
          token: "dummy-token",
          clock: new FakeClock(JOB_FINISHED + 1_000),
          apiBaseUrl: API_BASE,
        },
        request,
      ),
  };
}

async function expectUnavailable(rig: RigV1, message: string): Promise<void> {
  const result = await rig.read();
  assert.ok(!result.ok, `${message}: expected unavailable`);
}

Deno.test(
  "actions release host: valid historical log receipt binds the exact identity",
  async () => {
    const rig = makeRig();
    const result = await rig.read();
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) throw new Error("expected a hosted receipt");
    const receipt = result.value as {
      proof: Record<string, unknown>;
      request: ReleaseRequestV1;
    };
    assert.equal(receipt.proof.runId, RUN_ID);
    assert.equal(receipt.proof.runAttempt, RUN_ATTEMPT);
    assert.equal(receipt.proof.jobId, JOB_ID);
    assert.equal(receipt.proof.outcome, "idle");
    assert.equal(receipt.proof.terminalAt, TERMINAL_AT);
    assert.equal(receipt.proof.controllerSha, REVISION);
    assert.equal(receipt.proof.baseSha, REVISION);
    assert.equal(receipt.request.id, request.id);
    // The signed log is fetched once with empty headers and no authorization.
    const signed = rig.http.callsTo(SIGNED_PATH);
    assert.equal(signed.length, 1);
    assert.equal(signed[0]!.headers.size, 0);
    assert.equal(signed[0]!.body, null);
    // No raw log content or signed URL ever appears in the receipt.
    assert.ok(!JSON.stringify(receipt).includes("signature"));
    assert.ok(!JSON.stringify(receipt).includes("Starting job"));
  },
);

Deno.test(
  "actions release host: source, run, job and attempt identity mismatches never attest",
  async () => {
    const cases: Array<{ name: string; script: (rig: RigV1) => void }> = [
      {
        name: "unmerged PR",
        script: (rig) => {
          const body = pullBody() as Record<string, unknown>;
          body.merged = false;
          rig.http.on("GET", PULL_PATH, () => response(200, body));
        },
      },
      {
        name: "wrong merge revision",
        script: (rig) => {
          const body = pullBody() as Record<string, unknown>;
          body.merge_commit_sha = SHA1;
          rig.http.on("GET", PULL_PATH, () => response(200, body));
        },
      },
      {
        name: "wrong commit parents",
        script: (rig) => {
          rig.http.on(
            "GET",
            COMMIT_PATH,
            () => response(200, { sha: REVISION, parents: [{ sha: BASE }] }),
          );
        },
      },
      {
        name: "changed deno task",
        script: (rig) => {
          const changed = treeBody().tree.map((entry) =>
            entry.path === "deno.json"
              ? { ...entry, sha: "f".repeat(40) }
              : entry
          );
          rig.http.on(
            "GET",
            REVISION_TREE_PATH,
            () =>
              response(200, { sha: REVISION, truncated: false, tree: changed }),
          );
        },
      },
      {
        name: "missing authority file",
        script: (rig) => {
          const missing = AUTHORITY.filter((entry) =>
            entry.path !== "src/main.ts"
          );
          rig.http.on(
            "GET",
            REVISION_TREE_PATH,
            () =>
              response(200, { sha: REVISION, truncated: false, tree: missing }),
          );
        },
      },
      {
        name: "truncated tree",
        script: (rig) => {
          rig.http.on("GET", REVISION_TREE_PATH, () =>
            response(200, {
              sha: REVISION,
              truncated: true,
              tree: AUTHORITY,
            }));
        },
      },
      {
        name: "wrong run head",
        script: (rig) => {
          rig.http.on(
            "GET",
            RUNS_PATH,
            () => response(200, runsBody([runBody({ headSha: SHA1 })])),
          );
        },
      },
      {
        name: "truncated run list",
        script: (rig) => {
          rig.http.on(
            "GET",
            RUNS_PATH,
            () => response(200, runsBody([runBody()], 101)),
          );
        },
      },
      {
        name: "wrong attempt number",
        script: (rig) => {
          rig.http.on(
            "GET",
            ATTEMPT_PATH,
            () => response(200, attemptBody({ attempt: 2 })),
          );
        },
      },
      {
        name: "failed job",
        script: (rig) => {
          rig.http.on(
            "GET",
            JOBS_PATH,
            () => response(200, jobsBody([jobBody({ conclusion: "failure" })])),
          );
        },
      },
      {
        name: "active job",
        script: (rig) => {
          rig.http.on("GET", JOBS_PATH, () =>
            response(
              200,
              jobsBody([jobBody({ status: "in_progress", conclusion: null })]),
            ));
        },
      },
      {
        name: "missing repair step",
        script: (rig) => {
          rig.http.on(
            "GET",
            JOBS_PATH,
            () => response(200, jobsBody([jobBody({ steps: [] })])),
          );
        },
      },
    ];
    for (const testCase of cases) {
      const rig = makeRig();
      testCase.script(rig);
      await expectUnavailable(rig, testCase.name);
    }
  },
);

Deno.test(
  "actions release host: terminal log identity, duplication and health are strict",
  async () => {
    const bad: Array<{ name: string; log: string }> = [
      {
        name: "startup false",
        log: terminalLine(terminalRecord({ startupReady: false })),
      },
      {
        name: "unhealthy outcome",
        log: terminalLine(terminalRecord({
          outcome: { status: "state_error", detail: "boom" },
        })),
      },
      {
        name: "wrong controller",
        log: terminalLine(terminalRecord({ controllerSha: SHA1 })),
      },
      {
        name: "wrong login",
        log: terminalLine(terminalRecord({ login: "octocat" })),
      },
      {
        name: "duplicate terminal",
        log: `${terminalLine(terminalRecord())}\n${
          terminalLine(terminalRecord())
        }`,
      },
      {
        name: "unknown terminal key",
        log: terminalLine(terminalRecord({ extra: true })),
      },
      {
        name: "quoted json substring",
        log: `${iso(TERMINAL_AT)} "${
          JSON.stringify(terminalRecord()).replaceAll('"', '\\"')
        }"`,
      },
      {
        name: "terminal outside step window",
        log: terminalLine(terminalRecord(), STEP_FINISHED + 60_000),
      },
      {
        name: "missing terminal",
        log: `${iso(TERMINAL_AT)} {"note":"no terminal here"}`,
      },
      {
        name: "step_limit with detail",
        log: terminalLine(terminalRecord({
          outcome: { status: "step_limit", detail: "steps" },
        })),
      },
      {
        name: "idle with steps",
        log: terminalLine(terminalRecord({
          outcome: { status: "idle", steps: 3 },
        })),
      },
      {
        name: "malformed terminal beside valid",
        log: `${terminalLine(terminalRecord())}\n${
          iso(TERMINAL_AT)
        } {"status":"ran","outcome":{"status":"idle"}}}`,
      },
    ];
    for (const testCase of bad) {
      const rig = makeRig(testCase.log);
      await expectUnavailable(rig, testCase.name);
    }
    // A known optional ciApproval summary is permitted.
    const optional = makeRig(terminalLine(terminalRecord({
      ciApproval: { approved: 1, pending: 0, unavailable: 0 },
    })));
    const result = await optional.read();
    assert.ok(result.ok && result.value !== null);
    // The actual step_limit union member (bounded count, no detail) attests.
    const stepLimit = makeRig(terminalLine(terminalRecord({
      outcome: { status: "step_limit", steps: 64 },
    })));
    const stepResult = await stepLimit.read();
    assert.ok(stepResult.ok && stepResult.value !== null);
    if (stepResult.ok && stepResult.value !== null) {
      assert.equal(
        (stepResult.value as { proof: { outcome: string } }).proof.outcome,
        "step_limit",
      );
    }
  },
);

Deno.test(
  "actions release host: log redirect host, protocol and credentials are trusted only when exact",
  async () => {
    const locations = [
      "http://productionresultssa17.blob.core.windows.net/logs/abcdef",
      "https://evil.example.com/logs/abcdef",
      "https://productionresultssa17.blob.core.windows.net.evil.com/x",
      "https://user:pass@productionresultssa17.blob.core.windows.net/logs/abcdef",
      "https://productionresultssa17.blob.core.windows.net/logs/abcdef#frag",
      "https://productionresultssa17.blob.core.windows.net:8443/logs/abcdef",
    ];
    for (const location of locations) {
      const rig = makeRig();
      rig.http.on("GET", JOB_LOG_PATH, () => response(302, "", { location }));
      await expectUnavailable(rig, location);
      assert.equal(rig.http.callsTo(SIGNED_PATH).length, 0);
    }
    const missing = makeRig();
    missing.http.on("GET", JOB_LOG_PATH, () => response(200, "raw"));
    await expectUnavailable(missing, "no redirect");
  },
);

Deno.test(
  "actions release host: cooldown denial sends no HTTP and a 429 is recorded",
  async () => {
    const denied = makeRig();
    denied.gate.deny = true;
    await expectUnavailable(denied, "cooldown denial");
    assert.equal(denied.http.calls.length, 0);
    assert.deepEqual(denied.gate.admissions, [0]);

    const limited = makeRig();
    limited.http.on(
      "GET",
      PULL_PATH,
      () => response(429, "", { "retry-after": "3600" }),
    );
    await expectUnavailable(limited, "rate limited");
    assert.equal(limited.gate.recorded.length, 1);
  },
);

Deno.test(
  "actions release host: a missing successful run is null and foreign scopes are invalid",
  async () => {
    const missing = makeRig();
    missing.http.on("GET", RUNS_PATH, () => response(200, runsBody([])));
    const result = await missing.read();
    assert.ok(result.ok && result.value === null);

    const foreign = parseReleaseRequestV1({
      ...request,
      id: "release-foreign",
      target: {
        repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 7 },
        environment: "production",
      },
    });
    const rig = makeRig();
    const foreignResult = await readActionsReleaseReceipt(
      {
        gate: rig.gate,
        http: rig.http.transport,
        token: "dummy-token",
        clock: new FakeClock(JOB_FINISHED + 1_000),
        apiBaseUrl: API_BASE,
      },
      foreign,
    );
    assert.ok(!foreignResult.ok);
    assert.equal(rig.http.calls.length, 0, "no request for a foreign scope");
  },
);

interface RawReceiptV1 {
  version: "v1";
  kind: "actions_release_receipt";
  request: ReleaseRequestV1;
  proof: Record<string, unknown>;
}

/** A strict receipt object copy for parser-binding mismatch cases. */
function rawReceipt(): RawReceiptV1 {
  return {
    version: "v1",
    kind: "actions_release_receipt",
    request: structuredClone(request),
    proof: {
      repository: "ubiquity/sentinel",
      workflowId: WORKFLOW_ID,
      workflowPath: WORKFLOW_PATH,
      branch: "development",
      event: "schedule",
      controllerSha: REVISION,
      baseSha: REVISION,
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT,
      jobId: JOB_ID,
      startedAt: T0 + 1000,
      finishedAt: JOB_FINISHED,
      terminalAt: TERMINAL_AT,
      observedAt: JOB_FINISHED + 1_000,
      outcome: "idle",
      startupReady: true,
      settled: true,
      login: LOGIN,
      logDigest: "a".repeat(64),
    },
  };
}

Deno.test(
  "actions release host: the strict parser enforces the self request binding itself",
  () => {
    const valid = parseActionsReleaseReceiptV1(rawReceipt());
    assert.equal(valid.request.id, request.id);
    const mismatches: Array<{
      name: string;
      mutate: (raw: RawReceiptV1) => void;
    }> = [
      {
        name: "controller revision",
        mutate: (raw) => {
          raw.proof.controllerSha = SHA1;
        },
      },
      {
        name: "base revision",
        mutate: (raw) => {
          raw.proof.baseSha = SHA1;
        },
      },
      {
        name: "start before the request",
        mutate: (raw) => {
          raw.proof.startedAt = T0 - 1;
        },
      },
      {
        name: "isolated environment",
        mutate: (raw) => {
          raw.request.target.environment = "isolated";
        },
      },
      {
        name: "foreign repository",
        mutate: (raw) => {
          raw.request.target.repository = {
            owner: "ubiquity",
            name: "ai.ubq.fi",
            installationId: 7,
          };
        },
      },
      {
        name: "missing review reference",
        mutate: (raw) => {
          raw.request.source.reviewReceiptId = null;
        },
      },
      {
        name: "closed request",
        mutate: (raw) => {
          raw.request.status = "fulfilled";
        },
      },
    ];
    for (const testCase of mismatches) {
      const raw = rawReceipt();
      testCase.mutate(raw);
      assert.throws(
        () => parseActionsReleaseReceiptV1(raw),
        testCase.name,
      );
    }
  },
);
