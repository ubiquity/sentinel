/**
 * Uncapped model-start admission (owner update 2026-10-02T22:05:51Z: "lift all
 * the limits"). These cases drive the REAL production consumers — the frozen
 * repository-config parser and `RollingStartBudget` — against the intended
 * uncapped policy: explicit `null` on BOTH rolling caps, never a fake huge
 * number. Durable reservations, unique admission before every start, and the
 * explicitly numeric control stay enforced.
 *
 * RED before implementation: the frozen parser rejects a null hourly cap, so
 * the controller reports `disabled` instead of admitting starts and the null
 * policy cannot be expressed in trusted source config at all.
 */
import assert from "node:assert/strict";

import { RollingStartBudget } from "../../src/budget/mod.ts";
import { parseRepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type {
  LiveStartLimitsV1,
  RepositoryConfigV1,
} from "../../src/contracts/repository-config.ts";
import { createLocalRepositoryConfig } from "../../src/host/local.ts";
import { REPO, T0 } from "../state/helpers.ts";
import {
  FakeClock,
  MemoryRepairState,
  repositoryConfig,
  reserveRequest,
  seededReservation,
} from "./helpers.ts";

/** Intended uncapped policy literal: explicit null, never a large integer. */
const UNCAPPED = {
  perHour: null,
  perSevenDays: null,
} as unknown as LiveStartLimitsV1;

/** The same valid repository config with both rolling caps explicitly null. */
function uncappedRepositoryConfig(): RepositoryConfigV1 {
  return {
    ...repositoryConfig(REPO, { perHour: 120, perSevenDays: null }),
    liveStartLimits: UNCAPPED,
  } as unknown as RepositoryConfigV1;
}

Deno.test(
  "uncapped admission: the frozen config parser accepts explicit null hourly and weekly caps",
  () => {
    const parsed = parseRepositoryConfigV1({
      ...repositoryConfig(REPO, { perHour: 120, perSevenDays: null }),
      liveStartLimits: { perHour: null, perSevenDays: null },
    });
    assert.deepEqual(parsed.liveStartLimits, {
      perHour: null,
      perSevenDays: null,
    });
  },
);

Deno.test(
  "uncapped admission: the trusted local host config expresses the uncapped policy explicitly",
  () => {
    assert.deepEqual(createLocalRepositoryConfig().liveStartLimits, {
      perHour: null,
      perSevenDays: null,
    });
  },
);

Deno.test(
  "uncapped admission: RollingStartBudget admits 128 starts and keeps every durable charge",
  async () => {
    const clock = new FakeClock(T0);
    const state = new MemoryRepairState();
    const budget = new RollingStartBudget({
      clock,
      state,
      configs: [uncappedRepositoryConfig()],
    });

    const statuses: string[] = [];
    let firstFailure = "";
    for (let index = 0; index < 128; index++) {
      const result = await budget.reserveModelStart(
        reserveRequest(`uncapped-task-${index}`),
      );
      statuses.push(result.status);
      if (result.status !== "admitted" && firstFailure === "") {
        firstFailure = JSON.stringify(result);
      }
    }
    assert.deepEqual(
      statuses,
      Array.from({ length: 128 }, () => "admitted"),
      firstFailure,
    );

    const snapshot = state.current().snapshot;
    assert.ok(snapshot !== null);
    assert.equal(
      snapshot.reservations.length,
      128,
      "every admitted start keeps its durable reservation",
    );
    assert.ok(
      snapshot.reservations.every((record) => record.outcome === "reserved"),
      "uncharged-but-recorded admission is the retained accounting",
    );

    // Unique admission before every start stays strict: the same logical
    // identity is reconciliation, never a second start.
    const repeat = await budget.reserveModelStart(
      reserveRequest("uncapped-task-0"),
    );
    assert.equal(repeat.status, "duplicate");
    assert.equal(state.current().snapshot?.reservations.length, 128);
    assert.equal(state.current().snapshot?.sequence, 128);
  },
);

Deno.test(
  "uncapped admission: historical durable charges are preserved, never rewritten",
  async () => {
    const clock = new FakeClock(T0);
    const state = new MemoryRepairState();
    const legacy = seededReservation("legacy-charge", {
      createdAt: T0 - 1000,
      outcome: "submitted",
      settledAt: T0,
    });
    state.seed({
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0,
      incidents: [],
      evidence: [],
      work: [],
      reservations: [legacy],
      reviews: [],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
    });

    const budget = new RollingStartBudget({
      clock,
      state,
      configs: [uncappedRepositoryConfig()],
    });
    const result = await budget.reserveModelStart(
      reserveRequest("fresh-after-legacy"),
    );
    assert.equal(result.status, "admitted", JSON.stringify(result));

    const snapshot = state.current().snapshot;
    assert.ok(snapshot !== null);
    const preserved = snapshot.reservations.find((r) => r.id === legacy.id);
    assert.ok(preserved, "the historical charge remains durable");
    assert.equal(preserved.outcome, "submitted");
    assert.equal(preserved.createdAt, legacy.createdAt);
    assert.equal(preserved.settledAt, legacy.settledAt);
    assert.equal(snapshot.reservations.length, 2);
  },
);

Deno.test(
  "uncapped admission control: an explicitly numeric hourly cap still defers the excess start",
  async () => {
    const clock = new FakeClock(T0);
    const state = new MemoryRepairState();
    const budget = new RollingStartBudget({
      clock,
      state,
      configs: [repositoryConfig(REPO, { perHour: 2, perSevenDays: null })],
    });

    assert.equal(
      (await budget.reserveModelStart(reserveRequest("capped-a"))).status,
      "admitted",
    );
    assert.equal(
      (await budget.reserveModelStart(reserveRequest("capped-b"))).status,
      "admitted",
    );
    const third = await budget.reserveModelStart(reserveRequest("capped-c"));
    assert.equal(third.status, "deferred");
    if (third.status === "deferred") {
      assert.equal(third.reason, "cap_limit");
      assert.equal(third.retryAt, T0 + 3_600_000);
    }
    const snapshot = state.current().snapshot;
    assert.ok(snapshot !== null);
    assert.equal(
      snapshot.reservations.length,
      2,
      "the deferred start is never recorded as an admission",
    );
  },
);
