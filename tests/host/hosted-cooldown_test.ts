/**
 * Hosted cross-role cooldown gates: real temporary Git repair/release state
 * stores with a monotonic fake clock. No network, model, GitHub, deployment or
 * real rate-limit call is made; the durable holds are the only asserted state.
 */
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import {
  parseGitHubCooldownV1,
  parseGitHubRateLimitV1,
} from "../../src/contracts/github-cooldown.ts";
import type {
  GitHubCooldownV1,
  GitHubRateLimitV1,
} from "../../src/contracts/github-cooldown.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type {
  Clock,
  PortResultV1,
  ReleaseStateWriter,
  RepairStateWriter,
  StateReadResultV1,
  StateReadView,
  StateWriteResultV1,
} from "../../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import {
  HostedRepairCooldownGate,
  HostedSupervisorCooldownGate,
} from "../../src/host/hosted-cooldown.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
} from "../../src/state/mod.ts";
import type {
  ReleaseGitStateStore,
  RepairGitStateStore,
} from "../../src/state/mod.ts";
import {
  makeRemoteCtx,
  releaseRecord,
  T0,
  testGitEnv,
} from "../state/helpers.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/host\/hosted-cooldown_test\.ts$/,
  "",
);

class FakeClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/**
 * Real store reads/writes with exactly one injected persistence fault; the
 * durable state itself is always the real temporary Git store.
 */
class FaultyReleaseStore implements StateReadView, ReleaseStateWriter {
  constructor(
    private readonly real: ReleaseGitStateStore,
    private readonly fault: "readFailure" | "staleRead" | "failed" | "throw",
    private readonly stale:
      | { snapshot: ReleaseStateSnapshotV1; head: GitSha }
      | null = null,
  ) {}

  readRelease(): Promise<
    PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>>
  > {
    if (this.fault === "readFailure") {
      return Promise.resolve(portError("unavailable", "forced read failure"));
    }
    if (this.fault === "staleRead" && this.stale !== null) {
      return Promise.resolve(portOk({
        status: "found" as const,
        snapshot: this.stale.snapshot,
        head: this.stale.head,
        ref: null,
      }));
    }
    return this.real.readRelease();
  }

  readRepair() {
    return this.real.readRepair();
  }

  writeRelease(
    next: ReleaseStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    if (this.fault === "failed") {
      return Promise.resolve(portError("unavailable", "forced write failure"));
    }
    if (this.fault === "throw") throw new Error("forced write throw");
    return this.real.writeRelease(next, expectedHead);
  }
}

/** Repair-capable store whose release read always fails. */
class UnreadableReleaseForRepair implements StateReadView, RepairStateWriter {
  constructor(private readonly real: RepairGitStateStore) {}
  readRelease() {
    return Promise.resolve(portError("unavailable", "forced read failure"));
  }
  readRepair() {
    return this.real.readRepair();
  }
  writeRepair(next: RepairStateSnapshotV1, expectedHead: GitSha | null) {
    return this.real.writeRepair(next, expectedHead);
  }
}

interface RigV1 {
  release: ReleaseGitStateStore;
  repair: RepairGitStateStore;
  clock: FakeClock;
  supervisor(): HostedSupervisorCooldownGate;
  repairGate(): HostedRepairCooldownGate;
  seedRelease(
    githubCooldowns: GitHubCooldownV1[],
    releases?: ReleaseStateSnapshotV1["releases"],
  ): Promise<void>;
  seedRepair(githubCooldowns: GitHubCooldownV1[]): Promise<void>;
  cleanup(): Promise<void>;
}

async function makeRig(): Promise<RigV1> {
  const tmp = await Deno.makeTempDir({
    prefix: "sentinel-hosted-cooldown-",
    dir: ROOT,
  });
  const env = testGitEnv(`${tmp}/git-home`);
  await Deno.mkdir(`${tmp}/git-home`, { recursive: true });
  const remote = await makeRemoteCtx(tmp, env);
  const release = createReleaseStateStore({
    scratchDir: `${tmp}/release-scratch`,
    remoteUrl: remote.remoteUrl,
  });
  const repair = createRepairStateStore({
    scratchDir: `${tmp}/repair-scratch`,
    remoteUrl: remote.remoteUrl,
  });
  const clock = new FakeClock(T0);
  const rig: RigV1 = {
    release,
    repair,
    clock,
    supervisor: () =>
      new HostedSupervisorCooldownGate({ state: release, clock }),
    repairGate: () => new HostedRepairCooldownGate({ state: repair, clock }),
    seedRelease: (githubCooldowns, releases = []) =>
      seedRelease(rig, githubCooldowns, releases),
    seedRepair: (githubCooldowns) => seedRepair(rig, githubCooldowns),
    cleanup: async () => {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    },
  };
  return rig;
}

function scopeCooldown(
  overrides: Record<string, unknown> = {},
): GitHubCooldownV1 {
  return parseGitHubCooldownV1({
    installationId: 0,
    retryNotBefore: T0 + 60_000,
    observedAt: T0,
    observationId: "a".repeat(64),
    secondaryBackoff: 0,
    ...overrides,
  });
}

function rate(overrides: Record<string, unknown> = {}): GitHubRateLimitV1 {
  return parseGitHubRateLimitV1({
    kind: "primary",
    observedAt: T0,
    retryNotBefore: T0 + 60_000,
    observationId: "b".repeat(64),
    fallback: false,
    ...overrides,
  });
}

async function seedRelease(
  rig: RigV1,
  githubCooldowns: GitHubCooldownV1[],
  releases: ReleaseStateSnapshotV1["releases"] = [],
): Promise<void> {
  const read = await releaseRead(rig, true);
  const prior = read === null ? null : read.snapshot;
  const head = read === null ? null : read.head;
  const next = parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: head,
    sequence: prior === null ? 1 : prior.sequence + 1,
    updatedAt: Math.max(rig.clock.now(), prior?.updatedAt ?? 0),
    releases: prior === null ? releases : prior.releases,
    hostedRuntimes: prior?.hostedRuntimes ?? [],
    hostedReleases: prior?.hostedReleases ?? [],
    githubCooldowns,
  });
  const written = await rig.release.writeRelease(next, head);
  assert.ok(
    written.ok && written.value.status === "applied",
    JSON.stringify(written),
  );
}

async function seedRepair(
  rig: RigV1,
  githubCooldowns: GitHubCooldownV1[],
): Promise<void> {
  const read = await rig.repair.readRepair();
  assert.ok(read.ok, JSON.stringify(read));
  if (!read.ok) throw new Error("repair read failed");
  const prior = read.value.status === "found" ? read.value.snapshot : null;
  const head = read.value.status === "found" ? read.value.head : null;
  const next = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: head,
    sequence: prior === null ? 1 : prior.sequence + 1,
    updatedAt: Math.max(rig.clock.now(), prior?.updatedAt ?? 0),
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns,
  });
  const written = await rig.repair.writeRepair(next, head);
  assert.ok(
    written.ok && written.value.status === "applied",
    JSON.stringify(written),
  );
}

async function releaseRead(
  rig: RigV1,
  allowAbsent = false,
): Promise<{ snapshot: ReleaseStateSnapshotV1; head: GitSha } | null> {
  const read = await rig.release.readRelease();
  assert.ok(read.ok, JSON.stringify(read));
  if (!read.ok) throw new Error("release read failed");
  if (read.value.status === "absent") {
    assert.ok(allowAbsent, "expected release state");
    return null;
  }
  return { snapshot: read.value.snapshot, head: read.value.head };
}

async function readReleaseSnapshot(
  rig: RigV1,
): Promise<ReleaseStateSnapshotV1> {
  const read = await releaseRead(rig);
  if (read === null) throw new Error("missing release state");
  return read.snapshot;
}

async function readRepairSnapshot(rig: RigV1): Promise<RepairStateSnapshotV1> {
  const read = await rig.repair.readRepair();
  assert.ok(read.ok && read.value.status === "found", JSON.stringify(read));
  if (!read.ok || read.value.status !== "found") {
    throw new Error("missing repair state");
  }
  return read.value.snapshot;
}

async function repairHead(rig: RigV1): Promise<GitSha> {
  const read = await rig.repair.readRepair();
  assert.ok(read.ok && read.value.status === "found", JSON.stringify(read));
  if (!read.ok || read.value.status !== "found") {
    throw new Error("missing repair state");
  }
  return read.value.head;
}

/** One CAS write that preserves every existing record (moves the head only). */
async function bumpRelease(rig: RigV1): Promise<void> {
  await attemptReleaseCooldowns(
    rig,
    (await readReleaseSnapshot(rig)).githubCooldowns,
  );
}

async function attemptReleaseCooldowns(
  rig: RigV1,
  githubCooldowns: GitHubCooldownV1[],
): Promise<PortResultV1<StateWriteResultV1>> {
  const read = await releaseRead(rig);
  if (read === null) throw new Error("missing release state");
  const next = parseReleaseStateSnapshotV1({
    ...read.snapshot,
    stateHead: read.head,
    sequence: read.snapshot.sequence + 1,
    updatedAt: Math.max(rig.clock.now(), read.snapshot.updatedAt + 1),
    githubCooldowns,
  });
  return await rig.release.writeRelease(next, read.head);
}

function assertRateLimited(result: PortResultV1<void>): void {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) return;
  assert.equal(result.error.kind, "rate_limited", JSON.stringify(result));
}

function assertUnavailable(result: PortResultV1<void>): void {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) return;
  assert.equal(result.error.kind, "unavailable", JSON.stringify(result));
}

Deno.test("hosted cooldown: either ref's scope-0 hold blocks and is never erased", async () => {
  const rig = await makeRig();
  try {
    await rig.seedRelease([scopeCooldown()]);
    await rig.seedRepair([]);
    const supervisor = rig.supervisor();
    const repairGate = rig.repairGate();
    assertRateLimited(await supervisor.beforeRequest(0));
    assertRateLimited(await repairGate.beforeRequest(0));

    // An elapsed hold is allowed but remains durable and unchecked-erased.
    rig.clock.advance(120_000);
    assert.ok((await supervisor.beforeRequest(0)).ok);
    assert.ok((await repairGate.beforeRequest(0)).ok);
    const elapsed = await readReleaseSnapshot(rig);
    assert.equal(elapsed.githubCooldowns[0].retryNotBefore, T0 + 60_000);
    const sequence = elapsed.sequence;
    assert.ok((await supervisor.beforeRequest(0)).ok);
    assert.equal((await readReleaseSnapshot(rig)).sequence, sequence);

    // A future hold on the other ref blocks while this ref's hold is elapsed.
    const now = rig.clock.now();
    await rig.seedRepair([
      scopeCooldown({ observedAt: now, retryNotBefore: now + 60_000 }),
    ]);
    assertRateLimited(await supervisor.beforeRequest(0));
    assertRateLimited(await repairGate.beforeRequest(0));
    rig.clock.advance(120_000);
    assert.ok((await supervisor.beforeRequest(0)).ok);
    assert.ok((await repairGate.beforeRequest(0)).ok);

    // A retained null hold (manual fail-closed) blocks at any time.
    await rig.seedRelease([scopeCooldown({ retryNotBefore: null })]);
    assertRateLimited(await supervisor.beforeRequest(0));
    assertRateLimited(await repairGate.beforeRequest(0));
    assert.equal(
      (await readReleaseSnapshot(rig)).githubCooldowns[0].retryNotBefore,
      null,
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted cooldown: a supervisor hold lands only in the release ref and survives restart", async () => {
  const rig = await makeRig();
  try {
    await rig.seedRelease([], [releaseRecord("rel-1")]);
    await rig.seedRepair([]);
    const headBefore = await repairHead(rig);

    assert.ok((await rig.supervisor().recordRateLimit(0, rate())).ok);
    const release = await readReleaseSnapshot(rig);
    assert.equal(release.releases[0]?.id, "rel-1");
    assert.equal(release.hostedRuntimes.length, 0);
    assert.equal(release.hostedReleases.length, 0);
    const record = release.githubCooldowns.find((entry) =>
      entry.installationId === 0
    );
    assert.ok(record !== undefined);
    assert.equal(record?.retryNotBefore, T0 + 60_000);
    // The repair ref is untouched by a release-role write.
    assert.equal(await repairHead(rig), headBefore);
    assert.equal((await readRepairSnapshot(rig)).githubCooldowns.length, 0);

    // New instances over the same durable refs still see the shared hold.
    assertRateLimited(await rig.supervisor().beforeRequest(0));
    assertRateLimited(await rig.repairGate().beforeRequest(0));
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted cooldown: a repair hold is honored by the supervisor and never shortened", async () => {
  const rig = await makeRig();
  try {
    await rig.seedRelease([], [releaseRecord("rel-1")]);
    await rig.seedRepair([]);
    const release = await releaseRead(rig);
    if (release === null) throw new Error("missing release state");

    assert.ok((await rig.repairGate().recordRateLimit(0, rate())).ok);
    assert.equal(
      (await readRepairSnapshot(rig)).githubCooldowns[0].retryNotBefore,
      T0 + 60_000,
    );
    // The repair-role write never touches the release ref.
    const afterRepair = await releaseRead(rig);
    assert.equal(afterRepair?.head, release.head);
    assert.equal(afterRepair?.snapshot.releases[0]?.id, "rel-1");
    assert.equal(afterRepair?.snapshot.githubCooldowns.length, 0);
    assertRateLimited(await rig.supervisor().beforeRequest(0));

    // A later supervisor observation merges the repair hold conservatively.
    assert.ok(
      (await rig.supervisor().recordRateLimit(
        0,
        rate({
          observedAt: T0 + 10_000,
          retryNotBefore: T0 + 20_000,
          observationId: "d".repeat(64),
        }),
      )).ok,
    );
    const merged = (await readReleaseSnapshot(rig)).githubCooldowns[0];
    assert.equal(merged.retryNotBefore, T0 + 60_000);
    assert.equal(merged.observedAt, T0 + 10_000);
    assert.equal(merged.observationId, "d".repeat(64));
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted cooldown: duplicate observations are idempotent and unknown persistence latches", async () => {
  const rig = await makeRig();
  try {
    await rig.seedRelease([]);
    await rig.seedRepair([]);
    const observation = rate();
    const supervisor = rig.supervisor();
    assert.ok((await supervisor.recordRateLimit(0, observation)).ok);
    const first = await releaseRead(rig);
    if (first === null) throw new Error("missing release state");

    // The exact same durable observation is a no-write success.
    assert.ok((await supervisor.recordRateLimit(0, observation)).ok);
    const duplicate = await readReleaseSnapshot(rig);
    assert.equal(duplicate.sequence, first.snapshot.sequence);
    assert.deepEqual(duplicate.githubCooldowns, first.snapshot.githubCooldowns);

    await bumpRelease(rig);
    const later = rate({
      observedAt: T0 + 5000,
      retryNotBefore: T0 + 70_000,
      observationId: "e".repeat(64),
    });

    // A stale read makes the real expected-head CAS report a conflict.
    const conflicted = new HostedSupervisorCooldownGate({
      state: new FaultyReleaseStore(rig.release, "staleRead", first),
      clock: rig.clock,
    });
    assertUnavailable(await conflicted.recordRateLimit(0, later));
    assertUnavailable(await conflicted.beforeRequest(0));

    const failed = new HostedSupervisorCooldownGate({
      state: new FaultyReleaseStore(rig.release, "failed"),
      clock: rig.clock,
    });
    assertUnavailable(await failed.recordRateLimit(0, later));
    assertUnavailable(await failed.beforeRequest(0));

    const thrown = new HostedSupervisorCooldownGate({
      state: new FaultyReleaseStore(rig.release, "throw"),
      clock: rig.clock,
    });
    assertUnavailable(await thrown.recordRateLimit(0, later));

    // A malformed observation latches before any state is written.
    const malformed = new HostedSupervisorCooldownGate({
      state: rig.release,
      clock: rig.clock,
    });
    assertUnavailable(
      await malformed.recordRateLimit(0, { ...later, retryNotBefore: T0 - 1 }),
    );
    assertUnavailable(await malformed.beforeRequest(0));

    // Wrong scope and a bad clock latch as well.
    const wrongScope = new HostedSupervisorCooldownGate({
      state: rig.release,
      clock: rig.clock,
    });
    assertUnavailable(await wrongScope.beforeRequest(7));
    const badClock = new HostedSupervisorCooldownGate({
      state: rig.release,
      clock: { now: () => -1 },
    });
    assertUnavailable(await badClock.beforeRequest(0));
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted cooldown: absent or unreadable state latches and never reopens", async () => {
  const rig = await makeRig();
  try {
    const supervisor = rig.supervisor();
    const repairGate = rig.repairGate();
    assertUnavailable(await supervisor.beforeRequest(0));
    assertUnavailable(await repairGate.beforeRequest(0));
    // Seeding real state later never reopens a latched instance.
    await rig.seedRelease([]);
    await rig.seedRepair([]);
    assertUnavailable(await supervisor.beforeRequest(0));
    assertUnavailable(await repairGate.beforeRequest(0));

    const unreadable = new HostedSupervisorCooldownGate({
      state: new FaultyReleaseStore(rig.release, "readFailure"),
      clock: rig.clock,
    });
    assertUnavailable(await unreadable.beforeRequest(0));

    const unreadableForRepair = new HostedRepairCooldownGate({
      state: new UnreadableReleaseForRepair(rig.repair),
      clock: rig.clock,
    });
    assertUnavailable(await unreadableForRepair.beforeRequest(0));
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted cooldown: release state rejects dropping or weakening a cooldown", async () => {
  const finite = await makeRig();
  try {
    const seeded = scopeCooldown({
      observedAt: T0 + 5000,
      retryNotBefore: T0 + 30_000,
      secondaryBackoff: 2,
    });
    await finite.seedRelease([seeded]);
    assert.equal((await attemptReleaseCooldowns(finite, [])).ok, false);
    assert.equal(
      (await attemptReleaseCooldowns(finite, [
        scopeCooldown({ observedAt: T0, retryNotBefore: T0 + 30_000 }),
      ])).ok,
      false,
    );
    // A later observation may not shorten a finite deadline.
    assert.equal(
      (await attemptReleaseCooldowns(finite, [
        scopeCooldown({
          observedAt: T0 + 6000,
          retryNotBefore: T0 + 20_000,
          secondaryBackoff: 2,
        }),
      ])).ok,
      false,
    );
    // Nor may it decrease the bounded fallback index.
    assert.equal(
      (await attemptReleaseCooldowns(finite, [
        scopeCooldown({
          observedAt: T0 + 6000,
          retryNotBefore: T0 + 40_000,
          secondaryBackoff: 1,
        }),
      ])).ok,
      false,
    );
    // Every rejected attempt left the persisted record untouched.
    assert.deepEqual(
      (await readReleaseSnapshot(finite)).githubCooldowns,
      [seeded],
    );

    const applied = await attemptReleaseCooldowns(finite, [
      scopeCooldown({
        observedAt: T0 + 6000,
        retryNotBefore: T0 + 90_000,
        observationId: "f".repeat(64),
        secondaryBackoff: 3,
      }),
    ]);
    assert.ok(
      applied.ok && applied.value.status === "applied",
      JSON.stringify(applied),
    );
    const extended = (await readReleaseSnapshot(finite)).githubCooldowns[0];
    assert.equal(extended.retryNotBefore, T0 + 90_000);
    assert.equal(extended.secondaryBackoff, 3);

    // A finite hold may still become the stricter manual hold (null deadline).
    const manualized = await attemptReleaseCooldowns(finite, [
      scopeCooldown({
        observedAt: T0 + 7000,
        retryNotBefore: null,
        observationId: "e".repeat(64),
        secondaryBackoff: 3,
      }),
    ]);
    assert.ok(
      manualized.ok && manualized.value.status === "applied",
      JSON.stringify(manualized),
    );
    const held = (await readReleaseSnapshot(finite)).githubCooldowns[0];
    assert.equal(held.retryNotBefore, null);
    assert.equal(held.observedAt, T0 + 7000);
    assert.equal(held.secondaryBackoff, 3);
  } finally {
    await finite.cleanup();
  }

  const manual = await makeRig();
  try {
    await manual.seedRelease([scopeCooldown({ retryNotBefore: null })]);
    assert.equal((await attemptReleaseCooldowns(manual, [])).ok, false);
    assert.equal(
      (await attemptReleaseCooldowns(manual, [
        scopeCooldown({ retryNotBefore: T0 + 60_000 }),
      ])).ok,
      false,
    );
    assert.equal(
      (await readReleaseSnapshot(manual)).githubCooldowns[0].retryNotBefore,
      null,
    );
  } finally {
    await manual.cleanup();
  }
});
