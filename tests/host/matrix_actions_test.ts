/** Real hosted matrix composition over separate temporary Git repositories and fake external ports. */
import assert from "node:assert/strict";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { createActionsMatrixArtifactHttpTransport } from "../../src/host/matrix-artifacts.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
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
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { MatrixCellResultV1 } from "../../src/contracts/matrix.ts";
import {
  matrixDigestV1,
  MAX_MATRIX_ARTIFACT_BYTES,
} from "../../src/contracts/matrix.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
} from "../../src/state/mod.ts";
import {
  runActionsMatrixAggregateCycles,
  runActionsMatrixHost,
} from "../../src/host/matrix-actions.ts";
import { runActionsRepairHost } from "../../src/host/actions.ts";
import {
  OPERATION_MARGIN_MS,
  REPAIR_MODEL_CUTOFF_MS,
} from "../../src/repair/loop.ts";
import { FakeClock, FakeGithub, MemoryState } from "../repair/helpers.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import { issueWire } from "../github/helpers.ts";
import { gitRun, makeRemoteCtx, T0, testGitEnv } from "../state/helpers.ts";
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
async function rig(
  healthy = true,
  purpose: "ordinary" | "bootstrap" | "prior" | "candidate" | "rollback" =
    "ordinary",
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
  const store = createRepairStateStore({
    scratchDir: root + "/repair",
    remoteUrl: remote.remoteUrl,
  });
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
    github,
    jobs,
    job,
    advanceRun,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}
Deno.test("matrix actions: actual fresh intake plans both targets, isolated cells overlap, archive recovery publishes on a fresh aggregate", async () => {
  const r = await rig();
  try {
    let modelCalls = 0, active = 0, peak = 0;
    let unblock: () => void = () => {};
    const overlap = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const planner = await runActionsMatrixHost({
      ...await r.job("plan", "matrix_plan"),
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
      2,
      "fresh unseeded issues must reach actual matrix admission",
    );
    assert.equal(
      new Set(planner.plan.cells.map((cell) => cell.repository.name)).size,
      2,
    );
    const results: MatrixCellResultV1[] = [];
    const archive = r.root + "/archive";
    await Deno.mkdir(archive);
    for (const cell of planner.plan.cells) {
      await Deno.mkdir(r.root + "/cell-" + cell.cellId);
    }
    await Promise.all(planner.plan.cells.map(async (cell) => {
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
        model,
        carrier: { planDigest: planner.planDigest, cellId: cell.cellId },
      });
      assert.ok("cellId" in result);
      results.push(result);
      assert.ok(result.bundle);
      await Deno.copyFile(
        artifactRoot + "/" + result.bundle.file,
        archive + "/" + result.bundle.file,
      );
      await Deno.remove(r.root + "/" + name, { recursive: true });
    }));
    assert.equal(modelCalls, 2);
    assert.equal(peak, 2);
    const before = await r.store.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    assert.equal(
      before.value.snapshot.reservations.filter((row) =>
        row.purpose === "implementation"
      ).length,
      2,
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
        await zip([{ name: "result.json", content: encode(result) }, {
          name: result.bundle!.file,
          content: await Deno.readFile(archive + "/" + result.bundle!.file),
        }]),
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
    const job = (id: number, name: string, step: string) => ({
      id,
      name,
      run_id: 71,
      run_attempt: 1,
      head_sha: r.sha,
      status: "completed",
      conclusion: "success",
      started_at: iso,
      completed_at: iso,
      steps: [{
        name: step,
        number: 1,
        status: "completed",
        conclusion: "success",
        started_at: iso,
        completed_at: iso,
      }],
    });
    const jobs = [job(401, "matrix_plan", "Plan isolated issue matrix")];
    for (const [index, result] of results.entries()) {
      jobs.push(
        job(
          402 + index,
          "matrix_cell (" + result.cellId + ")",
          "Run isolated issue cell",
        ),
      );
      logs.set(
        402 + index,
        iso + " " +
          JSON.stringify({
            kind: "sentinel_matrix_cell",
            run: result.run,
            runtimeSha: result.runtimeSha,
            generation: result.generation,
            cellId: result.cellId,
            reservationId: result.reservationId,
            resultDigest: await matrixDigestV1(result),
            bundleDigest: result.bundle!.digest,
            status: result.status,
          }) + "\n",
      );
    }
    const artifactHttp = function (available: boolean) {
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
          const rows = available && !parsed.pathname.includes("/runs/72/")
            ? artifactRows
            : [];
          return reply({ total_count: rows.length, artifacts: rows });
        }
        if (parsed.pathname.endsWith("/jobs")) {
          return reply({ total_count: jobs.length, jobs });
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
    const aggregate = async function (
      name: string,
      available: boolean,
      carrier?: { planDigest: string },
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
      Deno.chdir(deps.workDir);
      try {
        await runActionsRepairHost({
          ...deps,
          artifactHttp: artifactHttp(available),
          model: {
            modelId: "gpt-reserve",
            runModel: () => {
              throw Error("aggregate must not implement");
            },
          },
          runTargetCycles: (input) =>
            runActionsMatrixAggregateCycles(
              { ...input, modelStartsEnabled: false },
              undefined,
              carrier,
            ),
        });
      } finally {
        Deno.chdir(oldCwd);
      }
    };
    const digestControl = await r.store.readRepair();
    assert.ok(digestControl.ok && digestControl.value.status === "found");
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
    await aggregate("missing-artifact", false);
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
    await aggregate("later-run", true);
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
});
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
