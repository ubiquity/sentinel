/** Production HTTP/archive transport, scripted native API only; no external writes. */
import assert from "node:assert/strict";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
  parseHostedExecutionSettlementV1,
} from "../../src/contracts/hosted-supervisor.ts";
import {
  matrixCellIdV1,
  type MatrixCellResultV1,
  matrixDigestV1,
  type MatrixPlanV1,
} from "../../src/contracts/matrix.ts";
import {
  type ModelRunRequestV1,
  portOk,
  type StateReadView,
} from "../../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { fetchHttpTransport } from "../../src/github/http.ts";
import {
  createActionsMatrixArtifactHttpTransport,
  createActionsMatrixArtifactTransport,
} from "../../src/host/matrix-artifacts.ts";
import {
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import {
  gitRun,
  REPO,
  reviewReceipt,
  SHA1,
  SHA2,
  SHA3,
  T0,
  testGitEnv,
  workRecord,
} from "../state/helpers.ts";

const LAUNCHER = "1".repeat(40) as GitSha;
const RUNTIME = "2".repeat(40) as GitSha;
const RUN = { runId: 71, runAttempt: 2, launcherSha: LAUNCHER };
const WAVE = "71:2:repair";
const RESERVATION = "a".repeat(64);
const ISO = new Date(T0).toISOString();
const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const bytes = (value: unknown) =>
  new TextEncoder().encode(canonicalStringify(value));
async function digest(value: Uint8Array) {
  return [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", value.slice())),
  ].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function zip(
  entries: { name: string; content: Uint8Array; unixMode?: number }[],
) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
  });
  for (const entry of entries) {
    await writer.add(entry.name, new Uint8ArrayReader(entry.content), {
      unixMode: entry.unixMode ?? 0o100600,
    });
  }
  return await writer.close();
}
async function fixture(paginated = false) {
  const tmp = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "matrix-transport-test-",
  });
  const checkout = `${tmp}/checkout`;
  await Deno.mkdir(checkout);
  const cellId = await matrixCellIdV1(WAVE, "artifact-task", RESERVATION);
  const request: ModelRunRequestV1 = {
    taskId: "artifact-task" as never,
    repository: REPO,
    base: SHA1,
    issue: { number: 1, title: "test", body: "test" },
    evidence: [],
    model: "gpt-reserve",
    reasoning: "max" as const,
    maxDurationMs: 10_000,
    maxOutputChars: 10_000,
  };
  const cell = {
    cellId,
    taskId: request.taskId,
    repository: REPO,
    reservationId: RESERVATION,
    intentKey: implementationIntentKey(RESERVATION),
    expectedBase: SHA1,
    runtimeSha: RUNTIME,
    generation: 3,
    requestDigest: await matrixDigestV1(request),
    request,
  };
  const plan: MatrixPlanV1 = {
    version: "v1",
    kind: "matrix_plan",
    waveId: WAVE,
    run: RUN,
    plannedAt: T0,
    cells: [cell],
  };
  const bundle = new Uint8Array([0x50, 0x4b, 0x00, 0xff, 0x80]);
  const result: MatrixCellResultV1 = {
    version: "v1",
    kind: "matrix_cell_result",
    waveId: WAVE,
    cellId,
    taskId: cell.taskId,
    repository: REPO,
    run: RUN,
    runtimeSha: RUNTIME,
    generation: 3,
    reservationId: RESERVATION,
    intentKey: cell.intentKey,
    requestDigest: cell.requestDigest,
    status: "completed",
    receipt: {
      invocationId: RESERVATION,
      outcome: "completed",
      actual: {
        evidenceKind: "request-runtime",
        provider: "test",
        threadId: "thread",
        turnId: "turn",
        terminalOrigin: "runtime",
        observedTerminalStatus: "completed",
        observedModel: "gpt-reserve",
        observedReasoning: "max",
        durationMs: 1,
        outputChars: 1,
      },
      candidate: { head: SHA2, checkpointSha: null, changedPaths: ["fix.ts"] },
      error: null,
    },
    bundle: {
      file: `${cellId}.bundle`,
      digest: await digest(bundle),
      head: SHA2,
      checkpointSha: null,
    },
    detail: null,
    completedAt: T0,
  };
  const work = workRecord("artifact-task", {
    repository: REPO,
    target: {
      base: SHA1,
      branch: "sentinel/test",
      checkpoint: null,
      head: null,
      pr: null,
    },
    intent: {
      kind: "implementation",
      key: cell.intentKey,
      startedAt: T0,
      branch: "sentinel/test",
      expectedHead: null,
      observedBase: SHA1,
      pr: null,
      requestId: RESERVATION,
      resultId: null,
    },
  });
  const repair = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: [work],
    reservations: [{
      version: "v1",
      kind: "budget_reservation",
      repository: REPO,
      id: RESERVATION,
      taskId: work.id,
      attempt: 1,
      head: SHA1,
      purpose: "implementation",
      createdAt: T0,
      outcome: "reserved",
      settledAt: null,
      proofRef: null,
    }],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
  });
  // A later execution has replaced the old execution/proofs; old intent survives.
  const release = parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    releases: [],
    hostedRuntimes: [{
      version: "v1",
      kind: "hosted_runtime",
      id: "ubiquity/sentinel:0:production",
      activeRevision: RUNTIME,
      generation: 3,
      lastHealthyProof: null,
      lastExecutionProof: null,
      nextOrdinaryAt: T0,
      execution: {
        id: "99:1:repair",
        runId: 99,
        runAttempt: 1,
        launcherSha: LAUNCHER,
        purpose: "ordinary",
        revision: RUNTIME,
        generation: 3,
        releaseId: null,
        createdAt: T0,
      },
      createdAt: T0,
      updatedAt: T0,
    }],
    hostedReleases: [],
    githubCooldowns: [],
  });
  const state: StateReadView = {
    readRepair: () =>
      Promise.resolve(
        portOk({ status: "found", snapshot: repair, head: SHA1, ref: null }),
      ),
    readRelease: () =>
      Promise.resolve(
        portOk({ status: "found", snapshot: release, head: SHA1, ref: null }),
      ),
  };
  const provenance = {
    id: 71,
    repository_id: 123,
    head_repository_id: 123,
    head_branch: "sentinel-supervisor",
    head_sha: LAUNCHER,
  };
  const planName = "sentinel-matrix-plan-71-2",
    cellName = `sentinel-matrix-cell-71-2-${cellId}`;
  const archives = new Map<number, Uint8Array>();
  const artifacts: Record<string, unknown>[] = [];
  async function setArchive(id: number, name: string, content: Uint8Array) {
    archives.set(id, content);
    const artifact = {
      id,
      name,
      size_in_bytes: content.length,
      expired: false,
      digest: `sha256:${await digest(content)}`,
      workflow_run: provenance,
    };
    const index = artifacts.findIndex((row) => row.id === id);
    if (index < 0) artifacts.push(artifact);
    else artifacts[index] = artifact;
  }
  await setArchive(
    501,
    planName,
    await zip([{ name: "plan.json", content: bytes(plan) }]),
  );
  await setArchive(
    502,
    cellName,
    await zip([{ name: "result.json", content: bytes(result) }, {
      name: `${cellId}.bundle`,
      content: bundle,
    }]),
  );
  const plannerMarker = {
    kind: "sentinel_matrix_plan",
    waveId: WAVE,
    run: RUN,
    runtimeSha: RUNTIME,
    generation: 3,
    planDigest: await matrixDigestV1(plan),
    prepared: 1,
  };
  const cellMarker = {
    kind: "sentinel_matrix_cell",
    run: RUN,
    runtimeSha: RUNTIME,
    generation: 3,
    cellId,
    reservationId: RESERVATION,
    resultDigest: await matrixDigestV1(result),
    bundleDigest: result.bundle!.digest,
    status: "completed",
  };
  const logs = new Map([[401, `${ISO} ${JSON.stringify(plannerMarker)}\n`], [
    402,
    `${ISO} ${JSON.stringify(cellMarker)}\n`,
  ]]);
  const job = (id: number, name: string, step: string) => ({
    id,
    name,
    run_id: RUN.runId,
    run_attempt: RUN.runAttempt,
    head_sha: LAUNCHER,
    status: "completed",
    conclusion: "success",
    started_at: ISO,
    completed_at: ISO,
    steps: [{
      name: step,
      number: 1,
      status: "completed",
      conclusion: "success",
      started_at: ISO,
      completed_at: ISO,
    }],
  });
  const jobs = [
    job(401, "matrix_plan", "Plan isolated issue matrix"),
    job(402, `matrix_cell (${cellId})`, "Run isolated issue cell"),
  ];
  if (paginated) {
    artifacts.unshift(
      ...Array.from(
        { length: 100 },
        (_, i) => ({ id: i + 1000, name: `other-${i}` }),
      ),
    );
    jobs.unshift(
      ...Array.from(
        { length: 100 },
        (_, i) => job(i + 2000, `other-${i}`, "other"),
      ),
    );
  }
  const attempt: Record<string, unknown> = {
    id: 71,
    run_attempt: 2,
    workflow_id: HOSTED_SUPERVISOR_WORKFLOW_ID,
    path: HOSTED_SUPERVISOR_WORKFLOW_PATH,
    event: "workflow_dispatch",
    head_branch: "sentinel-supervisor",
    head_sha: LAUNCHER,
    repository: { id: 123, full_name: "ubiquity/sentinel" },
    head_repository: { id: 123, full_name: "ubiquity/sentinel" },
    status: "in_progress",
    run_started_at: ISO,
    updated_at: ISO,
  };
  const calls: { url: string; auth: boolean }[] = [];
  const pagination = {
    numeric: false,
    next: null as string | null,
    repository: { id: 123, full_name: "ubiquity/sentinel" },
    truncate: false,
    duplicate: false,
  };
  const http = createActionsMatrixArtifactHttpTransport((url, init) => {
    const parsed = new URL(url);
    calls.push({ url, auth: Boolean(init?.headers?.authorization) });
    const reply = (body: unknown, headers: Record<string, string> = {}) =>
      Promise.resolve(new Response(JSON.stringify(body), { headers }));
    if (parsed.host.endsWith("blob.core.windows.net")) {
      assert.equal(init?.headers?.authorization, undefined);
      assert.equal(init?.redirect, "error");
      if (parsed.pathname.startsWith("/archive/")) {
        return Promise.resolve(
          new Response(
            archives.get(Number(parsed.pathname.split("/").at(-1)))!.slice(),
          ),
        );
      }
      return Promise.resolve(
        new Response(logs.get(Number(parsed.pathname.split("/").at(-1)))!),
      );
    }
    assert.equal(init?.headers?.authorization, "Bearer fake-local-token");
    assert.equal(init?.redirect, "manual");
    if (parsed.pathname === "/repos/ubiquity/sentinel") {
      return reply(pagination.repository);
    }
    if (parsed.pathname.endsWith("/attempts/2")) return reply(attempt);
    if (
      parsed.pathname.endsWith("/artifacts") ||
      parsed.pathname.endsWith("/jobs")
    ) {
      const key = parsed.pathname.endsWith("/jobs") ? "jobs" : "artifacts";
      const rows = key === "jobs" ? jobs : artifacts;
      const page = Number(parsed.searchParams.get("page"));
      const nextPath = pagination.numeric
        ? parsed.pathname.replace(
          "/repos/ubiquity/sentinel",
          "/repositories/123",
        )
        : parsed.pathname;
      const next = rows.length > page * 100
        ? `<${
          pagination.next ??
            `${parsed.origin}${nextPath}?per_page=100&page=${page + 1}`
        }>; rel="next"`
        : "";
      const entries: Record<string, unknown>[] = rows.slice(
        (page - 1) * 100,
        page * 100,
      );
      if (page === 2 && pagination.truncate) entries.pop();
      if (page === 2 && pagination.duplicate) {
        entries[entries.length - 1] = { ...rows[0] };
      }
      return reply({
        total_count: rows.length,
        [key]: entries,
      }, next ? { link: next } : {});
    }
    const archive = parsed.pathname.match(/\/artifacts\/(\d+)\/zip$/),
      log = parsed.pathname.match(/\/jobs\/(\d+)\/logs$/);
    if (archive || log) {
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: {
            location: `https://productionresultssa1.blob.core.windows.net/${
              archive ? "archive" : "log"
            }/${(archive ?? log)![1]}`,
          },
        }),
      );
    }
    throw new Error("unexpected fake route");
  });
  const artifactTransport = createActionsMatrixArtifactTransport({
    state,
    token: "fake-local-token",
    http,
    clock: { now: () => T0 + 10_000 },
    artifactRoot: `${tmp}/recovered`,
  });
  const transport: typeof artifactTransport = {
    async recover(input) {
      const originalCwd = Deno.cwd();
      Deno.chdir(checkout);
      try {
        return await artifactTransport.recover(input);
      } finally {
        Deno.chdir(originalCwd);
      }
    },
  };
  const input = {
    requests: [{
      taskId: work.id,
      repository: REPO,
      reservationId: RESERVATION,
      intentKey: cell.intentKey,
      expectedBase: SHA1,
      attempt: 1,
    }],
    runtimeSha: RUNTIME,
    launcherSha: LAUNCHER,
    currentRun: RUN,
  };
  return {
    tmp,
    plan,
    result,
    bundle,
    cell,
    repair,
    release,
    artifacts,
    jobs,
    attempt,
    logs,
    plannerMarker,
    cellMarker,
    archives,
    calls,
    pagination,
    http,
    state,
    transport,
    input,
    setArchive,
    planName,
    cellName,
  };
}

Deno.test("matrix artifacts: numeric repository pagination recovers native 100 plus 8 pages", async () => {
  const rig = await fixture(true);
  try {
    rig.pagination.numeric = true;
    rig.artifacts.push(
      ...Array.from(
        { length: 6 },
        (_, i) => ({ id: i + 3000, name: `extra-${i}` }),
      ),
    );
    const { currentRun: _oldRun, ...input } = rig.input;
    const waves = await rig.transport.recover(input);
    assert.equal(rig.artifacts.length, 108);
    assert.equal(waves.length, 1);
    assert.equal(waves[0].results.length, 1);
    assert.deepEqual(
      await Deno.readFile(`${waves[0].bundlesDir}/${rig.result.bundle!.file}`),
      rig.bundle,
    );
    assert.equal(
      rig.calls.filter((call) =>
        new URL(call.url).pathname === "/repos/ubiquity/sentinel"
      ).length,
      1,
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix artifacts: numeric repository pagination also binds current-run artifacts and job pages", async () => {
  const rig = await fixture(true);
  try {
    rig.pagination.numeric = true;
    rig.artifacts.push(
      ...Array.from(
        { length: 6 },
        (_, i) => ({ id: i + 3000, name: `extra-${i}` }),
      ),
    );
    rig.jobs.push(
      ...Array.from(
        { length: 6 },
        (_, i) => ({ ...rig.jobs[0], id: i + 4000, name: `extra-job-${i}` }),
      ),
    );
    const waves = await rig.transport.recover(rig.input);
    assert.equal(waves.length, 1);
    assert.equal(waves[0].results.length, 1);
    assert.ok(
      rig.calls.some((call) =>
        call.url.includes("/runs/71/artifacts?per_page=100&page=2")
      ),
    );
    assert.ok(
      rig.calls.some((call) =>
        call.url.includes("/attempts/2/jobs?per_page=100&page=2")
      ),
    );
    assert.equal(
      rig.calls.filter((call) =>
        new URL(call.url).pathname === "/repos/ubiquity/sentinel"
      ).length,
      1,
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix artifacts: numeric repository pagination refuses foreign identity and malformed boundaries", async (t) => {
  const valid =
    "https://api.github.com/repositories/123/actions/artifacts?per_page=100&page=2";
  const cases: [string, (rig: Awaited<ReturnType<typeof fixture>>) => void][] =
    [
      ["other repository ID", (rig) => {
        rig.pagination.next = valid.replace("/123/", "/456/");
      }],
      ["wrong authenticated repository name", (rig) => {
        rig.pagination.repository.full_name = "ubiquity/other";
      }],
      ["wrong authenticated repository ID", (rig) => {
        rig.pagination.repository.id = 456;
      }],
      ["invalid authenticated repository ID", (rig) => {
        rig.pagination.repository.id = 0;
      }],
      ["foreign host", (rig) => {
        rig.pagination.next = valid.replace(
          "api.github.com",
          "foreign.invalid",
        );
      }],
      ["HTTP scheme", (rig) => {
        rig.pagination.next = valid.replace("https:", "http:");
      }],
      ["wrong actions suffix", (rig) => {
        rig.pagination.next = valid.replace("/artifacts?", "/jobs?");
      }],
      ["wrong page size", (rig) => {
        rig.pagination.next = valid.replace("per_page=100", "per_page=99");
      }],
      ["skipped page", (rig) => {
        rig.pagination.next = valid.replace("page=2", "page=3");
      }],
      ["page loop", (rig) => {
        rig.pagination.next = valid.replace("page=2", "page=1");
      }],
      ["extra query", (rig) => {
        rig.pagination.next = valid + "&other=1";
      }],
      ["duplicate query", (rig) => {
        rig.pagination.next = valid + "&page=2";
      }],
      ["fragment", (rig) => {
        rig.pagination.next = valid + "#other";
      }],
      ["duplicate next relation", (rig) => {
        rig.pagination.next = valid + '>; rel="next", <' + valid;
      }],
      ["truncated second page", (rig) => {
        rig.pagination.truncate = true;
      }],
      ["duplicate item ID", (rig) => {
        rig.pagination.duplicate = true;
      }],
    ];
  for (const [name, change] of cases) {
    await t.step(name, async () => {
      const rig = await fixture(true);
      try {
        rig.pagination.numeric = true;
        rig.artifacts.push(
          ...Array.from(
            { length: 6 },
            (_, i) => ({ id: i + 3000, name: `extra-${i}` }),
          ),
        );
        change(rig);
        const before = canonicalStringify([rig.repair, rig.release]);
        const { currentRun: _oldRun, ...input } = rig.input;
        await assert.rejects(
          () => rig.transport.recover(input),
          /provenance unavailable or conflicting/,
        );
        assert.equal(canonicalStringify([rig.repair, rig.release]), before);
        assert.ok(
          rig.calls.every((call) =>
            new URL(call.url).hostname === "api.github.com"
          ),
        );
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test("matrix artifacts: authenticated paginated old wave recovers exact bundle after local cells disappeared", async () => {
  const rig = await fixture(true);
  try {
    const before = canonicalStringify([rig.repair, rig.release]);
    const { currentRun: _oldRun, ...input } = rig.input;
    const waves = await rig.transport.recover(input);
    assert.equal(waves.length, 1);
    assert.equal(waves[0].results.length, 1);
    assert.deepEqual(
      await Deno.readFile(`${waves[0].bundlesDir}/${rig.result.bundle!.file}`),
      rig.bundle,
    );
    assert.deepEqual(waves[0].provenance, {
      run: RUN,
      plannerJobId: 401,
      cellJobIds: [402],
    });
    assert.ok(
      rig.calls.some((call) =>
        call.url.includes("artifacts?per_page=100&page=2")
      ),
    );
    assert.ok(
      rig.calls.some((call) => call.url.includes("jobs?per_page=100&page=2")),
    );
    assert.equal(canonicalStringify([rig.repair, rig.release]), before);
    assert.ok(
      rig.calls.every((call) =>
        !call.url.includes("blob.core.windows.net") || !call.auth
      ),
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix skipped completion: no-runner wire timestamps and adverse guards", async () => {
  for (
    const fault of [
      "none",
      "executed",
      "runner",
      "active",
      "incomplete",
      "foreign",
      "duplicate",
      "truncated",
      "before-attempt",
      "after-attempt",
      "future",
      "invalid-start",
    ]
  ) {
    const f = await fixture();
    const previousCwd = Deno.cwd();
    Deno.chdir(`${f.tmp}/checkout`);
    try {
      const execution = {
        ...f.release.hostedRuntimes[0].execution!,
        id: WAVE,
        ...RUN,
        purpose: "bootstrap" as const,
      };
      f.release.hostedRuntimes[0].execution = execution;
      f.attempt.status = "completed";
      f.attempt.updated_at = new Date(T0 + 2_000).toISOString();
      const skipped = {
        ...f.jobs[0],
        id: 111354489906,
        name: "matrix_cell (${{ matrix.cellId }})",
        conclusion: "skipped",
        runner_id: null as number | null,
        runner_name: null as string | null,
        started_at: new Date(T0 + 1_000).toISOString(),
        completed_at: ISO,
        steps: [],
      };
      if (fault === "executed") skipped.conclusion = "success";
      if (fault === "runner") {
        skipped.runner_id = 7;
        skipped.runner_name = "assigned-runner";
      }
      if (fault === "active") skipped.status = "in_progress";
      if (fault === "incomplete") skipped.completed_at = "";
      if (fault === "foreign") skipped.run_id = 99;
      if (fault === "before-attempt") {
        skipped.completed_at = new Date(T0 - 1).toISOString();
      }
      if (fault === "after-attempt") {
        skipped.started_at = new Date(T0 + 3_000).toISOString();
      }
      if (fault === "future") {
        skipped.started_at = new Date(T0 + 120_000).toISOString();
        skipped.completed_at = skipped.started_at;
      }
      if (fault === "invalid-start") skipped.started_at = "not-a-timestamp";
      f.jobs.push(skipped);
      if (fault === "duplicate") f.jobs.push(skipped);
      const transport = createActionsMatrixArtifactTransport({
        state: f.state,
        token: "fake-local-token",
        clock: { now: () => T0 + 10_000 },
        artifactRoot: `${f.tmp}/skipped`,
        http: (request) =>
          fault === "truncated" &&
            new URL(request.url).pathname.endsWith("/jobs")
            ? Promise.resolve({
              status: 200,
              headers: new Headers(),
              bodyText: JSON.stringify({
                total_count: f.jobs.length + 1,
                jobs: f.jobs,
              }),
            })
            : f.http(request),
      });
      if (fault === "none") {
        assert.equal(
          await transport.confirmCompletedExecution!(execution),
          true,
        );
      } else {await assert.rejects(() =>
          transport.confirmCompletedExecution!(execution), fault);}
    } finally {
      Deno.chdir(previousCwd);
      await Deno.remove(f.tmp, { recursive: true });
    }
  }
});

Deno.test("matrix verification completion: exact held verification survives pointer advance", async () => {
  for (
    const purpose of ["bootstrap", "prior", "candidate", "rollback"] as const
  ) {
    const f = await fixture();
    const previousCwd = Deno.cwd();
    Deno.chdir(`${f.tmp}/checkout`);
    try {
      const runtime = f.release.hostedRuntimes[0];
      const execution = {
        ...runtime.execution!,
        id: WAVE,
        ...RUN,
        purpose,
        releaseId: purpose === "bootstrap" ? null : "verification-release",
      };
      runtime.execution = null;
      runtime.lastExecutionProof = parseHostedExecutionSettlementV1({
        execution,
        workflowId: HOSTED_SUPERVISOR_WORKFLOW_ID,
        workflowPath: HOSTED_SUPERVISOR_WORKFLOW_PATH,
        repository: "ubiquity/sentinel",
        ref: "refs/heads/sentinel-supervisor",
        jobId: 401,
        startedAt: T0,
        finishedAt: T0,
        observedAt: T0 + 10_000,
        outcome: "failed",
        startupReady: false,
        settled: true,
        baseSha: null,
        terminalAt: null,
        logDigest: "a".repeat(64),
      });
      runtime.activeRevision = SHA3;
      runtime.generation++;
      f.attempt.status = "completed";
      const transport = createActionsMatrixArtifactTransport({
        state: f.state,
        token: "fake-local-token",
        http: f.http,
        clock: { now: () => T0 + 10_000 },
        artifactRoot: `${f.tmp}/verification`,
      });
      assert.equal(await transport.confirmCompletedExecution!(execution), true);
      runtime.execution = {
        ...execution,
        id: "99:1:repair",
        runId: 99,
        runAttempt: 1,
        revision: SHA3,
        generation: runtime.generation,
      };
      await assert.rejects(() =>
        transport.confirmCompletedExecution!(execution)
      );
    } finally {
      Deno.chdir(previousCwd);
      await Deno.remove(f.tmp, { recursive: true });
    }
  }
});

Deno.test("matrix completion: exact settled latest authenticates and custody failures refuse", async () => {
  for (
    const fault of [
      "none",
      "pending",
      "missing",
      "foreign-owner",
      "generation",
      "revision",
      "truncated",
      "unavailable",
      "drift",
    ]
  ) {
    const f = await fixture();
    const previousCwd = Deno.cwd();
    Deno.chdir(`${f.tmp}/checkout`);
    try {
      const runtime = f.release.hostedRuntimes[0];
      const execution = { ...runtime.execution!, id: WAVE, ...RUN };
      runtime.execution = null;
      runtime.lastExecutionProof = parseHostedExecutionSettlementV1({
        execution,
        workflowId: HOSTED_SUPERVISOR_WORKFLOW_ID,
        workflowPath: HOSTED_SUPERVISOR_WORKFLOW_PATH,
        repository: "ubiquity/sentinel",
        ref: "refs/heads/sentinel-supervisor",
        jobId: null,
        finishedAt: T0,
        observedAt: T0 + 10_000,
        outcome: "not_started",
        evidenceDigest: "a".repeat(64),
      });
      f.attempt.status = "completed";
      if (fault === "missing") runtime.lastExecutionProof = null;
      if (fault === "foreign-owner") {
        runtime.execution = {
          ...execution,
          id: "99:1:repair",
          runId: 99,
          runAttempt: 1,
        };
      }
      if (fault === "generation") runtime.generation++;
      if (fault === "revision") runtime.activeRevision = SHA3;
      if (fault === "pending") f.attempt.status = "in_progress";
      const transport = createActionsMatrixArtifactTransport({
        state: f.state,
        token: "fake-local-token",
        clock: { now: () => T0 + 10_000 },
        artifactRoot: `${f.tmp}/completion`,
        http: (request) => {
          if (fault === "unavailable") {
            return Promise.resolve({
              status: 503,
              headers: new Headers(),
              bodyText: "",
            });
          }
          if (
            fault === "truncated" &&
            new URL(request.url).pathname.endsWith("/jobs")
          ) {
            return Promise.resolve({
              status: 200,
              headers: new Headers(),
              bodyText: JSON.stringify({
                total_count: f.jobs.length + 1,
                jobs: f.jobs,
              }),
            });
          }
          if (
            fault === "drift" && new URL(request.url).pathname.endsWith("/jobs")
          ) {
            runtime.execution = {
              ...execution,
              id: "99:1:repair",
              runId: 99,
              runAttempt: 1,
            };
          }
          return f.http(request);
        },
      });
      if (fault === "none") {
        assert.equal(
          await transport.confirmCompletedExecution!(execution),
          true,
        );
      } else {await assert.rejects(() =>
          transport.confirmCompletedExecution!(execution), fault);}
    } finally {
      Deno.chdir(previousCwd);
      await Deno.remove(f.tmp, { recursive: true });
    }
  }
});

Deno.test("matrix artifacts: exact identity and native provenance conflicts refuse", async (t) => {
  const cases: [string, (rig: Awaited<ReturnType<typeof fixture>>) => void][] =
    [
      ["native run", (rig) => {
        rig.attempt.id = 72;
      }],
      ["native attempt", (rig) => {
        rig.attempt.run_attempt = 1;
      }],
      ["launcher", (rig) => {
        rig.attempt.head_sha = SHA2;
      }],
      ["workflow", (rig) => {
        rig.attempt.workflow_id = 1;
      }],
      ["branch", (rig) => {
        rig.attempt.head_branch = "development";
      }],
      ["workflow path", (rig) => {
        rig.attempt.path = ".github/workflows/other.yml";
      }],
      ["repository", (rig) => {
        rig.attempt.repository = { id: 123, full_name: "attacker/sentinel" };
      }],
      ["task", (rig) => {
        rig.input.requests[0].taskId = "wrong" as never;
      }],
      ["reservation", (rig) => {
        rig.input.requests[0].reservationId = "b".repeat(64);
      }],
      ["base", (rig) => {
        rig.input.requests[0].expectedBase = SHA2;
      }],
      ["attempt grant", (rig) => {
        rig.input.requests[0].attempt = 2;
      }],
      ["intent", (rig) => {
        rig.input.requests[0].intentKey = "impl:wrong";
      }],
      ["runtime", (rig) => {
        rig.input.runtimeSha = SHA2;
      }],
      ["native cell job attempt", (rig) => {
        rig.jobs[1].run_attempt = 1;
      }],
      ["spoofed duplicate planner", (rig) => {
        rig.logs.set(401, rig.logs.get(401)! + rig.logs.get(401)!);
      }],
      ["spoofed duplicate cell", (rig) => {
        rig.logs.set(402, rig.logs.get(402)! + rig.logs.get(402)!);
      }],
      ["artifact provenance", (rig) => {
        rig.artifacts[1].workflow_run = { id: 72 };
      }],
      ["artifact archive digest", (rig) => {
        rig.artifacts[1].digest = `sha256:${"0".repeat(64)}`;
      }],
      ["conflicting names", (rig) => {
        rig.artifacts.push({ ...rig.artifacts[1], id: 503 });
      }],
      ["retained execution disagreement", (rig) => {
        rig.release.hostedRuntimes[0].execution = {
          ...rig.release.hostedRuntimes[0].execution!,
          id: WAVE,
          runId: 71,
          runAttempt: 2,
          revision: SHA2,
        };
      }],
    ];
  for (const [name, change] of cases) {
    await t.step(name, async () => {
      const rig = await fixture();
      try {
        change(rig);
        await assert.rejects(
          () => rig.transport.recover(rig.input),
          /provenance unavailable or conflicting/,
        );
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test("matrix artifacts: archive path, file type and content conflicts refuse", async (t) => {
  for (
    const [name, entries] of [
      [
        "traversal",
        (
          rig: Awaited<ReturnType<typeof fixture>>,
        ) => [{ name: "../result.json", content: bytes(rig.result) }],
      ],
      [
        "symlink",
        (
          rig: Awaited<ReturnType<typeof fixture>>,
        ) => [{
          name: "result.json",
          content: bytes(rig.result),
          unixMode: 0o120777,
        }],
      ],
      [
        "unexpected file",
        (
          rig: Awaited<ReturnType<typeof fixture>>,
        ) => [{ name: "secret.txt", content: bytes(rig.result) }],
      ],
      [
        "bundle hash",
        (
          rig: Awaited<ReturnType<typeof fixture>>,
        ) => [{ name: "result.json", content: bytes(rig.result) }, {
          name: rig.result.bundle!.file,
          content: new Uint8Array([1, 2, 3]),
        }],
      ],
      [
        "result hash",
        (
          rig: Awaited<ReturnType<typeof fixture>>,
        ) => [{
          name: "result.json",
          content: bytes({ ...rig.result, runtimeSha: SHA2 }),
        }, { name: rig.result.bundle!.file, content: rig.bundle }],
      ],
    ] as const
  ) {
    await t.step(name, async () => {
      const rig = await fixture();
      try {
        await rig.setArchive(502, rig.cellName, await zip(entries(rig)));
        await assert.rejects(
          () => rig.transport.recover(rig.input),
          /provenance unavailable or conflicting/,
        );
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test("matrix artifacts: missing artifact preserves charged intent and never proves not submitted", async () => {
  const rig = await fixture();
  try {
    rig.artifacts.splice(1, 1);
    const before = canonicalStringify(rig.repair);
    const waves = await rig.transport.recover(rig.input);
    assert.equal(waves[0].results.length, 0);
    assert.equal(canonicalStringify(rig.repair), before);
    assert.equal(rig.repair.reservations[0].outcome, "reserved");
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix artifacts: unrelated historical launcher wave cannot block admitted old-wave recovery", async () => {
  const rig = await fixture();
  try {
    const unrelated = {
      ...rig.plan,
      waveId: "70:1:repair",
      run: { runId: 70, runAttempt: 1, launcherSha: SHA2 },
      cells: [{ ...rig.cell, reservationId: "b".repeat(64) }],
    };
    await rig.setArchive(
      503,
      "sentinel-matrix-plan-70-1",
      await zip([{ name: "plan.json", content: bytes(unrelated) }]),
    );
    rig.artifacts.push({
      id: 504,
      name: "sentinel-matrix-plan-69-1",
      expired: true,
    });
    const { currentRun: _oldRun, ...input } = rig.input;
    const recovered = await rig.transport.recover(input);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].results.length, 1);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix artifacts: post-ingest candidate preservation hydrates on fresh runner without replay", async (t) => {
  const rig = await fixture();
  try {
    const first = await rig.transport.recover(rig.input);
    await Deno.remove(first[0].bundlesDir, { recursive: true });
    const task = rig.repair.work[0];
    const startedAt = T0 + 1_000;
    const intent = {
      kind: "candidate_preservation" as const,
      key: rig.cell.intentKey,
      startedAt,
      branch: await candidatePreservationRef(REPO, task.id, rig.cell.intentKey),
      expectedHead: rig.result.bundle!.head,
      observedBase: SHA1,
      pr: null,
      requestId: RESERVATION,
      resultId: null,
    };
    const target = {
      ...task.target,
      head: rig.result.bundle!.head,
      checkpoint: null,
      candidateState: { preserved: null, publishedHead: null },
    };
    rig.repair.work[0] = workRecord(task.id, {
      ...task,
      target,
      intent,
      updatedAt: startedAt,
    });
    rig.repair.reservations[0] = {
      ...rig.repair.reservations[0],
      outcome: "submitted",
      settledAt: startedAt,
    };
    rig.repair.updatedAt = startedAt;
    parseRepairStateSnapshotV1(rig.repair);
    const before = canonicalStringify(rig.repair);
    const recovered = await rig.transport.recover(rig.input);
    assert.equal(recovered[0].results.length, 1);
    assert.notEqual(recovered[0].bundlesDir, first[0].bundlesDir);
    assert.deepEqual(
      await Deno.readFile(
        recovered[0].bundlesDir + "/" + rig.result.bundle!.file,
      ),
      rig.bundle,
    );
    assert.equal(canonicalStringify(rig.repair), before);
    for (const outcome of ["reserved", "ambiguous"] as const) {
      await t.step(
        outcome + " cannot authorize candidate hydration",
        async () => {
          rig.repair.reservations[0].outcome = outcome;
          rig.repair.reservations[0].settledAt = outcome === "reserved"
            ? null
            : startedAt;
          await assert.rejects(() => rig.transport.recover(rig.input));
          rig.repair.reservations[0].outcome = "submitted";
          rig.repair.reservations[0].settledAt = startedAt;
        },
      );
    }
    await t.step(
      "persisted candidate mismatch refuses authentic bundle",
      async () => {
        rig.repair.work[0].target.head = SHA1;
        rig.repair.work[0].intent!.expectedHead = SHA1;
        await assert.rejects(() => rig.transport.recover(rig.input));
        rig.repair.work[0].target.head = rig.result.bundle!.head;
        rig.repair.work[0].intent!.expectedHead = rig.result.bundle!.head;
      },
    );
    await t.step("wrong preservation operation ref refuses", async () => {
      rig.repair.work[0].intent!.branch = "refs/heads/sentinel-candidates/" +
        "c".repeat(64);
      await assert.rejects(() => rig.transport.recover(rig.input));
    });
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix artifacts: production artifact HTTP recovers incompressible nine MiB bundle within finite limit", async () => {
  const rig = await fixture();
  try {
    const payload = new Uint8Array(9 * 1024 * 1024);
    for (let offset = 0; offset < payload.length; offset += 65_536) {
      crypto.getRandomValues(payload.subarray(offset, offset + 65_536));
    }
    const repository = rig.tmp + "/source";
    const gitHome = rig.tmp + "/git-home";
    await Deno.mkdir(repository);
    await Deno.mkdir(gitHome);
    const environment = testGitEnv(gitHome);
    const git = async (args: string[]) => {
      const result = await gitRun(repository, args, environment);
      assert.equal(result.ok, true, result.stderr);
      return result.stdout.trim();
    };
    await git(["init", "--initial-branch", "fixture"]);
    await git(["commit", "--allow-empty", "-m", "base"]);
    const base = await git(["rev-parse", "HEAD"]) as GitSha;
    await Deno.writeFile(repository + "/blob.bin", payload);
    await git(["add", "blob.bin"]);
    await git(["commit", "-m", "candidate"]);
    const head = await git(["rev-parse", "HEAD"]) as GitSha;
    const bundlePath = rig.tmp + "/candidate.bundle";
    await git(["bundle", "create", bundlePath, "HEAD", "^" + base]);
    const bundle = await Deno.readFile(bundlePath);
    rig.cell.expectedBase = base;
    rig.cell.request.base = base;
    rig.cell.requestDigest = await matrixDigestV1(rig.cell.request);
    rig.input.requests[0].expectedBase = base;
    rig.repair.work[0].target.base = base;
    rig.repair.work[0].intent!.observedBase = base;
    rig.repair.reservations[0].head = base;
    rig.result.requestDigest = rig.cell.requestDigest;
    rig.result.bundle!.head = head;
    rig.result.receipt!.candidate!.head = head;
    rig.result.receipt!.candidate!.changedPaths = ["blob.bin"];
    rig.plannerMarker.planDigest = await matrixDigestV1(rig.plan);
    rig.logs.set(401, ISO + " " + JSON.stringify(rig.plannerMarker) + "\n");
    await rig.setArchive(
      501,
      rig.planName,
      await zip([
        { name: "plan.json", content: bytes(rig.plan) },
      ]),
    );
    rig.result.bundle!.digest = await digest(bundle);
    rig.cellMarker.bundleDigest = rig.result.bundle!.digest;
    rig.cellMarker.resultDigest = await matrixDigestV1(rig.result);
    rig.logs.set(402, ISO + " " + JSON.stringify(rig.cellMarker) + "\n");
    const archive = await zip([
      { name: "result.json", content: bytes(rig.result) },
      { name: rig.result.bundle!.file, content: bundle },
    ]);
    assert.ok(archive.length > 8 * 1024 * 1024);
    await rig.setArchive(502, rig.cellName, archive);
    const recovered = await rig.transport.recover(rig.input);
    const actual = await Deno.readFile(
      recovered[0].bundlesDir + "/" + rig.result.bundle!.file,
    );
    assert.equal(actual.length, bundle.length);
    assert.equal(await digest(actual), rig.result.bundle!.digest);
    await git([
      "bundle",
      "verify",
      recovered[0].bundlesDir + "/" + rig.result.bundle!.file,
    ]);
    const beforeOversize = rig.calls.length;
    rig.artifacts[1].size_in_bytes = (64 + 2 + 1) * 1024 * 1024 + 1;
    await assert.rejects(() => rig.transport.recover(rig.input));
    assert.equal(
      rig.calls.slice(beforeOversize).some((call) =>
        new URL(call.url).pathname.endsWith("/archive/502")
      ),
      false,
    );
    const ordinary = fetchHttpTransport(() =>
      Promise.resolve(new Response(bundle.slice()))
    );
    await assert.rejects(() =>
      ordinary({
        method: "GET",
        url: "https://api.github.com/archive",
        headers: new Map(),
        body: null,
        responseType: "bytes",
      })
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix artifacts: review correction checkout binds prior candidate before and new candidate after ingestion", async (t) => {
  const rig = await fixture();
  try {
    const finding = {
      id: "correction-finding",
      severity: "P1",
      path: "fix.ts",
      message: "preserve requested behavior",
    };
    rig.repair.work[0].target.head = SHA2;
    rig.repair.work[0].target.pr = 12;
    rig.repair.work[0].createdAt = T0 - 10_000;
    rig.repair.reviews.push(reviewReceipt("correction-review", {
      pullRequest: { number: 12, head: SHA2, base: SHA1 },
      outcome: "completed",
      observedReviewer: "chatgpt-codex-connector[bot]",
      resultId: "correction-result",
      summary: "one required correction",
      findings: [{
        ...finding,
        fingerprint: await matrixDigestV1(finding),
        resolved: false,
        resolutionEvidence: null,
      }],
      unresolvedSeverities: ["P1"],
      submittedAt: T0 - 2_000,
      completedAt: T0 - 1_000,
      observedAt: T0 - 500,
    }));
    rig.cell.request.checkoutBase = SHA2;
    rig.cell.request.reviewFindings = [{
      severity: "P1",
      path: finding.path,
      message: finding.message,
    }];
    rig.cell.requestDigest = await matrixDigestV1(rig.cell.request);
    rig.result.requestDigest = rig.cell.requestDigest;
    rig.result.bundle!.head = SHA3;
    rig.result.receipt!.candidate!.head = SHA3;
    rig.plannerMarker.planDigest = await matrixDigestV1(rig.plan);
    rig.logs.set(401, ISO + " " + JSON.stringify(rig.plannerMarker) + "\n");
    rig.cellMarker.resultDigest = await matrixDigestV1(rig.result);
    rig.logs.set(402, ISO + " " + JSON.stringify(rig.cellMarker) + "\n");
    await rig.setArchive(
      501,
      rig.planName,
      await zip([
        { name: "plan.json", content: bytes(rig.plan) },
      ]),
    );
    await rig.setArchive(
      502,
      rig.cellName,
      await zip([
        { name: "result.json", content: bytes(rig.result) },
        { name: rig.result.bundle!.file, content: rig.bundle },
      ]),
    );
    parseRepairStateSnapshotV1(rig.repair);
    const first = await rig.transport.recover(rig.input);
    assert.equal(first[0].results[0].bundle!.head, SHA3);
    await t.step("wrong authoritative prior head refuses", async () => {
      rig.repair.work[0].target.head = SHA3;
      await assert.rejects(() => rig.transport.recover(rig.input));
      rig.repair.work[0].target.head = SHA2;
    });
    await t.step(
      "post-ingest new head does not replace prior checkout identity",
      async () => {
        const task = rig.repair.work[0];
        task.target.head = SHA3;
        task.target.candidateState = { preserved: null, publishedHead: SHA2 };
        task.intent = {
          kind: "candidate_preservation",
          key: rig.cell.intentKey,
          startedAt: T0 + 1_000,
          branch: await candidatePreservationRef(
            REPO,
            task.id,
            rig.cell.intentKey,
          ),
          expectedHead: SHA3,
          observedBase: SHA1,
          pr: null,
          requestId: RESERVATION,
          resultId: null,
        };
        rig.repair.reservations[0].outcome = "submitted";
        rig.repair.reservations[0].settledAt = T0 + 1_000;
        parseRepairStateSnapshotV1(rig.repair);
        const recovered = await rig.transport.recover(rig.input);
        assert.equal(recovered[0].results[0].bundle!.head, SHA3);
      },
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
