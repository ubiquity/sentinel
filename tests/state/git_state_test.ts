// GitStateStore suite against real disposable local bare repositories.
//
// Covers: branch creation/read/restart, strict expected-head CAS with both
// identical and different concurrent candidates (exactly one fresh applied
// authorization), non-fast-forward rejection, role separation, malformed
// remote record trees, immutable/terminal preservation, reservation
// deletion/refund guards, a successful push followed by a simulated lost
// response with authoritative reread, and an unavailable remote never being
// mistaken for empty. No production state branch is created anywhere: every
// commit and push goes to the disposable local bare repo in the task temp
// directory (removed after each test).
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import { asFindingFingerprint } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { parseGitHubCooldownV1 } from "../../src/contracts/github-cooldown.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import {
  DenoGitRunner,
  GitStateStore,
  REPAIR_STATE_REF,
} from "../../src/state/mod.ts";
import type { GitRunnerV1 } from "../../src/state/mod.ts";
import {
  BarrierRunner,
  DEP_2,
  FailedPushRunner,
  FakeLsRemoteRunner,
  gitRun,
  incidentEvidence,
  incidentSummary,
  LostPushResponseRunner,
  makeRemoteCtx,
  monitoredReleaseRecord,
  pushRawTree,
  releaseRecord,
  releaseRequest,
  reservation,
  reviewReceipt,
  SHA2,
  sha256Hex,
  SHA3,
  T0,
  testGitEnv,
  ThrowAfterRunner,
  ThrowingRunner,
  workRecord,
} from "./helpers.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/state\/git_state_test\.ts$/,
  "",
);

interface Ctx {
  tmp: string;
  env: Record<string, string>;
  remoteUrl: string;
  bare: string;
  work: string;
  cleanup(): Promise<void>;
}

function repairSnapshot(
  overrides: Partial<RepairStateSnapshotV1> = {},
): RepairStateSnapshotV1 {
  return {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0 + 1000,
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    ...overrides,
  };
}

function releaseSnapshot(
  overrides: Partial<ReleaseStateSnapshotV1> = {},
): ReleaseStateSnapshotV1 {
  return {
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0 + 1000,
    releases: [],
    hostedRuntimes: [],
    hostedReleases: [],
    ...overrides,
  };
}

/** Minimal valid durable GitHub cooldown, parsed by the frozen parser. */
function githubCooldown(
  installationId: number,
  overrides: Record<string, unknown> = {},
): ReturnType<typeof parseGitHubCooldownV1> {
  return parseGitHubCooldownV1({
    installationId,
    retryNotBefore: null,
    observedAt: T0,
    observationId: "a".repeat(64),
    secondaryBackoff: 0,
    ...overrides,
  });
}

async function makeCtx(prefix: string): Promise<Ctx> {
  const tmp = await Deno.makeTempDir({
    prefix: `sentinel-state-test-${prefix}-`,
    dir: ROOT,
  });
  const env = testGitEnv(`${tmp}/git-home`);
  await Deno.mkdir(`${tmp}/git-home`, { recursive: true });
  const remote = await makeRemoteCtx(tmp, env);
  return {
    tmp,
    env,
    remoteUrl: remote.remoteUrl,
    bare: remote.bare,
    work: remote.work,
    cleanup: async () => {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    },
  };
}

function storeAt(
  ctx: Ctx,
  name: string,
  role: "repair" | "release",
  runner?: GitRunnerV1,
): GitStateStore {
  return new GitStateStore({
    scratchDir: `${ctx.tmp}/scratch-${name}`,
    remoteUrl: ctx.remoteUrl,
    role,
    runner,
  });
}

async function remoteHead(ctx: Ctx, ref: string): Promise<GitSha> {
  const result = await gitRunAt(ctx, ["--git-dir", ctx.bare, "rev-parse", ref]);
  if (!result.ok) throw new Error(`remote head failed: ${result.stderr}`);
  return result.stdout.trim() as GitSha;
}

function gitRunAt(
  ctx: Ctx,
  args: string[],
): Promise<Awaited<ReturnType<typeof gitRun>>> {
  return gitRun(ctx.tmp, args, ctx.env);
}

function appliedHead(
  result: Awaited<ReturnType<GitStateStore["writeRepair"]>>,
): GitSha {
  assert.ok(result.ok, "expected a store result");
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.value.status, "applied");
  if (result.value.status !== "applied") throw new Error("unreachable");
  return result.value.head;
}

Deno.test("state: branch creation, sequential writes, read and restart", async () => {
  const ctx = await makeCtx("lifecycle");
  try {
    const first = storeAt(ctx, "a", "repair");
    const absent = await first.readRepair();
    assert.ok(absent.ok);
    if (absent.ok) {
      assert.equal(absent.value.status, "absent");
      assert.equal(absent.value.currentHead, null);
      assert.equal(absent.value.ref, REPAIR_STATE_REF);
    }

    const s1 = repairSnapshot({ work: [workRecord("w:1")] });
    const created = await first.writeRepair(s1, null);
    const head1 = appliedHead(created);

    const s2 = repairSnapshot({
      stateHead: head1,
      sequence: 2,
      updatedAt: T0 + 2000,
      work: [workRecord("w:1"), workRecord("w:2")],
    });
    const extended = await first.writeRepair(s2, head1);
    const head2 = appliedHead(extended);

    // A restarted store (fresh scratch) reads the exact remote state; the
    // returned head is the state commit while the snapshot parent is separate.
    const restarted = storeAt(ctx, "b", "repair");
    const read = await restarted.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      assert.equal(read.value.head, head2);
      assert.equal(read.value.ref, REPAIR_STATE_REF);
      assert.equal(read.value.snapshot.stateHead, head1);
      assert.equal(read.value.snapshot.sequence, 2);
      assert.equal(read.value.snapshot.work.length, 2);
    } else {
      assert.fail("expected a found snapshot");
    }

    // Every write carries a unique trusted nonce in commit metadata.
    const log = await gitRunAt(
      ctx,
      ["--git-dir", ctx.bare, "log", REPAIR_STATE_REF, "--format=%B"],
    );
    assert.ok(log.ok);
    const nonces = log.stdout.match(/^nonce: [0-9a-f]{64}$/gm) ?? [];
    assert.equal(nonces.length, 2);
    assert.notEqual(nonces[0], nonces[1]);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: identical concurrent candidates grant exactly one applied", async () => {
  const ctx = await makeCtx("cas-identical");
  try {
    const runner = new BarrierRunner(new DenoGitRunner(`${ctx.tmp}/git-home`));
    const a = storeAt(ctx, "a", "repair", runner);
    const b = storeAt(ctx, "b", "repair", runner);
    const snapshot = repairSnapshot({ work: [workRecord("w:1")] });
    const [ra, rb] = await Promise.all([
      a.writeRepair(snapshot, null),
      b.writeRepair(snapshot, null),
    ]);
    assert.ok(ra.ok && rb.ok);
    if (!ra.ok || !rb.ok) throw new Error("unreachable");
    const outcomes = [ra.value, rb.value];
    const applied = outcomes.filter((o) => o.status === "applied");
    const conflicts = outcomes.filter((o) => o.status === "conflict");
    assert.equal(applied.length, 1, "exactly one fresh applied authorization");
    assert.equal(conflicts.length, 1, "the identical twin must conflict");
    const winner = applied[0] as { status: "applied"; head: GitSha };
    const loser = conflicts[0] as {
      status: "conflict";
      currentHead: GitSha | null;
    };
    assert.equal(loser.currentHead, winner.head);
    // The losing caller's same-second identical snapshot was NOT applied:
    // rereading the authoritative ref shows one state commit, not two.
    const read = await storeAt(ctx, "c", "repair").readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      assert.equal(read.value.head, winner.head);
      assert.equal(read.value.snapshot.stateHead, null);
    } else {
      assert.fail("expected a found snapshot");
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: different concurrent candidates: one applied, one conflict", async () => {
  const ctx = await makeCtx("cas-different");
  try {
    const runner = new BarrierRunner(new DenoGitRunner(`${ctx.tmp}/git-home`));
    const a = storeAt(ctx, "a", "repair", runner);
    const b = storeAt(ctx, "b", "repair", runner);
    const [ra, rb] = await Promise.all([
      a.writeRepair(repairSnapshot({ work: [workRecord("w:a")] }), null),
      b.writeRepair(repairSnapshot({ work: [workRecord("w:b")] }), null),
    ]);
    assert.ok(ra.ok && rb.ok);
    if (!ra.ok || !rb.ok) throw new Error("unreachable");
    const outcomes = [ra.value, rb.value];
    assert.equal(
      outcomes.filter((o) => o.status === "applied").length,
      1,
      "exactly one winner",
    );
    assert.equal(
      outcomes.filter((o) => o.status === "conflict").length,
      1,
      "the racing candidate must conflict and never overwrite",
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: non-fast-forward is rejected; losing writer never overwrites", async () => {
  const ctx = await makeCtx("nff");
  try {
    const a = storeAt(ctx, "a", "repair");
    const head1 = appliedHead(
      await a.writeRepair(repairSnapshot({ work: [workRecord("w:1")] }), null),
    );
    const b = storeAt(ctx, "b", "repair");
    const head2b = appliedHead(
      await b.writeRepair(
        repairSnapshot({
          stateHead: head1,
          sequence: 2,
          updatedAt: T0 + 2000,
          work: [workRecord("w:1"), workRecord("w:2")],
        }),
        head1,
      ),
    );
    // Store A races its own child of head1 against B's already-applied child:
    // the push is non-fast-forward and must become a conflict, and the
    // remote must still hold B's exact state.
    const stale = await a.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [workRecord("w:1"), workRecord("w:3")],
      }),
      head1,
    );
    assert.ok(stale.ok);
    if (stale.ok) {
      assert.equal(stale.value.status, "conflict");
      if (stale.value.status === "conflict") {
        assert.equal(stale.value.currentHead, head2b);
      }
    }
    const read = await a.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      assert.equal(read.value.head, head2b);
      assert.deepEqual(
        read.value.snapshot.work.map((w) => w.id),
        ["w:1", "w:2"],
      );
    } else {
      assert.fail("expected a found snapshot");
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: role separation; both roles read both fixed refs", async () => {
  const ctx = await makeCtx("roles");
  try {
    const repair = storeAt(ctx, "a", "repair");
    const release = storeAt(ctx, "b", "release");
    // Role mismatch fails before any mutation.
    const wrongRepair = await repair.writeRelease(
      releaseSnapshot({ releases: [releaseRecord("rel:1")] }),
      null,
    );
    assert.ok(!wrongRepair.ok);
    if (!wrongRepair.ok) assert.equal(wrongRepair.error.kind, "invalid");
    const releaseStillAbsent = await repair.readRelease();
    assert.ok(releaseStillAbsent.ok);
    if (releaseStillAbsent.ok) {
      assert.equal(releaseStillAbsent.value.status, "absent");
    }
    const wrongRelease = await release.writeRepair(
      repairSnapshot({ work: [workRecord("w:1")] }),
      null,
    );
    assert.ok(!wrongRelease.ok);
    if (!wrongRelease.ok) assert.equal(wrongRelease.error.kind, "invalid");
    const repairStillAbsent = await release.readRepair();
    assert.ok(repairStillAbsent.ok);
    if (repairStillAbsent.ok) {
      assert.equal(repairStillAbsent.value.status, "absent");
    }

    // Own rolls: repair writes repair, release writes release.
    const h1 = appliedHead(
      await repair.writeRepair(
        repairSnapshot({ work: [workRecord("w:1")] }),
        null,
      ),
    );
    const h2 = appliedHead(
      await release.writeRelease(
        releaseSnapshot({ releases: [releaseRecord("rel:1")] }),
        null,
      ),
    );
    // Both roles read both refs.
    const repairReadsRelease = await repair.readRelease();
    assert.ok(
      repairReadsRelease.ok && repairReadsRelease.value.status === "found",
    );
    if (repairReadsRelease.ok && repairReadsRelease.value.status === "found") {
      assert.equal(repairReadsRelease.value.head, h2);
    }
    const releaseReadsRepair = await release.readRepair();
    assert.ok(
      releaseReadsRepair.ok && releaseReadsRepair.value.status === "found",
    );
    if (releaseReadsRepair.ok && releaseReadsRepair.value.status === "found") {
      assert.equal(releaseReadsRepair.value.head, h1);
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: malformed remote record trees fail closed", async () => {
  const ctx = await makeCtx("malformed");
  try {
    const store = storeAt(ctx, "a", "repair");
    const head1 = appliedHead(
      await store.writeRepair(
        repairSnapshot({ work: [workRecord("w:1")] }),
        null,
      ),
    );

    // Missing manifest: the branch is corrupt, not empty.
    await pushRawTree(ctx, head1, REPAIR_STATE_REF, {
      "work/foo": "not even json",
    }, ctx.env);
    const missingManifest = await store.readRepair();
    assert.ok(!missingManifest.ok);
    if (!missingManifest.ok) {
      assert.equal(missingManifest.error.kind, "invalid");
    }

    // Embedded stateHead must equal the actual commit parent.
    const corruptHead = await remoteHead(ctx, REPAIR_STATE_REF);
    await pushRawTree(ctx, corruptHead, REPAIR_STATE_REF, {
      "manifest.json": JSON.stringify({
        version: "v1",
        kind: "repair_state_manifest",
        sequence: 2,
        updatedAt: T0 + 2000,
        stateHead: null,
      }),
    }, ctx.env);
    const wrongParent = await store.readRepair();
    assert.ok(!wrongParent.ok);
    if (!wrongParent.ok) assert.equal(wrongParent.error.kind, "invalid");

    // Unknown top-level entries and non-digest file names are invalid.
    const corruptHead2 = await remoteHead(ctx, REPAIR_STATE_REF);
    await pushRawTree(ctx, corruptHead2, REPAIR_STATE_REF, {
      "manifest.json": JSON.stringify({
        version: "v1",
        kind: "repair_state_manifest",
        sequence: 2,
        updatedAt: T0 + 2000,
        stateHead: corruptHead2,
      }),
      "junk.json": "{}",
      "work/zzzz.json": "{}",
    }, ctx.env);
    const junk = await store.readRepair();
    assert.ok(!junk.ok);
    if (!junk.ok) assert.equal(junk.error.kind, "invalid");

    // A digest-named file whose record id hashes to a different name is
    // misplaced state and must be rejected, not accepted.
    const corruptHead3 = await remoteHead(ctx, REPAIR_STATE_REF);
    const recordText = JSON.stringify(workRecord("w:1"));
    const otherFile = `${await sha256Hex("w:other")}.json`;
    await pushRawTree(ctx, corruptHead3, REPAIR_STATE_REF, {
      "manifest.json": JSON.stringify({
        version: "v1",
        kind: "repair_state_manifest",
        sequence: 2,
        updatedAt: T0 + 2000,
        stateHead: corruptHead3,
      }),
      [`work/${otherFile}`]: recordText,
    }, ctx.env);
    const misplaced = await store.readRepair();
    assert.ok(!misplaced.ok);
    if (!misplaced.ok) assert.equal(misplaced.error.kind, "invalid");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: work identity is immutable and done is terminal", async () => {
  const ctx = await makeCtx("work-immutable");
  try {
    const store = storeAt(ctx, "a", "repair");
    const done = workRecord("w:1", { nextStep: "done" });
    const head1 = appliedHead(
      await store.writeRepair(
        repairSnapshot({ work: [done] }),
        null,
      ),
    );

    const mutated = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [workRecord("w:1", { nextStep: "work", updatedAt: T0 + 5000 })],
      }),
      head1,
    );
    assert.ok(!mutated.ok);
    if (!mutated.ok) assert.equal(mutated.error.kind, "invalid");

    const dropped = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [],
      }),
      head1,
    );
    assert.ok(!dropped.ok);
    if (!dropped.ok) assert.equal(dropped.error.kind, "invalid");

    const failingChanged = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [workRecord("w:1", { failingRevision: "9".repeat(40) })],
      }),
      head1,
    );
    assert.ok(!failingChanged.ok);
    if (!failingChanged.ok) assert.equal(failingChanged.error.kind, "invalid");

    // Unchanged existing work plus a new record is the only allowed extension.
    const extended = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [done, workRecord("w:2")],
      }),
      head1,
    );
    assert.ok(extended.ok);
    if (extended.ok) assert.equal(extended.value.status, "applied");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: reservations cannot disappear, change identity or revert settlement", async () => {
  const ctx = await makeCtx("reservations");
  try {
    const store = storeAt(ctx, "a", "repair");
    const r1 = reservation("r:1");
    const r2 = reservation("r:2", {
      outcome: "ambiguous",
      settledAt: T0 + 500,
      proofRef: null,
    });
    const head1 = appliedHead(
      await store.writeRepair(
        repairSnapshot({ reservations: [r1, r2] }),
        null,
      ),
    );

    // Deletion is never allowed.
    const dropped = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        reservations: [r1],
      }),
      head1,
    );
    assert.ok(!dropped.ok);
    if (!dropped.ok) assert.equal(dropped.error.kind, "invalid");

    // Identity/time cannot change.
    const identityChanged = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        reservations: [
          { ...r1, head: "9".repeat(40) as GitSha },
          r2,
        ],
      }),
      head1,
    );
    assert.ok(!identityChanged.ok);
    if (!identityChanged.ok) {
      assert.equal(identityChanged.error.kind, "invalid");
    }

    // A refund requires the parser's proof ref: without it the input itself
    // fails contract validation before any mutation.
    const refundWithoutProof = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        reservations: [
          r1,
          { ...r2, outcome: "confirmed_not_submitted", settledAt: T0 + 900 },
        ],
      }),
      head1,
    );
    assert.ok(!refundWithoutProof.ok);
    if (!refundWithoutProof.ok) {
      assert.equal(refundWithoutProof.error.kind, "invalid");
    }

    // With the proof ref the ambiguous reservation may be refunded (the only
    // uncharged transition), and both reservations survive.
    const refunded = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        reservations: [
          r1,
          {
            ...r2,
            outcome: "confirmed_not_submitted",
            settledAt: T0 + 900,
            proofRef: "artifact://proof/r2",
          },
        ],
      }),
      head1,
    );
    assert.ok(refunded.ok);
    if (refunded.ok) assert.equal(refunded.value.status, "applied");
    const refundHead = refunded.ok && refunded.value.status === "applied"
      ? refunded.value.head
      : null;
    assert.ok(refundHead);

    // Settled state cannot revert into a charged outcome or change time.
    const revert = await store.writeRepair(
      repairSnapshot({
        stateHead: refundHead,
        sequence: 3,
        updatedAt: T0 + 3000,
        reservations: [
          r1,
          { ...r2, outcome: "ambiguous", settledAt: T0 + 800, proofRef: null },
        ],
      }),
      refundHead,
    );
    assert.ok(!revert.ok);
    if (!revert.ok) assert.equal(revert.error.kind, "invalid");
    const resubmit = await store.writeRepair(
      repairSnapshot({
        stateHead: refundHead,
        sequence: 3,
        updatedAt: T0 + 3000,
        reservations: [
          r1,
          {
            ...r2,
            outcome: "submitted",
            settledAt: T0 + 999,
            proofRef: null,
          },
        ],
      }),
      refundHead,
    );
    assert.ok(!resubmit.ok);
    if (!resubmit.ok) assert.equal(resubmit.error.kind, "invalid");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: release requests, releases and generic records are preserved", async () => {
  const ctx = await makeCtx("preserve");
  try {
    const store = storeAt(ctx, "a", "repair");
    const request = releaseRequest("q:1");
    const incident = incidentSummary("inc:1");
    const receipt = reviewReceipt("rv:1");
    const head1 = appliedHead(
      await store.writeRepair(
        repairSnapshot({
          work: [workRecord("w:1")],
          reservations: [reservation("r:1")],
          releaseRequests: [request],
          incidents: [incident],
          reviews: [receipt],
        }),
        null,
      ),
    );

    // Dropping any prior record is invalid.
    const dropRequest = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [workRecord("w:1")],
        reservations: [reservation("r:1")],
        releaseRequests: [],
      }),
      head1,
    );
    assert.ok(!dropRequest.ok);
    if (!dropRequest.ok) assert.equal(dropRequest.error.kind, "invalid");
    const dropIncident = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [workRecord("w:1")],
        reservations: [reservation("r:1")],
        releaseRequests: [request],
        incidents: [],
      }),
      head1,
    );
    assert.ok(!dropIncident.ok);
    if (!dropIncident.ok) assert.equal(dropIncident.error.kind, "invalid");

    // Request identity cannot change; open -> fulfilled is a valid transition;
    // a terminal request cannot restart or mutate.
    const identityChange = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [workRecord("w:1")],
        reservations: [reservation("r:1")],
        releaseRequests: [releaseRequest("q:1", { revision: SHA3 })],
      }),
      head1,
    );
    assert.ok(!identityChange.ok);
    if (!identityChange.ok) assert.equal(identityChange.error.kind, "invalid");

    const fulfilled = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [workRecord("w:1")],
        reservations: [reservation("r:1")],
        releaseRequests: [releaseRequest("q:1", { status: "fulfilled" })],
        incidents: [incident],
        reviews: [receipt],
      }),
      head1,
    );
    assert.ok(fulfilled.ok);
    if (fulfilled.ok) assert.equal(fulfilled.value.status, "applied");
    const head2 = fulfilled.ok && fulfilled.value.status === "applied"
      ? fulfilled.value.head
      : null;
    assert.ok(head2);

    const terminalRestart = await store.writeRepair(
      repairSnapshot({
        stateHead: head2,
        sequence: 3,
        updatedAt: T0 + 3000,
        work: [workRecord("w:1"), workRecord("w:2")],
        reservations: [reservation("r:1")],
        releaseRequests: [releaseRequest("q:1", { status: "open" })],
        incidents: [incident],
        reviews: [receipt],
      }),
      head2,
    );
    assert.ok(!terminalRestart.ok);
    if (!terminalRestart.ok) {
      assert.equal(terminalRestart.error.kind, "invalid");
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: release records stay identity-pinned and terminal", async () => {
  const ctx = await makeCtx("release-guards");
  try {
    const store = storeAt(ctx, "a", "release");
    const requested = releaseRecord("rel:1");
    const head1 = appliedHead(
      await store.writeRelease(
        releaseSnapshot({ releases: [requested] }),
        null,
      ),
    );

    // Request identity cannot change after creation.
    const identityChange = await store.writeRelease(
      releaseSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        releases: [
          releaseRecord("rel:1", {
            requestRevision: SHA3,
            candidate: { identity: DEP_2, buildTransactionId: "txn-rel-1" },
          }),
        ],
      }),
      head1,
    );
    assert.ok(!identityChange.ok);
    if (!identityChange.ok) assert.equal(identityChange.error.kind, "invalid");

    // requested -> monitoring -> accepted are the forward transitions.
    const monitored = monitoredReleaseRecord("rel:1", "monitoring");
    const head2 = appliedHead(
      await store.writeRelease(
        releaseSnapshot({
          stateHead: head1,
          sequence: 2,
          updatedAt: T0 + 2000,
          releases: [monitored],
        }),
        head1,
      ),
    );
    const accepted = monitoredReleaseRecord("rel:1", "accepted");
    const head3 = appliedHead(
      await store.writeRelease(
        releaseSnapshot({
          stateHead: head2,
          sequence: 3,
          updatedAt: T0 + 3000,
          releases: [accepted],
        }),
        head2,
      ),
    );

    // An accepted release cannot be reset into a fresh promotion nor mutate.
    const reset = await store.writeRelease(
      releaseSnapshot({
        stateHead: head3,
        sequence: 4,
        updatedAt: T0 + 4000,
        releases: [
          monitoredReleaseRecord("rel:1", "monitoring"),
        ],
      }),
      head3,
    );
    assert.ok(!reset.ok);
    if (!reset.ok) assert.equal(reset.error.kind, "invalid");
    const mutateTerminal = await store.writeRelease(
      releaseSnapshot({
        stateHead: head3,
        sequence: 4,
        updatedAt: T0 + 4000,
        releases: [
          {
            ...accepted,
            observed: { ...accepted.observed, domain: "https://evil.example" },
          },
        ],
      }),
      head3,
    );
    assert.ok(!mutateTerminal.ok);
    if (!mutateTerminal.ok) assert.equal(mutateTerminal.error.kind, "invalid");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: successful push with lost response reconciles to applied", async () => {
  const ctx = await makeCtx("lost-response");
  try {
    const runner = new LostPushResponseRunner(
      new DenoGitRunner(`${ctx.tmp}/git-home`),
    );
    const store = storeAt(ctx, "a", "repair", runner);
    const result = await store.writeRepair(
      repairSnapshot({ work: [workRecord("w:1")] }),
      null,
    );
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.value.status, "applied");
      if (result.value.status === "applied") {
        assert.match(result.value.head, /^[0-9a-f]{40}$/);
      }
    }
    assert.equal(runner.pushAttempts, 1);
    // A fresh store's authoritative reread sees exactly the reconciled state.
    const read = await storeAt(ctx, "b", "repair").readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      assert.equal(read.value.snapshot.work[0]?.id, "w:1");
      assert.equal(read.value.snapshot.stateHead, null);
      assert.equal(read.value.snapshot.sequence, 1);
    } else {
      assert.fail("expected a found snapshot");
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: rejected push with an absent ref reports auth failure", async () => {
  const ctx = await makeCtx("rejected-push");
  try {
    const runner = new FailedPushRunner(
      new DenoGitRunner(`${ctx.tmp}/git-home`),
    );
    const store = storeAt(ctx, "a", "repair", runner);
    const result = await store.writeRepair(
      repairSnapshot({ work: [workRecord("w:rejected")] }),
      null,
    );
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.error.kind, "auth_failed");
      assert.equal(
        result.error.detail,
        "state push was not applied; the remote ref remains absent",
      );
    }
    assert.equal(runner.pushAttempts, 1);
    const read = await storeAt(ctx, "b", "repair").readRepair();
    assert.ok(read.ok && read.value.status === "absent");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: unavailable remote is never mistakenly empty", async () => {
  const ctx = await makeCtx("unavailable");
  try {
    const store = new GitStateStore({
      scratchDir: `${ctx.tmp}/scratch-x`,
      remoteUrl: `${ctx.tmp}/missing-remote.git`,
      role: "repair",
    });
    const read = await store.readRepair();
    assert.ok(
      !read.ok,
      "an unavailable remote must not look like an empty branch",
    );
    const write = await store.writeRepair(repairSnapshot(), null);
    assert.ok(
      !write.ok,
      "a write to an unavailable remote must not be applied",
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: snapshot stateHead must equal the expected remote head", async () => {
  const ctx = await makeCtx("statehead");
  try {
    const store = storeAt(ctx, "a", "repair");
    const wrongHead = await store.writeRepair(
      repairSnapshot({
        stateHead: SHA3,
      }),
      null,
    );
    assert.ok(!wrongHead.ok);
    if (!wrongHead.ok) assert.equal(wrongHead.error.kind, "invalid");

    // A stale expected head conflicts with the actual ref and reads reconcile.
    const head1 = appliedHead(
      await store.writeRepair(
        repairSnapshot({ work: [workRecord("w:1")] }),
        null,
      ),
    );
    const stale = await store.writeRepair(
      repairSnapshot({
        stateHead: SHA3,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [workRecord("w:1")],
      }),
      SHA3,
    );
    assert.ok(stale.ok);
    if (stale.ok) {
      assert.equal(stale.value.status, "conflict");
      if (stale.value.status === "conflict") {
        assert.equal(stale.value.currentHead, head1);
      }
    }
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Raw-tree plumbing helper: pushes an exactly controlled state tree with real
// git (index + write-tree + commit-tree + non-force push), no checkout and no
// store involvement, so blob bytes and tree modes are exactly what the store
// must validate. Modes: 100644 regular, 100755 executable, 120000 symlink
// (for 120000 the text is the link target).
// ---------------------------------------------------------------------------

async function pushRawStateTree(
  ctx: Ctx,
  parent: GitSha | null,
  ref: string,
  files: {
    path: string;
    text: string;
    mode?: "100644" | "100755" | "120000";
  }[],
): Promise<void> {
  const env = ctx.env;
  const reset = await gitRun(ctx.work, ["read-tree", "--empty"], env);
  if (!reset.ok) throw new Error(`read-tree --empty failed: ${reset.stderr}`);
  // Stage every entry via index machinery (hash-object + cacheinfo): a
  // symlink entry is a blob whose text is the link target, so no filesystem
  // symlink is ever created and the recorded mode is exactly what we set.
  for (const file of files) {
    const blobFile = `${ctx.work}/__raw-blob`;
    await Deno.writeTextFile(blobFile, file.text);
    const blob = await gitRun(ctx.work, ["hash-object", "-w", blobFile], env);
    await Deno.remove(blobFile).catch(() => {});
    if (!blob.ok) throw new Error(`hash-object failed: ${blob.stderr}`);
    const mode = file.mode ?? "100644";
    const stage = await gitRun(
      ctx.work,
      [
        "update-index",
        "--add",
        "--cacheinfo",
        `${mode},${blob.stdout.trim()},${file.path}`,
      ],
      env,
    );
    if (!stage.ok) {
      throw new Error(`update-index ${file.path} failed: ${stage.stderr}`);
    }
  }
  const tree = await gitRun(ctx.work, ["write-tree"], env);
  if (!tree.ok) throw new Error(`write-tree failed: ${tree.stderr}`);
  const parentArgs = parent === null ? [] : ["-p", parent];
  const commit = await gitRun(
    ctx.work,
    ["commit-tree", tree.stdout.trim(), ...parentArgs, "-m", "raw state tree"],
    env,
  );
  if (!commit.ok) throw new Error(`commit-tree failed: ${commit.stderr}`);
  const push = await gitRun(
    ctx.work,
    ["push", "-q", "origin", `${commit.stdout.trim()}:${ref}`],
    env,
  );
  if (!push.ok) throw new Error(`push failed: ${push.stderr}`);
}

function rawManifestText(
  sequence: number,
  updatedAt: number,
  stateHead: GitSha | null,
): string {
  return `${
    canonicalStringify({
      version: "v1",
      kind: "repair_state_manifest",
      sequence,
      updatedAt,
      stateHead,
    })
  }\n`;
}

Deno.test("state: incident summaries keep identity fixed while lifecycle updates pass", async () => {
  const ctx = await makeCtx("incident-lifecycle");
  try {
    const store = storeAt(ctx, "a", "repair");
    const head1 = appliedHead(
      await store.writeRepair(
        repairSnapshot({ incidents: [incidentSummary("inc:1")] }),
        null,
      ),
    );

    // Legitimate repeated discovery: count/lastSeenAt/capturedAt advance and
    // severity/errorType/context/coverage/evidenceRef may update.
    const updated = incidentSummary("inc:1", {
      severity: "P1",
      lastSeenAt: T0 + 9000,
      count: 2,
      errorType: "UpstreamTerminated",
      context: {
        message: "still upstream terminated",
        location: "src/handler.ts:9",
        sample: ["line one"],
      },
      provenance: {
        source: "gateway",
        endpoint: "https://ai.ubq.fi",
        capturedAt: T0 + 8000,
        capturedBy: null,
      },
      coverage: {
        status: "incomplete",
        reason: "page limit",
        nextCursor: "p-2",
      },
      evidenceRef: {
        ref: "artifact://inbox/inc-1.pgp",
        digest: "e".repeat(64),
      },
    });
    const passed = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        incidents: [updated],
      }),
      head1,
    );
    assert.ok(passed.ok);
    if (passed.ok) assert.equal(passed.value.status, "applied");
    const head2 = passed.ok && passed.value.status === "applied"
      ? passed.value.head
      : null;
    assert.ok(head2);

    // Every identity/provenance tamper fails closed.
    const attempts: ReturnType<typeof incidentSummary>[] = [
      incidentSummary("inc:1", { fingerprint: "a".repeat(64) }),
      incidentSummary("inc:1", { firstSeenAt: T0 - 1000 }),
      incidentSummary("inc:1", { failingRevision: SHA3 }),
      { ...updated, count: 1 },
      { ...updated, lastSeenAt: T0 + 5000 },
      {
        ...updated,
        provenance: {
          ...updated.provenance,
          endpoint: "https://evil.example",
        },
      },
      {
        ...updated,
        provenance: { ...updated.provenance, capturedAt: T0 - 1 },
      },
    ];
    for (const mutant of attempts) {
      const result = await store.writeRepair(
        repairSnapshot({
          stateHead: head2,
          sequence: 3,
          updatedAt: T0 + 3000,
          incidents: [mutant],
        }),
        head2,
      );
      assert.ok(!result.ok, `expected rejection for ${JSON.stringify(mutant)}`);
      if (!result.ok) assert.equal(result.error.kind, "invalid");
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: incident evidence keeps identity, appends artifacts and fills replay once", async () => {
  const ctx = await makeCtx("evidence-lifecycle");
  try {
    const store = storeAt(ctx, "a", "repair");
    const evidence = incidentEvidence("ev:1");
    const head1 = appliedHead(
      await store.writeRepair(repairSnapshot({ evidence: [evidence] }), null),
    );

    // New distinct artifact appends and coverage may change; the prior
    // artifact stays exactly present.
    const extra = {
      ref: "artifact://inbox/ev-1-extra.pgp",
      digest: "f".repeat(64),
      sizeBytes: 128,
      expiresAt: T0 + 100000000,
      contentType: "text/plain",
    };
    const appended = incidentEvidence("ev:1", {
      artifacts: [...evidence.artifacts, extra],
      coverage: {
        status: "incomplete",
        reason: "page limit",
        nextCursor: "p-9",
      },
    });
    const passed = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        evidence: [appended],
      }),
      head1,
    );
    assert.ok(passed.ok);
    if (passed.ok) assert.equal(passed.value.status, "applied");
    const head2 = passed.ok && passed.value.status === "applied"
      ? passed.value.head
      : null;
    assert.ok(head2);

    const invalidAttempts: ReturnType<typeof incidentEvidence>[] = [
      // Removing a prior artifact is invalid.
      incidentEvidence("ev:1", { artifacts: [extra] }),
      // Altering a prior artifact is invalid.
      incidentEvidence("ev:1", {
        artifacts: [
          { ...evidence.artifacts[0], digest: "a".repeat(64) },
          extra,
        ],
      }),
      // Provenance cannot be rewritten.
      {
        ...appended,
        provenance: { ...appended.provenance, capturedAt: T0 + 1 },
      },
    ];
    for (const mutant of invalidAttempts) {
      const result = await store.writeRepair(
        repairSnapshot({
          stateHead: head2,
          sequence: 3,
          updatedAt: T0 + 3000,
          evidence: [mutant],
        }),
        head2,
      );
      assert.ok(!result.ok, `expected rejection for ${JSON.stringify(mutant)}`);
      if (!result.ok) assert.equal(result.error.kind, "invalid");
    }

    // Duplicate artifact refs (on an existing or a brand-new record) are
    // rejected by the frozen parser itself on every path — direct parse,
    // initial snapshot write and raw remote read are covered separately by
    // the parser guard tests; the store is not the only defense.

    // Replay metadata may go null -> valid, and fixtureDigest/reproducedAt
    // fill exactly once but never replace a non-null identity.
    const replay0 = incidentEvidence("ev:1", {
      artifacts: [...evidence.artifacts, extra],
      coverage: appended.coverage,
      replay: {
        fixtureRef: "fixture://captures/ev-1/upstream.json",
        fixtureDigest: null,
        upstreamCaptured: false,
        commandId: "replay_capture",
        reproducedAt: null,
      },
    });
    const h3 = appliedHead(
      await store.writeRepair(
        repairSnapshot({
          stateHead: head2,
          sequence: 3,
          updatedAt: T0 + 3000,
          evidence: [replay0],
        }),
        head2,
      ),
    );
    const replay1 = incidentEvidence("ev:1", {
      artifacts: [...evidence.artifacts, extra],
      coverage: appended.coverage,
      replay: {
        fixtureRef: "fixture://captures/ev-1/upstream.json",
        fixtureDigest: "ab".repeat(32),
        upstreamCaptured: true,
        commandId: "replay_capture",
        reproducedAt: null,
      },
    });
    const h4 = appliedHead(
      await store.writeRepair(
        repairSnapshot({
          stateHead: h3,
          sequence: 4,
          updatedAt: T0 + 4000,
          evidence: [replay1],
        }),
        h3,
      ),
    );
    const replay2 = incidentEvidence("ev:1", {
      artifacts: [...evidence.artifacts, extra],
      coverage: appended.coverage,
      replay: {
        fixtureRef: "fixture://captures/ev-1/upstream.json",
        fixtureDigest: "ab".repeat(32),
        upstreamCaptured: true,
        commandId: "replay_capture",
        reproducedAt: T0 + 6000,
      },
    });
    const h5 = appliedHead(
      await store.writeRepair(
        repairSnapshot({
          stateHead: h4,
          sequence: 5,
          updatedAt: T0 + 5000,
          evidence: [replay2],
        }),
        h4,
      ),
    );
    const fillAttempts: ReturnType<typeof incidentEvidence>[] = [
      // Replacing the filled digest is invalid.
      incidentEvidence("ev:1", {
        artifacts: [...evidence.artifacts, extra],
        coverage: appended.coverage,
        replay: { ...replay2.replay!, fixtureDigest: "cd".repeat(32) },
      }),
      // Replacing reproducedAt is invalid.
      incidentEvidence("ev:1", {
        artifacts: [...evidence.artifacts, extra],
        coverage: appended.coverage,
        replay: { ...replay2.replay!, reproducedAt: T0 + 7000 },
      }),
      // The fixture ref is identity: it cannot change.
      incidentEvidence("ev:1", {
        artifacts: [...evidence.artifacts, extra],
        coverage: appended.coverage,
        replay: {
          ...replay2.replay!,
          fixtureRef: "fixture://captures/other.json",
        },
      }),
      // Replay metadata cannot be removed again.
      incidentEvidence("ev:1", {
        artifacts: [...evidence.artifacts, extra],
        coverage: appended.coverage,
        replay: null,
      }),
    ];
    for (const mutant of fillAttempts) {
      const result = await store.writeRepair(
        repairSnapshot({
          stateHead: h5,
          sequence: 6,
          updatedAt: T0 + 6000,
          evidence: [mutant],
        }),
        h5,
      );
      assert.ok(!result.ok, `expected rejection for ${JSON.stringify(mutant)}`);
      if (!result.ok) assert.equal(result.error.kind, "invalid");
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: review receipts may complete from pending but completed stays immutable", async () => {
  const ctx = await makeCtx("review-lifecycle");
  try {
    const store = storeAt(ctx, "a", "repair");
    const pending = reviewReceipt("rv:1");
    const head1 = appliedHead(
      await store.writeRepair(repairSnapshot({ reviews: [pending] }), null),
    );

    // Identity tampering fails: requestId, expectedReviewer, submittedAt, PR.
    const identityAttempts: ReturnType<typeof reviewReceipt>[] = [
      reviewReceipt("rv:1", { requestId: "req-other" }),
      reviewReceipt("rv:1", { expectedReviewer: "other[bot]" }),
      reviewReceipt("rv:1", { submittedAt: T0 + 1500 }),
      reviewReceipt("rv:1", {
        pullRequest: { number: 13, head: SHA3, base: SHA2 },
      }),
    ];
    for (const mutant of identityAttempts) {
      const result = await store.writeRepair(
        repairSnapshot({
          stateHead: head1,
          sequence: 2,
          updatedAt: T0 + 2000,
          reviews: [mutant],
        }),
        head1,
      );
      assert.ok(!result.ok, `expected rejection for ${JSON.stringify(mutant)}`);
      if (!result.ok) assert.equal(result.error.kind, "invalid");
    }

    // observedAt cannot move backward on a pending receipt.
    const backward = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        reviews: [reviewReceipt("rv:1", { observedAt: T0 + 1500 })],
      }),
      head1,
    );
    assert.ok(!backward.ok);
    if (!backward.ok) assert.equal(backward.error.kind, "invalid");

    // A pending observation update (later observedAt) is legitimate.
    const observed = reviewReceipt("rv:1", { observedAt: T0 + 2500 });
    const observedResult = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        reviews: [observed],
      }),
      head1,
    );
    assert.ok(observedResult.ok);
    if (observedResult.ok) {
      assert.equal(observedResult.value.status, "applied");
    }
    const head2 = observedResult.ok &&
        observedResult.value.status === "applied"
      ? observedResult.value.head
      : null;
    assert.ok(head2);

    // pending -> completed records the observed reviewer, result and findings.
    const completed = structuredClone(observed) as ReturnType<
      typeof reviewReceipt
    >;
    completed.outcome = "completed";
    completed.observedReviewer = completed.expectedReviewer;
    completed.resultId = "review-result-1";
    completed.summary = "One P1; otherwise acceptable.";
    completed.findings = [{
      id: "f-1",
      severity: "P1",
      path: null,
      message: "terminator dropped",
      fingerprint: asFindingFingerprint("a".repeat(64)),
      resolved: false,
      resolutionEvidence: null,
    }];
    completed.unresolvedSeverities = ["P1"];
    completed.completedAt = T0 + 3000;
    completed.observedAt = T0 + 4000;
    const completedResult = await store.writeRepair(
      repairSnapshot({
        stateHead: head2,
        sequence: 3,
        updatedAt: T0 + 3000,
        reviews: [completed],
      }),
      head2,
    );
    assert.ok(completedResult.ok);
    if (completedResult.ok) {
      assert.equal(completedResult.value.status, "applied");
    }
    const head3 = completedResult.ok &&
        completedResult.value.status === "applied"
      ? completedResult.value.head
      : null;
    assert.ok(head3);

    // A completed receipt is exactly immutable, and identity tampering on it
    // is still rejected.
    const mutateCompleted = await store.writeRepair(
      repairSnapshot({
        stateHead: head3,
        sequence: 4,
        updatedAt: T0 + 4000,
        reviews: [{ ...completed, summary: "changed" }],
      }),
      head3,
    );
    assert.ok(!mutateCompleted.ok);
    if (!mutateCompleted.ok) {
      assert.equal(mutateCompleted.error.kind, "invalid");
    }
    const tamperCompleted = await store.writeRepair(
      repairSnapshot({
        stateHead: head3,
        sequence: 4,
        updatedAt: T0 + 4000,
        reviews: [{
          ...completed,
          pullRequest: { ...completed.pullRequest, head: SHA3 },
        }],
      }),
      head3,
    );
    assert.ok(!tamperCompleted.ok);
    if (!tamperCompleted.ok) {
      assert.equal(tamperCompleted.error.kind, "invalid");
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: ambiguous reservations reconcile to submitted; settlement never moves backward", async () => {
  const ctx = await makeCtx("reservation-reconcile");
  try {
    const store = storeAt(ctx, "a", "repair");
    const r = reservation("r:1", {
      outcome: "ambiguous",
      settledAt: T0 + 500,
      proofRef: null,
    });
    const head1 = appliedHead(
      await store.writeRepair(repairSnapshot({ reservations: [r] }), null),
    );

    // A settled reservation cannot revert to reserved.
    const revert = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        reservations: [{ ...r, outcome: "reserved", settledAt: null }],
      }),
      head1,
    );
    assert.ok(!revert.ok);
    if (!revert.ok) assert.equal(revert.error.kind, "invalid");

    // Settlement time may advance with the same ambiguous outcome.
    const advanced = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 2000,
        reservations: [{ ...r, settledAt: T0 + 900 }],
      }),
      head1,
    );
    assert.ok(advanced.ok);
    if (advanced.ok) assert.equal(advanced.value.status, "applied");
    const head2 = advanced.ok && advanced.value.status === "applied"
      ? advanced.value.head
      : null;
    assert.ok(head2);

    // Settlement time cannot move backward.
    const backward = await store.writeRepair(
      repairSnapshot({
        stateHead: head2,
        sequence: 3,
        updatedAt: T0 + 3000,
        reservations: [{ ...r, settledAt: T0 + 700 }],
      }),
      head2,
    );
    assert.ok(!backward.ok);
    if (!backward.ok) assert.equal(backward.error.kind, "invalid");

    // ambiguous -> submitted is valid reconciliation and stays charged.
    const submitted = await store.writeRepair(
      repairSnapshot({
        stateHead: head2,
        sequence: 3,
        updatedAt: T0 + 3000,
        reservations: [{
          ...r,
          outcome: "submitted",
          settledAt: T0 + 1000,
        }],
      }),
      head2,
    );
    assert.ok(submitted.ok);
    if (submitted.ok) assert.equal(submitted.value.status, "applied");
    const head3 = submitted.ok && submitted.value.status === "applied"
      ? submitted.value.head
      : null;
    assert.ok(head3);

    // submitted is immutable: neither a later settlement time nor a refund.
    const laterSettlement = await store.writeRepair(
      repairSnapshot({
        stateHead: head3,
        sequence: 4,
        updatedAt: T0 + 4000,
        reservations: [{
          ...r,
          outcome: "submitted",
          settledAt: T0 + 2000,
        }],
      }),
      head3,
    );
    assert.ok(!laterSettlement.ok);
    if (!laterSettlement.ok) {
      assert.equal(laterSettlement.error.kind, "invalid");
    }
    const refundFromSubmitted = await store.writeRepair(
      repairSnapshot({
        stateHead: head3,
        sequence: 4,
        updatedAt: T0 + 4000,
        reservations: [{
          ...r,
          outcome: "confirmed_not_submitted",
          settledAt: T0 + 2000,
          proofRef: "artifact://proof/r:1",
        }],
      }),
      head3,
    );
    assert.ok(!refundFromSubmitted.ok);
    if (!refundFromSubmitted.ok) {
      assert.equal(refundFromSubmitted.error.kind, "invalid");
    }

    // Equal repeated settlement stays idempotent.
    const idempotent = await store.writeRepair(
      repairSnapshot({
        stateHead: head3,
        sequence: 4,
        updatedAt: T0 + 4000,
        reservations: [{
          ...r,
          outcome: "submitted",
          settledAt: T0 + 1000,
        }],
      }),
      head3,
    );
    assert.ok(idempotent.ok);
    if (idempotent.ok) assert.equal(idempotent.value.status, "applied");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: release records persist same-phase monitoring and interrupted coverage", async () => {
  const ctx = await makeCtx("release-same-phase");
  try {
    const store = storeAt(ctx, "a", "release");
    const m1 = monitoredReleaseRecord("rel:1", "monitoring");
    const r2 = releaseRecord("rel:2");
    const head1 = appliedHead(
      await store.writeRelease(
        releaseSnapshot({ releases: [m1, r2] }),
        null,
      ),
    );

    // Same-phase persistence: another monitoring sample, and a requested
    // record persisting its saved promote intent.
    const m2 = {
      ...m1,
      updatedAt: T0 + 2000,
      monitoring: {
        startedAt: T0 + 3000,
        samples: 2,
        continuous: true,
        lastSampleAt: T0 + 63000,
      },
    };
    const t2 = {
      ...r2,
      updatedAt: T0 + 2000,
      intent: {
        action: "promote" as const,
        key: "promote/rel-2",
        persistedAt: T0 + 2000,
      },
    };
    const head2 = appliedHead(
      await store.writeRelease(
        releaseSnapshot({
          stateHead: head1,
          sequence: 2,
          updatedAt: T0 + 2000,
          releases: [m2, t2],
        }),
        head1,
      ),
    );

    // Interrupted monitoring resets coverage; requested -> promoting is a
    // forward transition.
    const m3 = {
      ...m2,
      updatedAt: T0 + 3000,
      monitoring: {
        startedAt: T0 + 3000,
        samples: 2,
        continuous: false,
        lastSampleAt: T0 + 63000,
      },
    };
    const t3 = { ...t2, phase: "promoting" as const, updatedAt: T0 + 3000 };
    const head3 = appliedHead(
      await store.writeRelease(
        releaseSnapshot({
          stateHead: head2,
          sequence: 3,
          updatedAt: T0 + 3000,
          releases: [m3, t3],
        }),
        head2,
      ),
    );

    // A monitoring restart after the interruption, and a same-phase promoting
    // persistence.
    const m4 = {
      ...m3,
      updatedAt: T0 + 4000,
      monitoring: {
        startedAt: T0 + 90000,
        samples: 1,
        continuous: true,
        lastSampleAt: T0 + 120000,
      },
    };
    const t4 = { ...t3, updatedAt: T0 + 4000 };
    const head4 = appliedHead(
      await store.writeRelease(
        releaseSnapshot({
          stateHead: head3,
          sequence: 4,
          updatedAt: T0 + 4000,
          releases: [m4, t4],
        }),
        head3,
      ),
    );

    // Per-record updatedAt cannot move backward.
    const backwardTime = await store.writeRelease(
      releaseSnapshot({
        stateHead: head4,
        sequence: 5,
        updatedAt: T0 + 5000,
        releases: [{ ...m4, updatedAt: T0 + 3500 }, t4],
      }),
      head4,
    );
    assert.ok(!backwardTime.ok);
    if (!backwardTime.ok) {
      assert.equal(backwardTime.error.kind, "invalid");
    }

    // Backward phase resets stay forbidden (monitoring -> requested).
    const resetPhase = await store.writeRelease(
      releaseSnapshot({
        stateHead: head4,
        sequence: 5,
        updatedAt: T0 + 5000,
        releases: [
          releaseRecord("rel:1", { updatedAt: T0 + 5000 }),
          t4,
        ],
      }),
      head4,
    );
    assert.ok(!resetPhase.ok);
    if (!resetPhase.ok) assert.equal(resetPhase.error.kind, "invalid");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: transport throws become sanitized typed failures; pushes reconcile", async () => {
  const ctx = await makeCtx("transport-throws");
  try {
    const real = new DenoGitRunner(`${ctx.tmp}/git-home`);

    // Throws before any read or write: sanitized typed unavailable, and the
    // synthetic exception text must never leak into the result.
    const blind = storeAt(
      ctx,
      "a",
      "repair",
      new ThrowingRunner(real, () => true),
    );
    const read = await blind.readRepair();
    assert.ok(!read.ok);
    if (!read.ok) {
      assert.equal(read.error.kind, "unavailable");
      assert.ok(!read.error.detail.includes("synthetic"));
    }
    const write = await blind.writeRepair(
      repairSnapshot({ work: [workRecord("w:1")] }),
      null,
    );
    assert.ok(!write.ok);
    if (!write.ok) assert.equal(write.error.kind, "unavailable");

    // The push executes, then its response is thrown away: the authoritative
    // ref still proves the unique candidate was applied.
    const afterPush = new ThrowAfterRunner(real, (args) => args[0] === "push");
    const pushed = storeAt(ctx, "b", "repair", afterPush);
    const applied = await pushed.writeRepair(
      repairSnapshot({ work: [workRecord("w:p")] }),
      null,
    );
    assert.ok(applied.ok);
    if (applied.ok) assert.equal(applied.value.status, "applied");
    assert.equal(afterPush.throwCount, 1);
    const backRead = await storeAt(ctx, "c", "repair").readRepair();
    assert.ok(backRead.ok && backRead.value.status === "found");
    if (backRead.ok && backRead.value.status === "found") {
      assert.equal(backRead.value.snapshot.work[0]?.id, "w:p");
    }

    // The verification read throws after an attempted push: ambiguous, never
    // a false "not applied" error.
    const priorHead = backRead.ok && backRead.value.status === "found"
      ? backRead.value.head
      : null;
    assert.ok(priorHead);
    let lsRemoteCalls = 0;
    const afterVerify = new ThrowAfterRunner(real, (args) => {
      if (args[0] !== "ls-remote") return false;
      lsRemoteCalls++;
      return lsRemoteCalls === 2;
    });
    const verified = storeAt(ctx, "d", "repair", afterVerify);
    const ambiguous = await verified.writeRepair(
      repairSnapshot({
        stateHead: priorHead,
        sequence: 2,
        updatedAt: T0 + 2000,
        work: [workRecord("w:p"), workRecord("w:v")],
      }),
      priorHead,
    );
    assert.ok(ambiguous.ok);
    if (ambiguous.ok) assert.equal(ambiguous.value.status, "ambiguous");
    assert.equal(afterVerify.throwCount, 1);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: strict ls-remote: malformed, nonmatching and duplicate responses are invalid", async () => {
  const ctx = await makeCtx("lsremote-strict");
  try {
    const real = new DenoGitRunner(`${ctx.tmp}/git-home`);
    const ref = REPAIR_STATE_REF;
    const canned = (stdout: string) =>
      storeAt(
        ctx,
        "x",
        "repair",
        new FakeLsRemoteRunner(real, { ok: true, stdout }),
      );

    // Zero output lines with a successful ls-remote: the ref truly is absent.
    const absent = await canned("").readRepair();
    assert.ok(absent.ok && absent.value.status === "absent");

    const cases: { name: string; stdout: string }[] = [
      { name: "malformed line", stdout: "not-a-valid-ls-remote-line\n" },
      {
        name: "malformed commit id",
        stdout: `${"z".repeat(40)}\t${ref}\n`,
      },
      {
        name: "nonmatching ref",
        stdout:
          `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/sentinel-state/other\n`,
      },
      {
        name: "duplicate matching records",
        stdout: `${SHA3}\t${ref}\n${"b".repeat(40)}\t${ref}\n`,
      },
    ];
    for (const item of cases) {
      const result = await canned(item.stdout).readRepair();
      assert.ok(!result.ok, `${item.name} must not look empty`);
      if (!result.ok) assert.equal(result.error.kind, "invalid");
    }
    // A failed lookup is typed unavailable, never empty.
    const failed = storeAt(
      ctx,
      "y",
      "repair",
      new FakeLsRemoteRunner(real, { ok: false, stdout: "" }),
    );
    const failedRead = await failed.readRepair();
    assert.ok(!failedRead.ok);
    if (!failedRead.ok) assert.equal(failedRead.error.kind, "unavailable");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: raw state trees require canonical bytes and regular blob modes", async () => {
  const ctx = await makeCtx("raw-tree-strict");
  try {
    const store = storeAt(ctx, "a", "repair");
    const record = workRecord("w:1");
    const recordPath = `work/${await sha256Hex("w:1")}.json`;
    const recordText = `${canonicalStringify(record)}\n`;
    const manifest = rawManifestText(1, T0 + 1000, null);
    const canonicalTree = [
      { path: "manifest.json", text: manifest },
      { path: recordPath, text: recordText },
    ];

    // Exactly the store's canonical bytes, pushed as a raw tree: valid.
    await pushRawStateTree(ctx, null, REPAIR_STATE_REF, canonicalTree);
    const okRead = await store.readRepair();
    assert.ok(okRead.ok && okRead.value.status === "found");
    if (okRead.ok && okRead.value.status === "found") {
      assert.equal(okRead.value.snapshot.work[0]?.id, "w:1");
    }
    let head = await remoteHead(ctx, REPAIR_STATE_REF);
    const headManifest = rawManifestText(2, T0 + 2000, head);

    const invalidTrees: {
      name: string;
      files: {
        path: string;
        text: string;
        mode?: "100644" | "100755" | "120000";
      }[];
    }[] = [
      {
        name: "executable manifest",
        files: [
          { path: "manifest.json", text: headManifest, mode: "100755" },
          { path: recordPath, text: recordText },
        ],
      },
      {
        name: "symlink record file",
        files: [
          { path: "manifest.json", text: headManifest },
          { path: recordPath, text: "../../etc/passwd", mode: "120000" },
        ],
      },
      {
        name: "non-canonical record bytes",
        files: [
          { path: "manifest.json", text: headManifest },
          { path: recordPath, text: recordText.replace(/\n$/, "") },
        ],
      },
      {
        name: "manifest with duplicate JSON key",
        files: [
          {
            path: "manifest.json",
            text: headManifest.replace(
              '"version":"v1"',
              '"version":"v1","version":"v1"',
            ),
          },
          { path: recordPath, text: recordText },
        ],
      },
      {
        name: "record with duplicate JSON key",
        files: [
          { path: "manifest.json", text: headManifest },
          {
            path: recordPath,
            text: recordText.replace(
              '"version":"v1"',
              '"version":"v1","version":"v1"',
            ),
          },
        ],
      },
    ];
    for (const item of invalidTrees) {
      await pushRawStateTree(ctx, head, REPAIR_STATE_REF, item.files);
      head = await remoteHead(ctx, REPAIR_STATE_REF);
      const result = await store.readRepair();
      assert.ok(!result.ok, `${item.name} must be rejected`);
      if (!result.ok) assert.equal(result.error.kind, "invalid");
      // Restore a canonical tree on top for the next case.
      await pushRawStateTree(ctx, head, REPAIR_STATE_REF, [{
        path: "manifest.json",
        text: rawManifestText(2, T0 + 2000, head),
      }, {
        path: recordPath,
        text: recordText,
      }]);
      head = await remoteHead(ctx, REPAIR_STATE_REF);
      const restored = await store.readRepair();
      assert.ok(restored.ok);
    }
  } finally {
    await ctx.cleanup();
  }
});

/**
 * An evidence record with a duplicate artifact ref can no longer be produced
 * by the frozen parser (the guard lives in parseIncidentEvidenceV1 now), so
 * this raw object is assembled by hand for the store-level rejection cases;
 * it is canonical JSON with exactly one semantic defect.
 */
function duplicateRefEvidenceText(id: string): string {
  const valid = incidentEvidence(id);
  return `${
    canonicalStringify({
      ...valid,
      artifacts: [
        valid.artifacts[0],
        {
          ...valid.artifacts[0],
          digest: "f".repeat(64),
          sizeBytes: valid.artifacts[0].sizeBytes + 1,
        },
      ],
    })
  }\n`;
}

Deno.test("state: duplicate artifact refs are rejected on the initial snapshot write", async () => {
  const ctx = await makeCtx("dup-artifact-initial");
  try {
    const store = storeAt(ctx, "a", "repair");
    // The guard must run on branch creation too, not only on transitions.
    const rawEvidence = JSON.parse(duplicateRefEvidenceText("ev:duplicate"));
    const result = await store.writeRepair(
      repairSnapshot({ evidence: [rawEvidence] }),
      null,
    );
    assert.ok(!result.ok);
    if (!result.ok) assert.equal(result.error.kind, "invalid");
    // Nothing was applied: the ref stays absent.
    const read = await store.readRepair();
    assert.ok(read.ok);
    if (read.ok) assert.equal(read.value.status, "absent");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: canonical raw remote records with duplicate artifact refs are rejected on read", async () => {
  const ctx = await makeCtx("dup-artifact-raw");
  try {
    const store = storeAt(ctx, "a", "repair");
    // Establish a valid first commit so the raw tree has a real parent.
    const head1 = appliedHead(
      await store.writeRepair(
        repairSnapshot({ evidence: [incidentEvidence("ev:1")] }),
        null,
      ),
    );

    // Push canonical bytes (exactly one semantic defect: a duplicate ref) as a
    // raw remote tree the store must validate; the read must fail closed,
    // never return the record. pushRawTree fetches the parent into the raw
    // work repo before building the child commit.
    const duplicateId = "ev:duplicate";
    await pushRawTree(ctx, head1, REPAIR_STATE_REF, {
      "manifest.json": rawManifestText(2, T0 + 2000, head1),
      [`evidence/${await sha256Hex(duplicateId)}.json`]:
        duplicateRefEvidenceText(
          duplicateId,
        ),
    }, ctx.env);
    const read = await store.readRepair();
    assert.ok(!read.ok);
    if (!read.ok) assert.equal(read.error.kind, "invalid");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: github cooldowns roundtrip per installation and survive unrelated writes", async () => {
  const ctx = await makeCtx("cooldown-roundtrip");
  try {
    const store = storeAt(ctx, "a", "repair");
    // Two affected installations: one explicit manual fail-closed hold (null
    // deadline) and one bounded fallback deadline carrying the fallback index.
    const manual = githubCooldown(7);
    const fallback = githubCooldown(42, {
      retryNotBefore: T0 + 120_000,
      observationId: "b".repeat(64),
      secondaryBackoff: 2,
    });
    const head1 = appliedHead(
      await store.writeRepair(
        repairSnapshot({ githubCooldowns: [manual, fallback] }),
        null,
      ),
    );

    // Durable storage mapping: exactly one sha256(String(installationId))
    // json file per affected installation in the githubCooldowns collection.
    const tree = await gitRunAt(
      ctx,
      [
        "--git-dir",
        ctx.bare,
        "ls-tree",
        "-r",
        "--name-only",
        REPAIR_STATE_REF,
      ],
    );
    assert.ok(tree.ok);
    const paths = tree.stdout.split("\n").filter((line) => line.length > 0);
    assert.ok(paths.includes(`githubCooldowns/${await sha256Hex("7")}.json`));
    assert.ok(paths.includes(`githubCooldowns/${await sha256Hex("42")}.json`));

    // A fresh store reads the exact collection back, deterministic order by
    // installation id string ("42" before "7").
    const read = await storeAt(ctx, "b", "repair").readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      assert.deepEqual(read.value.snapshot.githubCooldowns, [fallback, manual]);
      assert.equal(
        read.value.snapshot.githubCooldowns[0].installationId,
        42,
      );
      assert.equal(read.value.snapshot.githubCooldowns[0].secondaryBackoff, 2);
      assert.equal(
        read.value.snapshot.githubCooldowns[1].retryNotBefore,
        null,
      );
    } else {
      assert.fail("expected a found snapshot");
    }

    // An unrelated repair write (a new work record) preserves both cooldowns.
    const head2 = appliedHead(
      await store.writeRepair(
        repairSnapshot({
          stateHead: head1,
          sequence: 2,
          updatedAt: T0 + 2000,
          work: [workRecord("w:1")],
          githubCooldowns: [manual, fallback],
        }),
        head1,
      ),
    );
    const read2 = await storeAt(ctx, "c", "repair").readRepair();
    assert.ok(read2.ok && read2.value.status === "found");
    if (read2.ok && read2.value.status === "found") {
      assert.equal(read2.value.snapshot.work[0]?.id, "w:1");
      assert.deepEqual(read2.value.snapshot.githubCooldowns, [
        fallback,
        manual,
      ]);
    } else {
      assert.fail("expected a found snapshot");
    }

    // A new observation may refresh the same installation's record (later
    // deadline, later observation, new backoff); the manual hold stays null.
    const refreshed = githubCooldown(42, {
      retryNotBefore: T0 + 240_000,
      observedAt: T0 + 5000,
      observationId: "c".repeat(64),
      secondaryBackoff: 3,
    });
    const head3 = appliedHead(
      await store.writeRepair(
        repairSnapshot({
          stateHead: head2,
          sequence: 3,
          updatedAt: T0 + 3000,
          work: [workRecord("w:1")],
          githubCooldowns: [manual, refreshed],
        }),
        head2,
      ),
    );

    // Silently dropping a cooldown is invalid: the gate must never lose an
    // affected installation's hold.
    const dropped = await store.writeRepair(
      repairSnapshot({
        stateHead: head3,
        sequence: 4,
        updatedAt: T0 + 4000,
        work: [workRecord("w:1")],
        githubCooldowns: [manual],
      }),
      head3,
    );
    assert.ok(!dropped.ok);
    if (!dropped.ok) assert.equal(dropped.error.kind, "invalid");

    // A manual fail-closed hold can never become a retry deadline.
    const converted = await store.writeRepair(
      repairSnapshot({
        stateHead: head3,
        sequence: 4,
        updatedAt: T0 + 4000,
        work: [workRecord("w:1")],
        githubCooldowns: [
          githubCooldown(7, { retryNotBefore: T0 + 60_000 }),
          refreshed,
        ],
      }),
      head3,
    );
    assert.ok(!converted.ok);
    if (!converted.ok) assert.equal(converted.error.kind, "invalid");

    // observedAt cannot move backward on an existing cooldown.
    const backward = await store.writeRepair(
      repairSnapshot({
        stateHead: head3,
        sequence: 4,
        updatedAt: T0 + 4000,
        work: [workRecord("w:1")],
        githubCooldowns: [
          manual,
          githubCooldown(42, {
            retryNotBefore: T0 + 120_000,
            observedAt: T0 + 1000,
            observationId: "b".repeat(64),
            secondaryBackoff: 2,
          }),
        ],
      }),
      head3,
    );
    assert.ok(!backward.ok);
    if (!backward.ok) assert.equal(backward.error.kind, "invalid");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: malformed github cooldown records fail closed on read", async () => {
  const ctx = await makeCtx("cooldown-tamper");
  try {
    const store = storeAt(ctx, "a", "repair");
    const cooldown = githubCooldown(7);
    const head1 = appliedHead(
      await store.writeRepair(
        repairSnapshot({ githubCooldowns: [cooldown] }),
        null,
      ),
    );
    const file7 = `${await sha256Hex("7")}.json`;

    // A non-digest file name in the cooldown collection is rejected.
    await pushRawTree(ctx, head1, REPAIR_STATE_REF, {
      "manifest.json": rawManifestText(2, T0 + 2000, head1),
      "githubCooldowns/not-a-digest.json": `${canonicalStringify(cooldown)}\n`,
    }, ctx.env);
    let read = await store.readRepair();
    assert.ok(!read.ok);
    if (!read.ok) assert.equal(read.error.kind, "invalid");
    let head = await remoteHead(ctx, REPAIR_STATE_REF);

    // The file name must hash to String(installationId): a record under the
    // sha256 of a different installation is misplaced state.
    await pushRawTree(ctx, head, REPAIR_STATE_REF, {
      "manifest.json": rawManifestText(2, T0 + 2000, head),
      [`githubCooldowns/${await sha256Hex("8")}.json`]: `${
        canonicalStringify(cooldown)
      }\n`,
    }, ctx.env);
    read = await store.readRepair();
    assert.ok(!read.ok);
    if (!read.ok) assert.equal(read.error.kind, "invalid");
    head = await remoteHead(ctx, REPAIR_STATE_REF);

    // Reordered keys are not the canonical bytes and are rejected.
    await pushRawTree(ctx, head, REPAIR_STATE_REF, {
      "manifest.json": rawManifestText(2, T0 + 2000, head),
      [`githubCooldowns/${file7}`]: `${
        JSON.stringify({
          installationId: 7,
          retryNotBefore: null,
          observedAt: T0,
          observationId: "a".repeat(64),
          secondaryBackoff: 0,
        })
      }\n`,
    }, ctx.env);
    read = await store.readRepair();
    assert.ok(!read.ok);
    if (!read.ok) assert.equal(read.error.kind, "invalid");
    head = await remoteHead(ctx, REPAIR_STATE_REF);

    // A record failing the frozen parser (invalid installation id) is
    // rejected instead of being admitted with a fabricated storage identity.
    await pushRawTree(ctx, head, REPAIR_STATE_REF, {
      "manifest.json": rawManifestText(2, T0 + 2000, head),
      [`githubCooldowns/${file7}`]: `${
        canonicalStringify({
          installationId: 0,
          retryNotBefore: null,
          observedAt: T0,
          observationId: "a".repeat(64),
          secondaryBackoff: 0,
        })
      }\n`,
    }, ctx.env);
    read = await store.readRepair();
    assert.ok(!read.ok);
    if (!read.ok) assert.equal(read.error.kind, "invalid");
  } finally {
    await ctx.cleanup();
  }
});
