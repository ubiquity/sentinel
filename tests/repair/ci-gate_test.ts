/**
 * CI gate decision tests: pure logic for the delivery-phase merge gate.
 * Verifies that pending checks wait, failed checks block, and green/empty
 * checks proceed — without blocking a turn.
 */
import assert from "node:assert/strict";

import { decideCiGate } from "../../src/repair/loop.ts";
import type { GitHubCheckV1 } from "../../src/contracts/ports.ts";

function check(
  name: string,
  status: GitHubCheckV1["status"],
  conclusion: GitHubCheckV1["conclusion"],
): GitHubCheckV1 {
  return {
    name,
    status,
    conclusion,
    head: "abc123" as never,
    startedAt: null,
    completedAt: null,
  };
}

Deno.test("decideCiGate: empty checks proceed (no CI to wait for)", () => {
  assert.equal(decideCiGate([]), "proceed");
});

Deno.test("decideCiGate: all green checks proceed", () => {
  const checks = [
    check("ci", "completed", "success"),
    check("lint", "completed", "success"),
  ];
  assert.equal(decideCiGate(checks), "proceed");
});

Deno.test("decideCiGate: skipped/neutral checks proceed", () => {
  const checks = [
    check("ci", "completed", "success"),
    check("optional", "completed", "skipped"),
    check("advisory", "completed", "neutral"),
  ];
  assert.equal(decideCiGate(checks), "proceed");
});

Deno.test("decideCiGate: in-progress check waits (non-blocking)", () => {
  const checks = [
    check("ci", "completed", "success"),
    check("slow", "in_progress", null),
  ];
  assert.equal(decideCiGate(checks), "wait");
});

Deno.test("decideCiGate: queued check waits", () => {
  const checks = [check("ci", "queued", null)];
  assert.equal(decideCiGate(checks), "wait");
});

Deno.test("decideCiGate: failed check blocks with names", () => {
  const checks = [
    check("ci", "completed", "success"),
    check("broken", "completed", "failure"),
  ];
  const result = decideCiGate(checks);
  assert.ok(typeof result === "object" && "blocked" in result);
  assert.ok(result.blocked.includes("broken"));
});

Deno.test("decideCiGate: timed_out/cancelled/action_required block", () => {
  for (
    const conclusion of ["timed_out", "cancelled", "action_required"] as const
  ) {
    const result = decideCiGate([check("ci", "completed", conclusion)]);
    assert.ok(typeof result === "object" && "blocked" in result);
  }
});
