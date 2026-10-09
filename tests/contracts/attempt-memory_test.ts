// AttemptMemoryRecordV1 contract suite: canonical identity derivation,
// fingerprint stability, strict parsing and bounded merging. All records are
// built as raw JSON and passed through the frozen parser, so the suite carries
// no duplicated validation logic.
import assert from "node:assert/strict";

import {
  attemptFingerprintV1,
  attemptMemoryIdV1,
  mergeAttemptOutcomeV1,
  parseAttemptMemoryRecordV1,
  recordAttemptSuccessV1,
} from "../../src/contracts/attempt-memory.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { tryParse } from "../../src/contracts/validation.ts";

const REPO = { owner: "ubiquity", name: "sentinel", installationId: 0 };
const BASE = "aafb7ee0598699bb7fb8a72ea133693ed64462da" as GitSha;
const OTHER_BASE = "6dc35d06e757107b91eb58232bd15e5f671d79b4" as GitSha;
const CONTROLLER = "4a21c96d46e6f98c3c04125cafce34e255e710e3" as GitSha;
const TASK = asWorkItemId("issue-ubiquity-sentinel-48");
const FINGERPRINT = "b".repeat(64);
const ID = "c".repeat(64);

function validRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: "v1",
    kind: "attempt_memory",
    id: ID,
    repository: REPO,
    taskId: TASK,
    base: BASE,
    purpose: "implementation",
    entries: [
      {
        fingerprint: FINGERPRINT,
        stage: "model",
        failureClass: "semantic_no_progress",
        detail: "model run did not complete with a trusted candidate",
        controllerSha: CONTROLLER,
        count: 2,
        firstAtMs: 1786000000000,
        lastAtMs: 1786000005000,
      },
    ],
    ...overrides,
  };
}

Deno.test("attempt memory: a valid record round-trips through the parser", () => {
  const record = parseAttemptMemoryRecordV1(validRecord());
  assert.equal(record.kind, "attempt_memory");
  assert.equal(record.base, BASE);
  assert.equal(record.entries.length, 1);
  assert.equal(record.entries[0].count, 2);
});

Deno.test("attempt memory: canonical id binds repository, task, base and purpose", async () => {
  const id = await attemptMemoryIdV1({
    repository: REPO,
    taskId: TASK,
    base: BASE,
    purpose: "implementation",
  });
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(
    id,
    await attemptMemoryIdV1({
      repository: { ...REPO },
      taskId: TASK,
      base: BASE,
      purpose: "implementation",
    }),
  );
  // A different base or task is a different family record.
  assert.notEqual(
    id,
    await attemptMemoryIdV1({
      repository: REPO,
      taskId: TASK,
      base: OTHER_BASE,
      purpose: "implementation",
    }),
  );
  assert.notEqual(
    id,
    await attemptMemoryIdV1({
      repository: REPO,
      taskId: asWorkItemId("issue-ubiquity-sentinel-49"),
      base: BASE,
      purpose: "implementation",
    }),
  );
});

Deno.test("attempt memory: fingerprint changes only with identity-bearing inputs", async () => {
  const base = {
    taskId: TASK,
    base: BASE,
    purpose: "implementation" as const,
    controllerSha: CONTROLLER,
    detail: "model run did not complete with a trusted candidate",
  };
  const fingerprint = await attemptFingerprintV1(base);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fingerprint, await attemptFingerprintV1({ ...base }));
  // A different base, revision or failure detail is different evidence.
  assert.notEqual(
    fingerprint,
    await attemptFingerprintV1({ ...base, base: OTHER_BASE }),
  );
  assert.notEqual(
    fingerprint,
    await attemptFingerprintV1({
      ...base,
      controllerSha: "d".repeat(40) as GitSha,
    }),
  );
  assert.notEqual(
    fingerprint,
    await attemptFingerprintV1({ ...base, detail: "failed_command_loop" }),
  );
});

Deno.test("attempt memory: unknown keys, bad enums and unordered entries fail closed", () => {
  const unknown = tryParse(parseAttemptMemoryRecordV1, {
    ...validRecord(),
    extra: true,
  });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.issues[0].code, "unknown_key");

  const badClass = tryParse(
    parseAttemptMemoryRecordV1,
    validRecord({
      entries: [{
        ...(validRecord().entries as Record<string, unknown>[])[0],
        failureClass: "whatever",
      }],
    }),
  );
  assert.equal(badClass.ok, false);
  if (!badClass.ok) {
    assert.equal(badClass.issues[0].code, "invalid_enum");
  }

  const unordered = tryParse(
    parseAttemptMemoryRecordV1,
    validRecord({
      entries: [
        {
          ...(validRecord().entries as Record<string, unknown>[])[0],
          lastAtMs: 1786000009000,
        },
        {
          ...(validRecord().entries as Record<string, unknown>[])[0],
          fingerprint: "e".repeat(64),
          count: 1,
          firstAtMs: 1786000001000,
          lastAtMs: 1786000002000,
        },
      ],
    }),
  );
  assert.equal(unordered.ok, false);
  if (!unordered.ok) {
    assert.equal(unordered.issues[0].code, "invalid_value");
  }

  const duplicate = tryParse(
    parseAttemptMemoryRecordV1,
    validRecord({
      entries: [
        (validRecord().entries as Record<string, unknown>[])[0],
        {
          ...(validRecord().entries as Record<string, unknown>[])[0],
          count: 1,
          firstAtMs: 1786000001000,
          lastAtMs: 1786000002000,
        },
      ],
    }),
  );
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) {
    assert.equal(duplicate.issues[0].code, "invalid_value");
  }
});

Deno.test("attempt memory: optional success awareness round-trips and stays paired", () => {
  const withSuccess = parseAttemptMemoryRecordV1(
    validRecord({ successes: 2, lastSuccessAtMs: 1786000030000 }),
  );
  assert.equal(withSuccess.successes, 2);
  assert.equal(withSuccess.lastSuccessAtMs, 1786000030000);
  // Legacy shape (absent) still parses byte-for-byte.
  const legacy = parseAttemptMemoryRecordV1(validRecord());
  assert.equal(legacy.successes, undefined);
  assert.equal(legacy.lastSuccessAtMs, undefined);
  // A half-present pair fails closed.
  const half = tryParse(
    parseAttemptMemoryRecordV1,
    validRecord({ successes: 1 }),
  );
  assert.equal(half.ok, false);
  if (!half.ok) assert.equal(half.issues[0].code, "invalid_value");

  const bumped = recordAttemptSuccessV1(legacy, 1786000040000);
  assert.equal(bumped.successes, 1);
  assert.equal(bumped.lastSuccessAtMs, 1786000040000);
  const twice = recordAttemptSuccessV1(bumped, 1786000050000);
  assert.equal(twice.successes, 2);
  assert.equal(twice.lastSuccessAtMs, 1786000050000);
});

Deno.test("attempt memory: merge increments the matching entry and appends new evidence", () => {
  const record = parseAttemptMemoryRecordV1(validRecord());
  const same = mergeAttemptOutcomeV1(record, {
    fingerprint: FINGERPRINT,
    stage: "model",
    failureClass: "semantic_no_progress",
    detail: "model run did not complete with a trusted candidate",
    controllerSha: CONTROLLER,
    atMs: 1786000010000,
  });
  assert.equal(same.entries.length, 1);
  assert.equal(same.entries[0].count, 3);
  assert.equal(same.entries[0].lastAtMs, 1786000010000);
  assert.equal(same.entries[0].firstAtMs, 1786000000000);

  const changed = mergeAttemptOutcomeV1(same, {
    fingerprint: "f".repeat(64),
    stage: "candidate",
    failureClass: "semantic_no_progress",
    detail: "model candidate changed only generated/cache artifacts",
    controllerSha: CONTROLLER,
    atMs: 1786000020000,
  });
  assert.equal(changed.entries.length, 2);
  assert.equal(changed.entries[1].count, 1);
  // The parser accepts the merged shape (ordering and bounds hold).
  assert.deepEqual(
    parseAttemptMemoryRecordV1(changed),
    changed,
  );
});

Deno.test("attempt memory: hitting the entry cap folds counts, never silently dropping them", () => {
  let record = parseAttemptMemoryRecordV1(validRecord({ entries: [] }));
  const atMs = 1786000000000;
  for (let index = 0; index < 20; index++) {
    record = mergeAttemptOutcomeV1(record, {
      fingerprint: index.toString(16).padStart(64, "0"),
      stage: "model",
      failureClass: "semantic_no_progress",
      detail: `detail-${index}`,
      controllerSha: CONTROLLER,
      atMs: atMs + index,
    });
  }
  assert.equal(record.entries.length, 16);
  const total = record.entries.reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(total, 20);
  assert.deepEqual(parseAttemptMemoryRecordV1(record), record);
});
