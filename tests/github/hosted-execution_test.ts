/**
 * Authenticated hosted execution reader: REAL GitHubApiClient public methods
 * over a scripted in-memory transport, with the actual GitHub API wire shapes
 * (attempt/jobs/log redirect/log lines). No network, model, token or Git.
 */
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubRateLimitV1 } from "../../src/contracts/github-cooldown.ts";
import { parseHostedRuntimeTerminalV1 } from "../../src/contracts/hosted-execution.ts";
import {
  parseHostedExecutionIntentV1,
  parseHostedRunProofV1,
} from "../../src/contracts/hosted-supervisor.ts";
import type {
  HostedExecutionIntentV1,
  HostedExecutionSettlementV1,
} from "../../src/contracts/hosted-supervisor.ts";
import type {
  Clock,
  GitHubCooldownGateV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { parseReleaseRequestV1 } from "../../src/contracts/release.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import { MaxText, tryParse } from "../../src/contracts/validation.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import type {
  HttpRequestV1,
  HttpResponseV1,
  HttpTransportV1,
} from "../../src/github/http.ts";

const API_BASE = "https://api.github.com";
const REPO = "ubiquity/sentinel";
const LAUNCHER = "1".repeat(40) as GitSha;
const REVISION = "2".repeat(40) as GitSha;
const PR_HEAD = "3".repeat(40) as GitSha;
const PR_BASE = "4".repeat(40) as GitSha;
const RUN_ID = 900;
const RUN_ATTEMPT = 2;
const JOB_ID = 901;
const PR_NUMBER = 55;
const SIGNED_URL =
  "https://productionresultssa17.blob.core.windows.net/logs/abc?sv=1&sig=x";
const SIGNED_PATH = "/logs/abc";

const T0 = 1_786_000_000_000;
const JOB_STARTED = T0 + 500;
const STEP_STARTED = T0 + 900;
const TERM_STARTED = T0 + 1000;
const TERM_AT = T0 + 1200;
const TERM_FINISHED = T0 + 1500;
const STEP_FINISHED = T0 + 2000;
const JOB_FINISHED = T0 + 2500;
const OBSERVED = T0 + 4000;

const ATTEMPT_PATH =
  `/repos/${REPO}/actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}`;
const JOBS_PATH = `${ATTEMPT_PATH}/jobs`;
const JOB_LOG_PATH = `/repos/${REPO}/actions/jobs/${JOB_ID}/logs`;
const COMPARE_PATH = `/repos/${REPO}/compare/${REVISION}...development`;
const PULL_PATH = `/repos/${REPO}/pulls/${PR_NUMBER}`;
const COMMIT_PATH = `/repos/${REPO}/commits/${REVISION}`;

class LocalClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
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

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

interface RigV1 {
  http: ScriptedHttp;
  gate: FakeGate;
  client: GitHubApiClient;
}

function makeRig(clockAt = OBSERVED): RigV1 {
  const http = new ScriptedHttp();
  const gate = new FakeGate();
  const client = new GitHubApiClient({
    repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
    apiBaseUrl: API_BASE,
    http: http.transport,
    auth: {
      authorizationHeader: () => Promise.resolve(portOk("Bearer test-token")),
    },
    cooldownGate: gate,
    clock: new LocalClock(clockAt),
  });
  return { http, gate, client };
}

function intent(
  overrides: Record<string, unknown> = {},
): HostedExecutionIntentV1 {
  return parseHostedExecutionIntentV1({
    id: `${RUN_ID}:${RUN_ATTEMPT}:repair`,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    launcherSha: LAUNCHER,
    purpose: "ordinary",
    revision: REVISION,
    generation: 2,
    releaseId: null,
    createdAt: T0,
    ...overrides,
  });
}

function attemptBody(
  overrides: {
    status?: string;
    conclusion?: string | null;
    runId?: number;
    attempt?: number;
    workflowId?: number;
    path?: string;
    headSha?: string;
    branch?: string;
    repo?: string;
    updatedAt?: number;
  } = {},
): Record<string, unknown> {
  return {
    id: overrides.runId ?? RUN_ID,
    run_attempt: overrides.attempt ?? RUN_ATTEMPT,
    workflow_id: overrides.workflowId ?? 357012162,
    path: overrides.path ?? ".github/workflows/supervisor.yml",
    head_sha: overrides.headSha ?? LAUNCHER,
    head_branch: overrides.branch ?? "sentinel-supervisor",
    event: "workflow_dispatch",
    status: overrides.status ?? "completed",
    conclusion: overrides.conclusion === undefined
      ? "success"
      : overrides.conclusion,
    repository: { full_name: overrides.repo ?? REPO },
    head_repository: { full_name: overrides.repo ?? REPO },
    run_started_at: iso(JOB_STARTED),
    updated_at: iso(overrides.updatedAt ?? JOB_FINISHED),
  };
}

function runtimeStep(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "Run selected Sentinel runtime",
    status: "completed",
    conclusion: "success",
    started_at: iso(STEP_STARTED),
    completed_at: iso(STEP_FINISHED),
    ...overrides,
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
    head_sha: overrides.headSha ?? LAUNCHER,
    status: overrides.status ?? "completed",
    conclusion: overrides.conclusion === undefined
      ? "success"
      : overrides.conclusion,
    started_at: iso(overrides.startedAt ?? JOB_STARTED),
    completed_at: iso(overrides.completedAt ?? JOB_FINISHED),
    steps: overrides.steps ?? [runtimeStep()],
  };
}

function jobsBody(jobs: unknown[], total = jobs.length): unknown {
  return { total_count: total, jobs };
}

function terminalRecord(
  executionIntent: HostedExecutionIntentV1 = intent(),
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: "v1",
    kind: "hosted_runtime_terminal",
    execution: executionIntent,
    controllerSha: REVISION,
    startedAt: TERM_STARTED,
    finishedAt: TERM_FINISHED,
    outcome: "healthy",
    startupReady: true,
    settled: true,
    baseSha: LAUNCHER,
    ...overrides,
  };
}

function logText(
  records: Array<Record<string, unknown>>,
  at: number = TERM_AT,
): string {
  return `2026-09-12T21:59:59.0000000Z Starting job\n${
    records.map((record) => `${iso(at)} ${JSON.stringify(record)}`).join("\n")
  }\n`;
}

function scriptLog(rig: RigV1, text: string, location = SIGNED_URL): void {
  rig.http.on(
    "GET",
    JOB_LOG_PATH,
    () => response(302, "", { location }),
  );
  rig.http.on("GET", SIGNED_PATH, () => response(200, text));
}

function scriptAttemptAndJobs(
  rig: RigV1,
  attempt: Record<string, unknown>,
  jobs: unknown,
  headers: Record<string, string> = {},
): void {
  rig.http.on("GET", ATTEMPT_PATH, () => response(200, attempt));
  rig.http.on("GET", JOBS_PATH, () => response(200, jobs, headers));
}

function settlementProof(
  result: PortResultV1<HostedExecutionSettlementV1 | null>,
): Extract<HostedExecutionSettlementV1, { outcome: "healthy" | "failed" }> {
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) throw new Error("expected settlement");
  assert.ok(result.value !== null);
  if (result.value === null || result.value.outcome === "not_started") {
    throw new Error("expected a run proof");
  }
  return result.value;
}

Deno.test("hosted execution: healthy finalizer settles while the attempt is in_progress", async () => {
  const rig = makeRig();
  scriptAttemptAndJobs(
    rig,
    attemptBody({ status: "in_progress", conclusion: null }),
    jobsBody([jobBody()]),
  );
  scriptLog(rig, logText([terminalRecord()]));
  const proof = settlementProof(await rig.client.readHostedExecution(intent()));
  assert.equal(proof.outcome, "healthy");
  assert.equal(proof.execution.id, intent().id);
  assert.equal(proof.jobId, JOB_ID);
  assert.equal(proof.startupReady, true);
  assert.equal(proof.baseSha, LAUNCHER);
  assert.equal(proof.terminalAt, TERM_AT);
  assert.equal(proof.startedAt, JOB_STARTED);
  assert.equal(proof.finishedAt, JOB_FINISHED);
  assert.equal(proof.logDigest.length, 64);
  // The signed blob read is token-free and never follows a redirect.
  const signed = rig.http.callsTo(SIGNED_PATH);
  assert.equal(signed.length, 1);
  assert.equal(signed[0].headers.size, 0);
  assert.equal(signed[0].redirect, "error");
  assert.ok(rig.gate.admissions.length >= 1);
});

/**
 * Real GitHub post-action step names exceed the 64-char label bound; the step
 * name alone uses the wider path bound while the job name keeps the label one.
 */
function postStep(name: string): Record<string, unknown> {
  return {
    name,
    status: "completed",
    conclusion: "success",
    started_at: iso(STEP_FINISHED + 100),
    completed_at: iso(STEP_FINISHED + 200),
  };
}

Deno.test("hosted execution: real pinned post-action step names do not exceed the runtime step-name bound", async () => {
  const rig = makeRig();
  scriptAttemptAndJobs(
    rig,
    attemptBody({ status: "in_progress", conclusion: null }),
    jobsBody([
      jobBody({
        steps: [
          runtimeStep(),
          postStep(
            "Post Run actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
          ),
          postStep(
            "Post Run denoland/setup-deno@22d081ff2d3a40755e97629de92e3bcbfa7cf2ed",
          ),
        ],
      }),
    ]),
  );
  scriptLog(rig, logText([terminalRecord()]));
  const proof = settlementProof(await rig.client.readHostedExecution(intent()));
  assert.equal(proof.outcome, "healthy");
  assert.equal(proof.jobId, JOB_ID);
  assert.equal(proof.terminalAt, TERM_AT);

  // The bound is still enforced: one character over MaxText.path is refused.
  const over = makeRig();
  scriptAttemptAndJobs(
    over,
    attemptBody({ status: "in_progress", conclusion: null }),
    jobsBody([
      jobBody({
        steps: [runtimeStep(), postStep("x".repeat(MaxText.path + 1))],
      }),
    ]),
  );
  scriptLog(over, logText([terminalRecord()]));
  assert.equal((await over.client.readHostedExecution(intent())).ok, false);
});

Deno.test("hosted execution: an explicit failed terminal or failed job is a failed proof, never healthy", async () => {
  const failedTerminal = makeRig();
  scriptAttemptAndJobs(failedTerminal, attemptBody(), jobsBody([jobBody()]));
  scriptLog(
    failedTerminal,
    logText([
      terminalRecord(intent(), {
        outcome: "failed",
        startupReady: false,
        baseSha: null,
      }),
    ]),
  );
  const explicit = settlementProof(
    await failedTerminal.client.readHostedExecution(intent()),
  );
  assert.equal(explicit.outcome, "failed");
  assert.equal(explicit.startupReady, false);
  assert.equal(explicit.baseSha, null);

  const failedJob = makeRig();
  scriptAttemptAndJobs(
    failedJob,
    attemptBody(),
    jobsBody([
      jobBody({
        conclusion: "failure",
        steps: [runtimeStep({ conclusion: "failure" })],
      }),
    ]),
  );
  scriptLog(
    failedJob,
    logText([
      terminalRecord(intent(), {
        outcome: "failed",
        startupReady: false,
        baseSha: null,
      }),
    ]),
  );
  const jobFailed = settlementProof(
    await failedJob.client.readHostedExecution(intent()),
  );
  assert.equal(jobFailed.outcome, "failed");

  // A healthy terminal with a failed job is contradictory, never rewritten.
  const mixed = makeRig();
  scriptAttemptAndJobs(
    mixed,
    attemptBody(),
    jobsBody([jobBody({ conclusion: "failure" })]),
  );
  scriptLog(mixed, logText([terminalRecord()]));
  assert.equal(
    (await mixed.client.readHostedExecution(intent())).ok,
    false,
  );

  // The same contradiction with a failed runtime step and healthy terminal.
  const stepMixed = makeRig();
  scriptAttemptAndJobs(
    stepMixed,
    attemptBody(),
    jobsBody([jobBody({ steps: [runtimeStep({ conclusion: "failure" })] })]),
  );
  scriptLog(stepMixed, logText([terminalRecord()]));
  assert.equal(
    (await stepMixed.client.readHostedExecution(intent())).ok,
    false,
  );
});

Deno.test("hosted execution: skipped, cancelled, timed-out or absent completed repair jobs are explicit not_started", async () => {
  const skipped = makeRig();
  scriptAttemptAndJobs(
    skipped,
    attemptBody(),
    jobsBody([jobBody({ conclusion: "skipped" })]),
  );
  const skippedResult = await skipped.client.readHostedExecution(intent());
  assert.ok(skippedResult.ok && skippedResult.value?.outcome === "not_started");
  if (skippedResult.ok && skippedResult.value?.outcome === "not_started") {
    assert.equal(skippedResult.value.jobId, JOB_ID);
    assert.equal(skippedResult.value.finishedAt, JOB_FINISHED);
    assert.equal(skippedResult.value.execution.id, intent().id);
    assert.equal(skippedResult.value.evidenceDigest.length, 64);
  }

  const cancelled = makeRig();
  scriptAttemptAndJobs(
    cancelled,
    attemptBody(),
    jobsBody([jobBody({ conclusion: "cancelled" })]),
  );
  const cancelledResult = await cancelled.client.readHostedExecution(intent());
  assert.ok(
    cancelledResult.ok && cancelledResult.value?.outcome === "not_started",
  );
  if (
    cancelledResult.ok && cancelledResult.value?.outcome === "not_started"
  ) {
    assert.equal(cancelledResult.value.jobId, JOB_ID);
    assert.equal(cancelledResult.value.finishedAt, JOB_FINISHED);
  }

  const timedOut = makeRig();
  scriptAttemptAndJobs(
    timedOut,
    attemptBody(),
    jobsBody([jobBody({ conclusion: "timed_out" })]),
  );
  const timedOutResult = await timedOut.client.readHostedExecution(intent());
  assert.ok(
    timedOutResult.ok && timedOutResult.value?.outcome === "not_started",
  );

  const absent = makeRig();
  scriptAttemptAndJobs(absent, attemptBody(), jobsBody([]));
  const absentResult = await absent.client.readHostedExecution(intent());
  assert.ok(absentResult.ok && absentResult.value?.outcome === "not_started");
  if (absentResult.ok && absentResult.value?.outcome === "not_started") {
    assert.equal(absentResult.value.jobId, null);
    assert.equal(absentResult.value.finishedAt, JOB_FINISHED);
  }

  const stepSkipped = makeRig();
  scriptAttemptAndJobs(
    stepSkipped,
    attemptBody(),
    jobsBody([
      jobBody({
        steps: [
          runtimeStep({
            conclusion: "skipped",
            started_at: null,
            completed_at: null,
          }),
        ],
      }),
    ]),
  );
  const stepSkippedResult = await stepSkipped.client.readHostedExecution(
    intent(),
  );
  assert.ok(
    stepSkippedResult.ok && stepSkippedResult.value?.outcome === "not_started",
  );
  if (
    stepSkippedResult.ok && stepSkippedResult.value?.outcome === "not_started"
  ) {
    assert.equal(stepSkippedResult.value.jobId, JOB_ID);
    assert.equal(stepSkippedResult.value.finishedAt, JOB_FINISHED);
  }
});

Deno.test("hosted execution: an absent repair job in an in_progress attempt is pending", async () => {
  const rig = makeRig();
  scriptAttemptAndJobs(
    rig,
    attemptBody({ status: "in_progress", conclusion: null }),
    jobsBody([]),
  );
  const result = await rig.client.readHostedExecution(intent());
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.value, null);
});

Deno.test("hosted execution: foreign attempt, launcher, terminal execution or controller are unavailable", async () => {
  const cases: Array<(rig: RigV1) => void> = [
    (rig) =>
      scriptAttemptAndJobs(
        rig,
        attemptBody({ workflowId: 1 }),
        jobsBody([jobBody()]),
      ),
    (rig) =>
      scriptAttemptAndJobs(
        rig,
        attemptBody({ branch: "development" }),
        jobsBody([jobBody()]),
      ),
    (rig) =>
      scriptAttemptAndJobs(
        rig,
        attemptBody({ repo: "ubiquity/other" }),
        jobsBody([jobBody()]),
      ),
    (rig) => {
      scriptAttemptAndJobs(rig, attemptBody(), jobsBody([jobBody()]));
      scriptLog(
        rig,
        logText([
          terminalRecord(intent({ runAttempt: 3, id: `${RUN_ID}:3:repair` })),
        ]),
      );
    },
    (rig) => {
      scriptAttemptAndJobs(rig, attemptBody(), jobsBody([jobBody()]));
      scriptLog(
        rig,
        logText([
          terminalRecord(intent(), { controllerSha: LAUNCHER }),
        ]),
      );
    },
  ];
  for (const script of cases) {
    const rig = makeRig();
    script(rig);
    const result = await rig.client.readHostedExecution(intent());
    assert.equal(result.ok, false, JSON.stringify(result));
  }
});

Deno.test("hosted execution: duplicate, malformed or key-extended terminals are never trusted", async () => {
  const duplicate = makeRig();
  scriptAttemptAndJobs(duplicate, attemptBody(), jobsBody([jobBody()]));
  scriptLog(duplicate, logText([terminalRecord(), terminalRecord()]));
  assert.equal(
    (await duplicate.client.readHostedExecution(intent())).ok,
    false,
  );

  const malformed = makeRig();
  scriptAttemptAndJobs(malformed, attemptBody(), jobsBody([jobBody()]));
  const truncated =
    `2026-09-12T22:00:01.0000000Z {"kind":"hosted_runtime_terminal","execution":`;
  scriptLog(malformed, `${truncated}\n${logText([terminalRecord()])}`);
  assert.equal(
    (await malformed.client.readHostedExecution(intent())).ok,
    false,
  );

  // Version-first truncated text still names the trusted kind.
  const versionFirst = makeRig();
  scriptAttemptAndJobs(versionFirst, attemptBody(), jobsBody([jobBody()]));
  const versionTruncated =
    `2026-09-12T22:00:01.0000000Z {"version":"v1","kind":"hosted_runtime_terminal","execution":`;
  scriptLog(
    versionFirst,
    `${versionTruncated}\n${logText([terminalRecord()])}`,
  );
  assert.equal(
    (await versionFirst.client.readHostedExecution(intent())).ok,
    false,
  );

  const unknownKey = makeRig();
  scriptAttemptAndJobs(unknownKey, attemptBody(), jobsBody([jobBody()]));
  scriptLog(unknownKey, logText([terminalRecord(intent(), { extra: true })]));
  assert.equal(
    (await unknownKey.client.readHostedExecution(intent())).ok,
    false,
  );

  // Parse boundary: a healthy terminal without startup/base is rejected.
  assert.throws(() =>
    parseHostedRuntimeTerminalV1(
      terminalRecord(intent(), { baseSha: null }),
    )
  );
  assert.ok(
    tryParse(parseHostedRunProofV1, {
      execution: intent(),
      workflowId: 357012162,
      workflowPath: ".github/workflows/supervisor.yml",
      repository: "ubiquity/sentinel",
      ref: "refs/heads/sentinel-supervisor",
      jobId: 1,
      startedAt: TERM_STARTED,
      finishedAt: TERM_FINISHED,
      observedAt: OBSERVED,
      outcome: "healthy",
      startupReady: true,
      settled: true,
      baseSha: null,
      terminalAt: TERM_AT,
      logDigest: "a".repeat(64),
    }).ok === false,
  );
});

Deno.test("hosted execution: duplicate jobs, incomplete listings and next links are unavailable", async () => {
  const duplicate = makeRig();
  scriptAttemptAndJobs(
    duplicate,
    attemptBody(),
    jobsBody([jobBody(), jobBody({ id: JOB_ID + 1 })]),
  );
  assert.equal(
    (await duplicate.client.readHostedExecution(intent())).ok,
    false,
  );

  const incomplete = makeRig();
  scriptAttemptAndJobs(
    incomplete,
    attemptBody(),
    jobsBody([jobBody()], 2),
  );
  assert.equal(
    (await incomplete.client.readHostedExecution(intent())).ok,
    false,
  );

  const next = makeRig();
  scriptAttemptAndJobs(
    next,
    attemptBody(),
    jobsBody([jobBody()]),
    { link: `<${API_BASE}${JOBS_PATH}?page=2>; rel="next"` },
  );
  assert.equal((await next.client.readHostedExecution(intent())).ok, false);
});

Deno.test("hosted execution: untrusted log redirects and non-302 log responses fail closed", async () => {
  const untrusted = makeRig();
  scriptAttemptAndJobs(untrusted, attemptBody(), jobsBody([jobBody()]));
  scriptLog(untrusted, logText([terminalRecord()]), "https://evil.example/log");
  const untrustedResult = await untrusted.client.readHostedExecution(intent());
  assert.equal(untrustedResult.ok, false);
  assert.equal(untrusted.http.callsTo(SIGNED_PATH).length, 0);

  const notRedirect = makeRig();
  scriptAttemptAndJobs(notRedirect, attemptBody(), jobsBody([jobBody()]));
  notRedirect.http.on("GET", JOB_LOG_PATH, () => response(200, "raw log"));
  assert.equal(
    (await notRedirect.client.readHostedExecution(intent())).ok,
    false,
  );
});

Deno.test("hosted execution: the durable gate denies before HTTP and rate limits are recorded", async () => {
  const denied = makeRig();
  denied.gate.deny = true;
  const deniedResult = await denied.client.readHostedExecution(intent());
  assert.equal(deniedResult.ok, false);
  if (!deniedResult.ok) {
    assert.equal(deniedResult.error.kind, "rate_limited");
  }
  assert.equal(denied.http.calls.length, 0);

  const limited = makeRig();
  scriptAttemptAndJobs(
    limited,
    attemptBody(),
    jobsBody([jobBody()]),
  );
  limited.http.on(
    "GET",
    JOBS_PATH,
    () =>
      response(403, {}, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-reset": String(Math.floor((T0 + 60_000) / 1000)),
      }),
  );
  const limitedResult = await limited.client.readHostedExecution(intent());
  assert.equal(limitedResult.ok, false);
  if (!limitedResult.ok) {
    assert.equal(limitedResult.error.kind, "rate_limited");
  }
  assert.equal(limited.gate.recorded.length, 1);
});

/** Real compare API shape: no head_commit; counters match the status. */
function compareBody(overrides: Record<string, unknown> = {}): unknown {
  const status = typeof overrides.status === "string"
    ? overrides.status
    : "ahead";
  const counters = status === "identical"
    ? { ahead_by: 0, behind_by: 0, total_commits: 0 }
    : status === "behind"
    ? { ahead_by: 0, behind_by: 2, total_commits: 2 }
    : status === "diverged"
    ? { ahead_by: 2, behind_by: 1, total_commits: 3 }
    : { ahead_by: 3, behind_by: 0, total_commits: 3 };
  return {
    status,
    base_commit: { sha: REVISION },
    merge_base_commit: { sha: REVISION },
    ...counters,
    ...overrides,
  };
}

Deno.test("hosted execution: revision ancestry accepts ahead/identical only with the exact base and merge base", async () => {
  const ahead = makeRig();
  ahead.http.on("GET", COMPARE_PATH, () => response(200, compareBody()));
  const aheadResult = await ahead.client.verifyHostedRevision(REVISION);
  assert.ok(aheadResult.ok && aheadResult.value === true);

  const identical = makeRig();
  identical.http.on(
    "GET",
    COMPARE_PATH,
    () => response(200, compareBody({ status: "identical" })),
  );
  const identicalResult = await identical.client.verifyHostedRevision(
    REVISION,
  );
  assert.ok(identicalResult.ok && identicalResult.value === true);

  for (
    const body of [
      compareBody({ status: "behind" }),
      compareBody({ status: "diverged" }),
      compareBody({ base_commit: { sha: LAUNCHER } }),
      compareBody({ merge_base_commit: { sha: LAUNCHER } }),
    ]
  ) {
    const rig = makeRig();
    rig.http.on("GET", COMPARE_PATH, () => response(200, body));
    const result = await rig.client.verifyHostedRevision(REVISION);
    assert.ok(result.ok && result.value === false, JSON.stringify(result));
  }

  // Malformed counters or a missing counter field are unavailable.
  for (
    const body of [
      compareBody({ total_commits: 1 }),
      compareBody({ status: "identical", ahead_by: 1, total_commits: 1 }),
      { status: "ahead", base_commit: { sha: REVISION } },
    ]
  ) {
    const rig = makeRig();
    rig.http.on("GET", COMPARE_PATH, () => response(200, body));
    assert.equal(
      (await rig.client.verifyHostedRevision(REVISION)).ok,
      false,
      JSON.stringify(body),
    );
  }
});

function requestFixture(
  overrides: Record<string, unknown> = {},
): ReleaseRequestV1 {
  return parseReleaseRequestV1({
    version: "v1",
    kind: "release_request",
    id: "release-hosted-1",
    target: {
      repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
      environment: "production",
    },
    revision: REVISION,
    source: {
      pullRequest: PR_NUMBER,
      reviewRequestId: "review-req-1",
      reviewReceiptId: "review-receipt-1",
      head: PR_HEAD,
      base: PR_BASE,
    },
    status: "open",
    failureReason: null,
    createdAt: T0,
    ...overrides,
  });
}

Deno.test("hosted execution: release requests require the merged two-parent PR plus exact ancestry", async () => {
  const good = makeRig();
  good.http.on("GET", PULL_PATH, () =>
    response(200, {
      number: PR_NUMBER,
      state: "closed",
      merged: true,
      merge_commit_sha: REVISION,
      head: {
        sha: PR_HEAD,
        ref: "sentinel/repair/x",
        repo: { full_name: REPO },
      },
      base: { ref: "development", repo: { full_name: REPO } },
    }));
  good.http.on("GET", COMMIT_PATH, () =>
    response(200, {
      sha: REVISION,
      parents: [{ sha: PR_BASE }, { sha: PR_HEAD }],
    }));
  good.http.on("GET", COMPARE_PATH, () => response(200, compareBody()));
  const verified = await good.client.verifyHostedReleaseRequest(
    requestFixture(),
  );
  assert.ok(verified.ok && verified.value === true);

  const wrongParents = makeRig();
  wrongParents.http.on("GET", PULL_PATH, () =>
    response(200, {
      number: PR_NUMBER,
      state: "closed",
      merged: true,
      merge_commit_sha: REVISION,
      head: {
        sha: PR_HEAD,
        ref: "sentinel/repair/x",
        repo: { full_name: REPO },
      },
      base: { ref: "development", repo: { full_name: REPO } },
    }));
  wrongParents.http.on("GET", COMMIT_PATH, () =>
    response(200, {
      sha: REVISION,
      parents: [{ sha: PR_BASE }, { sha: LAUNCHER }],
    }));
  const mismatch = await wrongParents.client.verifyHostedReleaseRequest(
    requestFixture(),
  );
  assert.ok(mismatch.ok && mismatch.value === false);

  // Foreign scope, cancelled or review-less requests never reach the network.
  for (
    const request of [
      requestFixture({ status: "cancelled", failureReason: "cancelled" }),
      requestFixture({
        target: {
          repository: {
            owner: "ubiquity",
            name: "sentinel",
            installationId: 7,
          },
          environment: "production",
        },
      }),
      requestFixture({
        source: {
          pullRequest: PR_NUMBER,
          reviewRequestId: "review-req-1",
          reviewReceiptId: null,
          head: PR_HEAD,
          base: PR_BASE,
        },
      }),
    ]
  ) {
    const rig = makeRig();
    const result = await rig.client.verifyHostedReleaseRequest(request);
    assert.ok(result.ok && result.value === false);
    assert.equal(rig.http.calls.length, 0);
  }
});

Deno.test("hosted execution: future, inverted or early-terminal metadata is refused", async () => {
  const futureAttempt = makeRig();
  scriptAttemptAndJobs(
    futureAttempt,
    attemptBody({ updatedAt: OBSERVED + 5000 }),
    jobsBody([jobBody()]),
  );
  scriptLog(futureAttempt, logText([terminalRecord()]));
  assert.equal(
    (await futureAttempt.client.readHostedExecution(intent())).ok,
    false,
  );

  const futureJob = makeRig();
  scriptAttemptAndJobs(
    futureJob,
    attemptBody(),
    jobsBody([
      jobBody({
        completedAt: OBSERVED + 5000,
        steps: [runtimeStep({ completedAt: OBSERVED + 5000 })],
      }),
    ]),
  );
  scriptLog(futureJob, logText([terminalRecord()]));
  assert.equal(
    (await futureJob.client.readHostedExecution(intent())).ok,
    false,
  );

  const invertedAttempt = makeRig();
  scriptAttemptAndJobs(
    invertedAttempt,
    attemptBody({ updatedAt: T0 - 1000 }),
    jobsBody([jobBody()]),
  );
  scriptLog(invertedAttempt, logText([terminalRecord()]));
  assert.equal(
    (await invertedAttempt.client.readHostedExecution(intent())).ok,
    false,
  );

  const invertedJob = makeRig();
  scriptAttemptAndJobs(
    invertedJob,
    attemptBody(),
    jobsBody([jobBody({ startedAt: JOB_FINISHED, completedAt: JOB_STARTED })]),
  );
  scriptLog(invertedJob, logText([terminalRecord()]));
  assert.equal(
    (await invertedJob.client.readHostedExecution(intent())).ok,
    false,
  );

  // A terminal emitted before its own finish cannot be trusted.
  const earlyTerminal = makeRig();
  scriptAttemptAndJobs(earlyTerminal, attemptBody(), jobsBody([jobBody()]));
  scriptLog(earlyTerminal, logText([terminalRecord()], TERM_FINISHED - 3000));
  assert.equal(
    (await earlyTerminal.client.readHostedExecution(intent())).ok,
    false,
  );
});
