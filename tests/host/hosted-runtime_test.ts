/**
 * Hosted runtime launcher: real temporary Git checkouts and release-state
 * stores, plus one isolated fixture child executed through the ACTUAL
 * DenoReplayRuntime owned-group border. No GitHub, model, deployment or
 * network call is made; this is never live Actions acceptance.
 */
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { parseHostedRuntimeTerminalV1 } from "../../src/contracts/hosted-execution.ts";
import { parseHostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import { HOSTED_RUNTIME_ID } from "../../src/contracts/hosted-supervisor.ts";
import type { HostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import type { Clock } from "../../src/contracts/ports.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import type {
  ReplayCommandInputV1,
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";
import {
  HOSTED_RUNTIME_CHILD_ENTRYPOINT,
  HOSTED_RUNTIME_CHILD_ENV_KEYS,
  HOSTED_RUNTIME_DEADLINE_MS,
  HOSTED_RUNTIME_MAX_OUTPUT_BYTES,
  HOSTED_RUNTIME_STATIC_IDENTITY,
  HOSTED_RUNTIME_WORKFLOW_REF,
  parseHostedEnvironment,
  readHostedRuntimeExecution,
  runHostedRuntimeLauncher,
} from "../../src/host/hosted-runtime.ts";
import type {
  HostedRuntimeIdentityV1,
  HostedRuntimeLauncherInputV1,
  HostedRuntimeLauncherResultV1,
} from "../../src/host/hosted-runtime.ts";
import { createReleaseStateStore } from "../../src/state/mod.ts";
import type { ReleaseGitStateStore } from "../../src/state/mod.ts";
import { gitRun, makeRemoteCtx, T0, testGitEnv } from "../state/helpers.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/host\/hosted-runtime_test\.ts$/,
  "",
);

const RUN_ID = 7;
const RUN_ATTEMPT = 2;
const FIXED_LAUNCHER = "a".repeat(40) as GitSha;
const OTHER_REVISION = "f".repeat(40) as GitSha;
const OBSERVED_BASE = "b".repeat(40) as GitSha;

class FakeClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Returns a valid start instant, then a backward finish instant. */
class BackwardClock implements Clock {
  private calls = 0;
  now(): number {
    this.calls += 1;
    return this.calls === 1 ? T0 : T0 - 1;
  }
}

/** One injected process border: real bounded Git plus the child invocation. */
class BorderRuntime implements ReplayRuntimeV1 {
  readonly calls: ReplayCommandInputV1[] = [];
  child: ReplayCommandResultV1 | null = null;
  realChild = false;
  throwOnChild = false;
  private readonly real = new DenoReplayRuntime(Deno.execPath());

  async run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
    this.calls.push(input);
    if (input.args.includes(HOSTED_RUNTIME_CHILD_ENTRYPOINT)) {
      if (this.throwOnChild) throw new Error("forced child border failure");
      if (this.realChild) return await this.real.run(input);
      if (this.child === null) throw new Error("no canned child result");
      return this.child;
    }
    return await this.real.run(input);
  }

  childCalls(): ReplayCommandInputV1[] {
    return this.calls.filter((call) =>
      call.args.includes(HOSTED_RUNTIME_CHILD_ENTRYPOINT)
    );
  }

  gitCalls(): ReplayCommandInputV1[] {
    return this.calls.filter((call) => call.executable === "/usr/bin/git");
  }
}

function hostedEnv(launcherSha: GitSha): Record<string, string> {
  return {
    GITHUB_RUN_ID: String(RUN_ID),
    GITHUB_RUN_ATTEMPT: String(RUN_ATTEMPT),
    GITHUB_REPOSITORY: "ubiquity/sentinel",
    GITHUB_REF: "refs/heads/sentinel-supervisor",
    GITHUB_SHA: launcherSha,
    GITHUB_WORKFLOW_SHA: launcherSha,
    GITHUB_WORKFLOW_REF: HOSTED_RUNTIME_WORKFLOW_REF,
    GITHUB_JOB: "repair",
    GITHUB_TOKEN: "test-native-token",
    UOS_AI_TOKEN: "test-model-token",
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    HOME: "/tmp",
  };
}

function exited(
  stdout: string,
  exitCode = 0,
  overrides: Partial<ReplayCommandResultV1> = {},
): ReplayCommandResultV1 {
  return {
    outcome: "exited",
    exitCode,
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
    truncated: false,
    settled: true,
    detail: "",
    ...overrides,
  };
}

function childLine(
  execution: HostedExecutionIntentV1,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    status: "ran",
    outcome: { status: "idle", detail: "no declared work" },
    controllerSha: execution.revision,
    baseSha: OBSERVED_BASE,
    login: "github-actions[bot]",
    startupReady: true,
    ciApproval: { approved: 0, pending: 0, unavailable: 0 },
    execution,
    ...overrides,
  });
}

async function makeCheckout(
  dir: string,
  env: Record<string, string>,
  files: Record<string, string>,
): Promise<GitSha> {
  await Deno.mkdir(dir, { recursive: true });
  await gitRun(dir, ["init", "-q"], env);
  for (const [name, text] of Object.entries(files)) {
    const full = `${dir}/${name}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeTextFile(full, text);
  }
  await gitRun(dir, ["add", "-A"], env);
  const committed = await gitRun(dir, ["commit", "-q", "-m", "fixture"], env);
  assert.ok(committed.ok, committed.stderr);
  const head = await gitRun(dir, ["rev-parse", "HEAD"], env);
  assert.ok(head.ok, head.stderr);
  return head.stdout.trim() as GitSha;
}

interface RigV1 {
  launcherDir: string;
  runtimeDir: string;
  identity: HostedRuntimeIdentityV1;
  execution: HostedExecutionIntentV1;
  env: Record<string, string>;
  release: ReleaseGitStateStore;
  clock: FakeClock;
  process: BorderRuntime;
  releaseHead(): Promise<GitSha | null>;
  cleanup(): Promise<void>;
}

async function makeRig(
  options: {
    runtimeFiles?: Record<string, string>;
    executionRevision?: GitSha;
  } = {},
): Promise<RigV1> {
  const root = await Deno.makeTempDir({
    prefix: "sentinel-hosted-runtime-",
    dir: ROOT,
  });
  const env = testGitEnv(`${root}/git-home`);
  await Deno.mkdir(`${root}/git-home`, { recursive: true });
  const launcherDir = `${root}/launcher`;
  const runtimeDir = `${root}/runtime`;
  const launcherSha = await makeCheckout(launcherDir, env, {
    "README.md": "launcher\n",
    ".gitignore": ".sentinel/\n",
  });
  const runtimeSha = await makeCheckout(
    runtimeDir,
    env,
    options.runtimeFiles ?? {
      "README.md": "runtime\n",
      ".gitignore": ".sentinel/\n",
    },
  );
  const remote = await makeRemoteCtx(root, env);
  const scratchDir = `${root}/state-scratch`;
  await Deno.mkdir(scratchDir, { recursive: true });
  const release = createReleaseStateStore({
    scratchDir,
    remoteUrl: remote.remoteUrl,
  });
  const identity: HostedRuntimeIdentityV1 = {
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    launcherSha,
    job: "repair",
  };
  const execution = parseHostedExecutionIntentV1({
    id: `${RUN_ID}:${RUN_ATTEMPT}:repair`,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    launcherSha,
    purpose: "ordinary",
    revision: options.executionRevision ?? runtimeSha,
    generation: 1,
    releaseId: null,
    createdAt: T0,
  });
  return {
    launcherDir,
    runtimeDir,
    identity,
    execution,
    env: hostedEnv(launcherSha),
    release,
    clock: new FakeClock(T0),
    process: new BorderRuntime(),
    releaseHead: async () => {
      const read = await release.readRelease();
      assert.ok(read.ok, JSON.stringify(read));
      if (!read.ok) throw new Error("release read failed");
      return read.value.status === "found" ? read.value.head : null;
    },
    cleanup: async () => {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

async function seedRelease(rig: RigV1): Promise<void> {
  const snapshot = parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    releases: [],
    hostedRuntimes: [{
      version: "v1",
      kind: "hosted_runtime",
      id: HOSTED_RUNTIME_ID,
      activeRevision: rig.execution.revision,
      generation: rig.execution.generation,
      lastHealthyProof: null,
      lastExecutionProof: null,
      nextOrdinaryAt: T0,
      execution: rig.execution,
      createdAt: T0,
      updatedAt: T0,
    }],
    hostedReleases: [],
    githubCooldowns: [],
  });
  const written = await rig.release.writeRelease(snapshot, null);
  assert.ok(
    written.ok && written.value.status === "applied",
    JSON.stringify(written),
  );
}

function launch(
  rig: RigV1,
  overrides: Partial<HostedRuntimeLauncherInputV1> = {},
): Promise<HostedRuntimeLauncherResultV1> {
  return runHostedRuntimeLauncher({
    state: rig.release,
    clock: rig.clock,
    env: rig.env,
    launcherDir: rig.launcherDir,
    runtimeDir: rig.runtimeDir,
    denoExecutable: Deno.execPath(),
    process: rig.process,
    ...overrides,
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Real fixture child that writes a marker, leaves a descendant, then a record. */
function validFixtureScript(): string {
  return `const decoder = new TextDecoder();
const runId = Number(Deno.env.get("GITHUB_RUN_ID"));
const runAttempt = Number(Deno.env.get("GITHUB_RUN_ATTEMPT"));
const launcherSha = Deno.env.get("GITHUB_SHA");
const head = decoder.decode(new Deno.Command("git", {
  args: ["rev-parse", "HEAD"],
  cwd: Deno.cwd(),
}).outputSync().stdout).trim();
const execution = {
  id: runId + ":" + runAttempt + ":repair",
  runId,
  runAttempt,
  launcherSha,
  purpose: "ordinary",
  revision: head,
  generation: 1,
  releaseId: null,
  createdAt: ${T0},
};
Deno.writeTextFileSync("child-ran.txt", "ran\\n");
// A descendant that outlives the leader holds the captured pipe: settlement
// must span the whole owned group, not just the direct child exit.
new Deno.Command("sleep", { args: ["0.3"] }).spawn();
console.log(JSON.stringify({
  status: "ran",
  outcome: { status: "idle", detail: "fixture" },
  controllerSha: head,
  baseSha: "${OBSERVED_BASE}",
  login: "github-actions[bot]",
  startupReady: true,
  ciApproval: { approved: 0, pending: 0, unavailable: 0 },
  execution,
}));
`;
}

/** Real fixture child attempting to forge the wrapper terminal kind. */
function forgedFixtureScript(): string {
  return `Deno.writeTextFileSync("child-ran.txt", "ran\\n");
console.log(JSON.stringify({
  version: "v1",
  kind: "hosted_runtime_terminal",
  outcome: "healthy",
  startupReady: true,
  settled: true,
  baseSha: null,
}));
`;
}

Deno.test("hosted runtime: native identity parsing is exact and rejects every foreign field", () => {
  const env = hostedEnv(FIXED_LAUNCHER);
  const identity = parseHostedEnvironment(env, "repair");
  assert.equal(identity.runId, RUN_ID);
  assert.equal(identity.runAttempt, RUN_ATTEMPT);
  assert.equal(identity.launcherSha, FIXED_LAUNCHER);
  assert.equal(identity.job, "repair");
  assert.equal(
    parseHostedEnvironment({ ...env, GITHUB_JOB: "prepare" }, "prepare").job,
    "prepare",
  );

  const bad: Record<string, string | undefined>[] = [
    { ...env, GITHUB_JOB: "finalize" },
    { ...env, GITHUB_REPOSITORY: "ubiquity/other" },
    { ...env, GITHUB_REF: "refs/heads/main" },
    {
      ...env,
      GITHUB_WORKFLOW_REF:
        "ubiquity/sentinel/.github/workflows/other.yml@refs/heads/sentinel-supervisor",
    },
    { ...env, GITHUB_WORKFLOW_SHA: "c".repeat(40) },
    { ...env, GITHUB_SHA: "not-a-sha" },
    { ...env, GITHUB_RUN_ID: "0" },
    { ...env, GITHUB_RUN_ID: "1e3" },
    { ...env, GITHUB_RUN_ATTEMPT: "-1" },
    { ...env, GITHUB_RUN_ATTEMPT: "1.5" },
    { ...env, GITHUB_RUN_ID: undefined },
  ];
  for (const candidate of bad) {
    assert.throws(
      () => parseHostedEnvironment(candidate, "repair"),
      { message: HOSTED_RUNTIME_STATIC_IDENTITY },
      JSON.stringify(candidate),
    );
  }
});

Deno.test("hosted runtime: the saved pointer execution is read strictly from real release state", async () => {
  const rig = await makeRig();
  try {
    // Absent release state is a refusal, never an inferred intent.
    await assert.rejects(
      readHostedRuntimeExecution({
        state: rig.release,
        identity: rig.identity,
        controllerSha: rig.execution.revision,
      }),
    );
    await seedRelease(rig);
    const execution = await readHostedRuntimeExecution({
      state: rig.release,
      identity: rig.identity,
      controllerSha: rig.execution.revision,
    });
    assert.equal(execution.id, `${RUN_ID}:${RUN_ATTEMPT}:repair`);
    assert.equal(
      canonicalStringify(execution),
      canonicalStringify(rig.execution),
    );

    const mismatches: {
      identity?: HostedRuntimeIdentityV1;
      controllerSha?: GitSha;
    }[] = [
      { identity: { ...rig.identity, runAttempt: RUN_ATTEMPT + 1 } },
      { identity: { ...rig.identity, runId: RUN_ID + 1 } },
      { identity: { ...rig.identity, launcherSha: OTHER_REVISION } },
      { controllerSha: OTHER_REVISION },
    ];
    for (const mismatch of mismatches) {
      await assert.rejects(
        readHostedRuntimeExecution({
          state: rig.release,
          identity: mismatch.identity ?? rig.identity,
          controllerSha: mismatch.controllerSha ?? rig.execution.revision,
        }),
      );
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: a malformed native identity launches nothing at all", async () => {
  const process = new BorderRuntime();
  const inert = {
    readRepair: () => {
      throw new Error("state must not be read");
    },
    readRelease: () => {
      throw new Error("state must not be read");
    },
  };
  const result = await runHostedRuntimeLauncher({
    state: inert,
    clock: new FakeClock(T0),
    env: { ...hostedEnv(FIXED_LAUNCHER), GITHUB_JOB: "prepare" },
    launcherDir: "/nonexistent/launcher",
    runtimeDir: "/nonexistent/runtime",
    denoExecutable: "deno",
    process,
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.terminal, null);
  assert.equal(process.calls.length, 0);
});

Deno.test("hosted runtime: a dirty source checkout or stale pointer launches no child and writes no state", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const head = await rig.releaseHead();

    await Deno.writeTextFile(`${rig.launcherDir}/untracked.txt`, "dirty\n");
    let result = await launch(rig);
    assert.equal(result.status, "unavailable");
    assert.equal(result.terminal, null);
    assert.equal(rig.process.childCalls().length, 0);

    await Deno.remove(`${rig.launcherDir}/untracked.txt`);
    await Deno.writeTextFile(`${rig.runtimeDir}/untracked.txt`, "dirty\n");
    result = await launch(rig);
    assert.equal(result.status, "unavailable");
    assert.equal(rig.process.childCalls().length, 0);
    assert.equal(await rig.releaseHead(), head);
  } finally {
    await rig.cleanup();
  }

  const stale = await makeRig({ executionRevision: OTHER_REVISION });
  try {
    await seedRelease(stale);
    const head = await stale.releaseHead();
    const result = await launch(stale);
    assert.equal(result.status, "unavailable");
    assert.equal(result.terminal, null);
    assert.equal(stale.process.childCalls().length, 0);
    assert.equal(await stale.releaseHead(), head);
  } finally {
    await stale.cleanup();
  }
});

Deno.test("hosted runtime: exact identity and clean source settle one healthy terminal and one fixed child", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    rig.process.child = exited(childLine(rig.execution));
    const result = await launch(rig);
    assert.equal(result.status, "healthy", JSON.stringify(result));
    const terminal = result.terminal;
    assert.ok(terminal !== null);
    if (terminal === null) throw new Error("unreachable");
    assert.deepEqual(terminal, parseHostedRuntimeTerminalV1(terminal));
    assert.equal(terminal.outcome, "healthy");
    assert.equal(terminal.startupReady, true);
    assert.equal(terminal.settled, true);
    assert.equal(terminal.baseSha, OBSERVED_BASE);
    assert.equal(terminal.controllerSha, rig.execution.revision);
    assert.equal(
      canonicalStringify(terminal.execution),
      canonicalStringify(rig.execution),
    );
    assert.ok(terminal.finishedAt >= terminal.startedAt);

    const childCalls = rig.process.childCalls();
    assert.equal(childCalls.length, 1);
    const child = childCalls[0];
    assert.equal(child.executable, Deno.execPath());
    assert.deepEqual(child.args, [
      "run",
      "-A",
      HOSTED_RUNTIME_CHILD_ENTRYPOINT,
    ]);
    assert.equal(child.cwd, await Deno.realPath(rig.runtimeDir));
    assert.equal(child.maxDurationMs, HOSTED_RUNTIME_DEADLINE_MS);
    assert.equal(child.maxOutputBytes, HOSTED_RUNTIME_MAX_OUTPUT_BYTES);
    assert.deepEqual(
      Object.keys(child.env).sort(),
      [...HOSTED_RUNTIME_CHILD_ENV_KEYS].sort(),
    );
    assert.equal("SENTINEL_SUPERVISOR_TOKEN" in child.env, false);
    assert.equal("GITHUB_OUTPUT" in child.env, false);
    assert.equal("GITHUB_ENV" in child.env, false);
    assert.equal(child.env.GITHUB_JOB, "repair");
    assert.equal(child.env.GITHUB_SHA, rig.identity.launcherSha);
    assert.equal(child.env.GITHUB_WORKFLOW_SHA, rig.identity.launcherSha);
    assert.equal(child.env.GITHUB_RUN_ID, String(RUN_ID));
    assert.equal(child.env.GITHUB_RUN_ATTEMPT, String(RUN_ATTEMPT));

    const gitCalls = rig.process.gitCalls();
    assert.ok(gitCalls.length >= 4);
    for (const call of gitCalls) {
      assert.equal(call.executable, "/usr/bin/git");
      assert.equal(call.args[0], "-c");
      assert.equal(call.args[1], "core.hooksPath=/dev/null");
      assert.ok(call.maxDurationMs > 0 && call.maxDurationMs <= 60_000);
      assert.ok(call.maxOutputBytes <= 64 * 1024);
      assert.equal("GITHUB_TOKEN" in call.env, false);
      assert.equal("GIT_CONFIG_COUNT" in call.env, false);
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: settled early failure is failed; unattestable zero exit is unavailable", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);

    rig.process.child = exited("", 3);
    let result = await launch(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.terminal?.outcome, "failed");
    assert.equal(result.terminal?.startupReady, false);
    assert.equal(result.terminal?.baseSha, null);
    assert.equal(result.terminal?.settled, true);

    rig.process.child = exited(
      childLine(rig.execution, { startupReady: false }),
      0,
    );
    result = await launch(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.terminal?.startupReady, false);
    assert.equal(result.terminal?.baseSha, OBSERVED_BASE);

    // An explicit child failure preserves its observed startup flag and base.
    rig.process.child = exited(
      childLine(rig.execution, {
        outcome: { status: "source_error", detail: "source unavailable" },
      }),
      0,
    );
    result = await launch(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.terminal?.startupReady, true);
    assert.equal(result.terminal?.baseSha, OBSERVED_BASE);

    // A healthy-looking record beside a nonzero exit is still failed, with the
    // observed metadata preserved rather than rewritten.
    rig.process.child = exited(childLine(rig.execution), 1);
    result = await launch(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.terminal?.startupReady, true);
    assert.equal(result.terminal?.baseSha, OBSERVED_BASE);

    // A zero exit with no attestable child record is uncertain, not healthy.
    rig.process.child = exited("", 0);
    result = await launch(rig);
    assert.equal(result.status, "unavailable");
    assert.equal(result.terminal, null);

    rig.process.child = exited(
      childLine(rig.execution, { outcome: { status: "step_limit", steps: 4 } }),
      0,
    );
    assert.equal((await launch(rig)).status, "healthy");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: duplicate, malformed, foreign or forged child records are unavailable", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const healthy = childLine(rig.execution);
    const forged = JSON.stringify({
      version: "v1",
      kind: "hosted_runtime_terminal",
      execution: rig.execution,
      controllerSha: rig.execution.revision,
      startedAt: T0,
      finishedAt: T0,
      outcome: "healthy",
      startupReady: true,
      settled: true,
      baseSha: OBSERVED_BASE,
    });
    for (
      const stdout of [
        `${healthy}\n${healthy}`,
        JSON.stringify({
          status: "ran",
          outcome: { status: "idle", detail: "missing keys" },
        }),
        JSON.stringify({ status: "completed" }),
        forged,
        `${healthy}\n${forged}`,
        childLine(rig.execution, { login: "attacker" }),
        childLine(rig.execution, {
          execution: { ...rig.execution, runId: RUN_ID + 1 },
        }),
        childLine(rig.execution, { controllerSha: OTHER_REVISION }),
      ]
    ) {
      rig.process.child = exited(stdout, 0);
      const result = await launch(rig);
      assert.equal(result.status, "unavailable", stdout);
      assert.equal(result.terminal, null, stdout);
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: a truncated status record is refused while legitimate noise is tolerated", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const healthy = childLine(rig.execution);
    const truncated =
      '{"status":"ran","outcome":{"status":"idle","detail":"x"}';
    for (
      const stdout of [
        `${truncated}\n${healthy}`,
        `${healthy}\n${truncated}`,
        '{"status":"ra',
        '{"status":',
      ]
    ) {
      rig.process.child = exited(stdout, 0);
      const result = await launch(rig);
      assert.equal(result.status, "unavailable", stdout);
      assert.equal(result.terminal, null, stdout);
    }

    // Legitimate preflight records and plain log noise carry no top-level
    // status and must not disturb the one valid child record.
    const preflight =
      '{"kind":"sentinel_startup_preflight","stage":"resolve_codex","codexExecutable":"/usr/bin/codex"}';
    rig.process.child = exited(
      `${preflight}\nordinary log noise\n${healthy}\n{"kind":"sentinel_startup_preflight","pass":true}\n`,
      0,
    );
    const result = await launch(rig);
    assert.equal(result.status, "healthy", JSON.stringify(result));
    assert.equal(result.terminal?.outcome, "healthy");
    assert.equal(result.terminal?.baseSha, OBSERVED_BASE);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: unsettled, truncated, spawn-failed or thrown child results are unavailable", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const healthy = childLine(rig.execution);
    for (
      const run of [
        exited(healthy, 0, { settled: false }),
        exited(healthy, 0, { truncated: true }),
        exited("", 0, { outcome: "timed_out", exitCode: null, settled: false }),
        exited("", 0, { outcome: "spawn_failed", exitCode: null }),
      ]
    ) {
      rig.process.child = run;
      const result = await launch(rig);
      assert.equal(result.status, "unavailable", JSON.stringify(run));
      assert.equal(result.terminal, null);
    }
    rig.process.throwOnChild = true;
    const thrown = await launch(rig);
    assert.equal(thrown.status, "unavailable");
    assert.equal(thrown.terminal, null);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: a settled timeout is an objective failure and a backward clock is unavailable", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);

    // The owned group provably stopped after the deadline: an objective failed
    // invocation, so a failed terminal is emitted with no invented metadata.
    rig.process.child = exited("", 0, {
      outcome: "timed_out",
      exitCode: null,
      settled: true,
    });
    let result = await launch(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.terminal?.outcome, "failed");
    assert.equal(result.terminal?.startupReady, false);
    assert.equal(result.terminal?.baseSha, null);
    assert.equal(result.terminal?.settled, true);

    // A valid child record beside the settled timeout keeps its own observed
    // startup flag and valid base instead of derived values.
    rig.process.child = exited(
      childLine(rig.execution, {
        outcome: { status: "source_error", detail: "source unavailable" },
      }),
      0,
      { outcome: "timed_out", exitCode: null, settled: true },
    );
    result = await launch(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.terminal?.startupReady, true);
    assert.equal(result.terminal?.baseSha, OBSERVED_BASE);

    // A malformed record beside a settled timeout stays unavailable.
    rig.process.child = exited(JSON.stringify({ status: "ran" }), 0, {
      outcome: "timed_out",
      exitCode: null,
      settled: true,
    });
    result = await launch(rig);
    assert.equal(result.status, "unavailable");
    assert.equal(result.terminal, null);

    // A backward clock never fabricates a finish instant or a terminal.
    rig.process.child = exited(childLine(rig.execution), 0);
    result = await launch(rig, { clock: new BackwardClock() });
    assert.equal(result.status, "unavailable");
    assert.equal(result.terminal, null);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: a real owned-group child cannot forge the wrapper terminal", async () => {
  const forged = await makeRig({
    runtimeFiles: {
      "src/host/actions.ts": forgedFixtureScript(),
      ".gitignore": ".sentinel/\n",
    },
  });
  try {
    await seedRelease(forged);
    forged.process.realChild = true;
    const result = await launch(forged);
    assert.equal(result.status, "unavailable");
    assert.equal(result.terminal, null);
    assert.equal(forged.process.childCalls().length, 1);
    assert.equal(
      await pathExists(`${forged.runtimeDir}/child-ran.txt`),
      true,
      "the real fixture child must have executed",
    );
  } finally {
    await forged.cleanup();
  }

  const valid = await makeRig({
    runtimeFiles: {
      "src/host/actions.ts": validFixtureScript(),
      ".gitignore": ".sentinel/\n",
    },
  });
  try {
    await seedRelease(valid);
    valid.process.realChild = true;
    const result = await launch(valid);
    assert.equal(result.status, "healthy", JSON.stringify(result));
    const terminal = result.terminal;
    assert.ok(terminal !== null);
    if (terminal === null) throw new Error("unreachable");
    assert.equal(terminal.outcome, "healthy");
    assert.equal(terminal.settled, true);
    assert.equal(terminal.baseSha, OBSERVED_BASE);
    assert.equal(
      canonicalStringify(terminal.execution),
      canonicalStringify(valid.execution),
    );
    assert.equal(
      await pathExists(`${valid.runtimeDir}/child-ran.txt`),
      true,
      "the real fixture child must have executed",
    );
  } finally {
    await valid.cleanup();
  }
});

Deno.test("hosted runtime: the real repair entrypoint refuses a malformed identity under scoped env grants", async () => {
  const runtime = new DenoReplayRuntime(Deno.execPath());
  const result = await runtime.run({
    executable: Deno.execPath(),
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      `--allow-env=${
        [
          "HOME",
          "PATH",
          "NODE_V8_COVERAGE",
          "GITHUB_RUN_ID",
          "GITHUB_RUN_ATTEMPT",
          "GITHUB_REPOSITORY",
          "GITHUB_REF",
          "GITHUB_SHA",
          "GITHUB_WORKFLOW_SHA",
          "GITHUB_WORKFLOW_REF",
          "GITHUB_JOB",
        ].join(",")
      }`,
      HOSTED_RUNTIME_CHILD_ENTRYPOINT,
    ],
    cwd: ROOT,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      HOME: "/tmp",
      GITHUB_JOB: "prepare",
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_REPOSITORY: "ubiquity/sentinel",
      GITHUB_REF: "refs/heads/sentinel-supervisor",
      GITHUB_SHA: FIXED_LAUNCHER,
      GITHUB_WORKFLOW_SHA: FIXED_LAUNCHER,
      GITHUB_WORKFLOW_REF: HOSTED_RUNTIME_WORKFLOW_REF,
    },
    maxDurationMs: 120_000,
    maxOutputBytes: 256 * 1024,
  });
  const stderr = new TextDecoder().decode(result.stderr);
  assert.equal(result.settled, true);
  assert.notEqual(result.exitCode, 0);
  assert.ok(stderr.includes(HOSTED_RUNTIME_STATIC_IDENTITY), stderr);
  // Scoped env grants are sufficient: the failure is the static identity
  // refusal, not a permission error, and no GitHub/model request is made.
  assert.equal(stderr.includes("PermissionDenied"), false, stderr);
  assert.equal(stderr.includes("NotCapable"), false, stderr);
  assert.equal(result.truncated, false);
});
