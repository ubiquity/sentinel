/**
 * Real protected hosted composition: `runHostedSupervisorHost` over the actual
 * core, the authenticated native GitHub client, real temporary source and
 * release/repair Git stores and a scripted HTTP transport. No network, model,
 * GitHub write or deployment is performed.
 */
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import { parseBudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { Clock } from "../../src/contracts/ports.ts";
import type {
  HostedExecutionIntentV1,
  HostedRunProofV1,
} from "../../src/contracts/hosted-supervisor.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
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
// Connected cancellation scenario: a queued repair job saved over a prior
// healthy proof, then force-cancelled before it ever produced a terminal.
const QUEUED_RUN = 910;

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
  await Deno.mkdir(`${dir}/src/host`, { recursive: true });
  await Deno.writeTextFile(`${dir}/src/host/matrix-actions.ts`, "export {};\n");
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
  // Bind ordinary capability to the fixture's immutable committed Git objects.
  const rootTree = await gitRun(sourceDir, [
    "rev-parse",
    `${launcherSha}^{tree}`,
  ], env);
  assert.ok(rootTree.ok, rootTree.stderr);
  http.on(
    "GET",
    `/repos/${REPO}/git/commits/${launcherSha}`,
    () =>
      response(200, {
        sha: launcherSha,
        tree: { sha: rootTree.stdout.trim() },
      }),
  );
  for (const path of ["", "src", "src/host"]) {
    const tree = await gitRun(sourceDir, [
      "rev-parse",
      path === "" ? `${launcherSha}^{tree}` : `${launcherSha}:${path}`,
    ], env);
    assert.ok(tree.ok, tree.stderr);
    const treeSha = tree.stdout.trim();
    const listed = await gitRun(sourceDir, ["ls-tree", treeSha], env);
    assert.ok(listed.ok, listed.stderr);
    const entries = listed.stdout.trim().split("\n").map((line) => {
      const match = /^(\d{6}) (blob|tree) ([a-f0-9]{40})\t(.+)$/.exec(line);
      assert.ok(match, `invalid fixture tree entry: ${line}`);
      const [, mode, type, sha, path] = match;
      return { mode, type, sha, path };
    });
    http.on(
      "GET",
      `/repos/${REPO}/git/trees/${treeSha}`,
      () => response(200, { sha: treeSha, truncated: false, tree: entries }),
    );
  }
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

/** Authenticated native workflow-attempt evidence, overridable per case. */
function scriptAttempt(
  rig: RigV1,
  runId: number,
  overrides: Record<string, unknown> = {},
): void {
  rig.http.on(
    "GET",
    `/repos/${REPO}/actions/runs/${runId}/attempts/1`,
    () =>
      response(200, {
        id: runId,
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
        ...overrides,
      }),
  );
}

/** Authenticated native repair-job evidence, overridable per case. */
function scriptRepairJob(
  rig: RigV1,
  runId: number,
  job: Record<string, unknown>,
): void {
  rig.http.on(
    "GET",
    `/repos/${REPO}/actions/runs/${runId}/attempts/1/jobs`,
    () =>
      response(200, {
        total_count: 1,
        jobs: [{
          id: JOB_ID,
          name: "repair",
          run_id: runId,
          run_attempt: 1,
          head_sha: rig.launcherSha,
          ...job,
        }],
      }),
  );
}

/** Exact persisted repair state and its head, read through the real store. */
async function repairState(rig: RigV1): Promise<{
  snapshot: RepairStateSnapshotV1;
  head: GitSha | null;
}> {
  const read = await rig.repair.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  if (!read.ok || read.value.status !== "found") {
    throw new Error("missing repair state");
  }
  return { snapshot: read.value.snapshot, head: read.value.head };
}

/**
 * Legal reachable cancellation state built by real host calls: the bootstrap
 * cycle records the prior healthy proof, the next due prepare saves the queued
 * ordinary execution, and the separate repair store holds one charged
 * admission reservation. The caller owns cleanup of the returned rig.
 */
async function seedCancellationRig(): Promise<{
  rig: RigV1;
  queuedIntent: HostedExecutionIntentV1;
  priorHealthy: HostedRunProofV1;
  saved: ReleaseStateSnapshotV1;
  repairSeed: RepairStateSnapshotV1;
  cancelAt: number;
}> {
  const rig = await makeRig();
  try {
    const charged = parseBudgetReservationV1({
      version: "v1",
      kind: "budget_reservation",
      repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
      id: "reservation-1",
      taskId: "issue:82",
      attempt: 1,
      head: rig.launcherSha,
      purpose: "implementation",
      createdAt: T0,
      outcome: "reserved",
      settledAt: null,
      proofRef: null,
    });
    const seededRepair = await repairState(rig);
    const repairSeed = parseRepairStateSnapshotV1({
      ...seededRepair.snapshot,
      stateHead: seededRepair.head,
      sequence: seededRepair.snapshot.sequence + 1,
      updatedAt: T0,
      reservations: [charged],
    });
    const repairWritten = await rig.repair.writeRepair(
      repairSeed,
      seededRepair.head,
    );
    assert.ok(
      repairWritten.ok && repairWritten.value.status === "applied",
      JSON.stringify(repairWritten),
    );

    scriptCompare(rig);
    const bootstrapped = await rig.run("prepare", RUN_ID);
    assert.equal(bootstrapped.status, "run", JSON.stringify(bootstrapped));
    if (bootstrapped.execution === null) throw new Error("unreachable");
    rig.clock.advance(OBSERVED - T0);
    scriptFinalize(rig, bootstrapped.execution);
    assert.equal((await rig.run("finalize", RUN_ID)).status, "idle");
    rig.output.length = 0;
    rig.clock.advance(HOUR_MS + 1000);
    const prepared = await rig.run("prepare", QUEUED_RUN);
    assert.equal(prepared.status, "run", JSON.stringify(prepared));
    const queuedIntent = prepared.execution;
    if (queuedIntent === null) throw new Error("unreachable");
    rig.output.length = 0;
    const saved = await rig.releaseSnapshot();
    const priorHealthy = saved.hostedRuntimes[0]?.lastHealthyProof ?? null;
    if (priorHealthy === null) {
      throw new Error("the prior healthy proof is not recorded");
    }
    assert.equal(saved.hostedRuntimes[0]?.execution?.id, queuedIntent.id);
    return {
      rig,
      queuedIntent,
      priorHealthy,
      saved,
      repairSeed,
      cancelAt: rig.clock.now() + 1_000,
    };
  } catch (error) {
    await rig.cleanup();
    throw error;
  }
}

/**
 * Minimal legal negative-case state: the real bootstrap prepare alone saves one
 * execution through the same composition. The caller owns cleanup.
 */
async function seedBootstrapRig(): Promise<{
  rig: RigV1;
  saved: ReleaseStateSnapshotV1;
}> {
  const rig = await makeRig();
  try {
    scriptCompare(rig);
    const prepared = await rig.run("prepare", RUN_ID);
    assert.equal(prepared.status, "run", JSON.stringify(prepared));
    // Observe after the attempt's own authenticated timestamps.
    rig.clock.advance(OBSERVED - T0);
    rig.output.length = 0;
    return { rig, saved: await rig.releaseSnapshot() };
  } catch (error) {
    await rig.cleanup();
    throw error;
  }
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
    assert.deepEqual(rig.output, [
      "run=true",
      `revision=${rig.launcherSha}`,
      "modelStartsEnabled=false",
    ]);

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

Deno.test(
  "hosted workflow: a queued repair reconciliation stays pending",
  async () => {
    const seeded = await seedCancellationRig();
    try {
      const { rig, queuedIntent, saved } = seeded;
      // The repair job is still queued: the saved execution, its prior health
      // and the pointer all stay untouched.
      scriptAttempt(rig, QUEUED_RUN);
      scriptRepairJob(rig, QUEUED_RUN, {
        status: "queued",
        conclusion: null,
        started_at: null,
        completed_at: null,
        steps: [],
      });
      const pending = await rig.run("finalize", QUEUED_RUN);
      assert.equal(pending.status, "pending", JSON.stringify(pending));
      assert.equal(pending.run, false);
      assert.deepEqual(rig.output, [], "finalize writes no outputs");
      assert.equal(
        canonicalStringify(await rig.releaseSnapshot()),
        canonicalStringify(saved),
        "an incomplete repair job leaves the saved execution untouched",
      );
      assert.equal(queuedIntent.purpose, "ordinary");
      assert.equal(
        canonicalStringify((await repairState(rig)).snapshot),
        canonicalStringify(seeded.repairSeed),
        "a pending reconciliation writes nothing, not even repair state",
      );
    } finally {
      await seeded.rig.cleanup();
    }
  },
);

Deno.test(
  "hosted workflow: a force-cancelled repair settles not_started and preserves prior health",
  async () => {
    const seeded = await seedCancellationRig();
    try {
      const { rig, queuedIntent, priorHealthy, saved, repairSeed, cancelAt } =
        seeded;
      // The simulated authenticated force-cancel outcome for the SAME repair
      // job: completed/cancelled, no runtime step and no child terminal
      // artifact (no log read is scripted and none may be needed).
      scriptAttempt(rig, QUEUED_RUN);
      scriptRepairJob(rig, QUEUED_RUN, {
        status: "completed",
        conclusion: "cancelled",
        started_at: null,
        completed_at: iso(cancelAt),
        steps: [],
      });
      rig.clock.advance(5_000);
      const observed = rig.clock.now();
      const callsBeforeCancellation = rig.http.calls.length;
      const settled = await rig.run("finalize", QUEUED_RUN);
      assert.equal(settled.status, "idle", JSON.stringify(settled));
      assert.equal(settled.run, false);
      assert.deepEqual(rig.output, []);

      const after = await rig.releaseSnapshot();
      const runtime = after.hostedRuntimes[0];
      if (runtime === undefined) throw new Error("runtime pointer is missing");
      assert.equal(runtime.execution, null, "the saved execution is freed");
      assert.equal(runtime.lastExecutionProof?.outcome, "not_started");
      assert.equal(runtime.lastExecutionProof?.execution.id, queuedIntent.id);
      assert.equal(runtime.lastExecutionProof?.jobId, JOB_ID);
      assert.equal(runtime.lastExecutionProof?.finishedAt, cancelAt);
      // Only the matching execution moved: the pointer revision and generation
      // are unchanged and the prior health proof is retained verbatim, so a
      // cancellation can never fabricate or demote health.
      assert.equal(runtime.activeRevision, rig.launcherSha);
      assert.equal(runtime.generation, 1);
      assert.equal(
        canonicalStringify(runtime.lastHealthyProof),
        canonicalStringify(priorHealthy),
      );
      assert.equal(
        runtime.nextOrdinaryAt,
        observed,
        "ordinary eligibility is restored at the observation time",
      );
      assert.equal(runtime.updatedAt, observed);
      // The settlement needed no child terminal artifact at all: the cancelled
      // observation reads only the run attempt and its job list.
      assert.ok(
        rig.http.calls.slice(callsBeforeCancellation).every((call) =>
          !call.url.includes("/logs")
        ),
        "a cancelled job with no terminal settles without any log read",
      );
      // Release history and the charged admission reservation survive.
      assert.equal(
        canonicalStringify(after.hostedReleases),
        canonicalStringify(saved.hostedReleases),
      );
      assert.equal(
        canonicalStringify(after.releases),
        canonicalStringify(saved.releases),
      );
      assert.equal(
        canonicalStringify((await repairState(rig)).snapshot),
        canonicalStringify(repairSeed),
      );

      // The freed pointer is due again immediately, and the reservation
      // history is still untouched.
      const next = await rig.run("prepare", QUEUED_RUN + 1);
      assert.equal(next.status, "run", JSON.stringify(next));
      assert.equal(next.run, true);
      assert.equal(next.execution?.purpose, "ordinary");
      assert.equal(next.execution?.revision, rig.launcherSha);
      assert.deepEqual(rig.output, [
        "run=true",
        `revision=${rig.launcherSha}`,
        "modelStartsEnabled=true",
      ]);
      assert.equal(
        canonicalStringify((await repairState(rig)).snapshot),
        canonicalStringify(repairSeed),
      );
      // Every native GitHub API request carried the repository token, never an
      // App token; the signed blob log URL is deliberately unauthenticated.
      for (const call of rig.http.calls) {
        if (!call.url.startsWith("https://api.github.com")) continue;
        assert.equal(
          call.headers.get("authorization"),
          `Bearer ${NATIVE_TOKEN}`,
        );
      }
    } finally {
      await seeded.rig.cleanup();
    }
  },
);

Deno.test(
  "hosted workflow: foreign run and launcher evidence leaves the saved execution pending",
  async () => {
    const seeded = await seedBootstrapRig();
    try {
      const { rig, saved } = seeded;
      // A repair job belonging to another run is refused outright.
      scriptAttempt(rig, RUN_ID);
      scriptRepairJob(rig, RUN_ID, {
        run_id: RUN_ID + 1,
        status: "queued",
        conclusion: null,
        started_at: null,
        completed_at: null,
        steps: [],
      });
      const foreignRun = await rig.run("finalize", RUN_ID);
      assert.equal(foreignRun.status, "pending", JSON.stringify(foreignRun));
      assert.equal(foreignRun.run, false);
      assert.equal(
        canonicalStringify(await rig.releaseSnapshot()),
        canonicalStringify(saved),
        "foreign run evidence changes nothing",
      );

      // An attempt whose launcher (controller) is not the saved launcher is
      // refused the same way.
      scriptAttempt(rig, RUN_ID, { head_sha: OTHER_SHA });
      const foreignLauncher = await rig.run("finalize", RUN_ID);
      assert.equal(
        foreignLauncher.status,
        "pending",
        JSON.stringify(foreignLauncher),
      );
      assert.equal(foreignLauncher.run, false);
      assert.deepEqual(rig.output, [], "finalize writes no outputs");
      assert.equal(
        canonicalStringify(await rig.releaseSnapshot()),
        canonicalStringify(saved),
        "foreign launcher evidence changes nothing",
      );
    } finally {
      await seeded.rig.cleanup();
    }
  },
);

Deno.test(
  "hosted workflow: a mismatched run attempt leaves the saved execution pending",
  async () => {
    const seeded = await seedBootstrapRig();
    try {
      const { rig, saved } = seeded;
      // The saved attempt is 1, so any other attempt number is foreign
      // evidence and never settles the saved execution.
      scriptAttempt(rig, RUN_ID, { run_attempt: 2 });
      const mismatched = await rig.run("finalize", RUN_ID);
      assert.equal(mismatched.status, "pending", JSON.stringify(mismatched));
      assert.equal(mismatched.run, false);
      assert.deepEqual(rig.output, [], "finalize writes no outputs");
      assert.equal(
        canonicalStringify(await rig.releaseSnapshot()),
        canonicalStringify(saved),
        "mismatched attempt evidence changes nothing",
      );
    } finally {
      await seeded.rig.cleanup();
    }
  },
);

Deno.test("hosted workflow: ordinary work starts on the next dispatch after settlement", async () => {
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

    // No artificial hour cooldown: the next scheduled dispatch immediately
    // starts ordinary work once the prior execution actually settled.
    const due = await rig.run("prepare", RUN_ID + 1);
    assert.equal(due.status, "run", JSON.stringify(due));
    assert.equal(due.execution?.purpose, "ordinary");
    assert.equal(due.revision, rig.launcherSha);
    assert.deepEqual(rig.output, [
      "run=true",
      `revision=${rig.launcherSha}`,
      "modelStartsEnabled=true",
    ]);

    // The started execution owns the pointer until it settles: durable state
    // carries exactly that one execution intent.
    const snapshot = await rig.releaseSnapshot();
    assert.equal(
      snapshot.hostedRuntimes[0].execution?.id,
      `${RUN_ID + 1}:1:repair`,
    );
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
    if (/^ {2}[a-z][a-z_-]*:$/.test(lines[index])) {
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
    6,
    "the coordinators and isolated cells mint scoped installation tokens",
  );

  for (
    const job of [
      "maintenance",
      "prepare",
      "matrix_plan",
      "matrix_cell",
      "repair",
      "finalize",
    ]
  ) {
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

  for (const job of ["maintenance", "matrix_plan", "matrix_cell", "repair"]) {
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
    if (job !== "maintenance") {
      assert.ok(
        targetsText.includes("working-directory: launcher"),
        "the repair job reads the committed setting from the launcher checkout",
      );
    }
    const mint = mintStepRange(lines);
    assert.equal(
      /permission-[a-z-]+:/.test(blockText(lines, mint)),
      job === "matrix_cell",
      `${job} keeps the required installation permission scope`,
    );
    assert.ok(
      targets.start < mint.start,
      `${job} resolves its targets before the mint`,
    );
    if (job === "matrix_cell") {
      assert.ok(blockText(lines, mint).includes("permission-contents: read"));
      assert.ok(
        blockText(lines, mint).includes("permission-pull-requests: read"),
      );
    }
    const writeStep = job === "maintenance"
      ? "Run hosted autonomy (retry transient failures, deliver reviewed heads)"
      : job === "matrix_plan"
      ? "Plan isolated issue matrix"
      : job === "matrix_cell"
      ? "Run isolated issue cell"
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

Deno.test("hosted workflow: forwards the configured model route and secret to runtime", async () => {
  const workflow = await Deno.readTextFile(
    `${ROOT}/.github/workflows/supervisor.yml`,
  );
  // Bounded by the neighbouring job keys, so the slice is the repair job
  // alone even though other jobs also bind these names.
  const repairAt = workflow.indexOf("\n  repair:");
  const finalizeAt = workflow.indexOf("\n  finalize:");
  assert.ok(repairAt > 0 && finalizeAt > repairAt, "repair job not found");
  const repair = workflow.slice(repairAt, finalizeAt);
  const stepAt = repair.indexOf("      - name: Run selected Sentinel runtime");
  assert.ok(stepAt > 0, "the selected runtime step is missing");
  // The step ends at its sibling step or the end of the job.
  const nextStepAt = repair.indexOf("\n      - ", stepAt + 1);
  const step = repair.slice(
    stepAt,
    nextStepAt > stepAt ? nextStepAt : repair.length,
  );

  // The runtime env block must bind each documented route input to its exact
  // source context. Names already occur in the --allow-env list, so assert
  // the `NAME: ${{ context.NAME }}` mapping inside env, not the bare name.
  const envAt = step.indexOf("        env:");
  const runAt = step.indexOf("\n        run:", envAt);
  assert.ok(envAt > 0 && runAt > envAt, "the runtime env block is missing");
  const envBlock = step.slice(envAt, runAt);
  const routeBindings: readonly [string, string][] = [
    ["SENTINEL_MODEL_BASE_URL", "vars"],
    ["SENTINEL_MODEL_ID", "vars"],
    ["SENTINEL_MODEL_FALLBACK", "vars"],
    ["SENTINEL_DEEPSEEK_API_KEY", "secrets"],
  ];
  const runtimeEnvLines = envBlock.split("\n").map((line) => line.trim());
  for (const [name, context] of routeBindings) {
    assert.ok(
      runtimeEnvLines.includes(`${name}: \${{ ${context}.${name} }}`),
      `runtime env block must bind ${name} from ${context}`,
    );
  }

  // The Deno grant must permit exactly the names the step now binds.
  const grantPrefix = "          --allow-env=";
  const grantLine = step.split("\n").find((line) =>
    line.startsWith(grantPrefix)
  );
  assert.ok(
    grantLine !== undefined,
    "the runtime --allow-env grant is missing",
  );
  const grantedEnv = new Set(
    grantLine.slice(grantPrefix.length).trim().split(","),
  );
  // Assignment lines only: the block header `env:` and any comment must not
  // be read as a granted variable name.
  const stepEnvNames = new Set(
    envBlock.split("\n")
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("#"))
      .map((line) => line.split(":")[0])
      .filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name)),
  );
  for (const name of stepEnvNames) {
    assert.ok(
      grantedEnv.has(name),
      `the runtime grant must permit ${name}`,
    );
  }
  for (const [name] of routeBindings) {
    assert.ok(grantedEnv.has(name), `the runtime grant must permit ${name}`);
  }

  // The App private key stays in the token-minting step and is never
  // forwarded to the runtime process or its child environment.
  for (const [name] of routeBindings) {
    assert.ok(
      !step.includes(`SENTINEL_SUPERVISOR_APP_PRIVATE_KEY: \${{`),
      `the runtime step must not bind the App private key alongside ${name}`,
    );
  }
  assert.ok(!envBlock.includes("SENTINEL_SUPERVISOR_APP_PRIVATE_KEY"));
  assert.ok(!grantedEnv.has("SENTINEL_SUPERVISOR_APP_PRIVATE_KEY"));
});

Deno.test("hosted workflow: matrix261jobs paginate before exact repair finalize settlement", async () => {
  const rig = await makeRig();
  try {
    scriptCompare(rig);
    const prepared = await rig.run("prepare", RUN_ID);
    assert.ok(prepared.execution !== null);
    if (prepared.execution === null) throw new Error("missing saved intent");
    rig.clock.advance(OBSERVED - T0);
    scriptFinalize(rig, prepared.execution);
    const jobs: Record<string, unknown>[] = Array.from(
      { length: 260 },
      (_, index) => ({
        id: 10000 + index,
        name: "matrix_cell (" + index + ")",
        run_id: RUN_ID,
        run_attempt: 1,
        head_sha: rig.launcherSha,
        status: "completed",
        conclusion: "success",
        started_at: iso(JOB_STARTED),
        completed_at: iso(JOB_FINISHED),
        steps: [],
      }),
    );
    jobs.push({
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
    });
    rig.http.on("GET", JOBS_PATH, (request) => {
      const page = Number(new URL(request.url).searchParams.get("page") ?? "1");
      return response(
        200,
        {
          total_count: jobs.length,
          jobs: jobs.slice((page - 1) * 100, page * 100),
        },
        page < 3
          ? {
            link: "<https://api.github.com" + JOBS_PATH +
              "?per_page=100&page=" + (page + 1) + '>; rel="next"',
          }
          : {},
      );
    });
    const finalized = await rig.run("finalize", RUN_ID);
    assert.equal(finalized.status, "idle");
    const snapshot = await rig.releaseSnapshot();
    assert.equal(
      snapshot.hostedRuntimes[0].execution,
      null,
      "complete matrix wave must clear saved execution",
    );
    assert.equal(
      snapshot.hostedRuntimes[0].lastExecutionProof?.outcome,
      "healthy",
    );
    assert.equal(
      rig.http.calls.filter((call) => new URL(call.url).pathname === JOBS_PATH)
        .length,
      3,
    );
    const next = await rig.run("prepare", RUN_ID + 1);
    assert.equal(
      next.status,
      "run",
      "settled matrix must not strand the next prepare",
    );
    assert.equal(next.execution?.purpose, "ordinary");
  } finally {
    await rig.cleanup();
  }
});
