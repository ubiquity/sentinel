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
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { GitHubIssueV1, PortResultV1 } from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { parseLocalReleaseReceiptV1 } from "../../src/contracts/local-release.ts";
import type { LocalReleaseReceiptV1 } from "../../src/contracts/local-release.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { parseRepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import { candidateBranch, pushIntentKey } from "../../src/repair/keys.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { runRepairEntrypoint } from "../../src/main.ts";
import { persistHostedReceipt } from "../host/hosted-receipt-fixture.ts";
import type { HostedReceiptPhaseV1 } from "../host/hosted-receipt-fixture.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { readHostedReleaseReceipt } from "../../src/host/actions-release.ts";
import {
  DEP_0,
  DEP_2,
  incidentEvidence,
  incidentSummary,
  makeRemoteCtx,
  monitoredReleaseRecord,
  releaseRequest,
  REPO,
  reviewReceipt,
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
  MemoryState,
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
  entry(
    deadlineMs?: number,
  ): Promise<Awaited<ReturnType<typeof runRepairEntrypoint>>>;
  snapshot(): Promise<RepairStateSnapshotV1>;
  sequence(): Promise<number>;
  acceptRelease(requestId: string): Promise<void>;
}

async function makeRig(
  prefix: string,
  options: {
    summaries?: boolean;
    github?: ConstructorParameters<typeof FakeGithub>[0];
    /** Exact fake port instance (e.g. one that serves native relations). */
    githubPort?: FakeGithub;
    model?: ConstructorParameters<typeof FakeModel>[0];
    replay?: ConstructorParameters<typeof FakeReplay>[0];
    incidents?: ConstructorParameters<typeof FakeIncidents>[0];
    configOverrides?: Record<string, unknown>;
    /**
     * Also configure the explicit local Sentinel scope (installationId 0), so
     * local-scope delivery records are eligible and their consumer is real.
     */
    localScope?: boolean;
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
  const githubCooldown = new DurableGitHubCooldownGate({ state: store, clock });
  const configs = repairConfigs({
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
    ...options.configOverrides,
  });
  if (options.localScope === true) {
    configs.push(localScopeConfig(configs[0]));
  }
  const budget = new RollingStartBudget({ clock, state: store, configs });
  const github = options.githubPort ??
    new FakeGithub({ baseSha: SHA1, ...options.github });
  const incidents = new FakeIncidents({
    summaries: options.summaries === false ? [] : [summaryFixture()],
    evidence: options.summaries === false ? null : evidenceFixture(),
    ...options.incidents,
  });
  const replay = new FakeReplay(options.replay);
  const model = new FakeModel({
    head: SHA3,
    changedPaths: ["src/app.ts"],
    ...options.model,
  });
  // Positive rigs need the declared review bound (10 min) plus the five-minute
  // operation margin to fit INSIDE the loop deadline: a 10-minute caller
  // deadline leaves no review window at all. 60 minutes stays under the fixed
  // 120-minute ceiling and the 90-minute model cutoff; the clock is fake, so
  // this costs no real time.
  const run = (deadlineMs = 60 * 60_000) =>
    runRepairCycle({
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
    }, { deadline: clock.now() + deadlineMs, stepLimit: 16 });
  // The actual production entrypoint: the hosted receipt capability is only
  // reachable through this path, exactly as the hosted Actions host wires it.
  const entry = (deadlineMs = 60 * 60_000) =>
    runRepairEntrypoint({
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
      hostedRuntimes: [],
      hostedReleases: [],
      githubCooldowns: [],
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
    entry,
    snapshot,
    sequence,
    acceptRelease,
  };
}

/** One full open-issue fixture (the frozen GitHubIssueV1 shape). */
function issueRecord(
  number: number,
  overrides: Partial<GitHubIssueV1> = {},
): GitHubIssueV1 {
  return {
    number,
    title: `issue ${number}`,
    body: "",
    state: "open",
    author: null,
    labels: [],
    createdAt: T0,
    updatedAt: T0,
    closedAt: null,
    ...overrides,
  };
}

/**
 * Native-relation fake GitHub port. `listed` is what intake sees and `latest`
 * is what every model-admission re-read sees, so a test can change the source
 * between the intake listing and the admission read.
 */
class RelationsFakeGithub extends FakeGithub {
  listed: GitHubIssueV1[] = [];
  latest = new Map<number, GitHubIssueV1 | null>();
  override listOpenIssues() {
    this.calls.push("listOpenIssues");
    return Promise.resolve(portOk(this.listed));
  }
  override readIssue(issueNumber: number) {
    this.calls.push(`readIssue:${issueNumber}`);
    return Promise.resolve(portOk(this.latest.get(issueNumber) ?? null));
  }
}

/**
 * Cheap in-memory issue-only loop rig: MemoryState plus fake ports. Unlike the
 * real-Git `makeRig`, no temp directory or Git command is touched.
 */
function makeMemoryRig(github: FakeGithub) {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  const configs = repairConfigs({
    adapter: { kind: "github" },
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  });
  const budget = new RollingStartBudget({ clock, state, configs });
  const githubCooldown = new DurableGitHubCooldownGate({ state, clock });
  const incidents = new FakeIncidents({ summaries: [], evidence: null });
  const replay = new FakeReplay();
  const model = new FakeModel({
    head: SHA3,
    changedPaths: ["src/app.ts"],
  });
  const run = (stepLimit = 16) =>
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
    }, { deadline: clock.now() + 60 * 60_000, stepLimit });
  const snapshot = async () => {
    const read = await state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (!read.ok || read.value.status !== "found") {
      throw new Error("no repair state");
    }
    return read.value.snapshot;
  };
  return { clock, state, github, model, run, snapshot };
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
      // A durable replay result lets the task resume after retained artifact
      // expiry; the saved fixture and before-failure proof are reused.
      rig.clock.advance(100_000_000 + 1);
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
    assert.equal(
      rig.model.requests[1]?.base,
      SHA1,
      "correction preserves the reviewed development base in the request",
    );
    assert.equal(
      rig.model.requests[1]?.checkoutBase,
      SHA3,
      "correction starts from the rejected candidate head",
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

Deno.test(
  "github adapter intake skips incident scans and admits a real seeded issue",
  async () => {
    // The fake incident source throws if touched at all: a github-only host
    // must advance the real seeded issue without any incident read.
    // The fake port serves the known-empty native relations that issue-only
    // github-adapter intake requires before any admission.
    const seededIssue = issueRecord(7, {
      title: "repair the failing request",
      labels: ["P1", "priority:9"],
      createdAt: T0 - 300,
      relations: { openBlockers: [], subIssueCount: 0 },
    });
    const githubPort = new RelationsFakeGithub({ baseSha: SHA1 });
    githubPort.listed = [seededIssue];
    githubPort.latest.set(7, seededIssue);
    const rig = await makeRig("githubintake", {
      summaries: false,
      configOverrides: { adapter: { kind: "github" } },
      incidents: { throwOnList: true },
      githubPort,
    });
    try {
      const first = await rig.run(1);
      assert.equal(first.status, "margin", JSON.stringify(first));
      const state = await rig.snapshot();
      assert.equal(state.incidents.length, 0);
      assert.equal(state.work.length, 1);
      const issue = state.work[0];
      assert.equal(issue.source.kind, "issue");
      assert.equal(issue.source.id, "7");
      assert.equal(issue.related.issueNumber, 7);
      assert.equal(issue.source.revision, SHA1);
      assert.equal(issue.target.base, SHA1);
      assert.deepEqual(issue.classification, { severity: "P1", priority: 9 });
      assert.equal(rig.model.requests.length, 0);
      assert.equal(
        rig.github.calls.filter((call) => call === "listOpenIssues").length,
        1,
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "github adapter issue intake gates on native relations before any model start",
  async () => {
    // A parent (has sub-issues) and an open-blocked issue are skipped at
    // intake: no work record, no reservation and no model start.
    const blocked = new RelationsFakeGithub({ baseSha: SHA1 });
    blocked.listed = [
      issueRecord(11, {
        relations: {
          openBlockers: [{ owner: "ubiquity", name: "ai.ubq.fi", number: 3 }],
          subIssueCount: 0,
        },
      }),
      issueRecord(12, {
        relations: { openBlockers: [], subIssueCount: 2 },
      }),
    ];
    const blockedRig = makeMemoryRig(blocked);
    const blockedRun = await blockedRig.run(1);
    assert.equal(blockedRun.status, "idle", JSON.stringify(blockedRun));
    let state = await blockedRig.snapshot();
    assert.equal(state.work.length, 0);
    assert.equal(state.reservations.length, 0);
    assert.equal(blockedRig.model.requests.length, 0);

    // Absent relations are UNKNOWN, never empty: the run reports a source
    // error and admits nothing.
    const missing = new RelationsFakeGithub({ baseSha: SHA1 });
    missing.listed = [issueRecord(13, { title: "unknown dependencies" })];
    const missingRig = makeMemoryRig(missing);
    const missingRun = await missingRig.run(1);
    assert.equal(missingRun.status, "source_error", JSON.stringify(missingRun));
    state = await missingRig.snapshot();
    assert.equal(state.work.length, 0);
    assert.equal(state.reservations.length, 0);
    assert.equal(missingRig.model.requests.length, 0);

    // A known-unblocked leaf is admitted and the implementation start is
    // charged exactly once against the same latest read.
    const leaf = new RelationsFakeGithub({ baseSha: SHA1 });
    const leafIssue = issueRecord(14, {
      relations: { openBlockers: [], subIssueCount: 0 },
    });
    leaf.listed = [leafIssue];
    leaf.latest.set(14, leafIssue);
    const leafRig = makeMemoryRig(leaf);
    await leafRig.run(6);
    state = await leafRig.snapshot();
    assert.equal(state.work.length, 1);
    assert.equal(leafRig.model.requests.length, 1);
    assert.equal(state.reservations[0]?.outcome, "submitted");

    // The source changes between the intake listing and the model-admission
    // re-read (an open blocker appears): admission defers with zero
    // reservation and zero model start, waiting exactly one hour so the next
    // poll re-reads the native dependency.
    const moved = new RelationsFakeGithub({ baseSha: SHA1 });
    moved.listed = [
      issueRecord(15, { relations: { openBlockers: [], subIssueCount: 0 } }),
    ];
    moved.latest.set(
      15,
      issueRecord(15, {
        relations: {
          openBlockers: [{ owner: "ubiquity", name: "sentinel", number: 99 }],
          subIssueCount: 0,
        },
      }),
    );
    const movedRig = makeMemoryRig(moved);
    await movedRig.run(6);
    state = await movedRig.snapshot();
    assert.equal(state.work.length, 1);
    assert.equal(state.work[0].wait?.reason, "unavailable");
    assert.equal(state.work[0].wait?.until, T0 + 60 * 60_000);
    assert.equal(state.reservations.length, 0);
    assert.equal(movedRig.model.requests.length, 0);
  },
);

Deno.test(
  "gateway intake keeps an incident source failure as a failure",
  async () => {
    // A single gateway configuration (and any ambiguous host) keeps the
    // existing incident read and its source-error outcome.
    const rig = await makeRig("gatewaysourcefail", {
      summaries: false,
      incidents: { failListNext: true },
    });
    try {
      const result = await rig.run(1);
      assert.equal(result.status, "source_error", JSON.stringify(result));
      const state = await rig.snapshot();
      assert.equal(state.work.length, 0);
      assert.equal(rig.model.requests.length, 0);
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
      githubCooldowns: [],
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
    githubCooldowns: [],
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

// ---------------------------------------------------------------------------
// Local activation branch: the explicit local Sentinel scope (installationId
// 0) reads only the private local receipt capability. The hosted Deno release
// path is never a fallback for local work, and the nonlocal gateway path is
// unchanged.
// ---------------------------------------------------------------------------

const LOCAL_SENTINEL_REPO = {
  owner: "ubiquity",
  name: "sentinel",
  installationId: 0,
} as const;

/**
 * Another repository that also uses the explicit no-App credential scope
 * (installationId 0) but is not `ubiquity/sentinel`. It is not the local
 * Sentinel scope, so it must never consult or consume the Sentinel local
 * receipt.
 */
const OTHER_SCOPE_ZERO_REPO = {
  owner: "ubiquity",
  name: "sentinel-fork",
  installationId: 0,
} as const;

/**
 * The local scope (installationId 0) configuration: the explicit no-App local
 * credential scope uses the github adapter, so the same synthetic command
 * registry is reused with only the repository identity and adapter kind
 * changed. Built through the frozen parser, never a cast.
 */
function localScopeConfig(
  base: RepositoryConfigV1,
): RepositoryConfigV1 {
  return parseRepositoryConfigV1({
    ...base,
    repository: LOCAL_SENTINEL_REPO,
    adapter: { kind: "github" },
  });
}

/** One local production request bound to the delivery record below. */
function localDeliveryRequest(
  id: string,
  revision: GitSha,
): ReleaseRequestV1 {
  return releaseRequest(id, {
    target: { repository: LOCAL_SENTINEL_REPO, environment: "production" },
    revision,
    source: {
      pullRequest: 12,
      reviewRequestId: `review-req-${id}`,
      reviewReceiptId: `review-receipt-${id}`,
      head: SHA1,
      base: SHA2,
    },
    createdAt: T0,
  });
}

/** A local production request for the same PR/head with a different base. */
function wrongBaseLocalRequest(id: string): ReleaseRequestV1 {
  return releaseRequest(id, {
    target: { repository: LOCAL_SENTINEL_REPO, environment: "production" },
    revision: SHA3,
    source: {
      pullRequest: 12,
      reviewRequestId: `review-req-${id}`,
      reviewReceiptId: `review-receipt-${id}`,
      head: SHA1,
      base: SHA3,
    },
    createdAt: T0,
  });
}

/** A strict accepted local receipt for one exact request. */
function localAcceptedReceipt(request: ReleaseRequestV1) {
  return parseLocalReleaseReceiptV1({
    version: "v1",
    kind: "local_release_receipt",
    request,
    priorRevision: SHA2,
    phase: "accepted",
    candidateProof: {
      invocationId: "inv-candidate",
      controllerSha: request.revision,
      startedAt: T0 + 1000,
      finishedAt: T0 + 2000,
      outcome: "idle",
    },
    priorProof: {
      invocationId: "inv-prior",
      controllerSha: SHA2,
      startedAt: T0,
      finishedAt: T0 + 500,
      outcome: "idle",
    },
    createdAt: T0,
    updatedAt: T0 + 2000,
  });
}

/**
 * The default local delivery issue: a valid positive number with a coherent
 * issue source id. Issue tasks never carry a null `related.issueNumber`.
 */
const LOCAL_DELIVERY_ISSUE = 42;

/**
 * A local-scope delivery record: it targets the configured local
 * (installationId 0) repository scope and carries a coherent issue source, so
 * the frozen parser accepts it and the real local consumer is exercised.
 */
function localDeliveryRecord(
  issueNumber: number = LOCAL_DELIVERY_ISSUE,
): WorkRecordV1 {
  return workRecord("local-delivery-1", {
    repository: LOCAL_SENTINEL_REPO,
    source: { kind: "issue", id: String(issueNumber), revision: SHA1 },
    related: { incidentId: null, issueNumber },
    target: { base: SHA2, branch: null, checkpoint: null, head: SHA1, pr: 12 },
    nextStep: "delivery",
    updatedAt: T0 + 1000,
  });
}

/** The explicit nonlocal control record: ai.ubq.fi under installation 7. */
function gatewayDeliveryRecord(): WorkRecordV1 {
  return workRecord("local-delivery-1", {
    repository: REPO,
    source: { kind: "issue", id: String(LOCAL_DELIVERY_ISSUE), revision: SHA1 },
    related: { incidentId: null, issueNumber: LOCAL_DELIVERY_ISSUE },
    target: { base: SHA2, branch: null, checkpoint: null, head: SHA1, pr: 12 },
    nextStep: "delivery",
    updatedAt: T0 + 1000,
  });
}

Deno.test(
  "local release: accepted local receipt closes the delivery record",
  async () => {
    const rig = await makeRig("localaccept", {
      summaries: false,
      localScope: true,
    });
    try {
      const request = localDeliveryRequest("release-local-1", SHA3);
      const seeded = await rig.store.writeRepair(
        seededSnapshot([localDeliveryRecord()], { releaseRequests: [request] }),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      let reads = 0;
      Object.assign(rig.store, {
        readLocalRelease: () => {
          reads++;
          return Promise.resolve(portOk(localAcceptedReceipt(request)));
        },
      });
      const run = await rig.run();
      assert.equal(run.status, "idle", JSON.stringify(run));
      const state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "done");
      assert.equal(reads, 1, "the local capability was consulted exactly once");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

/**
 * Matching-request accepted receipts whose proof is missing, failed or bound
 * to the wrong revision: cast values an injected reader may return and that
 * the consumer must reject before any accepted/closure/blocked transition.
 */
function malformedAcceptedReceipts(request: ReleaseRequestV1): unknown[] {
  const valid = localAcceptedReceipt(request);
  return [
    { ...valid, candidateProof: null },
    {
      ...valid,
      candidateProof: {
        invocationId: "inv-candidate-failed",
        controllerSha: request.revision,
        startedAt: T0 + 1000,
        finishedAt: T0 + 2000,
        outcome: "state_error",
      },
    },
    {
      ...valid,
      candidateProof: {
        invocationId: "inv-candidate-wrong",
        controllerSha: SHA2,
        startedAt: T0 + 1000,
        finishedAt: T0 + 2000,
        outcome: "idle",
      },
    },
  ];
}

Deno.test(
  "local release: malformed matching-request receipts never close the delivery record",
  async () => {
    const request = localDeliveryRequest("release-local-1", SHA3);
    const variants = malformedAcceptedReceipts(request);
    for (let index = 0; index < variants.length; index++) {
      const rig = await makeRig(`localmalformed${index}`, {
        summaries: false,
        localScope: true,
      });
      try {
        const seeded = await rig.store.writeRepair(
          seededSnapshot([localDeliveryRecord(42)], {
            releaseRequests: [request],
          }),
          null,
        );
        assert.ok(seeded.ok && seeded.value.status === "applied");
        Object.assign(rig.store, {
          readLocalRelease: () =>
            Promise.resolve(portOk(variants[index] as LocalReleaseReceiptV1)),
        });
        const run = await rig.run();
        assert.equal(run.status, "idle", JSON.stringify(run));
        const state = await rig.snapshot();
        assert.equal(
          state.work[0].nextStep,
          "delivery",
          `variant ${index}: no closure transition`,
        );
        assert.equal(state.work[0].wait?.reason, "unavailable");
        assert.equal(
          rig.github.calls.filter((call) => call.startsWith("closeIssue"))
            .length,
          0,
          `variant ${index}: zero closure calls`,
        );
      } finally {
        await rig.ctx.cleanup();
      }
    }
  },
);

Deno.test(
  "local release: mismatched local receipt waits and never accepts",
  async () => {
    const rig = await makeRig("localmismatch", {
      summaries: false,
      localScope: true,
    });
    try {
      const request = localDeliveryRequest("release-local-1", SHA3);
      const seeded = await rig.store.writeRepair(
        seededSnapshot([localDeliveryRecord()], { releaseRequests: [request] }),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      // A valid receipt for a DIFFERENT request: the consumer-side binding
      // check must reject it even though the port returned success.
      const other = localDeliveryRequest("release-local-other", SHA3);
      Object.assign(rig.store, {
        readLocalRelease: () =>
          Promise.resolve(portOk(localAcceptedReceipt(other))),
      });
      const run = await rig.run();
      assert.equal(run.status, "idle", JSON.stringify(run));
      const state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "delivery");
      assert.equal(state.work[0].wait?.reason, "unavailable");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "local release: unavailable local receipt waits",
  async () => {
    const rig = await makeRig("localunavailable", {
      summaries: false,
      localScope: true,
    });
    try {
      const request = localDeliveryRequest("release-local-1", SHA3);
      const seeded = await rig.store.writeRepair(
        seededSnapshot([localDeliveryRecord()], { releaseRequests: [request] }),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      Object.assign(rig.store, {
        readLocalRelease: () =>
          Promise.resolve(
            portError("unavailable", "local release receipt is unavailable"),
          ),
      });
      const run = await rig.run();
      assert.equal(run.status, "idle", JSON.stringify(run));
      const state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "delivery");
      assert.equal(state.work[0].wait?.reason, "unavailable");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "local release: wrong-scope or wrong-base request cannot close the delivery record",
  async () => {
    // Case 1: the request matches PR/head but targets the ai.ubq.fi gateway
    // scope (installation 7) while the record is local scope 0. A hosted
    // acceptance for that request must never close the local record.
    const wrongScope = await makeRig("localwrongscope", {
      summaries: false,
      localScope: true,
    });
    try {
      const request = releaseRequest("release-wrong-scope", {
        revision: SHA3,
        source: {
          pullRequest: 12,
          reviewRequestId: "review-req-wrong-scope",
          reviewReceiptId: "review-receipt-wrong-scope",
          head: SHA1,
          base: SHA2,
        },
        createdAt: T0,
      });
      const seeded = await wrongScope.store.writeRepair(
        seededSnapshot([localDeliveryRecord()], { releaseRequests: [request] }),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      await wrongScope.acceptRelease(request.id);
      const run = await wrongScope.run();
      const state = await wrongScope.snapshot();
      assert.equal(
        state.work[0].nextStep,
        "delivery",
        `wrong scope: no closure transition (${JSON.stringify(run)})`,
      );
      assert.equal(
        wrongScope.github.calls.filter((call) => call.startsWith("closeIssue"))
          .length,
        0,
        "wrong scope: zero closure calls",
      );
    } finally {
      await wrongScope.ctx.cleanup();
    }

    // Case 2: same local scope and PR/head, but the request's reviewed base
    // differs from the record base. A valid accepted local receipt for that
    // other request must never close this record either.
    const wrongBase = await makeRig("localwrongbase", {
      summaries: false,
      localScope: true,
    });
    try {
      const request = wrongBaseLocalRequest("release-wrong-base");
      const seeded = await wrongBase.store.writeRepair(
        seededSnapshot([localDeliveryRecord()], { releaseRequests: [request] }),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      let reads = 0;
      Object.assign(wrongBase.store, {
        readLocalRelease: () => {
          reads++;
          return Promise.resolve(portOk(localAcceptedReceipt(request)));
        },
      });
      const run = await wrongBase.run();
      const state = await wrongBase.snapshot();
      assert.equal(
        state.work[0].nextStep,
        "delivery",
        `wrong base: no closure transition (${JSON.stringify(run)})`,
      );
      assert.equal(
        reads,
        0,
        "wrong base: the wrong request is never observed by the local consumer",
      );
      assert.equal(
        wrongBase.github.calls.filter((call) => call.startsWith("closeIssue"))
          .length,
        0,
        "wrong base: zero closure calls",
      );
    } finally {
      await wrongBase.ctx.cleanup();
    }
  },
);

Deno.test(
  "local release: local scope cannot consume a fake hosted acceptance",
  async () => {
    const rig = await makeRig("localnofallback", {
      summaries: false,
      localScope: true,
    });
    try {
      const request = localDeliveryRequest("release-local-1", SHA3);
      const seeded = await rig.store.writeRepair(
        seededSnapshot([localDeliveryRecord()], { releaseRequests: [request] }),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      // A hosted Deno release record reports acceptance for the same request
      // id, but local scope has no local receipt: it must wait, never accept.
      await rig.acceptRelease(request.id);
      Object.assign(rig.store, {
        readLocalRelease: () => Promise.resolve(portOk(null)),
      });
      const run = await rig.run();
      assert.equal(run.status, "idle", JSON.stringify(run));
      const state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "delivery");
      assert.equal(state.work[0].wait?.reason, "unavailable");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "local release: nonlocal delivery still consumes the hosted release gateway",
  async () => {
    const rig = await makeRig("localgateway", { summaries: false });
    try {
      const request = releaseRequest("release-gateway-1", {
        revision: SHA3,
        source: {
          pullRequest: 12,
          reviewRequestId: "review-req-gateway",
          reviewReceiptId: "review-receipt-gateway",
          head: SHA1,
          base: SHA2,
        },
        createdAt: T0,
      });
      const seeded = await rig.store.writeRepair(
        seededSnapshot([gatewayDeliveryRecord()], {
          releaseRequests: [request],
        }),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      await rig.acceptRelease(request.id);
      let reads = 0;
      Object.assign(rig.store, {
        readLocalRelease: () => {
          reads++;
          return Promise.resolve(
            portOk(
              localAcceptedReceipt(
                localDeliveryRequest("release-local-1", SHA3),
              ),
            ),
          );
        },
      });
      const run = await rig.run();
      assert.equal(run.status, "idle", JSON.stringify(run));
      const state = await rig.snapshot();
      assert.equal(
        state.work[0].nextStep,
        "done",
        "the hosted gateway path is unchanged for nonlocal targets",
      );
      assert.equal(reads, 0, "the local capability is never consulted");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "local release: another scope-0 repository cannot consume the Sentinel local receipt",
  async () => {
    // The explicit local Sentinel scope is exactly ubiquity/sentinel at
    // installation 0. A different repository that also uses scope 0 is not
    // local: its delivery record must take the hosted path and never even
    // consult the Sentinel local receipt capability, let alone consume an
    // accepted Sentinel receipt returned by it.
    const rig = await makeRig("localotherscope", {
      summaries: false,
      configOverrides: {
        repository: OTHER_SCOPE_ZERO_REPO,
        adapter: { kind: "github" },
      },
    });
    try {
      const request = releaseRequest("release-other-scope-1", {
        target: {
          repository: OTHER_SCOPE_ZERO_REPO,
          environment: "production",
        },
        revision: SHA3,
        source: {
          pullRequest: 12,
          reviewRequestId: "review-req-other-scope-1",
          reviewReceiptId: "review-receipt-other-scope-1",
          head: SHA1,
          base: SHA2,
        },
        createdAt: T0,
      });
      const record = workRecord("other-scope-delivery-1", {
        repository: OTHER_SCOPE_ZERO_REPO,
        source: {
          kind: "issue",
          id: String(LOCAL_DELIVERY_ISSUE),
          revision: SHA1,
        },
        related: { incidentId: null, issueNumber: LOCAL_DELIVERY_ISSUE },
        target: {
          base: SHA2,
          branch: null,
          checkpoint: null,
          head: SHA1,
          pr: 12,
        },
        nextStep: "delivery",
        updatedAt: T0 + 1000,
      });
      const seeded = await rig.store.writeRepair(
        seededSnapshot([record], { releaseRequests: [request] }),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      // The capability offers the accepted SENTINEL local receipt for a
      // Sentinel request; the other scope-0 repository must not be its
      // consumer.
      let reads = 0;
      Object.assign(rig.store, {
        readLocalRelease: () => {
          reads++;
          return Promise.resolve(
            portOk(
              localAcceptedReceipt(
                localDeliveryRequest("release-local-1", SHA3),
              ),
            ),
          );
        },
      });
      const run = await rig.run();
      assert.equal(run.status, "idle", JSON.stringify(run));
      const state = await rig.snapshot();
      assert.equal(
        state.work[0].nextStep,
        "delivery",
        "another scope-0 repository never closes through the local receipt",
      );
      assert.equal(
        reads,
        0,
        "the Sentinel local receipt capability is never consulted",
      );
      assert.equal(
        rig.github.calls.filter((call) => call.startsWith("closeIssue"))
          .length,
        0,
        "zero closure calls",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

/**
 * Known-eligible issue source whose configured development ref read fails (no
 * fresh base): the native relations resolve, so the run reaches the base read
 * instead of stopping at the prerequisite read.
 */
class BaseRefUnavailableGithub extends RelationsFakeGithub {
  override readRef(
    ref: string,
  ): Promise<PortResultV1<{ ref: string; sha: GitSha } | null>> {
    if (ref.endsWith("refs/heads/development")) {
      this.calls.push(`readRef:${ref}`);
      return Promise.resolve(
        portError("unavailable", "development ref read failed"),
      );
    }
    return super.readRef(ref);
  }
}

Deno.test(
  "queued issue base: stale target base is refreshed before admission and history survives",
  async () => {
    const sourceIssue = issueRecord(1, {
      title: "queued repair",
      body: "body",
      relations: { openBlockers: [], subIssueCount: 0 },
    });
    const github = new RelationsFakeGithub({ baseSha: SHA2 });
    github.listed = [sourceIssue];
    github.latest.set(1, sourceIssue);
    const rig = makeMemoryRig(github);
    const queued = workRecord("issue-1", {
      source: { kind: "issue", id: "1", revision: SHA3 },
      counters: { attempts: 2, retries: 2, reviewRounds: 3 },
      firstSeenAt: T0 - 10_000,
      createdAt: T0 - 9_000,
      // The deterministic branch identity is already recorded: the first work
      // step of the loop assigns a candidate branch when it is null, so seeding
      // it is what lets the first single step reach the intended queued-base
      // refresh instead of stopping at branch assignment.
      target: {
        base: SHA1,
        branch: "sentinel/repair/issue-1",
        checkpoint: null,
        head: null,
        pr: null,
      },
    });
    const written = await rig.state.writeRepair(
      seededSnapshot([queued]),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");

    // One step: only the base refresh is persisted; nothing is reserved yet.
    const first = await rig.run(1);
    assert.equal(first.status, "step_limit", JSON.stringify(first));
    let state = await rig.snapshot();
    assert.equal(state.work[0].target.base, SHA2);
    assert.equal(state.work[0].source.revision, SHA3, "source revision kept");
    assert.deepEqual(state.work[0].counters, {
      attempts: 2,
      retries: 2,
      reviewRounds: 3,
    });
    assert.equal(state.work[0].id, queued.id);
    assert.equal(state.work[0].createdAt, T0 - 9_000);
    assert.equal(state.work[0].firstSeenAt, T0 - 10_000);
    assert.equal(rig.model.requests.length, 0, "refresh never starts a model");
    assert.equal(state.reservations.length, 0, "refresh reserves nothing");

    // The next admission charges and runs against the refreshed base.
    await rig.run(1);
    assert.equal(rig.model.requests.length, 1);
    assert.equal(rig.model.requests[0].base, SHA2);
    state = await rig.snapshot();
    assert.equal(state.reservations.length, 1);
    assert.equal(state.reservations[0].head, SHA2);
    // The third implementation start is admitted (the cap is three attempts).
    assert.equal(state.work[0].counters.attempts, 3);
    assert.equal(state.work[0].source.revision, SHA3);
  },
);

Deno.test(
  "queued issue base: an unavailable development ref reserves nothing",
  async () => {
    const sourceIssue = issueRecord(1, {
      title: "queued repair",
      body: "body",
      relations: { openBlockers: [], subIssueCount: 0 },
    });
    const github = new BaseRefUnavailableGithub();
    github.listed = [sourceIssue];
    github.latest.set(1, sourceIssue);
    const rig = makeMemoryRig(github);
    const written = await rig.state.writeRepair(
      seededSnapshot([
        workRecord("issue-1", {
          source: { kind: "issue", id: "1", revision: SHA1 },
        }),
      ]),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.ok(
      github.calls.includes("readRef:refs/heads/development"),
      "the eligible issue reaches the unavailable base read",
    );
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 0);
    assert.equal(state.work[0].target.base, SHA1, "base stays as recorded");
    assert.equal(state.work[0].wait?.reason, "unavailable");
    assert.equal(state.work[0].wait?.until, T0 + 60 * 60_000);
    assert.deepEqual(state.work[0].counters, {
      attempts: 0,
      retries: 0,
      reviewRounds: 0,
    });
  },
);

Deno.test(
  "queued issue base: a saved candidate keeps its recorded base on the correction path",
  async () => {
    const sourceIssue = issueRecord(1, {
      title: "queued repair",
      body: "body",
      relations: { openBlockers: [], subIssueCount: 0 },
    });
    const github = new RelationsFakeGithub({ baseSha: SHA2 });
    github.listed = [sourceIssue];
    github.latest.set(1, sourceIssue);
    const rig = makeMemoryRig(github);
    const correction = workRecord("issue-1", {
      source: { kind: "issue", id: "1", revision: SHA1 },
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
    // Without a completed, finding-bearing receipt for the CURRENT head the
    // work step would wait on the existing review. The receipt binds the exact
    // repository/PR/head/base and one unresolved P1 finding, so the run must
    // actually correct the rejected candidate.
    const rejected = reviewReceipt("review-receipt-1", {
      repository: REPO,
      pullRequest: { number: 7, head: SHA3, base: SHA1 },
      outcome: "completed",
      resultId: "result-1",
      observedReviewer: "chatgpt-codex-connector[bot]",
      submittedAt: T0,
      completedAt: T0 + 1000,
      observedAt: T0 + 1001,
      findings: [{
        id: "finding-1",
        severity: "P1",
        path: "src/app.ts",
        message: "required fix",
        fingerprint: "a".repeat(64),
        resolved: false,
        resolutionEvidence: null,
      }],
      unresolvedSeverities: ["P1"],
    });
    const written = await rig.state.writeRepair(
      seededSnapshot([correction], { reviews: [rejected] }),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");

    // Exactly ONE step: this test asserts the one correction operation for the
    // seeded rejected head. The fake always returns SHA3, the same head the
    // review rejected, so any further step would "correct" that unchanged
    // rejected fake head again and inflate the model/reservation counts; the
    // single step exercises the correction path being asserted here.
    await rig.run(1);
    const state = await rig.snapshot();
    assert.equal(rig.model.requests.length, 1);
    assert.equal(
      rig.model.requests[0].base,
      SHA1,
      "candidate correction is never rebased",
    );
    assert.equal(state.reservations[0].head, SHA1);
    assert.equal(state.work[0].target.base, SHA1);
    assert.ok(
      !github.calls.includes("readRef:refs/heads/development"),
      "saved-candidate work never reads the development ref",
    );
  },
);

// ---------------------------------------------------------------------------
// Hosted supervisor release receipt consumption (self scope 0). These cases run
// through the actual runRepairEntrypoint with a real temporary Git state and the
// REAL persisted-receipt reader wired exactly as the hosted host wires it.
// ---------------------------------------------------------------------------

/** Advance the ACTUAL supervisor core into the phase over the real store. */
async function seedHostedReceipt(
  rig: RigV1,
  request: ReleaseRequestV1,
  phase: HostedReceiptPhaseV1,
) {
  return await persistHostedReceipt({
    release: rig.releaseStore,
    clock: rig.clock,
    request,
    priorRevision: SHA2,
    phase,
  });
}

/** A found release snapshot without any hosted receipt (missing record). */
async function seedEmptyRelease(rig: RigV1): Promise<void> {
  const snapshot = parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    releases: [],
    hostedRuntimes: [],
    hostedReleases: [],
    githubCooldowns: [],
  });
  const written = await rig.releaseStore.writeRelease(snapshot, null);
  assert.ok(
    written.ok && written.value.status === "applied",
    JSON.stringify(written),
  );
}

/** Seed one delivery record + matching open request through the entry. */
async function seedActionsDelivery(
  rig: RigV1,
  request: ReleaseRequestV1,
  record: WorkRecordV1 = localDeliveryRecord(),
): Promise<void> {
  const seeded = await rig.store.writeRepair(
    seededSnapshot([record], { releaseRequests: [request] }),
    null,
  );
  assert.ok(seeded.ok && seeded.value.status === "applied");
}

/** Production wiring: the real reader over the repair store's release view. */
function wireHostedReader(rig: RigV1): void {
  Object.assign(rig.store, {
    readHostedRelease: (request: ReleaseRequestV1) =>
      readHostedReleaseReceipt({ state: rig.store }, request),
  });
}

Deno.test(
  "hosted release: an accepted persisted receipt closes the delivery record once",
  async () => {
    const rig = await makeRig("hostedaccept", {
      summaries: false,
      localScope: true,
    });
    try {
      const request = localDeliveryRequest("release-hosted-1", SHA3);
      await seedActionsDelivery(rig, request);
      await seedHostedReceipt(rig, request, "accepted");
      wireHostedReader(rig);
      const run = await rig.entry();
      assert.equal(run.status, "idle", JSON.stringify(run));
      const state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "done");
      assert.equal(state.work[0].intent, null, "closure intent settled");
      assert.equal(
        rig.github.calls.filter((call) => call.startsWith("closeIssue"))
          .length,
        1,
        "exactly one closure for the accepted hosted receipt",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "hosted release: a rolled_back persisted receipt blocks without closure",
  async () => {
    const rig = await makeRig("hostedrollback", {
      summaries: false,
      localScope: true,
    });
    try {
      const request = localDeliveryRequest("release-hosted-1", SHA3);
      await seedActionsDelivery(rig, request);
      await seedHostedReceipt(rig, request, "rolled_back");
      wireHostedReader(rig);
      const run = await rig.entry();
      assert.equal(run.status, "idle", JSON.stringify(run));
      const state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "blocked");
      assert.equal(
        rig.github.calls.filter((call) => call.startsWith("closeIssue"))
          .length,
        0,
        "no closure for a rolled-back hosted receipt",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "hosted release: requested and verifying persisted receipts wait",
  async () => {
    for (const phase of ["requested", "verifying"] as const) {
      const rig = await makeRig(`hosted-${phase}`, {
        summaries: false,
        localScope: true,
      });
      try {
        const request = localDeliveryRequest("release-hosted-1", SHA3);
        await seedActionsDelivery(rig, request);
        await seedHostedReceipt(rig, request, phase);
        wireHostedReader(rig);
        const run = await rig.entry();
        assert.ok(
          run.status === "idle" || run.status === "margin",
          `${phase}: ${JSON.stringify(run)}`,
        );
        const state = await rig.snapshot();
        assert.equal(state.work[0].nextStep, "delivery", phase);
        assert.equal(state.work[0].wait?.reason, "unavailable", phase);
        assert.equal(
          rig.github.calls.filter((call) => call.startsWith("closeIssue"))
            .length,
          0,
          phase,
        );
      } finally {
        await rig.ctx.cleanup();
      }
    }
  },
);

Deno.test(
  "hosted release: missing, error, throwing, malformed, wrong-id and wrong-request receipts wait",
  async () => {
    const request = localDeliveryRequest("release-hosted-1", SHA3);
    const other = localDeliveryRequest("release-hosted-2", SHA3);
    // Same deterministic id as the loop request, different canonical request.
    const mismatched = releaseRequest("release-hosted-1", {
      target: { repository: LOCAL_SENTINEL_REPO, environment: "production" },
      revision: SHA3,
      source: {
        pullRequest: 13,
        reviewRequestId: "review-req-release-hosted-1",
        reviewReceiptId: "review-receipt-release-hosted-1",
        head: SHA1,
        base: SHA2,
      },
      createdAt: T0,
    });
    const cases: Array<{
      name: string;
      seed: "absent" | "empty" | "none";
      wire: (rig: RigV1) => Promise<void> | void;
    }> = [
      {
        name: "absent-state",
        seed: "absent",
        wire: (rig) => wireHostedReader(rig),
      },
      {
        name: "missing-record",
        seed: "empty",
        wire: (rig) => wireHostedReader(rig),
      },
      {
        name: "error",
        seed: "none",
        wire: (rig) => {
          Object.assign(rig.store, {
            readHostedRelease: () =>
              Promise.resolve(portError("unavailable", "down")),
          });
        },
      },
      {
        name: "throwing",
        seed: "none",
        wire: (rig) => {
          Object.assign(rig.store, {
            readHostedRelease: () => Promise.reject(new Error("boom")),
          });
        },
      },
      {
        name: "malformed",
        seed: "none",
        wire: (rig) => {
          Object.assign(rig.store, {
            readHostedRelease: () =>
              Promise.resolve(
                portOk({ version: "v1", kind: "hosted_release" }),
              ),
          });
        },
      },
      {
        name: "wrong-id",
        seed: "none",
        wire: async (rig) => {
          const record = await persistHostedReceipt({
            release: rig.releaseStore,
            clock: rig.clock,
            request: other,
            priorRevision: SHA2,
            phase: "accepted",
          });
          Object.assign(rig.store, {
            readHostedRelease: () => Promise.resolve(portOk(record)),
          });
        },
      },
      {
        name: "wrong-request",
        seed: "none",
        wire: async (rig) => {
          const record = await persistHostedReceipt({
            release: rig.releaseStore,
            clock: rig.clock,
            request: mismatched,
            priorRevision: SHA2,
            phase: "accepted",
          });
          Object.assign(rig.store, {
            readHostedRelease: () => Promise.resolve(portOk(record)),
          });
        },
      },
    ];
    for (const testCase of cases) {
      const rig = await makeRig(`hosted-${testCase.name}`, {
        summaries: false,
        localScope: true,
      });
      try {
        await seedActionsDelivery(rig, request);
        if (testCase.seed === "empty") await seedEmptyRelease(rig);
        await testCase.wire(rig);
        const run = await rig.entry();
        assert.ok(
          run.status === "idle" || run.status === "margin",
          `${testCase.name}: ${JSON.stringify(run)}`,
        );
        const state = await rig.snapshot();
        assert.equal(state.work[0].nextStep, "delivery", testCase.name);
        assert.equal(state.work[0].wait?.reason, "unavailable", testCase.name);
        assert.equal(
          rig.github.calls.filter((call) => call.startsWith("closeIssue"))
            .length,
          0,
          testCase.name,
        );
      } finally {
        await rig.ctx.cleanup();
      }
    }
  },
);

Deno.test(
  "hosted release: two self receipt authorities wait without consulting either",
  async () => {
    const rig = await makeRig("hosted-dual", {
      summaries: false,
      localScope: true,
    });
    try {
      const request = localDeliveryRequest("release-hosted-1", SHA3);
      await seedActionsDelivery(rig, request);
      const persisted = await seedHostedReceipt(rig, request, "accepted");
      let localReads = 0;
      let hostedReads = 0;
      Object.assign(rig.store, {
        readLocalRelease: () => {
          localReads++;
          return Promise.resolve(portOk(localAcceptedReceipt(request)));
        },
        readHostedRelease: () => {
          hostedReads++;
          return Promise.resolve(portOk(persisted));
        },
      });
      const run = await rig.entry();
      assert.ok(run.status === "idle" || run.status === "margin");
      const state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "delivery");
      assert.equal(localReads, 0, "no receipt authority is guessed");
      assert.equal(hostedReads, 0, "no receipt authority is guessed");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "hosted release: a foreign scope never reaches the hosted capability",
  async () => {
    const rig = await makeRig("hosted-foreign", {
      summaries: false,
      localScope: true,
    });
    try {
      const request = releaseRequest("release-gateway-1", {
        target: { repository: REPO, environment: "production" },
        revision: SHA3,
        source: {
          pullRequest: 12,
          reviewRequestId: "review-req-gateway-1",
          reviewReceiptId: "review-receipt-gateway-1",
          head: SHA1,
          base: SHA2,
        },
        createdAt: T0,
      });
      // The matching FOREIGN work record: repository REPO (installation 7),
      // not the Sentinel local scope, so the Deno release path applies.
      await seedActionsDelivery(rig, request, gatewayDeliveryRecord());
      let hostedReads = 0;
      Object.assign(rig.store, {
        readHostedRelease: () => {
          hostedReads++;
          return Promise.resolve(portOk(null));
        },
      });
      const run = await rig.entry();
      assert.equal(run.status, "idle", JSON.stringify(run));
      const state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "delivery");
      assert.equal(state.work[0].wait?.reason, "unavailable");
      assert.equal(
        hostedReads,
        0,
        "the hosted capability never attests another scope",
      );
      assert.equal(
        rig.github.calls.filter((call) => call.startsWith("closeIssue"))
          .length,
        0,
        "no closure for a foreign scope",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// M15 V1 candidate state: the old reader parks new-format work without
// mutating it, and unrelated legacy work still advances.
// ---------------------------------------------------------------------------

const CANDIDATE_REF = `refs/heads/sentinel-candidates/${"ab".repeat(32)}`;
const PRODUCING_RESERVATION = "cd".repeat(32);
/** Parked candidate head; distinct from the fake model's SHA3 candidate. */
const PARKED_HEAD = SHA2;

function candidateStateFor(
  base: GitSha,
  head: GitSha | null,
): Record<string, unknown> {
  return head === null ? { preserved: null, publishedHead: null } : {
    preserved: {
      operationKey: `impl:${PRODUCING_RESERVATION}`,
      base,
      head,
      ref: CANDIDATE_REF,
    },
    publishedHead: head,
  };
}

function parkedIssueWork(
  id: string,
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return workRecord(id, {
    source: { kind: "issue", id, revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    target: {
      base: SHA1,
      branch: `sentinel/repair/${id}`,
      checkpoint: null,
      head: PARKED_HEAD,
      pr: 7,
      candidateState: candidateStateFor(SHA1, PARKED_HEAD),
    },
    ...overrides,
  });
}

Deno.test("parked candidate records stay unselected, unmodified and uncharged", async () => {
  const rig = await makeRig("candidate-parked", { summaries: false });
  try {
    const pushParked = parkedIssueWork("parked-push", {
      nextStep: "work",
      intent: {
        kind: "push",
        key: pushIntentKey(PARKED_HEAD),
        startedAt: T0,
        branch: "sentinel/repair/parked-push",
        expectedHead: PARKED_HEAD,
        observedBase: SHA1,
        pr: null,
        requestId: null,
        resultId: null,
      },
    });
    const implementationParked = parkedIssueWork("parked-impl", {
      nextStep: "work",
      intent: {
        kind: "implementation",
        key: `impl:${PRODUCING_RESERVATION}`,
        startedAt: T0,
        branch: "sentinel/repair/parked-impl",
        expectedHead: PARKED_HEAD,
        observedBase: SHA1,
        pr: null,
        requestId: PRODUCING_RESERVATION,
        resultId: null,
      },
    });
    const baseRefreshParked = parkedIssueWork("parked-refresh", {
      nextStep: "delivery",
      intent: {
        kind: "base_refresh",
        key: `push:${PARKED_HEAD}`,
        startedAt: T0,
        branch: "sentinel/repair/parked-refresh",
        expectedHead: PARKED_HEAD,
        observedBase: SHA1,
        pr: 7,
        requestId: null,
        resultId: null,
      },
    });
    const closureParked = parkedIssueWork("parked-closure", {
      nextStep: "delivery",
      intent: {
        kind: "issue_closure",
        key: "issue_closure:1",
        startedAt: T0,
        branch: null,
        expectedHead: null,
        observedBase: null,
        pr: 7,
        requestId: null,
        resultId: null,
      },
    });
    // An expired review wait does not make parked work eligible.
    const reviewParked = parkedIssueWork("parked-review", {
      nextStep: "review",
      wait: { reason: "review_pending", since: T0 - 2, until: T0 - 1 },
    });
    // Null-preserved parked work (no head, no PR) is parked as well.
    const nullParked = parkedIssueWork("parked-null", {
      nextStep: "work",
      target: {
        base: SHA1,
        branch: "sentinel/repair/parked-null",
        checkpoint: null,
        head: null,
        pr: null,
        candidateState: candidateStateFor(SHA1, null),
      },
    });
    // Terminal/blocked parked records keep their exact bytes too.
    const doneParked = parkedIssueWork("parked-done", { nextStep: "done" });
    const blockedParked = parkedIssueWork("parked-blocked", {
      nextStep: "blocked",
      blocker: { kind: "missing_evidence", message: "parked", since: T0 },
    });
    const records = [
      pushParked,
      implementationParked,
      baseRefreshParked,
      closureParked,
      reviewParked,
      nullParked,
      doneParked,
      blockedParked,
    ];
    const before = new Map(
      records.map((record) => [record.id, canonicalStringify(record)]),
    );
    const written = await rig.store.writeRepair(
      seededSnapshot(records),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(state.sequence, 1, "parked records cause no state write");
    assert.equal(state.work.length, records.length);
    for (const record of records) {
      const after = state.work.find((work) => work.id === record.id);
      assert.ok(after, `parked record ${record.id} survives`);
      assert.equal(
        canonicalStringify(after),
        before.get(record.id),
        `${record.id} bytes are unchanged`,
      );
    }
    assert.equal(rig.model.requests.length, 0, "no model start");
    assert.equal(rig.replay.requests.length, 0, "no replay run");
    assert.equal(rig.github.pushes.length, 0, "no push");
    assert.deepEqual(rig.github.calls, ["listOpenIssues"], "no effect calls");
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("changed incident intake cannot mutate parked work and legacy work still advances", async () => {
  const rig = await makeRig("candidate-intake", {
    github: {
      openIssues: [issueRecord(55), issueRecord(101)],
      issues: [issueRecord(101)],
    },
  });
  try {
    const parkedIncident = workRecord("incident-parked", {
      source: { kind: "incident", id: "inc-a", revision: SHA2 },
      related: { incidentId: "inc-a", issueNumber: null },
      fingerprint: FINGERPRINT,
      failingRevision: SHA2,
      nextStep: "review",
      wait: { reason: "review_pending", since: T0 - 2, until: T0 - 1 },
      target: {
        base: SHA1,
        branch: candidateBranch(asWorkItemId("incident-parked")),
        checkpoint: null,
        head: PARKED_HEAD,
        pr: 7,
        candidateState: candidateStateFor(SHA1, PARKED_HEAD),
      },
    });
    // A parked ISSUE task must be found by the whole-snapshot issue lookup and
    // never recreated from the incoming issue list.
    const parkedIssue = parkedIssueWork("issue-55", {
      source: { kind: "issue", id: "55", revision: SHA1 },
      related: { incidentId: null, issueNumber: 55 },
      nextStep: "work",
    });
    const storedSummary = summaryFixture();
    const written = await rig.store.writeRepair(
      seededSnapshot([parkedIncident, parkedIssue], {
        incidents: [storedSummary],
      }),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");
    const beforeIncident = canonicalStringify(parkedIncident);
    const beforeIssue = canonicalStringify(parkedIssue);
    const beforeSummary = canonicalStringify(storedSummary);

    // The source now reports a changed summary for the parked incident. The
    // old reader must skip it entirely, preserving the stored summary and the
    // parked work bytes.
    rig.incidents.setSummaries([
      incidentSummary("inc-a", {
        fingerprint: FINGERPRINT,
        severity: "P0",
        count: 9,
        firstSeenAt: storedSummary.firstSeenAt,
        lastSeenAt: T0 + 900_000,
        failingRevision: SHA2,
        context: {
          message: "changed upstream failure",
          location: null,
          sample: [],
        },
        evidenceRef: storedSummary.evidenceRef,
      }),
    ]);

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();

    const afterIncident = state.work.find((work) =>
      work.id === parkedIncident.id
    );
    const afterIssue = state.work.find((work) => work.id === parkedIssue.id);
    assert.ok(afterIncident && afterIssue);
    assert.equal(canonicalStringify(afterIncident), beforeIncident);
    assert.equal(canonicalStringify(afterIssue), beforeIssue);
    assert.equal(
      canonicalStringify(state.incidents[0]),
      beforeSummary,
      "the stored incident summary is preserved",
    );
    assert.equal(
      state.work.length,
      3,
      "the parked issue task was not recreated",
    );

    // The unrelated legacy issue advanced through the real loop.
    const legacy = state.work.find((work) =>
      work.source.kind === "issue" && work.source.id === "101"
    );
    assert.ok(legacy, "the legacy issue task exists");
    assert.equal(legacy?.nextStep, "review");
    assert.equal(legacy?.wait?.reason, "review_pending");
    assert.equal(legacy?.target.head, SHA3);
    assert.equal(legacy?.target.pr, 7);
    assert.equal(legacy?.counters.attempts, 1);
    assert.equal(
      rig.model.requests.length,
      1,
      "exactly one model start, for the legacy task",
    );
    assert.equal(rig.github.pushes.length, 1, "one legacy candidate push");
    assert.equal(
      rig.github.calls.filter((call) => call === "createPr").length,
      1,
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "merge").length,
      0,
      "no merge for the parked incident",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "observeReview").length,
      0,
      "the expired parked review wait is never observed",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});
