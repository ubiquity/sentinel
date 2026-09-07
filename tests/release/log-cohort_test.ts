// Log cohort parsing: exact gateway event formats, exact identity binding,
// owner-configured classification, dedupe and unreadable evidence counting.
import assert from "node:assert/strict";

import {
  CohortAccumulatorV1,
  parseCohortMessage,
} from "../../src/release/log-cohort.ts";
import { acceptedEvent, DEP_0, DEP_1, terminalEvent } from "./helpers.ts";

const KINDS = {
  timeoutFailureKinds: ["upstream_timeout"],
  upstreamWideFailureKinds: ["upstream_error"],
} as const;

Deno.test("cohort: parses accepted events and binds the exact identity", () => {
  const message = acceptedEvent({
    requestId: "req-1",
    identity: DEP_1,
    timestamp: 0,
  });
  const parse = parseCohortMessage(message, DEP_1);
  assert.equal(parse.kind, "accepted");
  if (parse.kind === "accepted") {
    assert.equal(parse.event.requestId, "req-1");
    assert.equal(parse.event.gitSha, DEP_1.gitSha);
    assert.equal(parse.event.revisionId, DEP_1.revisionId);
  }
});

Deno.test("cohort: terminal classification follows the configured rules only", () => {
  const cases: [string, unknown][] = [
    [
      terminalEvent({
        requestId: "r1",
        identity: DEP_1,
        timestamp: 0,
        status: 502,
      }),
      "five_xx",
    ],
    [
      terminalEvent({
        requestId: "r2",
        identity: DEP_1,
        timestamp: 0,
        failureKind: "upstream_timeout",
      }),
      "timeout",
    ],
    [
      terminalEvent({
        requestId: "r3",
        identity: DEP_1,
        timestamp: 0,
        stream: true,
        streamTerminalType: "error",
      }),
      "stream",
    ],
    [
      terminalEvent({
        requestId: "r4",
        identity: DEP_1,
        timestamp: 0,
        status: 502,
        failureKind: "upstream_error",
      }),
      "upstream",
    ],
  ] as const;
  const accumulator = new CohortAccumulatorV1();
  // Every failing request also has its accepted event in the same cohort.
  for (const requestId of ["r1", "r2", "r3", "r4"]) {
    accumulator.add(
      parseCohortMessage(
        acceptedEvent({
          requestId,
          identity: DEP_1,
          timestamp: 0,
        }),
        DEP_1,
      ),
      KINDS,
    );
  }
  for (const [message] of cases) {
    accumulator.add(parseCohortMessage(message, DEP_1), KINDS);
  }
  const counts = accumulator.counts();
  assert.equal(counts.acceptedCount, 4);
  assert.equal(counts.fiveXxCount, 2); // r1 and r4 both 5xx
  assert.equal(counts.timeoutCount, 1);
  assert.equal(counts.streamFailureCount, 1);
  assert.equal(counts.upstreamWideCount, 1);
  assert.equal(counts.unreadableCount, 0);
  assert.equal(counts.unresolvedOutcomeCount, 0);
});

Deno.test("cohort: a terminal outside the accepted cohort contributes nothing", () => {
  const accumulator = new CohortAccumulatorV1();
  accumulator.add(
    parseCohortMessage(
      acceptedEvent({ requestId: "r1", identity: DEP_1, timestamp: 0 }),
      DEP_1,
    ),
    KINDS,
  );
  // A terminal for a request whose accepted event belongs to another window
  // (or is missing) is NOT part of this scan's denominator cohort.
  accumulator.add(
    parseCohortMessage(
      terminalEvent({
        requestId: "r9",
        identity: DEP_1,
        timestamp: 0,
        status: 503,
      }),
      DEP_1,
    ),
    KINDS,
  );
  const counts = accumulator.counts();
  assert.equal(counts.acceptedCount, 1);
  assert.equal(counts.fiveXxCount, 0);
  assert.equal(counts.timeoutCount, 0);
  assert.equal(counts.streamFailureCount, 0);
  assert.equal(counts.upstreamWideCount, 0);
  assert.equal(counts.unreadableCount, 0);
  assert.equal(counts.unresolvedOutcomeCount, 1);
});

Deno.test("cohort: a terminals-only scan emits consistent zero counts, never inconsistent metrics", () => {
  // Review repro: a request accepted in the previous window terminates in
  // this window. The denominator must not be smaller than any failure count;
  // the only consistent outcome is the same cohort for both: nothing here.
  const accumulator = new CohortAccumulatorV1();
  accumulator.add(
    parseCohortMessage(
      terminalEvent({
        requestId: "crossing",
        identity: DEP_1,
        timestamp: 0,
        status: 502,
      }),
      DEP_1,
    ),
    KINDS,
  );
  const counts = accumulator.counts();
  assert.equal(counts.acceptedCount, 0);
  assert.equal(counts.fiveXxCount, 0);
  assert.equal(counts.timeoutCount, 0);
  assert.equal(counts.streamFailureCount, 0);
  assert.equal(counts.upstreamWideCount, 0);
  assert.equal(counts.unreadableCount, 0);
  assert.equal(counts.unresolvedOutcomeCount, 1);
});

Deno.test("cohort: duplicates are deduplicated per request id", () => {
  const accumulator = new CohortAccumulatorV1();
  const accepted = acceptedEvent({
    requestId: "dup",
    identity: DEP_1,
    timestamp: 0,
  });
  const terminal = terminalEvent({
    requestId: "dup",
    identity: DEP_1,
    timestamp: 0,
    status: 503,
  });
  accumulator.add(parseCohortMessage(accepted, DEP_1), KINDS);
  accumulator.add(parseCohortMessage(accepted, DEP_1), KINDS);
  accumulator.add(parseCohortMessage(terminal, DEP_1), KINDS);
  accumulator.add(parseCohortMessage(terminal, DEP_1), KINDS);
  const counts = accumulator.counts();
  assert.equal(counts.acceptedCount, 1);
  assert.equal(counts.fiveXxCount, 1);
  assert.equal(counts.unresolvedOutcomeCount, 0);
});

Deno.test("cohort: wrong identity or malformed evidence is unreadable, never counted", () => {
  const accumulator = new CohortAccumulatorV1();
  const wrongSha = acceptedEvent({
    requestId: "r1",
    identity: DEP_0,
    timestamp: 0,
  });
  accumulator.add(parseCohortMessage(wrongSha, DEP_1), KINDS);
  accumulator.add(
    parseCohortMessage("[ai.ubq.fi] request_terminal {broken", DEP_1),
    KINDS,
  );
  accumulator.add(
    parseCohortMessage(
      `[ai.ubq.fi] request_accepted ${
        JSON.stringify({
          request_id: "r2",
          git_sha: DEP_1.gitSha,
          deno_revision: DEP_1.revisionId,
        })
      }`,
      DEP_1,
    ),
    KINDS,
  );
  accumulator.add(
    parseCohortMessage("regular app log line", DEP_1),
    KINDS,
  );
  const counts = accumulator.counts();
  assert.equal(counts.acceptedCount, 0);
  assert.equal(counts.unreadableCount, 3);
  assert.equal(counts.unresolvedOutcomeCount, 0);
});

Deno.test("cohort: oversized and non-string fields are unreadable", () => {
  const big = `[ai.ubq.fi] request_accepted ${"x".repeat(17000)}`;
  const parse = parseCohortMessage(big, DEP_1);
  assert.equal(parse.kind, "unreadable");
  const badStatus = `[ai.ubq.fi] request_terminal ${
    JSON.stringify({
      request_id: "r",
      route: "r",
      status: "not-a-number",
      delivery_outcome: "delivered",
      stream: null,
      stream_terminal_type: null,
      failure_kind: null,
      git_sha: DEP_1.gitSha,
      deno_revision: DEP_1.revisionId,
    })
  }`;
  assert.equal(parseCohortMessage(badStatus, DEP_1).kind, "unreadable");
});
