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
import {
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
export function runReleaseEntrypoint(
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
  return controller.run();
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
