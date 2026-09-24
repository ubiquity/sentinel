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
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";

/** One implementation writer globally; at most three unfinished target PRs. */
export const MAX_UNFINISHED_PRS = 3;

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
 * no remaining intent or wait. Only this exact shape is exempt; arbitrary
 * blocked, open or waiting PRs keep consuming the cap.
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
 * Counted unfinished target pull requests. The selection gate and the publish
 * gate MUST agree: a fresh publication is admitted only while this count is
 * under MAX_UNFINISHED_PRS, and a trusted retirement never consumes a slot.
 */
export function countUnfinishedPullRequests(
  work: readonly WorkRecordV1[],
): number {
  return work.filter((record) =>
    record.target.pr !== null && record.nextStep !== "done" &&
    !isRetiredTargetRecord(record)
  ).length;
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
  const openPrCount = countUnfinishedPullRequests(snapshot.work);
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
    if (isWaiting(record, now)) {
      skipped[record.id] = "waiting";
      continue;
    }
    if (!dependenciesDone(record, snapshot)) {
      skipped[record.id] = "dependency";
      continue;
    }
    if (record.target.pr === null && openPrCount >= MAX_UNFINISHED_PRS) {
      skipped[record.id] = "wip";
      continue;
    }
    if (!byRepository.has(repoKey(record.repository))) {
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
 * a blocker — and the plan buckets, the ranking tie-breakers and the
 * unfinished-PR cap are unchanged.
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
