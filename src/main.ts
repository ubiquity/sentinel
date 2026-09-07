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
 * Executing this module directly is never a wired production run: without the
 * host-injected capability set the script exits non-zero with a static fault
 * (fail closed; see the bottom of this file).
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
  GitHubPort,
  ImplementationPort,
  IncidentAdapter,
  RepairStateWriter,
  ReplayPort,
  StateReadView,
} from "./contracts/ports.ts";
import {
  type RepairCycleOutcomeV1,
  type ReplayFixtureIdentitySourceV1,
  runRepairCycle,
} from "./repair/loop.ts";

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
  incidents: IncidentAdapter;
  replay: ReplayPort;
  /** Trusted fixture test-identity lookup paired with the replay resolver. */
  fixtureIdentities?: ReplayFixtureIdentitySourceV1;
  model: ImplementationPort;
  /** The one durable model-start admission controller. */
  budget: BudgetControllerV1;
}

export interface RepairEntrypointOptionsV1 {
  /** Absolute run deadline; declared operations must fit the remaining margin. */
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
export function runRepairEntrypoint(
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
  return runRepairCycle(
    {
      clock: deps.clock,
      state: deps.state,
      configs,
      controllerSha: deps.controllerSha,
      github: deps.github,
      incidents: deps.incidents,
      replay: deps.replay,
      fixtureIdentities: deps.fixtureIdentities,
      model: deps.model,
      budget: deps.budget,
    },
    { deadline: options.deadline, stepLimit: options.stepLimit },
  );
}

// ---------------------------------------------------------------------------
// Fail-closed direct execution: no capability wiring is shipped with the
// repository (transports, credentials and auth providers are injected by the
// trusted host at activation). A direct invocation is never a busy loop and
// never touches an external service. Importing this module (the normal
// production path) is unaffected.
// ---------------------------------------------------------------------------

if (import.meta.main) {
  throw new Error(
    "repair entrypoint requires injected trusted capabilities: " +
      "no host capability wiring is installed in this repository",
  );
}
