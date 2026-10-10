import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import {
  reviewTaskStatementDigest,
  TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL,
} from "../../src/contracts/review-receipt.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { reviewOperationKey } from "../../src/repair/keys.ts";
import { SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";

class ClosureGithub extends FakeGithub {
  closures = 0;
  failClosure = false;
  closeAlreadySatisfiedTask() {
    this.closures++;
    return Promise.resolve(
      this.failClosure
        ? portError("unavailable", "closure response unavailable")
        : portOk("closed" as const),
    );
  }
}

async function rig() {
  const clock = new FakeClock(T0 + 3600_001);
  const state = new MemoryState();
  const github = new ClosureGithub({ baseSha: SHA1, branchRefSha: SHA2 });
  github.releasedHead = SHA2;
  const record = workRecord("issue-1", {
    source: { kind: "issue", id: "1", revision: SHA1 },
    nextStep: "review",
    target: {
      base: SHA1,
      branch: "sentinel/repair/issue-1",
      checkpoint: null,
      head: SHA2,
      pr: 7,
    },
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
  });
  state.repair = {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: [record],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  };
  state.repairHead = SHA1;
  github.reviewObservationsByKey.set(reviewOperationKey(7, SHA2, 1), {
    status: "completed",
    requestId: "review-req-1",
    reviewer: github.reviewerIdentity,
    resultId: "result-1",
    completedAt: T0 + 2000,
    observedHead: SHA2,
    observedBase: SHA1,
    findings: [],
    summary: null,
    receivedAt: T0 + 2001,
    taskAcceptance: {
      issueNumber: 1,
      taskDigest: await reviewTaskStatementDigest({
        issueNumber: 1,
        title: "issue 1",
        body: "",
      }),
      verdict: "already_satisfied_at_base",
      evidence: ["the exact base already satisfies the task"],
    },
  });
  const configs = repairConfigs();
  const model = new FakeModel();
  const run = () =>
    runRepairCycle({
      clock,
      state,
      configs,
      controllerSha: SHA1,
      github,
      model,
      githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
      budget: new RollingStartBudget({ state, clock, configs }),
      incidents: new FakeIncidents({ summaries: [] }),
      replay: new FakeReplay(),
    }, { deadline: clock.now() + 3600_000, stepLimit: 8 });
  return { clock, state, github, record, model, run };
}

Deno.test("terminal closure: connected controller completes already-satisfied without a repair", async () => {
  const context = await rig();
  const outcome = await context.run();
  assert.equal(outcome.status, "idle", JSON.stringify(outcome));
  assert.equal(context.state.repair!.work[0].nextStep, "done");
  assert.equal(context.github.closures, 1);
  assert.equal(context.state.repair!.releaseRequests.length, 0);
  assert.equal(
    context.state.repair!.reviews[0].taskAcceptance?.verdict,
    "already_satisfied_at_base",
  );
  assert.deepEqual(context.state.repair!.work[0].target, context.record.target);
  assert.deepEqual(
    context.state.repair!.work[0].counters,
    context.record.counters,
  );
  assert.equal(context.model.requests.length, 0);
  assert.equal(context.github.calls.includes("merge"), false);
});

Deno.test("terminal closure: failed close keeps exact intent and retry remains closure-only", async () => {
  const context = await rig();
  context.github.failClosure = true;
  await context.run();
  const intent = context.state.repair!.work[0].intent;
  assert.equal(intent?.kind, "already_satisfied_closure");
  assert.equal(context.state.repair!.work[0].nextStep, "delivery");
  context.github.failClosure = false;
  context.clock.advance(300_001);
  await context.run();
  assert.equal(context.state.repair!.work[0].nextStep, "done");
  assert.equal(context.github.closures, 2);
  assert.equal(context.model.requests.length, 0);
  assert.equal(context.state.repair!.releaseRequests.length, 0);
});

Deno.test("terminal closure: task changed during retry blocks with preserved intent and no close", async () => {
  const context = await rig();
  context.github.failClosure = true;
  await context.run();
  const intent = context.state.repair!.work[0].intent;
  const readIssue = context.github.readIssue.bind(context.github);
  context.github.readIssue = async (number) => {
    const issue = await readIssue(number);
    return issue.ok && issue.value !== null
      ? portOk({ ...issue.value, body: "changed task" })
      : issue;
  };
  context.clock.advance(300_001);
  await context.run();
  assert.equal(context.state.repair!.work[0].nextStep, "blocked");
  assert.deepEqual(context.state.repair!.work[0].intent, intent);
  assert.equal(context.github.closures, 1);
});

function asHistoricalBlock(
  context: Awaited<ReturnType<typeof rig>>,
): void {
  context.state.repair!.work[0] = {
    ...context.state.repair!.work[0],
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL,
      since: T0 + 3600_000,
    },
    intent: null,
    wait: null,
  };
}

Deno.test("terminal closure: historical already-satisfied block recovers through the standing journal", async () => {
  const context = await rig();
  asHistoricalBlock(context);
  const outcome = await context.run();
  assert.equal(outcome.status, "idle", JSON.stringify(outcome));
  const record = context.state.repair!.work[0];
  assert.equal(record.nextStep, "done");
  assert.equal(record.blocker, null);
  assert.equal(record.intent, null);
  assert.equal(context.github.closures, 1);
  assert.equal(context.state.repair!.reviews.length, 1);
  assert.equal(context.github.calls.includes("merge"), false);
  assert.equal(context.model.requests.length, 0);
});

Deno.test("terminal closure: historical block without a readable journal stays blocked", async () => {
  const context = await rig();
  asHistoricalBlock(context);
  context.github.observeReview = () =>
    Promise.resolve(portError("unavailable", "review transport unavailable"));
  await context.run();
  assert.equal(context.state.repair!.work[0].nextStep, "blocked");
  assert.equal(context.github.closures, 0);
  assert.equal(context.state.repair!.reviews.length, 0);
});

Deno.test("terminal closure: historical block with a changed verdict stays blocked", async () => {
  const context = await rig();
  asHistoricalBlock(context);
  const key = reviewOperationKey(7, SHA2, 1);
  const observation = context.github.reviewObservationsByKey.get(key);
  assert(observation !== undefined);
  assert(observation.taskAcceptance !== null);
  context.github.reviewObservationsByKey.set(key, {
    ...observation,
    taskAcceptance: {
      ...observation.taskAcceptance,
      verdict: "fulfilled",
    },
  });
  await context.run();
  assert.equal(context.state.repair!.work[0].nextStep, "blocked");
  assert.equal(context.github.closures, 0);
});
