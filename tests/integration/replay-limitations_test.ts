import assert from "node:assert/strict";
import { makeRepairRig } from "./helpers.ts";

Deno.test("replay limitations block publication", async () => {
  for (const mode of ["before-only", "after-only"] as const) {
    const rig = await makeRepairRig(`limitations-${mode}`, {
      replay: mode === "before-only"
        ? { before: { limitations: ["fixture_redacted"] } }
        : { after: { limitations: ["output_truncated"] } },
    });
    try {
      await rig.run();
      let state = await rig.snapshot();
      assert.equal(
        state.work.some((w) => w.target.pr !== null),
        false,
        `${mode} published limited proof`,
      );
      assert.equal(
        state.work.some((w) => w.nextStep === "review"),
        false,
        `${mode} reached review`,
      );
      if (mode === "before-only") {
        assert.equal(
          rig.model.requests.length,
          0,
          "limited original must not admit implementation",
        );
        assert.equal(
          state.reservations.length,
          0,
          "limited original must not reserve model",
        );
      }
      if (mode === "after-only") {
        assert.ok(
          state.replays.some((r) => r.limitations.includes("output_truncated")),
          "after limitation must survive durable replay construction",
        );
        const read = await rig.store.readRepair();
        assert.ok(read.ok && read.value.status === "found");
        if (read.ok && read.value.status === "found") {
          state = structuredClone(read.value.snapshot);
          state.stateHead = read.value.head;
          state.sequence++;
          state.updatedAt = rig.clock.now();
          state.work = state.work.map((w) => ({
            ...w,
            nextStep: "work",
            blocker: null,
            wait: null,
          }));
          const write = await rig.store.writeRepair(state, read.value.head);
          assert.ok(write.ok && write.value.status === "applied");
          const modelCount = rig.model.requests.length,
            replayCount = rig.replay.requests.length,
            reservationCount = state.reservations.length;
          await rig.run();
          state = await rig.snapshot();
          assert.equal(rig.model.requests.length, modelCount);
          assert.equal(
            rig.replay.requests.length,
            replayCount,
            "cached limited proof must block before replay",
          );
          assert.equal(state.reservations.length, reservationCount);
          assert.equal(
            state.work.some((w) => w.target.pr !== null),
            false,
            "saved limited candidate must not be reused as accepted proof",
          );
          assert.ok(
            state.replays.every((r) =>
              r.limitations.includes("output_truncated")
            ),
            "resume stripped limitation",
          );
        }
      }
      console.log(
        `PASS ${mode}: zero publication; modelStarts=${rig.model.requests.length}; durableReplayLimitations=${
          JSON.stringify(state.replays.map((r) => r.limitations))
        }`,
      );
    } finally {
      await rig.ctx.cleanup();
    }
  }
});

Deno.test("replay cache identities are immutable", async () => {
  const baselineRig = await makeRepairRig("replay-cache-baseline");
  let baseline: Awaited<ReturnType<typeof baselineRig.snapshot>>;
  try {
    await baselineRig.run();
    baseline = await baselineRig.snapshot();
    assert.equal(baseline.replays.length, 1);
  } finally {
    await baselineRig.ctx.cleanup();
  }
  for (
    const mode of [
      "limitations",
      "noncausal",
      "repository",
      "original",
      "fixture-ref",
      "fixture-digest",
      "test-ids",
      "replay-command",
      "test-command",
    ]
  ) {
    const rig = await makeRepairRig(`cache-${mode}`);
    try {
      const seed = structuredClone(baseline);
      seed.stateHead = null;
      seed.sequence = 1;
      seed.updatedAt = rig.clock.now();
      seed.work = seed.work.map((w) => ({
        ...w,
        nextStep: "work",
        blocker: null,
        wait: null,
        intent: null,
        target: { ...w.target, pr: null },
      }));
      const result = seed.replays[0];
      if (mode === "limitations") result.limitations = ["fixture_redacted"];
      if (mode === "noncausal") {
        result.original.failure!.intended = false;
        result.limitations = ["original_not_reproduced"];
      }
      if (mode === "repository") {
        result.repository = { ...result.repository, name: "different" };
      }
      if (mode === "original") {
        result.original.revision = "a".repeat(
          40,
        ) as typeof result.original.revision;
      }
      if (mode === "fixture-ref") {
        result.fixture.ref =
          "artifact://sentinel/fixtures/different.json" as typeof result.fixture.ref;
      }
      if (mode === "fixture-digest") {
        result.fixture.digest = "a".repeat(64) as typeof result.fixture.digest;
      }
      if (mode === "test-ids") result.fixture.testIds = ["different:test"];
      if (mode === "replay-command") {
        result.commands.replay =
          "different_replay" as unknown as typeof result.commands.replay;
      }
      if (mode === "test-command") {
        result.commands.test =
          "different_test" as unknown as typeof result.commands.test;
      }
      const wrote = await rig.store.writeRepair(seed, null);
      assert.ok(wrote.ok && wrote.value.status === "applied", mode);
      const model = rig.model.requests.length,
        replay = rig.replay.requests.length,
        calls = rig.github.calls.length;
      await rig.run();
      const final = await rig.snapshot();
      assert.equal(final.work[0].nextStep, "blocked", mode);
      assert.equal(final.work[0].blocker?.kind, "missing_evidence", mode);
      assert.equal(rig.model.requests.length, model, mode);
      assert.equal(rig.replay.requests.length, replay, mode);
      assert.equal(
        rig.github.calls.slice(calls).some((c) =>
          c === "createPr" || c.startsWith("push:")
        ),
        false,
        mode,
      );
      assert.deepEqual(final.replays, seed.replays, mode);
      console.log(`PASS immutable cached proof rejects ${mode}`);
    } finally {
      await rig.ctx.cleanup();
    }
  }
});
