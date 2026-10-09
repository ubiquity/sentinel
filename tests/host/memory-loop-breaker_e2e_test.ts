// Named end-to-end scenario for the durable memory loop breaker.
//
// The changed lifecycle is exercised through the REAL production consumers on
// a disposable Git repair-state store: RollingStartBudget admission, the
// serial implementation start, the trusted failed-start settlement (which must
// persist the attempt-memory entry in the same state commit as the blocker),
// and the hosted retry planner that must refuse an equivalent replay and
// report it. External services (GitHub, incidents, replay, model) are fakes;
// there is no network, model, credential or paid call.
//
// Scenario:
//   1. Four real admission/settlement rounds record four equivalent transient
//      failures at one base and runtime revision.
//   2. A FRESH store instance (simulated next process) re-reads the durable
//      state and finds the four recorded outcomes.
//   3. The hosted retry pass refuses the fifth unchanged attempt and reports
//      the denial; nothing is charged and the state head is unchanged.
//   4. Fairness: an unrelated blocked record with NO matching memory is still
//      granted its retry in the same pass — a refused item never starves the
//      rest of the queue.
import assert from "node:assert/strict";

import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import {
  createRunBounds,
  loadRepairContext,
  prepareImplementationStart,
  settleFailedImplementation,
} from "../../src/repair/loop.ts";
import type { RepairCycleDepsV1 } from "../../src/repair/loop.ts";
import { ATTEMPT_DETAIL_NO_TRUSTED_RECEIPT } from "../../src/repair/attempt-policy.ts";
import {
  applyHostedRetries,
  hostedRepositoryKey,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  repairConfigs,
} from "../repair/helpers.ts";
import {
  makeRemoteCtx,
  REPO,
  SHA1,
  SHA2,
  SHA3,
  T0,
  testGitEnv,
  workRecord,
} from "../state/helpers.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/host\/memory-loop-breaker_e2e_test\.ts$/,
  "",
);

const BASE = SHA2;
const DEADLINE = T0 + 60 * 60_000;

function taskRecord(
  id: string,
  issueNumber: number,
  overrides: Record<string, unknown> = {},
) {
  return workRecord(id, {
    source: { kind: "issue", id: String(issueNumber), revision: SHA1 },
    related: { incidentId: null, issueNumber },
    target: {
      base: BASE,
      branch: `sentinel/repair/${id}`,
      checkpoint: null,
      head: null,
      pr: null,
    },
    nextStep: "work",
    counters: { attempts: 0, retries: 0, reviewRounds: 0 },
    firstSeenAt: T0 - 60_000,
    ...overrides,
  });
}

Deno.test(
  "memory loop breaker e2e: four settled failures refuse the unchanged replay across processes and never starve unrelated work",
  async () => {
    const tmp = await Deno.makeTempDir({
      prefix: "sentinel-memory-e2e-",
      dir: ROOT,
    });
    const env = testGitEnv(`${tmp}/git-home`);
    await Deno.mkdir(`${tmp}/git-home`, { recursive: true });
    const remote = await makeRemoteCtx(tmp, env);
    const clock = new FakeClock(T0);
    const configs = repairConfigs({
      liveStartLimits: { perHour: null, perSevenDays: null },
      sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
    });
    const storeA = createRepairStateStore({
      scratchDir: `${tmp}/scratch-a`,
      remoteUrl: remote.remoteUrl,
    });
    const budgetA = new RollingStartBudget({
      clock,
      state: storeA,
      configs,
    });
    const depsA: RepairCycleDepsV1 = {
      clock,
      state: storeA,
      configs,
      controllerSha: SHA1,
      github: new FakeGithub({ baseSha: BASE }),
      githubCooldown: new DurableGitHubCooldownGate({
        state: storeA,
        clock,
      }),
      incidents: new FakeIncidents({ summaries: [], evidence: null }),
      replay: new FakeReplay(),
      model: new FakeModel(),
      budget: budgetA,
    };
    try {
      const taskId = "issue-memory-e2e-754";
      const seed = parseRepairStateSnapshotV1({
        version: "v1",
        kind: "repair_state_snapshot",
        stateHead: null,
        sequence: 1,
        updatedAt: T0,
        incidents: [],
        evidence: [],
        work: [taskRecord(taskId, 754)],
        reservations: [],
        reviews: [],
        replays: [],
        releaseRequests: [],
        githubCooldowns: [],
        attemptMemory: [],
      });
      const seeded = await storeA.writeRepair(seed, null);
      assert.ok(seeded.ok && seeded.value.status === "applied");

      const bounds = createRunBounds(depsA, {
        deadline: DEADLINE,
        modelStartsEnabled: true,
      });

      // Four real admission/settlement rounds at the same base and runtime
      // revision: each start is charged, then fails without a trusted receipt.
      for (let round = 0; round < 4; round++) {
        const context = await loadRepairContext(depsA, bounds);
        assert.ok(context !== null, `round ${round}: context`);
        const record = context.snapshot.work.find((row) => row.id === taskId);
        assert.ok(record, `round ${round}: record`);
        const prepared = await prepareImplementationStart(
          depsA,
          context,
          record,
          configs[0],
        );
        assert.equal(
          prepared.kind,
          "prepared",
          `round ${round}: ${JSON.stringify(prepared)}`,
        );
        if (prepared.kind !== "prepared") throw new Error("unreachable");
        const afterStart = await loadRepairContext(depsA, bounds);
        assert.ok(afterStart !== null, `round ${round}: post-start context`);
        const settled = await settleFailedImplementation(
          depsA,
          afterStart,
          prepared.record,
          prepared.reservationId,
          ATTEMPT_DETAIL_NO_TRUSTED_RECEIPT,
        );
        assert.equal(
          settled.kind,
          "progress",
          `round ${round}: ${JSON.stringify(settled)}`,
        );
        if (round < 3) {
          // The tolerated transient allowance re-opens the next admission
          // through the real hosted retry pass.
          const blocked = await storeA.readRepair();
          assert.ok(blocked.ok && blocked.value.status === "found");
          const plans = planHostedRetries(
            blocked.value.snapshot,
            clock.now(),
          );
          assert.equal(plans.length, 1, `round ${round}: expected a grant`);
          const reopened = applyHostedRetries(
            blocked.value.snapshot,
            blocked.value.head,
            plans,
            clock.now(),
          );
          const written = await storeA.writeRepair(
            reopened,
            blocked.value.head,
          );
          assert.ok(written.ok && written.value.status === "applied");
        }
      }

      // A FRESH store instance stands in for the next process: it re-reads the
      // durable state and must see all four recorded outcomes.
      const storeB = createRepairStateStore({
        scratchDir: `${tmp}/scratch-b`,
        remoteUrl: remote.remoteUrl,
      });
      const fresh = await storeB.readRepair();
      assert.ok(fresh.ok && fresh.value.status === "found");
      const active = fresh.value.snapshot.work.find((row) => row.id === taskId);
      assert.ok(active);
      assert.equal(active.nextStep, "blocked");
      assert.equal(
        active.blocker?.message,
        ATTEMPT_DETAIL_NO_TRUSTED_RECEIPT,
      );
      assert.equal(fresh.value.snapshot.attemptMemory.length, 1);
      const memory = fresh.value.snapshot.attemptMemory[0];
      assert.equal(memory.entries.length, 1);
      assert.equal(memory.entries[0].count, 4);
      assert.equal(memory.entries[0].failureClass, "transient_infrastructure");
      assert.equal(
        fresh.value.snapshot.reservations.filter((row) =>
          row.outcome === "ambiguous"
        ).length,
        4,
      );

      // The unchanged replay is refused and REPORTED; planning is pure, so the
      // durable head does not move and nothing is charged for the refusal.
      const denials: { id: string; reason: string }[] = [];
      const refusedPlans = planHostedRetries(
        fresh.value.snapshot,
        clock.now(),
        new Map(),
        new Set(),
        (denial) => denials.push({ id: denial.id, reason: denial.reason }),
      );
      assert.equal(refusedPlans.length, 0);
      assert.equal(denials.length, 1);
      assert.equal(denials[0].id, taskId);
      assert.match(denials[0].reason, /^equivalent_attempt_refused:/);
      const afterRefusal = await storeB.readRepair();
      assert.ok(afterRefusal.ok && afterRefusal.value.status === "found");
      assert.equal(afterRefusal.value.head, fresh.value.head);

      // Fairness: an unrelated blocked record with NO matching memory is still
      // granted its own retry in the same pass. A refused item never starves
      // the rest of the queue.
      const unrelatedId = "issue-memory-e2e-755";
      const withUnrelated = parseRepairStateSnapshotV1({
        ...fresh.value.snapshot,
        stateHead: fresh.value.head,
        sequence: fresh.value.snapshot.sequence + 1,
        updatedAt: clock.now(),
        work: [
          ...fresh.value.snapshot.work,
          taskRecord(unrelatedId, 755, {
            nextStep: "blocked",
            blocker: {
              kind: "other",
              message: ATTEMPT_DETAIL_NO_TRUSTED_RECEIPT,
              since: T0,
            },
            counters: { attempts: 1, retries: 0, reviewRounds: 0 },
          }),
        ],
      });
      const writtenB = await storeB.writeRepair(
        withUnrelated,
        fresh.value.head,
      );
      assert.ok(writtenB.ok && writtenB.value.status === "applied");
      const fairDenials: { id: string }[] = [];
      const fairPlans = planHostedRetries(
        withUnrelated,
        clock.now(),
        new Map(),
        new Set(),
        (denial) => fairDenials.push({ id: denial.id }),
      );
      assert.equal(fairPlans.length, 1);
      assert.equal(fairPlans[0].id, unrelatedId);
      assert.equal(fairPlans[0].nextStep, "work");
      assert.equal(fairDenials.length, 1);
      assert.equal(fairDenials[0].id, taskId);

      // Changed evidence sanity: the refused record's base is the only base
      // with recorded outcomes; a genuine base move (the runtime's own refresh
      // path) is what re-opens it. Assert the durable memory stays bound to
      // the OLD base so that move is verifiable from state alone.
      assert.equal(memory.base, BASE);
      assert.equal(
        fresh.value.snapshot.attemptMemory.some((row) => row.base === SHA3),
        false,
      );
      assert.equal(hostedRepositoryKey(REPO), hostedRepositoryKey(REPO));
    } finally {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  },
);
