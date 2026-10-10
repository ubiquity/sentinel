import assert from "node:assert/strict";
import { deriveReservationId } from "../../src/budget/mod.ts";
import { canonicalStringifySha256 } from "../../src/contracts/canonical.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  candidateBranch,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import {
  planRuntimeMismatchRecovery,
  type RuntimeMismatchBindingV1,
  type RuntimeMismatchPlanInputV1,
  type RuntimeMismatchProofV1,
} from "../../ops/runtime-mismatch-recovery-plan.ts";
import { reservation, SHA1, T0, workRecord } from "../state/helpers.ts";

const WORK_ID = "issue-ubiquity-ai.ubq.fi-1";
const BASE_SHA = "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1";

function testRelease(): unknown {
  return {
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    releases: [],
    hostedRuntimes: [],
    hostedReleases: [],
    githubCooldowns: [],
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

async function baselineInput(
  purpose: "retry" | "implementation" = "retry",
): Promise<{
  input: RuntimeMismatchPlanInputV1;
  recordId: string;
  reservationId: string;
}> {
  const recordId = WORK_ID;
  const branch = candidateBranch(recordId as never);
  const repo = {
    owner: "ubiquity",
    name: "ai.ubq.fi",
    installationId: 155687488,
  };
  const reservationId = await deriveReservationId({
    repository: repo,
    taskId: recordId as never,
    head: BASE_SHA as never,
    attempt: 1,
    purpose,
  });
  const record = workRecord(WORK_ID, {
    repository: repo,
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: "authenticated historical matrix runtime mismatch; producer=1:1",
      since: T0,
    },
    target: { base: BASE_SHA, branch, checkpoint: null, head: null, pr: null },
    intent: {
      kind: "implementation",
      key: implementationIntentKey(reservationId),
      startedAt: T0 - 1000,
      branch,
      expectedHead: null,
      observedBase: BASE_SHA,
      pr: null,
      requestId: reservationId,
      resultId: null,
    },
  });
  const res = reservation(reservationId, {
    repository: repo,
    taskId: recordId,
    head: BASE_SHA,
    purpose,
  });
  const repair = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: [record],
    reservations: [res],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
  const binding: RuntimeMismatchBindingV1 = {
    id: recordId,
    reservationId,
    repository: {
      owner: "ubiquity",
      name: "ai.ubq.fi",
      installationId: 155687488,
    },
    base: BASE_SHA,
    branch,
    requestId: reservationId,
    intentKey: implementationIntentKey(reservationId),
    purpose,
    recordDigest: await canonicalStringifySha256(record),
    reservationDigest: await canonicalStringifySha256(res),
    producerRun: "1",
    producerAttempt: 1,
    producerTerminal: true,
  };
  return {
    input: {
      repair,
      release: testRelease(),
      bindings: [binding],
      proofs: { [recordId]: testProof() },
      expectedRepairHead: "rh1",
      expectedReleaseHead: "eh1",
      expectedSequence: 1,
      now: T0,
    },
    recordId,
    reservationId,
  };
}

Deno.test("planner refuses empty bindings", async () => {
  const { input } = await baselineInput();
  const result = await planRuntimeMismatchRecovery({ ...input, bindings: [] });
  assert.equal(result.ok, false);
});

Deno.test("planner refuses null release", async () => {
  const { input } = await baselineInput();
  const result = await planRuntimeMismatchRecovery({ ...input, release: null });
  assert.equal(result.ok, false);
});

Deno.test("planner refuses duplicate bindings", async () => {
  const { input } = await baselineInput();
  const doubled = {
    ...input,
    bindings: [input.bindings[0], input.bindings[0]],
  };
  const result = await planRuntimeMismatchRecovery(doubled);
  assert.equal(result.ok, false);
});

Deno.test("planner refuses missing proof", async () => {
  const { input } = await baselineInput();
  const result = await planRuntimeMismatchRecovery({ ...input, proofs: {} });
  assert.equal(result.ok, false);
});

Deno.test("planner refuses non-terminal producer", async () => {
  const { input } = await baselineInput();
  const bindings = [{ ...input.bindings[0], producerTerminal: false }];
  const result = await planRuntimeMismatchRecovery({ ...input, bindings });
  assert.equal(result.ok, false);
});

Deno.test("planner refuses candidate-bearing record", async () => {
  const { input, recordId, reservationId } = await baselineInput();
  const repo = {
    owner: "ubiquity",
    name: "ai.ubq.fi",
    installationId: 155687488,
  };
  const branch = candidateBranch(recordId as never);
  const record = workRecord(recordId, {
    repository: repo,
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: "authenticated historical matrix runtime mismatch; producer=1:1",
      since: T0,
    },
    target: {
      base: BASE_SHA,
      branch,
      checkpoint: null,
      head: SHA1,
      pr: null,
    },
    intent: {
      kind: "implementation",
      key: implementationIntentKey(reservationId),
      startedAt: T0 - 1000,
      branch,
      expectedHead: null,
      observedBase: BASE_SHA,
      pr: null,
      requestId: reservationId,
      resultId: null,
    },
  });
  const nativeRepair = parseRepairStateSnapshotV1(input.repair);
  const repair = { ...nativeRepair, work: [record] };
  const bindings = [{
    ...input.bindings[0],
    recordDigest: await canonicalStringifySha256(record),
  }];
  const result = await planRuntimeMismatchRecovery({
    ...input,
    repair,
    bindings,
  });
  assert.equal(result.ok, false);
});

Deno.test("planner refuses present PR observations", async () => {
  const { input, recordId } = await baselineInput();
  const proofs = {
    [recordId]: testProof({
      prObservations: [{ number: 1, state: "open", head: SHA1 }],
    }),
  };
  const result = await planRuntimeMismatchRecovery({ ...input, proofs });
  assert.equal(result.ok, false);
});

Deno.test("planner refuses missing effect disposition", async () => {
  const { input, recordId } = await baselineInput();
  const proofs = { [recordId]: testProof({ effectDisposition: null }) };
  const result = await planRuntimeMismatchRecovery({ ...input, proofs });
  assert.equal(result.ok, false);
});

Deno.test("planner refuses non-exclusive custody", async () => {
  const { input, recordId } = await baselineInput();
  const proofs = { [recordId]: testProof({ exclusiveCustody: false }) };
  const result = await planRuntimeMismatchRecovery({ ...input, proofs });
  assert.equal(result.ok, false);
});

Deno.test("planner proposes on fully bound retry input", async () => {
  const { input } = await baselineInput("retry");
  const result = await planRuntimeMismatchRecovery(input);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].id, WORK_ID);
    assert.equal(result.proposals[0].settleReservation.outcome, "ambiguous");
  }
});

Deno.test("planner proposes on fully bound implementation input", async () => {
  const { input } = await baselineInput("implementation");
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

Deno.test("planner refuses truncated record digest", async () => {
  const { input } = await baselineInput();
  const bindings = [{
    ...input.bindings[0],
    recordDigest: input.bindings[0].recordDigest.slice(0, 32),
  }];
  const result = await planRuntimeMismatchRecovery({ ...input, bindings });
  assert.equal(result.ok, false);
});

Deno.test("planner refuses truncated reservation digest", async () => {
  const { input } = await baselineInput();
  const bindings = [{
    ...input.bindings[0],
    reservationDigest: input.bindings[0].reservationDigest.slice(0, 32),
  }];
  const result = await planRuntimeMismatchRecovery({ ...input, bindings });
  assert.equal(result.ok, false);
});

Deno.test("planner refuses nonhex record digest", async () => {
  const { input } = await baselineInput();
  const bindings = [{
    ...input.bindings[0],
    recordDigest: "z".repeat(64),
  }];
  const result = await planRuntimeMismatchRecovery({ ...input, bindings });
  assert.equal(result.ok, false);
});

Deno.test("planner refuses changed reservation bytes", async () => {
  const { input, reservationId } = await baselineInput();
  const changed = reservation(reservationId, {
    taskId: WORK_ID,
    head: BASE_SHA,
    purpose: "retry",
    attempt: 2,
  });
  const bindings = [{
    ...input.bindings[0],
    reservationDigest: await canonicalStringifySha256(changed),
  }];
  const result = await planRuntimeMismatchRecovery({ ...input, bindings });
  assert.equal(result.ok, false);
});

Deno.test("planner refuses wrong installation scope", async () => {
  const { input } = await baselineInput();
  const bindings = [{
    ...input.bindings[0],
    repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 999 },
  }];
  const result = await planRuntimeMismatchRecovery({ ...input, bindings });
  assert.equal(result.ok, false);
});

Deno.test("planner refuses selected reservation B when intent names A", async () => {
  const { input } = await baselineInput();
  const otherId = await deriveReservationId({
    repository: {
      owner: "ubiquity",
      name: "ai.ubq.fi",
      installationId: 155687488,
    },
    taskId: WORK_ID as never,
    head: SHA1 as never,
    attempt: 1,
    purpose: "retry",
  });
  const bindings = [{ ...input.bindings[0], reservationId: otherId }];
  const result = await planRuntimeMismatchRecovery({ ...input, bindings });
  assert.equal(result.ok, false);
});

Deno.test("planner refuses changed record bytes", async () => {
  const { input } = await baselineInput();
  const nativeRepair = parseRepairStateSnapshotV1(input.repair);
  const changedRecord = {
    ...nativeRepair.work[0],
    counters: { attempts: 99, retries: 0, reviewRounds: 0 },
  };
  const repair = { ...nativeRepair, work: [changedRecord] };
  const result = await planRuntimeMismatchRecovery({
    ...input,
    repair,
    bindings: input.bindings,
  });
  assert.equal(result.ok, false);
});
