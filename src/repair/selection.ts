/**
 * m04-repair: deterministic selection. Pure ranking of eligible work records
 * into the plan's fixed priority order: delivery bookkeeping first, then
 * active incidents (impact/severity and oldest first_seen), P0/P1 correction,
 * reproducible unresolved 5xx, existing Sentinel PR repairs, then issues and
 * nonblocking backlog by recognized numeric priority and oldest first (missing
 * priority last, highest duplicate recognized label already resolved at
 * intake). Finish order is stable: repository, then source identity, then
 * work id — never time-based or list-order selection. Blocked, terminal and
 * actively waiting records are skipped without blocking unrelated work, and a
 * task whose dependencies have not completed is not eligible.
 */

import type { WorkItemId } from "../contracts/brands.ts";
import {
  type LiveStartLimitsV1,
  type RepositoryConfigV1,
  resolveGlobalLiveStartLimits,
} from "../contracts/repository-config.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";

/**
 * Exact hosted-retirement blocker. The hosted autonomy pass records it only
 * after the source issue AND its pull request are closed unmerged, so the
 * record no longer holds an open target PR.
 */
export const RETIRED_TARGET_MESSAGE =
  "source issue is closed; the repair no longer exists";

/**
 * Exact blocker for a repair whose own pull request was merged outside the
 * trusted review path (a human merge): the PR is not unfinished work, so the
 * record is terminal for capacity purposes and must never be republished.
 */
export const RETIRED_MERGED_MESSAGE =
  "pull request was merged outside the trusted review path";

/**
 * A trusted hosted retirement: the exact blocker above, still blocked, with
 * no remaining intent or wait. It is a subset of the terminal blocks below and
 * is retained as an explicit, independently testable identity.
 */
export function isRetiredTargetRecord(record: WorkRecordV1): boolean {
  const message = record.blocker?.message;
  return record.nextStep === "blocked" &&
    record.blocker?.kind === "other" &&
    (message === RETIRED_TARGET_MESSAGE ||
      message === RETIRED_MERGED_MESSAGE) &&
    record.intent === null &&
    record.wait === null;
}

/**
 * A terminal block. A blocked record is skipped by every lifecycle phase and
 * can never deliver its pull request. The historical three known offenders
 * (`issue-ubiquity-sentinel-79`/PR 83, `issue-ubiquity-sentinel-80`/PR 84 and
 * `issue-ubiquity-ai.ubq.fi-138`/PR 499) are exactly this shape and previously
 * wedged the retired unfinished-PR cap permanently.
 */
export function isTerminalBlock(record: WorkRecordV1): boolean {
  return record.nextStep === "blocked";
}

/**
 * The explicit TRANSIENT quota-exhausted / awaiting-review state: a wait
 * carrying the dedicated `review_quota` reason. Distinct from a terminal
 * block — the record is still live, keeps producing/updating its publication
 * and is retroactively drained by the review pass when quota returns.
 */
export function isReviewQuotaWait(record: WorkRecordV1): boolean {
  return record.wait?.reason === "review_quota";
}

/** A live record parked in the transient review-quota state. */
export function isTransientReviewQuota(record: WorkRecordV1): boolean {
  return record.nextStep !== "done" && record.nextStep !== "blocked" &&
    isReviewQuotaWait(record);
}

/**
 * Durable published identity. In addition to the stored PR number, an in-flight
 * `pull_request`/`push` intent that names its deterministic branch (and any
 * intent that already persisted a PR number) proves the record is recovering
 * an EXISTING publication, so its live PR is attached instead of being
 * republished (issue-141 / PR 433).
 */
export function hasPublishedIdentity(record: WorkRecordV1): boolean {
  if (record.target.pr !== null) return true;
  const intent = record.intent;
  if (intent === null) return false;
  if (intent.pr !== null) return true;
  return intent.branch !== null &&
    (intent.kind === "pull_request" || intent.kind === "push");
}

/**
 * Counted unfinished target pull requests. Retained as exact accounting for
 * reporting and reconciliation; it is no longer an admission authority on any
 * surface. A terminal block and a transient review-quota record never count,
 * and every counted record is one whose real PR this pipeline still owns.
 */
export function countUnfinishedPullRequests(
  work: readonly WorkRecordV1[],
): number {
  return work.filter((record) =>
    record.target.pr !== null && record.nextStep !== "done" &&
    !isTerminalBlock(record) && !isTransientReviewQuota(record)
  ).length;
}

/**
 * The review-drain pass selection: every live record parked in the transient
 * `review_quota` state, ordered highest priority first and then oldest first.
 * A record with no recognized numeric priority sorts after one that has it;
 * ties fall back to the stable identity tie-break (never time or list order).
 */
export function rankReviewDrain(
  snapshot: RepairStateSnapshotV1,
): WorkItemId[] {
  return snapshot.work
    .filter((record) =>
      isTransientReviewQuota(record) &&
      dependenciesDone(record, snapshot)
    )
    .sort((a, b) => compareKeys(drainKey(a), drainKey(b)))
    .map((record) => record.id);
}

/**
 * Drain ordering key: highest recognized numeric priority first, missing
 * priority last, then the oldest first-seen (created) instant, then the stable
 * identity tie-break. Mirrors the backlog bucket's priority key so the drain
 * never reinvents a different order.
 */
function drainKey(record: WorkRecordV1): string[] {
  return [priorityKey(record), zeroPad(oldestSeen(record)), tie(record)];
}

function priorityKey(record: WorkRecordV1): string {
  return record.classification.priority === null
    ? "9".repeat(20)
    : zeroPad(Number.MAX_SAFE_INTEGER - record.classification.priority);
}

function oldestSeen(record: WorkRecordV1): number {
  return record.firstSeenAt ?? record.createdAt;
}

export interface RankedWorkV1 {
  /** Deterministic priority order; index 0 is the next eligible action. */
  ordered: WorkItemId[];
  /** Exact skip reason per non-eligible record (never dropped silently). */
  skipped: Record<string, string>;
}

/** A record is waiting when its explicit wait has not elapsed. */
export function isWaiting(record: WorkRecordV1, now: number): boolean {
  if (record.wait === null) return false;
  if (record.wait.until === null) return true;
  return now < record.wait.until;
}

/**
 * True only when the complete supplied configuration set resolves to one
 * enabled policy whose BOTH rolling caps are explicitly null. A missing,
 * wholly null, conflicting or numeric policy is never uncapped: a null
 * `liveStartLimits` record still means inference is not enabled, and every
 * existing wait rule stays in force.
 */
export function isExplicitlyUncappedPolicy(
  configs: readonly RepositoryConfigV1[],
): boolean {
  const policy = resolveGlobalLiveStartLimits(configs);
  return policy.status === "enabled" &&
    policy.limits.perHour === null &&
    policy.limits.perSevenDays === null;
}

/**
 * A stored wait caused solely by a retired artificial rolling cap: the exact
 * `budget_cap` reason recorded when admission deferred on `retryAt`. Under an
 * explicitly fully uncapped policy no rolling window can defer a start, so
 * that wait is obsolete and may be reconsidered without touching the record's
 * charges, counters or identity. Every other wait class (provider, backoff,
 * manual, dependency, evidence, active operation) keeps its existing expiry
 * rules.
 */
export function isRetiredBudgetWait(
  record: WorkRecordV1,
  limits: LiveStartLimitsV1 | null | undefined,
): boolean {
  if (record.wait?.reason !== "budget_cap") return false;
  if (limits === null || limits === undefined) return false;
  return limits.perHour === null && limits.perSevenDays === null;
}

/** A record is eligible for deterministic/lifecycle work at `now`. */
export function isEligible(
  record: WorkRecordV1,
  snapshot: RepairStateSnapshotV1,
  now: number,
): boolean {
  if (record.nextStep === "done" || record.nextStep === "blocked") return false;
  if (isWaiting(record, now)) return false;
  if (!dependenciesDone(record, snapshot)) return false;
  return true;
}

function dependenciesDone(
  record: WorkRecordV1,
  snapshot: RepairStateSnapshotV1,
): boolean {
  for (const dependency of record.dependencies) {
    const dep = snapshot.work.find((work) => work.id === dependency);
    if (dep === undefined || dep.nextStep !== "done") return false;
  }
  return true;
}

/**
 * Fully eligible ranking for one snapshot. `now` decides wait expiry only;
 * selection itself is never time-dependent.
 */
export function rankEligibleWork(
  snapshot: RepairStateSnapshotV1,
  configs: readonly RepositoryConfigV1[],
  now: number,
): RankedWorkV1 {
  const uncappedPolicy = isExplicitlyUncappedPolicy(configs);
  const byRepository = new Map(
    configs.map((config) => [repoKey(config.repository), config] as const),
  );
  const ranked: { record: WorkRecordV1; key: string[] }[] = [];
  const skipped: Record<string, string> = {};

  for (const record of snapshot.work) {
    if (record.nextStep === "done") {
      skipped[record.id] = "terminal";
      continue;
    }
    if (record.nextStep === "blocked") {
      skipped[record.id] = "blocked";
      continue;
    }
    const config = byRepository.get(repoKey(record.repository));
    // A legacy budget-only wait is obsolete under an explicitly fully
    // uncapped policy; every other wait keeps its existing expiry rule.
    if (
      isWaiting(record, now) &&
      !(uncappedPolicy &&
        isRetiredBudgetWait(record, config?.liveStartLimits))
    ) {
      skipped[record.id] = "waiting";
      continue;
    }
    if (!dependenciesDone(record, snapshot)) {
      skipped[record.id] = "dependency";
      continue;
    }
    if (config === undefined) {
      skipped[record.id] = "unconfigured";
      continue;
    }
    ranked.push({ record, key: scoreKey(record, now) });
  }

  ranked.sort((a, b) => compareKeys(a.key, b.key));

  return {
    ordered: ranked.map((entry) => entry.record.id),
    skipped,
  };
}

/**
 * Per-record no-progress budget. An execution that advanced nothing durable
 * increments the record's `stalled` counter; at this budget the record is
 * demoted inside its own plan bucket so an oldest-first queue head can never
 * starve younger eligible work. It stays eligible — demotion is ordering, not
 * a blocker — and the plan buckets and ranking tie-breakers are unchanged.
 */
export const NO_PROGRESS_BUDGET = 3;

/**
 * Lexicographic priority key. The first element is the fixed plan bucket; the
 * second is the no-progress demotion tier (records that spent the budget come
 * after records that did not); later elements are the documented tie-breakers.
 * Compare lower-first.
 */
function scoreKey(record: WorkRecordV1, now: number): string[] {
  const bucket = planBucket(record, now);
  const severityOrder = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const oldest = record.firstSeenAt ?? record.createdAt;
  const demoted = (record.counters.stalled ?? 0) >= NO_PROGRESS_BUDGET
    ? "1"
    : "0";
  switch (bucket) {
    case 0: {
      // Delivery bookkeeping: outstanding merges/closure first, oldest last
      // update first; the same bucket never races a new repair.
      return [`0`, demoted, zeroPad(record.updatedAt), tie(record)];
    }
    case 1: {
      // Active incidents: severity, then oldest first seen.
      return [
        `1`,
        demoted,
        String(severityOrder[record.classification.severity]),
        zeroPad(oldest),
        tie(record),
      ];
    }
    case 2: {
      // P0/P1 corrections: severity, then oldest.
      return [
        `2`,
        demoted,
        String(severityOrder[record.classification.severity]),
        zeroPad(oldest),
        tie(record),
      ];
    }
    case 3: {
      return [`3`, demoted, zeroPad(oldest), tie(record)];
    }
    case 4: {
      return [`4`, demoted, zeroPad(record.createdAt), tie(record)];
    }
    default: {
      // Issues/backlog: highest recognized numeric priority, missing last,
      // then oldest; stable repository/source identity breaks any tie.
      // String-safe ordering: fixed-width ascending keys, missing = maximum.
      const priorityKey = record.classification.priority === null
        ? "9".repeat(20)
        : zeroPad(Number.MAX_SAFE_INTEGER - record.classification.priority);
      return [
        `5`,
        demoted,
        priorityKey,
        zeroPad(oldest),
        tie(record),
      ];
    }
  }
}

/**
 * Plan priority buckets, in delivery order. Pending-review observation is
 * delivery bookkeeping: a task whose review wait elapsed is processed before
 * any new repair starts, exactly once.
 */
function planBucket(record: WorkRecordV1, now: number): number {
  if (
    record.nextStep === "delivery" ||
    (record.nextStep === "review" && !isWaiting(record, now))
  ) {
    return 0;
  }
  if (
    record.urgency.activeProduction || record.urgency.severeSecurityOrDataLoss
  ) {
    return 1;
  }
  const severity = record.classification.severity;
  if (severity === "P0" || severity === "P1") return 2;
  if (record.urgency.reproducible5xx) return 3;
  if (record.source.kind === "review_backlog") return 4;
  return 5;
}

/** Stable repository/source tie-break: no selection by time or list order. */
function tie(record: WorkRecordV1): string {
  return zeroPadString([
    record.repository.owner,
    record.repository.name,
    record.source.id,
    record.id,
  ].join("\u0000"));
}

function zeroPad(timestamp: number): string {
  return String(timestamp).padStart(20, "0");
}

function zeroPadString(value: string): string {
  return value;
}

function compareKeys(a: string[], b: string[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const left = a[index] ?? "";
    const right = b[index] ?? "";
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Scope identity for configured-repository matching: the same owner/name
 * under a different installation (App or the explicit no-App local scope 0)
 * is a different scope and must never authorize a record through another
 * scope's configuration. Sorting tie keys are unchanged.
 */
function repoKey(repository: {
  owner: string;
  name: string;
  installationId: number;
}): string {
  return `${repository.installationId}\u0000${repository.owner}/${repository.name}`;
}
