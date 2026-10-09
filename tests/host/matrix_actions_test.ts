/** Real hosted matrix composition over separate temporary Git repositories and fake external ports. */
import assert from "node:assert/strict";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { createActionsMatrixArtifactHttpTransport } from "../../src/host/matrix-artifacts.ts";
import { MatrixHistoricalRuntimeMismatch } from "../../src/host/matrix-artifact-port.ts";
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  HOSTED_RUNTIME_ID,
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
  parseHostedExecutionIntentV1,
} from "../../src/contracts/hosted-supervisor.ts";
import type {
  GitHubIssueV1,
  ImplementationPort,
  ModelRunReceiptV1,
  ModelRunRequestV1,
} from "../../src/contracts/ports.ts";
import {
  portError,
  portOk,
  type PortResultV1,
  type RepairStateWriter,
  type StateReadResultV1,
  type StateReadView,
  type StateWriteResultV1,
} from "../../src/contracts/ports.ts";
import type { MatrixCellResultV1 } from "../../src/contracts/matrix.ts";
import {
  matrixCellIdV1,
  matrixDigestV1,
  MAX_MATRIX_ARTIFACT_BYTES,
} from "../../src/contracts/matrix.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
  type RepairGitStateStore,
} from "../../src/state/mod.ts";
import {
  historicalNotStartedProven,
  type MatrixAggregateOptionsV1,
  runActionsMatrixAggregateCycles,
  runActionsMatrixHost,
} from "../../src/host/matrix-actions.ts";
import { runActionsRepairHost } from "../../src/host/actions.ts";
import type { ActionsTargetCyclesInputV1 } from "../../src/host/actions.ts";
import {
  closedCWaveHandledReservations,
  closedCWaveNeedsRecovery,
  ingestClosedCWave,
} from "../../src/host/modern-matrix-recovery.ts";
import { createGitBundleImporter } from "../../src/host/matrix-git.ts";
import {
  applyHostedRetirements,
  applyHostedRetries,
  hostedIssueKey,
  planHostedRetirements,
  planHostedRetries,
  runHostedAutonomy,
} from "../../ops/hosted-autonomy.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { markBlocked } from "../../src/repair/transitions.ts";
import {
  MATRIX_PRESERVATION_UNCERTAINTY_DETAIL,
  MATRIX_UNCERTAINTY_BINDING,
  MATRIX_UNCERTAINTY_DETAIL,
  runMatrixUncertaintyMaintenance,
} from "../../src/host/matrix-uncertainty-maintenance.ts";
import {
  createRunBounds,
  loadRepairContext,
  OPERATION_MARGIN_MS,
  prepareImplementationStart,
  REPAIR_MODEL_CUTOFF_MS,
  runRepairCycle,
} from "../../src/repair/loop.ts";
import { FakeClock, FakeGithub, MemoryState } from "../repair/helpers.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import { issueWire } from "../github/helpers.ts";
import {
  gitRun,
  makeRemoteCtx,
  releaseRequest,
  reservation,
  T0,
  testGitEnv,
  workRecord,
} from "../state/helpers.ts";
const ROOT = decodeURIComponent(new URL(import.meta.url).pathname).replace(
  /\/tests\/host\/matrix_actions_test\.ts$/,
  "",
);
const PROVIDER = "uos";
function issue(number: number): GitHubIssueV1 {
  return {
    number,
    title: "issue " + number,
    body: "repair target " + number,
    state: "open",
    author: null,
    labels: [],
    createdAt: T0,
    updatedAt: T0,
    closedAt: null,
    relations: { openBlockers: [], subIssueCount: 0 },
  };
}
class TargetGithub extends FakeGithub {
  row = issue(1);
  override listOpenIssues() {
    this.calls.push("listOpenIssues");
    return Promise.resolve(portOk([this.row]));
  }
  override readIssue(number: number) {
    this.calls.push("readIssue:" + number);
    return Promise.resolve(
      portOk(number === this.row.number ? this.row : null),
    );
  }
}
async function checked(
  dir: string,
  args: string[],
  env: Record<string, string>,
) {
  const result = await gitRun(dir, args, env);
  assert.ok(result.ok, result.stderr);
  return result.stdout.trim();
}
async function checkout(
  path: string,
  env: Record<string, string>,
  files: Record<string, string>,
) {
  await Deno.mkdir(path, { recursive: true });
  await checked(path, ["init", "-q", "-b", "development"], env);
  for (const [name, bytes] of Object.entries(files)) {
    await Deno.writeTextFile(path + "/" + name, bytes);
  }
  await checked(path, ["add", "-A"], env);
  await checked(path, ["commit", "-q", "-m", "fixture"], env);
  return await checked(path, ["rev-parse", "HEAD"], env) as GitSha;
}
/**
 * Test-local repair-state adapter over the shared MemoryState. Only the clock
 * fixture's repair half is persisted here: the real store's expected-head CAS,
 * snapshot validation and sequence/time rules stay enabled, and every value
 * crossing the boundary is an independent copy so no consumer can mutate the
 * fixture's authoritative snapshot in place. It is deliberately repair-only
 * (MemoryState also lacks the real store's validateRepairTransition parity),
 * which the narrowed clock assertions and the explicit small real-Git recovery
 * plus sibling case cover together. Release reads never come from here; the
 * real Git release store stays authoritative.
 */
class CopyingRepairState
  implements Pick<StateReadView, "readRepair">, RepairStateWriter {
  private readonly inner = new MemoryState();

  async readRepair(): Promise<
    PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
  > {
    const read = await this.inner.readRepair();
    if (!read.ok || read.value.status !== "found") return read;
    return portOk({
      ...read.value,
      snapshot: structuredClone(read.value.snapshot),
    });
  }

  async writeRepair(
    next: RepairStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    // The real store rejects a snapshot whose stateHead is not the expected
    // remote head before any transition check; MemoryState omits that check, so
    // this adapter applies it with the identical typed diagnostic.
    if (next.stateHead !== expectedHead) {
      return portError(
        "invalid",
        "snapshot stateHead must equal the expected remote head",
      );
    }
    return await this.inner.writeRepair(
      structuredClone(next),
      expectedHead,
    );
  }
}

async function rig(
  healthy = true,
  purpose: "ordinary" | "bootstrap" | "prior" | "candidate" | "rollback" =
    "ordinary",
  fastRepair = false,
) {
  const root = await Deno.makeTempDir({
    prefix: "sentinel-matrix-actions-",
    dir: ROOT,
  });
  await Deno.mkdir(root + "/home");
  const env = testGitEnv(root + "/home");
  const sha = await checkout(root + "/seed", env, {
    "sentinel.targets.json": JSON.stringify([
      "ubiquity/sentinel",
      "ubiquity/ai.ubq.fi",
    ]),
    ".gitignore": ".sentinel-actions-state/\n",
    "base.txt": "self\n",
  });
  const foreignSha = await checkout(root + "/foreign", env, {
    "base.txt": "foreign\n",
  });
  const remote = await makeRemoteCtx(root, env);
  const clock = new FakeClock(T0 + 10000);
  const execution = parseHostedExecutionIntentV1({
    id: "71:1:repair",
    runId: 71,
    runAttempt: 1,
    launcherSha: sha,
    purpose,
    revision: sha,
    generation: 1,
    releaseId: purpose === "ordinary" || purpose === "bootstrap"
      ? null
      : "release:test",
    createdAt: T0 + 10000,
  });
  const prior = parseHostedExecutionIntentV1({
    ...execution,
    id: "70:1:repair",
    runId: 70,
    purpose: "bootstrap",
    releaseId: null,
    createdAt: T0,
  });
  const proof = {
    execution: prior,
    workflowId: HOSTED_SUPERVISOR_WORKFLOW_ID,
    workflowPath: HOSTED_SUPERVISOR_WORKFLOW_PATH,
    repository: "ubiquity/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: 101,
    startedAt: T0,
    finishedAt: T0 + 1000,
    observedAt: T0 + 1000,
    outcome: "healthy",
    startupReady: true,
    settled: true,
    baseSha: sha,
    terminalAt: T0 + 1000,
    logDigest: "a".repeat(64),
  };
  const release = createReleaseStateStore({
    scratchDir: root + "/release",
    remoteUrl: remote.remoteUrl,
  });
  const seeded = await release.writeRelease(
    parseReleaseStateSnapshotV1({
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: clock.now(),
      releases: [],
      hostedReleases: [],
      githubCooldowns: [],
      hostedRuntimes: [{
        version: "v1",
        kind: "hosted_runtime",
        id: HOSTED_RUNTIME_ID,
        activeRevision: sha,
        generation: 1,
        lastHealthyProof: null,
        lastExecutionProof: null,
        nextOrdinaryAt: T0,
        execution: healthy ? prior : execution,
        createdAt: T0,
        updatedAt: clock.now(),
      }],
    }),
    null,
  );
  assert.ok(
    seeded.ok && seeded.value.status === "applied",
    JSON.stringify(seeded),
  );
  if (healthy) {
    const read = await release.readRelease();
    assert.ok(read.ok && read.value.status === "found");
    const previous = read.value.snapshot.hostedRuntimes[0]!;
    const settled = await release.writeRelease(
      parseReleaseStateSnapshotV1({
        ...read.value.snapshot,
        stateHead: read.value.head,
        sequence: 2,
        updatedAt: clock.now(),
        hostedRuntimes: [{
          ...previous,
          execution: null,
          lastHealthyProof: proof,
          lastExecutionProof: proof,
          updatedAt: clock.now(),
        }],
      }),
      read.value.head,
    );
    assert.ok(
      settled.ok && settled.value.status === "applied",
      JSON.stringify(settled),
    );
    const ready = await release.readRelease();
    assert.ok(ready.ok && ready.value.status === "found");
    const started = await release.writeRelease(
      parseReleaseStateSnapshotV1({
        ...ready.value.snapshot,
        stateHead: ready.value.head,
        sequence: 3,
        updatedAt: clock.now(),
        hostedRuntimes: [{
          ...ready.value.snapshot.hostedRuntimes[0]!,
          execution,
          updatedAt: clock.now(),
        }],
      }),
      ready.value.head,
    );
    assert.ok(
      started.ok && started.value.status === "applied",
      JSON.stringify(started),
    );
  }
  const realStore = createRepairStateStore({
    scratchDir: root + "/repair",
    remoteUrl: remote.remoteUrl,
  });
  // The clock fixture shares ONE repair transport across planner, cells, budget
  // and aggregate. Only that scenario narrows the repair half to memory (real
  // CAS/sequence/validation and copy boundaries); every release read and every
  // target Git object stays real.
  const fastState = fastRepair ? new CopyingRepairState() : null;
  const store: RepairGitStateStore = fastState === null
    ? realStore
    : Object.assign(
      Object.create(Object.getPrototypeOf(realStore)) as RepairGitStateStore,
      realStore,
      {
        readRepair: () => fastState!.readRepair(),
        writeRepair: (
          next: RepairStateSnapshotV1,
          expectedHead: GitSha | null,
        ) => fastState!.writeRepair(next, expectedHead),
      },
    );
  const github = new Map<string, TargetGithub>();
  for (
    const [slug, base] of [["ubiquity/sentinel", sha], [
      "ubiquity/ai.ubq.fi",
      foreignSha,
    ]] as const
  ) {
    github.set(
      slug,
      new TargetGithub({
        baseSha: base,
        candidateLifecycle: {
          preserveCandidate: () => Promise.resolve(portOk(undefined)),
        },
        reviewUnavailable: true,
      }),
    );
  }
  await Deno.mkdir(root + "/bin");
  await Deno.writeTextFile(root + "/bin/codex", "");
  const jobs = new Map<string, string>();
  let currentRun = 71;
  async function advanceRun(runId: number) {
    const read = await release.readRelease();
    assert.ok(read.ok && read.value.status === "found");
    const runtime = read.value.snapshot.hostedRuntimes[0]!;
    assert.ok(runtime.execution);
    const settlement = {
      ...proof,
      execution: runtime.execution,
      startedAt: runtime.execution.createdAt,
      finishedAt: clock.now(),
      observedAt: clock.now(),
      terminalAt: clock.now(),
      logDigest: "b".repeat(64),
    };
    const saved = await release.writeRelease(
      parseReleaseStateSnapshotV1({
        ...read.value.snapshot,
        stateHead: read.value.head,
        sequence: read.value.snapshot.sequence + 1,
        updatedAt: clock.now(),
        hostedRuntimes: [{
          ...runtime,
          execution: null,
          lastHealthyProof: settlement,
          lastExecutionProof: settlement,
          updatedAt: clock.now(),
        }],
      }),
      read.value.head,
    );
    assert.ok(
      saved.ok && saved.value.status === "applied",
      JSON.stringify(saved),
    );
    clock.advance(1);
    const next = await release.readRelease();
    assert.ok(next.ok && next.value.status === "found");
    const nextExecution = parseHostedExecutionIntentV1({
      ...execution,
      id: runId + ":1:repair",
      runId,
      createdAt: clock.now(),
    });
    const started = await release.writeRelease(
      parseReleaseStateSnapshotV1({
        ...next.value.snapshot,
        stateHead: next.value.head,
        sequence: next.value.snapshot.sequence + 1,
        updatedAt: clock.now(),
        hostedRuntimes: [{
          ...next.value.snapshot.hostedRuntimes[0]!,
          execution: nextExecution,
          updatedAt: clock.now(),
        }],
      }),
      next.value.head,
    );
    assert.ok(
      started.ok && started.value.status === "applied",
      JSON.stringify(started),
    );
    currentRun = runId;
  }
  async function job(name: string, role: string) {
    const dir = root + "/" + name + "/runtime";
    await Deno.mkdir(root + "/" + name, { recursive: true });
    await checked(root, ["clone", "-q", root + "/seed", dir], env);
    jobs.set(name, dir);
    return {
      clock,
      workDir: dir,
      stateRemoteUrl: remote.remoteUrl,
      refreshSelf: () => Promise.resolve(sha),
      resolveDefaultBranch: () => Promise.resolve("development"),
      preflight: () => Promise.resolve(),
      env: {
        GITHUB_RUN_ID: String(currentRun),
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_REPOSITORY: "ubiquity/sentinel",
        GITHUB_REF: "refs/heads/sentinel-supervisor",
        GITHUB_SHA: sha,
        GITHUB_WORKFLOW_SHA: sha,
        GITHUB_WORKFLOW_REF:
          "ubiquity/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor",
        GITHUB_JOB: role,
        GITHUB_TOKEN: "fake-read-token",
        SENTINEL_SUPERVISOR_TOKEN: "fake-app-token",
        UOS_AI_TOKEN: "fake-model-token",
        PATH: root + "/bin:" + (Deno.env.get("PATH") ?? "/usr/bin:/bin"),
        HOME: root + "/home",
        GITHUB_OUTPUT: root + "/" + name + "/output",
        SENTINEL_COOLDOWN_MODE: "off",
      },
      http: () => Promise.reject(new Error("no external HTTP allowed")),
      composeGithub: (
        config: { repository: { owner: string; name: string } },
      ) => github.get(config.repository.owner + "/" + config.repository.name)!,
      prepareTarget: async (
        config: { repository: { name: string } },
        source: string,
      ) => {
        if (config.repository.name === "sentinel") return;
        try {
          await Deno.stat(source);
        } catch {
          await Deno.mkdir(source.slice(0, source.lastIndexOf("/")), {
            recursive: true,
          });
          await checked(root, ["clone", "-q", root + "/foreign", source], env);
        }
      },
    };
  }
  return {
    root,
    env,
    sha,
    foreignSha,
    clock,
    store,
    release,
    github,
    jobs,
    job,
    advanceRun,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}
Deno.test("preservation maintenance: real repair startup skips five blocked candidates and retains PR893", async () => {
  const r = await rig(true, "prior");
  try {
    const repo = {
      owner: "ubiquity",
      name: "ai.ubq.fi",
      installationId: 155687488,
    };
    const implementationIds = MATRIX_UNCERTAINTY_BINDING.reservationIds;
    const implementations = implementationIds.map((requestId, index) => {
      const id = ("issue-ubiquity-ai.ubq.fi-" + (595 + index)) as WorkItemId;
      return workRecord(id, {
        repository: repo,
        target: {
          base: r.foreignSha,
          branch: candidateBranch(id),
          head: null,
          checkpoint: null,
          pr: null,
        },
        counters: { attempts: 1, retries: 0, reviewRounds: 0 },
        intent: {
          kind: "implementation",
          key: implementationIntentKey(requestId),
          requestId,
          startedAt: T0 + 3000,
          branch: candidateBranch(id),
          expectedHead: null,
          observedBase: r.foreignSha,
          pr: null,
          resultId: null,
        },
      });
    });
    const preservationIds = [
      "c0d668a23d4c5230f6349d8368d964ea566509bd2e23a9476279108bc74dbc8b",
      "536ffe5515e1bcee3105412af0f419566b76ae422095ac54039f7a6789e1f02b",
      "739b0d9b59604f1fa163f5f90bf9fb37fd33d93ae8eee8d606e0fa174016671d",
      "11acb1590ed849db9e3fa8c4fe071ed169142c74c122deb8b40bc4ad55d7c6b3",
      "971b6ea4516e09c84a94083705353228a5d2ef31d652ddc9346fd5cae34081d9",
    ];
    const preservation = await Promise.all(
      preservationIds.map(async (requestId, index) => {
        const number = [884, 880, 730, 754, 879][index];
        const id = ("issue-ubiquity-ai.ubq.fi-" + number) as WorkItemId;
        return workRecord(id, {
          repository: repo,
          source: { kind: "issue", id: String(number), revision: String(T0) },
          related: { incidentId: null, issueNumber: number },
          target: {
            base: r.foreignSha,
            branch: candidateBranch(id),
            head: r.sha,
            checkpoint: null,
            pr: number === 730 ? 893 : null,
            candidateState: {
              preserved: null,
              publishedHead: number === 730 ? r.foreignSha : null,
            },
          },
          counters: { attempts: 1, retries: 0, reviewRounds: 0 },
          intent: {
            kind: "candidate_preservation",
            key: implementationIntentKey(requestId),
            requestId,
            startedAt: T0 + 3000,
            branch: await candidatePreservationRef(
              repo,
              id,
              implementationIntentKey(requestId),
            ),
            expectedHead: r.sha,
            observedBase: r.foreignSha,
            pr: null,
            resultId: null,
          },
        });
      }),
    );
    const control = workRecord("issue-ubiquity-sentinel-1", {
      repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
      source: { kind: "issue", id: "1", revision: String(T0) },
      target: {
        base: r.sha,
        branch: null,
        head: null,
        checkpoint: null,
        pr: null,
      },
    });
    const charges = [...implementations, ...preservation].map((row) =>
      reservation(row.intent!.requestId!, {
        repository: repo,
        taskId: row.id,
        head: r.foreignSha,
        attempt: 1,
        createdAt: T0 + 1000,
        outcome: row.intent!.kind === "candidate_preservation"
          ? "submitted"
          : "reserved",
        settledAt: row.intent!.kind === "candidate_preservation"
          ? T0 + 3000
          : null,
      })
    );
    const capture = parseRepairStateSnapshotV1({
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0 + 3000,
      incidents: [],
      evidence: [],
      work: [...implementations, ...preservation, control],
      reservations: charges,
      reviews: [],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
    });
    const saved = await r.store.writeRepair(capture, null);
    assert.ok(saved.ok && saved.value.status === "applied");
    const captureHead = saved.value.head;
    const parked = await r.store.writeRepair(
      parseRepairStateSnapshotV1({
        ...capture,
        stateHead: saved.value.head,
        sequence: 2,
        updatedAt: r.clock.now(),
        work: capture.work.map((row) =>
          implementationIds.includes(row.intent?.requestId ?? "")
            ? markBlocked(
              row,
              "other",
              MATRIX_UNCERTAINTY_DETAIL,
              r.clock.now(),
            )
            : row
        ),
        reservations: charges.map((row) =>
          implementationIds.includes(row.id)
            ? { ...row, outcome: "ambiguous", settledAt: r.clock.now() }
            : row
        ),
      }),
      saved.value.head,
    );
    assert.ok(parked.ok && parked.value.status === "applied");
    const request = releaseRequest("release:test", {
      target: {
        repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
        environment: "production",
      },
      revision: r.foreignSha,
      source: {
        pullRequest: 111,
        reviewRequestId: "review-111",
        reviewReceiptId: "review-111",
        head: r.foreignSha,
        base: r.sha,
      },
    });
    const live = await r.release.readRelease();
    assert.ok(live.ok && live.value.status === "found");
    const runtime = live.value.snapshot.hostedRuntimes[0];
    assert.ok(
      runtime.execution && runtime.lastExecutionProof &&
        runtime.lastExecutionProof.outcome !== "not_started",
    );
    const failed = {
      ...runtime.lastExecutionProof,
      execution: runtime.execution,
      startedAt: runtime.execution.createdAt,
      finishedAt: r.clock.now(),
      observedAt: r.clock.now(),
      terminalAt: r.clock.now(),
      outcome: "failed" as const,
      startupReady: false,
      baseSha: null,
    };
    const releaseSaved = await r.release.writeRelease(
      parseReleaseStateSnapshotV1({
        ...live.value.snapshot,
        stateHead: live.value.head,
        sequence: live.value.snapshot.sequence + 1,
        hostedRuntimes: [{
          ...runtime,
          execution: null,
          lastExecutionProof: failed,
        }],
        hostedReleases: [{
          version: "v1",
          kind: "hosted_release",
          id: request.id,
          request,
          priorRevision: r.sha,
          phase: "requested",
          priorProof: null,
          candidateProof: null,
          rollbackProof: null,
          pointerIntent: null,
          createdAt: r.clock.now(),
          updatedAt: r.clock.now(),
        }],
      }),
      live.value.head,
    );
    assert.ok(
      releaseSaved.ok && releaseSaved.value.status === "applied",
      JSON.stringify(releaseSaved),
    );
    const state = {
      readRepair: () => r.store.readRepair(),
      readRepairAt: r.store.readRepairAt!.bind(r.store),
      writeRepair: r.store.writeRepair.bind(r.store),
      readRelease: () => r.release.readRelease(),
    };
    const heldRelease = await state.readRelease();
    const before = await state.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    await runHostedAutonomy({
      state,
      clock: r.clock,
      githubFor: () => {
        throw Error("ordinary publication refused");
      },
      uncertainMatrix: () =>
        runMatrixUncertaintyMaintenance({
          state,
          clock: r.clock,
          binding: {
            repairCommit: captureHead,
            runtimeSha: r.sha,
            generation: 1,
            reservationIds: implementationIds,
          },
          confirmCompletedExecution: () => Promise.resolve(true),
          readExecution: () => Promise.resolve(portOk(failed)),
        }),
    });
    const after = await state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.equal(
      after.value.snapshot.work.filter((row) =>
        row.blocker?.message === MATRIX_PRESERVATION_UNCERTAINTY_DETAIL
      ).length,
      5,
    );
    assert.deepEqual(
      after.value.snapshot.reservations,
      before.value.snapshot.reservations,
    );
    assert.deepEqual(await state.readRelease(), heldRelease);
    const releaseRead = await r.release.readRelease();
    assert.ok(releaseRead.ok && releaseRead.value.status === "found");
    r.clock.advance(1);
    const nextExecution = parseHostedExecutionIntentV1({
      ...failed.execution,
      id: "72:1:repair",
      runId: 72,
      createdAt: r.clock.now(),
    });
    const started = await r.release.writeRelease(
      parseReleaseStateSnapshotV1({
        ...releaseRead.value.snapshot,
        sequence: releaseRead.value.snapshot.sequence + 1,
        stateHead: releaseRead.value.head,
        updatedAt: r.clock.now(),
        hostedRuntimes: releaseRead.value.snapshot.hostedRuntimes.map((
          row,
        ) => ({ ...row, execution: nextExecution, updatedAt: r.clock.now() })),
      }),
      releaseRead.value.head,
    );
    assert.ok(started.ok && started.value.status === "applied");
    const deps = await r.job("preservation-startup", "repair");
    const result = await runActionsRepairHost({
      ...deps,
      env: { ...deps.env, GITHUB_RUN_ID: "72" },
      model: {
        modelId: "gpt-reserve",
        runModel: () => {
          throw Error("startup must not implement");
        },
      },
      runTargetCycles: (input) =>
        runActionsMatrixAggregateCycles(
          { ...input, modelStartsEnabled: false },
          {
            recover: (input) => {
              assert.deepEqual(input.requests, []);
              return Promise.resolve([]);
            },
          },
        ),
    });
    assert.equal(result.startupReady, true);
    const settled = await r.store.readRepair();
    assert.ok(settled.ok && settled.value.status === "found");
    for (const original of preservation) {
      const row: WorkRecordV1 = settled.value.snapshot.work.find((work) =>
        work.id === original.id
      )!;
      assert.equal(row.nextStep, "blocked");
      assert.deepEqual(row.target, original.target);
      assert.deepEqual(row.intent, original.intent);
    }
    assert.equal(
      settled.value.snapshot.work.find((row) => row.id === control.id)!
        .nextStep,
      "work",
    );
    assert.deepEqual(
      settled.value.snapshot.reservations,
      after.value.snapshot.reservations,
    );
  } finally {
    await r.cleanup();
  }
});

Deno.test("closed C recovery: real mixed ingestion preserves charges and rehydrates fresh mirrors", async () => {
  const r = await rig();
  try {
    for (
      const [slug, count] of [["ubiquity/sentinel", 1], [
        "ubiquity/ai.ubq.fi",
        4,
      ]] as const
    ) {
      const rows = Array.from(
        { length: count },
        (_, index) => issue(index + 1),
      );
      const port = r.github.get(slug)!;
      port.listOpenIssues = () => Promise.resolve(portOk(rows));
      port.readIssue = (number) =>
        Promise.resolve(portOk(rows[number - 1] ?? null));
    }
    const refusing: ImplementationPort = {
      modelId: "gpt-reserve",
      runModel: () => {
        throw Error("recovery cannot start a model");
      },
    };
    const planner = await runActionsMatrixHost({
      ...await r.job("closed-plan", "matrix_plan"),
      model: refusing,
    });
    assert.ok("plan" in planner);
    assert.equal(planner.plan.cells.length, 5);
    const producerRepair = await r.store.readRepair();
    assert.ok(producerRepair.ok && producerRepair.value.status === "found");
    const results: MatrixCellResultV1[] = [];
    const archive = r.root + "/closed-archive";
    await Deno.mkdir(archive);
    for (const cell of planner.plan.cells) {
      const deps = await r.job("closed-cell-" + cell.cellId, "matrix_cell");
      const artifactRoot = deps.workDir + "/../.sentinel-matrix";
      await Deno.mkdir(artifactRoot);
      await Deno.writeTextFile(
        artifactRoot + "/plan.json",
        JSON.stringify(planner.plan),
      );
      const number = cell.request.issue!.number;
      const model: ImplementationPort = {
        modelId: "gpt-reserve",
        runModel: async (request) => {
          if (
            request.repository.name === "ai.ubq.fi" &&
            (number === 2 || number === 3)
          ) {
            return portOk({
              invocationId: cell.cellId,
              outcome: "interrupted",
              actual: {
                evidenceKind: "request-runtime",
                provider: PROVIDER,
                threadId: "thread-" + cell.cellId,
                turnId: "turn-" + cell.cellId,
                terminalOrigin: "runtime",
                observedTerminalStatus: "interrupted",
                observedModel: request.model,
                observedReasoning: "max",
                durationMs: 1,
                outputChars: 1,
              },
              candidate: null,
              error: null,
            });
          }
          const source = deps.workDir + "/.sentinel-actions-state/" +
            (request.repository.name === "sentinel"
              ? "source"
              : "sources/ubiquity-ai.ubq.fi");
          const path = request.repository.name === "sentinel" || number === 4
            ? "repair.txt"
            : "deno.json";
          await Deno.writeTextFile(source + "/" + path, "candidate\n");
          await checked(source, ["add", path], r.env);
          await checked(source, ["commit", "-q", "-m", "candidate"], r.env);
          const head = await checked(
            source,
            ["rev-parse", "HEAD"],
            r.env,
          ) as GitSha;
          return portOk({
            invocationId: cell.cellId,
            outcome: "completed",
            actual: {
              evidenceKind: "request-runtime",
              provider: PROVIDER,
              threadId: "thread-" + cell.cellId,
              turnId: "turn-" + cell.cellId,
              terminalOrigin: "runtime",
              observedTerminalStatus: "completed",
              observedModel: request.model,
              observedReasoning: "max",
              durationMs: 1,
              outputChars: 1,
            },
            candidate: {
              head,
              checkpointSha: request.repository.name === "sentinel"
                ? head
                : null,
              changedPaths: [path],
            },
            error: null,
          });
        },
      };
      const result = await runActionsMatrixHost({
        ...deps,
        model,
        carrier: { planDigest: planner.planDigest, cellId: cell.cellId },
      });
      assert.ok("cellId" in result);
      results.push(result);
      if (result.bundle) {
        await Deno.copyFile(
          artifactRoot + "/" + result.bundle.file,
          archive + "/" + result.bundle.file,
        );
      }
      await Deno.remove(deps.workDir + "/..", { recursive: true });
    }
    let assembly: ActionsTargetCyclesInputV1 | undefined;
    const capture = await r.job("closed-capture", "repair");
    await runActionsRepairHost({
      ...capture,
      model: refusing,
      runTargetCycles: (input) => {
        assembly = input;
        return Promise.resolve({
          outcome: { status: "idle", detail: "captured leaf dependencies" },
          addressed: [],
          skipped: [],
          failed: [],
        });
      },
    });
    assert.ok(assembly);
    const release = await r.release.readRelease();
    assert.ok(release.ok && release.value.status === "found");
    const runtime = release.value.snapshot.hostedRuntimes[0]!;
    assert.ok(runtime.execution && runtime.lastHealthyProof);
    const failedProof = {
      ...runtime.lastHealthyProof,
      execution: runtime.execution,
      startedAt: runtime.execution.createdAt,
      finishedAt: r.clock.now(),
      observedAt: r.clock.now(),
      outcome: "failed" as const,
      terminalAt: null,
      logDigest: "c".repeat(64),
    };
    const saved = await r.release.writeRelease(
      parseReleaseStateSnapshotV1({
        ...release.value.snapshot,
        stateHead: release.value.head,
        sequence: release.value.snapshot.sequence + 1,
        updatedAt: r.clock.now(),
        hostedRuntimes: [{
          ...runtime,
          execution: null,
          lastExecutionProof: failedProof,
          updatedAt: r.clock.now(),
        }],
      }),
      release.value.head,
    );
    assert.ok(
      saved.ok && saved.value.status === "applied",
      JSON.stringify(saved),
    );
    const binding = {
      runtimeSha: r.sha,
      generation: 1,
      run: planner.plan.run,
      repairCommit: producerRepair.value.head,
      releaseCommit: saved.value.head,
      planDigest: planner.planDigest,
      expectedProvider: PROVIDER,
      cells: planner.plan.cells.map((cell) => ({
        reservationId: cell.reservationId,
        taskId: cell.taskId,
        repository: cell.repository,
        base: cell.expectedBase,
      })),
    };
    const input = assembly;
    const deps = {
      state: r.store,
      clock: r.clock,
      configs: input.configs,
      cycleFor: (config: typeof input.configs[number]) => ({
        ...input,
        github: input.composeGithub(config),
        model: refusing,
        externalImplementations: true,
      }),
      prepareTarget: (config: typeof input.configs[number]) =>
        input.prepareTarget!(config),
      importerFor: (config: typeof input.configs[number], bundlesDir: string) =>
        createGitBundleImporter({
          repositoryDir: input.host!.sourcePathFor(config),
          bundlesDir,
        }),
      transportFor: () => ({
        confirmCompletedExecution: () => Promise.resolve(true),
        recover: (
          { requests }: { requests: readonly { reservationId: string }[] },
        ) =>
          Promise.resolve([{
            plan: planner.plan,
            planDigest: planner.planDigest,
            results: results.filter((result) =>
              requests.some((request) =>
                request.reservationId === result.reservationId
              )
            ),
            bundlesDir: archive,
            provenance: {
              run: planner.plan.run,
              plannerJobId: 101,
              cellJobIds: [102, 103, 104, 105],
            },
          }]),
      }),
      readExecution: () => Promise.resolve(portOk(failedProof)),
      binding,
    };
    assert.equal(
      closedCWaveNeedsRecovery(producerRepair.value.snapshot, binding),
      true,
      "unsettled original charges cannot retire",
    );
    const writeRepair = input.state.writeRepair.bind(input.state);
    let refusedCandidate = false;
    input.state.writeRepair = (snapshot, expectedHead) => {
      if (
        snapshot.work.some((row) =>
          row.repository.name === "sentinel" &&
          row.intent?.kind === "candidate_preservation"
        )
      ) {
        refusedCandidate = true;
        return Promise.resolve(
          portOk({ status: "conflict", currentHead: expectedHead }),
        );
      }
      return writeRepair(snapshot, expectedHead);
    };
    await assert.rejects(
      () => ingestClosedCWave(deps),
      /ingestion incomplete|readback unavailable/,
    );
    input.state.writeRepair = writeRepair;
    assert.equal(refusedCandidate, true);
    const partial = await r.store.readRepair();
    assert.ok(partial.ok && partial.value.status === "found");
    assert.equal(
      partial.value.snapshot.reservations.filter((row) =>
        row.outcome === "submitted"
      ).length,
      1,
    );
    assert.equal(
      closedCWaveNeedsRecovery(partial.value.snapshot, binding),
      true,
      "settled charge plus still-active original implementation cannot retire partial ingestion",
    );
    await assert.rejects(
      () =>
        ingestClosedCWave({
          ...deps,
          transportFor: () => ({
            confirmCompletedExecution: () => Promise.resolve(true),
            recover: () => {
              throw new Error("original archive unavailable");
            },
          }),
        }),
      /original archive unavailable/,
    );
    assert.deepEqual(
      await r.store.readRepair(),
      partial,
      "partial/unsettled scope cannot silently bypass custody or change state",
    );
    const first = await ingestClosedCWave(deps);
    const maintenance = await runHostedAutonomy({
      state: r.store,
      clock: r.clock,
      githubFor: () => {
        throw new Error(
          "maintenance must not follow ingestion with ordinary actions",
        );
      },
      historicalMatrix: {
        state: r.store,
        clock: r.clock,
        budget: input.budget,
        readExecution: () => {
          throw new Error(
            "legacy rejection must follow successful C ingestion on a later pass",
          );
        },
        transport: deps.transportFor(),
      },
      closedMatrix: () => Promise.resolve(deps),
    });
    assert.equal(maintenance.status, "skipped");
    assert.equal(
      first.dispositions.filter((row) => row.outcome === "submitted").length,
      3,
    );
    assert.equal(
      first.dispositions.filter((row) => row.outcome === "ambiguous").length,
      2,
    );
    assert.equal(
      first.dispositions.filter((row) =>
        row.intentKind === "candidate_preservation"
      ).length,
      2,
    );
    const protectedRow = first.dispositions.find((row) =>
      row.taskId.includes("ai.ubq.fi-1")
    )!;
    assert.equal(protectedRow.nextStep, "blocked");
    assert.equal(protectedRow.intentKind, null);
    assert.ok(protectedRow.head);
    assert.equal(protectedRow.checkpoint, null);
    const settled = await r.store.readRepair();
    assert.ok(settled.ok && settled.value.status === "found");
    assert.equal(
      closedCWaveHandledReservations(settled.value.snapshot, binding).size,
      5,
    );
    for (const config of input.configs) {
      const source = input.host!.sourcePathFor(config);
      await Deno.remove(source, { recursive: true });
      await checked(r.root, [
        "clone",
        "-q",
        config.repository.name === "sentinel"
          ? r.root + "/seed"
          : r.root + "/foreign",
        source,
      ], r.env);
    }
    const replay = await ingestClosedCWave(deps);
    assert.equal(
      replay.repairHead,
      first.repairHead,
      "rehydration must not resettle or mutate state",
    );
    for (
      const result of results.filter((row) =>
        row.bundle !== null && !row.taskId.endsWith("ai.ubq.fi-1")
      )
    ) {
      const config = input.configs.find((row) =>
        row.repository.name === result.repository.name
      )!;
      assert.ok(
        (await gitRun(input.host!.sourcePathFor(config), [
          "cat-file",
          "-e",
          result.bundle!.head + "^{commit}",
        ], r.env)).ok,
      );
    }
    const originalCharges = await r.store.readRepair();
    assert.ok(originalCharges.ok && originalCharges.value.status === "found");
    const retryPlans = planHostedRetries(
      originalCharges.value.snapshot,
      r.clock.now(),
    );
    assert.equal(
      retryPlans.length,
      2,
      "real incomplete receipts produce two legitimate maintenance retry plans",
    );
    const retried = await r.store.writeRepair(
      applyHostedRetries(
        originalCharges.value.snapshot,
        originalCharges.value.head,
        retryPlans,
        r.clock.now(),
      ),
      originalCharges.value.head,
    );
    assert.ok(retried.ok && retried.value.status === "applied");
    const afterRetry = await r.store.readRepair();
    assert.ok(afterRetry.ok && afterRetry.value.status === "found");
    const closing = afterRetry.value.snapshot.work.find((row) =>
      row.id.endsWith("ai.ubq.fi-3")
    )!;
    const retirementPlans = planHostedRetirements(
      afterRetry.value.snapshot,
      new Set([
        hostedIssueKey(closing.repository, closing.related.issueNumber!),
      ]),
    );
    assert.equal(retirementPlans.length, 1);
    const closed = await r.store.writeRepair(
      applyHostedRetirements(
        afterRetry.value.snapshot,
        afterRetry.value.head,
        retirementPlans,
        r.clock.now(),
      ),
      afterRetry.value.head,
    );
    assert.ok(closed.ok && closed.value.status === "applied");
    const beforeRecovered = await r.store.readRepair();
    assert.ok(beforeRecovered.ok && beforeRecovered.value.status === "found");
    assert.deepEqual(
      beforeRecovered.value.snapshot.reservations,
      originalCharges.value.snapshot.reservations,
      "retry and source retirement preserve all original charges",
    );
    const recoveredAfterProgress = await ingestClosedCWave(deps);
    assert.equal(
      recoveredAfterProgress.repairHead,
      beforeRecovered.value.head,
      "recovery hydrates active preservation without reopening consumed ambiguous operations",
    );
    await assert.rejects(
      () =>
        ingestClosedCWave({
          ...deps,
          readExecution: () =>
            Promise.resolve(
              portOk({ ...failedProof, logDigest: "d".repeat(64) }),
            ),
        }),
      /native failure proof changed/,
    );
    const self = input.configs.find((config) =>
      config.repository.name === "sentinel"
    )!;
    await runRepairCycle({ ...deps.cycleFor(self), configs: [self] }, {
      deadline: r.clock.now() + 240_000,
      stepLimit: 1,
      modelStartsEnabled: false,
    });
    let published = await r.store.readRepair();
    assert.ok(published.ok && published.value.status === "found");
    for (
      let step = 0;
      step < 3 &&
      published.value.snapshot.work.find((row) =>
          row.repository.name === "sentinel"
        )!.target.pr === null;
      step++
    ) {
      await runRepairCycle({ ...deps.cycleFor(self), configs: [self] }, {
        deadline: r.clock.now() + 240_000,
        stepLimit: 1,
        modelStartsEnabled: false,
      });
      published = await r.store.readRepair();
      assert.ok(published.ok && published.value.status === "found");
    }
    const sibling = published.value.snapshot.work.find((row) =>
      row.repository.name === "sentinel"
    )!;
    assert.ok(
      sibling.target.pr !== null && sibling.target.head !== null &&
        sibling.target.candidateState?.preserved !== null,
      "actual consumer publishes the consumed sibling before refreshing its base",
    );
    const source = input.host!.sourcePathFor(self);
    await checked(
      source,
      ["checkout", "-q", "-b", "fixture-new-base", r.sha],
      r.env,
    );
    await Deno.writeTextFile(source + "/new-base.txt", "base moved\n");
    await checked(source, ["add", "new-base.txt"], r.env);
    await checked(source, ["commit", "-q", "-m", "new base"], r.env);
    const newBase = await checked(
      source,
      ["rev-parse", "HEAD"],
      r.env,
    ) as GitSha;
    await checked(source, [
      "checkout",
      "-q",
      "-b",
      "fixture-refreshed-head",
      sibling.target.head!,
    ], r.env);
    await checked(source, ["merge", "-q", "--no-edit", newBase], r.env);
    const refreshedHead = await checked(
      source,
      ["rev-parse", "HEAD"],
      r.env,
    ) as GitSha;
    const selfGithub = r.github.get("ubiquity/sentinel")!;
    selfGithub.prepareBaseRefresh = () =>
      Promise.resolve(portOk(refreshedHead));
    const refresh = await r.store.writeRepair(
      applyHostedRetries(published.value.snapshot, published.value.head, [{
        id: sibling.id,
        repository: sibling.repository,
        grant: 0,
        nextStep: "work",
        reviewRounds: null,
        advanceBase: true,
        observedBase: newBase,
        detail: "fixture trusted base advancement",
      }], r.clock.now()),
      published.value.head,
    );
    assert.ok(refresh.ok && refresh.value.status === "applied");
    await runRepairCycle({ ...deps.cycleFor(self), configs: [self] }, {
      deadline: r.clock.now() + 240_000,
      stepLimit: 1,
      modelStartsEnabled: false,
    });
    const progressed = await r.store.readRepair();
    assert.ok(progressed.ok && progressed.value.status === "found");
    assert.equal(
      progressed.value.snapshot.work.find((row) => row.id === sibling.id)!
        .target.head,
      refreshedHead,
    );
    assert.equal(
      progressed.value.snapshot.work.find((row) => row.id === sibling.id)!
        .target.base,
      newBase,
    );
    const activeRecovery = await ingestClosedCWave(deps);
    assert.equal(
      activeRecovery.dispositions.length,
      1,
      "only the other still-actionable C preservation is read back",
    );
    assert.equal(
      activeRecovery.repairHead,
      progressed.value.head,
      "base-refreshed sibling remains unchanged while another candidate hydrates",
    );
    const foreign = input.configs.find((config) =>
      config.repository.name === "ai.ubq.fi"
    )!;
    await runRepairCycle({ ...deps.cycleFor(foreign), configs: [foreign] }, {
      deadline: r.clock.now() + 240_000,
      stepLimit: 1,
      modelStartsEnabled: false,
    });
    const ready = await r.store.readRepair();
    assert.ok(ready.ok && ready.value.status === "found");
    const newRetry = ready.value.snapshot.work.find((row) =>
      row.id.endsWith("ai.ubq.fi-2")
    )!;
    const retryCycle = { ...deps.cycleFor(foreign), configs: [foreign] };
    const retryContext = await loadRepairContext(
      retryCycle,
      createRunBounds(retryCycle, {
        deadline: input.deadline,
        runStartedAt: r.clock.now(),
        modelStartsEnabled: true,
      }),
    );
    assert.ok(retryContext);
    const nextAdmission = await prepareImplementationStart(
      retryCycle,
      retryContext,
      newRetry,
      foreign,
    );
    assert.equal(nextAdmission.kind, "prepared", JSON.stringify(nextAdmission));
    const retired = await r.store.readRepair();
    assert.ok(retired.ok && retired.value.status === "found");
    assert.equal(
      retired.value.snapshot.work.find((row) => row.id.includes("sentinel-1"))
        ?.intent,
      null,
      "actual preservation consumer must finish actionable custody",
    );
    const liveNewRetry = retired.value.snapshot.work.find((row) =>
      row.id === newRetry.id
    )!;
    assert.ok(liveNewRetry.intent?.requestId);
    assert.equal(
      closedCWaveHandledReservations(retired.value.snapshot, binding).has(
        liveNewRetry.intent!.requestId!,
      ),
      false,
      "new retry request is not in the retired original scope",
    );
    assert.equal(
      closedCWaveNeedsRecovery(retired.value.snapshot, binding),
      false,
      "handled protected BLOCKED candidate cannot keep old archives a global prerequisite",
    );
    for (const missing of [false, true]) {
      const unavailable = {
        ...deps,
        transportFor: () => ({
          recover: () => {
            throw new Error(missing ? "archive missing" : "archive expired");
          },
        }),
      };
      const noop = await ingestClosedCWave(unavailable);
      assert.equal(
        noop.dispositions.length,
        0,
        "fully retired scope performs no old artifact/history IO",
      );
      const maintenance = await runHostedAutonomy({
        state: r.store,
        clock: r.clock,
        githubFor: () => null,
        closedMatrix: () => Promise.resolve(unavailable),
      });
      assert.notEqual(
        maintenance.status,
        "failed",
        "retired protected disposition cannot block automatic maintenance on expired or missing archives",
      );
      assert.deepEqual(
        await r.store.readRepair(),
        retired,
        "retirement preserves blocked head/checkpoint, charges and all state",
      );
    }
  } finally {
    await r.cleanup();
  }
});

for (const mode of [false, true, "expensive_reads", "fresh_drift"] as const) {
  const unassigned = mode === true;
  const expensiveReads = mode === "expensive_reads";
  const freshDrift = mode === "fresh_drift";
  Deno.test(
    "matrix actions planner window: " +
      (freshDrift
        ? "fresh state eligibility is reread per selected candidate"
        : expensiveReads
        ? "ready mixed backlog avoids repeated full snapshots"
        : unassigned
        ? "fresh intake assigns branches before unrelated backlog"
        : "ready work precedes unrelated deterministic backlog"),
    async () => {
      const r = await rig();
      try {
        const memory = new MemoryState();
        const release = await r.store.readRelease();
        assert.ok(release.ok && release.value.status === "found");
        memory.setRelease(release.value.snapshot);
        const repository = {
          owner: "ubiquity",
          name: "sentinel",
          installationId: 0,
        };
        const background = Array.from(
          { length: 160 },
          (_, index) => {
            const liveIntent = expensiveReads && index % 3 === 2;
            const requestId = (index + 1).toString(16).padStart(64, "0");
            const branch = "sentinel/background-" + index;
            return workRecord("background-review-" + index, {
              repository: expensiveReads && index === 159
                ? { ...repository, name: "unconfigured" }
                : repository,
              source: {
                kind: "issue",
                id: String(index + 1000),
                revision: r.sha,
              },
              related: { incidentId: null, issueNumber: index + 1000 },
              controller: { sha: r.sha },
              failingRevision: null,
              nextStep: liveIntent
                ? "work"
                : expensiveReads && index % 3 === 1
                ? "delivery"
                : "review",
              counters: { attempts: 1, retries: 0, reviewRounds: 1 },
              target: {
                base: r.sha,
                branch,
                checkpoint: null,
                head: liveIntent ? null : r.sha,
                pr: liveIntent ? null : index + 1000,
              },
              intent: liveIntent
                ? {
                  kind: "implementation",
                  key: implementationIntentKey(requestId),
                  startedAt: T0,
                  branch,
                  expectedHead: null,
                  observedBase: r.sha,
                  pr: null,
                  requestId,
                  resultId: null,
                }
                : null,
            });
          },
        );
        const fresh = workRecord("issue-ubiquity-sentinel-1", {
          repository,
          source: { kind: "issue", id: "1", revision: r.sha },
          controller: { sha: r.sha },
          failingRevision: null,
          target: {
            base: r.sha,
            branch: "sentinel/repair/issue-ubiquity-sentinel-1",
            checkpoint: null,
            head: null,
            pr: null,
          },
        });
        const historical = reservation("historical-background-review", {
          repository,
          taskId: background[0]!.id,
          head: r.sha,
          purpose: "review_request",
          outcome: "submitted",
          settledAt: T0 + 1,
          proofRef: null,
        });
        const second = workRecord("issue-ubiquity-sentinel-2", {
          ...fresh,
          id: "issue-ubiquity-sentinel-2",
          source: { ...fresh.source, id: "2" },
          related: { incidentId: null, issueNumber: 2 },
          target: {
            ...fresh.target,
            branch: "sentinel/repair/issue-ubiquity-sentinel-2",
          },
        });
        const expectedCells = expensiveReads ? 2 : 1;
        const seeded = await memory.writeRepair(
          parseRepairStateSnapshotV1({
            version: "v1",
            kind: "repair_state_snapshot",
            stateHead: null,
            sequence: 1,
            updatedAt: r.clock.now(),
            incidents: [],
            evidence: [],
            work: unassigned
              ? background
              : expensiveReads || freshDrift
              ? [fresh, second, ...background]
              : [fresh, ...background],
            reservations: [historical],
            reviews: [],
            replays: [],
            releaseRequests: [],
            githubCooldowns: [],
            attemptMemory: [],
            lessons: [],
          }),
          null,
        );
        assert.ok(seeded.ok && seeded.value.status === "applied");
        const source = r.github.get("ubiquity/sentinel")!;
        let fullReads = 0, measureReads = expensiveReads;
        if (freshDrift) {
          const write = memory.writeRepair.bind(memory);
          let changed = false;
          memory.writeRepair = (snapshot, expected) => {
            if (
              !changed &&
              snapshot.work.some((row) =>
                row.id === fresh.id && row.intent?.kind === "implementation"
              )
            ) {
              changed = true;
              snapshot = structuredClone(snapshot);
              snapshot.work = snapshot.work.map((row) =>
                row.id === second.id
                  ? {
                    ...row,
                    nextStep: "blocked",
                    blocker: {
                      kind: "other",
                      message: "current eligibility changed",
                      since: r.clock.now(),
                    },
                    wait: null,
                  }
                  : row
              );
            }
            return write(snapshot, expected);
          };
        }
        if (expensiveReads || freshDrift) {
          const read = memory.readRepair.bind(memory);
          memory.readRepair = () => {
            if (measureReads) {
              fullReads++;
              r.clock.advance(45000);
            }
            return read();
          };
          const rows = [issue(1), issue(2)];
          source.listOpenIssues = () => Promise.resolve(portOk(rows));
          source.readIssue = (number) => {
            assert.ok(
              number === 1 || (!freshDrift && number === 2),
              "only currently eligible tasks may reach preparation",
            );
            return Promise.resolve(portOk(rows[number - 1] ?? null));
          };
        }
        r.github.get("ubiquity/ai.ubq.fi")!.listOpenIssues = () =>
          Promise.resolve(portOk([]));
        let backgroundReads = 0, modelCalls = 0;
        source.readPullRequest = async () => {
          await Promise.resolve();
          backgroundReads++;
          r.clock.advance(29000);
          return portOk(null);
        };
        const model: ImplementationPort = {
          modelId: "gpt-reserve",
          runModel: () => {
            modelCalls++;
            return Promise.resolve(
              portError("unavailable", "bounded fake model outcome"),
            );
          },
        };
        const planned = await runActionsMatrixHost({
          ...await r.job("window-plan", "matrix_plan"),
          state: memory,
          model,
        });
        measureReads = false;
        if (expensiveReads) {
          console.log(
            JSON.stringify({
              kind: "planner_snapshot_cost",
              fullReads,
              simulatedElapsedMs: fullReads * 45000,
            }),
          );
        }
        assert.ok("plan" in planned);
        assert.equal(
          planned.prepared,
          expectedCells,
          "fresh work must reach native admission before unrelated deterministic work consumes the session window",
        );
        assert.equal(modelCalls, 0);
        if (expensiveReads) {
          assert.ok(
            fullReads < 50,
            "ineligible ranked rows must not each cause another full authoritative snapshot",
          );
        }
        if (freshDrift) {
          assert.equal(
            memory.repair!.work.find((row) => row.id === second.id)!.nextStep,
            "blocked",
          );
        }
        assert.equal(
          backgroundReads,
          0,
          "unrelated review reconciliation belongs to the aggregate",
        );
        assert.ok(
          r.clock.now() + 1_800_000 + OPERATION_MARGIN_MS <=
            T0 + 10000 + 110 * 60_000,
        );
        assert.deepEqual(
          memory.repair!.work.filter((row) =>
            row.id.startsWith("background-review-")
          ),
          background,
        );
        assert.equal(memory.repair!.reservations.length, expectedCells + 1);
        assert.deepEqual(
          memory.repair!.reservations.find((row) => row.id === historical.id),
          historical,
        );
        assert.equal(
          memory.repair!.work.find((row) => row.related.issueNumber === 1)!
            .intent?.kind,
          "implementation",
        );
        const cell = planned.plan.cells[0]!;
        const deps = await r.job("window-cell", "matrix_cell");
        const artifactRoot = r.root + "/window-cell/.sentinel-matrix";
        await Deno.mkdir(artifactRoot);
        await Deno.writeTextFile(
          artifactRoot + "/plan.json",
          JSON.stringify(planned.plan),
        );
        const result = await runActionsMatrixHost({
          ...deps,
          state: memory,
          model,
          carrier: { planDigest: planned.planDigest, cellId: cell.cellId },
        });
        assert.ok("cellId" in result);
        assert.equal(modelCalls, 1);
        assert.equal(
          memory.repair!.reservations.length,
          expectedCells + 1,
          "cell does not add another charge",
        );
        assert.deepEqual(
          memory.repair!.work.filter((row) =>
            row.id.startsWith("background-review-")
          ),
          background,
        );
        const again = await runActionsMatrixHost({
          ...await r.job("window-repeat", "matrix_plan"),
          state: memory,
          model,
        });
        assert.ok("plan" in again);
        assert.equal(
          again.prepared,
          0,
          "a current implementation intent cannot be readmitted",
        );
        assert.equal(memory.repair!.reservations.length, expectedCells + 1);
        assert.deepEqual(
          memory.repair!.reservations.find((row) => row.id === historical.id),
          historical,
        );
        assert.equal(modelCalls, 1);
      } finally {
        await r.cleanup();
      }
    },
  );
}

for (
  const scenario of [
    "late_origin",
    "changed_source",
    "opt_out",
    "open_dependency",
    "wrong_owner",
    "cas_conflict",
  ] as const
) {
  Deno.test("matrix actions planner guard: " + scenario, async () => {
    const r = await rig();
    try {
      const memory = new MemoryState();
      const release = await r.store.readRelease();
      assert.ok(release.ok && release.value.status === "found");
      memory.setRelease(release.value.snapshot);
      r.github.get("ubiquity/ai.ubq.fi")!.listOpenIssues = () =>
        Promise.resolve(portOk([]));
      const source = r.github.get("ubiquity/sentinel")!;
      const row = source.row;
      if (scenario === "cas_conflict") {
        source.listOpenIssues = () => {
          memory.conflictRepairNext = true;
          return Promise.resolve(portOk([row]));
        };
      }
      source.readIssue = () =>
        Promise.resolve(portOk({
          ...row,
          ...(scenario === "changed_source"
            ? { body: "changed after intake" }
            : {}),
          ...(scenario === "opt_out" ? { labels: ["sentinel:skip"] } : {}),
          ...(scenario === "open_dependency"
            ? {
              relations: {
                subIssueCount: 0,
                openBlockers: [{
                  owner: "ubiquity",
                  name: "sentinel",
                  number: 2,
                }],
              },
            }
            : {}),
        }));
      if (scenario === "late_origin") r.clock.advance(76 * 60_000);
      const deps = await r.job("planner-guard", "matrix_plan");
      let modelCalls = 0;
      let rejected = false;
      try {
        const result = await runActionsMatrixHost({
          ...deps,
          state: memory,
          env: scenario === "wrong_owner"
            ? { ...deps.env, GITHUB_RUN_ID: "999" }
            : deps.env,
          model: {
            modelId: "gpt-reserve",
            runModel: () => {
              modelCalls++;
              return Promise.resolve(portError("unavailable", "fake model"));
            },
          },
        });
        assert.ok("plan" in result);
        assert.equal(result.prepared, scenario === "changed_source" ? 1 : 0);
        if (scenario === "changed_source") {
          const cell = result.plan.cells[0]!;
          assert.equal(
            cell.request.issue?.body,
            "changed after intake",
            "the grant uses the latest authoritative source",
          );
          source.readIssue = () =>
            Promise.resolve(portOk({ ...row, body: "changed after planning" }));
          const beforeCell = structuredClone(memory.repair);
          const cellDeps = await r.job("source-change-cell", "matrix_cell");
          const artifactRoot = r.root + "/source-change-cell/.sentinel-matrix";
          await Deno.mkdir(artifactRoot);
          await Deno.writeTextFile(
            artifactRoot + "/plan.json",
            JSON.stringify(result.plan),
          );
          const refused = await runActionsMatrixHost({
            ...cellDeps,
            state: memory,
            carrier: { planDigest: result.planDigest, cellId: cell.cellId },
            model: {
              modelId: "gpt-reserve",
              runModel: () => {
                modelCalls++;
                return Promise.resolve(portError("unavailable", "fake model"));
              },
            },
          });
          assert.ok("cellId" in refused);
          assert.equal(refused.status, "not_started");
          assert.deepEqual(memory.repair, beforeCell);
        }
      } catch (error) {
        if (scenario !== "wrong_owner" && scenario !== "cas_conflict") {
          throw error;
        }
        rejected = true;
        assert.match(String(error), /execution|identity|intake|state/);
      }
      assert.equal(
        rejected,
        scenario === "wrong_owner" || scenario === "cas_conflict",
      );
      assert.equal(modelCalls, 0);
      const charges = scenario === "changed_source" ? 1 : 0;
      assert.equal(memory.repair?.reservations.length ?? 0, charges);
      assert.equal(
        memory.repair?.work.filter((record) =>
          record.intent?.kind === "implementation"
        ).length ?? 0,
        charges,
      );
    } finally {
      await r.cleanup();
    }
  });
}

Deno.test("matrix actions: planner preserves native handoff time for prepared cells", async () => {
  const r = await rig();
  try {
    const rows = Array.from({ length: 3 }, (_, index) => issue(index + 1));
    const source = r.github.get("ubiquity/sentinel")!;
    source.listOpenIssues = () => Promise.resolve(portOk(rows));
    let sourceReads = 0;
    source.readIssue = async (number) => {
      await Promise.resolve();
      sourceReads++;
      r.clock.advance(number === 3 ? OPERATION_MARGIN_MS : 60_000);
      return portOk(rows[number - 1] ?? null);
    };
    r.github.get("ubiquity/ai.ubq.fi")!.listOpenIssues = () =>
      Promise.resolve(portOk([]));
    const startedAt = r.clock.now();
    r.clock.advance(68 * 60_000);
    const planned = await runActionsMatrixHost({
      ...await r.job("handoff-plan", "matrix_plan"),
      model: {
        modelId: "gpt-reserve",
        runModel: () => Promise.reject(new Error("planner cannot infer")),
      },
    });
    assert.ok("plan" in planned);
    assert.ok(planned.prepared > 0, "real intake must prepare fresh grants");
    const cell = planned.plan.cells[0]!;
    const sourceReadsAtPublication = sourceReads;
    source.readIssue = (number) =>
      Promise.resolve(portOk(rows[number - 1] ?? null));
    const deps = await r.job("handoff-cell", "matrix_cell");
    const artifactRoot = r.root + "/handoff-cell/.sentinel-matrix";
    await Deno.mkdir(artifactRoot);
    await Deno.writeTextFile(
      artifactRoot + "/plan.json",
      JSON.stringify(planned.plan),
    );
    r.clock.advance(60_000);
    let modelCalls = 0;
    const result = await runActionsMatrixHost({
      ...deps,
      model: {
        modelId: "gpt-reserve",
        runModel: () => {
          modelCalls++;
          return Promise.resolve(
            portError("unavailable", "bounded fake model outcome"),
          );
        },
      },
      carrier: { planDigest: planned.planDigest, cellId: cell.cellId },
    });
    assert.ok("cellId" in result);
    console.log(JSON.stringify({
      kind: "planner_native_handoff",
      prepared: planned.prepared,
      sourceReads: sourceReadsAtPublication,
      plannedElapsedMs: planned.plan.plannedAt - startedAt,
      status: result.status,
      modelCalls,
    }));
    assert.equal(
      modelCalls,
      1,
      "native handoff must retain a full configured session and margin",
    );
    assert.ok(
      planned.plan.plannedAt + cell.request.maxDurationMs +
          2 * OPERATION_MARGIN_MS <=
        startedAt + 110 * 60_000,
      "publication must leave the existing additional handoff reserve",
    );
    assert.ok(
      sourceReadsAtPublication < rows.length,
      "stop reading unstartable grants before the handoff reserve",
    );
    const after = await r.store.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.equal(after.value.snapshot.reservations.length, planned.prepared);
    assert.ok(
      after.value.snapshot.reservations.every((entry) =>
        entry.outcome === "reserved"
      ),
    );
  } finally {
    await r.cleanup();
  }
});

async function freshMatrixArtifacts(
  noStart17 = false,
  nativeScopedOnly = false,
  progressive: "none" | "settle" | "missing" | "single" = "none",
  historicalRuntimeIsolation = false,
) {
  const r = await rig(true, "ordinary", noStart17);
  try {
    if (noStart17) {
      for (
        const [slug, count] of [["ubiquity/sentinel", 9], [
          "ubiquity/ai.ubq.fi",
          8,
        ]] as const
      ) {
        const rows = Array.from(
          { length: count },
          (_, index) => issue(index + 1),
        );
        const port = r.github.get(slug)!;
        port.listOpenIssues = () => Promise.resolve(portOk(rows));
        port.readIssue = (number) => {
          r.clock.advance(100);
          return Promise.resolve(portOk(rows[number - 1] ?? null));
        };
      }
      const write = r.store.writeRepair.bind(r.store);
      r.store.writeRepair = async (snapshot, expected) => {
        const result = await write(snapshot, expected);
        r.clock.advance(1000);
        return result;
      };
    }
    const initialPlanTime = r.clock.now();
    const expectedCells = noStart17 ? 17 : 2;
    let modelCalls = 0, active = 0, peak = 0;
    let unblock: () => void = () => {};
    const overlap = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const planner = await runActionsMatrixHost({
      ...await r.job("plan", "matrix_plan"),
      ...(noStart17 ? { state: r.store } : {}),
      model: {
        modelId: "gpt-reserve",
        runModel: () => {
          throw Error("planner must not run a model");
        },
      },
    });
    assert.ok("plan" in planner);
    assert.equal(
      planner.prepared,
      expectedCells,
      "fresh unseeded issues must reach actual matrix admission",
    );
    assert.equal(
      new Set(planner.plan.cells.map((cell) => cell.repository.name)).size,
      2,
    );
    const results: MatrixCellResultV1[] = [];
    const archive = r.root + "/archive";
    await Deno.mkdir(archive);
    // The planner phase's artificial age (per-read and per-write clock advances
    // above) stays in the frozen plannedAt and admission timestamps. It is NOT
    // carried into the cell phase: every cell is anchored at its own trusted
    // run origin with its own fresh bounded start window.
    for (const cell of planner.plan.cells) {
      await Deno.mkdir(r.root + "/cell-" + cell.cellId);
    }
    const settledCells = await Promise.allSettled(
      planner.plan.cells.map(async (cell) => {
        const name = "cell-" + cell.cellId;
        const deps = await r.job(name, "matrix_cell");
        const artifactRoot = r.root + "/" + name + "/.sentinel-matrix";
        await Deno.mkdir(artifactRoot);
        await Deno.writeTextFile(
          artifactRoot + "/plan.json",
          JSON.stringify(planner.plan),
        );
        const model: ImplementationPort = {
          modelId: "gpt-reserve",
          runModel: async (request: ModelRunRequestV1) => {
            modelCalls++;
            active++;
            peak = Math.max(peak, active);
            if (active === 2) unblock();
            await overlap;
            const source = deps.workDir + "/.sentinel-actions-state/" +
              (request.repository.name === "sentinel"
                ? "source"
                : "sources/ubiquity-ai.ubq.fi");
            await Deno.writeTextFile(
              source + "/repair.txt",
              request.repository.name,
            );
            await checked(source, ["add", "repair.txt"], r.env);
            await checked(source, ["commit", "-q", "-m", "repair"], r.env);
            const head = await checked(
              source,
              ["rev-parse", "HEAD"],
              r.env,
            ) as GitSha;
            active--;
            const receipt: ModelRunReceiptV1 = {
              invocationId: "invocation-" + cell.cellId,
              outcome: "completed",
              actual: {
                evidenceKind: "request-runtime",
                provider: PROVIDER,
                threadId: "thread-" + cell.cellId,
                turnId: "turn-" + cell.cellId,
                terminalOrigin: "runtime",
                observedTerminalStatus: "completed",
                observedModel: request.model,
                observedReasoning: "max",
                durationMs: 1,
                outputChars: 1,
              },
              candidate: {
                head,
                checkpointSha: null,
                changedPaths: ["repair.txt"],
              },
              error: null,
            };
            return portOk(receipt);
          },
        };
        const result = await runActionsMatrixHost({
          ...deps,
          // One shared repair transport for the clock scenario: the planner,
          // every cell, the budget and the aggregate all read and write the
          // same narrowed repair state; target Git and release stay real.
          ...(noStart17 ? { state: r.store } : {}),
          model,
          carrier: { planDigest: planner.planDigest, cellId: cell.cellId },
        });
        assert.ok("cellId" in result);
        results.push(result);
        // The planner phase deliberately advanced the clock through the per-read
        // and per-write fakes, so each admission (and the frozen plannedAt) is
        // authentic. The cell phase inherits no artificial wave age: every cell
        // gets its own fresh bounded start window and completes with a real
        // receipt and bundle.
        assert.equal(result.status, "completed");
        assert.ok(result.receipt);
        assert.ok(result.bundle);
        await Deno.copyFile(
          artifactRoot + "/" + result.bundle.file,
          archive + "/" + result.bundle.file,
        );
        await Deno.remove(r.root + "/" + name, { recursive: true });
        return result;
      }),
    );
    // Every cell promise is settled before any failure is reported or cleanup
    // runs: no live artifact writer is left behind, and the first real body
    // failure is retained instead of being replaced by a cleanup race.
    const firstCellFailure = settledCells.find((entry) =>
      entry.status === "rejected"
    );
    if (
      firstCellFailure !== undefined && firstCellFailure.status === "rejected"
    ) {
      throw firstCellFailure.reason;
    }
    assert.equal(
      modelCalls,
      expectedCells,
      "every admitted cell starts exactly one isolated model",
    );
    if (noStart17) {
      assert.ok(
        peak >= 2,
        "isolated cells overlap under the advanced planner clock",
      );
    } else {
      assert.equal(peak, 2);
    }
    const before = await r.store.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    // Bind the narrowed found snapshot once: TypeScript does not retain the
    // assertion narrowing inside the poll callback below.
    const beforeHead = before.value.head;
    const beforeWork: ReturnType<typeof workRecord>[] = before.value
      .snapshot.work;
    assert.equal(
      before.value.snapshot.reservations.filter((row) =>
        row.purpose === "implementation"
      ).length,
      expectedCells,
    );
    const artifactCalls: string[] = [];
    const encode = (value: unknown) =>
      new TextEncoder().encode(JSON.stringify(value));
    const byteDigest = async function (value: Uint8Array) {
      return [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", value.slice())),
      ].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    const zip = async function (
      entries: { name: string; content: Uint8Array }[],
    ) {
      const writer = new ZipWriter(new Uint8ArrayWriter(), {
        useWebWorkers: false,
      });
      for (const entry of entries) {
        await writer.add(entry.name, new Uint8ArrayReader(entry.content), {
          unixMode: 0o100600,
        });
      }
      return await writer.close();
    };
    const archives = new Map<number, Uint8Array>();
    const artifactRows: Record<string, unknown>[] = [];
    const provenance = {
      id: 71,
      repository_id: 123,
      head_repository_id: 123,
      head_branch: "sentinel-supervisor",
      head_sha: r.sha,
    };
    const archiveRow = async function (
      id: number,
      name: string,
      bytes: Uint8Array,
    ) {
      archives.set(id, bytes);
      artifactRows.push({
        id,
        name,
        size_in_bytes: bytes.length,
        expired: false,
        digest: "sha256:" + await byteDigest(bytes),
        workflow_run: provenance,
      });
    };
    await archiveRow(
      501,
      "sentinel-matrix-plan-71-1",
      await zip([{ name: "plan.json", content: encode(planner.plan) }]),
    );
    for (const [index, result] of results.entries()) {
      await archiveRow(
        502 + index,
        "sentinel-matrix-cell-71-1-" + result.cellId,
        await zip([
          { name: "result.json", content: encode(result) },
          ...(result.bundle
            ? [{
              name: result.bundle!.file,
              content: await Deno.readFile(archive + "/" + result.bundle!.file),
            }]
            : []),
        ]),
      );
    }
    const iso = new Date(planner.plan.plannedAt).toISOString();
    const plannerMarker = {
      kind: "sentinel_matrix_plan",
      waveId: planner.plan.waveId,
      run: planner.plan.run,
      runtimeSha: r.sha,
      generation: 1,
      planDigest: planner.planDigest,
      prepared: planner.prepared,
    };
    const logs = new Map<number, string>([[
      401,
      iso + " " + JSON.stringify(plannerMarker) + "\n",
    ]]);
    const job = (id: number, name: string, step: string, at = iso) => ({
      id,
      name,
      run_id: 71,
      run_attempt: 1,
      head_sha: r.sha,
      status: "completed",
      conclusion: "success",
      started_at: at,
      completed_at: at,
      steps: [{
        name: step,
        number: 1,
        status: "completed",
        conclusion: "success",
        started_at: at,
        completed_at: at,
      }],
    });
    const jobs = [job(401, "matrix_plan", "Plan isolated issue matrix")];
    for (const [index, result] of results.entries()) {
      const at = noStart17 ? new Date(result.completedAt).toISOString() : iso;
      jobs.push(
        job(
          402 + index,
          "matrix_cell (" + result.cellId + ")",
          "Run isolated issue cell",
          at,
        ),
      );
      logs.set(
        402 + index,
        at + " " +
          JSON.stringify({
            kind: "sentinel_matrix_cell",
            run: result.run,
            runtimeSha: result.runtimeSha,
            generation: result.generation,
            cellId: result.cellId,
            reservationId: result.reservationId,
            resultDigest: await matrixDigestV1(result),
            bundleDigest: result.bundle?.digest ?? null,
            status: result.status,
          }) + "\n",
      );
    }
    // Minimal sanitized replay of ai#908's captured boundary: its admission
    // predates the manifest, native planner/cell agree on an older runtime,
    // and a later consumer must isolate that wave without importing its result.
    if (historicalRuntimeIsolation) {
      const oldRuntime = "e".repeat(40) as GitSha;
      const oldRun = { ...planner.plan.run, runId: 69 };
      const oldWave = "69:1:repair";
      const oldCell = structuredClone(
        planner.plan.cells.find((cell) =>
          cell.repository.name === "ai.ubq.fi"
        )!,
      );
      const originalCellId = oldCell.cellId;
      oldCell.cellId = await matrixCellIdV1(
        oldWave,
        oldCell.taskId,
        oldCell.reservationId,
      );
      oldCell.runtimeSha = oldRuntime;
      const oldResult = structuredClone(
        results.find((cell) => cell.cellId === originalCellId)!,
      );
      const oldBundle = await Deno.readFile(
        archive + "/" + oldResult.bundle!.file,
      );
      Object.assign(oldResult, {
        run: oldRun,
        waveId: oldWave,
        cellId: oldCell.cellId,
        runtimeSha: oldRuntime,
      });
      oldResult.bundle!.file = oldCell.cellId + ".bundle";
      const oldPlan = {
        ...planner.plan,
        run: oldRun,
        waveId: oldWave,
        cells: [oldCell],
      };
      const currentPlan = {
        ...planner.plan,
        cells: planner.plan.cells.filter((cell) =>
          cell.repository.name === "sentinel"
        ),
      };
      artifactRows.length = 0;
      archives.clear();
      await archiveRow(
        501,
        "sentinel-matrix-plan-71-1",
        await zip([{ name: "plan.json", content: encode(currentPlan) }]),
      );
      const currentResult = results.find((cell) =>
        cell.repository.name === "sentinel"
      )!;
      await archiveRow(
        502,
        "sentinel-matrix-cell-71-1-" + currentResult.cellId,
        await zip([
          { name: "result.json", content: encode(currentResult) },
          {
            name: currentResult.bundle!.file,
            content: await Deno.readFile(
              archive + "/" + currentResult.bundle!.file,
            ),
          },
        ]),
      );
      await archiveRow(
        503,
        "sentinel-matrix-plan-69-1",
        await zip([{ name: "plan.json", content: encode(oldPlan) }]),
      );
      await archiveRow(
        504,
        "sentinel-matrix-cell-69-1-" + oldCell.cellId,
        await zip([
          { name: "result.json", content: encode(oldResult) },
          { name: oldResult.bundle!.file, content: oldBundle },
        ]),
      );
      for (const row of artifactRows.filter((row) => Number(row.id) >= 503)) {
        row.workflow_run = { ...provenance, id: 69 };
      }
      // Put the rejected wave first: later valid artifacts must still advance.
      artifactRows.unshift(...artifactRows.splice(2));
      logs.set(
        401,
        iso + " " +
          JSON.stringify({
            ...plannerMarker,
            prepared: 1,
            planDigest: await matrixDigestV1(currentPlan),
          }) + "\n",
      );
      const currentJob = jobs.find((row) =>
        row.name === "matrix_cell (" + currentResult.cellId + ")"
      )!;
      const currentLog = logs.get(currentJob.id)!;
      jobs.splice(1, jobs.length - 1, currentJob);
      logs.set(currentJob.id, currentLog);
      const oldPlannerJob = {
        ...job(405, "matrix_plan", "Plan isolated issue matrix"),
        run_id: 69,
      };
      const oldCellJob = {
        ...job(
          406,
          "matrix_cell (" + oldCell.cellId + ")",
          "Run isolated issue cell",
        ),
        run_id: 69,
      };
      jobs.push(oldPlannerJob, oldCellJob);
      logs.set(
        405,
        iso + " " +
          JSON.stringify({
            ...plannerMarker,
            run: oldRun,
            waveId: oldWave,
            runtimeSha: oldRuntime,
            prepared: 1,
            planDigest: await matrixDigestV1(oldPlan),
          }) + "\n",
      );
      logs.set(
        406,
        iso + " " + JSON.stringify({
          kind: "sentinel_matrix_cell",
          run: oldRun,
          runtimeSha: oldRuntime,
          generation: 1,
          cellId: oldCell.cellId,
          reservationId: oldCell.reservationId,
          resultDigest: await matrixDigestV1(oldResult),
          bundleDigest: oldResult.bundle!.digest,
          status: oldResult.status,
        }) + "\n",
      );
    }
    const artifactHttp = function (
      available: () => boolean,
      allow: (row: Record<string, unknown>) => boolean = () => true,
    ) {
      return createActionsMatrixArtifactHttpTransport((url, init) => {
        artifactCalls.push(url);
        const parsed = new URL(url);
        const reply = (body: unknown) =>
          Promise.resolve(new Response(JSON.stringify(body)));
        if (parsed.host.endsWith("blob.core.windows.net")) {
          assert.equal(init?.headers?.authorization, undefined);
          assert.equal(init?.redirect, "error");
          return Promise.resolve(
            new Response(
              parsed.pathname.startsWith("/archive/")
                ? archives.get(Number(parsed.pathname.split("/").at(-1)))!
                  .slice()
                : logs.get(Number(parsed.pathname.split("/").at(-1)))!,
            ),
          );
        }
        assert.equal(init?.headers?.authorization, "Bearer fake-read-token");
        assert.equal(init?.redirect, "manual");
        const attempt = parsed.pathname.match(/\/runs\/(\d+)\/attempts\/1$/);
        if (attempt) {
          return reply({
            id: Number(attempt[1]),
            run_attempt: 1,
            workflow_id: HOSTED_SUPERVISOR_WORKFLOW_ID,
            path: HOSTED_SUPERVISOR_WORKFLOW_PATH,
            event: "workflow_dispatch",
            head_branch: "sentinel-supervisor",
            head_sha: r.sha,
            repository: { id: 123, full_name: "ubiquity/sentinel" },
            head_repository: { id: 123, full_name: "ubiquity/sentinel" },
            status: "in_progress",
            run_started_at: iso,
            updated_at: iso,
          });
        }
        if (parsed.pathname.endsWith("/artifacts")) {
          if (
            nativeScopedOnly &&
            parsed.pathname === "/repos/ubiquity/sentinel/actions/artifacts"
          ) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  total_count: artifactRows.length + 100,
                  artifacts: artifactRows,
                }),
                {
                  headers: {
                    link:
                      '<https://api.github.com/repositories/123/actions/artifacts?per_page=100&page=2>; rel="next"',
                  },
                },
              ),
            );
          }
          const rows = available() && !parsed.pathname.includes("/runs/72/")
            ? artifactRows.filter(allow)
            : [];
          return reply({ total_count: rows.length, artifacts: rows });
        }
        if (parsed.pathname.endsWith("/jobs")) {
          const runId = Number(parsed.pathname.match(/\/runs\/(\d+)\//)![1]);
          const selectedJobs = jobs.filter((row) => row.run_id === runId);
          return reply({
            total_count: selectedJobs.length,
            jobs: selectedJobs,
          });
        }
        const selected = parsed.pathname.match(/\/artifacts\/(\d+)\/zip$/) ??
          parsed.pathname.match(/\/jobs\/(\d+)\/logs$/);
        if (selected) {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: {
                location:
                  "https://productionresultssa1.blob.core.windows.net/" +
                  (parsed.pathname.endsWith("/zip") ? "archive/" : "log/") +
                  selected[1],
              },
            }),
          );
        }
        throw Error("unexpected native artifact API route");
      });
    };
    const originalPreservers = [...r.github.values()].map((port) =>
      port.preserveCandidate.bind(port)
    );
    for (const port of r.github.values()) {
      port.preserveCandidate = () =>
        Promise.resolve(
          portError("unavailable", "injected preservation outage"),
        );
    }
    let isolationWriteFailure: "conflict" | "ambiguous" | null = null;
    const aggregate = async function (
      name: string,
      available: boolean | (() => boolean),
      carrier?: { planDigest: string },
      options: MatrixAggregateOptionsV1 = { maxWaitMs: 0 },
      allow: (row: Record<string, unknown>) => boolean = () => true,
    ) {
      const deps = await r.job(name, "repair");
      if (name === "later-run") {
        deps.composeGithub = (config) => {
          const port = r.github.get(
            config.repository.owner + "/" + config.repository.name,
          )!;
          const source = deps.workDir + "/.sentinel-actions-state/" +
            (config.repository.name === "sentinel"
              ? "source"
              : "sources/ubiquity-ai.ubq.fi");
          const original =
            originalPreservers[config.repository.name === "sentinel" ? 0 : 1]!;
          port.preserveCandidate = async (request) => {
            assert.equal(
              (await gitRun(source, [
                "cat-file",
                "-e",
                request.candidate.head + "^{commit}",
              ], r.env)).ok,
              true,
              "real authenticated old-wave transport must hydrate before publication",
            );
            return original(request);
          };
          return port;
        };
      }
      const oldCwd = Deno.cwd();
      let result: { status: string } | null = null;
      Deno.chdir(deps.workDir);
      try {
        result = await runActionsRepairHost({
          ...deps,
          ...(noStart17 ? { state: r.store } : {}),
          artifactHttp: artifactHttp(
            typeof available === "function" ? available : () => available,
            allow,
          ),
          model: {
            modelId: "gpt-reserve",
            runModel: () => {
              throw Error("aggregate must not implement");
            },
          },
          runTargetCycles: (input) =>
            runActionsMatrixAggregateCycles(
              {
                ...input,
                modelStartsEnabled: false,
                ...(isolationWriteFailure === null ? {} : {
                  state: {
                    ...input.state,
                    readRepair: () => input.state.readRepair(),
                    readRelease: () => input.state.readRelease(),
                    writeRepair: () =>
                      Promise.resolve(
                        portOk({
                          status: isolationWriteFailure!,
                          currentHead: beforeHead,
                        }),
                      ),
                  },
                }),
              },
              undefined,
              carrier,
              options,
            ),
        });
      } finally {
        Deno.chdir(oldCwd);
      }
      return result;
    };
    if (historicalRuntimeIsolation) {
      const custody = structuredClone(before.value.snapshot);
      const oldWork = custody.work.find((row) =>
        row.repository.name === "ai.ubq.fi"
      )!;
      const oldCharge = custody.reservations.find((row) =>
        row.id === oldWork.intent!.requestId
      )!;
      assert.ok(oldCharge.createdAt <= planner.plan.plannedAt);
      const originalArchives = [...archives].map((
        [id, value],
      ) => [id, value.slice()]);
      [...r.github.values()].forEach((port, index) => {
        port.preserveCandidate = originalPreservers[index]!;
      });
      for (const failure of ["conflict", "ambiguous"] as const) {
        isolationWriteFailure = failure;
        await assert.rejects(
          aggregate("isolation-" + failure, true),
          /isolation CAS incomplete/,
        );
        assert.deepEqual(
          await r.store.readRepair(),
          before,
          "CAS failure cannot change either wave's custody or publish a sibling",
        );
      }
      isolationWriteFailure = null;
      const oldArtifact = artifactRows.find((row) => row.id === 504)!;
      const provenance = oldArtifact.workflow_run;
      oldArtifact.workflow_run = { id: 999 };
      await assert.rejects(
        aggregate("isolation-forged-native", true),
        /provenance unavailable or conflicting/,
      );
      assert.deepEqual(await r.store.readRepair(), before);
      oldArtifact.workflow_run = provenance;
      // The parser permits a blocked historical row to retain a stale request
      // ID. It is not the admitted work and its blocker must stay untouched.
      const unrelated = markBlocked(
        {
          ...structuredClone(oldWork),
          id: "unrelated-foreign-blocked" as WorkItemId,
          source: { ...oldWork.source, id: "999" },
          related: { ...oldWork.related, issueNumber: 999 },
        },
        "other",
        "merge_not_observed",
        r.clock.now(),
      );
      const seeded = await r.store.writeRepair(
        parseRepairStateSnapshotV1({
          ...before.value.snapshot,
          stateHead: beforeHead,
          sequence: before.value.snapshot.sequence + 1,
          work: [...before.value.snapshot.work, unrelated],
        }),
        beforeHead,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      await aggregate("historical-runtime-isolation", true);
      const after = await r.store.readRepair();
      assert.ok(after.ok && after.value.status === "found");
      const isolated = after.value.snapshot.work.find((row) =>
        row.id === oldWork.id
      )!;
      assert.deepEqual(
        after.value.snapshot.work.find((row) => row.id === unrelated.id),
        unrelated,
        "an unrelated blocked row sharing the stale request ID is byte-identical",
      );
      assert.equal(isolated.nextStep, "blocked");
      assert.match(isolated.blocker!.message, /historical.*runtime mismatch/);
      assert.deepEqual(isolated.intent, oldWork.intent);
      assert.deepEqual(isolated.target, oldWork.target);
      assert.deepEqual(isolated.evidence, oldWork.evidence);
      assert.deepEqual(isolated.counters, oldWork.counters);
      assert.deepEqual(
        after.value.snapshot.reservations.find((row) =>
          row.id === oldCharge.id
        ),
        oldCharge,
      );
      const sibling = after.value.snapshot.work.find((row) =>
        row.repository.name === "sentinel"
      )!;
      assert.ok(
        sibling.target.head !== null && sibling.target.pr !== null,
        "unrelated authenticated wave publishes through the real aggregate lifecycle",
      );
      assert.ok(
        r.github.get("ubiquity/sentinel")!.calls.some((call) =>
          call.startsWith("push:")
        ),
      );
      assert.ok(
        !r.github.get("ubiquity/ai.ubq.fi")!.calls.some((call) =>
          call.startsWith("push:")
        ),
        "rejected result must never be imported or published",
      );
      assert.deepEqual(
        [...archives],
        originalArchives,
        "original forensic archives remain unchanged",
      );
      assert.equal(modelCalls, 2, "isolation adds no model start or refund");
      return;
    }
    if (progressive !== "none") {
      const fast = results[0]!;
      const slow = results[1]!;
      const fastName = "sentinel-matrix-cell-71-1-" + fast.cellId;
      const slowName = "sentinel-matrix-cell-71-1-" + slow.cellId;
      const observed: { fast: boolean; slow: boolean }[] = [];
      const waits: number[] = [];
      let listings = 0;
      // Availability advances on each authenticated artifact listing: the fast
      // sibling appears only after the first empty scan, the slow sibling only
      // after the consumer has already consumed the fast one. The single-scan
      // mode exposes the fast cell immediately and never the slow one.
      const available = () => {
        listings += 1;
        return true;
      };
      const allow = (row: Record<string, unknown>) => {
        const name = String(row["name"]);
        if (name === fastName) {
          return progressive === "single" ||
            (progressive === "settle" && listings >= 2);
        }
        if (name === slowName) return progressive === "settle" && listings >= 4;
        return true;
      };
      const options: MatrixAggregateOptionsV1 = progressive === "single"
        ? {
          maxWaitMs: 0,
          pollWait: (ms) => {
            waits.push(ms);
            r.clock.advance(ms);
            return Promise.resolve();
          },
        }
        : {
          maxWaitMs: 180_000,
          pollWait: async (ms) => {
            waits.push(ms);
            r.clock.advance(ms);
            const mid = await r.store.readRepair();
            assert.ok(mid.ok && mid.value.status === "found");
            if (!mid.ok || mid.value.status !== "found") {
              throw new Error("repair state unreadable");
            }
            const state = mid.value.snapshot;
            const intentOf = (taskId: string) =>
              state.work.find((row) => row.id === taskId)?.intent?.kind ?? null;
            const reservationOf = (taskId: string) =>
              state.reservations.find((row) => row.taskId === taskId);
            // Ingestion itself preserves the charge/attempt/retry/review
            // accounting and adds no stalled execution: this snapshot is read
            // before the ordinary lifecycle runs.
            for (const record of state.work) {
              const prior = beforeWork.find((row) => row.id === record.id);
              assert.ok(prior);
              assert.equal(record.counters.attempts, prior.counters.attempts);
              assert.equal(record.counters.retries, prior.counters.retries);
              assert.equal(
                record.counters.reviewRounds,
                prior.counters.reviewRounds,
              );
              assert.equal(record.counters.stalled ?? 0, 0);
            }
            observed.push({
              fast: intentOf(fast.taskId) === "candidate_preservation",
              slow: intentOf(slow.taskId) === "candidate_preservation",
            });
            if (progressive === "missing") {
              // A live producer whose artifact has not arrived keeps its exact
              // implementation intent, charged reservation and no blocker.
              assert.equal(intentOf(fast.taskId), "implementation");
              assert.equal(intentOf(slow.taskId), "implementation");
              assert.equal(reservationOf(fast.taskId)?.outcome, "reserved");
              assert.equal(reservationOf(slow.taskId)?.outcome, "reserved");
              for (const record of state.work) {
                assert.equal(record.nextStep, "work");
                assert.equal(record.blocker, null);
                assert.equal(record.wait, null);
              }
            }
          },
        };
      const result = await aggregate(
        "progressive",
        available,
        { planDigest: planner.planDigest },
        options,
        allow,
      );
      assert.equal(result?.status, "ran");
      if (progressive === "single") {
        // The documented maxWaitMs 0 contract is exactly one authenticated
        // recovery, even though that recovery consumed the fast cell.
        assert.deepEqual(waits, [], "maxWaitMs 0 never waits");
        assert.equal(
          listings,
          1,
          "maxWaitMs 0 performs exactly one authenticated recovery",
        );
      } else {
        assert.deepEqual(waits, [60_000, 60_000]);
      }
      const final = await r.store.readRepair();
      assert.ok(final.ok && final.value.status === "found");
      if (!final.ok || final.value.status !== "found") {
        throw new Error("repair state unreadable");
      }
      // Bind the narrowed found snapshot once: the stalled lookup below runs
      // inside a closure where the assertion narrowing is not retained.
      const finalWork: ReturnType<typeof workRecord>[] = final.value
        .snapshot.work;
      assert.equal(modelCalls, 2, "consumption never starts a model");
      assert.deepEqual(
        final.value.snapshot.reservations.map((row) => [
          row.id,
          row.attempt,
          row.purpose,
        ]),
        before.value.snapshot.reservations.map((row) => [
          row.id,
          row.attempt,
          row.purpose,
        ]),
        "no refund, duplicate reservation or extra admission",
      );
      // Ingestion never changes the charge/attempt/retry/review accounting.
      assert.deepEqual(
        final.value.snapshot.work.map((row) => ({
          attempts: row.counters.attempts,
          retries: row.counters.retries,
          reviewRounds: row.counters.reviewRounds,
        })),
        before.value.snapshot.work.map((row) => ({
          attempts: row.counters.attempts,
          retries: row.counters.retries,
          reviewRounds: row.counters.reviewRounds,
        })),
        "ingestion preserves attempt/retry/review accounting",
      );
      // The ordinary lifecycle that follows is deterministic
      // unavailable-publication bookkeeping: each ingested candidate whose
      // preservation read is unavailable re-arms its wait and is counted as
      // exactly one stalled execution, while a still-unconsumed live producer
      // is deferred without any persistence at all.
      const stalledOf = (taskId: string) =>
        finalWork.find((row) => row.id === taskId)?.counters.stalled ?? 0;
      if (progressive === "settle") {
        assert.equal(
          stalledOf(fast.taskId),
          1,
          "each ingested candidate re-armed one unavailable wait",
        );
        assert.equal(stalledOf(slow.taskId), 1);
      } else if (progressive === "single") {
        assert.equal(
          stalledOf(fast.taskId),
          1,
          "the ingested candidate was stalled exactly once",
        );
        assert.equal(
          stalledOf(slow.taskId),
          0,
          "the unconsumed live producer was never persisted",
        );
      } else {
        assert.equal(stalledOf(fast.taskId), 0);
        assert.equal(stalledOf(slow.taskId), 0);
      }
      if (progressive === "settle") {
        // The first scan was empty and never completion; the fast cell was then
        // consumed while its slower sibling was still a live charged producer.
        assert.deepEqual(observed, [
          { fast: false, slow: false },
          { fast: true, slow: false },
        ]);
        for (const cell of [fast, slow]) {
          const record: ReturnType<typeof workRecord> | undefined = final.value
            .snapshot.work.find((row) => row.id === cell.taskId);
          assert.ok(record);
          assert.equal(record.intent?.kind, "candidate_preservation");
          assert.equal(record.blocker, null);
          assert.equal(record.nextStep, "work");
          assert.equal(
            record.target.head,
            cell.receipt?.candidate?.head ?? null,
            "the exact authenticated candidate head is preserved",
          );
        }
        assert.ok(
          final.value.snapshot.reservations.every((row) =>
            row.outcome === "submitted" && row.settledAt !== null
          ),
          "each cell is settled exactly once by real ingestion",
        );
      } else if (progressive === "single") {
        // One recovery consumed the fast cell; the slower live producer keeps
        // its exact charge and intent because the window had already closed.
        const fastRecord: ReturnType<typeof workRecord> | undefined = final
          .value.snapshot.work.find((row) => row.id === fast.taskId);
        assert.ok(fastRecord);
        assert.equal(fastRecord.intent?.kind, "candidate_preservation");
        assert.equal(
          fastRecord.target.head,
          fast.receipt?.candidate?.head ?? null,
          "the exact authenticated candidate head is preserved",
        );
        const slowRecord: ReturnType<typeof workRecord> | undefined = final
          .value.snapshot.work.find((row) => row.id === slow.taskId);
        assert.ok(slowRecord);
        assert.equal(slowRecord.intent?.kind, "implementation");
        assert.equal(slowRecord.nextStep, "work");
        assert.equal(slowRecord.blocker, null);
        assert.equal(
          final.value.snapshot.reservations.find((row) =>
            row.taskId === slow.taskId
          )?.outcome,
          "reserved",
          "the slower live producer stays charged and unresolved",
        );
      } else {
        assert.ok(observed.every((entry) => !entry.fast && !entry.slow));
        assert.deepEqual(
          final.value.snapshot.reservations,
          before.value.snapshot.reservations,
          "a live producer without an artifact stays charged and unresolved",
        );
        for (const record of final.value.snapshot.work) {
          assert.equal(record.intent?.kind, "implementation");
          assert.equal(record.nextStep, "work");
          assert.equal(record.blocker, null);
        }
      }
      return;
    }
    const digestControl = await r.store.readRepair();
    assert.ok(digestControl.ok && digestControl.value.status === "found");
    if (nativeScopedOnly) {
      await aggregate("native-scoped", true, {
        planDigest: planner.planDigest,
      });
      assert.ok(
        artifactCalls.some((url) =>
          new URL(url).pathname ===
            "/repos/ubiquity/sentinel/actions/runs/71/artifacts"
        ),
      );
      assert.ok(
        !artifactCalls.some((url) =>
          new URL(url).pathname === "/repos/ubiquity/sentinel/actions/artifacts"
        ),
      );
      const imported = await r.store.readRepair();
      assert.ok(imported.ok && imported.value.status === "found");
      assert.equal(
        imported.value.snapshot.work.filter((row) =>
          row.target.head !== null &&
          row.intent?.kind === "candidate_preservation"
        ).length,
        2,
      );
      assert.equal(
        modelCalls,
        2,
        "only isolated fake model cells ran; aggregate never starts inference",
      );
      return;
    }
    if (noStart17) {
      const setPlan = async (plan: typeof planner.plan) => {
        const bytes = await zip([{ name: "plan.json", content: encode(plan) }]);
        archives.set(501, bytes);
        artifactRows[0].size_in_bytes = bytes.length;
        artifactRows[0].digest = "sha256:" + await byteDigest(bytes);
        logs.set(
          401,
          iso + " " +
            JSON.stringify({
              ...plannerMarker,
              planDigest: await matrixDigestV1(plan),
            }) + "\n",
        );
      };
      for (
        const [name, plannedAt] of [
          ["early-historical-plan", initialPlanTime],
          [
            "reservation-after-plan",
            Math.max(
              ...before.value.snapshot.reservations.map((row) => row.createdAt),
            ) - 1,
          ],
          ["future-plan", r.clock.now() + 2000],
        ] as const
      ) {
        await setPlan({ ...planner.plan, plannedAt });
        await assert.rejects(
          aggregate(name, true),
          /matrix artifact provenance/,
        );
        assert.deepEqual(
          await r.store.readRepair(),
          digestControl,
          "chronology refusal preserves every charge and intent",
        );
      }
      await setPlan(planner.plan);
      await assert.rejects(
        aggregate("no-start-digest-conflict", true, {
          planDigest: "f".repeat(64),
        }),
        /differs from native planner output/,
      );
      assert.deepEqual(await r.store.readRepair(), digestControl);
      await aggregate("aggregate", true, { planDigest: planner.planDigest });
      const ingested = await r.store.readRepair();
      assert.ok(ingested.ok && ingested.value.status === "found");
      assert.equal(ingested.value.snapshot.work.length, 17);
      assert.ok(
        ingested.value.snapshot.work.every((row) =>
          row.nextStep === "work" &&
          row.intent?.kind === "candidate_preservation" &&
          row.target.head !== null && row.target.pr === null
        ),
        "every completed cell is ingested as authenticated candidate preservation while the injected preservation outage holds",
      );
      assert.equal(ingested.value.snapshot.reservations.length, 17);
      assert.ok(
        ingested.value.snapshot.reservations.every((row) =>
          row.outcome === "submitted" && row.settledAt !== null
        ),
        "each authenticated cell settles its exact implementation charge once",
      );
      assert.equal(
        new Set(ingested.value.snapshot.reservations.map((row) => row.id)).size,
        17,
        "every durable admission keeps a unique reservation identity",
      );
      assert.equal(
        new Set(ingested.value.snapshot.work.map((row) => row.intent?.key))
          .size,
        17,
        "every durable admission keeps a unique implementation intent",
      );
      // Identity, source and evidence survive admission, execution and ingestion
      // (intent and target legitimately advance to the authenticated candidate
      // head while publication stays unavailable). Accounting is the exact
      // projection proven by the progressive fixture: attempts/retries/
      // reviewRounds unchanged and exactly one stalled execution per ingested
      // candidate from the deterministic unavailable-publication bookkeeping.
      assert.deepEqual(
        ingested.value.snapshot.work.map((row) => ({
          attempts: row.counters.attempts,
          retries: row.counters.retries,
          reviewRounds: row.counters.reviewRounds,
        })),
        before.value.snapshot.work.map((row) => ({
          attempts: row.counters.attempts,
          retries: row.counters.retries,
          reviewRounds: row.counters.reviewRounds,
        })),
        "ingestion preserves attempt/retry/review accounting",
      );
      for (const record of before.value.snapshot.work) {
        const settledRecord: ReturnType<typeof workRecord> = ingested.value
          .snapshot.work.find((row) => row.id === record.id)!;
        assert.deepEqual(settledRecord.source, record.source);
        assert.deepEqual(settledRecord.evidence, record.evidence);
        assert.equal(
          settledRecord.counters.stalled ?? 0,
          1,
          "each ingested candidate re-armed exactly one unavailable wait",
        );
      }
      assert.ok(
        before.value.snapshot.reservations.every((row) =>
          row.createdAt <= planner.plan.plannedAt
        ),
        "plannedAt freezes after every durable admission",
      );
      assert.equal(
        await matrixDigestV1(
          JSON.parse(
            await Deno.readTextFile(
              r.root + "/plan/.sentinel-matrix/plan.json",
            ),
          ),
        ),
        planner.planDigest,
      );
      await aggregate("idempotent", true);
      assert.deepEqual(await r.store.readRepair(), ingested);
      assert.equal(modelCalls, expectedCells);
      return;
    }
    await assert.rejects(
      aggregate("native-digest-conflict", true, { planDigest: "f".repeat(64) }),
      /differs from native planner output/,
    );
    const afterDigestControl = await r.store.readRepair();
    assert.ok(
      afterDigestControl.ok && afterDigestControl.value.status === "found",
    );
    assert.equal(
      afterDigestControl.value.snapshot.sequence,
      digestControl.value.snapshot.sequence,
    );
    await aggregate("aggregate", true, { planDigest: planner.planDigest });
    const ingested = await r.store.readRepair();
    assert.ok(ingested.ok && ingested.value.status === "found");
    assert.ok(
      ingested.value.snapshot.work.every((row) =>
        row.intent?.kind === "candidate_preservation" &&
        row.target.head !== null && row.target.pr === null
      ),
    );
    const settledCharges = ingested.value.snapshot.reservations.filter((row) =>
      row.purpose === "implementation"
    );
    assert.ok(settledCharges.every((row) => row.outcome === "submitted"));
    await Deno.remove(r.root + "/aggregate", { recursive: true });
    r.clock.advance(300001);
    for (const port of r.github.values()) {
      port.preserveCandidate = () =>
        Promise.resolve(
          portError("not_found", "exact Git candidate object is absent"),
        );
    }
    await aggregate("missing-artifact", false, undefined, { maxWaitMs: 0 });
    const missing = await r.store.readRepair();
    assert.ok(missing.ok && missing.value.status === "found");
    assert.deepEqual(
      missing.value.snapshot.work.map((row) => row.target),
      ingested.value.snapshot.work.map((row) => row.target),
    );
    assert.ok(
      missing.value.snapshot.work.every((row) =>
        row.intent?.kind === "candidate_preservation"
      ),
    );
    assert.deepEqual(
      missing.value.snapshot.reservations,
      ingested.value.snapshot.reservations,
      "missing artifacts never refund, resettle or reserve another start",
    );
    await Deno.remove(r.root + "/missing-artifact", { recursive: true });
    r.clock.advance(300001);
    await r.advanceRun(72);
    [...r.github.values()].forEach((port, index) => {
      port.preserveCandidate = originalPreservers[index]!;
    });
    await aggregate("later-run", true, undefined, { maxWaitMs: 0 });
    assert.equal(
      modelCalls,
      2,
      "later-wave hydration never starts another implementation",
    );
    assert.ok(
      artifactCalls.some((url) =>
        new URL(url).pathname === "/repos/ubiquity/sentinel/actions/artifacts"
      ),
      "actual consumer must enumerate authenticated prior waves",
    );
    assert.ok(artifactCalls.some((url) => url.includes("/runs/71/attempts/1")));
    const after = await r.store.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.ok(
      after.value.snapshot.work.every((row) =>
        row.target.head !== null && row.target.pr !== null
      ),
    );
    assert.equal(
      after.value.snapshot.reservations.filter((row) =>
        row.purpose === "implementation"
      ).length,
      2,
    );
    assert.ok(
      [...r.github.values()].every((port) =>
        port.calls.some((call) => call.startsWith("push:"))
      ),
    );
    assert.equal(await matrixDigestV1(planner.plan), planner.planDigest);
  } finally {
    await r.cleanup();
  }
}
Deno.test("matrix actions: actual fresh intake plans both targets, isolated cells overlap, archive recovery publishes on a fresh aggregate", () =>
  freshMatrixArtifacts());
Deno.test("matrix actions: native carrier scopes real in-progress artifact recovery before import", () =>
  freshMatrixArtifacts(false, true));
Deno.test("matrix actions: advancing planner clock admits seventeen cells that each complete in their own bounded window", () =>
  freshMatrixArtifacts(true));
Deno.test("matrix actions: progressive consumer ingests a fast cell while a slower sibling is still active", () =>
  freshMatrixArtifacts(false, false, "settle"));
Deno.test("matrix actions: a live producer without an artifact stays charged, never failed or unhealthy", () =>
  freshMatrixArtifacts(false, false, "missing"));
Deno.test("matrix actions: the maxWaitMs-zero single scan consumer performs exactly one authenticated recovery", () =>
  freshMatrixArtifacts(false, false, "single"));
for (
  const scenario of [
    {
      name: "source read reaches model cutoff",
      boundary: "source",
      elapsed: REPAIR_MODEL_CUTOFF_MS,
      starts: 0,
    },
    {
      name: "intent read leaves insufficient full session margin",
      boundary: "state",
      elapsed: 110 * 60_000 - 1_800_000 - OPERATION_MARGIN_MS + 1,
      starts: 0,
    },
    {
      name: "source read reaches absolute deadline",
      boundary: "source",
      elapsed: 110 * 60_000,
      starts: 0,
    },
    {
      name: "intent read leaves exactly full session margin",
      boundary: "state",
      elapsed: 110 * 60_000 - 1_800_000 - OPERATION_MARGIN_MS,
      starts: 1,
    },
    {
      name: "source read stays just inside session margin",
      boundary: "source",
      elapsed: 110 * 60_000 - 1_800_000 - OPERATION_MARGIN_MS - 1,
      starts: 1,
    },
  ]
) {
  Deno.test("matrix actions deadline: " + scenario.name, async () => {
    const r = await rig();
    try {
      const planned = await runActionsMatrixHost({
        ...await r.job("deadline-plan", "matrix_plan"),
        model: {
          modelId: "gpt-reserve",
          runModel: () => Promise.reject(new Error("planner cannot infer")),
        },
      });
      assert.ok("plan" in planned);
      const cell = planned.plan.cells.find((entry) =>
        entry.repository.name === "sentinel"
      )!;
      assert.ok(cell);
      const before = await r.store.readRepair();
      assert.ok(before.ok && before.value.status === "found");
      const deps = await r.job("deadline-cell", "matrix_cell");
      const artifactRoot = r.root + "/deadline-cell/.sentinel-matrix";
      await Deno.mkdir(artifactRoot);
      await Deno.writeTextFile(
        artifactRoot + "/plan.json",
        JSON.stringify(planned.plan),
      );
      const github = r.github.get("ubiquity/sentinel")!;
      const readIssue = github.readIssue.bind(github);
      let armed = false, advanced = false, modelCalls = 0;
      const advance = () => {
        if (advanced) return;
        r.clock.advance(T0 + 10000 + scenario.elapsed - r.clock.now());
        advanced = true;
      };
      github.readIssue = async (number) => {
        const result = await readIssue(number);
        armed = true;
        if (scenario.boundary === "source") advance();
        return result;
      };
      const result = await runActionsMatrixHost({
        ...deps,
        state: {
          readRelease: () => r.store.readRelease(),
          writeRepair: (snapshot, expected) =>
            r.store.writeRepair(snapshot, expected),
          readRepair: async () => {
            const read = await r.store.readRepair();
            if (armed && scenario.boundary === "state") advance();
            return read;
          },
        },
        model: {
          modelId: "gpt-reserve",
          runModel: () => {
            modelCalls++;
            return Promise.resolve(
              portError("unavailable", "bounded fake model outcome"),
            );
          },
        },
        carrier: { planDigest: planned.planDigest, cellId: cell.cellId },
      });
      assert.ok("cellId" in result);
      assert.ok(
        advanced,
        "the real cell awaited the advancing source/state boundary",
      );
      assert.equal(
        modelCalls,
        scenario.starts,
        "late cells must start zero model sessions",
      );
      assert.equal(
        result.status,
        scenario.starts === 0 ? "not_started" : "failed",
      );
      assert.equal(result.receipt, null);
      assert.equal(result.bundle, null);
      if (scenario.starts === 0) {
        assert.equal(result.completedAt, r.clock.now());
        assert.match(result.detail!, /cutoff|run bounds/);
      }
      assert.deepEqual(
        JSON.parse(await Deno.readTextFile(artifactRoot + "/result.json")),
        result,
      );
      assert.deepEqual(
        await r.store.readRepair(),
        before,
        "cell refusal preserves reservation, history and intent",
      );
    } finally {
      await r.cleanup();
    }
  });
}

Deno.test("matrix timing: queued cells keep their own bounded start window", async (t) => {
  const setup = async (name: string) => {
    const r = await rig();
    const planned = await runActionsMatrixHost({
      ...await r.job(name + "-plan", "matrix_plan"),
      model: {
        modelId: "gpt-reserve",
        runModel: () => Promise.reject(new Error("planner cannot infer")),
      },
    });
    assert.ok("plan" in planned);
    const cell = planned.plan.cells.find((entry) =>
      entry.repository.name === "sentinel"
    )!;
    assert.ok(cell);
    const before = await r.store.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    // Bind the narrowed found snapshot once: TypeScript does not retain the
    // assertion narrowing inside the step closures below.
    const beforeSnapshot: RepairStateSnapshotV1 = before.value.snapshot;
    const deps = await r.job(name + "-cell", "matrix_cell");
    const artifactRoot = r.root + "/" + name + "-cell/.sentinel-matrix";
    await Deno.mkdir(artifactRoot);
    await Deno.writeTextFile(
      artifactRoot + "/plan.json",
      JSON.stringify(planned.plan),
    );
    const state = {
      readRelease: () => r.store.readRelease(),
      writeRepair: (
        snapshot: Parameters<typeof r.store.writeRepair>[0],
        expected: Parameters<typeof r.store.writeRepair>[1],
      ) => r.store.writeRepair(snapshot, expected),
      readRepair: () => r.store.readRepair(),
    };
    return {
      r,
      planned,
      cell,
      before,
      beforeSnapshot,
      deps,
      artifactRoot,
      state,
    };
  };
  const completedReceipt = (model: string): ModelRunReceiptV1 => ({
    invocationId: "timing-invocation",
    outcome: "completed" as const,
    actual: {
      evidenceKind: "request-runtime" as const,
      provider: PROVIDER,
      threadId: "timing-thread",
      turnId: "timing-turn",
      terminalOrigin: "runtime" as const,
      observedTerminalStatus: "completed" as const,
      observedModel: model,
      observedReasoning: "max" as const,
      durationMs: 1,
      outputChars: 1,
    },
    candidate: { head: null, checkpointSha: null, changedPaths: [] },
    error: null,
  });

  await t.step(
    "long planning or queued runner delay starts exactly one model and one charge",
    async () => {
      const { r, planned, cell, beforeSnapshot, deps, state } = await setup(
        "timing-queued",
      );
      try {
        // The execution row predates the planner; this cell's own runner starts
        // 100 minutes later. It must still own its full bounded window from its
        // own trusted invocation origin.
        r.clock.advance(100 * 60_000);
        let modelCalls = 0;
        const result = await runActionsMatrixHost({
          ...deps,
          state,
          model: {
            modelId: "gpt-reserve",
            runModel: (request) => {
              modelCalls++;
              return Promise.resolve(portOk(completedReceipt(request.model)));
            },
          },
          carrier: { planDigest: planned.planDigest, cellId: cell.cellId },
        });
        assert.ok("cellId" in result);
        assert.equal(modelCalls, 1, "the queued cell starts exactly one model");
        assert.equal(result.status, "completed");
        assert.ok(result.receipt !== null);
        assert.equal(result.bundle, null);
        const after = await r.store.readRepair();
        assert.ok(after.ok && after.value.status === "found");
        assert.deepEqual(
          after.value.snapshot.reservations.map((row) => [
            row.id,
            row.attempt,
            row.purpose,
          ]),
          beforeSnapshot.reservations.map((row) => [
            row.id,
            row.attempt,
            row.purpose,
          ]),
          "one start keeps exactly one reservation and charge",
        );
        assert.deepEqual(
          after.value.snapshot.work.map((row) => row.intent),
          beforeSnapshot.work.map((row) => row.intent),
          "the cell start keeps the exact admitted intent",
        );
      } finally {
        await r.cleanup();
      }
    },
  );

  await t.step(
    "own actual execution exhaustion still refuses with zero model starts",
    async () => {
      const { r, planned, cell, before, deps, state } = await setup(
        "timing-exhausted",
      );
      try {
        const github = r.github.get("ubiquity/sentinel")!;
        const readIssue = github.readIssue.bind(github);
        const origin = r.clock.now();
        let armed = false;
        github.readIssue = async (number) => {
          const read = await readIssue(number);
          if (!armed) {
            armed = true;
            // The cell's OWN absolute deadline lands here, after its trusted
            // invocation origin, so its remaining window cannot fit a session.
            r.clock.advance(origin + 110 * 60_000 - r.clock.now());
          }
          return read;
        };
        let modelCalls = 0;
        const result = await runActionsMatrixHost({
          ...deps,
          state,
          model: {
            modelId: "gpt-reserve",
            runModel: () => {
              modelCalls++;
              return Promise.resolve(portOk(completedReceipt("gpt-reserve")));
            },
          },
          carrier: { planDigest: planned.planDigest, cellId: cell.cellId },
        });
        assert.ok("cellId" in result);
        assert.equal(
          modelCalls,
          0,
          "an exhausted own window never starts a model",
        );
        assert.equal(result.status, "not_started");
        assert.equal(result.receipt, null);
        assert.equal(result.bundle, null);
        assert.match(result.detail!, /cutoff|run bounds/);
        assert.deepEqual(
          await r.store.readRepair(),
          before,
          "the refusal preserves reservation, intent and charge",
        );
      } finally {
        await r.cleanup();
      }
    },
  );

  await t.step(
    "wrong generation or stale runtime binding refuses before any model",
    async () => {
      const { r, planned, cell, before, deps, artifactRoot, state } =
        await setup(
          "timing-stale",
        );
      try {
        let modelCalls = 0;
        const model = {
          modelId: "gpt-reserve",
          runModel: () => {
            modelCalls++;
            return Promise.resolve(portOk(completedReceipt("gpt-reserve")));
          },
        };
        const rewritten = (change: Record<string, unknown>) =>
          JSON.stringify({
            ...planned.plan,
            cells: planned.plan.cells.map((entry) =>
              entry.cellId === cell.cellId ? { ...entry, ...change } : entry
            ),
          });
        await Deno.writeTextFile(
          artifactRoot + "/plan.json",
          rewritten({ generation: cell.generation + 1 }),
        );
        await assert.rejects(
          runActionsMatrixHost({
            ...deps,
            state,
            model,
            carrier: { planDigest: planned.planDigest, cellId: cell.cellId },
          }),
          /matrix plan does not match the trusted native digest/,
        );
        await Deno.writeTextFile(
          artifactRoot + "/plan.json",
          rewritten({ runtimeSha: "f".repeat(40) }),
        );
        await assert.rejects(
          runActionsMatrixHost({
            ...deps,
            state,
            model,
            carrier: { planDigest: planned.planDigest, cellId: cell.cellId },
          }),
          /matrix plan does not match the trusted native digest/,
        );
        assert.equal(modelCalls, 0, "a stale cell never starts a model");
        assert.deepEqual(
          await r.store.readRepair(),
          before,
          "a stale cell preserves reservation, intent and charge",
        );
      } finally {
        await r.cleanup();
      }
    },
  );
});

Deno.test("historical not started: only the exact authenticated window and null-receipt result prove non-start", () => {
  const wave = {
    reason: "reservation_after_manifest" as const,
    plannerStartedAt: new Date(T0).toISOString(),
    plannerCompletedAt: new Date(T0 + 3_600_000).toISOString(),
  };
  const admission = { id: "r-historical", createdAt: T0 + 1_000 };
  const cell = {
    cellId: "cell-historical",
    taskId: "issue-ubiquity-sentinel-1" as WorkItemId,
    reservationId: "r-historical",
    status: "not_started" as const,
    receiptNull: true,
    bundleNull: true,
    completedAt: T0 + 2_000,
    resultDigest: "a".repeat(64),
  };
  assert.equal(
    historicalNotStartedProven(wave, cell, admission),
    true,
    "the exact authenticated not-started admission is proven",
  );
  assert.equal(
    historicalNotStartedProven(
      wave,
      { ...cell, status: "completed" },
      admission,
    ),
    false,
    "a completed payload is never a not-started recovery",
  );
  assert.equal(
    historicalNotStartedProven(
      wave,
      { ...cell, receiptNull: false },
      admission,
    ),
    false,
    "a receipt-bearing payload is never a not-started recovery",
  );
  assert.equal(
    historicalNotStartedProven(wave, { ...cell, bundleNull: false }, admission),
    false,
    "a bundle-bearing payload is never a not-started recovery",
  );
  assert.equal(
    historicalNotStartedProven(
      wave,
      { ...cell, reservationId: "other" },
      admission,
    ),
    false,
    "evidence for another reservation is never adopted",
  );
  assert.equal(
    historicalNotStartedProven(wave, undefined, admission),
    false,
    "missing evidence is never inferred",
  );
  assert.equal(
    historicalNotStartedProven(wave, cell, {
      id: "r-historical",
      createdAt: T0 - 1,
    }),
    false,
    "an admission before the planner window is refused",
  );
  assert.equal(
    historicalNotStartedProven(wave, cell, {
      id: "r-historical",
      createdAt: T0 + 3_600_001,
    }),
    false,
    "an admission after the planner window is refused",
  );
  assert.equal(
    historicalNotStartedProven(
      { ...wave, plannerCompletedAt: "not-a-time" },
      cell,
      admission,
    ),
    false,
    "a malformed authenticated window fails closed",
  );
});

Deno.test("matrix actions: ordinary missing-health and verification purposes produce zero model admissions", async () => {
  for (
    const purpose of [
      "ordinary",
      "bootstrap",
      "prior",
      "candidate",
      "rollback",
    ] as const
  ) {
    const r = await rig(false, purpose);
    try {
      let starts = 0;
      const result = await runActionsMatrixHost({
        ...await r.job("verify", "matrix_plan"),
        model: {
          modelId: "gpt-reserve",
          runModel: () => {
            starts++;
            throw Error("verification cannot infer");
          },
        },
      });
      assert.ok("plan" in result);
      assert.equal(result.prepared, 0);
      assert.equal(starts, 0);
      const state = await r.store.readRepair();
      assert.ok(state.ok && state.value.status === "found");
      assert.equal(state.value.snapshot.reservations.length, 0);
    } finally {
      await r.cleanup();
    }
  }
});

Deno.test("matrix actions: one wave durably admits 128 fresh issues through real paginated source intake", async () => {
  const r = await rig();
  try {
    const memory = new MemoryState();
    const release = await r.store.readRelease();
    assert.ok(release.ok && release.value.status === "found");
    memory.setRelease(release.value.snapshot);
    const pages: number[] = [];
    const rows = Array.from({ length: 128 }, (_, index) =>
      issueWire({
        number: index + 1,
        title: "issue " + (index + 1),
        body: "body " + (index + 1),
        created_at: new Date(T0).toISOString(),
        updated_at: new Date(T0).toISOString(),
      }));
    const deps = await r.job("high-count", "matrix_plan");
    const client = new GitHubApiClient({
      repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
      apiBaseUrl: "https://api.github.com",
      clock: r.clock,
      auth: {
        authorizationHeader: () => Promise.resolve(portOk("Bearer fake-token")),
      },
      cooldownGate: {
        beforeRequest: () => Promise.resolve(portOk(undefined)),
        recordRateLimit: () => Promise.resolve(portOk(undefined)),
      },
      includeIssueRelations: true,
      http: (request) => {
        const url = new URL(request.url);
        let body: unknown;
        const headers = new Headers();
        if (url.pathname === "/graphql") {
          const number = JSON.parse(request.body!).variables.number;
          body = {
            data: {
              repository: {
                issue: {
                  number,
                  blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
                  subIssues: { totalCount: 0 },
                },
              },
            },
          };
        } else if (url.pathname === "/repos/ubiquity/sentinel/issues") {
          const page = Number(url.searchParams.get("page"));
          pages.push(page);
          body = page === 1 ? rows.slice(0, 100) : rows.slice(100);
          if (page === 1) {
            headers.set(
              "link",
              '<https://api.github.com/repos/ubiquity/sentinel/issues?state=open&per_page=100&page=2>; rel="next"',
            );
          }
        } else {
          const number = Number(url.pathname.split("/").at(-1));
          body = rows[number - 1];
          if (body === undefined) throw new Error("unexpected source request");
        }
        return Promise.resolve({
          status: 200,
          headers,
          bodyText: JSON.stringify(body),
        });
      },
    });
    const port = r.github.get("ubiquity/sentinel")!;
    port.listOpenIssues = () => client.listOpenIssues();
    port.readIssue = (number) => client.readIssue(number);
    r.github.get("ubiquity/ai.ubq.fi")!.listOpenIssues = () =>
      Promise.resolve(portOk([]));
    const planned = await runActionsMatrixHost({
      ...deps,
      state: memory,
      model: {
        modelId: "gpt-reserve",
        runModel: () => {
          throw new Error("planning cannot infer");
        },
      },
    });
    assert.ok("plan" in planned);
    assert.deepEqual(
      pages,
      [1, 2],
      "actual GitHub source must exhaust its second page",
    );
    assert.equal(
      planned.prepared,
      128,
      "one native wave must not stop at an artificial preparation limit",
    );
    assert.equal(memory.repair!.reservations.length, 128);
    assert.equal(
      new Set(memory.repair!.reservations.map((row) => row.id)).size,
      128,
    );
    assert.ok(
      memory.repair!.reservations.every((row) => row.outcome === "reserved"),
    );
    assert.equal(
      memory.repair!.work.filter((row) => row.intent?.kind === "implementation")
        .length,
      128,
    );
  } finally {
    await r.cleanup();
  }
});

Deno.test("matrix actions: manifest byte budget leaves overflow issues unreserved for a later wave", async () => {
  const r = await rig();
  try {
    const memory = new MemoryState();
    const release = await r.store.readRelease();
    assert.ok(release.ok && release.value.status === "found");
    memory.setRelease(release.value.snapshot);
    const rows = Array.from({ length: 128 }, (_, index) => ({
      ...issue(index + 1),
      body: "X".repeat(17 * 1024),
    }));
    const source = r.github.get("ubiquity/sentinel")!;
    source.listOpenIssues = () => Promise.resolve(portOk(rows));
    source.readIssue = (number) =>
      Promise.resolve(portOk(rows[number - 1] ?? null));
    r.github.get("ubiquity/ai.ubq.fi")!.listOpenIssues = () =>
      Promise.resolve(portOk([]));
    const model: ImplementationPort = {
      modelId: "gpt-reserve",
      runModel: () => {
        throw Error("planning cannot infer");
      },
    };
    let first: Awaited<ReturnType<typeof runActionsMatrixHost>> | null = null;
    try {
      first = await runActionsMatrixHost({
        ...await r.job("large-manifest", "matrix_plan"),
        state: memory,
        model,
      });
    } catch (error) {
      console.log(
        JSON.stringify({
          kind: "manifest_byte_failure",
          reservations: memory.repair?.reservations.length,
          intents: memory.repair?.work.filter((row) => row.intent !== null)
            .length,
        }),
      );
      throw error;
    }
    assert.ok("plan" in first);
    assert.ok(first.prepared > 0 && first.prepared < 128);
    assert.ok(
      (await Deno.stat(r.root + "/large-manifest/.sentinel-matrix/plan.json"))
        .size <= MAX_MATRIX_ARTIFACT_BYTES,
    );
    assert.equal(memory.repair!.reservations.length, first.prepared);
    assert.equal(
      memory.repair!.work.filter((row) => row.intent?.kind === "implementation")
        .length,
      first.prepared,
    );
    assert.ok(
      memory.repair!.work.filter((row) => row.intent === null).every((row) =>
        row.counters.attempts === 0
      ),
    );
    const firstCharges = structuredClone(memory.repair!.reservations);
    await r.advanceRun(72);
    const nextRelease = await r.store.readRelease();
    assert.ok(nextRelease.ok && nextRelease.value.status === "found");
    memory.setRelease(nextRelease.value.snapshot);
    const second = await runActionsMatrixHost({
      ...await r.job("later-manifest", "matrix_plan"),
      state: memory,
      model,
    });
    assert.ok("plan" in second);
    assert.equal(first.prepared + second.prepared, 128);
    assert.equal(memory.repair!.reservations.length, 128);
    assert.equal(
      new Set(memory.repair!.reservations.map((row) => row.id)).size,
      128,
    );
    assert.deepEqual(
      memory.repair!.reservations.slice(0, firstCharges.length),
      firstCharges,
    );
  } finally {
    await r.cleanup();
  }
});

Deno.test("matrix actions: authenticated historical runtime mismatch isolates one wave and advances unrelated work", () =>
  freshMatrixArtifacts(false, false, "none", true));

for (
  const scenario of [
    "scan expiry",
    "consumer expiry",
    "run expiry",
    "run already expired",
    "shortened retry",
  ] as const
) {
  Deno.test(
    "matrix actions: historical isolation deadline " + scenario,
    async () => {
      const r = await rig();
      try {
        const planned = await runActionsMatrixHost({
          ...await r.job("deadline-plan", "matrix_plan"),
          model: {
            modelId: "gpt-reserve",
            runModel: () => Promise.reject(new Error("planner cannot infer")),
          },
        });
        assert.ok("plan" in planned);
        const captured = await r.store.readRepair();
        assert.ok(captured.ok && captured.value.status === "found");
        const capturedHead = captured.value.head;
        const original = captured.value.snapshot;
        const cell = planned.plan.cells.find((row) =>
          row.repository.name === "ai.ubq.fi"
        )!;
        const work = original.work.find((row) => row.id === cell.taskId)!;
        const reservation = original.reservations.find((row) =>
          row.id === cell.reservationId
        )!;
        const startedAt = r.clock.now();
        const elapsed = scenario === "shortened retry"
          ? 40_000
          : scenario === "scan expiry"
          ? 120_001
          : 5_001;
        const calls: { at: number; deadline?: number }[] = [];
        const running = runActionsRepairHost({
          ...await r.job("deadline-aggregate", "repair"),
          model: {
            modelId: "gpt-reserve",
            runModel: () => Promise.reject(new Error("aggregate cannot infer")),
          },
          runTargetCycles: (input) =>
            runActionsMatrixAggregateCycles(
              {
                ...input,
                modelStartsEnabled: false,
                ...(scenario === "run already expired"
                  ? { deadline: startedAt }
                  : scenario === "run expiry"
                  ? { deadline: startedAt + 5_000 }
                  : {}),
              },
              {
                recover(request) {
                  calls.push({
                    at: r.clock.now(),
                    deadline: (request as { deadline?: number }).deadline,
                  });
                  if (calls.length > 1) return Promise.resolve([]);
                  r.clock.advance(elapsed);
                  return Promise.reject(
                    new MatrixHistoricalRuntimeMismatch({
                      consumerRun: input.host!.run,
                      expectedRuntimeSha: input.controllerSha,
                      run: { ...input.host!.run, runId: 69 },
                      runtimeSha: "e".repeat(40) as GitSha,
                      generation: 1,
                      repairHead: capturedHead,
                      planDigest: planned.planDigest,
                      planArtifactId: 503,
                      planArchiveDigest: "sha256:" + "a".repeat(64),
                      plannerJobId: 405,
                      affected: [{
                        work,
                        reservation,
                        cell: {
                          cellId: cell.cellId,
                          taskId: cell.taskId,
                          reservationId: cell.reservationId,
                          status: "completed",
                          receiptNull: false,
                          bundleNull: false,
                          completedAt: startedAt,
                          resultDigest: "b".repeat(64),
                        },
                      }],
                    }),
                  );
                },
              },
              undefined,
              {
                maxWaitMs: scenario === "consumer expiry" ? 5_000 : 0,
                pollWait: () =>
                  Promise.reject(new Error("deadline test must never sleep")),
              },
            ),
        });
        if (scenario === "run expiry" || scenario === "run already expired") {
          await assert.rejects(running, /reached its run deadline/);
        } else {
          assert.equal((await running).status, "ran");
        }
        assert.equal(
          calls.length,
          scenario === "run already expired"
            ? 0
            : scenario === "shortened retry"
            ? 2
            : 1,
          "a rejected wave must not renew recovery after the shared scan, consumer or run budget expires",
        );
        if (scenario === "shortened retry") {
          assert.equal(calls[0].deadline, startedAt + 120_000);
          assert.equal(calls[1].deadline, calls[0].deadline);
          assert.equal(calls[1].deadline! - calls[1].at, 80_000);
        }
        const after = await r.store.readRepair();
        assert.ok(after.ok && after.value.status === "found");
        assert.deepEqual(
          after.value.snapshot.reservations,
          original.reservations,
        );
        if (scenario === "run already expired") {
          assert.deepEqual(
            after.value.snapshot,
            original,
            "an expired run cannot inspect or isolate any artifact wave",
          );
        }
        const sibling = original.work.find((row) =>
          row.repository.name === "sentinel"
        )!;
        assert.deepEqual(
          after.value.snapshot.work.find((row) => row.id === sibling.id),
          sibling,
          "unconsumed sibling remains unresolved with its exact admission",
        );
        assert.ok(
          [...r.github.values()].every((port) =>
            !port.calls.some((call) => call.startsWith("push:"))
          ),
        );
      } finally {
        await r.cleanup();
      }
    },
  );
}
