/**
 * Trusted GitHub Actions repair host.
 *
 * This is the hosted counterpart of the owner's local host. The workflow
 * supplies the native `GITHUB_TOKEN` and the model key to this process, plus
 * the optional `SENTINEL_SUPERVISOR_TOKEN` minted for the `ubiquity-sentinel`
 * App. The split is fixed: the native token stays on state-ref bookkeeping
 * (`sentinel-state/repair`) and Actions metadata, while the App token
 * authenticates every code change this host writes (branch pushes, pull
 * requests, reviews, merges, issue writes). The model receives an isolated
 * checkout and a credential-free environment: no release writer, state
 * credential or GitHub token crosses into the model child.
 *
 * The model route (endpoint + model id + key environment) is resolved EXACTLY
 * ONCE here through the trusted route resolver: the UOS gateway stays primary
 * and the DeepSeek-direct route is used only when an explicit override or the
 * explicit fallback selector (with its key present) selects it. The route's
 * model id is what the runtime requests and records.
 */

import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import { SystemClock } from "../contracts/ports.ts";
import type { RepairCycleOutcomeV1 } from "../repair/loop.ts";
import { parseRepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { RollingStartBudget } from "../budget/mod.ts";
import { HostedRepairCooldownGate } from "./hosted-cooldown.ts";
import {
  parseHostedEnvironment,
  readHostedIdentityEnv,
  readHostedRuntimeExecution,
} from "./hosted-runtime.ts";
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import { fetchHttpTransport } from "../github/http.ts";
import { runRepairEntrypoint } from "../main.ts";
import { runActionsPreflight } from "./actions-preflight.ts";
import {
  type ActionsCiApprovalSummaryV1,
  runActionsCiApproval,
} from "./actions-ci.ts";
import { readHostedReleaseReceipt } from "./actions-release.ts";
import { createActionsCandidateRestorer } from "./actions-candidates.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import {
  createDefaultBranchResolver,
  loadTargetConfigsV1,
  STATIC_TARGETS_EMPTY,
  STATIC_TARGETS_UNSUPPORTED,
} from "./targets.ts";
import { createRepairStateStore, DenoGitRunner } from "../state/mod.ts";
import { resolveModelRoute } from "./model-route.ts";
import {
  composeLocalGitHub,
  createLocalRepositoryConfig,
  ensurePrivateDir,
  ensureReviewClient,
  githubGitAuthEnv,
  joinPath,
  LocalCheckoutModelPort,
  LocalSessionTracker,
  prepareSourceRepository,
  refreshDevelopment,
  scopeLocalRepairIssues,
  unavailableIncidents,
  unavailableReplay,
} from "./local.ts";

const REMOTE_URL = "https://github.com/ubiquity/sentinel.git";
/**
 * Public base URL of the primary gateway route. The trusted route resolver
 * (`src/host/model-route.ts`) owns route selection; this constant only names
 * the primary endpoint for callers that refer to it.
 */
export const ACTIONS_UOS_BASE_URL = "https://ai.ubq.fi/v1";

// Leave the workflow's final ten minutes for bounded drain and runner exit.
const RUN_DEADLINE_MS = 110 * 60 * 1000;
const STEP_LIMIT = 64;
const ACTIONS_LOGIN = "github-actions[bot]";
const APP_LOGIN = "ubiquity-sentinel[bot]";
const STATIC_ENV = "hosted repair host requires its configured credentials";
const STATIC_CONTROLLER =
  "hosted repair host could not read an exact controller commit";
const STATIC_EXECUTABLE = "hosted repair host could not resolve Codex";
const STATIC_RUNNER = "hosted repair host sessions did not settle";
const STATIC_PREFLIGHT =
  "hosted Codex startup unavailable; deterministic repair pass completed";

export interface ActionsRepairHostResultV1 {
  status: "ran";
  outcome: RepairCycleOutcomeV1;
  controllerSha: GitSha;
  baseSha: string;
  login: string;
  /** False when the model startup diagnostic failed for this run. */
  startupReady: boolean;
  /** Bounded deterministic CI approval counts for this run. */
  ciApproval: ActionsCiApprovalSummaryV1;
  /** The exact saved supervisor execution this run settles. */
  execution: HostedExecutionIntentV1;
}

/** Run one hosted repair pass through the actual production entrypoint. */
export async function runActionsRepairHost(): Promise<
  ActionsRepairHostResultV1
> {
  // The protected native identity is validated before any credential, state,
  // executable or network work: a malformed job identity fails with no request
  // and no durable write.
  const identity = parseHostedEnvironment(readHostedIdentityEnv(), "repair");

  // The trusted model route is resolved EXACTLY ONCE at host start, before any
  // credential read or client composition, and recorded as one bounded
  // advisory line: provider, model id and endpoint only — never the key value
  // and never the key environment's contents. Selection is explicit and
  // deterministic (owner override, then the explicit DeepSeek fallback with
  // its key present, else the primary gateway); it is never a per-request
  // swap, and the resolved model id is the id the runtime requests and records.
  const modelRoute = resolveModelRoute(Deno.env.toObject());
  console.log(JSON.stringify({
    kind: "sentinel_model_route",
    provider: modelRoute.provider,
    model: modelRoute.model,
    baseUrl: modelRoute.baseUrl,
  }));

  const githubToken = requireEnv("GITHUB_TOKEN");
  const appToken = optionalEnv("SENTINEL_SUPERVISOR_TOKEN");
  // The model token is the route's key when the route names a key environment
  // (read through the existing --allow-env mechanism), else the existing
  // gateway token.
  const modelToken = modelRoute.apiKeyEnv === null
    ? requireEnv("UOS_AI_TOKEN")
    : requireEnv(modelRoute.apiKeyEnv);
  const trustedPath = requireEnv("PATH");
  // Every code-change write goes through the App token when the workflow
  // minted one; the native token keeps the state store and Actions metadata.
  // An older installed revision has no App credential at all and still runs.
  const writeToken = appToken ?? githubToken;
  const login = appToken === undefined ? ACTIONS_LOGIN : APP_LOGIN;
  const sourceDir = Deno.cwd();
  const denoExecutable = Deno.execPath();
  const codexExecutable = await resolveExecutable("codex", trustedPath);
  const stateRoot = joinPath(sourceDir, ".sentinel-actions-state");
  const scratch = joinPath(stateRoot, "state-scratch");
  const sourcePath = joinPath(stateRoot, "source");
  const reviewCheckout = joinPath(stateRoot, "review-checkout");
  const reviewClientHome = joinPath(stateRoot, "clients", "review");
  const reviewTmpDir = joinPath(stateRoot, "tmp", "review");
  const reviewDenoDir = joinPath(stateRoot, "deno", "review");

  await ensurePrivateDir(stateRoot);
  await ensurePrivateDir(scratch);
  const controllerSha = await readControllerSha(sourceDir, trustedPath);

  // The state store uses the same authenticated Git transport as publication,
  // but its role is fixed to repair. GitHub state never shares an index or
  // checkout with the source repository.
  const state = createRepairStateStore({
    scratchDir: scratch,
    remoteUrl: REMOTE_URL,
    runner: new DenoGitRunner(
      joinPath(scratch, "state-git-home"),
      githubGitAuthEnv(githubToken),
    ),
  });
  const clock = new SystemClock();
  // The saved supervisor pointer must bind exactly this run, attempt, launcher
  // and controller revision BEFORE any repair seed, source, model, preflight or
  // review-client preparation. A stale or foreign pointer never runs.
  const execution = await readHostedRuntimeExecution({
    state,
    identity,
    controllerSha,
  });
  await ensureRepairStateSeed(state, clock);
  const gate = new HostedRepairCooldownGate({ state, clock });
  const hostInput = {
    stateRoot,
    sourceDir,
    controllerSha,
    githubToken,
    modelToken,
    codexExecutable,
    denoExecutable,
    trustedPath,
  };

  // The source mirror is private to this run. It is refreshed through the
  // shared cooldown gate before any GitHub/API work can use it.
  await prepareSourceRepository(sourcePath, hostInput, scratch);
  const baseSha = await refreshDevelopment(
    sourcePath,
    hostInput,
    scratch,
    gate,
  );

  await ensureReviewClient({
    reviewCheckout,
    reviewClientHome,
    reviewTmpDir,
    reviewDenoDir,
    token: modelToken,
    codexExecutable,
    denoExecutable,
    trustedPath,
    route: modelRoute,
  });

  const tracker = new LocalSessionTracker();
  const http = fetchHttpTransport();
  // Lazy candidate restoration for a fresh Actions clone: the exact durable
  // candidate objects are fetched only when a review snapshot, an ancestry
  // check, or a correction checkout actually needs them (never before the
  // repair loop).
  const gitExecutable = await resolveExecutable("git", trustedPath);
  const candidates = createActionsCandidateRestorer({
    state,
    gate,
    token: writeToken,
    http,
    clock,
    sourcePath,
    scratch,
    trustedPath,
    gitExecutable,
  });

  // The committed target setting is the ONLY source of target repositories.
  // It is read before any port is composed, so an unusable setting refuses the
  // run instead of quietly repairing nothing and instead of falling back to a
  // built-in repository. `createLocalRepositoryConfig()` is the trusted
  // per-repository template (commands, protected paths, limits) and the
  // identity this host addresses; it is no longer a target list.
  const templateConfig = createLocalRepositoryConfig();
  const targets = await loadTargetConfigsV1({
    template: templateConfig,
    resolveDefaultBranch: createDefaultBranchResolver({
      http,
      token: githubToken,
    }),
  });
  if (targets.configs.length === 0) throw new Error(STATIC_TARGETS_EMPTY);
  const config = targets.configs.find((candidate) =>
    candidate.repository.owner === templateConfig.repository.owner &&
    candidate.repository.name === templateConfig.repository.name &&
    candidate.repository.installationId ===
      templateConfig.repository.installationId
  );
  if (config === undefined) throw new Error(STATIC_TARGETS_UNSUPPORTED);
  // Targets this host cannot address yet are reported, never silently dropped
  // and never acted on through another repository's port. The diagnostic line
  // carries no `status` property, so it can never be read as a child status
  // record by the launcher.
  if (targets.configs.length > 1) {
    console.log(JSON.stringify({
      version: "v1",
      kind: "sentinel_targets_diagnostic",
      addressed: `${config.repository.owner}/${config.repository.name}`,
      unaddressable: targets.configs
        .filter((candidate) => candidate !== config)
        .map((candidate) =>
          `${candidate.repository.owner}/${candidate.repository.name}`
        ),
      skipped: [...targets.skipped],
    }));
  }
  const github = scopeLocalRepairIssues(composeLocalGitHub({
    clock,
    state,
    gate,
    http,
    token: writeToken,
    login,
    invocationId: crypto.randomUUID(),
    stateRoot,
    sourcePath,
    scratch,
    reviewCheckout,
    reviewClientHome,
    reviewTmpDir,
    reviewDenoDir,
    trustedPath,
    codexExecutable,
    tracker,
    ensureCandidateObjects: candidates.ensure,
    modelBaseUrl: modelRoute.baseUrl,
    route: modelRoute,
  }));
  const model = new LocalCheckoutModelPort({
    stateRoot,
    sourcePath,
    scratch,
    trustedPath,
    codexExecutable,
    denoExecutable,
    modelToken,
    tracker,
    clock,
    route: modelRoute,
    modelId: modelRoute.model,
    localIteration: false,
    ensureCandidateObjects: candidates.ensure,
  });

  // The hosted self release path reads the protected supervisor's persisted
  // strict receipt from the same release state this host already reads. No
  // HTTP, token, client or write is involved, and the obsolete raw
  // workflow-green path is gone.
  Object.assign(state, {
    readHostedRelease: (request: ReleaseRequestV1) =>
      readHostedReleaseReceipt({ state }, request),
  });

  // Model startup availability is proved once, in-process, before the
  // deterministic pass. The probe already logs its bounded dummy-only failure;
  // a failed probe must not prevent deterministic bookkeeping, it only refuses
  // new model starts for this run.
  let startupReady = false;
  try {
    await runActionsPreflight(modelRoute);
    startupReady = true;
  } catch {
    startupReady = false;
  }

  let outcome: RepairCycleOutcomeV1 | null = null;
  let failure: unknown = null;
  try {
    outcome = await runRepairEntrypoint({
      clock,
      state,
      configs: [config],
      controllerSha,
      github,
      githubCooldown: gate,
      // The hosted GitHub adapter is intentionally issue-only for this
      // target. Incident/replay capabilities remain unavailable until their
      // authenticated producer is configured; unavailable is never an empty
      // success and therefore cannot create a fabricated fixture.
      incidents: unavailableIncidents,
      replay: unavailableReplay,
      model,
      budget: new RollingStartBudget({
        clock,
        state,
        configs: [config],
      }),
    }, {
      deadline: clock.now() + RUN_DEADLINE_MS,
      stepLimit: STEP_LIMIT,
      // Only an ordinary hosted execution may start a model. Bootstrap, prior,
      // candidate and rollback runs execute the deterministic entrypoint with
      // no model starts while keeping every budget, limit and source behavior.
      modelStartsEnabled: startupReady && execution.purpose === "ordinary",
    });
  } catch (error) {
    failure = error;
  } finally {
    if (!await tracker.settleAll()) {
      failure ??= new Error(STATIC_RUNNER);
    }
  }
  if (failure !== null) throw failure;
  if (outcome === null) throw new Error(STATIC_RUNNER);

  // Deterministic CI approval for durable self-target candidates runs after
  // the loop and the tracker drain, even when model startup was unavailable.
  // The helper is bounded and never throws, so an approval failure cannot
  // prevent deterministic bookkeeping or change the original error semantics.
  const ciApproval = await runActionsCiApproval({
    state,
    gate,
    http,
    token: githubToken,
    clock,
  });

  const result: ActionsRepairHostResultV1 = {
    status: "ran",
    outcome,
    controllerSha,
    baseSha,
    login,
    startupReady,
    ciApproval,
    execution,
  };
  console.log(JSON.stringify(result));
  // The deterministic pass and its drain completed and were logged above; the
  // hosted run must still end red when model startup was unavailable.
  if (!startupReady) throw new Error(STATIC_PREFLIGHT);
  return result;
}

/** Create the dedicated repair ref once, before any gated GitHub read. */
async function ensureRepairStateSeed(
  state: ReturnType<typeof createRepairStateStore>,
  clock: SystemClock,
): Promise<void> {
  const current = await state.readRepair();
  if (!current.ok) throw new Error(STATIC_RUNNER);
  if (current.value.status === "found") return;
  const seed = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: clock.now(),
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
  });
  const written = await state.writeRepair(seed, null);
  if (written.ok && written.value.status === "applied") return;
  // A concurrent serialized retry may have seeded the ref after our read;
  // accept it only after an authoritative reread proves a valid state exists.
  const reread = await state.readRepair();
  if (!reread.ok || reread.value.status !== "found") {
    throw new Error(STATIC_RUNNER);
  }
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.length === 0) throw new Error(STATIC_ENV);
  return value;
}

/** An optional credential: absent and empty both mean "not supplied". */
function optionalEnv(name: string): string | undefined {
  const value = Deno.env.get(name);
  return value === undefined || value.length === 0 ? undefined : value;
}

async function resolveExecutable(
  name: string,
  trustedPath: string,
): Promise<string> {
  for (const directory of trustedPath.split(":")) {
    const candidate = joinPath(directory.length > 0 ? directory : "/", name);
    try {
      const info = await Deno.stat(candidate);
      if (!info.isDirectory) {
        try {
          return await Deno.realPath(candidate);
        } catch {
          return candidate;
        }
      }
    } catch {
      // Continue through the explicitly trusted PATH only.
    }
  }
  throw new Error(STATIC_EXECUTABLE);
}

async function readControllerSha(
  sourceDir: string,
  trustedPath: string,
): Promise<GitSha> {
  const result = await new Deno.Command("git", {
    args: ["-C", sourceDir, "rev-parse", "HEAD"],
    clearEnv: true,
    env: {
      PATH: trustedPath,
      HOME: sourceDir,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const sha = result.success
    ? new TextDecoder().decode(result.stdout).trim()
    : "";
  if (!isGitSha(sha)) throw new Error(STATIC_CONTROLLER);
  return sha;
}

if (import.meta.main) {
  await runActionsRepairHost();
}
