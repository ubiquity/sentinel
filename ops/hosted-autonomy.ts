/**
 * Bounded self-upkeep for the hosted supervisor, run FIRST inside the protected
 * maintenance job (before `prepare`, under the same `sentinel-repair` lock the
 * repair job holds), so its state changes are visible to that run's own
 * execution:
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
import type { GitSha } from "../src/contracts/brands.ts";
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
  releaseRequestId,
  reviewOperationKey,
} from "../src/repair/keys.ts";
import { githubGitAuthEnv } from "../src/host/local.ts";
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
  /** Current tip of one base branch, or null when it cannot be read. */
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
export function planHostedRetries(
  snapshot: RepairStateSnapshotV1,
  now: number,
  baseTips: ReadonlyMap<string, string | null> = new Map(),
  closedIssues: ReadonlySet<string> = new Set(),
): RetryPlanV1[] {
  const plans: RetryPlanV1[] = [];
  for (const record of snapshot.work) {
    if (record.nextStep !== "blocked") continue;
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

export async function runHostedAutonomy(
  deps: HostedAutonomyDepsV1,
): Promise<HostedAutonomyResultV1> {
  const actions: string[] = [];
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
  for (const record of snapshot.work) {
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
    const evidence = verifiedMergedDelivery(record, pull, scope.baseBranch);
    if (evidence === null) continue;
    foreignMerged.set(key, evidence);
  }
  // The trusted task statement is read again for every record whose delivered
  // evidence is present, immediately before the closure plan that may close
  // its issue: issue text that drifted after the delivery read is a different
  // task and never authorizes this closure.
  const closureTasks = new Map<
    string,
    ReviewTaskStatementV1 | null | "unavailable"
  >();
  for (const record of snapshot.work) {
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
    snapshot,
    released,
    foreignMerged,
    closureTasks,
  ).slice(0, 5);
  if (closures.length > 0) {
    for (const plan of closures) {
      const record = snapshot.work.find((item) =>
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
          snapshot,
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
export async function runHostedAutonomyMain(): Promise<number> {
  const facts = await readCheckoutFacts();
  const validated = validateIssue48QuotaHostedIdentity({
    repository: readEnv("GITHUB_REPOSITORY"),
    ref: readEnv("GITHUB_REF"),
    job: readEnv("GITHUB_JOB"),
    runId: readEnv("GITHUB_RUN_ID"),
    runAttempt: readEnv("GITHUB_RUN_ATTEMPT"),
    workflowRef: readEnv("GITHUB_WORKFLOW_REF"),
    sha: readEnv("GITHUB_SHA"),
    workflowSha: readEnv("GITHUB_WORKFLOW_SHA"),
    checkoutHead: facts.head,
    checkoutClean: facts.clean,
  });
  if (!validated.ok) return report(failed("identity_rejected", null));
  // Split by purpose, mirroring the hosted runtime: the scoped sentinel App
  // token authenticates every repository-visible code-change op (merge, issue
  // closure, CI approval) so it is attributed to ubiquity-sentinel[bot], while
  // the native Actions token keeps owning the state refs it has always owned.
  const stateToken = readEnv("GITHUB_TOKEN");
  const apiToken = readEnv("SENTINEL_SUPERVISOR_TOKEN") ?? stateToken;
  if (
    stateToken === null || stateToken.length === 0 ||
    apiToken === null || apiToken.length === 0
  ) {
    return report(failed("identity_rejected", null));
  }
  let result: HostedAutonomyResultV1;
  try {
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
    result = await runHostedAutonomy({
      state,
      githubFor,
      clock: { now: () => Date.now() },
    });
  } catch {
    result = failed("unexpected_failure", null);
  }
  return report(result);
}

/** The two reasons that mean the helper itself could not run safely. */
export function isHardAutonomyFailure(reason: HostedAutonomyReasonV1): boolean {
  return reason === "identity_rejected" || reason === "unexpected_failure";
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
