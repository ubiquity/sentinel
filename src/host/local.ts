/**
 * Concrete local repair host for the authorized ubiquity/sentinel target.
 *
 * One bounded hourly pass over real trusted capabilities: a private state
 * root with an exclusive writer lock and crash marker, a persistent local
 * state Git repository, a persistent trusted source checkout, one
 * authenticated GitHub login, one shared durable cooldown gate, the real
 * Codex review transport and a per-task isolated Codex implementation
 * checkout. Incident and replay capability stay explicitly unavailable: no
 * empty fixture is ever reported as success.
 *
 * Trusted inputs only. Tokens are read from the caller/environment, written
 * to mode-0600 files outside every checkout and never reach a model child
 * environment or a log line.
 */

import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import { portError, portOk, SystemClock } from "../contracts/ports.ts";
import type {
  Clock,
  EncryptedArtifactV1,
  GitHubCooldownGateV1,
  GitHubIssueV1,
  GitHubPort,
  ImplementationPort,
  IncidentAdapter,
  IncidentPageV1,
  IsolatedReplayResultV1,
  ModelIdV1,
  ModelRunReceiptV1,
  ModelRunRequestV1,
  PortErrorKindV1,
  PortResultV1,
  ReasoningEffortV1,
  RepairStateWriter,
  ReplayPort,
  ReplayRunRequestV1,
  StateReadView,
} from "../contracts/ports.ts";
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type { IncidentEvidenceV1 } from "../contracts/incident.ts";
import { parseRepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { createRepairStateStore } from "../state/mod.ts";
import { composeLocalReleaseReader } from "./local-release.ts";
import { RollingStartBudget } from "../budget/mod.ts";
import type { GitHubAuthProviderV1 } from "../github/auth.ts";
import { GitHubApiClient } from "../github/client.ts";
import { fetchHttpTransport, headerMap } from "../github/http.ts";
import type { HttpTransportV1 } from "../github/http.ts";
import { classifyGitHubRateLimit } from "../github/rate-limit.ts";
import { GitReviewSnapshot } from "../github/review-snapshot.ts";
import { CodexStructuredReviewer } from "../github/codex-reviewer.ts";
import { GitHubCodexReviewTransport } from "../github/codex-review-transport.ts";
import {
  type CodexSessionV1,
  CodexSubprocessSession,
} from "../repair/codex-transport.ts";
import {
  type CandidateCommitterV1,
  CodexImplementationPort,
  LocalCandidateCommitter,
  LOOP_STOP_MARKER,
} from "../repair/model-port.ts";
import { DurableGitHubCooldownGate } from "../repair/github-cooldown.ts";
import type { RepairCycleOutcomeV1 } from "../repair/loop.ts";
import { DenoReplayRuntime } from "../replay/runtime.ts";
import { composeGitHubHost } from "./github.ts";
import { runRepairEntrypoint } from "../main.ts";

/** Fixed local target identity (explicit no-App owner credential scope). */
const LOCAL_REPOSITORY: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "sentinel",
  installationId: 0,
};

const REMOTE_URL = "https://github.com/ubiquity/sentinel.git";
const API_BASE_URL = "https://api.github.com";
const API_USER_URL = "https://api.github.com/user";
/** Local default; hosted Actions supplies the public UOS gateway explicitly. */
export const DEFAULT_UOS_BASE_URL = "http://127.0.0.1:8000/v1";

const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;
const RUN_DEADLINE_MS = 3_600_000;
const STEP_LIMIT = 64;
const SESSION_DEADLINE_MS = 1_500_000;
const REVIEW_SESSION_DEADLINE_MS = 1_200_000;
const HOUR_MS = 3_600_000;

/** Applied runtime implementation model identity (fixed, not overridable). */
const IMPLEMENTATION_MODEL = "gpt-5.6-luna";
const IMPLEMENTATION_REASONING = "max";

const UNAVAILABLE_DETAIL = "local target does not provide this capability";

const STATIC_INVALID_OPTIONS =
  "local repair host rejected: host options are invalid";
const STATIC_INVALID_CONTROLLER =
  "local repair host rejected: controller SHA is not an exact lowercase 40-hex commit SHA";
const STATIC_ORPHAN =
  "local repair host refused: a prior run left an active session marker; orphan recovery is not reclaimed by time or process guess";
const STATIC_UNSETTLED =
  "local repair host failed: owned model sessions did not settle; the session marker was retained";
const STATIC_GIT_FAILED =
  "local repair host git command failed; output withheld";
const STATIC_GIT_BOUND =
  "local repair host git command exceeded its bounded output";
const STATIC_GITHUB_LOGIN =
  "local repair host rejected: authenticated GitHub login is unavailable";
const STATIC_MODEL_INPUT =
  "local repair host rejected: model request is invalid";
const STATIC_CHECKOUT =
  "local repair host rejected: isolated model checkout is unavailable";
const STATIC_IMPORT =
  "local repair host failed: candidate objects could not be imported into the trusted source repository";
const STATIC_MODEL_RESULT =
  "local repair host failed: the private model result receipt could not be persisted; no candidate was imported";
const STATIC_MARKER =
  "local repair host failed: the session marker could not be cleared";

/** Caller-supplied trusted inputs for one bounded local run. */
export interface LocalRepairHostOptionsV1 {
  stateRoot: string;
  sourceDir: string;
  controllerSha: GitSha;
  githubToken: string;
  modelToken: string;
  codexExecutable: string;
  denoExecutable: string;
  trustedPath: string;
}

/** Outcome of one startup attempt. Busy is an explicit refusal, not a wait. */
export type LocalRepairHostRunV1 =
  | { status: "busy" }
  | { status: "ran"; outcome: RepairCycleOutcomeV1; statusPath: string };

/** A prior marker proves a possible orphaned writer; never reclaimed here. */
export class LocalHostOrphanError extends Error {
  constructor() {
    super(STATIC_ORPHAN);
    this.name = "LocalHostOrphanError";
  }
}

/** Owned sessions did not settle; the marker and lock are retained. */
export class LocalHostSettlementError extends Error {
  constructor() {
    super(STATIC_UNSETTLED);
    this.name = "LocalHostSettlementError";
  }
}

// ---------------------------------------------------------------------------
// Fixed configuration (pure; no I/O)
// ---------------------------------------------------------------------------

/** The one fixed local repository configuration, through the frozen parser. */
export function createLocalRepositoryConfig(): RepositoryConfigV1 {
  return parseRepositoryConfigV1({
    version: "v1",
    kind: "repository_config",
    repository: { ...LOCAL_REPOSITORY },
    baseBranch: "development",
    adapter: { kind: "github" },
    commands: { replay: "replay_capture", test: "test_ci" },
    commandRegistry: {
      version: "v1",
      commands: {
        test_ci: {
          executable: "deno",
          args: ["task", "test:local"],
          maxDurationMs: 1_800_000,
          maxOutputBytes: 4_194_304,
        },
        replay_capture: {
          executable: "deno",
          args: ["task", "replay:capture"],
          maxDurationMs: 600_000,
          maxOutputBytes: 1_048_576,
        },
      },
    },
    protectedPaths: [
      ".github/workflows/",
      "AGENTS.md",
      "MASTER-PLAN.md",
      "deno.json",
      "docs/build-status.md",
      "src/contracts/actions-release.ts",
      "src/contracts/local-release.ts",
      "src/contracts/ports.ts",
      "src/github/client.ts",
      "src/github/http.ts",
      "src/host/actions-ci.ts",
      "src/host/actions-preflight.ts",
      "src/host/actions-release.ts",
      "src/host/actions.ts",
      "src/host/local-release.ts",
      "src/host/local-supervisor.ts",
      "src/host/local.ts",
      "src/main.ts",
      "src/repair/loop.ts",
      "src/budget/",
    ],
    build: { projectId: null, acceptance: null },
    secretRef: "secret://host/injected/sentinel-local-owner",
    liveStartLimits: { perHour: 1, perSevenDays: 168 },
    sessionBound: { maxDurationMs: 1_200_000, maxOutputChars: 4_000_000 },
    retention: null,
    stabilityPolicy: null,
  });
}

/** Inputs of one isolated Codex client configuration. */
export interface LocalCodexConfigInputV1 {
  profile: "sentinel-local" | "sentinel-review";
  /** Private model token file read by the app-server auth command. */
  tokenFile: string;
  /** HOME of shell commands: the isolated checkout. */
  shellHome: string;
  shellPath: string;
  shellTmpDir: string;
  shellDenoDir: string;
  /** Exact executable launched by the trusted host; sandbox helpers must be
   * able to execute this path when loading project instructions. */
  codexExecutable: string;
  codexDistributionDir: string;
  denoExecutable: string;
  /** Exact extra writable grants outside the checkout (empty for review). */
  writeGrants: string[];
  /** Trusted provider endpoint; local callers use the loopback default. */
  baseUrl?: string;
}

/**
 * Installed CommandLineTools Git directory. It precedes `/usr/bin` in the model
 * shell PATH when present, avoiding the macOS xcrun shim.
 */
const COMMAND_LINE_TOOLS_BIN = "/Library/Developer/CommandLineTools/usr/bin";

/** Read-only Git system configuration of that exact installed Git. */
const COMMAND_LINE_TOOLS_GIT_CORE =
  "/Library/Developer/CommandLineTools/usr/share/git-core";

/**
 * Render the per-client Codex configuration: provider uos over the local
 * app-server gateway, top-level approval/login/permission defaults, the proved
 * flat filesystem and network permission tables (relative grants live under
 * `:workspace_roots`) and a fixed minimal environment. Pure text; no token
 * value is ever included.
 */
export function renderLocalCodexConfig(input: LocalCodexConfigInputV1): string {
  const profile = input.profile;
  const lines = [
    "# Sentinel local host client config (generated; do not edit).",
    'approval_policy = "never"',
    "allow_login_shell = false",
    `default_permissions = ${toml(profile)}`,
    'model_provider = "uos"',
    "",
    "[model_providers.uos]",
    'name = "uos"',
    `base_url = "${input.baseUrl ?? DEFAULT_UOS_BASE_URL}"`,
    'wire_api = "responses"',
    "",
    "[model_providers.uos.auth]",
    'command = "/bin/cat"',
    `args = [${toml(input.tokenFile)}]`,
    "",
    "[features]",
    "apps = false",
    "multi_agent = false",
    "plugins = false",
    "web_search = false",
    "",
    `[permissions.${profile}.filesystem]`,
    '":minimal" = "read"',
    `${toml(COMMAND_LINE_TOOLS_GIT_CORE)} = "read"`,
    `${toml(COMMAND_LINE_TOOLS_BIN)} = "read"`,
    `${toml(input.codexExecutable)} = "read"`,
    `${toml(input.codexDistributionDir)} = "read"`,
    `${toml(input.denoExecutable)} = "read"`,
  ];
  if (profile === "sentinel-local") {
    for (const grant of input.writeGrants) {
      lines.push(`${toml(grant)} = "write"`);
    }
  }
  lines.push(
    "",
    `[permissions.${profile}.filesystem.":workspace_roots"]`,
  );
  if (profile === "sentinel-local") {
    lines.push(
      '"." = "write"',
      '".git" = "read"',
      '".codex" = "read"',
    );
  } else {
    lines.push('"." = "read"');
  }
  lines.push(
    "",
    `[permissions.${profile}.network]`,
    "enabled = false",
    "",
    "[shell_environment_policy]",
    'inherit = "none"',
    "",
    "[shell_environment_policy.set]",
    `PATH = ${toml(localClientShellPath(input.shellPath))}`,
    `HOME = ${toml(input.shellHome)}`,
    `TMPDIR = ${toml(input.shellTmpDir)}`,
    `DENO_DIR = ${toml(input.shellDenoDir)}`,
    "",
  );
  return lines.join("\n");
}

/** Stable private checkout key of one task (SHA-256 hex). */
export async function localCheckoutKey(taskId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(taskId),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Private local model-result diagnostics (outside every model checkout)
// ---------------------------------------------------------------------------

/**
 * Fixed private classification of one local model result, derived ONLY from
 * the receipt's own evidence. It never invents a cause or a model success.
 */
export type LocalModelResultReasonV1 =
  | "output_limit"
  | "failed_command_loop"
  | "host_timeout"
  | "runtime_error"
  | null;

/**
 * Minimal private JSON projection of exactly one local model result. It is an
 * explicit allow-list: no issue, evidence, prompt, changed path, raw error or
 * credential content is ever serialized.
 */
export interface LocalModelResultProjectionV1 {
  version: "v1";
  kind: "local_model_result";
  taskId: string;
  base: string;
  requested: {
    model: ModelIdV1;
    reasoning: ReasoningEffortV1;
    maxDurationMs: number;
    maxOutputChars: number;
  };
  observedAt: number;
  result:
    | {
      ok: true;
      outcome: "completed" | "failed" | "interrupted";
      actual: {
        provider: string;
        threadId: string;
        turnId: string;
        terminalOrigin: "runtime" | "host-timeout";
        observedTerminalStatus: "completed" | "interrupted" | "failed" | null;
        observedModel: string;
        observedReasoning: string;
        durationMs: number;
        outputChars: number;
      };
      candidate: { head: string | null; changedPathCount: number } | null;
    }
    | { ok: false; errorKind: PortErrorKindV1 };
  reason: LocalModelResultReasonV1;
}

/**
 * Persist one private minimal model-result diagnostic for a task under
 * `<stateRoot>/model-results/<localCheckoutKey(taskId)>/`, using a unique
 * `crypto.randomUUID()` filename, private 0700 directories and a 0600 file.
 * Returns the exact written path. This diagnostic stays outside every model
 * checkout and is never part of Actions status or public logs. A throw means
 * the receipt was not saved: the caller must not import or publish a candidate.
 */
export async function writeLocalModelResult(
  stateRoot: string,
  request: ModelRunRequestV1,
  result: PortResultV1<ModelRunReceiptV1>,
  observedAt: number,
): Promise<string> {
  const key = await localCheckoutKey(request.taskId);
  const root = joinPath(stateRoot, "model-results");
  const dir = joinPath(root, key);
  await ensurePrivateDir(stateRoot);
  await ensurePrivateDir(root);
  await ensurePrivateDir(dir);
  const path = joinPath(dir, `${crypto.randomUUID()}.json`);
  await writePrivateFile(
    path,
    JSON.stringify(projectLocalModelResult(request, result, observedAt)) + "\n",
  );
  return path;
}

function projectLocalModelResult(
  request: ModelRunRequestV1,
  result: PortResultV1<ModelRunReceiptV1>,
  observedAt: number,
): LocalModelResultProjectionV1 {
  const common = {
    version: "v1" as const,
    kind: "local_model_result" as const,
    taskId: request.taskId,
    base: request.base,
    requested: {
      model: request.model,
      reasoning: request.reasoning,
      maxDurationMs: request.maxDurationMs,
      maxOutputChars: request.maxOutputChars,
    },
    observedAt,
  };
  const reason = localModelResultReason(request, result);
  if (!result.ok) {
    return {
      ...common,
      result: { ok: false, errorKind: result.error.kind },
      reason,
    };
  }
  const receipt = result.value;
  return {
    ...common,
    result: {
      ok: true,
      outcome: receipt.outcome,
      actual: {
        provider: receipt.actual.provider,
        threadId: receipt.actual.threadId,
        turnId: receipt.actual.turnId,
        terminalOrigin: receipt.actual.terminalOrigin,
        observedTerminalStatus: receipt.actual.observedTerminalStatus,
        observedModel: receipt.actual.observedModel,
        observedReasoning: receipt.actual.observedReasoning,
        durationMs: receipt.actual.durationMs,
        outputChars: receipt.actual.outputChars,
      },
      candidate: receipt.candidate === null ? null : {
        head: receipt.candidate.head,
        changedPathCount: receipt.candidate.changedPaths.length,
      },
    },
    reason,
  };
}

/** Fixed reason order; no classification is fabricated for a clean run. */
function localModelResultReason(
  request: ModelRunRequestV1,
  result: PortResultV1<ModelRunReceiptV1>,
): LocalModelResultReasonV1 {
  if (!result.ok) return "runtime_error";
  const receipt = result.value;
  if (receipt.actual.outputChars > request.maxOutputChars) {
    return "output_limit";
  }
  if (receipt.error === LOOP_STOP_MARKER) return "failed_command_loop";
  if (receipt.actual.terminalOrigin === "host-timeout") return "host_timeout";
  if (receipt.error !== null) return "runtime_error";
  return null;
}

// ---------------------------------------------------------------------------
// Exclusive writer lock (narrow, testable)
// ---------------------------------------------------------------------------

/**
 * Acquire the exclusive state-root writer lock without waiting: a held lock
 * returns null immediately. The caller holds the file open and closes it only
 * after every owned session has settled.
 */
export async function tryAcquireLocalHostLock(
  stateRoot: string,
): Promise<Deno.FsFile | null> {
  const lockPath = joinPath(stateRoot, "runner.lock");
  const file = await Deno.open(lockPath, {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  try {
    if (file.tryLockSync(true)) return file;
  } catch {
    // fall through to close + refusal
  }
  file.close();
  return null;
}

// ---------------------------------------------------------------------------
// Entrypoints
// ---------------------------------------------------------------------------

/**
 * Run one bounded local repair pass over real trusted capabilities. Returns
 * `busy` when another writer holds the lock; throws on an orphaned marker,
 * an unsettled session set or any host failure. Tokens never leave this
 * process boundary.
 */
export async function runLocalRepairHost(
  options: LocalRepairHostOptionsV1,
): Promise<LocalRepairHostRunV1> {
  const input = readLocalHostOptions(options);
  const clock = new SystemClock();
  const startedAt = clock.now();
  const invocationId = crypto.randomUUID();
  await ensurePrivateDir(input.stateRoot);
  const lock = await tryAcquireLocalHostLock(input.stateRoot);
  if (lock === null) return { status: "busy" };

  const markerPath = joinPath(input.stateRoot, "session-active.json");
  const statusPath = joinPath(input.stateRoot, "status.json");
  const tracker = new LocalSessionTracker();
  const http = fetchHttpTransport();
  let markerWritten = false;
  let settled = true;
  let failure: unknown = null;
  let outcome: RepairCycleOutcomeV1 | null = null;
  let state: (StateReadView & RepairStateWriter) | null = null;
  let login: string | null = null;
  let targetBaseSha: string | null = null;
  let config: RepositoryConfigV1 | null = null;

  try {
    // Fail closed on a prior marker before any new session exists.
    if (await pathExists(markerPath)) throw new LocalHostOrphanError();

    const scratch = joinPath(input.stateRoot, "state-scratch");
    await ensurePrivateDir(scratch);
    const stateGitPath = joinPath(input.stateRoot, "state.git");
    await ensureBareStateRepository(stateGitPath, input, scratch);
    const sourcePath = joinPath(input.stateRoot, "source");
    await prepareSourceRepository(sourcePath, input, scratch);

    state = createRepairStateStore({
      scratchDir: scratch,
      remoteUrl: stateGitPath,
    });
    // The optional local-activation read capability is composed only here, on
    // the privately owned facade: no other host receives it and no repair
    // process ever writes these receipts.
    Object.assign(state, composeLocalReleaseReader(input.stateRoot));

    // One durable gate for the remote refresh, the login read, the API client
    // and the port. It is constructed BEFORE the first remote Git fetch, so a
    // live durable cooldown refuses before any Git runs.
    const gate = new DurableGitHubCooldownGate({ state, clock });
    targetBaseSha = await refreshDevelopment(sourcePath, input, scratch, gate);

    login = await readAuthenticatedLogin(input.githubToken, http, gate, clock);

    // Marker BEFORE any model session or subprocess can start.
    await writePrivateFile(
      markerPath,
      JSON.stringify({
        version: "v1",
        kind: "local_session_active",
        invocationId,
        checkoutPath: sourcePath,
        startedAt,
      }) + "\n",
    );
    markerWritten = true;

    const appliedConfig = createLocalRepositoryConfig();
    config = appliedConfig;
    const reviewCheckout = joinPath(input.stateRoot, "review-checkout");
    const reviewClientHome = joinPath(input.stateRoot, "clients", "review");
    const reviewTmpDir = joinPath(input.stateRoot, "tmp", "review");
    const reviewDenoDir = joinPath(input.stateRoot, "deno", "review");
    await ensureReviewClient({
      reviewCheckout,
      reviewClientHome,
      reviewTmpDir,
      reviewDenoDir,
      token: input.modelToken,
      codexExecutable: input.codexExecutable,
      denoExecutable: input.denoExecutable,
      trustedPath: input.trustedPath,
    });
    const github = composeLocalGitHub({
      clock,
      state,
      gate,
      http,
      token: input.githubToken,
      login,
      invocationId,
      sourcePath,
      scratch,
      reviewCheckout,
      reviewClientHome,
      reviewTmpDir,
      reviewDenoDir,
      trustedPath: input.trustedPath,
      codexExecutable: input.codexExecutable,
      tracker,
    });
    const model = new LocalCheckoutModelPort({
      stateRoot: input.stateRoot,
      sourcePath,
      scratch,
      trustedPath: input.trustedPath,
      codexExecutable: input.codexExecutable,
      denoExecutable: input.denoExecutable,
      modelToken: input.modelToken,
      tracker,
      clock,
      localIteration: true,
    });
    github.pushHead = () =>
      Promise.resolve(portError(
        "unavailable",
        "Owner local-only iteration: publication and reviews are paused",
      ));
    github.createPullRequest = () =>
      Promise.resolve(portError(
        "unavailable",
        "Owner local-only iteration: publication and reviews are paused",
      ));
    github.requestReview = () =>
      Promise.resolve(portError(
        "unavailable",
        "Owner local-only iteration: publication and reviews are paused",
      ));
    github.mergePullRequest = () =>
      Promise.resolve(portError(
        "unavailable",
        "Owner local-only iteration: publication and reviews are paused",
      ));
    outcome = await runRepairEntrypoint({
      clock,
      state,
      configs: [appliedConfig],
      controllerSha: input.controllerSha,
      github: github,
      githubCooldown: gate,
      incidents: unavailableIncidents,
      replay: unavailableReplay,
      model,
      budget: new RollingStartBudget({
        clock,
        state,
        configs: [appliedConfig],
      }),
    }, {
      deadline: startedAt + RUN_DEADLINE_MS,
      stepLimit: STEP_LIMIT,
    });
  } catch (error) {
    failure = error;
  } finally {
    settled = await tracker.settleAll();
    if (settled) {
      try {
        if (markerWritten) {
          try {
            await Deno.remove(markerPath);
          } catch {
            failure ??= new Error(STATIC_MARKER);
          }
        }
        if (state !== null && outcome !== null && config !== null) {
          // Status is persisted while this run still owns the runner lock so
          // a successor can never be overwritten by a prior runner's write.
          try {
            await writeLocalStatus({
              state,
              statusPath,
              invocationId,
              controllerSha: input.controllerSha,
              targetBaseSha,
              login,
              config,
              startedAt,
              finishedAt: clock.now(),
              outcome,
            });
          } catch (error) {
            failure ??= error;
          }
        }
      } finally {
        lock.close();
      }
    }
  }

  if (!settled) throw new LocalHostSettlementError();
  if (failure !== null) throw failure;
  if (outcome === null) throw new Error(STATIC_INVALID_OPTIONS);
  return { status: "ran", outcome, statusPath };
}

/**
 * Production direct startup. Reads exactly HOME, PATH, GITHUB_TOKEN and
 * UOS_AI_TOKEN; the source directory comes from this module URL and the
 * controller SHA from trusted `git rev-parse HEAD`.
 */
export async function startLocalRepairHostFromEnv(): Promise<
  LocalRepairHostRunV1
> {
  const home = requireEnv("HOME");
  const trustedPath = requireEnv("PATH");
  const githubToken = requireEnv("GITHUB_TOKEN");
  const modelToken = requireEnv("UOS_AI_TOKEN");
  const sourceDir = decodeURIComponent(
    new URL("../../", import.meta.url).pathname,
  );
  const stateRoot = joinPath(home, ".local", "state", "sentinel-local");
  await ensurePrivateDir(stateRoot);
  const scratch = joinPath(stateRoot, "state-scratch");
  await ensurePrivateDir(scratch);
  const controllerSha = await readControllerSha(
    sourceDir,
    trustedPath,
    scratch,
  );
  return await runLocalRepairHost({
    stateRoot,
    sourceDir,
    controllerSha,
    githubToken,
    modelToken,
    codexExecutable: joinPath(home, ".codex", "bin", "codex"),
    denoExecutable: Deno.execPath(),
    trustedPath,
  });
}

// ---------------------------------------------------------------------------
// Unsupported capability ports (never successful empty fixtures)
// ---------------------------------------------------------------------------

/** Static unavailable result for every unsupported port call. */
function unavailable<Value>(): PortResultV1<Value> {
  return portError("unavailable", UNAVAILABLE_DETAIL);
}

export const unavailableIncidents: IncidentAdapter = {
  listUnresolvedIncidents: (_cursor, _limit) =>
    Promise.resolve(unavailable<IncidentPageV1>()),
  readIncident: (_incidentId) =>
    Promise.resolve(unavailable<IncidentEvidenceV1 | null>()),
  readArtifact: (_ref, _maxBytes) =>
    Promise.resolve(unavailable<EncryptedArtifactV1 | null>()),
};

export const unavailableReplay: ReplayPort = {
  runReplay: (_request: ReplayRunRequestV1) =>
    Promise.resolve(unavailable<IsolatedReplayResultV1>()),
};

// ---------------------------------------------------------------------------
// GitHub composition (one client, one gate, one actor)
// ---------------------------------------------------------------------------

export interface LocalGitHubInputV1 {
  clock: Clock;
  state: StateReadView & RepairStateWriter;
  gate: GitHubCooldownGateV1;
  http: HttpTransportV1;
  token: string;
  login: string;
  invocationId: string;
  sourcePath: string;
  scratch: string;
  reviewCheckout: string;
  reviewClientHome: string;
  reviewTmpDir: string;
  reviewDenoDir: string;
  trustedPath: string;
  codexExecutable: string;
  tracker: LocalSessionTracker;
  /** Provider endpoint used by the isolated reviewer client. */
  modelBaseUrl?: string;
}

/** Compose the one authenticated GitHub port over the shared cooldown gate. */
export function composeLocalGitHub(input: LocalGitHubInputV1): GitHubPort {
  const repository = { ...LOCAL_REPOSITORY };
  const auth: GitHubAuthProviderV1 = {
    authorizationHeader: () => Promise.resolve(portOk(`Bearer ${input.token}`)),
  };
  const gate = input.gate;
  const client = new GitHubApiClient({
    repository,
    apiBaseUrl: API_BASE_URL,
    http: input.http,
    auth,
    cooldownGate: gate,
    clock: input.clock,
    includeIssueRelations: true,
  });
  const snapshot = new GitReviewSnapshot({
    trustedPath: input.trustedPath,
    repositoryDir: input.sourcePath,
    gitExecutable: trustedGitPath(input.trustedPath),
  });
  const reviewer = new CodexStructuredReviewer({
    provider: "uos",
    sessionCwd: input.reviewCheckout,
    permissionProfile: "sentinel-review",
    openSession: ({ cwd }) =>
      input.tracker.open(() =>
        new CodexSubprocessSession({
          command: [input.codexExecutable, "app-server"],
          cwd,
          env: codexChildEnv(
            input.reviewClientHome,
            input.reviewTmpDir,
            input.reviewDenoDir,
            input.trustedPath,
          ),
          operationDeadlineMs: REVIEW_SESSION_DEADLINE_MS,
        })
      ),
  });
  const reviewService = new GitHubCodexReviewTransport({
    client,
    repository,
    publisher: input.login,
    clock: input.clock,
    ownerRunId: input.invocationId,
    snapshot,
    reviewer,
    maxActiveReviews: 1,
  });
  const host = composeGitHubHost({
    repository,
    http: input.http,
    auth,
    cooldownGate: gate,
    clock: input.clock,
    reviewService,
    trustedPrAuthor: input.login,
    trustedReviewer: input.login,
    trustedResolutionAuthors: [input.login],
    git: {
      localDir: input.sourcePath,
      remoteUrl: REMOTE_URL,
      gitHome: input.scratch,
      extraEnv: githubGitAuthEnv(input.token),
      gitPath: trustedGitPath(input.trustedPath),
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
    },
    includeIssueRelations: true,
  });
  return scopeLocalRepairIssues(host.port);
}

/**
 * Exact local coding-task opt-in. GitHub's repository bot removes the old
 * admission labels within seconds, so labels have no role: eligibility is this
 * exact standalone first line of the issue body, terminated by LF, CRLF, or
 * the end of the body.
 */
const LOCAL_REPAIR_MARKER = "<!-- sentinel:repair -->";

/**
 * Restrict the privately-owned concrete local port to actual coding tasks.
 *
 * Only `listOpenIssues` and `readIssue` are replaced, and both originals are
 * bound to this exact port before replacement, so every other method keeps
 * the class instance and its `this` binding. An issue is in scope only when
 * its body opts in with the exact standalone first line
 * `<!-- sentinel:repair -->`; labels play no part because the repository bot
 * removes them. Errors pass through unchanged; an ineligible or absent read
 * passes through as `null`, preserving the existing pre-admission wait gate.
 * The loop re-reads the source issue before every admission, so a queued
 * issue that loses eligibility cannot consume budget.
 */
export function scopeLocalRepairIssues(port: GitHubPort): GitHubPort {
  const listOpenIssues = port.listOpenIssues.bind(port);
  const readIssue = port.readIssue.bind(port);
  port.listOpenIssues = async () => {
    const listed = await listOpenIssues();
    return listed.ok ? portOk(listed.value.filter(isLocalRepairIssue)) : listed;
  };
  port.readIssue = async (issueNumber) => {
    const read = await readIssue(issueNumber);
    if (!read.ok || read.value === null || isLocalRepairIssue(read.value)) {
      return read;
    }
    return portOk(null);
  };
  return port;
}

/**
 * Exact first-line opt-in admission. The marker must be the whole first line
 * with no leading whitespace, quoting or fencing, followed by LF, CRLF or the
 * end of the body. A marker later in prose, a longer suffix and a partial
 * match are refused; labels never admit or refuse.
 */
function isLocalRepairIssue(issue: GitHubIssueV1): boolean {
  if (!issue.body.startsWith(LOCAL_REPAIR_MARKER)) return false;
  const rest = issue.body.slice(LOCAL_REPAIR_MARKER.length);
  return rest === "" || rest.startsWith("\n") || rest.startsWith("\r\n");
}

/** Scoped Basic auth for trusted git only; never in a URL or config file. */
export function githubGitAuthEnv(token: string): Record<string, string> {
  const basic = btoa(`x-access-token:${token}`);
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${REMOTE_URL}.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

/** Authenticate the current owner login; strict nonempty bounded login. */
export async function readAuthenticatedLogin(
  token: string,
  http: HttpTransportV1,
  gate: GitHubCooldownGateV1,
  clock: Clock,
): Promise<string> {
  const admission = await gate.beforeRequest(LOCAL_REPOSITORY.installationId);
  if (!admission.ok) throw new Error(STATIC_GITHUB_LOGIN);
  const response = await http({
    method: "GET",
    url: API_USER_URL,
    headers: headerMap({
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "sentinel-local-owner",
      "x-github-api-version": "2022-11-28",
    }),
    body: null,
  });
  if (response.status !== 200) {
    // Classify through the shared rate-limit classifier only: a generic 403
    // (or any non-200 without a confirmed limit) yields null and never
    // invents a throttle. A confirmed 403/429 observation is persisted to the
    // same durable gate BEFORE the static startup failure is thrown; failed or
    // throwing persistence is itself a static failure with no follow-on
    // request.
    const observation = await classifyGitHubRateLimit(response, clock.now());
    if (observation !== null) {
      const persisted = await gate.recordRateLimit(
        LOCAL_REPOSITORY.installationId,
        observation,
      );
      if (!persisted.ok) throw new Error(STATIC_GITHUB_LOGIN);
    }
    throw new Error(STATIC_GITHUB_LOGIN);
  }
  let login: unknown = null;
  try {
    login = (JSON.parse(response.bodyText) as { login?: unknown } | null)
      ?.login;
  } catch {
    throw new Error(STATIC_GITHUB_LOGIN);
  }
  if (
    typeof login !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(login)
  ) {
    throw new Error(STATIC_GITHUB_LOGIN);
  }
  return login;
}

// ---------------------------------------------------------------------------
// Implementation port: one persistent isolated checkout per task
// ---------------------------------------------------------------------------

export interface LocalModelInputV1 {
  stateRoot: string;
  sourcePath: string;
  scratch: string;
  trustedPath: string;
  codexExecutable: string;
  denoExecutable: string;
  modelToken: string;
  tracker: LocalSessionTracker;
  clock: Clock;
  /** Provider endpoint used by the isolated implementation client. */
  modelBaseUrl?: string;
  /** Explicit owner-local pause; hosted Actions must leave this false. */
  localIteration?: boolean;
}

/**
 * Model port wrapper over the existing CodexImplementationPort. It owns one
 * persistent private checkout per task (never reset or recloned), commits
 * model edits atop the saved candidate, persists a private minimal result
 * receipt, and imports the exact candidate head into the trusted source
 * object repository before returning.
 */
export class LocalCheckoutModelPort implements ImplementationPort {
  constructor(private readonly input: LocalModelInputV1) {}

  async runModel(
    request: ModelRunRequestV1,
  ): Promise<PortResultV1<ModelRunReceiptV1>> {
    if (
      request === null || typeof request !== "object" || !isGitSha(request.base)
    ) {
      return portError("unavailable", STATIC_MODEL_INPUT);
    }
    const key = await localCheckoutKey(request.taskId);
    const prepared = await ensureTaskCheckout({
      taskId: request.taskId,
      base: request.base,
      key,
      stateRoot: this.input.stateRoot,
      sourcePath: this.input.sourcePath,
      scratch: this.input.scratch,
      trustedPath: this.input.trustedPath,
    });
    if (!prepared.ok) return portError("unavailable", STATIC_CHECKOUT);

    const clientHome = joinPath(this.input.stateRoot, "clients", key);
    const tmpDir = joinPath(this.input.stateRoot, "tmp", key);
    const denoDir = joinPath(this.input.stateRoot, "deno", key);
    await ensureTaskClient({
      clientHome,
      tmpDir,
      denoDir,
      checkout: prepared.checkout,
      token: this.input.modelToken,
      codexExecutable: this.input.codexExecutable,
      denoExecutable: this.input.denoExecutable,
      trustedPath: this.input.trustedPath,
      baseUrl: this.input.modelBaseUrl,
    });

    const commitBase = prepared.commitBase;
    const committer: CandidateCommitterV1 = {
      // Later review corrections commit uncommitted edits atop the saved
      // candidate; the default resolver still binds request.base.
      commit: () =>
        new LocalCandidateCommitter(prepared.checkout).commit(commitBase),
    };
    const port = new CodexImplementationPort({
      openSession: () =>
        Promise.resolve(
          this.input.tracker.open(() =>
            new CodexSubprocessSession({
              command: [this.input.codexExecutable, "app-server"],
              cwd: prepared.checkout,
              env: codexChildEnv(
                clientHome,
                tmpDir,
                denoDir,
                this.input.trustedPath,
              ),
              operationDeadlineMs: SESSION_DEADLINE_MS,
            })
          ),
        ),
      checkoutDir: prepared.checkout,
      localIteration: this.input.localIteration === true,
      modelProvider: "uos",
      permissionProfile: "sentinel-local",
      commitCandidate: committer,
    });

    const result = await port.runModel(request);
    if (!result.ok) {
      // The port detail is a bounded static diagnostic (never model output or
      // a credential). Hosted runs otherwise only expose the generic blocked
      // transition, which hides the actual failure boundary needed to repair
      // the runtime.
      console.log(JSON.stringify({
        kind: "sentinel_model_result",
        ok: false,
        taskId: request.taskId,
        errorKind: result.error.kind,
        errorDetail: result.error.detail,
      }));
    }
    // Persist the private minimal diagnostic BEFORE returning the receipt or
    // importing any candidate: a run without its saved receipt may not
    // publish. A storage failure must not erase the existing checkout or the
    // durable reservation, so it only returns static unavailable.
    try {
      await writeLocalModelResult(
        this.input.stateRoot,
        request,
        result,
        this.input.clock.now(),
      );
    } catch {
      return portError("unavailable", STATIC_MODEL_RESULT);
    }
    if (!result.ok) return result;
    const head = result.value.candidate?.head ?? null;
    if (head !== null) {
      const imported = await importCandidate({
        sourcePath: this.input.sourcePath,
        checkout: prepared.checkout,
        head,
        key,
        scratch: this.input.scratch,
        trustedPath: this.input.trustedPath,
      });
      if (!imported) return portError("unavailable", STATIC_IMPORT);
    }
    return result;
  }
}

/** Create the one-time checkout at the exact base; reuse is exact-match only. */
export async function ensureTaskCheckout(input: {
  taskId: string;
  base: GitSha;
  key: string;
  stateRoot: string;
  sourcePath: string;
  scratch: string;
  trustedPath: string;
}): Promise<
  { ok: true; checkout: string; commitBase: GitSha } | { ok: false }
> {
  const checkoutsDir = joinPath(input.stateRoot, "checkouts");
  const checkout = joinPath(checkoutsDir, input.key);
  const mappingPath = joinPath(checkoutsDir, `${input.key}.json`);
  if (await pathExists(checkout)) {
    const mapping = await readCheckoutMapping(mappingPath);
    if (mapping === null || mapping.taskId !== input.taskId) {
      return { ok: false };
    }
    if (mapping.base !== input.base) {
      // Only the durable base advanced (queued issue work): reuse this exact
      // checkout with a clean, verified movement instead of refusing the work.
      // Any other divergence (saved candidate head, dirty worktree, non-ancestor
      // base) is refused without touching the checkout or the mapping.
      const advanced = await advanceTaskCheckout({
        checkout,
        mappingPath,
        mapped: mapping,
        base: input.base,
        key: input.key,
        sourcePath: input.sourcePath,
        stateRoot: input.stateRoot,
        scratch: input.scratch,
        trustedPath: input.trustedPath,
      });
      if (!advanced) return { ok: false };
    }
  } else {
    if (await pathExists(mappingPath)) return { ok: false };
    await ensurePrivateDir(checkoutsDir);
    const cloned = await runTrustedGitResult({
      args: [
        "clone",
        "--no-hardlinks",
        "--no-checkout",
        input.sourcePath,
        checkout,
      ],
      cwd: input.stateRoot,
      scratch: input.scratch,
      trustedPath: input.trustedPath,
    });
    if (cloned.code !== 0) return { ok: false };
    const fetched = await runTrustedGitResult({
      args: [
        "-C",
        checkout,
        "fetch",
        "--no-tags",
        input.sourcePath,
        "+refs/sentinel/candidates/*:refs/sentinel/candidates/*",
      ],
      cwd: input.stateRoot,
      scratch: input.scratch,
      trustedPath: input.trustedPath,
    });
    if (fetched.code !== 0) return { ok: false };
    const detached = await runTrustedGitResult({
      args: [
        "-C",
        checkout,
        "-c",
        "advice.detachedHead=false",
        "checkout",
        "--detach",
        input.base,
      ],
      cwd: input.stateRoot,
      scratch: input.scratch,
      trustedPath: input.trustedPath,
    });
    if (detached.code !== 0) return { ok: false };
    await writePrivateFile(
      mappingPath,
      JSON.stringify({
        version: "v1",
        kind: "local_checkout",
        taskId: input.taskId,
        base: input.base,
        key: input.key,
      }) + "\n",
    );
  }

  const headRead = await runTrustedGitResult({
    args: ["-C", checkout, "rev-parse", "HEAD"],
    cwd: input.stateRoot,
    scratch: input.scratch,
    trustedPath: input.trustedPath,
  });
  const head = headRead.code === 0 ? headRead.stdout.trim() : "";
  if (!isGitSha(head)) return { ok: false };
  const ancestor = await runTrustedGitResult({
    args: ["-C", checkout, "merge-base", "--is-ancestor", input.base, head],
    cwd: input.stateRoot,
    scratch: input.scratch,
    trustedPath: input.trustedPath,
  });
  if (ancestor.code !== 0) return { ok: false };
  return { ok: true, checkout, commitBase: head };
}

/**
 * Advance one reusable checkout from its mapped base to the newly requested
 * base. Movement is allowed only when the mapped base is a real Git SHA and an
 * ancestor of the requested base, the checkout is clean with no untracked work,
 * and HEAD is exactly the mapped base (normal case) or exactly the requested
 * base (crash between the clean checkout movement and the mapping publication).
 * The requested exact SHA is fetched from the already-refreshed local source
 * (never the network) and moved with an ordinary detached checkout — no force,
 * reset or clean. The resulting exact HEAD and clean state are verified before
 * the mapping is published atomically; prior objects and history are kept and
 * nothing is recloned.
 */
async function advanceTaskCheckout(input: {
  checkout: string;
  mappingPath: string;
  mapped: { taskId: string; base: string; version: string; kind: string };
  base: GitSha;
  key: string;
  sourcePath: string;
  stateRoot: string;
  scratch: string;
  trustedPath: string;
}): Promise<boolean> {
  const git = (args: string[]) =>
    runTrustedGitResult({
      args,
      cwd: input.stateRoot,
      scratch: input.scratch,
      trustedPath: input.trustedPath,
    });
  const clean = async (): Promise<boolean> => {
    const status = await git([
      "-C",
      input.checkout,
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    return status.code === 0 && status.stdout.trim().length === 0;
  };
  // The mapped base is durable state: validate it as a SHA before any Git use.
  if (!isGitSha(input.mapped.base)) return false;
  if (!(await clean())) return false;
  const headRead = await git(["-C", input.checkout, "rev-parse", "HEAD"]);
  const head = headRead.code === 0 ? headRead.stdout.trim() : "";
  if (!isGitSha(head)) return false;
  // A saved candidate/checkpoint head is never moved.
  const recovered = head === input.base;
  if (!recovered && head !== input.mapped.base) return false;
  // Prove ancestry read-only in the refreshed local source before writing any
  // object into the checkout: a divergent requested base is refused untouched.
  const ancestor = await git([
    "-C",
    input.sourcePath,
    "merge-base",
    "--is-ancestor",
    input.mapped.base,
    input.base,
  ]);
  if (ancestor.code !== 0) return false;
  if (!recovered) {
    const fetched = await git([
      "-C",
      input.checkout,
      "fetch",
      "--no-tags",
      input.sourcePath,
      input.base,
    ]);
    if (fetched.code !== 0) return false;
    const detached = await git([
      "-C",
      input.checkout,
      "-c",
      "advice.detachedHead=false",
      "checkout",
      "--detach",
      input.base,
    ]);
    if (detached.code !== 0) return false;
  }
  const movedHead = await git(["-C", input.checkout, "rev-parse", "HEAD"]);
  if (movedHead.code !== 0 || movedHead.stdout.trim() !== input.base) {
    return false;
  }
  if (!(await clean())) return false;
  // Publish the updated mapping only after the verified move, atomically.
  const temporary = `${input.mappingPath}.tmp`;
  await writePrivateFile(
    temporary,
    JSON.stringify({
      version: input.mapped.version,
      kind: input.mapped.kind,
      taskId: input.mapped.taskId,
      base: input.base,
      key: input.key,
    }) + "\n",
  );
  await Deno.rename(temporary, input.mappingPath);
  return true;
}

/** Fetch the exact candidate head into the trusted source object repo. */
async function importCandidate(input: {
  sourcePath: string;
  checkout: string;
  head: GitSha;
  key: string;
  scratch: string;
  trustedPath: string;
}): Promise<boolean> {
  const ref = `refs/sentinel/candidates/${input.key}`;
  const fetched = await runTrustedGitResult({
    args: [
      "-C",
      input.sourcePath,
      "fetch",
      "--no-tags",
      input.checkout,
      `+HEAD:${ref}`,
    ],
    cwd: input.sourcePath,
    scratch: input.scratch,
    trustedPath: input.trustedPath,
  });
  if (fetched.code !== 0) return false;
  const observed = await runTrustedGitResult({
    args: ["-C", input.sourcePath, "rev-parse", ref],
    cwd: input.sourcePath,
    scratch: input.scratch,
    trustedPath: input.trustedPath,
  });
  return observed.code === 0 && observed.stdout.trim() === input.head;
}

/** Write the isolated client home, token file and config for one task. */
export async function ensureTaskClient(input: {
  clientHome: string;
  tmpDir: string;
  denoDir: string;
  checkout: string;
  token: string;
  codexExecutable: string;
  denoExecutable: string;
  trustedPath: string;
  baseUrl?: string;
}): Promise<void> {
  await ensurePrivateDir(input.clientHome);
  await ensurePrivateDir(input.tmpDir);
  await ensurePrivateDir(input.denoDir);
  const tokenFile = joinPath(input.clientHome, "model.token");
  await writePrivateFile(tokenFile, input.token);
  await writePrivateFile(
    joinPath(input.clientHome, "config.toml"),
    renderLocalCodexConfig({
      profile: "sentinel-local",
      tokenFile,
      shellHome: input.checkout,
      shellPath: input.trustedPath,
      shellTmpDir: input.tmpDir,
      shellDenoDir: input.denoDir,
      codexExecutable: input.codexExecutable,
      codexDistributionDir: codexDistributionDir(input.codexExecutable),
      denoExecutable: input.denoExecutable,
      writeGrants: [input.tmpDir, input.denoDir],
      baseUrl: input.baseUrl,
    }),
  );
}

/** Isolated read-only review client home, token file and profile config. */
export async function ensureReviewClient(input: {
  reviewCheckout: string;
  reviewClientHome: string;
  reviewTmpDir: string;
  reviewDenoDir: string;
  token: string;
  codexExecutable: string;
  denoExecutable: string;
  trustedPath: string;
  baseUrl?: string;
}): Promise<void> {
  await ensurePrivateDir(input.reviewCheckout);
  await ensurePrivateDir(input.reviewClientHome);
  await ensurePrivateDir(input.reviewTmpDir);
  await ensurePrivateDir(input.reviewDenoDir);
  const tokenFile = joinPath(input.reviewClientHome, "model.token");
  await writePrivateFile(tokenFile, input.token);
  await writePrivateFile(
    joinPath(input.reviewClientHome, "config.toml"),
    renderLocalCodexConfig({
      profile: "sentinel-review",
      tokenFile,
      shellHome: input.reviewCheckout,
      shellPath: input.trustedPath,
      shellTmpDir: input.reviewTmpDir,
      shellDenoDir: input.reviewDenoDir,
      codexExecutable: input.codexExecutable,
      codexDistributionDir: codexDistributionDir(input.codexExecutable),
      denoExecutable: input.denoExecutable,
      writeGrants: [],
      baseUrl: input.baseUrl,
    }),
  );
}

/** Minimal child environment: no GitHub, UOS or host credentials. */
function codexChildEnv(
  clientHome: string,
  tmpDir: string,
  denoDir: string,
  trustedPath: string,
): Record<string, string> {
  return {
    PATH: trustedPath,
    HOME: clientHome,
    CODEX_HOME: clientHome,
    TMPDIR: tmpDir,
    DENO_DIR: denoDir,
  };
}

// ---------------------------------------------------------------------------
// Session settlement tracking
// ---------------------------------------------------------------------------

/** Every session this run opened, so close/settlement is verified once. */
export class LocalSessionTracker {
  private readonly sessions = new Set<CodexSessionV1>();

  open<Session extends CodexSessionV1>(factory: () => Session): Session {
    const session = factory();
    this.sessions.add(session);
    return session;
  }

  /** Close every owned session and prove settlement; never throws. */
  async settleAll(): Promise<boolean> {
    let settled = true;
    for (const session of [...this.sessions]) {
      try {
        await session.close();
      } catch {
        settled = false;
      }
      try {
        if (session.isSettled?.() === false) settled = false;
      } catch {
        settled = false;
      }
    }
    return settled;
  }
}

// ---------------------------------------------------------------------------
// Durable Git and filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Initialize the private bare state repository when it is absent or an empty
 * directory; an existing nonempty path is preserved and its existing later
 * validation still refuses it. Nothing is ever deleted or reset.
 */
export async function ensureBareStateRepository(
  stateGitPath: string,
  input: LocalRepairHostOptionsV1,
  scratch: string,
): Promise<void> {
  const existing = await durableGitPathState(stateGitPath);
  if (existing === "symlink") throw new Error(STATIC_GIT_FAILED);
  if (existing === "present") return;
  const result = await runTrustedGitResult({
    args: ["init", "--bare", stateGitPath],
    cwd: input.stateRoot,
    trustedPath: input.trustedPath,
    scratch,
  });
  if (result.code !== 0) throw new Error(STATIC_GIT_FAILED);
}

/**
 * Clone the trusted source object repository when it is absent or an empty
 * directory; no hardlinks, no creds. An existing nonempty path is preserved
 * and its existing later validation still refuses it.
 */
export async function prepareSourceRepository(
  sourcePath: string,
  input: LocalRepairHostOptionsV1,
  scratch: string,
): Promise<void> {
  const existing = await durableGitPathState(sourcePath);
  if (existing === "symlink") throw new Error(STATIC_GIT_FAILED);
  if (existing === "present") return;
  const result = await runTrustedGitResult({
    args: ["clone", "--no-hardlinks", input.sourceDir, sourcePath],
    cwd: input.stateRoot,
    trustedPath: input.trustedPath,
    scratch,
  });
  if (result.code !== 0) throw new Error(STATIC_GIT_FAILED);
}

/**
 * Classify a durable Git path before initialization: an absent path and an
 * existing EMPTY directory are initialized in place, an existing nonempty
 * directory or plain file is preserved (its existing later validation still
 * refuses it), and a symlink is refused before any Git runs so initialization
 * can never follow it outside the private state root. Nothing is deleted.
 */
async function durableGitPathState(
  path: string,
): Promise<"absent" | "empty" | "present" | "symlink"> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "absent";
    throw error;
  }
  if (info.isSymlink) return "symlink";
  if (!info.isDirectory) return "present";
  for await (const _entry of Deno.readDir(path)) {
    return "present";
  }
  return "empty";
}

/** Refresh the exact remote development ref through trusted authenticated git. */
export async function refreshDevelopment(
  sourcePath: string,
  input: LocalRepairHostOptionsV1,
  scratch: string,
  gate: GitHubCooldownGateV1,
): Promise<string> {
  // Durable admission is the FIRST operation: a refused or faulted gate stops
  // here, before any Git command or external fetch runs. There is no
  // success-empty fallback.
  const admission = await gate.beforeRequest(LOCAL_REPOSITORY.installationId);
  if (!admission.ok) throw new Error(STATIC_GIT_FAILED);
  const fetched = await runTrustedGitResult({
    args: [
      "-C",
      sourcePath,
      "fetch",
      "--no-tags",
      REMOTE_URL,
      "+refs/heads/development:refs/remotes/origin/development",
    ],
    cwd: input.stateRoot,
    trustedPath: input.trustedPath,
    scratch,
    extraEnv: githubGitAuthEnv(input.githubToken),
  });
  if (fetched.code !== 0) throw new Error(STATIC_GIT_FAILED);
  const head = await runTrustedGitResult({
    args: ["-C", sourcePath, "rev-parse", "refs/remotes/origin/development"],
    cwd: input.stateRoot,
    trustedPath: input.trustedPath,
    scratch,
  });
  if (head.code !== 0 || !isGitSha(head.stdout.trim())) {
    throw new Error(STATIC_GIT_FAILED);
  }
  return head.stdout.trim();
}

/** Exact controller SHA through trusted git in the source worktree. */
async function readControllerSha(
  sourceDir: string,
  trustedPath: string,
  scratch: string,
): Promise<GitSha> {
  const result = await runTrustedGitResult({
    args: ["-C", sourceDir, "rev-parse", "HEAD"],
    cwd: sourceDir,
    trustedPath,
    scratch,
  });
  const sha = result.code === 0 ? result.stdout.trim() : "";
  if (!isGitSha(sha)) throw new Error(STATIC_INVALID_CONTROLLER);
  return sha;
}

interface LocalGitInputV1 {
  args: string[];
  cwd: string;
  trustedPath: string;
  scratch?: string;
  extraEnv?: Record<string, string>;
}

/** Bounded trusted git result through the shared owned-group runtime. */
async function runTrustedGitResult(
  input: LocalGitInputV1,
): Promise<{ code: number; stdout: string }> {
  const scratch = input.scratch ??
    joinPath(input.cwd, ".sentinel-git-home");
  const result = await new DenoReplayRuntime(Deno.execPath()).run({
    executable: trustedGitPath(input.trustedPath),
    args: ["-c", "core.hooksPath=/dev/null", ...input.args],
    cwd: input.cwd,
    env: {
      PATH: input.trustedPath,
      HOME: scratch,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      ...(input.extraEnv ?? {}),
    },
    maxDurationMs: GIT_TIMEOUT_MS,
    maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
  });
  // Only a normal, fully settled, untruncated exit yields a usable result;
  // every other outcome fails closed with a sanitized static fault.
  if (result.outcome !== "exited" || !result.settled) {
    throw new Error(STATIC_GIT_FAILED);
  }
  if (result.truncated) throw new Error(STATIC_GIT_BOUND);
  return {
    code: result.exitCode ?? 1,
    stdout: new TextDecoder().decode(result.stdout),
  };
}

async function readCheckoutMapping(
  mappingPath: string,
): Promise<
  { taskId: string; base: string; version: string; kind: string } | null
> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(mappingPath)) as {
      taskId?: unknown;
      base?: unknown;
      version?: unknown;
      kind?: unknown;
    };
    if (typeof parsed.taskId !== "string" || typeof parsed.base !== "string") {
      return null;
    }
    return {
      taskId: parsed.taskId,
      base: parsed.base,
      version: typeof parsed.version === "string" ? parsed.version : "v1",
      kind: typeof parsed.kind === "string" ? parsed.kind : "local_checkout",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Status and log
// ---------------------------------------------------------------------------

interface LocalStatusInputV1 {
  state: StateReadView & RepairStateWriter;
  statusPath: string;
  invocationId: string;
  /** Exact controller revision this run was started with. */
  controllerSha: GitSha;
  /** Refreshed remote development tip used as the target base. */
  targetBaseSha: string | null;
  /** Authenticated owner login, already shape-validated before this point. */
  login: string | null;
  /** Applied trusted repository configuration. */
  config: RepositoryConfigV1;
  startedAt: number;
  finishedAt: number;
  outcome: RepairCycleOutcomeV1;
}

/** Sanitized status: identities, stages and times only; no bodies or tokens. */
async function writeLocalStatus(input: LocalStatusInputV1): Promise<void> {
  const status: Record<string, unknown> = {
    version: "v1",
    kind: "sentinel_local_status",
    invocationId: input.invocationId,
    controllerSha: input.controllerSha,
    targetBaseSha: input.targetBaseSha,
    login: input.login,
    model: IMPLEMENTATION_MODEL,
    reasoning: IMPLEMENTATION_REASONING,
    limits: {
      perHour: input.config.liveStartLimits?.perHour ?? null,
      perSevenDays: input.config.liveStartLimits?.perSevenDays ?? null,
    },
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    outcome: input.outcome,
  };
  try {
    const read = await input.state.readRepair();
    if (read.ok && read.value.status === "found") {
      const snapshot = read.value.snapshot;
      status.work = snapshot.work.map((record) => ({
        id: record.id,
        sourceKind: record.source.kind,
        issueNumber: record.related.issueNumber,
        nextStep: record.nextStep,
        head: record.target.head,
        pr: record.target.pr,
        updatedAt: record.updatedAt,
      }));
      status.reservations = snapshot.reservations.map((reservation) => ({
        taskId: reservation.taskId,
        purpose: reservation.purpose,
        createdAt: reservation.createdAt,
        settledAt: reservation.settledAt,
        outcome: reservation.outcome,
      }));
      status.nextEligibleStartAt = nextEligibleStart(
        snapshot.reservations,
        input.finishedAt,
      );
    } else {
      status.state = "unavailable";
    }
  } catch {
    status.state = "unavailable";
  }
  const text = JSON.stringify(status, null, 2) + "\n";
  await writePrivateFile(input.statusPath, text);
  console.log(JSON.stringify(status));
}

/** Earliest next hourly start from real reservations; null when none. */
function nextEligibleStart(
  reservations: readonly BudgetReservationV1[],
  now: number,
): number | null {
  const recent = reservations.filter((reservation) =>
    reservation.outcome !== "confirmed_not_submitted" &&
    reservation.createdAt > now - HOUR_MS
  );
  if (recent.length === 0) return null;
  return Math.min(...recent.map((reservation) => reservation.createdAt)) +
    HOUR_MS;
}

// ---------------------------------------------------------------------------
// Small primitives
// ---------------------------------------------------------------------------

function readLocalHostOptions(
  options: LocalRepairHostOptionsV1,
): LocalRepairHostOptionsV1 {
  let record: Record<string, unknown>;
  try {
    record = options as unknown as Record<string, unknown>;
  } catch {
    throw new TypeError(STATIC_INVALID_OPTIONS);
  }
  const controllerSha = record?.controllerSha;
  if (!isGitSha(controllerSha)) throw new TypeError(STATIC_INVALID_CONTROLLER);
  return {
    stateRoot: requirePath(record.stateRoot, "stateRoot"),
    sourceDir: requirePath(record.sourceDir, "sourceDir"),
    controllerSha,
    githubToken: requirePath(record.githubToken, "githubToken"),
    modelToken: requirePath(record.modelToken, "modelToken"),
    codexExecutable: requirePath(record.codexExecutable, "codexExecutable"),
    denoExecutable: requirePath(record.denoExecutable, "denoExecutable"),
    trustedPath: requirePath(record.trustedPath, "trustedPath"),
  };
}

function requirePath(value: unknown, _field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(STATIC_INVALID_OPTIONS);
  }
  return value;
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`local repair host requires environment variable ${name}`);
  }
  return value;
}

/** Trusted git: /usr/bin/git first, otherwise the trusted PATH. */
function trustedGitPath(trustedPath: string): string {
  if (pathExistsSync("/usr/bin/git")) return "/usr/bin/git";
  for (const dir of trustedPath.split(":")) {
    const candidate = joinPath(dir.length > 0 ? dir : "/", "git");
    if (pathExistsSync(candidate)) return candidate;
  }
  return "git";
}

/** Installed Codex distribution directory derived from the executable path. */
function codexDistributionDir(codexExecutable: string): string {
  // npm's pinned @openai/codex package resolves its launcher through a
  // node_modules tree rather than the owner's ~/.codex/packages layout. The
  // trusted global node_modules root is the smallest read-only grant that
  // lets the launcher load its optional platform binary and package files.
  const nodeModules = "/node_modules/";
  const nodeModulesIndex = codexExecutable.indexOf(nodeModules);
  if (nodeModulesIndex >= 0) {
    return codexExecutable.slice(0, nodeModulesIndex + nodeModules.length - 1);
  }
  return joinPath(
    dirnamePath(dirnamePath(codexExecutable)),
    "packages",
    "standalone",
  );
}

export async function ensurePrivateDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  await Deno.chmod(path, 0o700);
}

async function writePrivateFile(path: string, text: string): Promise<void> {
  await Deno.writeTextFile(path, text, { mode: 0o600 });
  await Deno.chmod(path, 0o600);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

function pathExistsSync(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Model shell PATH: when this host actually has the installed CommandLineTools
 * Git executable, its directory precedes `/usr/bin`, which on macOS is only an
 * xcrun shim. The given PATH remains the fallback everywhere else.
 */
function localClientShellPath(trustedPath: string): string {
  if (!pathExistsSync(joinPath(COMMAND_LINE_TOOLS_BIN, "git"))) {
    return trustedPath;
  }
  const rest = trustedPath
    .split(":")
    .filter((dir) => dir !== COMMAND_LINE_TOOLS_BIN);
  return [COMMAND_LINE_TOOLS_BIN, ...rest].join(":");
}

function toml(value: string): string {
  return JSON.stringify(value);
}

export function joinPath(base: string, ...parts: string[]): string {
  let out = base.replace(/\/+$/, "");
  for (const part of parts) {
    out += "/" + part.replace(/^\/+|\/+$/g, "");
  }
  return out.length === 0 ? "/" : out;
}

function dirnamePath(path: string): string {
  const index = path.lastIndexOf("/");
  if (index < 0) return ".";
  if (index === 0) return "/";
  return path.slice(0, index);
}
