/**
 * m04-repair acceptance: focused actual loop tests with injected ports and
 * real temporary Git state/budget. Incident -> evidence -> intended before
 * failure -> fake bounded model candidate -> after pass -> deterministic PR ->
 * pending review -> other task progress -> next poll review -> exact merge ->
 * release request -> observed acceptance -> closure, with ambiguous/crash
 * injections proving reconciliation and zero duplicate starts. No model call,
 * no network, no credentials; workloads are seconds, never real waits.
 */
import assert from "node:assert/strict";

import { RollingStartBudget } from "../../src/budget/mod.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
} from "../../src/state/mod.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { candidateBranch, pushIntentKey } from "../../src/repair/keys.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import {
  DEP_0,
  DEP_2,
  incidentEvidence,
  incidentSummary,
  makeRemoteCtx,
  monitoredReleaseRecord,
  releaseRequest,
  SHA1,
  SHA2,
  SHA3,
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
  /\/tests\/repair\/loop_test\.ts$/,
  "",
);

const FINGERPRINT = "d".repeat(64);
const FINGERPRINT_B = "1".repeat(64);
const EVIDENCE_ID = "inc-a";
/** Second candidate head used by the P1 correction path. */
const SHA4 = "7f0b28dc5c6f8a1a2b3c4d5e6f7a8b9c0d1e2f3a" as GitSha;

function summaryFixture(): ReturnType<typeof incidentSummary> {
  return incidentSummary("inc-a", {
    fingerprint: FINGERPRINT,
    severity: "P1",
    failingRevision: SHA2,
    evidenceRef: {
      ref: `artifact://inbox/${EVIDENCE_ID}.pgp`,
      digest: "e".repeat(64),
    },
  });
}

function evidenceFixture(): ReturnType<typeof incidentEvidence> {
  return incidentEvidence("inc-a", {
    incidentId: "inc-a",
    fingerprint: FINGERPRINT,
    failingRevision: SHA2,
    replay: {
      fixtureRef: "fixture://sentinel/regression.json",
      fixtureDigest: "f".repeat(64) as never,
      upstreamCaptured: true,
      commandId: "replay_capture",
      reproducedAt: T0,
    },
  });
}

async function makeCtx(prefix: string) {
  const tmp = await Deno.makeTempDir({
    prefix: `sentinel-repair-test-${prefix}-`,
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

interface RigV1 {
  ctx: Awaited<ReturnType<typeof makeCtx>>;
  clock: FakeClock;
  store: ReturnType<typeof createRepairStateStore>;
  releaseStore: ReturnType<typeof createReleaseStateStore>;
  github: FakeGithub;
  incidents: FakeIncidents;
  replay: FakeReplay;
  model: FakeModel;
  run(deadlineMs?: number): Promise<Awaited<ReturnType<typeof runRepairCycle>>>;
  snapshot(): Promise<RepairStateSnapshotV1>;
  sequence(): Promise<number>;
  acceptRelease(requestId: string): Promise<void>;
}

async function makeRig(
  prefix: string,
  options: {
    summaries?: boolean;
    github?: ConstructorParameters<typeof FakeGithub>[0];
    model?: ConstructorParameters<typeof FakeModel>[0];
    replay?: ConstructorParameters<typeof FakeReplay>[0];
    configOverrides?: Record<string, unknown>;
  } = {},
): Promise<RigV1> {
  const ctx = await makeCtx(prefix);
  const clock = new FakeClock(T0);
  const store = createRepairStateStore({
    scratchDir: `${ctx.tmp}/scratch`,
    remoteUrl: ctx.remoteUrl,
  });
  const releaseStore = createReleaseStateStore({
    scratchDir: `${ctx.tmp}/release-scratch`,
    remoteUrl: ctx.remoteUrl,
  });
  const configs = repairConfigs({
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
    ...options.configOverrides,
  });
  const budget = new RollingStartBudget({ clock, state: store, configs });
  const github = new FakeGithub({ baseSha: SHA1, ...options.github });
  const incidents = new FakeIncidents({
    summaries: options.summaries === false ? [] : [summaryFixture()],
    evidence: options.summaries === false ? null : evidenceFixture(),
  });
  const replay = new FakeReplay(options.replay);
  const model = new FakeModel({
    head: SHA3,
    changedPaths: ["src/app.ts"],
    ...options.model,
  });
  const run = (deadlineMs = 600_000) =>
    runRepairCycle({
      clock,
      state: store,
      configs,
      controllerSha: SHA1,
      github,
      incidents,
      replay,
      model,
      budget,
    }, { deadline: clock.now() + deadlineMs, stepLimit: 16 });
  const snapshot = async () => {
    const read = await store.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (!read.ok || read.value.status !== "found") {
      throw new Error("no repair state");
    }
    return read.value.snapshot;
  };
  const sequence = async () => (await snapshot()).sequence;
  const acceptRelease = async (requestId: string) => {
    // Coherent accepted record bound to the exact candidate identity (SHA3).
    const releaseState: ReleaseStateSnapshotV1 = {
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0 + 2000,
      releases: [monitoredReleaseRecord("rel-1", "accepted", {
        requestId,
        requestRevision: SHA3,
        candidate: { identity: DEP_2, buildTransactionId: "txn-rel-1" },
        observed: {
          identity: DEP_2,
          domain: "https://ai.ubq.fi",
          verified: true,
          at: T0 + 3000,
        },
        acceptance: {
          identity: DEP_2,
          windowMs: 1800000,
          sampleIntervalMs: 30000,
          continuous: true,
          baseline: [{
            identity: DEP_0,
            windowStart: T0,
            windowEnd: T0 + 30_000,
            sampledAt: T0 + 30_000,
            domain: "https://ai.ubq.fi",
            requestCount: 1000,
            fiveXxCount: 0,
            timeoutCount: 0,
            streamFailureCount: 0,
            upstreamWideFault: false,
            coverage: { status: "complete" },
          }],
          samples: [{
            identity: DEP_2,
            windowStart: T0 + 33_000 - 30_000,
            windowEnd: T0 + 33_000,
            sampledAt: T0 + 33_000,
            domain: "https://ai.ubq.fi",
            requestCount: 100,
            fiveXxCount: 0,
            timeoutCount: 0,
            streamFailureCount: 0,
            upstreamWideFault: false,
            coverage: { status: "complete" },
          }],
          thresholdResults: [{
            metric: "five_xx_rate",
            observedRate: 0,
            baselineRate: 0,
            maxRate: 0.01,
            maxIncrease: 0.01,
            passed: true,
          }],
          passed: true,
        },
      })],
    };
    const written = await releaseStore.writeRelease(releaseState, null);
    assert.ok(written.ok && written.value.status === "applied");
  };
  return {
    ctx,
    clock,
    store,
    releaseStore,
    github,
    incidents,
    replay,
    model,
    run,
    snapshot,
    sequence,
    acceptRelease,
  };
}

Deno.test(
  "acceptance: incident through exact merge, release request, acceptance and closure",
  async () => {
    const rig = await makeRig("lifecycle");
    try {
      // Run 1: intake -> evidence -> before fail -> model -> after pass ->
      // PR -> review request -> review_pending wait.
      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));
      assert.equal(rig.model.requests.length, 1, "exactly one model start");
      let state = await rig.snapshot();
      assert.equal(state.work.length, 1);
      const work = state.work[0];
      assert.equal(work.nextStep, "review");
      assert.equal(work.wait?.reason, "review_pending");
      assert.equal(work.target.pr, 7);
      assert.equal(work.target.head, SHA3);
      assert.equal(work.counters.attempts, 1);
      assert.equal(state.replays.length, 1);
      const replayResult = state.replays[0];
      assert.equal(replayResult.original.revision, SHA2);
      assert.equal(replayResult.candidate.revision, SHA3);
      assert.equal(replayResult.original.outcome, "failed");
      assert.equal(replayResult.original.failure?.intended, true);
      assert.equal(replayResult.candidate.outcome, "passed");
      assert.equal(replayResult.limitations.length, 0);
      // One durable reservation per independently admitted start: the
      // implementation and the review request each charge the shared budget.
      assert.equal(state.reservations.length, 2);
      assert.deepEqual(
        state.reservations.map((reservation) => reservation.purpose),
        ["implementation", "review_request"],
      );
      assert.ok(
        state.reservations.every((reservation) =>
          reservation.outcome === "submitted"
        ),
        "implementation and review are both confirmed submitted",
      );
      assert.deepEqual(
        state.reservations.map((reservation) => reservation.taskId),
        [work.id, work.id],
      );
      assert.equal(rig.github.pushes.length, 1);
      assert.ok(rig.github.calls.includes("createPr"));
      assert.ok(rig.github.calls.includes("requestReview"));

      // Unchanged wait exit: no new model call, no state write.
      const sequenceBefore = await rig.sequence();
      const second = await rig.run();
      assert.equal(second.status, "idle", JSON.stringify(second));
      assert.equal(
        rig.model.requests.length,
        1,
        "observation is not an attempt",
      );
      assert.equal(
        await rig.sequence(),
        sequenceBefore,
        "unchanged wait exits without writes",
      );

      // Run 2 (after the review poll): completed review -> delivery -> merge
      // -> release request -> waiting for acceptance.
      rig.clock.advance(15 * 60_000 + 1);
      rig.github.completeReview([], rig.clock.now());
      const third = await rig.run();
      assert.equal(third.status, "idle", JSON.stringify(third));
      assert.equal(
        rig.github.calls.filter((call) => call === "merge").length,
        1,
      );
      state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "delivery");
      // The same run observes release state and, with no release snapshot yet,
      // waits for the release controller (exact request identity is held).
      assert.equal(state.work[0].wait?.reason, "unavailable");
      assert.equal(state.releaseRequests.length, 1);
      assert.equal(state.releaseRequests[0].revision, SHA3);
      assert.equal(state.releaseRequests[0].source.pullRequest, 7);

      // Run 3: release snapshot reports accepted completion; an incident task
      // has no issue to close, so the record becomes terminal.
      const requestId = state.releaseRequests[0].id;
      await rig.acceptRelease(requestId);
      rig.clock.advance(5 * 60_000 + 1);
      const fourth = await rig.run();
      assert.equal(fourth.status, "idle", JSON.stringify(fourth));
      state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "done");
      assert.equal(
        rig.github.calls.some((call) => call.startsWith("closeIssue:")),
        false,
        "incident tasks have no issue to close",
      );
      assert.equal(rig.model.requests.length, 1, "unchanged model starts");

      // Terminal records stay terminal with immutable identities.
      const done = state.work[0];
      const fifth = await rig.run();
      assert.equal(fifth.status, "idle", JSON.stringify(fifth));
      state = await rig.snapshot();
      assert.deepEqual(
        {
          id: done.id,
          fingerprint: done.fingerprint,
          failingRevision: done.failingRevision,
          controller: done.controller,
        },
        {
          id: state.work[0].id,
          fingerprint: state.work[0].fingerprint,
          failingRevision: state.work[0].failingRevision,
          controller: state.work[0].controller,
        },
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test("a second eligible task advances while the first review waits", async () => {
  const rig = await makeRig("secondtask");
  try {
    // Run 1: the first incident reaches the review wait with one model start.
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    assert.equal(rig.model.requests.length, 1);
    let state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "review");
    assert.equal(state.work[0].wait?.reason, "review_pending");
    assert.equal(state.work[0].target.head, SHA3);

    // A second incident arrives while the first review is pending: the same
    // single writer advances it through its own implementation, publication
    // and review request — never a second parallel model call.
    rig.incidents.setSummaries([
      summaryFixture(),
      incidentSummary("inc-b", {
        fingerprint: FINGERPRINT_B,
        severity: "P2",
        failingRevision: SHA2,
        evidenceRef: {
          ref: "artifact://inbox/inc-b.pgp",
          digest: "2".repeat(64),
        },
      }),
    ]);
    rig.incidents.setEvidence([
      evidenceFixture(),
      incidentEvidence("inc-b", {
        incidentId: "inc-b",
        fingerprint: FINGERPRINT_B,
        failingRevision: SHA2,
        replay: {
          fixtureRef: "fixture://sentinel/b.json",
          fixtureDigest: "3".repeat(64) as never,
          upstreamCaptured: true,
          commandId: "replay_capture",
          reproducedAt: T0,
        },
      }),
    ]);
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(
      rig.model.requests.length,
      2,
      "sequential starts, never parallel",
    );
    state = await rig.snapshot();
    const secondRecord = state.work.find((record) =>
      record.fingerprint === FINGERPRINT_B
    );
    assert.ok(secondRecord, "second work record exists");
    assert.equal(secondRecord?.nextStep, "review");
    assert.equal(secondRecord?.wait?.reason, "review_pending");
    assert.equal(
      state.reservations.filter((reservation) =>
        reservation.outcome === "submitted"
      ).length,
      4,
      "implementation + review for both tasks are charged",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      2,
    );
    // The first task is untouched: exact candidate identity preserved.
    const firstRecord = state.work.find((record) =>
      record.fingerprint === FINGERPRINT
    );
    assert.equal(firstRecord?.nextStep, "review");
    assert.equal(firstRecord?.target.head, SHA3);
    assert.equal(firstRecord?.counters.reviewRounds, 1);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("ambiguous push and review request reconcile without duplicate starts", async () => {
  const rig = await makeRig("ambiguous", {
    github: { pushOutcome: "ambiguous", reviewRequestOutcome: "ambiguous" },
  });
  try {
    // The lost push response reconcile in-run: exact ref present -> branch
    // updated once -> PR published -> ambiguous review request reconciled by
    // observation, ending in the single review_pending wait.
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    assert.equal(rig.model.requests.length, 1, "model ran exactly once");
    let state = await rig.snapshot();
    assert.equal(state.work[0].target.pr, 7);
    assert.equal(state.work[0].target.head, SHA3);
    assert.equal(state.work[0].nextStep, "review");
    assert.equal(state.work[0].wait?.reason, "review_pending");
    assert.equal(state.work[0].intent?.kind, "review_request");
    assert.ok(
      state.reservations.some((reservation) =>
        reservation.purpose === "review_request" &&
        reservation.outcome === "ambiguous"
      ),
      "ambiguous review charge is preserved",
    );

    // Next run: no re-push, no duplicate model start, no resubmission; the
    // pending review intent is observed, not re-requested.
    const pushesBefore = rig.github.pushes.length;
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(rig.github.pushes.length, pushesBefore, "no re-push");
    assert.equal(rig.model.requests.length, 1, "no duplicate model start");
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
      "single review request",
    );

    // Review request ambiguity already reconciled by observation (one pending
    // request per head); the review wait advances exactly once.
    rig.clock.advance(15 * 60_000 + 1);
    const third = await rig.run();
    assert.equal(third.status, "idle", JSON.stringify(third));
    state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "review");
    assert.equal(state.work[0].wait?.reason, "review_pending");
    assert.equal(rig.model.requests.length, 1);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("successful push reconciliation continues publication", async () => {
  const rig = await makeRig("pushcontinue", {
    summaries: false,
    github: { branchRefSha: SHA3 },
  });
  try {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    const work = workRecord("issue-1", {
      source: { kind: "issue", id: "1", revision: SHA1 },
      related: { incidentId: null, issueNumber: 1 },
      target: { base: SHA1, branch, checkpoint: null, head: SHA3, pr: 7 },
      nextStep: "work",
      intent: {
        kind: "push",
        key: pushIntentKey(SHA3),
        startedAt: T0,
        branch,
        expectedHead: SHA3,
        observedBase: SHA1,
        pr: null,
        requestId: null,
        resultId: null,
      },
      updatedAt: T0,
    });
    const seeded = await rig.store.writeRepair(seededSnapshot([work]), null);
    assert.ok(seeded.ok && seeded.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "review");
    assert.equal(state.work[0].wait?.reason, "review_pending");
    assert.equal(state.work[0].intent, null);
    assert.equal(
      rig.github.pushes.length,
      0,
      "an already successful push is never repeated",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "createPr").length,
      0,
      "an existing PR is not published again",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
      "publication continues with exactly one review request",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test(
  "protected directory prefixes are normalized before candidate path checks",
  async () => {
    const rig = await makeRig("protectedprefix", {
      configOverrides: { protectedPaths: ["./src/handler/"] },
      model: { changedPaths: ["src/handler/file.ts"] },
    });
    try {
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "blocked");
      assert.equal(state.work[0].blocker?.kind, "other");
      assert.equal(rig.github.pushes.length, 0);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test("review receipt preserves the actual submission timestamp", async () => {
  const submittedAt = T0 - 60_000;
  const rig = await makeRig("reviewtimestamp", {
    github: { reviewRequestedAt: submittedAt },
  });
  try {
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    let state = await rig.snapshot();
    assert.equal(state.work[0].wait?.since, submittedAt);

    rig.clock.advance(15 * 60_000 + 1);
    rig.github.completeReview([], rig.clock.now());
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    state = await rig.snapshot();
    assert.equal(state.reviews.length, 1);
    assert.equal(state.reviews[0].submittedAt, submittedAt);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("duplicate unresolved review severities are normalized before parsing", async () => {
  const rig = await makeRig("reviewseverity", {
    model: { heads: [SHA3, SHA4] },
  });
  try {
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    rig.clock.advance(15 * 60_000 + 1);
    rig.github.completeReview([
      {
        id: "finding-p1-a",
        severity: "P1",
        path: "src/app.ts",
        message: "first required fix",
        fingerprint: "b".repeat(64),
        resolved: false,
        resolutionEvidence: null,
      },
      {
        id: "finding-p1-b",
        severity: "P1",
        path: "src/app.ts",
        message: "second required fix",
        fingerprint: "c".repeat(64),
        resolved: false,
        resolutionEvidence: null,
      },
    ], rig.clock.now());
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    const state = await rig.snapshot();
    assert.equal(state.reviews.length, 1);
    assert.deepEqual(state.reviews[0].unresolvedSeverities, ["P1"]);
    assert.equal(state.work[0].nextStep, "review");
    assert.equal(state.work[0].target.head, SHA4);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("model uncertainty stays charged ambiguous and never resubmits", async () => {
  const rig = await makeRig("uncertain", {
    model: { portError: true },
  });
  try {
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    let state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "blocked");
    assert.equal(state.reservations.length, 1);
    assert.equal(state.reservations[0].outcome, "ambiguous");
    assert.ok(state.reservations[0].settledAt !== null);
    assert.equal(rig.model.requests.length, 1);

    // Never resubmit: subsequent runs leave the record blocked and unchanged.
    const sequenceBefore = await rig.sequence();
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(rig.model.requests.length, 1);
    assert.equal(await rig.sequence(), sequenceBefore);
    state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "blocked");
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("rolling budget caps share model starts and review requests", async () => {
  const rig = await makeRig("sharedcap", {
    configOverrides: { liveStartLimits: { perHour: 1, perSevenDays: 5 } },
  });
  try {
    // The first task's implementation consumes the single hour-window start;
    // its review request is the same shared budget and must defer, proving
    // there is no GitHubPort budget bypass.
    const run1 = await rig.run();
    assert.equal(run1.status, "idle", JSON.stringify(run1));
    assert.equal(rig.model.requests.length, 1);
    let state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "work");
    assert.equal(
      state.work[0].target.pr,
      7,
      "PR published before the review wait",
    );
    assert.equal(state.work[0].wait?.reason, "budget_cap");
    assert.ok((state.work[0].wait?.until ?? 0) > T0, "explicit retryAt");
    assert.equal(state.reservations.length, 1);
    assert.equal(state.reservations[0].purpose, "implementation");
    assert.equal(state.reservations[0].outcome, "submitted");
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      0,
      "review request is never invoked at the shared cap",
    );

    // A second distinct incident arrives while the window is full.
    rig.incidents.setSummaries([
      summaryFixture(),
      incidentSummary("inc-b", {
        fingerprint: FINGERPRINT_B,
        severity: "P2",
        failingRevision: SHA2,
        evidenceRef: {
          ref: "artifact://inbox/inc-b.pgp",
          digest: "2".repeat(64),
        },
      }),
    ]);
    rig.incidents.setEvidence([
      evidenceFixture(),
      incidentEvidence("inc-b", {
        incidentId: "inc-b",
        fingerprint: FINGERPRINT_B,
        failingRevision: SHA2,
        replay: {
          fixtureRef: "fixture://sentinel/b.json",
          fixtureDigest: "3".repeat(64) as never,
          upstreamCaptured: true,
          commandId: "replay_capture",
          reproducedAt: T0,
        },
      }),
    ]);
    const run2 = await rig.run();
    assert.equal(run2.status, "idle", JSON.stringify(run2));
    assert.equal(rig.model.requests.length, 1, "no model start at cap");
    state = await rig.snapshot();
    const second = state.work.find((record) =>
      record.fingerprint === FINGERPRINT_B
    );
    assert.ok(second, "second work record exists");
    assert.equal(second?.wait?.reason, "budget_cap");
    assert.ok((second?.wait?.until ?? 0) > T0, "explicit retryAt");
    assert.equal(state.reservations.length, 1, "no charge was ever deferred");

    // After the rolling hour the first task's review request is admitted
    // (its implementation charge fell out of the window); the single hourly
    // slot is consumed again, so the second task's implementation must defer
    // and no second model start happens.
    rig.clock.advance(3_600_000 + 1000);
    const run3 = await rig.run();
    assert.equal(run3.status, "idle", JSON.stringify(run3));
    assert.equal(
      rig.model.requests.length,
      1,
      "no second model at the shared cap",
    );
    state = await rig.snapshot();
    const firstAfter = state.work.find((record) =>
      record.fingerprint === FINGERPRINT
    );
    assert.ok(firstAfter, "first work record still exists");
    assert.equal(firstAfter?.nextStep, "review");
    assert.equal(firstAfter?.wait?.reason, "review_pending");
    const secondStill = state.work.find((record) =>
      record.fingerprint === FINGERPRINT_B
    );
    assert.equal(
      secondStill?.wait?.reason,
      "budget_cap",
      "task still deferred",
    );
    assert.equal(
      state.reservations.filter((reservation) =>
        reservation.outcome === "submitted"
      ).length,
      2,
      "implementation + review charged, one per hourly slot",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
      "the first review request is admitted exactly once",
    );

    // Another hour releases the slot: the second task implements and
    // publishes; its review request then defers again on the shared cap.
    rig.clock.advance(3_600_000 + 1000);
    const run4 = await rig.run();
    assert.equal(run4.status, "idle", JSON.stringify(run4));
    assert.equal(rig.model.requests.length, 2, "admission after cap release");
    state = await rig.snapshot();
    const secondAfter = state.work.find((record) =>
      record.fingerprint === FINGERPRINT_B
    );
    assert.ok(secondAfter, "second work record still exists");
    assert.equal(secondAfter?.nextStep, "work");
    assert.equal(
      secondAfter?.target.pr,
      7,
      "second PR published before its review wait",
    );
    assert.equal(secondAfter?.wait?.reason, "budget_cap");
    assert.equal(
      state.reservations.filter((reservation) =>
        reservation.outcome === "submitted"
      ).length,
      3,
      "implementation + review + implementation are each charged",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
      "only the first review request was admitted; the second stays deferred",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("review request ambiguous/failed stays charged once and never resubmits", async () => {
  // Lost response (ambiguous submission): charged ambiguous with the intent
  // preserved; recovery observes, never resubmits, and adds no second charge.
  const rig = await makeRig("reviewlost", {
    github: { reviewRequestOutcome: "ambiguous" },
  });
  try {
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
    );
    let state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "review");
    assert.equal(state.work[0].wait?.reason, "review_pending");
    assert.equal(state.work[0].intent?.kind, "review_request");
    assert.equal(state.reservations.length, 2);
    const review = state.reservations.find((reservation) =>
      reservation.purpose === "review_request"
    );
    assert.ok(review, "review admission reservation exists");
    assert.equal(review?.outcome, "ambiguous");
    assert.ok(review?.settledAt !== null, "ambiguous charge is settled");

    // Recovery observes the exact remote review state: no resubmission, no
    // second charge.
    rig.clock.advance(15 * 60_000 + 1);
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
      "observation never resubmits",
    );
    state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "review");
    assert.equal(state.reservations.length, 2, "no second review charge");

    // The pending observation ends in the normal accepted flow.
    rig.clock.advance(15 * 60_000 + 1);
    rig.github.completeReview([], rig.clock.now());
    const third = await rig.run();
    assert.equal(third.status, "idle", JSON.stringify(third));
    state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "delivery");
  } finally {
    await rig.ctx.cleanup();
  }

  // Transport loss immediately after admission: identical one-charge
  // recovery; the saved observation intent is never resubmitted.
  const rig2 = await makeRig("reviewfail", {
    github: { reviewRequestFailNext: true },
  });
  try {
    const first = await rig2.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    assert.equal(
      rig2.github.calls.filter((call) => call === "requestReview").length,
      1,
    );
    const state = await rig2.snapshot();
    assert.equal(state.work[0].nextStep, "review");
    assert.equal(state.work[0].intent?.kind, "review_request");
    assert.equal(state.reservations.length, 2);
    const review = state.reservations.find((reservation) =>
      reservation.purpose === "review_request"
    );
    assert.equal(review?.outcome, "ambiguous");
    assert.ok(review?.settledAt !== null);

    rig2.clock.advance(15 * 60_000 + 1);
    const second = await rig2.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(
      rig2.github.calls.filter((call) => call === "requestReview").length,
      1,
      "never resubmits",
    );
    assert.equal(
      (await rig2.snapshot()).reservations.length,
      2,
      "no second charge",
    );
  } finally {
    await rig2.ctx.cleanup();
  }
});

Deno.test("P1 findings trigger a fresh bounded implementation/candidate/replay path", async () => {
  const rig = await makeRig("p1fresh", {
    model: { heads: [SHA3, SHA4] },
  });
  try {
    // Run 1: the first candidate (SHA3) reaches the review wait.
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    assert.equal(rig.model.requests.length, 1);
    let state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "review");
    assert.equal(state.work[0].target.head, SHA3);

    // A P1 finding arrives on the observed head: it never merges and never
    // re-requests a review of the SAME rejected candidate. Instead the record
    // forgets the rejected head and runs a fresh bounded implementation,
    // validates the new candidate through the replay path and only then
    // updates the same PR and requests a review of the NEW head.
    rig.clock.advance(15 * 60_000 + 1);
    rig.github.completeReview([{
      id: "finding-1",
      severity: "P1",
      path: "src/app.ts",
      message: "required fix",
      fingerprint: "a".repeat(64),
      resolved: false,
      resolutionEvidence: null,
    }], rig.clock.now());
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(
      rig.model.requests.length,
      2,
      "a P1 finding opens exactly one fresh implementation",
    );
    state = await rig.snapshot();
    const work = state.work[0];
    assert.equal(work.nextStep, "review");
    assert.equal(work.target.head, SHA4, "corrected candidate head");
    assert.equal(work.target.pr, 7, "correction lands on the same PR");
    assert.equal(work.counters.attempts, 2);
    assert.equal(work.counters.reviewRounds, 2, "fresh correction round");
    assert.equal(
      rig.github.calls.includes("merge"),
      false,
      "P1 must never merge",
    );
    // The new candidate went through the before/after replay path with exact
    // original + candidate identities (a fresh candidate, not the old one).
    assert.equal(state.replays.length, 2);
    const newer = state.replays.find(
      (result) => result.candidate.revision === SHA4,
    );
    assert.ok(newer, "fresh candidate has a durable replay result");
    assert.equal(newer?.candidate.outcome, "passed");
    assert.equal(newer?.original.revision, SHA2);
    assert.equal(newer?.original.outcome, "failed");
    assert.equal(newer?.original.failure?.intended, true);
    // The corrected head is pushed onto the same branch and requested for
    // review once; no duplicate PR is created.
    assert.deepEqual(
      rig.github.pushes.map((push) => push.sha),
      [SHA3, SHA4],
      "new head pushed once to the existing branch",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "createPr").length,
      1,
      "no duplicate PR publication",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      2,
      "one review request per corrected head",
    );
    assert.equal(
      state.reservations.filter((reservation) =>
        reservation.outcome === "submitted"
      ).length,
      4,
      "implementation + review + retry implementation + correction review are each charged once",
    );
    // The rejected head is not silently forgotten: the review receipt remains
    // attached as evidence and the P1 finding is recorded.
    assert.ok(
      work.evidence.some((ref) => ref.kind === "review_receipt"),
      "P1 review receipt is retained as evidence",
    );
    assert.ok(
      state.reviews.some((review) =>
        review.outcome === "completed" &&
        review.unresolvedSeverities.includes("P1")
      ),
      "P1 finding is durably recorded",
    );
  } finally {
    await rig.ctx.cleanup();
  }

  // No-verdict review observation keeps waiting (not an attempt or request).
  const rig3 = await makeRig("noverdict", {
    github: { reviewUnavailable: true },
  });
  try {
    await rig3.run();
    rig3.clock.advance(15 * 60_000 + 1);
    const before = rig3.model.requests.length;
    const reviewed = await rig3.run();
    assert.equal(reviewed.status, "idle", JSON.stringify(reviewed));
    const state3 = await rig3.snapshot();
    assert.ok(
      state3.work[0].wait?.reason === "review_pending" ||
        state3.work[0].wait?.reason === "unavailable",
    );
    assert.equal(rig3.model.requests.length, before);
  } finally {
    await rig3.ctx.cleanup();
  }

  // Protected path: candidate blocked before any publication.
  const rig4 = await makeRig("protected", {
    model: { changedPaths: ["src/handler.ts"] },
  });
  try {
    await rig4.run();
    const state4 = await rig4.snapshot();
    assert.equal(state4.work[0].nextStep, "blocked");
    assert.equal(rig4.github.pushes.length, 0);
    assert.equal(state4.reservations[0].outcome, "submitted", "charged");
  } finally {
    await rig4.ctx.cleanup();
  }
});

Deno.test(
  "open GitHub issue intake creates one deterministic record and deduplicates repeated rows",
  async () => {
    const rig = await makeRig("issueintake", {
      summaries: false,
      github: {
        openIssues: [
          {
            number: 42,
            title: "repair the failing request",
            labels: ["P1", "priority:9"],
            createdAt: T0 - 300,
          },
          {
            number: 42,
            title: "duplicate listing with different metadata",
            labels: ["P2"],
            createdAt: T0 - 200,
          },
          {
            number: 43,
            title: "closed issue is not intake work",
            state: "closed",
            createdAt: T0 - 100,
          },
        ],
      },
    });
    try {
      // Keep the first run at intake so the assertion covers the durable
      // record creation without spending a model start on the new issue.
      const first = await rig.run(1);
      assert.equal(first.status, "margin", JSON.stringify(first));
      let state = await rig.snapshot();
      assert.equal(state.incidents.length, 0);
      assert.equal(state.work.length, 1);
      const issue = state.work[0];
      assert.equal(issue.source.kind, "issue");
      assert.equal(issue.source.id, "42");
      assert.equal(issue.related.issueNumber, 42);
      assert.equal(issue.source.revision, SHA1);
      assert.equal(issue.target.base, SHA1);
      assert.deepEqual(issue.classification, {
        severity: "P1",
        priority: 9,
      });
      assert.equal(rig.model.requests.length, 0);
      assert.equal(
        rig.github.calls.filter((call) => call === "listOpenIssues").length,
        1,
      );
      assert.equal(
        rig.github.calls.filter((call) =>
          call === "readRef:refs/heads/development"
        ).length,
        1,
        "base is read once for the repository",
      );

      // The same open issue is observed again, including the duplicate row,
      // but its deterministic repository/number identity prevents a second
      // record or a second checkpoint.
      const sequence = state.sequence;
      const second = await rig.run(1);
      assert.equal(second.status, "margin", JSON.stringify(second));
      state = await rig.snapshot();
      assert.equal(state.sequence, sequence);
      assert.equal(state.work.length, 1);
      assert.equal(state.work[0].id, issue.id);
      assert.equal(rig.model.requests.length, 0);
      assert.equal(
        rig.github.calls.filter((call) => call === "listOpenIssues").length,
        2,
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test("closure failure retries closure only", async () => {
  // Closure applies to issue tasks; seed an issue work record (no incidents).
  const rig = await makeRig("closure", {
    summaries: false,
    github: {
      closeFailNext: true,
      issues: [{ number: 1, title: "reproducible failure", body: "body" }],
    },
  });
  try {
    const seed: RepairStateSnapshotV1 = {
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0,
      incidents: [],
      evidence: [],
      work: [workRecord("issue-1")],
      reservations: [],
      reviews: [],
      replays: [],
      releaseRequests: [],
    };
    const seeded = await rig.store.writeRepair(seed, null);
    assert.ok(seeded.ok && seeded.value.status === "applied");

    await rig.run();
    rig.clock.advance(15 * 60_000 + 1);
    rig.github.completeReview([], rig.clock.now());
    await rig.run();
    const state = await rig.snapshot();
    await rig.acceptRelease(state.releaseRequests[0].id);
    rig.clock.advance(5 * 60_000 + 1);
    await rig.run();

    let current = await rig.snapshot();
    assert.equal(current.work[0].nextStep, "delivery");
    assert.equal(current.work[0].intent?.kind, "issue_closure");
    const closeCallsBefore = rig.github.calls.filter((call) =>
      call.startsWith("closeIssue:")
    ).length;
    assert.equal(closeCallsBefore, 1);

    // Retry is closure-only: no merge/release/model repeats.
    rig.clock.advance(5 * 60_000 + 1);
    const retried = await rig.run();
    assert.equal(retried.status, "idle", JSON.stringify(retried));
    current = await rig.snapshot();
    assert.equal(current.work[0].nextStep, "done");
    const closeCallsAfter = rig.github.calls.filter((call) =>
      call.startsWith("closeIssue:")
    ).length;
    assert.equal(closeCallsAfter, 2);
    assert.equal(rig.github.calls.filter((call) => call === "merge").length, 1);
    assert.equal(rig.model.requests.length, 1);
  } finally {
    await rig.ctx.cleanup();
  }
});

/** Seeded snapshot for focused delivery/merge cases (sequence 1). */
function seededSnapshot(
  work: WorkRecordV1[],
  extra: Partial<RepairStateSnapshotV1> = {},
): RepairStateSnapshotV1 {
  return {
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
    ...extra,
  };
}

Deno.test("retained expired incident evidence blocks before replay", async () => {
  const rig = await makeRig("expired-retained", { summaries: false });
  try {
    const retained = evidenceFixture();
    const expiredEvidence = {
      ...retained,
      artifacts: retained.artifacts.map((artifact) => ({
        ...artifact,
        expiresAt: T0,
      })),
    };
    const taskId = asWorkItemId("expired-retained");
    const seed = seededSnapshot([
      workRecord("expired-retained", {
        source: { kind: "incident", id: "inc-a", revision: SHA2 },
        related: { incidentId: "inc-a", issueNumber: null },
        fingerprint: FINGERPRINT,
        failingRevision: SHA2,
        target: {
          base: SHA1,
          branch: candidateBranch(taskId),
          checkpoint: null,
          head: null,
          pr: null,
        },
      }),
    ], {
      incidents: [summaryFixture()],
      evidence: [expiredEvidence],
    });
    const written = await rig.store.writeRepair(seed, null);
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "blocked");
    assert.equal(state.work[0].blocker?.kind, "evidence_expired");
    assert.equal(state.work[0].blocker?.message, "incident artifact expired");
    assert.equal(rig.replay.requests.length, 0);
    assert.equal(rig.model.requests.length, 0);
  } finally {
    await rig.ctx.cleanup();
  }
});

/** Issue task in the delivery phase with the given reviewed head and PR. */
function deliveryRecord(
  head: GitSha,
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return workRecord("issue-1", {
    source: { kind: "issue", id: "1", revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    target: {
      base: SHA1,
      branch: "sentinel/repair/issue-1",
      checkpoint: null,
      head,
      pr: 7,
    },
    nextStep: "delivery",
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    ...overrides,
  });
}

/** Completed clean review receipt bound to the exact reviewed PR/head/base. */
function completedReceipt(
  pullRequest: number,
  head: GitSha,
  base: GitSha,
  overrides: Record<string, unknown> = {},
): ReviewReceiptV1 {
  return parseReviewReceiptV1({
    version: "v1",
    kind: "review_receipt",
    id: `review-receipt:${pullRequest}:${head}`,
    requestId: "review-req-1",
    expectedReviewer: "chatgpt-codex-connector[bot]",
    observedReviewer: "chatgpt-codex-connector[bot]",
    repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 7 },
    pullRequest: { number: pullRequest, head, base },
    outcome: "completed",
    resultId: "result-1",
    summary: null,
    findings: [],
    findingsUncounted: 0,
    unresolvedSeverities: [],
    submittedAt: T0,
    completedAt: T0 + 1000,
    observedAt: T0 + 1001,
    ...overrides,
  });
}

Deno.test("merge reconciliation rejects an observed merged head different from the reviewed head", async () => {
  const rig = await makeRig("mergehead", {
    summaries: false,
    github: {
      // The PR was merged, but at a head this task never reviewed (SHA2).
      pullRequest: { state: "merged", head: SHA2, mergeSha: SHA2 },
    },
  });
  try {
    const seed = seededSnapshot([deliveryRecord(SHA3, {
      intent: {
        kind: "merge",
        key: `merge:7:${SHA3}`,
        startedAt: T0,
        branch: "sentinel/repair/issue-1",
        expectedHead: SHA3,
        observedBase: SHA1,
        pr: 7,
        requestId: "review-req-1",
        resultId: "result-1",
      },
    })]);
    const written = await rig.store.writeRepair(seed, null);
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(
      state.work[0].nextStep,
      "blocked",
      "a mismatched merged head fails closed",
    );
    assert.equal(
      state.work[0].blocker?.message,
      "observed merged head identity mismatch",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "merge").length,
      0,
      "no merge is retried after the contradiction",
    );
    assert.equal(
      state.releaseRequests.length,
      0,
      "no release request is fabricated for the wrong merged head",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("delivery matches an existing release request by source PR/head and retains the merged revision", async () => {
  const rig = await makeRig("rrlookup", { summaries: false });
  try {
    const seed = seededSnapshot(
      [deliveryRecord(SHA3)],
      {
        releaseRequests: [releaseRequest("release-7", {
          // Merged revision differs from the reviewed head: the lookup must
          // NOT match on `revision` — it matches source PR/head instead.
          revision: SHA2,
          source: {
            pullRequest: 7,
            reviewRequestId: "review-req-1",
            reviewReceiptId: null,
            head: SHA3,
            base: SHA1,
          },
        })],
      },
    );
    const written = await rig.store.writeRepair(seed, null);
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(
      rig.github.calls.filter((call) => call === "merge").length,
      0,
      "the existing release request suspends a new merge",
    );
    assert.equal(
      state.releaseRequests.length,
      1,
      "no duplicate release request is created",
    );
    assert.equal(
      state.releaseRequests[0].revision,
      SHA2,
      "the merged revision is retained inside the matched request",
    );
    assert.equal(
      state.releaseRequests[0].source.head,
      SHA3,
      "the source PR/head identity matched the saved reviewed head",
    );
    assert.equal(state.work[0].nextStep, "delivery");
    assert.equal(
      state.work[0].wait?.reason,
      "unavailable",
      "waits for release acceptance of the exact matched request",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("merged-but-ambiguous merge reconciliation builds one release request with the merged revision", async () => {
  const rig = await makeRig("rrmissing", {
    summaries: false,
    github: {
      // Direct merge response lost; the remote then shows the exact merged
      // head this task reviewed, with a distinct merge SHA.
      mergeOutcome: { outcome: "ambiguous", head: null, mergeSha: null },
      pullRequest: { state: "merged", head: SHA3, mergeSha: SHA2 },
    },
  });
  try {
    const seed = seededSnapshot(
      [deliveryRecord(SHA3)],
      {
        reviews: [completedReceipt(7, SHA3, SHA1)],
      },
    );
    const written = await rig.store.writeRepair(seed, null);
    assert.ok(written.ok && written.value.status === "applied");

    // The same bounded run first attempts the merge (ambiguous), then
    // reconciles by observing the merged PR and builds the release request.
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    assert.equal(
      rig.github.calls.filter((call) => call === "merge").length,
      1,
      "exactly one merge attempt, reconciled by observation",
    );
    let state = await rig.snapshot();
    assert.equal(state.releaseRequests.length, 1);
    assert.equal(state.work[0].intent, null, "merge intent reconciled");
    assert.equal(
      state.releaseRequests[0].revision,
      SHA2,
      "request revision is the exact merged revision",
    );
    assert.equal(
      state.releaseRequests[0].source.head,
      SHA3,
      "request source head is the reviewed candidate head",
    );
    assert.equal(state.releaseRequests[0].source.pullRequest, 7);

    // A later run observes the exact matched request: no blind re-merge, no
    // duplicate request.
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    state = await rig.snapshot();
    assert.equal(
      rig.github.calls.filter((call) => call === "merge").length,
      1,
      "no re-merge while the request is open",
    );
    assert.equal(state.releaseRequests.length, 1);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("existing-PR corrections are not blocked by the unfinished-PR cap", async () => {
  const rig = await makeRig("expricap", {
    summaries: false,
    github: { branchRefSha: SHA3 },
  });
  try {
    const openPrRecords: WorkRecordV1[] = Array.from(
      { length: 3 },
      (_, index) =>
        workRecord(`issue-${index + 100}`, {
          source: { kind: "issue", id: `${index + 100}`, revision: SHA1 },
          related: {
            incidentId: null,
            issueNumber: index + 100,
          },
          nextStep: "review",
          wait: {
            reason: "review_pending",
            since: T0,
            until: T0 + 3600_000,
          },
          target: {
            base: SHA1,
            branch: `sentinel/repair/issue-${index + 100}`,
            checkpoint: null,
            head: SHA2,
            pr: 20 + index,
          },
        }),
    );
    const correction = workRecord("issue-1", {
      source: { kind: "issue", id: "1", revision: SHA1 },
      related: { incidentId: null, issueNumber: 1 },
      classification: { severity: "P2", priority: 9 },
      target: {
        base: SHA1,
        branch: "sentinel/repair/issue-1",
        checkpoint: null,
        head: SHA3,
        pr: 7,
      },
      nextStep: "work",
      counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    });
    const seed = seededSnapshot([...openPrRecords, correction]);
    const written = await rig.store.writeRepair(seed, null);
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    const corrected = state.work.find((record) => record.id === correction.id);
    assert.ok(corrected, "correction record exists");
    assert.equal(
      corrected?.nextStep,
      "review",
      "the correction published and requested its own review",
    );
    assert.equal(corrected?.target.head, SHA3);
    assert.equal(
      rig.github.pushes.length,
      1,
      "the corrected head was pushed to its existing branch",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
      "one review request for the corrected head",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "createPr").length,
      0,
      "no new PR is published",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});
