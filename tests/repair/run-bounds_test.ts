/**
 * m04-repair run-bound acceptance: the plan §4 fixed 120-minute run ceiling,
 * the 90-minute no-new-model-work cutoff (implementation starts AND review
 * requests, rejected before any reservation) and the per-operation margin
 * rule, exercised through the ACTUAL runRepairCycle consumer with fake-clock
 * fakes. Deterministic observation/publication must continue while a
 * higher-ranked model action is deferred; nothing starts after the total
 * deadline. No model call, no network, no credentials; MemoryState mirrors the
 * real GitStateStore transition rules.
 */
import assert from "node:assert/strict";

import { RollingStartBudget } from "../../src/budget/mod.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  GitHubPullRequestV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import {
  REPAIR_MODEL_CUTOFF_MS,
  REPAIR_RUN_CEILING_MS,
  runRepairCycle,
} from "../../src/repair/loop.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import type { FakeGithubOptionsV1, FakeReplayOptionsV1 } from "./helpers.ts";
import {
  AdvancingFakeGithub,
  AdvancingFakeReplay,
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";
import {
  incidentEvidence,
  incidentSummary,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";

const MINUTE = 60_000;
const FINGERPRINT = "d".repeat(64);
const EVIDENCE_ID = "inc-a";

function summaryFixture() {
  return incidentSummary(EVIDENCE_ID, {
    fingerprint: FINGERPRINT,
    severity: "P1",
    failingRevision: SHA2,
    evidenceRef: {
      ref: `artifact://inbox/${EVIDENCE_ID}.pgp`,
      digest: "e".repeat(64),
    },
  });
}

function evidenceFixture() {
  return incidentEvidence(EVIDENCE_ID, {
    incidentId: EVIDENCE_ID,
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

interface RigV1 {
  clock: FakeClock;
  state: MemoryState;
  github: FakeGithub;
  incidents: FakeIncidents;
  replay: FakeReplay;
  model: FakeModel;
  run(deadlineMs?: number): Promise<Awaited<ReturnType<typeof runRepairCycle>>>;
  snapshot(): Promise<RepairStateSnapshotV1>;
}

function makeRig(
  options: {
    github?: FakeGithubOptionsV1;
    replay?: FakeReplayOptionsV1;
    /** Advance the clock when the before-run replay executes. */
    replayAdvanceMs?: number;
    /** Advance the clock when a candidate push succeeds. */
    githubAdvanceMs?: number;
    /** Advance the clock once when a remote PR lookup by head ref executes. */
    findPrAdvanceMs?: number;
    /** Advance the clock once when a merge-gate PR read executes. */
    readPrAdvanceMs?: number;
    /** Incident summary/evidence source for intake-created records. */
    incidents?: boolean;
  } = {},
): RigV1 {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  const githubCooldown = new DurableGitHubCooldownGate({ state, clock });
  const configs = repairConfigs({
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  });
  const budget = new RollingStartBudget({ clock, state, configs });
  const githubOptions: FakeGithubOptionsV1 = {
    baseSha: SHA1,
    branchRefSha: SHA3,
    ...options.github,
  };
  const github = options.githubAdvanceMs !== undefined
    ? new AdvancingFakeGithub(clock, options.githubAdvanceMs, githubOptions)
    : options.readPrAdvanceMs !== undefined
    ? new AdvancingReadPrGithub(clock, options.readPrAdvanceMs, githubOptions)
    : options.findPrAdvanceMs !== undefined
    ? new AdvancingFindPrGithub(clock, options.findPrAdvanceMs, githubOptions)
    : new FakeGithub(githubOptions);
  const incidents = new FakeIncidents({
    summaries: options.incidents === false ? [] : [summaryFixture()],
    evidence: options.incidents === false ? null : evidenceFixture(),
  });
  const replay = options.replayAdvanceMs !== undefined
    ? new AdvancingFakeReplay(clock, options.replayAdvanceMs, options.replay)
    : new FakeReplay(options.replay);
  const model = new FakeModel({ head: SHA3, changedPaths: ["src/app.ts"] });
  const run = (deadlineMs = 3 * 60 * MINUTE) =>
    runRepairCycle({
      clock,
      state,
      configs,
      controllerSha: SHA1,
      github,
      githubCooldown,
      incidents,
      replay,
      model,
      budget,
    }, { deadline: clock.now() + deadlineMs, stepLimit: 32 });
  const snapshot = async (): Promise<RepairStateSnapshotV1> => {
    const read = await state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (!read.ok || read.value.status !== "found") {
      throw new Error("no repair state");
    }
    return read.value.snapshot;
  };
  return { clock, state, github, incidents, replay, model, run, snapshot };
}

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
    githubCooldowns: [],
    ...extra,
  };
}

async function seed(
  rig: RigV1,
  snapshot: RepairStateSnapshotV1,
): Promise<void> {
  const written = await rig.state.writeRepair(snapshot, null);
  assert.ok(written.ok && written.value.status === "applied");
}

Deno.test(
  "run ceiling: an implementation start just before the 90-minute cutoff is admitted and completes publication",
  async () => {
    const rig = makeRig({ replayAdvanceMs: REPAIR_MODEL_CUTOFF_MS - 1 });
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(rig.model.requests.length, 1, "model start admitted");
    assert.equal(state.work[0]!.nextStep, "review");
    assert.equal(state.work[0]!.target.head, SHA3);
    // Implementation + review request are both still inside the cutoff.
    assert.deepEqual(
      state.reservations.map((reservation) => reservation.purpose),
      ["implementation", "review_request"],
    );
    assert.ok(
      state.reservations.every((reservation) =>
        reservation.outcome === "submitted"
      ),
    );
    assert.equal(state.work[0]!.wait?.reason, "review_pending");
  },
);

Deno.test(
  "run ceiling: an implementation start at exactly the 90-minute cutoff is deferred without any reservation",
  async () => {
    const rig = makeRig({ replayAdvanceMs: REPAIR_MODEL_CUTOFF_MS });
    const outcome = await rig.run();
    assert.equal(outcome.status, "margin", JSON.stringify(outcome));
    const state = await rig.snapshot();
    // The step crossed the cutoff after the deterministic evidence/replay
    // work: no model start, no reservation, no publication.
    assert.equal(rig.model.requests.length, 0, "no model start");
    assert.equal(state.reservations.length, 0, "nothing charged");
    assert.equal(rig.github.pushes.length, 0, "no publication");
    assert.ok(
      rig.github.calls.every((call) => !call.startsWith("push:")),
    );
    const record = state.work[0]!;
    assert.equal(record.nextStep, "work");
    assert.equal(record.target.head, null);
    assert.equal(record.intent, null);
  },
);

Deno.test(
  "run ceiling: crossing the total 120-minute deadline stops before any further side effect",
  async () => {
    const rig = makeRig({ replayAdvanceMs: REPAIR_RUN_CEILING_MS });
    const outcome = await rig.run();
    assert.equal(outcome.status, "margin", JSON.stringify(outcome));
    assert.equal(rig.model.requests.length, 0, "no model start");
    const state = await rig.snapshot();
    assert.equal(state.reservations.length, 0, "nothing charged");
    // After the deadline crossed, the loop stopped at the next boundary
    // without another port call or state write.
    assert.equal(
      rig.github.calls.filter((call) => call.startsWith("push:")).length,
      0,
      "no publication after the total deadline",
    );
  },
);

Deno.test(
  "run ceiling: a run whose caller deadline already expired returns margin with no side effect at all",
  async () => {
    const rig = makeRig({ incidents: false });
    // The caller deadline is exactly now: the fixed run-relative bounds must
    // not extend it, and nothing (not even intake) starts.
    const outcome = await rig.run(0);
    assert.equal(outcome.status, "margin", JSON.stringify(outcome));
    assert.equal(rig.github.calls.length, 0, "no port call");
    assert.equal(rig.model.requests.length, 0);
    assert.equal(rig.replay.requests.length, 0);
    assert.equal(rig.state.repairWrites, 0, "no state write");
    assert.equal(rig.incidents.readCalls.length, 0, "no incident read");
  },
);

Deno.test(
  "run ceiling: a review request past the cutoff is rejected without a reservation while deterministic publication still runs",
  async () => {
    const rig = makeRig({
      incidents: false,
      githubAdvanceMs: 100 * MINUTE,
    });
    // An already-published issue candidate whose next action is the review
    // request: the push (deterministic publication) runs, then the review
    // start is rejected before any admission charge.
    const record = workRecord("issue-1", {
      source: { kind: "issue", id: "1", revision: SHA1 },
      related: { incidentId: null, issueNumber: 1 },
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
    await seed(rig, seededSnapshot([record]));
    const outcome = await rig.run();
    assert.equal(outcome.status, "margin", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(rig.github.pushes.length, 1, "deterministic push ran");
    assert.ok(
      !rig.github.calls.includes("requestReview"),
      "no review request past the cutoff",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "createPr").length,
      0,
      "no duplicate PR",
    );
    assert.equal(state.reservations.length, 0, "review start charged nothing");
    assert.equal(rig.model.requests.length, 0);
    assert.equal(
      state.work[0]!.intent?.kind,
      "push",
      "the durable push intent is preserved for reconciliation",
    );
    assert.equal(state.work[0]!.nextStep, "work");
  },
);

Deno.test(
  "run ceiling: deterministic publication of a lower-ranked task proceeds while a higher-ranked model action is deferred",
  async () => {
    const rig = makeRig({ replayAdvanceMs: 110 * MINUTE });
    const modelStart = workRecord("incident-a", {
      source: { kind: "incident", id: EVIDENCE_ID, revision: SHA2 },
      related: { incidentId: EVIDENCE_ID, issueNumber: null },
      fingerprint: FINGERPRINT,
      failingRevision: SHA2,
      classification: { severity: "P1", priority: null },
      target: {
        base: SHA1,
        branch: "sentinel/repair/incident-a",
        checkpoint: null,
        head: null,
        pr: null,
      },
    });
    const publishable = workRecord("issue-2", {
      source: { kind: "issue", id: "2", revision: SHA1 },
      related: { incidentId: null, issueNumber: 2 },
      classification: { severity: "P3", priority: 9 },
      target: {
        base: SHA1,
        branch: "sentinel/repair/issue-2",
        checkpoint: null,
        head: SHA3,
        pr: 7,
      },
      counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    });
    await seed(
      rig,
      seededSnapshot([modelStart, publishable], {
        incidents: [summaryFixture()],
        evidence: [evidenceFixture()],
      }),
    );
    const outcome = await rig.run();
    assert.equal(outcome.status, "margin", JSON.stringify(outcome));
    const state = await rig.snapshot();
    // The P1 model start crossed the cutoff first and was deferred; the
    // lower-ranked deterministic publication then proceeded to its push and
    // its own deferred review request, so the run ends in margin.
    assert.equal(rig.model.requests.length, 0, "no model start");
    assert.equal(state.reservations.length, 0, "nothing charged");
    assert.equal(rig.github.pushes.length, 1, "deterministic push ran");
    const deferredModel = state.work.find((work) => work.id === modelStart.id)!;
    assert.equal(deferredModel.target.head, null);
    assert.equal(deferredModel.intent, null);
    const published = state.work.find((work) => work.id === publishable.id)!;
    assert.equal(published.target.head, SHA3);
    assert.equal(published.intent?.kind, "push");
  },
);

Deno.test(
  "run ceiling: review observation continues past the cutoff while a higher-ranked model action is deferred",
  async () => {
    const rig = makeRig({ replayAdvanceMs: 95 * MINUTE });
    const modelStart = workRecord("incident-a", {
      source: { kind: "incident", id: EVIDENCE_ID, revision: SHA2 },
      related: { incidentId: EVIDENCE_ID, issueNumber: null },
      fingerprint: FINGERPRINT,
      failingRevision: SHA2,
      classification: { severity: "P1", priority: null },
      target: {
        base: SHA1,
        branch: "sentinel/repair/incident-a",
        checkpoint: null,
        head: null,
        pr: null,
      },
    });
    // Review wait that has not elapsed at the run start but elapses after the
    // model start crosses the cutoff: the observation must still run then.
    const observing = workRecord("issue-3", {
      source: { kind: "issue", id: "3", revision: SHA1 },
      related: { incidentId: null, issueNumber: 3 },
      target: {
        base: SHA1,
        branch: "sentinel/repair/issue-3",
        checkpoint: null,
        head: SHA3,
        pr: 8,
      },
      nextStep: "review",
      wait: {
        reason: "review_pending",
        since: T0,
        until: T0 + MINUTE,
      },
      counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    });
    await seed(
      rig,
      seededSnapshot([modelStart, observing], {
        incidents: [summaryFixture()],
        evidence: [evidenceFixture()],
      }),
    );
    const outcome = await rig.run();
    assert.equal(outcome.status, "margin", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(rig.model.requests.length, 0, "no model start");
    assert.equal(state.reservations.length, 0, "observation is not an attempt");
    assert.ok(
      rig.github.calls.includes("observeReview"),
      "review observation ran past the cutoff",
    );
    const observed = state.work.find((work) => work.id === observing.id)!;
    assert.equal(observed.nextStep, "review");
    assert.equal(observed.wait?.reason, "review_pending");
  },
);

Deno.test(
  "run ceiling: a tighter caller deadline admits a fitting declared operation and rejects one that cannot fit before any reservation",
  async () => {
    // A 10-minute caller deadline: the 4-minute session plus the 5-minute
    // reserved margin fits, so the declared implementation starts.
    const fits = makeRig({ replayAdvanceMs: MINUTE });
    const fitted = await fits.run(10 * MINUTE);
    assert.equal(fitted.status, "idle", JSON.stringify(fitted));
    assert.equal(fits.model.requests.length, 1);
    assert.equal((await fits.snapshot()).work[0]!.target.head, SHA3);

    // A 5-minute caller deadline: the same declared operation (9 minutes
    // with margin) cannot fit, so nothing is started and nothing is charged.
    const tight = makeRig({ replayAdvanceMs: MINUTE });
    const rejected = await tight.run(5 * MINUTE);
    assert.equal(rejected.status, "margin", JSON.stringify(rejected));
    assert.equal(tight.model.requests.length, 0);
    assert.equal((await tight.snapshot()).reservations.length, 0);
  },
);

Deno.test(
  "run ceiling: a NaN caller deadline cannot bypass the fixed ceiling and the cutoff still holds",
  async () => {
    const rig = makeRig({ replayAdvanceMs: REPAIR_MODEL_CUTOFF_MS });
    const outcome = await rig.run(NaN);
    assert.equal(outcome.status, "margin", JSON.stringify(outcome));
    assert.equal(rig.model.requests.length, 0);
    assert.equal((await rig.snapshot()).reservations.length, 0);
  },
);

Deno.test(
  "run ceiling: an implementation admission crossing the cutoff during the reservation write is refunded confirmed_not_submitted and never invokes the model",
  async () => {
    const rig = makeRig();
    // Advance the clock when the durable reservation lands, exactly as the
    // primary late-admission probe: the entry gate passed, but the start is
    // not made until after the cutoff.
    const original = rig.state.writeRepair.bind(rig.state);
    let advanced = false;
    rig.state.writeRepair = async (next, expected) => {
      const result = await original(next, expected);
      if (
        !advanced && next.reservations.some((r) => r.outcome === "reserved")
      ) {
        advanced = true;
        rig.clock.advance(91 * MINUTE);
      }
      return result;
    };
    const outcome = await rig.run();
    assert.equal(outcome.status, "margin", JSON.stringify(outcome));
    assert.equal(rig.model.requests.length, 0, "model never invoked");
    const state = await rig.snapshot();
    assert.equal(state.reservations.length, 1);
    assert.equal(
      state.reservations[0]!.outcome,
      "confirmed_not_submitted",
      "the never-submitted start is refunded, never charged",
    );
    assert.match(
      state.reservations[0]!.proofRef ?? "",
      /^artifact:\/\/sentinel\/run-bounds\//,
      "a restricted proof ref proves the start was never submitted",
    );
    assert.equal(state.reservations[0]!.purpose, "implementation");
    assert.equal(state.work[0]!.intent, null, "the unsent intent is cleared");
    assert.equal(
      state.work[0]!.counters.attempts,
      1,
      "the prepared attempt is counted so the retry reservation identity differs",
    );
    assert.equal(state.work[0]!.target.head, null);
    // The next scheduled run has a fresh 90-minute window and retries with a
    // new attempt without a duplicate start.
    const retried = await rig.run();
    assert.equal(retried.status, "idle", JSON.stringify(retried));
    assert.equal(rig.model.requests.length, 1, "retry started exactly once");
    assert.equal((await rig.snapshot()).work[0]!.target.head, SHA3);
  },
);

Deno.test(
  "run ceiling: a review admission crossing the cutoff during the reservation write is refunded and a later run requests the review once",
  async () => {
    const rig = makeRig({ incidents: false });
    const record = workRecord("issue-1", {
      source: { kind: "issue", id: "1", revision: SHA1 },
      related: { incidentId: null, issueNumber: 1 },
      target: {
        base: SHA1,
        branch: "sentinel/repair/issue-1",
        checkpoint: null,
        head: SHA3,
        pr: 7,
      },
      nextStep: "work",
      counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    });
    await seed(rig, seededSnapshot([record]));
    const original = rig.state.writeRepair.bind(rig.state);
    let advanced = false;
    rig.state.writeRepair = async (next, expected) => {
      const result = await original(next, expected);
      if (
        !advanced &&
        next.reservations.some((r) =>
          r.outcome === "reserved" && r.purpose === "review_request"
        )
      ) {
        advanced = true;
        rig.clock.advance(91 * MINUTE);
      }
      return result;
    };
    const first = await rig.run();
    assert.equal(first.status, "margin", JSON.stringify(first));
    assert.ok(
      !rig.github.calls.includes("requestReview"),
      "review never requested past the cutoff",
    );
    let state = await rig.snapshot();
    assert.equal(state.reservations.length, 1);
    assert.equal(
      state.reservations[0]!.outcome,
      "confirmed_not_submitted",
      "the refunded review admission is never charged",
    );
    assert.equal(
      state.reservations[0]!.proofRef,
      "artifact://sentinel/run-bounds/" + state.reservations[0]!.id,
    );
    assert.equal(state.work[0]!.intent, null, "the unsent intent is cleared");
    assert.equal(
      state.work[0]!.counters.reviewRounds,
      1,
      "the prepared round gives the retry a fresh reservation identity",
    );

    // A later run inside its own fresh window re-publishes and requests the
    // review exactly once — never blocked by the refunded admission.
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
      "the retry requested the review exactly once",
    );
    state = await rig.snapshot();
    assert.equal(state.work[0]!.nextStep, "review");
    assert.equal(state.work[0]!.wait?.reason, "review_pending");
    assert.equal(state.reservations.length, 2);
    assert.equal(
      state.reservations[1]!.outcome,
      "submitted",
      "the retry admission is confirmed submitted",
    );
    assert.equal(state.reservations[1]!.purpose, "review_request");
  },
);

Deno.test(
  "run ceiling: a review admission crossing a tighter caller deadline is refunded and a later run requests the review once",
  async () => {
    const rig = makeRig({ incidents: false });
    const record = workRecord("issue-1", {
      source: { kind: "issue", id: "1", revision: SHA1 },
      related: { incidentId: null, issueNumber: 1 },
      target: {
        base: SHA1,
        branch: "sentinel/repair/issue-1",
        checkpoint: null,
        head: SHA3,
        pr: 7,
      },
      nextStep: "work",
      counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    });
    await seed(rig, seededSnapshot([record]));
    const original = rig.state.writeRepair.bind(rig.state);
    let advanced = false;
    rig.state.writeRepair = async (next, expected) => {
      const result = await original(next, expected);
      if (
        !advanced &&
        next.reservations.some((r) =>
          r.outcome === "reserved" && r.purpose === "review_request"
        )
      ) {
        advanced = true;
        rig.clock.advance(11 * MINUTE);
      }
      return result;
    };
    // A 10-minute caller deadline: deterministic publication runs, but the
    // review reservation write crosses the tighter total deadline, so the
    // provably never-submitted start is refunded instead of dispatched.
    const first = await rig.run(10 * MINUTE);
    assert.equal(first.status, "margin", JSON.stringify(first));
    assert.ok(
      !rig.github.calls.includes("requestReview"),
      "review never dispatched past the total deadline",
    );
    let state = await rig.snapshot();
    assert.equal(state.reservations.length, 1);
    assert.equal(
      state.reservations[0]!.outcome,
      "confirmed_not_submitted",
      "the never-submitted review start is refunded",
    );
    assert.equal(
      state.reservations[0]!.proofRef,
      "artifact://sentinel/run-bounds/" + state.reservations[0]!.id,
    );
    assert.equal(state.work[0]!.intent, null, "the unsent intent is cleared");
    assert.equal(state.work[0]!.counters.reviewRounds, 1);

    // A later run inside its own window dispatches the review exactly once.
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
      "the retry dispatched the review exactly once",
    );
    state = await rig.snapshot();
    assert.equal(state.work[0]!.nextStep, "review");
    assert.equal(state.reservations.length, 2);
    assert.equal(
      state.reservations[1]!.outcome,
      "submitted",
      "the retry admission is confirmed submitted",
    );
  },
);

// ---------------------------------------------------------------------------
// Late-publication regression: a real remote mutation (push, remote PR read,
// merge-gate read) may cross the total 120-minute deadline inside the awaited
// port call. The run must stop in the existing margin outcome without the
// NEXT remote mutation, keep the durable intent of the finished effect, and
// the next run resumes the exact continuation exactly once.
// ---------------------------------------------------------------------------

/** Run-bound device: advances the clock once when a remote PR lookup runs. */
class AdvancingFindPrGithub extends FakeGithub {
  private advanced = false;
  constructor(
    private readonly clock: FakeClock,
    private readonly advanceMs: number,
    options: FakeGithubOptionsV1 = {},
  ) {
    super(options);
  }
  override findPullRequestByHeadRef(
    headRef: string,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    if (!this.advanced) {
      this.advanced = true;
      this.clock.advance(this.advanceMs);
    }
    return super.findPullRequestByHeadRef(headRef);
  }
}

/** Run-bound device: advances the clock once when a merge-gate PR read runs. */
class AdvancingReadPrGithub extends FakeGithub {
  private advanced = false;
  constructor(
    private readonly clock: FakeClock,
    private readonly advanceMs: number,
    options: FakeGithubOptionsV1 = {},
  ) {
    super(options);
  }
  override readPullRequest(
    number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    if (!this.advanced) {
      this.advanced = true;
      this.clock.advance(this.advanceMs);
    }
    return super.readPullRequest(number);
  }
}

/** Delivery-phase issue record for the focused merge-gate case (PR 7). */
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
  });
}

Deno.test(
  "run ceiling: a push that crosses the total deadline publishes once and the next run creates the PR once without re-pushing",
  async () => {
    const rig = makeRig({
      githubAdvanceMs: REPAIR_RUN_CEILING_MS + MINUTE,
    });
    const first = await rig.run();
    assert.equal(first.status, "margin", JSON.stringify(first));
    assert.equal((rig.clock.now() - T0) / MINUTE, 121, "push advanced to 121");
    assert.equal(rig.github.pushes.length, 1, "the candidate push finished");
    assert.equal(
      rig.github.calls.filter((call) => call === "createPr").length,
      0,
      "no PR creation after the total deadline",
    );
    let state = await rig.snapshot();
    assert.equal(state.work[0]!.target.head, SHA3);
    assert.equal(
      state.work[0]!.intent?.kind,
      "push",
      "the finished push stays durable for the next run",
    );

    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(rig.github.pushes.length, 1, "no second push");
    assert.equal(
      rig.github.calls.filter((call) => call === "createPr").length,
      1,
      "the next run created the PR exactly once",
    );
    state = await rig.snapshot();
    assert.equal(state.work[0]!.intent, null);
    assert.equal(state.work[0]!.target.pr, 7);
    assert.equal(state.work[0]!.nextStep, "review");
  },
);

Deno.test(
  "run ceiling: a remote PR reconciliation read that crosses the total deadline defers creation and the next run creates it once",
  async () => {
    const rig = makeRig({
      incidents: false,
      findPrAdvanceMs: REPAIR_RUN_CEILING_MS + MINUTE,
    });
    // No PR exists yet: creation must be re-attempted after the deadline.
    rig.github.prNumber = 0;
    rig.github.releasedHead = SHA3;
    const record = workRecord("issue-1", {
      source: { kind: "issue", id: "1", revision: SHA1 },
      related: { incidentId: null, issueNumber: 1 },
      target: {
        base: SHA1,
        branch: "sentinel/repair/issue-1",
        checkpoint: null,
        head: SHA3,
        pr: null,
      },
      nextStep: "work",
      counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      intent: {
        kind: "pull_request",
        key: `pull_request:${SHA3}`,
        startedAt: T0,
        branch: "sentinel/repair/issue-1",
        expectedHead: SHA3,
        observedBase: SHA1,
        pr: null,
        requestId: null,
        resultId: null,
      },
    });
    await seed(rig, seededSnapshot([record]));
    const first = await rig.run();
    assert.equal(first.status, "margin", JSON.stringify(first));
    assert.equal(rig.github.pushes.length, 0);
    assert.equal(
      rig.github.calls.filter((call) => call === "createPr").length,
      0,
      "no PR creation after the total deadline",
    );
    let state = await rig.snapshot();
    assert.equal(
      state.work[0]!.intent?.kind,
      "pull_request",
      "the PR intent stays durable for the next run",
    );

    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(
      rig.github.calls.filter((call) => call === "createPr").length,
      1,
      "the next run created the PR exactly once",
    );
    state = await rig.snapshot();
    assert.equal(state.work[0]!.intent, null);
    assert.equal(state.work[0]!.target.pr, 7);
    assert.equal(state.work[0]!.nextStep, "review");
  },
);

Deno.test(
  "run ceiling: no intake read starts when the initial state read crosses the total deadline",
  async () => {
    const rig = makeRig();
    const original = rig.state.readRepair.bind(rig.state);
    let advanced = false;
    rig.state.readRepair = async () => {
      const result = await original();
      if (!advanced) {
        advanced = true;
        rig.clock.advance(REPAIR_RUN_CEILING_MS + MINUTE);
      }
      return result;
    };
    const outcome = await rig.run();
    assert.equal(outcome.status, "margin", JSON.stringify(outcome));
    assert.equal(
      rig.incidents.listCalls,
      0,
      "no incident read after the deadline",
    );
    assert.equal(rig.github.calls.length, 0, "no source read");
    assert.equal(rig.replay.requests.length, 0);
    assert.equal(rig.model.requests.length, 0);
    assert.equal(rig.state.repairWrites, 0, "nothing was seeded or written");
  },
);

Deno.test(
  "run ceiling: a merge-gate read that crosses the total deadline defers the merge and the next run merges exactly once",
  async () => {
    const rig = makeRig({
      incidents: false,
      readPrAdvanceMs: REPAIR_RUN_CEILING_MS + MINUTE,
      github: { pullRequest: { state: "open", head: SHA3, mergeSha: null } },
    });
    // The observed gate is open (not merged), but the eventual merge outcome
    // must carry the exact reviewed head so release-request identity matches.
    rig.github.releasedHead = SHA3;
    const record = deliveryRecord(SHA3, {
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
    });
    await seed(
      rig,
      seededSnapshot([record], {
        reviews: [completedReceipt(7, SHA3, SHA1)],
      }),
    );
    const first = await rig.run();
    assert.equal(first.status, "margin", JSON.stringify(first));
    assert.equal(
      rig.github.calls.filter((call) => call === "merge").length,
      0,
      "no merge after the total deadline",
    );
    let state = await rig.snapshot();
    assert.equal(
      state.work[0]!.intent?.kind,
      "merge",
      "the merge intent stays durable for the next run",
    );

    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(
      rig.github.calls.filter((call) => call === "merge").length,
      1,
      "the next run merged exactly once",
    );
    state = await rig.snapshot();
    assert.equal(state.work[0]!.intent, null);
    assert.equal(state.releaseRequests.length, 1);
    assert.equal(state.work[0]!.nextStep, "delivery");
  },
);
