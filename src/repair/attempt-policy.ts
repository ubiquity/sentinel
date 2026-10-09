/**
 * Attempt-equivalence policy: the durable loop breaker.
 *
 * Sentinel's own history shows the failure mode this module exists to stop:
 * a task fails, the hosted retry pass manufactures a fresh attempt identity at
 * the same base and runtime revision, the same failure repeats, and the loop
 * continues for many cycles without learning anything. This module turns the
 * trusted settlement details into durable attempt-memory entries and answers
 * one question for the retry pass and the planner: "is the next attempt
 * equivalent to one that already failed, and if so, must it be refused?"
 *
 * Rules:
 * - An attempt is equivalent when its identity-bearing inputs match a prior
 *   entry: same task, same target base, same purpose, same runtime revision
 *   (the approach generation) and the same closed failure detail. A new base
 *   or a new runtime revision is changed evidence and is always allowed.
 * - Each failure class has its own tolerated count. Semantic failures (the
 *   model ran and produced nothing usable) tolerate fewer repeats than
 *   transient infrastructure failures (a provider/run fault that a later
 *   attempt may genuinely resolve). `unknown` is conservative.
 * - Transient entries additionally decay: once the recorded window is older
 *   than the transient decay window, one more attempt is allowed, so a long
 *   provider outage can never permanently wedge a task.
 *
 * The policy is consulted by the hosted retry pass (`planHostedRetries`); the
 * memory records it reads are written only by trusted settlement paths in the
 * same state commit as the blocker they describe.
 */

import type {
  AttemptFailureClassV1,
  AttemptMemoryRecordV1,
  AttemptPurposeV1,
  AttemptStageV1,
} from "../contracts/attempt-memory.ts";
import {
  attemptFingerprintV1,
  attemptMemoryIdV1,
  mergeAttemptOutcomeV1,
} from "../contracts/attempt-memory.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";

/**
 * Closed settlement details the implementation path already produces. These
 * constants are the single source for both the blocker text and the memory
 * classification, so the two can never drift.
 */
export const ATTEMPT_DETAIL_NO_TRUSTED_RECEIPT =
  "model run ended without a trusted receipt" as const;
export const ATTEMPT_DETAIL_INCOMPLETE =
  "model run did not complete with a trusted candidate" as const;
export const ATTEMPT_DETAIL_INTERRUPTED_BOUND =
  "model run did not complete with a trusted candidate: interrupted output bound exceeded" as const;
export const ATTEMPT_DETAIL_LOOP_STOP = "failed_command_loop" as const;
export const ATTEMPT_DETAIL_ARTIFACT_ONLY =
  "model candidate changed only generated/cache artifacts" as const;
export const ATTEMPT_DETAIL_UNCERTAIN =
  "implementation outcome uncertain; awaiting authoritative disposition" as const;

interface AttemptDetailClassification {
  stage: AttemptStageV1;
  failureClass: AttemptFailureClassV1;
}

/**
 * Closed detail → (stage, class) table. Exact matches only: an unknown detail
 * never inherits a classification it was not explicitly given.
 */
const DETAIL_CLASSIFICATION: readonly (readonly [
  string,
  AttemptDetailClassification,
])[] = [
  [
    ATTEMPT_DETAIL_NO_TRUSTED_RECEIPT,
    { stage: "model", failureClass: "transient_infrastructure" },
  ],
  [
    ATTEMPT_DETAIL_INCOMPLETE,
    { stage: "model", failureClass: "semantic_no_progress" },
  ],
  [
    ATTEMPT_DETAIL_INTERRUPTED_BOUND,
    { stage: "model", failureClass: "transient_infrastructure" },
  ],
  [
    ATTEMPT_DETAIL_LOOP_STOP,
    { stage: "model", failureClass: "semantic_no_progress" },
  ],
  [
    ATTEMPT_DETAIL_ARTIFACT_ONLY,
    { stage: "candidate", failureClass: "semantic_no_progress" },
  ],
  [
    ATTEMPT_DETAIL_UNCERTAIN,
    { stage: "reservation", failureClass: "unknown" },
  ],
];

export function classifyAttemptDetailV1(detail: string): {
  stage: AttemptStageV1;
  failureClass: AttemptFailureClassV1;
} {
  for (const [known, classification] of DETAIL_CLASSIFICATION) {
    if (known === detail) return classification;
  }
  return { stage: "reservation", failureClass: "unknown" };
}

export interface AttemptEquivalencePolicyV1 {
  /**
   * Maximum equivalent outcomes observed before an equivalent attempt is
   * refused, per failure class.
   */
  maxEquivalentOutcomes: Readonly<Record<AttemptFailureClassV1, number>>;
  /**
   * Decay window for transient infrastructure failures: an entry whose
   * window is older than this allows one more attempt even at the cap.
   * `null` disables decay for that class.
   */
  transientDecayMs: number;
}

export const ATTEMPT_TRANSIENT_DECAY_MS = 6 * 60 * 60 * 1000;

export const DEFAULT_ATTEMPT_EQUIVALENCE_POLICY_V1: AttemptEquivalencePolicyV1 =
  {
    maxEquivalentOutcomes: {
      transient_infrastructure: 4,
      semantic_no_progress: 2,
      unknown: 1,
    },
    transientDecayMs: ATTEMPT_TRANSIENT_DECAY_MS,
  };

export interface AttemptEquivalenceDecisionV1 {
  decision: "allow" | "refuse";
  /** Equivalent outcomes already observed for this fingerprint. */
  priorCount: number;
  fingerprint: string;
  failureClass: AttemptFailureClassV1;
  /** Bounded static reason; safe to persist or log. */
  reason: string;
}

/**
 * Decide whether one more attempt with `fingerprint` may start. Pure and
 * synchronous so the retry pass can consult it while planning.
 */
export function decideEquivalentAttemptV1(input: {
  record: AttemptMemoryRecordV1 | null;
  fingerprint: string;
  failureClass: AttemptFailureClassV1;
  now: number;
  policy?: AttemptEquivalencePolicyV1;
}): AttemptEquivalenceDecisionV1 {
  const policy = input.policy ?? DEFAULT_ATTEMPT_EQUIVALENCE_POLICY_V1;
  const entry =
    input.record?.entries.find((candidate) =>
      candidate.fingerprint === input.fingerprint
    ) ?? null;
  const priorCount = entry?.count ?? 0;
  const max = policy.maxEquivalentOutcomes[input.failureClass];
  if (priorCount < max) {
    return {
      decision: "allow",
      priorCount,
      fingerprint: input.fingerprint,
      failureClass: input.failureClass,
      reason: "equivalent outcomes below the tolerated count",
    };
  }
  if (
    input.failureClass === "transient_infrastructure" &&
    entry !== null &&
    input.now - entry.lastAtMs >= policy.transientDecayMs
  ) {
    return {
      decision: "allow",
      priorCount,
      fingerprint: input.fingerprint,
      failureClass: input.failureClass,
      reason:
        "transient decay window elapsed since the last equivalent outcome",
    };
  }
  return {
    decision: "refuse",
    priorCount,
    fingerprint: input.fingerprint,
    failureClass: input.failureClass,
    reason: `${priorCount} equivalent ${
      input.failureClass === "transient_infrastructure"
        ? "transient failures"
        : input.failureClass === "semantic_no_progress"
        ? "no-progress outcomes"
        : "outcomes"
    } already recorded at this base and revision; changed evidence is required`,
  };
}

function sameRepository(
  left: RepositoryIdentityV1,
  right: RepositoryIdentityV1,
): boolean {
  return left.owner === right.owner && left.name === right.name &&
    left.installationId === right.installationId;
}

/**
 * The latest-entry refusal check the retry pass uses. Synchronous: it only
 * compares stored fields against the record's current base/revision, so no
 * digest recomputation is needed for the common decision.
 */
export function attemptEquivalenceRefusalForRecordV1(input: {
  record: WorkRecordV1;
  snapshot: RepairStateSnapshotV1;
  now: number;
  purpose?: AttemptPurposeV1;
  policy?: AttemptEquivalencePolicyV1;
}): {
  refuse: boolean;
  entry: AttemptMemoryRecordV1["entries"][number] | null;
} {
  const purpose = input.purpose ?? "implementation";
  const memory = input.snapshot.attemptMemory.find((candidate) =>
    sameRepository(candidate.repository, input.record.repository) &&
    candidate.taskId === input.record.id &&
    candidate.base === input.record.target.base &&
    candidate.purpose === purpose
  );
  if (memory === undefined || memory.entries.length === 0) {
    return { refuse: false, entry: null };
  }
  // Entries are oldest-first; the last entry is the most recent outcome.
  const entry = memory.entries[memory.entries.length - 1];
  if (entry.controllerSha !== input.record.controller.sha) {
    // The runtime revision changed since that outcome: the approach
    // generation is different, so this is changed evidence.
    return { refuse: false, entry };
  }
  const decision = decideEquivalentAttemptV1({
    record: memory,
    fingerprint: entry.fingerprint,
    failureClass: entry.failureClass,
    now: input.now,
    policy: input.policy,
  });
  return { refuse: decision.decision === "refuse", entry };
}

/**
 * Mutation factory for one failed implementation settlement. Callers persist
 * the returned mutation in the SAME state commit as the blocker it describes
 * (via `persistAfterSettlement`/`persistTransition`), so memory and outcome
 * move atomically. The factory resolves the record against the draft it is
 * applied to — never a stale preloaded snapshot.
 */
export async function attemptMemorySettlementMutationV1(input: {
  record: WorkRecordV1;
  detail: string;
  now: number;
}): Promise<(draft: RepairStateSnapshotV1) => void> {
  const purpose: AttemptPurposeV1 = "implementation";
  const base = input.record.target.base;
  const controllerSha = input.record.controller.sha;
  const classification = classifyAttemptDetailV1(input.detail);
  const id = await attemptMemoryIdV1({
    repository: input.record.repository,
    taskId: input.record.id,
    base,
    purpose,
  });
  const fingerprint = await attemptFingerprintV1({
    taskId: input.record.id,
    base,
    purpose,
    controllerSha,
    detail: input.detail,
  });
  return (draft) => {
    const index = draft.attemptMemory.findIndex((record) => record.id === id);
    const existing: AttemptMemoryRecordV1 = index === -1
      ? {
        version: "v1",
        kind: "attempt_memory",
        id,
        repository: input.record.repository,
        taskId: input.record.id,
        base,
        purpose,
        entries: [],
      }
      : draft.attemptMemory[index];
    const merged = mergeAttemptOutcomeV1(existing, {
      fingerprint,
      stage: classification.stage,
      failureClass: classification.failureClass,
      detail: input.detail,
      controllerSha,
      atMs: input.now,
    });
    if (index === -1) {
      draft.attemptMemory.push(merged);
    } else {
      draft.attemptMemory[index] = merged;
    }
  };
}
