/**
 * Repair polling workflow entrypoint (Wave C).
 *
 * This is the production boundary between the trusted host and the repair
 * loop (m04). The trusted host injects every capability: the durable repair
 * state read/write view, the complete trusted repository configuration set,
 * the Clock, the GitHub/Incident/Replay/Implementation ports and the one
 * durable RollingStartBudget admission controller. No transport, credential,
 * environment variable, CLI flag or storage alternative is constructed here.
 *
 * Capability boundary (docs/contracts.md §10, frozen):
 * - The repair entrypoint NEVER receives release write capability, a
 *   DenoReleasePort or release records; the read-only StateReadView is the
 *   only shared surface.
 * - Model starts are granted exclusively by a durable
 *   `RollingStartBudget.reserveModelStart(...)` result of `{ status:
 *   "admitted" }` (applied inside the loop before `ImplementationPort.runModel`
 *   is invoked). `resolveGlobalLiveStartLimits` is cap agreement only: an
 *   `enabled` agreement without a durable admitted reservation is never a
 *   model start, and this entrypoint never calls a model port itself.
 *
 * Executing this module directly starts the one authorized concrete local
 * host (`startLocalRepairHostFromEnv`, dynamically imported at the bottom of
 * this file) from trusted environment inputs; importing it as a library stays
 * side-effect free.
 */

import type { GitSha } from "./contracts/brands.ts";
import {
  parseRepositoryConfigV1,
  resolveGlobalLiveStartLimits,
} from "./contracts/repository-config.ts";
import type { RepositoryConfigV1 } from "./contracts/repository-config.ts";
import type { BudgetControllerV1 } from "./budget/mod.ts";
import type {
  Clock,
  GitHubCooldownGateV1,
  GitHubPort,
  ImplementationPort,
  IncidentAdapter,
  RepairStateWriter,
  ReplayPort,
  ReviewDrainReportV1,
  StateReadView,
} from "./contracts/ports.ts";
import {
  OPERATION_MARGIN_MS,
  REPAIR_RUN_CEILING_MS,
  type RepairCycleOutcomeV1,
  type ReplayFixtureIdentitySourceV1,
  runRepairCycle,
} from "./repair/loop.ts";

/** Static sanitized message of every mandatory drain failure. */
export const REPAIR_REVIEW_DRAIN_ERROR_MESSAGE =
  "repair review drain failed: owned review sessions were not settled";

/**
 * Typed mandatory-drain failure. Carries the sanitized drain report (null when
 * the transport itself failed), the original cycle outcome (null when the
 * cycle threw before producing one) and the original cycle exception as the
 * `cause` when there was one. The message is always the static text above;
 * no raw transport or exception detail is ever exposed.
 */
export class RepairReviewDrainError extends Error {
  readonly report: ReviewDrainReportV1 | null;
  readonly outcome: RepairCycleOutcomeV1 | null;

  constructor(input: {
    report: ReviewDrainReportV1 | null;
    outcome: RepairCycleOutcomeV1 | null;
    cause?: unknown;
  }) {
    super(REPAIR_REVIEW_DRAIN_ERROR_MESSAGE, { cause: input.cause });
    this.name = "RepairReviewDrainError";
    this.report = input.report;
    this.outcome = input.outcome;
  }
}

/** The trusted capability set one repair entrypoint run receives. */
export interface RepairEntrypointDepsV1 {
  clock: Clock;
  /** Read-only repair/release view plus the one trusted repair writer.
   * Never a release writer: release records are mutated only by the release
   * workflow (src/release-main.ts). */
  state: StateReadView & RepairStateWriter;
  /** Complete trusted repository configuration set (frozen contract). */
  configs: readonly RepositoryConfigV1[];
  /** Exact Sentinel controller SHA that owns every new work record. */
  controllerSha: GitSha;
  github: GitHubPort;
  /**
   * The one durable GitHub cooldown gate. The trusted host MUST supply the
   * SAME DurableGitHubCooldownGate instance it injected into the GitHub
   * client/token acquisition and the GitHubPort implementation — there is no
   * independent/default gate constructed here. The loop checks it before any
   * GitHub read, model reservation or publication; this entrypoint passes the
   * exact object through unchanged.
   */
  githubCooldown: GitHubCooldownGateV1;
  incidents: IncidentAdapter;
  replay: ReplayPort;
  /** Trusted fixture test-identity lookup paired with the replay resolver. */
  fixtureIdentities?: ReplayFixtureIdentitySourceV1;
  model: ImplementationPort;
  /** The one durable model-start admission controller. */
  budget: BudgetControllerV1;
}

export interface RepairEntrypointOptionsV1 {
  /**
   * Absolute run deadline; declared operations must fit the remaining margin.
   * The caller-supplied deadline is bound by the fixed 120-minute run ceiling
   * (the stricter of the two wins), so an unbounded caller value can never
   * extend a run past the plan's ceiling; the loop also enforces the
   * 90-minute no-new-model-work cutoff internally.
   */
  deadline: number;
  /** Bounded persisted transitions per run. */
  stepLimit?: number;
}

/**
 * Run one bounded repair polling pass through the production entrypoint.
 *
 * Boundary hardening before the loop starts:
 * - every supplied configuration is re-validated with the frozen parser (a
 *   bad host config must stop the run before any external effect), and
 * - the global live-start agreement is resolved across the complete set: a
 *   CONFLICT is a host wiring fault (per-repository independent caps are
 *   never used) and fails closed here. A `disabled` agreement is a normal
 *   state (inference not enabled): the loop and the budget handle it per
 *   operation, and admission remains impossible without a durable
 *   `admitted` reservation.
 */
export async function runRepairEntrypoint(
  deps: RepairEntrypointDepsV1,
  options: RepairEntrypointOptionsV1,
): Promise<RepairCycleOutcomeV1> {
  const configs = deps.configs.map((config) => parseRepositoryConfigV1(config));
  const agreement = resolveGlobalLiveStartLimits(configs);
  if (agreement.status === "conflict") {
    throw new Error(
      "repair configuration rejected: conflicting global live-start limits " +
        `across ${agreement.repositories.join(", ")}`,
    );
  }
  // Bound the caller-supplied deadline by the fixed run ceiling before the
  // loop's run-relative bounds are applied. The ORIGINAL run start is captured
  // exactly once here and passed into the cycle, so a shortened caller
  // deadline can never shift the 90-minute model cutoff later. A NaN caller
  // deadline is not a bound (its comparisons are all false) and must never
  // bypass the fixed ceiling, so it is normalized to unbounded and the
  // ceiling governs.
  const runStartedAt = deps.clock.now();
  const callerDeadline = Number.isNaN(options.deadline)
    ? Number.POSITIVE_INFINITY
    : options.deadline;
  const hardDeadline = Math.min(
    callerDeadline,
    runStartedAt + REPAIR_RUN_CEILING_MS,
  );

  let outcome: RepairCycleOutcomeV1 | null = null;
  let cycleError: unknown = null;
  let cycleThrew = false;
  try {
    outcome = await runRepairCycle(
      {
        clock: deps.clock,
        state: deps.state,
        configs,
        controllerSha: deps.controllerSha,
        github: deps.github,
        githubCooldown: deps.githubCooldown,
        incidents: deps.incidents,
        replay: deps.replay,
        fixtureIdentities: deps.fixtureIdentities,
        model: deps.model,
        budget: deps.budget,
      },
      {
        deadline: hardDeadline - OPERATION_MARGIN_MS,
        stepLimit: options.stepLimit,
        runStartedAt,
      },
    );
  } catch (error) {
    // The original outcome/error is preserved: drain runs on this path too,
    // and on a successful drain the original error is rethrown unchanged.
    cycleThrew = true;
    cycleError = error;
  }

  // Mandatory bounded finalization on EVERY return and error path, including
  // the double-failure path. Drain stops review admission, awaits or
  // interrupts every owned producer session and reconciles its journal inside
  // the hard deadline; it never starts a model, reserves no budget and writes
  // no repair state.
  let report: ReviewDrainReportV1 | null = null;
  let drainFailed = false;
  let drainCause: unknown = null;
  try {
    const drained = await deps.github.drainReviews({
      deadline: hardDeadline,
      interrupt: true,
    });
    if (drained.ok) {
      report = drained.value;
      drainFailed = report.ok === false;
    } else {
      drainFailed = true;
      drainCause = drained.error;
    }
  } catch (error) {
    drainFailed = true;
    drainCause = error;
  }
  if (drainFailed) {
    // No log-only success: a drain that could not prove settlement/durability
    // is a typed failure carrying the sanitized report, the original outcome
    // and (when the cycle failed) the original exception as cause.
    throw new RepairReviewDrainError({
      report,
      outcome,
      cause: cycleThrew ? cycleError : drainCause,
    });
  }
  if (cycleThrew) throw cycleError;
  return outcome!;
}

// ---------------------------------------------------------------------------
// Authorized local target: direct execution starts the concrete trusted local
// host (src/host/local.ts). The import is dynamic so importing this module
// stays side-effect free; an ordinary library import never starts a host.
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { startLocalRepairHostFromEnv } = await import("./host/local.ts");
  const run = await startLocalRepairHostFromEnv();
  if (run.status === "busy") {
    console.error(
      "local repair host busy: another writer holds the state lock",
    );
    Deno.exitCode = 1;
  }
}
