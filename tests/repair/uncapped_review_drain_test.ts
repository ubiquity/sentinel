/**
 * Review-drain backlog regression (owner update 2026-10-02T22:05:51Z: "lift
 * all the limits"). The retroactive `review_quota` drain released at most a
 * fixed eight transient records per run, silently leaving the rest of the
 * actual pending collection parked even when the run's real bounds still
 * admitted them.
 *
 * This case drives the real production repair cycle over the real temporary
 * Git repair-state store: ten transient records are parked, and the run's
 * step budget (64) and deadline (60 minutes) comfortably admit all ten. Only
 * the removed fixed truncation can leave any of them unobserved.
 *
 * RED before the drain change: exactly eight records move to the ordinary
 * `review_pending` wait and two stay in `review_quota`.
 */
import assert from "node:assert/strict";

import { RollingStartBudget } from "../../src/budget/mod.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import {
  makeRemoteCtx,
  SHA1,
  SHA2,
  T0,
  testGitEnv,
  workRecord,
} from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  repairConfigs,
} from "./helpers.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/repair\/uncapped_review_drain_test\.ts$/,
  "",
);

const PARKED = 10;

/** One live publication parked in the transient review-quota state. */
function parkedReviewRecord(number: number, pr: number): WorkRecordV1 {
  return workRecord(`issue-${number}`, {
    source: { kind: "issue", id: String(number), revision: SHA1 },
    related: { incidentId: null, issueNumber: number },
    target: {
      base: SHA1,
      branch: `sentinel/repair/issue-${number}`,
      checkpoint: null,
      head: SHA2,
      pr,
    },
    nextStep: "review",
    wait: { reason: "review_quota", since: T0, until: T0 + 3_600_000 },
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
  });
}

function seedSnapshot(work: WorkRecordV1[]): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work,
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
  });
}

Deno.test(
  "review drain: ten transient review-quota records all progress in one bounded run",
  async () => {
    const tmp = await Deno.makeTempDir({
      prefix: "sentinel-review-drain-",
      dir: ROOT,
    });
    try {
      const env = testGitEnv(`${tmp}/git-home`);
      await Deno.mkdir(`${tmp}/git-home`, { recursive: true });
      const remote = await makeRemoteCtx(tmp, env);
      const clock = new FakeClock(T0);
      const store = createRepairStateStore({
        scratchDir: `${tmp}/scratch`,
        remoteUrl: remote.remoteUrl,
      });
      const configs = repairConfigs({
        adapter: { kind: "github" },
        sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
      });
      const budget = new RollingStartBudget({ clock, state: store, configs });
      const githubCooldown = new DurableGitHubCooldownGate({
        state: store,
        clock,
      });
      const github = new FakeGithub({ baseSha: SHA1 });
      const incidents = new FakeIncidents({ summaries: [], evidence: null });
      const replay = new FakeReplay();
      const model = new FakeModel({
        head: SHA2,
        changedPaths: ["src/app.ts"],
      });

      const seeded = Array.from(
        { length: PARKED },
        (_, index) => parkedReviewRecord(101 + index, 11 + index),
      );
      const written = await store.writeRepair(seedSnapshot(seeded), null);
      assert.ok(written.ok && written.value.status === "applied");

      const outcome = await runRepairCycle({
        clock,
        state: store,
        configs,
        controllerSha: SHA1,
        github,
        githubCooldown,
        incidents,
        replay,
        model,
        budget,
      }, { deadline: clock.now() + 60 * 60_000, stepLimit: 64 });
      assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));

      const read = await store.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      if (!read.ok || read.value.status !== "found") {
        throw new Error("seeded repair state unavailable");
      }
      const snapshot = read.value.snapshot;
      const pending = snapshot.work.filter(
        (record) => record.wait?.reason === "review_pending",
      ).length;
      const stillParked = snapshot.work.filter(
        (record) => record.wait?.reason === "review_quota",
      ).length;
      assert.equal(
        pending,
        PARKED,
        `only ${pending}/${PARKED} drained records reached the ordinary review wait`,
      );
      assert.equal(
        stillParked,
        0,
        "no truncation may leave parked work behind",
      );
      assert.equal(github.observedReviewKeys.length, PARKED);
      assert.equal(model.requests.length, 0, "draining never starts a model");
    } finally {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  },
);
