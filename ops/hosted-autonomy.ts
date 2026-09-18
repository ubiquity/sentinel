/**
 * Bounded self-upkeep for the hosted supervisor, run FIRST inside the protected
 * maintenance job (before `prepare`, under the same `sentinel-repair` lock the
 * repair job holds), so its state changes are visible to that run's own
 * execution:
 *
 *  1. RETRY PASS — a work record blocked by one of the runtime's TRANSIENT
 *     failures (a model session that produced no trusted receipt or candidate,
 *     an exhausted attempt budget, exhausted review rounds, or a reservation
 *     identity that is already settled at the current base) is granted the
 *     smallest closed counter adjustment that makes its next admission an
 *     UNUSED reservation identity; a work-returning grant must also land
 *     strictly below the runtime's own implementation-attempt ceiling, because
 *     admission at or above that ceiling is refused outright. When every
 *     identity at the record's current base is already charged, the grant
 *     instead records the runtime's own base-refresh intent for the newest
 *     observed base, which is what supplies fresh identities. Each task may use
 *     at most `HOSTED_AUTONOMY_MAX_RETRIES` such grants, counted in the task's
 *     durable reservations (every purpose, including one still `reserved`), so
 *     no uncharged retry cycle exists and a task can never loop forever.
 *     Nothing is deleted or reset: the preserved `retries` counter, every
 *     charge, reservation, receipt, review and candidate stay exactly as they
 *     are, and only `attempts` is lowered by the grant.
 *
 *  2. DELIVERY PASS — a record whose exact reviewed head carries a completed
 *     review receipt with no unresolved P0/P1 (the runtime's own retained
 *     acceptance rule) and a successful deterministic check is delivered end to
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
import type { ReviewReceiptV1 } from "../src/contracts/review-receipt.ts";
import type { GitSha } from "../src/contracts/brands.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import { releaseRequestId } from "../src/repair/keys.ts";
import { githubGitAuthEnv } from "../src/host/local.ts";
import { createRepairStateStore, DenoGitRunner } from "../src/state/mod.ts";
import type {
  RepairStateWriter,
  StateReadView,
  StateWriteResultV1,
} from "../src/contracts/ports.ts";
import {
  ISSUE48_QUOTA_REMOTE_URL,
  ISSUE48_QUOTA_REPOSITORY,
  validateIssue48QuotaHostedIdentity,
} from "./issue48-review-quota-recovery.ts";

/** Snapshot work record, as read from the durable repair state. */
type HostedAutonomyRecordV1 = RepairStateSnapshotV1["work"][number];

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

/** The trusted publication identity of autonomously repaired pull requests. */
export const HOSTED_AUTONOMY_TRUSTED_AUTHOR = "github-actions[bot]";

/**
 * The exact transient blockers the retry pass may clear, with the step the
 * record returns to. A blocker outside this closed set is never touched.
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
    prefix: "model admission refused: duplicate",
    nextStep: "work",
  },
];

const API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_048_576;

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
  /** Current base-branch tip, or null when it cannot be read. */
  readBaseTip(): Promise<string | null>;
  /** True when the exact head carries a successful deterministic check. */
  hasSuccessfulCheck(head: string): Promise<boolean>;
  readPull(number: number): Promise<HostedAutonomyPullV1 | null>;
  /**
   * True when the source issue is open, false when it is closed or missing,
   * null when that cannot be read. Only a definitive false stops a retry.
   */
  readIssueOpen(number: number): Promise<boolean | null>;
  /** Expected-head merge; null on any refusal. */
  merge(
    number: number,
    head: string,
  ): Promise<{ merged: boolean; sha: string | null } | null>;
  /** Idempotent issue closure: true when the issue ends closed. */
  closeIssue(number: number): Promise<boolean>;
  /** Workflow-run ids parked for approval on exactly this commit. */
  listParkedRuns(head: string): Promise<number[]>;
  /** Approve one parked workflow run; true when the approval was accepted. */
  approveRun(id: number): Promise<boolean>;
}

export interface HostedAutonomyDepsV1 {
  state: StateReadView & RepairStateWriter;
  github: HostedAutonomyGitHubV1;
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
  if (record.intent.kind !== "implementation") return false;
  const requestId = record.intent.requestId;
  if (requestId === null || requestId === "") return false;
  return reservations.some((reservation) =>
    reservation.id === requestId && reservation.outcome !== "reserved"
  );
}

export interface RetryPlanV1 {
  id: string;
  grant: number;
  nextStep: "work" | "review";
  resetReviewRounds: boolean;
  /**
   * True when every attempt identity at the record's CURRENT base is already
   * charged, so the only way to admit another attempt is the runtime's own
   * deterministic base refresh: the plan persists that intent and the loop
   * republishes the candidate on the newest base, which gives fresh
   * reservation identities.
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
 */
export function planHostedRetries(
  snapshot: RepairStateSnapshotV1,
  now: number,
  baseTip: string | null = null,
  closedIssues: ReadonlySet<number> = new Set(),
): RetryPlanV1[] {
  const plans: RetryPlanV1[] = [];
  for (const record of snapshot.work) {
    if (record.nextStep !== "blocked") continue;
    // A task whose source issue is closed or gone is not repairable: retrying
    // it can only spend a model session on work that no longer exists.
    if (
      record.related.issueNumber !== null &&
      closedIssues.has(record.related.issueNumber)
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
      if (
        rule.nextStep === "work" &&
        remaining >= HOSTED_AUTONOMY_MAX_IMPLEMENTATION_ATTEMPTS
      ) {
        continue;
      }
      // The identity the runtime will charge is fixed by the counters AFTER
      // this grant: the loop admits corrections with purpose `retry`, and only
      // a zero-attempt record is admitted as `implementation`.
      const purpose = rule.nextStep === "review"
        ? "review_request"
        : remaining === 0
        ? "implementation"
        : "retry";
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
      // refresh is what gives an unused identity, and only a work-returning
      // rule may spend it: a review-returning grant has its own identity space
      // and never advances the base.
      const pr = record.target.pr;
      const head = record.target.head;
      const branch = record.target.branch;
      if (
        rule.nextStep !== "work" || pr === null || head === null ||
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
        grant: ceilingGrant,
        nextStep: rule.nextStep,
        resetReviewRounds: false,
        advanceBase: true,
        observedBase: baseTip,
        detail: `${blocker.kind}:${rule.prefix}:base-advance`,
      });
      continue;
    }
    plans.push({
      id: record.id,
      grant,
      nextStep: rule.nextStep,
      resetReviewRounds: rule.nextStep === "review",
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
          // every other counter) stays exactly as it was.
          attempts: record.counters.attempts - plan.grant,
          retries: record.counters.retries,
          reviewRounds: plan.resetReviewRounds
            ? 0
            : record.counters.reviewRounds,
        },
        updatedAt: now,
      };
    }),
  });
}

/**
 * The exact completed receipt the runtime's own release authorization requires:
 * same reviewer identity, exact PR/head/base binding, a result and completion
 * instant, zero uncounted findings and no unresolved P0/P1. P2/P3 stay future
 * work exactly as the plan states.
 */
function authorizingReceipt(
  snapshot: RepairStateSnapshotV1,
  repository: ReleaseRequestV1["target"]["repository"],
  pullRequest: number,
  head: string,
  base: string,
): ReviewReceiptV1 | null {
  const found = snapshot.reviews.find((review) =>
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
  return found ?? null;
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

/** Hosted releases that are accepted, keyed by the exact source they delivered. */
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
      `${release.request.source.pullRequest}:${release.request.source.head}`,
      release,
    );
  }
  return accepted;
}

/**
 * Records whose exact pull request and reviewed head are delivered by an
 * ACCEPTED hosted release, whose issue is still open and whose implementation
 * intent (when present) is provably settled. These are the tasks the runtime's
 * own closure step would finish; marking them done here is the same conclusion
 * from the same evidence, never an earlier one.
 */
export function planHostedClosures(
  snapshot: RepairStateSnapshotV1,
  released: ReadonlyMap<string, unknown>,
): { id: string; issueNumber: number }[] {
  const plans: { id: string; issueNumber: number }[] = [];
  for (const record of snapshot.work) {
    if (record.nextStep === "done") continue;
    const issueNumber = record.related.issueNumber;
    if (issueNumber === null) continue;
    const pullRequest = record.target.pr;
    const head = record.target.head;
    if (pullRequest === null || head === null) continue;
    if (!released.has(`${pullRequest}:${head}`)) continue;
    if (!intentClosable(record, snapshot.reservations)) continue;
    plans.push({ id: record.id, issueNumber });
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
  closedIssues: ReadonlySet<number>,
  closedUnmerged: ReadonlySet<string> = new Set(),
): { id: string; issueNumber: number }[] {
  const plans: { id: string; issueNumber: number }[] = [];
  for (const record of snapshot.work) {
    if (record.nextStep === "done") continue;
    const issueNumber = record.related.issueNumber;
    if (issueNumber === null || !closedIssues.has(issueNumber)) continue;
    if (record.target.pr === null) {
      // Existing behavior: only a non-blocked record that produced nothing is
      // parked; an already blocked record keeps its own blocker.
      if (record.nextStep === "blocked") continue;
      plans.push({ id: record.id, issueNumber });
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
    plans.push({ id: record.id, issueNumber });
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

  // ---- retry pass ---------------------------------------------------------
  // A task whose pull request is already merged or closed is delivered or
  // abandoned: retrying it would only spend model starts on a branch that can
  // no longer be published, so those plans are dropped before any write. A
  // pull that cannot be read is also not retried, but it is recorded as a read
  // failure rather than as the definitive not-open verdict it never was.
  let tip: string | null = null;
  try {
    tip = await deps.github.readBaseTip();
  } catch {
    tip = null;
  }
  // The closed-issue fact is collected for every record that is not done, not
  // only for blocked ones: the retirement pass needs it for a live record whose
  // source issue is already gone. The retry pass keeps consuming it for blocked
  // records exactly as before.
  const closedIssues = new Set<number>();
  for (const record of snapshot.work) {
    if (record.nextStep === "done") continue;
    const issueNumber = record.related.issueNumber;
    if (issueNumber === null) continue;
    let open: boolean | null = null;
    try {
      open = await deps.github.readIssueOpen(issueNumber);
    } catch {
      open = null;
    }
    if (open === false) closedIssues.add(issueNumber);
  }
  const planned = planHostedRetries(
    snapshot,
    deps.clock.now(),
    tip,
    closedIssues,
  );
  const plans: RetryPlanV1[] = [];
  for (const plan of planned) {
    const record = snapshot.work.find((item) => item.id === plan.id);
    const pullRequest = record?.target.pr ?? null;
    if (pullRequest === null) {
      plans.push(plan);
      continue;
    }
    let pull: HostedAutonomyPullV1 | null;
    try {
      pull = await deps.github.readPull(pullRequest);
    } catch {
      pull = null;
    }
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
  // exact reviewed head; the check itself stays credential-free and unchanged.
  for (const record of snapshot.work) {
    if (!deliveryEligible(record)) {
      continue;
    }
    const head = record.target.head;
    if (head === null || record.target.pr === null) continue;
    let parked: number[] = [];
    try {
      parked = await deps.github.listParkedRuns(head);
    } catch {
      parked = [];
    }
    for (const id of parked.slice(0, 3)) {
      let approved = false;
      try {
        approved = await deps.github.approveRun(id);
      } catch {
        approved = false;
      }
      actions.push(
        `approve:${record.id}:run=${id}:${approved ? "approved" : "refused"}`,
      );
    }
  }

  // ---- delivery pass ------------------------------------------------------
  let baseTip: string | null;
  try {
    baseTip = await deps.github.readBaseTip();
  } catch {
    baseTip = null;
  }
  if (baseTip === null) {
    return actions.length > 0
      ? skipped("retried", observedHead, actions)
      : skipped("base_moved", observedHead, actions);
  }

  for (const record of snapshot.work) {
    if (!deliveryEligible(record)) {
      continue;
    }
    const pullRequest = record.target.pr;
    const head = record.target.head;
    const base = record.target.base;
    if (pullRequest === null || head === null || base === null) continue;
    const receipt = authorizingReceipt(
      snapshot,
      record.repository,
      pullRequest,
      head,
      base,
    );
    if (receipt === null) continue;
    if (
      snapshot.releaseRequests.some((request) =>
        request.source.pullRequest === pullRequest &&
        request.source.head === head && request.source.base === base &&
        request.target.environment === "production"
      )
    ) {
      actions.push(`delivery:${record.id}:already_recorded`);
      continue;
    }
    let pull: HostedAutonomyPullV1 | null;
    try {
      pull = await deps.github.readPull(pullRequest);
    } catch {
      pull = null;
    }
    if (pull === null || pull.headSha !== head) continue;
    if (pull.author !== HOSTED_AUTONOMY_TRUSTED_AUTHOR) {
      actions.push(`delivery:${record.id}:foreign_author`);
      continue;
    }

    let revision: string | null = null;
    if (pull.state === "open" && pull.merged === false) {
      // The base must be exactly the reviewed base, and the deterministic check
      // must already have succeeded on the exact head.
      if (baseTip !== base) {
        actions.push(`delivery:${record.id}:base_moved`);
        continue;
      }
      let green: boolean;
      try {
        green = await deps.github.hasSuccessfulCheck(head);
      } catch {
        green = false;
      }
      if (!green) {
        actions.push(`delivery:${record.id}:checks_pending`);
        continue;
      }
      let merged: { merged: boolean; sha: string | null } | null;
      try {
        merged = await deps.github.merge(pullRequest, head);
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
      let after: HostedAutonomyPullV1 | null;
      try {
        after = await deps.github.readPull(pullRequest);
      } catch {
        after = null;
      }
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
    if (issueNumber === null || !closedIssues.has(issueNumber)) continue;
    const pullRequest = record.target.pr;
    if (pullRequest === null) continue;
    let pull: HostedAutonomyPullV1 | null;
    try {
      pull = await deps.github.readPull(pullRequest);
    } catch {
      pull = null;
    }
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
    return {
      kind: "hosted_autonomy",
      status: "applied",
      reason: "retired_records",
      beforeHead: observedHead,
      appliedHead: write.value.head,
      actions,
      revisions,
    };
  }
  const closures = planHostedClosures(snapshot, released).slice(0, 5);
  if (closures.length > 0) {
    for (const plan of closures) {
      let closed = false;
      try {
        closed = await deps.github.closeIssue(plan.issueNumber);
      } catch {
        closed = false;
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

/** Live GitHub surface this helper needs, over one repository token. */
export function createHostedAutonomyGitHub(
  token: string,
): HostedAutonomyGitHubV1 {
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
  ): Promise<HostedAutonomyPullV1 | null> {
    const pull = await request(
      "GET",
      `/repos/${ISSUE48_QUOTA_REPOSITORY}/pulls/${number}`,
    );
    const parsed = parseHostedAutonomyPull(pull);
    if (parsed === null || parsed.merged !== true) return parsed;
    const mergeCommitSha = parsed.mergeCommitSha;
    if (mergeCommitSha === null) return null;
    let parents: string[] = [];
    let revisionOnBaseBranch = false;
    const commit = await request(
      "GET",
      `/repos/${ISSUE48_QUOTA_REPOSITORY}/commits/${mergeCommitSha}`,
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
      `/repos/${ISSUE48_QUOTA_REPOSITORY}/compare/${mergeCommitSha}...${HOSTED_AUTONOMY_BASE_BRANCH}`,
    );
    revisionOnBaseBranch = revisionIntegratedIntoBase(
      compare,
      mergeCommitSha,
    );
    return { ...parsed, parents, revisionOnBaseBranch };
  }

  return {
    async readBaseTip() {
      const ref = await request(
        "GET",
        `/repos/${ISSUE48_QUOTA_REPOSITORY}/git/ref/heads/${HOSTED_AUTONOMY_BASE_BRANCH}`,
      );
      if (ref === null || typeof ref !== "object") return null;
      const object = (ref as Record<string, unknown>)["object"];
      if (object === null || typeof object !== "object") return null;
      const sha = (object as Record<string, unknown>)["sha"];
      return typeof sha === "string" ? sha : null;
    },
    async hasSuccessfulCheck(head: string) {
      const runs = await request(
        "GET",
        `/repos/${ISSUE48_QUOTA_REPOSITORY}/commits/${head}/check-runs?per_page=100`,
      );
      const list = runs !== null && typeof runs === "object"
        ? (runs as Record<string, unknown>)["check_runs"]
        : null;
      if (!Array.isArray(list)) return false;
      return list.some((item) =>
        typeof item === "object" && item !== null &&
        (item as Record<string, unknown>)["name"] ===
          HOSTED_AUTONOMY_REQUIRED_CHECK &&
        (item as Record<string, unknown>)["head_sha"] === head &&
        (item as Record<string, unknown>)["status"] === "completed" &&
        (item as Record<string, unknown>)["conclusion"] === "success"
      );
    },
    readPull,
    async listParkedRuns(head: string) {
      const runs = await request(
        "GET",
        `/repos/${ISSUE48_QUOTA_REPOSITORY}/actions/runs?head_sha=${head}&per_page=50`,
      );
      const list = runs !== null && typeof runs === "object"
        ? (runs as Record<string, unknown>)["workflow_runs"]
        : null;
      if (!Array.isArray(list)) return [];
      return list
        .filter((item) =>
          typeof item === "object" && item !== null &&
          (item as Record<string, unknown>)["head_sha"] === head &&
          (item as Record<string, unknown>)["conclusion"] === "action_required"
        )
        .map((item) => Number((item as Record<string, unknown>)["id"]))
        .filter((id) => Number.isSafeInteger(id) && id > 0);
    },
    async approveRun(id: number) {
      const approved = await request(
        "POST",
        `/repos/${ISSUE48_QUOTA_REPOSITORY}/actions/runs/${id}/approve`,
      );
      return approved !== null;
    },
    async readIssueOpen(number: number) {
      const issue = await request(
        "GET",
        `/repos/${ISSUE48_QUOTA_REPOSITORY}/issues/${number}`,
      );
      if (issue === null || typeof issue !== "object") return null;
      const state = (issue as Record<string, unknown>)["state"];
      if (state === "open") return true;
      if (state === "closed") return false;
      return null;
    },
    async closeIssue(number: number) {
      const closed = await request(
        "PATCH",
        `/repos/${ISSUE48_QUOTA_REPOSITORY}/issues/${number}`,
        { state: "closed" },
      );
      if (closed === null || typeof closed !== "object") return false;
      return (closed as Record<string, unknown>)["state"] === "closed";
    },
    async merge(number: number, head: string) {
      const response = await request(
        "PUT",
        `/repos/${ISSUE48_QUOTA_REPOSITORY}/pulls/${number}/merge`,
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
  const token = readEnv("GITHUB_TOKEN");
  if (token === null || token.length === 0) {
    return report(failed("identity_rejected", null));
  }
  let result: HostedAutonomyResultV1;
  try {
    const scratch = `${Deno.cwd()}/.hosted-autonomy`;
    Deno.mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const runner = new DenoGitRunner(
      `${scratch}/git-home`,
      githubGitAuthEnv(token),
    );
    const state = createRepairStateStore({
      scratchDir: `${scratch}/state`,
      remoteUrl: ISSUE48_QUOTA_REMOTE_URL,
      runner,
    });
    result = await runHostedAutonomy({
      state,
      github: createHostedAutonomyGitHub(token),
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
