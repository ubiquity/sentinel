/**
 * Wave C top-level trusted-host assembly (one bounded host wiring module).
 *
 * `assembleTrustedHost` closes the last local composition gap: it imports the
 * existing host seams — src/host/github.ts (`composeGitHubHost`),
 * src/host/repair.ts (`composeRepairHost`) and src/host/release.ts
 * (`composeReleaseHost`) — and composes them from ONE explicit caller-
 * supplied capability set, returning the EXACT repair and release
 * entrypoint dependency sets:
 *
 * - `repair`: the typed `RepairEntrypointDepsV1` consumed by
 *   `runRepairEntrypoint` — repair state writer + budget + model path, the
 *   composed GitHub port and the one shared cooldown gate. It never receives
 *   release write capability, a Deno release port or release records.
 * - `release`: the typed `ReleaseEntrypointDepsV1` consumed by
 *   `runReleaseEntrypoint` — read-only state view plus the release-only
 *   writer, the Deno release port and the (default unavailable) build-receipt
 *   resolver. It never receives repair write capability, work records,
 *   budget, model or admission authority.
 * - `github`: the `GitHubHostResultV1` (composed port plus the exact
 *   `GitExecutorV1` identity the port publishes through) for host-side
 *   reconciliation; it is not part of either entrypoint capability set.
 *
 * Shared-capability identity is guaranteed structurally, not by convention:
 *
 * - ONE `clock` and ONE `githubCooldown` are hoisted to the assembly options
 *   and injected into every seam. A caller cannot express a second cooldown
 *   gate; the assembly's explicit fields override whatever a sub-record
 *   carries, so a late JS value can never register a parallel gate.
 * - The composed GitHub port (one instance) is handed to the repair host, so
 *   repair publishing and the host's own git reconciliation share one
 *   executor identity.
 *
 * Every external/secret-bearing capability stays an explicit typed value or
 * closure on the options; the assembly reads no environment variable, no
 * filesystem state and no network, and it manufactures no credential, model
 * receipt, build receipt, revision choice or sandbox attestation. An omitted
 * receipt verifier keeps the implementation port's default unverified-receipt
 * policy (no model session), an omitted release resolver keeps the
 * unavailable build-receipt default (no promotion), and a false/absent
 * restricted-execution attestation fails closed before construction.
 *
 * Validation order (fail fast, static non-echoing `TypeError` text only):
 * the ONE clock and the ONE cooldown gate shapes, every capability shape,
 * controller SHA, config set and repository identity are re-validated with
 * the frozen contracts, the three repository bindings must agree exactly
 * with the composed repair repository and it must match exactly one
 * configured repository, the release target/policy are re-validated, and the
 * isolation attestation must prove restricted execution — all BEFORE any
 * downstream instance is constructed.
 */

import { isGitSha } from "../contracts/brands.ts";
import type { Clock, GitHubCooldownGateV1 } from "../contracts/ports.ts";
import { parseRepositoryConfigV1 } from "../contracts/repository-config.ts";
import type {
  RepositoryConfigV1,
  StabilityPolicyV1,
} from "../contracts/repository-config.ts";
import { parseRepositoryIdentity } from "../contracts/shared.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import {
  validateReleaseTargetConfig,
  validateStabilityPolicy,
} from "../release/config.ts";
import type { RepairEntrypointDepsV1 } from "../main.ts";
import type { ReleaseEntrypointDepsV1 } from "../release-main.ts";
import {
  composeGitHubHost,
  type GitHubHostOptionsV1,
  type GitHubHostResultV1,
} from "./github.ts";
import { composeRepairHost, type RepairHostOptionsV1 } from "./repair.ts";
import { composeReleaseHost, type ReleaseHostOptionsV1 } from "./release.ts";
import { createReplayIsolationHost } from "./providers.ts";

/** Static reject texts; no input-derived text is ever interpolated. */
const ERR_CONTROLLER_SHA =
  "trusted host assembly rejected: controller SHA is not an exact lowercase 40-hex commit SHA";
const ERR_CONFIGS =
  "trusted host assembly rejected: a repository configuration is invalid";
const ERR_GITHUB_REPOSITORY =
  "trusted host assembly rejected: github host repository identity is invalid";
const ERR_GATEWAY_REPOSITORY =
  "trusted host assembly rejected: the gateway repository identity is invalid";
const ERR_RELEASE_REPOSITORY =
  "trusted host assembly rejected: release host repository identity is invalid";
const ERR_UNCONFIGURED_REPOSITORY =
  "trusted host assembly rejected: the composed repository is not among the configured repositories";
const ERR_AMBIGUOUS_REPOSITORY =
  "trusted host assembly rejected: the composed repository matches more than one configured repository";
const ERR_GITHUB_GATEWAY_MISMATCH =
  "trusted host assembly rejected: the github host repository does not match the repair gateway repository";
const ERR_RELEASE_MISMATCH =
  "trusted host assembly rejected: the release repository does not match the composed repair repository";
const ERR_TOP_LEVEL =
  "trusted host assembly rejected: host options are invalid";
const ERR_CLOCK = "trusted host assembly rejected: clock shape is invalid";
const ERR_COOLDOWN =
  "trusted host assembly rejected: github cooldown gate shape is invalid";
const ERR_GITHUB_INPUT =
  "trusted host assembly rejected: github host inputs are invalid";
const ERR_GITHUB_HTTP =
  "trusted host assembly rejected: github HTTP transport shape is invalid";
const ERR_GITHUB_AUTH =
  "trusted host assembly rejected: github auth provider shape is invalid";
const ERR_GITHUB_REVIEW =
  "trusted host assembly rejected: github review service shape is invalid";
const ERR_GITHUB_RESOLVER =
  "trusted host assembly rejected: github resolution verifier shape is invalid";
const ERR_REPAIR_INPUT =
  "trusted host assembly rejected: repair host inputs are invalid";
const ERR_REPAIR_STATE =
  "trusted host assembly rejected: repair state capability shape is invalid";
const ERR_GATEWAY_INPUT =
  "trusted host assembly rejected: gateway inputs are invalid";
const ERR_GATEWAY_TRANSPORT =
  "trusted host assembly rejected: gateway transport shape is invalid";
const ERR_GATEWAY_AUTH =
  "trusted host assembly rejected: gateway auth provider shape is invalid";
const ERR_GATEWAY_STORE =
  "trusted host assembly rejected: gateway artifact store shape is invalid";
const ERR_GATEWAY_KEY =
  "trusted host assembly rejected: gateway key capability shape is invalid";
const ERR_REPLAY_INPUT =
  "trusted host assembly rejected: replay inputs are invalid";
const ERR_REPLAY_SOURCE =
  "trusted host assembly rejected: replay source shape is invalid";
const ERR_REPLAY_POLICY =
  "trusted host assembly rejected: replay policy shape is invalid";
const ERR_MODEL_INPUT =
  "trusted host assembly rejected: model inputs are invalid";
const ERR_MODEL_SESSION =
  "trusted host assembly rejected: model session opener shape is invalid";
const ERR_MODEL_CHECKOUT =
  "trusted host assembly rejected: model checkout path is invalid";
const ERR_MODEL_RECEIPT =
  "trusted host assembly rejected: model receipt verifier shape is invalid";
const ERR_RELEASE_INPUT =
  "trusted host assembly rejected: release host inputs are invalid";
const ERR_RELEASE_STATE_READ =
  "trusted host assembly rejected: release state read view shape is invalid";
const ERR_RELEASE_STATE_WRITE =
  "trusted host assembly rejected: release state writer shape is invalid";
const ERR_RELEASE_DENO =
  "trusted host assembly rejected: release Deno capability shape is invalid";
const ERR_RELEASE_ENVIRONMENT =
  "trusted host assembly rejected: release environment is invalid";
const ERR_RELEASE_TARGET =
  "trusted host assembly rejected: release target configuration is invalid";
const ERR_RELEASE_POLICY =
  "trusted host assembly rejected: release stability policy is invalid";
const ERR_RELEASE_RESOLVER =
  "trusted host assembly rejected: release receipt resolver shape is invalid";

/**
 * The complete explicit capability set the top-level assembly consumes. The
 * ONE clock and the ONE durable GitHub cooldown gate are hoisted here: the
 * assembly injects these exact instances into every seam and accepts no
 * alternative from any sub-record. `github`/`repair`/`release` keep the
 * remaining seam inputs; the composed GitHub port is derived once and handed
 * to the repair host.
 */
export interface TrustedHostOptionsV1 {
  /** THE trusted-host clock: the same instance for every seam. */
  clock: Clock;
  /**
   * THE one durable GitHub cooldown gate: the same instance is injected into
   * the GitHub host composition (authentication) and the repair host
   * composition (loop checks); no default or second gate exists.
   */
  githubCooldown: GitHubCooldownGateV1;
  /** GitHub host seam inputs (repository, transports, auth, git settings). */
  github: Omit<GitHubHostOptionsV1, "clock" | "cooldownGate">;
  /**
   * Repair host seam inputs. `github`, the shared `clock` and the shared
   * `githubCooldown` are injected by the assembly.
   */
  repair: Omit<RepairHostOptionsV1, "clock" | "github" | "githubCooldown">;
  /** Release host seam inputs; the shared clock is injected by the assembly. */
  release: Omit<ReleaseHostOptionsV1, "clock">;
}

/** The composed host capability set: both exact entrypoint deps plus the host git identity. */
export interface TrustedHostAssemblyV1 {
  /** Exact repair entrypoint deps (repair writer + budget + model path). */
  repair: RepairEntrypointDepsV1;
  /** Exact release entrypoint deps (read-only state + release-only writer). */
  release: ReleaseEntrypointDepsV1;
  /**
   * The composed GitHub port and the exact `GitExecutorV1` identity the port
   * publishes through — one executor, one binding; host-side reconciliation
   * observes exactly what the repair host publishes.
   */
  github: GitHubHostResultV1;
}

/**
 * Compose the GitHub, repair and release host seams into one explicit
 * capability set. All validation happens before any construction: a static
 * non-echoing `TypeError` is thrown and no transport, auth provider, gate,
 * state, model or release capability has been touched.
 */
export function assembleTrustedHost(
  options: TrustedHostOptionsV1,
): TrustedHostAssemblyV1 {
  // 1. Top-level shape: the assembly is a composition seam, not a default.
  //    The ONE clock and the ONE cooldown gate are hoisted capabilities, so
  //    they are validated here — before any sub-record is dereferenced and
  //    before any downstream constructor runs. Every read is a contained
  //    readField/spreadRecord: a hostile accessor or property-enumeration
  //    fault is the SAME static non-echoing TypeError the shape check would
  //    reject with, never a raw thrown value.
  expectRecord(options, ERR_TOP_LEVEL);
  const clock = readField<Clock>(options, "clock", ERR_CLOCK);
  expectMethod(clock, "now", ERR_CLOCK);
  const githubCooldown = readField<GitHubCooldownGateV1>(
    options,
    "githubCooldown",
    ERR_COOLDOWN,
  );
  expectRecord(githubCooldown, ERR_COOLDOWN);
  expectCallable(
    readField(githubCooldown, "beforeRequest", ERR_COOLDOWN),
    ERR_COOLDOWN,
  );
  expectCallable(
    readField(githubCooldown, "recordRateLimit", ERR_COOLDOWN),
    ERR_COOLDOWN,
  );
  const githubInput = readField<
    Omit<GitHubHostOptionsV1, "clock" | "cooldownGate">
  >(options, "github", ERR_GITHUB_INPUT);
  expectRecord(githubInput, ERR_GITHUB_INPUT);
  const repairInput = readField<
    Omit<RepairHostOptionsV1, "clock" | "github" | "githubCooldown">
  >(options, "repair", ERR_REPAIR_INPUT);
  expectRecord(repairInput, ERR_REPAIR_INPUT);
  const releaseInput = readField<Omit<ReleaseHostOptionsV1, "clock">>(
    options,
    "release",
    ERR_RELEASE_INPUT,
  );
  expectRecord(releaseInput, ERR_RELEASE_INPUT);

  // 2. Required capability shapes (fail-closed before any instance exists,
  //    and before any sub-record is dereferenced).
  validateGitHubShapes(githubInput);
  validateRepairShapes(repairInput);
  validateReleaseShapes(releaseInput);

  // 3. Controller identity: exact lowercase 40-hex Git commit SHA (frozen
  //    brand predicate) before any config or instance processing.
  if (!isGitSha(readField(repairInput, "controllerSha", ERR_CONTROLLER_SHA))) {
    throw new TypeError(ERR_CONTROLLER_SHA);
  }

  // 4. Complete config set through the frozen parser; rejections are static
  //    and the whole pass is contained (a hostile array/enumeration fault is
  //    the same static config error, never a raw throw).
  const configs: RepositoryConfigV1[] = [];
  try {
    const configSet = readField<readonly unknown[]>(
      repairInput,
      "configs",
      ERR_CONFIGS,
    );
    for (const config of configSet) {
      configs.push(parseRepositoryConfigV1(config));
    }
  } catch {
    throw new TypeError(ERR_CONFIGS);
  }

  // 5. Every repository identity through the frozen parser, then prove the
  //    bindings agree. The GitHub host, the gateway adapter and the release
  //    controller must all own the SAME exact repository (owner + name +
  //    installation id), and that repository must appear exactly once in the
  //    configured set — a drift is a host wiring fault, never a late
  //    resolve-time surprise.
  const githubRepository = parseIdentity(
    readField(githubInput, "repository", ERR_GITHUB_REPOSITORY),
    "$",
    ERR_GITHUB_REPOSITORY,
  );
  const gatewayRecord = readField(repairInput, "gateway", ERR_GATEWAY_INPUT);
  expectRecord(gatewayRecord, ERR_GATEWAY_INPUT);
  const gatewayRepository = parseIdentity(
    readField(gatewayRecord, "repository", ERR_GATEWAY_REPOSITORY),
    "$",
    ERR_GATEWAY_REPOSITORY,
  );
  if (!sameRepositoryIdentity(githubRepository, gatewayRepository)) {
    throw new TypeError(ERR_GITHUB_GATEWAY_MISMATCH);
  }
  const matches = configs.filter((config) =>
    sameRepositoryIdentity(config.repository, githubRepository)
  );
  if (matches.length === 0) throw new TypeError(ERR_UNCONFIGURED_REPOSITORY);
  if (matches.length > 1) throw new TypeError(ERR_AMBIGUOUS_REPOSITORY);
  const releaseRepository = parseIdentity(
    readField(releaseInput, "repository", ERR_RELEASE_REPOSITORY),
    "$",
    ERR_RELEASE_REPOSITORY,
  );
  if (!sameRepositoryIdentity(releaseRepository, githubRepository)) {
    throw new TypeError(ERR_RELEASE_MISMATCH);
  }

  // 6. Restricted-execution attestation: the concrete port requirement is
  //    enforced at this boundary too, so a false/absent attestation fails
  //    closed before the replay port could even refuse construction.
  const replayRecord = readField(repairInput, "replay", ERR_REPLAY_INPUT);
  expectRecord(replayRecord, ERR_REPLAY_INPUT);
  const isolation = readField(
    replayRecord,
    "isolation",
    ERR_REPLAY_INPUT,
  ) as unknown as { attestation?: unknown } | null;
  expectRecord(isolation, ERR_REPLAY_INPUT);
  createReplayIsolationHost(
    readField(isolation, "attestation", ERR_REPLAY_INPUT),
  );

  // 7. Compose the three seams. The assembly's explicit clock/cooldown gate/
  //    composed GitHub port override any sub-record value, so a single shared
  //    gate and one executor identity are structural, not conventional.
  //    spreadRecord snapshots each validated input into a plain record, so a
  //    later enumeration fault is the same static input error.
  const github = composeGitHubHost({
    ...spreadRecord(githubInput, ERR_GITHUB_INPUT),
    clock,
    cooldownGate: githubCooldown,
  });
  const repair = composeRepairHost({
    ...spreadRecord(repairInput, ERR_REPAIR_INPUT),
    clock,
    github: github.port,
    githubCooldown,
  });
  const release = composeReleaseHost({
    ...spreadRecord(releaseInput, ERR_RELEASE_INPUT),
    clock,
  });

  return { repair, release, github };
}

/** Exact repository identity: owner, name AND installation id are one. */
function sameRepositoryIdentity(
  a: RepositoryIdentityV1,
  b: RepositoryIdentityV1,
): boolean {
  return a.owner === b.owner && a.name === b.name &&
    a.installationId === b.installationId;
}

/** Parse one repository identity; any fault is the given static error. */
function parseIdentity(
  input: unknown,
  path: string,
  error: string,
): RepositoryIdentityV1 {
  try {
    return parseRepositoryIdentity(input, path);
  } catch {
    throw new TypeError(error);
  }
}

// ---------------------------------------------------------------------------
// Capability shape checks (static, non-echoing; no value is ever printed)
// ---------------------------------------------------------------------------

function validateGitHubShapes(
  github: Omit<GitHubHostOptionsV1, "clock" | "cooldownGate">,
): void {
  expectCallable(readField(github, "http", ERR_GITHUB_HTTP), ERR_GITHUB_HTTP);
  expectMethod(
    readField(github, "auth", ERR_GITHUB_AUTH),
    "authorizationHeader",
    ERR_GITHUB_AUTH,
  );
  const reviewService = readField(
    github,
    "reviewService",
    ERR_GITHUB_REVIEW,
  );
  expectRecord(reviewService, ERR_GITHUB_REVIEW);
  expectCallable(
    readField(reviewService, "submitReview", ERR_GITHUB_REVIEW),
    ERR_GITHUB_REVIEW,
  );
  expectCallable(
    readField(reviewService, "readReview", ERR_GITHUB_REVIEW),
    ERR_GITHUB_REVIEW,
  );
  const resolutionVerifier = readField(
    github,
    "resolutionVerifier",
    ERR_GITHUB_RESOLVER,
  );
  if (resolutionVerifier !== undefined) {
    expectMethod(
      resolutionVerifier,
      "verifyResolution",
      ERR_GITHUB_RESOLVER,
    );
  }
}

function validateRepairShapes(
  repair: Omit<RepairHostOptionsV1, "clock" | "github" | "githubCooldown">,
): void {
  if (!Array.isArray(readField(repair, "configs", ERR_CONFIGS))) {
    throw new TypeError(ERR_CONFIGS);
  }
  // Repair state: read + repair-write capability shape (never a release
  // writer; the release writer is only accepted by the release assembly).
  const state = readField(repair, "state", ERR_REPAIR_STATE);
  expectRecord(state, ERR_REPAIR_STATE);
  expectCallable(
    readField(state, "readRepair", ERR_REPAIR_STATE),
    ERR_REPAIR_STATE,
  );
  expectCallable(
    readField(state, "writeRepair", ERR_REPAIR_STATE),
    ERR_REPAIR_STATE,
  );

  const gateway = readField(repair, "gateway", ERR_GATEWAY_INPUT);
  expectRecord(gateway, ERR_GATEWAY_INPUT);
  expectCallable(
    readField(gateway, "transport", ERR_GATEWAY_TRANSPORT),
    ERR_GATEWAY_TRANSPORT,
  );
  expectMethod(
    readField(gateway, "auth", ERR_GATEWAY_AUTH),
    "headers",
    ERR_GATEWAY_AUTH,
  );
  const store = readField(gateway, "store", ERR_GATEWAY_STORE);
  expectRecord(store, ERR_GATEWAY_STORE);
  const keyBytes = readField(gateway, "keyBytes", ERR_GATEWAY_KEY);
  if (!(keyBytes instanceof Uint8Array)) {
    throw new TypeError(ERR_GATEWAY_KEY);
  }

  const replay = readField(repair, "replay", ERR_REPLAY_INPUT);
  expectRecord(replay, ERR_REPLAY_INPUT);
  const source = readField(replay, "source", ERR_REPLAY_SOURCE);
  if (typeof source !== "object" || source === null) {
    throw new TypeError(ERR_REPLAY_SOURCE);
  }
  const sourceRecord = source as Record<string, unknown>;
  const sourceKind = readField(sourceRecord, "kind", ERR_REPLAY_SOURCE);
  if (sourceKind !== "local" && sourceKind !== "remote") {
    throw new TypeError(ERR_REPLAY_SOURCE);
  }
  if (
    sourceKind === "local" &&
    typeof readField(sourceRecord, "path", ERR_REPLAY_SOURCE) !== "string"
  ) {
    throw new TypeError(ERR_REPLAY_SOURCE);
  }
  if (
    sourceKind === "remote" &&
    typeof readField(sourceRecord, "url", ERR_REPLAY_SOURCE) !== "string"
  ) {
    throw new TypeError(ERR_REPLAY_SOURCE);
  }
  const scratchDir = readField(replay, "scratchDir", ERR_REPLAY_INPUT);
  if (typeof scratchDir !== "string" || scratchDir.length === 0) {
    throw new TypeError(ERR_REPLAY_INPUT);
  }
  expectRecord(
    readField(replay, "policy", ERR_REPLAY_POLICY),
    ERR_REPLAY_POLICY,
  );
  const replayIsolation = readField(replay, "isolation", ERR_REPLAY_INPUT);
  expectRecord(replayIsolation, ERR_REPLAY_INPUT);

  const model = readField(repair, "model", ERR_MODEL_INPUT);
  expectRecord(model, ERR_MODEL_INPUT);
  expectCallable(
    readField(model, "openSession", ERR_MODEL_SESSION),
    ERR_MODEL_SESSION,
  );
  const checkoutDir = readField(model, "checkoutDir", ERR_MODEL_CHECKOUT);
  if (typeof checkoutDir !== "string" || checkoutDir.length === 0) {
    throw new TypeError(ERR_MODEL_CHECKOUT);
  }
  const checkout = readField(model, "checkout", ERR_MODEL_INPUT);
  if (checkout !== undefined) {
    expectMethod(checkout, "resolve", ERR_MODEL_INPUT);
  }
  const commitCandidate = readField(
    model,
    "commitCandidate",
    ERR_MODEL_INPUT,
  );
  if (commitCandidate !== undefined) {
    expectMethod(commitCandidate, "commit", ERR_MODEL_INPUT);
  }
  const receiptVerifier = readField(
    model,
    "receiptVerifier",
    ERR_MODEL_RECEIPT,
  );
  if (receiptVerifier !== undefined) {
    expectCallable(receiptVerifier, ERR_MODEL_RECEIPT);
  }
}

function validateReleaseShapes(
  release: Omit<ReleaseHostOptionsV1, "clock">,
): void {
  const environment = readField(
    release,
    "environment",
    ERR_RELEASE_ENVIRONMENT,
  );
  if (environment !== "production" && environment !== "isolated") {
    throw new TypeError(ERR_RELEASE_ENVIRONMENT);
  }
  const target = readField(release, "target", ERR_RELEASE_TARGET);
  expectRecord(target, ERR_RELEASE_TARGET);
  try {
    validateReleaseTargetConfig(target);
  } catch {
    throw new TypeError(ERR_RELEASE_TARGET);
  }
  const policy = readField(release, "policy", ERR_RELEASE_POLICY);
  expectRecord(policy, ERR_RELEASE_POLICY);
  let policyCheck: ReturnType<typeof validateStabilityPolicy>;
  try {
    policyCheck = validateStabilityPolicy(
      policy as unknown as StabilityPolicyV1,
    );
  } catch {
    throw new TypeError(ERR_RELEASE_POLICY);
  }
  if (!policyCheck.ok) throw new TypeError(ERR_RELEASE_POLICY);

  const stateRead = readField(release, "stateRead", ERR_RELEASE_STATE_READ);
  expectRecord(stateRead, ERR_RELEASE_STATE_READ);
  expectCallable(
    readField(stateRead, "readRepair", ERR_RELEASE_STATE_READ),
    ERR_RELEASE_STATE_READ,
  );
  expectCallable(
    readField(stateRead, "readRelease", ERR_RELEASE_STATE_READ),
    ERR_RELEASE_STATE_READ,
  );
  const stateWrite = readField(
    release,
    "stateWrite",
    ERR_RELEASE_STATE_WRITE,
  );
  expectRecord(stateWrite, ERR_RELEASE_STATE_WRITE);
  expectCallable(
    readField(stateWrite, "writeRelease", ERR_RELEASE_STATE_WRITE),
    ERR_RELEASE_STATE_WRITE,
  );

  const deno = readField(release, "deno", ERR_RELEASE_DENO);
  expectRecord(deno, ERR_RELEASE_DENO);
  expectCallable(
    readField(deno, "transport", ERR_RELEASE_DENO),
    ERR_RELEASE_DENO,
  );
  expectMethod(
    readField(deno, "auth", ERR_RELEASE_DENO),
    "bearerToken",
    ERR_RELEASE_DENO,
  );
  const resolver = readField(release, "resolver", ERR_RELEASE_RESOLVER);
  if (resolver !== undefined) {
    expectMethod(resolver, "resolve", ERR_RELEASE_RESOLVER);
  }
}

// ---------------------------------------------------------------------------
// Shape primitives (static TypeErrors only; nothing is echoed)
// ---------------------------------------------------------------------------

function expectRecord(
  value: unknown,
  error: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(error);
  }
}

function expectCallable(value: unknown, error: string): void {
  if (typeof value !== "function") throw new TypeError(error);
}

function expectMethod(
  value: unknown,
  method: string,
  error: string,
): void {
  expectRecord(value, error);
  expectCallable(readField(value, method, error), error);
}

/**
 * Read one field with the get trap contained: a hostile accessor/proxy fault
 * is the same static non-echoing TypeError the field's own shape check would
 * reject with, so nothing caller-controlled can escape this validation
 * boundary as a raw error or value.
 */
function readField<Value = unknown>(
  record: Record<string, unknown>,
  key: string,
  error: string,
): Value {
  try {
    return record[key] as Value;
  } catch {
    throw new TypeError(error);
  }
}

/**
 * Snapshot one validated record into a plain object with property
 * enumeration contained: a hostile ownKeys/get trap is the same static
 * non-echoing TypeError, and downstream seams never see a proxy.
 */
function spreadRecord<Value extends object>(
  record: Value,
  error: string,
): Value {
  try {
    return { ...record } as Value;
  } catch {
    throw new TypeError(error);
  }
}
