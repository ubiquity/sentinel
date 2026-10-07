/**
 * Decomposition regression tests: consecutive matrix-cell host timeouts are
 * counted, the stale intent is cleared so the record stays retry-eligible,
 * and a repeatedly-timed-out issue splits into serial sub-tasks with their
 * own ids, branches and dependencies. Pure functions only; no ports, no Git,
 * no model calls.
 */
import assert from "node:assert/strict";

import { parseMatrixModelRequestV1 } from "../../src/contracts/matrix.ts";
import {
  MATRIX_DECOMPOSE_AFTER_TIMEOUTS,
  MATRIX_DECOMPOSE_MAX_PARTS,
} from "../../src/contracts/matrix.ts";
import type { ModelRunRequestV1 } from "../../src/contracts/ports.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  clearMatrixTimeouts,
  createDecompositionChildren,
  createIssueWork,
  decompositionChildId,
  decompositionPartOf,
  decompositionScopeNote,
  isDecompositionChildId,
  recordMatrixTimeout,
  setIntent,
} from "../../src/repair/transitions.ts";
import { SHA1, SHA2, T0 } from "../state/helpers.ts";

const NOW = T0 + 60_000;

function parentRecord(): WorkRecordV1 {
  return createIssueWork(
    { number: 42, title: "large issue", labels: [], createdAt: T0 },
    {
      controllerSha: SHA1,
      repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
      observedBase: SHA2,
      now: T0,
    },
  );
}

function timedOutParent(timeouts: number): WorkRecordV1 {
  let record = parentRecord();
  for (let i = 0; i < timeouts; i++) {
    record = recordMatrixTimeout(record, NOW + i);
  }
  return record;
}

Deno.test("recordMatrixTimeout counts from absent and clears a stale intent", () => {
  const withIntent = setIntent(
    parentRecord(),
    {
      kind: "implementation",
      key: "impl:deadbeef",
      startedAt: T0,
      branch: "sentinel/repair/x",
      expectedHead: null,
      observedBase: SHA2,
      pr: null,
      requestId: null,
      resultId: null,
    },
    NOW,
  );
  const once = recordMatrixTimeout(withIntent, NOW);
  assert.equal(once.counters.timeouts, 1);
  assert.equal(once.intent, null);
  const twice = recordMatrixTimeout(once, NOW + 1);
  assert.equal(twice.counters.timeouts, 2);
});

Deno.test("clearMatrixTimeouts drops the additive key", () => {
  const timedOut = timedOutParent(2);
  assert.equal(timedOut.counters.timeouts, 2);
  const cleared = clearMatrixTimeouts(timedOut, NOW);
  assert.equal(cleared.counters.timeouts, undefined);
  // Legacy shape round-trips exactly through the frozen parser.
  const reparsed = parseWorkRecordV1(JSON.parse(JSON.stringify(cleared)));
  assert.equal(reparsed.counters.timeouts, undefined);
});

Deno.test("decomposition id helpers round-trip without pattern matching", () => {
  const parentId = "ubiquity:ai.ubq.fi:issue:42";
  const childId = decompositionChildId(parentId, 2, 3);
  assert.ok(isDecompositionChildId(childId));
  assert.ok(!isDecompositionChildId(parentId));
  assert.deepEqual(decompositionPartOf(childId), { index: 2, total: 3 });
  assert.equal(decompositionPartOf(parentId), null);
  assert.equal(decompositionPartOf(parentId + ":part-x"), null);
});

Deno.test("createDecompositionChildren builds serial parts", () => {
  const parent = timedOutParent(MATRIX_DECOMPOSE_AFTER_TIMEOUTS);
  const children = createDecompositionChildren(parent, NOW);
  assert.equal(children.length, MATRIX_DECOMPOSE_AFTER_TIMEOUTS);
  children.forEach((child, i) => {
    const index = i + 1;
    assert.equal(child.id, `${parent.id}:part-${index}-of-${children.length}`);
    assert.ok(isDecompositionChildId(child.id));
    assert.deepEqual(decompositionPartOf(child.id), {
      index,
      total: children.length,
    });
    // Serial chain: each part waits for the previous one.
    assert.deepEqual(
      child.dependencies,
      index === 1
        ? []
        : [`${parent.id}:part-${index - 1}-of-${children.length}`],
    );
    // Same issue, fresh lifecycle, own branch.
    assert.equal(child.source.kind, "issue");
    assert.equal(child.related.issueNumber, 42);
    assert.equal(child.counters.attempts, 0);
    assert.equal(child.counters.timeouts, undefined);
    assert.ok(
      (child.target.branch ?? "").startsWith("sentinel/repair/"),
      "child gets its own candidate branch",
    );
    assert.equal(child.nextStep, "work");
  });
});

Deno.test("decomposition part count grows with timeouts up to the cap", () => {
  const parent = timedOutParent(MATRIX_DECOMPOSE_MAX_PARTS + 5);
  const children = createDecompositionChildren(parent, NOW);
  assert.equal(children.length, MATRIX_DECOMPOSE_MAX_PARTS);
});

Deno.test("decomposition scope note is a fixed template", () => {
  const note = decompositionScopeNote(1, 3);
  assert.ok(note.includes("part 1 of 3"));
  assert.ok(!note.includes("42"), "no issue-specific content");
});

Deno.test("matrix request parser accepts an optional scopeNote", () => {
  const base = {
    taskId: "ubiquity:ai.ubq.fi:issue:42:part-1-of-2",
    repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
    base: SHA2,
    issue: { number: 42, title: "large issue", body: "body" },
    evidence: [],
    model: "gpt-6-luna",
    reasoning: "max",
    maxDurationMs: 1000,
    maxOutputChars: 1000,
  };
  const without = parseMatrixModelRequestV1(base, "$");
  assert.equal(without.scopeNote, undefined);
  const request = { ...base, scopeNote: decompositionScopeNote(1, 2) };
  const parsed: ModelRunRequestV1 = parseMatrixModelRequestV1(request, "$");
  assert.equal(parsed.scopeNote, decompositionScopeNote(1, 2));
});

Deno.test("work record with timeouts round-trips the frozen parser", () => {
  const record = timedOutParent(2);
  const json = JSON.parse(JSON.stringify(record)) as unknown;
  const reparsed = parseWorkRecordV1(json);
  assert.equal(reparsed.counters.timeouts, 2);
  // Canonical digest stability: the counter participates in identity.
  const once = JSON.stringify(timedOutParent(1).counters);
  const twice = JSON.stringify(timedOutParent(2).counters);
  assert.notEqual(once, twice);
});
