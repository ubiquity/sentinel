/** Queue custody discovered after scheduling must stop actual runtime consumers. */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { GitHubQueueDeliveryClient } from "../../src/github/client-queue-delivery.ts";
import { createNativeQueueGuard } from "../../src/github/native-queue-guard.ts";
import { createQueueDeliveryReader } from "../../src/github/queue-delivery-reader.ts";
import { CHECK_POLL_MS } from "../../src/repair/loop-bounds.ts";
import { FakeAuthProvider, FakeCooldownGate } from "../github/helpers.ts";
import { POLICY } from "../host/merge-queue-proof-fixtures.ts";
import {
  releaseRequest,
  reservation,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type {
  IncompleteOperationV1,
  WorkRecordV1,
} from "../../src/contracts/work-record.ts";
import type {
  NativeQueueGuardV1,
  NativeQueueOperation,
  QueueGuardReason,
} from "../../src/github/native-queue-guard.ts";
import { conflictMarker } from "../../src/repair/conflict-resolution.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import {
  baseRefreshIntentKey,
  implementationIntentKey,
  mergeIntentKey,
} from "../../src/repair/keys.ts";
import {
  ensureBaseRefreshIntent,
  executeBaseRefreshIntent,
} from "../../src/repair/loop-base-refresh.ts";
import { retryClosure } from "../../src/repair/loop-closure.ts";
import {
  confirmConflictResolution,
  handleConflictResolutionReceipt,
} from "../../src/repair/loop-conflict-resolution.ts";
import { releaseReviewQuotaWait } from "../../src/repair/loop-cycle.ts";
import { prepareImplementationStart } from "../../src/repair/loop-implementation.ts";
import {
  executeMerge,
  handleMergeOutcome,
} from "../../src/repair/loop-merge.ts";
import {
  executePublishStep,
  reconcileOrphanPublication,
} from "../../src/repair/loop-publication.ts";
import {
  acceptRelease,
  resumeDeferredRelease,
} from "../../src/repair/loop-release.ts";
import { applyObservedReview } from "../../src/repair/loop-review-result.ts";
import { requestReviewFor } from "../../src/repair/loop-review-request.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import {
  executeDeliveryStep,
  executeImplementationStep,
  executeWorkStep,
} from "../../src/repair/loop-work.ts";
import { r80Available, withR80Parsers } from "../host/r80-contracts.ts";
import { inactiveNativeQueueFixture } from "../github/native-queue-fixture.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";
import {
  exactOpenPr,
  preservedIssueWork,
  PRODUCING_RESERVATION,
} from "./loop-candidate-fixtures.ts";
import {
  acceptedObservation,
  completedReceipt,
} from "./loop-review-fixtures.ts";
import { seededSnapshot, SHA4 } from "./loop-rig.ts";
import { releaseWithoutVps } from "./release-deferred-fixtures.ts";

const CHARGE = "1".repeat(64);
const DAY = 24 * 60 * 60_000;
const available = await r80Available();

function baseRecord(overrides: Partial<WorkRecordV1> = {}): WorkRecordV1 {
  return workRecord("issue-1", {
    ...preservedIssueWork("issue-1", SHA2),
    ...overrides,
  });
}
function intent(
  kind: IncompleteOperationV1["kind"],
  record: WorkRecordV1,
): IncompleteOperationV1 {
  return {
    kind,
    key: kind === "implementation"
      ? implementationIntentKey(CHARGE)
      : kind === "base_refresh"
      ? baseRefreshIntentKey(7, SHA2, SHA3)
      : kind === "merge"
      ? mergeIntentKey(7, SHA2)
      : `${kind}:retained-operation`,
    startedAt: T0,
    branch: record.target.branch,
    expectedHead: SHA2,
    observedBase: kind === "base_refresh" ? SHA3 : SHA1,
    pr: kind === "push" ? null : 7,
    requestId: kind === "implementation" ? CHARGE : null,
    resultId: null,
    ...(kind === "implementation" || kind === "base_refresh"
      ? { failure: conflictMarker(SHA3, T0) }
      : {}),
  };
}
function harness(
  record: WorkRecordV1,
  reason: QueueGuardReason | "allow" | "missing" = "member",
) {
  let decision = reason;
  const inspections: (NativeQueueOperation | "delivery")[] = [];
  const inactive = inactiveNativeQueueFixture();
  const nativeQueue: NativeQueueGuardV1 = {
    inspect: (input) => {
      inspections.push(input.operation);
      return decision === "allow" ? inactive.inspect(input) : Promise.resolve({
        status: "hold",
        reason: decision === "missing" ? "capability_missing" : decision,
        pull: null,
      });
    },
    inspectEffect: (input) => inactive.inspectEffect(input),
    proveDelivery: (input) => {
      inspections.push("delivery");
      return decision === "allow"
        ? inactive.proveDelivery(input)
        : Promise.resolve({
          status: "unavailable",
          reason: "queue_evidence_unavailable",
        });
    },
  };
  const state = new MemoryState();
  const clock = new FakeClock(T0 + 5000);
  const github = new FakeGithub({
    nativeQueue: reason === "missing" ? null : nativeQueue,
    baseSha: SHA3,
    branchRefSha: SHA2,
  });
  const model = new FakeModel({ head: SHA4, changedPaths: ["src/fix.ts"] });
  const replay = new FakeReplay();
  const configs = repairConfigs({
    sessionBound: {
      maxDurationMs: 240_000,
      maxOutputChars: Number.MAX_SAFE_INTEGER,
    },
  });
  const receipt = completedReceipt(7, SHA2, SHA1);
  const request = releaseRequest("release-exact", {
    revision: SHA4,
    source: {
      pullRequest: 7,
      head: SHA2,
      base: SHA1,
      reviewRequestId: receipt.requestId,
      reviewReceiptId: receipt.id,
    },
  });
  state.repair = seededSnapshot([record], {
    reservations: [
      reservation(PRODUCING_RESERVATION, {
        taskId: record.id,
        outcome: "submitted",
        settledAt: T0 + 1000,
      }),
      reservation(CHARGE, {
        taskId: record.id,
        attempt: 2,
        outcome: "reserved",
      }),
    ],
    reviews: [receipt],
  });
  state.repairHead = SHA1;
  const deps: RepairCycleDepsV1 = {
    clock,
    state,
    configs,
    controllerSha: SHA1,
    github,
    model,
    replay,
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    budget: new RollingStartBudget({ clock, state, configs }),
    incidents: new FakeIncidents({ summaries: [] }),
  };
  const context: LoopContextV1 = {
    snapshot: state.repair,
    head: SHA1,
    executionBaseline: record,
    bounds: {
      runDeadline: clock.now() + 60 * 60_000,
      modelCutoff: clock.now() + 60 * 60_000,
    },
  };
  return {
    deps,
    state,
    clock,
    github,
    model,
    replay,
    context,
    record,
    receipt,
    request,
    inspections,
    setDecision: (next: typeof decision) => {
      decision = next;
    },
  };
}
type Rig = ReturnType<typeof harness>;
function transientRuleGuard(rig: Rig, proofActivated = false) {
  const calls = { rules: 0, queuePulls: 0, http: 0 };
  const client = new GitHubQueueDeliveryClient({
    repository: rig.record.repository,
    clock: rig.clock,
    apiBaseUrl: "https://api.github.com",
    auth: new FakeAuthProvider(),
    cooldownGate: new FakeCooldownGate(),
    http: () => {
      calls.http++;
      return Promise.reject(
        new Error("No queue HTTP is authorized by this fixture"),
      );
    },
  }, null);
  client.readBranchRules = (branch) => {
    assert.equal(branch, "development");
    calls.rules++;
    return Promise.resolve(
      calls.rules === 1
        ? portError("unavailable", "synthetic rule observation failure")
        : portOk([]),
    );
  };
  client.readQueuePull = () => {
    calls.queuePulls++;
    return Promise.resolve({ status: "unavailable", reason: "permission" });
  };
  const reader = createQueueDeliveryReader({
    repository: rig.record.repository,
    clock: rig.clock,
    client,
    policy: POLICY,
  });
  rig.github.nativeQueue = createNativeQueueGuard({
    repository: rig.record.repository,
    clock: rig.clock,
    state: rig.state,
    client,
    reader,
    policy: POLICY,
    mode: "off",
    proofActivated,
  });
  return calls;
}

function assertHeld(
  rig: Rig,
  before: RepairStateSnapshotV1,
  allowReads = false,
  transient = false,
) {
  const after = rig.state.repair!;
  const row = after.work[0];
  const now = rig.clock.now();
  const unavailableSince = before.work[0].wait?.reason === "unavailable"
    ? before.work[0].wait.since
    : now;
  assert.deepEqual(row, {
    ...before.work[0],
    wait: transient
      ? {
        reason: "unavailable",
        since: unavailableSince,
        until: now + CHECK_POLL_MS,
      }
      : { reason: "backoff", since: now, until: null },
    updatedAt: now,
  });
  for (
    const key of [
      "reservations",
      "reviews",
      "releaseRequests",
      "replays",
      "attemptMemory",
    ] as const
  ) {
    assert.deepEqual(after[key], before[key], `${key} must stay intact`);
  }
  if (allowReads) {
    assert.ok(rig.github.calls.every((call) => call.startsWith("read")));
  } else assert.deepEqual(rig.github.calls, []);
  assert.deepEqual(rig.github.pushes, []);
  assert.deepEqual(rig.github.preservationRequests, []);
  assert.equal(rig.model.requests.length, 0);
  assert.equal(rig.replay.requests.length, 0);
}

const boundaries: {
  name: string;
  record: () => WorkRecordV1;
  release?: boolean;
  delivery?: boolean;
  run: (r: Rig) => Promise<unknown>;
}[] = [
  {
    name: "direct implementation admission",
    record: () => baseRecord(),
    run: (r) =>
      prepareImplementationStart(
        r.deps,
        r.context,
        r.record,
        r.deps.configs[0],
      ),
  },
  {
    name: "direct review admission",
    record: () => baseRecord(),
    run: (r) => requestReviewFor(r.deps, r.context, r.record, 7),
  },
  {
    name: "publish",
    record: () => baseRecord({ intent: intent("push", baseRecord()) }),
    run: (r) =>
      executePublishStep(r.deps, r.context, r.record, r.deps.configs[0]),
  },
  {
    name: "plan refresh",
    record: () => baseRecord(),
    run: (r) => ensureBaseRefreshIntent(r.deps, r.context, r.record),
  },
  {
    name: "execute refresh",
    record: () => baseRecord({ intent: intent("base_refresh", baseRecord()) }),
    run: (r) => executeBaseRefreshIntent(r.deps, r.context, r.record),
  },
  {
    name: "confirm conflict",
    record: () => baseRecord({ intent: intent("base_refresh", baseRecord()) }),
    run: (r) => confirmConflictResolution(r.deps, r.context, r.record),
  },
  {
    name: "consume conflict receipt",
    record: () =>
      baseRecord({ intent: intent("implementation", baseRecord()) }),
    run: (r) =>
      handleConflictResolutionReceipt(r.deps, r.context, r.record, CHARGE, {
        head: SHA4,
        changedPaths: ["src/fix.ts"],
      }, r.deps.configs[0]),
  },
  {
    name: "consume review",
    record: () => baseRecord({ nextStep: "review" }),
    run: (r) =>
      applyObservedReview(
        r.deps,
        r.context,
        r.record,
        acceptedObservation(
          SHA2,
          r.receipt.taskAcceptance ?? null,
          r.clock.now(),
        ),
        "review:original",
      ),
  },
  {
    name: "direct merge",
    record: () => baseRecord({ nextStep: "delivery" }),
    run: (r) => executeMerge(r.deps, r.context, r.record),
  },
  {
    name: "book merged response",
    delivery: true,
    record: () =>
      baseRecord({
        nextStep: "delivery",
        intent: intent("merge", baseRecord()),
      }),
    run: (r) =>
      handleMergeOutcome(r.deps, r.context, r.record, {
        outcome: "merged",
        head: SHA2,
        mergeSha: SHA4,
      }, r.receipt),
  },
  {
    name: "accept release",
    record: () => baseRecord({ nextStep: "delivery" }),
    release: true,
    delivery: true,
    run: (r) =>
      acceptRelease(r.deps, r.context, r.record, r.request, r.clock.now()),
  },
  {
    name: "retry closure",
    record: () =>
      baseRecord({
        nextStep: "delivery",
        intent: intent("issue_closure", baseRecord()),
      }),
    release: true,
    delivery: true,
    run: (r) => retryClosure(r.deps, r.context, r.record),
  },
  {
    name: "resume work",
    record: () => baseRecord(),
    run: (r) => executeWorkStep(r.deps, r.context, r.record),
  },
  {
    name: "resume delivery",
    record: () => baseRecord({ nextStep: "delivery" }),
    release: true,
    delivery: true,
    run: (r) => executeDeliveryStep(r.deps, r.context, r.record),
  },
  {
    name: "orphan adoption",
    record: () =>
      baseRecord({
        target: { ...baseRecord().target, pr: null },
        intent: intent("push", baseRecord()),
      }),
    run: (r) => reconcileOrphanPublication(r.deps, r.context, new Set()),
  },
  {
    name: "review quota resume",
    record: () =>
      baseRecord({
        nextStep: "review",
        wait: { reason: "review_quota", since: T0, until: null },
      }),
    run: (r) => releaseReviewQuotaWait(r.deps, r.context, new Set()),
  },
  {
    name: "deferred release resume",
    record: () =>
      baseRecord({
        nextStep: "delivery",
        wait: { reason: "unavailable", since: T0, until: null },
      }),
    release: true,
    delivery: true,
    run: (r) =>
      resumeDeferredRelease(r.deps, r.context, {
        attempted: new Set(),
        release: releaseWithoutVps(T0),
      }),
  },
];

Deno.test("native queue refusals preserve custody at runtime boundaries", async (t) => {
  for (const reason of ["member", "observation_unavailable"] as const) {
    for (const boundary of boundaries) {
      await t.step(`${reason}: ${boundary.name}`, async () => {
        const rig = harness(boundary.record(), reason);
        if (boundary.release) {
          rig.context.snapshot.releaseRequests.push(rig.request);
        }
        const before = structuredClone(rig.context.snapshot);
        const result = await boundary.run(rig);
        assert.deepEqual(result, { kind: "progress" });
        assertHeld(
          rig,
          before,
          false,
          boundary.delivery || reason === "observation_unavailable",
        );
        assert.equal(rig.inspections.length, 1);
      });
    }
  }
});

Deno.test("missing native queue capability uses a bounded wait", async () => {
  const rig = harness(baseRecord(), "missing");
  const before = structuredClone(rig.context.snapshot);
  assert.deepEqual(
    await executePublishStep(
      rig.deps,
      rig.context,
      rig.record,
      rig.deps.configs[0],
    ),
    { kind: "progress" },
  );
  assertHeld(rig, before, false, true);
});

Deno.test("direct implementation and review admission recheck custody immediately before reserving", async (t) => {
  await t.step("implementation planner barrier", async () => {
    const rig = harness(
      baseRecord({ intent: intent("base_refresh", baseRecord()) }),
      "allow",
    );
    const before = structuredClone(rig.state.repair!);
    let barrier = 0;
    const result = await prepareImplementationStart(
      rig.deps,
      rig.context,
      rig.record,
      rig.deps.configs[0],
      () => {
        barrier++;
        rig.setDecision("member");
        return Promise.resolve(true);
      },
    );
    assert.equal(
      barrier,
      1,
      "entry and prerequisite guards must permit reaching the planner barrier",
    );
    assert.deepEqual(result, { kind: "progress" });
    assertHeld(rig, before, true);
  });
  await t.step("review live task barrier", async () => {
    const rig = harness(baseRecord(), "allow");
    const before = structuredClone(rig.state.repair!);
    rig.github.prepareBaseRefresh = () => {
      throw new Error("unchanged base must not refresh");
    };
    rig.github.readPullRequest = (number) => {
      rig.github.calls.push(`readPr:${number}`);
      return Promise.resolve(
        portOk(exactOpenPr(number, SHA2, rig.record.target.branch!, SHA1)),
      );
    };
    const readRef = rig.github.readRef.bind(rig.github);
    rig.github.readRef = async (ref) => {
      const read = await readRef(ref);
      return ref === "refs/heads/development"
        ? portOk({ ref, sha: SHA1 })
        : read;
    };
    const readIssue = rig.github.readIssue.bind(rig.github);
    let barrier = 0;
    rig.github.readIssue = async (number) => {
      const issue = await readIssue(number);
      barrier++;
      rig.setDecision("member");
      return issue;
    };
    const result = await requestReviewFor(rig.deps, rig.context, rig.record, 7);
    assert.equal(
      barrier,
      1,
      "fresh head and green CI must reach the live task read",
    );
    assert.deepEqual(result, { kind: "progress" });
    assertHeld(rig, before, true);
    assert.deepEqual(rig.github.reviewRequestIdentities, []);
  });
});

Deno.test("queue hold CAS refusal cannot publish or overwrite the authoritative record", async () => {
  const rig = harness(baseRecord({ intent: intent("push", baseRecord()) }));
  const before = structuredClone(rig.state.repair);
  rig.state.conflictRepairNext = true;
  const result = await executePublishStep(
    rig.deps,
    rig.context,
    rig.record,
    rig.deps.configs[0],
  );
  assert.equal(result.kind, "state_error");
  assert.deepEqual(rig.state.repair, before);
  assert.deepEqual(rig.github.calls, []);
  assert.deepEqual(rig.github.pushes, []);
  assert.equal(rig.model.requests.length, 0);
});

Deno.test("preactivation rule observation failure polls and resumes an existing refresh without queue permission", async () => {
  const refresh = intent("base_refresh", baseRecord());
  delete refresh.failure;
  const rig = harness(baseRecord({ intent: refresh }));
  const calls = transientRuleGuard(rig);
  let prepared = 0;
  rig.github.prepareBaseRefresh = () => {
    prepared++;
    return Promise.resolve(portOk(SHA4));
  };
  rig.github.preserveCandidate = (request) => {
    rig.github.preservationRequests.push(structuredClone(request));
    return Promise.resolve(portOk(undefined));
  };
  const before = structuredClone(rig.state.repair!);
  assert.deepEqual(await executeWorkStep(rig.deps, rig.context, rig.record), {
    kind: "progress",
  });
  const paused = rig.state.repair!.work[0];
  assert.deepEqual(paused, {
    ...before.work[0],
    wait: {
      reason: "unavailable",
      since: rig.clock.now(),
      until: rig.clock.now() + CHECK_POLL_MS,
    },
    updatedAt: rig.clock.now(),
  });
  assert.deepEqual(rig.state.repair!.reservations, before.reservations);
  assert.deepEqual(rig.github.calls, []);
  assert.equal(prepared, 0);
  assert.equal(rig.model.requests.length, 0);
  assert.deepEqual(calls, { rules: 1, queuePulls: 0, http: 0 });

  rig.clock.advance(CHECK_POLL_MS + 1);
  assert.deepEqual(await executeWorkStep(rig.deps, rig.context, paused), {
    kind: "progress",
  });
  const resumed = rig.state.repair!.work[0];
  assert.equal(prepared, 1);
  assert.equal(resumed.wait, null);
  assert.equal(resumed.intent, null);
  assert.equal(resumed.target.base, SHA3);
  assert.equal(resumed.target.head, SHA4);
  assert.deepEqual(rig.github.pushes, [{
    ref: `refs/heads/${rig.record.target.branch}`,
    sha: SHA4,
    expected: SHA2,
  }]);
  assert.deepEqual(rig.state.repair!.reservations, before.reservations);
  assert.equal(rig.model.requests.length, 0);
  assert.ok(calls.rules > 1, "the rule absence must be freshly authenticated");
  assert.equal(calls.queuePulls, 0);
  assert.equal(calls.http, 0);
});

Deno.test("activated proof policy polls unknown rules with a bounded wait", async () => {
  const rig = harness(baseRecord());
  const calls = transientRuleGuard(rig, true);
  const before = structuredClone(rig.state.repair!);
  await executeWorkStep(rig.deps, rig.context, rig.record);
  assertHeld(rig, before, false, true);
  assert.deepEqual(calls, { rules: 1, queuePulls: 0, http: 0 });
});

Deno.test("a transient rule refusal never downgrades existing nonexpiring queue custody", async () => {
  const held = baseRecord({
    wait: { reason: "backoff", since: T0, until: null },
  });
  const rig = harness(held, "rule_unavailable");
  const before = structuredClone(rig.state.repair!);
  const first = await executeWorkStep(rig.deps, rig.context, held);
  assert.equal(first.kind, "deferred");
  assert.deepEqual(rig.state.repair, before);
  assert.equal(rig.state.repairWrites, 0);
  const calls = transientRuleGuard(rig);
  const second = await executeWorkStep(rig.deps, rig.context, held);
  assert.equal(second.kind, "deferred");
  assert.deepEqual(rig.state.repair, before);
  assert.deepEqual(calls, { rules: 0, queuePulls: 0, http: 0 });
  assert.deepEqual(rig.github.calls, []);
  assert.equal(rig.model.requests.length, 0);
});

async function queuedDuringSession() {
  const rig = harness(
    baseRecord({ intent: intent("base_refresh", baseRecord()) }),
    "allow",
  );
  // Only the original completed implementation exists before the real next admission.
  rig.context.snapshot.reservations = rig.context.snapshot.reservations.slice(
    0,
    1,
  );
  let admitted: RepairStateSnapshotV1 | null = null;
  const run = rig.model.runModel.bind(rig.model);
  rig.model.runModel = async (request) => {
    admitted = structuredClone(rig.state.repair!);
    assert.equal(admitted.work[0].intent?.kind, "implementation");
    assert.equal(admitted.reservations.at(-1)?.outcome, "reserved");
    const receipt = await run(request);
    rig.setDecision("member");
    return receipt;
  };
  const result = await executeImplementationStep(
    rig.deps,
    rig.context,
    rig.record,
    rig.deps.configs[0],
  );
  assert.deepEqual(result, { kind: "progress" });
  assert.ok(admitted, "the real admission and model session must happen");
  const before = admitted as RepairStateSnapshotV1;
  const held = rig.state.repair!;
  assert.equal(rig.model.requests.length, 1);
  assert.deepEqual(
    held.reservations,
    before.reservations,
    "the submitted session remains charged",
  );
  assert.deepEqual(held.work[0], {
    ...before.work[0],
    wait: { reason: "backoff", since: rig.clock.now(), until: null },
    updatedAt: rig.clock.now(),
  });
  assert.deepEqual(rig.github.pushes, []);
  assert.equal(rig.github.calls.includes("merge"), false);
  assert.deepEqual(held.releaseRequests, []);
  return { rig, held };
}

Deno.test("owner enqueue during a charged conflict session holds its receipt and never expires", async () => {
  const { rig, held } = await queuedDuringSession();
  const original = structuredClone(held);
  rig.clock.advance(180 * DAY);
  rig.context.snapshot = rig.state.repair!;
  rig.context.head = rig.state.repairHead;
  rig.context.bounds = {
    runDeadline: rig.clock.now() + 3600_000,
    modelCutoff: rig.clock.now() + 3600_000,
  };
  const outcome = await handleConflictResolutionReceipt(
    rig.deps,
    rig.context,
    held.work[0],
    held.work[0].intent!.requestId!,
    { head: SHA4, changedPaths: ["src/fix.ts"] },
    rig.deps.configs[0],
  );
  assert.equal(outcome.kind, "deferred");
  assert.deepEqual(rig.state.repair, original);
  assert.equal(rig.model.requests.length, 1);
});

Deno.test({
  name:
    "actual R80 parser accepts runtime-produced queue hold and retained charged session",
  ignore: !available,
  fn: async () => {
    const { held } = await queuedDuringSession();
    await withR80Parsers((r80) => {
      assert.deepEqual(r80.parseRepairStateSnapshotV1(held), held);
    });
  },
});
