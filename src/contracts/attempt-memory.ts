/**
 * AttemptMemoryRecordV1: durable, machine-readable memory of failed
 * implementation attempts on the repair state branch.
 *
 * One record per attempt family — (repository, task, base, purpose). Each
 * record carries bounded entries keyed by the canonical attempt fingerprint:
 * the same task, target base, purpose, runtime revision and closed failure
 * detail produce the same fingerprint, so a trusted reader can tell an
 * UNCHANGED re-attempt from an attempt whose inputs actually changed. The
 * record exists so admission and retry decisions can refuse an equivalent
 * failed attempt instead of repeating it blindly (the "do not bang its head
 * against the wall" guarantee).
 *
 * Trusted writers only: the repair workflow appends an entry in the SAME state
 * commit as the settlement/blocker it describes. Model workers never write
 * this kind, and no field ever carries raw upstream text, request bodies,
 * credentials or customer data — `detail` is a bounded closed settlement
 * constant, and the fingerprints are digests.
 */

import { asWorkItemId } from "./brands.ts";
import type { GitSha, WorkItemId } from "./brands.ts";
import { canonicalStringifySha256 } from "./canonical.ts";
import { parseRepositoryIdentity } from "./shared.ts";
import type { RepositoryIdentityV1 } from "./shared.ts";
import {
  expectArray,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectPattern,
  expectPositiveInt,
  expectRecord,
  expectSha256Hex,
  expectTimestamp,
  expectVersion,
  fail,
  MaxItems,
  MaxText,
} from "./validation.ts";

/**
 * Closed purpose set. V1 covers implementation attempts only; review and
 * delivery attempts keep their own existing durable counters.
 */
export type AttemptPurposeV1 = "implementation";

/**
 * Highest stage one attempt is PROVEN to have reached, derived by the trusted
 * writer from the settlement evidence (never from model-supplied text):
 *
 * - `reservation` — admission/intent persisted; nothing else was observed.
 * - `startup` — the model process was observed to start.
 * - `session` — a model session/thread was established.
 * - `model` — a terminal model outcome was observed (receipt or run stop).
 * - `candidate` — a candidate was captured but rejected downstream.
 */
export type AttemptStageV1 =
  | "reservation"
  | "startup"
  | "session"
  | "model"
  | "candidate";

/** Closed classification of one failed attempt outcome. */
export type AttemptFailureClassV1 =
  | "transient_infrastructure"
  | "semantic_no_progress"
  | "unknown";

export interface AttemptMemoryEntryV1 {
  /**
   * Canonical SHA-256 over the attempt-input tuple
   * `{taskId, base, purpose, controllerSha, detail}`. Attempt numbers, run
   * ids, wall-clock time and other incidental differences never change it.
   */
  fingerprint: string;
  /** Highest proven stage of the attempt. */
  stage: AttemptStageV1;
  /** Closed classification of the failure mode. */
  failureClass: AttemptFailureClassV1;
  /** Bounded closed settlement detail constant (sanitized by construction). */
  detail: string;
  /**
   * Runtime revision the attempt ran under. A later attempt under a different
   * revision is treated as changed evidence by the policy.
   */
  controllerSha: GitSha;
  /** Consecutive equivalent outcomes observed; never decreases. */
  count: number;
  firstAtMs: number;
  lastAtMs: number;
}

export interface AttemptMemoryRecordV1 {
  version: "v1";
  kind: "attempt_memory";
  /** Canonical SHA-256 over `{repository, taskId, base, purpose}`. */
  id: string;
  repository: RepositoryIdentityV1;
  taskId: WorkItemId;
  /** Target base the attempts ran against. */
  base: GitSha;
  purpose: AttemptPurposeV1;
  /** Bounded, append/merge-only entry list (oldest first). */
  entries: AttemptMemoryEntryV1[];
}

/**
 * Canonical identity of the attempt family one record stores. Callers must
 * use this function (never an ad-hoc hash) so ids are reproducible.
 */
export function attemptMemoryIdV1(
  binding: {
    repository: RepositoryIdentityV1;
    taskId: WorkItemId;
    base: GitSha;
    purpose: AttemptPurposeV1;
  },
): Promise<string> {
  // Domain-separated hash input: the family identity can never collide with
  // any other digest in the system, and the full defining tuple stays in the
  // record so a reader can re-derive and verify it.
  return canonicalStringifySha256({
    domain: "sentinel.memory.attempt-family.v1",
    repository: {
      owner: binding.repository.owner,
      name: binding.repository.name,
      installationId: binding.repository.installationId,
    },
    taskId: binding.taskId,
    base: binding.base,
    purpose: binding.purpose,
  });
}

/**
 * Canonical fingerprint of one attempt's identity-bearing inputs. The closed
 * `detail` constant is part of the tuple, so each distinct failure mode keeps
 * its own count inside the family record.
 */
export function attemptFingerprintV1(
  input: {
    taskId: WorkItemId;
    base: GitSha;
    purpose: AttemptPurposeV1;
    controllerSha: GitSha;
    detail: string;
  },
): Promise<string> {
  return canonicalStringifySha256({
    domain: "sentinel.memory.attempt-fingerprint.v1",
    taskId: input.taskId,
    base: input.base,
    purpose: input.purpose,
    controllerSha: input.controllerSha,
    detail: input.detail,
  });
}

/** Closed stage value list (single source for every parser and view). */
export const ATTEMPT_STAGES_V1: readonly AttemptStageV1[] = [
  "reservation",
  "startup",
  "session",
  "model",
  "candidate",
];

/** Closed failure-class value list (single source for every parser/view). */
export const ATTEMPT_FAILURE_CLASSES_V1: readonly AttemptFailureClassV1[] = [
  "transient_infrastructure",
  "semantic_no_progress",
  "unknown",
];

const STAGES = ATTEMPT_STAGES_V1;
const FAILURE_CLASSES = ATTEMPT_FAILURE_CLASSES_V1;

const RECORD_KEYS = [
  "version",
  "kind",
  "id",
  "repository",
  "taskId",
  "base",
  "purpose",
  "entries",
] as const;

const ENTRY_KEYS = [
  "fingerprint",
  "stage",
  "failureClass",
  "detail",
  "controllerSha",
  "count",
  "firstAtMs",
  "lastAtMs",
] as const;

export function parseAttemptMemoryRecordV1(
  input: unknown,
): AttemptMemoryRecordV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, RECORD_KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, ["attempt_memory"], "$.kind");

  const id = expectSha256Hex(obj.id, "$.id");
  const repository = parseRepositoryIdentity(obj.repository, "$.repository");
  const taskId = asWorkItemId(
    expectPattern(
      obj.taskId,
      "$.taskId",
      /^[A-Za-z0-9._:-]{1,256}$/,
      "invalid_pattern",
      "expected deterministic work item id",
      MaxText.recordId,
    ),
  );
  const base = expectGitSha(obj.base, "$.base");
  const purpose = expectEnum(obj.purpose, ["implementation"], "$.purpose");
  const entries = expectArray(
    obj.entries,
    "$.entries",
    MaxItems.attemptEntries,
    (value, path) => parseAttemptMemoryEntryV1(value, path),
  );
  const seen = new Set<string>();
  let previousLastAtMs = -1;
  for (const entry of entries) {
    if (seen.has(entry.fingerprint)) {
      fail("$.entries", "invalid_value", "duplicate attempt fingerprint");
    }
    seen.add(entry.fingerprint);
    if (entry.lastAtMs < previousLastAtMs) {
      fail("$.entries", "invalid_value", "entries must be oldest-first");
    }
    previousLastAtMs = entry.lastAtMs;
  }
  return {
    version: "v1",
    kind: "attempt_memory",
    id,
    repository,
    taskId,
    base,
    purpose,
    entries,
  };
}

function parseAttemptMemoryEntryV1(
  input: unknown,
  path: string,
): AttemptMemoryEntryV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, ENTRY_KEYS, path);
  const fingerprint = expectSha256Hex(obj.fingerprint, `${path}.fingerprint`);
  const stage = expectEnum(obj.stage, STAGES, `${path}.stage`);
  const failureClass = expectEnum(
    obj.failureClass,
    FAILURE_CLASSES,
    `${path}.failureClass`,
  );
  const detail = expectNonEmptyString(
    obj.detail,
    `${path}.detail`,
    MaxText.detail,
  );
  const controllerSha = expectGitSha(
    obj.controllerSha,
    `${path}.controllerSha`,
  );
  const count = expectPositiveInt(obj.count, `${path}.count`);
  const firstAtMs = expectTimestamp(obj.firstAtMs, `${path}.firstAtMs`);
  const lastAtMs = expectTimestamp(obj.lastAtMs, `${path}.lastAtMs`);
  if (lastAtMs < firstAtMs) {
    fail(`${path}.lastAtMs`, "invalid_value", "lastAtMs precedes firstAtMs");
  }
  return {
    fingerprint,
    stage,
    failureClass,
    detail,
    controllerSha,
    count,
    firstAtMs,
    lastAtMs,
  };
}

/**
 * Merge one observed outcome into a record's entries and return the new
 * record. Pure: the caller persists the result in the same state commit as
 * the settlement it describes. The matched entry's count increments and the
 * window extends; the entry list stays bounded, and hitting the cap folds the
 * oldest entry's count into its successor so no count is silently lost.
 */
export function mergeAttemptOutcomeV1(
  record: AttemptMemoryRecordV1,
  outcome: {
    fingerprint: string;
    stage: AttemptStageV1;
    failureClass: AttemptFailureClassV1;
    detail: string;
    controllerSha: GitSha;
    atMs: number;
  },
): AttemptMemoryRecordV1 {
  const entries = [...record.entries];
  const index = entries.findIndex((entry) =>
    entry.fingerprint === outcome.fingerprint
  );
  if (index !== -1) {
    const prior = entries[index];
    entries[index] = {
      ...prior,
      stage: outcome.stage,
      failureClass: outcome.failureClass,
      detail: outcome.detail,
      controllerSha: outcome.controllerSha,
      count: prior.count + 1,
      lastAtMs: outcome.atMs,
    };
    return { ...record, entries };
  }
  entries.push({
    fingerprint: outcome.fingerprint,
    stage: outcome.stage,
    failureClass: outcome.failureClass,
    detail: outcome.detail,
    controllerSha: outcome.controllerSha,
    count: 1,
    firstAtMs: outcome.atMs,
    lastAtMs: outcome.atMs,
  });
  if (entries.length > MaxItems.attemptEntries) {
    const [oldest, ...rest] = entries;
    const target = rest[0];
    if (oldest !== undefined && target !== undefined) {
      rest[0] = {
        ...target,
        count: target.count + oldest.count,
        firstAtMs: Math.min(target.firstAtMs, oldest.firstAtMs),
      };
    }
    return { ...record, entries: rest };
  }
  return { ...record, entries };
}
