/**
 * Wave C host-assembly seam: one minimal typed repair-host composition factory.
 *
 * `composeRepairHost` wires the existing concrete Wave B modules — the gateway
 * incident adapter, the gateway replay composition, the ReplayPortImpl over
 * that composition, the Codex implementation port and the rolling model-start
 * budget — into the exact `RepairEntrypointDepsV1` capability set consumed by
 * `runRepairEntrypoint` (src/main.ts). Every external dependency is an
 * explicit caller-supplied capability; the factory performs no I/O of its
 * own: it never reads Deno.env, the filesystem, the network, credentials,
 * durable state or release capability, and it never constructs a transport, a
 * credential source, an artifact store, a state store or a release writer.
 *
 * Fail-closed boundaries are preserved, never bypassed:
 *
 * - The controller SHA is validated at this boundary as an exact lowercase
 *   40-hex Git commit SHA before any instance is constructed; a malformed
 *   value is rejected with one static `TypeError` that never echoes input.
 * - The complete config set is re-validated with the frozen
 *   `parseRepositoryConfigV1` parser, and the gateway adapter repository must
 *   match exactly one configured repository; invalid configs, an invalid
 *   gateway repository identity and a missing/ambiguous match are all
 *   rejected with a static `TypeError` BEFORE any instance is constructed.
 * - The replay port is constructed with the injected trusted isolation
 *   capability; without an attestation of real restricted execution the
 *   concrete `ReplayPortImpl` constructor itself fails closed, so the factory
 *   can never make a target-controlled command runnable on its own.
 * - The implementation port keeps its default unverified-receipt policy when
 *   the caller supplies no `receiptVerifier`: `runModel` stays `unavailable`
 *   and no model session is opened. The factory never fabricates a model
 *   receipt, model id, reasoning effort or fallback model.
 * - The gateway adapter maps a missing producer index to `unavailable` (never
 *   an empty successful page) and `runRepairEntrypoint` retains its static
 *   direct-execution fault; this file changes neither.
 *
 * This factory is a composition seam for a future trusted host only: it does
 * not make live activation possible, adds no environment variable, secret,
 * CLI flag, release writer or workflow activation, and never calls a model
 * port itself.
 */

import { isGitSha } from "../contracts/brands.ts";
import type { CommandId, GitSha } from "../contracts/brands.ts";
import type {
  Clock,
  GitHubCooldownGateV1,
  GitHubPort,
} from "../contracts/ports.ts";
import { parseRepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import { parseRepositoryIdentity } from "../contracts/shared.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { RepairEntrypointDepsV1 } from "../main.ts";
import type { RepairGitStateStore } from "../state/mod.ts";
import {
  GatewayIncidentAdapter,
} from "../adapters/gateway/incident-adapter.ts";
import type {
  GatewayAuthProviderV1,
  GatewayTransportV1,
} from "../adapters/gateway/http.ts";
import {
  GatewayReplayComposition,
} from "../adapters/gateway/replay-composition.ts";
import type { GatewaySanitizerPolicyV1 } from "../adapters/gateway/sanitize.ts";
import type { ArtifactStoreV1 } from "../adapters/gateway/store.ts";
import type { ExpectedFailureV1, ReplayPolicyV1 } from "../replay/fixture.ts";
import { ReplayPortImpl } from "../replay/port.ts";
import type {
  ReplayIsolationCapabilityV1,
  ReplaySourceV1,
} from "../replay/port.ts";
import type { ReplayRuntimeV1 } from "../replay/runtime.ts";
import { CodexImplementationPort } from "../repair/model-port.ts";
import type {
  CandidateCommitterV1,
  CheckoutResolverV1,
  ReceiptVerifierV1,
} from "../repair/model-port.ts";
import { LocalCandidateCommitter } from "../repair/model-port.ts";
import type { CodexSessionV1 } from "../repair/codex-transport.ts";
import { RollingStartBudget } from "../budget/mod.ts";

/** Exact repository identity: owner, name AND installation id are one. */
function sameRepositoryIdentity(
  a: RepositoryIdentityV1,
  b: RepositoryIdentityV1,
): boolean {
  return a.owner === b.owner && a.name === b.name &&
    a.installationId === b.installationId;
}

/** Static reject texts; no input-derived text is ever interpolated. */
const STATIC_INVALID_CONTROLLER_SHA =
  "repair host configuration rejected: controller SHA is not an exact lowercase 40-hex commit SHA";
const STATIC_INVALID_CONFIG =
  "repair host configuration rejected: a repository configuration is invalid";
const STATIC_INVALID_REPOSITORY =
  "repair host configuration rejected: the gateway adapter repository identity is invalid";
const STATIC_UNCONFIGURED_REPOSITORY =
  "repair host configuration rejected: the gateway adapter repository is not among the configured repositories";
const STATIC_AMBIGUOUS_REPOSITORY =
  "repair host configuration rejected: the gateway adapter repository matches more than one configured repository";

/** Caller-supplied gateway inputs for one adapter + replay composition. */
export interface RepairHostGatewayOptionsV1 {
  /**
   * Exact repository identity the gateway adapter and replay composition are
   * built for; it must match exactly one configured repository.
   */
  repository: RepositoryIdentityV1;
  transport: GatewayTransportV1;
  auth: GatewayAuthProviderV1;
  /** Bounded restricted evidence store (the same one both instances use). */
  store: ArtifactStoreV1;
  /** Existing 32-byte producer key capability for retained-capture decryption. */
  keyBytes: Uint8Array<ArrayBuffer>;
  /** Fixed trusted host sanitizer policy. */
  policy: GatewaySanitizerPolicyV1;
  /** Trusted replay command id recorded in replay metadata. */
  commandId: CommandId;
  /** Trusted replay test identity attested by composed fixtures. */
  testIds: readonly string[];
  /** Trusted before-failure signature attested by composed fixtures. */
  expectedFailure: ExpectedFailureV1;
}

/** Caller-supplied replay port inputs; the fixture resolver is the host-owned composition. */
export interface RepairHostReplayOptionsV1 {
  source: ReplaySourceV1;
  scratchDir: string;
  policy: ReplayPolicyV1;
  /** Trusted restricted-execution capability; the concrete port requires it. */
  isolation: ReplayIsolationCapabilityV1;
  /** Optional process runtime; defaults to the concrete DenoReplayRuntime. */
  runtime?: ReplayRuntimeV1;
}

/** Caller-supplied implementation port inputs. */
export interface RepairHostModelOptionsV1 {
  /** Opens one bounded app-server session per run. */
  openSession(): Promise<CodexSessionV1>;
  /** Absolute path of the secret-free model checkout. */
  checkoutDir: string;
  /** Local checkout identity resolver; optional (port default is local git). */
  checkout?: CheckoutResolverV1;
  /** Optional trusted host commit step; defaults to the local checkout committer. */
  commitCandidate?: CandidateCommitterV1;
  /**
   * Trusted-host receipt verifier; the factory NEVER supplies one, so the
   * default unverified-receipt policy stays active unless the host provides
   * an authoritative verifier.
   */
  receiptVerifier?: ReceiptVerifierV1;
}

/** The complete trusted capability set one repair-host composition needs. */
export interface RepairHostOptionsV1 {
  /** Complete trusted repository configuration set (frozen contract). */
  configs: readonly RepositoryConfigV1[];
  /** Exact Sentinel controller SHA that owns every new work record. */
  controllerSha: GitSha;
  clock: Clock;
  /** Repair read/write capability over the durable repair state branch. */
  state: RepairGitStateStore;
  /** Authenticated GitHub port for the configured repository. */
  github: GitHubPort;
  /**
   * The one shared durable GitHub cooldown gate: the SAME instance the host
   * injected into its GitHub client/token acquisition. No default gate exists.
   */
  githubCooldown: GitHubCooldownGateV1;
  gateway: RepairHostGatewayOptionsV1;
  replay: RepairHostReplayOptionsV1;
  model: RepairHostModelOptionsV1;
}

/**
 * Compose one complete repair entrypoint dependency set from caller-supplied
 * capabilities. Validates the controller SHA as an exact lowercase 40-hex Git
 * commit SHA, then rejects an invalid config set or a gateway repository that
 * does not match exactly one configured repository with a static `TypeError`
 * before any instance is constructed; every other trust boundary keeps its
 * own fail-closed constructor behavior.
 */
export function composeRepairHost(
  options: RepairHostOptionsV1,
): RepairEntrypointDepsV1 {
  // 1. Validate the controller identity before anything is constructed. The
  //    exact lowercase-40-hex rule is the frozen brand predicate; the reject
  //    text is static and never echoes the supplied value.
  if (!isGitSha(options.controllerSha)) {
    throw new TypeError(STATIC_INVALID_CONTROLLER_SHA);
  }

  // 2. Validate the complete config set before anything is constructed.
  const configs: RepositoryConfigV1[] = [];
  for (const config of options.configs) {
    try {
      configs.push(parseRepositoryConfigV1(config));
    } catch {
      throw new TypeError(STATIC_INVALID_CONFIG);
    }
  }

  // 3. Bind the gateway adapter repository to exactly one configured
  //    repository; the parsed set remains the single source of truth.
  let gatewayRepository: RepositoryIdentityV1;
  try {
    gatewayRepository = parseRepositoryIdentity(
      options.gateway.repository,
      "$.repository",
    );
  } catch {
    throw new TypeError(STATIC_INVALID_REPOSITORY);
  }
  const matches = configs.filter((config) =>
    sameRepositoryIdentity(config.repository, gatewayRepository)
  );
  if (matches.length === 0) {
    throw new TypeError(STATIC_UNCONFIGURED_REPOSITORY);
  }
  if (matches.length > 1) {
    throw new TypeError(STATIC_AMBIGUOUS_REPOSITORY);
  }
  const target = matches[0];

  // 4. One gateway composition: the incident adapter is built over the
  //    matched parsed config and the supplied store, and the replay
  //    composition wraps THAT adapter and THAT store.
  const adapter = new GatewayIncidentAdapter({
    config: target,
    transport: options.gateway.transport,
    auth: options.gateway.auth,
    clock: options.clock,
    store: options.gateway.store,
  });
  const composition = new GatewayReplayComposition({
    adapter,
    store: options.gateway.store,
    repository: target.repository,
    keyBytes: options.gateway.keyBytes,
    policy: options.gateway.policy,
    commandId: options.gateway.commandId,
    testIds: options.gateway.testIds,
    expectedFailure: options.gateway.expectedFailure,
    clock: options.clock,
  });

  // 5. The replay port resolver is the exact composition instance; the port
  //    config is the same matched parsed repository config.
  const replay = new ReplayPortImpl({
    config: target,
    source: options.replay.source,
    scratchDir: options.replay.scratchDir,
    fixtures: composition,
    policy: options.replay.policy,
    isolation: options.replay.isolation,
    runtime: options.replay.runtime,
    clock: options.clock,
  });

  // 6. The implementation port keeps its fail-closed default receipt policy
  //    unless the host supplies a verifier; no receipt is fabricated here.
  const model = new CodexImplementationPort({
    openSession: options.model.openSession,
    checkoutDir: options.model.checkoutDir,
    checkout: options.model.checkout,
    receiptVerifier: options.model.receiptVerifier,
    commitCandidate: options.model.commitCandidate ??
      new LocalCandidateCommitter(options.model.checkoutDir),
  });

  // 7. One RollingStartBudget over the same repair state and config set.
  const budget = new RollingStartBudget({
    clock: options.clock,
    state: options.state,
    configs,
  });

  return {
    clock: options.clock,
    state: options.state,
    configs,
    controllerSha: options.controllerSha,
    github: options.github,
    githubCooldown: options.githubCooldown,
    // The composition is the IncidentAdapter (read-only delegation) and the
    // exact fixture identity source for the repair loop.
    incidents: composition,
    replay,
    fixtureIdentities: composition,
    model,
    budget,
  };
}

// Re-export the composed capability type so a trusted host can assemble a
// host-only module without importing src/main.ts machinery.
export type { RepairEntrypointDepsV1 };
