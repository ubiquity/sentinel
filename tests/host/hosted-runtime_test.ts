/**
 * Hosted runtime launcher: real temporary Git checkouts and release-state
 * stores, plus one isolated fixture child executed through the ACTUAL
 * DenoReplayRuntime owned-group border. No GitHub, model, deployment or
 * network call is made; this is never live Actions acceptance.
 */
import assert from "node:assert/strict";

import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { parseHostedRuntimeTerminalV1 } from "../../src/contracts/hosted-execution.ts";
import { parseHostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import { HOSTED_RUNTIME_ID } from "../../src/contracts/hosted-supervisor.ts";
import type { HostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type {
  ModelRunReceiptV1,
  ModelRunRequestV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import type { Clock } from "../../src/contracts/ports.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import type {
  ReplayCommandInputV1,
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";
import {
  ACTIONS_UOS_BASE_URL,
  childRunDeadlineV1,
  runActionsRepairHost,
  runActionsTargetCycles,
} from "../../src/host/actions.ts";
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
  HostedModelDiagnosticV1,
  HostedRuntimeIdentityV1,
  HostedRuntimeLauncherInputV1,
  HostedRuntimeLauncherResultV1,
} from "../../src/host/hosted-runtime.ts";
import {
  createLocalRepositoryConfig,
  localCheckoutKey,
  parseLocalModelDiagnosticV1,
  unavailableIncidents,
  unavailableReplay,
  writeLocalModelResult,
} from "../../src/host/local.ts";
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
const NATIVE_LOGIN = "github-actions[bot]";
const APP_LOGIN = "ubiquity-sentinel[bot]";
const APP_TOKEN = "test-app-token";
/**
 * Every allow-listed key that is OPTIONAL: it crosses only when the run
 * supplies non-empty text. The exact-key assertions subtract this set from
 * the allow-list for a run that supplies none of them.
 */
const OPTIONAL_CHILD_ENV_KEYS = [
  "SENTINEL_SUPERVISOR_TOKEN",
  "SENTINEL_MODEL_BASE_URL",
  "SENTINEL_MODEL_ID",
  "SENTINEL_MODEL_FALLBACK",
  "SENTINEL_REVIEW_MODEL_ID",
  "SENTINEL_DEEPSEEK_API_KEY",
  "SENTINEL_APP_INSTALLATION_ID",
  "SENTINEL_COOLDOWN_MODE",
] as const;

/** The exact child key set for a run that supplies no optional value. */
function requiredChildEnvKeys(): string[] {
  const optional = new Set<string>(OPTIONAL_CHILD_ENV_KEYS);
  return HOSTED_RUNTIME_CHILD_ENV_KEYS.filter((key) => !optional.has(key))
    .sort();
}

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
    if (
      input.args.includes(HOSTED_RUNTIME_CHILD_ENTRYPOINT) ||
      input.args.includes("src/host/matrix-actions.ts")
    ) {
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
    login: NATIVE_LOGIN,
    startupReady: true,
    ciApproval: { approved: 0, pending: 0, unavailable: 0 },
    execution,
    ...overrides,
  });
}

const DIAGNOSTIC_TASK_KEY = "c".repeat(64);

/** One real serialized advisory summary exactly as the local host emits it. */
function diagnosticLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: "v1",
    kind: "sentinel_model_diagnostic",
    taskKey: DIAGNOSTIC_TASK_KEY,
    base: OBSERVED_BASE,
    observedAt: T0,
    outcome: "failed",
    reason: "runtime_error",
    errorKind: null,
    terminalOrigin: "runtime",
    observedTerminalStatus: "completed",
    durationMs: 1_234,
    outputChars: 100,
    candidatePresent: true,
    reasonCode: null,
    ...overrides,
  });
}

/**
 * One advisory summary exactly as the independently pinned INSTALLED runtime
 * version emits it: a port error carries `reasonCode`, either one of that
 * version's own eight static seam codes or null. No raw detail is ever a code.
 */
function runtimeDiagnosticLine(reasonCode: string | null): string {
  return JSON.stringify({
    version: "v1",
    kind: "sentinel_model_diagnostic",
    taskKey: DIAGNOSTIC_TASK_KEY,
    base: OBSERVED_BASE,
    observedAt: T0,
    outcome: "port_error",
    reason: "runtime_error",
    errorKind: "unavailable",
    terminalOrigin: null,
    observedTerminalStatus: null,
    durationMs: null,
    outputChars: null,
    candidatePresent: false,
    reasonCode,
  });
}

/** The exact safe diagnostic carried by {@link diagnosticLine}. */
const SAFE_DIAGNOSTIC = {
  version: "v1",
  kind: "sentinel_model_diagnostic",
  taskKey: DIAGNOSTIC_TASK_KEY,
  base: OBSERVED_BASE,
  observedAt: T0,
  outcome: "failed",
  reason: "runtime_error",
  errorKind: null,
  terminalOrigin: "runtime",
  observedTerminalStatus: "completed",
  durationMs: 1_234,
  outputChars: 100,
  candidatePresent: true,
  reasonCode: null,
} as const;

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

function launchInput(rig: RigV1): HostedRuntimeLauncherInputV1 {
  return {
    state: rig.release,
    clock: rig.clock,
    env: rig.env,
    launcherDir: rig.launcherDir,
    runtimeDir: rig.runtimeDir,
    denoExecutable: Deno.execPath(),
    process: rig.process,
  };
}

function launch(
  rig: RigV1,
  overrides: Partial<HostedRuntimeLauncherInputV1> = {},
): Promise<HostedRuntimeLauncherResultV1> {
  return runHostedRuntimeLauncher({ ...launchInput(rig), ...overrides });
}

/**
 * The same launcher input with one optional advisory sink attached through
 * Object.assign, so this fixture keeps compiling against a runtime that does
 * not declare the optional streaming field yet.
 */
function launchWithSink(
  rig: RigV1,
  sink: (diagnostic: HostedModelDiagnosticV1) => void,
): Promise<HostedRuntimeLauncherResultV1> {
  return runHostedRuntimeLauncher(
    Object.assign({}, launchInput(rig), { onDiagnostic: sink }),
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Synchronous marker check usable from inside a streaming sink callback. */
function pathExistsSync(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

// Synthetic private fixture inputs for the real owned-group child: the actual
// local host writes these through its real projection and advisory paths.
const HOSTED_FIXTURE_TASK_ID = "hosted-fixture-issue";
const HOSTED_FIXTURE_ISSUE_BODY = "hosted-fixture-issue-body-marker";
const HOSTED_FIXTURE_EVIDENCE_REF = "hosted-fixture-evidence-ref-marker";
const HOSTED_FIXTURE_RAW_ERROR = "hosted-fixture-raw-error-marker";
const HOSTED_FIXTURE_CHANGED_PATH = "src/hosted-fixture-changed-path-marker.ts";
const HOSTED_FIXTURE_INVOCATION = "hosted-fixture-invocation-marker";
const HOSTED_FIXTURE_PROVIDER = "hosted-fixture-provider-marker";
const HOSTED_FIXTURE_THREAD = "hosted-fixture-thread-marker";
const HOSTED_FIXTURE_TURN = "hosted-fixture-turn-marker";
const HOSTED_FIXTURE_MODEL = "hosted-fixture-observed-model-marker";
const HOSTED_FIXTURE_REASONING = "hosted-fixture-observed-reasoning-marker";

/** One valid Luna/max request bound to the observed base with marker inputs. */
function hostedFixtureRequest(): ModelRunRequestV1 {
  return {
    taskId: asWorkItemId(HOSTED_FIXTURE_TASK_ID),
    repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
    base: OBSERVED_BASE,
    issue: { number: 53, title: "fixture", body: HOSTED_FIXTURE_ISSUE_BODY },
    evidence: [{ kind: "replay_result", ref: HOSTED_FIXTURE_EVIDENCE_REF }],
    model: "gpt-reserve",
    reasoning: "max",
    maxDurationMs: 1_200_000,
    maxOutputChars: 400_000,
  };
}

/** Synthetic failed host-timeout receipt carrying private marker identity. */
function hostedFixtureReceipt(): PortResultV1<ModelRunReceiptV1> {
  return portOk({
    invocationId: HOSTED_FIXTURE_INVOCATION,
    outcome: "failed",
    actual: {
      evidenceKind: "request-runtime",
      provider: HOSTED_FIXTURE_PROVIDER,
      threadId: HOSTED_FIXTURE_THREAD,
      turnId: HOSTED_FIXTURE_TURN,
      terminalOrigin: "host-timeout",
      observedTerminalStatus: null,
      observedModel: HOSTED_FIXTURE_MODEL,
      observedReasoning: HOSTED_FIXTURE_REASONING,
      durationMs: 4_321,
      outputChars: 99,
    },
    candidate: null,
    error: HOSTED_FIXTURE_RAW_ERROR,
  });
}

/**
 * Real fixture child that writes a marker, prints the exact captured advisory
 * stdout, leaves a descendant, then a record.
 */
function validFixtureScript(diagnosticStdout: string): string {
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
// The exact advisory stdout captured from actual local model-result writes,
// embedded as one safe JavaScript string literal.
console.log(${JSON.stringify(diagnosticStdout)});
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

/**
 * Real fixture child for the streaming case. It prints one valid advisory line
 * in two pipe writes, waits (bounded) for the sink's acknowledgement file so
 * the emission provably precedes the finish marker it writes below, then
 * prints ignored inputs, an oversized line whose parseable-looking suffix
 * arrives only after the retained bound was exceeded, a stderr advisory, a
 * resumed valid advisory, and finally its status record.
 */
function streamingFixtureScript(input: {
  firstHalf: string;
  secondHalf: string;
  ignoredLines: string[];
  oversizedSuffix: string;
  afterLine: string;
  stderrLine: string;
}): string {
  return `const encoder = new TextEncoder();
const write = (text: string) => Deno.stdout.writeSync(encoder.encode(text));
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const exists = (path: string) => {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
};
const decoder = new TextDecoder();
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
// One valid advisory line split across two pipe writes: the retained partial
// line must be assembled across the chunk boundary.
write(${JSON.stringify(input.firstHalf)});
await pause(80);
write(${JSON.stringify(input.secondHalf)} + "\\n");
// Bounded handshake: the sink acknowledges the first streamed advisory by
// creating this file, so the finish marker below provably follows it. A
// runtime without streaming lets the bound expire and still exits normally.
for (let i = 0; i < 500 && !exists("release-child.txt"); i++) await pause(10);
for (const line of ${JSON.stringify(input.ignoredLines)}) write(line + "\\n");
// Oversized line: the retained bound is exceeded first, and only then does the
// parseable-looking suffix arrive; the whole line must be discarded.
write("x".repeat(2_100));
await pause(30);
write(${JSON.stringify(input.oversizedSuffix)} + "\\n");
// stderr is never forwarded to the advisory sink.
console.error(${JSON.stringify(input.stderrLine)});
write(${JSON.stringify(input.afterLine)} + "\\n");
// The finish marker is written after every advisory attempt and before the
// status record: its absence at emission time proves the child had not exited.
Deno.writeTextFileSync("child-finished.txt", "finished\\n");
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
    // The allow-list is exact: every listed key crosses except the optional
    // values this run did not supply.
    assert.deepEqual(
      Object.keys(child.env).sort(),
      requiredChildEnvKeys(),
    );
    assert.equal("SENTINEL_SUPERVISOR_TOKEN" in child.env, false);
    assert.equal("SENTINEL_DEEPSEEK_API_KEY" in child.env, false);
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

Deno.test("hosted runtime: the sentinel App bot login is accepted and an absent App token still forwards the strict child environment", async () => {
  // App-login transition case: a child at or after the migration reports
  // `ubiquity-sentinel[bot]`; it must settle exactly like the native identity.
  const appRig = await makeRig();
  try {
    await seedRelease(appRig);
    appRig.process.child = exited(
      childLine(appRig.execution, { login: "ubiquity-sentinel[bot]" }),
    );
    const result = await launch(appRig);
    assert.equal(result.status, "healthy", JSON.stringify(result));
    assert.equal(result.terminal?.outcome, "healthy");
  } finally {
    await appRig.cleanup();
  }

  // Absence case: without the App token the child environment keeps exactly
  // the declared key set, and the App token key is genuinely absent rather
  // than present-and-empty.
  const noAppRig = await makeRig();
  try {
    await seedRelease(noAppRig);
    noAppRig.process.child = exited(childLine(noAppRig.execution));
    const env = { ...hostedEnv(noAppRig.identity.launcherSha) };
    delete env.SENTINEL_SUPERVISOR_TOKEN;
    const result = await launch(noAppRig, { env });
    assert.equal(result.status, "healthy", JSON.stringify(result));
    const child = noAppRig.process.childCalls()[0];
    assert.equal("SENTINEL_SUPERVISOR_TOKEN" in child.env, false);
    assert.deepEqual(
      Object.keys(child.env).sort(),
      requiredChildEnvKeys(),
    );
  } finally {
    await noAppRig.cleanup();
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

Deno.test("hosted runtime: the optional sentinel App token crosses only when it is non-empty text", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    rig.process.child = exited(childLine(rig.execution));
    const withoutToken = await launch(rig);
    assert.equal(withoutToken.status, "healthy", JSON.stringify(withoutToken));
    let child = rig.process.childCalls().at(-1);
    assert.ok(child !== undefined);
    assert.equal("SENTINEL_SUPERVISOR_TOKEN" in child.env, false);
    assert.equal(child.env.GITHUB_TOKEN, rig.env.GITHUB_TOKEN);

    rig.process.child = exited(childLine(rig.execution));
    const withToken = await launch(rig, {
      env: { ...rig.env, SENTINEL_SUPERVISOR_TOKEN: APP_TOKEN },
    });
    assert.equal(withToken.status, "healthy", JSON.stringify(withToken));
    child = rig.process.childCalls().at(-1);
    assert.ok(child !== undefined);
    assert.equal(child.env.SENTINEL_SUPERVISOR_TOKEN, APP_TOKEN);
    assert.deepEqual(
      Object.keys(child.env).sort(),
      [
        ...requiredChildEnvKeys(),
        "SENTINEL_SUPERVISOR_TOKEN",
      ].sort(),
      "a supplied App token completes the exact allow-list",
    );
    assert.equal(child.env.GITHUB_TOKEN, rig.env.GITHUB_TOKEN);

    // The DeepSeek-direct fallback selection reaches the child exactly as the
    // launcher received it; the launcher never selects or rewrites a route.
    rig.process.child = exited(childLine(rig.execution));
    const routed = await launch(rig, {
      env: {
        ...rig.env,
        SENTINEL_MODEL_FALLBACK: "deepseek",
        SENTINEL_DEEPSEEK_API_KEY: "test-deepseek-key",
      },
    });
    assert.equal(routed.status, "healthy", JSON.stringify(routed));
    const routedChild = rig.process.childCalls().at(-1);
    assert.ok(routedChild !== undefined);
    assert.equal(routedChild.env.SENTINEL_MODEL_FALLBACK, "deepseek");
    assert.equal(
      routedChild.env.SENTINEL_DEEPSEEK_API_KEY,
      "test-deepseek-key",
    );
    assert.deepEqual(
      Object.keys(routedChild.env).sort(),
      [
        ...requiredChildEnvKeys(),
        "SENTINEL_MODEL_FALLBACK",
        "SENTINEL_DEEPSEEK_API_KEY",
      ].sort(),
      "the selected route variables cross with the required keys only",
    );

    rig.process.child = exited(childLine(rig.execution));
    const emptyToken = await launch(rig, {
      env: { ...rig.env, SENTINEL_SUPERVISOR_TOKEN: "" },
    });
    assert.equal(emptyToken.status, "healthy", JSON.stringify(emptyToken));
    child = rig.process.childCalls().at(-1);
    assert.ok(child !== undefined);
    assert.equal(
      "SENTINEL_SUPERVISOR_TOKEN" in child.env,
      false,
      "an empty App token never crosses",
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: a child settled as the sentinel App login is accepted during the transition", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    for (const login of [NATIVE_LOGIN, APP_LOGIN]) {
      rig.process.child = exited(childLine(rig.execution, { login }));
      const result = await launch(rig);
      assert.equal(
        result.status,
        "healthy",
        `${login}: ${JSON.stringify(result)}`,
      );
      assert.equal(result.terminal?.outcome, "healthy", login);
      assert.equal(result.terminal?.baseSha, OBSERVED_BASE, login);
    }
    // Any other login is still refused: the transition set is bounded, not
    // an open prefix or suffix match.
    for (const login of ["ubiquity-sentinel", "github-actions"]) {
      rig.process.child = exited(childLine(rig.execution, { login }));
      const foreign = await launch(rig);
      assert.equal(foreign.status, "unavailable", login);
      assert.equal(foreign.terminal, null, login);
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

    // An attempted status key after another key (truncated key/value/tail) and
    // an invalid-typed top-level status are uncertain in either order.
    const lateTruncated = '{"noise":0,"status":';
    const lateTail = '{"noise":0,"status":"ran","outcome":{';
    for (
      const stdout of [
        `${lateTruncated}\n${healthy}`,
        `${healthy}\n${lateTruncated}`,
        `${lateTail}\n${healthy}`,
        `${healthy}\n${lateTail}`,
        `{"noise":0,"status":false}\n${healthy}`,
        `${healthy}\n{"noise":0,"status":false}`,
        `{"noise":0,"status":null}\n${healthy}`,
        `${healthy}\n{"noise":0,"status":null}`,
        `{"noise":0,"status":42}\n${healthy}`,
        `${healthy}\n{"noise":0,"status":42}`,
        `{"noise":0,"sta\n${healthy}`,
        `${healthy}\n{"noise":0,"sta`,
        `{"status\n${healthy}`,
        `${healthy}\n{"status`,
      ]
    ) {
      rig.process.child = exited(stdout, 0);
      const result = await launch(rig);
      assert.equal(result.status, "unavailable", stdout);
      assert.equal(result.terminal, null, stdout);
    }

    // Legitimate preflight records, nested status objects and plain log noise
    // carry no top-level status and must not disturb the one valid record.
    const preflight =
      '{"kind":"sentinel_startup_preflight","stage":"resolve_codex","codexExecutable":"/usr/bin/codex"}';
    const nested =
      '{"kind":"sentinel_startup_preflight","detail":{"status":"ran"}}';
    rig.process.child = exited(
      `${preflight}\n${nested}\nordinary log noise\n${healthy}\n{"kind":"sentinel_startup_preflight","pass":true}\n`,
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

Deno.test("hosted runtime: advisory summaries are wrapper-stamped, bounded and never change health or terminal", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const healthy = childLine(rig.execution);
    const safe = diagnosticLine();

    // One valid child summary beside a healthy child record: the summary is
    // copied only through the strict allow-list and stamped with the exact
    // verified launch execution.
    rig.process.child = exited(`${safe}\n${healthy}\n`);
    let result = await launch(rig);
    assert.equal(result.status, "healthy", JSON.stringify(result));
    assert.equal(result.terminal?.outcome, "healthy");
    assert.equal(result.terminal?.baseSha, OBSERVED_BASE);
    assert.equal(result.diagnostics.length, 1);
    const advisory = result.diagnostics[0];
    assert.ok(advisory !== undefined);
    if (advisory === undefined) throw new Error("unreachable");
    assert.deepEqual(Object.keys(advisory).sort(), [
      "advisory",
      "diagnostic",
      "execution",
      "kind",
      "version",
    ]);
    assert.equal(advisory.version, "v1");
    assert.equal(advisory.kind, "hosted_model_diagnostic");
    assert.equal(advisory.advisory, true);
    assert.equal(
      canonicalStringify(advisory.execution),
      canonicalStringify(rig.execution),
    );
    assert.deepEqual(advisory.diagnostic, SAFE_DIAGNOSTIC);
    const serialized = JSON.stringify(result.diagnostics);
    for (
      const marker of [
        "local_model_result",
        "sentinel_model_result",
        "provider",
        "threadId",
        "turnId",
        "errorDetail",
        "observedModel",
        "invocationId",
        'errorKind":"unavailable',
      ]
    ) {
      assert.equal(serialized.includes(marker), false, marker);
    }

    // A settled nonzero exit keeps its existing failed terminal and still
    // carries the advisory; the advisory never rewrites the failure.
    rig.process.child = exited(`${safe}\n`, 3);
    result = await launch(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.terminal?.outcome, "failed");
    assert.equal(result.terminal?.startupReady, false);
    assert.equal(result.terminal?.baseSha, null);
    assert.equal(result.diagnostics.length, 1);

    // A settled timeout beside a valid child record is unchanged and keeps its
    // observed startup flag and base while the advisory is still attached.
    rig.process.child = exited(
      `${safe}\n${
        childLine(rig.execution, {
          outcome: { status: "source_error", detail: "source unavailable" },
        })
      }\n`,
      0,
      { outcome: "timed_out", exitCode: null, settled: true },
    );
    result = await launch(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.terminal?.startupReady, true);
    assert.equal(result.terminal?.baseSha, OBSERVED_BASE);
    assert.equal(result.diagnostics.length, 1);

    // Absent diagnostics keep the bounded empty default.
    rig.process.child = exited(`${healthy}\n`);
    result = await launch(rig);
    assert.equal(result.status, "healthy");
    assert.deepEqual(result.diagnostics, []);

    // The accepted list is bounded at 64 summaries.
    rig.process.child = exited(
      `${Array.from({ length: 70 }, () => safe).join("\n")}\n${healthy}\n`,
    );
    result = await launch(rig);
    assert.equal(result.status, "healthy");
    assert.equal(result.diagnostics.length, 64);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: malformed, oversized, unknown-field or forged advisory inputs are ignored", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const healthy = childLine(rig.execution);
    const forgedWrapper = JSON.stringify({
      version: "v1",
      kind: "hosted_model_diagnostic",
      advisory: true,
      execution: rig.execution,
      diagnostic: JSON.parse(diagnosticLine()),
    });
    const oversized = diagnosticLine().replace("{", `{${" ".repeat(2_100)}`);
    assert.ok(oversized.length > 2_048);
    for (
      const bad of [
        '{"kind":"sentinel_model_diagnostic"}',
        diagnosticLine({ provider: "private-marker" }),
        diagnosticLine({ execution: rig.execution }),
        diagnosticLine({ kind: "model_diagnostic" }),
        diagnosticLine({ outcome: "port_error" }),
        diagnosticLine({ errorKind: "unavailable" }),
        diagnosticLine({ reason: "made_up" }),
        // reasonCode must be one of the runtime's own fixed literals, or null.
        // Arbitrary text, an unknown literal, a non-string, or a code on a
        // settled record are all refused, so no raw text can ever be echoed.
        diagnosticLine({ reasonCode: "raw-error-marker" }),
        diagnosticLine({ reasonCode: "made-up-code" }),
        diagnosticLine({ reasonCode: 7 }),
        oversized,
        forgedWrapper,
      ]
    ) {
      rig.process.child = exited(`${bad}\n${healthy}\n`);
      const result = await launch(rig);
      assert.equal(result.status, "healthy", bad.slice(0, 80));
      assert.equal(result.terminal?.outcome, "healthy", bad.slice(0, 80));
      assert.deepEqual(result.diagnostics, [], bad.slice(0, 80));
    }

    // A malformed object-looking line is never ignored beside a complete
    // record: the unchanged status scan refuses it as uncertain, so even a
    // following healthy record can never create terminal proof or an advisory.
    rig.process.child = exited(
      `{"kind":"sentinel_model_diagnostic","version":"v1"\n${healthy}\n`,
    );
    const malformed = await launch(rig);
    assert.equal(malformed.status, "unavailable");
    assert.equal(malformed.terminal, null);
    assert.deepEqual(malformed.diagnostics, []);

    // An unrecognized line alone never creates terminal proof or an advisory.
    rig.process.child = exited(`${diagnosticLine({ extra: "x" })}\n`, 0);
    const alone = await launch(rig);
    assert.equal(alone.status, "unavailable");
    assert.equal(alone.terminal, null);
    assert.deepEqual(alone.diagnostics, []);

    // Truncated, unsettled or unspawned captures yield no advisory at all and
    // cannot improve or create terminal proof.
    for (
      const run of [
        exited(`${diagnosticLine()}\n${healthy}\n`, 0, { truncated: true }),
        exited(`${diagnosticLine()}\n${healthy}\n`, 0, { settled: false }),
        exited(`${diagnosticLine()}\n`, 0, {
          outcome: "timed_out",
          exitCode: null,
          settled: false,
        }),
        exited(`${diagnosticLine()}\n`, 0, {
          outcome: "spawn_failed",
          exitCode: null,
        }),
      ]
    ) {
      rig.process.child = run;
      const result = await launch(rig);
      assert.equal(result.terminal, null, JSON.stringify(run));
      assert.deepEqual(result.diagnostics, [], JSON.stringify(run));
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: an installed-runtime advisory keeps its static reason code and refuses any other", async () => {
  // Decoder contract first: the installed pinned runtime emits the required
  // `reasonCode`, either one of its own eight static seam codes or null.
  const known = runtimeDiagnosticLine("model_checkout_unavailable");
  const knownParsed = parseLocalModelDiagnosticV1(JSON.parse(known));
  assert.deepEqual(knownParsed, JSON.parse(known), known);

  const nullCode = runtimeDiagnosticLine(null);
  const nullParsed = parseLocalModelDiagnosticV1(JSON.parse(nullCode));
  assert.deepEqual(nullParsed, JSON.parse(nullCode), nullCode);

  // A diagnostic missing its required static reason-code key is refused.
  const missingCode = JSON.parse(diagnosticLine());
  delete missingCode.reasonCode;
  assert.equal(parseLocalModelDiagnosticV1(missingCode), null);

  // Only the exact eight static literals are codes: a raw error or provider
  // string, an unknown word, a near-miss code, an empty string and a code on
  // a settled record are all still refused.
  for (
    const refused of [
      runtimeDiagnosticLine("hosted-fixture-raw-error-marker"),
      runtimeDiagnosticLine("unavailable"),
      runtimeDiagnosticLine("model_checkout_unavailable_v2"),
      runtimeDiagnosticLine(""),
      diagnosticLine({ reasonCode: "model_checkout_unavailable" }),
      diagnosticLine({ reasonCode: "not_a_static_code" }),
      runtimeDiagnosticLine("model_checkout_unavailable").replace(
        '"errorKind":"unavailable"',
        '"errorKind":"made_up"',
      ),
      diagnosticLine({ reasonCode: null, candidatePresent: "true" }),
    ]
  ) {
    assert.equal(
      parseLocalModelDiagnosticV1(JSON.parse(refused)),
      null,
      refused,
    );
  }

  // One real launcher call: the known code survives into the stamped advisory
  // and health and terminal are unchanged.
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    rig.process.child = exited(`${known}\n${childLine(rig.execution)}\n`);
    const result = await launch(rig);
    assert.equal(result.status, "healthy");
    assert.equal(result.terminal?.outcome, "healthy");
    assert.equal(result.diagnostics.length, 1);
    assert.deepEqual(result.diagnostics[0]?.diagnostic, JSON.parse(known));
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
    assert.deepEqual(result.diagnostics, []);
    assert.equal(forged.process.childCalls().length, 1);
    assert.equal(
      await pathExists(`${forged.runtimeDir}/child-ran.txt`),
      true,
      "the real fixture child must have executed",
    );
  } finally {
    await forged.cleanup();
  }

  const fixtureRequest = hostedFixtureRequest();
  const fixtureTaskKey = await localCheckoutKey(fixtureRequest.taskId);
  const privateRoot = await Deno.makeTempDir({
    prefix: "sentinel-hosted-model-results-",
    dir: ROOT,
  });
  let diagnosticStdout = "";
  try {
    const emitted: string[] = [];
    const originalLog = console.log;
    let firstPath = "";
    let secondPath = "";
    try {
      console.log = ((...args: unknown[]) => {
        emitted.push(
          args.map((arg) => typeof arg === "string" ? arg : String(arg)).join(
            " ",
          ),
        );
      }) as typeof console.log;
      firstPath = await writeLocalModelResult(
        privateRoot,
        fixtureRequest,
        hostedFixtureReceipt(),
        T0,
      );
      secondPath = await writeLocalModelResult(
        privateRoot,
        fixtureRequest,
        portError("unavailable", HOSTED_FIXTURE_RAW_ERROR),
        T0,
      );
    } finally {
      console.log = originalLog;
    }
    assert.equal(emitted.length, 2, "one advisory per written result");
    diagnosticStdout = emitted.join("\n");

    // Both private files are real 0600 projections inside 0700 directories and
    // never retain the raw error.
    for (const path of [firstPath, secondPath]) {
      assert.equal((await Deno.stat(path)).mode! & 0o777, 0o600);
      assert.equal(
        (await Deno.stat(path.slice(0, path.lastIndexOf("/")))).mode! & 0o777,
        0o700,
      );
      const privateText = await Deno.readTextFile(path);
      const privateRecord = JSON.parse(privateText) as Record<string, unknown>;
      assert.equal(privateRecord.version, "v1");
      assert.equal(privateRecord.kind, "local_model_result");
      assert.equal(privateRecord.taskId, fixtureRequest.taskId);
      assert.equal(privateText.includes(HOSTED_FIXTURE_RAW_ERROR), false);
    }
    const firstPrivate = await Deno.readTextFile(firstPath);
    assert.equal(
      firstPrivate.includes(HOSTED_FIXTURE_PROVIDER),
      true,
      "the private projection keeps the acknowledged provider",
    );
  } finally {
    await Deno.remove(privateRoot, { recursive: true }).catch(() => {});
  }

  const valid = await makeRig({
    runtimeFiles: {
      "src/host/actions.ts": validFixtureScript(diagnosticStdout),
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
    // The real fixture child stdout crosses the actual owned-group border; the
    // two advisories written by the actual local host are reconstructed and
    // wrapper-stamped here.
    assert.equal(result.diagnostics.length, 2);
    const timeoutAdvisory = result.diagnostics[0];
    const portAdvisory = result.diagnostics[1];
    assert.ok(timeoutAdvisory !== undefined && portAdvisory !== undefined);
    if (timeoutAdvisory === undefined || portAdvisory === undefined) {
      throw new Error("unreachable");
    }
    for (const advisory of result.diagnostics) {
      assert.equal(advisory.kind, "hosted_model_diagnostic");
      assert.equal(advisory.advisory, true);
      assert.equal(
        canonicalStringify(advisory.execution),
        canonicalStringify(valid.execution),
      );
      assert.equal(advisory.diagnostic.taskKey, fixtureTaskKey);
      assert.equal(advisory.diagnostic.base, OBSERVED_BASE);
      assert.equal(advisory.diagnostic.observedAt, T0);
    }
    assert.deepEqual(timeoutAdvisory.diagnostic, {
      version: "v1",
      kind: "sentinel_model_diagnostic",
      taskKey: fixtureTaskKey,
      base: OBSERVED_BASE,
      observedAt: T0,
      outcome: "failed",
      reason: "host_timeout",
      errorKind: null,
      terminalOrigin: "host-timeout",
      observedTerminalStatus: null,
      durationMs: 4_321,
      outputChars: 99,
      candidatePresent: false,
      reasonCode: null,
    });
    assert.deepEqual(portAdvisory.diagnostic, {
      version: "v1",
      kind: "sentinel_model_diagnostic",
      taskKey: fixtureTaskKey,
      base: OBSERVED_BASE,
      observedAt: T0,
      outcome: "port_error",
      reason: "runtime_error",
      errorKind: "unavailable",
      terminalOrigin: null,
      observedTerminalStatus: null,
      durationMs: null,
      outputChars: null,
      candidatePresent: false,
      reasonCode: null,
    });
    const serialized = JSON.stringify(result.diagnostics);
    for (
      const marker of [
        HOSTED_FIXTURE_ISSUE_BODY,
        HOSTED_FIXTURE_EVIDENCE_REF,
        HOSTED_FIXTURE_RAW_ERROR,
        HOSTED_FIXTURE_CHANGED_PATH,
        HOSTED_FIXTURE_INVOCATION,
      ]
    ) {
      assert.equal(serialized.includes(marker), false, marker);
    }
    assert.equal(
      await pathExists(`${valid.runtimeDir}/child-ran.txt`),
      true,
      "the real fixture child must have executed",
    );
    // Synthetic fixture evidence for the existing CI job log only.
    for (const advisory of result.diagnostics) {
      console.log(`SENTINEL_DIAGNOSTIC_FIXTURE ${JSON.stringify(advisory)}`);
    }
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

Deno.test("hosted runtime: actions environment allowlist", async () => {
  // The committed `repair:actions` task runs the REAL `src/host/actions.ts`
  // entrypoint under one NAMED environment allowlist (deno.json). A named
  // allowlist grants only the listed names and never an unrestricted
  // `Deno.env.toObject()`, so the entrypoint must resolve its route and review
  // configuration through named reads and cross the environment configuration
  // boundary instead of demanding a full environment dump.
  const declaredEnvAllowlist = [
    "HOME",
    "PATH",
    "GITHUB_TOKEN",
    "SENTINEL_SUPERVISOR_TOKEN",
    "UOS_AI_TOKEN",
    "SENTINEL_MODEL_BASE_URL",
    "SENTINEL_MODEL_ID",
    "SENTINEL_MODEL_FALLBACK",
    "SENTINEL_DEEPSEEK_API_KEY",
    "SENTINEL_COOLDOWN_MODE",
    "SENTINEL_APP_INSTALLATION_ID",
    "NODE_V8_COVERAGE",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_REPOSITORY",
    "GITHUB_REF",
    "GITHUB_SHA",
    "GITHUB_WORKFLOW_SHA",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_JOB",
    "SENTINEL_REVIEW_MODEL_ID",
  ].join(",");

  // The full valid hosted identity, with the credential keys present but
  // EMPTY, exactly as an absent workflow secret appears. The run must stop at
  // its own credential boundary, so no real Git fetch, model session or
  // GitHub write is reachable; the child also never receives `--allow-run` or
  // `--allow-net`, so even a regression that moved that boundary could not
  // touch the network.
  const identityEnv = {
    ...hostedEnv(FIXED_LAUNCHER),
    GITHUB_TOKEN: "",
    UOS_AI_TOKEN: "",
  };

  const cacheInfo = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.ok(cacheInfo.success, new TextDecoder().decode(cacheInfo.stderr));
  const cachedDenoDir = JSON.parse(
    new TextDecoder().decode(cacheInfo.stdout),
  ).denoDir;
  assert.ok(typeof cachedDenoDir === "string" && cachedDenoDir.length > 0);

  /** Run the real entrypoint once through the owned-group child border. */
  const runEntrypoint = (env: Record<string, string>) =>
    new DenoReplayRuntime(Deno.execPath()).run({
      executable: Deno.execPath(),
      args: [
        "run",
        "--frozen",
        "--cached-only",
        "--allow-read",
        "--allow-write",
        `--allow-env=${declaredEnvAllowlist}`,
        HOSTED_RUNTIME_CHILD_ENTRYPOINT,
      ],
      cwd: ROOT,
      env: { ...env, DENO_DIR: cachedDenoDir },
      maxDurationMs: 120_000,
      maxOutputBytes: 256 * 1024,
    });

  /**
   * Assert one run crossed the environment configuration boundary and stopped
   * at its own credential boundary with no environment-capability denial
   * anywhere, then return its non-empty stdout lines.
   */
  const assertCrossedBoundary = (result: ReplayCommandResultV1): string[] => {
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    assert.equal(result.outcome, "exited", stderr);
    assert.equal(result.settled, true, stderr);
    assert.equal(result.truncated, false, stderr);
    assert.notEqual(result.exitCode, 0, stderr);
    for (
      const denial of [
        "NotCapable",
        "PermissionDenied",
        "Requires env access",
      ]
    ) {
      assert.equal(
        `${stdout}\n${stderr}`.includes(denial),
        false,
        `the declared named allowlist must be sufficient; found ${denial}\n` +
          `stdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    assert.ok(
      stderr.includes(
        "hosted repair host requires its configured credentials",
      ),
      "the run must cross the environment configuration boundary and stop " +
        `at its credential boundary\nchild: ${
          JSON.stringify({
            outcome: result.outcome,
            exitCode: result.exitCode,
            settled: result.settled,
          })
        }\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
    const lines = stdout.split("\n").map((line) => line.trim()).filter((line) =>
      line.length > 0
    );
    assert.equal(
      lines[0]?.includes('"sentinel_run_window"'),
      true,
      `stdout:\n${stdout}\nstderr:\n${stderr}`,
    );
    return lines;
  };

  /** Parse the one strict route/review advisory this run recorded. */
  const routeOf = (lines: readonly string[]): Record<string, unknown> => {
    const line = lines.find((candidate) =>
      candidate.includes('"sentinel_model_route"')
    );
    assert.ok(
      line !== undefined,
      `no model route recorded:\n${lines.join("\n")}`,
    );
    return JSON.parse(line) as Record<string, unknown>;
  };

  // 1. Without a route input the gateway primary and the preferred review
  //    model are the resolved values; nothing is fabricated from a missing key.
  const plainRoute = routeOf(
    assertCrossedBoundary(await runEntrypoint({ ...identityEnv })),
  );
  assert.deepEqual(plainRoute, {
    kind: "sentinel_model_route",
    provider: "uos",
    model: "gpt-reserve",
    baseUrl: ACTIONS_UOS_BASE_URL,
    reviewModel: "codex-auto-review",
  });

  // 2. The explicit DeepSeek fallback and the dedicated review-model override
  //    are still read from the real environment under the same named
  //    allowlist: the owner's selections reach the resolved route instead of
  //    hardcoded defaults. The fallback key is a synthetic marker, and the
  //    empty GitHub credential still stops the run before any budget, state or
  //    transport work.
  const fallbackRoute = routeOf(
    assertCrossedBoundary(
      await runEntrypoint({
        ...identityEnv,
        SENTINEL_MODEL_FALLBACK: "deepseek",
        SENTINEL_DEEPSEEK_API_KEY: "synthetic-marker-not-a-credential",
        SENTINEL_REVIEW_MODEL_ID: "codex-auto-review-canary",
      }),
    ),
  );
  assert.deepEqual(fallbackRoute, {
    kind: "sentinel_model_route",
    provider: "deepseek",
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com/v1",
    reviewModel: "codex-auto-review-canary",
  });
});

Deno.test("hosted runtime: source preparation is charged against the one absolute child deadline", async () => {
  // The launcher's own bounded wait over the child process stays 112 minutes,
  // measured from the instant it spawns the child. It is not the child's
  // deadline: the child anchors its own 110-minute budget before its setup.
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    rig.process.child = exited(childLine(rig.execution));
    const launched = await launch(rig);
    assert.equal(launched.status, "healthy", JSON.stringify(launched));
    assert.equal(launched.terminal?.startedAt, T0);
    const launchedChild = rig.process.childCalls()[0];
    assert.ok(launchedChild !== undefined);
    assert.equal(launchedChild.maxDurationMs, HOSTED_RUNTIME_DEADLINE_MS);
  } finally {
    await rig.cleanup();
  }

  // ONE absolute child deadline, derived exactly as production derives it:
  // the origin plus the unchanged 110-minute child budget. The test adds no
  // separate deadline arithmetic of its own.
  const deadline = childRunDeadlineV1(T0);

  const self = createLocalRepositoryConfig();
  const foreign: RepositoryConfigV1 = {
    ...self,
    repository: { ...self.repository, name: "foreign-target" },
  };
  const third: RepositoryConfigV1 = {
    ...self,
    repository: { ...self.repository, name: "third-target" },
  };
  const slugOf = (config: RepositoryConfigV1): string =>
    `${config.repository.owner}/${config.repository.name}`;
  const capability = {} as never;

  // Slow setup: the foreign target's own source preparation and base refresh
  // consume the remaining clock time and cross the absolute deadline.
  const clock = new FakeClock(T0);
  const prepared: string[] = [];
  const composed: string[] = [];
  const cycles: string[] = [];
  const selfOutcome = { status: "idle", detail: "self fixture" } as const;
  const foreignOutcome = {
    status: "margin",
    detail: "hosted repair run deadline reached",
  } as const;
  const result = await runActionsTargetCycles({
    clock,
    state: capability,
    configs: [self, foreign, third],
    controllerSha: FIXED_LAUNCHER,
    githubCooldown: capability,
    incidents: unavailableIncidents,
    replay: unavailableReplay,
    model: capability,
    budget: capability,
    deadline,
    stepLimit: 16,
    modelStartsEnabled: false,
    composeGithub: (config) => {
      composed.push(slugOf(config));
      return capability;
    },
    prepareTarget: (config) => {
      const slug = slugOf(config);
      prepared.push(slug);
      // The self mirror is prepared before the loop; a foreign target's own
      // mirror seed and base refresh consume clock time here.
      if (slug !== "ubiquity/sentinel") clock.advance(3 * 60_000);
      return Promise.resolve();
    },
    runCycle: (deps, options) => {
      const slug = slugOf(deps.configs[0]!);
      cycles.push(slug);
      assert.equal(options.deadline, deadline);
      if (slug === "ubiquity/sentinel") {
        // The self cycle consumes the budget up to two minutes before the ONE
        // absolute deadline.
        clock.advance(deadline - clock.now() - 2 * 60_000);
        return Promise.resolve(selfOutcome);
      }
      return Promise.resolve(foreignOutcome);
    },
  });

  assert.deepEqual(prepared, ["ubiquity/sentinel", "ubiquity/foreign-target"]);
  // The third target's cycle never starts either: the one absolute deadline
  // stops the run instead of spending remaining budget on doomed work.
  assert.deepEqual(composed, ["ubiquity/sentinel"]);
  assert.deepEqual(cycles, ["ubiquity/sentinel"]);
  assert.deepEqual(result.addressed, ["ubiquity/sentinel"]);
  assert.deepEqual(result.skipped, [
    "ubiquity/foreign-target",
    "ubiquity/third-target",
  ]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.outcome, selfOutcome);

  // Control: a preparation that finishes inside the bound still starts, and
  // the cycle receives exactly the one absolute deadline.
  const controlClock = new FakeClock(T0);
  const controlComposed: string[] = [];
  const controlDeadlines: number[] = [];
  const control = await runActionsTargetCycles({
    clock: controlClock,
    state: capability,
    configs: [foreign],
    controllerSha: FIXED_LAUNCHER,
    githubCooldown: capability,
    incidents: unavailableIncidents,
    replay: unavailableReplay,
    model: capability,
    budget: capability,
    deadline,
    stepLimit: 16,
    modelStartsEnabled: false,
    composeGithub: (config) => {
      controlComposed.push(slugOf(config));
      return capability;
    },
    prepareTarget: () => {
      controlClock.advance(5 * 60_000);
      return Promise.resolve();
    },
    runCycle: (_deps, options) => {
      controlDeadlines.push(options.deadline);
      return Promise.resolve(foreignOutcome);
    },
  });
  assert.deepEqual(controlComposed, ["ubiquity/foreign-target"]);
  assert.deepEqual(controlDeadlines, [deadline]);
  assert.deepEqual(control.addressed, ["ubiquity/foreign-target"]);
  assert.deepEqual(control.skipped, []);
  assert.deepEqual(control.outcome, foreignOutcome);
});

Deno.test("hosted runtime: the real child announces its run window before its own setup begins", async () => {
  // The child's origin is the earliest instant it can observe for ITSELF, and
  // the ONE absolute deadline is derived from it before any identity, state,
  // source or target preparation. Proved on the actual entrypoint: its first
  // setup step is made to fail, so a run window in that run's stdout can only
  // have been established before setup began.
  const root = await Deno.makeTempDir({
    prefix: "sentinel-hosted-runtime-",
    dir: ROOT,
  });
  try {
    // A disposable cwd keeps the child's private state directory out of the
    // checkout. The child runs the real entrypoint file by absolute path, so
    // its module graph is the real runtime source and its cwd is disposable.
    const bin = `${root}/bin`;
    await Deno.mkdir(bin);
    const marker = `${root}/git-ran`;
    await Deno.writeTextFile(
      `${bin}/git`,
      `#!/bin/sh\n: > ${marker}\nexit 1\n`,
    );
    await Deno.chmod(`${bin}/git`, 0o755);
    // Executable resolution only stats PATH entries; this file never runs.
    await Deno.writeTextFile(`${bin}/codex`, "");

    const child = await new Deno.Command(Deno.execPath(), {
      // The launcher's fixed child invocation is `run -A <entrypoint>`; the
      // child environment below is complete and controlled by this test.
      args: ["run", "-A", `${ROOT}/${HOSTED_RUNTIME_CHILD_ENTRYPOINT}`],
      cwd: root,
      clearEnv: true,
      env: {
        ...hostedEnv(FIXED_LAUNCHER),
        PATH: bin,
        HOME: root,
        TMPDIR: root,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(child.stdout);
    const stderr = new TextDecoder().decode(child.stderr);
    const lines = stdout.split("\n").map((line) => line.trim()).filter((line) =>
      line.length > 0
    );

    // Setup began at the controller-revision read and failed there, so the
    // child never reached any later preparation.
    assert.equal(await pathExists(marker), true, stderr);
    assert.notEqual(child.code, 0, stderr);
    assert.ok(
      stderr.includes("could not read an exact controller commit"),
      stderr,
    );

    // The announced window therefore proves the origin and its ONE absolute
    // deadline were established before that setup, and the arithmetic is the
    // production derivation, not a second copy of it.
    const windowLine = lines.find((line) =>
      line.includes('"sentinel_run_window"')
    );
    assert.ok(windowLine !== undefined, `stdout: ${stdout}\nstderr: ${stderr}`);
    const parsed = JSON.parse(windowLine) as Record<string, unknown>;
    assert.equal(parsed.kind, "sentinel_run_window");
    assert.equal(typeof parsed.originAt, "number");
    assert.equal(typeof parsed.deadlineAt, "number");
    assert.equal(
      parsed.deadlineAt,
      childRunDeadlineV1(parsed.originAt as number),
    );
    // It is emitted before the first credential read, so it is the child's
    // first advisory line.
    assert.equal(lines[0], windowLine);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("hosted runtime: the real host hands its origin-anchored deadline to the production target-cycle call", async () => {
  // The defect under regression is a deadline computed LATE: a host that
  // recomputes `childRunDeadlineV1(clock.now())` after its own setup hands the
  // cycles a deadline shifted by however long setup took. This scenario runs
  // the REAL `runActionsRepairHost` setup to completion over one local fixture
  // checkout and one local bare state remote, with the injected clock advancing
  // during that setup, then observes the deadline production actually supplies
  // to its target-cycle call. No live GitHub, model or network request is made.
  const root = await Deno.makeTempDir({
    prefix: "sentinel-host-wiring-",
    dir: ROOT,
  });
  const env = testGitEnv(`${root}/git-home`);
  await Deno.mkdir(`${root}/git-home`, { recursive: true });
  try {
    // The real checkout the host reads its controller revision and its
    // committed target setting from, plus the executable-resolution stub.
    const checkoutDir = `${root}/checkout`;
    const checkoutSha = await makeCheckout(checkoutDir, env, {
      "sentinel.targets.json": JSON.stringify(["ubiquity/sentinel"]),
      ".gitignore": ".sentinel-actions-state/\n",
    });
    const bin = `${root}/bin`;
    await Deno.mkdir(bin);
    await Deno.writeTextFile(`${bin}/codex`, "");

    // One disposable bare remote holds BOTH durable state refs. Its release
    // ref carries the exact saved execution pointer the host must read before
    // it may run.
    const remote = await makeRemoteCtx(root, env);
    await Deno.mkdir(`${root}/release-scratch`, { recursive: true });
    const release = createReleaseStateStore({
      scratchDir: `${root}/release-scratch`,
      remoteUrl: remote.remoteUrl,
    });
    const execution = parseHostedExecutionIntentV1({
      id: `${RUN_ID}:${RUN_ATTEMPT}:repair`,
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT,
      launcherSha: checkoutSha,
      purpose: "ordinary",
      revision: checkoutSha,
      generation: 1,
      releaseId: null,
      createdAt: T0,
    });
    const releaseSnapshot = parseReleaseStateSnapshotV1({
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
        activeRevision: checkoutSha,
        generation: 1,
        lastHealthyProof: null,
        lastExecutionProof: null,
        nextOrdinaryAt: T0,
        execution,
        createdAt: T0,
        updatedAt: T0,
      }],
      hostedReleases: [],
      githubCooldowns: [],
    });
    const seeded = await release.writeRelease(releaseSnapshot, null);
    assert.ok(
      seeded.ok && seeded.value.status === "applied",
      JSON.stringify(seeded),
    );

    // The injected clock advances ONLY at fake external setup boundaries, so a
    // deadline recomputed after setup is strictly later than the run origin.
    const clock = new FakeClock(T0);
    const setupSpentMs = 7 * 60_000;
    const setup: string[] = [];
    const captured: Parameters<typeof runActionsTargetCycles>[0][] = [];
    const capturedAt: number[] = [];
    let observedRoute = "";
    const fakeOutcome = { status: "idle", detail: "fixture" } as const;
    const capability = {} as never;

    const stdoutLines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      stdoutLines.push(args.map((value) => String(value)).join(" "));
    };
    let result: Awaited<ReturnType<typeof runActionsRepairHost>>;
    try {
      result = await runActionsRepairHost({
        clock,
        env: {
          ...hostedEnv(checkoutSha),
          PATH: `${bin}:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}`,
        },
        workDir: checkoutDir,
        stateRemoteUrl: remote.remoteUrl,
        refreshSelf: () => {
          setup.push("refresh-self");
          // The self mirror refresh is real setup work; here it consumes
          // simulated run time exactly like an external fetch would.
          clock.advance(setupSpentMs);
          return Promise.resolve(checkoutSha);
        },
        resolveDefaultBranch: () => Promise.resolve("development"),
        preflight: (route) => {
          setup.push("preflight");
          observedRoute = `${route.provider}:${route.model}:${route.baseUrl}`;
          return Promise.resolve();
        },
        runTargetCycles: (input) => {
          setup.push("target-cycles");
          captured.push(input);
          capturedAt.push(clock.now());
          // The production call site has now supplied its deadline. Delegate
          // the REAL multi-target loop with only the per-target cycle faked,
          // so production code both states and consumes that exact deadline.
          return runActionsTargetCycles({
            ...input,
            composeGithub: () => capability,
            runCycle: () => Promise.resolve(fakeOutcome),
          });
        },
      });
    } finally {
      console.log = originalLog;
    }

    // The host ran its real setup and reached the production call.
    assert.deepEqual(setup, ["refresh-self", "preflight", "target-cycles"]);
    assert.equal(captured.length, 1);
    const supplied = captured[0]!.deadline;
    const atCall = capturedAt[0]!;
    // Setup advanced the clock, so a deadline recomputed at the call site
    // (`childRunDeadlineV1(clock.now())`) is strictly different from the one
    // the host captured before setup. This assertion is the regression: it
    // fails when ONLY that call-site expression is restored to the late form.
    assert.equal(atCall, T0 + setupSpentMs);
    assert.notEqual(
      childRunDeadlineV1(atCall),
      supplied,
      "the supplied deadline must not be a post-setup recomputation",
    );
    // The ONE absolute deadline is the value captured at the run origin.
    assert.equal(supplied, childRunDeadlineV1(T0));
    // The early advisory and the cycle argument are the same production value.
    const windowLine = stdoutLines.find((line) =>
      line.includes('"sentinel_run_window"')
    );
    assert.ok(windowLine !== undefined, `stdout: ${stdoutLines.join("\n")}`);
    const window = JSON.parse(windowLine) as Record<string, unknown>;
    assert.equal(window.kind, "sentinel_run_window");
    assert.equal(window.originAt, T0);
    assert.equal(window.deadlineAt, supplied);

    // The real production call settled normally on the fixture, with the
    // untouched native identity, admission and model-route defaults.
    assert.equal(result.status, "ran");
    assert.equal(result.controllerSha, checkoutSha);
    assert.equal(result.baseSha, checkoutSha);
    assert.equal(result.execution.id, `${RUN_ID}:${RUN_ATTEMPT}:repair`);
    assert.equal(result.startupReady, true);
    assert.deepEqual(result.outcome, fakeOutcome);
    assert.deepEqual(result.ciApproval, {
      approved: 0,
      pending: 0,
      unavailable: 0,
    });
    assert.equal(observedRoute, `uos:gpt-reserve:${ACTIONS_UOS_BASE_URL}`);
    // The setup really ran against the fixture: its self source mirror exists.
    assert.equal(
      await pathExists(`${checkoutDir}/.sentinel-actions-state/source/.git`),
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("streams sanitized hosted diagnostics before runtime exit", async () => {
  const FIRST_TASK_KEY = "d".repeat(64);
  const AFTER_TASK_KEY = "e".repeat(64);
  const STDERR_TASK_KEY = "f".repeat(64);
  const OVERSIZED_TASK_KEY = "1".repeat(64);
  const firstLine = diagnosticLine({ taskKey: FIRST_TASK_KEY });
  const afterLine = diagnosticLine({ taskKey: AFTER_TASK_KEY });
  const stderrLine = diagnosticLine({ taskKey: STDERR_TASK_KEY });
  const oversizedSuffix = diagnosticLine({ taskKey: OVERSIZED_TASK_KEY });
  const invalidLine = '{"kind":"sentinel_model_diagnostic"}';
  const privateLine = diagnosticLine({
    taskKey: FIRST_TASK_KEY,
    provider: HOSTED_FIXTURE_PROVIDER,
  });
  const forgedLine = JSON.stringify({
    version: "v1",
    kind: "hosted_model_diagnostic",
    advisory: true,
    execution: null,
    diagnostic: JSON.parse(firstLine),
  });

  const rig = await makeRig({
    runtimeFiles: {
      "src/host/actions.ts": streamingFixtureScript({
        firstHalf: firstLine.slice(0, 20),
        secondHalf: firstLine.slice(20),
        ignoredLines: [invalidLine, privateLine, forgedLine],
        oversizedSuffix,
        afterLine,
        stderrLine,
      }),
      ".gitignore": ".sentinel/\n",
    },
  });
  try {
    await seedRelease(rig);
    const runtimeReal = await Deno.realPath(rig.runtimeDir);
    const releaseMarker = `${runtimeReal}/release-child.txt`;
    const finishedMarker = `${runtimeReal}/child-finished.txt`;
    const streamed: {
      diagnostic: HostedModelDiagnosticV1;
      runSettled: boolean;
      finishedMarkerPresent: boolean;
    }[] = [];
    let runSettled = false;
    rig.process.realChild = true;
    const result = await launchWithSink(rig, (diagnostic) => {
      streamed.push({
        diagnostic,
        runSettled,
        finishedMarkerPresent: pathExistsSync(finishedMarker),
      });
      if (streamed.length === 1) {
        Deno.writeTextFileSync(releaseMarker, "released\n");
      }
      if (streamed.length === 2) {
        // The advisory sink is never allowed to disturb capture or settlement.
        throw new Error("forced advisory sink failure");
      }
    });
    runSettled = true;

    // The valid line was split across pipe writes and still reached the sink
    // before the child finished and before the launcher promise settled.
    assert.equal(streamed.length, 2, JSON.stringify(streamed));
    const first = streamed[0];
    const second = streamed[1];
    assert.ok(first !== undefined && second !== undefined);
    if (first === undefined || second === undefined) {
      throw new Error("unreachable");
    }
    assert.equal(first.runSettled, false);
    assert.equal(first.finishedMarkerPresent, false);
    assert.deepEqual(Object.keys(first.diagnostic).sort(), [
      "advisory",
      "diagnostic",
      "execution",
      "kind",
      "version",
    ]);
    assert.equal(first.diagnostic.version, "v1");
    assert.equal(first.diagnostic.kind, "hosted_model_diagnostic");
    assert.equal(first.diagnostic.advisory, true);
    for (const entry of streamed) {
      assert.equal(entry.runSettled, false);
      assert.equal(
        canonicalStringify(entry.diagnostic.execution),
        canonicalStringify(rig.execution),
      );
    }
    assert.deepEqual(first.diagnostic.diagnostic, {
      ...SAFE_DIAGNOSTIC,
      taskKey: FIRST_TASK_KEY,
    });
    assert.deepEqual(second.diagnostic.diagnostic, {
      ...SAFE_DIAGNOSTIC,
      taskKey: AFTER_TASK_KEY,
    });

    // Invalid, private, forged, oversized and stderr inputs produced nothing,
    // while the valid line after the oversized one resumed streaming.
    const serialized = JSON.stringify(
      streamed.map((entry) => entry.diagnostic),
    );
    for (
      const marker of [
        HOSTED_FIXTURE_PROVIDER,
        HOSTED_FIXTURE_RAW_ERROR,
        HOSTED_FIXTURE_ISSUE_BODY,
      ]
    ) {
      assert.equal(serialized.includes(marker), false, marker);
    }
    assert.equal(
      streamed.some((entry) =>
        entry.diagnostic.diagnostic.taskKey === OVERSIZED_TASK_KEY
      ),
      false,
      "an oversized line is discarded through its newline, suffix included",
    );
    assert.equal(
      streamed.some((entry) =>
        entry.diagnostic.diagnostic.taskKey === STDERR_TASK_KEY
      ),
      false,
      "stderr is never forwarded to the sink",
    );

    // A throwing advisory sink changed nothing: the real child still settles
    // the one healthy trusted terminal, and the unchanged final capture and
    // parser see exactly the two advisory lines the stream saw.
    assert.equal(result.status, "healthy", JSON.stringify(result));
    assert.equal(result.terminal?.outcome, "healthy");
    assert.equal(result.terminal?.settled, true);
    assert.equal(result.terminal?.baseSha, OBSERVED_BASE);
    assert.deepEqual(
      result.diagnostics.map((entry) => entry.diagnostic.taskKey),
      [FIRST_TASK_KEY, AFTER_TASK_KEY],
    );
    assert.equal(
      await pathExists(finishedMarker),
      true,
      "the real fixture child must have executed",
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted matrix launcher: native plan role reads one repair intent without a terminal", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const planDigest = "d".repeat(64);
    const carrier = {
      kind: "sentinel_matrix_plan",
      waveId: rig.execution.id,
      run: {
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
        launcherSha: rig.identity.launcherSha,
      },
      runtimeSha: rig.execution.revision,
      generation: rig.execution.generation,
      planDigest,
      prepared: 1,
    };
    rig.process.child = exited(JSON.stringify(carrier) + "\n");
    const result = await launch(rig, {
      env: {
        ...rig.env,
        GITHUB_JOB: "matrix_plan",
        GITHUB_OUTPUT: "/tmp/native-output",
      },
    });
    assert.equal(result.status, "healthy", JSON.stringify(result));
    assert.equal(result.terminal, null);
    assert.deepEqual(
      (result as unknown as { matrixCarrier: unknown }).matrixCarrier,
      carrier,
    );
    const child = rig.process.calls.find((call) =>
      call.args.includes("src/host/matrix-actions.ts")
    );
    assert.ok(child);
    assert.equal(child.env.GITHUB_JOB, "matrix_plan");
    assert.equal(child.env.GITHUB_OUTPUT, "/tmp/native-output");
    assert.equal(await rig.releaseHead() !== null, true);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted matrix launcher: native cell stdin and carrier never settle aggregate repair", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const head = await rig.releaseHead();
    const cellId = "c".repeat(64);
    const stdin = JSON.stringify({ planDigest: "d".repeat(64), cellId });
    const carrier = {
      kind: "sentinel_matrix_cell",
      run: {
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
        launcherSha: rig.identity.launcherSha,
      },
      runtimeSha: rig.execution.revision,
      generation: rig.execution.generation,
      cellId,
      reservationId: "reservation-1",
      resultDigest: "e".repeat(64),
      bundleDigest: "f".repeat(64),
      status: "completed",
    };
    rig.process.child = exited(
      JSON.stringify(carrier) + "\n" + childLine(rig.execution),
    );
    const input = Object.assign({
      env: { ...rig.env, GITHUB_JOB: "matrix_cell" },
    }, { stdin });
    const result = await launch(rig, input);
    assert.equal(result.status, "healthy", JSON.stringify(result));
    assert.equal(
      result.terminal,
      null,
      "cell may never mint the repair terminal",
    );
    const child = rig.process.calls.find((call) =>
      call.args.includes("src/host/matrix-actions.ts")
    );
    assert.ok(child);
    assert.equal(
      (child as ReplayCommandInputV1 & { stdin?: string }).stdin,
      stdin,
    );
    assert.equal("GITHUB_OUTPUT" in child.env, false);
    assert.equal(child.env.GITHUB_JOB, "matrix_cell");
    assert.equal(
      await rig.releaseHead(),
      head,
      "only aggregate owns settlement",
    );
    for (
      const forged of [
        { ...carrier, run: { ...carrier.run, runAttempt: RUN_ATTEMPT + 1 } },
        { ...carrier, runtimeSha: OTHER_REVISION },
        { ...carrier, generation: 2 },
        { ...carrier, cellId: "a".repeat(64) },
        { ...carrier, rawModelOutput: "do not disclose" },
      ]
    ) {
      rig.process.child = exited(JSON.stringify(forged));
      const refused = await launch(rig, input);
      assert.equal(refused.status, "unavailable");
      assert.equal(refused.terminal, null);
      assert.equal(refused.matrixCarrier, undefined);
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted matrix identity: explicit native roles share read-only repair identity", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const head = await rig.releaseHead();
    for (const job of ["matrix_plan", "matrix_cell"] as const) {
      const identity = parseHostedEnvironment(
        { ...rig.env, GITHUB_JOB: job },
        job,
      );
      assert.equal(identity.job, job);
      assert.throws(() =>
        parseHostedEnvironment({ ...rig.env, GITHUB_JOB: "repair" }, job)
      );
      assert.equal(
        (await readHostedRuntimeExecution({
          state: rig.release,
          identity,
          controllerSha: rig.execution.revision,
        })).id,
        rig.execution.id,
      );
      await assert.rejects(readHostedRuntimeExecution({
        state: rig.release,
        identity: { ...identity, runAttempt: RUN_ATTEMPT + 1 },
        controllerSha: rig.execution.revision,
      }));
      assert.equal(await rig.releaseHead(), head);
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted matrix launcher: aggregate receives only native digest JSON", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    rig.process.child = exited(childLine(rig.execution));
    const stdin = JSON.stringify({ planDigest: "d".repeat(64) });
    const result = await launch(rig, { stdin });
    assert.equal(result.status, "healthy");
    assert.ok(result.terminal);
    assert.equal(rig.process.childCalls()[0].stdin, stdin);
    const before = rig.process.childCalls().length;
    assert.equal(
      (await launch(rig, {
        stdin: JSON.stringify({ planDigest: "bad", secret: "no" }),
      })).status,
      "unavailable",
    );
    assert.equal(rig.process.childCalls().length, before);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted runtime: real child bootstrap empty stdin aggregate", async () => {
  // Retain this private fixture and both complete child streams for diagnosis.
  const root = await Deno.makeTempDir({
    prefix: "sentinel-hosted-runtime-bootstrap57-",
    dir: ROOT,
  });
  await Deno.chmod(root, 0o700);
  await Deno.mkdir(`${root}/git-home`);
  const env = testGitEnv(`${root}/git-home`);
  // CI may contain only HEAD. Historical failed-runtime proof stays private;
  // this permanent regression exercises the current checkout's real consumer.
  const current = await gitRun(ROOT, ["rev-parse", "HEAD"], env);
  assert.ok(current.ok, current.stderr);
  const revision = current.stdout.trim();
  const launcher = revision;
  const frozen = `${root}/frozen`;
  const cloned = await gitRun(root, [
    "clone",
    "-q",
    "--no-hardlinks",
    "--no-checkout",
    ROOT,
    frozen,
  ], env);
  assert.ok(cloned.ok, cloned.stderr);
  const detached = await gitRun(frozen, [
    "checkout",
    "-q",
    "--detach",
    revision,
  ], env);
  assert.ok(detached.ok, detached.stderr);
  const frozenHead = await gitRun(frozen, ["rev-parse", "HEAD"], env);
  assert.equal(frozenHead.stdout.trim(), revision);
  // Preserve a local aggregate correction over the immutable current snapshot.
  const aggregateSource = await Deno.readTextFile(
    `${ROOT}/src/host/matrix-actions.ts`,
  );
  await Deno.writeTextFile(
    `${frozen}/src/host/matrix-actions.ts`,
    aggregateSource,
  );
  const aggregateDigest = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(aggregateSource),
      ),
    ),
  ].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const sourceTree = await gitRun(ROOT, ["rev-parse", `${revision}:src`], env);
  assert.ok(sourceTree.ok, sourceTree.stderr);
  const protectedSources = await gitRun(ROOT, [
    "show",
    `${launcher}:src/host/hosted-runtime.ts`,
  ], env);
  assert.ok(protectedSources.ok, protectedSources.stderr);
  await Deno.writeTextFile(
    `${root}/protected-hosted-runtime.ts`,
    protectedSources.stdout,
    {
      mode: 0o600,
    },
  );
  const workflow = await gitRun(ROOT, [
    "show",
    `${launcher}:.github/workflows/supervisor.yml`,
  ], env);
  assert.ok(workflow.ok, workflow.stderr);
  await Deno.writeTextFile(
    `${root}/protected-supervisor.yml`,
    workflow.stdout,
    { mode: 0o600 },
  );
  const cacheInfo = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.ok(cacheInfo.success, new TextDecoder().decode(cacheInfo.stderr));
  const cachedDenoDir =
    JSON.parse(new TextDecoder().decode(cacheInfo.stdout)).denoDir;
  assert.equal(typeof cachedDenoDir, "string");
  const child = `${root}/bootstrap-child.ts`;
  await Deno.writeTextFile(
    child,
    `
import assert from "node:assert/strict";
import { runActionsRepairHost } from "./frozen/src/host/actions.ts";
import { readMatrixNativeCarrier, runActionsMatrixAggregateCycles } from "./frozen/src/host/matrix-actions.ts";
import { parseHostedExecutionIntentV1, HOSTED_RUNTIME_ID } from "./frozen/src/contracts/hosted-supervisor.ts";
import { parseRepairStateSnapshotV1, parseReleaseStateSnapshotV1 } from "./frozen/src/contracts/state-snapshots.ts";
import { parseBudgetReservationV1 } from "./frozen/src/contracts/budget-reservation.ts";
import { createReleaseStateStore, createRepairStateStore } from "./frozen/src/state/mod.ts";
import { FakeGithub } from "./frozen/tests/repair/helpers.ts";
import { canonicalStringify } from "./frozen/src/contracts/canonical.ts";
import { makeRemoteCtx, pushRawTree, sha256Hex, testGitEnv, workRecord } from "./frozen/tests/state/helpers.ts";
const T0 = 1791034316336;
const root = ${JSON.stringify(root)};
const revision = ${JSON.stringify(revision)};
const launcher = ${JSON.stringify(launcher)};
const checkout = root + "/frozen";
const env = testGitEnv(root + "/git-home");
const remote = await makeRemoteCtx(root, env);
const release = createReleaseStateStore({ scratchDir: root + "/release-scratch", remoteUrl: remote.remoteUrl });
const execution = parseHostedExecutionIntentV1({ id: "37126414865:1:repair", runId: 37126414865, runAttempt: 1, launcherSha: launcher, purpose: "bootstrap", revision, generation: 57, releaseId: null, createdAt: T0 });
const runtimeRecord = { version: "v1", kind: "hosted_runtime", id: HOSTED_RUNTIME_ID, activeRevision: revision, generation: 57, lastHealthyProof: null, lastExecutionProof: null, nextOrdinaryAt: T0, execution, createdAt: T0, updatedAt: T0 };
const seeded = await release.writeRelease(parseReleaseStateSnapshotV1({ version: "v1", kind: "release_state_snapshot", stateHead: null, sequence: 1, updatedAt: T0, releases: [], hostedRuntimes: [{ ...runtimeRecord, generation: 1, execution: null }], hostedReleases: [], githubCooldowns: [] }), null);
assert.ok(seeded.ok && seeded.value.status === "applied", JSON.stringify(seeded));
const prior = await release.readRelease();
assert.ok(prior.ok && prior.value.status === "found", JSON.stringify(prior));
if (!prior.ok || prior.value.status !== "found") throw Error("missing fixture state");
// Install only the sanitized persisted-generation fixture in this disposable remote.
const fixtureState = await pushRawTree(remote, prior.value.head, "refs/heads/sentinel-state/release", {
  "manifest.json": canonicalStringify({ version: "v1", kind: "release_state_manifest", sequence: 2, updatedAt: T0, stateHead: prior.value.head }) + "\\n",
  ["hostedRuntimes/" + await sha256Hex(HOSTED_RUNTIME_ID) + ".json"]: canonicalStringify(runtimeRecord) + "\\n",
}, env);
assert.ok(fixtureState.ok, fixtureState.stderr);
const reservationId = "e".repeat(64);
const taskId = "bootstrap-blocked-ai-114";
const repository = { owner: "ubiquity", name: "ai.ubq.fi", installationId: 155687488 };
const base = "b".repeat(40);
const branch = "sentinel/repair/" + taskId;
const blocked = workRecord(taskId, {
  repository,
  source: { kind: "issue", id: "114", revision: "c".repeat(40) },
  related: { incidentId: null, issueNumber: 114 },
  target: { base, branch, checkpoint: null, head: null, pr: null },
  nextStep: "blocked", wait: null,
  blocker: { kind: "other", message: "synthetic uncertain implementation awaiting disposition", since: T0 - 1000 },
  counters: { attempts: 3, retries: 0, reviewRounds: 0 },
  intent: { kind: "implementation", key: "impl:" + reservationId, startedAt: T0 - 9000, branch, expectedHead: null, observedBase: base, pr: null, requestId: reservationId, resultId: null },
  createdAt: T0 - 10000, updatedAt: T0 - 1000,
});
const reservation = parseBudgetReservationV1({ version: "v1", kind: "budget_reservation", id: reservationId, repository, taskId, head: base, attempt: 3, purpose: "retry", createdAt: T0 - 10000, outcome: "ambiguous", settledAt: T0 - 2000, proofRef: null });
const repairStore = createRepairStateStore({ scratchDir: root + "/repair-seed", remoteUrl: remote.remoteUrl });
const repairSeed = await repairStore.writeRepair(parseRepairStateSnapshotV1({ version: "v1", kind: "repair_state_snapshot", stateHead: null, sequence: 1, updatedAt: T0, incidents: [], evidence: [], work: [blocked], reservations: [reservation], reviews: [], replays: [], releaseRequests: [], githubCooldowns: [] }), null);
assert.ok(repairSeed.ok && repairSeed.value.status === "applied", JSON.stringify(repairSeed));
await Deno.mkdir(root + "/bin");
await Deno.writeTextFile(root + "/bin/codex", "");
const github = new FakeGithub({ baseSha: revision, openIssues: [] });
let modelCalls = 0, httpCalls = 0, artifactHttpCalls = 0, preflightCalls = 0;
const carrier = await readMatrixNativeCarrier(false, true);
assert.equal(carrier, undefined);
let result, failure;
try { result = await runActionsRepairHost({
  clock: { now: () => T0 },
  workDir: checkout,
  stateRemoteUrl: remote.remoteUrl,
  env: { GITHUB_RUN_ID: "37126414865", GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY: "ubiquity/sentinel", GITHUB_REF: "refs/heads/sentinel-supervisor", GITHUB_SHA: launcher, GITHUB_WORKFLOW_SHA: launcher, GITHUB_WORKFLOW_REF: "ubiquity/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor", GITHUB_JOB: "repair", GITHUB_TOKEN: "synthetic-native-token", SENTINEL_SUPERVISOR_TOKEN: "synthetic-app-token", UOS_AI_TOKEN: "synthetic-model-token", PATH: root + "/bin:" + env.PATH, HOME: root + "/git-home" },
  refreshSelf: () => Promise.resolve(revision),
  resolveDefaultBranch: () => Promise.resolve("development"),
  preflight: () => { preflightCalls++; return Promise.resolve(); },
  prepareTarget: () => Promise.resolve(),
  composeGithub: () => github,
  model: { modelId: "gpt-reserve", runModel: () => { modelCalls++; throw Error("bootstrap must not start a model"); } },
  http: () => { httpCalls++; throw Error("fixture must not request external HTTP"); },
  artifactHttp: () => { artifactHttpCalls++; throw Error("empty recovery must not request artifacts"); },
  runTargetCycles: (input) => runActionsMatrixAggregateCycles(input, undefined, carrier),
}); } catch (error) { failure = error; }
const repair = await repairStore.readRepair();
assert.ok(repair.ok && repair.value.status === "found", JSON.stringify(repair));
if (!repair.ok || repair.value.status !== "found") throw Error("missing repair state");
assert.deepEqual(repair.value.snapshot.work, [blocked]);
assert.deepEqual(repair.value.snapshot.reservations, [reservation]);
assert.equal(modelCalls, 0);
assert.equal(httpCalls, 0);
assert.equal(artifactHttpCalls, 0);
console.log(JSON.stringify({ kind: "bootstrap_fixture_state", stateUnchanged: true, modelCalls, httpCalls, artifactHttpCalls, preflightCalls, error: failure?.message ?? null }));
if (failure) throw failure;
assert.equal(result.status, "ran");
assert.equal(result.startupReady, true);
assert.equal(result.controllerSha, revision);
assert.equal(result.baseSha, revision);
assert.deepEqual(result.execution, execution);
assert.equal(result.outcome.status, "idle");
assert.equal(preflightCalls, 1);
assert.equal(modelCalls, 0);
assert.equal(httpCalls, 0);
assert.equal(artifactHttpCalls, 0);
assert.ok(github.calls.includes("listOpenIssues"));
console.log(JSON.stringify({ kind: "bootstrap_fixture", result, modelCalls, httpCalls, artifactHttpCalls, preflightCalls }));
`,
    { mode: 0o600 },
  );
  const runtime = new DenoReplayRuntime(Deno.execPath());
  const argv = [
    "run",
    "--frozen",
    "--cached-only",
    `--config=${frozen}/deno.json`,
    `--allow-read=${root},/usr,/bin,${Deno.execPath()}`,
    `--allow-write=${root}`,
    "--allow-run",
    "--allow-env=PATH,NODE_V8_COVERAGE",
    child,
  ];
  const result = await runtime.run({
    executable: Deno.execPath(),
    args: argv,
    cwd: frozen,
    env: { ...env, DENO_DIR: cachedDenoDir },
    maxDurationMs: 240_000,
    maxOutputBytes: 8 * 1024 * 1024,
  });
  const group = runtime.lastOwnedGroupId();
  await Deno.writeFile(`${root}/child.stdout`, result.stdout, { mode: 0o600 });
  await Deno.writeFile(`${root}/child.stderr`, result.stderr, { mode: 0o600 });
  await Deno.writeTextFile(
    `${root}/receipt.json`,
    JSON.stringify(
      {
        revision,
        launcher,
        snapshotOrigin: "current-checkout",
        sourceTree: sourceTree.stdout.trim(),
        aggregateDigest,
        argv: [Deno.execPath(), ...argv],
        group,
        result: { ...result, stdout: undefined, stderr: undefined },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({ kind: "bootstrap_fixture_capture", root, group }),
  );
  assert.ok(group !== null, "fixture child must actually spawn");
  assert.throws(() => Deno.kill(-group, "SIGCONT"), Deno.errors.NotFound);
  assert.equal(result.settled, true, `${root}/child.stderr`);
  assert.equal(result.truncated, false, `${root}/child.stderr`);
  assert.equal(result.outcome, "exited", `${root}/child.stderr`);
  assert.equal(result.exitCode, 0, `${root}/child.stderr`);
  const stdout = new TextDecoder().decode(result.stdout);
  assert.ok(
    stdout.includes('"kind":"bootstrap_fixture"'),
    `${root}/child.stdout`,
  );
});
