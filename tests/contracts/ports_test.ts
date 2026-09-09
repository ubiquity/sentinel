// Minimal fake-port contract test: fakes hold no product logic — they record
// calls and return canned results. The test pins result-kind discrimination
// (unavailable ≠ empty ≠ success; ambiguous ≠ failed ≠ blocked), the
// expected-head compare-and-swap semantics of the StateStore contract, the
// separate read-only view / repair writer / release writer capabilities, and
// the exact deployment identity shapes required by release recovery.
import assert from "node:assert/strict";

import type {
  CommandId,
  FixtureDigest,
  GitSha,
  WorkItemId,
} from "../../src/contracts/brands.ts";
import type {
  DenoReleasePort,
  GitHubPort,
  IsolatedReplayResultV1,
  MergeOutcomeV1,
  PortResultV1,
  ReleaseStateWriter,
  RepairStateWriter,
  ReplayPort,
  ReplayRunRequestV1,
  StateReadView,
  StateStore,
  StateWriteResultV1,
} from "../../src/contracts/ports.ts";
import { portError, portOk, SystemClock } from "../../src/contracts/ports.ts";
import type { Clock } from "../../src/contracts/ports.ts";
import { parseIncidentSummaryV1 } from "../../src/contracts/incident.ts";
import type { IncidentSummaryV1 } from "../../src/contracts/incident.ts";
import type {
  IncidentCoverageV1,
  RepositoryIdentityV1,
} from "../../src/contracts/shared.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import {
  expectExactKeys,
  expectRecord,
  RecordParseError,
} from "../../src/contracts/validation.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";

const SHA: GitSha = "aafb7ee0598699bb7fb8a72ea133693ed64462da" as GitSha;
const REVIEWER = "chatgpt-codex-connector[bot]";

/** Minimal valid completed review receipt, parsed by the frozen parser. */
function completedReview(
  overrides: Record<string, unknown> = {},
): ReviewReceiptV1 {
  return parseReviewReceiptV1({
    version: "v1",
    kind: "review_receipt",
    id: "review-1",
    requestId: "req-1",
    expectedReviewer: REVIEWER,
    observedReviewer: REVIEWER,
    repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
    pullRequest: { number: 1, head: SHA, base: SHA },
    outcome: "completed",
    resultId: "result-1",
    summary: null,
    findings: [],
    findingsUncounted: 0,
    unresolvedSeverities: [],
    submittedAt: 1786000000000,
    completedAt: 1786000001000,
    observedAt: 1786000002000,
    ...overrides,
  });
}

/** The exact new merge request shape the GitHub fake now requires. */
function mergeRequest(): Parameters<GitHubPort["mergePullRequest"]>[0] {
  return {
    pullRequestNumber: 1,
    expectedHead: SHA,
    expectedBase: SHA,
    review: completedReview(),
  };
}

/** Test helpers: mark strings with the exact contract brands. */
function digest(hex: string): FixtureDigest {
  return hex as FixtureDigest;
}
function workId(value: string): WorkItemId {
  return value as WorkItemId;
}
function commandId(value: string): CommandId {
  return value as CommandId;
}

/** Resolves a canned port result for non-async fake methods. */
function resolved<T>(result: PortResultV1<T>): Promise<PortResultV1<T>> {
  return Promise.resolve(result);
}

class FakeClock implements Clock {
  private current: number;
  constructor(start: number) {
    this.current = start;
  }
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

/** Records every call; no product logic. */
class RecordingReplayPort implements ReplayPort {
  readonly requests: ReplayRunRequestV1[] = [];
  private readonly result: PortResultV1<IsolatedReplayResultV1>;
  constructor(result: PortResultV1<IsolatedReplayResultV1>) {
    this.result = result;
  }
  runReplay(
    request: ReplayRunRequestV1,
  ): Promise<PortResultV1<IsolatedReplayResultV1>> {
    this.requests.push(request);
    return resolved(this.result);
  }
}

/** In-memory expected-head CAS per branch; no product logic. */
class FakeStateStore implements StateStore {
  private repair: RepairStateSnapshotV1 | null = null;
  private repairHead: GitSha | null = null;
  private release: ReleaseStateSnapshotV1 | null = null;
  private releaseHead: GitSha | null = null;
  repairWrites = 0;
  releaseWrites = 0;
  /** When set, the next repair write reports an ambiguous network outcome. */
  ambiguousRepairNext = false;
  private seq = 0;

  readRepair(): Promise<
    PortResultV1<
      | {
        status: "found";
        snapshot: RepairStateSnapshotV1;
        head: GitSha;
        ref: string | null;
      }
      | { status: "absent"; currentHead: GitSha | null; ref: string | null }
    >
  > {
    if (this.repair === null) {
      return resolved(
        portOk({
          status: "absent",
          currentHead: this.repairHead,
          ref: "refs/heads/sentinel-state/repair",
        }),
      );
    }
    return resolved(
      portOk({
        status: "found",
        snapshot: this.repair,
        head: this.repairHead ?? SHA,
        ref: "refs/heads/sentinel-state/repair",
      }),
    );
  }
  writeRepair(
    next: RepairStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    this.repairWrites++;
    if (this.ambiguousRepairNext) {
      this.ambiguousRepairNext = false;
      return resolved(
        portOk({ status: "ambiguous", currentHead: this.repairHead }),
      );
    }
    if (this.repairHead !== expectedHead) {
      return resolved(
        portOk({ status: "conflict", currentHead: this.repairHead }),
      );
    }
    const newHead = nextHead(this.seq++);
    this.repair = next;
    this.repairHead = newHead;
    return resolved(portOk({ status: "applied", head: newHead }));
  }
  readRelease(): Promise<
    PortResultV1<
      | {
        status: "found";
        snapshot: ReleaseStateSnapshotV1;
        head: GitSha;
        ref: string | null;
      }
      | { status: "absent"; currentHead: GitSha | null; ref: string | null }
    >
  > {
    if (this.release === null) {
      return resolved(
        portOk({
          status: "absent",
          currentHead: this.releaseHead,
          ref: "refs/heads/sentinel-state/release",
        }),
      );
    }
    return resolved(
      portOk({
        status: "found",
        snapshot: this.release,
        head: this.releaseHead ?? SHA,
        ref: "refs/heads/sentinel-state/release",
      }),
    );
  }
  writeRelease(
    next: ReleaseStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    this.releaseWrites++;
    if (this.releaseHead !== expectedHead) {
      return resolved(
        portOk({ status: "conflict", currentHead: this.releaseHead }),
      );
    }
    const newHead = nextHead(this.seq++);
    this.release = next;
    this.releaseHead = newHead;
    return resolved(portOk({ status: "applied", head: newHead }));
  }
}

function nextHead(n: number): GitSha {
  const hex = `00000000000000000000000000000000000000${
    n.toString(16).padStart(2, "0")
  }`.slice(0, 40);
  return hex as GitSha;
}

const MINIMAL_WORK: WorkRecordV1 = {
  version: "v1",
  kind: "work",
  repository: {
    owner: "ubiquity",
    name: "ai.ubq.fi",
    installationId: 1,
  },
  id: workId("i:1"),
  source: { kind: "issue", id: "1", revision: SHA },
  related: { incidentId: null, issueNumber: 1 },
  fingerprint: null,
  failingRevision: null,
  sourceSnapshotDigest: null,
  classification: { severity: "P3", priority: null },
  urgency: {
    activeProduction: false,
    reproducible5xx: false,
    severeSecurityOrDataLoss: false,
  },
  dependencies: [],
  controller: { sha: SHA },
  target: { base: SHA, branch: null, checkpoint: null, head: null, pr: null },
  nextStep: "work",
  wait: null,
  blocker: null,
  counters: { attempts: 0, retries: 0, reviewRounds: 0 },
  evidence: [],
  intent: null,
  firstSeenAt: null,
  createdAt: 1786000000000,
  updatedAt: 1786000000000,
};

Deno.test("StateStore: branch creation applies, stale expected head conflicts", async () => {
  const store = new FakeStateStore();
  const first = parseWorkRecordV1({ ...MINIMAL_WORK });
  const snapshotA: RepairStateSnapshotV1 = {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: 1786000000000,
    incidents: [],
    evidence: [],
    work: [first],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
  };
  const created = await store.writeRepair(snapshotA, null);
  assert.equal(created.ok, true);
  if (created.ok) assert.equal(created.value.status, "applied");

  // Blinded write with a stale expected head must conflict, not overwrite.
  const stale = await store.writeRepair(snapshotA, SHA);
  assert.equal(stale.ok, true);
  if (stale.ok) assert.equal(stale.value.status, "conflict");

  // The store still holds the originally applied snapshot.
  const read = await store.readRepair();
  assert.equal(read.ok, true);
  if (read.ok && read.value.status === "found") {
    assert.equal(read.value.snapshot.work[0]?.id, "i:1");
  } else assert.fail("expected a found snapshot");
});

Deno.test("StateStore: ambiguous network outcome is distinct from conflict", async () => {
  const store = new FakeStateStore();
  const snapshot: RepairStateSnapshotV1 = {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: 1786000000000,
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
  };
  store.ambiguousRepairNext = true;
  const ambiguous = await store.writeRepair(snapshot, null);
  assert.equal(ambiguous.ok, true);
  if (ambiguous.ok) {
    assert.equal(ambiguous.value.status, "ambiguous");
    // A failed/conflicted write and an ambiguous one are distinct kinds.
    assert.ok(!("head" in ambiguous.value));
  }
  const tryAgain = await store.writeRepair(snapshot, null);
  assert.equal(tryAgain.ok, true);
  if (tryAgain.ok) assert.equal(tryAgain.value.status, "applied");
});

Deno.test("StateStore: repair and release branches are strictly separate", async () => {
  const store = new FakeStateStore();
  const repairSnapshot: RepairStateSnapshotV1 = {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: 1786000000000,
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
  };
  const releaseSnapshot: ReleaseStateSnapshotV1 = {
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: 1786000000000,
    releases: [],
  };
  await store.writeRepair(repairSnapshot, null);
  await store.writeRelease(releaseSnapshot, null);
  assert.equal(store.repairWrites, 1);
  assert.equal(store.releaseWrites, 1);
  const repair = await store.readRepair();
  assert.ok(repair.ok && repair.value.status === "found");
  if (repair.ok && repair.value.status === "found") {
    assert.ok(!("releases" in repair.value.snapshot));
    // Operational external ref identity is kept separate from the head.
    assert.equal(repair.value.ref, "refs/heads/sentinel-state/repair");
  }
  const release = await store.readRelease();
  assert.ok(release.ok && release.value.status === "found");
  if (release.ok && release.value.status === "found") {
    assert.ok(!("work" in release.value.snapshot));
    assert.equal(release.value.ref, "refs/heads/sentinel-state/release");
  }
});

Deno.test("state capabilities: read-only view and per-writer capabilities are narrow", () => {
  const store = new FakeStateStore();
  const readOnly: StateReadView = store;
  const repairWriter: RepairStateWriter = store;
  const releaseWriter: ReleaseStateWriter = store;
  assert.ok(readOnly && repairWriter && releaseWriter);
  // A release writer must never expose repair write capability.
  // @ts-expect-error release-only writer has no writeRepair
  releaseWriter.writeRepair;
  // @ts-expect-error repair-only writer has no writeRelease
  repairWriter.writeRelease;
});

Deno.test("Clock: fake time is deterministic and monotonic", () => {
  const clock = new FakeClock(1786000000000);
  assert.equal(clock.now(), 1786000000000);
  clock.advance(30_000);
  assert.equal(clock.now(), 1786000030000);
  const system = new SystemClock();
  const before = Date.now();
  const sampled = system.now();
  assert.ok(sampled >= before && sampled <= before + 5_000);
});

Deno.test("Replay port: unavailable is not an empty/success result", async () => {
  const unavailable = new RecordingReplayPort(
    portError("unavailable", "sandbox could not be provisioned"),
  );
  const request: ReplayRunRequestV1 = {
    taskId: workId("i:1"),
    repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
    revision: SHA,
    commandId: commandId("test_ci"),
    fixtureRef: "fixture://f.json",
    fixtureDigest: digest("aa".repeat(32)),
    testIds: ["t"],
    outputLimitBytes: 1024,
  };
  const result = await unavailable.runReplay(request);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "unavailable");

  const passed = new RecordingReplayPort(
    portOk({
      outcome: "passed",
      exitCode: 0,
      output: {
        stdoutDigest: digest("bb".repeat(32)),
        stderrDigest: null,
        truncated: false,
      },
      failure: null,
      limitations: [],
      startedAt: 1786000000000,
      endedAt: 1786000001000,
    }),
  );
  const okResult = await passed.runReplay(request);
  assert.equal(okResult.ok, true);
  if (okResult.ok) assert.equal(okResult.value.outcome, "passed");
  assert.equal(unavailable.requests.length, 1);
  assert.equal(passed.requests.length, 1);
});

Deno.test("GitHub merge result kinds are discriminated values, not booleans", () => {
  const merged: MergeOutcomeV1 = {
    outcome: "merged",
    head: SHA,
    mergeSha: SHA,
  };
  const blocked: MergeOutcomeV1 = {
    outcome: "blocked",
    reason: "checks_pending",
    head: SHA,
  };
  const baseMismatch: MergeOutcomeV1 = {
    outcome: "blocked",
    reason: "base_mismatch",
    head: SHA,
  };
  const reviewRequired: MergeOutcomeV1 = {
    outcome: "blocked",
    reason: "review_required",
    head: SHA,
  };
  const ambiguous: MergeOutcomeV1 = {
    outcome: "ambiguous",
    head: null,
    mergeSha: null,
  };
  assert.equal(merged.outcome, "merged");
  assert.equal(blocked.outcome, "blocked");
  assert.equal(ambiguous.outcome, "ambiguous");
  if (blocked.outcome === "blocked") {
    assert.equal(blocked.reason, "checks_pending");
  }
  if (baseMismatch.outcome === "blocked") {
    assert.equal(baseMismatch.reason, "base_mismatch");
  }
  if (reviewRequired.outcome === "blocked") {
    assert.equal(reviewRequired.reason, "review_required");
  }
});

Deno.test("portOk/portError helpers produce the documented shapes", () => {
  assert.deepEqual(portError("rate_limited", "backoff"), {
    ok: false,
    error: { kind: "rate_limited", detail: "backoff" },
  });
  assert.deepEqual(portOk(7), { ok: true, value: 7 });
});

// Compile-time shape guard: a minimal DenoReleasePort fake type-checks with
// exact deployment identities and the SHA+buildTransactionId+revisionId
// lookup (the exact revision id comes from the trusted receipt resolver).
const _releaseFake: DenoReleasePort = {
  findBuiltCandidate(
    _projectId: string,
    _revision: string,
    _buildTransactionId: string,
    _revisionId: string,
  ) {
    return resolved(portOk({ status: "none" }));
  },
  readCurrentDeployment() {
    return resolved(portOk({
      projectId: "p",
      identity: null,
      domain: null,
      status: "unknown",
      updatedAt: null,
    }));
  },
  promote() {
    return resolved(
      portOk({
        outcome: "ambiguous",
        statusCode: null,
        detail: "response lost",
      }),
    );
  },
  sampleHealth() {
    return resolved(portOk({
      at: 1786000000000,
      status: "unreachable",
      httpStatus: null,
      bodyMarkerPresent: null,
      headersMatch: null,
      identity: null,
      domain: null,
    }));
  },
  sampleMetrics() {
    return resolved(portOk({
      identity: {
        gitSha: SHA,
        revisionId: "dep-0001",
      },
      windowStart: 1786000070000,
      windowEnd: 1786000100000,
      sampledAt: 1786000100000,
      domain: null,
      requestCount: null,
      fiveXxCount: null,
      timeoutCount: null,
      streamFailureCount: null,
      upstreamWideFault: null,
      coverage: { status: "complete" },
    }));
  },
};

// Compile-time shape guard: a minimal GitHubPort fake type-checks with the
// deterministic-head PR lookup and identity-bound review submission.
const _githubFake: GitHubPort = {
  listOpenIssues() {
    return resolved(portOk([]));
  },
  readIssue() {
    return resolved(portOk(null));
  },
  findPullRequestByHeadRef() {
    return resolved(portOk(null));
  },
  readPullRequest() {
    return resolved(portOk(null));
  },
  readChecks() {
    return resolved(portOk({ head: SHA, checks: [] }));
  },
  readProtections() {
    return resolved(portOk({
      branch: "development",
      protected: false,
      requiredStatusChecks: [],
      requiredApprovingReviewCount: 0,
      requireBranchUpToDate: false,
      enforceAdmins: false,
    }));
  },
  readRef() {
    return resolved(portOk(null));
  },
  pushHead() {
    return resolved(portOk("applied"));
  },
  createPullRequest() {
    return resolved(portOk({ outcome: "ambiguous", number: null, head: null }));
  },
  requestReview() {
    return resolved(
      portOk({
        outcome: "applied",
        requestId: "req-1",
        requestedAt: 1786000000000,
      }),
    );
  },
  observeReview() {
    return resolved(portOk({
      status: "pending",
      requestId: "req-1",
      reviewer: null,
      resultId: null,
      completedAt: null,
      observedHead: null,
      observedBase: null,
      findings: [],
      summary: null,
      receivedAt: 1786000000000,
    }));
  },
  mergePullRequest() {
    return resolved(
      portOk({ outcome: "blocked", reason: "protection_required", head: SHA }),
    );
  },
  closeIssue() {
    return resolved(portOk("already_closed"));
  },
};

Deno.test("fake ports are callable and return documented kinds", async () => {
  assert.deepEqual(await _githubFake.listOpenIssues(), portOk([]));
  const check = await _githubFake.readChecks(SHA);
  assert.ok(check.ok && check.value.checks.length === 0); // empty checks is a real value
  const merge = await _githubFake.mergePullRequest(mergeRequest());
  assert.ok(merge.ok && merge.value.outcome === "blocked");
  const dep = await _releaseFake.readCurrentDeployment("p");
  assert.ok(dep.ok && dep.value.status === "unknown");
});

// ---------------------------------------------------------------------------
// Minimal fake-port loop skeleton (plan §8, Wave A): the shape of one polling
// pass over the frozen ports, driven by the existing canned fakes. It records
// the calls it makes, runs two deterministic ticking passes, and exits at an
// unchanged review wait. This is a contract smoke skeleton ONLY — it holds no
// selection logic, no budget admission, no state write and no model port; the
// real selection/loop state machine belongs to m04 and the release state
// machine to m05 (see docs/contracts.md §10 for entrypoint ownership).
// ---------------------------------------------------------------------------

interface SmokeLoopDepsV1 {
  /** Read-only repair snapshot access; a writer is never handed to the loop. */
  repair: Pick<StateReadView, "readRepair">;
  /** Canned authoritative source read + review observation (m01 fake). */
  github: Pick<GitHubPort, "readIssue" | "observeReview">;
  replay: ReplayPort;
  clock: Clock;
}

interface SmokePollV1 {
  /** Ordered record of every port call made during this pass. */
  trace: string[];
  /** True when the observed review is still pending: the wait stays unchanged. */
  waitUnchanged: boolean;
}

/** One scripted poll: repair read, source read, replay, review observation. */
async function smokePoll(
  deps: SmokeLoopDepsV1,
  tick: number,
  waiting: WorkRecordV1,
): Promise<SmokePollV1> {
  const trace: string[] = [];
  const at = deps.clock.now();
  const read = await deps.repair.readRepair();
  trace.push(
    `tick:${tick}@${at}:repair-read:${read.ok ? "found" : "unavailable"}`,
  );
  const source = await deps.github.readIssue(waiting.related.issueNumber ?? 1);
  trace.push(`tick:${tick}@${at}:source-read:${source.ok ? "ok" : "error"}`);
  const replayResult = await deps.replay.runReplay({
    taskId: waiting.id,
    repository: waiting.repository,
    revision: waiting.failingRevision ?? waiting.target.base,
    commandId: commandId("test_ci"),
    fixtureRef: "fixture://sentinel/synth-0001.json",
    fixtureDigest: digest("cc".repeat(32)),
    testIds: ["test_ci"],
    outputLimitBytes: 4096,
  });
  trace.push(
    `tick:${tick}@${at}:replay:${
      replayResult.ok ? replayResult.value.outcome : "error"
    }`,
  );
  const observed = await deps.github.observeReview({
    operationKey: `review:${waiting.id}`,
    prNumber: waiting.target.pr ?? 1,
    head: waiting.target.head ?? waiting.failingRevision ?? SHA,
  });
  trace.push(
    `tick:${tick}@${at}:review-observe:${
      observed.ok ? observed.value.status : "unavailable"
    }`,
  );
  return {
    trace,
    waitUnchanged: observed.ok && observed.value.status === "pending",
  };
}

const T0 = 1786000000000;

Deno.test(
  "fake-port loop skeleton: two ticks exit at an unchanged review wait, no model or sleep",
  async () => {
    const clock = new FakeClock(T0);
    const store = new FakeStateStore();
    const replay = new RecordingReplayPort(
      portOk({
        outcome: "passed",
        exitCode: 0,
        output: {
          stdoutDigest: digest("bb".repeat(32)),
          stderrDigest: null,
          truncated: false,
        },
        failure: null,
        limitations: [],
        startedAt: T0,
        endedAt: T0 + 1000,
      }),
    );

    // One work item sitting in the review wait: the source/replay evidence is
    // done; the wait reason is review_pending until T0 + 1h.
    const waiting: WorkRecordV1 = {
      ...MINIMAL_WORK,
      id: workId("i:2"),
      nextStep: "review",
      wait: { reason: "review_pending", since: T0, until: T0 + 3_600_000 },
    };
    const repairSnapshot: RepairStateSnapshotV1 = {
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0,
      incidents: [],
      evidence: [],
      work: [waiting],
      reservations: [],
      reviews: [],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
    };
    await store.writeRepair(repairSnapshot, null);
    const releaseSnapshot: ReleaseStateSnapshotV1 = {
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0,
      releases: [],
    };
    await store.writeRelease(releaseSnapshot, null);
    assert.equal(store.repairWrites, 1);
    assert.equal(store.releaseWrites, 1);

    // Capability separation at the smoke boundary: the loop reads the repair
    // snapshot only, and the release read stays an independent capability.
    const repairRead: Pick<StateReadView, "readRepair"> = store;
    const releaseRead: Pick<StateReadView, "readRelease"> = store;
    // @ts-expect-error a repair read capability never carries release reads
    repairRead.readRelease;
    // @ts-expect-error a release read capability never carries repair reads
    releaseRead.readRepair;
    const deps: SmokeLoopDepsV1 = {
      repair: repairRead,
      github: _githubFake,
      replay,
      clock,
    };
    // @ts-expect-error the smoke loop has no model port (admission is never in scope here)
    deps.runModel;
    // @ts-expect-error the smoke loop has no state write capability
    deps.repair.writeRepair;

    // Two deterministic polling ticks; the canned review stays pending, so
    // both pass ends at the same wait and the loop advances nothing.
    const trace: string[] = [];
    const exits: string[] = [];
    for (let tick = 1; tick <= 2; tick++) {
      const poll = await smokePoll(deps, tick, waiting);
      trace.push(...poll.trace);
      exits.push(
        `tick:${tick}:${poll.waitUnchanged ? "unchanged" : "changed"}`,
      );
      // Independent release read: its own branch, never repair records.
      const release = await releaseRead.readRelease();
      assert.ok(release.ok && release.value.status === "found");
      if (release.ok && release.value.status === "found") {
        assert.deepEqual(release.value.snapshot.releases, []);
        assert.ok(!("work" in release.value.snapshot));
      }
      clock.advance(60_000);
    }

    assert.deepEqual(exits, ["tick:1:unchanged", "tick:2:unchanged"]);
    assert.deepEqual(trace, [
      `tick:1@${T0}:repair-read:found`,
      `tick:1@${T0}:source-read:ok`,
      `tick:1@${T0}:replay:passed`,
      `tick:1@${T0}:review-observe:pending`,
      `tick:2@${T0 + 60_000}:repair-read:found`,
      `tick:2@${T0 + 60_000}:source-read:ok`,
      `tick:2@${T0 + 60_000}:replay:passed`,
      `tick:2@${T0 + 60_000}:review-observe:pending`,
    ]);
    // Both ticks issued one deterministic replay for the same identity.
    assert.equal(replay.requests.length, 2);
    assert.deepEqual(replay.requests[1], replay.requests[0]);
    // The loop wrote nothing: only the two seed writes happened.
    assert.equal(store.repairWrites, 1);
    assert.equal(store.releaseWrites, 1);
    // The wait and lifecycle are byte-identical after the loop; the clock moved
    // only by explicit ticks (no real sleeping, no model call).
    const finalRead = await store.readRepair();
    assert.ok(finalRead.ok && finalRead.value.status === "found");
    if (finalRead.ok && finalRead.value.status === "found") {
      assert.equal(finalRead.value.snapshot.work[0]?.nextStep, "review");
      assert.deepEqual(finalRead.value.snapshot.work[0]?.wait, waiting.wait);
    }
    assert.equal(clock.now(), T0 + 120_000);
  },
);

Deno.test(
  "release read capability is independent of repair state across the same ticks",
  async () => {
    const store = new FakeStateStore();
    await store.writeRepair({
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0,
      incidents: [],
      evidence: [],
      work: [MINIMAL_WORK],
      reservations: [],
      reviews: [],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
    }, null);
    await store.writeRelease({
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0,
      releases: [],
    }, null);

    const releaseRead: Pick<StateReadView, "readRelease"> = store;
    // @ts-expect-error release reads never expose the repair snapshot
    releaseRead.readRepair;
    const release = await releaseRead.readRelease();
    assert.ok(release.ok && release.value.status === "found");
    if (release.ok && release.value.status === "found") {
      assert.ok(!("work" in release.value.snapshot));
      assert.equal(release.value.snapshot.sequence, 1);
    }
    // Repair branch still holds its own records, untouched by the release read.
    const repair = await store.readRepair();
    assert.ok(repair.ok && repair.value.status === "found");
    if (repair.ok && repair.value.status === "found") {
      assert.ok(!("releases" in repair.value.snapshot));
      assert.equal(repair.value.snapshot.work.length, 1);
    }
    assert.equal(store.releaseWrites, 1);
  },
);

// ---------------------------------------------------------------------------
// Proposed gateway producer index mapping (docs/contracts.md §11): the
// synthetic wire fixture maps into the frozen IncidentSummaryV1 records. The
// conversion is test-only; m02 owns the real production adapter. No new shared
// port interface is added, and this fixture proves producer/consumer schema
// mapping only — never live discovery.
// ---------------------------------------------------------------------------

/** Exact wire keys; unknown keys fail closed at the mapping boundary. */
const GATEWAY_ROW_KEYS = [
  "incident_id",
  "fingerprint",
  "severity",
  "first_seen_at_ms",
  "last_seen_at_ms",
  "count",
  "failing_revision",
  "error_type",
  "context",
  "provenance",
  "evidence_ref",
  "evidence_expires_at_ms",
] as const;
const GATEWAY_CONTEXT_KEYS = ["message", "location", "sample"] as const;
const GATEWAY_PROVENANCE_KEYS = [
  "endpoint",
  "captured_at_ms",
  "captured_by",
] as const;
const GATEWAY_EVIDENCE_REF_KEYS = ["ref", "digest"] as const;
/**
 * The target's existing incident identity format: `src/sentinel_incident_outbox.ts`
 * `INCIDENT_ID` at the recorded setup snapshot
 * (`aafb7ee0598699bb7fb8a72ea133693ed64462da`). The frozen generic incident
 * parser accepts bounded text, so this mapping boundary pins the exact format
 * the gateway replay export actually requires; rows outside it fail closed.
 */
const GATEWAY_INCIDENT_ID =
  /^provider-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Exact wire row shape of the proposed gateway index page. */
interface GatewayIndexRowV1 {
  incident_id: string;
  fingerprint: string;
  severity: string;
  first_seen_at_ms: number;
  last_seen_at_ms: number;
  count: number;
  failing_revision: string | null;
  error_type: string;
  context: { message: string; location: string | null; sample: string[] };
  provenance: {
    endpoint: string;
    captured_at_ms: number;
    captured_by: string | null;
  };
  evidence_ref: { ref: string; digest: string } | null;
  evidence_expires_at_ms: number | null;
}

/** Test-only wire row → IncidentSummaryV1 conversion (m02 owns the adapter). */
function gatewayRowToSummary(
  input: unknown,
  repository: RepositoryIdentityV1,
  coverage: IncidentCoverageV1,
): IncidentSummaryV1 {
  const row = expectRecord(input, "$");
  expectExactKeys(row, GATEWAY_ROW_KEYS, "$");
  const context = expectRecord(row.context, "$.context");
  expectExactKeys(context, GATEWAY_CONTEXT_KEYS, "$.context");
  const provenance = expectRecord(row.provenance, "$.provenance");
  expectExactKeys(provenance, GATEWAY_PROVENANCE_KEYS, "$.provenance");
  let evidenceRef: { ref: string; digest: string | null } | null = null;
  if (row.evidence_ref !== null) {
    const evidence = expectRecord(row.evidence_ref, "$.evidence_ref");
    expectExactKeys(evidence, GATEWAY_EVIDENCE_REF_KEYS, "$.evidence_ref");
    evidenceRef = {
      ref: evidence.ref as string,
      digest: evidence.digest as string | null,
    };
  }
  // Repository identity and provenance.source are trusted adapter
  // configuration/constants, never wire fields; evidence expiry is consumed by
  // the evidence stage (artifacts[].expiresAt), not carried on the summary.
  const summary: Record<string, unknown> = {
    version: "v1",
    kind: "incident_summary",
    repository,
    id: row.incident_id,
    fingerprint: row.fingerprint,
    severity: row.severity,
    firstSeenAt: row.first_seen_at_ms,
    lastSeenAt: row.last_seen_at_ms,
    count: row.count,
    failingRevision: row.failing_revision,
    errorType: row.error_type,
    context: {
      message: context.message,
      location: context.location,
      sample: context.sample,
    },
    provenance: {
      source: "gateway",
      endpoint: provenance.endpoint,
      capturedAt: provenance.captured_at_ms,
      capturedBy: provenance.captured_by,
    },
    coverage,
    evidenceRef,
  };
  // The frozen parser is the authority: every value is re-validated here.
  return parseIncidentSummaryV1(summary);
}

Deno.test("gateway index fixture maps into frozen IncidentSummaryV1 records", async () => {
  const page = JSON.parse(
    await Deno.readTextFile(
      new URL("../fixtures/contracts/gateway-index-v1.json", import.meta.url),
    ),
  ) as {
    data: GatewayIndexRowV1[];
    cursor: string | null;
    coverage: IncidentCoverageV1;
  };
  assert.equal(page.coverage.status, "complete");
  assert.equal(page.cursor, null);
  // Every fixture id must already satisfy the target's existing incident id
  // format, and the old synthetic form is rejected: the generic incident
  // parser is permissive, so this pins the format the replay export accepts.
  for (const row of page.data) {
    assert.ok(
      GATEWAY_INCIDENT_ID.test(row.incident_id),
      `fixture incident_id ${row.incident_id} is not in the target provider-UUID format`,
    );
  }
  assert.equal(GATEWAY_INCIDENT_ID.test("sentinel-synth-0001"), false);
  const repository: RepositoryIdentityV1 = {
    owner: "ubiquity",
    name: "ai.ubq.fi",
    installationId: 12345,
  };
  const summaries = page.data.map((row) =>
    gatewayRowToSummary(row, repository, page.coverage)
  );
  assert.equal(summaries.length, 2);

  const first = summaries[0];
  assert.equal(first.id, "provider-00000000-0000-4000-8000-000000000001");
  assert.equal(first.fingerprint, page.data[0].fingerprint);
  assert.equal(first.severity, "P1");
  assert.equal(first.count, 7);
  assert.equal(first.failingRevision, page.data[0].failing_revision);
  assert.equal(first.provenance.source, "gateway");
  assert.equal(first.provenance.endpoint, "https://ai.ubq.fi");
  assert.equal(
    first.evidenceRef?.ref,
    "artifact://sentinel/synth-0001/capture-1.pgp",
  );
  assert.equal(
    first.evidenceRef?.digest,
    page.data[0].evidence_ref?.digest ?? null,
  );
  // Page coverage belongs to each mapped summary.
  assert.deepEqual(first.coverage, { status: "complete" });

  const second = summaries[1];
  // Missing failing revision / evidence blocks later replay stages, never
  // discovery: the row still maps, with explicit nulls (never fabricated).
  assert.equal(second.failingRevision, null);
  assert.equal(second.evidenceRef, null);
  assert.equal(second.count, 1);

  // Fail closed: unknown row keys and malformed values are rejected at the
  // mapping boundary before any summary can be produced.
  assert.throws(() =>
    gatewayRowToSummary(
      { ...(page.data[0] as object), claim_url: "https://not-a-row-key" },
      repository,
      page.coverage,
    )
  );
  assert.throws(
    () =>
      gatewayRowToSummary(
        { ...(page.data[0] as object), count: 0 },
        repository,
        page.coverage,
      ),
    (error: unknown) => error instanceof RecordParseError,
  );
});
