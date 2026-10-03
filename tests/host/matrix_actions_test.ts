/** Real hosted matrix composition over separate temporary Git repositories and fake external ports. */
import assert from "node:assert/strict";
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
import { matrixDigestV1 } from "../../src/contracts/matrix.ts";
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
    const waves = [{
      plan: planner.plan,
      planDigest: planner.planDigest,
      results,
      bundlesDir: archive,
      provenance: {
        run: planner.plan.run,
        plannerJobId: 102,
        cellJobIds: [103, 104],
      },
    }];
    const originalPreservers = [...r.github.values()].map((port) =>
      port.preserveCandidate.bind(port)
    );
    for (const port of r.github.values()) {
      port.preserveCandidate = () =>
        Promise.resolve(
          portError("unavailable", "injected preservation outage"),
        );
    }
    async function aggregate(
      name: string,
      available: boolean,
      carrier?: { planDigest: string },
    ) {
      const deps = await r.job(name, "repair");
      await runActionsRepairHost({
        ...deps,
        model: {
          modelId: "gpt-reserve",
          runModel: () => {
            throw Error("aggregate must not implement");
          },
        },
        runTargetCycles: (input) =>
          runActionsMatrixAggregateCycles({
            ...input,
            modelStartsEnabled: false,
          }, {
            recover: (request) => {
              assert.equal(
                request.requests.length,
                2,
                "submitted preservation intents remain artifact recovery requests",
              );
              if (!available) {
                return Promise.all(input.configs.map(async (entry) => {
                  await input.prepareTarget?.(entry);
                  const candidate = results.find((result) =>
                    result.repository.name === entry.repository.name
                  )!;
                  assert.equal(
                    (await gitRun(input.host!.sourcePathFor(entry), [
                      "cat-file",
                      "-e",
                      candidate.bundle!.head + "^{commit}",
                    ], r.env)).ok,
                    false,
                  );
                })).then(() => []);
              }
              return Promise.resolve(available ? waves : []);
            },
          }, carrier),
      });
    }
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
