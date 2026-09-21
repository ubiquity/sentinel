/**
 * Hosted cross-role durable cooldown gates. The hosted supervisor holds only
 * the release-state write capability and the repair role only the repair-state
 * write capability, so neither can persist into the other's ref. Each role
 * records the exact observation it saw in its own ref, while every hosted
 * request is checked against the strictest scope-0 hold found in either ref.
 * The effective hold therefore survives a restart and is never shortened by a
 * less strict observation recorded by the other role.
 *
 * Both gates are fail-closed: a wrong scope, a bad clock, absent, unreadable or
 * unparseable state, or an unknown persistence outcome (failed, conflicting,
 * ambiguous or thrown) permanently latches the instance; a normal
 * rate_limited denial never latches.
 */

import type { GitSha } from "../contracts/brands.ts";
import { parseGitHubRateLimitV1 } from "../contracts/github-cooldown.ts";
import type {
  GitHubCooldownV1,
  GitHubRateLimitV1,
} from "../contracts/github-cooldown.ts";
import { portOk } from "../contracts/ports.ts";
import type {
  Clock,
  GitHubCooldownGateV1,
  PortResultV1,
  ReleaseStateWriter,
  RepairStateWriter,
  StateReadView,
} from "../contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import {
  computeCooldown,
  DurableGitHubCooldownGate,
} from "../repair/github-cooldown.ts";

/** Hosted composition is fixed to the explicit no-App self scope. */
const HOSTED_SCOPE = 0;

const FAULT_DETAIL = "hosted cooldown gate faulted; state not trustworthy";
const RATE_LIMITED_DETAIL = "github cooldown active";

/**
 * Release-role gate: reads both strict snapshots for the effective hold and
 * persists only its own release-role record through expected-head CAS.
 */
export class HostedSupervisorCooldownGate implements GitHubCooldownGateV1 {
  private readonly state: StateReadView & ReleaseStateWriter;
  private readonly clock: Clock;
  private faulted = false;

  constructor(
    deps: { state: StateReadView & ReleaseStateWriter; clock: Clock },
  ) {
    this.state = deps.state;
    this.clock = deps.clock;
  }

  async beforeRequest(installationId: number): Promise<PortResultV1<void>> {
    if (this.faulted) return faultResult();
    try {
      if (installationId !== HOSTED_SCOPE) return this.latch();
      const now = this.clock.now();
      if (!isNonNegativeSafeInteger(now)) return this.latch();

      const release = await readReleaseStrict(this.state);
      if (release === null) return this.latch();
      const repair = await readRepairStrict(this.state);
      if (repair === null) return this.latch();

      // A hold from either ref blocks; checking never erases a hold.
      const blocked = [
        ...release.snapshot.githubCooldowns,
        ...repair.githubCooldowns,
      ].some((record) =>
        record.installationId === HOSTED_SCOPE &&
        (record.retryNotBefore === null || now < record.retryNotBefore)
      );
      return blocked ? rateLimitedResult() : portOk(undefined);
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
      if (installationId !== HOSTED_SCOPE) return this.latch();
      // A caller-supplied object is re-validated through the strict parser.
      const rate = parseGitHubRateLimitV1(rateLimit);
      const now = this.clock.now();
      if (!isNonNegativeSafeInteger(now)) return this.latch();

      const release = await readReleaseStrict(this.state);
      if (release === null) return this.latch();
      const repair = await readRepairStrict(this.state);
      if (repair === null) return this.latch();

      const own = release.snapshot.githubCooldowns.find(
        (record) => record.installationId === HOSTED_SCOPE,
      );
      const foreign = repair.githubCooldowns.find(
        (record) => record.installationId === HOSTED_SCOPE,
      );
      // The existing pure policy runs on the own-role prior first, then the
      // other ref's hold is incorporated conservatively.
      const nextRecord = mergeCooldownHold(
        computeCooldown(HOSTED_SCOPE, own, rate),
        foreign,
      );
      // Only an own record already at least as strict needs no write; anything
      // stricter, including a newly incorporated foreign hold, is persisted.
      if (own !== undefined && sameCooldown(own, nextRecord)) {
        return portOk(undefined);
      }

      const githubCooldowns = own === undefined
        ? [...release.snapshot.githubCooldowns, nextRecord]
        : release.snapshot.githubCooldowns.map((record) =>
          record.installationId === HOSTED_SCOPE ? nextRecord : record
        );
      const next = parseReleaseStateSnapshotV1({
        ...release.snapshot,
        stateHead: release.head,
        sequence: release.snapshot.sequence + 1,
        updatedAt: Math.max(now, release.snapshot.updatedAt),
        githubCooldowns,
      });
      const write = await this.state.writeRelease(next, release.head);
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

/**
 * Repair-role gate: composes the existing durable repair gate and additionally
 * checks the release ref's scope-0 hold before every request. It never writes
 * release state and never adapts the supervisor's store into a repair writer.
 */
export class HostedRepairCooldownGate implements GitHubCooldownGateV1 {
  private readonly state: StateReadView & RepairStateWriter;
  private readonly clock: Clock;
  private readonly inner: DurableGitHubCooldownGate;
  private faulted = false;

  constructor(
    deps: { state: StateReadView & RepairStateWriter; clock: Clock },
  ) {
    this.state = deps.state;
    this.clock = deps.clock;
    this.inner = new DurableGitHubCooldownGate(deps);
  }

  /**
   * Every committed target is gated under its own scope: the sentinel
   * self-target uses the reserved no-App scope 0 and a foreign target uses the
   * App installation scope that can actually write to it. Any valid
   * non-negative integer is therefore accepted and passed through to the
   * durable per-scope gate; only a malformed value is a refusal.
   *
   * The release ref's scope-0 hold is a DEPLOYMENT-wide hold, so it still
   * blocks every scope: a hold recorded against the self scope stops the whole
   * run, foreign targets included. A hold for one foreign target does not block
   * another target, because the inner gate keeps one record per scope.
   */
  async beforeRequest(installationId: number): Promise<PortResultV1<void>> {
    if (this.faulted) return faultResult();
    try {
      if (!isNonNegativeSafeInteger(installationId)) return this.latch();
      const now = this.clock.now();
      if (!isNonNegativeSafeInteger(now)) return this.latch();

      const release = await readReleaseStrict(this.state);
      if (release === null) return this.latch();
      const blocked = release.snapshot.githubCooldowns.some((record) =>
        record.installationId === HOSTED_SCOPE &&
        (record.retryNotBefore === null || now < record.retryNotBefore)
      );
      if (blocked) return rateLimitedResult();

      return await this.delegate(this.inner.beforeRequest(installationId));
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
      // Repair-owned recording only; the release ref is never written here.
      // The record is written for the scope that actually hit the limit, so a
      // foreign target's rate limit never masks or blocks the self scope.
      return await this.delegate(
        this.inner.recordRateLimit(installationId, rateLimit),
      );
    } catch {
      return this.latch();
    }
  }

  /** A normal rate_limited denial passes through; every fault latches. */
  private async delegate(
    result: Promise<PortResultV1<void>>,
  ): Promise<PortResultV1<void>> {
    const settled = await result;
    if (settled.ok) return settled;
    if (settled.error.kind === "rate_limited") return settled;
    return this.latch();
  }

  private latch(): PortResultV1<void> {
    this.faulted = true;
    return faultResult();
  }
}

interface StrictReleaseReadV1 {
  snapshot: ReleaseStateSnapshotV1;
  head: GitSha;
}

async function readReleaseStrict(
  state: StateReadView,
): Promise<StrictReleaseReadV1 | null> {
  const read = await state.readRelease();
  if (!read.ok) return null;
  if (read.value.status !== "found") return null;
  try {
    return {
      snapshot: parseReleaseStateSnapshotV1(read.value.snapshot),
      head: read.value.head,
    };
  } catch {
    return null;
  }
}

async function readRepairStrict(
  state: StateReadView,
): Promise<RepairStateSnapshotV1 | null> {
  const read = await state.readRepair();
  if (!read.ok) return null;
  if (read.value.status !== "found") return null;
  try {
    return parseRepairStateSnapshotV1(read.value.snapshot);
  } catch {
    return null;
  }
}

/**
 * Conservative combination of the freshly computed own-role record with the
 * other ref's prior record: a null deadline absorbs every value, deadlines and
 * fallback indices only grow, and the newer observation keeps its identity, so
 * the merged record is never less strict than either input.
 */
function mergeCooldownHold(
  next: GitHubCooldownV1,
  foreign: GitHubCooldownV1 | undefined,
): GitHubCooldownV1 {
  if (foreign === undefined) return next;
  const retryNotBefore = next.retryNotBefore === null ||
      foreign.retryNotBefore === null
    ? null
    : Math.max(next.retryNotBefore, foreign.retryNotBefore);
  return {
    installationId: HOSTED_SCOPE,
    retryNotBefore,
    observedAt: Math.max(next.observedAt, foreign.observedAt),
    observationId: foreign.observedAt > next.observedAt
      ? foreign.observationId
      : next.observationId,
    secondaryBackoff: Math.max(next.secondaryBackoff, foreign.secondaryBackoff),
  };
}

function sameCooldown(a: GitHubCooldownV1, b: GitHubCooldownV1): boolean {
  return a.installationId === b.installationId &&
    a.retryNotBefore === b.retryNotBefore &&
    a.observedAt === b.observedAt &&
    a.observationId === b.observationId &&
    a.secondaryBackoff === b.secondaryBackoff;
}

function rateLimitedResult(): PortResultV1<void> {
  return {
    ok: false,
    error: { kind: "rate_limited", detail: RATE_LIMITED_DETAIL },
  };
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
