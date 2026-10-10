/**
 * Stale implementation intent TTL: an implementation intent older than 6h with
 * no result must not block matrix re-admission (its run died without settling).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isStaleImplementationIntent,
  STALE_IMPLEMENTATION_INTENT_TTL_MS,
} from "../../src/repair/loop.ts";
import type { IncompleteOperationV1 } from "../../src/contracts/work-record.ts";

const NOW = 1_790_000_000_000;

function baseIntent(
  overrides: Partial<IncompleteOperationV1> = {},
): IncompleteOperationV1 {
  return {
    kind: "implementation",
    key: "test-key",
    startedAt: NOW - 1000,
    branch: "test-branch",
    expectedHead: null,
    observedBase: null,
    pr: null,
    requestId: "res-123",
    resultId: null,
    ...overrides,
  };
}

describe("isStaleImplementationIntent", () => {
  it("null intent is not stale", () => {
    assert.equal(isStaleImplementationIntent(null, NOW), false);
  });

  it("fresh implementation intent is not stale", () => {
    assert.equal(isStaleImplementationIntent(baseIntent(), NOW), false);
  });

  it("old implementation intent with no result is stale", () => {
    const intent = baseIntent({
      startedAt: NOW - STALE_IMPLEMENTATION_INTENT_TTL_MS - 1000,
    });
    assert.equal(isStaleImplementationIntent(intent, NOW), true);
  });

  it("old implementation intent with result is not stale", () => {
    const intent = baseIntent({
      startedAt: NOW - STALE_IMPLEMENTATION_INTENT_TTL_MS - 1000,
      resultId: "result-123",
    });
    assert.equal(isStaleImplementationIntent(intent, NOW), false);
  });

  it("old non-implementation intent is not stale", () => {
    const intent = baseIntent({
      kind: "merge",
      startedAt: NOW - STALE_IMPLEMENTATION_INTENT_TTL_MS - 1000,
    });
    assert.equal(isStaleImplementationIntent(intent, NOW), false);
  });

  it("intent exactly at TTL boundary is stale", () => {
    const intent = baseIntent({
      startedAt: NOW - STALE_IMPLEMENTATION_INTENT_TTL_MS,
    });
    assert.equal(isStaleImplementationIntent(intent, NOW), true);
  });
});
