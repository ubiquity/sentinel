/**
 * Hosted cross-role durable cooldown gates. The hosted supervisor holds only
 * the release-state write capability and the repair role only the repair-state
 * write capability, so neither can persist into the other's ref. Each role
 * records the exact observation it saw in its own ref, while every hosted
 * request is checked against the strictest scope-0 hold found in either ref.
 * The effective hold therefore survives a restart and is never shortened by a
 * less strict observation recorded by the other role.
 *
 * Both gates are fail-closed but never freeze: a wrong scope, a bad clock,
 * absent, unreadable or unparseable state, or an unknown persistence outcome
 * refuses every request for a BOUNDED window and is then re-checked against
 * the real state, with the closed fault identity in the error detail. Only an
 * unreadable clock — which no later read can repair — stays sticky. A normal
 * rate_limited denial never faults.
 */

import type { GitSha } from "../contracts/brands.ts";
import { parseGitHubRateLimitV1 } from "../contracts/github-cooldown.ts";
import type {
  GitHubCooldownV1,
  GitHubRateLimitV1,
} from "../contracts/github-cooldown.ts";
import {
  type CooldownModeV1,
  DEFAULT_COOLDOWN_MODE,
} from "../contracts/cooldown-mode.ts";
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
/** Bounded fail-closed window: refuse, then re-read the real state. */
const FAULT_WINDOW_MS = 60_000;
const FAULT_SCOPE = "hosted cooldown gate faulted: scope invalid";
const FAULT_CLOCK = "hosted cooldown gate faulted: clock invalid";
const FAULT_RELEASE_STATE =
  "hosted cooldown gate faulted: release state unavailable";
const FAULT_RELEASE_SHAPE =
  "hosted cooldown gate faulted: release state unparseable";
const FAULT_REPAIR_STATE =
  "hosted cooldown gate faulted: repair state unavailable";
const FAULT_REPAIR_SHAPE =
  "hosted cooldown gate faulted: repair state unparseable";
const FAULT_WRITE = "hosted cooldown gate faulted: write outcome unknown";

/** One classified, bounded refusal window shared by both hosted gates. */
interface CooldownFaultV1 {
  detail: string;
  until: number;
}

/**
 * Release-role gate: reads both strict snapshots for the effective hold and
 * persists only its own release-role record through expected-head CAS.
 */
export class HostedSupervisorCooldownGate implements GitHubCooldownGateV1 {
  private readonly state: StateReadView & ReleaseStateWriter;
  private readonly clock: Clock;
  private readonly mode: CooldownModeV1;
  /** Only an unreadable clock stays sticky; no later read can repair it. */
  private clockFaulted = false;
  private fault: CooldownFaultV1 | null = null;

  constructor(
    deps: {
      state: StateReadView & ReleaseStateWriter;
      clock: Clock;
      /** Injected enforcement mode; absent keeps the production default. */
      mode?: CooldownModeV1;
    },
  ) {
    this.state = deps.state;
    this.clock = deps.clock;
    this.mode = deps.mode ?? DEFAULT_COOLDOWN_MODE;
  }

  async beforeRequest(installationId: number): Promise<PortResultV1<void>> {
    if (this.mode === "off") return portOk(undefined);
    if (this.clockFaulted) return faultResult(FAULT_CLOCK);
    const now = this.clock.now();
    if (!isNonNegativeSafeInteger(now)) {
      this.clockFaulted = true;
      return faultResult(FAULT_CLOCK);
    }
    const open = this.openFault(now);
    if (open !== null) return open;
    try {
      if (installationId !== HOSTED_SCOPE) {
        return this.faulted(FAULT_SCOPE, now);
      }

      const release = await readReleaseStrict(this.state);
      if (!release.ok) {
        return this.faulted(
          release.why === "unparseable"
            ? FAULT_RELEASE_SHAPE
            : FAULT_RELEASE_STATE,
          now,
        );
      }
      const repair = await readRepairStrict(this.state);
      if (!repair.ok) {
        return this.faulted(
          repair.why === "unparseable"
            ? FAULT_REPAIR_SHAPE
            : FAULT_REPAIR_STATE,
          now,
        );
      }

      // A hold from either ref blocks; checking never erases a hold.
      const blocked = [
        ...release.snapshot.githubCooldowns,
        ...repair.snapshot.githubCooldowns,
      ].some((record) =>
        record.installationId === HOSTED_SCOPE &&
        (record.retryNotBefore === null || now < record.retryNotBefore)
      );
      return blocked ? rateLimitedResult() : portOk(undefined);
    } catch {
      return this.faulted(FAULT_RELEASE_STATE, now);
    }
  }

  async recordRateLimit(
    installationId: number,
    rateLimit: GitHubRateLimitV1,
  ): Promise<PortResultV1<void>> {
    if (this.mode === "off") return portOk(undefined);
    if (this.clockFaulted) return faultResult(FAULT_CLOCK);
    const now = this.clock.now();
    if (!isNonNegativeSafeInteger(now)) {
      this.clockFaulted = true;
      return faultResult(FAULT_CLOCK);
    }
    const open = this.openFault(now);
    if (open !== null) return open;
    try {
      if (installationId !== HOSTED_SCOPE) {
        return this.faulted(FAULT_SCOPE, now);
      }
      // A caller-supplied object is re-validated through the strict parser.
      let rate: GitHubRateLimitV1;
      try {
        rate = parseGitHubRateLimitV1(rateLimit);
      } catch {
        return this.faulted(FAULT_SCOPE, now);
      }

      const release = await readReleaseStrict(this.state);
      if (!release.ok) {
        return this.faulted(
          release.why === "unparseable"
            ? FAULT_RELEASE_SHAPE
            : FAULT_RELEASE_STATE,
          now,
        );
      }
      const repair = await readRepairStrict(this.state);
      if (!repair.ok) {
        return this.faulted(
          repair.why === "unparseable"
            ? FAULT_REPAIR_SHAPE
            : FAULT_REPAIR_STATE,
          now,
        );
      }

      const own = release.snapshot.githubCooldowns.find(
        (record) => record.installationId === HOSTED_SCOPE,
      );
      const foreign = repair.snapshot.githubCooldowns.find(
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
      if (!write.ok) return this.faulted(FAULT_WRITE, now);
      if (write.value.status !== "applied") {
        return this.faulted(FAULT_WRITE, now);
      }
      return portOk(undefined);
    } catch {
      return this.faulted(FAULT_WRITE, now);
    }
  }

  /** Refuse while a bounded fault window is open; then re-read the state. */
  private openFault(now: number): PortResultV1<void> | null {
    const fault = this.fault;
    if (fault === null) return null;
    if (now < fault.until) return faultResult(fault.detail);
    this.fault = null;
    return null;
  }

  private faulted(detail: string, now: number): PortResultV1<void> {
    this.fault = { detail, until: now + FAULT_WINDOW_MS };
    return faultResult(detail);
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
  private readonly mode: CooldownModeV1;
  /** Only an unreadable clock stays sticky; no later read can repair it. */
  private clockFaulted = false;
  private fault: CooldownFaultV1 | null = null;

  constructor(
    deps: {
      state: StateReadView & RepairStateWriter;
      clock: Clock;
      /** Injected enforcement mode; absent keeps the production default. */
      mode?: CooldownModeV1;
    },
  ) {
    this.state = deps.state;
    this.clock = deps.clock;
    this.inner = new DurableGitHubCooldownGate(deps);
    this.mode = deps.mode ?? DEFAULT_COOLDOWN_MODE;
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
    if (this.mode === "off") return portOk(undefined);
    if (this.clockFaulted) return faultResult(FAULT_CLOCK);
    const now = this.clock.now();
    if (!isNonNegativeSafeInteger(now)) {
      this.clockFaulted = true;
      return faultResult(FAULT_CLOCK);
    }
    const open = this.openFault(now);
    if (open !== null) return open;
    try {
      if (!isNonNegativeSafeInteger(installationId)) {
        return this.faulted(FAULT_SCOPE, now);
      }

      const release = await readReleaseStrict(this.state);
      if (release.ok) {
        const blocked = release.snapshot.githubCooldowns.some((record) =>
          record.installationId === HOSTED_SCOPE &&
          (record.retryNotBefore === null || now < record.retryNotBefore)
        );
        if (blocked) return rateLimitedResult();
      } else if (release.why === "unavailable") {
        // The deployment-wide hold cannot be proven absent. A refusal is the
        // fail-closed answer, but it is bounded so an unreadable ref can never
        // freeze the run permanently.
        return this.faulted(FAULT_RELEASE_STATE, now);
      } else {
        return this.faulted(FAULT_RELEASE_SHAPE, now);
      }

      return await this.delegate(this.inner.beforeRequest(installationId));
    } catch {
      return this.faulted(FAULT_RELEASE_STATE, now);
    }
  }

  async recordRateLimit(
    installationId: number,
    rateLimit: GitHubRateLimitV1,
  ): Promise<PortResultV1<void>> {
    if (this.mode === "off") return portOk(undefined);
    if (this.clockFaulted) return faultResult(FAULT_CLOCK);
    const now = this.clock.now();
    if (!isNonNegativeSafeInteger(now)) {
      this.clockFaulted = true;
      return faultResult(FAULT_CLOCK);
    }
    const open = this.openFault(now);
    if (open !== null) return open;
    try {
      if (!isNonNegativeSafeInteger(installationId)) {
        return this.faulted(FAULT_SCOPE, now);
      }
      // Repair-owned recording only; the release ref is never written here.
      // The record is written for the scope that actually hit the limit, so a
      // foreign target's rate limit never masks or blocks the self scope.
      return await this.delegate(
        this.inner.recordRateLimit(installationId, rateLimit),
      );
    } catch {
      return this.faulted(FAULT_WRITE, now);
    }
  }

  /**
   * The inner durable gate already classifies its own bounded faults, so its
   * typed refusal is surfaced unchanged: a normal rate_limited denial, an
   * unreadable/unparseable state and an unknown write outcome all keep their
   * exact identity instead of being collapsed into one instance-wide latch.
   */
  private async delegate(
    result: Promise<PortResultV1<void>>,
  ): Promise<PortResultV1<void>> {
    return await result;
  }

  /** Refuse while a bounded fault window is open; then re-read the state. */
  private openFault(now: number): PortResultV1<void> | null {
    const fault = this.fault;
    if (fault === null) return null;
    if (now < fault.until) return faultResult(fault.detail);
    this.fault = null;
    return null;
  }

  private faulted(detail: string, now: number): PortResultV1<void> {
    this.fault = { detail, until: now + FAULT_WINDOW_MS };
    return faultResult(detail);
  }
}

/**
 * Strict read outcome. `unavailable` (the ref could not be read at all) and
 * `unparseable` (it read, but this role cannot trust its shape) are separate
 * closed identities: they have different causes and both are reported.
 */
type StrictReadV1<T> =
  | { ok: true; snapshot: T; head: GitSha }
  | { ok: false; why: "unavailable" | "unparseable" };

async function readReleaseStrict(
  state: StateReadView,
): Promise<StrictReadV1<ReleaseStateSnapshotV1>> {
  const read = await state.readRelease();
  if (!read.ok) return { ok: false, why: "unavailable" };
  if (read.value.status !== "found") return { ok: false, why: "unavailable" };
  try {
    return {
      ok: true,
      snapshot: parseReleaseStateSnapshotV1(read.value.snapshot),
      head: read.value.head,
    };
  } catch {
    return { ok: false, why: "unparseable" };
  }
}

async function readRepairStrict(
  state: StateReadView,
): Promise<StrictReadV1<RepairStateSnapshotV1>> {
  const read = await state.readRepair();
  if (!read.ok) return { ok: false, why: "unavailable" };
  if (read.value.status !== "found") return { ok: false, why: "unavailable" };
  try {
    return {
      ok: true,
      snapshot: parseRepairStateSnapshotV1(read.value.snapshot),
      head: read.value.head,
    };
  } catch {
    return { ok: false, why: "unparseable" };
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

function faultResult(detail: string = FAULT_DETAIL): PortResultV1<void> {
  return {
    ok: false,
    error: { kind: "unavailable", detail },
  };
}

function isNonNegativeSafeInteger(value: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
