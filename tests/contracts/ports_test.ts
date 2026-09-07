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
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";

const SHA: GitSha = "aafb7ee0598699bb7fb8a72ea133693ed64462da" as GitSha;

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
});

Deno.test("portOk/portError helpers produce the documented shapes", () => {
  assert.deepEqual(portError("rate_limited", "backoff"), {
    ok: false,
    error: { kind: "rate_limited", detail: "backoff" },
  });
  assert.deepEqual(portOk(7), { ok: true, value: 7 });
});

// Compile-time shape guard: a minimal DenoReleasePort fake type-checks with
// exact deployment identities and the SHA+buildTransactionId lookup.
const _releaseFake: DenoReleasePort = {
  findBuiltCandidate() {
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
      sampledAt: 1786000000000,
      domain: null,
      requestCount: null,
      fiveXxCount: null,
      timeoutCount: null,
      streamFailureCount: null,
      upstreamWideFault: null,
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
  const merge = await _githubFake.mergePullRequest({
    pullRequestNumber: 1,
    expectedHead: SHA,
  });
  assert.ok(merge.ok && merge.value.outcome === "blocked");
  const dep = await _releaseFake.readCurrentDeployment("p");
  assert.ok(dep.ok && dep.value.status === "unknown");
});
