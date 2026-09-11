/**
 * m04-repair local owner scope tests: installation scope 0 is the explicit
 * no-App local credential. It shares the durable cooldown and configured-
 * repository matching with every other scope — no Git, timers, network or
 * credentials are touched, and the real contract parsers plus the durable
 * cooldown gate run over the in-memory state capability.
 */
import assert from "node:assert/strict";

import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { rankEligibleWork } from "../../src/repair/selection.ts";
import { T0, workRecord } from "../state/helpers.ts";
import { FakeClock, MemoryState, repairConfigs } from "./helpers.ts";

/** A local no-App scope for a repository that is not the configured target. */
const LOCAL = {
  owner: "ubiquity",
  name: "sentinel",
  installationId: 0,
} as const;

function emptySnapshot(): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
  });
}

Deno.test("local owner: scope 0 cooldown persists and survives a gate restart", async () => {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  const seeded = await state.writeRepair(emptySnapshot(), null);
  assert.equal(seeded.ok, true);

  const deadline = T0 + 60_000;
  const gate = new DurableGitHubCooldownGate({ state, clock });
  const recorded = await gate.recordRateLimit(0, {
    kind: "primary",
    observedAt: T0,
    retryNotBefore: deadline,
    observationId: "a".repeat(64),
    fallback: false,
  });
  assert.equal(recorded.ok, true);

  const read = await state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  if (!read.ok || read.value.status !== "found") return;
  assert.deepEqual(read.value.snapshot.githubCooldowns, [{
    installationId: 0,
    retryNotBefore: deadline,
    observedAt: T0,
    observationId: "a".repeat(64),
    secondaryBackoff: 0,
  }]);

  // A restarted gate reads the same durable record and still denies.
  const restarted = new DurableGitHubCooldownGate({ state, clock });
  const denied = await restarted.beforeRequest(0);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.kind, "rate_limited");

  // An unrelated positive App scope is unaffected by the local cooldown.
  assert.equal((await restarted.beforeRequest(7)).ok, true);

  clock.advance(59_999);
  assert.equal((await restarted.beforeRequest(0)).ok, false);
  clock.advance(1);
  assert.equal((await restarted.beforeRequest(0)).ok, true);
});

Deno.test("local owner: scope 0 work still requires a configured repository", () => {
  const record = workRecord("local-owner-1", { repository: { ...LOCAL } });
  const snapshot: RepairStateSnapshotV1 = {
    ...emptySnapshot(),
    work: [record],
  };

  // No configured repository matches: scope 0 is skipped, never exempted.
  const unconfigured = rankEligibleWork(snapshot, repairConfigs(), T0);
  assert.equal(unconfigured.skipped[record.id], "unconfigured");
  assert.deepEqual(unconfigured.ordered, []);

  // The matching github adapter config for scope 0 makes it eligible.
  const configured = rankEligibleWork(
    snapshot,
    repairConfigs({
      repository: { ...LOCAL },
      adapter: { kind: "github" },
    }),
    T0,
  );
  assert.deepEqual(configured.ordered, [record.id]);
  assert.equal(configured.skipped[record.id], undefined);
});

Deno.test("local owner: same owner/name under another installation is unconfigured", () => {
  const record = workRecord("local-owner-2", { repository: { ...LOCAL } });
  const snapshot: RepairStateSnapshotV1 = {
    ...emptySnapshot(),
    work: [record],
  };

  // Exact same owner/name but a DIFFERENT installation scope (a positive App
  // id): the local scope 0 record must never be authorized through another
  // App's configuration, even though owner/name match.
  const otherScope = rankEligibleWork(
    snapshot,
    repairConfigs({
      repository: { owner: LOCAL.owner, name: LOCAL.name, installationId: 7 },
      adapter: { kind: "github" },
    }),
    T0,
  );
  assert.equal(otherScope.skipped[record.id], "unconfigured");
  assert.deepEqual(otherScope.ordered, []);

  // The exact scope identity (installation 0) remains eligible.
  const exactScope = rankEligibleWork(
    snapshot,
    repairConfigs({
      repository: { ...LOCAL },
      adapter: { kind: "github" },
    }),
    T0,
  );
  assert.deepEqual(exactScope.ordered, [record.id]);
});
