/**
 * One-shot owner-authorized development installation.
 *
 * This fixed trusted operation performs at most one pointer movement in the
 * hosted release state: original generation 5 -> reader generation 6 ->
 * aggregate generation 7 -> review recovery generation 8 -> review-step
 * reconciliation generation 9 -> reviewer provenance generation 10 ->
 * one-shot exit contract generation 11, plus a one-time
 * rollback of an exact failed candidate to its recorded previously healthy
 * revision. It is NOT a runtime redesign and NOT a recurring global gate: every other state is a zero-write
 * waiting/no-change outcome so the unchanged protected supervisor continues
 * to settle and verify its own work. A rollback state never reattempts
 * installation by itself.
 *
 * Storage authority stays read-only: the complete release snapshot is read and
 * validated through the existing release-role Git store. The movement itself
 * is one explicitly owner-authorized commit created through GitHub's existing
 * Git database API with the exact expected state head as its ONLY parent, then
 * published with a non-force ref update. The commit message carries the
 * permanent owner-development-install record (authority timestamp, exact
 * prior/next revision and generation, expected parent state head, the exact
 * authorizing healthy proof and a random write nonce); the commit id remains
 * the durable rollback record. No review, release receipt, execution intent,
 * live-delivery claim or autonomous transition is fabricated.
 *
 * Identity is fixed: the process must be the `prepare` job of the protected
 * `sentinel-supervisor` workflow at the exact dispatched source commit. The
 * App token is used only for release-store/Git-data authority; the repository
 * token is used only for the read-only ancestry and test-local check
 * verification of an installed revision. Credentials are read by name, never
 * printed and never placed in a URL.
 */

import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import {
  HOSTED_SUPERVISOR_REF,
  HOSTED_SUPERVISOR_REPOSITORY,
  parseHostedRunProofV1,
  parseHostedRuntimeRecordV1,
} from "../contracts/hosted-supervisor.ts";
import type {
  HostedRunProofV1,
  HostedRuntimeRecordV1,
} from "../contracts/hosted-supervisor.ts";
import type {
  PortResultV1,
  StateReadResultV1,
  StateReadView,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import { parseReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { tryParse } from "../contracts/validation.ts";
import { createReleaseStateStore, DenoGitRunner } from "../state/mod.ts";
import { ensurePrivateDir, githubGitAuthEnv, joinPath } from "./local.ts";

/** The only repository this operation may touch; fixed, never configurable. */
export const OWNER_DEVELOPMENT_INSTALL_REPOSITORY =
  HOSTED_SUPERVISOR_REPOSITORY;
/** The only remote the release-state store may read; fixed. */
export const OWNER_DEVELOPMENT_INSTALL_REMOTE_URL =
  "https://github.com/ubiquity/sentinel.git";
/** Moving development ref the installed revisions must remain ancestors of. */
export const OWNER_DEVELOPMENT_INSTALL_DEVELOPMENT_BRANCH = "development";
/** The fixed release-state branch; only its ref is ever updated. */
export const OWNER_DEVELOPMENT_INSTALL_RELEASE_BRANCH =
  "sentinel-state/release";
/** The deterministic CI check a freshly installed revision must carry. */
export const OWNER_DEVELOPMENT_INSTALL_TEST_LOCAL_CHECK = "test-local";

/** Exact first installed revision of the fixed owner development chain. */
export const OWNER_DEVELOPMENT_INSTALL_ORIGINAL_REVISION =
  "20aae115b44ed740c37e2452de4d5530b66430ec" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_ORIGINAL_GENERATION = 5;
/** Exact middle revision installed only after the original healthy proof. */
export const OWNER_DEVELOPMENT_INSTALL_READER_REVISION =
  "864d7a0cbb595616b4e90293338f496788b8321a" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_READER_GENERATION = 6;
/** Exact final revision installed only after the reader healthy proof. */
export const OWNER_DEVELOPMENT_INSTALL_AGGREGATE_REVISION =
  "92f3a87f0d0bfb0f0784bf9af4e5402800086852" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_AGGREGATE_GENERATION = 7;
/**
 * Exact revision carrying the review no-verdict recovery fix, installed only
 * after the aggregate generation 7 healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_RECOVERY_REVISION =
  "fd5902a8998a7dd906fa15666c448fdb4b845aec" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_RECOVERY_GENERATION = 8;
/**
 * Exact revision carrying the review-step base-refresh reconciliation,
 * installed only after the review recovery generation 8 healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_REVISION =
  "87193550640078f190ab94d7f8ca0f00bbef9124" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_GENERATION = 9;
/**
 * Exact revision accepting the agent unified-exec command sources in review
 * evidence, installed only after the review-step generation 9 healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_REVIEWER_REVISION =
  "80384fc3668c246297621aa1c588c0e49ea516c6" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_REVIEWER_GENERATION = 10;
/**
 * Exact revision carrying the one-shot exit contract, installed only after the
 * reviewer provenance generation 10 healthy proof. Its install is also what
 * gives the runtime an immediate health-gap execution after a bounded grant.
 */
export const OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_REVISION =
  "3f500514f464c7c1ae66cc02bfe6fc4963387d04" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_GENERATION = 11;
/**
 * Exact revision carrying the corrected closed grant set; its install is also
 * what gives the runtime an immediate health-gap execution that consumes the
 * grant in the same run the maintenance job applies it.
 */
export const OWNER_DEVELOPMENT_INSTALL_ROUND8_REVISION =
  "e2bb6c2b1d0cafaefe9e16c16b421522819c823e" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_ROUND8_GENERATION = 12;
/**
 * Exact revision that carries the review findings into a correction prompt; its
 * install is also what gives the runtime an immediate health-gap execution.
 */
export const OWNER_DEVELOPMENT_INSTALL_FINDINGS_REVISION =
  "664a52ddeb4f23eafa58a32e8394754f3303f0c4" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_FINDINGS_GENERATION = 13;
/**
 * Exact revision folding earlier rejections into a correction prompt; its
 * install also gives the runtime an immediate health-gap execution.
 */
export const OWNER_DEVELOPMENT_INSTALL_HISTORY_REVISION =
  "4c209ddaf21a94be2c226d1ce31060dca8543f68" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_HISTORY_GENERATION = 14;
/**
 * Exact revision building a settled review receipt from its durable request
 * reservation (the CI-verified revision, which contains the capped-submission
 * fix); its install also triggers an immediate health-gap execution.
 */
export const OWNER_DEVELOPMENT_INSTALL_RECEIPT_REVISION =
  "9fcc959bcdc903aed21f2bbe968c8838d86010ef" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_RECEIPT_GENERATION = 15;
/**
 * Exact revision carrying the delivery-evidence ledger and the local case
 * evaluator (the CI-verified development tip); its install also triggers an
 * immediate execution, so a delivered review round is observed without waiting
 * for the hourly ordinary cadence.
 */
export const OWNER_DEVELOPMENT_INSTALL_LEDGER_REVISION =
  "2b6a25b7d9992c6a027448e43d5ce104d8f1a93e" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_LEDGER_GENERATION = 16;
/**
 * Exact revision carrying the honest cancelled-execution settlement and the
 * delivery ledger; its install also triggers an immediate execution after a
 * further bounded correction grant.
 */
export const OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_REVISION =
  "fc25d716981870ce6b7038c2eda94ed2430cca58" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_GENERATION = 17;
/**
 * Exact revision the hosted promotion accepted for the delivered self-repair
 * (generation 18). It is the pointer the trigger install below starts from.
 */
export const OWNER_DEVELOPMENT_INSTALL_RELEASED_REVISION =
  "1ed66cd191271cc206aaf436d0f93d245aaee936" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_RELEASED_GENERATION = 18;
/**
 * Exact revision carrying default-include intake, the autonomous delivery pass
 * and the automatic issue closure. Its install also triggers an immediate
 * execution, which is how the owner asks the fleet to start working now instead
 * of waiting for the hourly ordinary cadence.
 */
export const OWNER_DEVELOPMENT_INSTALL_TRIGGER_REVISION =
  "0853a5c0454d17ab73856d3c9621dc534a0fa706" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_TRIGGER_GENERATION = 19;
/**
 * Exact revision carrying the base-advance recovery for a wedged attempt
 * budget. Its install triggers an immediate execution, which is how the loop
 * reconciles the pending refresh and runs the next model session now.
 */
export const OWNER_DEVELOPMENT_INSTALL_ADVANCE_REVISION =
  "33ff7fb27c5cb272d953f9ddaae3be1271212afd" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_ADVANCE_GENERATION = 20;
/**
 * Exact revision carrying the cadence-based retry policy. Its install triggers
 * the immediate execution that retries the wedged tasks.
 */
export const OWNER_DEVELOPMENT_INSTALL_CADENCE_REVISION =
  "9f1bde9e342547c23dc1dc69f7650704d0f43e7f" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_CADENCE_GENERATION = 21;
/**
 * Exact revision carrying the closed-issue retry guard, so the next execution
 * spends its model session on a repairable task instead of a closed one.
 */
export const OWNER_DEVELOPMENT_INSTALL_GUARD_REVISION =
  "6c5ab021deff64f0df38e1841cbed259cc6287fb" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_GUARD_GENERATION = 22;
/**
 * Exact revision carrying the retirement pass. Its install triggers the
 * immediate execution that records the pending review verdict and starts the
 * correction round.
 */
export const OWNER_DEVELOPMENT_INSTALL_RETIRE_REVISION =
  "cf8e6610b206f80b976785d12eef9d8fa1706311" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_RETIRE_GENERATION = 23;
/**
 * Exact revision and generation the live pointer may carry when the App
 * identity install is authorized: the delivered self-repair merge advanced
 * the pointer one generation past the retirement link through an ordinary
 * correction round. Its own healthy proof authorizes the next install.
 */
export const OWNER_DEVELOPMENT_INSTALL_DELIVERED_ROUND2_REVISION =
  "38c70a5bf3e58ff3fb1c7cfeb7a91e98105c3d1a" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_DELIVERED_ROUND2_GENERATION = 24;
/**
 * Exact revision carrying the single ubiquity-sentinel App identity. Installed
 * only after the retirement revision's own healthy proof, so every
 * repository-visible code change the runtime publishes is attributed to
 * `ubiquity-sentinel[bot]` instead of the native Actions bot.
 */
export const OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_REVISION =
  "c07fc944759a3fb1eaddfc4d180a17b9ac15136d" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_GENERATION = 25;
/**
 * Exact revision carrying the DeepSeek-direct fallback model route together
 * with the launcher pass-through that lets the child actually receive it.
 * Installed only after the App identity revision's own healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_REVISION =
  "c09c9fd84614298a6b3fd6eeabd42e9a6b4d6eb8" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_GENERATION = 26;
/**
 * Exact revision switching the gateway model id to the separately metered
 * `gpt-reserve` (luna under its own quota class). Installed only after the
 * model-route revision's own healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_RESERVE_MODEL_REVISION =
  "cbfa39cb8fc35630ea01281bcc5bdf9075d89d1a" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_RESERVE_MODEL_GENERATION = 27;
/**
 * Exact revision addressing EVERY committed target. It gives each target its
 * own private source mirror seeded from that target's authenticated remote,
 * so a foreign target's base commit can actually be resolved, and it restores
 * each target's candidate objects from that target's own remote under the
 * `ubiquity-sentinel` App installation scope. Installed only after the
 * reserve-model revision's own healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_MULTI_TARGET_REVISION =
  "dfd283e83e634dad4473c612bb3ee1aefe25f6b8" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_MULTI_TARGET_GENERATION = 28;
/**
 * Exact revision whose repair cooldown gate admits each target's own
 * installation scope. Generation 28 still latched the shared gate on the first
 * foreign-scope request, which faulted the ONE gate every target shares, so
 * generation 29 is what actually lets a foreign target run. Installed only
 * after the multi-target revision's own healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_SCOPE_GATE_REVISION =
  "dbae19f218141a44becd7d1fffc22d792913b4f0" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_SCOPE_GATE_GENERATION = 29;
/**
 * Exact revision scoping the candidate Git auth header to the target's own
 * remote. Generation 29 ran a full multi-target cycle and produced a genuine
 * ai.ubq.fi candidate, but every candidate push was anonymous because the
 * header named the sentinel URL, so nothing landed on the foreign remote.
 * Installed only after the scope-gate revision's own healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_CANDIDATE_AUTH_REVISION =
  "4da7f5a87a159d36aad1e20d8698d41e777c52fe" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_CANDIDATE_AUTH_GENERATION = 30;

const API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_LIMIT_BYTES = 1_048_576;
const MAX_COMMIT_MESSAGE_CHARS = 8_192;
const NONCE_BYTES = 32;

const STATIC_PLAN = "owner development install plan is invalid";
const STATIC_API = "owner development install GitHub request failed";
const STATIC_WRITE = "owner development install write was not confirmed";

export type OwnerDevelopmentInstallActionV1 = "install" | "rollback";

/** One exact planned pointer movement and the proof that authorizes it. */
export interface OwnerDevelopmentInstallMoveV1 {
  action: OwnerDevelopmentInstallActionV1;
  priorRevision: GitSha;
  priorGeneration: number;
  nextRevision: GitSha;
  nextGeneration: number;
  /**
   * Exact recorded healthy proof authorizing this movement: the current
   * pointer's proof for an install, the recorded previously healthy revision's
   * proof for a rollback.
   */
  priorHealthyProof: HostedRunProofV1;
}

export type OwnerDevelopmentInstallPlanV1 =
  | {
    status: "install";
    move: OwnerDevelopmentInstallMoveV1;
    detail: string;
  }
  | {
    status: "rollback";
    move: OwnerDevelopmentInstallMoveV1;
    detail: string;
  }
  | { status: "waiting"; detail: string }
  | { status: "no_change"; detail: string };

/**
 * Pure planning boundary. The snapshot is re-validated, so an unparsed or
 * tampered record set can never authorize movement. Nothing here performs I/O:
 * the caller supplies the exact read snapshot and the current clock.
 */
export function planOwnerDevelopmentInstall(
  snapshot: ReleaseStateSnapshotV1,
  now: number,
): OwnerDevelopmentInstallPlanV1 {
  const parsed = tryParse(parseReleaseStateSnapshotV1, snapshot);
  if (!parsed.ok) {
    return waiting("release state is not the exact parsed snapshot");
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    return waiting("the supplied clock is invalid");
  }
  const state = parsed.value;
  if (state.hostedRuntimes.length !== 1) {
    return waiting("the single hosted runtime pointer is not installed");
  }
  const runtime = state.hostedRuntimes[0];
  if (runtime.execution !== null) {
    return waiting("a hosted runtime execution is in flight");
  }
  if (
    state.hostedReleases.some((release) =>
      release.pointerIntent !== null ||
      (release.phase !== "accepted" && release.phase !== "rolled_back")
    )
  ) {
    return waiting("a hosted release is not terminal");
  }
  if (
    state.githubCooldowns.some((cooldown) =>
      cooldown.retryNotBefore === null || now < cooldown.retryNotBefore
    )
  ) {
    return waiting("a github cooldown is active");
  }

  const revision = runtime.activeRevision;
  const generation = runtime.generation;
  const healthy = healthyProofFor(runtime, revision, generation);
  const failed = failedSettlementFor(runtime, revision, generation);

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_ORIGINAL_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_ORIGINAL_GENERATION
  ) {
    if (healthy === null) {
      return waiting("the original generation 5 healthy proof is not recorded");
    }
    return movePlan(
      "install",
      runtime,
      OWNER_DEVELOPMENT_INSTALL_READER_REVISION,
      OWNER_DEVELOPMENT_INSTALL_READER_GENERATION,
      healthy,
      "install the reader revision after the original healthy proof",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_READER_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_READER_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure
    // evidence even when an older healthy proof exists; the rollback still
    // requires the recorded healthy proof of the exact prior revision, so a
    // missing or unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ORIGINAL_REVISION,
        OWNER_DEVELOPMENT_INSTALL_ORIGINAL_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded original healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ORIGINAL_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed reader candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_AGGREGATE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_AGGREGATE_GENERATION,
        healthy,
        "install the aggregate revision after the reader healthy proof",
      );
    }
    return waiting("the reader generation 6 healthy proof is not recorded");
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_AGGREGATE_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_AGGREGATE_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_READER_REVISION,
        OWNER_DEVELOPMENT_INSTALL_READER_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded reader healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_READER_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed aggregate candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RECOVERY_REVISION,
        OWNER_DEVELOPMENT_INSTALL_RECOVERY_GENERATION,
        healthy,
        "install the review recovery revision after the aggregate healthy proof",
      );
    }
    return waiting("the aggregate generation 7 healthy proof is not recorded");
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_RECOVERY_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_RECOVERY_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_AGGREGATE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_AGGREGATE_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded aggregate healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_AGGREGATE_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed review recovery candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_REVISION,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_GENERATION,
        healthy,
        "install the review-step reconciliation after the review recovery healthy proof",
      );
    }
    return waiting(
      "the review recovery generation 8 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RECOVERY_REVISION,
        OWNER_DEVELOPMENT_INSTALL_RECOVERY_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded review recovery healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RECOVERY_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed review-step candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEWER_REVISION,
        OWNER_DEVELOPMENT_INSTALL_REVIEWER_GENERATION,
        healthy,
        "install the reviewer provenance revision after the review-step healthy proof",
      );
    }
    return waiting(
      "the review-step generation 9 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_REVIEWER_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_REVIEWER_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_REVISION,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded review-step healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed reviewer provenance candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_REVISION,
        OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_GENERATION,
        healthy,
        "install the one-shot exit contract after the reviewer provenance healthy proof",
      );
    }
    return waiting(
      "the reviewer provenance generation 10 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEWER_REVISION,
        OWNER_DEVELOPMENT_INSTALL_REVIEWER_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded reviewer provenance healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEWER_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed exit contract candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ROUND8_REVISION,
        OWNER_DEVELOPMENT_INSTALL_ROUND8_GENERATION,
        healthy,
        "install the corrected grant revision after the exit-contract healthy proof",
      );
    }
    return waiting(
      "the exit contract generation 11 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_ROUND8_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_ROUND8_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_REVISION,
        OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded exit-contract healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed corrected grant candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_FINDINGS_REVISION,
        OWNER_DEVELOPMENT_INSTALL_FINDINGS_GENERATION,
        healthy,
        "install the findings-feedback revision after the round-8 grant healthy proof",
      );
    }
    return waiting(
      "the corrected grant generation 12 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_FINDINGS_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_FINDINGS_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ROUND8_REVISION,
        OWNER_DEVELOPMENT_INSTALL_ROUND8_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded round-8 grant healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ROUND8_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed findings-feedback candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_HISTORY_REVISION,
        OWNER_DEVELOPMENT_INSTALL_HISTORY_GENERATION,
        healthy,
        "install the rejection-history revision after the findings-feedback healthy proof",
      );
    }
    return waiting(
      "the findings-feedback generation 13 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_HISTORY_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_HISTORY_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_FINDINGS_REVISION,
        OWNER_DEVELOPMENT_INSTALL_FINDINGS_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded findings-feedback healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_FINDINGS_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed rejection-history candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RECEIPT_REVISION,
        OWNER_DEVELOPMENT_INSTALL_RECEIPT_GENERATION,
        healthy,
        "install the receipt-submission revision after the rejection-history healthy proof",
      );
    }
    return waiting(
      "the rejection-history generation 14 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_RECEIPT_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_RECEIPT_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_HISTORY_REVISION,
        OWNER_DEVELOPMENT_INSTALL_HISTORY_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded rejection-history healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_HISTORY_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed receipt-submission candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_LEDGER_REVISION,
        OWNER_DEVELOPMENT_INSTALL_LEDGER_GENERATION,
        healthy,
        "install the ledger revision after the receipt-submission healthy proof",
      );
    }
    return waiting(
      "the receipt-submission generation 15 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_LEDGER_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_LEDGER_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RECEIPT_REVISION,
        OWNER_DEVELOPMENT_INSTALL_RECEIPT_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded receipt-submission healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RECEIPT_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed ledger candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_REVISION,
        OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_GENERATION,
        healthy,
        "install the settlement revision after the ledger healthy proof",
      );
    }
    return waiting("the ledger generation 16 healthy proof is not recorded");
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_LEDGER_REVISION,
        OWNER_DEVELOPMENT_INSTALL_LEDGER_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded ledger healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_LEDGER_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed settlement candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_TRIGGER_REVISION,
        OWNER_DEVELOPMENT_INSTALL_TRIGGER_GENERATION,
        healthy,
        "install the trigger revision after the settlement healthy proof",
      );
    }
    return waiting(
      "the settlement generation 17 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_RELEASED_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_RELEASED_GENERATION
  ) {
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_TRIGGER_REVISION,
        OWNER_DEVELOPMENT_INSTALL_TRIGGER_GENERATION,
        healthy,
        "install the trigger revision after the released generation healthy proof",
      );
    }
    return waiting(
      "the released generation 18 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_TRIGGER_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_TRIGGER_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RELEASED_REVISION,
        OWNER_DEVELOPMENT_INSTALL_RELEASED_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded released healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RELEASED_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed trigger candidate to the released revision",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ADVANCE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_ADVANCE_GENERATION,
        healthy,
        "install the base-advance revision after the trigger healthy proof",
      );
    }
    return waiting(
      "the trigger generation 19 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_ADVANCE_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_ADVANCE_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_TRIGGER_REVISION,
        OWNER_DEVELOPMENT_INSTALL_TRIGGER_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded trigger healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_TRIGGER_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed base-advance candidate to the trigger revision",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CADENCE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CADENCE_GENERATION,
        healthy,
        "install the cadence revision after the base-advance healthy proof",
      );
    }
    return waiting(
      "the base-advance generation 20 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_CADENCE_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_CADENCE_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ADVANCE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_ADVANCE_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded base-advance healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ADVANCE_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed cadence candidate to the base-advance revision",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_GUARD_REVISION,
        OWNER_DEVELOPMENT_INSTALL_GUARD_GENERATION,
        healthy,
        "install the guard revision after the cadence healthy proof",
      );
    }
    return waiting(
      "the cadence generation 21 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_GUARD_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_GUARD_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CADENCE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CADENCE_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded cadence healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CADENCE_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed guard candidate to the cadence revision",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RETIRE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_RETIRE_GENERATION,
        healthy,
        "install the retirement revision after the guard healthy proof",
      );
    }
    return waiting("the guard generation 22 healthy proof is not recorded");
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_RETIRE_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_RETIRE_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_GUARD_REVISION,
        OWNER_DEVELOPMENT_INSTALL_GUARD_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded guard healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_GUARD_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed retirement candidate to the guard revision",
      );
    }
    if (healthy !== null) {
      return noChange("the owner development installation is complete");
    }
    return waiting(
      "the retirement generation 23 healthy proof is not recorded",
    );
  }

  // The live pointer sits one generation past the retirement link (the
  // delivered self-repair merge advanced it through an ordinary correction
  // round). That exact revision still carries its own healthy proof, which
  // authorizes the App identity install; any other pointer stays a no-op.
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_DELIVERED_ROUND2_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_DELIVERED_ROUND2_GENERATION &&
    failed === null &&
    healthy !== null
  ) {
    return movePlan(
      "install",
      runtime,
      OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_REVISION,
      OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_GENERATION,
      healthy,
      "install the ubiquity-sentinel App identity revision after the delivered round-2 healthy proof",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_GENERATION
  ) {
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_GENERATION,
        healthy,
        "install the DeepSeek fallback model-route revision after the App identity healthy proof",
      );
    }
    return waiting(
      "the App identity generation 25 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_GENERATION
  ) {
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RESERVE_MODEL_REVISION,
        OWNER_DEVELOPMENT_INSTALL_RESERVE_MODEL_GENERATION,
        healthy,
        "install the gpt-reserve model revision after the model-route healthy proof",
      );
    }
    return waiting(
      "the model-route generation 26 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_RESERVE_MODEL_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_RESERVE_MODEL_GENERATION
  ) {
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_MULTI_TARGET_REVISION,
        OWNER_DEVELOPMENT_INSTALL_MULTI_TARGET_GENERATION,
        healthy,
        "install the multi-target revision after the reserve-model healthy proof",
      );
    }
    return waiting(
      "the reserve-model generation 27 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_MULTI_TARGET_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_MULTI_TARGET_GENERATION
  ) {
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_SCOPE_GATE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_SCOPE_GATE_GENERATION,
        healthy,
        "install the scope-admitting revision after the multi-target healthy proof",
      );
    }
    return waiting(
      "the multi-target generation 28 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_SCOPE_GATE_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_SCOPE_GATE_GENERATION
  ) {
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CANDIDATE_AUTH_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CANDIDATE_AUTH_GENERATION,
        healthy,
        "install the target-scoped candidate auth revision after the scope-gate healthy proof",
      );
    }
    return waiting(
      "the scope-gate generation 29 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_CANDIDATE_AUTH_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_CANDIDATE_AUTH_GENERATION
  ) {
    if (healthy !== null) {
      return noChange("the owner development installation is complete");
    }
    return waiting(
      "the candidate-auth generation 30 healthy proof is not recorded",
    );
  }

  // Any other pointer, including a completed rollback target, is deliberately
  // a no-op so this one-shot never becomes a recurring global gate.
  return noChange(
    "the runtime pointer is outside the owner installation chain",
  );
}

/** Exact healthy proof binding one revision and generation, or null. */
function healthyProofFor(
  runtime: HostedRuntimeRecordV1,
  revision: GitSha,
  generation: number,
): HostedRunProofV1 | null {
  const proof = runtime.lastHealthyProof;
  if (proof === null || proof.outcome !== "healthy") return null;
  if (proof.execution.revision !== revision) return null;
  if (proof.execution.generation !== generation) return null;
  return proof;
}

/**
 * Exact settled failed run proof binding one revision and generation. The
 * deterministic execution id and the settlement slot are the identity; a
 * no-execution settlement is never candidate failure evidence.
 */
function failedSettlementFor(
  runtime: HostedRuntimeRecordV1,
  revision: GitSha,
  generation: number,
): HostedRunProofV1 | null {
  const settlement = runtime.lastExecutionProof;
  if (settlement === null || settlement.outcome !== "failed") return null;
  if (settlement.execution.revision !== revision) return null;
  if (settlement.execution.generation !== generation) return null;
  return settlement;
}

function movePlan(
  action: OwnerDevelopmentInstallActionV1,
  runtime: HostedRuntimeRecordV1,
  nextRevision: GitSha,
  nextGeneration: number,
  priorHealthyProof: HostedRunProofV1,
  detail: string,
): OwnerDevelopmentInstallPlanV1 {
  const move: OwnerDevelopmentInstallMoveV1 = {
    action,
    priorRevision: runtime.activeRevision,
    priorGeneration: runtime.generation,
    nextRevision,
    nextGeneration,
    priorHealthyProof,
  };
  return action === "install"
    ? { status: "install", move, detail }
    : { status: "rollback", move, detail };
}

function waiting(detail: string): OwnerDevelopmentInstallPlanV1 {
  return { status: "waiting", detail };
}

function noChange(detail: string): OwnerDevelopmentInstallPlanV1 {
  return { status: "no_change", detail };
}

/**
 * Pure intended-snapshot construction: same collections and records, sequence
 * plus one, stateHead set to the exact read head, and exactly one runtime
 * change (activeRevision, generation+1, updatedAt and nextOrdinaryAt=now).
 * Historical proofs and every other runtime field are preserved verbatim.
 */
export function buildOwnerDevelopmentInstallSnapshot(
  snapshot: ReleaseStateSnapshotV1,
  head: GitSha,
  move: OwnerDevelopmentInstallMoveV1,
  now: number,
): ReleaseStateSnapshotV1 {
  const parsed = tryParse(parseReleaseStateSnapshotV1, snapshot);
  if (!parsed.ok || !isGitSha(head)) throw new Error(STATIC_PLAN);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error(STATIC_PLAN);
  const state = parsed.value;
  const runtime = state.hostedRuntimes.length === 1
    ? state.hostedRuntimes[0]
    : null;
  if (runtime === null) throw new Error(STATIC_PLAN);
  if (
    runtime.activeRevision !== move.priorRevision ||
    runtime.generation !== move.priorGeneration ||
    runtime.generation + 1 !== move.nextGeneration ||
    runtime.activeRevision === move.nextRevision ||
    runtime.lastHealthyProof === null ||
    canonicalStringify(runtime.lastHealthyProof) !==
      canonicalStringify(move.priorHealthyProof)
  ) {
    throw new Error(STATIC_PLAN);
  }
  const nextRuntime = tryParse(parseHostedRuntimeRecordV1, {
    ...runtime,
    activeRevision: move.nextRevision,
    generation: move.nextGeneration,
    updatedAt: now,
    nextOrdinaryAt: now,
  });
  if (!nextRuntime.ok) throw new Error(STATIC_PLAN);
  const next = tryParse(parseReleaseStateSnapshotV1, {
    ...state,
    stateHead: head,
    sequence: state.sequence + 1,
    updatedAt: now,
    hostedRuntimes: [nextRuntime.value],
  });
  if (!next.ok) throw new Error(STATIC_PLAN);
  return next.value;
}

/** Exact canonical state-file set of one planned owner installation. */
export interface OwnerDevelopmentInstallFileV1 {
  path: string;
  text: string;
}

export interface OwnerDevelopmentInstallFilesV1 {
  manifest: OwnerDevelopmentInstallFileV1;
  record: OwnerDevelopmentInstallFileV1;
}

/**
 * Serialization boundary of the two changed blobs. The manifest and the
 * hosted-runtime record use the store's existing layout and canonical bytes
 * (canonicalStringify + LF); the record file name is the SHA-256 of the
 * runtime id exactly as the release store addresses it.
 */
export async function ownerDevelopmentInstallFiles(
  snapshot: ReleaseStateSnapshotV1,
  head: GitSha,
): Promise<OwnerDevelopmentInstallFilesV1> {
  const parsed = tryParse(parseReleaseStateSnapshotV1, snapshot);
  if (!parsed.ok || !isGitSha(head) || parsed.value.stateHead !== head) {
    throw new Error(STATIC_PLAN);
  }
  const runtime = parsed.value.hostedRuntimes.length === 1
    ? parsed.value.hostedRuntimes[0]
    : null;
  if (runtime === null) throw new Error(STATIC_PLAN);
  const manifest = {
    version: "v1",
    kind: "release_state_manifest",
    sequence: parsed.value.sequence,
    updatedAt: parsed.value.updatedAt,
    stateHead: head,
  };
  return {
    manifest: {
      path: "manifest.json",
      text: `${canonicalStringify(manifest)}\n`,
    },
    record: {
      path: `hostedRuntimes/${await sha256HexText(runtime.id)}.json`,
      text: `${canonicalStringify(runtime)}\n`,
    },
  };
}

/**
 * Permanent owner-authorized installation record carried by the state commit.
 * It is deliberately NOT a contract record: it is the explicit external owner
 * migration marker in the commit message, not a review or release receipt.
 */
export interface OwnerDevelopmentInstallRecordV1 {
  version: "v1";
  kind: "owner_development_install";
  authority: "owner";
  action: OwnerDevelopmentInstallActionV1;
  /** Authority timestamp of this exact installation operation. */
  authorizedAt: number;
  priorRevision: GitSha;
  priorGeneration: number;
  nextRevision: GitSha;
  nextGeneration: number;
  /** Exact parent state head the created commit extends. */
  stateHead: GitSha;
  /** Exact recorded healthy proof authorizing the movement. */
  priorHealthyProof: HostedRunProofV1;
  /** Random trusted write nonce; identical writes never collide. */
  nonce: string;
}

/** Bounded commit message carrying the exact installation record. */
export function ownerDevelopmentInstallCommitMessage(
  record: OwnerDevelopmentInstallRecordV1,
): string {
  const proof = tryParse(parseHostedRunProofV1, record.priorHealthyProof);
  if (
    record.version !== "v1" ||
    record.kind !== "owner_development_install" ||
    record.authority !== "owner" ||
    (record.action !== "install" && record.action !== "rollback") ||
    !Number.isSafeInteger(record.authorizedAt) || record.authorizedAt < 0 ||
    !isGitSha(record.priorRevision) ||
    !isGitSha(record.nextRevision) ||
    !isGitSha(record.stateHead) ||
    !Number.isSafeInteger(record.priorGeneration) ||
    record.priorGeneration < 1 ||
    !Number.isSafeInteger(record.nextGeneration) ||
    record.nextGeneration !== record.priorGeneration + 1 ||
    record.priorRevision === record.nextRevision ||
    !/^[0-9a-f]{64}$/.test(record.nonce) ||
    !proof.ok
  ) {
    throw new Error(STATIC_PLAN);
  }
  const message = `owner-development-install\n\n${
    canonicalStringify(record)
  }\n`;
  if (message.length > MAX_COMMIT_MESSAGE_CHARS) throw new Error(STATIC_PLAN);
  return message;
}

/** Sanitized bounded result; identities only, never a payload or credential. */
export interface OwnerDevelopmentInstallResultV1 {
  kind: "owner_development_install";
  status: "installed" | "rolled_back" | "waiting" | "no_change" | "failed";
  action: OwnerDevelopmentInstallActionV1 | null;
  priorRevision: string | null;
  priorGeneration: number | null;
  candidateRevision: string | null;
  candidateGeneration: number | null;
  stateHead: string | null;
  stateCommit: string | null;
  detail: string;
}

type OwnerDevelopmentInstallStateReadV1 =
  | { status: "found"; snapshot: ReleaseStateSnapshotV1; head: GitSha }
  | { status: "absent" }
  | { status: "unavailable" };

type OwnerDevelopmentInstallWriteV1 =
  | { status: "confirmed"; commit: GitSha }
  | { status: "not_confirmed"; commit: GitSha | null; detail: string };

interface OwnerDevelopmentInstallApiResponseV1 {
  status: number;
  value: unknown;
}

/**
 * Fixed production entry point. Reads only the named native identity and
 * credential variables; refuses before touching credentials when the process
 * is not the protected prepare job at the exact dispatched source commit.
 * Operational outcomes (waiting, no change, conflict, unconfirmed write) are
 * reported and exit zero so the unchanged supervisor is never blocked by this
 * one-shot; only invalid identity or credentials exit nonzero.
 */
export async function runOwnerDevelopmentInstallMain(): Promise<number> {
  const repository = Deno.env.get("GITHUB_REPOSITORY");
  const ref = Deno.env.get("GITHUB_REF");
  const job = Deno.env.get("GITHUB_JOB");
  const sha = Deno.env.get("GITHUB_SHA");
  const workflowSha = Deno.env.get("GITHUB_WORKFLOW_SHA");
  if (
    repository !== OWNER_DEVELOPMENT_INSTALL_REPOSITORY ||
    ref !== HOSTED_SUPERVISOR_REF ||
    job !== "prepare" ||
    !isGitSha(sha) ||
    !isGitSha(workflowSha) ||
    sha !== workflowSha
  ) {
    return report(failedResult("identity_rejected"), 1);
  }
  const nativeToken = Deno.env.get("GITHUB_TOKEN");
  const appToken = Deno.env.get("SENTINEL_SUPERVISOR_TOKEN");
  if (!isToken(nativeToken) || !isToken(appToken)) {
    return report(failedResult("credentials_unavailable"), 1);
  }

  let state: StateReadView;
  try {
    state = await createOwnerDevelopmentInstallState(appToken);
  } catch {
    return report(failedResult("state_unavailable"));
  }

  const now = Date.now();
  const current = await readOwnerDevelopmentInstallState(state);
  if (current.status !== "found") {
    return report(
      waitingResult(
        current.status === "absent"
          ? "release state is absent"
          : "release state is unavailable",
        null,
        null,
      ),
    );
  }

  const plan = planOwnerDevelopmentInstall(current.snapshot, now);
  if (plan.status === "waiting" || plan.status === "no_change") {
    return report({
      ...waitingResult(plan.detail, current.snapshot, current.head),
      status: plan.status,
    });
  }

  const move = plan.move;
  if (plan.status === "install") {
    const verified = await verifyOwnerDevelopmentInstallRevision(
      nativeToken,
      move.nextRevision,
    );
    if (!verified.verified) {
      return report(
        waitingResult(verified.detail, current.snapshot, current.head),
      );
    }
  }

  let planned: ReleaseStateSnapshotV1;
  let files: OwnerDevelopmentInstallFilesV1;
  let message: string;
  try {
    planned = buildOwnerDevelopmentInstallSnapshot(
      current.snapshot,
      current.head,
      move,
      now,
    );
    files = await ownerDevelopmentInstallFiles(planned, current.head);
    message = ownerDevelopmentInstallCommitMessage({
      version: "v1",
      kind: "owner_development_install",
      authority: "owner",
      action: move.action,
      authorizedAt: now,
      priorRevision: move.priorRevision,
      priorGeneration: move.priorGeneration,
      nextRevision: move.nextRevision,
      nextGeneration: move.nextGeneration,
      stateHead: current.head,
      priorHealthyProof: move.priorHealthyProof,
      nonce: randomHex(NONCE_BYTES),
    });
  } catch {
    return report(failedResult("plan_invalid"));
  }

  const written = await writeOwnerDevelopmentInstallCommit(
    state,
    appToken,
    current.head,
    planned,
    files,
    message,
  );
  if (written.status !== "confirmed") {
    return report({
      ...waitingResult(written.detail, current.snapshot, current.head),
      status: "failed",
      action: move.action,
      priorRevision: move.priorRevision,
      priorGeneration: move.priorGeneration,
      candidateRevision: move.nextRevision,
      candidateGeneration: move.nextGeneration,
      stateCommit: written.commit,
    });
  }

  return report({
    kind: "owner_development_install",
    status: move.action === "install" ? "installed" : "rolled_back",
    action: move.action,
    priorRevision: move.priorRevision,
    priorGeneration: move.priorGeneration,
    candidateRevision: move.nextRevision,
    candidateGeneration: move.nextGeneration,
    stateHead: current.head,
    stateCommit: written.commit,
    detail: move.action === "install"
      ? "owner development install applied; runtime health is not yet proven"
      : "owner development rollback applied; runtime health is not yet proven",
  });
}

async function createOwnerDevelopmentInstallState(
  appToken: string,
): Promise<StateReadView> {
  const sentinelDir = joinPath(Deno.cwd(), ".sentinel");
  const scratch = joinPath(sentinelDir, "state-scratch");
  const gitHome = joinPath(sentinelDir, "state-git-home");
  await ensurePrivateDir(scratch);
  await ensurePrivateDir(gitHome);
  // Read-only capability only: this operation never calls a store writer and
  // never changes the store's schema or transition policy.
  return createReleaseStateStore({
    scratchDir: scratch,
    remoteUrl: OWNER_DEVELOPMENT_INSTALL_REMOTE_URL,
    runner: new DenoGitRunner(gitHome, githubGitAuthEnv(appToken)),
  });
}

async function readOwnerDevelopmentInstallState(
  state: StateReadView,
): Promise<OwnerDevelopmentInstallStateReadV1> {
  let read: PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>>;
  try {
    read = await state.readRelease();
  } catch {
    return { status: "unavailable" };
  }
  if (!read.ok) return { status: "unavailable" };
  if (read.value.status === "absent") return { status: "absent" };
  const parsed = tryParse(parseReleaseStateSnapshotV1, read.value.snapshot);
  if (!parsed.ok) return { status: "unavailable" };
  return { status: "found", snapshot: parsed.value, head: read.value.head };
}

/**
 * Read-only verification of one installed revision: the exact SHA must be an
 * ancestor of the current development ref (GitHub compare) and must carry a
 * completed successful `test-local` check. Both reads use the repository
 * token only; a negative or unavailable answer is a normal waiting outcome.
 */
async function verifyOwnerDevelopmentInstallRevision(
  token: string,
  revision: GitSha,
): Promise<{ verified: boolean; detail: string }> {
  const compare = await ownerDevelopmentInstallApi(
    token,
    "GET",
    `/repos/${OWNER_DEVELOPMENT_INSTALL_REPOSITORY}/compare/${revision}...${OWNER_DEVELOPMENT_INSTALL_DEVELOPMENT_BRANCH}`,
  );
  if (!compare.ok) {
    return { verified: false, detail: "revision ancestry is unavailable" };
  }
  const compared = requireStatus(compare.value, 200);
  if (!compared.ok) {
    return { verified: false, detail: "revision ancestry is unavailable" };
  }
  if (!compareConfirmsAncestor(compared.value, revision)) {
    return {
      verified: false,
      detail: "revision is not an ancestor of development",
    };
  }
  const checks = await ownerDevelopmentInstallApi(
    token,
    "GET",
    `/repos/${OWNER_DEVELOPMENT_INSTALL_REPOSITORY}/commits/${revision}/check-runs?per_page=100`,
  );
  if (!checks.ok) {
    return { verified: false, detail: "revision checks are unavailable" };
  }
  const listed = requireStatus(checks.value, 200);
  if (!listed.ok) {
    return { verified: false, detail: "revision checks are unavailable" };
  }
  if (!testLocalCheckSucceeded(listed.value, revision)) {
    return {
      verified: false,
      detail: "revision has no successful completed test-local check",
    };
  }
  return { verified: true, detail: "revision verified" };
}

/**
 * Create the explicitly owner-authorized state commit, recheck the release ref
 * against the exact expected head, publish it with force:false, then perform
 * exactly one confirmation read: the ref must equal the created commit and the
 * full read state must canonical-equal the planned snapshot. An ambiguous
 * response is settled by that same single reobservation; a mismatch fails
 * closed and the write is never retried.
 */
async function writeOwnerDevelopmentInstallCommit(
  state: StateReadView,
  appToken: string,
  expectedHead: GitSha,
  planned: ReleaseStateSnapshotV1,
  files: OwnerDevelopmentInstallFilesV1,
  message: string,
): Promise<OwnerDevelopmentInstallWriteV1> {
  const baseTree = await readOwnerDevelopmentInstallCommitTree(
    appToken,
    expectedHead,
  );
  if (!baseTree.ok) {
    return notConfirmed(null, "base state tree is unavailable");
  }
  const manifestBlob = await createOwnerDevelopmentInstallBlob(
    appToken,
    files.manifest.text,
  );
  if (!manifestBlob.ok) {
    return notConfirmed(null, "manifest blob could not be created");
  }
  const recordBlob = await createOwnerDevelopmentInstallBlob(
    appToken,
    files.record.text,
  );
  if (!recordBlob.ok) {
    return notConfirmed(null, "runtime record blob could not be created");
  }
  const tree = await createOwnerDevelopmentInstallTree(
    appToken,
    baseTree.value,
    files,
    manifestBlob.value,
    recordBlob.value,
  );
  if (!tree.ok) return notConfirmed(null, "state tree could not be created");
  const commit = await createOwnerDevelopmentInstallCommit(
    appToken,
    message,
    tree.value,
    expectedHead,
  );
  if (!commit.ok) {
    return notConfirmed(null, "installation commit could not be created");
  }

  const ref = await readOwnerDevelopmentInstallRef(appToken);
  if (!ref.ok) {
    return notConfirmed(commit.value, "release ref could not be rechecked");
  }
  if (ref.value !== expectedHead) {
    return notConfirmed(
      commit.value,
      "release ref moved before the installation commit was published",
    );
  }
  const patch = await patchOwnerDevelopmentInstallRef(appToken, commit.value);
  if (!patch.ok && patch.error.kind === "auth_failed") {
    return notConfirmed(commit.value, "release ref could not be published");
  }

  const confirmed = await confirmOwnerDevelopmentInstall(
    state,
    appToken,
    commit.value,
    planned,
  );
  if (!confirmed) {
    return notConfirmed(
      commit.value,
      "created installation commit and intended snapshot were not confirmed",
    );
  }
  return { status: "confirmed", commit: commit.value };
}

async function confirmOwnerDevelopmentInstall(
  state: StateReadView,
  appToken: string,
  commit: GitSha,
  planned: ReleaseStateSnapshotV1,
): Promise<boolean> {
  const ref = await readOwnerDevelopmentInstallRef(appToken);
  if (!ref.ok || ref.value !== commit) return false;
  const read = await readOwnerDevelopmentInstallState(state);
  if (read.status !== "found" || read.head !== commit) return false;
  return canonicalStringify(read.snapshot) === canonicalStringify(planned);
}

async function readOwnerDevelopmentInstallCommitTree(
  token: string,
  commitSha: GitSha,
): Promise<PortResultV1<GitSha>> {
  const response = await ownerDevelopmentInstallApi(
    token,
    "GET",
    `/repos/${OWNER_DEVELOPMENT_INSTALL_REPOSITORY}/git/commits/${commitSha}`,
  );
  if (!response.ok) return response;
  const value = requireStatus(response.value, 200);
  if (!value.ok) return value;
  const tree = readNestedSha(value.value, "tree");
  if (tree === null) return portError("invalid", STATIC_API);
  return portOk(tree);
}

async function createOwnerDevelopmentInstallBlob(
  token: string,
  text: string,
): Promise<PortResultV1<GitSha>> {
  const response = await ownerDevelopmentInstallApi(
    token,
    "POST",
    `/repos/${OWNER_DEVELOPMENT_INSTALL_REPOSITORY}/git/blobs`,
    { content: base64Text(text), encoding: "base64" },
  );
  if (!response.ok) return response;
  const value = requireStatus(response.value, 201);
  if (!value.ok) return value;
  const sha = readShaField(value.value, "sha");
  if (sha === null) return portError("invalid", STATIC_API);
  return portOk(sha);
}

async function createOwnerDevelopmentInstallTree(
  token: string,
  baseTree: GitSha,
  files: OwnerDevelopmentInstallFilesV1,
  manifestBlob: GitSha,
  recordBlob: GitSha,
): Promise<PortResultV1<GitSha>> {
  const response = await ownerDevelopmentInstallApi(
    token,
    "POST",
    `/repos/${OWNER_DEVELOPMENT_INSTALL_REPOSITORY}/git/trees`,
    {
      base_tree: baseTree,
      tree: [
        {
          path: files.manifest.path,
          mode: "100644",
          type: "blob",
          sha: manifestBlob,
        },
        {
          path: files.record.path,
          mode: "100644",
          type: "blob",
          sha: recordBlob,
        },
      ],
    },
  );
  if (!response.ok) return response;
  const value = requireStatus(response.value, 201);
  if (!value.ok) return value;
  const sha = readShaField(value.value, "sha");
  if (sha === null) return portError("invalid", STATIC_API);
  return portOk(sha);
}

async function createOwnerDevelopmentInstallCommit(
  token: string,
  message: string,
  tree: GitSha,
  parent: GitSha,
): Promise<PortResultV1<GitSha>> {
  const response = await ownerDevelopmentInstallApi(
    token,
    "POST",
    `/repos/${OWNER_DEVELOPMENT_INSTALL_REPOSITORY}/git/commits`,
    { message, tree, parents: [parent] },
  );
  if (!response.ok) return response;
  const value = requireStatus(response.value, 201);
  if (!value.ok) return value;
  const sha = readShaField(value.value, "sha");
  if (sha === null) return portError("invalid", STATIC_API);
  return portOk(sha);
}

async function readOwnerDevelopmentInstallRef(
  token: string,
): Promise<PortResultV1<GitSha>> {
  const response = await ownerDevelopmentInstallApi(
    token,
    "GET",
    `/repos/${OWNER_DEVELOPMENT_INSTALL_REPOSITORY}/git/ref/heads/${OWNER_DEVELOPMENT_INSTALL_RELEASE_BRANCH}`,
  );
  if (!response.ok) return response;
  if (response.value.status === 404) {
    return portError("not_found", STATIC_WRITE);
  }
  const value = requireStatus(response.value, 200);
  if (!value.ok) return value;
  const sha = readNestedSha(value.value, "object");
  if (sha === null) return portError("invalid", STATIC_API);
  return portOk(sha);
}

async function patchOwnerDevelopmentInstallRef(
  token: string,
  commit: GitSha,
): Promise<PortResultV1<GitSha>> {
  const response = await ownerDevelopmentInstallApi(
    token,
    "PATCH",
    `/repos/${OWNER_DEVELOPMENT_INSTALL_REPOSITORY}/git/refs/heads/${OWNER_DEVELOPMENT_INSTALL_RELEASE_BRANCH}`,
    { sha: commit, force: false },
  );
  if (!response.ok) return response;
  const value = requireStatus(response.value, 200);
  if (!value.ok) return value;
  const sha = readNestedSha(value.value, "object");
  if (sha === null) return portError("invalid", STATIC_API);
  return portOk(sha);
}

/**
 * One bounded authenticated GitHub request. The fixed deadline stays armed
 * through the complete body read, the body is limited by BYTE count, and only
 * a fully read in-budget JSON body is parsed. No response text, status detail
 * or exception message ever leaves this function.
 */
async function ownerDevelopmentInstallApi(
  token: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<PortResultV1<OwnerDevelopmentInstallApiResponseV1>> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "sentinel-owner-development-install",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
  } catch {
    return portError("unavailable", STATIC_API);
  }
  const text = await readBoundedResponse(response);
  if (!text.ok) return text;
  let value: unknown = null;
  if (text.value.length > 0) {
    try {
      value = JSON.parse(text.value);
    } catch {
      return portError("invalid", STATIC_API);
    }
  }
  return portOk({ status: response.status, value });
}

async function readBoundedResponse(
  response: Response,
): Promise<PortResultV1<string>> {
  if (response.body === null) return portOk("");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let readBytes = 0;
  let overflowed = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      readBytes += chunk.value.byteLength;
      if (readBytes > RESPONSE_LIMIT_BYTES) {
        overflowed = true;
        break;
      }
      chunks.push(chunk.value);
    }
  } catch {
    return portError("unavailable", STATIC_API);
  } finally {
    if (overflowed) {
      try {
        await reader.cancel();
      } catch {
        // Best-effort stream stop; the static failure below is unaffected.
      }
    }
  }
  if (overflowed) return portError("invalid", STATIC_API);
  const bytes = new Uint8Array(readBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return portOk(new TextDecoder().decode(bytes));
}

function requireStatus(
  response: OwnerDevelopmentInstallApiResponseV1,
  expected: number,
): PortResultV1<unknown> {
  if (response.status === expected) return portOk(response.value);
  if (response.status === 404) return portError("not_found", STATIC_API);
  if (response.status === 401 || response.status === 403) {
    return portError("auth_failed", STATIC_API);
  }
  if (response.status === 409 || response.status === 422) {
    return portError("conflict", STATIC_API);
  }
  return portError("unavailable", STATIC_API);
}

/**
 * Strict positive compare parse mirroring the hosted revision verifier: the
 * requested revision must be the compare base and merge base, and only
 * `ahead`/`identical` counters prove ancestry of the current development ref.
 */
function compareConfirmsAncestor(value: unknown, revision: GitSha): boolean {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  const base = readNestedSha(obj, "base_commit");
  const merge = readNestedSha(obj, "merge_base_commit");
  const ahead = readCountField(obj, "ahead_by");
  const behind = readCountField(obj, "behind_by");
  const total = readCountField(obj, "total_commits");
  if (base !== revision || merge !== revision) return false;
  if (ahead === null || behind === null || total === null) return false;
  if (total !== ahead + behind) return false;
  if (obj.status === "identical") return ahead === 0 && behind === 0;
  if (obj.status === "ahead") return ahead > 0 && behind === 0;
  return false;
}

/**
 * Strict one-page check listing: a truncated listing is never a successful
 * verification, and the check must bind the exact head, be completed and have
 * concluded success.
 */
function testLocalCheckSucceeded(value: unknown, revision: GitSha): boolean {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  const runs = obj.check_runs;
  const total = readCountField(obj, "total_count");
  if (total === null || !Array.isArray(runs) || total !== runs.length) {
    return false;
  }
  return runs.some((run) => {
    if (typeof run !== "object" || run === null) return false;
    const item = run as Record<string, unknown>;
    return item.name === OWNER_DEVELOPMENT_INSTALL_TEST_LOCAL_CHECK &&
      item.head_sha === revision &&
      item.status === "completed" &&
      item.conclusion === "success";
  });
}

function readShaField(value: unknown, key: string): GitSha | null {
  if (typeof value !== "object" || value === null) return null;
  const field = (value as Record<string, unknown>)[key];
  return isGitSha(field) ? field : null;
}

function readNestedSha(value: unknown, key: string): GitSha | null {
  if (typeof value !== "object" || value === null) return null;
  const nested = (value as Record<string, unknown>)[key];
  return readShaField(nested, "sha");
}

function readCountField(value: unknown, key: string): number | null {
  if (typeof value !== "object" || value === null) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isSafeInteger(field) && field >= 0
    ? field
    : null;
}

function base64Text(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Raw UTF-8 SHA-256 hex, exactly how the release store addresses a record. */
async function sha256HexText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomHex(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isToken(value: string | undefined): value is string {
  return typeof value === "string" && value.length >= 20 &&
    !/[\p{Cc}]/u.test(value);
}

function notConfirmed(
  commit: GitSha | null,
  detail: string,
): OwnerDevelopmentInstallWriteV1 {
  return { status: "not_confirmed", commit, detail };
}

function failedResult(detail: string): OwnerDevelopmentInstallResultV1 {
  return {
    kind: "owner_development_install",
    status: "failed",
    action: null,
    priorRevision: null,
    priorGeneration: null,
    candidateRevision: null,
    candidateGeneration: null,
    stateHead: null,
    stateCommit: null,
    detail,
  };
}

function waitingResult(
  detail: string,
  snapshot: ReleaseStateSnapshotV1 | null,
  head: GitSha | null,
): OwnerDevelopmentInstallResultV1 {
  const runtime = snapshot !== null && snapshot.hostedRuntimes.length === 1
    ? snapshot.hostedRuntimes[0]
    : null;
  return {
    kind: "owner_development_install",
    status: "waiting",
    action: null,
    priorRevision: runtime?.activeRevision ?? null,
    priorGeneration: runtime?.generation ?? null,
    candidateRevision: null,
    candidateGeneration: null,
    stateHead: head,
    stateCommit: null,
    detail,
  };
}

/** Sanitized bounded JSON line; never a token, payload or raw error. */
function report(result: OwnerDevelopmentInstallResultV1, exitCode = 0): number {
  console.log(JSON.stringify(result));
  return exitCode;
}

if (import.meta.main) {
  Deno.exitCode = await runOwnerDevelopmentInstallMain();
}
