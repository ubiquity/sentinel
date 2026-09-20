/**
 * Real protected hosted composition: `runHostedSupervisorHost` over the actual
 * core, the authenticated native GitHub client, real temporary source and
 * release/repair Git stores and a scripted HTTP transport. No network, model,
 * GitHub write or deployment is performed.
 */
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import type { Clock } from "../../src/contracts/ports.ts";
import type { HostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type {
  HttpRequestV1,
  HttpResponseV1,
  HttpTransportV1,
} from "../../src/github/http.ts";
import { runHostedSupervisorHost } from "../../src/host/actions-supervisor.ts";
import type { HostedSupervisorHostResultV1 } from "../../src/host/actions-supervisor.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
} from "../../src/state/mod.ts";
import type {
  GitStateStore,
  ReleaseGitStateStore,
  RepairGitStateStore,
} from "../../src/state/mod.ts";
import { gitRun, makeRemoteCtx, T0, testGitEnv } from "../state/helpers.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/host\/hosted-workflow_test\.ts$/,
  "",
);

const REPO = "ubiquity/sentinel";
const RUN_ID = 1;
const JOB_ID = 901;
const NATIVE_TOKEN = "native-token-0123456789";
const HOUR_MS = 3_600_000;
const OTHER_SHA = "9".repeat(40) as GitSha;
const SIGNED_URL =
  "https://productionresultssa17.blob.core.windows.net/logs/abc?sv=1&sig=x";
const SIGNED_PATH = "/logs/abc";
const ATTEMPT_PATH = `/repos/${REPO}/actions/runs/${RUN_ID}/attempts/1`;
const JOBS_PATH = `${ATTEMPT_PATH}/jobs`;
const JOB_LOG_PATH = `/repos/${REPO}/actions/jobs/${JOB_ID}/logs`;

const JOB_STARTED = T0 + 500;
const STEP_STARTED = T0 + 900;
const TERM_STARTED = T0 + 1000;
const TERM_AT = T0 + 1200;
const TERM_FINISHED = T0 + 1500;
const STEP_FINISHED = T0 + 2000;
const JOB_FINISHED = T0 + 2500;
const OBSERVED = T0 + 4000;

class StepClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
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
}

function response(status: number, body: unknown, headers = {}): HttpResponseV1 {
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
  sourceDir: string;
  launcherSha: GitSha;
  http: ScriptedHttp;
  clock: StepClock;
  state: ReleaseGitStateStore;
  repair: RepairGitStateStore;
  output: string[];
  releaseSnapshot(): Promise<ReleaseStateSnapshotV1>;
  releaseHead(): Promise<GitSha | null>;
  run(
    job: "prepare" | "finalize",
    runId: number,
    env?: Record<string, string | undefined>,
  ): Promise<HostedSupervisorHostResultV1>;
  cleanup(): Promise<void>;
}

async function makeCheckout(
  dir: string,
  env: Record<string, string>,
): Promise<GitSha> {
  await Deno.mkdir(dir, { recursive: true });
  await gitRun(dir, ["init", "-q"], env);
  await Deno.writeTextFile(`${dir}/README.md`, "launcher\n");
  await Deno.writeTextFile(`${dir}/.gitignore`, ".sentinel/\n");
  await gitRun(dir, ["add", "-A"], env);
  const committed = await gitRun(dir, ["commit", "-q", "-m", "fixture"], env);
  assert.ok(committed.ok, committed.stderr);
  const head = await gitRun(dir, ["rev-parse", "HEAD"], env);
  assert.ok(head.ok, head.stderr);
  return head.stdout.trim() as GitSha;
}

function emptyReleaseSnapshot(): ReleaseStateSnapshotV1 {
  return parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    releases: [],
    hostedRuntimes: [],
    hostedReleases: [],
    githubCooldowns: [],
  });
}

function emptyRepairSnapshot() {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
  });
}

function hostEnv(
  launcherSha: GitSha,
  job: "prepare" | "finalize",
  runId: number,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    GITHUB_RUN_ID: String(runId),
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REPOSITORY: REPO,
    GITHUB_REF: "refs/heads/sentinel-supervisor",
    GITHUB_SHA: launcherSha,
    GITHUB_WORKFLOW_SHA: launcherSha,
    GITHUB_WORKFLOW_REF:
      `${REPO}/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor`,
    GITHUB_JOB: job,
    GITHUB_TOKEN: NATIVE_TOKEN,
    PATH: "/usr/bin:/bin",
    ...overrides,
  };
}

function outputWriter(
  output: string[],
): (name: string, value: string) => Promise<void> {
  return (name, value) => {
    output.push(`${name}=${value}`);
    return Promise.resolve();
  };
}

async function makeRig(): Promise<RigV1> {
  const root = await Deno.makeTempDir({
    prefix: "sentinel-hosted-workflow-",
    dir: ROOT,
  });
  const env = testGitEnv(`${root}/git-home`);
  await Deno.mkdir(`${root}/git-home`, { recursive: true });
  const sourceDir = `${root}/source`;
  const launcherSha = await makeCheckout(sourceDir, env);
  const remote = await makeRemoteCtx(root, env);
  const state = createReleaseStateStore({
    scratchDir: `${root}/release-scratch`,
    remoteUrl: remote.remoteUrl,
  });
  const repair = createRepairStateStore({
    scratchDir: `${root}/repair-scratch`,
    remoteUrl: remote.remoteUrl,
  });
  const seededRelease = await state.writeRelease(emptyReleaseSnapshot(), null);
  assert.ok(seededRelease.ok && seededRelease.value.status === "applied");
  const seededRepair = await repair.writeRepair(emptyRepairSnapshot(), null);
  assert.ok(seededRepair.ok && seededRepair.value.status === "applied");

  const http = new ScriptedHttp();
  const clock = new StepClock(T0);
  const output: string[] = [];
  const releaseSnapshot = async () => {
    const read = await state.readRelease();
    assert.ok(read.ok && read.value.status === "found");
    if (!read.ok || read.value.status !== "found") {
      throw new Error("missing release state");
    }
    return read.value.snapshot;
  };
  return {
    sourceDir,
    launcherSha,
    http,
    clock,
    state,
    repair,
    output,
    releaseSnapshot,
    releaseHead: async () => {
      const read = await state.readRelease();
      assert.ok(read.ok);
      if (!read.ok) throw new Error("release read failed");
      return read.value.status === "found" ? read.value.head : null;
    },
    run: (job, runId, overrides = {}) =>
      runHostedSupervisorHost({
        env: hostEnv(launcherSha, job, runId, overrides),
        sourceDir,
        clock,
        http: http.transport,
        state,
        process: new DenoReplayRuntime(Deno.execPath()),
        writeOutput: job === "prepare" ? outputWriter(output) : undefined,
      }),
    cleanup: async () => {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

function scriptCompare(rig: RigV1): void {
  rig.http.on(
    "GET",
    `/repos/${REPO}/compare/${rig.launcherSha}...development`,
    () =>
      response(200, {
        status: "ahead",
        base_commit: { sha: rig.launcherSha },
        merge_base_commit: { sha: rig.launcherSha },
        ahead_by: 1,
        behind_by: 0,
        total_commits: 1,
      }),
  );
}

function scriptFinalize(rig: RigV1, saved: HostedExecutionIntentV1): void {
  rig.http.on("GET", ATTEMPT_PATH, () =>
    response(200, {
      id: RUN_ID,
      run_attempt: 1,
      workflow_id: 357012162,
      path: ".github/workflows/supervisor.yml",
      head_sha: rig.launcherSha,
      head_branch: "sentinel-supervisor",
      event: "workflow_dispatch",
      status: "in_progress",
      conclusion: null,
      repository: { full_name: REPO },
      head_repository: { full_name: REPO },
      run_started_at: iso(JOB_STARTED),
      updated_at: iso(JOB_FINISHED),
    }));
  rig.http.on("GET", JOBS_PATH, () =>
    response(200, {
      total_count: 1,
      jobs: [{
        id: JOB_ID,
        name: "repair",
        run_id: RUN_ID,
        run_attempt: 1,
        head_sha: rig.launcherSha,
        status: "completed",
        conclusion: "success",
        started_at: iso(JOB_STARTED),
        completed_at: iso(JOB_FINISHED),
        steps: [{
          name: "Run selected Sentinel runtime",
          status: "completed",
          conclusion: "success",
          started_at: iso(STEP_STARTED),
          completed_at: iso(STEP_FINISHED),
        }],
      }],
    }));
  const record = {
    version: "v1",
    kind: "hosted_runtime_terminal",
    execution: saved,
    controllerSha: saved.revision,
    startedAt: TERM_STARTED,
    finishedAt: TERM_FINISHED,
    outcome: "healthy",
    startupReady: true,
    settled: true,
    baseSha: saved.revision,
  };
  rig.http.on("GET", JOB_LOG_PATH, () =>
    response(302, "", {
      location: SIGNED_URL,
    }));
  rig.http.on("GET", SIGNED_PATH, () =>
    response(
      200,
      `2026-09-12T21:59:59.0000000Z Starting job\n${iso(TERM_AT)} ${
        JSON.stringify(record)
      }\n`,
    ));
}

Deno.test("hosted workflow: prepare saves the bootstrap intent and exact output revision", async () => {
  const rig = await makeRig();
  try {
    scriptCompare(rig);
    const result = await rig.run("prepare", RUN_ID);
    assert.equal(result.status, "run", JSON.stringify(result));
    assert.equal(result.run, true);
    assert.equal(result.revision, rig.launcherSha);
    assert.equal(result.execution?.purpose, "bootstrap");
    assert.equal(result.execution?.revision, rig.launcherSha);
    assert.deepEqual(rig.output, ["run=true", `revision=${rig.launcherSha}`]);

    const snapshot = await rig.releaseSnapshot();
    assert.equal(snapshot.hostedRuntimes.length, 1);
    assert.equal(
      snapshot.hostedRuntimes[0].execution?.id,
      `${RUN_ID}:1:repair`,
    );
    assert.equal(
      snapshot.hostedRuntimes[0].execution?.launcherSha,
      rig.launcherSha,
    );
    // Every native API request carried the native token, never an App token.
    assert.equal(rig.http.calls.length, 1);
    assert.equal(
      rig.http.calls[0].headers.get("authorization"),
      `Bearer ${NATIVE_TOKEN}`,
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted workflow: finalize settles the exact completed repair job while the attempt is in_progress", async () => {
  const rig = await makeRig();
  try {
    scriptCompare(rig);
    const prepared = await rig.run("prepare", RUN_ID);
    assert.equal(prepared.status, "run");
    assert.ok(prepared.execution !== null);
    if (prepared.execution === null) throw new Error("unreachable");
    rig.output.length = 0;

    rig.clock.advance(OBSERVED - T0);
    scriptFinalize(rig, prepared.execution);
    const finalized = await rig.run("finalize", RUN_ID);
    assert.equal(finalized.status, "idle", JSON.stringify(finalized));
    assert.equal(finalized.run, false);
    assert.equal(finalized.execution, null);
    assert.deepEqual(rig.output, [], "finalize writes no outputs");

    const snapshot = await rig.releaseSnapshot();
    assert.equal(snapshot.hostedRuntimes[0].execution, null);
    assert.equal(
      snapshot.hostedRuntimes[0].lastExecutionProof?.outcome,
      "healthy",
    );
    assert.ok(
      rig.http.calls.some((call) =>
        call.url.includes(`/actions/runs/${RUN_ID}/attempts/1`)
      ),
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted workflow: ordinary work starts only after its due time", async () => {
  const rig = await makeRig();
  try {
    scriptCompare(rig);
    const prepared = await rig.run("prepare", RUN_ID);
    assert.ok(prepared.execution !== null);
    if (prepared.execution === null) throw new Error("unreachable");
    rig.clock.advance(OBSERVED - T0);
    scriptFinalize(rig, prepared.execution);
    assert.equal((await rig.run("finalize", RUN_ID)).status, "idle");
    rig.output.length = 0;

    // Not yet due: the runtime is healthy but nextOrdinaryAt has not passed.
    const early = await rig.run("prepare", RUN_ID + 1);
    assert.equal(early.status, "idle", JSON.stringify(early));
    assert.equal(early.run, false, JSON.stringify(early));
    assert.deepEqual(rig.output, ["run=false"]);

    rig.output.length = 0;
    rig.clock.advance(HOUR_MS + 1000);
    const due = await rig.run("prepare", RUN_ID + 2);
    assert.equal(due.status, "run", JSON.stringify(due));
    assert.equal(due.execution?.purpose, "ordinary");
    assert.equal(due.revision, rig.launcherSha);
    assert.deepEqual(rig.output, ["run=true", `revision=${rig.launcherSha}`]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted workflow: identity or source mismatch has no API, output or state side effects", async () => {
  const rig = await makeRig();
  try {
    const head = await rig.releaseHead();
    const before = await rig.releaseSnapshot();
    scriptCompare(rig);

    await assert.rejects(
      rig.run("prepare", RUN_ID, {
        GITHUB_SHA: OTHER_SHA,
        GITHUB_WORKFLOW_SHA: OTHER_SHA,
      }),
      /source checkout is not the exact clean revision/,
    );
    await assert.rejects(
      rig.run("prepare", RUN_ID, { GITHUB_REPOSITORY: "ubiquity/other" }),
      /identity is invalid/,
    );
    await assert.rejects(
      rig.run("prepare", RUN_ID, { GITHUB_JOB: "repair" }),
      /job identity is invalid/,
    );
    await assert.rejects(
      rig.run("prepare", RUN_ID, { GITHUB_TOKEN: "" }),
      /credentials are unavailable/,
    );

    assert.equal(rig.http.calls.length, 0, "no API request was made");
    assert.deepEqual(rig.output, [], "no output was written");
    assert.equal(await rig.releaseHead(), head);
    const after = await rig.releaseSnapshot();
    assert.deepEqual(after, before, "release state is untouched");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted workflow: prepare without an output sink is refused before any side effect", async () => {
  const rig = await makeRig();
  try {
    const head = await rig.releaseHead();
    const before = await rig.releaseSnapshot();
    scriptCompare(rig);
    await assert.rejects(
      runHostedSupervisorHost({
        env: hostEnv(rig.launcherSha, "prepare", RUN_ID),
        sourceDir: rig.sourceDir,
        clock: rig.clock,
        http: rig.http.transport,
        state: rig.state,
        process: new DenoReplayRuntime(Deno.execPath()),
      }),
      /prepare output is unavailable/,
    );
    assert.equal(rig.http.calls.length, 0, "no API request was made");
    assert.deepEqual(rig.output, [], "no output was written");
    assert.equal(await rig.releaseHead(), head);
    assert.deepEqual(await rig.releaseSnapshot(), before);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted workflow: the shared cooldown gate blocks a new native request", async () => {
  const rig = await makeRig();
  try {
    // A manual scope-0 hold in the release state denies before any request.
    const current = await rig.releaseSnapshot();
    const head = await rig.releaseHead();
    const held = parseReleaseStateSnapshotV1({
      ...current,
      stateHead: head,
      sequence: current.sequence + 1,
      updatedAt: T0 + 1000,
      githubCooldowns: [{
        installationId: 0,
        retryNotBefore: null,
        observedAt: T0,
        observationId: "a".repeat(64),
        secondaryBackoff: 0,
      }],
    });
    const written = await rig.state.writeRelease(held, head);
    assert.ok(written.ok && written.value.status === "applied");
    rig.clock.advance(1000);
    scriptCompare(rig);

    const result = await rig.run("prepare", RUN_ID);
    assert.equal(result.run, false, JSON.stringify(result));
    assert.equal(result.status, "pending");
    assert.deepEqual(rig.output, ["run=false"]);
    assert.equal(
      rig.http.calls.length,
      0,
      "the gate denied before the request",
    );
    const snapshot = await rig.releaseSnapshot();
    assert.equal(snapshot.hostedRuntimes.length, 0);
    assert.equal(snapshot.githubCooldowns[0].retryNotBefore, null);
  } finally {
    await rig.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Workflow structure: every job that writes code mints the sentinel App token.
// ---------------------------------------------------------------------------

interface BlockV1 {
  start: number;
  end: number;
}

/** One top-level workflow job's lines: its key through the line before the next. */
function jobLines(workflow: string, job: string): string[] {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start < 0) throw new Error(`supervisor job ${job} is missing`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^ {2}[a-z][a-z-]*:$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end);
}

/** The first step line after `from`, or the end of the job. */
function nextStepIndex(job: readonly string[], from: number): number {
  for (let index = from + 1; index < job.length; index++) {
    if (job[index].startsWith("      - ")) return index;
  }
  return job.length;
}

/** One exact `- name: <name>` step inside a job, up to the next step. */
function namedStepRange(job: readonly string[], name: string): BlockV1 {
  const start = job.findIndex((line) => line === `      - name: ${name}`);
  if (start < 0) throw new Error(`step ${name} is missing`);
  return { start, end: nextStepIndex(job, start) };
}

/** The one App-token mint step inside a job, up to the next step. */
function mintStepRange(job: readonly string[]): BlockV1 {
  const uses = job.findIndex((line) =>
    line.startsWith("        uses: actions/create-github-app-token@")
  );
  if (uses < 0) throw new Error("the App-token mint step is missing");
  let start = uses;
  while (start > 0 && !job[start].startsWith("      - ")) start -= 1;
  if (!job[start].startsWith("      - ")) {
    throw new Error("the App-token mint step has no step start");
  }
  return { start, end: nextStepIndex(job, uses) };
}

function blockText(job: readonly string[], range: BlockV1): string {
  return job.slice(range.start, range.end).join("\n");
}

Deno.test("hosted workflow: every code-writing job mints the ubiquity-sentinel App token", async () => {
  const workflow = await Deno.readTextFile(
    `${ROOT}/.github/workflows/supervisor.yml`,
  );
  assert.equal(
    workflow.includes("Iv23liB8E2FcIZd9i7Pg"),
    false,
    "the deleted supervisor App client id is gone",
  );
  assert.equal(
    workflow.split("uses: actions/create-github-app-token@").length - 1,
    4,
    "exactly the four code-writing jobs mint an installation token",
  );

  for (const job of ["maintenance", "prepare", "repair", "finalize"]) {
    const lines = jobLines(workflow, job);
    const mint = blockText(lines, mintStepRange(lines));
    assert.ok(
      mint.includes("client-id: Iv23liHUJNXds9mU3j7Q"),
      `${job} mints from the surviving ubiquity-sentinel client id`,
    );
    assert.ok(
      mint.includes(
        "private-key: ${{ secrets.SENTINEL_SUPERVISOR_APP_PRIVATE_KEY }}",
      ),
      `${job} mints with the environment-scoped App private key`,
    );
    assert.ok(
      mint.includes("repositories: ${{ steps.targets.outputs.repositories }}"),
      `${job} scopes the token to the committed target repositories`,
    );
  }

  for (const job of ["maintenance", "repair"]) {
    const lines = jobLines(workflow, job);
    assert.ok(
      lines.includes("    environment:") &&
        lines.includes("      name: sentinel-supervisor"),
      `${job} runs under the sentinel-supervisor environment`,
    );
    const targets = namedStepRange(
      lines,
      "Resolve the committed target repositories",
    );
    const targetsText = blockText(lines, targets);
    assert.ok(
      targetsText.includes(
        `repositories=$(jq -r 'join(",")' sentinel.targets.json)`,
      ),
      `${job} resolves the committed target repositories with the jq join`,
    );
    if (job === "repair") {
      assert.ok(
        targetsText.includes("working-directory: launcher"),
        "the repair job reads the committed setting from the launcher checkout",
      );
    }
    const mint = mintStepRange(lines);
    assert.equal(
      /permission-[a-z-]+:/.test(blockText(lines, mint)),
      false,
      `${job} inherits the whole installation grant`,
    );
    assert.ok(
      targets.start < mint.start,
      `${job} resolves its targets before the mint`,
    );
    const writeStep = job === "maintenance"
      ? "Run hosted autonomy (retry transient failures, deliver reviewed heads)"
      : "Run selected Sentinel runtime";
    const write = blockText(lines, namedStepRange(lines, writeStep));
    assert.ok(
      write.includes(
        "SENTINEL_SUPERVISOR_TOKEN: ${{ steps.app-token.outputs.token }}",
      ),
      `${job}: ${writeStep} receives the minted App token`,
    );
    assert.ok(
      /--allow-env=\S*SENTINEL_SUPERVISOR_TOKEN/.test(write),
      `${job}: ${writeStep} may read the minted App token`,
    );
    assert.ok(
      write.includes("GITHUB_TOKEN: ${{ github.token }}"),
      `${job} keeps the native token for state bookkeeping`,
    );
  }
});

Deno.test("hosted workflow: the release-role store can never write repair state", async () => {
  const rig = await makeRig();
  try {
    // The concrete store keeps its role denial; the release facade hides the
    // repair writer, so probe it through the concrete type.
    const denied = await (rig.state as GitStateStore).writeRepair(
      emptyRepairSnapshot(),
      null,
    );
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.kind, "invalid");
    const repairRead = await rig.repair.readRepair();
    assert.ok(repairRead.ok && repairRead.value.status === "found");
    if (repairRead.ok && repairRead.value.status === "found") {
      assert.equal(repairRead.value.snapshot.sequence, 1);
    }
  } finally {
    await rig.cleanup();
  }
});
