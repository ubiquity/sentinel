/**
 * Wave C trusted release host composition seam.
 *
 * One minimal, typed, side-effect-free factory that constructs the existing
 * concrete release modules from explicit caller-supplied capabilities and
 * returns the exact `ReleaseEntrypointDepsV1` capability set for
 * `runReleaseEntrypoint` (MASTER-PLAN.md §Wave C):
 *
 * - one `DenoReleaseRESTClient` from the supplied Deno transport/auth and the
 *   validated release target config/clock;
 * - `GithubBuildReceiptResolver` bound to the exact repository, environment,
 *   project, base branch and pinned workflow blob SHA when authenticated
 *   resolver inputs are supplied; `UnavailableBuildReceiptResolver` (the
 *   production default) when they are omitted — the controller then waits and
 *   can never promote a build it cannot bind;
 * - the exact state role split: the read-only `StateReadView` plus the
 *   release-only `ReleaseStateWriter`; no repair write capability, budget,
 *   model or work-record surface exists on this seam.
 *
 * The factory validates the explicit release `repository` with the frozen
 * `parseRepositoryIdentity` parser and requires the runtime `environment` to
 * be exactly `production` or `isolated` BEFORE anything is constructed, then
 * validates the target through `validateReleaseTargetConfig`, requires
 * `validateStabilityPolicy` to pass, and rejects repository/environment/project
 * binding mismatches and malformed resolver input with static `TypeError` text
 * (no value is ever echoed).
 *
 * Capability boundary: this composition seam never reads `Deno.env`, the
 * filesystem, the network, credentials, state or any repair capability; it
 * adds no environment variable, secret, CLI flag, arbitrary revision
 * selector, promotion fallback or workflow activation. It is a composition
 * seam for a future trusted host: it promotes nothing, cannot manufacture a
 * hosted build receipt and cannot claim live acceptance.
 */

import { type GitSha, isGitSha } from "../contracts/brands.ts";
import type {
  Clock,
  ReleaseStateWriter,
  StateReadView,
} from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { parseRepositoryIdentity } from "../contracts/shared.ts";
import type { ReleaseTargetEnvironmentV1 } from "../contracts/release.ts";
import type { StabilityPolicyV1 } from "../contracts/repository-config.ts";
import type { ReleaseEntrypointDepsV1 } from "../release-main.ts";
import {
  type ReleaseTargetConfigV1,
  validateReleaseTargetConfig,
  validateStabilityPolicy,
} from "../release/config.ts";
import type {
  DenoAuthProviderV1,
  DenoHttpTransportV1,
} from "../release/http.ts";
import {
  GithubBuildReceiptResolver,
  type GithubBuildReceiptResolverAuthV1,
  type GithubBuildReceiptResolverOptionsV1,
} from "../release/build-receipt-resolver.ts";
import { DenoReleaseRESTClient } from "../release/port.ts";
import { UnavailableBuildReceiptResolver } from "../release/resolver.ts";

/** Static reject texts; no input value is ever echoed. */
const ERR_POLICY = "release host stability policy is rejected";
const ERR_REPOSITORY = "release host repository identity is invalid";
const ERR_ENVIRONMENT = "release host environment is invalid";
const ERR_RESOLVER_INPUT = "release host resolver input is invalid";
const ERR_RESOLVER_REPOSITORY =
  "release host resolver repository does not match the release target";
const ERR_RESOLVER_ENVIRONMENT =
  "release host resolver environment does not match the release target";
const ERR_RESOLVER_PROJECT =
  "release host resolver project does not match the release target";

/** Mirrors the resolver's accepted base-branch shape (module-level constant). */
const RESOLVER_BASE_BRANCH_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,254})$/;
const RESOLVER_CONTROL_CHARS_RE = /[\p{Cc}]/u;
/** Mirrors the resolver's whole-resolve deadline bounds. */
const RESOLVER_MIN_TIMEOUT_MS = 1;
const RESOLVER_MAX_TIMEOUT_MS = 30_000;

/** Deno HTTP transport plus its credential source (host-injected). */
export interface ReleaseHostDenoInputV1 {
  transport: DenoHttpTransportV1;
  auth: DenoAuthProviderV1;
}

/**
 * Authenticated GitHub build-receipt resolver binding. Every field is
 * explicit so the factory can prove the resolver agrees with the release
 * target binding before constructing anything; a drift is a host wiring
 * fault, never a late resolve-time surprise.
 */
export interface ReleaseHostResolverInputV1 {
  repository: RepositoryIdentityV1;
  environment: ReleaseTargetEnvironmentV1;
  /** Deno Deploy project the receipt is expected for. */
  project: string;
  /** Base branch of the exact build workflow. */
  baseBranch: string;
  /** Pinned workflow blob SHA at the accepted revision. */
  workflowBlobSha: GitSha;
  /** Authenticated GitHub capability (holds the App credential). */
  auth: GithubBuildReceiptResolverAuthV1;
  /** Optional injected fetch (defaults inside the resolver). */
  fetch?: typeof globalThis.fetch;
  /** Optional resolver deadline (1..30000ms; internal test bound). */
  timeoutMs?: number;
}

/** Every capability the trusted host supplies to compose the release entrypoint. */
export interface ReleaseHostOptionsV1 {
  clock: Clock;
  stateRead: StateReadView;
  stateWrite: ReleaseStateWriter;
  repository: RepositoryIdentityV1;
  environment: ReleaseTargetEnvironmentV1;
  /** m05 release target configuration (re-validated by the factory). */
  target: ReleaseTargetConfigV1;
  /** Enabled owner stability policy (must pass the m05 check). */
  policy: StabilityPolicyV1;
  deno: ReleaseHostDenoInputV1;
  /** Authenticated receipt binding; omitted keeps the unavailable default. */
  resolver?: ReleaseHostResolverInputV1;
}

/**
 * Compose the exact release entrypoint deps. All validation happens before
 * any construction: a target/policy/resolver fault throws and no capability
 * (transport, auth, state, clock) is ever touched.
 */
export function composeReleaseHost(
  options: ReleaseHostOptionsV1,
): ReleaseEntrypointDepsV1 {
  // The explicit host binding is validated before anything is constructed:
  // the frozen parser normalizes the repository identity, and the runtime
  // environment must be exactly `production` or `isolated`. A fault is a
  // static TypeError and no supplied value is ever echoed.
  let repository: RepositoryIdentityV1;
  try {
    repository = parseRepositoryIdentity(options.repository, "$");
  } catch {
    throw new TypeError(ERR_REPOSITORY);
  }
  const environment = options.environment;
  if (environment !== "production" && environment !== "isolated") {
    throw new TypeError(ERR_ENVIRONMENT);
  }
  const target = validateReleaseTargetConfig(options.target);
  const policyCheck = validateStabilityPolicy(options.policy);
  if (!policyCheck.ok) {
    throw new TypeError(`${ERR_POLICY}: ${policyCheck.detail}`);
  }
  const resolverInput = options.resolver === undefined
    ? null
    : validateResolverBinding(options, options.resolver, target);

  const deno = new DenoReleaseRESTClient({
    transport: options.deno.transport,
    auth: options.deno.auth,
    config: target,
    clock: options.clock,
  });
  const resolver = resolverInput === null
    ? new UnavailableBuildReceiptResolver()
    : new GithubBuildReceiptResolver(resolverInput);
  return {
    clock: options.clock,
    stateRead: options.stateRead,
    stateWrite: options.stateWrite,
    repository,
    environment,
    target,
    policy: options.policy,
    deno,
    resolver,
  };
}

/**
 * Validates the resolver binding shape and equality against the release
 * target binding, and returns the normalized resolver options. Structure
 * faults and binding mismatches are distinct static TypeErrors, both raised
 * before any concrete object is constructed.
 */
function validateResolverBinding(
  options: ReleaseHostOptionsV1,
  input: ReleaseHostResolverInputV1,
  target: ReleaseTargetConfigV1,
): GithubBuildReceiptResolverOptionsV1 {
  let repository: RepositoryIdentityV1;
  try {
    repository = parseRepositoryIdentity(input.repository, "$");
  } catch {
    throw new TypeError(ERR_RESOLVER_INPUT);
  }
  if (
    input.environment !== "production" && input.environment !== "isolated"
  ) {
    throw new TypeError(ERR_RESOLVER_INPUT);
  }
  if (typeof input.project !== "string" || input.project.length === 0) {
    throw new TypeError(ERR_RESOLVER_INPUT);
  }
  if (
    typeof input.baseBranch !== "string" || input.baseBranch.length === 0 ||
    RESOLVER_CONTROL_CHARS_RE.test(input.baseBranch) ||
    input.baseBranch !== input.baseBranch.trim() ||
    !RESOLVER_BASE_BRANCH_RE.test(input.baseBranch)
  ) {
    throw new TypeError(ERR_RESOLVER_INPUT);
  }
  if (!isGitSha(input.workflowBlobSha)) {
    throw new TypeError(ERR_RESOLVER_INPUT);
  }
  if (typeof input.auth !== "object" || input.auth === null) {
    throw new TypeError(ERR_RESOLVER_INPUT);
  }
  if (
    typeof (input.auth as { authorizationHeader?: unknown })
      .authorizationHeader !== "function"
  ) {
    throw new TypeError(ERR_RESOLVER_INPUT);
  }
  if (input.fetch !== undefined && typeof input.fetch !== "function") {
    throw new TypeError(ERR_RESOLVER_INPUT);
  }
  if (
    input.timeoutMs !== undefined &&
    (typeof input.timeoutMs !== "number" ||
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < RESOLVER_MIN_TIMEOUT_MS ||
      input.timeoutMs > RESOLVER_MAX_TIMEOUT_MS)
  ) {
    throw new TypeError(ERR_RESOLVER_INPUT);
  }

  if (
    repository.owner !== options.repository.owner ||
    repository.name !== options.repository.name ||
    repository.installationId !== options.repository.installationId
  ) {
    throw new TypeError(ERR_RESOLVER_REPOSITORY);
  }
  if (input.environment !== options.environment) {
    throw new TypeError(ERR_RESOLVER_ENVIRONMENT);
  }
  if (input.project !== target.projectId) {
    throw new TypeError(ERR_RESOLVER_PROJECT);
  }
  return {
    repository,
    environment: input.environment,
    project: input.project,
    baseBranch: input.baseBranch,
    workflowBlobSha: input.workflowBlobSha,
    clock: options.clock,
    auth: input.auth,
    fetch: input.fetch,
    timeoutMs: input.timeoutMs,
  };
}
