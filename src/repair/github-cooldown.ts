/**
 * m04-repair durable GitHub cooldown gate. Every authenticated request is
 * gated on the exact persisted cooldown for the affected installation scope: a
 * retained null deadline (manual fail-closed or unrepresentable value) or a
 * current time before the deadline is a normal rate_limited denial, and a
 * successful request never clears a cooldown. Observed limits are persisted
 * through strict expected-head compare-and-swap with exactly one write.
 *
 * The gate fails closed but not silently: any invalid input, clock anomaly,
 * missing/unreadable/unparseable state, failed, conflicting or ambiguous
 * write or unexpected throw permanently latches the instance; every later
 * call then returns the same sanitized unavailable error and no request is
 * gated open on trust. A normal rate_limited denial never latches.
 */

import {
  GITHUB_FALLBACK_MIN_BACKOFF_MS,
  parseGitHubRateLimitV1,
} from "../contracts/github-cooldown.ts";
import type {
  GitHubCooldownV1,
  GitHubRateLimitV1,
} from "../contracts/github-cooldown.ts";
import { parseRepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { portOk } from "../contracts/ports.ts";
import type {
  Clock,
  GitHubCooldownGateV1,
  PortResultV1,
  RepairStateWriter,
  StateReadView,
} from "../contracts/ports.ts";

/** Backoff index ceiling; a saturated index keeps the longest bounded duration. */
const MAX_FALLBACK_COUNT = 10;

const FAULT_DETAIL = "github cooldown gate faulted; state not trustworthy";
const RATE_LIMITED_DETAIL = "github cooldown active";

export class DurableGitHubCooldownGate implements GitHubCooldownGateV1 {
  private readonly state: StateReadView & RepairStateWriter;
  private readonly clock: Clock;
  private faulted = false;

  constructor(
    deps: { state: StateReadView & RepairStateWriter; clock: Clock },
  ) {
    this.state = deps.state;
    this.clock = deps.clock;
  }

  async beforeRequest(installationId: number): Promise<PortResultV1<void>> {
    if (this.faulted) return faultResult();
    try {
      if (!isNonNegativeSafeInteger(installationId)) return this.latch();
      const now = this.clock.now();
      if (!isNonNegativeSafeInteger(now)) return this.latch();

      const read = await this.state.readRepair();
      if (!read.ok) return this.latch();
      if (read.value.status !== "found") return this.latch();
      const snapshot = parseRepairStateSnapshotV1(read.value.snapshot);

      const cooldown = snapshot.githubCooldowns.find(
        (record) => record.installationId === installationId,
      );
      if (cooldown === undefined) return portOk(undefined);
      if (cooldown.retryNotBefore === null || now < cooldown.retryNotBefore) {
        return {
          ok: false,
          error: { kind: "rate_limited", detail: RATE_LIMITED_DETAIL },
        };
      }
      return portOk(undefined);
    } catch {
      return this.latch();
    }
  }

  async recordRateLimit(
    installationId: number,
    rateLimit: GitHubRateLimitV1,
  ): Promise<PortResultV1<void>> {
    if (this.faulted) return faultResult();
    try {
      if (!isNonNegativeSafeInteger(installationId)) return this.latch();
      // A caller-supplied plain object is re-validated through the strict
      // parser; the parsed result, never the raw input, is recorded.
      const rate = parseGitHubRateLimitV1(rateLimit);
      const now = this.clock.now();
      if (!isNonNegativeSafeInteger(now)) return this.latch();

      const read = await this.state.readRepair();
      if (!read.ok) return this.latch();
      if (read.value.status !== "found") return this.latch();
      const snapshot = parseRepairStateSnapshotV1(read.value.snapshot);

      const prior = snapshot.githubCooldowns.find(
        (record) => record.installationId === installationId,
      );
      const nextRecord = computeCooldown(installationId, prior, rate);
      if (prior !== undefined && sameCooldown(prior, nextRecord)) {
        return portOk(undefined);
      }

      const githubCooldowns = prior === undefined
        ? [...snapshot.githubCooldowns, nextRecord]
        : snapshot.githubCooldowns.map((record) =>
          record.installationId === installationId ? nextRecord : record
        );
      const next = parseRepairStateSnapshotV1({
        ...snapshot,
        stateHead: read.value.head,
        sequence: snapshot.sequence + 1,
        updatedAt: Math.max(now, snapshot.updatedAt),
        githubCooldowns,
      });

      const write = await this.state.writeRepair(next, read.value.head);
      if (!write.ok) return this.latch();
      if (write.value.status !== "applied") return this.latch();
      return portOk(undefined);
    } catch {
      return this.latch();
    }
  }

  private latch(): PortResultV1<void> {
    this.faulted = true;
    return faultResult();
  }
}

function faultResult(): PortResultV1<void> {
  return {
    ok: false,
    error: { kind: "unavailable", detail: FAULT_DETAIL },
  };
}

function isNonNegativeSafeInteger(value: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Merge of the old/incoming/computed deadlines; any null is fail-closed and
 * absorbs every other value — never a retry now, never silently lifted.
 */
function mergeDeadline(
  ...deadlines: readonly (number | null)[]
): number | null {
  let max: number | null = null;
  for (const deadline of deadlines) {
    if (deadline === null) return null;
    if (max === null || deadline > max) max = deadline;
  }
  return max;
}

/** Sum when still a representable deadline; null on overflow (manual). */
function safeSum(a: number, b: number): number | null {
  const sum = a + b;
  return Number.isSafeInteger(sum) ? sum : null;
}

function computeCooldown(
  installationId: number,
  prior: GitHubCooldownV1 | undefined,
  rate: GitHubRateLimitV1,
): GitHubCooldownV1 {
  const observedAt = prior === undefined
    ? rate.observedAt
    : Math.max(prior.observedAt, rate.observedAt);
  // The id always tracks the strictly newer observation; an equally-timed
  // duplicate keeps the already-persisted identity.
  const observationId = prior === undefined ||
      rate.observedAt > prior.observedAt
    ? rate.observationId
    : prior.observationId;
  const repeatsKnownObservation = prior !== undefined &&
    (rate.observationId === prior.observationId ||
      rate.observedAt <= prior.observedAt);

  let secondaryBackoff: number;
  let retryNotBefore: number | null;
  if (prior === undefined) {
    // First record: a fallback starts the bounded one-minute index; a hint
    // (primary or server-confirmed secondary) is index 0.
    if (rate.fallback) {
      secondaryBackoff = 1;
      retryNotBefore = mergeDeadline(
        rate.retryNotBefore,
        safeSum(rate.observedAt, GITHUB_FALLBACK_MIN_BACKOFF_MS),
      );
    } else {
      secondaryBackoff = 0;
      retryNotBefore = rate.retryNotBefore;
    }
  } else if (repeatsKnownObservation) {
    // Same identity or an older/equal observation: never escalate the fallback
    // index nor recompute; extend the deadline conservatively only.
    secondaryBackoff = prior.secondaryBackoff;
    retryNotBefore = mergeDeadline(prior.retryNotBefore, rate.retryNotBefore);
  } else if (rate.fallback) {
    // Distinct strictly later fallback: one more bounded index, exponential
    // duration from the prior index, merged with the incoming/old deadlines.
    const priorCount = prior.secondaryBackoff;
    secondaryBackoff = Math.min(priorCount + 1, MAX_FALLBACK_COUNT);
    const duration = GITHUB_FALLBACK_MIN_BACKOFF_MS *
      2 ** Math.min(priorCount, MAX_FALLBACK_COUNT);
    retryNotBefore = mergeDeadline(
      prior.retryNotBefore,
      rate.retryNotBefore,
      safeSum(rate.observedAt, duration),
    );
  } else {
    // Distinct strictly later hint: keeps the prior index.
    secondaryBackoff = prior.secondaryBackoff;
    retryNotBefore = mergeDeadline(prior.retryNotBefore, rate.retryNotBefore);
  }

  return {
    installationId,
    retryNotBefore,
    observedAt,
    observationId,
    secondaryBackoff,
  };
}

function sameCooldown(a: GitHubCooldownV1, b: GitHubCooldownV1): boolean {
  return a.installationId === b.installationId &&
    a.retryNotBefore === b.retryNotBefore &&
    a.observedAt === b.observedAt &&
    a.observationId === b.observationId &&
    a.secondaryBackoff === b.secondaryBackoff;
}
