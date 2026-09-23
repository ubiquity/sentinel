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
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type {
  GitHubIssueV1,
  GitHubPort,
  GitHubPullRequestV1,
  LegacyBaseRefreshLossProofV1,
  PortResultV1,
  ReviewObservationV1,
} from "../../src/contracts/ports.ts";
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
import {
  baseRefreshIntentKey,
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
  pushIntentKey,
  reviewReceiptId,
  workItemIdForIncident,
  workItemIdForIssue,
} from "../../src/repair/keys.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import type { RepairCycleDepsV1 } from "../../src/repair/loop.ts";
import { runRepairEntrypoint } from "../../src/main.ts";
import {
  applyHostedRetirements,
  HOSTED_AUTONOMY_RETIRED,
  planHostedRetirements,
} from "../../ops/hosted-autonomy.ts";
import { persistHostedReceipt } from "../host/hosted-receipt-fixture.ts";
import type { HostedReceiptPhaseV1 } from "../host/hosted-receipt-fixture.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { readHostedReleaseReceipt } from "../../src/host/actions-release.ts";
import {
  DEP_0,
  DEP_2,
  gitRun,
  incidentEvidence,
  incidentSummary,
  makeRemoteCtx,
  monitoredReleaseRecord,
  releaseRequest,
  REPO,
  reservation,
  reviewReceipt,
  SHA1,
  SHA2,
  sha256Hex,
  SHA3,
  T0,
  testGitEnv,
  workRecord,
} from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  type FakeGithubCandidateLifecycleV1,
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
    bare: remote.bare,
    work: remote.work,
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
    const rig = await makeRig("lifecycle", {
      github: { candidateLifecycle: positiveLifecycle() },
    });
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
      const published = [...rig.github.candidatePullRequests.values()];
      assert.equal(published.length, 1, "one published pull request");
      assert.equal(
        published[0].body,
        `Sentinel repair for incident ${work.source.id}`,
        "an incident task keeps a non-closing descriptive body",
      );
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
  const rig = await makeRig("secondtask", {
    github: { candidateLifecycle: positiveLifecycle() },
  });
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
    github: {
      pushOutcome: "ambiguous",
      reviewRequestOutcome: "ambiguous",
      candidateLifecycle: positiveLifecycle(),
    },
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
  const id = asWorkItemId("issue-1");
  const branch = candidateBranch(id);
  const rig = await makeRig("pushcontinue", {
    summaries: false,
    github: {
      candidateLifecycle: {
        ...positiveLifecycle(),
        refs: { [`refs/heads/${branch}`]: SHA3 },
        pullRequests: [exactOpenPr(7, SHA3, branch)],
      },
    },
  });
  try {
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
    github: {
      reviewRequestedAt: submittedAt,
      candidateLifecycle: positiveLifecycle(),
    },
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
    github: { candidateLifecycle: positiveLifecycle() },
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

Deno.test(
  "repair loop: implementation uncertainty persists after budget settlement",
  async () => {
    // Regression for the audited defect: the ambiguous settlement of an
    // unsettled implementation intent writes the SAME authoritative repair
    // state, so the block must be applied to the REREAD head. Applying it to
    // the pre-settlement context is refused as state_error and the blocked
    // disposition is lost (the reservation still moves reserved -> ambiguous).
    const sourceIssue = issueRecord(31, {
      title: "uncertain implementation",
      relations: { openBlockers: [], subIssueCount: 0 },
    });
    const github = new RelationsFakeGithub({ baseSha: SHA1 });
    github.listed = [sourceIssue];
    github.latest.set(31, sourceIssue);
    const rig = makeMemoryRig(github);
    const reservationId = "res-uncertain";
    const taskId = asWorkItemId("issue-31");
    const branch = candidateBranch(taskId);
    const uncertain = workRecord("issue-31", {
      source: { kind: "issue", id: "31", revision: SHA1 },
      related: { incidentId: null, issueNumber: 31 },
      target: { base: SHA1, branch, checkpoint: null, head: null, pr: null },
      nextStep: "work",
      counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      intent: {
        kind: "implementation",
        key: implementationIntentKey(reservationId),
        startedAt: T0,
        branch,
        expectedHead: null,
        observedBase: SHA1,
        pr: null,
        requestId: reservationId,
        resultId: null,
      },
    });
    // Unsettled reservation in the authoritative state the budget port writes.
    const charge = reservation(reservationId, {
      taskId,
      attempt: 1,
      head: SHA1,
      purpose: "implementation",
      outcome: "reserved",
      settledAt: null,
    });
    const written = await rig.state.writeRepair(
      seededSnapshot([uncertain], { reservations: [charge] }),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");

    // BASE returns state_error here (settlement moved the head); the fix
    // reloads the settled head and stores the blocked disposition.
    const outcome = await rig.run(3);
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(state.reservations.length, 1, "no replacement admission");
    assert.equal(state.reservations[0].id, reservationId);
    assert.equal(state.reservations[0].outcome, "ambiguous");
    assert.ok(state.reservations[0].settledAt !== null, "charge settled");
    const stored = state.work.find((work) => work.id === "issue-31")!;
    assert.equal(stored.nextStep, "blocked");
    assert.equal(stored.blocker?.kind, "other");
    assert.equal(stored.intent?.requestId, reservationId);
    assert.equal(rig.model.requests.length, 0, "never resubmitted");
  },
);

Deno.test("rolling budget caps share model starts and review requests", async () => {
  const rig = await makeRig("sharedcap", {
    configOverrides: { liveStartLimits: { perHour: 1, perSevenDays: 5 } },
    github: { candidateLifecycle: positiveLifecycle() },
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
      8,
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
    github: {
      reviewRequestOutcome: "ambiguous",
      candidateLifecycle: positiveLifecycle(),
    },
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
    assert.equal(state.work[0].intent?.pr, 7, "exact PR binding");
    assert.equal(
      state.work[0].intent?.expectedHead,
      SHA3,
      "exact head binding",
    );
    assert.equal(
      state.reviews.length,
      0,
      "a lost acknowledgement never fabricates a completed verdict",
    );
    assert.equal(state.reservations.length, 2);
    const review = state.reservations.find((reservation) =>
      reservation.purpose === "review_request"
    );
    assert.ok(review, "review admission reservation exists");
    assert.equal(review?.outcome, "ambiguous");
    assert.ok(review?.settledAt !== null, "ambiguous charge is settled");
    const ambiguousBytes = canonicalStringify(review);
    const savedIntent = state.work[0].intent;

    // Recovery observes the exact remote review state: no resubmission, no
    // second charge. The actual observation request is bound to the saved
    // operation/PR/head instead of trusting the fixture.
    const observe = rig.github.observeReview.bind(rig.github);
    let observedKey: string | null = null;
    let observedPr: number | null = null;
    let observedHead: GitSha | null = null;
    rig.github.observeReview = (request) => {
      const bound = request as {
        operationKey: string;
        prNumber: number;
        head: GitSha;
      };
      observedKey = bound.operationKey;
      observedPr = bound.prNumber;
      observedHead = bound.head;
      return observe(request);
    };
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
    assert.equal(state.work[0].intent?.kind, "review_request");
    assert.equal(state.work[0].intent?.expectedHead, SHA3);
    assert.equal(
      state.reviews.length,
      0,
      "pending observation is not a verdict",
    );
    assert.equal(state.reservations.length, 2, "no second review charge");
    assert.equal(observedKey, savedIntent?.key, "exact saved operation");
    assert.equal(observedPr, savedIntent?.pr, "exact saved PR");
    assert.equal(observedHead, savedIntent?.expectedHead, "exact saved head");
    assert.equal(
      canonicalStringify(
        state.reservations.find((entry) => entry.id === review?.id),
      ),
      ambiguousBytes,
      "the original ambiguous reservation is unchanged",
    );

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
    github: {
      reviewRequestFailNext: true,
      candidateLifecycle: positiveLifecycle(),
    },
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
    const ambiguousBytes = canonicalStringify(review);
    const savedIntent = state.work[0].intent;

    // The restart observes exactly the saved operation/PR/head and leaves the
    // original ambiguous reservation byte-identical.
    const observe = rig2.github.observeReview.bind(rig2.github);
    let observedKey: string | null = null;
    let observedPr: number | null = null;
    let observedHead: GitSha | null = null;
    rig2.github.observeReview = (request) => {
      const bound = request as {
        operationKey: string;
        prNumber: number;
        head: GitSha;
      };
      observedKey = bound.operationKey;
      observedPr = bound.prNumber;
      observedHead = bound.head;
      return observe(request);
    };

    rig2.clock.advance(15 * 60_000 + 1);
    const second = await rig2.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(
      rig2.github.calls.filter((call) => call === "requestReview").length,
      1,
      "never resubmits",
    );
    const restarted = await rig2.snapshot();
    assert.equal(
      restarted.reservations.length,
      2,
      "no second charge",
    );
    assert.equal(observedKey, savedIntent?.key, "exact saved operation");
    assert.equal(observedPr, savedIntent?.pr, "exact saved PR");
    assert.equal(observedHead, savedIntent?.expectedHead, "exact saved head");
    assert.equal(
      canonicalStringify(
        restarted.reservations.find((entry) => entry.id === review?.id),
      ),
      ambiguousBytes,
      "the original ambiguous reservation is unchanged",
    );
  } finally {
    await rig2.ctx.cleanup();
  }
});

Deno.test(
  "review receipt: a completed observation is recorded even after its wait was cleared",
  async () => {
    const rig = await makeRig("clearedwait", {
      model: { heads: [SHA3, SHA4] },
      github: { candidateLifecycle: positiveLifecycle() },
    });
    try {
      // Run 1: the candidate reaches the review wait, which persists the
      // durable review-request reservation for this round.
      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));
      const state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "review");
      assert.equal(state.reservations.length, 2, "review is charged");

      // A bounded recovery cleared the wait while the review was completing,
      // so the record carries no wait to quote and its updatedAt is LATER than
      // the completion. The receipt must still be built from the reservation.
      rig.github.completeReview([{
        id: "finding-1",
        severity: "P1",
        path: "src/app.ts",
        message: "required fix",
        fingerprint: "a".repeat(64),
        resolved: false,
        resolutionEvidence: null,
      }], rig.clock.now());
      const read = await rig.store.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      if (!read.ok || read.value.status !== "found") return;
      rig.clock.advance(5 * 60_000);
      const cleared = {
        ...read.value.snapshot.work[0]!,
        wait: null,
        updatedAt: rig.clock.now(),
      };
      const written = await rig.store.writeRepair({
        ...read.value.snapshot,
        stateHead: read.value.head,
        sequence: read.value.snapshot.sequence + 1,
        updatedAt: rig.clock.now(),
        work: [cleared],
      }, read.value.head);
      assert.ok(
        written.ok && written.value.status === "applied",
        JSON.stringify(written),
      );

      rig.clock.advance(15 * 60_000 + 1);
      const second = await rig.run();
      assert.equal(second.status, "idle", JSON.stringify(second));
      const after = await rig.snapshot();
      const record = after.work[0]!;
      // The settled observation was recorded instead of being re-armed
      // forever: the receipt is durable and the task continues to a correction
      // that carries the exact finding.
      assert.ok(
        record.evidence.some((ref) =>
          ref.kind === "review_receipt" && ref.ref.includes("review-receipt:")
        ),
        "the completed review is recorded as a receipt",
      );
      // The recorded finding drove a correction in the SAME run: a fresh
      // implementation ran with the finding, published a new head and
      // requested its review, so the task is back at `review`.
      assert.equal(record.nextStep, "review");
      assert.equal(record.target.head, SHA4, "corrected candidate head");
      assert.equal(record.counters.reviewRounds, 2, "fresh correction round");
      assert.equal(rig.model.requests.length, 2);
      assert.deepEqual(rig.model.requests[1]?.reviewFindings, [{
        severity: "P1",
        path: "src/app.ts",
        message: "required fix",
      }]);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test("P1 findings trigger a fresh bounded implementation/candidate/replay path", async () => {
  const rig = await makeRig("p1fresh", {
    model: { heads: [SHA3, SHA4] },
    github: { candidateLifecycle: positiveLifecycle() },
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
    // The correction also carries the EXACT findings of the rejecting review:
    // without them the same change is re-implemented and the task can never
    // converge (a real four-round stalemate before this field existed).
    assert.deepEqual(
      rig.model.requests[1]?.reviewFindings,
      [{
        severity: "P1",
        path: "src/app.ts",
        message: "required fix",
      }],
      "the correction receives the unresolved review findings",
    );
    assert.equal(
      rig.model.requests[0]?.reviewFindings,
      undefined,
      "a first implementation carries no rejection findings",
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
    // A LATER correction also carries the earlier rejections of the same pull
    // request, so the model can converge on the rule rather than the last case.
    rig.clock.advance(15 * 60_000 + 1);
    rig.github.completeReview([{
      id: "finding-2",
      severity: "P2",
      path: "src/github/text.ts",
      message: "second required fix",
      fingerprint: "b".repeat(64),
      resolved: false,
      resolutionEvidence: null,
    }], rig.clock.now());
    const third = await rig.run();
    assert.equal(third.status, "idle", JSON.stringify(third));
    assert.equal(rig.model.requests.length, 3);
    const history = rig.model.requests[2]?.reviewFindings ?? [];
    const messages = history.map((finding) => finding.message);
    assert.ok(
      messages.includes("second required fix"),
      "the current rejection is carried",
    );
    assert.ok(
      messages.includes("required fix"),
      "the earlier rejection of the same pull request is carried too",
    );
  } finally {
    await rig.ctx.cleanup();
  }

  // No-verdict review observation keeps waiting (not an attempt or request).
  const rig3 = await makeRig("noverdict", {
    github: {
      reviewUnavailable: true,
      candidateLifecycle: positiveLifecycle(),
    },
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
      candidateLifecycle: positiveLifecycle(),
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
    const published = [...rig.github.candidatePullRequests.values()];
    assert.equal(published.length, 1, "one published pull request");
    assert.equal(
      published[0].body,
      "Resolves #1",
      "an issue task publishes exactly the GitHub closing keyword",
    );
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
    github: {
      candidateLifecycle: {
        ...positiveLifecycle(),
        refs: { "refs/heads/sentinel/repair/issue-1": SHA3 },
        pullRequests: [exactOpenPr(7, SHA3, "sentinel/repair/issue-1")],
      },
    },
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

Deno.test(
  "fresh publication: trusted retired PRs do not consume the unfinished-PR cap",
  async () => {
    const id = asWorkItemId("issue-1");
    const rig = await makeRig("retired-publish-cap", {
      summaries: false,
      github: {
        candidateLifecycle: {
          ...positiveLifecycle(),
          refs: {},
          pullRequests: [exactOpenPr(7, SHA2, "sentinel/repair/issue-100")],
        },
      },
    });
    try {
      const retired = [61, 120].map((number) =>
        workRecord(`issue-${number}`, {
          source: { kind: "issue", id: `${number}`, revision: SHA1 },
          related: { incidentId: null, issueNumber: number },
          nextStep: "blocked",
          blocker: {
            kind: "other",
            message: "source issue is closed; the repair no longer exists",
            since: T0,
          },
          target: {
            base: SHA1,
            branch: `sentinel/repair/issue-${number}`,
            checkpoint: null,
            head: SHA2,
            pr: 500 + number,
          },
        })
      );
      const live = workRecord("issue-100", {
        source: { kind: "issue", id: "100", revision: SHA1 },
        related: { incidentId: null, issueNumber: 100 },
        nextStep: "review",
        wait: { reason: "review_pending", since: T0, until: T0 + 3600_000 },
        target: {
          base: SHA1,
          branch: "sentinel/repair/issue-100",
          checkpoint: null,
          head: SHA2,
          pr: 7,
        },
      });
      const fresh = preservedIssueWork("issue-1", H1, {
        pr: null,
        publishedHead: null,
      });
      const written = await rig.store.writeRepair(
        seededSnapshot([...retired, live, fresh]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();
      const published = state.work.find((record) => record.id === id);
      assert.ok(published, "the fresh record exists");
      assert.equal(
        published?.nextStep,
        "review",
        "the fresh candidate publishes past two trusted retirements",
      );
      assert.equal(published?.wait?.reason, "review_pending");
      assert.equal(
        rig.github.pushes.length,
        1,
        "exactly one fresh candidate push",
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "createPr").length,
        1,
        "exactly one fresh PR",
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        1,
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

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
// Exact candidate lifecycle fixtures shared by the bounded production-loop
// recovery cases. Preservation success is always an explicit per-test opt-in.
// ---------------------------------------------------------------------------

const CANDIDATE_REF = `refs/heads/sentinel-candidates/${"ab".repeat(32)}`;
const PRODUCING_RESERVATION = "cd".repeat(32);
const CHECK_POLL_MS = 5 * 60_000;
/** Candidate head used by the candidate-state fixtures. */
const H0 = SHA2;
const H1 = SHA4;

/**
 * Explicit per-test positive lifecycle callbacks. These callbacks simulate
 * capability success over the fake ports (no storage); real preservation
 * storage evidence comes only from the existing destructive host fixtures. A
 * base refresh must never run while the configured base is unchanged.
 */
function positiveLifecycle(): FakeGithubCandidateLifecycleV1 {
  return {
    preserveCandidate: (request) => {
      assert.ok(request.taskId.length > 0, "preservation task identity");
      assert.match(
        request.candidate.ref,
        /^refs\/heads\/sentinel-candidates\/[0-9a-f]{64}$/,
        "preservation ref identity",
      );
      assert.match(
        request.candidate.operationKey,
        /^impl:[0-9a-f]{64}$/,
        "preservation operation identity",
      );
      assert.equal(request.candidate.head.length, 40);
      assert.equal(request.candidate.base.length, 40);
      return Promise.resolve(portOk(undefined));
    },
    prepareBaseRefresh: () => {
      throw new Error("a base refresh must never run for an unchanged base");
    },
  };
}

/** Exact open PR bound to the candidate branch/head/base. */
function exactOpenPr(
  number: number,
  head: GitSha,
  headRef: string,
  base: GitSha = SHA1,
): GitHubPullRequestV1 {
  return {
    number,
    title: "Sentinel repair",
    body: "Refs 1",
    state: "open",
    head,
    base,
    mergeSha: null,
    headRef,
    baseRef: "development",
    author: null,
    createdAt: T0,
    updatedAt: T0,
    mergedAt: null,
    reviewDecision: "none",
  };
}

function candidateStateFor(
  base: GitSha,
  head: GitSha | null,
): Record<string, unknown> {
  return head === null ? { preserved: null, publishedHead: null } : {
    preserved: {
      operationKey: implementationIntentKey(PRODUCING_RESERVATION),
      base,
      head,
      ref: CANDIDATE_REF,
    },
    publishedHead: head,
  };
}

/** Preserved/published issue candidate bound to its exact branch and PR. */
function preservedIssueWork(
  id: string,
  head: GitSha,
  options: {
    base?: GitSha;
    /** Explicit null models a preserved-but-never-published candidate. */
    publishedHead?: GitSha | null;
    pr?: number | null;
    nextStep?: WorkRecordV1["nextStep"];
    counters?: WorkRecordV1["counters"];
  } = {},
): WorkRecordV1 {
  const workId = asWorkItemId(id);
  const base = options.base ?? SHA1;
  return workRecord(id, {
    source: { kind: "issue", id, revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    target: {
      base,
      branch: candidateBranch(workId),
      checkpoint: null,
      head,
      pr: options.pr === undefined ? 7 : options.pr,
      candidateState: {
        preserved: {
          operationKey: implementationIntentKey(PRODUCING_RESERVATION),
          base,
          head,
          ref: CANDIDATE_REF,
        },
        publishedHead: options.publishedHead === undefined
          ? head
          : options.publishedHead,
      },
    },
    nextStep: options.nextStep ?? "work",
    counters: options.counters ?? { attempts: 1, retries: 0, reviewRounds: 1 },
  });
}

/** Stable candidate/accounting subset that no freshness refusal may alter. */
function candidateAccounting(record: WorkRecordV1): unknown {
  return {
    id: record.id,
    source: record.source,
    fingerprint: record.fingerprint,
    target: record.target,
    counters: record.counters,
    dependencies: record.dependencies,
    controller: record.controller,
    evidence: record.evidence,
  };
}

Deno.test(
  "candidate lifecycle: a missing preserved descriptor without intent defers safely",
  async () => {
    const rig = await makeRig("candidate-descriptor", { summaries: false });
    try {
      const id = asWorkItemId("issue-1");
      const record = workRecord("issue-1", {
        source: { kind: "issue", id: "1", revision: SHA1 },
        related: { incidentId: null, issueNumber: 1 },
        target: {
          base: SHA1,
          branch: candidateBranch(id),
          checkpoint: null,
          head: null,
          pr: null,
          candidateState: { preserved: null, publishedHead: null },
        },
        nextStep: "work",
      });
      const before = canonicalStringify(record);
      const written = await rig.store.writeRepair(
        seededSnapshot([record]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      const outcome = await rig.run();
      assert.equal(outcome.status, "margin", JSON.stringify(outcome));
      const state = await rig.snapshot();
      assert.equal(state.sequence, 1, "a safe deferral writes nothing");
      assert.equal(canonicalStringify(state.work[0]), before);
      assert.equal(state.reservations.length, 0);
      assert.equal(rig.model.requests.length, 0, "no model start");
      assert.equal(rig.replay.requests.length, 0, "no replay run");
      assert.equal(rig.github.pushes.length, 0, "no push");
      assert.equal(rig.github.preservationRequests.length, 0);
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        0,
        "no review request without a preserved descriptor",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle: an unavailable preserver keeps the exact intent/head with a bounded wait",
  async () => {
    const rig = await makeRig("candidate-preserve-unavailable", {
      summaries: false,
    });
    try {
      const id = asWorkItemId("issue-1");
      const operationKey = implementationIntentKey(PRODUCING_RESERVATION);
      const ref = await candidatePreservationRef(REPO, id, operationKey);
      const record = workRecord("issue-1", {
        source: { kind: "issue", id: "1", revision: SHA1 },
        related: { incidentId: null, issueNumber: 1 },
        target: {
          base: SHA1,
          branch: candidateBranch(id),
          checkpoint: null,
          head: H0,
          pr: null,
          candidateState: { preserved: null, publishedHead: null },
        },
        nextStep: "work",
        intent: {
          kind: "candidate_preservation",
          key: operationKey,
          startedAt: T0,
          branch: ref,
          expectedHead: H0,
          observedBase: SHA1,
          pr: null,
          requestId: PRODUCING_RESERVATION,
          resultId: null,
        },
        counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      });
      const written = await rig.store.writeRepair(
        seededSnapshot([record]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();
      const work = state.work[0];
      assert.equal(work.intent?.kind, "candidate_preservation");
      assert.equal(work.intent?.key, operationKey);
      assert.equal(work.intent?.requestId, PRODUCING_RESERVATION);
      assert.equal(work.intent?.resultId, null);
      assert.equal(work.intent?.expectedHead, H0);
      assert.equal(
        work.target.head,
        H0,
        "the exact candidate head is retained",
      );
      assert.equal(work.target.candidateState?.preserved, null);
      assert.equal(work.target.candidateState?.publishedHead, null);
      assert.equal(work.wait?.reason, "unavailable");
      assert.equal(work.wait?.until, T0 + CHECK_POLL_MS);
      assert.deepEqual(rig.github.preservationRequests, [{
        taskId: id,
        candidate: {
          operationKey,
          base: SHA1,
          head: H0,
          ref,
        },
        publishedHead: null,
      }]);
      assert.equal(state.reservations.length, 0, "no charge for a wait");
      assert.equal(rig.model.requests.length, 0);
      assert.equal(rig.github.pushes.length, 0);
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        0,
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle: a positively missing candidate returns to a fresh attempt instead of retrying forever",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    const operationKey = implementationIntentKey(PRODUCING_RESERVATION);
    const ref = await candidatePreservationRef(REPO, id, operationKey);
    const lifecycle = positiveLifecycle();
    const positivePreserve = lifecycle.preserveCandidate!;
    let preservations = 0;
    const rig = await makeRig("candidate-preserve-missing", {
      github: {
        issues: [{ number: 1, title: "reproducible failure", body: "body" }],
        candidateLifecycle: {
          ...lifecycle,
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H1, branch)],
          preserveCandidate: (request) => {
            preservations++;
            if (preservations === 1) {
              // The host loader's exact positive-absence classification: no
              // trusted store or remote ref holds the produced candidate.
              return Promise.resolve(
                portError(
                  "not_found",
                  "candidate is not available in the trusted local store",
                ),
              );
            }
            return positivePreserve(request);
          },
        },
      },
    });
    try {
      const record = workRecord("issue-1", {
        source: { kind: "issue", id: "1", revision: SHA1 },
        related: { incidentId: null, issueNumber: 1 },
        target: {
          base: SHA1,
          branch,
          checkpoint: null,
          head: H0,
          pr: 7,
          candidateState: { preserved: null, publishedHead: H1 },
        },
        nextStep: "work",
        intent: {
          kind: "candidate_preservation",
          key: operationKey,
          startedAt: T0,
          branch: ref,
          expectedHead: H0,
          observedBase: SHA1,
          pr: null,
          requestId: PRODUCING_RESERVATION,
          resultId: null,
        },
        counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      });
      const written = await rig.store.writeRepair(
        seededSnapshot([record]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      // Run 1: the missing candidate is never reconciled and the record never
      // parks on it. It returns to the legacy work shape bound to the published
      // branch head with its charged attempt history preserved, and the same
      // cycle buys exactly one fresh implementation attempt whose candidate is
      // preserved under a new operation identity.
      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));
      const state = await rig.snapshot();
      const work = state.work[0]!;
      assert.ok(
        rig.model.requests.length >= 1,
        "the recovery buys a fresh run",
      );
      assert.equal(work.target.head, SHA3, "the fresh candidate head");
      assert.equal(work.counters.attempts, 2, "one charged fresh attempt");
      assert.notEqual(
        work.target.candidateState?.preserved?.operationKey ?? null,
        operationKey,
        "the lost operation identity is retired",
      );
      assert.equal(
        work.target.candidateState?.preserved?.head ?? null,
        SHA3,
        "the fresh candidate is preserved",
      );
      assert.equal(work.target.candidateState?.publishedHead, SHA3);
      assert.equal(
        work.nextStep,
        "review",
        "the record advances past the loss",
      );
      assert.equal(work.wait?.reason, "review_pending");
      assert.ok(
        state.reservations.some((entry) =>
          entry.attempt === 2 && entry.purpose === "retry" &&
          entry.outcome === "submitted"
        ),
        "the fresh attempt is charged as a retry",
      );
      assert.ok(preservations >= 2, "one refused and one durable preservation");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle: a closed-unmerged own PR republishes the preserved candidate once",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    // GitHub freezes a closed pull request's head forever, so both shapes are
    // recoverable: the exact published head and a head that predates the
    // refreshed candidate now on the task branch (the live issue-138 shape).
    for (const closedHead of [H1, H0]) {
      const rig = await makeRig(
        `candidate-closed-pr-${closedHead.slice(0, 6)}`,
        {
          summaries: false,
          github: {
            candidateLifecycle: {
              ...positiveLifecycle(),
              refs: { [`refs/heads/${branch}`]: H1 },
              pullRequests: [{
                ...exactOpenPr(7, closedHead, branch),
                state: "closed" as const,
              }],
            },
          },
        },
      );
      try {
        const written = await rig.store.writeRepair(
          seededSnapshot([preservedIssueWork("issue-1", H1)]),
          null,
        );
        assert.ok(written.ok && written.value.status === "applied");

        const outcome = await rig.run();
        assert.equal(outcome.status, "idle", JSON.stringify(outcome));
        const state = await rig.snapshot();
        const work = state.work[0]!;
        assert.equal(work.target.head, H1, "the exact candidate is retained");
        assert.equal(work.target.pr, 8, "one replacement pull request");
        assert.equal(work.nextStep, "review");
        assert.equal(work.wait?.reason, "review_pending");
        const replaced = rig.github.candidatePullRequests.get(8);
        assert.equal(
          replaced?.head,
          H1,
          "the replacement carries the candidate",
        );
        assert.equal(
          replaced?.body,
          "Resolves #1",
          "the closing keyword body",
        );
        assert.equal(
          rig.model.requests.length,
          0,
          "recovering a closed publication starts no model run",
        );
        assert.equal(rig.github.pushes.length, 0, "no additional push");
        const assignIndex = rig.github.calls.indexOf("assignIssue:1");
        const createIndex = rig.github.calls.indexOf("createPr");
        assert.ok(
          assignIndex !== -1 && createIndex !== -1 && assignIndex < createIndex,
          "the source issue is assigned before the pull request exists",
        );
      } finally {
        await rig.ctx.cleanup();
      }
    }
  },
);

Deno.test(
  "candidate lifecycle: a refused issue assignment still publishes from the preserved candidate",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    const rig = await makeRig("candidate-assign-failed", {
      summaries: false,
      github: {
        assignFailNext: true,
        candidateLifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [],
        },
      },
    });
    try {
      const written = await rig.store.writeRepair(
        seededSnapshot([preservedIssueWork("issue-1", H1, { pr: null })]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      const outcome = await rig.run();
      const state = await rig.snapshot();
      const work = state.work[0]!;
      assert.equal(work.target.pr, 7, "the replacement was published anyway");
      assert.equal(work.target.head, H1, "the candidate is retained");
      assert.equal(work.nextStep, "review");
      assert.ok(
        rig.github.calls.includes("assignIssue:1"),
        "the assignment was attempted first",
      );
      const assignIndex = rig.github.calls.indexOf("assignIssue:1");
      const createIndex = rig.github.calls.indexOf("createPr");
      assert.ok(
        assignIndex !== -1 && createIndex !== -1 && assignIndex < createIndex,
        "the assignment attempt precedes the pull request",
      );
      assert.equal(rig.model.requests.length, 0);
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle: an exact preserved/published candidate progresses to one review",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    const rig = await makeRig("candidate-preserved-progress", {
      summaries: false,
      github: {
        candidateLifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H1, branch)],
        },
      },
    });
    try {
      const record = preservedIssueWork("issue-1", H1);
      const written = await rig.store.writeRepair(
        seededSnapshot([record]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();
      const work = state.work[0];
      assert.equal(work.nextStep, "review");
      assert.equal(work.wait?.reason, "review_pending");
      assert.equal(work.intent, null);
      assert.equal(work.target.head, H1);
      assert.equal(work.target.candidateState?.publishedHead, H1);
      assert.equal(
        rig.github.pushes.length,
        0,
        "an already published exact head is adopted, never re-pushed",
      );
      assert.equal(rig.model.requests.length, 0);
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        1,
      );
      assert.deepEqual(
        state.reservations.map((reservation) => reservation.purpose),
        ["review_request"],
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle H1: a push applied with a lost response keeps published H0 and recovers H1 once",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    const rig = await makeRig("candidate-h1-lost-push", {
      summaries: false,
      github: {
        candidateLifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H0 },
          pullRequests: [exactOpenPr(7, H0, branch)],
        },
      },
    });
    try {
      // The first push mutates the exact remote once and then loses its
      // response; the harness never reports a success for it.
      const originalPush = rig.github.pushHead.bind(rig.github);
      let lost = false;
      rig.github.pushHead = (
        ref: string,
        sha: GitSha,
        expected: GitSha | null,
      ) => {
        if (!lost) {
          lost = true;
          assert.equal(ref, `refs/heads/${branch}`, "exact full task ref");
          assert.equal(sha, H1, "exact recovered head");
          assert.equal(expected, H0, "exact expected lease");
          rig.github.calls.push(`push:${ref}:${sha.slice(0, 8)}`);
          rig.github.pushes.push({ ref, sha, expected });
          rig.github.applyPushWithoutResponse(ref, sha);
          return Promise.resolve(
            portError("unavailable", "push response lost"),
          );
        }
        return originalPush(ref, sha, expected);
      };
      const record = preservedIssueWork("issue-1", H1, {
        publishedHead: H0,
      });
      const historical = reservation("hist-review-h1", {
        taskId: id,
        head: H0,
        purpose: "review_request",
        outcome: "submitted",
        settledAt: T0,
      });
      const historicalBytes = canonicalStringify(historical);
      const written = await rig.store.writeRepair(
        seededSnapshot([record], { reservations: [historical] }),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      // Run 1: H1 was applied remotely with a lost response. The durable push
      // intent, the H0 publication proof and the wait survive, no review is
      // requested and nothing is charged.
      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));
      let state = await rig.snapshot();
      let work = state.work[0];
      assert.equal(work.intent?.kind, "push");
      assert.equal(work.intent?.expectedHead, H1);
      assert.equal(work.target.head, H1, "the candidate head is unchanged");
      assert.equal(
        work.target.candidateState?.publishedHead,
        H0,
        "the lost response never advances publishedHead",
      );
      assert.equal(work.wait?.reason, "unavailable");
      assert.equal(work.wait?.until, T0 + CHECK_POLL_MS);
      assert.equal(rig.github.pushes.length, 1, "one applied push");
      assert.equal(
        rig.github.candidateRefs.get(`refs/heads/${branch}`),
        H1,
        "the exact remote branch carries H1",
      );
      assert.equal(state.reservations.length, 1, "no review charge");
      assert.equal(
        canonicalStringify(
          state.reservations.find((entry) => entry.id === historical.id),
        ),
        historicalBytes,
        "the historical reservation is unchanged",
      );
      assert.equal(rig.model.requests.length, 0, "no model");

      // Run 2 after the bounded wait: the exact ref proves the push, H1 is
      // acknowledged atomically and exactly one review is requested.
      rig.clock.advance(CHECK_POLL_MS + 1);
      const second = await rig.run();
      assert.equal(second.status, "idle", JSON.stringify(second));
      state = await rig.snapshot();
      work = state.work[0];
      assert.equal(work.intent, null, "the reconciled push intent is cleared");
      assert.equal(work.target.head, H1);
      assert.equal(work.target.candidateState?.publishedHead, H1);
      assert.equal(work.nextStep, "review");
      assert.equal(work.wait?.reason, "review_pending");
      assert.equal(rig.github.pushes.length, 1, "no second push");
      assert.equal(rig.model.requests.length, 0, "no second model");
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        1,
        "exactly one review request for the recovered head",
      );
      const admitted = state.reservations.filter((entry) =>
        entry.id !== historical.id
      );
      assert.equal(admitted.length, 1, "only one new review reservation");
      assert.equal(admitted[0].purpose, "review_request");
      assert.equal(admitted[0].head, H1, "exact final review head");
      assert.equal(admitted[0].outcome, "submitted");
      assert.equal(
        canonicalStringify(
          state.reservations.find((entry) => entry.id === historical.id),
        ),
        historicalBytes,
        "the historical reservation is unchanged",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle H2: a lost refresh push retains H1/H2 and acknowledges H2 once",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    const B1 = SHA1;
    const B2 = SHA2;
    const H2 = H1;
    const H1_HEAD = SHA3;
    const refreshKey = `base_refresh:7:${H1_HEAD}:${B2}`;
    const rig = await makeRig("candidate-h2-lost-push", {
      summaries: false,
      // The configured base already carries B2 when the refreshed candidate is
      // re-observed for review admission.
      github: {
        baseSha: B2,
        candidateLifecycle: {
          refs: { [`refs/heads/${branch}`]: H1_HEAD },
          pullRequests: [exactOpenPr(7, H1_HEAD, branch, B2)],
          preserveCandidate: async (request) => {
            // The exact successor descriptor AND the durable old-H1 target are
            // asserted from inside the real preservation call.
            const durable = (await rig.snapshot()).work[0];
            assert.equal(request.taskId, id);
            assert.equal(request.candidate.operationKey, refreshKey);
            assert.equal(request.candidate.base, B2);
            assert.equal(request.candidate.head, H2);
            assert.equal(
              request.candidate.ref,
              await candidatePreservationRef(REPO, id, refreshKey),
              "exact preservation ref",
            );
            assert.equal(request.publishedHead, H1_HEAD);
            assert.equal(durable.target.head, H1_HEAD, "durable old H1 target");
            assert.equal(durable.target.base, B1, "durable old base");
            assert.equal(
              durable.target.candidateState?.publishedHead,
              H1_HEAD,
            );
            assert.equal(durable.intent?.kind, "base_refresh");
            assert.equal(durable.intent?.resultId, H2);
            return portOk(undefined);
          },
          prepareBaseRefresh: (request) => {
            assert.equal(request.pullRequestNumber, 7);
            assert.equal(request.branch, branch);
            assert.equal(request.expectedHead, H1_HEAD);
            assert.equal(request.previousBase, B1);
            assert.equal(request.expectedBase, B2);
            assert.equal(request.preparedHead, H2);
            return Promise.resolve(portOk(H2));
          },
        },
      },
    });
    try {
      const originalPush = rig.github.pushHead.bind(rig.github);
      let lost = false;
      rig.github.pushHead = (
        ref: string,
        sha: GitSha,
        expected: GitSha | null,
      ) => {
        if (!lost) {
          lost = true;
          rig.github.calls.push(`push:${ref}:${sha.slice(0, 8)}`);
          rig.github.pushes.push({ ref, sha, expected });
          rig.github.applyPushWithoutResponse(ref, sha);
          return Promise.resolve(
            portError("unavailable", "refresh push response lost"),
          );
        }
        return originalPush(ref, sha, expected);
      };
      const record = preservedIssueWork("issue-1", H1_HEAD, {
        publishedHead: H1_HEAD,
        nextStep: "delivery",
      });
      const withRefresh = workRecord("issue-1", {
        ...record,
        intent: {
          kind: "base_refresh",
          key: refreshKey,
          startedAt: T0,
          branch,
          expectedHead: H1_HEAD,
          observedBase: B2,
          pr: 7,
          requestId: null,
          resultId: H2,
        },
      });
      const historical = reservation("hist-review-h2", {
        taskId: id,
        head: H1_HEAD,
        purpose: "review_request",
        outcome: "submitted",
        settledAt: T0,
      });
      const historicalBytes = canonicalStringify(historical);
      const written = await rig.store.writeRepair(
        seededSnapshot([withRefresh], { reservations: [historical] }),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      // Run 1: the persisted prepared H2 is preserved and pushed onto the
      // exact branch; the lost response retains the old H1 target and the H2
      // intent with no review charge.
      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));
      let state = await rig.snapshot();
      let work = state.work[0];
      assert.equal(work.target.head, H1_HEAD, "old H1 target retained");
      assert.equal(work.target.base, B1, "old base retained");
      assert.equal(work.target.candidateState?.publishedHead, H1_HEAD);
      assert.equal(work.intent?.kind, "base_refresh");
      assert.equal(work.intent?.resultId, H2, "the H2 intent is retained");
      assert.equal(work.wait?.reason, "unavailable");
      assert.equal(rig.github.pushes.length, 1);
      assert.equal(rig.github.pushes[0].sha, H2);
      assert.equal(rig.github.pushes[0].expected, H1_HEAD);
      assert.equal(
        rig.github.candidateRefs.get(`refs/heads/${branch}`),
        H2,
        "the exact remote branch carries H2",
      );
      assert.equal(state.reservations.length, 1, "no review charge");
      assert.equal(
        canonicalStringify(
          state.reservations.find((entry) => entry.id === historical.id),
        ),
        historicalBytes,
        "the historical reservation is unchanged",
      );
      assert.equal(rig.model.requests.length, 0, "no model");

      // Run 2 after the wait: regeneration matches the persisted H2, the ref is
      // already prepared (no second push), the target advances atomically and
      // exactly one fresh review is requested.
      rig.clock.advance(CHECK_POLL_MS + 1);
      const second = await rig.run();
      assert.equal(second.status, "idle", JSON.stringify(second));
      state = await rig.snapshot();
      work = state.work[0];
      assert.equal(work.intent, null, "the refresh intent is cleared");
      assert.equal(work.target.base, B2, "target advanced to the new base");
      assert.equal(work.target.head, H2, "target advanced to the prepared H2");
      assert.equal(work.target.candidateState?.preserved?.head, H2);
      assert.equal(work.target.candidateState?.publishedHead, H2);
      assert.equal(work.nextStep, "review");
      assert.equal(work.wait?.reason, "review_pending");
      assert.equal(rig.github.pushes.length, 1, "no second push");
      assert.equal(rig.model.requests.length, 0, "no model");
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        1,
        "one review for the acknowledged H2",
      );
      const admitted = state.reservations.filter((entry) =>
        entry.id !== historical.id
      );
      assert.equal(admitted.length, 1, "only one new review reservation");
      assert.equal(admitted[0].purpose, "review_request");
      assert.equal(admitted[0].head, H2, "exact final review head");
      assert.equal(admitted[0].outcome, "submitted");
      assert.equal(
        canonicalStringify(
          state.reservations.find((entry) => entry.id === historical.id),
        ),
        historicalBytes,
        "the historical reservation is unchanged",
      );
      assert.equal(
        rig.github.preservationRequests.length,
        2,
        "the same successor was preserved once per run",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle: review freshness refusals leave candidate accounting untouched",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    // NOTE: a closed-unmerged own PR is no longer a refusal. It recovers by
    // retiring the publication identity, asserted by the dedicated
    // "a closed-unmerged own PR republishes the preserved candidate once" case.
    const wrongBranchPr = { ...exactOpenPr(7, H1, branch), headRef: "other" };
    const wrongBasePr = { ...exactOpenPr(7, H1, branch), baseRef: "main" };
    let prepareCalls = 0;
    const cases: Array<{
      name: string;
      baseSha?: GitSha;
      lifecycle: FakeGithubCandidateLifecycleV1;
      mutate?: (rig: RigV1) => void;
      expectedBlocked?: string;
      expectedIntentBase?: GitSha;
      /** The missing capability IS the gate under test; never injected. */
      absentPrepare?: boolean;
      /** The exact PR must be observed before the freshness refusal. */
      expectPrObservation?: boolean;
    }> = [
      {
        name: "failed base read",
        lifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H1, branch)],
        },
        mutate: (rig) => {
          const original = rig.github.readRef.bind(rig.github);
          rig.github.readRef = (ref) =>
            ref.endsWith("refs/heads/development")
              ? Promise.resolve(portError("unavailable", "base read failed"))
              : original(ref);
        },
      },
      {
        name: "null base read",
        lifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H1, branch)],
        },
        mutate: (rig) => {
          const original = rig.github.readRef.bind(rig.github);
          rig.github.readRef = (ref) =>
            ref.endsWith("refs/heads/development")
              ? Promise.resolve(portOk(null))
              : original(ref);
        },
      },
      {
        name: "moved base",
        baseSha: SHA2,
        lifecycle: {
          preserveCandidate: () => Promise.resolve(portOk(undefined)),
          prepareBaseRefresh: (request) => {
            prepareCalls++;
            assert.equal(request.expectedHead, H1);
            assert.equal(request.previousBase, SHA1);
            assert.equal(request.expectedBase, SHA2);
            return Promise.resolve(
              portError("unavailable", "prepared unavailable"),
            );
          },
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H1, branch)],
        },
        expectedIntentBase: SHA2,
      },
      {
        name: "moved base with absent prepare capability",
        baseSha: SHA2,
        absentPrepare: true,
        lifecycle: {
          preserveCandidate: () => Promise.resolve(portOk(undefined)),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H1, branch)],
        },
      },
      {
        name: "missing prepare capability",
        absentPrepare: true,
        lifecycle: {
          preserveCandidate: () => Promise.resolve(portOk(undefined)),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H1, branch)],
        },
      },
      {
        name: "wrong PR branch",
        lifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [wrongBranchPr],
        },
        expectPrObservation: true,
      },
      {
        name: "wrong PR base",
        lifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [wrongBasePr],
        },
        expectPrObservation: true,
      },
      {
        name: "stale PR head",
        lifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H0, branch)],
        },
        expectPrObservation: true,
      },
      {
        name: "missing candidate ref",
        lifecycle: { refs: {}, pullRequests: [exactOpenPr(7, H1, branch)] },
        expectedBlocked: "published candidate ref is missing",
      },
      {
        name: "wrong candidate ref",
        lifecycle: {
          refs: { [`refs/heads/${branch}`]: SHA2 },
          pullRequests: [exactOpenPr(7, H1, branch)],
        },
        expectedBlocked: "candidate branch ref identity mismatch",
      },
      {
        // The publication read acknowledges the exact H1 task ref; the SECOND
        // central read at review admission observes a null task ref and must
        // refuse review with the exact PR already observed.
        name: "acknowledged ref missing on review re-read",
        lifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H1, branch)],
        },
        mutate: (rig) => {
          const original = rig.github.readRef.bind(rig.github);
          let taskReads = 0;
          rig.github.readRef = (
            ref,
          ): Promise<
            PortResultV1<{ ref: string; sha: GitSha } | null>
          > => {
            if (ref !== `refs/heads/${branch}`) return original(ref);
            taskReads++;
            return taskReads === 1
              ? original(ref)
              : Promise.resolve(portOk(null));
          };
        },
        expectPrObservation: true,
      },
      {
        // Same acknowledgement, but the review re-read observes an unrelated
        // SHA: the refusal is the identity mismatch, never a second publish.
        name: "acknowledged ref moved on review re-read",
        lifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H1, branch)],
        },
        mutate: (rig) => {
          const original = rig.github.readRef.bind(rig.github);
          let taskReads = 0;
          rig.github.readRef = (
            ref,
          ): Promise<
            PortResultV1<{ ref: string; sha: GitSha } | null>
          > => {
            if (ref !== `refs/heads/${branch}`) return original(ref);
            taskReads++;
            return taskReads === 1
              ? original(ref)
              : Promise.resolve(portOk({ ref, sha: SHA2 }));
          };
        },
        expectPrObservation: true,
      },
    ];
    for (const testCase of cases) {
      const rig = await makeRig(`candidate-fresh-${testCase.name}`, {
        summaries: false,
        github: {
          baseSha: testCase.baseSha ?? SHA1,
          candidateLifecycle: testCase.lifecycle,
        },
      });
      try {
        // Every negative case composes the explicit unused prepare capability
        // so the earlier missing-capability gate never masks the specific
        // base/PR/ref refusal under test. The two absent-prepare fixtures keep
        // the capability missing: that gate is exactly what they test.
        if (
          testCase.absentPrepare !== true &&
          rig.github.prepareBaseRefresh === undefined
        ) {
          rig.github.prepareBaseRefresh = () => {
            throw new Error("prepare must not run for an unchanged base");
          };
        }
        const record = preservedIssueWork("issue-1", H1);
        const before = candidateAccounting(record);
        const written = await rig.store.writeRepair(
          seededSnapshot([record]),
          null,
        );
        assert.ok(written.ok && written.value.status === "applied");
        testCase.mutate?.(rig);

        const outcome = await rig.run();
        assert.equal(
          outcome.status,
          testCase.expectedBlocked === undefined &&
            testCase.expectedIntentBase === undefined
            ? "margin"
            : "idle",
          `${testCase.name}: ${JSON.stringify(outcome)}`,
        );
        const state = await rig.snapshot();
        const work = state.work[0];
        assert.deepEqual(
          candidateAccounting(work),
          before,
          `${testCase.name}: candidate/accounting unchanged`,
        );
        assert.equal(state.reservations.length, 0, `${testCase.name}: charge`);
        assert.equal(rig.model.requests.length, 0, `${testCase.name}: model`);
        assert.equal(
          rig.github.calls.filter((call) => call === "requestReview").length,
          0,
          `${testCase.name}: review request`,
        );
        if (testCase.expectPrObservation === true) {
          assert.ok(
            rig.github.calls.includes("readPr:7"),
            `${testCase.name}: exact PR observation was reached`,
          );
        }
        if (testCase.expectedBlocked !== undefined) {
          assert.equal(work.nextStep, "blocked", testCase.name);
          assert.equal(work.blocker?.message, testCase.expectedBlocked);
        } else {
          assert.equal(work.nextStep, "work", testCase.name);
        }
        if (testCase.expectedIntentBase !== undefined) {
          assert.equal(work.intent?.kind, "base_refresh", testCase.name);
          assert.equal(
            work.intent?.observedBase,
            testCase.expectedIntentBase,
            `${testCase.name}: exact observed base`,
          );
          assert.equal(
            work.wait?.reason,
            "unavailable",
            `${testCase.name}: bounded unavailable wait`,
          );
        }
      } finally {
        await rig.ctx.cleanup();
      }
    }
    assert.equal(prepareCalls, 1, "preparation ran once through the intent");
  },
);

// The Stage-1 global candidate parking is gone: candidate-state records are
// selected like any other record, and their lifecycle steps perform the safe
// deferral/reconciliation asserted by the focused cases above. The intake
// identity-isolation cases below keep the remaining M15 guarantees.

Deno.test("changed incident intake refreshes matching work while unrelated parked work is isolated", async () => {
  const rig = await makeRig("candidate-intake", {
    github: {
      openIssues: [issueRecord(55), issueRecord(101)],
      issues: [issueRecord(101)],
      candidateLifecycle: positiveLifecycle(),
    },
  });
  try {
    const parkedIncident = workRecord("incident-parked", {
      source: { kind: "incident", id: "inc-a", revision: SHA2 },
      related: { incidentId: "inc-a", issueNumber: null },
      fingerprint: FINGERPRINT,
      failingRevision: SHA2,
      nextStep: "review",
      wait: { reason: "review_pending", since: T0, until: T0 + 10_000_000 },
      target: {
        base: SHA1,
        branch: candidateBranch(asWorkItemId("incident-parked")),
        checkpoint: null,
        head: H0,
        pr: 7,
        candidateState: candidateStateFor(SHA1, H0),
      },
    });
    // A parked ISSUE task must be found by the whole-snapshot issue lookup and
    // never recreated from the incoming issue list. Its explicit task-level
    // wait (no restored global parking) keeps it out of this run.
    const parkedIssue = workRecord("issue-55", {
      source: { kind: "issue", id: "55", revision: SHA1 },
      related: { incidentId: null, issueNumber: 55 },
      nextStep: "work",
      wait: { reason: "unavailable", since: T0, until: T0 + 10_000_000 },
      target: {
        base: SHA1,
        branch: candidateBranch(asWorkItemId("issue-55")),
        checkpoint: null,
        head: H0,
        pr: 8,
        candidateState: candidateStateFor(SHA1, H0),
      },
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

    // The source now reports a changed summary for the stored incident. The
    // matching summary and its matching work identity are refreshed; the
    // unrelated parked issue remains byte-identical and is not recreated.
    const changed = incidentSummary("inc-a", {
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
    });
    rig.incidents.setSummaries([changed]);

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();

    const afterIncident = state.work.find((work) =>
      work.id === parkedIncident.id
    );
    const afterIssue = state.work.find((work) => work.id === parkedIssue.id);
    assert.ok(afterIncident && afterIssue);
    assert.notEqual(
      canonicalStringify(afterIncident),
      beforeIncident,
      "the matching incident work is refreshed",
    );
    assert.equal(afterIncident?.fingerprint, FINGERPRINT);
    assert.equal(afterIncident?.source.id, "inc-a");
    assert.equal(afterIncident?.firstSeenAt, null, "identity is preserved");
    assert.equal(afterIncident?.classification.severity, "P0");
    assert.equal(afterIncident?.target.head, H0, "candidate target untouched");
    assert.deepEqual(afterIncident?.counters, {
      attempts: 0,
      retries: 0,
      reviewRounds: 0,
    });
    assert.ok(
      afterIncident?.evidence.some((ref) => ref.kind === "incident_evidence"),
      "the refreshed summary evidence is attached",
    );
    assert.equal(canonicalStringify(afterIssue), beforeIssue);
    assert.equal(
      canonicalStringify(state.incidents[0]),
      canonicalStringify(changed),
      "the matching incident summary is refreshed",
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
      "no merge for the waiting incident",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "observeReview").length,
      0,
      "the waiting task's review is never observed",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P1 correction: intake lookups bind the exact incident scope (incident id,
// fingerprint and repository identity), so candidate state from another
// incident or repository can never suppress an incoming summary. Identity
// isolation — never global candidate parking — is what keeps A untouched.
// ---------------------------------------------------------------------------

/** The candidate's repository: same owner, different name from REPO. */
const FOREIGN_REPO = {
  owner: "ubiquity",
  name: "sentinel",
  installationId: 7,
} as const;

Deno.test(
  "changed incident intake keeps another repository's candidate isolated",
  async () => {
    // B is the configured repository (REPO) and uses its normal evidence.
    const incoming = summaryFixture();
    const rig = await makeRig("candidate-incident-foreign-repo", {
      incidents: { summaries: [incoming], evidence: evidenceFixture() },
      github: { candidateLifecycle: positiveLifecycle() },
    });
    try {
      // A lives in another repository (same owner, different name) and
      // carries the same fingerprint as incoming inc-a. A fingerprint-only
      // work lookup would have matched this record and skipped inc-a entirely.
      const parkedAId = workItemIdForIncident(FOREIGN_REPO, FINGERPRINT);
      const parkedA = workRecord(parkedAId, {
        repository: FOREIGN_REPO,
        source: { kind: "incident", id: "inc-parked", revision: SHA2 },
        related: { incidentId: "inc-parked", issueNumber: null },
        fingerprint: FINGERPRINT,
        failingRevision: SHA2,
        nextStep: "review",
        wait: { reason: "review_pending", since: T0 - 2, until: T0 - 1 },
        target: {
          base: SHA1,
          branch: candidateBranch(parkedAId),
          checkpoint: null,
          head: H0,
          pr: 7,
          candidateState: candidateStateFor(SHA1, H0),
        },
      });
      const storedSummaryA = incidentSummary("inc-parked", {
        repository: FOREIGN_REPO,
        fingerprint: FINGERPRINT,
        failingRevision: SHA2,
      });
      const written = await rig.store.writeRepair(
        seededSnapshot([parkedA], { incidents: [storedSummaryA] }),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");
      const beforeWorkA = canonicalStringify(parkedA);
      const beforeSummaryA = canonicalStringify(storedSummaryA);

      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();

      // Parked A is byte-identical: never refreshed, duplicated or recreated.
      const afterA = state.work.find((work) => work.id === parkedAId);
      assert.ok(afterA, "the parked foreign-repository work survives");
      assert.equal(canonicalStringify(afterA), beforeWorkA);
      const afterSummaryA = state.incidents.find((incident) =>
        incident.id === "inc-parked"
      );
      assert.ok(afterSummaryA, "the foreign-repository summary survives");
      assert.equal(canonicalStringify(afterSummaryA), beforeSummaryA);
      assert.equal(state.incidents.length, 2, "exactly the two summaries");

      // B's own summary and correctly scoped work exist.
      const bSummary = state.incidents.find((incident) =>
        incident.id === "inc-a"
      );
      assert.ok(bSummary, "the configured repository's summary is saved");
      assert.equal(canonicalStringify(bSummary), canonicalStringify(incoming));
      assert.deepEqual(bSummary.repository, REPO);

      const bWorkId = workItemIdForIncident(REPO, FINGERPRINT);
      const bWork = state.work.find((work) => work.id === bWorkId);
      assert.ok(bWork, "the configured repository's work exists");
      assert.deepEqual(bWork.repository, REPO);
      assert.equal(bWork.source.kind, "incident");
      assert.equal(bWork.source.id, "inc-a");
      assert.equal(bWork.related.incidentId, "inc-a");
      assert.equal(bWork.fingerprint, FINGERPRINT);
      assert.equal(bWork.nextStep, "review");
      assert.equal(bWork.wait?.reason, "review_pending");
      assert.equal(bWork.target.pr, 7);
      assert.equal(bWork.counters.attempts, 1);
      assert.equal(state.work.length, 2, "no duplicate or extra work record");

      // Exactly one implementation, and only B was published and reviewed.
      assert.equal(rig.model.requests.length, 1, "exactly one model start");
      assert.equal(rig.model.requests[0].taskId, bWorkId);
      assert.deepEqual(rig.model.requests[0].repository, REPO);
      assert.equal(rig.github.pushes.length, 1, "one candidate push");
      assert.equal(
        rig.github.pushes[0].ref,
        `refs/heads/${candidateBranch(bWorkId)}`,
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "createPr").length,
        1,
        "only B was published",
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        1,
        "only B requested review",
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "merge").length,
        0,
        "no merge for the parked task",
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "observeReview").length,
        0,
        "the parked task's expired review wait is never observed",
      );
      assert.ok(rig.incidents.readCalls.length >= 1, "B evidence was read");
      assert.ok(
        rig.incidents.readCalls.every((incidentId) => incidentId === "inc-a"),
        "no evidence read for the foreign parked incident",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "changed incident intake saves a new incident summary without running the fingerprint-duplicate task",
  async () => {
    const incoming = incidentSummary("inc-new", {
      fingerprint: FINGERPRINT,
      severity: "P1",
      count: 2,
      lastSeenAt: T0 + 900_000,
      failingRevision: SHA2,
      context: {
        message: "fresh observation of the same fingerprint",
        location: null,
        sample: [],
      },
    });
    // Same configured repository and fingerprint as stored inc-old; the
    // incident id is the only remaining scope difference.
    const rig = await makeRig("candidate-incident-same-repo", {
      incidents: { summaries: [incoming], evidence: null },
    });
    try {
      const parkedId = workItemIdForIncident(REPO, FINGERPRINT);
      const parkedOld = workRecord(parkedId, {
        repository: REPO,
        source: { kind: "incident", id: "inc-old", revision: SHA2 },
        related: { incidentId: "inc-old", issueNumber: null },
        fingerprint: FINGERPRINT,
        failingRevision: SHA2,
        nextStep: "review",
        // The intended no-work guarantee comes from this explicit task-level
        // wait, never from restored global candidate parking.
        wait: { reason: "review_pending", since: T0, until: T0 + 10_000_000 },
        target: {
          base: SHA1,
          branch: candidateBranch(parkedId),
          checkpoint: null,
          head: H0,
          pr: 7,
          candidateState: candidateStateFor(SHA1, H0),
        },
      });
      const storedOld = incidentSummary("inc-old", {
        fingerprint: FINGERPRINT,
        failingRevision: SHA2,
      });
      const written = await rig.store.writeRepair(
        seededSnapshot([parkedOld], { incidents: [storedOld] }),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");
      const beforeWork = canonicalStringify(parkedOld);
      const beforeOld = canonicalStringify(storedOld);

      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();

      // The new incident summary is durable...
      const afterNew = state.incidents.find((incident) =>
        incident.id === "inc-new"
      );
      assert.ok(afterNew, "the new incident summary is saved");
      assert.equal(canonicalStringify(afterNew), canonicalStringify(incoming));
      // ...while the old summary and the parked work keep their exact bytes.
      const afterOld = state.incidents.find((incident) =>
        incident.id === "inc-old"
      );
      assert.ok(afterOld, "the old incident summary survives");
      assert.equal(canonicalStringify(afterOld), beforeOld);
      const afterWork = state.work.find((work) => work.id === parkedId);
      assert.ok(afterWork, "the parked work survives");
      assert.equal(canonicalStringify(afterWork), beforeWork);

      // The tentative work record for inc-new carries the canonical
      // workItemIdForIncident id, a pure function of repository and
      // fingerprint, so the existing final draft.work id dedupe skips it as a
      // duplicate of the parked inc-old record. This test does not claim a
      // second task is runnable.
      assert.equal(state.work.length, 1, "exactly one original work record");
      assert.equal(state.replays.length, 0);
      assert.equal(state.reservations.length, 0, "no reservation");
      assert.equal(rig.model.requests.length, 0, "no model start");
      assert.equal(rig.github.pushes.length, 0, "no push");
      assert.equal(
        rig.github.calls.filter((call) => call === "createPr").length,
        0,
        "no publication",
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        0,
        "no review request",
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "observeReview").length,
        0,
        "the parked review wait is never observed",
      );
      assert.equal(rig.incidents.readCalls.length, 0, "no evidence read");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Legacy loss bridge (M14/V17): the bounded pre-ranking two-CAS recovery of a
// proven lost legacy base-refresh candidate. Real Git state stores prove the
// historical ancestry and the ordinary charged successor; cheap MemoryState
// fixtures cover the refusal and scheduling variations. The optional proof
// capability is attached through a GitHubPort-typed reference because the
// concrete FakeGithub class does not declare it.
// ---------------------------------------------------------------------------

const LEGACY_ISSUE = 48;
const LEGACY_PR = 51;
const LEGACY_TASK = asWorkItemId("issue-48");
const LEGACY_BRANCH = candidateBranch(LEGACY_TASK);
const LEGACY_B0 = SHA1;
const LEGACY_B1 = SHA2;
const LEGACY_H1 = SHA3;
const LEGACY_H0 = SHA4;
const LEGACY_INTENT_KEY = baseRefreshIntentKey(LEGACY_PR, LEGACY_H1, LEGACY_B1);
const LEGACY_REVIEW_ID = `review-receipt:${LEGACY_PR}:${LEGACY_H0}`;
const LEGACY_DETAIL =
  "legacy base-refresh candidate is missing; predecessor head pending";

/** Original unprepared legacy base-refresh intent for one task id. */
function legacyLossIntent(id: string, pr = LEGACY_PR) {
  const branch = candidateBranch(asWorkItemId(id));
  return {
    kind: "base_refresh" as const,
    key: baseRefreshIntentKey(pr, LEGACY_H1, LEGACY_B1),
    startedAt: T0,
    branch,
    expectedHead: LEGACY_H1,
    observedBase: LEGACY_B1,
    pr,
    requestId: null,
    resultId: null,
  };
}

/** Self scope-0 issue work-record overrides for one legacy-loss tuple. */
function legacyLossOverrides(
  id: string,
  issueNumber: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const taskId = asWorkItemId(id);
  const branch = candidateBranch(taskId);
  return {
    repository: LOCAL_SENTINEL_REPO,
    source: { kind: "issue", id: String(issueNumber), revision: LEGACY_B0 },
    related: { incidentId: null, issueNumber },
    target: {
      base: LEGACY_B0,
      branch,
      checkpoint: { branch, sha: LEGACY_H1 },
      head: LEGACY_H1,
      pr: LEGACY_PR,
    },
    nextStep: "work",
    counters: { attempts: 3, retries: 0, reviewRounds: 1 },
    evidence: [{
      kind: "review_receipt",
      ref: `artifact://sentinel/legacy-loss/${issueNumber}`,
    }],
    intent: legacyLossIntent(id),
    ...extra,
  };
}

function legacyLossWork(
  id: string,
  issueNumber: number,
  extra: Record<string, unknown> = {},
): WorkRecordV1 {
  return workRecord(id, legacyLossOverrides(id, issueNumber, extra));
}

/** Original submitted charge for the seeded attempts-3 legacy operation. */
function legacyLossCharge(
  id = "res-3",
  overrides: Record<string, unknown> = {},
) {
  return reservation(id, {
    repository: LOCAL_SENTINEL_REPO,
    taskId: LEGACY_TASK,
    attempt: 3,
    head: LEGACY_B0,
    purpose: "retry",
    outcome: "submitted",
    settledAt: T0 + 500,
    ...overrides,
  });
}

/** Completed review bound to one exact repository/PR/head/base tuple. */
function legacyLossReview(
  id: string,
  head: GitSha,
  base: GitSha,
  overrides: Record<string, unknown> = {},
): ReviewReceiptV1 {
  return reviewReceipt(id, {
    repository: LOCAL_SENTINEL_REPO,
    pullRequest: { number: LEGACY_PR, head, base },
    outcome: "completed",
    resultId: "result-h0",
    observedReviewer: "chatgpt-codex-connector[bot]",
    submittedAt: T0,
    completedAt: T0 + 1000,
    observedAt: T0 + 1001,
    findings: [{
      id: "finding-h0",
      severity: "P2",
      path: "src/app.ts",
      message: "legacy correction finding",
      fingerprint: "a".repeat(64),
      resolved: false,
      resolutionEvidence: null,
    }],
    unresolvedSeverities: ["P2"],
    ...overrides,
  });
}

/** Runtime proof value bound to one exact task and authoritative state head. */
function legacyLossProof(
  taskId: WorkItemId,
  stateHead: GitSha,
  overrides: Partial<LegacyBaseRefreshLossProofV1> = {},
): LegacyBaseRefreshLossProofV1 {
  return {
    taskId,
    repository: { ...LOCAL_SENTINEL_REPO },
    stateHead,
    shape: "legacy_base_refresh",
    lostBase: LEGACY_B0,
    lostHead: LEGACY_H1,
    predecessorHead: LEGACY_H0,
    branch: candidateBranch(taskId),
    pr: LEGACY_PR,
    intentKey: LEGACY_INTENT_KEY,
    reviewId: LEGACY_REVIEW_ID,
    ...overrides,
  };
}

/** The authoritative repair state head (never `snapshot.stateHead`). */
async function repairStateHead(
  state: RepairCycleDepsV1["state"],
): Promise<GitSha> {
  const read = await state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  if (!read.ok || read.value.status !== "found") {
    throw new Error("no repair state");
  }
  return read.value.head;
}

/**
 * Bounded direct-cycle driver for the legacy-loss bridge tests. `makeRig.run`
 * fixes its step limit at 16; these tests assert one persisted transition per
 * cycle, so they call the real loop with the same explicit self scope-0
 * config/budget pair the rig uses. The generic rig API is not grown.
 */
function legacyLossCycles(
  base: Pick<
    RepairCycleDepsV1,
    "clock" | "state" | "github" | "incidents" | "replay" | "model"
  >,
) {
  const configs = repairConfigs({
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  });
  configs.push(localScopeConfig(configs[0]));
  const budget = new RollingStartBudget({
    clock: base.clock,
    state: base.state,
    configs,
  });
  const githubCooldown = new DurableGitHubCooldownGate({
    state: base.state,
    clock: base.clock,
  });
  const run = (stepLimit: number) =>
    runRepairCycle({
      clock: base.clock,
      state: base.state,
      configs,
      controllerSha: SHA1,
      github: base.github,
      githubCooldown,
      incidents: base.incidents,
      replay: base.replay,
      model: base.model,
      budget,
    }, { deadline: base.clock.now() + 60 * 60_000, stepLimit });
  return { run };
}

/** Cheap MemoryState bridge rig with the self scope-0 config pair. */
function legacyLossMemory() {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  const github: GitHubPort = new FakeGithub({ baseSha: LEGACY_B0 });
  const incidents = new FakeIncidents({ summaries: [], evidence: null });
  const replay = new FakeReplay();
  const model = new FakeModel({
    head: LEGACY_H1,
    changedPaths: ["src/app.ts"],
  });
  const { run } = legacyLossCycles({
    clock,
    state,
    github,
    incidents,
    replay,
    model,
  });
  const snapshot = async (): Promise<RepairStateSnapshotV1> => {
    const read = await state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (!read.ok || read.value.status !== "found") {
      throw new Error("no repair state");
    }
    return read.value.snapshot;
  };
  return { clock, state, github, model, run, snapshot };
}

/** Blocked tuple the discovery CAS writes (before any restoration). */
function legacyLossBlockedExtras() {
  return {
    nextStep: "blocked",
    blocker: {
      kind: "missing_evidence",
      message: LEGACY_DETAIL,
      since: T0,
    },
  };
}

Deno.test(
  "legacy loss bridge: two guarded CAS commits recover a lost legacy candidate into one charged retry",
  async () => {
    const port = new RelationsFakeGithub({ baseSha: LEGACY_B0 });
    const rig = await makeRig("legacy-loss", {
      summaries: false,
      localScope: true,
      githubPort: port,
    });
    try {
      const github: GitHubPort = port;
      let proofCalls = 0;
      github.proveLegacyBaseRefreshLoss = async (taskId) => {
        proofCalls++;
        return portOk(
          legacyLossProof(taskId, await repairStateHead(rig.store)),
        );
      };
      const charge = legacyLossCharge();
      const review = legacyLossReview(LEGACY_REVIEW_ID, LEGACY_H0, LEGACY_B0);
      const seeded = seededSnapshot(
        [legacyLossWork("issue-48", LEGACY_ISSUE)],
        { reservations: [charge], reviews: [review] },
      );
      const written = await rig.store.writeRepair(seeded, null);
      assert.ok(written.ok && written.value.status === "applied");
      const seedHead = written.value.head;
      const { run } = legacyLossCycles({
        clock: rig.clock,
        state: rig.store,
        github,
        incidents: rig.incidents,
        replay: rig.replay,
        model: rig.model,
      });

      // Cycle 1: ONLY the truthful loss discovery is committed. The blocked
      // state head D retains the original H1/B0 tuple and every historical
      // record; no model start and no reservation are created.
      const first = await run(1);
      assert.equal(first.status, "step_limit", JSON.stringify(first));
      const afterFirst = await rig.snapshot();
      const blocked = afterFirst.work[0]!;
      assert.equal(blocked.nextStep, "blocked");
      assert.equal(blocked.blocker?.kind, "missing_evidence");
      assert.equal(blocked.blocker?.message, LEGACY_DETAIL);
      assert.equal(blocked.target.head, LEGACY_H1);
      assert.equal(blocked.target.base, LEGACY_B0);
      assert.equal(blocked.target.branch, LEGACY_BRANCH);
      assert.equal(blocked.target.pr, LEGACY_PR);
      assert.deepEqual(blocked.target.checkpoint, {
        branch: LEGACY_BRANCH,
        sha: LEGACY_H1,
      });
      assert.equal(blocked.intent?.key, LEGACY_INTENT_KEY);
      assert.deepEqual(blocked.counters, {
        attempts: 3,
        retries: 0,
        reviewRounds: 1,
      });
      assert.equal(proofCalls, 1);
      assert.equal(rig.model.requests.length, 0, "no model start in discovery");
      assert.equal(afterFirst.reservations.length, 1);
      assert.equal(afterFirst.reservations[0]!.outcome, "submitted");
      assert.deepEqual(afterFirst.reviews.map((entry) => entry.id), [
        LEGACY_REVIEW_ID,
      ]);
      assert.equal(afterFirst.stateHead, seedHead);
      const D = await repairStateHead(rig.store);
      assert.notEqual(D, seedHead);

      // Cycle 2: the blocked tuple is independently proved at the NEW
      // authoritative head and restored to the ordinary work tuple at H0/B0.
      const second = await run(1);
      assert.equal(second.status, "step_limit", JSON.stringify(second));
      const afterSecond = await rig.snapshot();
      const restored = afterSecond.work[0]!;
      assert.equal(restored.nextStep, "work");
      assert.equal(restored.target.head, LEGACY_H0);
      assert.equal(restored.target.base, LEGACY_B0);
      assert.equal(restored.target.branch, LEGACY_BRANCH);
      assert.equal(restored.target.pr, LEGACY_PR);
      assert.equal(restored.target.checkpoint, null);
      assert.equal(restored.target.candidateState, undefined);
      assert.equal(restored.intent, null);
      assert.equal(restored.wait, null);
      assert.equal(restored.blocker, null);
      assert.deepEqual(restored.counters, {
        attempts: 3,
        retries: 0,
        reviewRounds: 1,
      });
      assert.deepEqual(restored.evidence, blocked.evidence);
      assert.equal(proofCalls, 2);
      assert.equal(
        rig.model.requests.length,
        0,
        "no model start in restoration",
      );
      const R = await repairStateHead(rig.store);
      assert.notEqual(R, D);

      // Both committed snapshots live in the ACTUAL state Git history: D is an
      // ancestor of R, and D still carries the original intent/H1 record.
      const ancestor = await gitRun(
        rig.ctx.bare,
        ["merge-base", "--is-ancestor", D, R],
        rig.ctx.env,
      );
      assert.ok(ancestor.ok, `D must be an ancestor of R: ${ancestor.stderr}`);
      const digest = await sha256Hex("issue-48");
      const atDRaw = await gitRun(
        rig.ctx.bare,
        ["show", `${D}:work/${digest}.json`],
        rig.ctx.env,
      );
      assert.ok(atDRaw.ok, atDRaw.stderr);
      const atD = JSON.parse(atDRaw.stdout);
      assert.equal(atD.nextStep, "blocked");
      assert.equal(atD.target.head, LEGACY_H1);
      assert.equal(atD.intent.key, LEGACY_INTENT_KEY);
      assert.deepEqual(atD.counters, {
        attempts: 3,
        retries: 0,
        reviewRounds: 1,
      });
      assert.equal(atD.evidence.length, 1);
      const atRRaw = await gitRun(
        rig.ctx.bare,
        ["show", `${R}:work/${digest}.json`],
        rig.ctx.env,
      );
      assert.ok(atRRaw.ok, atRRaw.stderr);
      const atR = JSON.parse(atRRaw.stdout);
      assert.equal(atR.target.head, LEGACY_H0);
      assert.equal(atR.intent, null);
      assert.equal(atR.blocker, null);
      assert.deepEqual(afterSecond.reservations.map((entry) => entry.id), [
        charge.id,
      ]);
      assert.deepEqual(afterSecond.reviews.map((entry) => entry.id), [
        LEGACY_REVIEW_ID,
      ]);

      // Cycle 3: ordinary admission alone starts exactly one attempt-4 retry
      // at head B0 with the H0 correction checkout; the run stops at the next
      // bounded checkpoint and needs no publication/review infrastructure.
      port.latest.set(
        LEGACY_ISSUE,
        issueRecord(LEGACY_ISSUE, {
          relations: { subIssueCount: 0, openBlockers: [] },
        }),
      );
      // The seeded original charge settled at T0+500; the retry cycle runs in
      // real post-settlement time so admission is not clock-regression deferred.
      rig.clock.advance(2000);
      const third = await run(1);
      assert.equal(third.status, "step_limit", JSON.stringify(third));
      assert.equal(rig.model.requests.length, 1, "exactly one attempt-4 start");
      const request = rig.model.requests[0]!;
      assert.equal(request.taskId, "issue-48");
      assert.equal(request.base, LEGACY_B0);
      assert.equal(request.checkoutBase, LEGACY_H0);
      const afterThird = await rig.snapshot();
      const attempt4 = afterThird.reservations.find((entry) =>
        entry.attempt === 4
      );
      assert.ok(attempt4, "attempt-4 reservation exists");
      assert.equal(attempt4.purpose, "retry");
      assert.equal(attempt4.head, LEGACY_B0);
      assert.equal(attempt4.repository.installationId, 0);
      assert.equal(afterThird.reservations.length, 2);
      const original = afterThird.reservations.find((entry) =>
        entry.id === charge.id
      );
      assert.ok(original, "the original submitted charge is preserved");
      assert.equal(original.outcome, "submitted");
      assert.equal(original.head, LEGACY_B0);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "legacy loss bridge: a cooldown-only state move between proof and CAS refuses the stale commit",
  async () => {
    const port = new RelationsFakeGithub({ baseSha: LEGACY_B0 });
    const rig = await makeRig("legacy-loss-drift", {
      summaries: false,
      localScope: true,
      githubPort: port,
    });
    try {
      const github: GitHubPort = port;
      const { run } = legacyLossCycles({
        clock: rig.clock,
        state: rig.store,
        github,
        incidents: rig.incidents,
        replay: rig.replay,
        model: rig.model,
      });
      const gate = new DurableGitHubCooldownGate({
        state: rig.store,
        clock: rig.clock,
      });
      let proofCalls = 0;
      github.proveLegacyBaseRefreshLoss = async (taskId) => {
        proofCalls++;
        const head = await repairStateHead(rig.store);
        // A valid cooldown-only update AFTER the proof bound its head: the
        // authoritative head moves without any work-contents change.
        const recorded = await gate.recordRateLimit(0, {
          kind: "primary",
          observedAt: rig.clock.now(),
          retryNotBefore: rig.clock.now() + 60_000,
          observationId: "c".repeat(64),
          fallback: false,
        });
        assert.ok(recorded.ok);
        return portOk(legacyLossProof(taskId, head));
      };
      const unrelated = workRecord("issue-9", {
        repository: LOCAL_SENTINEL_REPO,
        source: { kind: "issue", id: "9", revision: LEGACY_B0 },
        related: { incidentId: null, issueNumber: 9 },
        target: {
          base: LEGACY_B0,
          branch: null,
          checkpoint: null,
          head: null,
          pr: null,
        },
        nextStep: "work",
        counters: { attempts: 0, retries: 0, reviewRounds: 0 },
      });
      const seeded = seededSnapshot([
        legacyLossWork("issue-48", LEGACY_ISSUE),
        unrelated,
      ], {
        reviews: [legacyLossReview(LEGACY_REVIEW_ID, LEGACY_H0, LEGACY_B0)],
      });
      const written = await rig.store.writeRepair(seeded, null);
      assert.ok(written.ok && written.value.status === "applied");

      const outcome = await run(1);
      assert.equal(outcome.status, "step_limit", JSON.stringify(outcome));
      const state = await rig.snapshot();
      assert.equal(proofCalls, 1, "one bounded proof attempt");
      const legacy = state.work.find((work) => work.id === "issue-48")!;
      assert.equal(legacy.nextStep, "work", "zero stale CAS or blocker");
      assert.equal(legacy.blocker, null);
      assert.equal(legacy.target.head, LEGACY_H1);
      assert.equal(legacy.intent?.key, LEGACY_INTENT_KEY);
      assert.deepEqual(legacy.counters, {
        attempts: 3,
        retries: 0,
        reviewRounds: 1,
      });
      // The admitted cooldown-only write moved the authoritative head while
      // the proof's bound head stayed stale: the committed state's own
      // `stateHead` field is never the current head.
      const head = await repairStateHead(rig.store);
      assert.notEqual(state.stateHead, head);
      // The unrelated eligible issue still advances normally in this run.
      const advanced = state.work.find((work) => work.id === "issue-9")!;
      assert.equal(
        advanced.target.branch,
        candidateBranch(asWorkItemId("issue-9")),
      );
      assert.equal(rig.model.requests.length, 0);
      assert.equal(state.reservations.length, 0);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "legacy loss bridge: a null higher candidate never starves the later recoverable one",
  async () => {
    const rig = legacyLossMemory();
    const calls: string[] = [];
    rig.github.proveLegacyBaseRefreshLoss = async (taskId) => {
      calls.push(taskId);
      if (taskId === "issue-2") return portOk(null);
      return portOk(legacyLossProof(taskId, await repairStateHead(rig.state)));
    };
    const unrelated = workRecord("issue-9", {
      repository: LOCAL_SENTINEL_REPO,
      source: { kind: "issue", id: "9", revision: LEGACY_B0 },
      related: { incidentId: null, issueNumber: 9 },
      classification: { severity: "P1", priority: null },
      target: {
        base: LEGACY_B0,
        branch: null,
        checkpoint: null,
        head: null,
        pr: null,
      },
      nextStep: "work",
      counters: { attempts: 0, retries: 0, reviewRounds: 0 },
    });
    const seeded = seededSnapshot([
      legacyLossWork("issue-2", 2),
      legacyLossWork("issue-4", 4),
      unrelated,
    ], {
      reviews: [legacyLossReview(LEGACY_REVIEW_ID, LEGACY_H0, LEGACY_B0)],
    });
    const written = await rig.state.writeRepair(seeded, null);
    assert.ok(written.ok && written.value.status === "applied");

    // Cycle 1: the null proof leaves the scan running, so the later
    // recoverable candidate receives its discovery CAS.
    const first = await rig.run(1);
    assert.equal(first.status, "step_limit", JSON.stringify(first));
    assert.deepEqual(calls, ["issue-2", "issue-4"], "one per phase");
    let state = await rig.snapshot();
    const higher = state.work.find((work) => work.id === "issue-2")!;
    assert.equal(higher.nextStep, "work", "null proof is no-op");
    assert.equal(higher.target.head, LEGACY_H1);
    assert.equal(higher.intent?.key, LEGACY_INTENT_KEY);
    const recovered = state.work.find((work) => work.id === "issue-4")!;
    assert.equal(recovered.nextStep, "blocked");
    assert.equal(recovered.blocker?.kind, "missing_evidence");
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 0);

    // Cycle 2: restoration, then the unrelated P1 issue advances normally in
    // the same run. No model work is attributable to either bridge phase.
    const second = await rig.run(2);
    assert.equal(second.status, "step_limit", JSON.stringify(second));
    assert.deepEqual(calls, [
      "issue-2",
      "issue-4",
      "issue-2",
      "issue-4",
    ]);
    state = await rig.snapshot();
    const restored = state.work.find((work) => work.id === "issue-4")!;
    assert.equal(restored.nextStep, "work");
    assert.equal(restored.target.head, LEGACY_H0);
    assert.equal(restored.intent, null);
    const advanced = state.work.find((work) => work.id === "issue-9")!;
    assert.equal(
      advanced.target.branch,
      candidateBranch(asWorkItemId("issue-9")),
    );
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 0);
    assert.equal(
      state.work.find((work) => work.id === "issue-2")!.nextStep,
      "work",
      "the null candidate is still untouched",
    );
  },
);

Deno.test(
  "legacy loss bridge: an unavailable higher candidate never starves the later recoverable one",
  async () => {
    const rig = legacyLossMemory();
    const calls: string[] = [];
    rig.github.proveLegacyBaseRefreshLoss = async (taskId) => {
      calls.push(taskId);
      if (taskId === "issue-2") {
        return portError("unavailable", "legacy loss proof unavailable");
      }
      return portOk(legacyLossProof(taskId, await repairStateHead(rig.state)));
    };
    const unrelated = workRecord("issue-9", {
      repository: LOCAL_SENTINEL_REPO,
      source: { kind: "issue", id: "9", revision: LEGACY_B0 },
      related: { incidentId: null, issueNumber: 9 },
      classification: { severity: "P1", priority: null },
      target: {
        base: LEGACY_B0,
        branch: null,
        checkpoint: null,
        head: null,
        pr: null,
      },
      nextStep: "work",
      counters: { attempts: 0, retries: 0, reviewRounds: 0 },
    });
    const seeded = seededSnapshot([
      legacyLossWork("issue-2", 2),
      legacyLossWork("issue-4", 4),
      unrelated,
    ], {
      reviews: [legacyLossReview(LEGACY_REVIEW_ID, LEGACY_H0, LEGACY_B0)],
    });
    const written = await rig.state.writeRepair(seeded, null);
    assert.ok(written.ok && written.value.status === "applied");

    // Cycle 1: the unavailable proof leaves the scan running, so the later
    // recoverable candidate receives its discovery CAS.
    const first = await rig.run(1);
    assert.equal(first.status, "step_limit", JSON.stringify(first));
    assert.deepEqual(calls, ["issue-2", "issue-4"], "one per phase");
    let state = await rig.snapshot();
    const higher = state.work.find((work) => work.id === "issue-2")!;
    assert.equal(higher.nextStep, "work", "unavailable proof is no-op");
    assert.equal(higher.target.head, LEGACY_H1);
    assert.equal(higher.intent?.key, LEGACY_INTENT_KEY);
    const recovered = state.work.find((work) => work.id === "issue-4")!;
    assert.equal(recovered.nextStep, "blocked");
    assert.equal(recovered.blocker?.kind, "missing_evidence");
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 0);

    // Cycle 2: restoration, then the unrelated P1 issue advances normally in
    // the same run. No model work is attributable to either bridge phase.
    const second = await rig.run(2);
    assert.equal(second.status, "step_limit", JSON.stringify(second));
    assert.deepEqual(calls, [
      "issue-2",
      "issue-4",
      "issue-2",
      "issue-4",
    ]);
    state = await rig.snapshot();
    const restored = state.work.find((work) => work.id === "issue-4")!;
    assert.equal(restored.nextStep, "work");
    assert.equal(restored.target.head, LEGACY_H0);
    assert.equal(restored.intent, null);
    const advanced = state.work.find((work) => work.id === "issue-9")!;
    assert.equal(
      advanced.target.branch,
      candidateBranch(asWorkItemId("issue-9")),
    );
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 0);
    assert.equal(
      state.work.find((work) => work.id === "issue-2")!.nextStep,
      "work",
      "the unavailable candidate is still untouched",
    );
  },
);

Deno.test(
  "legacy loss bridge: an earlier clean H0 receipt keeps the tuple blocked",
  async () => {
    const rig = legacyLossMemory();
    let proofCalls = 0;
    rig.github.proveLegacyBaseRefreshLoss = async (taskId) => {
      proofCalls++;
      return portOk(legacyLossProof(taskId, await repairStateHead(rig.state)));
    };
    // The clean receipt sorts FIRST for this PR/head, exactly the order the
    // existing headRejectedByReview helper reads (the real store's
    // deterministic id order preserves it too).
    const clean = legacyLossReview(
      "review-receipt:00-clean-first",
      LEGACY_H0,
      LEGACY_B0,
      {
        resultId: "result-clean",
        findings: [],
        unresolvedSeverities: [],
      },
    );
    const p2 = legacyLossReview(LEGACY_REVIEW_ID, LEGACY_H0, LEGACY_B0);
    const seeded = seededSnapshot([
      legacyLossWork("issue-48", LEGACY_ISSUE, legacyLossBlockedExtras()),
    ], {
      reviews: [clean, p2],
      reservations: [legacyLossCharge()],
    });
    const written = await rig.state.writeRepair(seeded, null);
    assert.ok(written.ok && written.value.status === "applied");
    const writesBefore = rig.state.repairWrites;
    const before = canonicalStringify((await rig.snapshot()).work[0]);

    const outcome = await rig.run(1);
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    const record = state.work[0]!;
    assert.equal(record.nextStep, "blocked");
    assert.equal(record.blocker?.kind, "missing_evidence");
    assert.equal(record.target.head, LEGACY_H1);
    assert.equal(record.intent?.key, LEGACY_INTENT_KEY);
    assert.deepEqual(record.counters, {
      attempts: 3,
      retries: 0,
      reviewRounds: 1,
    });
    assert.equal(canonicalStringify(record), before);
    assert.equal(proofCalls, 1);
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 1);
    assert.equal(state.reservations[0]!.outcome, "submitted");
    assert.equal(
      rig.state.repairWrites,
      writesBefore,
      "refusal writes no state",
    );
  },
);

Deno.test(
  "legacy loss bridge: exhausted attempts get truthful discovery but never restoration",
  async () => {
    const rig = legacyLossMemory();
    let proofCalls = 0;
    rig.github.proveLegacyBaseRefreshLoss = async (taskId) => {
      proofCalls++;
      return portOk(legacyLossProof(taskId, await repairStateHead(rig.state)));
    };
    const seeded = seededSnapshot([
      legacyLossWork("issue-48", LEGACY_ISSUE, {
        counters: { attempts: 4, retries: 0, reviewRounds: 1 },
      }),
    ], {
      reviews: [legacyLossReview(LEGACY_REVIEW_ID, LEGACY_H0, LEGACY_B0)],
      reservations: [legacyLossCharge("res-4", { attempt: 4 })],
    });
    const written = await rig.state.writeRepair(seeded, null);
    assert.ok(written.ok && written.value.status === "applied");

    const first = await rig.run(1);
    assert.equal(first.status, "step_limit", JSON.stringify(first));
    assert.equal(proofCalls, 1);
    let state = await rig.snapshot();
    assert.equal(state.work[0]!.nextStep, "blocked");
    assert.equal(state.work[0]!.blocker?.kind, "missing_evidence");
    assert.equal(state.work[0]!.counters.attempts, 4);
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 1);

    // Exhaustion never authorizes a restore proof or a fourth-limit bypass.
    const second = await rig.run(1);
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(proofCalls, 1, "no restore proof for an exhausted task");
    state = await rig.snapshot();
    assert.equal(state.work[0]!.nextStep, "blocked");
    assert.equal(state.work[0]!.blocker?.kind, "missing_evidence");
    assert.equal(state.reservations.length, 1);
    assert.equal(rig.model.requests.length, 0);
  },
);

Deno.test(
  "legacy loss bridge: new-format and unprepared/prepared foreign intents are never probed",
  async () => {
    const rig = legacyLossMemory();
    let proofCalls = 0;
    rig.github.proveLegacyBaseRefreshLoss = () => {
      proofCalls++;
      return Promise.resolve(portOk(null));
    };
    const blocked = legacyLossBlockedExtras();
    const newFormatBranch = candidateBranch(asWorkItemId("issue-30"));
    const newFormat = workRecord(
      "issue-30",
      legacyLossOverrides("issue-30", 30, {
        ...blocked,
        target: {
          base: LEGACY_B0,
          branch: newFormatBranch,
          checkpoint: { branch: newFormatBranch, sha: LEGACY_H1 },
          head: LEGACY_H1,
          pr: LEGACY_PR,
          candidateState: candidateStateFor(LEGACY_B0, LEGACY_H1),
        },
      }),
    );
    const preReceipt = workRecord(
      "issue-31",
      legacyLossOverrides("issue-31", 31, {
        ...blocked,
        intent: {
          kind: "implementation",
          key: implementationIntentKey("res-pre"),
          startedAt: T0,
          branch: candidateBranch(asWorkItemId("issue-31")),
          expectedHead: null,
          observedBase: LEGACY_B0,
          pr: null,
          requestId: "res-pre",
          resultId: null,
        },
      }),
    );
    const prepared = workRecord(
      "issue-32",
      legacyLossOverrides("issue-32", 32, {
        ...blocked,
        intent: { ...legacyLossIntent("issue-32"), resultId: LEGACY_H1 },
      }),
    );
    const seeded = seededSnapshot([newFormat, preReceipt, prepared]);
    const written = await rig.state.writeRepair(seeded, null);
    assert.ok(written.ok && written.value.status === "applied");
    const writesBefore = rig.state.repairWrites;

    const outcome = await rig.run(1);
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    assert.equal(proofCalls, 0, "no unsupported record is proved");
    const state = await rig.snapshot();
    for (const id of ["issue-30", "issue-31", "issue-32"]) {
      const before = canonicalStringify(seeded.work.find((w) => w.id === id));
      const after = canonicalStringify(state.work.find((w) => w.id === id));
      assert.equal(after, before, `${id} is untouched`);
    }
    assert.equal(rig.state.repairWrites, writesBefore, "no state write");
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 0);
  },
);

Deno.test(
  "legacy loss bridge: a mismatched proof tuple stays untouched and uncharged",
  async () => {
    const rig = legacyLossMemory();
    let proofCalls = 0;
    rig.github.proveLegacyBaseRefreshLoss = async (taskId) => {
      proofCalls++;
      return portOk(legacyLossProof(taskId, await repairStateHead(rig.state), {
        lostHead: LEGACY_B1,
      }));
    };
    const seeded = seededSnapshot([
      legacyLossWork("issue-48", LEGACY_ISSUE),
    ], {
      reviews: [legacyLossReview(LEGACY_REVIEW_ID, LEGACY_H0, LEGACY_B0)],
      reservations: [legacyLossCharge()],
    });
    const written = await rig.state.writeRepair(seeded, null);
    assert.ok(written.ok && written.value.status === "applied");
    const writesBefore = rig.state.repairWrites;
    const before = canonicalStringify((await rig.snapshot()).work[0]);

    const outcome = await rig.run(1);
    // The refused record is deferred for this run, so no eligible work remains.
    assert.equal(outcome.status, "margin", JSON.stringify(outcome));
    assert.equal(proofCalls, 1, "the phase is attempted once per run");
    const state = await rig.snapshot();
    assert.equal(canonicalStringify(state.work[0]), before);
    assert.equal(rig.state.repairWrites, writesBefore, "no state write");
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 1);
    assert.equal(state.reservations[0]!.outcome, "submitted");
  },
);

Deno.test(
  "legacy loss bridge: an absent proof capability leaves generic behavior unchanged",
  async () => {
    const rig = legacyLossMemory();
    const seeded = seededSnapshot([
      legacyLossWork("issue-48", LEGACY_ISSUE),
    ], {
      reviews: [legacyLossReview(LEGACY_REVIEW_ID, LEGACY_H0, LEGACY_B0)],
      reservations: [legacyLossCharge()],
    });
    const written = await rig.state.writeRepair(seeded, null);
    assert.ok(written.ok && written.value.status === "applied");
    const writesBefore = rig.state.repairWrites;

    const outcome = await rig.run(1);
    assert.equal(outcome.status, "step_limit", JSON.stringify(outcome));
    const state = await rig.snapshot();
    const record = state.work[0]!;
    // The generic unprepared base-refresh path waits bounded; the bridge never
    // writes its blocker and never touches the loss tuple.
    assert.equal(record.nextStep, "work");
    assert.equal(record.blocker, null);
    assert.equal(record.target.head, LEGACY_H1);
    assert.equal(record.intent?.key, LEGACY_INTENT_KEY);
    assert.equal(record.wait?.reason, "unavailable");
    assert.equal(rig.state.repairWrites, writesBefore + 1);
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 1);
  },
);

// ---------------------------------------------------------------------------
// Review attempt recovery: a review that concluded without an accepted verdict
// is a bounded, observable disposition — never an eternal pending poll.
// ---------------------------------------------------------------------------

/** Terminal no-verdict observation for the exact published head. */
function noVerdictObservation(
  head: GitSha,
  summary: string,
  at: number,
): ReviewObservationV1 {
  return {
    status: "unavailable",
    requestId: "review-req-1",
    reviewer: null,
    resultId: null,
    completedAt: at,
    observedHead: head,
    observedBase: SHA1,
    findings: [],
    summary,
    receivedAt: at + 1,
  };
}

/** Drive one task to its first review wait through the real lifecycle. */
async function rigAtReviewWait(prefix: string) {
  const rig = await makeRig(prefix, {
    github: { candidateLifecycle: positiveLifecycle() },
  });
  const first = await rig.run();
  assert.equal(first.status, "idle", JSON.stringify(first));
  const state = await rig.snapshot();
  const work = state.work[0]!;
  assert.equal(work.nextStep, "review");
  assert.equal(work.wait?.reason, "review_pending");
  assert.equal(work.counters.reviewRounds, 1);
  return { rig, work };
}

Deno.test(
  "review no-verdict: one bounded re-attempt is requested under its own attempt identity",
  async () => {
    const { rig, work } = await rigAtReviewWait("review-no-verdict-retry");
    try {
      const reason =
        "structured review unavailable: the runtime terminal was not completed";
      rig.clock.advance(15 * 60_000 + 1);
      rig.github.reviewStatus = "unavailable";
      rig.github.reviewObservations = noVerdictObservation(
        work.target.head!,
        reason,
        rig.clock.now() - 1000,
      );
      const second = await rig.run();
      assert.equal(second.status, "idle", JSON.stringify(second));
      const state = await rig.snapshot();
      const record = state.work[0]!;
      // A fresh round is a fresh bounded attempt of the SAME head: charged,
      // recorded and awaiting its own review.
      assert.equal(record.nextStep, "review");
      assert.equal(record.wait?.reason, "review_pending");
      assert.equal(record.counters.reviewRounds, 2);
      assert.equal(record.target.head, work.target.head);
      assert.equal(record.blocker, null);
      assert.equal(
        rig.github.reviewRequestIdentities.length,
        2,
        "the rejected head keeps exactly one request per attempt",
      );
      assert.equal(
        rig.github.reviewRequestIdentities[0]!.operationKey,
        `review:7:${work.target.head}`,
      );
      assert.equal(
        rig.github.reviewRequestIdentities[1]!.operationKey,
        `review:7:${work.target.head}:attempt-2`,
      );
      const reviewCharges = state.reservations.filter((reservation) =>
        reservation.purpose === "review_request"
      );
      assert.equal(reviewCharges.length, 2);
      // State reservation order is not a chronology; the durable attempt
      // identity is what proves each round was charged on its own.
      assert.deepEqual(
        reviewCharges.map((reservation) => reservation.attempt).sort(),
        [1, 2],
        "each attempt carries its own durable charge identity",
      );
      assert.ok(
        reviewCharges.every((reservation) =>
          reservation.outcome === "submitted"
        ),
      );

      // The re-attempt is a REAL review of the same head: when it completes
      // with an accepted verdict, the recorded receipt is bound to the exact
      // identity it was read under, so a later delivery can never be
      // authorized by the earlier attempt's receipt.
      const attemptKey = `review:7:${work.target.head}:attempt-2`;
      const completedAt = rig.clock.now() + 1000;
      rig.github.reviewObservationsByKey.set(attemptKey, {
        status: "completed",
        requestId: `review-${attemptKey}`,
        reviewer: rig.github.reviewerIdentity,
        resultId: "result-attempt-2",
        completedAt,
        observedHead: work.target.head!,
        observedBase: record.target.base,
        findings: [],
        summary: "No actionable defects found in the supplied change.",
        receivedAt: completedAt + 1,
      });
      rig.clock.advance(15 * 60_000 + 1);
      await rig.run();
      const delivered = await rig.snapshot();
      const deliveredRecord = delivered.work[0]!;
      const receiptId = await reviewReceiptId(
        attemptKey,
        work.target.head!,
      );
      assert.ok(
        deliveredRecord.evidence.some((ref) =>
          ref.ref === `artifact:review-receipt/${receiptId}`
        ),
        "the accepted verdict is recorded under the identity it was read at",
      );
      const receipt = delivered.reviews.find((review) =>
        review.id === receiptId
      );
      assert.ok(receipt !== undefined, "the receipt is durable");
      assert.equal(receipt.requestId, `review-${attemptKey}`);
      assert.equal(receipt.outcome, "completed");
      assert.equal(receipt.resultId, "result-attempt-2");
      assert.equal(receipt.completedAt, completedAt);
      assert.deepEqual(receipt.unresolvedSeverities, []);
      assert.equal(receipt.pullRequest.head, work.target.head);
      assert.equal(receipt.pullRequest.base, record.target.base);
      assert.equal(deliveredRecord.nextStep, "delivery");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "review no-verdict: the round allowance blocks the task with the observed reason",
  async () => {
    const { rig, work } = await rigAtReviewWait("review-no-verdict-blocked");
    try {
      const reason =
        "structured review unavailable: the review reported insufficient evidence";
      // The plan's three review rounds are already consumed for this head.
      rig.clock.advance(15 * 60_000 + 1);
      for (let round = 0; round < 2; round += 1) {
        rig.github.reviewStatus = "unavailable";
        rig.github.reviewObservations = noVerdictObservation(
          work.target.head!,
          reason,
          rig.clock.now() - 1000,
        );
        await rig.run();
        rig.clock.advance(15 * 60_000 + 1);
      }
      let state = await rig.snapshot();
      assert.equal(state.work[0]!.counters.reviewRounds, 3);
      const requestsBefore = rig.github.reviewRequestIdentities.length;
      const chargesBefore = state.reservations.length;

      const blocked = await rig.run();
      assert.equal(blocked.status, "idle", JSON.stringify(blocked));
      state = await rig.snapshot();
      const record = state.work[0]!;
      // No fourth round exists: the task is blocked with the exact reason
      // instead of polling a terminal disposition forever.
      assert.equal(record.nextStep, "blocked");
      assert.equal(record.blocker?.kind, "review_quota");
      assert.ok(
        record.blocker?.message.includes(reason),
        `blocker names the observed reason: ${record.blocker?.message}`,
      );
      assert.equal(record.wait, null);
      assert.equal(rig.github.reviewRequestIdentities.length, requestsBefore);
      assert.equal(state.reservations.length, chargesBefore);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "review no-verdict: a first-attempt journal stays observable under its legacy identity",
  async () => {
    const { rig, work } = await rigAtReviewWait("review-no-verdict-legacy");
    try {
      const head = work.target.head!;
      const reason =
        "structured review unavailable: the owned session was closed before completion";
      // The persisted record of a review requested BEFORE attempt identities
      // existed: round two is already consumed while its one durable journal
      // is bound only under the original first-attempt key.
      const read = await rig.store.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      if (!read.ok || read.value.status !== "found") return;
      const legacyRecord = {
        ...read.value.snapshot.work[0]!,
        counters: { ...work.counters, reviewRounds: 2 },
        wait: null,
      };
      const rewritten = await rig.store.writeRepair({
        ...read.value.snapshot,
        stateHead: read.value.head,
        sequence: read.value.snapshot.sequence + 1,
        updatedAt: rig.clock.now(),
        work: [legacyRecord],
      }, read.value.head);
      assert.ok(
        rewritten.ok && rewritten.value.status === "applied",
        JSON.stringify(rewritten),
      );
      rig.clock.advance(15 * 60_000 + 1);
      rig.github.reviewStatus = "unavailable";
      rig.github.unboundReviewKeys.add(`review:7:${head}:attempt-2`);
      rig.github.reviewObservationsByKey.set(
        `review:7:${head}`,
        noVerdictObservation(head, reason, rig.clock.now() - 1000),
      );
      const second = await rig.run();
      assert.equal(second.status, "idle", JSON.stringify(second));
      const state = await rig.snapshot();
      const record = state.work[0]!;
      // The legacy journal was observed, so exactly one re-attempt was
      // requested instead of waiting forever on an unobservable identity.
      assert.deepEqual(rig.github.observedReviewKeys, [
        `review:7:${head}:attempt-2`,
        `review:7:${head}`,
      ]);
      assert.equal(record.counters.reviewRounds, 3);
      assert.equal(record.nextStep, "review");
      assert.equal(
        rig.github.reviewRequestIdentities[1]!.operationKey,
        `review:7:${head}:attempt-3`,
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Retired PR WIP: the hosted retirement disposition must free a real WIP slot
// for the ACTUAL loop, not only for a pure helper. These cases seed durable
// state with records parked through the actual applyHostedRetirements and then
// run the real repair cycle over real temporary Git state.
// ---------------------------------------------------------------------------

const RETIRED_AI_120 = workItemIdForIssue(REPO, 120);
const RETIRED_SENTINEL_61 = workItemIdForIssue(REPO, 61);
const HUMAN_MERGED_264 = workItemIdForIssue(REPO, 264);
const FRESH_AFTER_RETIREMENT = workItemIdForIssue(REPO, 999);

/** One closed-unmerged-PR record in the shape retirement consumes. */
function retiredPrRecord(
  id: WorkItemId,
  issueNumber: number,
  pr: number,
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return workRecord(id, {
    source: { kind: "issue", id: String(issueNumber), revision: SHA1 },
    related: { incidentId: null, issueNumber },
    target: {
      base: SHA1,
      branch: `sentinel/repair/issue-${issueNumber}`,
      checkpoint: null,
      head: SHA2,
      pr,
    },
    nextStep: "review",
    wait: { reason: "review_pending", since: T0, until: T0 + 3_600_000 },
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    ...overrides,
  });
}

/** One open issue row served to the real intake in these cases. */
function freshIssueRow(number: number): GitHubIssueV1 {
  return issueRecord(number, {
    title: "fresh eligible repair after retirements",
    labels: ["P2", "priority:9"],
    createdAt: T0 - 100,
  });
}

Deno.test(
  "retired PR WIP: actual retirements free two slots and the fresh issue starts exactly one model session",
  async () => {
    const rig = await makeRig("retired-wip", {
      summaries: false,
      github: {
        openIssues: [freshIssueRow(999)],
        // The pre-admission freshness re-read must resolve the same row.
        issues: [freshIssueRow(999)],
      },
    });
    try {
      const retiredAi120 = retiredPrRecord(RETIRED_AI_120, 120, 375, {
        evidence: [{
          kind: "review_receipt",
          ref: "artifact:review-receipt/ai-120",
        }],
      });
      const retiredSentinel61 = retiredPrRecord(RETIRED_SENTINEL_61, 61, 63, {
        counters: { attempts: 2, retries: 0, reviewRounds: 1 },
        intent: {
          kind: "implementation",
          key: "implementation:sentinel-61",
          startedAt: T0 + 500,
          branch: "sentinel/repair/issue-61",
          expectedHead: null,
          observedBase: SHA1,
          pr: null,
          requestId: "charge-61",
          resultId: null,
        },
      });
      // ai#264 / PR393: human-merged but unaccepted, so it stays counted.
      const humanMerged264 = retiredPrRecord(HUMAN_MERGED_264, 264, 393, {
        nextStep: "delivery",
      });
      const historicalCharge = reservation("charge-61", {
        taskId: RETIRED_SENTINEL_61,
        head: SHA1,
        attempt: 2,
        purpose: "implementation",
        outcome: "submitted",
        settledAt: T0 + 2000,
      });
      const historicalReceipt = reviewReceipt("review-receipt-ai-120", {
        pullRequest: { number: 375, head: SHA2, base: SHA1 },
        submittedAt: T0 + 1000,
        observedAt: T0 + 2000,
      });
      const seeded = seededSnapshot(
        [retiredAi120, retiredSentinel61, humanMerged264],
        { reservations: [historicalCharge], reviews: [historicalReceipt] },
      );
      const seededWrite = await rig.store.writeRepair(seeded, null);
      assert.ok(seededWrite.ok && seededWrite.value.status === "applied");
      const read = await rig.store.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      if (!read.ok || read.value.status !== "found") {
        throw new Error("seeded repair state unavailable");
      }

      const plans = planHostedRetirements(
        read.value.snapshot,
        new Set([120, 61]),
        new Set([retiredAi120.id, retiredSentinel61.id]),
      );
      assert.deepEqual(
        plans.map((plan) => plan.id).sort(),
        [retiredAi120.id, retiredSentinel61.id].sort(),
        "the actual retirement helper parks both closed-unmerged PRs",
      );
      const retired = applyHostedRetirements(
        read.value.snapshot,
        read.value.head,
        plans,
        T0 + 1000,
      );
      const retiredWrite = await rig.store.writeRepair(
        retired,
        read.value.head,
      );
      assert.ok(retiredWrite.ok && retiredWrite.value.status === "applied");
      // The retirement write advanced the durable state past the frozen rig
      // clock; move the fake clock forward so the run's own writes are legal.
      rig.clock.advance(2_000);

      const outcome = await rig.run();
      // Semantic red before the fix: the two retired records still count, the
      // fresh issue is WIP-skipped and this is 0 with no model start.
      assert.equal(rig.model.requests.length, 1, JSON.stringify(outcome));
      assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));

      const state = await rig.snapshot();
      const fresh = state.work.find((record) =>
        record.id === FRESH_AFTER_RETIREMENT
      );
      assert.ok(fresh, "the fresh issue reached durable state");
      assert.equal(fresh.counters.attempts, 1);
      assert.equal(
        state.reservations.filter((record) =>
          record.taskId === FRESH_AFTER_RETIREMENT &&
          record.purpose === "implementation"
        ).length,
        1,
        "exactly one durable implementation charge",
      );

      const ai120 = state.work.find((record) => record.id === RETIRED_AI_120);
      assert.ok(ai120);
      assert.equal(ai120.nextStep, "blocked");
      assert.equal(ai120.target.pr, 375);
      assert.equal(ai120.target.head, SHA2);
      assert.equal(ai120.blocker?.kind, "other");
      assert.equal(ai120.blocker?.message, HOSTED_AUTONOMY_RETIRED);
      assert.equal(ai120.wait, null);
      assert.equal(ai120.intent, null);
      assert.equal(ai120.counters.attempts, 1);
      assert.equal(ai120.counters.reviewRounds, 1);

      const sentinel61 = state.work.find((record) =>
        record.id === RETIRED_SENTINEL_61
      );
      assert.ok(sentinel61);
      assert.equal(sentinel61.nextStep, "blocked");
      assert.equal(sentinel61.target.pr, 63);
      assert.equal(sentinel61.target.head, SHA2);
      assert.equal(sentinel61.blocker?.kind, "other");
      assert.equal(sentinel61.blocker?.message, HOSTED_AUTONOMY_RETIRED);
      assert.equal(sentinel61.wait, null);
      assert.equal(sentinel61.intent, null);
      assert.equal(sentinel61.counters.attempts, 2);
      assert.equal(sentinel61.counters.reviewRounds, 1);

      assert.ok(
        state.reservations.some((record) =>
          record.id === historicalCharge.id &&
          record.outcome === "submitted"
        ),
        "the historical charge is retained",
      );
      assert.ok(
        state.reviews.some((record) => record.id === historicalReceipt.id),
        "the historical review receipt is retained",
      );

      const humanMerged = state.work.find((record) =>
        record.id === HUMAN_MERGED_264
      );
      assert.ok(humanMerged);
      assert.equal(humanMerged.nextStep, "delivery");
      assert.equal(humanMerged.target.pr, 393);
      assert.equal(humanMerged.target.head, SHA2);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "retired PR WIP: three arbitrary blocked or waiting PRs yield no model start (control)",
  async () => {
    const rig = await makeRig("retired-wip-control", {
      summaries: false,
      github: {
        openIssues: [freshIssueRow(999)],
        // The control must fail only on the cap: a missing issue row would
        // produce zero starts for the wrong reason.
        issues: [freshIssueRow(999)],
      },
    });
    try {
      const genericBlocked = retiredPrRecord(
        workItemIdForIssue(REPO, 301),
        301,
        401,
        {
          nextStep: "blocked",
          wait: null,
          blocker: {
            kind: "other",
            message: "model run ended without a trusted receipt",
            since: T0,
          },
        },
      );
      const unavailableBlocked = retiredPrRecord(
        workItemIdForIssue(REPO, 302),
        302,
        402,
        {
          nextStep: "blocked",
          wait: null,
          blocker: {
            kind: "unavailable",
            message: "review transport unavailable",
            since: T0,
          },
        },
      );
      const waitingReview = retiredPrRecord(
        workItemIdForIssue(REPO, 303),
        303,
        403,
      );
      const write = await rig.store.writeRepair(
        seededSnapshot([genericBlocked, unavailableBlocked, waitingReview]),
        null,
      );
      assert.ok(write.ok && write.value.status === "applied");

      const outcome = await rig.run();
      assert.equal(rig.model.requests.length, 0, JSON.stringify(outcome));

      const state = await rig.snapshot();
      const fresh = state.work.find((record) =>
        record.id === FRESH_AFTER_RETIREMENT
      );
      assert.ok(fresh, "the fresh issue was admitted into state");
      assert.equal(fresh.nextStep, "work");
      assert.equal(fresh.target.pr, null);
      assert.equal(fresh.counters.attempts, 0);
      assert.equal(fresh.wait, null, "never selected or deferred");
      assert.equal(state.reservations.length, 0);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);
