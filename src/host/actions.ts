/**
 * Trusted GitHub Actions repair host.
 *
 * This is the hosted counterpart of the owner's local host. The workflow
 * supplies the two existing credentials (`GITHUB_TOKEN` and `UOS_AI_TOKEN`)
 * to this process only. GitHub state is written through the dedicated
 * `sentinel-state/repair` ref, while the model receives an isolated checkout
 * and a credential-free environment. No release writer, state credential or
 * GitHub token crosses into the model child.
 */

import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import { SystemClock } from "../contracts/ports.ts";
import type { RepairCycleOutcomeV1 } from "../repair/loop.ts";
import { parseRepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { RollingStartBudget } from "../budget/mod.ts";
import { DurableGitHubCooldownGate } from "../repair/github-cooldown.ts";
import { fetchHttpTransport } from "../github/http.ts";
import { runRepairEntrypoint } from "../main.ts";
import { createRepairStateStore, DenoGitRunner } from "../state/mod.ts";
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
/** Public UOS gateway used by hosted Codex app-server sessions. */
export const ACTIONS_UOS_BASE_URL = "https://ai.ubq.fi/v1";

// Leave the workflow's final ten minutes for bounded drain and runner exit.
const RUN_DEADLINE_MS = 110 * 60 * 1000;
const STEP_LIMIT = 64;
const ACTIONS_LOGIN = "github-actions[bot]";
const STATIC_ENV = "hosted repair host requires its configured credentials";
const STATIC_CONTROLLER =
  "hosted repair host could not read an exact controller commit";
const STATIC_EXECUTABLE = "hosted repair host could not resolve Codex";
const STATIC_RUNNER = "hosted repair host sessions did not settle";

export interface ActionsRepairHostResultV1 {
  status: "ran";
  outcome: RepairCycleOutcomeV1;
  controllerSha: GitSha;
  baseSha: string;
  login: string;
}

/** Run one hosted repair pass through the actual production entrypoint. */
export async function runActionsRepairHost(): Promise<
  ActionsRepairHostResultV1
> {
  const githubToken = requireEnv("GITHUB_TOKEN");
  const modelToken = requireEnv("UOS_AI_TOKEN");
  const trustedPath = requireEnv("PATH");
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
  await ensureRepairStateSeed(state, clock);
  const gate = new DurableGitHubCooldownGate({ state, clock });
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
    baseUrl: ACTIONS_UOS_BASE_URL,
  });

  const tracker = new LocalSessionTracker();
  const http = fetchHttpTransport();
  const github = scopeLocalRepairIssues(composeLocalGitHub({
    clock,
    state,
    gate,
    http,
    token: githubToken,
    login: ACTIONS_LOGIN,
    invocationId: crypto.randomUUID(),
    sourcePath,
    scratch,
    reviewCheckout,
    reviewClientHome,
    reviewTmpDir,
    reviewDenoDir,
    trustedPath,
    codexExecutable,
    tracker,
    modelBaseUrl: ACTIONS_UOS_BASE_URL,
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
    modelBaseUrl: ACTIONS_UOS_BASE_URL,
  });
  const config = createLocalRepositoryConfig();

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

  const result: ActionsRepairHostResultV1 = {
    status: "ran",
    outcome,
    controllerSha,
    baseSha,
    login: ACTIONS_LOGIN,
  };
  console.log(JSON.stringify(result));
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
