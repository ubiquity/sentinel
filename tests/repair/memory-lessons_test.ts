// Deterministic lessons-view suite: the per-repository digest must be a pure,
// reproducible function of authoritative attempt memory, must flag currently
// refused work, must stay bounded, and must change its source digest exactly
// when the source records change.
import assert from "node:assert/strict";

import {
  attemptFingerprintV1,
  attemptMemoryIdV1,
} from "../../src/contracts/attempt-memory.ts";
import type { AttemptMemoryRecordV1 } from "../../src/contracts/attempt-memory.ts";
import { parseMemoryLessonsRecordV1 } from "../../src/contracts/memory-lessons.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { ATTEMPT_DETAIL_INCOMPLETE } from "../../src/repair/attempt-policy.ts";
import {
  buildMemoryLessonsV1,
  memoryLessonsSourceDigestV1,
} from "../../src/repair/memory-lessons.ts";
import { REPO, SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";

const TASK = asWorkItemId("issue-ubiquity-sentinel-48");

async function memoryRecord(
  overrides: {
    taskId?: string;
    base?: GitSha;
    count?: number;
    controllerSha?: GitSha;
    lastAtMs?: number;
  } = {},
): Promise<AttemptMemoryRecordV1> {
  const taskId = asWorkItemId(overrides.taskId ?? TASK);
  const base = overrides.base ?? SHA1;
  const controllerSha = overrides.controllerSha ?? SHA1;
  const id = await attemptMemoryIdV1({
    repository: REPO,
    taskId,
    base,
    purpose: "implementation",
  });
  const fingerprint = await attemptFingerprintV1({
    taskId,
    base,
    purpose: "implementation",
    controllerSha,
    detail: ATTEMPT_DETAIL_INCOMPLETE,
  });
  return {
    version: "v1",
    kind: "attempt_memory",
    id,
    repository: REPO,
    taskId,
    base,
    purpose: "implementation",
    entries: [
      {
        fingerprint,
        stage: "model",
        failureClass: "semantic_no_progress",
        detail: ATTEMPT_DETAIL_INCOMPLETE,
        controllerSha,
        count: overrides.count ?? 1,
        firstAtMs: T0,
        lastAtMs: overrides.lastAtMs ?? T0 + 1000,
      },
    ],
  };
}

function snapshotWith(
  memory: AttemptMemoryRecordV1[],
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0 + 2000,
    incidents: [],
    evidence: [],
    work: [workRecord(TASK)],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: memory,
    lessons: [],
  });
}

Deno.test("memory lessons: the digest is deterministic and reproducible", async () => {
  const snapshot = snapshotWith([await memoryRecord({ count: 2 })]);
  const first = await buildMemoryLessonsV1(snapshot, T0 + 3000);
  const second = await buildMemoryLessonsV1(snapshot, T0 + 3000);
  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  const record = parseMemoryLessonsRecordV1(first[0]);
  assert.equal(record.entries.length, 1);
  assert.equal(record.entries[0].count, 2);
  // Two recorded no-progress outcomes at this base and revision are exactly
  // the refused condition for the semantic class.
  assert.equal(record.entries[0].refused, true);
  assert.equal(record.entries[0].detail, ATTEMPT_DETAIL_INCOMPLETE);
  assert.equal(record.entries[0].base, SHA1);
});

Deno.test("memory lessons: a recorded success resolves the lesson and clears the refusal", async () => {
  const memory = await memoryRecord({ count: 2 });
  const resolvedMemory = {
    ...memory,
    successes: 1,
    lastSuccessAtMs: T0 + 8000,
  };
  const snapshot = snapshotWith([resolvedMemory]);
  const built = await buildMemoryLessonsV1(snapshot, T0 + 9000);
  const parsed = parseMemoryLessonsRecordV1(built[0]);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].resolved, true);
  assert.equal(parsed.entries[0].refused, false);

  // A success BEFORE the last failure does not resolve it.
  const staleSuccess = {
    ...memory,
    successes: 1,
    lastSuccessAtMs: T0 - 5000,
  };
  const stale = await buildMemoryLessonsV1(
    snapshotWith([staleSuccess]),
    T0 + 9000,
  );
  assert.equal(stale[0].entries[0].resolved, false);
  assert.equal(stale[0].entries[0].refused, true);
});

Deno.test("memory lessons: the source digest follows the source records", async () => {
  const one = snapshotWith([await memoryRecord({ count: 1 })]);
  const two = snapshotWith([await memoryRecord({ count: 2 })]);
  const digestOne = await memoryLessonsSourceDigestV1(one);
  const digestOneRepeat = await memoryLessonsSourceDigestV1(one);
  const digestTwo = await memoryLessonsSourceDigestV1(two);
  assert.equal(digestOne, digestOneRepeat);
  assert.notEqual(digestOne, digestTwo);

  const built = await buildMemoryLessonsV1(two, T0 + 3000);
  assert.equal(built[0].sourceDigest, digestTwo);
});

Deno.test("memory lessons: an allowed count is not flagged; bounded and complete", async () => {
  const allowed = snapshotWith([await memoryRecord({ count: 1 })]);
  const built = await buildMemoryLessonsV1(allowed, T0 + 3000);
  assert.equal(built[0].entries[0].refused, false);

  // Many families: one lesson per family record, refused entries first and
  // deterministic tiebreaks, all within the contract bound.
  const many: AttemptMemoryRecordV1[] = [];
  for (let index = 0; index < 20; index++) {
    many.push(
      await memoryRecord({
        taskId: `issue-ubiquity-sentinel-${100 + index}`,
        base: index % 2 === 0 ? SHA1 : SHA2,
        count: index % 3 === 0 ? 2 : 1,
        lastAtMs: T0 + 1000 + index,
      }),
    );
  }
  const bounded = await buildMemoryLessonsV1(snapshotWith(many), T0 + 4000);
  assert.equal(bounded.length, 1);
  const parsed = parseMemoryLessonsRecordV1(bounded[0]);
  assert.ok(parsed.entries.length <= 16);
  assert.equal(parsed.entries[0].refused, true);
  assert.equal(bounded[0].generatedAt, T0 + 4000);
});
