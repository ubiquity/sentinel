/**
 * M14 V1 candidate-handoff fresh-process worker.
 *
 * This module is the new-process seam of the candidate-durability regression.
 * The parent test drives the ordinary correction path through the production
 * entrypoint (real receipt handler, real state store, real budget and gate) in
 * its own process, then removes the private producer workspace and the trusted
 * source mirror and starts THIS worker as a separate `deno run` child with a
 * fresh empty Git object store. The child composes the same production
 * consumers the host composes — the real `GitHubPortImpl` over a scripted HTTP
 * transport that observes the actual bare-remote refs, the real
 * `DenoGitExecutor`, the real `createPrepareBaseRefresh` capability, the real
 * `createActionsCandidateRestorer` recovery consumer and the real repair loop
 * through `runRepairEntrypoint` — and reports bounded structured observations
 * back to the parent through a JSON file. The model implementation port throws
 * on any call, so a new implementation start can never be hidden by this
 * fixture.
 *
 * Fixture context arrives ONLY on stdin as JSON (identities and counters, never
 * Git object contents). No product CLI flag or environment interface is added.
 * The child performs no network request: every HTTP answer is derived from the
 * actual bare remote refs (never from a requested head) and every Git command
 * runs against local fixture paths with `clearEnv`, a task-owned HOME and no
 * global/system Git config.
 */

import type { GitSha } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import {
  type Clock,
  type ImplementationPort,
  portError,
  type PortResultV1,
} from "../../src/contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import type {
  ReviewRequestSubmitV1,
  ReviewSubmitOutcomeV1,
} from "../../src/github/review-service.ts";
import type { RepairCycleOutcomeV1 } from "../../src/repair/loop.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import {
  createRepairStateStore,
  type RepairGitStateStore,
} from "../../src/state/mod.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { candidateBranch, workItemIdForIssue } from "../../src/repair/keys.ts";
import { createActionsCandidateRestorer } from "../../src/host/actions-candidates.ts";
import { composeGitHubHost } from "../../src/host/github.ts";
import {
  createLocalRepositoryConfig,
  createPrepareBaseRefresh,
  unavailableIncidents,
  unavailableReplay,
} from "../../src/host/local.ts";
import { runRepairEntrypoint } from "../../src/main.ts";
import {
  FakeAuthProvider,
  FakeReviewService,
  issueWire,
  pullWire,
  refWire,
} from "../github/helpers.ts";

/** Exact fixture identity/counter description passed on stdin. */
export interface CandidateHandoffScenarioV1 {
  repository: {
    owner: string;
    name: string;
    installationId: number;
  };
  /** `file://` URL of the real bare remote (development + candidate refs). */
  remoteUrl: string;
  /** Local path of that same bare remote, for direct ref observation. */
  remoteGitDir: string;
  /** Local path of the real repair state bare remote. */
  stateRemoteUrl: string;
  /** Fresh empty Git object store for this child process. */
  childSource: string;
  /** Task-owned private git HOME for this child process. */
  childScratch: string;
  /** Where the bounded observation JSON is written. */
  observationPath: string;
  baseBranch: string;
  candidateBranch: string;
  issueNumber: number;
  pullRequestNumber: number;
  trustedPrAuthor: string;
  trustedReviewer: string;
  controllerSha: GitSha;
  /** H1: the completed model candidate that was never published. */
  producerHead: GitSha;
  /** H0: the actual remote head of the owned candidate branch. */
  oldRemoteHead: GitSha;
  /** B0: the base the producer ran against. */
  oldBase: GitSha;
  /** B1: the base that moved during the one model call. */
  newBase: GitSha;
  /** Deterministic child clock value. */
  now: number;
  /** Bounded persisted transitions for the child run. */
  stepLimit: number;
}

export interface PortObservationV1 {
  ok: boolean;
  kind: string | null;
  detail: string | null;
}

export interface ReviewSubmissionObservationV1 {
  expectedHead: GitSha;
  expectedBase: GitSha;
  accepted: boolean;
}

export interface CandidateHandoffObservationV1 {
  workerError: string | null;
  /** Bounded production boundary that stopped the child. */
  boundary: string;
  restore: PortObservationV1;
  /** Whether the hosted-startup base fetch succeeded in the fresh child. */
  baseFetchOk: boolean;
  /** The exact base ref fetched into the fresh child object store. */
  fetchedBase: GitSha | null;
  /** H1 must still be absent after the base fetch and before restoration. */
  h1AbsentBeforeRestore: boolean;
  h1ObjectPresent: boolean;
  publishedHead: GitSha | null;
  reviewedHead: GitSha | null;
  reviewedParents: string[] | null;
  reviewedHeadH1Ancestor: boolean | null;
  reviewedHeadB1Ancestor: boolean | null;
  targetBase: GitSha | null;
  targetHead: GitSha | null;
  targetNextStep: string | null;
  targetIntentKind: string | null;
  targetWaitReason: string | null;
  modelCalls: number;
  modelError: string | null;
  cycleStatus: string | null;
  cycleDetail: string | null;
  cycleError: string | null;
  reservations: BudgetReservationV1[];
  reviewSubmissions: ReviewSubmissionObservationV1[];
  staleReviewAttempts: number;
}

const STATIC_MODEL = "model implementation port must not be called";
const STATIC_BRANCH = "candidate handoff scenario branch is not exact";

/** Minimal local `git` invocation with an isolated, credential-free child. */
export async function gitRun(
  cwd: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ ok: boolean; code: number; stdout: string }> {
  const result = await new Deno.Command("git", {
    args,
    cwd,
    clearEnv: true,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    ok: result.success,
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
  };
}

/** Actual bare-remote ref reader: never echoes a requested head. */
export function createRemoteRefReader(
  gitDir: string,
  env: Record<string, string>,
): (ref: string) => Promise<GitSha | null> {
  return async (ref) => {
    const read = await gitRun(gitDir, [
      "--git-dir",
      gitDir,
      "rev-parse",
      "--verify",
      "--quiet",
      ref,
    ], env);
    if (!read.ok) return null;
    const sha = read.stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha as GitSha : null;
  };
}

export interface RefReadingTransportInputV1 {
  repository: RepositoryIdentityV1;
  pullRequestNumber: number;
  issueNumber: number;
  candidateBranch: string;
  baseBranch: string;
  trustedPrAuthor: string;
  readRef(ref: string): Promise<GitSha | null>;
}

/**
 * Scripted GitHub REST/GraphQL transport over the ACTUAL remote refs. Every
 * PR/ref answer is read from the bare remote at request time, so an unpublished
 * or stale head can never be echoed back as published. Unknown requests fail
 * loudly instead of fabricating an empty success.
 */
export function makeRefReadingTransport(
  input: RefReadingTransportInputV1,
): HttpTransportV1 {
  const path = `/repos/${input.repository.owner}/${input.repository.name}`;
  const reply = (status: number, body: unknown) => ({
    status,
    headers: new Headers(),
    bodyText: JSON.stringify(body),
  });
  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === `${path}/issues`) {
      return reply(200, []);
    }
    if (
      request.method === "GET" &&
      url.pathname === `${path}/issues/${input.issueNumber}`
    ) {
      return reply(
        200,
        issueWire({
          number: input.issueNumber,
          title: `issue ${input.issueNumber}`,
          body: `<!-- sentinel:repair -->\nfixture issue\n`,
          state: "open",
        }),
      );
    }
    if (request.method === "POST" && url.pathname === "/graphql") {
      return reply(200, {
        data: {
          repository: {
            issue: {
              number: input.issueNumber,
              blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
              subIssues: { totalCount: 0 },
            },
          },
        },
      });
    }
    if (
      request.method === "GET" &&
      url.pathname === `${path}/pulls/${input.pullRequestNumber}`
    ) {
      const head = await input.readRef(`refs/heads/${input.candidateBranch}`);
      const base = await input.readRef(`refs/heads/${input.baseBranch}`);
      return reply(
        200,
        pullWire({
          number: input.pullRequestNumber,
          title: "Sentinel repair: issue",
          head: { ref: input.candidateBranch, sha: head },
          base: { ref: input.baseBranch, sha: base },
          user: { login: input.trustedPrAuthor },
          review_decision: "none",
        }),
      );
    }
    const marker = `${path}/git/ref/`;
    if (request.method === "GET" && url.pathname.startsWith(marker)) {
      const ref = `refs/${url.pathname.slice(marker.length)}`;
      const sha = await input.readRef(ref);
      if (sha === null) return reply(404, { message: "Not Found" });
      return reply(200, refWire(sha, ref));
    }
    throw new Error(
      `candidate handoff worker: unexpected request ${request.method} ` +
        url.pathname,
    );
  };
}

/**
 * Recording review transport that refuses (and records) any submission whose
 * exact head is not the candidate branch head actually published on the bare
 * remote at submission time.
 */
class PublishedHeadReviewService extends FakeReviewService {
  readonly stale: { expectedHead: GitSha; publishedHead: GitSha | null }[] = [];
  constructor(
    private readonly publishedHead: () => Promise<GitSha | null>,
  ) {
    super();
  }
  override async submitReview(
    request: ReviewRequestSubmitV1,
  ): Promise<PortResultV1<ReviewSubmitOutcomeV1>> {
    const published = await this.publishedHead();
    if (published === null || published !== request.expectedHead) {
      this.stale.push({
        expectedHead: request.expectedHead,
        publishedHead: published,
      });
      return portError(
        "conflict",
        "review head is not the published candidate",
      );
    }
    return await super.submitReview(request);
  }
}

function portObservation(result: PortResultV1<unknown>): PortObservationV1 {
  return result.ok
    ? { ok: true, kind: null, detail: null }
    : { ok: false, kind: result.error.kind, detail: result.error.detail };
}

/** Bounded, sanitized empty observation used when the worker itself failed. */
export function failedObservation(
  message: string,
): CandidateHandoffObservationV1 {
  return {
    workerError: message,
    boundary: "worker_failed",
    restore: { ok: false, kind: null, detail: null },
    baseFetchOk: false,
    fetchedBase: null,
    h1AbsentBeforeRestore: false,
    h1ObjectPresent: false,
    publishedHead: null,
    reviewedHead: null,
    reviewedParents: null,
    reviewedHeadH1Ancestor: null,
    reviewedHeadB1Ancestor: null,
    targetBase: null,
    targetHead: null,
    targetNextStep: null,
    targetIntentKind: null,
    targetWaitReason: null,
    modelCalls: 0,
    modelError: null,
    cycleStatus: null,
    cycleDetail: null,
    cycleError: null,
    reservations: [],
    reviewSubmissions: [],
    staleReviewAttempts: 0,
  };
}

async function safe<Value>(
  run: () => Promise<Value>,
  fallback: Value,
): Promise<Value> {
  try {
    return await run();
  } catch {
    return fallback;
  }
}

/**
 * Run the production consumers in this fresh process and return the bounded
 * observation. Throwing here is a worker fault, not a production-boundary
 * observation; the parent separates the two.
 */
export async function runCandidateHandoffWorker(
  scenario: CandidateHandoffScenarioV1,
): Promise<CandidateHandoffObservationV1> {
  const trustedPath = Deno.env.get("PATH") ?? "/usr/bin:/bin";
  const env: Record<string, string> = {
    PATH: trustedPath,
    HOME: scenario.childScratch,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const repository: RepositoryIdentityV1 = { ...scenario.repository };
  const workId = workItemIdForIssue(repository, scenario.issueNumber);
  const branch = candidateBranch(workId);
  if (branch !== scenario.candidateBranch) throw new Error(STATIC_BRANCH);

  const readRemote = createRemoteRefReader(scenario.remoteGitDir, env);
  const clock: Clock = { now: () => scenario.now };
  const state: RepairGitStateStore = createRepairStateStore({
    scratchDir: `${scenario.childScratch}/state`,
    remoteUrl: scenario.stateRemoteUrl,
  });
  const gate = new DurableGitHubCooldownGate({ state, clock });
  const config = createLocalRepositoryConfig();
  const configs = [config];
  const budget = new RollingStartBudget({ clock, state, configs });
  const review = new PublishedHeadReviewService(() =>
    readRemote(`refs/heads/${branch}`)
  );
  const http = makeRefReadingTransport({
    repository,
    pullRequestNumber: scenario.pullRequestNumber,
    issueNumber: scenario.issueNumber,
    candidateBranch: branch,
    baseBranch: scenario.baseBranch,
    trustedPrAuthor: scenario.trustedPrAuthor,
    readRef: readRemote,
  });
  const host = composeGitHubHost({
    repository,
    http,
    auth: new FakeAuthProvider(),
    cooldownGate: gate,
    clock,
    reviewService: review,
    trustedPrAuthor: scenario.trustedPrAuthor,
    trustedReviewer: scenario.trustedReviewer,
    trustedResolutionAuthors: [scenario.trustedPrAuthor],
    includeIssueRelations: true,
    git: {
      localDir: scenario.childSource,
      remoteUrl: scenario.remoteUrl,
      gitHome: scenario.childScratch,
      gitPath: "git",
    },
  });
  // The real recovery consumer of the hosted composition: a fresh empty object
  // store can only obtain H1 through this exact path.
  const candidates = createActionsCandidateRestorer({
    state,
    gate,
    token: "candidate-handoff-fixture-token",
    http,
    clock,
    sourcePath: scenario.childSource,
    scratch: scenario.childScratch,
    trustedPath,
    gitExecutable: "git",
    remoteUrl: scenario.remoteUrl,
    apiBaseUrl: "https://api.github.com",
  });
  // The exact production capability on the exact same port + executor.
  host.port.prepareBaseRefresh = createPrepareBaseRefresh({
    git: host.git,
    observer: host.port,
    baseBranch: scenario.baseBranch,
    trustedPrAuthor: scenario.trustedPrAuthor,
    ensureCandidateObjects: (value) => candidates.ensure(value),
  });

  // Hosted startup loads the moved base before any recovery: fetch ONLY the
  // base ref from the bare remote into this fresh object store, exactly like
  // `refreshDevelopment`, so the B1 objects the refresh needs actually exist
  // here. No alternate, shared clone or object cache is involved.
  const baseFetch = await gitRun(scenario.childSource, [
    "fetch",
    "--no-tags",
    scenario.remoteUrl,
    `+refs/heads/${scenario.baseBranch}:refs/remotes/origin/${scenario.baseBranch}`,
  ], env);
  const fetchedBaseRead = await gitRun(scenario.childSource, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/origin/${scenario.baseBranch}`,
  ], env);
  const fetchedRaw = fetchedBaseRead.stdout.trim();
  const fetchedBase = fetchedBaseRead.ok && /^[0-9a-f]{40}$/.test(fetchedRaw)
    ? fetchedRaw as GitSha
    : null;
  const h1AbsentBeforeRestore = !(await safe(
    async () =>
      (await gitRun(scenario.childSource, [
        "cat-file",
        "-e",
        `${scenario.producerHead}^{commit}`,
      ], env)).ok,
    true,
  ));

  // Recovery attempt: the durable record's exact old base and candidate head.
  const restore = portObservation(
    await candidates.ensure({
      base: scenario.oldBase,
      head: scenario.producerHead,
    }),
  );

  let modelCalls = 0;
  let modelError: string | null = null;
  const model: ImplementationPort = {
    runModel: () => {
      modelCalls += 1;
      modelError = STATIC_MODEL;
      throw new Error(STATIC_MODEL);
    },
  };

  let outcome: RepairCycleOutcomeV1 | null = null;
  let cycleError: string | null = null;
  try {
    outcome = await runRepairEntrypoint({
      clock,
      state,
      configs,
      controllerSha: scenario.controllerSha,
      github: host.port,
      githubCooldown: gate,
      incidents: unavailableIncidents,
      replay: unavailableReplay,
      model,
      budget,
    }, {
      deadline: scenario.now + 3_600_000,
      stepLimit: scenario.stepLimit,
    });
  } catch (error) {
    cycleError = error instanceof Error ? error.message : String(error);
  }

  const publishedHead = await safe(
    () => readRemote(`refs/heads/${branch}`),
    null,
  );
  const hasH1 = await safe(
    async () =>
      (await gitRun(scenario.childSource, [
        "cat-file",
        "-e",
        `${scenario.producerHead}^{commit}`,
      ], env)).ok,
    false,
  );
  let targetBase: GitSha | null = null;
  let targetHead: GitSha | null = null;
  let targetNextStep: string | null = null;
  let targetIntentKind: string | null = null;
  let targetWaitReason: string | null = null;
  let reservations: BudgetReservationV1[] = [];
  const stateRead = await state.readRepair();
  if (stateRead.ok && stateRead.value.status === "found") {
    reservations = stateRead.value.snapshot.reservations;
    const record = stateRead.value.snapshot.work.find((work) =>
      work.id === workId
    ) ?? null;
    if (record !== null) {
      targetBase = record.target.base;
      targetHead = record.target.head;
      targetNextStep = record.nextStep;
      targetIntentKind = record.intent?.kind ?? null;
      targetWaitReason = record.wait?.reason ?? null;
    }
  }
  const reviewSubmissions: ReviewSubmissionObservationV1[] = review.submits.map(
    (submit) => ({
      expectedHead: submit.expectedHead,
      expectedBase: submit.expectedBase,
      accepted: true,
    }),
  );
  // One ACTUAL recorded submission defines the reviewed head. The durable
  // target head is production bookkeeping and must never stand in for it; zero
  // or multiple submissions leave the reviewed head unknown so the parent's
  // exactly-one requirement fails instead of passing on a fabricated head.
  const reviewedHead = reviewSubmissions.length === 1
    ? reviewSubmissions[0].expectedHead
    : null;
  let reviewedPresent = false;
  let reviewedParents: string[] | null = null;
  let reviewedHeadH1Ancestor: boolean | null = null;
  let reviewedHeadB1Ancestor: boolean | null = null;
  if (reviewedHead !== null) {
    const target: GitSha = reviewedHead;
    reviewedPresent = await safe(async () => {
      const read = await gitRun(scenario.childSource, [
        "cat-file",
        "-e",
        `${target}^{commit}`,
      ], env);
      return read.ok;
    }, false);
    if (reviewedPresent) {
      reviewedParents = await safe(async () => {
        const read = await gitRun(scenario.childSource, [
          "rev-list",
          "--parents",
          "-n",
          "1",
          target,
        ], env);
        return read.ok ? read.stdout.trim().split(/\s+/) : null;
      }, null);
      const ancestorOf = async (
        ancestor: GitSha,
      ): Promise<boolean | null> =>
        await safe(async () => {
          const read = await gitRun(scenario.childSource, [
            "merge-base",
            "--is-ancestor",
            ancestor,
            target,
          ], env);
          return read.ok;
        }, null);
      reviewedHeadH1Ancestor = hasH1
        ? await ancestorOf(scenario.producerHead)
        : null;
      reviewedHeadB1Ancestor = await ancestorOf(scenario.newBase);
    }
  }

  let boundary = "reached_review_admission";
  if (!restore.ok) boundary = "candidate_restore_unavailable";
  else if (publishedHead === null) boundary = "candidate_branch_absent";
  else if (publishedHead === scenario.oldRemoteHead) {
    boundary = "candidate_not_published";
  } else if (reviewedHead !== publishedHead) {
    boundary = "reviewed_head_not_published";
  }
  const cycleDetail = outcome === null
    ? null
    : outcome.status === "step_limit"
    ? `steps:${outcome.steps}`
    : outcome.detail;

  return {
    workerError: null,
    boundary,
    restore,
    baseFetchOk: baseFetch.ok,
    fetchedBase,
    h1AbsentBeforeRestore,
    h1ObjectPresent: hasH1,
    publishedHead,
    reviewedHead,
    reviewedParents,
    reviewedHeadH1Ancestor,
    reviewedHeadB1Ancestor,
    targetBase,
    targetHead,
    targetNextStep,
    targetIntentKind,
    targetWaitReason,
    modelCalls,
    modelError,
    cycleStatus: outcome?.status ?? null,
    cycleDetail,
    cycleError,
    reservations,
    reviewSubmissions,
    staleReviewAttempts: review.stale.length,
  };
}

if (import.meta.main) {
  let observationPath: string | null = null;
  let observation: CandidateHandoffObservationV1;
  try {
    const scenario = JSON.parse(
      await new Response(Deno.stdin.readable).text(),
    ) as CandidateHandoffScenarioV1;
    observationPath = scenario.observationPath;
    observation = await runCandidateHandoffWorker(scenario);
  } catch (error) {
    observation = failedObservation(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (observationPath !== null) {
    await Deno.writeTextFile(
      observationPath,
      JSON.stringify(observation, null, 2) + "\n",
    ).catch(() => {});
  }
}
