// Attempt-equivalence policy suite: the loop breaker's classification,
// fingerprint-comparison decisions, and the settlement mutation that the
// trusted writer persists in the same state commit as the blocker.
import assert from "node:assert/strict";

import {
  attemptFingerprintV1,
  attemptMemoryIdV1,
} from "../../src/contracts/attempt-memory.ts";
import type { AttemptMemoryRecordV1 } from "../../src/contracts/attempt-memory.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  ATTEMPT_DETAIL_ARTIFACT_ONLY,
  ATTEMPT_DETAIL_INCOMPLETE,
  ATTEMPT_DETAIL_INTERRUPTED_BOUND,
  ATTEMPT_DETAIL_LOOP_STOP,
  ATTEMPT_DETAIL_NO_TRUSTED_RECEIPT,
  ATTEMPT_DETAIL_UNCERTAIN,
  ATTEMPT_TRANSIENT_DECAY_MS,
  attemptEquivalenceRefusalForRecordV1,
  attemptMemorySettlementMutationV1,
  classifyAttemptDetailV1,
  decideEquivalentAttemptV1,
  priorAttemptFactsForRecordV1,
} from "../../src/repair/attempt-policy.ts";
import { REPO, SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";

const TASK = asWorkItemId("issue-ubiquity-sentinel-48");
const DETAIL = ATTEMPT_DETAIL_INCOMPLETE;

async function memoryRecord(
  overrides: Partial<AttemptMemoryRecordV1> = {},
  entry: {
    count?: number;
    controllerSha?: GitSha;
    detail?: string;
    lastAtMs?: number;
  } = {},
): Promise<AttemptMemoryRecordV1> {
  const base = overrides.base ?? SHA1;
  const id = await attemptMemoryIdV1({
    repository: REPO,
    taskId: TASK,
    base,
    purpose: "implementation",
  });
  const detail = entry.detail ?? DETAIL;
  const fingerprint = await attemptFingerprintV1({
    taskId: TASK,
    base,
    purpose: "implementation",
    controllerSha: entry.controllerSha ?? SHA1,
    detail,
  });
  return {
    version: "v1",
    kind: "attempt_memory",
    id,
    repository: REPO,
    taskId: TASK,
    base,
    purpose: "implementation",
    entries: [
      {
        fingerprint,
        stage: "model",
        failureClass: "semantic_no_progress",
        detail,
        controllerSha: entry.controllerSha ?? SHA1,
        count: entry.count ?? 1,
        firstAtMs: T0,
        lastAtMs: entry.lastAtMs ?? T0 + 1000,
      },
    ],
    ...overrides,
  };
}

function snapshotWith(
  memory: AttemptMemoryRecordV1[],
  record = workRecord(TASK),
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0 + 2000,
    incidents: [],
    evidence: [],
    work: [record],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: memory,
  });
}

Deno.test("attempt policy: closed details classify exactly, unknown fails closed", () => {
  assert.deepEqual(classifyAttemptDetailV1(ATTEMPT_DETAIL_NO_TRUSTED_RECEIPT), {
    stage: "model",
    failureClass: "transient_infrastructure",
  });
  assert.deepEqual(classifyAttemptDetailV1(ATTEMPT_DETAIL_INCOMPLETE), {
    stage: "model",
    failureClass: "semantic_no_progress",
  });
  assert.deepEqual(classifyAttemptDetailV1(ATTEMPT_DETAIL_INTERRUPTED_BOUND), {
    stage: "model",
    failureClass: "transient_infrastructure",
  });
  assert.deepEqual(classifyAttemptDetailV1(ATTEMPT_DETAIL_LOOP_STOP), {
    stage: "model",
    failureClass: "semantic_no_progress",
  });
  assert.deepEqual(classifyAttemptDetailV1(ATTEMPT_DETAIL_ARTIFACT_ONLY), {
    stage: "candidate",
    failureClass: "semantic_no_progress",
  });
  assert.deepEqual(classifyAttemptDetailV1(ATTEMPT_DETAIL_UNCERTAIN), {
    stage: "reservation",
    failureClass: "unknown",
  });
  assert.deepEqual(classifyAttemptDetailV1("something new"), {
    stage: "reservation",
    failureClass: "unknown",
  });
});

Deno.test("attempt policy: equivalent outcomes are tolerated per class, then refused", async () => {
  const memory = await memoryRecord({}, { count: 1 });
  const fingerprint = memory.entries[0].fingerprint;

  // One prior semantic outcome: the next identical attempt is allowed.
  assert.equal(
    decideEquivalentAttemptV1({
      record: memory,
      fingerprint,
      failureClass: "semantic_no_progress",
      now: T0 + 2000,
    }).decision,
    "allow",
  );
  // Two: refused until the evidence changes.
  const capped = await memoryRecord({}, { count: 2 });
  const refused = decideEquivalentAttemptV1({
    record: capped,
    fingerprint,
    failureClass: "semantic_no_progress",
    now: T0 + 2000,
  });
  assert.equal(refused.decision, "refuse");
  assert.match(refused.reason, /changed evidence is required/);

  // Transient infrastructure failures tolerate more repeats...
  assert.equal(
    decideEquivalentAttemptV1({
      record: await memoryRecord({}, { count: 3 }),
      fingerprint,
      failureClass: "transient_infrastructure",
      now: T0 + 2000,
    }).decision,
    "allow",
  );
  assert.equal(
    decideEquivalentAttemptV1({
      record: await memoryRecord({}, { count: 4 }),
      fingerprint,
      failureClass: "transient_infrastructure",
      now: T0 + 2000,
    }).decision,
    "refuse",
  );
  // ...and decay: an old window allows one more attempt so a long provider
  // outage can never permanently wedge a task.
  assert.equal(
    decideEquivalentAttemptV1({
      record: await memoryRecord({}, { count: 4 }),
      fingerprint,
      failureClass: "transient_infrastructure",
      now: T0 + 1000 + ATTEMPT_TRANSIENT_DECAY_MS,
    }).decision,
    "allow",
  );

  // Unknown outcomes are conservative: one is enough to refuse a repeat.
  const unknownMemory = await memoryRecord({}, {
    count: 1,
    detail: ATTEMPT_DETAIL_UNCERTAIN,
  });
  assert.equal(
    decideEquivalentAttemptV1({
      record: unknownMemory,
      fingerprint: unknownMemory.entries[0].fingerprint,
      failureClass: "unknown",
      now: T0 + 2000,
    }).decision,
    "refuse",
  );
});

Deno.test("attempt policy: refusal checks the latest outcome against current base and revision", async () => {
  const record = workRecord(TASK, {
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: DETAIL,
      since: T0 + 1000,
    },
    counters: { attempts: 2, retries: 1, reviewRounds: 0 },
  });
  const memory = await memoryRecord({}, { count: 2 });
  const snapshot = snapshotWith([memory], record);

  const sameEvidence = attemptEquivalenceRefusalForRecordV1({
    record,
    snapshot,
    now: T0 + 2000,
  });
  assert.equal(sameEvidence.refuse, true);

  // A different runtime revision is changed evidence.
  const otherController = workRecord(TASK, {
    controller: { sha: SHA2 },
    nextStep: "blocked",
    blocker: { kind: "other", message: DETAIL, since: T0 + 1000 },
  });
  assert.equal(
    attemptEquivalenceRefusalForRecordV1({
      record: otherController,
      snapshot,
      now: T0 + 2000,
    }).refuse,
    false,
  );

  // A different target base is a different family record entirely.
  const otherBase = workRecord(TASK, {
    target: {
      base: SHA2,
      branch: null,
      checkpoint: null,
      head: null,
      pr: null,
    },
    nextStep: "blocked",
    blocker: { kind: "other", message: DETAIL, since: T0 + 1000 },
  });
  assert.equal(
    attemptEquivalenceRefusalForRecordV1({
      record: otherBase,
      snapshot,
      now: T0 + 2000,
    }).refuse,
    false,
  );

  // Below the tolerated count the retry is allowed.
  const belowCap = snapshotWith([await memoryRecord({}, { count: 1 })], record);
  assert.equal(
    attemptEquivalenceRefusalForRecordV1({
      record,
      snapshot: belowCap,
      now: T0 + 2000,
    }).refuse,
    false,
  );
});

Deno.test("attempt policy: the settlement mutation merges into the draft it is applied to", async () => {
  const record = workRecord(TASK, {
    nextStep: "blocked",
    blocker: { kind: "other", message: DETAIL, since: T0 + 1000 },
    counters: { attempts: 2, retries: 1, reviewRounds: 0 },
  });
  const mutation = await attemptMemorySettlementMutationV1({
    record,
    detail: DETAIL,
    now: T0 + 3000,
  });

  const fresh = snapshotWith([], record);
  const applied = parseRepairStateSnapshotV1((() => {
    const draft: RepairStateSnapshotV1 = {
      ...fresh,
      attemptMemory: [...fresh.attemptMemory],
      work: [...fresh.work],
    };
    mutation(draft);
    return draft;
  })());
  assert.equal(applied.attemptMemory.length, 1);
  const first = applied.attemptMemory[0];
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].count, 1);
  assert.match(first.entries[0].fingerprint, /^[0-9a-f]{64}$/);

  // A second identical settlement increments the same entry.
  const second = parseRepairStateSnapshotV1((() => {
    const draft: RepairStateSnapshotV1 = {
      ...applied,
      attemptMemory: [...applied.attemptMemory],
      work: [...applied.work],
    };
    mutation(draft);
    return draft;
  })());
  assert.equal(second.attemptMemory.length, 1);
  assert.equal(second.attemptMemory[0].entries[0].count, 2);
  assert.equal(second.attemptMemory[0].id, first.id);

  // A different runtime revision records a distinct entry beside the first.
  const otherRevision = workRecord(TASK, {
    controller: { sha: SHA2 },
    nextStep: "blocked",
    blocker: { kind: "other", message: DETAIL, since: T0 + 1000 },
  });
  const revisionMutation = await attemptMemorySettlementMutationV1({
    record: otherRevision,
    detail: DETAIL,
    now: T0 + 4000,
  });
  const third = parseRepairStateSnapshotV1((() => {
    const draft: RepairStateSnapshotV1 = {
      ...second,
      attemptMemory: [...second.attemptMemory],
      work: [...second.work],
    };
    revisionMutation(draft);
    return draft;
  })());
  assert.equal(third.attemptMemory.length, 1);
  assert.equal(third.attemptMemory[0].entries.length, 2);
});

Deno.test("attempt policy: prior-attempt facts are newest-first and exclude older revisions", async () => {
  const record = workRecord(TASK, {
    nextStep: "blocked",
    blocker: { kind: "other", message: DETAIL, since: T0 + 1000 },
    counters: { attempts: 2, retries: 1, reviewRounds: 0 },
  });
  const memory = await memoryRecord({}, { count: 2 });
  // A second entry under an OLDER runtime revision must not be advised.
  memory.entries.unshift({
    fingerprint: "9".repeat(64),
    stage: "model",
    failureClass: "transient_infrastructure",
    detail: ATTEMPT_DETAIL_NO_TRUSTED_RECEIPT,
    controllerSha: SHA2,
    count: 3,
    firstAtMs: T0,
    lastAtMs: T0 + 500,
  });
  const snapshot = snapshotWith([memory], record);

  const facts = priorAttemptFactsForRecordV1(snapshot, record);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].detail, DETAIL);
  assert.equal(facts[0].count, 2);
  assert.equal(facts[0].stage, "model");

  // No memory at this base: no facts, no prompt section.
  assert.equal(
    priorAttemptFactsForRecordV1(snapshotWith([]), record).length,
    0,
  );
  // A different base is a different family: still no facts.
  const movedBase = workRecord(TASK, {
    target: {
      base: SHA2,
      branch: null,
      checkpoint: null,
      head: null,
      pr: null,
    },
    nextStep: "blocked",
    blocker: { kind: "other", message: DETAIL, since: T0 + 1000 },
  });
  assert.equal(priorAttemptFactsForRecordV1(snapshot, movedBase).length, 0);
});
