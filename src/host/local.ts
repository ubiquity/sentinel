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

import { isGitSha, isSha256Hex } from "../contracts/brands.ts";
import type { GitSha, WorkItemId } from "../contracts/brands.ts";
import { portError, portOk, SystemClock } from "../contracts/ports.ts";
import type {
  Clock,
  EncryptedArtifactV1,
  GitHubCooldownGateV1,
  GitHubIssueV1,
  GitHubPort,
  GitHubPullRequestV1,
  GitHubRefV1,
  ImplementationPort,
  IncidentAdapter,
  IncidentPageV1,
  IsolatedReplayResultV1,
  ModelIdV1,
  ModelRunReceiptV1,
  ModelRunRequestV1,
  PortErrorKindV1,
  PortResultV1,
  PrepareBaseRefreshRequestV1,
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
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { MaxText } from "../contracts/validation.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { createRepairStateStore } from "../state/mod.ts";
import { composeLocalReleaseReader } from "./local-release.ts";
import {
  earliestRetryAt,
  HOUR_WINDOW_MS,
  isCharged,
  RollingStartBudget,
  SEVEN_DAY_WINDOW_MS,
} from "../budget/mod.ts";
import type { GitHubAuthProviderV1 } from "../github/auth.ts";
import { GitHubApiClient } from "../github/client.ts";
import type { GitExecutorV1 } from "../github/git-executor.ts";
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
import {
  createCandidatePreserver,
  createLegacyBaseRefreshLossProver,
} from "./actions-candidates.ts";
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
/** The one fixed base branch of the local repository configuration. */
const LOCAL_BASE_BRANCH = "development";
/** Local default; hosted Actions supplies the public UOS gateway explicitly. */
export const DEFAULT_UOS_BASE_URL = "http://127.0.0.1:8000/v1";

const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;
const RUN_DEADLINE_MS = 3_600_000;
const STEP_LIMIT = 64;
const SESSION_DEADLINE_MS = 1_500_000;
const REVIEW_SESSION_DEADLINE_MS = 1_200_000;

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
const STATIC_LOCAL_CANDIDATE =
  "local candidate objects are unavailable for the exact task and head";
const STATIC_RECEIPT_DIAGNOSTIC =
  "local model diagnostic persistence failed; the trusted completed receipt is preserved without a durability claim";
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
    baseBranch: LOCAL_BASE_BRANCH,
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
      "src/contracts/github-cooldown.ts",
      "src/contracts/hosted-execution.ts",
      "src/contracts/hosted-supervisor.ts",
      "src/contracts/local-release.ts",
      "src/contracts/ports.ts",
      "src/contracts/state-snapshots.ts",
      "src/github/client.ts",
      "src/github/http.ts",
      "src/host/actions-ci.ts",
      "src/host/actions-candidates.ts",
      "src/host/actions-preflight.ts",
      "src/host/actions-release.ts",
      "src/host/actions-supervisor.ts",
      "src/host/actions.ts",
      "src/host/hosted-cooldown.ts",
      "src/host/hosted-runtime.ts",
      "src/host/local-release.ts",
      "src/host/local-supervisor.ts",
      "src/host/local.ts",
      "src/main.ts",
      "src/repair/github-cooldown.ts",
      "src/repair/loop.ts",
      "src/state/",
      "src/budget/",
    ],
    build: { projectId: null, acceptance: null },
    secretRef: "secret://host/injected/sentinel-local-owner",
    liveStartLimits: { perHour: 120, perSevenDays: null },
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
 * checkout. After the private report is saved, one strictly validated advisory
 * summary line is emitted for the existing Actions log; that summary never
 * changes this path, this file or any caller result. A throw means the receipt
 * was not saved: the caller must not import or publish a candidate.
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
  emitLocalModelDiagnostic(request, result, observedAt, key);
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

/**
 * Public advisory summary of exactly one local model result. It is a separate
 * explicit allow-list, never a serialization of the private projection: no
 * provider/model/reasoning identity, thread/turn identity, task string, raw
 * error, prompt, output, filesystem or candidate path, or credential value can
 * reach this shape. `taskKey` is the stable SHA-256 of the task id and `base`
 * is the exact validated request base.
 */
export interface LocalModelDiagnosticV1 {
  version: "v1";
  kind: "sentinel_model_diagnostic";
  taskKey: string;
  base: GitSha;
  observedAt: number;
  outcome: "completed" | "failed" | "interrupted" | "port_error";
  reason: LocalModelResultReasonV1;
  errorKind: PortErrorKindV1 | null;
  terminalOrigin: "runtime" | "host-timeout" | null;
  observedTerminalStatus: "completed" | "interrupted" | "failed" | null;
  durationMs: number | null;
  outputChars: number | null;
  candidatePresent: boolean;
}

const LOCAL_DIAGNOSTIC_KEYS = [
  "version",
  "kind",
  "taskKey",
  "base",
  "observedAt",
  "outcome",
  "reason",
  "errorKind",
  "terminalOrigin",
  "observedTerminalStatus",
  "durationMs",
  "outputChars",
  "candidatePresent",
] as const;

const PORT_ERROR_KINDS: readonly PortErrorKindV1[] = [
  "unavailable",
  "auth_failed",
  "rate_limited",
  "not_found",
  "conflict",
  "invalid",
];

function isPortErrorKind(value: unknown): value is PortErrorKindV1 {
  return typeof value === "string" &&
    PORT_ERROR_KINDS.includes(value as PortErrorKindV1);
}

function isAdvisoryCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Strict parser of the advisory summary: exact own keys only, fixed enums,
 * non-negative safe integers and the port-error/receipt shapes validated
 * separately so a mixed record is rejected. Null means no summary may be
 * emitted or copied. Only validated fields are copied into the result.
 */
export function parseLocalModelDiagnosticV1(
  value: unknown,
): LocalModelDiagnosticV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== LOCAL_DIAGNOSTIC_KEYS.length) return null;
  if (!LOCAL_DIAGNOSTIC_KEYS.every((key) => Object.hasOwn(record, key))) {
    return null;
  }
  const version = record.version;
  const kind = record.kind;
  const taskKey = record.taskKey;
  const base = record.base;
  const observedAt = record.observedAt;
  const outcome = record.outcome;
  const reason = record.reason;
  const errorKind = record.errorKind;
  const terminalOrigin = record.terminalOrigin;
  const observedTerminalStatus = record.observedTerminalStatus;
  const durationMs = record.durationMs;
  const outputChars = record.outputChars;
  const candidatePresent = record.candidatePresent;

  if (version !== "v1") return null;
  if (kind !== "sentinel_model_diagnostic") return null;
  if (!isSha256Hex(taskKey)) return null;
  if (!isGitSha(base)) return null;
  if (!isAdvisoryCount(observedAt)) return null;
  if (
    terminalOrigin !== null && terminalOrigin !== "runtime" &&
    terminalOrigin !== "host-timeout"
  ) {
    return null;
  }
  if (
    observedTerminalStatus !== null && observedTerminalStatus !== "completed" &&
    observedTerminalStatus !== "interrupted" &&
    observedTerminalStatus !== "failed"
  ) {
    return null;
  }

  if (outcome === "port_error") {
    // A port error has one fixed shape: its kind, no terminal, no counters and
    // no candidate. Any other combination is not this record.
    if (reason !== "runtime_error") return null;
    if (!isPortErrorKind(errorKind)) return null;
    if (terminalOrigin !== null || observedTerminalStatus !== null) return null;
    if (durationMs !== null || outputChars !== null) return null;
    if (candidatePresent !== false) return null;
    return {
      version: "v1",
      kind: "sentinel_model_diagnostic",
      taskKey,
      base,
      observedAt,
      outcome: "port_error",
      reason: "runtime_error",
      errorKind,
      terminalOrigin: null,
      observedTerminalStatus: null,
      durationMs: null,
      outputChars: null,
      candidatePresent: false,
    };
  }

  if (
    outcome !== "completed" && outcome !== "failed" && outcome !== "interrupted"
  ) {
    return null;
  }
  if (
    reason !== null && reason !== "output_limit" &&
    reason !== "failed_command_loop" && reason !== "host_timeout" &&
    reason !== "runtime_error"
  ) {
    return null;
  }
  if (errorKind !== null) return null;
  if (terminalOrigin === null) return null;
  if (terminalOrigin === "host-timeout" && observedTerminalStatus !== null) {
    return null;
  }
  if (!isAdvisoryCount(durationMs) || !isAdvisoryCount(outputChars)) {
    return null;
  }
  if (typeof candidatePresent !== "boolean") return null;
  return {
    version: "v1",
    kind: "sentinel_model_diagnostic",
    taskKey,
    base,
    observedAt,
    outcome,
    reason,
    errorKind: null,
    terminalOrigin,
    observedTerminalStatus,
    durationMs,
    outputChars,
    candidatePresent,
  };
}

/**
 * Rebuild the advisory summary through the explicit allow-list. Only typed
 * receipt/port fields are copied; no untrusted object is spread.
 */
function projectLocalModelDiagnostic(
  request: ModelRunRequestV1,
  result: PortResultV1<ModelRunReceiptV1>,
  observedAt: number,
  taskKey: string,
): LocalModelDiagnosticV1 {
  const reason = localModelResultReason(request, result);
  if (!result.ok) {
    return {
      version: "v1",
      kind: "sentinel_model_diagnostic",
      taskKey,
      base: request.base,
      observedAt,
      outcome: "port_error",
      reason,
      errorKind: result.error.kind,
      terminalOrigin: null,
      observedTerminalStatus: null,
      durationMs: null,
      outputChars: null,
      candidatePresent: false,
    };
  }
  const receipt = result.value;
  return {
    version: "v1",
    kind: "sentinel_model_diagnostic",
    taskKey,
    base: request.base,
    observedAt,
    outcome: receipt.outcome,
    reason,
    errorKind: null,
    terminalOrigin: receipt.actual.terminalOrigin,
    observedTerminalStatus: receipt.actual.observedTerminalStatus,
    durationMs: receipt.actual.durationMs,
    outputChars: receipt.actual.outputChars,
    candidatePresent: receipt.candidate !== null,
  };
}

/**
 * Emit the one advisory summary line after the private report is saved. A
 * projection that fails the strict parser prints nothing, and any preparation
 * or emission failure stays local: the saved private report and the caller's
 * result are never changed by advisory diagnostics.
 */
function emitLocalModelDiagnostic(
  request: ModelRunRequestV1,
  result: PortResultV1<ModelRunReceiptV1>,
  observedAt: number,
  taskKey: string,
): void {
  try {
    const safe = parseLocalModelDiagnosticV1(
      projectLocalModelDiagnostic(request, result, observedAt, taskKey),
    );
    if (safe === null) return;
    console.log(JSON.stringify(safe));
  } catch {
    // Advisory only: never affect the successful private persistence.
  }
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
      stateRoot: input.stateRoot,
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
  /**
   * Exact private state root this host owns: the trusted source `checkouts`
   * mapping and the owned scratch used by candidate preservation.
   */
  stateRoot: string;
  sourcePath: string;
  scratch: string;
  reviewCheckout: string;
  reviewClientHome: string;
  reviewTmpDir: string;
  reviewDenoDir: string;
  trustedPath: string;
  codexExecutable: string;
  tracker: LocalSessionTracker;
  /**
   * Optional trusted capability: ensure the exact candidate base/head objects
   * exist in the private source repository before a review snapshot capture or
   * an ancestry check. Ordinary local callers omit it (behavior unchanged).
   */
  ensureCandidateObjects?: (
    input: { base: GitSha; head: GitSha },
  ) => Promise<PortResultV1<void>>;
  /** Provider endpoint used by the isolated reviewer client. */
  modelBaseUrl?: string;
}

// ---------------------------------------------------------------------------
// Deterministic candidate-base refresh adapter (optional port capability)
// ---------------------------------------------------------------------------

/** Narrow read-only observation the base-refresh adapter needs from the port. */
export interface BaseRefreshObserverV1 {
  readPullRequest(
    number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>>;
  readRef(ref: string): Promise<PortResultV1<GitHubRefV1 | null>>;
}

export interface PrepareBaseRefreshAdapterInputV1 {
  /** THE same trusted executor instance the port publishes through. */
  git: GitExecutorV1;
  /** The exact port instance (or any exact observer over it). */
  observer: BaseRefreshObserverV1;
  /** Exact configured base branch the PR must target. */
  baseBranch: string;
  /** Trusted PR author login for this scope. */
  trustedPrAuthor: string;
  /**
   * Existing hosted exact-object restore capability. The local host omits it
   * because its persistent private source repository already owns the
   * candidate objects.
   */
  ensureCandidateObjects?: (
    input: { base: GitSha; head: GitSha },
  ) => Promise<PortResultV1<void>>;
}

export type PrepareBaseRefreshV1 = (
  request: PrepareBaseRefreshRequestV1,
) => Promise<PortResultV1<GitSha>>;

const STATIC_BASE_REFRESH_INPUT = "base refresh request is invalid";
const STATIC_BASE_REFRESH_PR =
  "base refresh requires the exact open trusted-author PR";
const STATIC_BASE_REFRESH_AUTHOR = "base refresh PR author is not trusted";
const STATIC_BASE_REFRESH_HEAD_REF = "base refresh head branch is not exact";
const STATIC_BASE_REFRESH_BASE_REF = "base refresh base branch is not exact";
const STATIC_BASE_REFRESH_HEAD = "base refresh PR head is not exact";
const STATIC_BASE_REFRESH_BASE_MOVED = "base refresh configured base moved";
const STATIC_BASE_REFRESH_RESTORE =
  "base refresh candidate objects are unavailable";
const STATIC_BASE_REFRESH_UNSUPPORTED =
  "base refresh local integration is unavailable";
const STATIC_BASE_REFRESH_PREPARED = "base refresh prepared identity mismatch";

/**
 * Trusted deterministic candidate-base generation over ONE executor instance.
 *
 * Every identity is re-observed immediately before generation: the PR must be
 * open, authored by the trusted login, carry the exact head branch and target
 * the exact configured base branch, the PR head must be the exact old
 * candidate (or, on recovery only, the exact persisted prepared commit), and
 * the current configured base ref must equal `expectedBase`. The old candidate
 * parents are ensured through the SAME restore capability the port uses before
 * the local integration runs. Nothing is merged or published here; a wrong,
 * foreign or moved identity fails closed with a bounded static error.
 */
export function createPrepareBaseRefresh(
  input: PrepareBaseRefreshAdapterInputV1,
): PrepareBaseRefreshV1 {
  const baseBranch = input.baseBranch;
  const trustedPrAuthor = input.trustedPrAuthor;
  return async (request) => {
    if (
      request === null || typeof request !== "object" ||
      !Number.isSafeInteger(request.pullRequestNumber) ||
      request.pullRequestNumber <= 0 ||
      typeof request.branch !== "string" ||
      request.branch.length === 0 ||
      request.branch.length > MaxText.branch ||
      !isGitSha(request.expectedHead) ||
      !isGitSha(request.previousBase) ||
      !isGitSha(request.expectedBase) ||
      (request.preparedHead !== undefined && !isGitSha(request.preparedHead))
    ) {
      return portError("invalid", STATIC_BASE_REFRESH_INPUT);
    }
    const observed = await input.observer.readPullRequest(
      request.pullRequestNumber,
    );
    if (!observed.ok) return observed;
    if (observed.value === null) {
      return portError("not_found", STATIC_BASE_REFRESH_PR);
    }
    const pull = observed.value;
    if (pull.state !== "open") {
      return portError("conflict", STATIC_BASE_REFRESH_PR);
    }
    if (pull.author !== trustedPrAuthor) {
      return portError("conflict", STATIC_BASE_REFRESH_AUTHOR);
    }
    if (pull.headRef !== request.branch) {
      return portError("conflict", STATIC_BASE_REFRESH_HEAD_REF);
    }
    if (pull.baseRef !== baseBranch) {
      return portError("conflict", STATIC_BASE_REFRESH_BASE_REF);
    }
    // The head must be the exact old candidate, or on recovery exactly the
    // already persisted prepared commit. Nothing else is ever adopted.
    if (
      pull.head !== request.expectedHead &&
      pull.head !== request.preparedHead
    ) {
      return portError("conflict", STATIC_BASE_REFRESH_HEAD);
    }
    const base = await input.observer.readRef(`refs/heads/${baseBranch}`);
    if (!base.ok) return base;
    if (base.value === null) {
      return portError("conflict", STATIC_BASE_REFRESH_BASE_MOVED);
    }
    // An UNPREPARED refresh requires the exact current base. A prepared
    // recovery (exact preparedHead supplied) publishes the already frozen
    // deterministic candidate even if the configured base has since advanced:
    // the regeneration below still has to equal the saved prepared commit, and
    // the saved observed base is never rewritten. This is publication of an
    // existing candidate, not merge approval.
    if (
      base.value.sha !== request.expectedBase &&
      request.preparedHead === undefined
    ) {
      return portError("conflict", STATIC_BASE_REFRESH_BASE_MOVED);
    }
    if (input.ensureCandidateObjects !== undefined) {
      let ensured: PortResultV1<void>;
      try {
        ensured = await input.ensureCandidateObjects({
          base: request.previousBase,
          head: request.expectedHead,
        });
      } catch {
        return portError("unavailable", STATIC_BASE_REFRESH_RESTORE);
      }
      if (!ensured.ok) return ensured;
    }
    const integrateBase = input.git.integrateBase?.bind(input.git);
    if (integrateBase === undefined) {
      return portError("unavailable", STATIC_BASE_REFRESH_UNSUPPORTED);
    }
    const integrated = await integrateBase(
      request.expectedHead,
      request.expectedBase,
    );
    if (!integrated.ok) return integrated;
    // The regenerated deterministic commit is byte-identical to the persisted
    // recovery identity or the request is refused: an unrelated head can never
    // be adopted through this capability.
    if (
      request.preparedHead !== undefined &&
      integrated.value !== request.preparedHead
    ) {
      return portError("invalid", STATIC_BASE_REFRESH_PREPARED);
    }
    return integrated;
  };
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
    repositoryDir: input.reviewCheckout,
    gitExecutable: trustedGitPath(input.trustedPath),
  });
  const ensureCandidateObjects = input.ensureCandidateObjects;
  // Every capture first restores the exact durable candidate objects when the
  // host has that capability, then prepares the independent exact review
  // checkout under trusted ownership and captures the immutable manifest from
  // that exact checkout. A failed restore or preparation propagates as this
  // operation's sanitized unavailability, never a host-wide exception.
  const snapshotSource = {
    capture: async (value: { base: GitSha; head: GitSha }) => {
      if (ensureCandidateObjects !== undefined) {
        const ensured = await ensureCandidateObjects(value);
        if (!ensured.ok) return ensured;
      }
      const prepared = await prepareReviewCheckout({
        sourcePath: input.sourcePath,
        reviewCheckout: input.reviewCheckout,
        base: value.base,
        head: value.head,
        trustedPath: input.trustedPath,
        scratch: input.scratch,
      });
      if (!prepared.ok) return prepared;
      return await snapshot.capture(value);
    },
  };
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
    snapshot: snapshotSource,
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
  if (ensureCandidateObjects !== undefined) {
    // Wrap the SAME executor instance the port holds (never a parallel one):
    // a resumed merge proves ancestry only after the exact objects exist.
    const originalIsAncestor = host.git.isAncestor.bind(host.git);
    host.git.isAncestor = async (ancestor, descendant) => {
      const ensured = await ensureCandidateObjects({
        base: ancestor,
        head: descendant,
      });
      if (!ensured.ok) return ensured;
      return await originalIsAncestor(ancestor, descendant);
    };
  }
  // The optional deterministic base-refresh capability is composed HERE on the
  // SAME port + executor identities: it re-observes through this exact port and
  // integrates through this exact executor, so host reconciliation and port
  // publication can never drift to a parallel instance.
  host.port.prepareBaseRefresh = createPrepareBaseRefresh({
    git: host.git,
    observer: host.port,
    baseBranch: LOCAL_BASE_BRANCH,
    trustedPrAuthor: input.login,
    ensureCandidateObjects,
  });
  // Candidate preservation is composed on the SAME port + executor identities:
  // the authenticated operation-ref read and the create-only push use this
  // exact port, and the trusted loader imports only the exact task-mapped
  // producer checkout under this host's private state root.
  host.port.preserveCandidate = createCandidatePreserver({
    state: input.state,
    gate,
    token: input.token,
    http: input.http,
    clock: input.clock,
    sourcePath: input.sourcePath,
    scratch: input.scratch,
    trustedPath: input.trustedPath,
    gitExecutable: trustedGitPath(input.trustedPath),
    port: host.port,
    protectedPaths: createLocalRepositoryConfig().protectedPaths,
    ensureLocalCandidate: createLocalCandidateLoader({
      stateRoot: input.stateRoot,
      sourcePath: input.sourcePath,
      scratch: input.scratch,
      trustedPath: input.trustedPath,
    }),
  });
  // The legacy candidate-loss proof is composed on the SAME port identity and
  // the SAME exact loader inputs as preservation. The port object is passed
  // BEFORE the scope wrapper replaces `readIssue`, so the prover resolves the
  // scoped reader dynamically at invocation and never captures a pre-scope one.
  host.port.proveLegacyBaseRefreshLoss = createLegacyBaseRefreshLossProver({
    state: input.state,
    port: host.port,
    gate,
    token: input.token,
    scratch: input.scratch,
    trustedPath: input.trustedPath,
    gitExecutable: trustedGitPath(input.trustedPath),
    baseBranch: LOCAL_BASE_BRANCH,
    trustedPrAuthor: input.login,
    ensureLocalCandidate: createLocalCandidateLoader({
      stateRoot: input.stateRoot,
      sourcePath: input.sourcePath,
      scratch: input.scratch,
      trustedPath: input.trustedPath,
    }),
  });
  return scopeLocalRepairIssues(host.port);
}

/**
 * Explicit local coding-task opt-OUT. Every open issue is repaired by default;
 * an issue is excluded only when its body's first line is exactly this
 * standalone marker, or when it carries the matching label (honoured wherever
 * the repository bot has not removed it yet).
 */
const LOCAL_SKIP_MARKER = "<!-- sentinel:skip -->";
const LOCAL_SKIP_LABEL = "sentinel:skip";

/**
 * Scope the privately-owned concrete local port to the issues this deployment
 * may repair.
 *
 * Only `listOpenIssues` and `readIssue` are replaced, and both originals are
 * bound to this exact port before replacement, so every other method keeps
 * the class instance and its `this` binding. EVERY open issue is in scope:
 * nothing is silently filtered out, and an issue is excluded only by an
 * explicit opt-out — the exact standalone first line `<!-- sentinel:skip -->`
 * or the `sentinel:skip` label. The historical `<!-- sentinel:repair -->`
 * opt-in marker is still accepted and is simply no longer required. Errors
 * pass through unchanged; an excluded or absent read passes through as `null`,
 * preserving the existing pre-admission wait gate. The loop re-reads the
 * source issue before every admission, so a queued issue that gains the
 * opt-out cannot consume budget.
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
 * Default admission with an explicit opt-out. The skip marker must be the whole
 * first line with no leading whitespace, quoting or fencing, followed by LF,
 * CRLF or the end of the body; the skip label is honoured according to
 * GitHub's own case-insensitive label identity. Anything else is in scope, and
 * the historical `<!-- sentinel:repair -->` marker changes nothing.
 */
function isLocalRepairIssue(issue: GitHubIssueV1): boolean {
  if (issue.labels.some((label) => label.toLowerCase() === LOCAL_SKIP_LABEL)) {
    return false;
  }
  if (!issue.body.startsWith(LOCAL_SKIP_MARKER)) return true;
  const rest = issue.body.slice(LOCAL_SKIP_MARKER.length);
  return !(rest === "" || rest.startsWith("\n") || rest.startsWith("\r\n"));
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
  /**
   * Hosted capability that restores an exact durable candidate before a fresh
   * correction checkout is created. Local callers omit it because their
   * persistent source object repository already imports candidates.
   */
  ensureCandidateObjects?: (
    input: { base: GitSha; head: GitSha },
  ) => Promise<PortResultV1<void>>;
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
    if (
      request.checkoutBase !== undefined &&
      !isGitSha(request.checkoutBase)
    ) {
      return portError("unavailable", STATIC_MODEL_INPUT);
    }
    const checkoutBase = request.checkoutBase ?? request.base;
    if (!isGitSha(checkoutBase)) {
      return portError("unavailable", STATIC_MODEL_INPUT);
    }
    if (
      checkoutBase !== request.base &&
      this.input.ensureCandidateObjects !== undefined
    ) {
      let restored: PortResultV1<void>;
      try {
        restored = await this.input.ensureCandidateObjects({
          base: request.base,
          head: checkoutBase,
        });
      } catch {
        return portError("unavailable", STATIC_CHECKOUT);
      }
      if (!restored.ok) return portError("unavailable", STATIC_CHECKOUT);
    }
    const key = await localCheckoutKey(request.taskId);
    const prepared = await ensureTaskCheckout({
      taskId: request.taskId,
      base: checkoutBase,
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

    // The durable request keeps the reviewed development base for state
    // evidence, while the implementation port receives the exact rejected
    // head so its committer and resolver continue that candidate's history.
    const modelRequest = checkoutBase === request.base
      ? request
      : { ...request, base: checkoutBase };
    const result = await port.runModel(modelRequest);
    return await finalizeLocalModelResult({
      stateRoot: this.input.stateRoot,
      request,
      result,
      observedAt: this.input.clock.now(),
      importCandidate: (head) =>
        importCandidate({
          sourcePath: this.input.sourcePath,
          checkout: prepared.checkout,
          head,
          key,
          scratch: this.input.scratch,
          trustedPath: this.input.trustedPath,
        }),
    });
  }
}

/**
 * Post-run trusted bookkeeping for exactly one local model invocation.
 *
 * The private minimal diagnostic is still persisted BEFORE any candidate
 * import, and a non-completed port error keeps its original conservative
 * behavior (an unsaved diagnostic or a failed import stays `unavailable`).
 *
 * A TRUSTED COMPLETED receipt is different: its execution/accounting meaning
 * is preserved unchanged when either the diagnostic write or the best-effort
 * local import fails. The diagnostic failure is reported as one static line
 * and the original receipt (including its exact candidate head and actual
 * runtime fields) is returned unchanged; no durability claim is made and
 * nothing is published here. The persistent checkout is never touched.
 */
export async function finalizeLocalModelResult(input: {
  stateRoot: string;
  request: ModelRunRequestV1;
  result: PortResultV1<ModelRunReceiptV1>;
  observedAt: number;
  /** Exact-head import into the trusted source mirror; best effort. */
  importCandidate: (head: GitSha) => Promise<boolean>;
}): Promise<PortResultV1<ModelRunReceiptV1>> {
  const completedHead: GitSha | null = input.result.ok
    ? input.result.value.candidate?.head ?? null
    : null;
  const completed = completedHead !== null && input.result.ok &&
    input.result.value.outcome === "completed";
  let diagnosticSaved = false;
  try {
    await writeLocalModelResult(
      input.stateRoot,
      input.request,
      input.result,
      input.observedAt,
    );
    diagnosticSaved = true;
  } catch {
    if (!completed) return portError("unavailable", STATIC_MODEL_RESULT);
    // Static sanitized line only: no task content, candidate identity or raw
    // error is ever logged, and the receipt below keeps its full meaning.
    console.log(STATIC_RECEIPT_DIAGNOSTIC);
  }
  if (!input.result.ok) return input.result;
  if (completedHead !== null && diagnosticSaved) {
    let imported = false;
    try {
      imported = await input.importCandidate(completedHead);
    } catch {
      imported = false;
    }
    // A trusted completed run never turns a failed best-effort import into
    // model-unavailable accounting; durability remains a separate obligation.
    if (!imported && !completed) {
      return portError("unavailable", STATIC_IMPORT);
    }
  }
  return input.result;
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
  // The EXACT requested commit is fetched, never the checkout's mutable HEAD:
  // a later commit or a moved HEAD must not silently replace the candidate.
  const fetched = await runTrustedGitResult({
    args: [
      "-C",
      input.sourcePath,
      "fetch",
      "--no-tags",
      input.checkout,
      `+${input.head}:${ref}`,
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

/** Three-way availability of one exact object in one verified repository. */
type LocalObjectStateV1 = "present" | "absent" | "unknown";

/** Three-way path state: only a NotFound error proves the path is missing. */
type LocalPathStateV1 = "present" | "absent" | "unknown";

/** Direct candidate-checkout mapping read bound (bytes). */
const CANDIDATE_MAPPING_MAX_BYTES = 64 * 1024;

/** Path state where every failure other than NotFound stays unknown. */
async function localPathState(path: string): Promise<LocalPathStateV1> {
  try {
    await Deno.stat(path);
    return "present";
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? "absent" : "unknown";
  }
}

/**
 * Trusted exact-object loader for candidate preservation.
 *
 * It first checks the private source mirror (already-imported objects need no
 * checkout access), then resolves EXACTLY the task's mapped producer checkout
 * under `<stateRoot>/checkouts/<localCheckoutKey(taskId)>` through a direct
 * bounded mapping read and the exact requested SHA. Only then is that exact
 * commit imported into the source mirror — never a mutable HEAD and never a
 * different task's checkout.
 *
 * Availability is three-way and never conflates failure with loss: an object
 * is `present` only in a verified repository, `absent` only after the
 * documented missing-revision exit code 1, and every unreadable, corrupt,
 * wrong-type, wrong-task/version/kind/base or mismatched mapping state is
 * `unavailable`. `not_found` is returned ONLY after the source mirror AND the
 * exact mapped checkout/object both prove positive absence. Files are never
 * deleted or rewritten.
 */
export function createLocalCandidateLoader(input: {
  stateRoot: string;
  sourcePath: string;
  scratch: string;
  trustedPath: string;
}): (taskId: WorkItemId, head: GitSha) => Promise<PortResultV1<void>> {
  const gitAt = async (
    dir: string,
    args: string[],
  ): Promise<{ code: number; stdout: string } | null> => {
    try {
      return await runTrustedGitResult({
        args: ["-C", dir, ...args],
        cwd: input.stateRoot,
        scratch: input.scratch,
        trustedPath: input.trustedPath,
        // Read-only object queries must never lazy-fetch, substitute replace
        // refs or reach any protocol: the same isolation the publication
        // validator already applies to its local object reads.
        extraEnv: {
          GIT_NO_LAZY_FETCH: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_ALLOW_PROTOCOL: "",
        },
      });
    } catch {
      return null;
    }
  };
  /**
   * Exact commit availability in one verified repository.
   *
   * The repository is verified first; `rev-parse --verify --quiet <sha>^{commit}`
   * then has exactly one positive absence: exit code 1 with empty stdout.
   * Exit 128, a throw, truncation, an unreadable repository and a present
   * non-commit object (wrong type) are all `unknown`, never absence.
   */
  const objectState = async (
    dir: string,
    head: GitSha,
  ): Promise<LocalObjectStateV1> => {
    const repo = await gitAt(dir, ["rev-parse", "--absolute-git-dir"]);
    if (repo === null || repo.code !== 0 || repo.stdout.trim().length === 0) {
      return "unknown";
    }
    // Parent-directory discovery is refused: the resolved Git directory must be
    // this exact repository itself (bare source mirror) or its own `.git`
    // (mapped producer clone). Any read or path identity mismatch is unknown.
    try {
      const gitDir = await Deno.realPath(repo.stdout.trim());
      const repoDir = await Deno.realPath(dir);
      if (gitDir !== repoDir) {
        const dotGit = await Deno.realPath(joinPath(dir, ".git"));
        if (gitDir !== dotGit) return "unknown";
      }
    } catch {
      return "unknown";
    }
    const peeled = await gitAt(dir, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${head}^{commit}`,
    ]);
    if (peeled === null) return "unknown";
    if (peeled.code === 0) {
      return peeled.stdout.trim() === head ? "present" : "unknown";
    }
    if (peeled.code !== 1 || peeled.stdout.trim() !== "") return "unknown";
    // The revision is missing OR names a present non-commit object: never
    // report the wrong type as positive loss.
    const object = await gitAt(dir, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${head}^{object}`,
    ]);
    if (object === null || object.code !== 1) return "unknown";
    return object.stdout.trim() === "" ? "absent" : "unknown";
  };
  /**
   * Direct bounded mapping read for this exact task/key; the shared legacy
   * checkout-mapping helper is deliberately not used here.
   */
  const mappingState = async (
    mappingPath: string,
    taskId: WorkItemId,
    key: string,
  ): Promise<"exact" | "missing" | "unusable"> => {
    let text: string;
    try {
      const stat = await Deno.stat(mappingPath);
      if (!stat.isFile || stat.size > CANDIDATE_MAPPING_MAX_BYTES) {
        return "unusable";
      }
      text = await Deno.readTextFile(mappingPath);
    } catch (error) {
      return error instanceof Deno.errors.NotFound ? "missing" : "unusable";
    }
    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(text);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return "unusable";
      }
      parsed = value as Record<string, unknown>;
    } catch {
      return "unusable";
    }
    if (
      parsed.version !== "v1" || parsed.kind !== "local_checkout" ||
      typeof parsed.taskId !== "string" || typeof parsed.key !== "string" ||
      typeof parsed.base !== "string" || !isGitSha(parsed.base)
    ) {
      return "unusable";
    }
    return parsed.taskId === taskId && parsed.key === key
      ? "exact"
      : "unusable";
  };
  return async (taskId, head) => {
    if (typeof taskId !== "string" || taskId.length === 0 || !isGitSha(head)) {
      return portError("invalid", STATIC_LOCAL_CANDIDATE);
    }
    // 1. The trusted source mirror already owning the exact objects wins.
    const inSource = await objectState(input.sourcePath, head);
    if (inSource === "present") return portOk(undefined);
    // A failed source read is never ignored and never becomes not_found.
    if (inSource === "unknown") {
      return portError("unavailable", STATIC_LOCAL_CANDIDATE);
    }
    // 2. The exact task-mapped producer checkout; anything else refuses.
    const key = await localCheckoutKey(taskId);
    const checkoutsDir = joinPath(input.stateRoot, "checkouts");
    const checkout = joinPath(checkoutsDir, key);
    const mapping = await mappingState(
      joinPath(checkoutsDir, `${key}.json`),
      taskId,
      key,
    );
    if (mapping === "unusable") {
      return portError("unavailable", STATIC_LOCAL_CANDIDATE);
    }
    const checkoutPath = await localPathState(checkout);
    if (checkoutPath === "unknown") {
      return portError("unavailable", STATIC_LOCAL_CANDIDATE);
    }
    if (mapping === "missing") {
      // No mapped producer checkout was ever published for this task: only a
      // provably absent checkout path can prove the candidate was never made.
      return checkoutPath === "absent"
        ? portError("not_found", STATIC_LOCAL_CANDIDATE)
        : portError("unavailable", STATIC_LOCAL_CANDIDATE);
    }
    if (checkoutPath === "absent") {
      return portError("not_found", STATIC_LOCAL_CANDIDATE);
    }
    const inCheckout = await objectState(checkout, head);
    if (inCheckout === "unknown") {
      return portError("unavailable", STATIC_LOCAL_CANDIDATE);
    }
    if (inCheckout === "absent") {
      return portError("not_found", STATIC_LOCAL_CANDIDATE);
    }
    let imported = false;
    try {
      imported = await importCandidate({
        sourcePath: input.sourcePath,
        checkout,
        head,
        key,
        scratch: input.scratch,
        trustedPath: input.trustedPath,
      });
    } catch {
      return portError("unavailable", STATIC_LOCAL_CANDIDATE);
    }
    if (!imported) return portError("unavailable", STATIC_LOCAL_CANDIDATE);
    return portOk(undefined);
  };
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

// ---------------------------------------------------------------------------
// Independent exact review checkout (trusted host ownership)
// ---------------------------------------------------------------------------

/** Static sanitized failure for one exact review checkout preparation. */
export const STATIC_REVIEW_CHECKOUT =
  "review checkout unavailable: the exact independent review checkout could not be prepared";

export interface PrepareReviewCheckoutInputV1 {
  /** Trusted persistent source object repository (never a model checkout). */
  sourcePath: string;
  /** Independent review checkout directory exposed to the model session. */
  reviewCheckout: string;
  /** Exact committed base that must exist in the review checkout. */
  base: GitSha;
  /** Exact candidate head the review checkout must be detached at. */
  head: GitSha;
  /** Trusted PATH for the Git child only. */
  trustedPath: string;
  /** Private scratch HOME for trusted Git invocations. */
  scratch: string;
}

/**
 * Narrow safe local configuration of a standard independent clone: the ONLY
 * accepted keys and values (exact match, no duplicates). Every other local
 * key, a repeated key or an unexpected value refuses the checkout, so local
 * authority such as hooks, fsmonitor, worktree redirection or checkout filters
 * can never be executed while the checkout is validated or reused.
 */
const REVIEW_CHECKOUT_SAFE_CONFIG = new Map<string, ReadonlySet<string>>([
  ["core.repositoryformatversion", new Set(["0"])],
  ["core.filemode", new Set(["true", "false"])],
  ["core.bare", new Set(["false"])],
  ["core.logallrefupdates", new Set(["true"])],
  ["core.ignorecase", new Set(["true", "false"])],
  ["core.precomposeunicode", new Set(["true", "false"])],
]);
const REVIEW_CHECKOUT_REQUIRED_CONFIG: readonly string[] = [
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.logallrefupdates",
];

/**
 * True only when a `git config --local --no-includes --list` listing contains
 * allowed independent-clone keys with allowed values, no duplicate and every
 * required key. This is a strict equivalence check over Git's own config
 * listing, never a general config parser and never a denylist.
 */
function hasSafeReviewCheckoutConfig(text: string): boolean {
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    if (separator <= 0) return false;
    const key = line.slice(0, separator);
    if (seen.has(key)) return false;
    seen.add(key);
    const allowed = REVIEW_CHECKOUT_SAFE_CONFIG.get(key);
    if (allowed === undefined || !allowed.has(line.slice(separator + 1))) {
      return false;
    }
  }
  for (const key of REVIEW_CHECKOUT_REQUIRED_CONFIG) {
    if (!seen.has(key)) return false;
  }
  return true;
}

/** Exact lstat classification of one critical metadata path (never followed). */
async function metadataEntryKind(
  path: string,
): Promise<"absent" | "file" | "directory" | "other"> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "absent";
    throw error;
  }
  if (info.isSymlink) return "other";
  if (info.isFile) return "file";
  if (info.isDirectory) return "directory";
  return "other";
}

/** Bounded whole-`.git` traversal limits: entries examined and depth below `.git`. */
const REVIEW_CHECKOUT_METADATA_MAX_ENTRIES = 100_000;
const REVIEW_CHECKOUT_METADATA_MAX_DEPTH = 64;

/**
 * Bounded link-free walk of the ENTIRE real `.git` directory. Every entry is
 * classified with `Deno.lstat` and never followed: a symlink, a non-file or
 * non-directory entry, and a regular file with more than one link (shared
 * writable metadata) all refuse the checkout. The walk fails closed beyond its
 * entry or depth bound and on any directory-read or lstat error, and it never
 * modifies anything, so every offending entry and its target are preserved.
 */
async function reviewCheckoutMetadataTreeSafe(
  gitDir: string,
): Promise<boolean> {
  let entries = 0;
  const visit = async (directory: string, depth: number): Promise<boolean> => {
    if (depth > REVIEW_CHECKOUT_METADATA_MAX_DEPTH) return false;
    try {
      for await (const entry of Deno.readDir(directory)) {
        entries++;
        if (entries > REVIEW_CHECKOUT_METADATA_MAX_ENTRIES) return false;
        const path = joinPath(directory, entry.name);
        const info = await Deno.lstat(path);
        if (info.isSymlink) return false;
        if (info.isFile) {
          if (info.nlink !== 1) return false;
          continue;
        }
        if (!info.isDirectory) return false;
        if (!(await visit(path, depth + 1))) return false;
      }
    } catch {
      return false;
    }
    return true;
  };
  return await visit(gitDir, 1);
}

/**
 * Verify the exposed checkout's local Git metadata BEFORE any command that can
 * execute config hooks or filters: `.git` must be a real directory (never a
 * file pointer or symlink), commondir/alternates/grafts redirection must be
 * absent, and config, HEAD, index (when present), objects, refs and info must
 * be real local entries. A bounded link-free walk then classifies EVERY entry
 * of the real `.git` directory, including FETCH_HEAD, logs descendants and
 * objects/pack descendants: symlinks, special entries, hardlinked regular
 * files and any walk beyond its entry/depth bounds are refused. Every refusal
 * preserves the offending entry and its target exactly.
 */
async function reviewCheckoutMetadataSafe(
  reviewCheckout: string,
): Promise<boolean> {
  const gitDir = joinPath(reviewCheckout, ".git");
  if (await metadataEntryKind(gitDir) !== "directory") return false;
  const forbidden = [
    "commondir",
    joinPath("objects", "info", "alternates"),
    joinPath("objects", "info", "http-alternates"),
    joinPath("info", "grafts"),
  ];
  for (const relative of forbidden) {
    if (await metadataEntryKind(joinPath(gitDir, relative)) !== "absent") {
      return false;
    }
  }
  for (const relative of ["config", "HEAD"]) {
    if (await metadataEntryKind(joinPath(gitDir, relative)) !== "file") {
      return false;
    }
  }
  for (const relative of ["objects", "refs", "info"]) {
    if (await metadataEntryKind(joinPath(gitDir, relative)) !== "directory") {
      return false;
    }
  }
  const objectsInfo = await metadataEntryKind(
    joinPath(gitDir, "objects", "info"),
  );
  if (objectsInfo !== "absent" && objectsInfo !== "directory") return false;
  const index = await metadataEntryKind(joinPath(gitDir, "index"));
  if (index !== "absent" && index !== "file") return false;
  return await reviewCheckoutMetadataTreeSafe(gitDir);
}

/**
 * Classify the durable review checkout path: an absent path and an existing
 * EMPTY directory may be initialized, an existing nonempty directory is only
 * ever reused under verification (never deleted), and a symlink or plain file
 * is refused before any Git runs. Nothing is deleted or reset here.
 */
async function reviewCheckoutState(
  path: string,
): Promise<"fresh" | "reuse" | "blocked"> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "fresh";
    throw error;
  }
  if (info.isSymlink || !info.isDirectory) return "blocked";
  for await (const _entry of Deno.readDir(path)) return "reuse";
  return "fresh";
}

/**
 * Trusted preparation of the ONE independent review checkout.
 *
 * The checkout is a real `--no-hardlinks` clone of the trusted source object
 * repository with its own `.git` directory and independent objects: no `.git`
 * file pointer, symlinked metadata, alternates, shared writable metadata,
 * hooks or credential-bearing config, and no remote after preparation. Only
 * the exact base/head objects are fetched from the trusted local source (no
 * network, no credentials), then the checkout is detached at the exact head.
 * A reused nonempty directory is verified (real local `.git` metadata with no
 * commondir/alternates/graft redirection, symlinked or hardlinked metadata or
 * special `.git` entries, an exact safe-local-config allowlist through Git's
 * own `--local --no-includes` listing, no loose or packed `refs/replace/`
 * entry, and an actual `--absolute-git-dir`/`--show-toplevel` identity bound
 * to the exact real checkout paths) BEFORE any Git command that could execute a
 * config hook or filter, and clean tracked AND untracked state is proved before
 * it is changed; unexpected data is preserved and reported, never reset,
 * cleaned or erased. Every failure returns the same sanitized unavailable
 * result and never escapes as a thrown host error.
 */
export async function prepareReviewCheckout(
  input: PrepareReviewCheckoutInputV1,
): Promise<PortResultV1<void>> {
  if (!isGitSha(input.base) || !isGitSha(input.head)) {
    return portError("unavailable", STATIC_REVIEW_CHECKOUT);
  }
  const parent = dirnamePath(input.reviewCheckout);
  const git = (args: string[]) =>
    runTrustedGitResult({
      args,
      cwd: parent,
      scratch: input.scratch,
      trustedPath: input.trustedPath,
    });
  const trustedMetadata = async (): Promise<boolean> => {
    if (!(await reviewCheckoutMetadataSafe(input.reviewCheckout))) return false;
    // Git's own local listing without includes is read only AFTER the metadata
    // paths proved real, so no config hook or filter can run first.
    const config = await git([
      "-C",
      input.reviewCheckout,
      "config",
      "--local",
      "--no-includes",
      "--list",
    ]);
    if (config.code !== 0) return false;
    if (!hasSafeReviewCheckoutConfig(config.stdout)) return false;
    // Loose AND packed `refs/replace/` entries are refused here, BEFORE any
    // fetch, checkout or status: replacement refs would otherwise make model
    // Git read content other than the exact objects bound by the manifest.
    const replacements = await git([
      "-C",
      input.reviewCheckout,
      "for-each-ref",
      "--format=%(refname)",
      "refs/replace/",
    ]);
    return replacements.code === 0 &&
      replacements.stdout.trim().length === 0;
  };
  /**
   * Bind the actual repository identity Git would use to the exact real
   * checkout and `.git` paths before any fetch, checkout or status runs, so a
   * worktree/commondir redirection that survived metadata acceptance can never
   * operate on another directory.
   */
  const bindIdentity = async (): Promise<boolean> => {
    let realCheckout: string;
    let realGitDir: string;
    try {
      realCheckout = await Deno.realPath(input.reviewCheckout);
      realGitDir = await Deno.realPath(joinPath(input.reviewCheckout, ".git"));
    } catch {
      return false;
    }
    if (realGitDir !== joinPath(realCheckout, ".git")) return false;
    const absoluteGitDir = await git([
      "-C",
      input.reviewCheckout,
      "rev-parse",
      "--absolute-git-dir",
    ]);
    if (
      absoluteGitDir.code !== 0 ||
      absoluteGitDir.stdout.trim() !== realGitDir
    ) {
      return false;
    }
    const topLevel = await git([
      "-C",
      input.reviewCheckout,
      "rev-parse",
      "--show-toplevel",
    ]);
    return topLevel.code === 0 && topLevel.stdout.trim() === realCheckout;
  };
  const cleanCheckout = async (): Promise<boolean> => {
    const status = await git([
      "-C",
      input.reviewCheckout,
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    return status.code === 0 && status.stdout.trim().length === 0;
  };
  const trustedCheckout = async (): Promise<boolean> =>
    await trustedMetadata() && await bindIdentity() && await cleanCheckout();
  try {
    await ensurePrivateDir(parent);
    const state = await reviewCheckoutState(input.reviewCheckout);
    if (state === "blocked") {
      return portError("unavailable", STATIC_REVIEW_CHECKOUT);
    }
    if (state === "fresh") {
      await ensurePrivateDir(input.reviewCheckout);
      const cloned = await git([
        "clone",
        "--no-hardlinks",
        "--no-checkout",
        input.sourcePath,
        input.reviewCheckout,
      ]);
      if (cloned.code !== 0) {
        return portError("unavailable", STATIC_REVIEW_CHECKOUT);
      }
      // Remove the clone's transport authority BEFORE the checkout is exposed
      // to any model tool: no origin, no push/fetch target remains.
      const removed = await git([
        "-C",
        input.reviewCheckout,
        "remote",
        "remove",
        "origin",
      ]);
      if (removed.code !== 0) {
        return portError("unavailable", STATIC_REVIEW_CHECKOUT);
      }
      // A fresh `--no-checkout` clone has an empty index, so metadata, safe
      // config and the bound repository identity are verified here;
      // tracked/untracked cleanliness is proved after the exact detached
      // checkout below.
      if (!(await trustedMetadata())) {
        return portError("unavailable", STATIC_REVIEW_CHECKOUT);
      }
      if (!(await bindIdentity())) {
        return portError("unavailable", STATIC_REVIEW_CHECKOUT);
      }
    } else if (!(await trustedCheckout())) {
      return portError("unavailable", STATIC_REVIEW_CHECKOUT);
    }
    // Fetch only the exact base/head objects from the trusted local source; a
    // request denied for an object the local clone already carries is not
    // fatal, but the exact objects must then already be present below.
    for (const sha of [input.head, input.base]) {
      await git([
        "-C",
        input.reviewCheckout,
        "fetch",
        "--no-tags",
        input.sourcePath,
        sha,
      ]);
    }
    for (const sha of [input.head, input.base]) {
      const present = await git([
        "-C",
        input.reviewCheckout,
        "cat-file",
        "-e",
        `${sha}^{commit}`,
      ]);
      if (present.code !== 0) {
        return portError("unavailable", STATIC_REVIEW_CHECKOUT);
      }
    }
    const detached = await git([
      "-C",
      input.reviewCheckout,
      "-c",
      "advice.detachedHead=false",
      "checkout",
      "--detach",
      input.head,
    ]);
    if (detached.code !== 0) {
      return portError("unavailable", STATIC_REVIEW_CHECKOUT);
    }
    const head = await git(["-C", input.reviewCheckout, "rev-parse", "HEAD"]);
    if (head.code !== 0 || head.stdout.trim() !== input.head) {
      return portError("unavailable", STATIC_REVIEW_CHECKOUT);
    }
    const symbolic = await git([
      "-C",
      input.reviewCheckout,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    if (symbolic.code !== 0 || symbolic.stdout.trim() !== "HEAD") {
      return portError("unavailable", STATIC_REVIEW_CHECKOUT);
    }
    if (!(await trustedCheckout())) {
      return portError("unavailable", STATIC_REVIEW_CHECKOUT);
    }
    return portOk(undefined);
  } catch {
    return portError("unavailable", STATIC_REVIEW_CHECKOUT);
  }
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

/**
 * Fixed local-report bounds. These are local repository limits, not claimed
 * GitHub limits, and the same number bounds JS code units and UTF-8 bytes.
 * The detail lists are display-only: the complete counts live in aggregates.
 */
const STATUS_MAX_TEXT_CHARS = 50_000;
const STATUS_MAX_TEXT_BYTES = 50_000;
const STATUS_MAX_DETAIL_ITEMS = 200;
/** Conservative workflow-dispatch transport bound (GitHub documents 65,535). */
const STATUS_MAX_DISPATCH_BYTES = 65_535;
/** Fixed report admission semantics: 120 starts per rolling hour, no weekly cap. */
const STATUS_POLICY_LIMITS = { perHour: 120, perSevenDays: null } as const;
const STATUS_KNOWN_STEPS = [
  "work",
  "review",
  "delivery",
  "blocked",
  "done",
] as const;
type StatusKnownStepV1 = (typeof STATUS_KNOWN_STEPS)[number];
/** Detail priority: blocked first, other nonterminal, then terminal history. */
const STATUS_STEP_PRIORITY: Record<StatusKnownStepV1 | "unknown", number> = {
  blocked: 0,
  work: 1,
  review: 1,
  delivery: 1,
  unknown: 1,
  done: 2,
};
const STATUS_TEXT_ENCODER = new TextEncoder();

export interface LocalStatusInputV1 {
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

/** Bounded envelope shared by the available and unavailable report shapes. */
interface LocalStatusIdentityV1 {
  envelope: Record<string, unknown>;
  /** Observation time; null when the reported lifecycle is unusable. */
  finishedAt: number | null;
  /** True only when every envelope field is present and bounded. */
  usable: boolean;
}

function isStatusCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedStatusText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** Known outcome object: status only, plus steps for step_limit. No detail. */
function statusOutcome(
  outcome: RepairCycleOutcomeV1,
): Record<string, unknown> {
  const record = typeof outcome === "object" && outcome !== null
    ? outcome as unknown as Record<string, unknown>
    : {};
  if (record.status === "step_limit") {
    return isStatusCount(record.steps)
      ? { status: "step_limit", steps: record.steps }
      : { status: "state_error" };
  }
  if (
    record.status === "idle" || record.status === "margin" ||
    record.status === "state_error" || record.status === "source_error"
  ) {
    return { status: record.status };
  }
  return { status: "state_error" };
}

/**
 * Bounded, truthful v1 envelope. The top-level version stays v1 because the
 * retained local receipt consumer parses this shape; `reportVersion: "v2"` is
 * the report-shape cutover and has no legacy fallback. Fields that cannot be
 * bounded are replaced with explicit nulls/"unavailable", never echoed.
 */
function statusIdentity(input: LocalStatusInputV1): LocalStatusIdentityV1 {
  const invocationId = isBoundedStatusText(input.invocationId, MaxText.recordId)
    ? input.invocationId
    : "unavailable";
  const controllerSha = isGitSha(input.controllerSha)
    ? input.controllerSha
    : null;
  const targetBaseSha = isGitSha(input.targetBaseSha)
    ? input.targetBaseSha
    : null;
  const login = isBoundedStatusText(input.login, MaxText.login)
    ? input.login
    : null;
  const startedAt = isStatusCount(input.startedAt) ? input.startedAt : null;
  const finishedAt = isStatusCount(input.finishedAt) ? input.finishedAt : null;
  const lifecycleOrdered = startedAt !== null && finishedAt !== null &&
    finishedAt >= startedAt;
  return {
    envelope: {
      version: "v1",
      kind: "sentinel_local_status",
      reportVersion: "v2",
      invocationId,
      controllerSha,
      targetBaseSha,
      login,
      model: IMPLEMENTATION_MODEL,
      reasoning: IMPLEMENTATION_REASONING,
      limits: {
        perHour: STATUS_POLICY_LIMITS.perHour,
        perSevenDays: STATUS_POLICY_LIMITS.perSevenDays,
      },
      startedAt: lifecycleOrdered ? startedAt : null,
      finishedAt: lifecycleOrdered ? finishedAt : null,
      outcome: statusOutcome(input.outcome),
    },
    finishedAt: lifecycleOrdered ? finishedAt : null,
    usable: invocationId !== "unavailable" && controllerSha !== null &&
      lifecycleOrdered,
  };
}

/** Truthful failure shape: no counts, no permission statement, empty arrays. */
function unavailableStatus(
  identity: LocalStatusIdentityV1,
): Record<string, unknown> {
  return {
    ...identity.envelope,
    state: "unavailable",
    aggregates: null,
    summary: "unavailable",
    work: [],
    reservations: [],
    nextEligibleStartAt: null,
  };
}

/**
 * Sanitized status: bounded identities, counts and times only; no bodies,
 * blocker text, model output, provider request or artifact reference.
 */
export async function writeLocalStatus(
  input: LocalStatusInputV1,
): Promise<void> {
  const status = await projectLocalStatus(input);
  const text = JSON.stringify(status, null, 2) + "\n";
  await writePrivateFile(input.statusPath, text);
  console.log(JSON.stringify(status));
}

async function projectLocalStatus(
  input: LocalStatusInputV1,
): Promise<Record<string, unknown>> {
  const identity = statusIdentity(input);
  const finishedAt = identity.finishedAt;
  if (
    !identity.usable || finishedAt === null ||
    !hasStatusPolicyLimits(input.config)
  ) {
    return unavailableStatus(identity);
  }
  let snapshot: RepairStateSnapshotV1;
  try {
    const read = await input.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      return unavailableStatus(identity);
    }
    snapshot = read.value.snapshot;
  } catch {
    return unavailableStatus(identity);
  }
  try {
    return projectStatusSnapshot(snapshot, finishedAt, identity);
  } catch {
    return unavailableStatus(identity);
  }
}

function hasStatusPolicyLimits(config: RepositoryConfigV1): boolean {
  return config.liveStartLimits?.perHour === STATUS_POLICY_LIMITS.perHour &&
    config.liveStartLimits?.perSevenDays === STATUS_POLICY_LIMITS.perSevenDays;
}

function statusWorkStep(nextStep: unknown): StatusKnownStepV1 | "unknown" {
  return (STATUS_KNOWN_STEPS as readonly unknown[]).includes(nextStep)
    ? nextStep as StatusKnownStepV1
    : "unknown";
}

/** Complete aggregates, bounded detail; omissions are recomputed per shape. */
function projectStatusSnapshot(
  snapshot: RepairStateSnapshotV1,
  finishedAt: number,
  identity: LocalStatusIdentityV1,
): Record<string, unknown> {
  const work = snapshot.work;
  const reservations = snapshot.reservations;
  if (!Array.isArray(work) || !Array.isArray(reservations)) {
    return unavailableStatus(identity);
  }
  if (!statusReservationsValid(reservations, finishedAt)) {
    return unavailableStatus(identity);
  }
  let retryAt: number;
  try {
    retryAt = earliestRetryAt(reservations, finishedAt, STATUS_POLICY_LIMITS);
  } catch {
    return unavailableStatus(identity);
  }

  const byNextStep: Record<StatusKnownStepV1, number> = {
    work: 0,
    review: 0,
    delivery: 0,
    blocked: 0,
    done: 0,
  };
  let unknownSteps = 0;
  for (const record of work) {
    const step = statusWorkStep(record?.nextStep);
    if (step === "unknown") unknownSteps++;
    else byNextStep[step]++;
  }
  const blocked = byNextStep.blocked;
  const charged = reservations.filter(isCharged);
  const chargedHour =
    charged.filter((entry) =>
      entry.createdAt > finishedAt - HOUR_WINDOW_MS &&
      entry.createdAt <= finishedAt
    ).length;
  const chargedSevenDays =
    charged.filter((entry) =>
      entry.createdAt > finishedAt - SEVEN_DAY_WINDOW_MS &&
      entry.createdAt <= finishedAt
    ).length;
  const open = reservations.filter((entry) => entry.settledAt === null).length;
  const totalWork = work.length;
  const totalReservations = reservations.length;

  let workDetail = selectStatusWorkDetail(work);
  let reservationDetail = selectStatusReservationDetail(reservations);
  for (;;) {
    const aggregates = {
      work: {
        total: totalWork,
        byNextStep: { ...byNextStep },
        unknownSteps,
        blocked,
        omitted: totalWork - workDetail.length,
        omittedBlocked: blocked - countStatusStep(workDetail, "blocked"),
      },
      reservations: {
        total: totalReservations,
        open,
        settled: totalReservations - open,
        chargedHour,
        chargedSevenDays,
        omitted: totalReservations - reservationDetail.length,
      },
    };
    const status = {
      ...identity.envelope,
      aggregates,
      summary: aggregates.work.omitted === 0 &&
          aggregates.reservations.omitted === 0
        ? "complete"
        : "truncated",
      work: workDetail,
      reservations: reservationDetail,
      nextEligibleStartAt: retryAt > finishedAt ? retryAt : null,
    };
    const text = JSON.stringify(status, null, 2) + "\n";
    if (statusTextWithinBounds(text)) return status;
    // Reduce only optional detail, deterministically, until every bound holds.
    // Reservation history is optional display detail and is dropped first so
    // blocked work detail survives byte pressure; the work ordering below then
    // removes done/nonterminal history before blocked work.
    if (reservationDetail.length > 0) {
      reservationDetail = reservationDetail.slice(0, -1);
    } else if (workDetail.length > 0) {
      workDetail = workDetail.slice(0, -1);
    } else return unavailableStatus(identity);
  }
}

/** Invalid or future reservation chronology must never look permissive. */
function statusReservationsValid(
  reservations: readonly BudgetReservationV1[],
  finishedAt: number,
): boolean {
  for (const entry of reservations) {
    if (typeof entry !== "object" || entry === null) return false;
    if (!isStatusCount(entry.createdAt) || entry.createdAt > finishedAt) {
      return false;
    }
    if (entry.settledAt === null) continue;
    if (
      !isStatusCount(entry.settledAt) || entry.settledAt < entry.createdAt ||
      entry.settledAt > finishedAt
    ) {
      return false;
    }
  }
  return true;
}

function selectStatusWorkDetail(
  work: readonly WorkRecordV1[],
): Array<Record<string, unknown>> {
  const ordered = work.map((record, index) => ({ record, index }));
  ordered.sort((left, right) => {
    const leftPriority =
      STATUS_STEP_PRIORITY[statusWorkStep(left.record?.nextStep)];
    const rightPriority =
      STATUS_STEP_PRIORITY[statusWorkStep(right.record?.nextStep)];
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    const leftId = typeof left.record?.id === "string" ? left.record.id : "";
    const rightId = typeof right.record?.id === "string" ? right.record.id : "";
    if (leftId < rightId) return -1;
    if (leftId > rightId) return 1;
    return left.index - right.index;
  });
  return ordered.slice(0, STATUS_MAX_DETAIL_ITEMS).map(({ record }) => ({
    id: record.id,
    sourceKind: record.source?.kind,
    issueNumber: record.related?.issueNumber ?? null,
    nextStep: statusWorkStep(record.nextStep),
    head: record.target?.head ?? null,
    pr: record.target?.pr ?? null,
    updatedAt: record.updatedAt,
  }));
}

function selectStatusReservationDetail(
  reservations: readonly BudgetReservationV1[],
): Array<Record<string, unknown>> {
  const ordered = reservations.map((entry, index) => ({ entry, index }));
  ordered.sort((left, right) => {
    const leftId = typeof left.entry?.id === "string" ? left.entry.id : "";
    const rightId = typeof right.entry?.id === "string" ? right.entry.id : "";
    if (leftId < rightId) return -1;
    if (leftId > rightId) return 1;
    return left.index - right.index;
  });
  return ordered.slice(0, STATUS_MAX_DETAIL_ITEMS).map(({ entry }) => ({
    taskId: entry.taskId,
    purpose: entry.purpose,
    createdAt: entry.createdAt,
    settledAt: entry.settledAt,
    outcome: entry.outcome,
  }));
}

function countStatusStep(
  detail: readonly Record<string, unknown>[],
  step: string,
): number {
  let count = 0;
  for (const entry of detail) if (entry.nextStep === step) count++;
  return count;
}

/** Every bound on the actual status file and its dispatch transport. */
function statusTextWithinBounds(text: string): boolean {
  if (text.length > STATUS_MAX_TEXT_CHARS) return false;
  if (STATUS_TEXT_ENCODER.encode(text).length > STATUS_MAX_TEXT_BYTES) {
    return false;
  }
  const envelope = JSON.stringify({ inputs: { status: text } });
  return STATUS_TEXT_ENCODER.encode(envelope).length <=
    STATUS_MAX_DISPATCH_BYTES;
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
