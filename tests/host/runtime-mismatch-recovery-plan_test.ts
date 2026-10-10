import assert from "node:assert/strict";
import {
  planRuntimeMismatchRecovery,
  type RuntimeMismatchBindingV1,
  type RuntimeMismatchPlanInputV1,
  type RuntimeMismatchProofV1,
} from "../../ops/runtime-mismatch-recovery-plan.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";

function testRelease(): ReleaseStateSnapshotV1 {
  return {
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    releases: [],
    hostedRuntimes: [],
    hostedReleases: [],
  } as ReleaseStateSnapshotV1;
}

const T0 = 1791623000000;

function testRecord(overrides: Partial<WorkRecordV1> = {}): WorkRecordV1 {
  return {
    version: "v1",
    kind: "work",
    id: "issue-ubiquity-ai.ubq.fi-1",
    repository: {
      owner: "ubiquity",
      name: "ai.ubq.fi",
      installationId: 155687488,
    },
    source: { kind: "issue", id: "1", revision: "r1" },
    target: {
      base: "b1",
      branch: "sentinel/repair/issue-ubiquity-ai.ubq.fi-1",
      checkpoint: null,
      head: null,
      pr: null,
    },
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: "authenticated historical matrix runtime mismatch; producer=1:1",
    },
    wait: null,
    intent: {
      kind: "implementation",
      key: "impl:k1",
      startedAt: T0 - 1000,
      branch: "sentinel/repair/issue-ubiquity-ai.ubq.fi-1",
      expectedHead: null,
      observedBase: "b1",
      pr: null,
      requestId: "req1",
      resultId: null,
    },
    dependencies: [],
    counters: { attempts: 1, retries: 0, reviewRounds: 0, stalled: 0 },
    ...overrides,
  } as WorkRecordV1;
}

function testReservation(
  overrides: Partial<BudgetReservationV1> = {},
): BudgetReservationV1 {
  return {
    version: "v1",
    kind: "budget_reservation",
    repository: {
      owner: "ubiquity",
      name: "ai.ubq.fi",
      installationId: 155687488,
    },
    id: "req1",
    taskId: "issue-ubiquity-ai.ubq.fi-1" as never,
    attempt: 1,
    head: "b1" as never,
    purpose: "retry",
    createdAt: T0 - 2000,
    outcome: "reserved",
    settledAt: null,
    proofRef: null,
    ...overrides,
  } as BudgetReservationV1;
}

function testSnapshot(
  work: WorkRecordV1[],
  reservations: BudgetReservationV1[],
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
    reservations,
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  } as RepairStateSnapshotV1;
}

function testBinding(
  overrides: Partial<RuntimeMismatchBindingV1> = {},
): RuntimeMismatchBindingV1 {
  return {
    id: "issue-ubiquity-ai.ubq.fi-1",
    reservationId: "req1",
    repository: {
      owner: "ubiquity",
      name: "ai.ubq.fi",
      installationId: 155687488,
    },
    base: "b1",
    branch: "sentinel/repair/issue-ubiquity-ai.ubq.fi-1",
    requestId: "req1",
    intentKey: "impl:k1",
    purpose: "retry",
    recordDigest: "h0",
    reservationDigest: "h0",
    producerRun: "1",
    producerAttempt: 1,
    producerTerminal: true,
    ...overrides,
  };
}

function testProof(
  overrides: Partial<RuntimeMismatchProofV1> = {},
): RuntimeMismatchProofV1 {
  return {
    publicationRefs: [],
    preservationRefs: [],
    headRefs: [],
    prObservations: [],
    effectDisposition: { operation: "op1", evidence: "ev1" },
    exclusiveCustody: true,
    ...overrides,
  };
}

import { canonicalStringifySha256 } from "../../src/contracts/canonical.ts";

async function validInput(): Promise<RuntimeMismatchPlanInputV1> {
  const record = testRecord();
  const reservation = testReservation();
  return {
    repair: testSnapshot([record], [reservation]),
    release: testRelease(),
    bindings: [
      testBinding({
        recordDigest: await canonicalStringifySha256(record),
        reservationDigest: await canonicalStringifySha256(reservation),
      }),
    ],
    proofs: { "issue-ubiquity-ai.ubq.fi-1": testProof() },
    expectedRepairHead: "rh1",
    expectedReleaseHead: "eh1",
    expectedSequence: 1,
    now: T0,
  };
}

Deno.test("planner refuses empty bindings", async () => {
  const input = { ...await validInput(), bindings: [] };
  const result = await planRuntimeMismatchRecovery(input);
  assert.equal(result.ok, false);
});

Deno.test("planner refuses duplicate bindings", async () => {
  const input = await validInput();
  const doubled = {
    ...input,
    bindings: [input.bindings[0], input.bindings[0]],
  };
  const result = await planRuntimeMismatchRecovery(doubled);
  assert.equal(result.ok, false);
});

Deno.test("planner refuses missing proof", async () => {
  const input = { ...await validInput(), proofs: {} };
  const result = await planRuntimeMismatchRecovery(input);
  assert.equal(result.ok, false);
});

Deno.test("planner refuses non-terminal producer", async () => {
  const input = await validInput();
  const bindings = [{ ...input.bindings[0], producerTerminal: false }];
  const result = await planRuntimeMismatchRecovery({ ...input, bindings });
  assert.equal(result.ok, false);
});

Deno.test("planner refuses candidate-bearing record", async () => {
  const record = testRecord({
    target: { ...testRecord().target, head: "h1" as never },
  });
  const reservation = testReservation();
  const input: RuntimeMismatchPlanInputV1 = {
    ...await validInput(),
    repair: testSnapshot([record], [reservation]),
    bindings: [
      testBinding({
        recordDigest: await canonicalStringifySha256(record),
        reservationDigest: await canonicalStringifySha256(reservation),
      }),
    ],
  };
  const result = await planRuntimeMismatchRecovery(input);
  assert.equal(result.ok, false);
});

Deno.test("planner refuses present PR observations", async () => {
  const input = await validInput();
  const proofs = {
    "issue-ubiquity-ai.ubq.fi-1": testProof({
      prObservations: [{ number: 1, state: "open", head: "h1" }],
    }),
  };
  const result = await planRuntimeMismatchRecovery({ ...input, proofs });
  assert.equal(result.ok, false);
});

Deno.test("planner refuses missing effect disposition", async () => {
  const input = await validInput();
  const proofs = {
    "issue-ubiquity-ai.ubq.fi-1": testProof({ effectDisposition: null }),
  };
  const result = await planRuntimeMismatchRecovery({ ...input, proofs });
  assert.equal(result.ok, false);
});

Deno.test("planner refuses non-exclusive custody", async () => {
  const input = await validInput();
  const proofs = {
    "issue-ubiquity-ai.ubq.fi-1": testProof({ exclusiveCustody: false }),
  };
  const result = await planRuntimeMismatchRecovery({ ...input, proofs });
  assert.equal(result.ok, false);
});

Deno.test("planner proposes on fully bound input", async () => {
  const input = await validInput();
  const result = await planRuntimeMismatchRecovery(input);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].id, "issue-ubiquity-ai.ubq.fi-1");
    assert.equal(result.proposals[0].settleReservation.outcome, "ambiguous");
  }
});

Deno.test("planner distinguishes retry and implementation purposes", async () => {
  const record = testRecord();
  const reservation = testReservation({ purpose: "implementation" });
  const input: RuntimeMismatchPlanInputV1 = {
    ...await validInput(),
    repair: testSnapshot([record], [reservation]),
    bindings: [
      testBinding({
        purpose: "implementation",
        recordDigest: await canonicalStringifySha256(record),
        reservationDigest: await canonicalStringifySha256(reservation),
      }),
    ],
  };
  const result = await planRuntimeMismatchRecovery(input);
  assert.equal(result.ok, true);
});

Deno.test("planner accepts insertion-order equivalent digests", async () => {
  const first = { b: 2, a: 1 };
  const second = { a: 1, b: 2 };
  assert.equal(
    await canonicalStringifySha256(first),
    await canonicalStringifySha256(second),
  );
});

Deno.test("planner refuses truncated digest", async () => {
  const input = await validInput();
  const bindings = [{
    ...input.bindings[0],
    recordDigest: input.bindings[0].recordDigest.slice(0, 32),
  }];
  const result = await planRuntimeMismatchRecovery({ ...input, bindings });
  assert.equal(result.ok, false);
});

Deno.test("planner refuses changed record bytes", async () => {
  const record = testRecord({ nextStep: "work" as never });
  const reservation = testReservation();
  const input: RuntimeMismatchPlanInputV1 = {
    ...await validInput(),
    repair: testSnapshot([record], [reservation]),
    bindings: [
      testBinding({
        recordDigest: await canonicalStringifySha256(testRecord()),
        reservationDigest: await canonicalStringifySha256(reservation),
      }),
    ],
  };
  const result = await planRuntimeMismatchRecovery(input);
  assert.equal(result.ok, false);
});
