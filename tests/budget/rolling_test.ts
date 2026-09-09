// Rolling-window arithmetic tests: strict millisecond boundaries, overlapping
// hour/week caps, several excess entries under lowered limits, proof-only
// refunds, exact safe-integer bounds and fixed sanitized RangeErrors on
// invalid input or overflow. These use the pure earliestRetryAt/isCharged
// helpers with deterministic synthetic reservations; real Git admission
// coverage lives in git_budget_test.ts.
import assert from "node:assert/strict";

import {
  earliestRetryAt,
  HOUR_WINDOW_MS,
  isCharged,
  SEVEN_DAY_WINDOW_MS,
} from "../../src/budget/mod.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import { T0 } from "../state/helpers.ts";
import { seededReservation } from "./helpers.ts";

const NOW = T0;

Deno.test("budget: hour window boundary is strict (now-duration, now]", () => {
  // An entry exactly one hour ago is outside (now - HOUR, now].
  const excluded = seededReservation("excluded", {
    createdAt: NOW - HOUR_WINDOW_MS,
  });
  const included = seededReservation("included", {
    createdAt: NOW - HOUR_WINDOW_MS + 1,
  });

  // Per-hour cap 1: the strictly-inside entry fills the window, so admission
  // is deferred until it falls out one millisecond after exactly one hour.
  assert.equal(
    earliestRetryAt(
      [excluded, included],
      NOW,
      { perHour: 1, perSevenDays: 3 },
    ),
    NOW + 1,
  );
  // Per-hour cap 2: only one entry is inside, so admission is available now.
  assert.equal(
    earliestRetryAt(
      [excluded, included],
      NOW,
      { perHour: 2, perSevenDays: 3 },
    ),
    NOW,
  );
  // With only the boundary entry, the hour window is empty: admitted now.
  assert.equal(
    earliestRetryAt([excluded], NOW, { perHour: 1, perSevenDays: 3 }),
    NOW,
  );
});

Deno.test("budget: overlapping hour and week caps take the later retryAt", () => {
  const recent = seededReservation("recent", { createdAt: NOW - 500 });
  const older = seededReservation("older", {
    createdAt: NOW - 1_000_000,
  });
  // Hour cap 1: `recent` alone fills it; it falls out at NOW + HOUR - 500.
  // Week cap 2: `older` is the second-most-recent; it falls out at
  // NOW - 1_000_000 + 7d, which is later and therefore binding.
  assert.equal(
    earliestRetryAt(
      [recent, older],
      NOW,
      { perHour: 1, perSevenDays: 2 },
    ),
    NOW - 1_000_000 + SEVEN_DAY_WINDOW_MS,
  );

  const twoHoursAgo = seededReservation("a", {
    createdAt: NOW - 2 * HOUR_WINDOW_MS,
  });
  const threeHoursAgo = seededReservation("b", {
    createdAt: NOW - 3 * HOUR_WINDOW_MS,
  });
  // Nothing in the hour window (both are older than an hour), but the week
  // cap 2 binds on the second-most-recent entry.
  assert.equal(
    earliestRetryAt(
      [twoHoursAgo, threeHoursAgo],
      NOW,
      { perHour: 1, perSevenDays: 2 },
    ),
    NOW - 3 * HOUR_WINDOW_MS + SEVEN_DAY_WINDOW_MS,
  );
});

Deno.test("budget: lowered caps with several excess reservations sort, not single-entry", () => {
  const entries = [
    seededReservation("e0", { createdAt: NOW }),
    seededReservation("e1", { createdAt: NOW - 60_000 }),
    seededReservation("e2", { createdAt: NOW - 120_000 }),
    seededReservation("e3", { createdAt: NOW - 180_000 }),
    seededReservation("e4", { createdAt: NOW - 240_000 }),
  ];
  // Hour cap 2: the second-most-recent entry (e1) must fall out.
  // Week cap 3: the third-most-recent entry (e2) must fall out; 7d dominates.
  assert.equal(
    earliestRetryAt(
      entries,
      NOW,
      { perHour: 2, perSevenDays: 3 },
    ),
    NOW - 120_000 + SEVEN_DAY_WINDOW_MS,
  );
  // Hour cap 1 with four excess entries: only the newest (e0) drives retryAt;
  // the earlier ones are irrelevant until the count drops below two.
  assert.equal(
    earliestRetryAt(entries, NOW, { perHour: 1, perSevenDays: 10 }),
    NOW + HOUR_WINDOW_MS,
  );
});

Deno.test("budget: refunded reservations never charge; only proof-valid refunds", () => {
  const refunded = seededReservation("refunded", {
    outcome: "confirmed_not_submitted",
    settledAt: NOW,
    proofRef: "artifact://proof/refunded",
  });
  assert.equal(isCharged(refunded), false);
  assert.equal(
    earliestRetryAt([refunded], NOW, { perHour: 1, perSevenDays: 1 }),
    NOW,
    "a refunded reservation leaves the caps empty",
  );

  const charged = seededReservation("charged", {
    outcome: "submitted",
    settledAt: NOW,
  });
  assert.equal(isCharged(charged), true);
  // Ambiguous and reserved entries stay charged too.
  assert.equal(
    isCharged(
      seededReservation("amb", { outcome: "ambiguous", settledAt: NOW }),
    ),
    true,
  );
  assert.equal(isCharged(seededReservation("res")), true);
});

Deno.test("budget: retryAt is exact at the safe-integer bound and overflows typed", () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  const limits = { perHour: 1, perSevenDays: 10 };
  // The one charge is inside the strict window and its retryAt lands exactly
  // on MAX_SAFE_INTEGER: the helper returns that exact safe value.
  const boundary = seededReservation("boundary", {
    createdAt: MAX - HOUR_WINDOW_MS,
  });
  assert.equal(
    earliestRetryAt([boundary], MAX - 1, limits),
    MAX,
  );
  // One millisecond closer and threshold + window would leave the safe
  // integer range: the helper throws the fixed sanitized RangeError instead
  // of returning an unsafe retryAt.
  const overflowing = seededReservation("over", {
    createdAt: MAX - HOUR_WINDOW_MS + 1,
  });
  assert.throws(
    () => earliestRetryAt([overflowing], MAX - 1, limits),
    (error: unknown) =>
      error instanceof RangeError &&
      /earliestRetryAt: retry timestamp overflow/.test(error.message),
  );
  // A clean window at the maximum timestamp still returns the exact now.
  assert.equal(
    earliestRetryAt([], MAX, limits),
    MAX,
  );
});

Deno.test("budget: earliestRetryAt rejects invalid inputs with a fixed sanitized RangeError", () => {
  const limits = { perHour: 2, perSevenDays: 5 };
  // Built after the frozen parser so the malformed value only ever reaches
  // the arithmetic helper, which must validate and reject it.
  const malformed = {
    ...seededReservation("bad-time"),
    createdAt: NaN,
  } as unknown as BudgetReservationV1;
  const invalidReservation = {
    ...seededReservation("old"),
    outcome: "submitted" as const,
    settledAt: null,
  } as unknown as BudgetReservationV1;
  const cases: { name: string; call: () => unknown }[] = [
    {
      name: "malformed reservation timestamp",
      call: () => earliestRetryAt([malformed], NOW, limits),
    },
    {
      name: "lifecycle-invalid reservation",
      call: () => earliestRetryAt([invalidReservation], NOW, limits),
    },
    {
      name: "negative now",
      call: () => earliestRetryAt([], -1, limits),
    },
    {
      name: "unsafe now",
      call: () => earliestRetryAt([], Number.MAX_SAFE_INTEGER + 1, limits),
    },
    {
      name: "zero hour cap",
      call: () => earliestRetryAt([], NOW, { perHour: 0, perSevenDays: 5 }),
    },
    {
      name: "unsafe week cap",
      call: () =>
        earliestRetryAt([], NOW, {
          perHour: 2,
          perSevenDays: Number.MAX_SAFE_INTEGER + 1,
        }),
    },
    {
      name: "hour cap exceeds week cap",
      call: () => earliestRetryAt([], NOW, { perHour: 6, perSevenDays: 5 }),
    },
    {
      name: "non-array reservations",
      call: () =>
        earliestRetryAt(
          null as unknown as readonly BudgetReservationV1[],
          NOW,
          limits,
        ),
    },
  ];
  for (const item of cases) {
    assert.throws(item.call, (error: unknown) => {
      if (!(error instanceof RangeError)) return false;
      // Fixed sanitized detail: the message never echoes input values.
      assert.match(error.message, /^earliestRetryAt: /);
      assert.ok(!error.message.includes("NaN"));
      assert.ok(!error.message.includes("" + Number.MAX_SAFE_INTEGER));
      return true;
    }, item.name);
  }
});
