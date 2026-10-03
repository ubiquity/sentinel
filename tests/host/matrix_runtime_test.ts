/**
 * m19 matrix runtime: real planner/cell/ingester consumers over real temporary
 * Git repositories/state with fake external GitHub/model transports. No
 * network, paid model, GitHub write or deployment effect exists here.
 *
 * Proves: >=2 model sessions overlap; only implementation-ready records get
 * grants (review/delivery/already-intended never do); the trusted actual
 * run/runtime identity gates every cell; candidate objects are ABSENT in a
 * distinct ingester repository before transfer and present with verified
 * ancestry afterwards; opt-out revocation, wrong receipts, missing bundles,
 * conflicting duplicates and missing results cause no state update and never
 * overwrite siblings; ingestion is idempotent; preservation/publication still
 * run through the production consumers.
 */
import assert from "node:assert/strict";
import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
} from "@zip.js/zip.js";

import { RollingStartBudget } from "../../src/budget/mod.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  MATRIX_PLAN_VERSION,
  type MatrixCellPlanV1,
  type MatrixCellResultV1,
  matrixDigestV1,
} from "../../src/contracts/matrix.ts";
import type {
  GitHubIssueV1,
  ImplementationPort,
  ModelRunReceiptV1,
  ModelRunRequestV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { implementationIntentKey } from "../../src/repair/keys.ts";
import type { RepairCycleDepsV1 } from "../../src/repair/loop.ts";
import { createRunBounds, runRepairCycle } from "../../src/repair/loop.ts";
import {
  ingestMatrixResults,
  type MatrixIngestOptionsV1,
  type MatrixPlanOptionsV1,
  planMatrixWave,
  runMatrixCell,
  runMatrixCellEntrypoint,
} from "../../src/host/matrix.ts";
import {
  createGitBundleExporter,
  createGitBundleImporter,
  type MatrixBundleExporterV1,
} from "../../src/host/matrix-git.ts";
import {
  scopeLocalRepairIssues,
  writeLocalModelResult,
} from "../../src/host/local.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeReplay,
  repairConfigs,
} from "../repair/helpers.ts";
import {
  gitRun,
  makeRemoteCtx,
  SHA2,
  T0,
  testGitEnv,
  workRecord,
} from "../state/helpers.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/host\/matrix_runtime_test\.ts$/,
  "",
);

const WAVE = "wave-test-1";
const LAUNCHER = "1".repeat(40) as GitSha;
const RUN = { runId: 41, runAttempt: 1, launcherSha: LAUNCHER };
const ACTUAL = { run: RUN, runtimeSha: LAUNCHER, generation: 1 };
const PROVIDER = "sentinel-host";
const DEADLINE = T0 + 60 * 60_000;

function issueRow(number: number): GitHubIssueV1 {
  return {
    number,
    title: `matrix issue ${number}`,
    body: `body ${number}`,
    state: "open",
    author: null,
    labels: [],
    createdAt: T0 - 10_000,
    updatedAt: T0 - 10_000,
    closedAt: null,
    relations: { openBlockers: [], subIssueCount: 0 },
  };
}

class ListedGithub extends FakeGithub {
  listed: GitHubIssueV1[] = [];
  latest = new Map<number, GitHubIssueV1 | null>();

  override listOpenIssues(): Promise<PortResultV1<GitHubIssueV1[]>> {
    this.calls.push("listOpenIssues");
    return Promise.resolve(portOk(this.listed));
  }

  override readIssue(
    issueNumber: number,
  ): Promise<PortResultV1<GitHubIssueV1 | null>> {
    this.calls.push(`readIssue:${issueNumber}`);
    return Promise.resolve(portOk(this.latest.get(issueNumber) ?? null));
  }
}

/** One model port per cell repository; holds calls until `target` overlap. */
class OverlappingModel implements ImplementationPort {
  readonly modelId = "gpt-reserve";
  readonly requests: ModelRunRequestV1[] = [];
  active = 0;
  maxActive = 0;
  private release: (() => void) | null = null;
  private readonly gate: Promise<void>;

  constructor(
    private readonly target: number,
    private readonly repos: Map<string, string>,
    private readonly env: Record<string, string>,
  ) {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  async runModel(
    request: ModelRunRequestV1,
  ): Promise<PortResultV1<ModelRunReceiptV1>> {
    this.requests.push(request);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    if (this.active >= this.target && this.release !== null) {
      this.release();
      this.release = null;
    }
    await this.gate;
    this.active--;
    const repo = this.repos.get(request.taskId);
    if (repo === undefined) throw new Error("no cell repository for task");
    const index = this.requests.length;
    await Deno.writeTextFile(`${repo}/candidate-${index}.txt`, `candidate\n`);
    assert.ok((await gitRun(repo, ["add", "-A"], this.env)).ok);
    const committed = await gitRun(
      repo,
      ["commit", "-q", "-m", `candidate ${index}`],
      this.env,
    );
    assert.ok(committed.ok, committed.stderr);
    const rev = await gitRun(repo, ["rev-parse", "HEAD"], this.env);
    assert.ok(rev.ok, rev.stderr);
    const head = rev.stdout.trim() as GitSha;
    return portOk({
      invocationId: `matrix-invoke-${index}`,
      outcome: "completed",
      actual: {
        evidenceKind: "request-runtime",
        provider: PROVIDER,
        threadId: `thread-${index}`,
        turnId: `turn-${index}`,
        terminalOrigin: "runtime",
        observedTerminalStatus: "completed",
        observedModel: "gpt-reserve",
        observedReasoning: "max",
        durationMs: 100,
        outputChars: 500,
      },
      candidate: {
        head,
        checkpointSha: null,
        changedPaths: [`candidate-${index}.txt`],
      },
      error: null,
    });
  }
}

interface CellContextV1 {
  cell: MatrixCellPlanV1;
  repositoryDir: string;
  deps: {
    clock: FakeClock;
    bounds: { runDeadline: number; modelCutoff: number };
    sessionBound: { maxDurationMs: number; maxOutputChars: number };
    state: RigV1["store"];
    github: ListedGithub;
    model: OverlappingModel;
    bundle: MatrixBundleExporterV1;
  };
  bundlesDir: string;
}

interface RigV1 {
  clock: FakeClock;
  store: ReturnType<typeof createRepairStateStore>;
  github: ListedGithub;
  model: OverlappingModel;
  deps: RepairCycleDepsV1;
  base: GitSha;
  mirrorRepo: string;
  mirrorBundles: string;
  env: Record<string, string>;
  tmp: string;
  planOptions(): MatrixPlanOptionsV1;
  ingestOptions(): MatrixIngestOptionsV1;
  claimCell(cell: MatrixCellPlanV1): Promise<CellContextV1>;
  transfer(
    results: readonly MatrixCellResultV1[],
    ctxs: readonly CellContextV1[],
  ): Promise<void>;
  objectPresent(sha: GitSha): Promise<boolean>;
  cleanup(): Promise<void>;
}

function seedSnapshot(work: WorkRecordV1[]): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work,
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
  });
}

function freshIssue(number: number, base: GitSha): WorkRecordV1 {
  return workRecord(`issue-${number}`, {
    source: { kind: "issue", id: String(number), revision: base },
    related: { incidentId: null, issueNumber: number },
    target: {
      base,
      branch: `sentinel/repair/issue-${number}`,
      checkpoint: null,
      head: null,
      pr: null,
    },
    nextStep: "work",
    firstSeenAt: T0 - 60_000,
  });
}

function parkedNonReady(
  number: number,
  step: "review" | "delivery",
  base: GitSha,
): WorkRecordV1 {
  return workRecord(`issue-${number}`, {
    source: { kind: "issue", id: String(number), revision: base },
    related: { incidentId: null, issueNumber: number },
    target: {
      base,
      branch: `sentinel/repair/issue-${number}`,
      checkpoint: null,
      head: SHA2,
      pr: 7,
    },
    nextStep: step,
    wait: null,
    firstSeenAt: T0 - 70_000,
  });
}

function activeIntent(
  number: number,
  reservationId: string,
  base: GitSha,
): WorkRecordV1 {
  return workRecord(`issue-${number}`, {
    source: { kind: "issue", id: String(number), revision: base },
    related: { incidentId: null, issueNumber: number },
    target: {
      base,
      branch: `sentinel/repair/issue-${number}`,
      checkpoint: null,
      head: null,
      pr: null,
    },
    nextStep: "work",
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    intent: {
      kind: "implementation",
      key: implementationIntentKey(reservationId),
      startedAt: T0,
      branch: `sentinel/repair/issue-${number}`,
      expectedHead: null,
      observedBase: base,
      pr: null,
      requestId: reservationId,
      resultId: null,
    },
  });
}

async function makeRig(
  issueNumbers: number[],
  overlap: number,
): Promise<RigV1> {
  const tmp = await Deno.makeTempDir({
    prefix: "sentinel-matrix-runtime-",
    dir: ROOT,
  });
  const env = testGitEnv(`${tmp}/git-home`);
  await Deno.mkdir(`${tmp}/git-home`, { recursive: true });

  // A distinct trusted ingester mirror with the planned base commit; every
  // cell gets its own clone (its own isolated checkout).
  const mirrorRepo = `${tmp}/mirror`;
  await Deno.mkdir(mirrorRepo, { recursive: true });
  assert.ok((await gitRun(mirrorRepo, ["init", "-q"], env)).ok);
  await Deno.writeTextFile(`${mirrorRepo}/base.txt`, "base\n");
  assert.ok((await gitRun(mirrorRepo, ["add", "-A"], env)).ok);
  assert.ok((await gitRun(mirrorRepo, ["commit", "-q", "-m", "base"], env)).ok);
  const baseRev = await gitRun(mirrorRepo, ["rev-parse", "HEAD"], env);
  assert.ok(baseRev.ok, baseRev.stderr);
  const base = baseRev.stdout.trim() as GitSha;
  const mirrorBundles = `${tmp}/mirror-bundles`;
  await Deno.mkdir(mirrorBundles, { recursive: true });

  const github = new ListedGithub({
    baseSha: base,
    // The trusted preservation capability the real host composes: a completed
    // candidate becomes durable before publication. Without it the records
    // park on the preservation wait and never publish.
    candidateLifecycle: {
      preserveCandidate: () => Promise.resolve(portOk(undefined)),
    },
  });
  scopeLocalRepairIssues(github);
  for (const number of issueNumbers) {
    const row = issueRow(number);
    github.listed.push(row);
    github.latest.set(number, row);
  }
  const remote = await makeRemoteCtx(tmp, env);
  const clock = new FakeClock(T0);
  const store = createRepairStateStore({
    scratchDir: `${tmp}/scratch`,
    remoteUrl: remote.remoteUrl,
  });
  const configs = repairConfigs({
    adapter: { kind: "github" },
    liveStartLimits: { perHour: null, perSevenDays: null },
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  });
  const budget = new RollingStartBudget({ clock, state: store, configs });
  const githubCooldown = new DurableGitHubCooldownGate({ state: store, clock });
  const repos = new Map<string, string>();
  let claimCounter = 0;
  const model = new OverlappingModel(overlap, repos, env);
  const deps: RepairCycleDepsV1 = {
    clock,
    state: store,
    configs,
    controllerSha: LAUNCHER,
    github,
    githubCooldown,
    incidents: new FakeIncidents({ summaries: [], evidence: null }),
    replay: new FakeReplay(),
    model,
    budget,
  };
  const importer = createGitBundleImporter({
    repositoryDir: mirrorRepo,
    bundlesDir: mirrorBundles,
  });
  return {
    clock,
    store,
    github,
    model,
    deps,
    base,
    mirrorRepo,
    mirrorBundles,
    env,
    tmp,
    planOptions: () => ({
      waveId: WAVE,
      run: RUN,
      runtimeSha: LAUNCHER,
      generation: 1,
      plannedAt: T0,
      deadline: DEADLINE,
    }),
    ingestOptions: () => ({
      deadline: DEADLINE,
      expectedProvider: PROVIDER,
      bundleImporter: importer,
    }),
    claimCell: async (cell) => {
      // Every claim is a fresh isolated runner: a unique checkout and artifact
      // directory, never a populated path reused or overwritten.
      const claim = ++claimCounter;
      const repo = `${tmp}/cell-${cell.taskId}-${claim}`;
      assert.ok((await gitRun(tmp, ["clone", "-q", mirrorRepo, repo], env)).ok);
      assert.ok((await gitRun(repo, ["checkout", "-q", base], env)).ok);
      repos.set(cell.taskId, repo);
      const bundlesDir = `${tmp}/bundles-${cell.taskId}-${claim}`;
      await Deno.mkdir(bundlesDir, { recursive: true });
      return {
        cell,
        repositoryDir: repo,
        deps: {
          clock,
          bounds: createRunBounds(deps, {
            deadline: DEADLINE,
            runStartedAt: T0,
          }),
          sessionBound: configs[0]!.sessionBound!,
          state: store,
          github,
          model,
          bundle: createGitBundleExporter({
            repositoryDir: repo,
            outputDir: bundlesDir,
          }),
        },
        bundlesDir,
      };
    },
    transfer: async (results, ctxs) => {
      for (const result of results) {
        const ctx = ctxs.find((item) => item.cell.cellId === result.cellId);
        if (ctx === undefined || result.bundle === null) continue;
        await Deno.copyFile(
          `${ctx.bundlesDir}/${result.bundle.file}`,
          `${mirrorBundles}/${result.bundle.file}`,
        );
      }
    },
    objectPresent: async (sha) =>
      (await gitRun(mirrorRepo, ["cat-file", "-e", `${sha}^{commit}`], env)).ok,
    cleanup: async () => {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    },
  };
}

async function snapshot(rig: RigV1): Promise<RepairStateSnapshotV1> {
  const read = await rig.store.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  if (!read.ok || read.value.status !== "found") {
    throw new Error("no repair state");
  }
  return read.value.snapshot;
}

function completedReceipt(result: MatrixCellResultV1): ModelRunReceiptV1 {
  if (result.receipt === null) throw new Error("expected a completed receipt");
  return result.receipt;
}

Deno.test(
  "matrix runtime: two admitted tasks overlap, transfer real objects, ingest and publish",
  async () => {
    const rig = await makeRig([201, 202], 2);
    try {
      const written = await rig.store.writeRepair(
        seedSnapshot([freshIssue(201, rig.base), freshIssue(202, rig.base)]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      const report = await planMatrixWave(rig.deps, rig.planOptions());
      assert.equal(report.plan.version, MATRIX_PLAN_VERSION);
      assert.equal(report.plan.cells.length, 2);
      assert.equal(report.prepared, 2);
      assert.equal(report.notReady, 0);
      const reservations = (await snapshot(rig)).reservations;
      assert.equal(reservations.length, 2, "one durable admission per cell");
      assert.equal(new Set(reservations.map((r) => r.id)).size, 2);
      for (const cell of report.plan.cells) {
        assert.equal(cell.expectedBase, rig.base);
        assert.match(cell.cellId, /^[0-9a-f]{64}$/, "opaque safe cell id");
        assert.equal(cell.requestDigest, await matrixDigestV1(cell.request));
      }

      const ctxs = await Promise.all(
        report.plan.cells.map((cell) => rig.claimCell(cell)),
      );
      const results = await Promise.all(
        ctxs.map((ctx) =>
          runMatrixCell(
            ctx.deps,
            { waveId: WAVE, run: RUN, cell: ctx.cell },
            ACTUAL,
            T0,
          )
        ),
      );
      assert.equal(rig.model.maxActive, 2, "two model sessions overlapped");
      assert.ok(results.every((result) => result.status === "completed"));
      for (const result of results) {
        assert.ok(result.bundle, "completed results carry a real bundle");
      }
      const heads = results.map((result) =>
        completedReceipt(result).candidate!.head!
      );
      for (const head of heads) {
        assert.equal(await rig.objectPresent(head), false, "absent before");
      }
      await rig.transfer(results, ctxs);
      const ingest = await ingestMatrixResults(
        rig.deps,
        report.plan,
        results,
        rig.ingestOptions(),
      );
      assert.equal(ingest.ingested, 2);
      for (const head of heads) {
        assert.equal(await rig.objectPresent(head), true, "present after");
        assert.ok(
          (await gitRun(
            rig.mirrorRepo,
            ["merge-base", "--is-ancestor", rig.base, head],
            rig.env,
          )).ok,
          "imported candidate descends from the base",
        );
      }

      const outcome = await runRepairCycle(rig.deps, {
        deadline: DEADLINE,
        stepLimit: 32,
      });
      assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
      const records = (await snapshot(rig)).work.map((record) => ({
        id: record.id,
        nextStep: record.nextStep,
        wait: record.wait?.reason ?? null,
        blocker: record.blocker?.message ?? null,
      }));
      assert.equal(
        rig.github.pushes.length,
        2,
        `one candidate push per task (${JSON.stringify(outcome)}): ${
          JSON.stringify(records)
        }`,
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "createPr").length,
        2,
      );
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "matrix runtime: identity, receipt, bundle and duplicate gates isolate siblings",
  async () => {
    const rig = await makeRig([301, 302, 303], 1);
    try {
      const written = await rig.store.writeRepair(
        seedSnapshot([
          freshIssue(301, rig.base),
          freshIssue(302, rig.base),
          parkedNonReady(303, "review", rig.base),
        ]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");
      const report = await planMatrixWave(rig.deps, rig.planOptions());
      assert.equal(
        report.plan.cells.length,
        2,
        "only ready records are granted",
      );
      assert.equal(report.notReady, 1);
      const [first, second] = report.plan.cells;

      const badRun = await runMatrixCell(
        (await rig.claimCell(first)).deps,
        { waveId: WAVE, run: RUN, cell: first },
        { run: { ...RUN, runAttempt: 2 }, runtimeSha: LAUNCHER, generation: 1 },
        T0,
      );
      assert.equal(badRun.status, "failed");
      const badGeneration = await runMatrixCell(
        (await rig.claimCell(first)).deps,
        { waveId: WAVE, run: RUN, cell: first },
        { run: RUN, runtimeSha: LAUNCHER, generation: 2 },
        T0,
      );
      assert.equal(badGeneration.status, "failed");
      assert.equal(
        rig.model.requests.length,
        0,
        "no model for mismatched runs",
      );

      const substitutedRequest = {
        ...first.request,
        issue: second.request.issue,
      };
      const wrongSourceCell = {
        ...first,
        request: substitutedRequest,
        requestDigest: await matrixDigestV1(substitutedRequest),
      };
      assert.equal(
        (await runMatrixCell(
          (await rig.claimCell(first)).deps,
          { waveId: WAVE, run: RUN, cell: wrongSourceCell },
          ACTUAL,
          T0,
        )).status,
        "not_started",
        "another real issue cannot substitute for the authoritative task source",
      );
      const foreignRepository = {
        ...first.repository,
        installationId: first.repository.installationId + 1,
      };
      const foreignRequest = {
        ...first.request,
        repository: foreignRepository,
      };
      const wrongRepositoryCell = {
        ...first,
        repository: foreignRepository,
        request: foreignRequest,
        requestDigest: await matrixDigestV1(foreignRequest),
      };
      assert.equal(
        (await runMatrixCell(
          (await rig.claimCell(first)).deps,
          { waveId: WAVE, run: RUN, cell: wrongRepositoryCell },
          ACTUAL,
          T0,
        )).status,
        "not_started",
        "self-consistent grant repository must still match authoritative task",
      );
      const read = await rig.store.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      const actualRead = read.value;
      const mismatchedAdmission = parseRepairStateSnapshotV1({
        ...actualRead.snapshot,
        reservations: actualRead.snapshot.reservations.map((reservation) =>
          reservation.id === first.reservationId
            ? { ...reservation, attempt: reservation.attempt + 1 }
            : reservation
        ),
      });
      const admissionCtx = await rig.claimCell(first);
      assert.equal(
        (await runMatrixCell(
          {
            ...admissionCtx.deps,
            state: {
              readRepair: () =>
                Promise.resolve(
                  portOk({ ...actualRead, snapshot: mismatchedAdmission }),
                ),
              readRelease: () => rig.store.readRelease(),
            },
          },
          { waveId: WAVE, run: RUN, cell: first },
          ACTUAL,
          T0,
        )).status,
        "not_started",
        "reservation attempt must match authoritative task attempt",
      );
      assert.equal(rig.model.requests.length, 0);

      const ctx = await rig.claimCell(first);
      const completed = await runMatrixCell(
        ctx.deps,
        { waveId: WAVE, run: RUN, cell: first },
        ACTUAL,
        T0,
      );
      assert.equal(completed.status, "completed");
      const head = completedReceipt(completed).candidate!.head!;

      const receipt = completedReceipt(completed);
      const wrongModel: MatrixCellResultV1 = {
        ...completed,
        receipt: {
          ...receipt,
          actual: { ...receipt.actual, observedModel: "gpt-other" },
        },
      };
      const beforeReject = await snapshot(rig);
      const rejected = await ingestMatrixResults(
        rig.deps,
        report.plan,
        [wrongModel],
        rig.ingestOptions(),
      );
      assert.equal(
        rejected.entries.find((entry) => entry.cellId === first.cellId)
          ?.disposition,
        "receipt_rejected",
      );
      assert.equal(rejected.ingested, 0);
      assert.equal((await snapshot(rig)).sequence, beforeReject.sequence);
      assert.equal(await rig.objectPresent(head), false, "no import on reject");

      // Missing bundle bytes are never accepted as a candidate.
      const noBundle: MatrixCellResultV1 = { ...completed, bundle: null };
      const unavailable = await ingestMatrixResults(
        rig.deps,
        report.plan,
        [noBundle],
        rig.ingestOptions(),
      );
      assert.equal(
        unavailable.entries.find((entry) => entry.cellId === first.cellId)
          ?.disposition,
        "candidate_unavailable",
      );
      assert.equal(await rig.objectPresent(head), false);

      // Conflicting duplicate artifacts for one cell are both refused.
      await rig.transfer([completed], [ctx]);
      const conflict = await ingestMatrixResults(
        rig.deps,
        report.plan,
        [
          { ...completed, completedAt: T0 },
          { ...completed, completedAt: T0 + 1 },
        ],
        rig.ingestOptions(),
      );
      assert.equal(
        conflict.entries.find((entry) => entry.cellId === first.cellId)
          ?.disposition,
        "conflict",
      );
      assert.equal(conflict.ingested, 0);

      const foreign: MatrixCellResultV1 = {
        ...completed,
        cellId: "f".repeat(64),
      };
      const mixed = await ingestMatrixResults(
        rig.deps,
        report.plan,
        [foreign, completed],
        rig.ingestOptions(),
      );
      assert.equal(
        mixed.entries.find((entry) => entry.cellId === "f".repeat(64))
          ?.disposition,
        "foreign",
      );
      assert.equal(mixed.ingested, 1);
      assert.equal(await rig.objectPresent(head), true, "imported on ingest");
      const afterFirst = await snapshot(rig);
      const secondRecord = afterFirst.work.find((record) =>
        record.id === second.taskId
      );
      assert.equal(secondRecord?.intent?.requestId, second.reservationId);
      assert.equal(
        afterFirst.reservations.find((entry) =>
          entry.id === second.reservationId
        )?.outcome,
        "reserved",
      );

      const replay = await ingestMatrixResults(
        rig.deps,
        report.plan,
        [completed],
        rig.ingestOptions(),
      );
      assert.equal(replay.ingested, 0);
      assert.equal(
        replay.entries.find((entry) => entry.cellId === first.cellId)
          ?.disposition,
        "duplicate",
      );
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "matrix runtime: review, delivery and already-intended records get no grant or charge",
  async () => {
    const rig = await makeRig([501, 502, 503, 504], 1);
    try {
      const existing = "res-existing";
      const written = await rig.store.writeRepair(
        seedSnapshot([
          freshIssue(501, rig.base),
          parkedNonReady(502, "review", rig.base),
          parkedNonReady(503, "delivery", rig.base),
          activeIntent(504, existing, rig.base),
        ]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");
      const report = await planMatrixWave(rig.deps, rig.planOptions());
      assert.equal(
        report.plan.cells.length,
        1,
        "only the ready issue is planned",
      );
      assert.equal(report.notReady, 3);
      assert.equal(report.deferred, 0);
      assert.equal(report.plan.cells[0].taskId, "issue-501");

      const after = await snapshot(rig);
      assert.equal(
        after.reservations.length,
        1,
        "one charge for the ready issue",
      );
      const intended = after.work.find((record) =>
        record.intent?.requestId === existing
      );
      assert.ok(intended, "the in-flight implementation record survives");
      assert.equal(
        after.reservations.some((entry) => entry.taskId === "issue-504"),
        false,
        "no second charge for the in-flight record",
      );
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "matrix runtime: changed, closed or opted-out source refuses before any model call",
  async () => {
    const rig = await makeRig([401], 1);
    try {
      const written = await rig.store.writeRepair(
        seedSnapshot([freshIssue(401, rig.base)]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");
      const report = await planMatrixWave(rig.deps, rig.planOptions());
      assert.equal(report.plan.cells.length, 1);
      const ctx = await rig.claimCell(report.plan.cells[0]);
      const grant = { waveId: WAVE, run: RUN, cell: report.plan.cells[0] };
      const before = await snapshot(rig);

      rig.github.latest.set(401, {
        ...issueRow(401),
        title: "renamed after planning",
      });
      assert.equal(
        (await runMatrixCell(ctx.deps, grant, ACTUAL, T0)).status,
        "not_started",
      );
      rig.github.latest.set(401, {
        ...issueRow(401),
        state: "closed",
        closedAt: T0,
      });
      assert.equal(
        (await runMatrixCell(ctx.deps, grant, ACTUAL, T0)).status,
        "not_started",
      );
      rig.github.latest.set(401, {
        ...issueRow(401),
        labels: ["sentinel:skip"],
      });
      assert.equal(
        (await runMatrixCell(ctx.deps, grant, ACTUAL, T0)).status,
        "not_started",
      );
      assert.equal(
        rig.model.requests.length,
        0,
        "no inference for a stale plan",
      );

      const after = await snapshot(rig);
      assert.equal(after.sequence, before.sequence, "no state write occurred");
      assert.equal(after.reservations[0].outcome, "reserved");
      assert.equal(
        after.work[0].intent?.requestId,
        before.work[0].intent?.requestId,
      );
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test("matrix runtime: delta bundle requires its base and ignores model-controlled Git hooks", async () => {
  const rig = await makeRig([501], 1);
  try {
    const written = await rig.store.writeRepair(
      seedSnapshot([freshIssue(501, rig.base)]),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");
    const planned = await planMatrixWave(rig.deps, rig.planOptions());
    const cell = planned.plan.cells[0]!;
    const ctx = await rig.claimCell(cell);
    const hooks = ctx.bundlesDir + "/hooks";
    const marker = ctx.bundlesDir + "/hook-ran";
    await Deno.mkdir(hooks);
    await Deno.writeTextFile(
      hooks + "/reference-transaction",
      '#!/bin/sh\nprintf hook > "' + marker + '"\nexit 1\n',
      { mode: 0o700 },
    );
    const exporter = ctx.deps.bundle;
    ctx.deps.bundle = {
      create: async (request) => {
        assert.ok(
          (await gitRun(
            ctx.repositoryDir,
            ["config", "core.hooksPath", hooks],
            rig.env,
          )).ok,
        );
        return exporter.create(request);
      },
    };
    const result = await runMatrixCell(
      ctx.deps,
      { waveId: WAVE, run: RUN, cell },
      ACTUAL,
      T0,
    );
    assert.equal(result.status, "completed");
    assert.ok(result.bundle);
    const bytes = await Deno.readFile(
      ctx.bundlesDir + "/" + result.bundle.file,
    );
    const header = new TextDecoder().decode(bytes.slice(0, 4096)).split(
      "\n\n",
    )[0]!;
    assert.ok(
      header.split("\n").some((line) => line.startsWith("-" + rig.base + " ")),
      "planned base is an external prerequisite, not bundled history",
    );
    await assert.rejects(Deno.stat(marker), Deno.errors.NotFound);
    await rig.transfer([result], [ctx]);
    assert.ok(
      (await gitRun(
        rig.mirrorRepo,
        ["config", "core.hooksPath", hooks],
        rig.env,
      )).ok,
    );
    const report = await ingestMatrixResults(
      rig.deps,
      planned.plan,
      [result],
      rig.ingestOptions(),
    );
    assert.equal(report.ingested, 1);
    assert.equal(await rig.objectPresent(result.bundle.head), true);
    await assert.rejects(Deno.stat(marker), Deno.errors.NotFound);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("matrix runtime: private model error stays out of exported JSON logs and uploaded artifact bytes", async () => {
  const rig = await makeRig([601], 1);
  const sentinel = "PRIVATE_MODEL_ERROR_SENTINEL_601";
  const logs: string[] = [];
  const originalLog = console.log;
  try {
    const seeded = await rig.store.writeRepair(
      seedSnapshot([freshIssue(601, rig.base)]),
      null,
    );
    assert.ok(seeded.ok && seeded.value.status === "applied");
    const planned = await planMatrixWave(rig.deps, rig.planOptions());
    const cell = planned.plan.cells[0]!;
    const ctx = await rig.claimCell(cell);
    const privateRoot = rig.tmp + "/private-model-evidence";
    await Deno.mkdir(privateRoot, { mode: 0o700 });
    const privateWire = privateRoot + "/session-wire.json";
    const privateReceipt: ModelRunReceiptV1 = {
      invocationId: "failed-private-invocation",
      outcome: "failed",
      actual: {
        evidenceKind: "request-runtime",
        provider: PROVIDER,
        threadId: "private-thread",
        turnId: "private-turn",
        terminalOrigin: "runtime",
        observedTerminalStatus: "failed",
        observedModel: "gpt-reserve",
        observedReasoning: "max",
        durationMs: 10,
        outputChars: 10,
      },
      candidate: null,
      error: sentinel,
    };
    const model: ImplementationPort = {
      modelId: "gpt-reserve",
      runModel: async (request) => {
        // The fake external model keeps its original wire evidence privately,
        // then runs the production private diagnostic writer before cell export.
        await Deno.writeTextFile(privateWire, JSON.stringify(privateReceipt), {
          mode: 0o600,
        });
        await writeLocalModelResult(
          privateRoot,
          request,
          portOk(privateReceipt),
          T0,
        );
        return portOk(privateReceipt);
      },
    };
    const publicRoot = rig.tmp + "/.sentinel-matrix";
    await Deno.mkdir(publicRoot);
    const cellPath = publicRoot + "/cell.json",
      resultPath = publicRoot + "/result.json";
    await Deno.writeTextFile(
      cellPath,
      JSON.stringify({ waveId: WAVE, run: RUN, cell }),
    );
    console.log = (...values) => {
      logs.push(values.map(String).join(" "));
    };
    const result = await runMatrixCellEntrypoint({
      deps: { ...ctx.deps, model },
      actual: ACTUAL,
      cellPath,
      resultPath,
      completedAt: T0,
    });
    console.log = originalLog;
    const jsonBytes = await Deno.readFile(resultPath);
    // This is the same public result.json selected by upload-artifact. Package
    // those actual exported bytes, then send the archive across a fake HTTP
    // upload boundary; storage mode makes byte-level absence meaningful.
    const writer = new ZipWriter(new Uint8ArrayWriter(), {
      useWebWorkers: false,
    });
    await writer.add("result.json", new Uint8ArrayReader(jsonBytes), {
      level: 0,
      unixMode: 0o100600,
    });
    const archive = await writer.close();
    let uploaded: Uint8Array | null = null;
    const fakeUpload = async (request: Request) => {
      uploaded = new Uint8Array(await request.arrayBuffer());
      return new Response(null, { status: 201 });
    };
    const response = await fakeUpload(
      new Request("https://artifact-upload.invalid/cell", {
        method: "POST",
        body: archive.slice(),
      }),
    );
    assert.equal(response.status, 201);
    assert.deepEqual(uploaded, archive);
    const reader = new ZipReader(new Uint8ArrayReader(archive), {
      useWebWorkers: false,
    });
    const entries = await reader.getEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.filename, "result.json");
    const entry = entries[0]!;
    assert.equal(entry.directory, false);
    if (entry.directory) throw Error("expected a result file");
    const packedJson = await entry.getData!(new Uint8ArrayWriter());
    await reader.close();
    assert.deepEqual(packedJson, jsonBytes);
    assert.ok((await Deno.readTextFile(privateWire)).includes(sentinel));
    assert.equal((await Deno.stat(privateWire)).mode! & 0o077, 0);
    assert.equal(
      privateReceipt.error,
      sentinel,
      "public projection never rewrites private evidence",
    );
    assert.equal(
      new TextDecoder().decode(jsonBytes).includes(sentinel),
      false,
      "exported JSON leaks no private error",
    );
    assert.equal(
      new TextDecoder().decode(archive).includes(sentinel),
      false,
      "uploaded artifact bytes leak no private error",
    );
    assert.ok(
      logs.length > 0,
      "actual private diagnostic emitted its safe log projection",
    );
    assert.equal(logs.join("\n").includes(sentinel), false);
    assert.equal(result.status, "completed", "wrapper status is preserved");
    assert.equal(result.receipt?.outcome, "failed");
    assert.equal(result.receipt?.error, "runtime_error");
    assert.equal(result.reservationId, cell.reservationId);
    assert.equal(
      await matrixDigestV1(JSON.parse(new TextDecoder().decode(jsonBytes))),
      await matrixDigestV1(result),
    );
    assert.equal(
      canonicalStringify(result).includes(sentinel),
      false,
      "production canonical payload is sanitized too",
    );
    for (
      const [outcome, error, expected] of [
        ["interrupted", sentinel, "runtime_error"],
        ["failed", null, null],
        ["failed", "failed_command_loop", "failed_command_loop"],
      ] as const
    ) {
      const original: ModelRunReceiptV1 = {
        ...privateReceipt,
        outcome,
        error,
        actual: { ...privateReceipt.actual, observedTerminalStatus: outcome },
      };
      const projected = await runMatrixCellEntrypoint({
        deps: {
          ...ctx.deps,
          model: {
            modelId: "gpt-reserve",
            runModel: () => Promise.resolve(portOk(original)),
          },
        },
        actual: ACTUAL,
        cellPath,
        resultPath,
        completedAt: T0,
      });
      assert.deepEqual(projected.receipt, { ...original, error: expected });
      assert.equal(original.error, error, "private receipt remains unchanged");
      assert.equal(
        (await Deno.readTextFile(resultPath)).includes(sentinel),
        false,
      );
    }
    const before = await snapshot(rig);
    const ingested = await ingestMatrixResults(
      rig.deps,
      planned.plan,
      [result],
      rig.ingestOptions(),
    );
    assert.equal(ingested.ingested, 1);
    const after = await snapshot(rig);
    assert.equal(after.reservations.length, before.reservations.length);
    assert.equal(after.reservations[0]!.id, cell.reservationId);
    assert.equal(
      after.reservations[0]!.outcome,
      "ambiguous",
      "failed execution stays charged",
    );
    assert.equal(after.work[0]!.nextStep, "blocked");
  } finally {
    console.log = originalLog;
    await rig.cleanup();
  }
});
