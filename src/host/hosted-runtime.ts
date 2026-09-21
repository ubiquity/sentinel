/**
 * Protected hosted runtime identity, pointer read and launcher.
 *
 * The workflow's repair job runs this module as the trusted wrapper around the
 * selected runtime entrypoint (`src/host/actions.ts`). Three boundaries are
 * fixed here and nowhere else:
 *
 *   - The native environment identity is parsed from the standard GitHub
 *     Actions variables (`GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`,
 *     `GITHUB_REPOSITORY`, `GITHUB_REF`, `GITHUB_SHA`, `GITHUB_WORKFLOW_SHA`,
 *     `GITHUB_WORKFLOW_REF`, `GITHUB_JOB`); no custom variable or CLI argument
 *     can supply or override any of it.
 *   - The one saved execution pointer is read strictly from the release state
 *     snapshot and must bind this exact run, attempt, launcher, execution id,
 *     controller revision and generation. Nothing is selected by time, list
 *     order or a moving ref.
 *   - The launcher verifies BOTH the launcher checkout and the runtime
 *     checkout as clean Git worktrees at their exact commits BEFORE any child
 *     runs, then settles the child through the owned-group runtime. Only a
 *     settled, untruncated real process result can produce the trusted
 *     `HostedRuntimeTerminalV1`; a child line can never attest the wrapper
 *     kind because the wrapper terminal is emitted by this trusted process.
 */

import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import { parseHostedRuntimeTerminalV1 } from "../contracts/hosted-execution.ts";
import type { HostedRuntimeTerminalV1 } from "../contracts/hosted-execution.ts";
import {
  HOSTED_SUPERVISOR_REF,
  HOSTED_SUPERVISOR_REPOSITORY,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
} from "../contracts/hosted-supervisor.ts";
import { parseHostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import { SystemClock } from "../contracts/ports.ts";
import type { Clock, StateReadView } from "../contracts/ports.ts";
import { parseReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { tryParse } from "../contracts/validation.ts";
import { DenoReplayRuntime } from "../replay/runtime.ts";
import type {
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../replay/runtime.ts";
import { createReleaseStateStore, DenoGitRunner } from "../state/mod.ts";
import {
  ensurePrivateDir,
  githubGitAuthEnv,
  joinPath,
  parseLocalModelDiagnosticV1,
} from "./local.ts";
import type { LocalModelDiagnosticV1 } from "./local.ts";

/** Exact fixed workflow ref the protected supervisor runs from. */
export const HOSTED_RUNTIME_WORKFLOW_REF =
  `${HOSTED_SUPERVISOR_REPOSITORY}/${HOSTED_SUPERVISOR_WORKFLOW_PATH}@${HOSTED_SUPERVISOR_REF}`;
/** Fixed child entrypoint inside the verified runtime checkout. */
export const HOSTED_RUNTIME_CHILD_ENTRYPOINT = "src/host/actions.ts";
/** 112 minutes, inside the workflow's 120-minute bound. */
export const HOSTED_RUNTIME_DEADLINE_MS = 112 * 60 * 1000;
/** Combined retained child stdout+stderr bound (4 MiB). */
export const HOSTED_RUNTIME_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Exact complete-only child environment (no App token, no Actions files). */
export const HOSTED_RUNTIME_CHILD_ENV_KEYS = [
  "HOME",
  "PATH",
  "GITHUB_TOKEN",
  "SENTINEL_SUPERVISOR_TOKEN",
  "SENTINEL_MODEL_BASE_URL",
  "SENTINEL_MODEL_ID",
  "SENTINEL_MODEL_FALLBACK",
  "SENTINEL_DEEPSEEK_API_KEY",
  "SENTINEL_APP_INSTALLATION_ID",
  "UOS_AI_TOKEN",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_REPOSITORY",
  "GITHUB_REF",
  "GITHUB_SHA",
  "GITHUB_WORKFLOW_SHA",
  "GITHUB_WORKFLOW_REF",
  "GITHUB_JOB",
  "TMPDIR",
  "TEMP",
  "TMP",
  "DENO_DIR",
] as const;

export const HOSTED_RUNTIME_STATIC_IDENTITY =
  "hosted runtime environment identity is invalid";
export const HOSTED_RUNTIME_STATIC_SOURCE =
  "hosted runtime source checkout is not the exact clean revision";
export const HOSTED_RUNTIME_STATIC_EXECUTION =
  "hosted runtime saved execution is unavailable";
export const HOSTED_RUNTIME_STATIC_ENV =
  "hosted runtime launcher credentials are unavailable";
export const HOSTED_RUNTIME_HEALTHY_DETAIL = "hosted runtime settled healthy";
export const HOSTED_RUNTIME_FAILED_DETAIL = "hosted runtime settled failed";
export const HOSTED_RUNTIME_UNAVAILABLE_DETAIL =
  "hosted runtime result is unavailable";

const ACTIONS_LOGIN = "github-actions[bot]";
const SENTINEL_APP_LOGIN = "ubiquity-sentinel[bot]";
/**
 * Bounded identity-transition acceptance: children at older installed
 * revisions still report the native Actions identity, and children after the
 * sentinel App migration report the App bot. Remove the old login after the
 * first App-login child settles healthy.
 */
const CHILD_ACCEPTED_LOGINS: readonly string[] = [
  ACTIONS_LOGIN,
  SENTINEL_APP_LOGIN,
];
const REMOTE_URL = "https://github.com/ubiquity/sentinel.git";
const GIT_EXECUTABLE = "/usr/bin/git";
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_DETAIL_CHARS = 4_096;
const HOSTED_TERMINAL_LOOKING = /"kind"\s*:\s*"hosted_runtime_terminal"/;
const MAX_DIAGNOSTIC_LINE_CHARS = 2_048;
const MAX_HOSTED_DIAGNOSTICS = 64;

export type HostedRuntimeJobV1 = "prepare" | "repair" | "finalize";

/** Core run identity plus the exact protected job this process runs in. */
export interface HostedRuntimeIdentityV1 {
  runId: number;
  runAttempt: number;
  launcherSha: GitSha;
  job: HostedRuntimeJobV1;
}

/**
 * Read ONLY the eight standard native identity keys this boundary validates.
 * Named reads keep the existing per-name Deno env grants sufficient; the whole
 * environment is never dumped, and no App or Actions output key is consulted.
 */
export function readHostedIdentityEnv(): Record<string, string | undefined> {
  return {
    GITHUB_RUN_ID: Deno.env.get("GITHUB_RUN_ID"),
    GITHUB_RUN_ATTEMPT: Deno.env.get("GITHUB_RUN_ATTEMPT"),
    GITHUB_REPOSITORY: Deno.env.get("GITHUB_REPOSITORY"),
    GITHUB_REF: Deno.env.get("GITHUB_REF"),
    GITHUB_SHA: Deno.env.get("GITHUB_SHA"),
    GITHUB_WORKFLOW_SHA: Deno.env.get("GITHUB_WORKFLOW_SHA"),
    GITHUB_WORKFLOW_REF: Deno.env.get("GITHUB_WORKFLOW_REF"),
    GITHUB_JOB: Deno.env.get("GITHUB_JOB"),
  };
}

/**
 * Parse the fixed native identity. Every field is mandatory and exact; a
 * mismatch (including a different caller job) is a static refusal.
 */
export function parseHostedEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  expectedJob: HostedRuntimeJobV1,
): HostedRuntimeIdentityV1 {
  const runId = parsePositiveDecimal(env.GITHUB_RUN_ID);
  const runAttempt = parsePositiveDecimal(env.GITHUB_RUN_ATTEMPT);
  if (env.GITHUB_REPOSITORY !== HOSTED_SUPERVISOR_REPOSITORY) failIdentity();
  if (env.GITHUB_REF !== HOSTED_SUPERVISOR_REF) failIdentity();
  const sha = env.GITHUB_SHA;
  if (!isGitSha(sha)) failIdentity();
  if (sha !== env.GITHUB_WORKFLOW_SHA) failIdentity();
  if (env.GITHUB_WORKFLOW_REF !== HOSTED_RUNTIME_WORKFLOW_REF) failIdentity();
  if (env.GITHUB_JOB !== expectedJob) failIdentity();
  return { runId, runAttempt, launcherSha: sha, job: expectedJob };
}

/**
 * Read the exactly one saved runtime pointer from the strict release snapshot
 * and require it to bind this run, attempt, launcher, execution id, controller
 * revision and generation. Any absence, malformation, foreign execution or
 * stale revision is a static refusal; nothing is inferred from list order.
 */
export async function readHostedRuntimeExecution(input: {
  state: StateReadView;
  identity: HostedRuntimeIdentityV1;
  controllerSha: GitSha;
}): Promise<HostedExecutionIntentV1> {
  let snapshot: ReleaseStateSnapshotV1 | null = null;
  try {
    const read = await input.state.readRelease();
    if (!read.ok) failExecution();
    if (read.value.status !== "found") failExecution();
    snapshot = parseReleaseStateSnapshotV1(read.value.snapshot);
  } catch {
    failExecution();
  }
  if (snapshot === null) failExecution();
  if (snapshot.hostedRuntimes.length !== 1) failExecution();
  const runtime = snapshot.hostedRuntimes[0];
  const execution = runtime.execution;
  if (execution === null) failExecution();
  if (execution.id !== executionIdOf(input.identity)) failExecution();
  if (
    execution.runId !== input.identity.runId ||
    execution.runAttempt !== input.identity.runAttempt ||
    execution.launcherSha !== input.identity.launcherSha
  ) {
    failExecution();
  }
  if (
    runtime.activeRevision !== input.controllerSha ||
    execution.revision !== input.controllerSha
  ) {
    failExecution();
  }
  if (runtime.generation !== execution.generation) failExecution();
  return execution;
}

export interface HostedRuntimeLauncherInputV1 {
  state: StateReadView;
  clock: Clock;
  env: Readonly<Record<string, string | undefined>>;
  launcherDir: string;
  runtimeDir: string;
  denoExecutable: string;
  /** The one process border: bounded Git identity reads and the child run. */
  process: ReplayRuntimeV1;
}

export type HostedRuntimeLauncherStatusV1 =
  | "healthy"
  | "failed"
  | "unavailable";

/**
 * One reconstructed advisory diagnostic. The wrapper kind, the advisory flag
 * and the execution intent are stamped by this trusted process only: a child
 * line can never supply them. The nested diagnostic was strictly rebuilt from
 * the child's own summary by the explicit allow-list parser.
 */
export interface HostedModelDiagnosticV1 {
  version: "v1";
  kind: "hosted_model_diagnostic";
  advisory: true;
  execution: HostedExecutionIntentV1;
  diagnostic: LocalModelDiagnosticV1;
}

export interface HostedRuntimeLauncherResultV1 {
  status: HostedRuntimeLauncherStatusV1;
  /** The trusted terminal, or null when no honest proof exists. */
  terminal: HostedRuntimeTerminalV1 | null;
  /** Static diagnostic; never raw child output. */
  detail: string;
  /**
   * Reconstructed advisory summaries from settled child stdout. Empty by
   * default; they never attest health, terminal, settlement or any authority.
   */
  diagnostics: HostedModelDiagnosticV1[];
}

/** Fixed private launcher scratch inside the ignored launcher checkout. */
export function hostedRuntimeSentinelDir(launcherDir: string): string {
  return joinPath(launcherDir, ".sentinel");
}

/**
 * Verify the launcher and runtime checkouts as clean worktrees at their exact
 * commits, read the saved execution, run the fixed child entrypoint through the
 * injected owned-group border and settle the one trusted terminal. Any
 * unsettled, truncated, thrown or unattestable result is unavailable with NO
 * terminal; a settled nonzero exit without a child result is an honest failure.
 */
export async function runHostedRuntimeLauncher(
  input: HostedRuntimeLauncherInputV1,
): Promise<HostedRuntimeLauncherResultV1> {
  try {
    return await launchHostedRuntime(input);
  } catch {
    return unavailableResult();
  }
}

async function launchHostedRuntime(
  input: HostedRuntimeLauncherInputV1,
): Promise<HostedRuntimeLauncherResultV1> {
  const identity = parseHostedEnvironment(input.env, "repair");
  const dirs = await resolveRuntimeDirectories(
    input.launcherDir,
    input.runtimeDir,
  );

  // Both source checkouts must be clean at their exact commits before the
  // child exists; HEAD commits, never refs or inputs, are the authority.
  const launcherHead = await readCleanGitHead(input.process, dirs.launcher);
  if (launcherHead !== identity.launcherSha) {
    throw new Error(HOSTED_RUNTIME_STATIC_SOURCE);
  }
  const runtimeHead = await readCleanGitHead(input.process, dirs.runtime);
  if (!isGitSha(runtimeHead)) throw new Error(HOSTED_RUNTIME_STATIC_SOURCE);

  // Scratch exists only after the source is verified; the read-only release
  // state is then read through it. No repair or release write happens here.
  const sentinelDir = hostedRuntimeSentinelDir(dirs.launcher);
  const childHome = joinPath(sentinelDir, "child-home");
  const childTmp = joinPath(sentinelDir, "child-tmp");
  const childDenoDir = joinPath(sentinelDir, "child-deno");
  await ensurePrivateDir(joinPath(sentinelDir, "state-scratch"));
  await ensurePrivateDir(joinPath(sentinelDir, "state-git-home"));
  await ensurePrivateDir(childHome);
  await ensurePrivateDir(childTmp);
  await ensurePrivateDir(childDenoDir);

  const execution = await readHostedRuntimeExecution({
    state: input.state,
    identity,
    controllerSha: runtimeHead,
  });
  if (execution.revision !== runtimeHead) {
    throw new Error(HOSTED_RUNTIME_STATIC_EXECUTION);
  }

  const startedAt = input.clock.now();
  if (!isNonNegativeSafeInteger(startedAt)) {
    throw new Error(HOSTED_RUNTIME_STATIC_ENV);
  }
  const childEnv = buildChildEnvironment(input.env, identity, {
    home: childHome,
    tmp: childTmp,
    denoDir: childDenoDir,
  });

  const run = await input.process.run({
    executable: input.denoExecutable,
    args: ["run", "-A", HOSTED_RUNTIME_CHILD_ENTRYPOINT],
    cwd: dirs.runtime,
    env: childEnv,
    maxDurationMs: HOSTED_RUNTIME_DEADLINE_MS,
    maxOutputBytes: HOSTED_RUNTIME_MAX_OUTPUT_BYTES,
  });
  const finishedAt = input.clock.now();
  // A backward or invalid clock is a refusal: no terminal instant is ever
  // fabricated to hide it.
  if (!isNonNegativeSafeInteger(finishedAt) || finishedAt < startedAt) {
    return unavailableResult();
  }
  const resolved = resolveLauncherResult({
    run,
    execution,
    startedAt,
    finishedAt,
  });
  // Advisory summaries are attached independently of the resolved status and
  // never replace the trusted terminal or the existing unhealthy exit.
  return attachDiagnostics(resolved, run, execution);
}

interface LauncherTerminalInputV1 {
  run: ReplayCommandResultV1;
  execution: HostedExecutionIntentV1;
  startedAt: number;
  finishedAt: number;
}

function resolveLauncherResult(
  input: LauncherTerminalInputV1,
): HostedRuntimeLauncherResultV1 {
  const { run } = input;
  // Truncated capture, an invocation that never began and an unproven
  // settlement are all uncertain: no terminal is ever minted from them.
  if (run.truncated) return unavailableResult();
  if (run.outcome === "spawn_failed") return unavailableResult();
  if (
    (run.outcome === "exited" || run.outcome === "timed_out") && !run.settled
  ) {
    return unavailableResult();
  }
  if (run.outcome !== "exited" && run.outcome !== "timed_out") {
    return unavailableResult();
  }

  const scan = scanChildStatusRecords(new TextDecoder().decode(run.stdout));
  if (scan.kind === "uncertain") return unavailableResult();
  const child = scan.kind === "one"
    ? parseChildStatus(scan.value, input.execution)
    : null;
  // A present-but-unusable record is uncertain, never silently ignored.
  if (scan.kind === "one" && child === null) return unavailableResult();

  // A settled owned-group timeout is an objective failed invocation; the
  // observed child metadata is preserved when a valid record exists.
  if (run.outcome === "timed_out") return failedResult(input, child);

  if (run.exitCode === null) return unavailableResult();
  if (child === null) {
    // A settled nonzero exit with no attestable child result is an honest
    // early failure; a zero exit with no result is unattestable.
    if (run.exitCode === 0) return unavailableResult();
    return failedResult(input, null);
  }
  if (run.exitCode !== 0 || !child.healthy || child.baseSha === null) {
    // A nonzero exit is a failure even beside a healthy-looking record, and a
    // child that did not attest startup health or its observed base cannot be
    // healthy; its observed metadata is still preserved.
    return failedResult(input, child);
  }
  return terminalResult(input, "healthy", true, child.baseSha);
}

function failedResult(
  input: LauncherTerminalInputV1,
  child: ChildStatusV1 | null,
): HostedRuntimeLauncherResultV1 {
  // An early no-child failure has no observed metadata; an actual child record
  // keeps its own observed startup flag and valid base SHA.
  return terminalResult(
    input,
    "failed",
    child?.startupReady ?? false,
    child?.baseSha ?? null,
  );
}

function terminalResult(
  input: LauncherTerminalInputV1,
  outcome: "healthy" | "failed",
  startupReady: boolean,
  baseSha: GitSha | null,
): HostedRuntimeLauncherResultV1 {
  const parsed = tryParse(parseHostedRuntimeTerminalV1, {
    version: "v1",
    kind: "hosted_runtime_terminal",
    execution: input.execution,
    controllerSha: input.execution.revision,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    outcome,
    startupReady,
    settled: true,
    baseSha,
  });
  if (!parsed.ok) return unavailableResult();
  return {
    status: outcome,
    terminal: parsed.value,
    detail: outcome === "healthy"
      ? HOSTED_RUNTIME_HEALTHY_DETAIL
      : HOSTED_RUNTIME_FAILED_DETAIL,
    diagnostics: [],
  };
}

/**
 * Scan only a complete bounded untruncated settled child capture for advisory
 * summaries. Each accepted line is strictly re-parsed through the shared
 * allow-list, then stamped with the already-verified execution intent; a child
 * can never supply the wrapper kind, the advisory flag or the execution.
 * Malformed, oversized, unrecognized or forged records are ignored and never
 * copied. Nothing is invented from the host duration or the exit code, and a
 * diagnostic can never create terminal or health proof.
 */
function attachDiagnostics(
  result: HostedRuntimeLauncherResultV1,
  run: ReplayCommandResultV1,
  execution: HostedExecutionIntentV1,
): HostedRuntimeLauncherResultV1 {
  const diagnostics = scanChildDiagnostics(run, execution);
  if (diagnostics.length === 0) return result;
  return { ...result, diagnostics };
}

function scanChildDiagnostics(
  run: ReplayCommandResultV1,
  execution: HostedExecutionIntentV1,
): HostedModelDiagnosticV1[] {
  if (run.truncated || !run.settled) return [];
  if (run.outcome !== "exited" && run.outcome !== "timed_out") return [];
  const found: HostedModelDiagnosticV1[] = [];
  const stdout = new TextDecoder().decode(run.stdout);
  for (const rawLine of stdout.split("\n")) {
    if (found.length >= MAX_HOSTED_DIAGNOSTICS) break;
    const line = rawLine.trim();
    if (line.length === 0 || line.length > MAX_DIAGNOSTIC_LINE_CHARS) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const diagnostic = parseLocalModelDiagnosticV1(value);
    if (diagnostic === null) continue;
    found.push({
      version: "v1",
      kind: "hosted_model_diagnostic",
      advisory: true,
      execution,
      diagnostic,
    });
  }
  return found;
}

type ChildStatusScanV1 =
  | { kind: "none" }
  | { kind: "one"; value: unknown }
  | { kind: "uncertain" };

/**
 * A child status record is one whole JSON line carrying a `status` property.
 * More than one, any malformed attempt at one, or any attempted
 * `hosted_runtime_terminal` record, is uncertain: the child can never attest
 * the wrapper's own terminal kind.
 */
function scanChildStatusRecords(stdout: string): ChildStatusScanV1 {
  let found: unknown = null;
  let count = 0;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (HOSTED_TERMINAL_LOOKING.test(line)) return { kind: "uncertain" };
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // Any object-looking line that is not COMPLETE JSON is ambiguous
      // structured output, never ignored beside a valid record: a truncated
      // key, value or tail may hide a second record. Plain non-object text
      // noise is still skipped.
      if (line.startsWith("{")) return { kind: "uncertain" };
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const record = value as Record<string, unknown>;
    // ANY own status property is a top-level attempt: a false/null/number
    // status is rejected by the strict child parser, never skipped as noise.
    if (!Object.hasOwn(record, "status")) continue;
    count += 1;
    if (count === 1) found = record;
  }
  if (count === 0) return { kind: "none" };
  if (count > 1) return { kind: "uncertain" };
  return { kind: "one", value: found };
}

interface ChildStatusV1 {
  /** Observed child startup flag; never derived from the wrapper outcome. */
  startupReady: boolean;
  /** Observed base SHA when it is a valid GitSha, else null. */
  baseSha: GitSha | null;
  /** The child reported a healthy-shaped successful outcome. */
  healthy: boolean;
}

const CHILD_RESULT_KEYS = [
  "status",
  "outcome",
  "controllerSha",
  "baseSha",
  "login",
  "startupReady",
  "ciApproval",
  "execution",
] as const;

/**
 * Strict validation of the one printed `ActionsRepairHostResultV1` record. A
 * structurally invalid, foreign or mismatched record is null (uncertain); a
 * structurally valid record whose child reported an explicit failure maps to
 * failed. Health additionally requires the valid observed base SHA.
 */
function parseChildStatus(
  value: unknown,
  execution: HostedExecutionIntentV1,
): ChildStatusV1 | null {
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, CHILD_RESULT_KEYS)) return null;
  if (record.status !== "ran") return null;
  const parsedExecution = tryParse(
    parseHostedExecutionIntentV1,
    record.execution,
  );
  if (!parsedExecution.ok) return null;
  if (
    canonicalStringify(parsedExecution.value) !== canonicalStringify(execution)
  ) {
    return null;
  }
  if (record.controllerSha !== execution.revision) return null;
  if (
    typeof record.login !== "string" ||
    !CHILD_ACCEPTED_LOGINS.includes(record.login)
  ) return null;
  if (typeof record.startupReady !== "boolean") return null;
  if (!isCiApproval(record.ciApproval)) return null;
  if (typeof record.baseSha !== "string") return null;
  const outcome = record.outcome;
  if (
    typeof outcome !== "object" || outcome === null || Array.isArray(outcome)
  ) {
    return null;
  }
  const status = (outcome as Record<string, unknown>).status;
  if (!isChildOutcome(outcome, status)) return null;

  return {
    startupReady: record.startupReady,
    baseSha: isGitSha(record.baseSha) ? record.baseSha : null,
    healthy: record.startupReady === true &&
      (status === "idle" || status === "margin" || status === "step_limit"),
  };
}

function isChildOutcome(value: unknown, status: unknown): boolean {
  if (typeof status !== "string") return false;
  const record = value as Record<string, unknown>;
  if (status === "step_limit") {
    return hasExactKeys(record, ["status", "steps"]) &&
      isNonNegativeSafeInteger(record.steps);
  }
  if (
    status === "idle" || status === "margin" || status === "state_error" ||
    status === "source_error"
  ) {
    return hasExactKeys(record, ["status", "detail"]) &&
      typeof record.detail === "string" && record.detail.length > 0 &&
      record.detail.length <= MAX_DETAIL_CHARS;
  }
  return false;
}

function isCiApproval(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ["approved", "pending", "unavailable"])) {
    return false;
  }
  return isNonNegativeSafeInteger(record.approved) &&
    isNonNegativeSafeInteger(record.pending) &&
    isNonNegativeSafeInteger(record.unavailable);
}

function hasExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(record);
  return own.length === keys.length &&
    keys.every((key) => Object.hasOwn(record, key));
}

function buildChildEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  identity: HostedRuntimeIdentityV1,
  dirs: { home: string; tmp: string; denoDir: string },
): Record<string, string> {
  const path = env.PATH;
  const githubToken = env.GITHUB_TOKEN;
  const appToken = env.SENTINEL_SUPERVISOR_TOKEN;
  const modelToken = env.UOS_AI_TOKEN;
  if (
    !isNonEmptyText(path) || !isNonEmptyText(githubToken) ||
    !isNonEmptyText(modelToken)
  ) {
    throw new Error(HOSTED_RUNTIME_STATIC_ENV);
  }
  // Complete-only child environment: the existing credentials, the optional
  // scoped sentinel App token that authenticates every code-change write, and
  // the validated standard identity, plus private HOME/cache/temp. The App
  // private key never crosses over, no Actions output/env/path files and no
  // host variable crosses over. The App token is optional only during the
  // bounded identity transition: a child at an older installed revision
  // ignores it, and the launcher must not fail when it is absent.
  const child: Record<string, string> = {
    HOME: dirs.home,
    PATH: path,
    GITHUB_TOKEN: githubToken,
    UOS_AI_TOKEN: modelToken,
    GITHUB_RUN_ID: String(identity.runId),
    GITHUB_RUN_ATTEMPT: String(identity.runAttempt),
    GITHUB_REPOSITORY: HOSTED_SUPERVISOR_REPOSITORY,
    GITHUB_REF: HOSTED_SUPERVISOR_REF,
    GITHUB_SHA: identity.launcherSha,
    GITHUB_WORKFLOW_SHA: identity.launcherSha,
    GITHUB_WORKFLOW_REF: HOSTED_RUNTIME_WORKFLOW_REF,
    GITHUB_JOB: identity.job,
    TMPDIR: dirs.tmp,
    TEMP: dirs.tmp,
    TMP: dirs.tmp,
    DENO_DIR: dirs.denoDir,
  };
  if (isNonEmptyText(appToken)) {
    child.SENTINEL_SUPERVISOR_TOKEN = appToken;
  }
  // Optional model-route inputs, forwarded only when non-empty so an unset
  // route keeps the primary gateway behaviour exactly as before. The child's
  // own trusted resolver decides the route; the launcher never selects one and
  // the DeepSeek key is only ever a forwarded value, never logged.
  for (
    const key of [
      "SENTINEL_MODEL_BASE_URL",
      "SENTINEL_MODEL_ID",
      "SENTINEL_MODEL_FALLBACK",
      "SENTINEL_DEEPSEEK_API_KEY",
      "SENTINEL_APP_INSTALLATION_ID",
    ] as const
  ) {
    const value = env[key];
    if (isNonEmptyText(value)) child[key] = value;
  }
  return child;
}

/** Canonical real directories: the runtime is the launcher's fixed sibling. */
async function resolveRuntimeDirectories(
  launcherDir: string,
  runtimeDir: string,
): Promise<{ launcher: string; runtime: string }> {
  const launcher = await realDirectory(launcherDir);
  const runtime = await realDirectory(runtimeDir);
  if (runtime !== joinPath(parentDirectory(launcher), "runtime")) {
    throw new Error(HOSTED_RUNTIME_STATIC_SOURCE);
  }
  if (runtime === launcher) throw new Error(HOSTED_RUNTIME_STATIC_SOURCE);
  return { launcher, runtime };
}

async function realDirectory(path: string): Promise<string> {
  let real: string;
  try {
    real = await Deno.realPath(path);
  } catch {
    throw new Error(HOSTED_RUNTIME_STATIC_SOURCE);
  }
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(real);
  } catch {
    throw new Error(HOSTED_RUNTIME_STATIC_SOURCE);
  }
  if (!info.isDirectory) throw new Error(HOSTED_RUNTIME_STATIC_SOURCE);
  return real;
}

/** Exact commit of a clean worktree, read with fixed credential-free git. */
export async function readCleanGitHead(
  process: ReplayRuntimeV1,
  dir: string,
): Promise<GitSha> {
  const head = await runBoundedGit(process, dir, ["rev-parse", "HEAD"]);
  if (head === null || !isGitSha(head)) {
    throw new Error(HOSTED_RUNTIME_STATIC_SOURCE);
  }
  const status = await runBoundedGit(process, dir, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (status === null || status !== "") {
    throw new Error(HOSTED_RUNTIME_STATIC_SOURCE);
  }
  return head;
}

async function runBoundedGit(
  process: ReplayRuntimeV1,
  dir: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    const result = await process.run({
      executable: GIT_EXECUTABLE,
      args: ["-c", "core.hooksPath=/dev/null", "-C", dir, ...args],
      cwd: dir,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: dir,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      maxDurationMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
    });
    if (
      result.outcome !== "exited" || !result.settled || result.truncated ||
      result.exitCode !== 0
    ) {
      return null;
    }
    return new TextDecoder().decode(result.stdout).trim();
  } catch {
    return null;
  }
}

function executionIdOf(identity: HostedRuntimeIdentityV1): string {
  return `${identity.runId}:${identity.runAttempt}:repair`;
}

function parsePositiveDecimal(value: string | undefined): number {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) failIdentity();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) failIdentity();
  return parsed;
}

function parentDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  if (index < 0) return ".";
  if (index === 0) return "/";
  return path.slice(0, index);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyText(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function failIdentity(): never {
  throw new Error(HOSTED_RUNTIME_STATIC_IDENTITY);
}

function failExecution(): never {
  throw new Error(HOSTED_RUNTIME_STATIC_EXECUTION);
}

function unavailableResult(): HostedRuntimeLauncherResultV1 {
  return {
    status: "unavailable",
    terminal: null,
    detail: HOSTED_RUNTIME_UNAVAILABLE_DETAIL,
    diagnostics: [],
  };
}

/**
 * Production entrypoint: fixed launcher cwd, fixed sibling runtime, the actual
 * Deno executable and the existing native token for a read-only release-state
 * read in the private ignored launcher scratch. No App credential is read and
 * no test-only override exists in this path.
 */
export async function runHostedRuntimeMain(): Promise<
  HostedRuntimeLauncherResultV1
> {
  try {
    // Only the named keys are read: the eight identity fields plus the four
    // existing process inputs. No unrestricted env access is required.
    const env = {
      ...readHostedIdentityEnv(),
      HOME: Deno.env.get("HOME"),
      PATH: Deno.env.get("PATH"),
      GITHUB_TOKEN: Deno.env.get("GITHUB_TOKEN"),
      SENTINEL_SUPERVISOR_TOKEN: Deno.env.get("SENTINEL_SUPERVISOR_TOKEN"),
      SENTINEL_MODEL_BASE_URL: Deno.env.get("SENTINEL_MODEL_BASE_URL"),
      SENTINEL_MODEL_ID: Deno.env.get("SENTINEL_MODEL_ID"),
      SENTINEL_MODEL_FALLBACK: Deno.env.get("SENTINEL_MODEL_FALLBACK"),
      SENTINEL_DEEPSEEK_API_KEY: Deno.env.get("SENTINEL_DEEPSEEK_API_KEY"),
      SENTINEL_APP_INSTALLATION_ID: Deno.env.get("SENTINEL_APP_INSTALLATION_ID"),
      UOS_AI_TOKEN: Deno.env.get("UOS_AI_TOKEN"),
    };
    // Native identity is the first check: a malformed job identity fails
    // before any credential, checkout or state setup.
    parseHostedEnvironment(env, "repair");
    const launcherDir = Deno.cwd();
    const runtimeDir = joinPath(launcherDir, "..", "runtime");
    const token = env.GITHUB_TOKEN;
    if (!isNonEmptyText(token)) throw new Error(HOSTED_RUNTIME_STATIC_ENV);
    const sentinelDir = hostedRuntimeSentinelDir(launcherDir);
    const state = createReleaseStateStore({
      scratchDir: joinPath(sentinelDir, "state-scratch"),
      remoteUrl: REMOTE_URL,
      runner: new DenoGitRunner(
        joinPath(sentinelDir, "state-git-home"),
        githubGitAuthEnv(token),
      ),
    });
    const result = await runHostedRuntimeLauncher({
      state,
      clock: new SystemClock(),
      env,
      launcherDir,
      runtimeDir,
      denoExecutable: Deno.execPath(),
      process: new DenoReplayRuntime(Deno.execPath()),
    });
    return result;
  } catch {
    return unavailableResult();
  }
}

if (import.meta.main) {
  const result = await runHostedRuntimeMain();
  // Each reconstructed advisory is printed first; it is not evidence. Then
  // only the trusted parsed terminal is ever printed. A failed or unavailable
  // run prints no terminal record and exits nonzero.
  for (const diagnostic of result.diagnostics) {
    console.log(JSON.stringify(diagnostic));
  }
  if (result.terminal !== null) console.log(JSON.stringify(result.terminal));
  if (result.status !== "healthy") {
    console.error(result.detail);
    Deno.exit(1);
  }
}
