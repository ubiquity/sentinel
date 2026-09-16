/**
 * Wave C run-bound acceptance through the ACTUAL production entrypoint
 * (`runRepairEntrypoint` in src/main.ts) with fake-clock fakes: the fixed
 * 120-minute run ceiling bounds an unbounded caller deadline, the 90-minute
 * no-new-model-work cutoff rejects an implementation start before any
 * reservation, and a tighter caller deadline governs over the ceiling. Real
 * disposable Git state stores; no model call, no network, no credentials.
 */
import assert from "node:assert/strict";

import { RollingStartBudget } from "../../src/budget/mod.ts";
import {
  REPAIR_MODEL_CUTOFF_MS,
  REPAIR_RUN_CEILING_MS,
} from "../../src/repair/loop.ts";
import {
  AdvancingFakeGithub,
  AdvancingFakeReplay,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
} from "../repair/helpers.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { runRepairEntrypoint } from "../../src/main.ts";
import {
  evidenceFixture,
  exactCandidateLifecycle,
  FakeClock,
  makeIntegrationCtx,
  repairConfigs,
  SHA1,
  SHA3,
  summaryFixture,
  T0,
} from "./helpers.ts";

const MINUTE = 60_000;

Deno.test(
  "entrypoint: the fixed 120-minute ceiling bounds a longer caller deadline and the 90-minute cutoff blocks a model start without a reservation",
  async () => {
    const ctx = await makeIntegrationCtx("runbounds-ceiling");
    const clock = new FakeClock(T0);
    try {
      const store = createRepairStateStore({
        scratchDir: `${ctx.tmp}/scratch-repair`,
        remoteUrl: ctx.remoteUrl,
      });
      const githubCooldown = new DurableGitHubCooldownGate({
        state: store,
        clock,
      });
      const configs = repairConfigs({
        sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
      });
      const budget = new RollingStartBudget({ clock, state: store, configs });
      const github = new FakeGithub({ baseSha: SHA1 });
      const incidents = new FakeIncidents({
        summaries: [summaryFixture()],
        evidence: evidenceFixture(),
      });
      const replay = new AdvancingFakeReplay(clock, REPAIR_MODEL_CUTOFF_MS);
      const model = new FakeModel({ head: undefined });
      // A caller deadline far beyond the fixed ceiling must be clamped to
      // 120 minutes; the before-run replay advances the clock past the
      // 90-minute cutoff mid-run.
      const outcome = await runRepairEntrypoint({
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
      }, {
        deadline: clock.now() + 3 * 60 * MINUTE,
        stepLimit: 32,
      });
      assert.equal(outcome.status, "margin", JSON.stringify(outcome));
      assert.equal(model.requests.length, 0, "no model start");
      const read = await store.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      if (!read.ok || read.value.status !== "found") {
        throw new Error("no repair state");
      }
      const snapshot = read.value.snapshot;
      assert.equal(snapshot.reservations.length, 0, "nothing charged");
      assert.equal(snapshot.work[0]!.target.head, null);
      assert.equal(snapshot.work[0]!.intent, null);
      assert.equal(github.pushes.length, 0, "no publication");
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "entrypoint: an already-expired caller deadline stops the run before any side effect",
  async () => {
    const ctx = await makeIntegrationCtx("runbounds-expired");
    const clock = new FakeClock(T0);
    try {
      const store = createRepairStateStore({
        scratchDir: `${ctx.tmp}/scratch-repair`,
        remoteUrl: ctx.remoteUrl,
      });
      const githubCooldown = new DurableGitHubCooldownGate({
        state: store,
        clock,
      });
      const configs = repairConfigs({
        sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
      });
      const budget = new RollingStartBudget({ clock, state: store, configs });
      const github = new FakeGithub({ baseSha: SHA1 });
      const incidents = new FakeIncidents({ summaries: [], evidence: null });
      const replay = new FakeReplay();
      const model = new FakeModel();
      const outcome = await runRepairEntrypoint({
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
      }, {
        deadline: clock.now(), // the total run deadline is already reached
      });
      assert.equal(outcome.status, "margin", JSON.stringify(outcome));
      assert.equal(github.calls.length, 0, "no port call");
      assert.equal(model.requests.length, 0, "no model start");
      assert.equal(replay.requests.length, 0, "no replay");
      const read = await store.readRepair();
      assert.ok(
        read.ok && read.value.status === "absent",
        "no state was seeded or written",
      );
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "entrypoint: a tighter caller deadline governs over the ceiling and rejects a non-fitting operation before any reservation",
  async () => {
    const ctx = await makeIntegrationCtx("runbounds-tight");
    const clock = new FakeClock(T0);
    try {
      const store = createRepairStateStore({
        scratchDir: `${ctx.tmp}/scratch-repair`,
        remoteUrl: ctx.remoteUrl,
      });
      const githubCooldown = new DurableGitHubCooldownGate({
        state: store,
        clock,
      });
      const configs = repairConfigs({
        sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
      });
      const budget = new RollingStartBudget({ clock, state: store, configs });
      const github = new FakeGithub({ baseSha: SHA1 });
      const incidents = new FakeIncidents({
        summaries: [summaryFixture()],
        evidence: evidenceFixture(),
      });
      const replay = new AdvancingFakeReplay(clock, MINUTE);
      const model = new FakeModel();
      // 4-minute session + 5-minute reserved margin cannot fit a 5-minute
      // caller deadline: the operation is refused before any reservation.
      const outcome = await runRepairEntrypoint({
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
      }, {
        deadline: clock.now() + 5 * MINUTE,
        stepLimit: 32,
      });
      assert.equal(outcome.status, "margin", JSON.stringify(outcome));
      assert.equal(model.requests.length, 0, "no model start");
      // The entrypoint reserves its five-minute finalization margin OUTSIDE
      // the loop deadline, so a 5-minute caller window leaves the loop a
      // zero-length window: no write is forced when no time remains. An absent
      // state is the correct no-work boundary; if a snapshot did land, it must
      // carry no reservation.
      const read = await store.readRepair();
      assert.equal(read.ok, true, JSON.stringify(read));
      if (read.ok && read.value.status === "found") {
        assert.equal(
          read.value.snapshot.reservations.length,
          0,
          "nothing charged when no work fits",
        );
      } else if (read.ok) {
        assert.equal(
          read.value.status,
          "absent",
          "no fabricated snapshot when no time remains",
        );
      }
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "entrypoint: a push that crosses the total deadline publishes once and the next run creates the PR once without re-pushing",
  async () => {
    const ctx = await makeIntegrationCtx("runbounds-latepub");
    const clock = new FakeClock(T0);
    try {
      const store = createRepairStateStore({
        scratchDir: `${ctx.tmp}/scratch-repair`,
        remoteUrl: ctx.remoteUrl,
      });
      const githubCooldown = new DurableGitHubCooldownGate({
        state: store,
        clock,
      });
      const configs = repairConfigs({
        sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
      });
      const budget = new RollingStartBudget({ clock, state: store, configs });
      const github = new AdvancingFakeGithub(
        clock,
        REPAIR_RUN_CEILING_MS + MINUTE,
        {
          baseSha: SHA1,
          // Fresh publication: the candidate branch is absent at the start and
          // the fake exposes the exact pushed SHA afterwards.
          candidateLifecycle: exactCandidateLifecycle({
            base: SHA1,
            head: SHA3,
          }),
        },
      );
      const incidents = new FakeIncidents({
        summaries: [summaryFixture()],
        evidence: evidenceFixture(),
      });
      const replay = new FakeReplay();
      const model = new FakeModel({ head: SHA3, changedPaths: ["src/app.ts"] });
      const first = await runRepairEntrypoint({
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
      }, {
        deadline: clock.now() + 3 * 60 * MINUTE,
        stepLimit: 32,
      });
      assert.equal(first.status, "margin", JSON.stringify(first));
      assert.equal(github.pushes.length, 1, "the candidate push finished");
      assert.equal(
        github.calls.filter((call) => call === "createPr").length,
        0,
        "no PR creation after the total deadline",
      );
      const resumed = await runRepairEntrypoint({
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
      }, {
        // A fresh absolute deadline for the resumed run (same clock, now at
        // minute 121 of the first run's window).
        deadline: clock.now() + 3 * 60 * MINUTE,
        stepLimit: 32,
      });
      assert.equal(resumed.status, "idle", JSON.stringify(resumed));
      assert.equal(github.pushes.length, 1, "no second push");
      assert.equal(
        github.calls.filter((call) => call === "createPr").length,
        1,
        "the next run created the PR exactly once",
      );
      const read = await store.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      if (!read.ok || read.value.status !== "found") {
        throw new Error("no repair state");
      }
      assert.equal(read.value.snapshot.work[0]!.intent, null);
      assert.equal(read.value.snapshot.work[0]!.target.pr, 7);
    } finally {
      await ctx.cleanup();
    }
  },
);
