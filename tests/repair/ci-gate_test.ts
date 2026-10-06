/**
 * CI gate decision tests: pure logic for the delivery-phase merge gate.
 * Verifies that pending checks wait, failed/skipped/neutral checks block, and
 * only all-success checks proceed — without blocking a turn. Matches
 * requiredChecksState semantics (only completed `success` passes).
 */
import assert from "node:assert/strict";

import { decideCiGate } from "../../src/repair/loop.ts";
import type { GitHubCheckV1 } from "../../src/contracts/ports.ts";

function check(
  name: string,
  status: GitHubCheckV1["status"],
  conclusion: GitHubCheckV1["conclusion"],
  completedAt: number | null = 1,
): GitHubCheckV1 {
  return {
    name,
    status,
    conclusion,
    head: "abc123" as never,
    startedAt: 0,
    completedAt,
  };
}

Deno.test("decideCiGate: empty checks wait (no evidence CI ran)", () => {
  assert.equal(decideCiGate([]), "wait");
});

Deno.test("decideCiGate: all success checks proceed", () => {
  const checks = [
    check("ci", "completed", "success"),
    check("lint", "completed", "success"),
  ];
  assert.equal(decideCiGate(checks), "proceed");
});

Deno.test("decideCiGate: skipped check blocks", () => {
  const result = decideCiGate([check("ci", "completed", "skipped")]);
  assert.ok(typeof result === "object" && "blocked" in result);
});

Deno.test("decideCiGate: neutral check blocks", () => {
  const result = decideCiGate([check("ci", "completed", "neutral")]);
  assert.ok(typeof result === "object" && "blocked" in result);
});

Deno.test("decideCiGate: in-progress check waits (non-blocking)", () => {
  const checks = [
    check("ci", "completed", "success"),
    check("slow", "in_progress", null, null),
  ];
  assert.equal(decideCiGate(checks), "wait");
});

Deno.test("decideCiGate: queued check waits", () => {
  const checks = [check("ci", "queued", null, null)];
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

Deno.test("decideCiGate: dedupes by name, latest wins", () => {
  // Old failed run must not override a newer pass.
  const checks = [
    check("ci", "completed", "failure", 1),
    check("ci", "completed", "success", 2),
  ];
  assert.equal(decideCiGate(checks), "proceed");
});

Deno.test("decideCiGate: dedupes by name, latest pending waits", () => {
  // Newer pending run overrides an older pass.
  const checks = [
    { ...check("ci", "completed", "success", 1), startedAt: 0 },
    { ...check("ci", "in_progress", null, null), startedAt: 2 },
  ];
  assert.equal(decideCiGate(checks), "wait");
});
