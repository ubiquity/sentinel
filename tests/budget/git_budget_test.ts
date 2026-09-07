// Budget controller tests against the real GitStateStore and disposable local
// bare remotes: one global cap across repositories with a restarted store,
// simultaneous identical and distinct admissions at cap (exactly one winner),
// a successful push with a lost response reconciling to a single durable
// reservation, read/transport failures never admitting, and unrelated state
// preservation plus idempotent settlement. No production state branch,
// no network and no model calls exist in this suite.
import assert from "node:assert/strict";

import { HOUR_WINDOW_MS, RollingStartBudget } from "../../src/budget/mod.ts";
import { createRepairStateStore, DenoGitRunner } from "../../src/state/mod.ts";
import type { GitRunnerV1 } from "../../src/state/mod.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  BarrierRunner,
  incidentSummary,
  LostPushResponseRunner,
  makeRemoteCtx,
  REPO,
  T0,
  testGitEnv,
  ThrowingRunner,
  workRecord,
} from "../state/helpers.ts";
import {
  FakeClock,
  REPO_2,
  repositoryConfig,
  reserveRequest,
} from "./helpers.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/budget\/git_budget_test\.ts$/,
  "",
);

interface Ctx {
  tmp: string;
  env: Record<string, string>;
  remoteUrl: string;
  cleanup(): Promise<void>;
}

async function makeCtx(prefix: string): Promise<Ctx> {
  const tmp = await Deno.makeTempDir({
    prefix: `sentinel-budget-test-${prefix}-`,
    dir: ROOT,
  });
  const env = testGitEnv(`${tmp}/git-home`);
  await Deno.mkdir(`${tmp}/git-home`, { recursive: true });
  const remote = await makeRemoteCtx(tmp, env);
  return {
    tmp,
    env,
    remoteUrl: remote.remoteUrl,
    cleanup: async () => {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    },
  };
}

function storeAt(
  ctx: Ctx,
  name: string,
  runner?: GitRunnerV1,
): ReturnType<typeof createRepairStateStore> {
  return createRepairStateStore({
    scratchDir: `${ctx.tmp}/scratch-${name}`,
    remoteUrl: ctx.remoteUrl,
    runner,
  });
}

const CAPS = { perHour: 1, perSevenDays: 3 } as const;
const configs = () => [
  repositoryConfig(REPO, CAPS),
  repositoryConfig(REPO_2, CAPS),
];

function budgetAt(
  clock: FakeClock,
  state: ReturnType<typeof createRepairStateStore>,
  configSet: ReturnType<typeof configs> = configs(),
): RollingStartBudget {
  return new RollingStartBudget({ clock, state, configs: configSet });
}

Deno.test("budget: one global cap across repositories survives a restart", async () => {
  const ctx = await makeCtx("cross-repo");
  try {
    const clock = new FakeClock(T0);
    const first = budgetAt(clock, storeAt(ctx, "a"));
    const admitted = await first.reserveModelStart(
      reserveRequest("task:a", { repository: REPO }),
    );
    assert.equal(admitted.status, "admitted", JSON.stringify(admitted));
    assert.equal(admitted.status === "admitted", true);
    const admittedHead = admitted.status === "admitted"
      ? admitted.stateHead
      : null;
    assert.ok(admittedHead);

    // A restarted store (fresh scratch) in another repository shares the cap.
    const restarted = budgetAt(clock, storeAt(ctx, "b"));
    const deferred = await restarted.reserveModelStart(
      reserveRequest("task:b", { repository: REPO_2 }),
    );
    assert.equal(deferred.status, "deferred", JSON.stringify(deferred));
    if (deferred.status === "deferred") {
      assert.equal(deferred.reason, "cap_limit");
      assert.equal(deferred.retryAt, T0 + HOUR_WINDOW_MS);
    }

    // After one hour the window has no charges left: admission proceeds and
    // the durable record carries the second repository.
    clock.advance(HOUR_WINDOW_MS + 1);
    const admitted2 = await restarted.reserveModelStart(
      reserveRequest("task:b2", { repository: REPO_2 }),
    );
    assert.equal(admitted2.status, "admitted", JSON.stringify(admitted2));

    const read = await storeAt(ctx, "c").readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      const repos = read.value.snapshot.reservations.map((r) =>
        `${r.repository.owner}/${r.repository.name}`
      ).sort();
      assert.deepEqual(
        repos,
        [
          "ubiquity/ai.ubq.fi",
          "ubiquity/sentinel",
        ].sort(),
      );
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("budget: simultaneous identical admissions grant exactly one start", async () => {
  const ctx = await makeCtx("cas-identical");
  try {
    const clock = new FakeClock(T0);
    const runner = new BarrierRunner(new DenoGitRunner(`${ctx.tmp}/git-home`));
    const a = budgetAt(clock, storeAt(ctx, "a", runner));
    const b = budgetAt(clock, storeAt(ctx, "b", runner));
    const request = reserveRequest("task:same");
    const [ra, rb] = await Promise.all([
      a.reserveModelStart(request),
      b.reserveModelStart(request),
    ]);
    const statuses = [ra.status, rb.status].sort();
    assert.deepEqual(statuses, ["admitted", "conflict"]);
    const winner = ra.status === "admitted" ? ra : rb;
    const loser = ra.status === "conflict" ? ra : rb;
    assert.ok(winner.status === "admitted" && loser.status === "conflict");
    if (winner.status === "admitted" && loser.status === "conflict") {
      assert.equal(loser.currentHead, winner.stateHead);
    }

    // The losing caller's reconciling retry must yield duplicate, not a start.
    const retry = await budgetAt(clock, storeAt(ctx, "c"))
      .reserveModelStart(request);
    assert.equal(retry.status, "duplicate");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("budget: simultaneous distinct admissions at cap grant exactly one start", async () => {
  const ctx = await makeCtx("cas-distinct");
  try {
    const clock = new FakeClock(T0);
    const runner = new BarrierRunner(new DenoGitRunner(`${ctx.tmp}/git-home`));
    const a = budgetAt(clock, storeAt(ctx, "a", runner));
    const b = budgetAt(clock, storeAt(ctx, "b", runner));
    const [ra, rb] = await Promise.all([
      a.reserveModelStart(reserveRequest("task:x1")),
      b.reserveModelStart(reserveRequest("task:x2")),
    ]);
    const statuses = [ra.status, rb.status].sort();
    assert.deepEqual(statuses, ["admitted", "conflict"]);
    // The ref holds exactly one reservation.
    const read = await storeAt(ctx, "c").readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      assert.equal(read.value.snapshot.reservations.length, 1);
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("budget: successful push with lost response yields one durable reservation", async () => {
  const ctx = await makeCtx("lost-response");
  try {
    const clock = new FakeClock(T0);
    const runner = new LostPushResponseRunner(
      new DenoGitRunner(`${ctx.tmp}/git-home`),
    );
    const controller = budgetAt(clock, storeAt(ctx, "a", runner));
    const request = reserveRequest("task:lost");
    const admitted = await controller.reserveModelStart(request);
    assert.equal(admitted.status, "admitted", JSON.stringify(admitted));
    assert.equal(runner.pushAttempts, 1, "never a blind second push");

    // Repeating the identical request reconciles: duplicate, no second start.
    const again = await controller.reserveModelStart(request);
    assert.equal(again.status, "duplicate");
    const read = await storeAt(ctx, "b").readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      assert.equal(read.value.snapshot.reservations.length, 1);
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("budget: throwing transport never admits and nothing is applied", async () => {
  const ctx = await makeCtx("throwing");
  try {
    const clock = new FakeClock(T0);
    const failing = budgetAt(
      clock,
      storeAt(
        ctx,
        "a",
        new ThrowingRunner(
          new DenoGitRunner(`${ctx.tmp}/git-home`),
          () => true,
        ),
      ),
    );
    const request = reserveRequest("task:throw");
    const result = await failing.reserveModelStart(request);
    assert.equal(result.status, "unavailable", JSON.stringify(result));

    // Authoritative state was never created; a healthy path can still apply.
    const absent = await storeAt(ctx, "b").readRepair();
    assert.ok(absent.ok && absent.value.status === "absent");
    const healthy = budgetAt(clock, storeAt(ctx, "c"));
    const admitted = await healthy.reserveModelStart(request);
    assert.equal(admitted.status, "admitted");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("budget: invalid identity inputs are invalid at the real state boundary and write nothing", async () => {
  const ctx = await makeCtx("invalid-boundary");
  try {
    const clock = new FakeClock(T0);
    const controller = budgetAt(clock, storeAt(ctx, "a"));
    const badHead = await controller.reserveModelStart(
      reserveRequest("task:inv1", { head: "nope" as never }),
    );
    assert.equal(badHead.status, "invalid");
    const zeroAttempt = await controller.reserveModelStart(
      reserveRequest("task:inv2", { attempt: 0 }),
    );
    assert.equal(zeroAttempt.status, "invalid");
    const badRepo = await controller.reserveModelStart({
      ...reserveRequest("task:inv3"),
      repository: {
        owner: "bad owner!",
        name: "x",
        installationId: 1,
      } as never,
    });
    assert.equal(badRepo.status, "invalid");
    const badPurpose = await controller.reserveModelStart(
      reserveRequest("task:inv4", { purpose: "boss" as never }),
    );
    assert.equal(badPurpose.status, "invalid");

    // None of the rejected requests ever created or wrote the state branch.
    const absent = await storeAt(ctx, "b").readRepair();
    assert.ok(absent.ok && absent.value.status === "absent");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("budget: unrelated state collections survive; settlement is idempotent in real git", async () => {
  const ctx = await makeCtx("preserve");
  try {
    const store = storeAt(ctx, "a");
    const seed: RepairStateSnapshotV1 = {
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0,
      incidents: [incidentSummary("inc:1")],
      evidence: [],
      work: [workRecord("w:1")],
      reservations: [],
      reviews: [],
      replays: [],
      releaseRequests: [],
    };
    const seeded = await store.writeRepair(seed, null);
    assert.ok(seeded.ok && seeded.value.status === "applied");

    const clock = new FakeClock(T0 + 1_000);
    const controller = budgetAt(clock, store);
    const admitted = await controller.reserveModelStart(
      reserveRequest("task:preserve"),
    );
    assert.equal(admitted.status, "admitted", JSON.stringify(admitted));
    assert.ok(admitted.status === "admitted");
    if (admitted.status !== "admitted") throw new Error("unreachable");
    const id = admitted.reservation.id;

    const settled = await controller.settleModelStart({
      id,
      outcome: "submitted",
      proofRef: null,
    });
    assert.equal(settled.status, "settled", JSON.stringify(settled));
    const settledHead = settled.status === "settled" ? settled.stateHead : null;
    assert.ok(settledHead);

    // Equal repeated settlement: idempotent, no new commit, timestamp intact.
    const idempotent = await controller.settleModelStart({
      id,
      outcome: "submitted",
      proofRef: null,
    });
    assert.equal(idempotent.status, "idempotent");
    if (idempotent.status === "idempotent") {
      assert.equal(idempotent.stateHead, settledHead);
      assert.equal(idempotent.reservation.settledAt, T0 + 1_000);
      assert.equal(idempotent.reservation.createdAt, T0 + 1_000);
    }

    const read = await storeAt(ctx, "b").readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      assert.deepEqual(
        read.value.snapshot.work.map((w) => w.id),
        ["w:1"],
      );
      assert.deepEqual(
        read.value.snapshot.incidents.map((i) => i.id),
        ["inc:1"],
      );
      assert.equal(read.value.snapshot.reservations.length, 1);
      assert.equal(read.value.snapshot.reservations[0]?.outcome, "submitted");
      assert.equal(read.value.snapshot.reservations[0]?.settledAt, T0 + 1_000);
    }
  } finally {
    await ctx.cleanup();
  }
});
