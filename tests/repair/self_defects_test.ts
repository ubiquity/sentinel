/**
 * Self-observation core tests: allowlisted extraction, normalization identity,
 * dedup against existing markers and the per-pass issue cap. Pure functions
 * only; no network, state, model or Git access, and every log fixture below is
 * synthetic.
 */
import assert from "node:assert/strict";

import {
  extractSelfFailureSignature,
  planSelfObservations,
  SELF_DEFECT_MAX_ISSUES_PER_PASS,
  selfDefectMarker,
  type SelfFailureV1,
} from "../../ops/self-defects.ts";

const RUN: SelfFailureV1 = {
  runId: 111,
  workflow: "sentinel-ci",
  job: "test-local",
  conclusion: "failure",
  createdAt: "2026-09-23T18:18:46Z",
};

Deno.test("self defects: a runner shutdown is its own stable signature", () => {
  const log = "2026-09-23T20:34:38Z ##[error]The runner has received a " +
    "shutdown signal. This can happen when the runner service is stopped\n" +
    "Process completed with exit code 143.";
  const first = extractSelfFailureSignature(log, RUN);
  const second = extractSelfFailureSignature(log, { ...RUN, runId: 222 });
  assert.equal(first.key, second.key, "same class, same key");
  assert.match(first.summary, /runner was shut down/);
});

Deno.test("self defects: an Actions cancellation is its own stable signature", () => {
  const signature = extractSelfFailureSignature(
    "nothing useful here\n",
    { ...RUN, conclusion: "cancelled" },
  );
  const fromLog = extractSelfFailureSignature(
    "##[error]The operation was canceled.\n",
    RUN,
  );
  assert.deepEqual(fromLog, signature);
  assert.match(signature.key, /:test-local:cancelled:/);
  assert.equal(signature.summary, "the job was cancelled before it completed");
});

Deno.test("self defects: normalization makes one class out of shifting values", () => {
  const a = extractSelfFailureSignature(
    "TS2304 [ERROR]: Cannot find name 'X' at ./src/a.ts:12:3\n",
    RUN,
  );
  const b = extractSelfFailureSignature(
    "TS2304 [ERROR]: Cannot find name 'X' at ./src/b.ts:99:7\n",
    RUN,
  );
  assert.equal(a.key, b.key, "paths and positions are redacted");
  assert.equal(a.summary, "type error: TS2304");
});

Deno.test("self defects: CI job display names remain allowlisted", () => {
  for (
    const job of [
      "quality",
      "test-local",
      "test-shards (modules)",
      "test-shards (integration)",
      "test-shards (host-1)",
      "test-shards (host-2)",
      "test-shards (host-3)",
    ]
  ) {
    const signature = extractSelfFailureSignature("no useful log output\n", {
      ...RUN,
      job,
    });
    const expectedJob = job.startsWith("test-shards (") ? "test-shards" : job;
    assert.equal(signature.key, `sentinel-ci:${expectedJob}:job:observed`);
  }
});

Deno.test("self defects: assertion and generic error lines are extracted", () => {
  const assertion = extractSelfFailureSignature(
    "error: AssertionError: unexpected github calls: readRef, createPr\n",
    RUN,
  );
  assert.match(assertion.key, /:test-local:assertion:/);
  const generic = extractSelfFailureSignature(
    "some context\n\nerror: Test failed\n",
    RUN,
  );
  assert.match(generic.key, /:test-local:error:/);
  const exit = extractSelfFailureSignature(
    "##[error]Process completed with exit code 143\n",
    RUN,
  );
  assert.match(exit.key, /:test-local:exit:/);
  const none = extractSelfFailureSignature("nothing useful here\n", RUN);
  assert.match(none.key, /:test-local:job:/);
  assert.match(none.summary, /no allowlisted log pattern/);
});

Deno.test("self defects: planning dedups markers, caps the pass and counts runs", () => {
  const signature = extractSelfFailureSignature(
    "error: AssertionError: boom\n",
    RUN,
  );
  const failures = [
    { ...RUN, runId: 1, signature },
    { ...RUN, runId: 2, signature },
    {
      ...RUN,
      runId: 3,
      workflow: "sentinel-supervisor",
      signature: extractSelfFailureSignature(
        "error: another distinct failure\n",
        { ...RUN, workflow: "sentinel-supervisor" },
      ),
    },
    {
      ...RUN,
      runId: 4,
      workflow: "sentinel-repair",
      signature: extractSelfFailureSignature(
        "TS2339 [ERROR]: Property does not exist\n",
        { ...RUN, workflow: "sentinel-repair" },
      ),
    },
  ];
  const planned = planSelfObservations({
    failures,
    existingMarkers: [],
  });
  assert.equal(planned.length, SELF_DEFECT_MAX_ISSUES_PER_PASS);
  assert.equal(planned[0]!.occurrences, 2, "most observed first");
  assert.deepEqual(planned[0]!.runIds, [1, 2]);
  assert.ok(planned[0]!.body.includes(selfDefectMarker(planned[0]!.key)));
  assert.ok(
    !planned[0]!.body.includes("boom"),
    "arbitrary assertion detail is private",
  );

  const deduped = planSelfObservations({
    failures,
    existingMarkers: [selfDefectMarker(planned[0]!.key)],
  });
  assert.equal(deduped.length, 2);
  assert.ok(
    deduped.every((issue) => issue.key !== planned[0]!.key),
    "an already-filed class is never refiled",
  );
});
