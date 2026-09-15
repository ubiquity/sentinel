/**
 * Rolling model-start budget controller.
 *
 * One global budget across all configured repositories: a model start is
 * admitted only after one new durable BudgetReservationV1 (outcome
 * "reserved") has been applied to the repair state branch. The caller holds
 * no cached snapshot between operations — every operation reads the
 * authoritative repair state, and a read/CAS failure, malformed state,
 * ambiguous write or persistence failure never grants permission.
 *
 * Everything in this module is trusted code: reservation ids are derived
 * deterministically from the canonical JSON of
 * repository/taskId/head/attempt/purpose (SHA-256), never accepted from the
 * caller, and neither createdAt nor settled state is caller-supplied. A
 * duplicate logical identity can never obtain a second start by choosing
 * another id or another retry: the same id plus identical logical identity
 * yields reconciliation-needed, and a mismatched identity under a colliding
 * id — or the same identity under a different id — is an invalid collision.
 * A genuinely new retry uses its own incremented attempt.
 *
 * Charging: millisecond rolling intervals (now - duration, now]; every
 * "reserved", "submitted" and "ambiguous" reservation charges globally. Only
 * "confirmed_not_submitted" with a validated restricted proof ref is
 * refunded. Windows never reset on process restart or midnight, and the
 * earliest retryAt across the enforced caps is computed by sorting charged
 * reservation timestamps rather than assuming one excess entry; timestamps
 * and sequence arithmetic must stay inside the safe-integer range, and an
 * overflow is a typed failure that writes nothing.
 *
 * Transports never throw across this boundary: a rejected read is a
 * sanitized unavailable (no permission), and a rejected write is ambiguous
 * with a null currentHead because the effect may have happened — no start is
 * ever granted from an unconfirmed response, and rereading reconciles.
 *
 * Admission policy is one trusted complete repository configuration set: the
 * configured repository must belong to the set, and every supplied config
 * must carry an always-enforced positive hourly cap, an optional numeric
 * weekly cap disabled only by explicit null, and session bounds; all shared
 * policy fields must agree exactly. Missing, non-positive or mismatched
 * policies disable admission; no default/fallback caps are guessed. Workflow
 * single-writer serialization and one deployed config are required by the
 * caller — this controller never invents distributed policy negotiation.
 *
 * The controller contains no inference transport and no retry loop; after an
 * ambiguous or conflicting write the caller reconciles by rereading.
 */

import { parseBudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type {
  BudgetReservationV1,
  ReservationOutcomeV1,
  ReservationPurposeV1,
} from "../contracts/budget-reservation.ts";
import { isGitSha } from "../contracts/brands.ts";
import type { GitSha, WorkItemId } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type {
  Clock,
  PortResultV1,
  RepairStateWriter,
  StateReadResultV1,
  StateReadView,
  StateWriteResultV1,
} from "../contracts/ports.ts";
import { parseRepositoryConfigV1 } from "../contracts/repository-config.ts";
import type {
  LiveStartLimitsV1,
  RepositoryConfigV1,
} from "../contracts/repository-config.ts";
import {
  expectRestrictedRef,
  parseRepositoryIdentity,
} from "../contracts/shared.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";

/** One rolling hour in milliseconds. */
export const HOUR_WINDOW_MS = 3_600_000;
/** One rolling week in milliseconds. */
export const SEVEN_DAY_WINDOW_MS = 7 * 24 * 3_600_000;

const PURPOSES: readonly ReservationPurposeV1[] = [
  "implementation",
  "continuation",
  "retry",
  "review_request",
];
const SETTLEMENT_OUTCOMES: readonly ReservationOutcomeV1[] = [
  "submitted",
  "ambiguous",
  "confirmed_not_submitted",
];

export interface ReserveModelStartRequestV1 {
  repository: RepositoryIdentityV1;
  taskId: WorkItemId;
  /** Repository head the session would start against. */
  head: GitSha;
  /** One-based attempt; a genuinely new retry uses its own incremented attempt. */
  attempt: number;
  purpose: ReservationPurposeV1;
}

export type DeferredReasonV1 = "cap_limit" | "clock_regression";

export type ReserveModelStartResultV1 =
  | { status: "admitted"; reservation: BudgetReservationV1; stateHead: GitSha }
  | { status: "duplicate"; reservation: BudgetReservationV1 }
  | { status: "deferred"; reason: DeferredReasonV1; retryAt: number }
  | { status: "disabled"; detail: string }
  | { status: "conflict"; currentHead: GitSha | null }
  | { status: "ambiguous"; currentHead: GitSha | null }
  | { status: "unavailable"; detail: string }
  | { status: "invalid"; detail: string };

export interface SettleModelStartRequestV1 {
  /** The trusted derived reservation id. */
  id: string;
  /** submitted | ambiguous remain charged; confirmed_not_submitted refunds. */
  outcome: ReservationOutcomeV1;
  /** Required restricted proof ref iff outcome is confirmed_not_submitted. */
  proofRef: string | null;
}

export type SettleModelStartResultV1 =
  | { status: "settled"; reservation: BudgetReservationV1; stateHead: GitSha }
  | {
    status: "idempotent";
    reservation: BudgetReservationV1;
    stateHead: GitSha;
  }
  | { status: "deferred"; reason: "clock_regression"; retryAt: number }
  | { status: "conflict"; currentHead: GitSha | null }
  | { status: "ambiguous"; currentHead: GitSha | null }
  | { status: "unavailable"; detail: string }
  | { status: "invalid"; detail: string };

export interface BudgetControllerOptionsV1 {
  clock: Clock;
  /** The repair state capability: authoritative reads + one trusted writer. */
  state: StateReadView & RepairStateWriter;
  /**
   * Trusted complete repository configuration set. Every operation re-parses
   * and re-validates the whole set with the frozen parser; admission is
   * disabled on any missing/mismatched policy or unchosen repository.
   */
  configs: readonly RepositoryConfigV1[];
}

export interface BudgetControllerV1 {
  reserveModelStart(
    request: ReserveModelStartRequestV1,
  ): Promise<ReserveModelStartResultV1>;
  settleModelStart(
    request: SettleModelStartRequestV1,
  ): Promise<SettleModelStartResultV1>;
}

export class RollingStartBudget implements BudgetControllerV1 {
  private readonly clock: Clock;
  private readonly state: StateReadView & RepairStateWriter;
  private readonly configs: readonly RepositoryConfigV1[];

  constructor(options: BudgetControllerOptionsV1) {
    this.clock = options.clock;
    this.state = options.state;
    this.configs = options.configs;
  }

  // -------------------------------------------------------------------------
  // Reserve: one durable reservation must be applied before a start is granted.
  // -------------------------------------------------------------------------

  async reserveModelStart(
    request: ReserveModelStartRequestV1,
  ): Promise<ReserveModelStartResultV1> {
    const identity = this.parseRepository(request);
    if (identity === null) {
      return invalid("repository identity is invalid");
    }
    const taskId = this.parseTaskId(request.taskId);
    if (taskId === null) {
      return invalid("taskId is invalid");
    }
    if (!isGitSha(request.head)) {
      return invalid("head must be a full 40-hex commit SHA");
    }
    if (
      typeof request.attempt !== "number" ||
      !Number.isSafeInteger(request.attempt) ||
      request.attempt < 1
    ) {
      return invalid("attempt must be a positive safe integer");
    }
    if (!PURPOSES.includes(request.purpose)) {
      return invalid("purpose is not a supported reservation purpose");
    }

    const policy = this.resolvePolicy(identity);
    if (policy.status === "disabled") {
      return { status: "disabled", detail: policy.detail };
    }

    const now = this.readClock();
    if (now === null) return unavailable("clock returned an invalid timestamp");

    let loaded: PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>;
    try {
      loaded = await this.state.readRepair();
    } catch {
      // A rejected read is never a successful empty state: no information was
      // obtained, so no permission is granted (fixed sanitized detail; no
      // exception text can leak).
      return unavailable(
        "authoritative repair state could not be read; no permission granted",
      );
    }
    if (!loaded.ok) {
      return unavailable(
        "authoritative repair state could not be read; no permission granted",
      );
    }
    const expectedHead = loaded.value.status === "found"
      ? loaded.value.head
      : null;
    const prior = loaded.value.status === "found"
      ? loaded.value.snapshot
      : null;

    const regression = prior === null ? null : this.clockRegression(prior, now);
    if (regression !== null) {
      return {
        status: "deferred",
        reason: "clock_regression",
        retryAt: regression,
      };
    }

    const id = await deriveReservationId({
      repository: identity,
      taskId,
      head: request.head,
      attempt: request.attempt,
      purpose: request.purpose,
    });

    // Exact logical identity is decided before any duplicate classification: a
    // matching derived id is only `duplicate` when repository/taskId/head/
    // attempt/purpose all match. An id that belongs to a different logical
    // identity (a derivation/hash collision) is an invalid collision, never a
    // reconciliation-needed duplicate; the same identity under a different id
    // is likewise invalid.
    const sameId = prior?.reservations.find((r) => r.id === id) ?? null;
    if (
      sameId !== null &&
      sameLogicalIdentity(
        sameId,
        identity,
        taskId,
        request.head,
        request.attempt,
        request.purpose,
      )
    ) {
      // A prior matching reservation (including a refunded one) is never a
      // second start permission: same identity, reconciliation needed.
      return { status: "duplicate", reservation: sameId };
    }
    if (sameId !== null) {
      return invalid(
        "a reservation with this id belongs to a different logical identity",
      );
    }
    if (
      prior?.reservations.some((r) =>
        sameLogicalIdentity(
          r,
          identity,
          taskId,
          request.head,
          request.attempt,
          request.purpose,
        )
      ) === true
    ) {
      // Same task/head/attempt/purpose under a different id: a collision or
      // mismatched immutable identity — never a second admission.
      return invalid(
        "a reservation with this logical identity already exists under a different id",
      );
    }

    const reservation: BudgetReservationV1 = {
      version: "v1",
      kind: "budget_reservation",
      repository: identity,
      id,
      taskId,
      attempt: request.attempt,
      head: request.head,
      purpose: request.purpose,
      createdAt: now,
      outcome: "reserved",
      settledAt: null,
      proofRef: null,
    };
    // The frozen parser is the final gate for the record we persist.
    try {
      parseBudgetReservationV1(reservation);
    } catch {
      return invalid("constructed reservation failed contract validation");
    }

    let retryAt: number;
    try {
      retryAt = earliestRetryAt(
        prior?.reservations ?? [],
        now,
        policy.limits,
      );
    } catch (error) {
      // The arithmetic helper throws a fixed sanitized RangeError on invalid
      // or overflowing inputs; that is malformed state, never a permission.
      if (error instanceof RangeError) {
        return unavailable(
          "state reservation timestamps are out of range; no permission granted",
        );
      }
      throw error;
    }
    if (retryAt > now) {
      return { status: "deferred", reason: "cap_limit", retryAt };
    }

    const sequence = nextSequence(prior);
    if (sequence === null) {
      return unavailable(
        "state sequence is exhausted; no permission granted",
      );
    }

    const next = this.extendSnapshot(
      prior,
      expectedHead,
      now,
      reservation,
      sequence,
    );
    let write: PortResultV1<StateWriteResultV1>;
    try {
      write = await this.state.writeRepair(next, expectedHead);
    } catch {
      // A rejected write means the effect may have happened: never grant a
      // start from this response; the caller rereads and reconciles.
      return { status: "ambiguous", currentHead: null };
    }
    if (!write.ok) {
      return unavailable(
        `state write failed (${write.error.kind}); no permission granted`,
      );
    }
    if (write.value.status === "applied") {
      return {
        status: "admitted",
        reservation,
        stateHead: write.value.head,
      };
    }
    if (write.value.status === "conflict") {
      return { status: "conflict", currentHead: write.value.currentHead };
    }
    return { status: "ambiguous", currentHead: write.value.currentHead };
  }

  // -------------------------------------------------------------------------
  // Settle: reconciliation of one durable reservation; never a new admission.
  // -------------------------------------------------------------------------

  async settleModelStart(
    request: SettleModelStartRequestV1,
  ): Promise<SettleModelStartResultV1> {
    if (
      typeof request.id !== "string" ||
      request.id.length === 0 ||
      request.id.length > 256
    ) {
      return invalid("reservation id is invalid");
    }
    if (!SETTLEMENT_OUTCOMES.includes(request.outcome)) {
      return invalid("outcome is not a settlement outcome");
    }
    let proofRef: string | null;
    try {
      proofRef = request.proofRef === null
        ? null
        : expectRestrictedRef(request.proofRef, "$.proofRef");
    } catch {
      return invalid("proofRef must be a restricted storage reference");
    }
    if (request.outcome === "confirmed_not_submitted" && proofRef === null) {
      return invalid("confirmed_not_submitted requires a proof ref");
    }
    if (request.outcome !== "confirmed_not_submitted" && proofRef !== null) {
      return invalid("proof ref is only valid for confirmed_not_submitted");
    }

    const now = this.readClock();
    if (now === null) return unavailable("clock returned an invalid timestamp");

    let loaded: PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>;
    try {
      loaded = await this.state.readRepair();
    } catch {
      // A rejected read is never a successful empty state: no settlement is
      // applied from an unreadable authoritative state.
      return unavailable(
        "authoritative repair state could not be read; no settlement applied",
      );
    }
    if (!loaded.ok) {
      return unavailable(
        "authoritative repair state could not be read; no settlement applied",
      );
    }
    if (loaded.value.status !== "found") {
      return invalid("no reservation with that id exists");
    }
    const snapshot = loaded.value.snapshot;
    const expectedHead = loaded.value.head;

    const regression = this.clockRegression(snapshot, now);
    if (regression !== null) {
      return {
        status: "deferred",
        reason: "clock_regression",
        retryAt: regression,
      };
    }

    const prior = snapshot.reservations.find((r) => r.id === request.id);
    if (prior === undefined) {
      return invalid("no reservation with that id exists");
    }

    // Equal already-settled outcome: idempotent, never rewrites its timestamp.
    if (prior.outcome === request.outcome) {
      if (
        prior.proofRef === proofRef ||
        (request.outcome !== "confirmed_not_submitted" && proofRef === null)
      ) {
        return {
          status: "idempotent",
          reservation: prior,
          stateHead: expectedHead,
        };
      }
      return invalid("settled proof ref cannot change");
    }

    if (prior.outcome === "reserved") {
      const updated = this.updatedReservation(
        prior,
        request.outcome,
        now,
        proofRef,
      );
      if (updated === null) {
        return invalid("settlement failed contract validation");
      }
      return this.writeSettlement(snapshot, expectedHead, now, updated);
    }

    // A settled reservation never reverts to reserved and never changes to a
    // contradictory terminal outcome (submitted/confirmed stay immutable).
    if (prior.outcome !== "ambiguous") {
      return invalid(
        "settled reservation cannot change to a contradictory terminal outcome",
      );
    }
    // Ambiguous may resolve to submitted (charged) or to a proved
    // confirmed_not_submitted; time only moves forward (regression-blocked).
    const updated = this.updatedReservation(
      prior,
      request.outcome,
      now,
      proofRef,
    );
    if (updated === null) {
      return invalid("settlement failed contract validation");
    }
    return this.writeSettlement(snapshot, expectedHead, now, updated);
  }

  // -------------------------------------------------------------------------
  // Policy: one global budget, one trusted complete config set.
  // -------------------------------------------------------------------------

  private resolvePolicy(
    requested: RepositoryIdentityV1,
  ): { status: "valid"; limits: LiveStartLimitsV1 } | {
    status: "disabled";
    detail: string;
  } {
    if (this.configs.length === 0) {
      return disabledPolicy("no repository configurations were supplied");
    }
    let first: LiveStartLimitsV1 | null = null;
    let requestedConfigured = false;
    for (const config of this.configs) {
      let parsed: RepositoryConfigV1;
      try {
        parsed = parseRepositoryConfigV1(config);
      } catch {
        return disabledPolicy("a repository configuration failed validation");
      }
      if (parsed.liveStartLimits === null) {
        return disabledPolicy(
          "liveStartLimits is null: inference is not enabled",
        );
      }
      if (parsed.sessionBound === null) {
        return disabledPolicy(
          "sessionBound is null: session bounds are required",
        );
      }
      const limits = parsed.liveStartLimits;
      // Hour is always a finite positive safe integer for admission. The
      // weekly cap is enforced only when numeric: explicit null means no
      // weekly admission cap, never a wildcard and never Infinity/zero.
      if (
        limits.perHour < 1 ||
        (limits.perSevenDays !== null && limits.perSevenDays < 1)
      ) {
        return disabledPolicy("live start caps must be positive integers");
      }
      if (first === null) {
        first = limits;
      } else if (
        limits.perHour !== first.perHour ||
        limits.perSevenDays !== first.perSevenDays
      ) {
        return disabledPolicy(
          "configured live start caps disagree across repositories",
        );
      }
      if (sameRepository(parsed.repository, requested)) {
        requestedConfigured = true;
      }
    }
    if (!requestedConfigured) {
      return disabledPolicy("the requested repository is not configured");
    }
    return { status: "valid", limits: first as LiveStartLimitsV1 };
  }

  // -------------------------------------------------------------------------
  // Timestamps, regression and rolling caps.
  // -------------------------------------------------------------------------

  private readClock(): number | null {
    let now: number;
    try {
      now = this.clock.now();
    } catch {
      return null;
    }
    if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) {
      return null;
    }
    return now;
  }

  /**
   * The earliest time at which the clock is no longer behind durable state:
   * now must never be behind the snapshot updatedAt or any reservation
   * creation/settlement time (including refunded entries), or state written
   * by a newer clock could be lost. Returns null when now is not behind.
   */
  private clockRegression(
    snapshot: RepairStateSnapshotV1,
    now: number,
  ): number | null {
    let latest = snapshot.updatedAt;
    for (const reservation of snapshot.reservations) {
      if (reservation.createdAt > latest) latest = reservation.createdAt;
      if (
        reservation.settledAt !== null && reservation.settledAt > latest
      ) {
        latest = reservation.settledAt;
      }
    }
    return now < latest ? latest : null;
  }

  private extendSnapshot(
    prior: RepairStateSnapshotV1 | null,
    expectedHead: GitSha | null,
    now: number,
    reservation: BudgetReservationV1,
    sequence: number,
  ): RepairStateSnapshotV1 {
    const base = prior ?? {
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: now,
      incidents: [],
      evidence: [],
      work: [],
      reservations: [],
      reviews: [],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
    };
    return {
      ...base,
      stateHead: expectedHead,
      sequence,
      updatedAt: now,
      reservations: [...base.reservations, reservation],
    };
  }

  private updatedReservation(
    prior: BudgetReservationV1,
    outcome: ReservationOutcomeV1,
    now: number,
    proofRef: string | null,
  ): BudgetReservationV1 | null {
    const updated: BudgetReservationV1 = {
      ...prior,
      outcome,
      settledAt: now,
      proofRef,
      // createdAt is immutable trusted identity; never caller-supplied.
    };
    try {
      return parseBudgetReservationV1(updated);
    } catch {
      return null;
    }
  }

  private async writeSettlement(
    snapshot: RepairStateSnapshotV1,
    expectedHead: GitSha,
    now: number,
    updated: BudgetReservationV1,
  ): Promise<SettleModelStartResultV1> {
    const sequence = nextSequence(snapshot);
    if (sequence === null) {
      return unavailable("state sequence is exhausted; no settlement applied");
    }
    const next: RepairStateSnapshotV1 = {
      ...snapshot,
      stateHead: expectedHead,
      sequence,
      updatedAt: now,
      reservations: snapshot.reservations.map((r) =>
        r.id === updated.id ? updated : r
      ),
    };
    let write: PortResultV1<StateWriteResultV1>;
    try {
      write = await this.state.writeRepair(next, expectedHead);
    } catch {
      // A rejected write means the settlement may have been applied: no
      // outcome is claimed from this response; rereading reconciles.
      return { status: "ambiguous", currentHead: null };
    }
    if (!write.ok) {
      return unavailable(
        `state settlement write failed (${write.error.kind}); not applied`,
      );
    }
    if (write.value.status === "applied") {
      return {
        status: "settled",
        reservation: updated,
        stateHead: write.value.head,
      };
    }
    if (write.value.status === "conflict") {
      return { status: "conflict", currentHead: write.value.currentHead };
    }
    return { status: "ambiguous", currentHead: write.value.currentHead };
  }

  // -------------------------------------------------------------------------
  // Request validation via the frozen parsers (no duplicated validation).
  // -------------------------------------------------------------------------

  private parseRepository(
    request: ReserveModelStartRequestV1,
  ): RepositoryIdentityV1 | null {
    try {
      return parseRepositoryIdentity(request.repository, "$.repository");
    } catch {
      return null;
    }
  }

  private parseTaskId(taskId: WorkItemId): WorkItemId | null {
    if (
      typeof taskId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(taskId)
    ) {
      return null;
    }
    return taskId as WorkItemId;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for deterministic use and boundary tests).
// ---------------------------------------------------------------------------

/** Reservations that still charge the caps; refunded proof is the only uncharged terminal. */
export function isCharged(
  reservation: BudgetReservationV1,
): boolean {
  return reservation.outcome !== "confirmed_not_submitted";
}

/**
 * Earliest retry time under the rolling caps at `now` for the given
 * reservations. Windows are (x - windowMs, x]; refunded
 * confirmed_not_submitted reservations never charge. Entries are sorted by
 * their charge timestamp (createdAt) and the earliest x >= now that admits
 * one more start is the max of every enforced per-window result. A numeric
 * weekly cap is enforced; explicit null enforces the hourly cap only.
 *
 * Exported for deterministic use and boundary tests. Invalid input (a
 * malformed reservation, a non-safe `now`, a non-positive hour cap, a
 * malformed weekly cap, or a numeric hour cap that exceeds a numeric weekly
 * cap) and arithmetic overflow throw one fixed sanitized RangeError that
 * never echoes input values; callers catch it at their boundary and fail
 * closed.
 */
export function earliestRetryAt(
  reservations: readonly BudgetReservationV1[],
  now: number,
  limits: LiveStartLimitsV1,
): number {
  if (!isSafeTimestamp(now)) {
    throw new RangeError("earliestRetryAt: invalid now");
  }
  if (
    !isPositiveSafeInt(limits.perHour) ||
    (limits.perSevenDays !== null &&
      !isPositiveSafeInt(limits.perSevenDays)) ||
    (limits.perSevenDays !== null && limits.perHour > limits.perSevenDays)
  ) {
    throw new RangeError("earliestRetryAt: invalid limits");
  }
  if (!Array.isArray(reservations)) {
    throw new RangeError("earliestRetryAt: invalid reservations");
  }
  // The frozen reservation parser is the input gate: reserved/settled
  // lifecycle, safe timestamps and valid refs are all already enforced.
  for (const reservation of reservations) {
    try {
      parseBudgetReservationV1(reservation);
    } catch {
      throw new RangeError("earliestRetryAt: invalid reservation");
    }
  }
  const descending = reservations
    .filter(isCharged)
    .map((r) => r.createdAt)
    .sort((a, b) => b - a);
  let retryAt = now;
  retryAt = Math.max(
    retryAt,
    perWindowRetryAt(descending, limits.perHour, HOUR_WINDOW_MS, now),
  );
  // A numeric weekly cap still defers; explicit null has no weekly admission
  // cap, so only the hourly result bounds admission.
  if (limits.perSevenDays !== null) {
    retryAt = Math.max(
      retryAt,
      perWindowRetryAt(
        descending,
        limits.perSevenDays,
        SEVEN_DAY_WINDOW_MS,
        now,
      ),
    );
  }
  return retryAt;
}

function perWindowRetryAt(
  descending: readonly number[],
  limit: number,
  windowMs: number,
  now: number,
): number {
  if (descending.length < limit) return now;
  // The limit-th most recent charge must fall out of the window before one
  // more start fits; sorting handles several excess entries, not one.
  const threshold = descending[limit - 1];
  const retryAt = threshold + windowMs;
  if (!Number.isSafeInteger(retryAt)) {
    throw new RangeError("earliestRetryAt: retry timestamp overflow");
  }
  return Math.max(now, retryAt);
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * The next snapshot sequence: sequence 1 on branch creation, otherwise
 * exactly one more than the prior sequence. Returns null when the increment
 * would leave the safe-integer range (exhausted state: no write may proceed).
 */
function nextSequence(prior: RepairStateSnapshotV1 | null): number | null {
  const value = prior === null ? 1 : prior.sequence + 1;
  return Number.isSafeInteger(value) ? value : null;
}

/** SHA-256 of the canonical JSON identity — the trusted reservation id. */
export async function deriveReservationId(
  identity: {
    repository: RepositoryIdentityV1;
    taskId: WorkItemId;
    head: GitSha;
    attempt: number;
    purpose: ReservationPurposeV1;
  },
): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonicalStringify({
      repository: identity.repository,
      taskId: identity.taskId,
      head: identity.head,
      attempt: identity.attempt,
      purpose: identity.purpose,
    }),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sameLogicalIdentity(
  reservation: BudgetReservationV1,
  repository: RepositoryIdentityV1,
  taskId: WorkItemId,
  head: GitSha,
  attempt: number,
  purpose: ReservationPurposeV1,
): boolean {
  return sameRepository(reservation.repository, repository) &&
    reservation.taskId === taskId &&
    reservation.head === head &&
    reservation.attempt === attempt &&
    reservation.purpose === purpose;
}

function sameRepository(
  a: RepositoryIdentityV1,
  b: RepositoryIdentityV1,
): boolean {
  return a.owner === b.owner && a.name === b.name &&
    a.installationId === b.installationId;
}

function unavailable<T extends string>(
  detail: T,
): { status: "unavailable"; detail: T } {
  return { status: "unavailable", detail };
}

function invalid<T extends string>(
  detail: T,
): { status: "invalid"; detail: T } {
  return { status: "invalid", detail };
}

function disabledPolicy(
  detail: string,
): { status: "disabled"; detail: string } {
  return { status: "disabled", detail };
}
