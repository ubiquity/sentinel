import assert from "node:assert/strict";
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { implementationIntentKey } from "../../src/repair/keys.ts";
import {
  HISTORICAL_RETRY_DISPOSITION_BINDING_V1,
  HISTORICAL_RETRY_DISPOSITION_MESSAGE,
  planHistoricalRetryDisposition,
} from "../../ops/historical-retry-disposition.ts";
import { SHA1, T0, workRecord } from "../state/helpers.ts";

const AI = { owner: "ubiquity", name: "ai.ubq.fi", installationId: 0 } as const;
const BASE = "3691fe4a36e4e4c6aae6f8c6aa04c12ed3ff6698" as GitSha;
const RID_A = "a".repeat(64);
const RID_B = "b".repeat(64);
const NOW = T0 + 100_000;

function record(
  id: string,
  reservationId: string,
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return workRecord(id, {
    repository: { ...AI },
    target: {
      base: BASE,
      branch: "sentinel/test",
      checkpoint: null,
      head: null,
      pr: null,
    },
    intent: {
      kind: "implementation",
      key: implementationIntentKey(reservationId),
      startedAt: T0,
      branch: "sentinel/test",
      expectedHead: null,
      observedBase: BASE,
      pr: null,
      requestId: reservationId,
      resultId: null,
    },
    ...overrides,
  });
}

function reservation(
  id: string,
  taskId: string,
  overrides: Record<string, unknown> = {},
): BudgetReservationV1 {
  return {
    version: "v1",
    kind: "budget_reservation",
    repository: { ...AI },
    id,
    taskId: taskId as WorkItemId,
    attempt: 2,
    head: BASE,
    purpose: "retry",
    createdAt: T0,
    outcome: "reserved",
    settledAt: null,
    proofRef: null,
    ...overrides,
  } as unknown as BudgetReservationV1;
}

function snapshot(
  work: WorkRecordV1[],
  reservations: BudgetReservationV1[],
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 5,
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
  });
}

const BINDING = [
  { id: "issue-ubiquity-ai.ubq.fi-398", reservationId: RID_A, base: BASE },
  { id: "issue-ubiquity-ai.ubq.fi-420", reservationId: RID_B, base: BASE },
] as const;

function fixture(): RepairStateSnapshotV1 {
  return snapshot(
    [
      record("issue-ubiquity-ai.ubq.fi-398", RID_A),
      record("issue-ubiquity-ai.ubq.fi-420", RID_B),
      record("issue-ubiquity-ai.ubq.fi-999", "c".repeat(64)),
    ],
    [
      reservation(RID_A, "issue-ubiquity-ai.ubq.fi-398"),
      reservation(RID_B, "issue-ubiquity-ai.ubq.fi-420"),
      reservation("c".repeat(64), "issue-ubiquity-ai.ubq.fi-999"),
    ],
  );
}

Deno.test("historical retry disposition: applies exactly the bound transitions", () => {
  const before = fixture();
  const unrelated = before.work[2];
  const plan = planHistoricalRetryDisposition(before, BINDING, NOW);
  assert.ok(plan.ok, plan.ok ? "" : plan.refused);
  const next = plan.snapshot;
  assert.deepEqual(next.sequence, before.sequence + 1);
  assert.deepEqual(next.updatedAt, NOW);
  for (
    const [index, id] of [
      "issue-ubiquity-ai.ubq.fi-398",
      "issue-ubiquity-ai.ubq.fi-420",
    ].entries()
  ) {
    const moved = next.work.find((row) => row.id === id)!;
    assert.deepEqual(moved.nextStep, "blocked");
    assert.deepEqual(moved.wait, null);
    assert.deepEqual(moved.blocker, {
      kind: "other",
      message: HISTORICAL_RETRY_DISPOSITION_MESSAGE,
      since: NOW,
    });
    const settled = next.reservations.find((row) =>
      row.id === (index === 0 ? RID_A : RID_B)
    )!;
    assert.deepEqual(settled.outcome, "ambiguous");
    assert.deepEqual(settled.settledAt, NOW);
    assert.deepEqual(settled.proofRef, null);
  }
  assert.deepEqual(next.work[2], unrelated);
  assert.deepEqual(next.reservations[2], before.reservations[2]);
  assert.deepEqual(plan.transitions.length, 2);
});

Deno.test("historical retry disposition: the production binding is the exact sixteen records", () => {
  assert.deepEqual(HISTORICAL_RETRY_DISPOSITION_BINDING_V1.length, 16);
  for (const entry of HISTORICAL_RETRY_DISPOSITION_BINDING_V1) {
    assert.ok(entry.id.startsWith("issue-ubiquity-ai.ubq.fi-"));
    assert.deepEqual(entry.base, BASE);
  }
});

Deno.test("historical retry disposition: any deviation refuses the whole batch", () => {
  const cases: readonly [string, RepairStateSnapshotV1][] = [
    [
      "moved record",
      snapshot(
        [
          record("issue-ubiquity-ai.ubq.fi-398", RID_A, {
            nextStep: "blocked",
            blocker: { kind: "other", message: "existing", since: T0 },
          }),
          record("issue-ubiquity-ai.ubq.fi-420", RID_B),
        ],
        [
          reservation(RID_A, "issue-ubiquity-ai.ubq.fi-398"),
          reservation(RID_B, "issue-ubiquity-ai.ubq.fi-420"),
        ],
      ),
    ],
    [
      "changed base",
      snapshot(
        [
          record("issue-ubiquity-ai.ubq.fi-398", RID_A, {
            target: {
              base: SHA1,
              branch: "sentinel/test",
              checkpoint: null,
              head: null,
              pr: null,
            },
          }),
          record("issue-ubiquity-ai.ubq.fi-420", RID_B),
        ],
        [
          reservation(RID_A, "issue-ubiquity-ai.ubq.fi-398"),
          reservation(RID_B, "issue-ubiquity-ai.ubq.fi-420"),
        ],
      ),
    ],
    [
      "settled reservation",
      snapshot(
        [
          record("issue-ubiquity-ai.ubq.fi-398", RID_A),
          record("issue-ubiquity-ai.ubq.fi-420", RID_B),
        ],
        [
          reservation(RID_A, "issue-ubiquity-ai.ubq.fi-398", {
            outcome: "submitted",
            settledAt: T0,
          }),
          reservation(RID_B, "issue-ubiquity-ai.ubq.fi-420"),
        ],
      ),
    ],
    [
      "foreign purpose",
      snapshot(
        [
          record("issue-ubiquity-ai.ubq.fi-398", RID_A),
          record("issue-ubiquity-ai.ubq.fi-420", RID_B),
        ],
        [
          reservation(RID_A, "issue-ubiquity-ai.ubq.fi-398", {
            purpose: "implementation",
          }),
          reservation(RID_B, "issue-ubiquity-ai.ubq.fi-420"),
        ],
      ),
    ],
    [
      "missing reservation",
      snapshot(
        [
          record("issue-ubiquity-ai.ubq.fi-398", RID_A),
          record("issue-ubiquity-ai.ubq.fi-420", RID_B),
        ],
        [reservation(RID_B, "issue-ubiquity-ai.ubq.fi-420")],
      ),
    ],
    [
      "changed intent",
      snapshot(
        [
          record("issue-ubiquity-ai.ubq.fi-398", "d".repeat(64)),
          record("issue-ubiquity-ai.ubq.fi-420", RID_B),
        ],
        [
          reservation(RID_A, "issue-ubiquity-ai.ubq.fi-398"),
          reservation(RID_B, "issue-ubiquity-ai.ubq.fi-420"),
        ],
      ),
    ],
  ];
  for (const [name, value] of cases) {
    const plan = planHistoricalRetryDisposition(value, BINDING, NOW);
    assert.strictEqual(plan.ok, false, name);
  }
  const empty = planHistoricalRetryDisposition(fixture(), [], NOW);
  assert.strictEqual(empty.ok, false, "empty binding");
});

Deno.test("historical retry disposition: a missing bound record refuses", () => {
  const value = snapshot(
    [record("issue-ubiquity-ai.ubq.fi-420", RID_B)],
    [reservation(RID_B, "issue-ubiquity-ai.ubq.fi-420")],
  );
  const plan = planHistoricalRetryDisposition(value, BINDING, NOW);
  assert.strictEqual(plan.ok, false);
});
