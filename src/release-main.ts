/**
 * Deterministic release workflow entrypoint (Wave C, exclusive release
 * ownership).
 *
 * This is the production boundary between the trusted host and the release
 * controller (m05). The trusted host injects the release-role state
 * capabilities (read-only view + release writer only), the deploy identity
 * configuration, the DenoReleasePort and the Clock, plus — when the m06/WaveC
 * build-receipt integration is wired — the trusted authenticated
 * BuildReceiptResolverV1 keyed by the exact ReleaseRequestV1.
 *
 * Capability boundary (docs/contracts.md §10, frozen):
 * - This entrypoint NEVER receives repair write capability, work records,
 *   budget reservations, an ImplementationPort or any model admission
 *   authority; it cannot edit application code and it cannot promote anything
 *   except through DenoReleasePort.
 * - A build receipt is NEVER created here. When `resolver` is absent the
 *   controller receives `UnavailableBuildReceiptResolver`, so every release
 *   waits/blocks without promotion: versions are never selected by list
 *   order, timestamp or model-provided identity.
 *
 * Executing this module directly is never a wired production run: without the
 * host-injected capability set the script exits non-zero with a static fault
 * (fail closed; see the bottom of this file).
 */

import type {
  Clock,
  DenoReleasePort,
  PortResultV1,
  ReleaseStateWriter,
  StateReadView,
} from "./contracts/ports.ts";
import type { RepositoryIdentityV1 } from "./contracts/shared.ts";
import type { ReleaseTargetEnvironmentV1 } from "./contracts/release.ts";
import type { StabilityPolicyV1 } from "./contracts/repository-config.ts";
import type { ReleaseRecordV1 } from "./contracts/release.ts";
import {
  DENO_DEFAULT_TIMEOUT_MS,
  RELEASE_EXPECTED_SAMPLES,
  RELEASE_SAMPLE_INTERVAL_MS,
  RELEASE_WINDOW_MS,
  type ReleaseTargetConfigV1,
  validateReleaseTargetConfig,
} from "./release/config.ts";
import {
  ReleaseController,
  type ReleaseCycleResultV1,
} from "./release/controller.ts";
import {
  type BuildReceiptResolverV1,
  UnavailableBuildReceiptResolver,
} from "./release/resolver.ts";

export interface ReleaseEntrypointDepsV1 {
  clock: Clock;
  /** Read-only repair + release view (open release requests live on the
   * repair branch). NEVER a repair writer. */
  stateRead: StateReadView;
  /** The one trusted release writer: release records only. */
  stateWrite: ReleaseStateWriter;
  /** Exact target repository this controller owns. */
  repository: RepositoryIdentityV1;
  /** Exact target environment (production/isolated). */
  environment: ReleaseTargetEnvironmentV1;
  /** Trusted m05 release target configuration. */
  target: ReleaseTargetConfigV1;
  /** Enabled owner stability policy (validated at construction). */
  policy: StabilityPolicyV1;
  deno: DenoReleasePort;
  /**
   * Trusted authenticated build receipt resolver for this request. When
   * absent, the default `UnavailableBuildReceiptResolver` is injected: the
   * controller waits/blocks and can never promote a build it cannot bind.
   */
  resolver?: BuildReceiptResolverV1;
  /**
   * Waits between scheduled monitoring samples. Production uses a real timer;
   * deterministic tests inject a clock-advancing waiter. The waiter is a
   * trusted host capability and carries no release or state authority.
   */
  wait?: (durationMs: number) => Promise<void>;
}

/**
 * Run one bounded release controller cycle through the production entrypoint.
 *
 * The boundary re-validates the target configuration with the m05 validator
 * (a host config fault must stop the run before any platform effect) and
 * injects the resolver default: unavailable unless a trusted resolver is
 * explicitly supplied. The controller itself owns all phase/identity/
 * promotion/acceptance/rollback semantics.
 */
export async function runReleaseEntrypoint(
  deps: ReleaseEntrypointDepsV1,
): Promise<PortResultV1<ReleaseCycleResultV1>> {
  const target = validateReleaseTargetConfig(deps.target);
  const controller = new ReleaseController({
    repository: deps.repository,
    environment: deps.environment,
    target,
    policy: deps.policy,
    stateRead: deps.stateRead,
    stateWrite: deps.stateWrite,
    deno: deps.deno,
    resolver: deps.resolver ?? new UnavailableBuildReceiptResolver(),
    clock: deps.clock,
  });

  // GitHub's release schedule is five minutes, while the target acceptance
  // contract requires a 30-second sample interval. Keep one bounded scheduled
  // invocation alive for the complete window and persist every slot through
  // the same controller path. A missing/delayed waiter or transport never
  // relaxes the controller's persisted gap checks.
  const wait = deps.wait ?? waitForDuration;
  const runStartedAt = deps.clock.now();
  const runDeadline = runStartedAt + RELEASE_WINDOW_MS +
    RELEASE_SAMPLE_INTERVAL_MS + target.logsLagMs + DENO_DEFAULT_TIMEOUT_MS;
  const maxCycles = RELEASE_EXPECTED_SAMPLES + 4;
  let cycles = 0;
  let result = await controller.run();
  while (continuesMonitoring(result)) {
    if (cycles >= maxCycles) return result;
    const beforeWait = deps.clock.now();
    const remaining = runDeadline - beforeWait;
    if (remaining <= 0) return result;
    // Derive the next due instant from the persisted monitor state. This
    // handles an invocation that starts just before a slot boundary without
    // skipping that slot, while the controller still rejects a real gap.
    const delay = await nextSampleDelay(deps, target.logsLagMs, beforeWait);
    if (delay === null) return result;
    const boundedDelay = Math.min(delay, remaining);
    if (boundedDelay <= 0) return result;
    await wait(boundedDelay);
    // A deterministic waiter must advance the injected clock. Without this
    // guard, a broken test/host waiter would turn the scheduled entrypoint
    // into an unbounded busy loop while producing no coverage.
    if (deps.clock.now() <= beforeWait) return result;
    cycles++;
    result = await controller.run();
  }
  return result;
}

async function nextSampleDelay(
  deps: ReleaseEntrypointDepsV1,
  logsLagMs: number,
  now: number,
): Promise<number | null> {
  const read = await deps.stateRead.readRelease();
  if (!read.ok || read.value.status !== "found") return null;
  const record = read.value.snapshot.releases.find((candidate) =>
    candidate.phase === "monitoring" &&
    candidate.environment === deps.environment &&
    candidate.repository.owner === deps.repository.owner &&
    candidate.repository.name === deps.repository.name &&
    candidate.repository.installationId === deps.repository.installationId
  ) as ReleaseRecordV1 | undefined;
  if (record?.monitoring.startedAt === null || record === undefined) {
    return null;
  }
  const nextDueAt = record.monitoring.startedAt +
    (record.monitoring.samples + 1) * RELEASE_SAMPLE_INTERVAL_MS + logsLagMs;
  // A zero/negative delay means the state became due while it was being read;
  // yield one millisecond before retrying so the entrypoint cannot busy-loop.
  return Math.max(1, nextDueAt - now);
}

function continuesMonitoring(
  result: PortResultV1<ReleaseCycleResultV1>,
): boolean {
  if (!result.ok) return false;
  const value = result.value;
  if (value.status === "advanced" || value.status === "persisted") {
    return value.phase === "monitoring";
  }
  // A run can reach the entrypoint just before a slot's source-lag boundary.
  // Keep that active monitor alive for the next interval, while other waiting
  // outcomes (for example an unavailable build receipt) return to the next
  // scheduled invocation.
  return value.status === "waiting" &&
    value.detail === "next sample slot is not due";
}

function waitForDuration(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

// ---------------------------------------------------------------------------
// Fail-closed direct execution: no capability wiring is shipped with the
// repository (credentials, transports and the build-receipt seam are injected
// by the trusted host at activation). A direct invocation never promotes.
// ---------------------------------------------------------------------------

if (import.meta.main) {
  throw new Error(
    "release entrypoint requires injected trusted capabilities: " +
      "no host capability wiring is installed in this repository",
  );
}
