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
import type {
  Clock,
  GitHubCooldownGateV1,
  GitHubPort,
  ImplementationPort,
  IncidentAdapter,
  RepairStateWriter,
  ReplayPort,
  StateReadView,
} from "../contracts/ports.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { RepairCycleOutcomeV1 } from "../repair/loop.ts";
import { portError } from "../contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { RollingStartBudget } from "../budget/mod.ts";
import type { BudgetControllerV1 } from "../budget/mod.ts";
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
import type { ActionsCandidateRestorerV1 } from "./actions-candidates.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import {
  createDefaultBranchResolver,
  loadTargetConfigsV1,
  STATIC_TARGETS_EMPTY,
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
const STATIC_APP_INSTALLATION =
  "hosted repair host rejected: SENTINEL_APP_INSTALLATION_ID is not a positive safe integer";
const STATIC_DEADLINE =
  "hosted repair host reached its run deadline before addressing any target";
const STATIC_TARGET_UNKNOWN =
  "hosted repair host rejected: the requested repository is not a committed target";

/**
 * The App installation scope of `ubiquity-sentinel`. Every committed target
 * that is not the sentinel self-repository is addressed under this one scope
 * (`SENTINEL_APP_INSTALLATION_ID` overrides it); the sentinel self-target
 * keeps installation scope 0, the reserved no-App owner scope, exactly as the
 * trusted template defines it. This is a scope key, never a credential: the
 * App token itself still arrives through `SENTINEL_SUPERVISOR_TOKEN`.
 */
const DEFAULT_APP_INSTALLATION_ID = 155_687_488;
/** The one allowlisted environment entry that may override that scope. */
const APP_INSTALLATION_ENV = "SENTINEL_APP_INSTALLATION_ID";

/**
 * Read the App installation scope for non-sentinel targets. An absent value
 * keeps the one fixed default; anything that is not a positive safe integer
 * is refused instead of guessed.
 */
export function parseAppInstallationId(value: string | undefined): number {
  if (value === undefined) return DEFAULT_APP_INSTALLATION_ID;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(STATIC_APP_INSTALLATION);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(STATIC_APP_INSTALLATION);
  }
  return parsed;
}

/**
 * Apply the per-target installation scope. The sentinel self-repository keeps
 * the reserved no-App owner scope from the trusted template; every other
 * committed target is addressed under the App installation scope that can
 * actually write to it. Nothing except the identity changes, so a slug can
 * still never introduce a command, limit or protection of its own.
 */
export function scopeTargetConfigV1(
  config: RepositoryConfigV1,
  selfRepository: RepositoryIdentityV1,
  appInstallationId: number,
): RepositoryConfigV1 {
  const installationId = config.repository.owner === selfRepository.owner &&
      config.repository.name === selfRepository.name
    ? selfRepository.installationId
    : appInstallationId;
  if (config.repository.installationId === installationId) return config;
  return {
    ...config,
    repository: { ...config.repository, installationId },
  };
}

/**
 * The one advisory multi-target diagnostic line. It reports the targets that
 * were addressed and the ones that were skipped (an unavailable default
 * branch, or the absolute run deadline). It carries no `status` property, so
 * the launcher's child-status scan can never read it as a child result.
 */
export function targetsDiagnosticV1(input: {
  readonly addressed: readonly string[];
  readonly skipped: readonly string[];
  readonly failed: readonly string[];
}): Record<string, unknown> {
  return {
    version: "v1",
    kind: "sentinel_targets_diagnostic",
    addressed: [...input.addressed],
    skipped: [...input.skipped],
    failed: [...input.failed],
  };
}

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

/** The exact capability set one multi-target host pass runs on. */
export interface ActionsTargetCyclesInputV1 {
  clock: Clock;
  state: StateReadView & RepairStateWriter;
  /** Every committed, usable target configuration, in setting order. */
  configs: readonly RepositoryConfigV1[];
  controllerSha: GitSha;
  /** THE one durable gate shared by every cycle and every composed port. */
  githubCooldown: GitHubCooldownGateV1;
  incidents: IncidentAdapter;
  replay: ReplayPort;
  /** THE one model port shared by every cycle. */
  model: ImplementationPort;
  /** THE one admission controller, constructed over every target config. */
  budget: BudgetControllerV1;
  /** ONE absolute run deadline shared by every cycle; never restarted. */
  deadline: number;
  stepLimit: number;
  modelStartsEnabled: boolean;
  /**
   * Prepare one target's own private state before its port is composed: its
   * source mirror and that mirror's base fetch. A target whose preparation
   * fails is recorded and skipped instead of stopping every other target,
   * because a foreign remote is a failure mode the self-target must not
   * inherit. Omitted callers need no preparation.
   */
  prepareTarget?: (config: RepositoryConfigV1) => Promise<void>;
  /** Compose the exact port for one target repository. */
  composeGithub: (config: RepositoryConfigV1) => GitHubPort;
  /** The production entrypoint; injectable for deterministic tests only. */
  runCycle?: typeof runRepairEntrypoint;
  /** One bounded advisory report of the targets addressed and skipped. */
  report?: (result: ActionsTargetCyclesResultV1) => void;
}

/** The per-target outcome of one host pass. */
export interface ActionsTargetCyclesResultV1 {
  /** The LAST addressed cycle's outcome, or null when none was addressed. */
  readonly outcome: RepairCycleOutcomeV1 | null;
  /** `owner/name` of every target whose cycle was started, in setting order. */
  readonly addressed: readonly string[];
  /** `owner/name` of every target not attempted because time ran out. */
  readonly skipped: readonly string[];
  /**
   * `owner/name: reason` of every target whose own preparation failed. It is
   * disjoint from `addressed` and `skipped` and is never a success claim.
   */
  readonly failed: readonly string[];
}

/**
 * Run ONE separately targeted repair cycle per committed target repository,
 * sequentially, over the shared state store, cooldown gate, admission budget,
 * model port and absolute run deadline.
 *
 * The injected GitHub port targets one repository. The frozen
 * `GitHubIssueV1` carries no repository field, so each cycle associates its
 * rows with its SOLE configuration instead of guessing: the host injects a
 * separately targeted cycle rather than one port for several repositories.
 * The absolute deadline is re-checked before every cycle and never restarted;
 * once it has passed, the remaining targets are reported as skipped and no
 * further port, cycle or model start is composed.
 */
export async function runActionsTargetCycles(
  input: ActionsTargetCyclesInputV1,
): Promise<ActionsTargetCyclesResultV1> {
  const runCycle = input.runCycle ?? runRepairEntrypoint;
  const addressed: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  let outcome: RepairCycleOutcomeV1 | null = null;
  try {
    for (const [index, config] of input.configs.entries()) {
      if (!(input.clock.now() < input.deadline)) {
        // The deadline is absolute and the clock only moves forward: every
        // remaining target is reported as not attempted, and none is started.
        for (const remaining of input.configs.slice(index)) {
          skipped.push(
            `${remaining.repository.owner}/${remaining.repository.name}`,
          );
        }
        break;
      }
      const slug = `${config.repository.owner}/${config.repository.name}`;
      if (input.prepareTarget !== undefined) {
        try {
          await input.prepareTarget(config);
        } catch (error) {
          // This target's own private state could not be prepared. Record the
          // exact reason and leave every other target untouched: a target that
          // cannot be prepared was never addressed, so it is not reported as
          // one.
          const reason = error instanceof Error
            ? error.message
            : "target preparation failed";
          failed.push(`${slug}: ${reason}`);
          continue;
        }
      }
      addressed.push(slug);
      outcome = await runCycle({
        clock: input.clock,
        state: input.state,
        configs: [config],
        controllerSha: input.controllerSha,
        github: input.composeGithub(config),
        githubCooldown: input.githubCooldown,
        incidents: input.incidents,
        replay: input.replay,
        model: input.model,
        budget: input.budget,
      }, {
        deadline: input.deadline,
        stepLimit: input.stepLimit,
        modelStartsEnabled: input.modelStartsEnabled,
      });
    }
  } finally {
    // The advisory report is emitted even when a cycle threw, so the targets
    // actually addressed are never silently lost.
    input.report?.({
      outcome,
      addressed: [...addressed],
      skipped: [...skipped],
      failed: [...failed],
    });
  }
  return { outcome, addressed, skipped, failed };
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

  // The source mirror is private to this run. The SENTINEL mirror is seeded
  // from this run's own checkout (the exact runtime revision) and refreshed
  // here; a FOREIGN target cannot be served by it, because that mirror holds
  // no object from the other repository at all. Each foreign target therefore
  // gets its own mirror below, seeded from its own authenticated remote and
  // fetched at its own base branch. The shared cooldown gate still governs
  // every fetch.
  await prepareSourceRepository(sourcePath, hostInput, scratch);
  const baseSha = await refreshDevelopment(
    sourcePath,
    hostInput,
    scratch,
    gate,
  );
  /**
   * Exact private mirror directory for one committed target. The sentinel
   * self-target keeps the original single `source` mirror so every existing
   * path, checkpoint and candidate object of the self-repair lane is
   * unchanged; every other target gets its own directory derived from its
   * validated owner/name.
   */
  /**
   * Exact independent review checkout for one target. It is a real clone of
   * THAT target's mirror, created and detached inside the review snapshot
   * capture, so a review can never read another repository's objects or carry
   * a previous target's checkout state into this target's snapshot.
   */
  const reviewCheckoutFor = (config: RepositoryConfigV1): string =>
    config.repository.owner === templateConfig.repository.owner &&
      config.repository.name === templateConfig.repository.name
      ? reviewCheckout
      : joinPath(
        stateRoot,
        "review-checkouts",
        `${config.repository.owner}-${config.repository.name}`,
      );
  const mirrorPathFor = (config: RepositoryConfigV1): string =>
    config.repository.owner === templateConfig.repository.owner &&
      config.repository.name === templateConfig.repository.name
      ? sourcePath
      : joinPath(
        stateRoot,
        "sources",
        `${config.repository.owner}-${config.repository.name}`,
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
  const gitExecutable = await resolveExecutable("git", trustedPath);

  // The committed target setting is the ONLY source of target repositories.
  // It is read before any port is composed, so an unusable setting refuses the
  // run instead of quietly repairing nothing and instead of falling back to a
  // built-in repository. `createLocalRepositoryConfig()` is the trusted
  // per-repository template (commands, protected paths, limits) and names the
  // sentinel self-identity; it is not a target list.
  const templateConfig = createLocalRepositoryConfig();
  const targets = await loadTargetConfigsV1({
    template: templateConfig,
    resolveDefaultBranch: createDefaultBranchResolver({
      http,
      token: githubToken,
    }),
  });
  if (targets.configs.length === 0) throw new Error(STATIC_TARGETS_EMPTY);
  // EVERY usable target is addressed, one separately targeted cycle each. The
  // sentinel self-repository keeps the reserved no-App owner scope; every other
  // committed target runs under the App installation scope that can write to
  // it, read once from the one allowlisted environment entry.
  const selfRepository = templateConfig.repository;
  const needsAppScope = targets.configs.some((candidate) =>
    candidate.repository.owner !== selfRepository.owner ||
    candidate.repository.name !== selfRepository.name
  );
  const appInstallationId = needsAppScope
    ? parseAppInstallationId(optionalEnv(APP_INSTALLATION_ENV))
    : DEFAULT_APP_INSTALLATION_ID;
  const targetConfigs = targets.configs.map((candidate) =>
    scopeTargetConfigV1(candidate, selfRepository, appInstallationId)
  );
  /**
   * ONE lazy candidate restorer per target, each bound to that target's own
   * mirror, remote and repository identity. Candidate objects live in the
   * remote of the repository that owns them, so a shared restorer pointed at
   * the sentinel remote could never restore a foreign target's candidate, and
   * a shared mirror could never hold it either. Restoration stays lazy: the
   * exact durable objects are fetched only when a review snapshot, an ancestry
   * check or a correction checkout actually needs them, never before the loop.
   */
  const candidatesBySlug = new Map<string, ActionsCandidateRestorerV1>();
  const candidatesFor = (
    config: RepositoryConfigV1,
  ): ActionsCandidateRestorerV1 => {
    const slug = `${config.repository.owner}/${config.repository.name}`;
    let restorer = candidatesBySlug.get(slug);
    if (restorer === undefined) {
      restorer = createActionsCandidateRestorer({
        state,
        gate,
        token: writeToken,
        http,
        clock,
        sourcePath: mirrorPathFor(config),
        scratch,
        trustedPath,
        gitExecutable,
        repository: config.repository,
      });
      candidatesBySlug.set(slug, restorer);
    }
    return restorer;
  };
  /** The exact mirror each requested repository must be served from. */
  const sourcePathBySlug = new Map<string, string>();
  for (const config of targetConfigs) {
    sourcePathBySlug.set(
      `${config.repository.owner}/${config.repository.name}`,
      mirrorPathFor(config),
    );
  }

  // ONE admission budget for the whole run: it is constructed over every
  // target config, so a reservation for any target resolves its policy against
  // the shared 120-starts-per-hour cap instead of a per-target one.
  const budget = new RollingStartBudget({
    clock,
    state,
    configs: targetConfigs,
  });
  // ONE absolute run deadline for the whole run: it is computed once here and
  // never restarted between target cycles.
  const deadline = clock.now() + RUN_DEADLINE_MS;
  // The port is composed per target: the REST client, review service, trusted
  // git remote and cooldown scope all address exactly that repository.
  const composeTargetGithub = (config: RepositoryConfigV1): GitHubPort =>
    scopeLocalRepairIssues(composeLocalGitHub({
      clock,
      state,
      gate,
      http,
      token: writeToken,
      login,
      invocationId: crypto.randomUUID(),
      stateRoot,
      sourcePath: mirrorPathFor(config),
      scratch,
      reviewCheckout: reviewCheckoutFor(config),
      reviewClientHome,
      reviewTmpDir,
      reviewDenoDir,
      trustedPath,
      codexExecutable,
      tracker,
      ensureCandidateObjects: candidatesFor(config).ensure,
      modelBaseUrl: modelRoute.baseUrl,
      route: modelRoute,
      repository: config.repository,
      baseBranch: config.baseBranch,
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
    // Both capabilities resolve from the REQUESTED repository, not from the
    // sentinel self-identity: the checkout and the candidate import must use
    // the target's own mirror, and candidate restoration must read the
    // target's own remote. A request for a repository the run did not commit
    // as a target refuses instead of silently using sentinel's mirror.
    ensureCandidateObjects: (input) => {
      const slug = `${input.repository.owner}/${input.repository.name}`;
      const mirror = sourcePathBySlug.get(slug);
      if (mirror === undefined) {
        return Promise.resolve(portError(
          "invalid",
          STATIC_TARGET_UNKNOWN,
        ));
      }
      const config = targetConfigs.find((candidate) =>
        candidate.repository.owner === input.repository.owner &&
        candidate.repository.name === input.repository.name
      );
      if (config === undefined) {
        return Promise.resolve(portError("invalid", STATIC_TARGET_UNKNOWN));
      }
      return candidatesFor(config).ensure({ base: input.base, head: input.head });
    },
    resolveSourcePath: (repository) =>
      sourcePathBySlug.get(`${repository.owner}/${repository.name}`) ??
        sourcePath,
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

  /**
   * Prepare ONE target's own private state immediately before its cycle: its
   * mirror seeded from its own authenticated remote, fetched at its own base
   * branch through the shared cooldown gate. The sentinel self-target is
   * already prepared above from this run's own checkout, so it needs nothing
   * here and its existing path is unchanged. A foreign target's preparation
   * failure is contained to that target by the loop, which records it as
   * failed rather than treating it as addressed.
   */
  const prepareTarget = async (config: RepositoryConfigV1): Promise<void> => {
    if (mirrorPathFor(config) === sourcePath) return;
    const remoteUrl =
      `https://github.com/${config.repository.owner}/${config.repository.name}.git`;
    await prepareSourceRepository(
      mirrorPathFor(config),
      hostInput,
      scratch,
      remoteUrl,
    );
    await refreshDevelopment(
      mirrorPathFor(config),
      hostInput,
      scratch,
      gate,
      config.repository.installationId,
      { remoteUrl, baseBranch: config.baseBranch },
    );
  };

  let outcome: RepairCycleOutcomeV1 | null = null;
  let failure: unknown = null;
  try {
    const cycles = await runActionsTargetCycles({
      clock,
      state,
      configs: targetConfigs,
      controllerSha,
      githubCooldown: gate,
      // The hosted GitHub adapter is intentionally issue-only for each target.
      // Incident/replay capabilities remain unavailable until their
      // authenticated producer is configured; unavailable is never an empty
      // success and therefore cannot create a fabricated fixture.
      incidents: unavailableIncidents,
      replay: unavailableReplay,
      model,
      budget,
      deadline,
      stepLimit: STEP_LIMIT,
      // Only an ordinary hosted execution may start a model. Bootstrap, prior,
      // candidate and rollback runs execute the deterministic entrypoint with
      // no model starts while keeping every budget, limit and source behavior.
      modelStartsEnabled: startupReady && execution.purpose === "ordinary",
      prepareTarget,
      composeGithub: composeTargetGithub,
      // The one advisory line reports every committed target as addressed or
      // skipped (an unavailable default branch, or out of time). It carries no
      // `status` property, so the launcher can never read it as a child record.
      report: (result) => {
        if (targets.targets.length > 1) {
          console.log(JSON.stringify(targetsDiagnosticV1({
            addressed: result.addressed,
            skipped: [...targets.skipped, ...result.skipped],
            failed: result.failed,
          })));
        }
      },
    });
    outcome = cycles.outcome;
  } catch (error) {
    failure = error;
  } finally {
    if (!await tracker.settleAll()) {
      failure ??= new Error(STATIC_RUNNER);
    }
  }
  if (failure !== null) throw failure;
  if (outcome === null) throw new Error(STATIC_DEADLINE);

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
