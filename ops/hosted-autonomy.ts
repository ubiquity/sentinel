/**
 * Bounded self-upkeep for the hosted supervisor, run FIRST inside the protected
 * maintenance job (before `prepare`, under the same `sentinel-repair` lock the
 * repair job holds), so its state changes are visible to that run's own
 * execution:
 *
 *  A CANDIDATE-REF REVALIDATION runs before any blocked work is selected for a
 *  retry grant. The runtime's ONE terminal diagnosis that the managed candidate
 *  branch ref matched neither the saved candidate head nor the recorded
 *  published head is re-read from the record's OWN repository surface; only a
 *  record whose saved descriptor, published head and canonical preservation ref
 *  all bind to that same repository, task and producing operation, and whose
 *  live branch ref reports exactly the original saved head, returns to `work`
 *  with only that blocker cleared. The pass returns immediately after that
 *  write, so a delivery or review decision is never made in the same run from a
 *  state the runtime has not yet reconciled; every other identity is untouched.
 *
 *  1. RETRY PASS — a work record blocked by one of the runtime's TRANSIENT
 *     failures (a model session that produced no trusted receipt or candidate,
 *     an exhausted attempt budget, exhausted review rounds, a review that
 *     produced no verdict within its bounded wait, or a review admission that
 *     was already settled at the current head) is granted the smallest closed
 *     counter adjustment that makes its next admission an UNUSED reservation
 *     identity; a work-returning grant must also land strictly below the
 *     runtime's own implementation-attempt ceiling, because admission at or
 *     above that ceiling is refused outright. A review-returning grant instead
 *     persists the review-round floor its own settled `review_request` charges
 *     prove — never zeroing or lowering a charged counter — and, once every
 *     review identity inside the runtime's round allowance is spent at that
 *     head, records the runtime's own base-refresh intent for a newer observed
 *     base, which is what supplies a new head and therefore fresh identities.
 *     When every identity at the record's current base is already charged, a
 *     work-returning grant uses that same base-refresh path, and a review
 *     intent is cleared only when its exact request reservation is proven
 *     settled. Each task may use at most `HOSTED_AUTONOMY_MAX_RETRIES` such
 *     grants, counted in the task's durable reservations (every purpose,
 *     including one still `reserved`), so no uncharged retry cycle exists and a
 *     task can never loop forever. Nothing is deleted or reset: the preserved
 *     `retries` counter, every charge, reservation, receipt, review and
 *     candidate stay exactly as they are, and only `attempts` is lowered by a
 *     work-returning grant.
 *
 *  2. DELIVERY PASS — a record whose exact reviewed head carries a completed
 *     review receipt that POSITIVELY accepts the record's own source issue,
 *     bound to the trusted live issue statement read immediately before the
 *     merge (the shared predicate of `src/repair/review-gate.ts`; a legacy
 *     quality-only receipt, a wrong-task digest, a not-fulfilled/uncertain or
 *     already-satisfied-base verdict never authorizes delivery) and a
 *     successful deterministic check is delivered end to
 *     end without an operator: the expected-head merge is performed with a
 *     compare-and-swap under the runtime's own criteria — necessary because
 *     this deployment's `development` ruleset carries no active `pull_request`
 *     rule, so the runtime's trusted merge port refuses by design — and then
 *     the exact release request the runtime's delivery step would have written
 *     is recorded for the trusted supervisor, which still owns prior/candidate
 *     proofs, promotion, acceptance and rollback. A record the runtime parked
 *     in `work`/`blocked` because its own correction predicate demanded a round
 *     it can no longer review is delivered from the same receipt: the review
 *     budget is spent, so no further verdict is reachable.
 *
 *  3. CLOSURE PASS — a SELF record whose exact pull request and reviewed head
 *     are delivered by an ACCEPTED hosted release is closed, exactly as before,
 *     and only while the same semantic receipt predicate still authorizes it
 *     against the trusted issue statement read immediately before the closure.
 *     A FOREIGN record is closed from its OWN merged pull request instead: the
 *     trusted release path is bound to the self scope by design, so sentinel
 *     holds no release authority for another repository and never fabricates a
 *     hosted release for one. Its closure requires the pull merged under a
 *     named merge commit with exactly two parents equal to the recorded base
 *     and head, the revision integrated into that repository's recorded base
 *     branch, and a completed authorizing receipt for the exact
 *     repository/PR/head/base.
 *
 * Every surface, base branch, deterministic check, issue identity and delivery
 * decision is resolved PER REPOSITORY: a record is read and written only under
 * its own repository identity, its own repository default branch supplies its
 * base branch, and one repository's issue number can never be confused with
 * another's. An unreadable surface, a missing default branch, a missing
 * check-run, an unreadable pull or any mismatched head/base/author fails
 * closed with an explicit bounded action and changes nothing.
 *
 * It writes no review, receipt, proof, promotion or acceptance, and it never
 * merges without a completed current-head receipt, a green deterministic check
 * and an unchanged recorded base.
 *
 * Runs only inside the protected `sentinel-supervisor` maintenance job at the
 * dispatched source commit.
 */
import type { PortResultV1 } from "../src/contracts/ports.ts";
import type {
  GitHubPort,
  IncidentAdapter,
  ReplayPort,
} from "../src/contracts/ports.ts";
import {
  CLOSED_C_WAVE,
  type ClosedCWaveBindingV1,
  closedCWaveNeedsRecovery,
  type ClosedCWaveRecoveryDepsV1,
  ingestClosedCWave,
} from "../src/host/modern-matrix-recovery.ts";
import { createGitBundleImporter } from "../src/host/matrix-git.ts";
import { ingestMatrixResults } from "../src/host/matrix.ts";
import { matrixDigestV1 } from "../src/contracts/matrix.ts";
import {
  HOSTED_RUNTIME_ID,
  parseHostedRunProofV1,
} from "../src/contracts/hosted-supervisor.ts";
import {
  createMatrixUncertaintyMaintenance,
  MATRIX_PRESERVATION_UNCERTAINTY_DETAIL,
  runMatrixUncertaintyMaintenance,
} from "../src/host/matrix-uncertainty-maintenance.ts";
import {
  createDefaultBranchResolver,
  loadTargetConfigsV1,
} from "../src/host/targets.ts";
import {
  parseAppInstallationId,
  scopeTargetConfigV1,
} from "../src/host/actions.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import { parseRepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { ReleaseRequestV1 } from "../src/contracts/release.ts";
import { parseReleaseRequestV1 } from "../src/contracts/release.ts";
import {
  checkReviewTaskStatement,
  type ReviewReceiptV1,
  reviewTaskStatementDigest,
  type ReviewTaskStatementV1,
} from "../src/contracts/review-receipt.ts";
import { reviewAuthorizesMerge } from "../src/repair/review-gate.ts";
import { attemptEquivalenceRefusalForRecordV1 } from "../src/repair/attempt-policy.ts";
import { RETIRED_MERGED_MESSAGE } from "../src/repair/selection.ts";
import type { GitSha } from "../src/contracts/brands.ts";
import { RollingStartBudget } from "../src/budget/mod.ts";
import { GitHubApiClient } from "../src/github/client.ts";
import { portError, portOk } from "../src/contracts/ports.ts";
import {
  fetchHttpTransport,
  type HttpTransportV1,
} from "../src/github/http.ts";
import { HostedRepairCooldownGate } from "../src/host/hosted-cooldown.ts";
import { parseCooldownModeV1 } from "../src/contracts/cooldown-mode.ts";
import {
  createActionsMatrixArtifactHttpTransport,
  createActionsMatrixArtifactTransport,
} from "../src/host/matrix-artifacts.ts";
import {
  HISTORICAL_NOT_STARTED_DETAIL,
  type HistoricalMatrixQuarantineDepsV1,
  runHistoricalMatrixQuarantine,
} from "../src/host/matrix-actions.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import {
  extractSelfFailureSignature,
  planSelfObservations,
  SELF_DEFECT_MAX_ISSUES_PER_PASS,
  SELF_DEFECT_MAX_LOG_BYTES,
  SELF_DEFECT_MAX_RUNS_PER_PASS,
  SELF_DEFECT_WINDOW_MS,
  SELF_DEFECT_WORKFLOWS,
  type SelfFailureV1,
} from "./self-defects.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
  releaseRequestId,
  reviewOperationKey,
} from "../src/repair/keys.ts";
import {
  createLocalRepositoryConfig,
  githubGitAuthEnv,
  prepareSourceRepository,
  refreshDevelopment,
} from "../src/host/local.ts";
import { createRepairStateStore, DenoGitRunner } from "../src/state/mod.ts";
import type {
  RepairStateWriter,
  StateReadView,
  StateWriteResultV1,
} from "../src/contracts/ports.ts";
import {
  ISSUE48_QUOTA_REMOTE_URL,
  validateIssue48QuotaHostedIdentity,
} from "./issue48-review-quota-recovery.ts";

/** Snapshot work record, as read from the durable repair state. */
type HostedAutonomyRecordV1 = RepairStateSnapshotV1["work"][number];

/**
 * The one hosted self scope: the no-App owner credential identity that owns
 * this repository, its `development` base branch, its named deterministic
 * check and the trusted release path. Every other identity is a foreign target
 * and is handled entirely under its OWN repository surface.
 */
const HOSTED_AUTONOMY_SELF_SCOPE: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "sentinel",
  installationId: 0,
};

/** True only for the sentinel self scope, the one identity with named checks. */
function isHostedSelf(repository: RepositoryIdentityV1): boolean {
  return repository.installationId ===
      HOSTED_AUTONOMY_SELF_SCOPE.installationId &&
    repository.owner === HOSTED_AUTONOMY_SELF_SCOPE.owner &&
    repository.name === HOSTED_AUTONOMY_SELF_SCOPE.name;
}

/** Exact repository identity equality, installation scope included. */
function sameRepository(
  left: RepositoryIdentityV1,
  right: RepositoryIdentityV1,
): boolean {
  return left.installationId === right.installationId &&
    left.owner === right.owner && left.name === right.name;
}

/**
 * Stable repository scope key. This is the separator that makes every planning
 * identity repository-scoped: two repositories may both have an issue 120 and
 * they must never be confused.
 */
export function hostedRepositoryKey(
  repository: RepositoryIdentityV1,
): string {
  return `${repository.installationId}:${repository.owner}/${repository.name}`;
}

/** One issue identity: the pair (repository, issue number), never a number. */
export function hostedIssueKey(
  repository: RepositoryIdentityV1,
  issueNumber: number,
): string {
  return `${hostedRepositoryKey(repository)}#${issueNumber}`;
}

/** One delivery identity: repository, pull request, head and base. */
export function hostedDeliveryKey(
  repository: RepositoryIdentityV1,
  pullRequest: number,
  head: string,
  base: string,
): string {
  return `${hostedRepositoryKey(repository)}:${pullRequest}:${head}:${base}`;
}

/**
 * Delivery eligibility. The ordinary path is the runtime's own `review` and
 * `delivery` steps. A record parked in `work` or `blocked` is also eligible
 * once it has spent every review round: the runtime advances to a correction
 * round for ANY unresolved finding (its `advanceToCorrection` predicate is
 * stricter than the documented "no unresolved P0/P1 → delivery" rule and than
 * the trusted acceptance gate), and without a review round left that
 * correction can never become a reviewed verdict. The receipt in hand is then
 * the only honest basis for delivery, and P2/P3 findings stay future work. No
 * other parked step is ever delivered.
 */
function deliveryEligible(record: HostedAutonomyRecordV1): boolean {
  if (record.nextStep === "review" || record.nextStep === "delivery") {
    return true;
  }
  if (record.nextStep !== "work" && record.nextStep !== "blocked") {
    return false;
  }
  return record.counters.reviewRounds >= HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS;
}

/** The base branch every reviewed candidate must be integrated into. */
export const HOSTED_AUTONOMY_BASE_BRANCH = "development";

/** The deterministic check the merge requires on the exact reviewed head. */
export const HOSTED_AUTONOMY_REQUIRED_CHECK = "test-local";

/**
 * Bound on automatic retry grants per task, counted in the task's durable
 * reservations: every reservation for the task counts, whatever its purpose or
 * outcome, including one still `reserved`. A reservation is the charge the
 * runtime persists before any model start, so this unit cannot be reset,
 * refunded away or left uncharged by this pass; the preserved `retries` counter
 * is history and is never incremented or reset here. A transient provider
 * outage must never permanently kill a task, and a single task must never loop
 * cheaply either: the retry only ever runs inside an execution, and executions
 * are hourly unless a release or a health gap starts one, so the cadence itself
 * is the rate limit. (An earlier 30-minute blocker cooldown also gated retries
 * that carry a fresh reservation identity, which merely wedged tasks that were
 * otherwise recoverable.)
 */
export const HOSTED_AUTONOMY_MAX_RETRIES = 200;

/** The runtime's own implementation-attempt ceiling. */
export const HOSTED_AUTONOMY_MAX_IMPLEMENTATION_ATTEMPTS = 4;

/**
 * The runtime's own review-round ceiling. A record that has spent every review
 * round can never turn another correction into a reviewed verdict, so the only
 * remaining delivery path is the receipt it already holds.
 */
export const HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS = 3;

/**
 * Static blocker message for a record whose source issue no longer exists. It
 * deliberately matches none of the retryable prefixes, so the retry pass never
 * revives it.
 */
export const HOSTED_AUTONOMY_RETIRED =
  "source issue is closed; the repair no longer exists";

/**
 * The trusted publication identity of autonomously repaired pull requests
 * before the App migration. Kept as the single legacy login for callers that
 * still name it.
 */
export const HOSTED_AUTONOMY_TRUSTED_AUTHOR = "github-actions[bot]";
/** The sentinel App bot identity that now authors repaired pull requests. */
export const HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR = "ubiquity-sentinel[bot]";
/**
 * The same fixed sentinel App identity (App 4682172, bot user 319834869) is
 * the ONLY reviewer that may authorize issue-backed delivery at the persisted
 * receipt boundary: `authorizingReceipt` pins
 * `HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR` as the receipt's exact reviewer, so a
 * self-consistent receipt naming any other reviewer never authorizes. Legacy
 * receipts keep parsing; they simply refuse as new authorization.
 */
/**
 * Bounded transition set: a pull request published by a runtime at an older
 * installed revision is authored by `github-actions[bot]`, one published after
 * this migration by `ubiquity-sentinel[bot]`. This dual acceptance is a scoped
 * transition rule; remove the old login after the first app-authored delivery
 * is observed.
 */
export const HOSTED_AUTONOMY_TRUSTED_AUTHORS: readonly string[] = [
  HOSTED_AUTONOMY_TRUSTED_AUTHOR,
  "ubiquity-sentinel[bot]",
];

/**
 * The exact transient blockers the retry pass may clear, with the step the
 * record returns to. A blocker outside this closed set is never touched.
 *
 * The two review classes are the runtime's own transient review outcomes: a
 * review whose durable admission was settled while its operation intent was
 * lost (re-entry on the same identity is the runtime's terminal "settled
 * without an intent" contradiction), and the legacy bounded no-verdict review
 * wait. Both return to `review`, where the runtime rehydrates its standing
 * review before any new charge and continues inside its own round allowance.
 */
export const HOSTED_AUTONOMY_RETRYABLE: readonly {
  readonly prefix: string;
  readonly nextStep: "work" | "review";
}[] = [
  {
    prefix: "model run ended without a trusted receipt",
    nextStep: "work",
  },
  {
    prefix: "model run did not complete with a trusted candidate",
    nextStep: "work",
  },
  {
    // A truthfully proven historical not-started admission is resolved
    // uncertainty, not a model outcome: the existing retry authority still
    // owns whether a fresh eligible start follows, under its own attempt
    // ceiling, durable reservation identity, source and closed-issue gates.
    prefix: HISTORICAL_NOT_STARTED_DETAIL,
    nextStep: "work",
  },
  {
    prefix: "implementation attempt budget exhausted",
    nextStep: "work",
  },
  {
    prefix: "review rounds exhausted without an accepted verdict",
    nextStep: "review",
  },
  {
    prefix: "review produced no verdict within the bounded review wait",
    nextStep: "review",
  },
  {
    prefix: "review admission already settled without an intent",
    nextStep: "review",
  },
  {
    prefix: "model admission refused: duplicate",
    nextStep: "work",
  },
];

const API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_048_576;
/**
 * GitHub list pagination bound. Every list read that gates a delivery must be
 * COMPLETE: the reader walks pages until the response's own `total_count` is
 * covered, and a listing that promises more items than the bound can cover is
 * refused rather than answered from a prefix.
 */
const LISTING_PAGE_SIZE = 100;
/** The workflow-run listing keeps its pre-existing 50-item page size. */
const RUN_LISTING_PAGE_SIZE = 50;
const MAX_LISTING_PAGES = 20;

export type HostedAutonomyReasonV1 =
  | "applied"
  | "no_change"
  | "retried"
  | "no_authorizing_review"
  | "base_moved"
  | "checks_pending"
  | "merge_refused"
  | "merge_not_observed"
  | "already_recorded"
  | "closed_issues"
  | "retired_records"
  | "foreign_author"
  | "release_not_terminal"
  | "clock_invalid"
  | "snapshot_invalid"
  | "write_conflict"
  | "write_ambiguous"
  | "write_unavailable"
  | "readback_unverified"
  | "identity_rejected"
  | "historical_quarantine_incomplete"
  | "unexpected_failure";

export interface HostedAutonomyResultV1 {
  kind: "hosted_autonomy";
  status: "applied" | "skipped" | "failed";
  reason: HostedAutonomyReasonV1;
  beforeHead: string | null;
  appliedHead: string | null;
  actions: readonly string[];
  revisions: readonly string[];
}

/** Remote merge facts this helper may not guess. */
export interface HostedAutonomyPullV1 {
  number: number;
  state: string;
  merged: boolean;
  mergeCommitSha: string | null;
  headSha: string | null;
  baseRef: string | null;
  author: string | null;
  /** Required only when recovering a historical cleared publication. */
  mergedBy?: string | null;
  parents: readonly string[];
  revisionOnBaseBranch: boolean;
}

export interface HostedAutonomyGitHubV1 {
  /**
   * The repository's own default branch, or null when it cannot be read. Only
   * a foreign repository consults this; the self scope keeps its recorded
   * `development` constant.
   */
  readDefaultBranch(): Promise<string | null>;
  /**
   * Current tip of one repository branch — the repository's configured base
   * branch or a managed candidate branch — or null when it cannot be read. The
   * response must name exactly `refs/heads/<branch>`: a ref that names any
   * other branch is not evidence for the requested branch and reads as null.
   */
  readBaseTip(branch: string): Promise<string | null>;
  /**
   * Self gate: true when the exact head carries a completed successful
   * check-run named `test-local`. The whole check-run listing is read and must
   * be proven complete and consistent; an unreadable, incomplete, drifted,
   * duplicated or malformed read is never green, and a later page may not hide
   * the named check or a failure.
   */
  hasSuccessfulCheck(head: string): Promise<boolean>;
  /**
   * Foreign gate: true when the exact head carries at least one check-run and
   * every one of them is completed with conclusion `success`. Zero check-runs
   * is not green, no run may still be pending or queued on that head, and the
   * listing must be proven complete across every page: a read that cannot be
   * completed is never green.
   */
  hasAllChecksGreen(head: string): Promise<boolean>;
  /**
   * `baseBranch` is the branch the merge must be integrated into; a merged
   * pull whose integration cannot be verified without it reads as null.
   */
  readPull(
    number: number,
    baseBranch: string | null,
  ): Promise<HostedAutonomyPullV1 | null>;
  /**
   * True when the source issue is open, false when it is closed or missing,
   * null when that cannot be read. Only a definitive false stops a retry.
   */
  readIssueOpen(number: number): Promise<boolean | null>;
  /**
   * Trusted, independent read of the exact source-issue task statement this
   * delivery must fulfill: the issue's own number, title and body with the
   * canonical digest of that text, read over THIS repository's authenticated
   * surface immediately before a merge, release request or closure. Null means
   * the statement could not be read or bounded, which never authorizes
   * issue-backed delivery. Absent means the surface cannot supply it, which
   * also fails closed for issue-backed records.
   */
  readIssueTask?(number: number): Promise<ReviewTaskStatementV1 | null>;
  /** Expected-head merge; null on any refusal. */
  merge(
    number: number,
    head: string,
  ): Promise<{ merged: boolean; sha: string | null } | null>;
  /** Idempotent issue closure: true when the issue ends closed. */
  closeIssue(number: number): Promise<boolean>;
  /**
   * Workflow-run ids parked for approval on exactly this commit, read from the
   * complete listing (a parked run on a later page is still found). A listing
   * that cannot be proven complete approves nothing.
   */
  listParkedRuns(head: string): Promise<number[]>;
  /** Approve one parked workflow run; true when the approval was accepted. */
  approveRun(id: number): Promise<boolean>;

  /**
   * Optional self-observation capability. Present only where the deployment
   * may read its own Actions history and file defects into its own tracker.
   */
  selfObservation?: HostedSelfObservationV1;
}

export interface HostedSelfRunV1 {
  id: number;
  name: string;
  conclusion: string | null;
  createdAt: string;
}

export interface HostedSelfJobV1 {
  id: number;
  name: string;
  conclusion: string | null;
}

/**
 * Optional self-observation surface: this deployment's own recent workflow
 * runs, the failed job logs (bounded read) and the issue write used to report
 * a defect class. Absent means the pass is skipped entirely — no reads, no
 * writes — so a host without the capability behaves exactly as before.
 */
export interface HostedSelfObservationV1 {
  listRuns(input: {
    sinceIso: string;
    limit: number;
  }): Promise<HostedSelfRunV1[] | null>;
  listJobs(runId: number): Promise<HostedSelfJobV1[] | null>;
  readJobLog(
    input: { jobId: number; maxBytes: number },
  ): Promise<string | null>;
  listOpenIssueBodies(): Promise<string[] | null>;
  fileIssue(input: { title: string; body: string }): Promise<number | null>;
}

export interface HostedAutonomyDepsV1 {
  state: StateReadView & RepairStateWriter;
  /**
   * Resolve the GitHub surface for one exact repository identity. A null (or
   * throwing) resolver is an unreadable surface: the affected record is
   * skipped with an explicit action and nothing changes. No repository ever
   * borrows another repository's surface.
   */
  githubFor(repository: RepositoryIdentityV1): HostedAutonomyGitHubV1 | null;
  clock: { now(): number };
  /** Present on protected maintenance; rejection-only, before retry/delivery. */
  historicalMatrix?: HistoricalMatrixQuarantineDepsV1;
  closedMatrix?: (
    state?: StateReadView & RepairStateWriter,
  ) => Promise<ClosedCWaveRecoveryDepsV1>;
  /** Charged uncertainty only; no producer, artifact, health or release authority. */
  uncertainMatrix?: () => ReturnType<typeof runMatrixUncertaintyMaintenance>;
}

/** The maintenance slice has no implementation, review or publication capability. */
export async function createHostedClosedMatrixRecovery(input: {
  state: StateReadView & RepairStateWriter;
  clock: { now(): number };
  token: string;
  apiToken: string;
  sourceDir: string;
  scratch: string;
  artifactRoot: string;
  appInstallationId?: string;
  cooldownMode?: string;
  http?: HttpTransportV1;
  artifactHttp?: HttpTransportV1;
}): Promise<ClosedCWaveRecoveryDepsV1> {
  const http = input.http ?? fetchHttpTransport();
  const template = createLocalRepositoryConfig();
  const targets = await loadTargetConfigsV1({
    template,
    root: input.sourceDir,
    resolveDefaultBranch: createDefaultBranchResolver({
      http,
      token: input.apiToken,
    }),
  });
  const configs = targets.configs.map((config) =>
    scopeTargetConfigV1(
      config,
      template.repository,
      parseAppInstallationId(input.appInstallationId),
    )
  );
  const gate = new HostedRepairCooldownGate({
    state: input.state,
    clock: input.clock,
    mode: parseCooldownModeV1(input.cooldownMode),
  });
  const client = new GitHubApiClient({
    repository: template.repository,
    apiBaseUrl: "https://api.github.com",
    http,
    clock: input.clock,
    auth: {
      authorizationHeader: () =>
        Promise.resolve(portOk(`Bearer ${input.token}`)),
    },
    cooldownGate: gate,
  });
  const budget = new RollingStartBudget({
    state: input.state,
    clock: input.clock,
    configs,
  });
  function refused<T>(): T {
    return new Proxy({}, {
      get: () => () =>
        Promise.reject(new Error("C maintenance capability refused")),
    }) as T;
  }
  const mirror = (config: typeof configs[number]) =>
    input.scratch + "/sources/" + config.repository.owner + "-" +
    config.repository.name;
  await Deno.mkdir(input.scratch + "/sources", {
    recursive: true,
    mode: 0o700,
  });
  return {
    state: input.state,
    clock: input.clock,
    configs,
    cycleFor: () => ({
      state: input.state,
      clock: input.clock,
      configs,
      controllerSha: CLOSED_C_WAVE.runtimeSha,
      github: refused<GitHubPort>(),
      githubCooldown: gate,
      incidents: refused<IncidentAdapter>(),
      replay: refused<ReplayPort>(),
      model: {
        modelId: "gpt-reserve",
        runModel: () => {
          throw new Error("C maintenance model refused");
        },
      },
      budget,
      externalImplementations: true,
    }),
    prepareTarget: async (config) => {
      const host = {
        stateRoot: input.scratch,
        sourceDir: input.sourceDir,
        controllerSha: CLOSED_C_WAVE.runtimeSha,
        githubToken: input.apiToken,
        modelToken: "",
        codexExecutable: "",
        denoExecutable: Deno.execPath(),
        trustedPath: "/usr/bin:/bin",
      };
      const remoteUrl =
        `https://github.com/${config.repository.owner}/${config.repository.name}.git`;
      await prepareSourceRepository(
        mirror(config),
        host,
        input.scratch,
        config.repository.name === template.repository.name &&
          config.repository.owner === template.repository.owner
          ? undefined
          : remoteUrl,
      );
      await refreshDevelopment(
        mirror(config),
        host,
        input.scratch,
        gate,
        config.repository.installationId,
        { remoteUrl, baseBranch: config.baseBranch },
      );
    },
    importerFor: (config, bundlesDir) =>
      createGitBundleImporter({ repositoryDir: mirror(config), bundlesDir }),
    transportFor: (state) =>
      createActionsMatrixArtifactTransport({
        state,
        clock: input.clock,
        token: input.token,
        artifactRoot: input.artifactRoot,
        http: input.artifactHttp ?? createActionsMatrixArtifactHttpTransport(),
      }),
    readExecution: (execution) => client.readHostedExecution(execution),
  };
}

/** Exact authenticated legacy wave identities; no runtime-selected history. */
/**
 * The documented runtime routes a retained producer could have used: the
 * gateway primary and its per-run DeepSeek fallback. Historical recovery
 * accepts a receipt from either and refuses anything else.
 */
const HISTORICAL_RECOVERY_PROVIDERS: readonly string[] = ["uos", "deepseek"];

const HISTORICAL_C63 = {
  executionId: "37354374590:1:repair",
  runtimeSha: "e4cef46332cf124a8c283d798a963cf5f66e45c2" as GitSha,
  generation: 63,
  run: {
    runId: 37354374590,
    runAttempt: 1,
    launcherSha: "b261c3672b29c29cfe6858fe96beb05687018c8f" as GitSha,
  },
  base: "3691fe4a36e4e4c6aae6f8c6aa04c12ed3ff6698",
  repository: {
    owner: "ubiquity",
    name: "ai.ubq.fi",
    installationId: 155687488,
  },
  rows: [
    {
      id: "issue-ubiquity-ai.ubq.fi-576",
      issue: 576,
      reservation:
        "ffc3337e27e0e05a641908db08825ad63bc6d6868cfabcd5af667b2ede4d4677",
      cellId:
        "65dae22ecd6455374aa5d3a1873c52e0cd07f2a7b4abdb57a40b39e025a42b86",
    },
    {
      id: "issue-ubiquity-ai.ubq.fi-616",
      issue: 616,
      reservation:
        "7d9d1b7949b3d5dc3c9917cf24263324f23674ce891f9f269b73a9e787d8bad4",
      cellId:
        "f2a5c534305b6229e3214cf10f64f54c6d9fff81004c8a1a190f87528c2b124f",
    },
    {
      id: "issue-ubiquity-ai.ubq.fi-618",
      issue: 618,
      reservation:
        "2956b4efb0ba8181e3e0c15f6ce7bd024640706c293cdb34a7dfd322e3d4ae86",
      cellId:
        "389abc16ad5eda81f11b4eca7407b43912b8d43398edb516d830ff4212fa5cb4",
    },
  ],
} as const;

export const HOSTED_HISTORICAL_RELEASE_WITNESSES = [
  {
    commit: "fd976f84ba57e4090021a2f06aa9c8ff4acb3a06" as GitSha,
    executionId: HISTORICAL_C63.executionId,
    logDigest:
      "efe0cf9e6434798bdc6e0ba9ee693f2c4839e95bfffafd1de307478cb2fb72b0",
    reservationIds: [
      ...HISTORICAL_C63.rows.map((row) => row.reservation),
      "8da7cfad2230c22de6955d53a2b6923ce1734dd825a2440c43d6a74440c99a09",
      "3cb86e0f76b76aadaaac176c172e43effb5c8533c7d1b3ca1339f548da534af5",
      "fb79ebbb9552de0df004fdf8d19ec2bd2be7dc8ac36b94efb98dddce72d0804e",
      "1bc96d7012496ae85316abdd6e68914fa9944288c71a5fade3f8005533d08ebc",
      "d53181817d837b13f62ab7ee92fd7e540d576312c90239cebc4c0d7268a4e0d0",
      "487ed315f82ff0bd132fbe8fa97b6fd736f1fdc2701497367cb981f8ced0161d",
      "128b0db9b4f8c157f953b9ecfb18544ee04f019fb78eeec7ddf7e649a031d522",
      "8f4f55cb4af1c3e543e36556da8890c1a9c11b913415d4cfb0c3e35c5118241a",
      "63988226e9739da266ce14de1cce5746d662220e39a8ddcb99337ab40b405d69",
      "0d8da09d774019c738f09dfdd6a249993a7bd49ffeb03b21b4629132e739cd44",
      "53437275fa4adaa9788d2ca51b971cc0a3744611c5cf281d84b95c4d8d73fed7",
      "73535d9286a092a3f7b2d96c22a8ef6a0f935b975d09006cd7e418fc867d91cd",
      "c97ba108b7c9e9aaa01bc0ac765ed962292f20514b66ec99913320d42e26eb2d",
      "99255d8f4e420dc7947a6bc5fc6acfb47d33e2acbb9b4234264bf2ac735d3437",
      "6ca9fd2eb1ad7e38d7c5676fd15e1f80dfa0fa3339064a7711e60d53a9bd5fcc",
      "097cf4dcf51d6b671e0014bda5db042fe0f61b7823d978fa71bddf7560c9baae",
    ],
  },
  {
    commit: "d3e5fe3afcdb22e91e5adbc8c9c842a2fb3b632b" as GitSha,
    "executionId": "37136320870:1:repair",
    "logDigest":
      "42a15377b48d6c450a48ec576601b2c309952bba6d14b4fb5e66bdcfaf16a382",
    "reservationIds": [
      "a5a5a4eb8def3fb0dd206be5ef2e75bdcc2650c32ed69fd82949e86864ef3dc3",
      "2728ed37da51affad5ac17c398e225e75d3cee1072cc4a767843940a37ceb67e",
      "f99343ab71054a98b8c4a9c29f9f2b19a67437147d52d7b6c366f9e145b84a17",
      "0df2dcacd998b4d6fbf3feb09ac84bab9364455286eafcab5b1b7f856add56f7",
      "448359fb26b85d331c68ea900a670be80bcd8545efab306d69530e3a440ea402",
      "7b91eca5b9a29cc65f1e212194c9b56a8e224165f42e3e6a5f7db629e89632c3",
      "d5cbbdd18a86599ac27d2f7fe17a0bd9d926b40571205a70baee3caa6bf1882e",
      "99b14f1d04d90b2406f686d11d76379cc1387766047f8bef75c1a03b36c53741",
      "40376755c0596ef299de3727841b4b1f09d48584ea7983ee28906d8ce773c1f8",
      "18c28151264422816eac473c9ba9d24146c44d73a2b35f8b399f71dc0e7a9813",
      "56c6f2b4f30243601743e10a168e64b94f2ef41b5594220a9fbe03e3d900f32a",
      "a384e381e286775a57948c62afe39b7bc2377194260b3f5256b3de8929c2345d",
      "df86a3969fcda87556c790a1657859a16518e8e60e5ab56970d6dfd3b299e418",
      "8be524c6a84d2437e409cbf1d20f41d0f2494bda32a1134010e712df7afdf22d",
      "39b9a47b246bc52d0b15eee5ffcae5f33adb1d59a4b4d22822b3f801703a1217",
      "0e5ef4a90f4a3e96c989640652cd115087d1d5b786bcf44d6f356416c145076c",
      "421ad1ffb88498aa18bc2d8bc23bded5040872000e0777f8da9a7981c4e8fc84",
    ],
  },
  {
    commit: "6f7d7807b3735d97641704d6afa5c4e659e849da" as GitSha,
    "executionId": "37156933037:1:repair",
    "logDigest":
      "9e2cd0411cf981d23d9aca67e41f10a8d7bce559c1c0280f58631450f3a16136",
    "reservationIds": [
      "05914e39fc4b2d04752f67041dfcef3b22353aecab648e9ab84b576641dcc951",
      "c574901f8e8976026d9313e620612dceb6a331b425443d3f7182f45b834e8d3b",
      "b70df1a941fbf9f21192b0925fe3d1a8b21670ece85360f3e8ebad4d4107a213",
      "39cc9b44691f9664ad7ca565ab4977b19e76435964dbbe2a5a2a59a618f8c2ca",
      "b7e2233c8ba405373805dadef6403ec8d24a0da5b6442153d33d427b5763930d",
      "b7275d76529d103fe7da3e7a2fcb3b8e6e444c3b2107e1f4b1d8a0ccd65babc1",
      "6a86c8363fefd915b575ce2a21b737c0cf4dd48651d1e3e5a38ad9c2495bc63c",
      "3903063fbf3b049a16ab323283932d3758f624595193633de6dd2528560b2bc4",
      "be97f92573f794189512e8cffef4e6fb1277abb9d32da8dd3ddada5c4d3f84ec",
      "0ca007a49aa57177fe054e16a8c76b6f9d20919feb0edde79638eeb63b0339a1",
      "4977b245da20cd0741801efeb29ab1ce399797e55dbf5e896eb1dc3097e3dd7c",
      "d36b9d8e05ce00f3d696daba691b442ba84df3db7294bc9138e79e690235c956",
      "3c8d01b2842eb6c085351099835c120f47dd533d1e96841e59986f038cf6b215",
      "f55ec1fc902224ab8e70f085778620525febdae37f3fd334e2a2c41ff30589f1",
      "6d2d0f1b6f462bb134774a46c1642529cc350477f3f8146cba135070399e21a2",
      "fb5dc155319f94be9d273044c1b3bf1be031b18fc73211803b20811919c815fc",
      "1333409255344a59b15eff709136f80f0c78a63a5695b7c60a7b2d2323854558",
      "fb6ffebb981f6f2b815adc0644b867db67886ab1d103542c61391321a75d95e2",
      "feec7f11741630755a8df4640f80ed1999bd43d4bd01425ede1d44a32cfb3e9e",
      "9ace0199e2d63e597a400357b74a40d12123dbe5837aa57be5885ae276c68b86",
      "1e59655194095dc16a9193105b57c1e7c68528f286f6f8e79f6e537fb729551a",
      "5c1b2a234ec5bd050b17bc7a6cb525ed0dc2534e25bc6b7d01a3952e53fd0f36",
      "8aa6c1cf368a45c0f0e9f3eab962109a8cc9bb8f002d912adb0c19b85e323549",
      "b693cb12d961d68bc90e2f0bd36aec9a1822b50135fc69df4c0ce04858445290",
      "d2d7ae3b0540e7348c75a70ee1d4b9eb058df17690a3752e3b5eb5bf078d263b",
    ],
  },
  {
    commit: "1a706850cf981273a98521c4b1222a765b9c90ed" as GitSha,
    "executionId": "37160285420:1:repair",
    "logDigest":
      "3a03c95cbc4a10faa78f90cc61444911bddd7ef2f35eb4dadd1daff85ef3cb5a",
    "reservationIds": [
      "537ab0051c0d8b1b20002cc45e40b198a96cde83bff3ad1dbe8fa918be06197f",
      "9bd37b5aa6fe58fc8348699ef437cc08f2b73c115488dcfbb217460dbd4d606b",
      "83bd09f94fe5895264eb91e972b754e287503c637f3d1a1d0a0c7e1fe6daf793",
      "b9b116ae25fcf76903209a6bcfc40237c092406d9948448398195b8dacf0052b",
      "f2f5ace0a637da758688b40c25b953caa57db5db0aa9bdabf339a1953280f08c",
      "d3e308bab83964b714ad94ae4ea4b361b2d0fcd406ebeba71cb87c0182bbe787",
      "c89f4a3377ef1c8b2062a0a98599fe9d5f23a44f0b31dcf8367a4d1a0fe74061",
      "5b3f11483b67d4c3ff407f14ae43ba1c0e1071e32a7beea9db34acbb02828a91",
      "a2aae7ba3e7e121598ba70fe8a8a5b30f1598efc887b590e6ed9be582a889088",
      "1ac673010b05e5217222c0e57adeccad1db6f75bf60b2d1bc81f240043fa6263",
      "43be66f33a484a7d0653cd151fb9f5a3a620cbaad6182fa06a319999306c1c2f",
      "74bb67bf09a54e1544ba910379a5ac4a31e1faa99a322585209ab0b240e1fff6",
      "95027b082bcd340e05422cabcb81632908e7a40bb20c51667525716005bea252",
    ],
  },
] as const;

/** Existing native token and read-only artifact route; no release writer or model. */
export function createHostedHistoricalMatrixQuarantine(input: {
  state: StateReadView & RepairStateWriter;
  clock: { now(): number };
  token: string;
  artifactRoot: string;
  http?: HttpTransportV1;
  artifactHttp?: HttpTransportV1;
  cooldownMode?: string;
  /**
   * Explicit authenticated not-started revalidation of already-quarantined
   * records. Defaults to false so every existing caller keeps the original
   * closed quarantine pass; the trusted production maintenance route enables
   * it explicitly.
   */
  revalidateNotStarted?: boolean;
  historicalReleaseWitnesses?: readonly {
    commit: GitSha;
    executionId: string;
    logDigest: string;
    reservationIds: readonly string[];
  }[];
}): HistoricalMatrixQuarantineDepsV1 {
  const witnesses = input.historicalReleaseWitnesses ??
    HOSTED_HISTORICAL_RELEASE_WITNESSES;
  const client = new GitHubApiClient({
    repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
    apiBaseUrl: "https://api.github.com",
    http: input.http ?? fetchHttpTransport(),
    clock: input.clock,
    auth: {
      authorizationHeader: () =>
        Promise.resolve(portOk(`Bearer ${input.token}`)),
    },
    cooldownGate: new HostedRepairCooldownGate({
      state: input.state,
      clock: input.clock,
      mode: parseCooldownModeV1(input.cooldownMode),
    }),
  });
  return {
    state: input.state,
    clock: input.clock,
    revalidateNotStarted: input.revalidateNotStarted === true,
    budget: new RollingStartBudget({
      state: input.state,
      clock: input.clock,
      configs: [],
    }),
    readExecution: (execution) => client.readHostedExecution(execution),
    historicalReleaseWitnesses: witnesses.map((witness) => ({
      ...witness,
      reject: (proof, expectedHead, _revalidateNotStarted, deadline) => {
        const historicalState: StateReadView = {
          readRepair: () => input.state.readRepair(),
          readRelease: () =>
            input.state.readReleaseAt
              ? input.state.readReleaseAt({
                commit: witness.commit,
                expectedHead,
              })
              : Promise.resolve(
                portError(
                  "unavailable",
                  "historical release reader unavailable",
                ),
              ),
        };
        return createActionsMatrixArtifactTransport({
          state: historicalState,
          clock: input.clock,
          token: input.token,
          artifactRoot: input.artifactRoot,
          http: input.artifactHttp ??
            createActionsMatrixArtifactHttpTransport(),
        }).rejectHistorical!({
          proof,
          revalidateNotStarted: input.revalidateNotStarted === true,
          ...(deadline === undefined ? {} : { deadline }),
        });
      },
    })),
    transport: createActionsMatrixArtifactTransport({
      state: input.state,
      clock: input.clock,
      token: input.token,
      artifactRoot: input.artifactRoot,
      http: input.artifactHttp ?? createActionsMatrixArtifactHttpTransport(),
    }),
  };
}

function skipped(
  reason: HostedAutonomyReasonV1,
  beforeHead: string | null,
  actions: readonly string[] = [],
): HostedAutonomyResultV1 {
  return {
    kind: "hosted_autonomy",
    status: "skipped",
    reason,
    beforeHead,
    appliedHead: null,
    actions,
    revisions: [],
  };
}

function failed(
  reason: HostedAutonomyReasonV1,
  beforeHead: string | null,
  actions: readonly string[] = [],
): HostedAutonomyResultV1 {
  return { ...skipped(reason, beforeHead, actions), status: "failed" };
}

async function readRepairSafely(
  state: StateReadView,
): Promise<
  PortResultV1<
    { status: "found"; head: string; snapshot: RepairStateSnapshotV1 } | {
      status: "missing";
    }
  > | null
> {
  try {
    return await state.readRepair() as PortResultV1<
      { status: "found"; head: string; snapshot: RepairStateSnapshotV1 } | {
        status: "missing";
      }
    >;
  } catch {
    return null;
  }
}

async function readReleaseSafely(
  state: StateReadView,
): Promise<
  PortResultV1<
    { status: "found"; head: string; snapshot: ReleaseStateSnapshotV1 } | {
      status: "missing";
    }
  > | null
> {
  try {
    return await state.readRelease() as PortResultV1<
      { status: "found"; head: string; snapshot: ReleaseStateSnapshotV1 } | {
        status: "missing";
      }
    >;
  } catch {
    return null;
  }
}

/**
 * Durable reservations charged to one task, across every purpose and outcome
 * (including one still `reserved`). This is the automatic-retry bound's unit:
 * this pass no longer increments the preserved `retries` counter, and a
 * reservation is the charge the runtime always persists before a model start,
 * so the bound cannot be reset or evaded by an uncharged retry cycle.
 */
function taskReservationCount(
  snapshot: RepairStateSnapshotV1,
  taskId: string,
): number {
  let count = 0;
  for (const reservation of snapshot.reservations) {
    if (reservation.taskId === taskId) count++;
  }
  return count;
}

/** Attempt numbers already occupied at one base for one purpose. */
function usedAttempts(
  snapshot: RepairStateSnapshotV1,
  taskId: string,
  base: string,
  purpose: string,
): Set<number> {
  const used = new Set<number>();
  for (const reservation of snapshot.reservations) {
    if (reservation.taskId !== taskId) continue;
    if (reservation.head !== base) continue;
    if (reservation.purpose !== purpose) continue;
    // The runtime refuses a duplicate (repository, task, base, attempt,
    // purpose) identity instead of starting a second session, so a reserved
    // implementation/retry identity is already occupied and must never be
    // planned again. A reserved review_request is the one exception: the
    // review step reconciles that pending request through its own existing
    // semantics, so it stays eligible here exactly as before.
    if (reservation.outcome === "reserved" && purpose === "review_request") {
      continue;
    }
    used.add(reservation.attempt);
  }
  return used;
}

/** The runtime's own settled-intent safety rule for a blocked record. */
function intentClosable(
  record: RepairStateSnapshotV1["work"][number],
  reservations: RepairStateSnapshotV1["reservations"],
): boolean {
  if (record.intent === null) return true;
  const requestId = record.intent.requestId;
  if (requestId === null || requestId === "") return false;
  if (record.intent.kind === "implementation") {
    return reservations.some((reservation) =>
      reservation.id === requestId && reservation.outcome !== "reserved"
    );
  }
  // A review intent may be cleared only when BOTH sides of its identity are
  // proven: the intent itself must be bound to the record's exact current
  // publication (same head, PR, deterministic candidate branch and the non-null
  // base that publication was reviewed against), and the settled reservation
  // must be the exact review charge of the round the intent's canonical
  // operation key names. A still-`reserved`, unknown or mismatched reservation
  // — or a stale intent for another publication, key, round or base — leaves
  // everything protected for the runtime's own reconciliation.
  if (record.intent.kind !== "review_request") return false;
  const intent = record.intent;
  const head = record.target.head;
  const pullRequest = record.target.pr;
  if (head === null || pullRequest === null) return false;
  if (intent.expectedHead !== head) return false;
  if (intent.pr !== pullRequest) return false;
  if (intent.branch !== candidateBranch(record.id)) return false;
  if (record.target.branch !== intent.branch) return false;
  // A review admission binds the head, not the base, so the base the intent
  // itself observed is the only proof this charge belongs to the record's
  // current publication; a null record base or a moved intent base refuses.
  const base = record.target.base;
  if (base === null) return false;
  if (intent.observedBase !== base) return false;
  return reservations.some((reservation) =>
    reservation.id === requestId &&
    reservation.outcome !== "reserved" &&
    reservation.taskId === record.id &&
    reservation.purpose === "review_request" &&
    reservation.head === head &&
    sameRepository(reservation.repository, record.repository) &&
    intent.key === reviewOperationKey(pullRequest, head, reservation.attempt)
  );
}

/**
 * Review identities already charged and SETTLED at one record's current
 * candidate head. The runtime's review identity is (repository, task, head,
 * attempt, purpose), and a duplicate of a settled identity is the terminal
 * "review admission already settled without an intent" contradiction, so these
 * attempts are occupied and must never be planned again. A reservation still
 * `reserved` is an in-flight admission the review step reconciles through its
 * own semantics, so it stays out of this set exactly as it does for the
 * attempt identities above.
 */
function settledReviewAttempts(
  snapshot: RepairStateSnapshotV1,
  record: RepairStateSnapshotV1["work"][number],
): Set<number> {
  const settled = new Set<number>();
  const head = record.target.head;
  if (head === null) return settled;
  for (const reservation of snapshot.reservations) {
    if (reservation.taskId !== record.id) continue;
    if (reservation.purpose !== "review_request") continue;
    if (reservation.head !== head) continue;
    if (reservation.outcome === "reserved") continue;
    if (!sameRepository(reservation.repository, record.repository)) continue;
    settled.add(reservation.attempt);
  }
  return settled;
}

/**
 * The review-round counter a review-returning grant must persist: the record's
 * current counter raised to the first review identity at its current head that
 * no settled admission occupies. A charged counter is history and is only ever
 * raised — never zeroed, never lowered and never reused, so the next admission
 * the runtime charges is an identity nothing has charged yet.
 */
function plannedReviewRounds(
  record: RepairStateSnapshotV1["work"][number],
  settled: ReadonlySet<number>,
): number {
  let rounds = record.counters.reviewRounds;
  for (const attempt of settled) {
    if (attempt > rounds) rounds = attempt;
  }
  while (settled.has(rounds + 1)) rounds++;
  return rounds;
}

export interface RetryPlanV1 {
  id: string;
  /** The exact repository scope this plan belongs to. */
  repository: RepositoryIdentityV1;
  grant: number;
  nextStep: "work" | "review";
  /**
   * The exact review-round counter a review-returning plan persists, or null
   * when the counter is preserved. It is the computed floor — the highest
   * settled `review_request` attempt at the record's current head raised past
   * every occupied identity — and never below the record's current value: a
   * charged counter is history, so it is never zeroed or lowered. Work plans
   * carry null.
   */
  reviewRounds: number | null;
  /**
   * True when every identity at the record's CURRENT base is already
   * charged, so the only way to admit another attempt is the runtime's own
   * deterministic base refresh: the plan persists that intent and the loop
   * republishes the candidate on the newest base, which gives fresh
   * reservation identities. A review-returning plan advances the base for the
   * same reason once every review identity inside the runtime's own round
   * allowance is spent at the current head.
   */
  advanceBase: boolean;
  /** Exact base observed for an advancing plan. */
  observedBase: string | null;
  detail: string;
}

/**
 * Bounded, closed retry planning for one snapshot. Every returned plan has an
 * unused next-attempt identity, respects every attempt ceiling and stays inside
 * the per-task automatic-retry budget.
 *
 * `baseTips` is keyed by `hostedRepositoryKey`: each record is planned against
 * its OWN repository's base tip, so a foreign repository can never advance a
 * sentinel record's base or vice versa. `closedIssues` holds
 * `hostedIssueKey` values, so two repositories may both carry issue 120.
 */
/**
 * One blocked record whose equivalent-retry grant was refused by durable
 * attempt memory. Reported by the caller; never a silent no-op.
 */
export interface RetryDenialV1 {
  id: string;
  repository: RepositoryIdentityV1;
  reason: string;
}

export function planHostedRetries(
  snapshot: RepairStateSnapshotV1,
  now: number,
  baseTips: ReadonlyMap<string, string | null> = new Map(),
  closedIssues: ReadonlySet<string> = new Set(),
  onDenied?: (denial: RetryDenialV1) => void,
): RetryPlanV1[] {
  const plans: RetryPlanV1[] = [];
  for (const record of snapshot.work) {
    if (record.nextStep !== "blocked") continue;
    // These original failed C63 admissions remain charged and closed; the
    // historical recovery never grants a retry for their retained intent.
    if (
      HISTORICAL_C63.rows.some((row) =>
        row.id === record.id && record.intent?.kind === "implementation" &&
        record.intent.key === implementationIntentKey(row.reservation) &&
        record.intent.requestId === row.reservation &&
        snapshot.reservations.some((charge) =>
          charge.id === row.reservation && charge.outcome === "ambiguous" &&
          charge.settledAt !== null
        )
      )
    ) continue;
    // A task whose source issue is closed or gone is not repairable: retrying
    // it can only spend a model session on work that no longer exists. The
    // identity is the pair (repository, issue number): a closed issue in
    // another repository never stops this record's retry.
    if (
      record.related.issueNumber !== null &&
      closedIssues.has(
        hostedIssueKey(record.repository, record.related.issueNumber),
      )
    ) {
      continue;
    }
    const blocker = record.blocker;
    if (blocker === null) continue;
    if (
      taskReservationCount(snapshot, record.id) >= HOSTED_AUTONOMY_MAX_RETRIES
    ) {
      continue;
    }
    if (!Number.isSafeInteger(now)) continue;
    const rule = HOSTED_AUTONOMY_RETRYABLE.find((item) =>
      blocker.message.startsWith(item.prefix)
    );
    if (rule === undefined) continue;
    if (!intentClosable(record, snapshot.reservations)) continue;
    // A work-returning grant only exists to buy another implementation run.
    // Once every review round is spent, that run cannot become a reviewed
    // verdict, so the grant is provably futile and is never planned: the
    // delivery pass owns the record's receipt instead. A review-returning
    // grant is untouched by this gate.
    if (
      rule.nextStep === "work" &&
      record.counters.reviewRounds >= HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS
    ) {
      continue;
    }
    const base = record.target.base;
    if (base === null) continue;
    const baseTip = baseTips.get(hostedRepositoryKey(record.repository)) ??
      null;
    // Durable attempt memory gate: refuse a work-returning grant whose
    // attempt would be equivalent to failures already recorded at this base
    // and runtime revision. A base advance is genuinely changed evidence, so
    // that path is exempt; a review-returning grant has its own identity
    // space and is untouched. Refusals are reported, never silent.
    if (rule.nextStep === "work") {
      const advancing = baseTip !== null && baseTip !== base;
      if (!advancing) {
        const equivalence = attemptEquivalenceRefusalForRecordV1({
          record,
          snapshot,
          now,
        });
        if (equivalence.refuse) {
          onDenied?.({
            id: record.id,
            repository: record.repository,
            reason: `equivalent_attempt_refused:${
              equivalence.entry?.detail ?? "unknown"
            }`,
          });
          continue;
        }
      }
    }
    // A review-returning grant has its OWN identity space: the runtime admits
    // a review with attempt = reviewRounds + 1 at the record's current head, so
    // the grant must persist the floor its durable charges prove. While the
    // runtime's round allowance remains, that floor is an identity nothing has
    // charged; once the allowance is spent at this head, only the runtime's own
    // base refresh (a new head, therefore a new identity) can continue the
    // task, and without a newer base this pass fails closed rather than
    // re-using a charged identity or zeroing a charged counter.
    if (rule.nextStep === "review") {
      const head = record.target.head;
      const pr = record.target.pr;
      const branch = record.target.branch;
      // A review can only continue on the record's exact published identity:
      // without it there is nothing the runtime could rehydrate or review, so
      // nothing is planned rather than clearing the blocker into a state error.
      if (head === null || pr === null || branch === null) continue;
      const settled = settledReviewAttempts(snapshot, record);
      const rounds = plannedReviewRounds(record, settled);
      if (rounds >= HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS) {
        if (baseTip === null || baseTip === base) continue;
        plans.push({
          id: record.id,
          repository: record.repository,
          grant: 0,
          nextStep: "review",
          reviewRounds: rounds,
          advanceBase: true,
          observedBase: baseTip,
          detail: `${blocker.kind}:${rule.prefix}:base-advance`,
        });
        continue;
      }
      plans.push({
        id: record.id,
        repository: record.repository,
        grant: 0,
        nextStep: "review",
        reviewRounds: rounds,
        advanceBase: false,
        observedBase: null,
        detail: `${blocker.kind}:${rule.prefix}`,
      });
      continue;
    }
    const attempts = record.counters.attempts;
    let grant: number | null = null;
    for (
      let candidate = 0;
      candidate <= 3 && candidate <= attempts;
      candidate++
    ) {
      const remaining = attempts - candidate;
      // No work-returning grant may land at or above the runtime's own
      // implementation ceiling: admission there is refused outright, so such a
      // grant would only re-block the record instead of buying a run.
      if (remaining >= HOSTED_AUTONOMY_MAX_IMPLEMENTATION_ATTEMPTS) {
        continue;
      }
      // The identity the runtime will charge is fixed by the counters AFTER
      // this grant: the loop admits corrections with purpose `retry`, and only
      // a zero-attempt record is admitted as `implementation`.
      const purpose = remaining === 0 ? "implementation" : "retry";
      if (
        usedAttempts(snapshot, record.id, base, purpose).has(remaining + 1)
      ) {
        continue;
      }
      // The frozen record invariant is `retries <= attempts`, and this pass
      // only lowers attempts (the preserved `retries` counter is history), so a
      // grant is valid only while it does not cut attempts below retries.
      if (record.counters.retries > remaining) continue;
      grant = candidate;
      break;
    }
    if (grant === null) {
      // Every attempt number at this base is charged. The runtime's own base
      // refresh is what gives an unused identity.
      const pr = record.target.pr;
      const head = record.target.head;
      const branch = record.target.branch;
      if (
        pr === null || head === null ||
        branch === null || baseTip === null || baseTip === base
      ) {
        continue;
      }
      const ceilingGrant = attempts -
        (HOSTED_AUTONOMY_MAX_IMPLEMENTATION_ATTEMPTS - 1);
      if (ceilingGrant < 0 || ceilingGrant > 3) continue;
      if (
        attempts - ceilingGrant >= HOSTED_AUTONOMY_MAX_IMPLEMENTATION_ATTEMPTS
      ) {
        continue;
      }
      // Same invariant: the grant lowers attempts, so the preserved retries
      // counter must still fit under the lowered ceiling.
      if (record.counters.retries > attempts - ceilingGrant) continue;
      plans.push({
        id: record.id,
        repository: record.repository,
        grant: ceilingGrant,
        nextStep: "work",
        reviewRounds: null,
        advanceBase: true,
        observedBase: baseTip,
        detail: `${blocker.kind}:${rule.prefix}:base-advance`,
      });
      continue;
    }
    plans.push({
      id: record.id,
      repository: record.repository,
      grant,
      nextStep: "work",
      reviewRounds: null,
      advanceBase: false,
      observedBase: null,
      detail: `${blocker.kind}:${rule.prefix}`,
    });
  }
  return plans;
}

/** Apply the retry plans to one snapshot (pure). */
export function applyHostedRetries(
  snapshot: RepairStateSnapshotV1,
  head: GitSha,
  plans: readonly RetryPlanV1[],
  now: number,
): RepairStateSnapshotV1 {
  const byId = new Map(plans.map((plan) => [plan.id, plan]));
  return parseRepairStateSnapshotV1({
    ...snapshot,
    stateHead: head,
    sequence: snapshot.sequence + 1,
    updatedAt: now,
    work: snapshot.work.map((record) => {
      const plan = byId.get(record.id);
      if (plan === undefined) return record;
      const refresh = plan.advanceBase && plan.observedBase !== null &&
          record.target.pr !== null && record.target.head !== null &&
          record.target.branch !== null
        ? {
          kind: "base_refresh" as const,
          key:
            `base_refresh:${record.target.pr}:${record.target.head}:${plan.observedBase}`,
          startedAt: now,
          branch: record.target.branch,
          expectedHead: record.target.head,
          observedBase: plan.observedBase,
          pr: record.target.pr,
          requestId: null,
          resultId: null,
        }
        : null;
      return {
        ...record,
        nextStep: plan.nextStep,
        wait: null,
        blocker: null,
        intent: refresh,
        counters: {
          // Only the attempt ceiling moves: the grant buys an unused identity
          // by lowering attempts, while the preserved `retries` counter (and
          // every other counter) stays exactly as it was. A review-returning
          // plan carries its computed floor, which is only ever at or above the
          // current counter — never a reset.
          attempts: record.counters.attempts - plan.grant,
          retries: record.counters.retries,
          reviewRounds: plan.reviewRounds ?? record.counters.reviewRounds,
        },
        updatedAt: now,
      };
    }),
  });
}

/**
 * The runtime's exact diagnosis that the managed candidate branch ref matched
 * neither the saved candidate head nor the head that record had published. It
 * is the ONLY blocker this maintenance pass revalidates, and it is cleared only
 * against the record's own repository, task and producing operation.
 */
const CANDIDATE_REF_IDENTITY_MISMATCH =
  "candidate branch ref identity mismatch";

/** The exact identity one record must prove before its blocker is cleared. */
interface CandidateRefRevalidationV1 {
  readonly id: string;
  readonly repository: RepositoryIdentityV1;
  readonly branch: string;
  readonly head: GitSha;
}

/**
 * The exact blocked shape this maintenance pass may revalidate: the runtime's
 * recorded candidate-ref identity mismatch, on a record whose saved candidate
 * descriptor, published head and canonical preservation ref all bind to the
 * record's OWN repository, task and producing operation, and whose branch is
 * the deterministic managed candidate branch of that same task. Anything else
 * — a different blocker, a foreign or mismatched branch, a missing or
 * incoherent descriptor, an incompatible wait — is refused here and left
 * untouched, with no remote read at all. The caller still has to observe the
 * branch's exact live head before anything is written.
 */
async function candidateRefRevalidation(
  record: HostedAutonomyRecordV1,
): Promise<CandidateRefRevalidationV1 | null> {
  if (record.nextStep !== "blocked" || record.wait !== null) return null;
  const blocker = record.blocker;
  if (
    blocker === null || blocker.kind !== "other" ||
    blocker.message !== CANDIDATE_REF_IDENTITY_MISMATCH
  ) {
    return null;
  }
  const head = record.target.head;
  const branch = record.target.branch;
  const candidateState = record.target.candidateState;
  if (head === null || branch === null || candidateState === undefined) {
    return null;
  }
  // The managed branch is derived from the task identity: a record pointing at
  // any other branch is not this record's candidate and is never revalidated.
  if (branch !== candidateBranch(record.id)) return null;
  const preserved = candidateState.preserved;
  if (preserved === null) return null;
  // The saved descriptor, the published head and the target must agree on the
  // exact same candidate identity before the live ref is even consulted.
  if (preserved.head !== head || preserved.base !== record.target.base) {
    return null;
  }
  if (candidateState.publishedHead !== head) return null;
  if (
    preserved.ref !== await candidatePreservationRef(
      record.repository,
      record.id,
      preserved.operationKey,
    )
  ) {
    return null;
  }
  return { id: record.id, repository: record.repository, branch, head };
}

/**
 * The exact repository/task identity one candidate-ref revalidation binds. The
 * repository part is the record's own identity, never another repository's.
 */
function candidateRefKey(record: {
  readonly id: string;
  readonly repository: RepositoryIdentityV1;
}): string {
  return `${hostedRepositoryKey(record.repository)}\u0000${record.id}`;
}

/**
 * The pure transition: exactly these records return to `work` with ONLY the
 * diagnosed blocker cleared. The intent (null or non-null), wait, target,
 * counters, evidence and every other durable field are preserved byte for
 * byte; only the records' `updatedAt` and the snapshot's head and sequence
 * move, exactly as every other maintenance write does.
 */
function applyCandidateRefRevalidations(
  snapshot: RepairStateSnapshotV1,
  head: GitSha,
  records: readonly CandidateRefRevalidationV1[],
  now: number,
): RepairStateSnapshotV1 {
  const selected = new Set(records.map(candidateRefKey));
  return parseRepairStateSnapshotV1({
    ...snapshot,
    stateHead: head,
    sequence: snapshot.sequence + 1,
    updatedAt: now,
    work: snapshot.work.map((record) =>
      selected.has(candidateRefKey(record))
        ? { ...record, nextStep: "work", blocker: null, updatedAt: now }
        : record
    ),
  });
}

/**
 * Every completed receipt this record's delivery identity binds: same
 * repository, pull request, reviewed head and observed base, a result and
 * completion instant, and a reviewer-bound identity with zero uncounted
 * findings and no unresolved P0/P1. This is the identity pre-filter only; it
 * NEVER authorizes a delivery. `authorizingReceipt` applies the shared semantic
 * predicate to these candidates.
 */
function boundReviewReceipts(
  snapshot: RepairStateSnapshotV1,
  record: HostedAutonomyRecordV1,
): ReviewReceiptV1[] {
  const pullRequest = record.target.pr;
  const head = record.target.head;
  const base = record.target.base;
  if (pullRequest === null || head === null || base === null) return [];
  const repository = record.repository;
  return snapshot.reviews.filter((review) =>
    review.repository.owner === repository.owner &&
    review.repository.name === repository.name &&
    review.repository.installationId === repository.installationId &&
    review.pullRequest.number === pullRequest &&
    review.pullRequest.head === head &&
    review.pullRequest.base === base &&
    review.outcome === "completed" &&
    review.resultId !== null &&
    review.completedAt !== null &&
    review.observedReviewer !== null &&
    review.observedReviewer === review.expectedReviewer &&
    review.findingsUncounted === 0 &&
    !review.unresolvedSeverities.some((s) => s === "P0" || s === "P1")
  );
}

/**
 * The ONE authorization for an issue-delivery action: the shared predicate from
 * `src/repair/review-gate.ts` over the exact existing receipt and WorkRecord,
 * with the TRUSTED live source-issue statement independently read immediately
 * before the merge/release/closure, AND the fixed GitHub App reviewer identity
 * pinned by the contract's own reviewer field. A legacy quality-only receipt, a
 * receipt bound to another issue or to changed issue text, a not-fulfilled/
 * uncertain verdict, an already-satisfied base, an alternate self-consistent
 * reviewer identity and an unreadable task context all refuse.
 */
function authorizingReceipt(
  snapshot: RepairStateSnapshotV1,
  record: HostedAutonomyRecordV1,
  task: ReviewTaskStatementV1 | null | "unavailable",
): ReviewReceiptV1 | null {
  const candidates = boundReviewReceipts(snapshot, record);
  return candidates.find((candidate) =>
    reviewAuthorizesMerge(
      candidate,
      record,
      HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
      task,
    )
  ) ?? null;
}

/**
 * The trusted source-issue statement for one record, read over that record's
 * OWN repository surface. A record without a source issue keeps the existing
 * change-only contract (null); an unreadable, throwing or absent read is
 * `"unavailable"`, which never authorizes issue-backed delivery.
 */
async function readTrustedTask(
  surface: HostedAutonomyGitHubV1 | null,
  record: HostedAutonomyRecordV1,
): Promise<ReviewTaskStatementV1 | null | "unavailable"> {
  const issueNumber = record.related.issueNumber;
  if (issueNumber === null) return null;
  const read = surface?.readIssueTask;
  if (surface === null || read === undefined) return "unavailable";
  try {
    const task = await read.call(surface, issueNumber);
    return task ?? "unavailable";
  } catch {
    return "unavailable";
  }
}

/** Recover only the PR erased by the merged/base-refresh disposition. */
async function historicalMergedPublication(
  snapshot: RepairStateSnapshotV1,
  record: HostedAutonomyRecordV1,
): Promise<HostedAutonomyRecordV1 | null> {
  const head = record.target.head;
  const base = record.target.base;
  const preserved = record.target.candidateState?.preserved;
  if (
    isHostedSelf(record.repository) || record.nextStep !== "blocked" ||
    record.blocker?.kind !== "other" ||
    record.blocker.message !== RETIRED_MERGED_MESSAGE ||
    record.target.pr !== null || record.source.kind !== "issue" ||
    record.related.issueNumber === null ||
    record.source.id !== String(record.related.issueNumber) ||
    head === null || base === null || preserved == null ||
    record.target.branch !== candidateBranch(record.id) ||
    preserved.head !== head || preserved.base !== base ||
    record.target.candidateState?.publishedHead !== head ||
    !intentClosable(record, snapshot.reservations)
  ) return null;
  if (
    preserved.ref !== await candidatePreservationRef(
      record.repository,
      record.id,
      preserved.operationKey,
    )
  ) return null;
  const numbers = new Set(
    snapshot.reviews.filter((review) =>
      sameRepository(review.repository, record.repository) &&
      review.pullRequest.head === head && review.pullRequest.base === base &&
      review.taskAcceptance?.issueNumber === record.related.issueNumber &&
      record.evidence.some((evidence) =>
        evidence.kind === "review_receipt" &&
        evidence.ref === `artifact:review-receipt/${review.id}`
      )
    ).map((review) => review.pullRequest.number),
  );
  if (numbers.size !== 1) return null;
  return { ...record, target: { ...record.target, pr: [...numbers][0] } };
}

/** Verified merge facts: the exact revision a foreign record delivered. */
interface HostedMergedDeliveryV1 {
  readonly revision: string;
}

/**
 * The exact merged-delivery evidence a FOREIGN record's closure requires: the
 * pull is merged under a named merge commit, it is authored by a trusted
 * identity, it targets the record's own base branch, that commit has exactly
 * two parents equal to the recorded base and head, and the revision is
 * integrated into the recorded base branch. Any missing, unreadable or
 * mismatched fact yields null: an ambiguous merge is never evidence.
 */
function verifiedMergedDelivery(
  record: HostedAutonomyRecordV1,
  pull: HostedAutonomyPullV1,
  baseBranch: string | null,
): HostedMergedDeliveryV1 | null {
  const head = record.target.head;
  const base = record.target.base;
  if (head === null || base === null || baseBranch === null) return null;
  if (pull.merged !== true || pull.mergeCommitSha === null) return null;
  if (pull.headSha !== head) return null;
  if (
    typeof pull.author !== "string" ||
    !HOSTED_AUTONOMY_TRUSTED_AUTHORS.includes(pull.author)
  ) {
    return null;
  }
  if (pull.baseRef !== baseBranch) return null;
  if (
    pull.parents.length !== 2 ||
    !pull.parents.includes(base) || !pull.parents.includes(head)
  ) {
    return null;
  }
  if (!pull.revisionOnBaseBranch) return null;
  return { revision: pull.mergeCommitSha };
}

/** The exact request the loop's delivery step would have written. */
export async function buildHostedReleaseRequest(
  repository: ReleaseRequestV1["target"]["repository"],
  revision: string,
  head: string,
  base: string,
  pullRequest: number,
  receipt: ReviewReceiptV1,
  now: number,
): Promise<ReleaseRequestV1 | null> {
  try {
    return parseReleaseRequestV1({
      version: "v1",
      kind: "release_request",
      id: await releaseRequestId(repository, revision as GitSha, pullRequest),
      target: { repository, environment: "production" },
      revision,
      source: {
        pullRequest,
        reviewRequestId: receipt.requestId,
        reviewReceiptId: receipt.id,
        head,
        base,
      },
      status: "open",
      failureReason: null,
      createdAt: now,
    });
  } catch {
    return null;
  }
}

/**
 * Hosted releases that are accepted, keyed by the exact repository, pull
 * request, head and base they delivered. The repository scope is part of the
 * key, so an accepted release for one repository can never retire another
 * repository's record.
 */
function acceptedReleases(
  releases: readonly {
    readonly phase: string;
    readonly request: ReleaseRequestV1;
    readonly candidateProof: unknown;
  }[],
): Map<string, unknown> {
  const accepted = new Map<string, unknown>();
  for (const release of releases) {
    if (release.phase !== "accepted") continue;
    if (release.candidateProof === null) continue;
    accepted.set(
      hostedDeliveryKey(
        release.request.target.repository,
        release.request.source.pullRequest,
        release.request.source.head,
        release.request.source.base,
      ),
      release,
    );
  }
  return accepted;
}

/** One closure candidate: the record and its exact repository-scoped issue. */
export interface HostedClosurePlanV1 {
  id: string;
  issueNumber: number;
  repository: RepositoryIdentityV1;
}

/**
 * Records whose exact pull request and reviewed head are delivered, whose issue
 * is still open and whose implementation intent (when present) is provably
 * settled. These are the tasks the runtime's own closure step would finish;
 * marking them done here is the same conclusion from the same evidence, never
 * an earlier one.
 *
 * The two delivery authorities are deliberately separate and repository-bound.
 * A SELF record is closed only by an ACCEPTED hosted release: the trusted
 * release path is bound to the self scope by design, and no other evidence may
 * stand in for it. A FOREIGN record is closed only by `foreignMerged`, the
 * verified merge evidence its own repository surface produced, because the
 * sentinel release authority can never authorize a foreign repository.
 */
export function planHostedClosures(
  snapshot: RepairStateSnapshotV1,
  released: ReadonlyMap<string, unknown>,
  foreignMerged: ReadonlyMap<string, unknown> = new Map(),
  tasks: ReadonlyMap<
    string,
    ReviewTaskStatementV1 | null | "unavailable"
  > = new Map(),
): HostedClosurePlanV1[] {
  const plans: HostedClosurePlanV1[] = [];
  for (const record of snapshot.work) {
    if (record.nextStep === "done") continue;
    const issueNumber = record.related.issueNumber;
    if (issueNumber === null) continue;
    const pullRequest = record.target.pr;
    const head = record.target.head;
    const base = record.target.base;
    if (pullRequest === null || head === null || base === null) continue;
    const key = hostedDeliveryKey(
      record.repository,
      pullRequest,
      head,
      base,
    );
    const delivered = isHostedSelf(record.repository)
      ? released.has(key)
      : foreignMerged.has(key);
    if (!delivered) continue;
    // Delivered evidence alone never closes a task: the SAME shared semantic
    // predicate that authorized the delivery must still authorize the closure
    // against the trusted live issue statement read immediately before it.
    // A legacy quality-only receipt, a drifted digest or an unreadable task
    // context leaves the issue open.
    if (
      authorizingReceipt(
        snapshot,
        record,
        tasks.get(record.id) ?? "unavailable",
      ) ===
        null
    ) continue;
    if (!intentClosable(record, snapshot.reservations)) continue;
    plans.push({ id: record.id, issueNumber, repository: record.repository });
  }
  return plans;
}

/**
 * Records whose source issue is closed or gone and which can no longer produce
 * anything: the work no longer exists, so the record is parked as blocked with
 * a static reason that the retry pass refuses to clear. A record that produced
 * nothing (no pull request) is parked from a live step only, exactly as before:
 * an already blocked record keeps its own blocker. A record with a pull request
 * still has a delivery path unless that pull request is definitively closed
 * without a merge, and that verdict is evidence from any step — an already
 * blocked record whose pull can never merge is parked with the same static
 * reason. `closedUnmerged` carries the ids whose pull request is closed without
 * a merge; an open, merged or unreadable pull is not evidence. A record with a
 * pull request and an UNSETTLED implementation intent is never retired: the
 * runtime's own uncertainty handler owns that intent, and only a settled
 * implementation intent may be cleared here. Non-implementation intents (the
 * runtime clears an unprepared `base_refresh` itself) and null intents stay
 * retirable.
 */
export function planHostedRetirements(
  snapshot: RepairStateSnapshotV1,
  closedIssues: ReadonlySet<string>,
  closedUnmerged: ReadonlySet<string> = new Set(),
): HostedClosurePlanV1[] {
  const plans: HostedClosurePlanV1[] = [];
  for (const record of snapshot.work) {
    if (record.nextStep === "done") continue;
    if (
      record.nextStep === "blocked" &&
      record.intent?.kind === "candidate_preservation" &&
      record.blocker?.kind === "other" &&
      record.blocker.message === MATRIX_PRESERVATION_UNCERTAINTY_DETAIL
    ) continue;
    const issueNumber = record.related.issueNumber;
    if (
      issueNumber === null ||
      !closedIssues.has(hostedIssueKey(record.repository, issueNumber))
    ) {
      continue;
    }
    if (record.target.pr === null) {
      // Existing behavior: only a non-blocked record that produced nothing is
      // parked; an already blocked record keeps its own blocker.
      if (record.nextStep === "blocked") continue;
      plans.push({ id: record.id, issueNumber, repository: record.repository });
      continue;
    }
    // Only a definitively closed-unmerged pull proves the task can never
    // deliver; anything else leaves the record alone.
    if (!closedUnmerged.has(record.id)) continue;
    // Retirement clears the intent, so it must never take an unsettled
    // implementation intent away from the runtime's own uncertainty handler.
    // `intentClosable` is that same settled-intent rule; it is consulted only
    // for implementation intents, so non-implementation and null intents stay
    // retirable exactly as before.
    if (
      record.intent !== null && record.intent.kind === "implementation" &&
      !intentClosable(record, snapshot.reservations)
    ) continue;
    plans.push({ id: record.id, issueNumber, repository: record.repository });
  }
  return plans;
}

/** Park the given records with the immutable retirement reason (pure). */
export function applyHostedRetirements(
  snapshot: RepairStateSnapshotV1,
  head: GitSha,
  plans: readonly { id: string; issueNumber: number }[],
  now: number,
): RepairStateSnapshotV1 {
  const ids = new Set(plans.map((plan) => plan.id));
  return parseRepairStateSnapshotV1({
    ...snapshot,
    stateHead: head,
    sequence: snapshot.sequence + 1,
    updatedAt: now,
    work: snapshot.work.map((record) =>
      ids.has(record.id)
        ? {
          ...record,
          nextStep: "blocked",
          wait: null,
          blocker: {
            kind: "other",
            message: HOSTED_AUTONOMY_RETIRED,
            since: now,
          },
          intent: null,
          updatedAt: now,
        }
        : record
    ),
  });
}

/** Mark the given records done (pure). */
export function applyHostedClosures(
  snapshot: RepairStateSnapshotV1,
  head: GitSha,
  plans: readonly { id: string; issueNumber: number }[],
  now: number,
): RepairStateSnapshotV1 {
  const ids = new Set(plans.map((plan) => plan.id));
  return parseRepairStateSnapshotV1({
    ...snapshot,
    stateHead: head,
    sequence: snapshot.sequence + 1,
    updatedAt: now,
    work: snapshot.work.map((record) =>
      ids.has(record.id)
        ? {
          ...record,
          nextStep: "done",
          wait: null,
          blocker: null,
          intent: null,
          updatedAt: now,
        }
        : record
    ),
  });
}

/**
 * One bounded autonomy pass: retries first (one CAS batch), then at most one
 * delivery action (one CAS write), then the closure of every task whose exact
 * reviewed head already has an ACCEPTED hosted release (one CAS batch). A
 * single maintenance run can therefore never write an unbounded amount of
 * state.
 */
/**
 * Bounded self-observation: read this deployment's own recent failed or
 * cancelled runs, extract ONE allowlisted signature per failed job from a
 * bounded log read, and file at most `SELF_DEFECT_MAX_ISSUES_PER_PASS`
 * deduplicated reports into the repository's own tracker. The normal repair
 * loop then works those issues like any other. Every read and write here is
 * optional: a surface without the capability is skipped with an explicit
 * action, and no failure of this pass changes any state or blocks another
 * pass.
 */
export async function runSelfObservationPass(input: {
  github: HostedAutonomyGitHubV1 | null;
  now: number;
}): Promise<string[]> {
  const actions: string[] = [];
  const surface = input.github;
  const observation = surface?.selfObservation;
  if (surface === null || observation === undefined) {
    return ["self-observation:skipped:capability_absent"];
  }
  let runs: Awaited<ReturnType<HostedSelfObservationV1["listRuns"]>> = null;
  try {
    runs = await observation.listRuns({
      sinceIso: new Date(input.now - SELF_DEFECT_WINDOW_MS).toISOString(),
      limit: 30,
    });
  } catch {
    runs = null;
  }
  if (runs === null) return ["self-observation:skipped:runs_unavailable"];
  const failed = runs
    .filter((run) =>
      SELF_DEFECT_WORKFLOWS.includes(run.name) &&
      run.conclusion !== null && run.conclusion !== "success" &&
      run.conclusion !== "skipped"
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, SELF_DEFECT_MAX_RUNS_PER_PASS);
  if (failed.length === 0) return ["self-observation:skipped:no_failed_runs"];
  const failures: (SelfFailureV1 & {
    signature: ReturnType<typeof extractSelfFailureSignature>;
  })[] = [];
  for (const run of failed) {
    let jobs: Awaited<ReturnType<HostedSelfObservationV1["listJobs"]>> = null;
    try {
      jobs = await observation.listJobs(run.id);
    } catch {
      jobs = null;
    }
    if (jobs === null) {
      actions.push(`self-observation:skipped:run=${run.id}:jobs_unavailable`);
      continue;
    }
    const job = jobs.find((entry) =>
      entry.conclusion !== null && entry.conclusion !== "success" &&
      entry.conclusion !== "skipped"
    );
    if (job === undefined) continue;
    let log: string | null = null;
    try {
      log = await observation.readJobLog({
        jobId: job.id,
        maxBytes: SELF_DEFECT_MAX_LOG_BYTES,
      });
    } catch {
      log = null;
    }
    if (log === null) {
      actions.push(
        `self-observation:skipped:run=${run.id}:log_unavailable`,
      );
      continue;
    }
    const context: SelfFailureV1 = {
      runId: run.id,
      workflow: run.name,
      job: job.name,
      conclusion: job.conclusion ?? run.conclusion ?? "unknown",
      createdAt: run.createdAt,
    };
    failures.push({
      ...context,
      signature: extractSelfFailureSignature(log, context),
    });
  }
  if (failures.length === 0) {
    return actions.length > 0
      ? actions
      : ["self-observation:skipped:no_readable_failure"];
  }
  let existing: string[] | null = null;
  try {
    existing = await observation.listOpenIssueBodies();
  } catch {
    existing = null;
  }
  if (existing === null) {
    return [...actions, "self-observation:skipped:markers_unavailable"];
  }
  const existingMarkers = existing
    .flatMap((body) => {
      const found = body.match(/<!-- sentinel:self-observation:[^>]*-->/g);
      return found ?? [];
    });
  const planned = planSelfObservations({
    failures,
    existingMarkers,
    maxIssues: SELF_DEFECT_MAX_ISSUES_PER_PASS,
  });
  for (const issue of planned) {
    let number: number | null = null;
    try {
      number = await observation.fileIssue({
        title: issue.title,
        body: issue.body,
      });
    } catch {
      number = null;
    }
    actions.push(
      number === null
        ? `self-observation:refused:${issue.key}`
        : `self-observation:filed:${number}:${issue.occurrences}x`,
    );
  }
  if (actions.length === 0) actions.push("self-observation:no_change");
  return actions;
}

/** Only these three authenticated failed cells may bypass legacy rejection. */
async function recoverHostedHistoricalC63(
  deps: HistoricalMatrixQuarantineDepsV1,
): Promise<{ ingested: number; deferred: boolean }> {
  const repair = await deps.state.readRepair();
  // Missing or temporarily unavailable repair custody defers recovery.
  if (!repair.ok || repair.value.status !== "found") {
    return { ingested: 0, deferred: true };
  }
  const before = repair.value;
  if (
    !HISTORICAL_C63.rows.some((binding) =>
      before.snapshot.work.some((row) => row.id === binding.id) ||
      before.snapshot.reservations.some((row) => row.id === binding.reservation)
    )
  ) return { ingested: 0, deferred: false };
  const captured = HISTORICAL_C63.rows.flatMap((binding) => {
    const record = before.snapshot.work.find((row) => row.id === binding.id);
    const reservation = before.snapshot.reservations.find((row) =>
      row.id === binding.reservation
    );
    // Only a row absent from BOTH repair halves is treated as already
    // removed. A half-present binding is incomplete custody and fails closed:
    // durable settlement never removes one side alone.
    if (record === undefined && reservation === undefined) return [];
    if (record === undefined || reservation === undefined) {
      throw new Error(
        "historical matrix selected reservation binding unavailable",
      );
    }
    const recoverable = record.nextStep === "work" ||
      (record.nextStep === "blocked" && reservation.outcome === "ambiguous");
    if (!recoverable) return [];
    if (
      canonicalStringify(record.repository) !==
        canonicalStringify(HISTORICAL_C63.repository) ||
      canonicalStringify(reservation.repository) !==
        canonicalStringify(record.repository) ||
      record.source.kind !== "issue" ||
      record.related.issueNumber !== binding.issue ||
      record.counters.attempts !== 2 ||
      record.target.base !== HISTORICAL_C63.base ||
      record.target.head !== null || record.target.pr !== null ||
      record.target.checkpoint !== null ||
      record.target.candidateState !== undefined ||
      record.intent?.kind !== "implementation" ||
      record.intent.requestId !== binding.reservation ||
      record.intent.key !== implementationIntentKey(binding.reservation) ||
      record.intent.observedBase !== record.target.base ||
      record.intent.expectedHead !== null || record.intent.resultId !== null ||
      reservation.taskId !== record.id ||
      reservation.head !== record.target.base || reservation.attempt !== 2 ||
      reservation.purpose !== "retry" ||
      !["reserved", "ambiguous"].includes(reservation.outcome) ||
      (reservation.outcome === "reserved"
        ? reservation.settledAt !== null
        : reservation.settledAt === null)
    ) {
      throw new Error(
        "historical matrix selected reservation binding unavailable",
      );
    }
    return [{ binding, record, reservation }];
  });
  if (captured.length === 0) return { ingested: 0, deferred: false };
  const release = await deps.state.readRelease();
  // Missing or temporarily unavailable release custody defers recovery; the
  // pass must never fail because another run holds or lacks the state.
  if (!release.ok || release.value.status !== "found") {
    return { ingested: 0, deferred: true };
  }
  const current = release.value;
  const runtime = current.snapshot.hostedRuntimes.find((row) =>
    row.id === HOSTED_RUNTIME_ID
  );
  // A missing runtime or a nonterminal release defers recovery; the next
  // maintenance pass re-runs it.
  if (
    !runtime ||
    current.snapshot.hostedReleases.some((row) =>
      !["accepted", "rolled_back", "cancelled"].includes(row.phase)
    )
  ) return { ingested: 0, deferred: true };
  if (runtime.execution !== null) {
    // An unsettled current execution defers recovery; the pass must never
    // fail because another run is still writing.
    if (
      !deps.transport.confirmCompletedExecution ||
      !await deps.transport.confirmCompletedExecution(runtime.execution)
    ) return { ingested: 0, deferred: true };
    const observed = await deps.readExecution(runtime.execution);
    if (
      !observed.ok || observed.value === null ||
      canonicalStringify(observed.value.execution) !==
        canonicalStringify(runtime.execution)
    ) throw new Error("historical matrix current native binding changed");
  }
  const witness = deps.historicalReleaseWitnesses?.find((row) =>
    row.executionId === HISTORICAL_C63.executionId &&
    HISTORICAL_C63.rows.every((binding) =>
      row.reservationIds.includes(binding.reservation)
    )
  );
  const historical = witness
    ? await deps.state.readReleaseAt?.({
      commit: witness.commit,
      expectedHead: current.head,
    })
    : null;
  if (
    witness &&
    (!historical?.ok || historical.value.status !== "found" ||
      historical.value.head !== witness.commit)
  ) return { ingested: 0, deferred: true };
  const saved = historical?.ok && historical.value.status === "found"
    ? historical.value.snapshot.hostedRuntimes.find((row) =>
      row.id === HOSTED_RUNTIME_ID
    )?.lastExecutionProof
    : runtime.lastExecutionProof;
  // A configured, readable witness must carry the exact C63 failed proof. A
  // missing or different proof inside a present witness commit is tampered or
  // mismatched history and fails closed; only genuinely absent custody defers.
  const execution = witness
    ? (saved?.execution.id === HISTORICAL_C63.executionId
      ? saved.execution
      : null)
    : saved?.execution.id === HISTORICAL_C63.executionId
    ? saved.execution
    : runtime.execution?.id === HISTORICAL_C63.executionId
    ? runtime.execution
    : null;
  if (witness && execution === null) {
    throw new Error("historical matrix release witness binding changed");
  }
  if (!execution) return { ingested: 0, deferred: true };
  if (
    execution.runId !== HISTORICAL_C63.run.runId ||
    execution.runAttempt !== HISTORICAL_C63.run.runAttempt ||
    execution.launcherSha !== HISTORICAL_C63.run.launcherSha ||
    execution.revision !== HISTORICAL_C63.runtimeSha ||
    execution.generation !== HISTORICAL_C63.generation ||
    execution.purpose !== "ordinary" || execution.releaseId !== null ||
    (witness &&
      (!saved || saved.outcome !== "failed" ||
        saved.logDigest !== witness.logDigest))
  ) throw new Error("historical matrix release witness binding changed");
  const custody = async () => {
    const fresh = await deps.state.readRelease();
    if (
      !fresh.ok || fresh.value.status !== "found" ||
      fresh.value.head !== current.head ||
      canonicalStringify(fresh.value.snapshot) !==
        canonicalStringify(current.snapshot)
    ) throw new Error("historical matrix current custody changed");
    if (witness) {
      const prior = await deps.state.readReleaseAt?.({
        commit: witness.commit,
        expectedHead: current.head,
      });
      if (
        !prior?.ok || prior.value.status !== "found" ||
        prior.value.head !== witness.commit ||
        canonicalStringify(prior.value.snapshot) !==
          canonicalStringify(
            historical?.ok && historical.value.status === "found"
              ? historical.value.snapshot
              : null,
          )
      ) throw new Error("historical matrix release witness binding changed");
    }
  };
  await custody();
  const pending = captured.filter((row) => row.record.nextStep === "work");
  if (pending.length === 0) return { ingested: 0, deferred: false };
  const native = await deps.readExecution(execution);
  if (
    !native.ok || native.value === null || native.value.outcome !== "failed"
  ) throw new Error("historical matrix native settlement unavailable");
  const proof = parseHostedRunProofV1(native.value);
  if (
    canonicalStringify(proof.execution) !== canonicalStringify(execution) ||
    (saved?.execution.id === execution.id &&
      canonicalStringify({ ...proof, observedAt: 0 }) !==
        canonicalStringify({ ...saved, observedAt: 0 }))
  ) throw new Error("historical matrix native custody unavailable");
  const requests = pending.map(({ record, binding }) => ({
    taskId: record.id,
    repository: record.repository,
    reservationId: binding.reservation,
    intentKey: record.intent!.key,
    expectedBase: record.target.base,
    attempt: record.counters.attempts,
  }));
  const deadlineAt = deps.clock.now() + 60_000;
  const waves = await deps.transport.recover({
    requests,
    runtimeSha: HISTORICAL_C63.runtimeSha,
    launcherSha: HISTORICAL_C63.run.launcherSha,
    currentRun: HISTORICAL_C63.run,
    deadline: deadlineAt,
  });
  if (waves.length !== 1) {
    throw new Error("historical matrix native custody unavailable");
  }
  const wave = waves[0];
  if (
    wave.plan.waveId !== HISTORICAL_C63.executionId ||
    canonicalStringify(wave.plan.run) !==
      canonicalStringify(HISTORICAL_C63.run) ||
    canonicalStringify(wave.provenance.run) !==
      canonicalStringify(HISTORICAL_C63.run) ||
    wave.planDigest !== await matrixDigestV1(wave.plan) ||
    wave.results.length !== pending.length ||
    pending.some(({ binding }) =>
      !wave.plan.cells.some((cell) =>
        cell.cellId === binding.cellId && cell.taskId === binding.id &&
        cell.reservationId === binding.reservation &&
        cell.runtimeSha === HISTORICAL_C63.runtimeSha &&
        cell.generation === HISTORICAL_C63.generation
      ) || wave.results.filter((result) =>
          result.cellId === binding.cellId && result.taskId === binding.id &&
          result.reservationId === binding.reservation &&
          result.status === "not_started" && result.receipt === null &&
          result.bundle === null
        ).length !== 1
    )
  ) throw new Error("historical matrix native custody unavailable");
  await custody();
  const freshRepair = await deps.state.readRepair();
  if (
    !freshRepair.ok || freshRepair.value.status !== "found" ||
    freshRepair.value.head !== before.head ||
    canonicalStringify(freshRepair.value.snapshot) !==
      canonicalStringify(before.snapshot)
  ) throw new Error("historical matrix captured identity changed");
  const config = {
    ...createLocalRepositoryConfig(),
    repository: HISTORICAL_C63.repository,
  };
  // Both budget settlement and work persistence retain the same current and
  // historical release custody gate before each real expected-head write.
  const state: StateReadView & RepairStateWriter = {
    readRepair: () => deps.state.readRepair(),
    readRelease: () => deps.state.readRelease(),
    writeRepair: async (next, expectedHead) => {
      await custody();
      return deps.state.writeRepair(next, expectedHead);
    },
  };
  const gate = new HostedRepairCooldownGate({
    state,
    clock: deps.clock,
  });
  const refused = <T>(): T =>
    new Proxy({}, {
      get: () => () =>
        Promise.reject(new Error("C63 maintenance capability refused")),
    }) as T;
  const selected = new Set<string>(
    requests.map((request) => request.reservationId),
  );
  const report = await ingestMatrixResults(
    {
      state,
      clock: deps.clock,
      configs: [config],
      controllerSha: HISTORICAL_C63.runtimeSha,
      github: refused<GitHubPort>(),
      githubCooldown: gate,
      incidents: refused<IncidentAdapter>(),
      replay: refused<ReplayPort>(),
      model: {
        runModel: () =>
          Promise.reject(new Error("C63 maintenance model refused")),
      },
      budget: new RollingStartBudget({
        state,
        clock: deps.clock,
        configs: [config],
      }),
      externalImplementations: true,
    },
    {
      ...wave.plan,
      cells: wave.plan.cells.filter((cell) => selected.has(cell.reservationId)),
    },
    wave.results,
    { deadline: deadlineAt, expectedProvider: HISTORICAL_RECOVERY_PROVIDERS },
  );
  if (report.ingested !== pending.length) {
    throw new Error("historical matrix settlement incomplete");
  }
  await custody();
  const readback = await deps.state.readRepair();
  if (!readback.ok || readback.value.status !== "found") {
    throw new Error("historical matrix block readback incomplete");
  }
  const after = readback.value.snapshot;
  for (const { record, reservation } of pending) {
    const changed = after.work.find((row) => row.id === record.id);
    const charge = after.reservations.find((row) => row.id === reservation.id);
    if (
      !changed || !charge || changed.nextStep !== "blocked" ||
      changed.blocker?.kind !== "other" || charge.outcome !== "ambiguous" ||
      charge.settledAt === null ||
      canonicalStringify({
          ...changed,
          nextStep: record.nextStep,
          blocker: record.blocker,
          wait: record.wait,
          updatedAt: record.updatedAt,
        }) !== canonicalStringify(record) ||
      canonicalStringify({
          ...charge,
          outcome: reservation.outcome,
          settledAt: reservation.settledAt,
        }) !== canonicalStringify(reservation)
    ) throw new Error("historical matrix block readback incomplete");
  }
  const normalized = {
    ...after,
    stateHead: before.snapshot.stateHead,
    sequence: before.snapshot.sequence,
    updatedAt: before.snapshot.updatedAt,
    work: after.work.map((row) =>
      pending.find((saved) => saved.record.id === row.id)?.record ?? row
    ),
    reservations: after.reservations.map((row) =>
      pending.find((saved) => saved.reservation.id === row.id)?.reservation ??
        row
    ),
  };
  // The durable attempt-memory and lessons sections are growth-only side
  // effects of the same normal-consumer settlement; every other section must
  // be byte-identical to the captured snapshot.
  const expected = {
    ...before.snapshot,
    attemptMemory: normalized.attemptMemory,
    lessons: normalized.lessons,
  };
  if (canonicalStringify(normalized) !== canonicalStringify(expected)) {
    throw new Error("historical matrix block readback incomplete");
  }
  return { ingested: report.ingested, deferred: false };
}

async function recoverHostedCurrentMatrix(
  deps: HostedAutonomyDepsV1,
  binding: ClosedCWaveBindingV1,
  onDeferred: () => void,
): Promise<HostedAutonomyResultV1 | null> {
  if (!deps.closedMatrix) return null;
  const deadlineAt = deps.clock.now() + 60_000;
  const dedicated = new Set<string>([
    ...binding.cells.map((row) => row.reservationId),
    ...(deps.historicalMatrix
      ? HISTORICAL_C63.rows.map((row) => row.reservation)
      : []),
    ...(deps.historicalMatrix?.historicalReleaseWitnesses?.flatMap((row) =>
      row.reservationIds
    ) ?? []),
  ]);
  const [repair, release] = await Promise.all([
    deps.state.readRepair(),
    deps.state.readRelease(),
  ]);
  // Missing or temporarily unavailable custody defers recovery.
  if (
    !repair.ok || repair.value.status !== "found" || !release.ok ||
    release.value.status !== "found"
  ) {
    onDeferred();
    return null;
  }
  if (
    !repair.value.snapshot.work.some((row) =>
      row.nextStep === "work" && row.intent &&
      ["implementation", "candidate_preservation"].includes(row.intent.kind) &&
      !dedicated.has(row.intent.requestId ?? "")
    )
  ) return null;
  const current = release.value;
  const runtime = current.snapshot.hostedRuntimes.find((row) =>
    row.id === HOSTED_RUNTIME_ID
  );
  if (!runtime) {
    onDeferred();
    return null;
  }
  // An active execution or a nonterminal release defers current-matrix
  // recovery; the existing maintenance guard owns that disposition and the
  // pass must never fail here. Return no recovery so active promotion stays
  // a deferred condition.
  if (
    runtime.execution !== null ||
    current.snapshot.hostedReleases.some((row) =>
      !["accepted", "rolled_back", "cancelled"].includes(row.phase)
    )
  ) {
    onDeferred();
    return null;
  }
  const snapshots = new Set<string>();
  const proofs = new Map<string, string>();
  const covered = new Set<string>();
  const pending = repair.value.snapshot.work.filter((row) =>
    row.nextStep === "work" && row.intent &&
    ["implementation", "candidate_preservation"].includes(row.intent.kind) &&
    !dedicated.has(row.intent.requestId ?? "")
  );
  const scan = async () => {
    let producer = current;
    while (true) {
      if (deps.clock.now() >= deadlineAt) {
        throw new Error("current matrix history deadline exhausted");
      }
      if (snapshots.has(producer.head)) {
        throw new Error("current matrix history cycle");
      }
      snapshots.add(producer.head);
      const producerRuntime = producer.snapshot.hostedRuntimes.find((row) =>
        row.id === HOSTED_RUNTIME_ID
      );
      const saved = producerRuntime?.lastExecutionProof;
      if (
        producerRuntime?.execution === null && saved &&
        saved.outcome !== "not_started" &&
        saved.execution.purpose === "ordinary"
      ) {
        const deferred = (saved.execution.runId === binding.run.runId &&
          saved.execution.runAttempt === binding.run.runAttempt &&
          saved.execution.launcherSha === binding.run.launcherSha &&
          saved.execution.revision === binding.runtimeSha &&
          saved.execution.generation === binding.generation) ||
          saved.execution.id === HISTORICAL_C63.executionId ||
          deps.historicalMatrix?.historicalReleaseWitnesses?.some((row) =>
            row.executionId === saved.execution.id
          );
        if (!deferred) {
          const identity = canonicalStringify(saved.execution);
          const proof = canonicalStringify({ ...saved, observedAt: 0 });
          const prior = proofs.get(identity);
          if (prior !== undefined && prior !== proof) {
            throw new Error("current matrix historical proof conflicts");
          }
          if (prior === undefined) {
            proofs.set(identity, proof);
            const produced = await recoverHostedMatrixProducer(
              deps,
              current,
              producer,
              deadlineAt,
              covered,
              dedicated,
              onDeferred,
            );
            // An unresolved newer producer stops older-history recovery:
            // an older wave must never settle a reservation whose newer
            // producer outcome is still unavailable.
            if (produced.deferred) return null;
            if (produced.result?.status === "applied") {
              return produced.result;
            }
            if (
              pending.every((row) =>
                row.intent?.requestId && covered.has(row.intent.requestId)
              )
            ) return null;
          }
        }
      }
      const parent = producer.snapshot.stateHead;
      if (parent === null) {
        if (producer.snapshot.sequence !== 1) {
          throw new Error("current matrix history root unavailable");
        }
        return null;
      }
      // Unauthenticated or tampered release history stays fail-closed: the
      // offline-history controls pin a rejection for missing, wrong-head,
      // wrong-sequence and cycle faults.
      if (snapshots.has(parent) || !deps.state.readReleaseAt) {
        throw new Error("current matrix history unavailable");
      }
      const prior = await deps.state.readReleaseAt({
        commit: parent,
        expectedHead: current.head,
      });
      if (
        !prior.ok || prior.value.status !== "found" ||
        prior.value.head !== parent ||
        prior.value.snapshot.sequence !== producer.snapshot.sequence - 1
      ) throw new Error("current matrix history ancestry unavailable");
      producer = prior.value;
    }
  };
  return await scan();
}

async function recoverHostedMatrixProducer(
  deps: HostedAutonomyDepsV1,
  current: { head: GitSha; snapshot: ReleaseStateSnapshotV1 },
  producer: { head: GitSha; snapshot: ReleaseStateSnapshotV1 },
  deadlineAt: number,
  covered: Set<string>,
  dedicated: ReadonlySet<string>,
  onDeferred: () => void,
): Promise<{ result: HostedAutonomyResultV1 | null; deferred: boolean }> {
  const checkDeadline = () => {
    if (deps.clock.now() >= deadlineAt) {
      throw new Error("current matrix history deadline exhausted");
    }
  };
  checkDeadline();
  const repair = await deps.state.readRepair();
  checkDeadline();
  if (!repair.ok || repair.value.status !== "found") {
    onDeferred();
    return { result: null, deferred: true };
  }
  const before = repair.value;
  const runtime = producer.snapshot.hostedRuntimes.find((row) =>
    row.id === HOSTED_RUNTIME_ID
  );
  const saved = runtime?.lastExecutionProof;
  if (
    !runtime || !saved || saved.outcome === "not_started" ||
    saved.execution.purpose !== "ordinary"
  ) return { result: null, deferred: false };
  if (
    runtime.execution !== null || saved.execution.releaseId !== null ||
    runtime.activeRevision !== saved.execution.revision ||
    runtime.generation !== saved.execution.generation ||
    current.snapshot.hostedReleases.some((row) =>
      !["accepted", "rolled_back", "cancelled"].includes(row.phase)
    )
  ) throw new Error("current matrix producer custody unavailable");
  const custody = async () => {
    if (deps.clock.now() >= deadlineAt) {
      throw new Error("current matrix history deadline exhausted");
    }
    const fresh = await deps.state.readRelease();
    checkDeadline();
    if (
      !fresh.ok || fresh.value.status !== "found" ||
      fresh.value.head !== current.head ||
      canonicalStringify(fresh.value.snapshot) !==
        canonicalStringify(current.snapshot)
    ) {
      throw new Error("current matrix release custody changed");
    }
    if (producer.head !== current.head) {
      checkDeadline();
      const prior = await deps.state.readReleaseAt?.({
        commit: producer.head,
        expectedHead: current.head,
      });
      checkDeadline();
      if (
        !prior?.ok || prior.value.status !== "found" ||
        prior.value.head !== producer.head ||
        canonicalStringify(prior.value.snapshot) !==
          canonicalStringify(producer.snapshot)
      ) throw new Error("current matrix producer ancestry changed");
    }
  };
  const state: StateReadView & RepairStateWriter = {
    readRepair: () => deps.state.readRepair(),
    readRelease: () => deps.state.readRelease(),
    writeRepair: async (next, expectedHead) => {
      await custody();
      checkDeadline();
      return await deps.state.writeRepair(next, expectedHead);
    },
  };
  // Native reads, cooldown, budget and consumer writes all use this SAME
  // composed writer; changing only cycle.state would leave captured writers.
  checkDeadline();
  const ports = await deps.closedMatrix!(state);
  checkDeadline();
  const requests = before.snapshot.work.flatMap((record) => {
    const intent = record.intent;
    if (
      record.nextStep !== "work" || !intent ||
      !["implementation", "candidate_preservation"].includes(intent.kind) ||
      dedicated.has(intent.requestId ?? "")
    ) return [];
    const charge = before.snapshot.reservations.find((row) =>
      row.id === intent.requestId
    );
    if (
      !charge || record.source.kind !== "issue" ||
      canonicalStringify(charge.repository) !==
        canonicalStringify(record.repository) ||
      charge.taskId !== record.id || charge.head !== record.target.base ||
      charge.attempt !== record.counters.attempts ||
      !["implementation", "retry"].includes(charge.purpose) ||
      charge.outcome === "confirmed_not_submitted" ||
      intent.key !== implementationIntentKey(charge.id) ||
      intent.observedBase !== record.target.base || intent.resultId !== null
    ) {
      throw new Error("current matrix request binding unavailable");
    }
    if (
      !ports.configs.some((config) =>
        canonicalStringify(config.repository) ===
          canonicalStringify(record.repository)
      )
    ) return [];
    return [{
      taskId: record.id,
      repository: record.repository,
      reservationId: charge.id,
      intentKey: intent.key,
      expectedBase: record.target.base,
      attempt: record.counters.attempts,
    }];
  });
  if (requests.length === 0) return { result: null, deferred: false };
  const producerState: StateReadView & RepairStateWriter = {
    ...state,
    readRelease: () =>
      producer.head === current.head
        ? state.readRelease()
        : deps.state.readReleaseAt!({
          commit: producer.head,
          expectedHead: current.head,
        }),
  };
  checkDeadline();
  const transport = await ports.transportFor(producerState);
  checkDeadline();
  if (
    !transport.confirmCompletedExecution ||
    !await transport.confirmCompletedExecution(saved.execution)
  ) {
    // A producer whose own native run is still in flight is not recoverable
    // yet; stop the history traversal and defer instead of failing.
    onDeferred();
    return { result: null, deferred: true };
  }
  checkDeadline();
  const native = await ports.readExecution(saved.execution);
  checkDeadline();
  if (!native.ok || native.value === null) {
    onDeferred();
    return { result: null, deferred: true };
  }
  if (native.value.outcome === "not_started") {
    throw new Error("current matrix native proof unavailable");
  }
  const proof = parseHostedRunProofV1(native.value);
  if (
    canonicalStringify({ ...proof, observedAt: 0 }) !==
      canonicalStringify({ ...saved, observedAt: 0 })
  ) {
    throw new Error("current matrix native proof changed");
  }
  await custody();
  const waves = await transport.recover({
    requests,
    runtimeSha: saved.execution.revision,
    launcherSha: saved.execution.launcherSha,
    currentRun: {
      runId: saved.execution.runId,
      runAttempt: saved.execution.runAttempt,
      launcherSha: saved.execution.launcherSha,
    },
    deadline: deadlineAt,
  });
  checkDeadline();
  if (waves.length !== 1) throw new Error("current matrix wave unavailable");
  const wave = waves[0];
  if (
    wave.plan.waveId !== saved.execution.id ||
    wave.plan.run.runId !== saved.execution.runId ||
    wave.plan.run.runAttempt !== saved.execution.runAttempt ||
    wave.plan.run.launcherSha !== saved.execution.launcherSha ||
    canonicalStringify(wave.provenance.run) !==
      canonicalStringify(wave.plan.run) ||
    wave.planDigest !== await matrixDigestV1(wave.plan) ||
    wave.plan.cells.some((cell) =>
      cell.runtimeSha !== saved.execution.revision ||
      cell.generation !== saved.execution.generation
    )
  ) {
    throw new Error("current matrix wave binding changed");
  }
  const intersection = wave.plan.cells.filter((cell) =>
    requests.some((request) => request.reservationId === cell.reservationId)
  );
  if (intersection.length === 0) {
    await custody();
    const fresh = await state.readRepair();
    if (
      !fresh.ok || fresh.value.status !== "found" ||
      fresh.value.head !== before.head ||
      canonicalStringify(fresh.value.snapshot) !==
        canonicalStringify(before.snapshot)
    ) {
      throw new Error("current matrix repair custody changed");
    }
    return { result: null, deferred: false };
  }
  const fresh = await state.readRepair();
  if (
    !fresh.ok || fresh.value.status !== "found" ||
    fresh.value.head !== before.head ||
    canonicalStringify(fresh.value.snapshot) !==
      canonicalStringify(before.snapshot)
  ) {
    throw new Error("current matrix repair custody changed");
  }
  let ingested = 0;
  const selected = new Set<string>();
  const selectedTasks = new Set<string>();
  for (const config of ports.configs) {
    const cells = wave.plan.cells.filter((cell) =>
      requests.some((request) =>
        request.reservationId === cell.reservationId
      ) &&
      canonicalStringify(cell.repository) ===
        canonicalStringify(config.repository)
    );
    if (cells.length === 0) continue;
    for (const cell of cells) {
      selected.add(cell.reservationId);
      selectedTasks.add(cell.taskId);
    }
    await custody();
    await ports.prepareTarget(config);
    checkDeadline();
    const report = await ingestMatrixResults(
      {
        ...ports.cycleFor(config),
        state,
        controllerSha: saved.execution.revision,
        externalImplementations: true,
      },
      { ...wave.plan, cells },
      wave.results.filter((result) =>
        cells.some((cell) => cell.cellId === result.cellId)
      ),
      {
        deadline: deadlineAt,
        expectedProvider: HISTORICAL_RECOVERY_PROVIDERS,
        bundleImporter: ports.importerFor(config, wave.bundlesDir),
      },
    );
    // A missing current artifact is a completed timeout disposition: the
    // normal consumer records the host timeout, clears the intent and emits
    // `missing`, so it must not fail the maintenance pass after that write.
    if (
      report.entries.some((entry) =>
        !["ingested", "duplicate", "missing"].includes(entry.disposition)
      ) || report.entries.length !== cells.length
    ) {
      throw new Error("current matrix ingestion incomplete");
    }
    checkDeadline();
    ingested += report.ingested;
  }
  if (selected.size === 0) {
    throw new Error("current matrix selected evidence unavailable");
  }
  await custody();
  const after = await state.readRepair();
  if (
    !after.ok || after.value.status !== "found" ||
    canonicalStringify(after.value.snapshot.reviews) !==
      canonicalStringify(before.snapshot.reviews) ||
    canonicalStringify(after.value.snapshot.releaseRequests) !==
      canonicalStringify(before.snapshot.releaseRequests) ||
    canonicalStringify(
        after.value.snapshot.work.filter((row) => !selectedTasks.has(row.id)),
      ) !==
      canonicalStringify(
        before.snapshot.work.filter((row) => !selectedTasks.has(row.id)),
      ) ||
    canonicalStringify(
        after.value.snapshot.reservations.filter((row) =>
          !selected.has(row.id)
        ),
      ) !==
      canonicalStringify(
        before.snapshot.reservations.filter((row) => !selected.has(row.id)),
      )
  ) {
    throw new Error("current matrix readback incomplete");
  }
  for (const id of selected) covered.add(id);
  return {
    result: {
      kind: "hosted_autonomy",
      status: after.value.head === before.head ? "skipped" : "applied",
      reason: after.value.head === before.head ? "no_change" : "applied",
      beforeHead: before.head,
      appliedHead: after.value.head,
      actions: [`current-matrix:ingested:${ingested}`],
      revisions: [],
    },
    deferred: false,
  };
}

export async function runHostedAutonomy(
  deps: HostedAutonomyDepsV1,
): Promise<HostedAutonomyResultV1> {
  const actions: string[] = [];
  let closedBinding: ClosedCWaveBindingV1 = CLOSED_C_WAVE;
  if (deps.closedMatrix) {
    const read = await deps.state.readRepair();
    // Missing or temporarily unavailable repair custody defers the closed and
    // current matrix pre-passes instead of failing the maintenance pass.
    const closed = read.ok && read.value.status === "found"
      ? await deps.closedMatrix()
      : undefined;
    closedBinding = closed?.binding ?? CLOSED_C_WAVE;
    const releaseRead = read.ok && read.value.status === "found"
      ? await deps.state.readRelease()
      : null;
    if (
      releaseRead?.ok && releaseRead.value.status === "found" &&
      read.ok && read.value.status === "found" && closed !== undefined &&
      closedCWaveNeedsRecovery(read.value.snapshot, closed.binding)
    ) {
      const recovered = await ingestClosedCWave(closed);
      console.log(
        JSON.stringify({ kind: "sentinel_closed_c_recovery", ...recovered }),
      );
      return {
        kind: "hosted_autonomy",
        status: recovered.repairHead === read.value.head
          ? "skipped"
          : "applied",
        reason: recovered.repairHead === read.value.head
          ? "no_change"
          : "applied",
        beforeHead: read.value.head,
        appliedHead: recovered.repairHead,
        actions: ["closed-c-matrix:ingested:" + recovered.dispositions.length],
        revisions: [],
      };
    }
  }
  let custodyDeferred = false;
  const currentMatrix = await recoverHostedCurrentMatrix(
    deps,
    closedBinding,
    () => {
      custodyDeferred = true;
    },
  );
  if (currentMatrix?.status === "applied") return currentMatrix;
  if (deps.historicalMatrix) {
    let count: number;
    try {
      const c63 = await recoverHostedHistoricalC63(deps.historicalMatrix);
      if (c63.deferred) custodyDeferred = true;
      if (c63.ingested > 0) {
        actions.push(`historical-c63:ingested:${c63.ingested}`);
      }
      // A custody-absent pre-pass must not fall through to the legacy
      // quarantine pass, whose refusals would turn it into a hard failure.
      count = custodyDeferred
        ? 0
        : await runHistoricalMatrixQuarantine(deps.historicalMatrix);
    } catch (error) {
      // Only fixed quarantine vocabulary reaches hosted logs, never transport text.
      let errorName: unknown;
      let errorMessage: unknown;
      try {
        if (error instanceof Error) {
          errorName = error.name;
          errorMessage = error.message;
        }
      } catch {
        // A throwing accessor must not replace the quarantine refusal.
      }
      const name = typeof errorName === "string" && [
          "Error",
          "TypeError",
          "RangeError",
          "SyntaxError",
          "ReferenceError",
          "URIError",
          "EvalError",
          "AggregateError",
        ].includes(errorName)
        ? errorName
        : "UnknownError";
      const message = typeof errorMessage === "string" && [
          "matrix artifact provenance unavailable or conflicting",
          "historical matrix not-started admission unproven",
          "historical matrix state unavailable",
          "historical matrix selected reservation binding unavailable",
          "historical matrix release unavailable",
          "historical matrix current native writers unsettled",
          "historical matrix current native settlement unavailable",
          "historical matrix current native binding changed",
          "historical matrix saved custody unavailable",
          "historical matrix current custody changed",
          "historical matrix release witness unavailable",
          "historical matrix release witness binding changed",
          "historical matrix verification custody changed",
          "historical matrix verification completion unavailable",
          "historical matrix verification proof unavailable",
          "historical matrix verification binding changed",
          "historical matrix verification observation changed",
          "historical matrix saved execution unavailable",
          "historical matrix native settlement unavailable",
          "historical matrix native custody unavailable",
          "historical matrix selected witness rejection unavailable",
          "historical matrix applicability changed",
          "historical matrix rejection identity unavailable",
          "historical matrix rejection reservation outside witness",
          "historical matrix final custody changed",
          "historical matrix custody unavailable",
          "historical matrix captured identity changed",
          "historical matrix pre-settlement custody unavailable",
          "historical matrix settlement incomplete",
          "historical matrix post-settlement custody unavailable",
          "historical matrix post-settlement identity changed",
          "historical matrix clock unavailable",
          "historical matrix pre-block custody unavailable",
          "historical matrix block incomplete",
          "historical matrix block readback incomplete",
        ].includes(errorMessage)
        ? errorMessage
        : "[redacted]";
      console.error(JSON.stringify({
        kind: "sentinel_historical_quarantine_error",
        name,
        message,
      }));
      throw new HistoricalQuarantineIncomplete();
    }
    if (count > 0) actions.push(`historical-matrix:quarantined:${count}`);
  }
  const uncertainty = await deps.uncertainMatrix?.();
  if (uncertainty && uncertainty.quarantined > 0) {
    actions.push(`matrix-uncertainty:quarantined:${uncertainty.quarantined}`);
  }
  const revisions: string[] = [];
  const initial = await readRepairSafely(deps.state);
  if (initial === null || !initial.ok || initial.value.status !== "found") {
    return skipped("no_change", null, actions);
  }
  let snapshot = initial.value.snapshot;
  let observedHead = initial.value.head;

  const releaseRead = await readReleaseSafely(deps.state);
  if (
    releaseRead === null || !releaseRead.ok ||
    releaseRead.value.status !== "found"
  ) {
    return skipped("release_not_terminal", observedHead, actions);
  }
  if (
    releaseRead.value.snapshot.hostedReleases.some((release) =>
      release.phase !== "accepted" && release.phase !== "rolled_back"
    )
  ) {
    return skipped("release_not_terminal", observedHead, actions);
  }

  // ---- per-repository surfaces -------------------------------------------
  // Every fact below is read from the surface of the record's OWN repository.
  // The sentinel scope keeps its recorded `development` base branch, its named
  // `test-local` check and its trusted release path; every other identity is a
  // foreign target whose default branch, checks, pulls and issues are read and
  // written under its own repository only. An unreadable surface or an
  // unreadable default branch is never guessed around: the affected record is
  // skipped with an explicit action and nothing changes.
  interface HostedAutonomyScopeV1 {
    readonly repository: RepositoryIdentityV1;
    readonly key: string;
    readonly surface: HostedAutonomyGitHubV1 | null;
    readonly baseBranch: string | null;
  }
  const scopes = new Map<string, Promise<HostedAutonomyScopeV1>>();
  const scopeFor = (
    repository: RepositoryIdentityV1,
  ): Promise<HostedAutonomyScopeV1> => {
    const key = hostedRepositoryKey(repository);
    const cached = scopes.get(key);
    if (cached !== undefined) return cached;
    const resolved = (async (): Promise<HostedAutonomyScopeV1> => {
      let surface: HostedAutonomyGitHubV1 | null = null;
      try {
        surface = deps.githubFor(repository);
      } catch {
        surface = null;
      }
      if (surface === null) {
        return { repository, key, surface: null, baseBranch: null };
      }
      if (isHostedSelf(repository)) {
        return {
          repository,
          key,
          surface,
          baseBranch: HOSTED_AUTONOMY_BASE_BRANCH,
        };
      }
      let baseBranch: string | null = null;
      try {
        baseBranch = await surface.readDefaultBranch();
      } catch {
        baseBranch = null;
      }
      return { repository, key, surface, baseBranch };
    })();
    scopes.set(key, resolved);
    return resolved;
  };
  const readTip = async (
    scope: HostedAutonomyScopeV1,
  ): Promise<string | null> => {
    const surface = scope.surface;
    const branch = scope.baseBranch;
    if (surface === null || branch === null) return null;
    try {
      return await surface.readBaseTip(branch);
    } catch {
      return null;
    }
  };
  const readPull = async (
    scope: HostedAutonomyScopeV1,
    number: number,
  ): Promise<HostedAutonomyPullV1 | null> => {
    const surface = scope.surface;
    if (surface === null) return null;
    try {
      return await surface.readPull(number, scope.baseBranch);
    } catch {
      return null;
    }
  };

  // ---- candidate-ref revalidation pass ------------------------------------
  // The runtime parks a record when its managed candidate branch ref matched
  // neither the saved candidate head nor the head that record had published.
  // That ONE diagnosis is revalidated here, before any blocked work is
  // selected for a retry grant: every saved identity must bind exactly to this
  // record's own repository, task and producing operation, and the branch's
  // live ref must report exactly the original saved head. A record that proves
  // it returns to `work` with only that blocker cleared, through the same
  // expected-head CAS and readback as every other maintenance write, and the
  // pass then returns immediately so no delivery or review decision is made in
  // the same run from a state the runtime has not yet reconciled. An
  // unavailable surface or ref, a mismatched identity and every other blocker
  // leave the snapshot exactly as it was.
  const revalidated: CandidateRefRevalidationV1[] = [];
  for (const record of snapshot.work) {
    const candidate = await candidateRefRevalidation(record);
    if (candidate === null) continue;
    const surface = (await scopeFor(record.repository)).surface;
    if (surface === null) continue;
    let observed: string | null;
    try {
      observed = await surface.readBaseTip(candidate.branch);
    } catch {
      observed = null;
    }
    if (observed !== candidate.head) continue;
    revalidated.push(candidate);
  }
  if (revalidated.length > 0) {
    const now = deps.clock.now();
    if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
      return skipped("clock_invalid", observedHead, actions);
    }
    let next: RepairStateSnapshotV1;
    try {
      next = applyCandidateRefRevalidations(
        snapshot,
        observedHead as GitSha,
        revalidated,
        now,
      );
    } catch {
      return skipped("snapshot_invalid", observedHead, actions);
    }
    let write: PortResultV1<StateWriteResultV1> | null;
    try {
      write = await deps.state.writeRepair(next, observedHead as GitSha);
    } catch {
      return failed("write_unavailable", observedHead, actions);
    }
    if (write === null || !write.ok) {
      return failed("write_unavailable", observedHead, actions);
    }
    if (write.value.status === "conflict") {
      return skipped("write_conflict", observedHead, actions);
    }
    if (write.value.status === "ambiguous") {
      return failed("write_ambiguous", observedHead, actions);
    }
    const readback = await readRepairSafely(deps.state);
    if (
      readback === null || !readback.ok ||
      readback.value.status !== "found" ||
      readback.value.head !== write.value.head ||
      canonicalStringify(readback.value.snapshot) !== canonicalStringify(next)
    ) {
      return failed("readback_unverified", observedHead, actions);
    }
    for (const record of revalidated) {
      actions.push(`revalidate:${record.id}:cleared`);
    }
    return {
      kind: "hosted_autonomy",
      status: "applied",
      reason: "applied",
      beforeHead: observedHead,
      appliedHead: write.value.head,
      actions,
      revisions,
    };
  }

  // ---- retry pass ---------------------------------------------------------
  // A task whose pull request is already merged or closed is delivered or
  // abandoned: retrying it would only spend model starts on a branch that can
  // no longer be published, so those plans are dropped before any write. A
  // pull that cannot be read is also not retried, but it is recorded as a read
  // failure rather than as the definitive not-open verdict it never was.
  const retryTips = new Map<string, string | null>();
  for (const record of snapshot.work) {
    if (record.nextStep === "done") continue;
    const scope = await scopeFor(record.repository);
    if (retryTips.has(scope.key)) continue;
    retryTips.set(scope.key, await readTip(scope));
  }
  // The closed-issue fact is collected for every record that is not done, not
  // only for blocked ones: the retirement pass needs it for a live record whose
  // source issue is already gone. The retry pass keeps consuming it for blocked
  // records exactly as before, and the identity is always the pair
  // (repository, issue number).
  const closedIssues = new Set<string>();
  for (const record of snapshot.work) {
    if (record.nextStep === "done") continue;
    const issueNumber = record.related.issueNumber;
    if (issueNumber === null) continue;
    const scope = await scopeFor(record.repository);
    if (scope.surface === null) {
      actions.push(`record:${record.id}:surface_unreadable`);
      continue;
    }
    let open: boolean | null = null;
    try {
      open = await scope.surface.readIssueOpen(issueNumber);
    } catch {
      open = null;
    }
    if (open === false) {
      closedIssues.add(hostedIssueKey(record.repository, issueNumber));
    }
  }
  const planned = planHostedRetries(
    snapshot,
    deps.clock.now(),
    retryTips,
    closedIssues,
    (denial) => {
      actions.push(`retry:${denial.id}:denied:${denial.reason}`);
    },
  );
  const plans: RetryPlanV1[] = [];
  for (const plan of planned) {
    const record = snapshot.work.find((item) =>
      item.id === plan.id && sameRepository(item.repository, plan.repository)
    );
    const pullRequest = record?.target.pr ?? null;
    if (record === undefined || pullRequest === null) {
      plans.push(plan);
      continue;
    }
    const scope = await scopeFor(record.repository);
    if (scope.surface === null) {
      actions.push(`retry:${plan.id}:skipped:surface_unreadable`);
      continue;
    }
    const pull = await readPull(scope, pullRequest);
    if (pull === null) {
      // A read that threw or returned nothing is transient: it is no evidence
      // that the pull is closed, so it must not be reported as not open.
      actions.push(`retry:${plan.id}:skipped:pr_read_failed`);
    } else if (pull.state === "open" && pull.merged === false) {
      plans.push(plan);
    } else {
      actions.push(`retry:${plan.id}:skipped:pr_not_open`);
    }
  }
  if (plans.length > 0) {
    const now = deps.clock.now();
    if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
      return skipped("clock_invalid", observedHead, actions);
    }
    let next: RepairStateSnapshotV1;
    try {
      next = applyHostedRetries(snapshot, observedHead as GitSha, plans, now);
    } catch {
      return skipped("snapshot_invalid", observedHead, actions);
    }
    let write: PortResultV1<StateWriteResultV1> | null;
    try {
      write = await deps.state.writeRepair(next, observedHead as GitSha);
    } catch {
      return failed("write_unavailable", observedHead, actions);
    }
    if (write === null || !write.ok) {
      return failed("write_unavailable", observedHead, actions);
    }
    if (write.value.status === "conflict") {
      return skipped("write_conflict", observedHead, actions);
    }
    if (write.value.status === "ambiguous") {
      return failed("write_ambiguous", observedHead, actions);
    }
    const readback = await readRepairSafely(deps.state);
    if (
      readback === null || !readback.ok ||
      readback.value.status !== "found" ||
      readback.value.head !== write.value.head ||
      canonicalStringify(readback.value.snapshot) !== canonicalStringify(next)
    ) {
      return failed("readback_unverified", observedHead, actions);
    }
    snapshot = readback.value.snapshot;
    observedHead = readback.value.head;
    for (const plan of plans) {
      actions.push(`retry:${plan.id}:grant=${plan.grant}:${plan.detail}`);
    }
    return {
      kind: "hosted_autonomy",
      status: "applied",
      reason: "retried",
      beforeHead: initial.value.head,
      appliedHead: write.value.head,
      actions,
      revisions,
    };
  }

  // ---- check-approval pass ------------------------------------------------
  // A candidate pushed to a pull request by the bot produces a CI run that
  // GitHub parks for approval, so the deterministic check the merge requires
  // can never complete on its own. The job approves exactly those runs for the
  // exact reviewed head, on the record's OWN repository surface; the check
  // itself stays credential-free and unchanged.
  for (const record of snapshot.work) {
    if (!deliveryEligible(record)) {
      continue;
    }
    const head = record.target.head;
    if (head === null || record.target.pr === null) continue;
    const scope = await scopeFor(record.repository);
    if (scope.surface === null) {
      actions.push(`approve:${record.id}:surface_unreadable`);
      continue;
    }
    let parked: number[] = [];
    try {
      parked = await scope.surface.listParkedRuns(head);
    } catch {
      parked = [];
    }
    for (const id of parked.slice(0, 3)) {
      let approved = false;
      try {
        approved = await scope.surface.approveRun(id);
      } catch {
        approved = false;
      }
      actions.push(
        `approve:${record.id}:run=${id}:${approved ? "approved" : "refused"}`,
      );
    }
  }

  // ---- delivery pass ------------------------------------------------------
  // Each repository's base tip is read once in this pass from that repository's
  // OWN surface. A missing tip or a missing default branch is an explicit skip,
  // never a guessed base, and never another repository's branch.
  const deliveryTips = new Map<string, string | null>();
  const deliveryTip = async (
    scope: HostedAutonomyScopeV1,
  ): Promise<string | null> => {
    const cached = deliveryTips.get(scope.key);
    if (cached !== undefined) return cached;
    const tip = await readTip(scope);
    deliveryTips.set(scope.key, tip);
    return tip;
  };
  // Verified merge facts for FOREIGN records delivered in this pass, keyed by
  // exact repository/pull/head/base. The closure pass owns the actual closure
  // and consumes these only as the evidence it re-checks below.
  const foreignMerged = new Map<string, unknown>();

  // The self scope keeps its exact pre-existing refusal: once sentinel has a
  // record to deliver, an unreadable `development` tip stops the pass before
  // any delivery, exactly as it always did. A foreign-only snapshot never
  // reads the self scope at all.
  if (
    snapshot.work.some((record) =>
      deliveryEligible(record) && isHostedSelf(record.repository)
    )
  ) {
    const selfTip = await deliveryTip(
      await scopeFor(HOSTED_AUTONOMY_SELF_SCOPE),
    );
    if (selfTip === null) {
      return actions.length > 0
        ? skipped("retried", observedHead, actions)
        : skipped("base_moved", observedHead, actions);
    }
  }

  for (const record of snapshot.work) {
    if (!deliveryEligible(record)) {
      continue;
    }
    const pullRequest = record.target.pr;
    const head = record.target.head;
    const base = record.target.base;
    if (pullRequest === null || head === null || base === null) continue;
    const scope = await scopeFor(record.repository);
    // The exact receipts bound to this delivery identity decide whether the
    // candidate is even a delivery candidate. A record without one changes
    // nothing and is reported exactly as before, without an extra read.
    if (boundReviewReceipts(snapshot, record).length === 0) continue;
    // The trusted live source-issue statement is read over the record's OWN
    // authenticated surface immediately before the merge and the release
    // request; the shared predicate then binds the receipt's acceptance to
    // that exact text. A legacy quality-only receipt, a wrong-task digest or
    // an unreadable context refuses here, before any external effect.
    const receipt = authorizingReceipt(
      snapshot,
      record,
      await readTrustedTask(scope.surface, record),
    );
    if (receipt === null) {
      actions.push(`delivery:${record.id}:task_acceptance_refused`);
      continue;
    }
    const self = isHostedSelf(record.repository);
    if (
      self &&
      snapshot.releaseRequests.some((request) =>
        sameRepository(request.target.repository, record.repository) &&
        request.source.pullRequest === pullRequest &&
        request.source.head === head && request.source.base === base &&
        request.target.environment === "production"
      )
    ) {
      actions.push(`delivery:${record.id}:already_recorded`);
      continue;
    }
    if (scope.surface === null) {
      actions.push(`delivery:${record.id}:surface_unreadable`);
      continue;
    }
    if (scope.baseBranch === null) {
      actions.push(`delivery:${record.id}:default_branch_unreadable`);
      continue;
    }
    let pull = await readPull(scope, pullRequest);
    if (pull === null || pull.headSha !== head) continue;
    if (
      typeof pull.author !== "string" ||
      !HOSTED_AUTONOMY_TRUSTED_AUTHORS.includes(pull.author)
    ) {
      actions.push(`delivery:${record.id}:foreign_author`);
      continue;
    }

    let revision: string | null = null;
    if (pull.state === "open" && pull.merged === false) {
      // The base must be exactly the reviewed base, and the repository's own
      // deterministic check must already have succeeded on the exact head.
      const baseTip = await deliveryTip(scope);
      if (baseTip === null) {
        actions.push(`delivery:${record.id}:base_unreadable`);
        continue;
      }
      if (baseTip !== base) {
        actions.push(`delivery:${record.id}:base_moved`);
        continue;
      }
      // A foreign pull must target the exact branch its repository declares as
      // the delivered base; a mismatched base ref is never merged.
      if (!self && pull.baseRef !== scope.baseBranch) {
        actions.push(`delivery:${record.id}:base_mismatch`);
        continue;
      }
      let green: boolean;
      try {
        green = self
          ? await scope.surface.hasSuccessfulCheck(head)
          : await scope.surface.hasAllChecksGreen(head);
      } catch {
        green = false;
      }
      if (!green) {
        actions.push(`delivery:${record.id}:checks_pending`);
        continue;
      }
      // One more trusted source-issue read immediately before the external
      // merge: issue text that drifted while the other gates were read is a
      // different task and never authorizes this merge.
      if (
        authorizingReceipt(
          snapshot,
          record,
          await readTrustedTask(scope.surface, record),
        ) === null
      ) {
        actions.push(`delivery:${record.id}:task_acceptance_refused`);
        continue;
      }
      let merged: { merged: boolean; sha: string | null } | null;
      try {
        merged = await scope.surface.merge(pullRequest, head);
      } catch {
        merged = null;
      }
      if (merged === null) {
        actions.push(`delivery:${record.id}:merge_refused`);
        continue;
      }
      if (merged.merged !== true || merged.sha === null) {
        actions.push(`delivery:${record.id}:merge_not_observed`);
        continue;
      }
      revision = merged.sha;
      actions.push(`merge:${record.id}:pr=${pullRequest}:sha=${revision}`);
      const after = await readPull(scope, pullRequest);
      if (after === null) continue;
      pull = after;
    }
    if (pull.merged !== true || pull.mergeCommitSha === null) continue;
    if (revision === null) revision = pull.mergeCommitSha;
    if (revision !== pull.mergeCommitSha) continue;
    if (
      pull.parents.length !== 2 ||
      !pull.parents.includes(base) || !pull.parents.includes(head) ||
      !pull.revisionOnBaseBranch
    ) {
      actions.push(`delivery:${record.id}:merge_not_observed`);
      continue;
    }

    if (!self) {
      // A foreign repository has no sentinel release authority: nothing is
      // recorded and no release is invented. The verified merge facts are
      // handed to the closure pass, which closes the record's OWN issue from
      // exactly this evidence.
      const evidence = verifiedMergedDelivery(record, pull, scope.baseBranch);
      if (evidence === null) {
        actions.push(`delivery:${record.id}:merge_not_observed`);
        continue;
      }
      foreignMerged.set(
        hostedDeliveryKey(record.repository, pullRequest, head, base),
        evidence,
      );
      actions.push(`delivery:${record.id}:foreign_merged`);
      revisions.push(revision);
      break;
    }

    const now = deps.clock.now();
    if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
      return skipped("clock_invalid", observedHead, actions);
    }
    const request = await buildHostedReleaseRequest(
      record.repository,
      revision,
      head,
      base,
      pullRequest,
      receipt,
      now,
    );
    if (request === null) {
      return skipped("snapshot_invalid", observedHead, actions);
    }
    let next: RepairStateSnapshotV1;
    try {
      next = parseRepairStateSnapshotV1({
        ...snapshot,
        stateHead: observedHead,
        sequence: snapshot.sequence + 1,
        updatedAt: now,
        releaseRequests: [...snapshot.releaseRequests, request],
      });
    } catch {
      return skipped("snapshot_invalid", observedHead, actions);
    }
    let write: PortResultV1<StateWriteResultV1> | null;
    try {
      write = await deps.state.writeRepair(next, observedHead as GitSha);
    } catch {
      return failed("write_unavailable", observedHead, actions);
    }
    if (write === null || !write.ok) {
      return failed("write_unavailable", observedHead, actions);
    }
    if (write.value.status === "conflict") {
      return skipped("write_conflict", observedHead, actions);
    }
    if (write.value.status === "ambiguous") {
      return failed("write_ambiguous", observedHead, actions);
    }
    const readback = await readRepairSafely(deps.state);
    if (
      readback === null || !readback.ok ||
      readback.value.status !== "found" ||
      readback.value.head !== write.value.head ||
      canonicalStringify(readback.value.snapshot) !== canonicalStringify(next)
    ) {
      return failed("readback_unverified", observedHead, actions);
    }
    actions.push(`request:${record.id}:${request.id}`);
    revisions.push(revision);
    return {
      kind: "hosted_autonomy",
      status: "applied",
      reason: actions.some((action) => action.startsWith("retry:"))
        ? "retried"
        : "applied",
      beforeHead: observedHead,
      appliedHead: write.value.head,
      actions,
      revisions,
    };
  }

  // ---- closure pass -------------------------------------------------------
  const released = acceptedReleases(releaseRead.value.snapshot.hostedReleases);
  // A record whose source issue is closed and whose own pull request is
  // definitively closed without a merge can never deliver, whatever step it is
  // parked at. That verdict requires the read to succeed and the pull to be
  // neither merged nor open; a failed or empty read is not evidence and leaves
  // the record alone.
  const closedUnmerged = new Set<string>();
  for (const record of snapshot.work) {
    if (record.nextStep === "done") continue;
    const issueNumber = record.related.issueNumber;
    if (
      issueNumber === null ||
      !closedIssues.has(hostedIssueKey(record.repository, issueNumber))
    ) {
      continue;
    }
    const pullRequest = record.target.pr;
    if (pullRequest === null) continue;
    const scope = await scopeFor(record.repository);
    const pull = await readPull(scope, pullRequest);
    if (pull === null) continue;
    if (pull.merged !== true && pull.state !== "open") {
      closedUnmerged.add(record.id);
    }
  }
  const retirements = planHostedRetirements(
    snapshot,
    closedIssues,
    closedUnmerged,
  ).slice(0, 5);
  let retirementResult: HostedAutonomyResultV1 | null = null;
  if (retirements.length > 0) {
    const now = deps.clock.now();
    if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
      return skipped("clock_invalid", observedHead, actions);
    }
    let next: RepairStateSnapshotV1;
    try {
      next = applyHostedRetirements(
        snapshot,
        observedHead as GitSha,
        retirements,
        now,
      );
    } catch {
      return skipped("snapshot_invalid", observedHead, actions);
    }
    let write: PortResultV1<StateWriteResultV1> | null;
    try {
      write = await deps.state.writeRepair(next, observedHead as GitSha);
    } catch {
      return failed("write_unavailable", observedHead, actions);
    }
    if (write === null || !write.ok) {
      return failed("write_unavailable", observedHead, actions);
    }
    if (write.value.status === "conflict") {
      return skipped("write_conflict", observedHead, actions);
    }
    if (write.value.status === "ambiguous") {
      return failed("write_ambiguous", observedHead, actions);
    }
    const readback = await readRepairSafely(deps.state);
    if (
      readback === null || !readback.ok ||
      readback.value.status !== "found" ||
      readback.value.head !== write.value.head ||
      canonicalStringify(readback.value.snapshot) !== canonicalStringify(next)
    ) {
      return failed("readback_unverified", observedHead, actions);
    }
    for (const plan of retirements) {
      actions.push(`retire:${plan.id}:issue=${plan.issueNumber}`);
    }
    retirementResult = {
      kind: "hosted_autonomy",
      status: "applied",
      reason: "retired_records",
      beforeHead: observedHead,
      appliedHead: write.value.head,
      actions,
      revisions,
    };
    snapshot = readback.value.snapshot;
    observedHead = readback.value.head;
  }
  // A foreign record's delivery evidence is its OWN merged pull request: the
  // trusted release path is bound to the self scope by design and can never
  // authorize a foreign repository, so no release is ever fabricated for one.
  // The exact facts are re-read here for every foreign record with an
  // authorizing receipt; the ones the delivery pass verified in this same run
  // are already present and are not read twice.
  const recovered = new Map<string, HostedAutonomyRecordV1>();
  for (const original of snapshot.work) {
    const record = await historicalMergedPublication(snapshot, original) ??
      original;
    if (record !== original) recovered.set(record.id, record);
    if (record.nextStep === "done") continue;
    if (isHostedSelf(record.repository)) continue;
    const issueNumber = record.related.issueNumber;
    const pullRequest = record.target.pr;
    const head = record.target.head;
    const base = record.target.base;
    if (
      issueNumber === null || pullRequest === null || head === null ||
      base === null
    ) {
      continue;
    }
    const key = hostedDeliveryKey(record.repository, pullRequest, head, base);
    if (foreignMerged.has(key)) continue;
    const scope = await scopeFor(record.repository);
    // The same trusted, immediately-preceding source-issue read authorizes the
    // merge evidence this closure will consume, exactly as it did the merge.
    if (
      authorizingReceipt(
        snapshot,
        record,
        await readTrustedTask(scope.surface, record),
      ) === null
    ) {
      continue;
    }
    const pull = await readPull(scope, pullRequest);
    if (pull === null) continue;
    if (
      recovered.has(record.id) && (
        pull.number !== pullRequest ||
        pull.author !== HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR ||
        pull.mergedBy !== HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR
      )
    ) continue;
    const evidence = verifiedMergedDelivery(record, pull, scope.baseBranch);
    if (evidence === null) continue;
    foreignMerged.set(key, evidence);
  }
  // The trusted task statement is read again for every record whose delivered
  // evidence is present, immediately before the closure plan that may close
  // its issue: issue text that drifted after the delivery read is a different
  // task and never authorizes this closure.
  const closureSnapshot = {
    ...snapshot,
    work: snapshot.work.map((record) => recovered.get(record.id) ?? record),
  };
  const closureTasks = new Map<
    string,
    ReviewTaskStatementV1 | null | "unavailable"
  >();
  for (const record of closureSnapshot.work) {
    if (record.nextStep === "done") continue;
    const issueNumber = record.related.issueNumber;
    const pullRequest = record.target.pr;
    const head = record.target.head;
    const base = record.target.base;
    if (
      issueNumber === null || pullRequest === null || head === null ||
      base === null
    ) {
      continue;
    }
    const key = hostedDeliveryKey(record.repository, pullRequest, head, base);
    const delivered = isHostedSelf(record.repository)
      ? released.has(key)
      : foreignMerged.has(key);
    if (!delivered) continue;
    const scope = await scopeFor(record.repository);
    closureTasks.set(
      record.id,
      await readTrustedTask(scope.surface, record),
    );
  }
  const closures = planHostedClosures(
    closureSnapshot,
    released,
    foreignMerged,
    closureTasks,
  ).slice(0, 5);
  if (closures.length > 0) {
    for (const plan of closures) {
      const record = closureSnapshot.work.find((item) =>
        item.id === plan.id && sameRepository(item.repository, plan.repository)
      );
      if (record === undefined) continue;
      const scope = await scopeFor(plan.repository);
      // The plan above is only a candidate list. Immediately before EVERY
      // actual closure, including a self closure, the CURRENT source-issue
      // statement is re-read over the record's own authenticated surface and
      // the full receipt/record authorization is re-applied to it: an earlier
      // action in this same pass that changed this issue's text (or an
      // unreadable context) refuses here, so a stale bulk read never closes.
      const authorized = authorizingReceipt(
        snapshot,
        record,
        await readTrustedTask(scope.surface, record),
      );
      if (authorized === null) {
        actions.push(`close:${plan.id}:issue=${plan.issueNumber}:refused`);
        continue;
      }
      if (!isHostedSelf(record.repository)) {
        if (recovered.has(record.id)) {
          const pull = await readPull(scope, record.target.pr!);
          if (
            pull === null || pull.number !== record.target.pr ||
            pull.author !== HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR ||
            pull.mergedBy !== HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR ||
            verifiedMergedDelivery(record, pull, scope.baseBranch) === null
          ) {
            actions.push(`close:${plan.id}:issue=${plan.issueNumber}:refused`);
            continue;
          }
        }
        let checksGreen = false;
        try {
          checksGreen = scope.surface !== null && record.target.head !== null &&
            await scope.surface.hasAllChecksGreen(record.target.head) === true;
        } catch {
          checksGreen = false;
        }
        if (!checksGreen) {
          actions.push(`close:${plan.id}:issue=${plan.issueNumber}:refused`);
          continue;
        }
      }
      let closed = false;
      if (scope.surface !== null) {
        try {
          closed = await scope.surface.closeIssue(plan.issueNumber);
        } catch {
          closed = false;
        }
      }
      if (!closed) {
        actions.push(`close:${plan.id}:issue=${plan.issueNumber}:refused`);
        continue;
      }
      actions.push(`close:${plan.id}:issue=${plan.issueNumber}`);
    }
    const closedIds = new Set(
      actions
        .filter((action) => /^close:[^:]+:issue=\d+$/.test(action))
        .map((action) =>
          action.slice("close:".length, action.indexOf(":issue="))
        ),
    );
    const applied = closures.filter((plan) => closedIds.has(plan.id));
    if (applied.length > 0) {
      const now = deps.clock.now();
      if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
        return skipped("clock_invalid", observedHead, actions);
      }
      let next: RepairStateSnapshotV1;
      try {
        next = applyHostedClosures(
          {
            ...snapshot,
            work: snapshot.work.map((record) =>
              applied.some((plan) => plan.id === record.id)
                ? recovered.get(record.id) ?? record
                : record
            ),
          },
          observedHead as GitSha,
          applied,
          now,
        );
      } catch {
        return skipped("snapshot_invalid", observedHead, actions);
      }
      let write: PortResultV1<StateWriteResultV1> | null;
      try {
        write = await deps.state.writeRepair(next, observedHead as GitSha);
      } catch {
        return failed("write_unavailable", observedHead, actions);
      }
      if (write === null || !write.ok) {
        return failed("write_unavailable", observedHead, actions);
      }
      if (write.value.status === "conflict") {
        return skipped("write_conflict", observedHead, actions);
      }
      if (write.value.status === "ambiguous") {
        return failed("write_ambiguous", observedHead, actions);
      }
      const readback = await readRepairSafely(deps.state);
      if (
        readback === null || !readback.ok ||
        readback.value.status !== "found" ||
        readback.value.head !== write.value.head ||
        canonicalStringify(readback.value.snapshot) !== canonicalStringify(next)
      ) {
        return failed("readback_unverified", observedHead, actions);
      }
      return {
        kind: "hosted_autonomy",
        status: "applied",
        reason: "closed_issues",
        beforeHead: observedHead,
        appliedHead: write.value.head,
        actions,
        revisions,
      };
    }
  }

  if (retirementResult !== null) return retirementResult;

  // ---- self-observation pass ---------------------------------------------
  // Runs LAST and is fully optional: every read is bounded and state-free, its
  // only write is one deduplicated issue in this deployment's own tracker, and
  // any refusal inside it is reported as an action rather than a failure. The
  // normal repair loop then works those issues like any other.
  let selfSurface: HostedAutonomyGitHubV1 | null = null;
  try {
    selfSurface = (await scopeFor(HOSTED_AUTONOMY_SELF_SCOPE)).surface;
  } catch {
    selfSurface = null;
  }
  actions.push(
    ...await runSelfObservationPass({
      github: selfSurface,
      now: deps.clock.now(),
    }),
  );

  const suffix = (value: string) =>
    actions.some((action) => action.endsWith(value));
  const reason: HostedAutonomyReasonV1 =
    actions.some((action) => action.startsWith("retry:"))
      ? "retried"
      : suffix(":already_recorded")
      ? "already_recorded"
      : suffix(":base_moved")
      ? "base_moved"
      : suffix(":checks_pending")
      ? "checks_pending"
      : suffix(":merge_refused")
      ? "merge_refused"
      : suffix(":merge_not_observed")
      ? "merge_not_observed"
      : suffix(":foreign_author")
      ? "foreign_author"
      : actions.length > 0
      ? "no_authorizing_review"
      : "no_change";
  return skipped(reason, observedHead, actions);
}

class HistoricalQuarantineIncomplete extends Error {
  constructor() {
    super("historical matrix quarantine incomplete");
  }
}

/**
 * Parse one raw `GET /pulls/{number}` response into the remote merge facts the
 * helper needs. GitHub assigns `merge_commit_sha` only once a pull is merged,
 * so an unmerged pull legitimately carries it as null (or omits it); a merged
 * pull must name its merge commit. `parents` and `revisionOnBaseBranch` are
 * resolved afterwards by the live reader from the commit and compare
 * endpoints, so this parse stays pure.
 */
export function parseHostedAutonomyPull(
  raw: unknown,
): HostedAutonomyPullV1 | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const head = obj["head"] as Record<string, unknown> | undefined;
  const base = obj["base"] as Record<string, unknown> | undefined;
  const user = obj["user"] as Record<string, unknown> | undefined;
  const merger = obj["merged_by"] as Record<string, unknown> | undefined;
  const merged = obj["merged"] === true;
  const mergeCommitSha = obj["merge_commit_sha"];
  const headSha = head?.["sha"];
  const baseRef = base?.["ref"];
  if (typeof headSha !== "string" || typeof baseRef !== "string") return null;
  if (merged && typeof mergeCommitSha !== "string") return null;
  return {
    number: Number(obj["number"]),
    state: String(obj["state"] ?? ""),
    merged,
    mergeCommitSha: typeof mergeCommitSha === "string" ? mergeCommitSha : null,
    headSha,
    baseRef,
    author: typeof user?.["login"] === "string" ? String(user["login"]) : null,
    ...(obj["merged_by"] === undefined ? {} : {
      mergedBy: typeof merger?.["login"] === "string" ? merger["login"] : null,
    }),
    parents: [],
    revisionOnBaseBranch: false,
  };
}

/**
 * Live GitHub surface this helper needs, over one repository token. The
 * factory takes the target repository identity and builds EVERY REST path for
 * THAT repository: the sentinel self repository's paths are never reused as a
 * fallback for a foreign target, and no other repository name is hard-coded.
 */
export function createHostedAutonomyGitHub(
  token: string,
  repository: RepositoryIdentityV1,
): HostedAutonomyGitHubV1 {
  const scope = `${repository.owner}/${repository.name}`;

  async function request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "sentinel-hosted-autonomy",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (response.status < 200 || response.status >= 300) return null;
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) return null;
      return JSON.parse(text);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function readPull(
    number: number,
    baseBranch: string | null,
  ): Promise<HostedAutonomyPullV1 | null> {
    const pull = await request("GET", `/repos/${scope}/pulls/${number}`);
    const parsed = parseHostedAutonomyPull(pull);
    if (parsed === null || parsed.merged !== true) return parsed;
    const mergeCommitSha = parsed.mergeCommitSha;
    if (mergeCommitSha === null) return null;
    // A merged pull whose integration point is unknown cannot be verified: it
    // reads as null rather than as an unproven merge.
    if (baseBranch === null) return null;
    let parents: string[] = [];
    let revisionOnBaseBranch = false;
    const commit = await request(
      "GET",
      `/repos/${scope}/commits/${mergeCommitSha}`,
    );
    const parentList = commit !== null && typeof commit === "object"
      ? (commit as Record<string, unknown>)["parents"]
      : null;
    if (!Array.isArray(parentList)) return null;
    parents = parentList.map((parent) =>
      typeof parent === "object" && parent !== null
        ? String((parent as Record<string, unknown>)["sha"] ?? "")
        : ""
    );
    const compare = await request(
      "GET",
      `/repos/${scope}/compare/${mergeCommitSha}...${baseBranch}`,
    );
    revisionOnBaseBranch = revisionIntegratedIntoBase(
      compare,
      mergeCommitSha,
    );
    return { ...parsed, parents, revisionOnBaseBranch };
  }

  /**
   * Complete listing read for ONE GitHub list endpoint. Every page is read
   * until the response's own `total_count` is covered, and the read is refused
   * (null) whenever it cannot be proven complete and consistent:
   *
   *  - a page without a valid `total_count` or list field is malformed;
   *  - a `total_count` that changes between pages is count drift;
   *  - an item without a usable id, or the same id twice, is a duplicate read;
   *  - an empty page while more items are promised, or a page bound that the
   *    promised count cannot fit, is an incomplete read.
   *
   * Callers fail closed on null: an unproven listing is never green and never
   * authorizes an approval.
   */
  async function readCompleteListing(
    pagePath: (page: number) => string,
    key: string,
    pageSize: number,
  ): Promise<Record<string, unknown>[] | null> {
    const items: Record<string, unknown>[] = [];
    const seen = new Set<number>();
    let total: number | null = null;
    for (let page = 1; page <= MAX_LISTING_PAGES; page++) {
      const body = await request("GET", pagePath(page));
      if (body === null || typeof body !== "object") return null;
      const obj = body as Record<string, unknown>;
      const count = obj["total_count"];
      if (
        typeof count !== "number" || !Number.isSafeInteger(count) || count < 0
      ) {
        return null;
      }
      if (total === null) {
        total = count;
        if (total > MAX_LISTING_PAGES * pageSize) return null;
      } else if (total !== count) {
        // The endpoint's own count moved between pages: the listing is not one
        // stable read.
        return null;
      }
      const list = obj[key];
      if (!Array.isArray(list)) return null;
      for (const entry of list) {
        if (entry === null || typeof entry !== "object") return null;
        const record = entry as Record<string, unknown>;
        const id = record["id"];
        if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
          return null;
        }
        if (seen.has(id)) return null;
        seen.add(id);
        items.push(record);
      }
      if (items.length > total) return null;
      if (items.length === total) break;
      if (list.length === 0) return null;
    }
    if (total === null || items.length !== total) return null;
    return items;
  }

  /**
   * Complete check-run listing for exactly one commit. Every reported run must
   * be bound to the requested head: a run recorded for another commit is not
   * evidence for this head, and a page that could not be read completely makes
   * the whole listing unusable.
   */
  async function readCompleteCheckRuns(
    head: string,
  ): Promise<Record<string, unknown>[] | null> {
    const runs = await readCompleteListing(
      (page) =>
        `/repos/${scope}/commits/${head}/check-runs?per_page=${LISTING_PAGE_SIZE}&page=${page}`,
      "check_runs",
      LISTING_PAGE_SIZE,
    );
    if (runs === null) return null;
    for (const run of runs) {
      if (run["head_sha"] !== head) return null;
      if (typeof run["name"] !== "string" || run["name"].length === 0) {
        return null;
      }
      if (typeof run["status"] !== "string" || run["status"].length === 0) {
        return null;
      }
      const conclusion = run["conclusion"];
      if (conclusion !== null && typeof conclusion !== "string") return null;
    }
    return runs;
  }

  return {
    async readDefaultBranch() {
      const repo = await request("GET", `/repos/${scope}`);
      if (repo === null || typeof repo !== "object") return null;
      const branch = (repo as Record<string, unknown>)["default_branch"];
      return typeof branch === "string" && branch.length > 0 ? branch : null;
    },
    async readBaseTip(branch: string) {
      const ref = await request(
        "GET",
        `/repos/${scope}/git/ref/heads/${branch}`,
      );
      if (ref === null || typeof ref !== "object") return null;
      // The response must name exactly the requested branch: a ref for another
      // branch (or one without a ref identity) is never this branch's tip.
      if ((ref as Record<string, unknown>)["ref"] !== `refs/heads/${branch}`) {
        return null;
      }
      const object = (ref as Record<string, unknown>)["object"];
      if (object === null || typeof object !== "object") return null;
      const sha = (object as Record<string, unknown>)["sha"];
      return typeof sha === "string" ? sha : null;
    },
    async hasSuccessfulCheck(head: string) {
      const runs = await readCompleteCheckRuns(head);
      // An unreadable, incomplete, drifted or malformed listing is never
      // green; the exact named check must be found on its bound head.
      if (runs === null) return false;
      return runs.some((run) =>
        run["name"] === HOSTED_AUTONOMY_REQUIRED_CHECK &&
        run["head_sha"] === head &&
        run["status"] === "completed" &&
        run["conclusion"] === "success"
      );
    },
    async hasAllChecksGreen(head: string) {
      const runs = await readCompleteCheckRuns(head);
      if (runs === null) return false;
      // Only the runs reported on the exact head count, and the listing was
      // already proven complete and bound to this head. Zero runs is not
      // green: a foreign repository's own completed CI is the only
      // deterministic signal it can supply, so a head with no CI at all is
      // never delivered. Every run on that head must be completed and
      // successful, which also excludes anything pending, queued or failed —
      // including a failure that only the last page carries.
      if (runs.length === 0) return false;
      return runs.every((run) =>
        run["head_sha"] === head &&
        run["status"] === "completed" &&
        run["conclusion"] === "success"
      );
    },
    readPull,
    async listParkedRuns(head: string) {
      // The approval listing gates the same delivery as the checks themselves,
      // so it is read completely too: a parked run on a later page must still
      // be found, and an unproven listing approves nothing.
      const runs = await readCompleteListing(
        (page) =>
          `/repos/${scope}/actions/runs?head_sha=${head}&per_page=${RUN_LISTING_PAGE_SIZE}&page=${page}`,
        "workflow_runs",
        RUN_LISTING_PAGE_SIZE,
      );
      if (runs === null) return [];
      return runs
        .filter((run) =>
          run["head_sha"] === head &&
          run["conclusion"] === "action_required"
        )
        .map((run) => Number(run["id"]))
        .filter((id) => Number.isSafeInteger(id) && id > 0);
    },
    async approveRun(id: number) {
      const approved = await request(
        "POST",
        `/repos/${scope}/actions/runs/${id}/approve`,
      );
      return approved !== null;
    },
    async readIssueOpen(number: number) {
      const issue = await request("GET", `/repos/${scope}/issues/${number}`);
      if (issue === null || typeof issue !== "object") return null;
      const state = (issue as Record<string, unknown>)["state"];
      if (state === "open") return true;
      if (state === "closed") return false;
      return null;
    },
    async readIssueTask(number: number) {
      // Trusted independent read over THIS repository's authenticated surface,
      // through the same client and auth as every other read here. Only the
      // bounded exact statement is returned: a malformed, over-bound or
      // unreadable issue is null and never authorizes anything.
      const issue = await request("GET", `/repos/${scope}/issues/${number}`);
      if (issue === null || typeof issue !== "object") return null;
      const obj = issue as Record<string, unknown>;
      const title = obj["title"];
      const rawBody = obj["body"];
      const body = typeof rawBody === "string"
        ? rawBody
        : rawBody === null
        ? ""
        : null;
      if (typeof title !== "string" || body === null) return null;
      const checked = await checkReviewTaskStatement({
        issueNumber: Number(obj["number"]),
        title,
        body,
        digest: await reviewTaskStatementDigest({
          issueNumber: Number(obj["number"]),
          title,
          body,
        }),
      });
      return checked.ok ? checked.statement : null;
    },
    async closeIssue(number: number) {
      const closed = await request(
        "PATCH",
        `/repos/${scope}/issues/${number}`,
        { state: "closed" },
      );
      if (closed === null || typeof closed !== "object") return false;
      return (closed as Record<string, unknown>)["state"] === "closed";
    },
    selfObservation: {
      async listRuns(input: { sinceIso: string; limit: number }) {
        const runs = await request(
          "GET",
          `/repos/${scope}/actions/runs?created=${
            encodeURIComponent(
              `>=${input.sinceIso}`,
            )
          }&per_page=${Math.min(Math.max(input.limit, 1), 50)}`,
        );
        const list = runs !== null && typeof runs === "object"
          ? (runs as Record<string, unknown>)["workflow_runs"]
          : null;
        if (!Array.isArray(list)) return null;
        const parsed: HostedSelfRunV1[] = [];
        for (const item of list) {
          if (typeof item !== "object" || item === null) continue;
          const obj = item as Record<string, unknown>;
          const id = Number(obj["id"]);
          const name = obj["name"];
          const conclusion = obj["conclusion"];
          const createdAt = obj["created_at"];
          if (!Number.isSafeInteger(id) || id <= 0) continue;
          if (typeof name !== "string" || typeof createdAt !== "string") {
            continue;
          }
          parsed.push({
            id,
            name,
            conclusion: typeof conclusion === "string" ? conclusion : null,
            createdAt,
          });
        }
        return parsed;
      },
      async listJobs(runId: number) {
        const jobs = await request(
          "GET",
          `/repos/${scope}/actions/runs/${runId}/jobs?per_page=50`,
        );
        const list = jobs !== null && typeof jobs === "object"
          ? (jobs as Record<string, unknown>)["jobs"]
          : null;
        if (!Array.isArray(list)) return null;
        const parsed: HostedSelfJobV1[] = [];
        for (const item of list) {
          if (typeof item !== "object" || item === null) continue;
          const obj = item as Record<string, unknown>;
          const id = Number(obj["id"]);
          const name = obj["name"];
          const conclusion = obj["conclusion"];
          if (!Number.isSafeInteger(id) || id <= 0) continue;
          if (typeof name !== "string") continue;
          parsed.push({
            id,
            name,
            conclusion: typeof conclusion === "string" ? conclusion : null,
          });
        }
        return parsed;
      },
      async readJobLog(input: { jobId: number; maxBytes: number }) {
        // The log endpoint answers with a redirect to a pre-signed URL that
        // must NEVER receive the installation token, so the redirect is taken
        // manually and the signed URL is fetched unauthenticated.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          const head = await fetch(
            `${API_BASE}/repos/${scope}/actions/jobs/${input.jobId}/logs`,
            {
              method: "GET",
              redirect: "manual",
              headers: {
                authorization: `Bearer ${token}`,
                accept: "application/vnd.github+json",
                "user-agent": "sentinel-hosted-autonomy",
              },
              signal: controller.signal,
            },
          );
          const location = head.headers.get("location");
          const isRedirect = head.status >= 300 && head.status < 400;
          if (isRedirect && location === null) return null;
          const target = isRedirect ? location! : null;
          if (target !== null && !target.startsWith("https://")) return null;
          const response = target === null ? head : await fetch(target, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
          });
          if (response.status < 200 || response.status >= 300) return null;
          const body = response.body;
          if (body === null) return null;
          const reader = body.getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (total < input.maxBytes) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const value = chunk.value;
            if (value === undefined) break;
            const remaining = input.maxBytes - total;
            const slice = value.byteLength > remaining
              ? value.slice(0, remaining)
              : value;
            chunks.push(slice);
            total += slice.byteLength;
            if (value.byteLength > remaining) break;
          }
          try {
            await reader.cancel();
          } catch {
            // A body that refuses cancellation is still bounded by total.
          }
          const merged = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return new TextDecoder().decode(merged);
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      },
      async listOpenIssueBodies() {
        const issues = await request(
          "GET",
          `/repos/${scope}/issues?state=open&per_page=100`,
        );
        if (!Array.isArray(issues)) return null;
        const bodies: string[] = [];
        for (const item of issues) {
          if (typeof item !== "object" || item === null) continue;
          const body = (item as Record<string, unknown>)["body"];
          if (typeof body === "string") bodies.push(body);
        }
        return bodies;
      },
      async fileIssue(input: { title: string; body: string }) {
        const created = await request("POST", `/repos/${scope}/issues`, {
          title: input.title,
          body: input.body,
        });
        if (created === null || typeof created !== "object") return null;
        const number = Number((created as Record<string, unknown>)["number"]);
        return Number.isSafeInteger(number) && number > 0 ? number : null;
      },
    },
    async merge(number: number, head: string) {
      const response = await request(
        "PUT",
        `/repos/${scope}/pulls/${number}/merge`,
        { sha: head, merge_method: "merge" },
      );
      if (response === null || typeof response !== "object") return null;
      const obj = response as Record<string, unknown>;
      const sha = obj["sha"];
      return {
        merged: obj["merged"] === true,
        sha: typeof sha === "string" ? sha : null,
      };
    },
  };
}

/**
 * True only when the exact revision is integrated into the base branch, with
 * the SAME evidence the runtime's own release verifier reads from
 * `compare/{revision}...{baseBranch}`: the base commit and merge base of that
 * comparison must be the revision itself, and the status must be `ahead`
 * (base branch contains it and moved on) or `identical` (it is the tip).
 * `behind`/`diverged` and any malformed shape are definitive negatives.
 */
export function revisionIntegratedIntoBase(
  compare: unknown,
  revision: string,
): boolean {
  if (compare === null || typeof compare !== "object") return false;
  const obj = compare as Record<string, unknown>;
  const status = obj["status"];
  if (status !== "ahead" && status !== "identical") return false;
  const baseCommit = obj["base_commit"];
  const mergeBase = obj["merge_base_commit"];
  if (
    baseCommit === null || typeof baseCommit !== "object" ||
    mergeBase === null || typeof mergeBase !== "object"
  ) {
    return false;
  }
  return (baseCommit as Record<string, unknown>)["sha"] === revision &&
    (mergeBase as Record<string, unknown>)["sha"] === revision;
}

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Hosted entry point: identity first, then the two bounded passes. */
export async function runHostedAutonomyMain(input?: {
  /** Trusted in-process test transport; native checkout identity remains mandatory. */
  env: Readonly<Record<string, string | undefined>>;
  deps: HostedAutonomyDepsV1;
}): Promise<number> {
  const env = (key: string) =>
    input === undefined ? readEnv(key) : input.env[key] ?? null;
  const facts = await readCheckoutFacts();
  const validated = validateIssue48QuotaHostedIdentity({
    repository: env("GITHUB_REPOSITORY"),
    ref: env("GITHUB_REF"),
    job: env("GITHUB_JOB"),
    runId: env("GITHUB_RUN_ID"),
    runAttempt: env("GITHUB_RUN_ATTEMPT"),
    workflowRef: env("GITHUB_WORKFLOW_REF"),
    sha: env("GITHUB_SHA"),
    workflowSha: env("GITHUB_WORKFLOW_SHA"),
    checkoutHead: facts.head,
    checkoutClean: facts.clean,
  });
  if (!validated.ok) return report(failed("identity_rejected", null));
  // Split by purpose, mirroring the hosted runtime: the scoped sentinel App
  // token authenticates every repository-visible code-change op (merge, issue
  // closure, CI approval) so it is attributed to ubiquity-sentinel[bot], while
  // the native Actions token keeps owning the state refs it has always owned.
  const stateToken = env("GITHUB_TOKEN");
  const apiToken = env("SENTINEL_SUPERVISOR_TOKEN") ?? stateToken;
  if (
    stateToken === null || stateToken.length === 0 ||
    apiToken === null || apiToken.length === 0
  ) {
    return report(failed("identity_rejected", null));
  }
  let result: HostedAutonomyResultV1;
  try {
    if (input) {
      result = await runHostedAutonomy(input.deps);
    } else {
      const scratch = `${Deno.cwd()}/.hosted-autonomy`;
      Deno.mkdirSync(scratch, { recursive: true, mode: 0o700 });
      const runner = new DenoGitRunner(
        `${scratch}/git-home`,
        githubGitAuthEnv(stateToken),
      );
      const state = createRepairStateStore({
        scratchDir: `${scratch}/state`,
        remoteUrl: ISSUE48_QUOTA_REMOTE_URL,
        runner,
      });
      // One surface per exact repository identity: the durable snapshot may
      // carry work for several repositories, and each record is delivered under
      // its OWN repository, never under the self repository.
      const surfaces = new Map<string, HostedAutonomyGitHubV1>();
      const githubFor = (
        repository: RepositoryIdentityV1,
      ): HostedAutonomyGitHubV1 => {
        const key = hostedRepositoryKey(repository);
        const cached = surfaces.get(key);
        if (cached !== undefined) return cached;
        const created = createHostedAutonomyGitHub(apiToken, repository);
        surfaces.set(key, created);
        return created;
      };
      const artifactRoot = await Deno.makeTempDir({
        prefix: "sentinel-maintenance-matrix-",
      });
      try {
        result = await runHostedAutonomy({
          state,
          githubFor,
          clock: { now: () => Date.now() },
          uncertainMatrix: () =>
            runMatrixUncertaintyMaintenance(createMatrixUncertaintyMaintenance({
              state,
              clock: { now: () => Date.now() },
              token: stateToken,
              artifactRoot,
            })),
          closedMatrix: (guardedState = state) =>
            createHostedClosedMatrixRecovery({
              state: guardedState,
              clock: { now: () => Date.now() },
              token: stateToken,
              apiToken,
              sourceDir: Deno.cwd(),
              scratch,
              artifactRoot,
              appInstallationId: env("SENTINEL_APP_INSTALLATION_ID") ??
                undefined,
              cooldownMode: env("SENTINEL_COOLDOWN_MODE") ?? undefined,
            }),
          historicalMatrix: createHostedHistoricalMatrixQuarantine({
            state,
            clock: { now: () => Date.now() },
            token: stateToken,
            artifactRoot,
            cooldownMode: env("SENTINEL_COOLDOWN_MODE") ?? undefined,
            // The trusted production maintenance route is the one caller that
            // revalidates already-quarantined records against authenticated
            // not-started evidence.
            revalidateNotStarted: true,
          }),
        });
      } finally {
        await Deno.remove(artifactRoot, { recursive: true });
      }
    }
  } catch (error) {
    result = failed(
      error instanceof HistoricalQuarantineIncomplete
        ? "historical_quarantine_incomplete"
        : "unexpected_failure",
      null,
    );
  }
  return report(result);
}

/** The two reasons that mean the helper itself could not run safely. */
export function isHardAutonomyFailure(reason: HostedAutonomyReasonV1): boolean {
  return reason === "identity_rejected" || reason === "unexpected_failure" ||
    reason === "historical_quarantine_incomplete";
}

function report(result: HostedAutonomyResultV1): number {
  console.log(JSON.stringify(result));
  return isHardAutonomyFailure(result.reason) ? 1 : 0;
}

function readEnv(key: string): string | null {
  try {
    return Deno.env.get(key) ?? null;
  } catch {
    return null;
  }
}

async function readCheckoutFacts(): Promise<
  { head: string | null; clean: boolean }
> {
  const env: Record<string, string> = {
    PATH: readEnv("PATH") ?? "/usr/bin:/bin",
    HOME: readEnv("HOME") ?? "/tmp",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  try {
    const cwd = Deno.cwd();
    const head = await new Deno.Command("git", {
      args: ["rev-parse", "HEAD"],
      cwd,
      clearEnv: true,
      env,
      stdout: "piped",
      stderr: "null",
    }).output();
    const headSha = head.success
      ? new TextDecoder().decode(head.stdout).trim()
      : "";
    const status = await new Deno.Command("git", {
      args: ["status", "--porcelain"],
      cwd,
      clearEnv: true,
      env,
      stdout: "piped",
      stderr: "null",
    }).output();
    return {
      head: GIT_SHA_PATTERN.test(headSha) ? headSha : null,
      clean: status.success &&
        new TextDecoder().decode(status.stdout).trim() === "",
    };
  } catch {
    return { head: null, clean: false };
  }
}

if (import.meta.main) {
  Deno.exitCode = await runHostedAutonomyMain();
}
