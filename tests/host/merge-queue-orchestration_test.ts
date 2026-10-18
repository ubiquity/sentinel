import assert from "node:assert/strict";
import { runHostedQueueCustody } from "../../ops/hosted-autonomy-queue-pass.ts";
import {
  createQueueIntent,
  parseQueueIntent,
  queueIntentBinding,
} from "../../ops/hosted-autonomy-queue-intent.ts";
import { queueRecordProtected } from "../../ops/hosted-autonomy-queue-context.ts";
import { protectQueueState } from "../../ops/hosted-autonomy-queue-state.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { queueHold } from "../../ops/hosted-autonomy-queue-writer.ts";
import { renderHostedParkSummary } from "../../ops/hosted-autonomy-summary.ts";
import {
  nativeEntry,
  orchestrationRig,
  T0,
} from "./merge-queue-orchestration-fixtures.ts";

Deno.test("queue custody: dark no-rule path uses no new queue permission API", async () => {
  const f = await orchestrationRig();
  f.queue.config.proofActivated = false;
  const before = canonicalStringify(f.state.repair);
  const result = await runHostedQueueCustody(f.deps, f.now() + 60000);
  assert.equal(result.ready, true);
  assert.deepEqual(f.calls, ["rules"]);
  assert.equal(canonicalStringify(f.state.repair), before);
});

Deno.test("queue custody: unavailable rules or queue is never empty and never ready", async (t) => {
  for (
    const mode of [
      "unknown_rules",
      "permission",
      "missing_coordinator",
    ] as const
  ) {
    await t.step(mode, async () => {
      const f = await orchestrationRig();
      f.rules({ status: "complete", value: true });
      if (mode === "unknown_rules") {
        f.rules({ status: "unavailable", reason: "permission" });
      }
      if (mode === "permission") {
        f.scan({ status: "unavailable", reason: "permission" });
      }
      if (mode === "missing_coordinator") {
        delete f.deps.queue;
      }
      const result = await runHostedQueueCustody(f.deps, f.now() + 60000);
      assert.equal(result.ready, false);
      assert.equal(f.calls.includes("enqueue"), false);
    });
  }
});

Deno.test("queue custody: foreign native enqueue is held before any later observation", async () => {
  const f = await orchestrationRig();
  f.rules({ status: "complete", value: true });
  const entry = nativeEntry();
  entry.enqueuer = { type: "User", nodeId: "U_owner", login: "owner" };
  f.join(entry);
  f.queue.authorization.readAuthorization = () => {
    assert.equal(f.state.repair!.work[0].wait?.until, null);
    assert.equal(f.state.repair!.work[0].intent, null);
    return Promise.resolve({ status: "unavailable", reason: "unsupported" });
  };
  const charges = canonicalStringify(f.state.repair!.reservations);
  const result = await runHostedQueueCustody(f.deps, f.now() + 60000);
  assert.equal(result.ready, true);
  assert.ok(result.protectedRecordIds.has(f.proof.record.id));
  assert.equal(canonicalStringify(f.state.repair!.reservations), charges);
  assert.equal(f.calls.includes("dequeue"), false);
});

Deno.test("queue custody: hold CAS conflicts and ambiguity stop before effects", async (t) => {
  for (const kind of ["conflict", "ambiguous"] as const) {
    await t.step(kind, async () => {
      const f = await orchestrationRig();
      f.rules({ status: "complete", value: true });
      f.join();
      if (kind === "conflict") {
        f.state.conflictRepairNext = true;
      } else f.state.ambiguousRepairNext = true;
      const result = await runHostedQueueCustody(f.deps, f.now() + 60000);
      assert.equal(result.ready, false);
      assert.equal(f.calls.includes("authorization"), false);
      assert.equal(f.calls.includes("enqueue"), false);
    });
  }
});

Deno.test("queue custody: admitted entry survives restart with exact immutable receipt binding", async () => {
  const f = await orchestrationRig();
  f.queue.config.mode = "on";
  f.rules({ status: "complete", value: true });
  f.onEnqueue(() => {
    const row = f.state.repair!.work[0];
    assert.equal(row.wait?.until, null);
    assert.ok(parseQueueIntent(row));
    f.join();
  });
  assert.equal(
    (await runHostedQueueCustody(f.deps, f.now() + 60000)).ready,
    true,
  );
  const saved = await queueIntentBinding(
    f.state.repair!,
    f.state.repair!.work[0],
  );
  assert.equal(saved?.state.intent.resultId, "MQE_7");
  assert.equal(saved?.binding.reviewReceiptId, f.proof.receipt.id);
  f.advance(30 * 24 * 60 * 60 * 1000);
  assert.equal(
    (await runHostedQueueCustody(f.deps, f.now() + 60000)).ready,
    true,
  );
  assert.equal(f.calls.filter((call) => call === "enqueue").length, 1);
});

Deno.test("queue custody: ambiguous/crashed submission stays charged and never resubmits", async () => {
  const f = await orchestrationRig();
  f.queue.config.mode = "on";
  f.rules({ status: "complete", value: true });
  f.admission({ status: "ambiguous", requestId: null });
  const charges = canonicalStringify(f.state.repair!.reservations);
  await runHostedQueueCustody(f.deps, f.now() + 60000);
  for (let pass = 0; pass < 4; pass++) {
    await runHostedQueueCustody(f.deps, f.now() + 60000);
  }
  assert.equal(f.calls.filter((call) => call === "enqueue").length, 1);
  f.advance(6 * 60 * 60 * 1000);
  const last = await runHostedQueueCustody(f.deps, f.now() + 60000);
  assert.ok(
    last.actions.some((action) =>
      action.endsWith("owner_park:admission_unresolved")
    ),
  );
  assert.equal(canonicalStringify(f.state.repair!.reservations), charges);
});

Deno.test("queue admission: a definite preflight refusal is reconciled without refund", async () => {
  const f = await orchestrationRig();
  f.queue.config.mode = "on";
  f.rules({ status: "complete", value: true });
  let authorizations = 0;
  const readAuthorization = f.queue.authorization.readAuthorization;
  f.queue.authorization.readAuthorization = (request) => {
    authorizations++;
    if (authorizations === 2) f.auth.headCiGreen = false;
    return readAuthorization(request);
  };
  const charges = canonicalStringify(f.state.repair!.reservations);
  const first = await runHostedQueueCustody(f.deps, f.now() + 60000);
  assert.equal(first.ready, true, first.actions.join(" "));
  assert.equal(
    parseQueueIntent(f.state.repair!.work[0])?.stage,
    "not_submitted",
  );
  assert.equal(f.calls.includes("enqueue"), false);
  const second = await runHostedQueueCustody(f.deps, f.now() + 60000);
  assert.equal(second.ready, true, second.actions.join(" "));
  assert.ok(
    second.actions.some((action) =>
      action.endsWith(":not_submitted_reconciled")
    ),
  );
  assert.equal(f.state.repair!.work[0].intent, null);
  assert.equal(f.state.repair!.work[0].wait, null);
  assert.equal(canonicalStringify(f.state.repair!.reservations), charges);
});

Deno.test("queue custody: definitive refusals stop at three, preserving original admission age", async () => {
  const f = await orchestrationRig();
  f.queue.config.mode = "on";
  f.rules({ status: "complete", value: true });
  f.admission({ status: "refused", reason: "not_mergeable" });
  for (let pass = 0; pass < 5; pass++) {
    await runHostedQueueCustody(f.deps, f.now() + 60000);
    f.advance(1000);
  }
  assert.equal(f.calls.filter((call) => call === "enqueue").length, 3);
  assert.equal(parseQueueIntent(f.state.repair!.work[0])?.refusals, 3);
  assert.equal(f.state.repair!.work[0].intent?.startedAt, T0 + 2000);
});

Deno.test("queue custody: persisted prepared intent is uncertain after a crash", async () => {
  const f = await orchestrationRig();
  f.queue.config.mode = "on";
  f.rules({ status: "complete", value: true });
  const row = f.state.repair!.work[0];
  f.state.repair!.work[0] = {
    ...queueHold(row, f.now()),
    intent: await createQueueIntent(row, f.proof.binding, f.now()),
  };
  const result = await runHostedQueueCustody(f.deps, f.now() + 60000);
  assert.equal(result.ready, true);
  assert.equal(f.calls.includes("enqueue"), false);
});

Deno.test("queue write assertion protects row, charge, review, and release authority", async (t) => {
  for (const kind of ["row", "charge", "review"] as const) {
    await t.step(kind, async () => {
      const f = await orchestrationRig();
      f.state.repair!.work[0] = queueHold(f.state.repair!.work[0], f.now());
      const guarded = protectQueueState(f.state, {
        ready: true,
        proofActivated: false,
        protectedRecordIds: new Set(),
      });
      const next = structuredClone(f.state.repair!);
      next.sequence++;
      next.stateHead = f.state.repairHead;
      next.updatedAt = f.now();
      if (kind === "row") {
        next.work[0].wait = null;
      }
      if (kind === "charge") next.reservations = [];
      if (kind === "review") next.reviews = [];
      const written = await guarded.writeRepair(next, f.state.repairHead);
      assert.equal(written.ok, false);
      assert.equal(f.state.repairWrites, 0);
    });
  }
});

Deno.test("queue admission: fresh head CI is required before intent or external submission", async () => {
  const f = await orchestrationRig();
  f.queue.config.mode = "on";
  f.rules({ status: "complete", value: true });
  f.auth.headCiGreen = false;
  const result = await runHostedQueueCustody(f.deps, f.now() + 60000);
  assert.equal(result.ready, true);
  assert.equal(f.calls.includes("enqueue"), false);
  assert.equal(f.state.repair!.work[0].intent, null);
});

Deno.test("queue custody: path drift is rechecked every pass; only own entry is dequeued", async (t) => {
  for (const foreign of [false, true]) {
    await t.step(foreign ? "foreign owner park" : "own dequeue", async () => {
      const f = await orchestrationRig();
      f.queue.config.mode = "on";
      f.rules({ status: "complete", value: true });
      if (foreign) {
        const entry = nativeEntry();
        entry.enqueuer = { type: "User", nodeId: "U_owner", login: "owner" };
        f.join(entry);
      } else f.onEnqueue(() => f.join());
      await runHostedQueueCustody(f.deps, f.now() + 60000);
      f.auth.pathsDisjoint = false;
      let dequeues = 0;
      f.queue.surface.dequeue = () => {
        dequeues++;
        f.leave();
        return Promise.resolve({ status: "submitted" });
      };
      const result = await runHostedQueueCustody(f.deps, f.now() + 60000);
      assert.equal(dequeues, foreign ? 0 : 1);
      assert.ok(result.actions.some((action) =>
        action.includes(
          foreign
            ? "owner_park:foreign_entry_drift"
            : "dequeue_submitted:path_overlap",
        )
      ));
      assert.equal(f.state.repair!.work[0].wait?.until, null);
    });
  }
});

Deno.test("queue reentry: one proven ejection starts a distinct admission without expiring queued wait", async () => {
  const f = await orchestrationRig();
  f.queue.config.mode = "on";
  f.rules({ status: "complete", value: true });
  f.onEnqueue(() => f.join());
  await runHostedQueueCustody(f.deps, f.now() + 60000);
  const first = f.state.repair!.work[0].intent!;
  f.advance(30 * 24 * 60 * 60 * 1000);
  f.leave();
  f.queue.authorization.readRemoval = () =>
    Promise.resolve({
      status: "complete",
      value: { classification: "ci_failed", eventId: "EV_removed" },
    });
  f.onEnqueue(() => {});
  const reentry = await runHostedQueueCustody(f.deps, f.now() + 60000);
  assert.equal(reentry.ready, true);
  const second = parseQueueIntent(f.state.repair!.work[0])!;
  assert.equal(second.admission, 1);
  assert.equal(second.queueFailures, 1);
  assert.equal(second.intent.key, `${first.key}:a1`);
  assert.equal(second.intent.startedAt, f.now());
  const pending = await runHostedQueueCustody(f.deps, f.now() + 60000);
  assert.equal(
    pending.actions.some((action) => action.includes("admission_unresolved")),
    false,
  );
  assert.equal(f.calls.filter((call) => call === "enqueue").length, 2);
  const entry = { ...nativeEntry(), id: "MQE_8", enqueuedAt: f.now() };
  f.join(entry);
  await runHostedQueueCustody(f.deps, f.now() + 60000);
  f.leave();
  const exhausted = await runHostedQueueCustody(f.deps, f.now() + 60000);
  assert.ok(
    exhausted.actions.some((action) =>
      action.includes("owner_park:repeated_queue_failure")
    ),
  );
  assert.equal(f.calls.filter((call) => call === "enqueue").length, 2);
});

Deno.test("queue custody: premature active rules hold native entries and refuse launcher activation", async () => {
  const f = await orchestrationRig();
  f.queue.config.proofActivated = false;
  f.queue.config.mode = "on";
  f.rules({ status: "complete", value: true });
  f.join();
  const result = await runHostedQueueCustody(f.deps, f.now() + 60000);
  assert.equal(result.ready, false);
  assert.ok(result.actions.includes("queue:activation_unaccepted"));
  assert.ok(result.protectedRecordIds.has(f.proof.record.id));
  assert.equal(f.state.repair!.work[0].wait?.until, null);
  assert.equal(f.calls.includes("enqueue"), false);
});

Deno.test("queue custody: a late native membership is held before returning ready", async (t) => {
  for (const conflict of [false, true]) {
    await t.step(conflict ? "hold CAS lost" : "verified hold", async () => {
      const f = await orchestrationRig();
      f.queue.config.mode = "on";
      f.rules({ status: "complete", value: true });
      const entry = nativeEntry();
      entry.enqueuer = { type: "User", nodeId: "U_owner", login: "owner" };
      f.member({
        status: "complete",
        value: { pull: entry.pull, entry, mergedRevision: null },
      });
      f.state.conflictRepairNext = conflict;
      const result = await runHostedQueueCustody(f.deps, f.now() + 60000);
      assert.equal(result.ready, !conflict);
      if (!conflict) {
        assert.equal(f.state.repair!.work[0].wait?.until, null);
        assert.ok(result.protectedRecordIds.has(f.proof.record.id));
      }
      assert.equal(f.calls.includes("enqueue"), false);
    });
  }
});

Deno.test("queue custody: post-effect scans hold a second foreign entry despite probation", async () => {
  const f = await orchestrationRig();
  f.queue.config.mode = "on";
  f.rules({ status: "complete", value: true });
  const second = structuredClone(f.state.repair!.work[0]);
  second.id = "issue:second" as typeof second.id;
  second.target.pr = 8;
  f.state.repair!.work.push(second);
  const entry = nativeEntry();
  entry.id = "MQE_foreign";
  entry.pull = { ...entry.pull, number: 8, nodeId: "PR_8" };
  entry.enqueuer = { type: "User", nodeId: "U_owner", login: "owner" };
  f.onEnqueue(() => {
    f.join();
    f.scan({
      status: "complete",
      value: {
        repository: f.queue.repository,
        baseRef: "development",
        baseTip: f.proof.binding.base,
        queueId: "MQ_1",
        entries: [nativeEntry(), entry],
        observedAt: f.now(),
      },
    });
  });
  const result = await runHostedQueueCustody(f.deps, f.now() + 60000);
  assert.equal(result.ready, true);
  assert.ok(result.protectedRecordIds.has(second.id));
  assert.equal(
    f.state.repair!.work.find((row) => row.id === second.id)!.wait?.until,
    null,
  );
  assert.equal(f.calls.filter((call) => call === "enqueue").length, 1);
});

Deno.test("queue dequeue: durable intent prevents replay after ambiguity, exception, and restart", async (t) => {
  for (const failure of ["ambiguous", "throw", "cas_conflict"] as const) {
    await t.step(failure, async () => {
      const f = await orchestrationRig();
      f.queue.config.mode = "on";
      f.rules({ status: "complete", value: true });
      f.onEnqueue(() => f.join());
      await runHostedQueueCustody(f.deps, f.now() + 60000);
      f.auth.pathsDisjoint = false;
      const original = f.state.repair!.work[0].intent!;
      let dequeues = 0;
      f.queue.surface.dequeue = () => {
        dequeues++;
        assert.equal(
          parseQueueIntent(f.state.repair!.work[0])?.stage,
          "dequeue_pending",
        );
        assert.equal(
          f.state.repair!.work[0].intent?.resultId,
          original.resultId,
        );
        if (failure === "throw") throw new Error("transport disappeared");
        return Promise.resolve({ status: "ambiguous" });
      };
      f.state.conflictRepairNext = failure === "cas_conflict";
      const first = await runHostedQueueCustody(f.deps, f.now() + 60000);
      assert.equal(first.ready, false);
      assert.equal(dequeues, failure === "cas_conflict" ? 0 : 1);
      if (failure === "cas_conflict") return;
      assert.equal(f.state.repair!.work[0].intent?.failure, undefined);
      await runHostedQueueCustody(f.deps, f.now() + 60000);
      f.leave();
      await runHostedQueueCustody(f.deps, f.now() + 60000);
      assert.equal(dequeues, 1);
      assert.equal(f.calls.filter((call) => call === "enqueue").length, 1);
      assert.equal(f.state.repair!.work[0].wait?.until, null);
      assert.equal(
        f.state.repair!.work[0].intent?.startedAt,
        original.startedAt,
      );
    });
  }
});

Deno.test("queue summary: every closed owner action is named without raw diagnostics", async () => {
  const f = await orchestrationRig();
  f.state.repair!.work[0] = queueHold(f.state.repair!.work[0], f.now());
  for (
    const suffix of [
      "owner_park:admission_unresolved",
      "owner_park:foreign_entry_drift",
      "owner_park:refusals_exhausted",
      "owner_park:repeated_queue_failure",
      "invalid_intent_owner_action",
      "binding_changed_owner_action",
      "foreign_hold_absent_owner_action",
      "removal_unproven_owner_action",
      "dequeue_pending_owner_action",
    ]
  ) {
    const summary = renderHostedParkSummary(f.state.repair!, [
      `queue:${f.proof.record.id}:${suffix}`,
    ]);
    assert.ok(summary.includes("Owner:"), suffix);
    assert.ok(summary.includes(`| ${f.proof.record.target.pr} |`));
  }
  const raw = renderHostedParkSummary(f.state.repair!, [
    `queue:${f.proof.record.id}:sensitive unknown detail`,
  ]);
  assert.equal(raw.includes("sensitive unknown detail"), false);
});

Deno.test("queue admission: native second precision owns the containing second only", async (t) => {
  for (const reconcile of [false, true]) {
    for (const older of [false, true]) {
      await t.step(
        `${reconcile ? "restart" : "post-enqueue"} ${
          older ? "prior second" : "same second"
        }`,
        async () => {
          const f = await orchestrationRig();
          f.queue.config.mode = "on";
          f.rules({ status: "complete", value: true });
          f.advance(999);
          const entry = nativeEntry();
          if (older) entry.enqueuedAt -= 1000;
          if (!reconcile) f.onEnqueue(() => f.join(entry));
          await runHostedQueueCustody(f.deps, f.now() + 60000);
          if (reconcile) {
            f.join(entry);
            await runHostedQueueCustody(f.deps, f.now() + 60000);
          }
          assert.equal(
            f.state.repair!.work[0].intent?.resultId,
            older ? null : entry.id,
          );
          assert.equal(f.calls.filter((call) => call === "enqueue").length, 1);
        },
      );
    }
  }
});

Deno.test("queue provenance: completed or damaged namespace stays protected without reopening completed work", async () => {
  const f = await orchestrationRig();
  f.queue.config.proofActivated = false;
  const row = f.state.repair!.work[0];
  const completed = {
    ...row,
    nextStep: "done" as const,
    intent: null,
    wait: null,
    evidence: [
      {
        kind: "review_receipt" as const,
        ref: "artifact:review-receipt/merge-queue-v1/damaged",
      },
    ],
  };
  f.state.repair!.work = [completed];
  assert.equal(queueRecordProtected(completed), true);
  const result = await runHostedQueueCustody(f.deps, f.now() + 60000);
  assert.equal(result.ready, true);
  assert.ok(result.protectedRecordIds.has(row.id));
  assert.equal(f.state.repair!.work[0].wait, null);
  assert.equal(
    renderHostedParkSummary(f.state.repair!).includes(`| ${row.target.pr} |`),
    false,
  );
  assert.deepEqual(f.calls, ["rules"]);
});

Deno.test("queue effects: slow authorization cannot submit after the pass deadline", async (t) => {
  for (const operation of ["enqueue", "dequeue"] as const) {
    await t.step(operation, async () => {
      const f = await orchestrationRig();
      f.queue.config.mode = "on";
      f.rules({ status: "complete", value: true });
      if (operation === "dequeue") {
        f.onEnqueue(() => f.join());
        await runHostedQueueCustody(f.deps, f.now() + 60000);
        f.auth.pathsDisjoint = false;
      }
      const read = f.queue.authorization.readAuthorization;
      let reads = 0;
      f.queue.authorization.readAuthorization = async (request) => {
        const observed = await read(request);
        reads++;
        if (operation === "dequeue" || reads === 2) f.advance(60000);
        return observed;
      };
      const before = f.calls.filter((call) => call === operation).length;
      const result = await runHostedQueueCustody(f.deps, f.now() + 60000);
      assert.equal(result.ready, false);
      assert.equal(f.calls.filter((call) => call === operation).length, before);
    });
  }
});

Deno.test("queue dequeue: a competing head after marker readback revokes mutation authority", async () => {
  const f = await orchestrationRig();
  f.queue.config.mode = "on";
  f.rules({ status: "complete", value: true });
  f.onEnqueue(() => f.join());
  await runHostedQueueCustody(f.deps, f.now() + 60000);
  f.auth.pathsDisjoint = false;
  const read = f.state.readRepair.bind(f.state);
  let reads = 0;
  f.state.readRepair = async () => {
    const result = await read();
    reads++;
    // Prelude read, marker's before-read, marker readback; then a competing writer wins.
    if (reads === 3) {
      f.state.repairHead = "f".repeat(40) as typeof f.state.repairHead;
    }
    return result;
  };
  const result = await runHostedQueueCustody(f.deps, f.now() + 60000);
  assert.equal(result.ready, false);
  assert.equal(f.calls.includes("dequeue"), false);
  assert.equal(
    parseQueueIntent(f.state.repair!.work[0])?.stage,
    "dequeue_pending",
  );
  assert.equal(f.state.repair!.work[0].wait?.until, null);
});
