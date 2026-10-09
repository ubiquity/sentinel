/**
 * MemoryLessonsRecordV1: the bounded, machine-readable lesson digest — the
 * analog of a curated long-term memory file. One record per repository,
 * RECOMPUTED deterministically from authoritative attempt memory by the
 * trusted writers (never written by a model, never hand-edited), so it can
 * never disagree with the records it summarizes: same state, same lessons.
 *
 * It exists so a reader (human or trusted tooling) sees, without scanning the
 * whole collection: which work items carry equivalent recorded failures, how
 * many, and whether the loop breaker currently refuses an unchanged replay.
 */

import { asWorkItemId } from "./brands.ts";
import type { GitSha, WorkItemId } from "./brands.ts";
import { canonicalStringifySha256 } from "./canonical.ts";
import { parseRepositoryIdentity } from "./shared.ts";
import type { RepositoryIdentityV1 } from "./shared.ts";
import type {
  AttemptFailureClassV1,
  AttemptStageV1,
} from "./attempt-memory.ts";
import {
  expectArray,
  expectBoolean,
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

/** Stable builder identity; a change requires a reviewed contract revision. */
export const MEMORY_LESSONS_BUILDER_VERSION = "sentinel.memory.lessons.v1";

/** Closed lesson kinds. V1 covers equivalent recorded failures only. */
export type MemoryLessonKindV1 = "equivalent_failures_recorded";

export interface MemoryLessonV1 {
  taskId: WorkItemId;
  kind: MemoryLessonKindV1;
  /** Bounded generated statement (closed fields only, never model text). */
  detail: string;
  stage: AttemptStageV1;
  failureClass: AttemptFailureClassV1;
  /** Equivalent outcomes recorded for this exact failure detail. */
  count: number;
  base: GitSha;
  lastAtMs: number;
  /**
   * True when the equivalence policy is currently refusing an unchanged
   * replay of this exact failure: changed evidence is required.
   */
  refused: boolean;
  /**
   * True when the work item later produced an accepted candidate at this base
   * (the family's recorded success is at or after this failure): the refusal
   * no longer applies, and the lesson reads as a resolved learning instead of
   * an open blocker.
   */
  resolved: boolean;
  /**
   * True when this failure mode previously succeeded at an OLDER runtime
   * revision and now fails at the current one: a regression signal derived
   * from the versioned success history.
   */
  regression: boolean;
}

export interface MemoryLessonsRecordV1 {
  version: "v1";
  kind: "memory_lessons";
  /** Canonical SHA-256 over `{repository, builderVersion}`. */
  id: string;
  repository: RepositoryIdentityV1;
  builderVersion: string;
  /**
   * Canonical digest of the source attempt-memory records this view was built
   * from; a reader can detect a stale view by recomputing it.
   */
  sourceDigest: string;
  generatedAt: number;
  /** Bounded, deterministic entry list. */
  entries: MemoryLessonV1[];
}

/** Canonical identity of the per-repository lessons record. */
export function memoryLessonsIdV1(
  binding: { repository: RepositoryIdentityV1; builderVersion: string },
): Promise<string> {
  return canonicalStringifySha256({
    domain: "sentinel.memory.lessons-record.v1",
    repository: {
      owner: binding.repository.owner,
      name: binding.repository.name,
      installationId: binding.repository.installationId,
    },
    builderVersion: binding.builderVersion,
  });
}

const RECORD_KEYS = [
  "version",
  "kind",
  "id",
  "repository",
  "builderVersion",
  "sourceDigest",
  "generatedAt",
  "entries",
] as const;

const ENTRY_KEYS = [
  "taskId",
  "kind",
  "detail",
  "stage",
  "failureClass",
  "count",
  "base",
  "lastAtMs",
  "refused",
  "resolved",
  "regression",
] as const;

const LESSON_KINDS: readonly MemoryLessonKindV1[] = [
  "equivalent_failures_recorded",
];

const STAGES: readonly AttemptStageV1[] = [
  "reservation",
  "startup",
  "session",
  "model",
  "candidate",
];

const FAILURE_CLASSES: readonly AttemptFailureClassV1[] = [
  "transient_infrastructure",
  "semantic_no_progress",
  "unknown",
];

export function parseMemoryLessonsRecordV1(
  input: unknown,
): MemoryLessonsRecordV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, RECORD_KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, ["memory_lessons"], "$.kind");
  const id = expectSha256Hex(obj.id, "$.id");
  const repository = parseRepositoryIdentity(obj.repository, "$.repository");
  const builderVersion = expectNonEmptyString(
    obj.builderVersion,
    "$.builderVersion",
    MaxText.recordId,
  );
  if (builderVersion !== MEMORY_LESSONS_BUILDER_VERSION) {
    fail(
      "$.builderVersion",
      "invalid_value",
      "unsupported memory lessons builder version",
    );
  }
  const sourceDigest = expectSha256Hex(obj.sourceDigest, "$.sourceDigest");
  const generatedAt = expectTimestamp(obj.generatedAt, "$.generatedAt");
  const entries = expectArray(
    obj.entries,
    "$.entries",
    MaxItems.lessonEntries,
    (value, path) => parseMemoryLessonV1(value, path),
  );
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${String(entry.taskId)}:${entry.base}:${entry.detail}`;
    if (seen.has(key)) {
      fail("$.entries", "invalid_value", "duplicate lesson entry");
    }
    seen.add(key);
  }
  return {
    version: "v1",
    kind: "memory_lessons",
    id,
    repository,
    builderVersion,
    sourceDigest,
    generatedAt,
    entries,
  };
}

function parseMemoryLessonV1(input: unknown, path: string): MemoryLessonV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, ENTRY_KEYS, path);
  const taskId = asWorkItemId(
    expectPattern(
      obj.taskId,
      `${path}.taskId`,
      /^[A-Za-z0-9._:-]{1,256}$/,
      "invalid_pattern",
      "expected deterministic work item id",
      MaxText.recordId,
    ),
  );
  const kind = expectEnum(obj.kind, LESSON_KINDS, `${path}.kind`);
  const detail = expectNonEmptyString(
    obj.detail,
    `${path}.detail`,
    MaxText.detail,
  );
  const stage = expectEnum(obj.stage, STAGES, `${path}.stage`);
  const failureClass = expectEnum(
    obj.failureClass,
    FAILURE_CLASSES,
    `${path}.failureClass`,
  );
  const count = expectPositiveInt(obj.count, `${path}.count`);
  const base = expectGitSha(obj.base, `${path}.base`);
  const lastAtMs = expectTimestamp(obj.lastAtMs, `${path}.lastAtMs`);
  const refused = expectBoolean(obj.refused, `${path}.refused`);
  const resolved = expectBoolean(obj.resolved, `${path}.resolved`);
  const regression = expectBoolean(obj.regression, `${path}.regression`);
  if (refused && resolved) {
    fail(`${path}.resolved`, "invalid_value", "refused and resolved conflict");
  }
  return {
    taskId,
    kind,
    detail,
    stage,
    failureClass,
    count,
    base,
    lastAtMs,
    refused,
    resolved,
    regression,
  };
}
