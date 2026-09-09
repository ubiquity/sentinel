// Review request/observation suite: exactly-one submission with exact
// PR/head/base/reviewer binding, operation-key reconciliation across lost
// responses, and fail-closed normalization — pending, completed-clean,
// finding-bearing, missing findings, stale heads, wrong authors, CodeRabbit,
// malformed service evidence, impossible completion times. Receipt
// derivation is validated by the frozen parser.
import assert from "node:assert/strict";

import type {
  ReviewObservationRequestV1,
  ReviewSubmissionV1,
} from "../../src/contracts/ports.ts";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { deriveReviewReceiptV1 } from "../../src/github/review-normalize.ts";
import {
  commentWire,
  completedServiceRead,
  defaultServiceReceipt,
  FakeClock,
  FakeReviewService,
  httpRespond,
  makePort,
  pullWire,
  REPO,
  REVIEWER,
  reviewWire,
  SHA1,
  SHA2,
  SHA3,
  SHA4,
  T0,
} from "./helpers.ts";
import type { ScriptEntry } from "./helpers.ts";

function submitRequest(
  overrides: Partial<ReviewSubmissionV1> = {},
): ReviewSubmissionV1 {
  return {
    prNumber: 1,
    expectedHead: SHA1,
    expectedBase: SHA2,
    expectedReviewer: REVIEWER,
    operationKey: "review:work-1",
    ...overrides,
  };
}

function observeRequest(
  overrides: Partial<ReviewObservationRequestV1> = {},
): ReviewObservationRequestV1 {
  return {
    operationKey: "review:work-1",
    prNumber: 1,
    head: SHA1,
    ...overrides,
  };
}

function observeScript(
  scripts: (ScriptEntry | ScriptEntry[])[],
): ScriptEntry[] {
  return scripts.flat();
}

const PR_READ: ScriptEntry = {
  ...httpRespond(
    "GET",
    "/repos/ubiquity/sentinel/pulls/1",
    200,
    pullWire({
      number: 1,
      head: { ref: "sentinel/fix-1", sha: SHA1 },
      base: { ref: "development", sha: SHA2 },
    }),
  ),
  repeat: true,
};

function reviewsRead(reviews: unknown[]): ScriptEntry {
  return {
    ...httpRespond(
      "GET",
      "/repos/ubiquity/sentinel/pulls/1/reviews?per_page=100&page=1",
      200,
      reviews,
    ),
    repeat: true,
  };
}

function commentsRead(comments: unknown[]): ScriptEntry {
  return {
    ...httpRespond(
      "GET",
      "/repos/ubiquity/sentinel/pulls/1/comments?per_page=100&page=1",
      200,
      comments,
    ),
    repeat: true,
  };
}

Deno.test("requestReview: exactly one submission with exact identities", async () => {
  const service = new FakeReviewService();
  service.submitResult = {
    status: "submitted",
    requestId: "req-77",
    requestedAt: T0 + 1000,
  };
  const { port, transport } = makePort({ script: [PR_READ], review: service });
  const result = await port.requestReview(submitRequest());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    outcome: "applied",
    requestId: "req-77",
    requestedAt: T0 + 1000,
  });
  assert.equal(service.submits.length, 1);
  assert.deepEqual(service.submits[0], {
    operationKey: "review:work-1",
    prNumber: 1,
    expectedHead: SHA1,
    expectedBase: SHA2,
    expectedReviewer: REVIEWER,
  });
  assert.equal(transport.requests.length, 1); // one PR read, zero retries

  // A second call is a separate request — never an automatic retry.
  await port.requestReview(submitRequest());
  assert.equal(service.submits.length, 2);
});

Deno.test("requestReview: identity mismatches and non-open PRs fail before submission", async () => {
  const service = new FakeReviewService();
  const { port } = makePort({
    script: [PR_READ],
    review: service,
  });
  const wrongHead = await port.requestReview(submitRequest({
    expectedHead: SHA2,
  }));
  assert.equal(wrongHead.ok, false);
  if (!wrongHead.ok) assert.equal(wrongHead.error.kind, "conflict");

  const wrongBase = await port.requestReview(submitRequest({
    expectedBase: SHA1,
  }));
  assert.equal(wrongBase.ok, false);
  if (!wrongBase.ok) assert.equal(wrongBase.error.kind, "conflict");

  const wrongReviewer = await port.requestReview(submitRequest({
    expectedReviewer: "coderabbitai[bot]",
  }));
  assert.equal(wrongReviewer.ok, false);
  if (!wrongReviewer.ok) assert.equal(wrongReviewer.error.kind, "invalid");

  const closedPort = makePort({
    script: [
      httpRespond(
        "GET",
        "/repos/ubiquity/sentinel/pulls/1",
        200,
        pullWire({
          state: "closed",
        }),
      ),
    ],
  });
  const closed = await closedPort.port.requestReview(submitRequest());
  assert.equal(closed.ok, false);
  if (!closed.ok) assert.equal(closed.error.kind, "conflict");

  const missingPort = makePort({
    script: [httpRespond("GET", "/repos/ubiquity/sentinel/pulls/404", 404, {})],
  });
  const missing = await missingPort.port.requestReview(submitRequest({
    prNumber: 404,
  }));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.kind, "not_found");

  assert.equal(service.submits.length, 0, "no submission after any conflict");
});

Deno.test("requestReview: lost response is ambiguous, rejection is a typed conflict", async () => {
  const service = new FakeReviewService();
  service.submitResult = { status: "ambiguous" };
  const { port } = makePort({ script: [PR_READ], review: service });
  const ambiguous = await port.requestReview(submitRequest());
  assert.ok(ambiguous.ok);
  if (!ambiguous.ok) return;
  assert.deepEqual(ambiguous.value, {
    outcome: "ambiguous",
    requestId: null,
    requestedAt: T0,
  });

  service.submitResult = { status: "rejected" };
  const rejected = await port.requestReview(submitRequest());
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.kind, "conflict");
  assert.equal(service.submits.length, 2);
});

Deno.test("observeReview: pending stays pending and unresolved ids fail closed", async () => {
  const service = new FakeReviewService();
  service.readResult = defaultServiceReceipt({
    status: "pending",
    requestId: "req-1",
    resultId: null,
    completedAt: null,
    summary: null,
    terminalTurnSucceeded: false,
    outputPresent: false,
  });
  const { port } = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([[PR_READ], reviewsRead([]), commentsRead([])]),
    review: service,
  });
  const observed = await port.observeReview(observeRequest());
  assert.ok(observed.ok);
  if (!observed.ok) return;
  assert.equal(observed.value.status, "pending");
  assert.equal(observed.value.requestId, "req-1");
  assert.equal(observed.value.reviewer, null);
  assert.equal(observed.value.findings.length, 0);
  assert.equal(observed.value.observedHead, SHA1);
  assert.equal(observed.value.observedBase, SHA2);

  // A pending read without a request id cannot be verified: unavailable.
  service.readResult = defaultServiceReceipt({
    status: "pending",
    requestId: null,
    resultId: null,
    completedAt: null,
    summary: null,
    terminalTurnSucceeded: false,
    outputPresent: false,
  });
  const unseen = await port.observeReview(observeRequest());
  assert.ok(unseen.ok);
  if (!unseen.ok) return;
  assert.equal(unseen.value.status, "unavailable");
});

Deno.test("observeReview: completed requires terminal provenance, review author and exact head", async () => {
  // Completed by the service but no GitHub review by the expected reviewer
  // (CodeRabbit only): unavailable.
  const service = new FakeReviewService();
  service.readResult = completedServiceRead();
  const { port } = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([reviewWire({
        id: 5,
        user: { login: "coderabbitai[bot]" },
        state: "APPROVED",
      })]),
      commentsRead([]),
    ]),
    review: service,
  });
  const coderabbit = await port.observeReview(observeRequest());
  assert.ok(coderabbit.ok);
  if (!coderabbit.ok) return;
  assert.equal(coderabbit.value.status, "unavailable");

  // Stale head: the PR moved after the completed review.
  const stalePort = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: [
      httpRespond(
        "GET",
        "/repos/ubiquity/sentinel/pulls/1",
        200,
        pullWire({
          head: { ref: "sentinel/fix-1", sha: SHA2 },
          base: { ref: "development", sha: SHA2 },
        }),
      ),
      reviewsRead([reviewWire({ commit_id: SHA2 })]),
      commentsRead([]),
    ],
    review: service,
  });
  const stale = await stalePort.port.observeReview(observeRequest());
  assert.ok(stale.ok);
  if (!stale.ok) return;
  assert.equal(stale.value.status, "unavailable");
  assert.equal(stale.value.observedHead, SHA2);

  // Malformed completion evidence: missing terminal success/output/result.
  for (
    const override of [
      { terminalTurnSucceeded: false },
      { outputPresent: false },
      { resultId: null },
      { completedAt: null },
    ]
  ) {
    service.readResult = completedServiceRead(override);
    const malformed = await port.observeReview(observeRequest());
    assert.ok(malformed.ok);
    if (!malformed.ok) return;
    assert.equal(
      malformed.value.status,
      "unavailable",
      JSON.stringify(override),
    );
    if (malformed.value.status !== "unavailable") return;
  }

  // Completion in the future is unverifiable under the observation clock.
  service.readResult = completedServiceRead({
    completedAt: T0 + 10_000_000,
  });
  const future = await port.observeReview(observeRequest());
  assert.ok(future.ok);
  if (!future.ok) return;
  assert.equal(future.value.status, "unavailable");
});

Deno.test("observeReview: completed clean requires the exact reviewer review on the exact head", async () => {
  const service = new FakeReviewService();
  service.readResult = completedServiceRead();
  const { port } = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([
        reviewWire({ id: 100, state: "APPROVED", body: "no issues found" }),
      ]),
      commentsRead([]),
    ]),
    review: service,
  });
  const observed = await port.observeReview(observeRequest());
  assert.ok(observed.ok);
  if (!observed.ok) return;
  assert.equal(observed.value.status, "completed");
  assert.equal(observed.value.reviewer, REVIEWER);
  assert.equal(observed.value.requestId, "req-1");
  assert.equal(observed.value.resultId, "result-9");
  assert.equal(observed.value.completedAt, T0 + 120_000);
  assert.deepEqual(observed.value.findings, []);
  assert.equal(observed.value.summary, "no issues found");
  assert.equal(observed.value.observedHead, SHA1);

  // Reactions and extra wire fields are ignored; extra fields on the review
  // object never manufacture a verdict.
  const reactionPort = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([{
        ...reviewWire({ id: 100, state: "APPROVED", body: "no issues found" }),
        reactions: { total_count: 3, heart: 1 },
      }]),
      commentsRead([]),
    ]),
    review: service,
  });
  const withReactions = await reactionPort.port.observeReview(observeRequest());
  assert.ok(withReactions.ok);
  if (!withReactions.ok) return;
  assert.equal(withReactions.value.status, "completed");
  assert.deepEqual(withReactions.value.findings, []);
});

Deno.test("observeReview: finding-bearing completions carry the full parsed findings", async () => {
  const service = new FakeReviewService();
  service.readResult = completedServiceRead();
  const { port } = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([reviewWire({
        id: 100,
        state: "CHANGES_REQUESTED",
        body: "[P2] tests could be tightened\n[P1] broken error handling",
      })]),
      commentsRead([
        commentWire({ id: 500, body: "[P1] broken error handling" }),
        commentWire({ id: 501, body: "looks reasonable" }),
        commentWire({ id: 502, body: "**P2** naming is confusing" }),
      ]),
    ]),
    review: service,
  });
  const observed = await port.observeReview(observeRequest());
  assert.ok(observed.ok);
  if (!observed.ok) return;
  assert.equal(observed.value.status, "completed");
  assert.equal(observed.value.findings.length, 4);
  const severities = observed.value.findings
    .map((finding) => finding.severity)
    .sort();
  // Findings are a full set; the exact delivery order is not part of the
  // contract, only completeness and exact identities.
  assert.deepEqual(severities, ["P1", "P1", "P2", "P2"]);
  const p1 = observed.value.findings.find((finding) =>
    finding.severity === "P1"
  );
  assert.ok(p1 !== undefined);
  assert.equal(p1.path, "src/main.ts");
  assert.equal(p1.resolved, false);
  assert.equal(p1.id, "github-comment-500");
  // Fingerprints are SHA-256 of the canonical finding identity.
  assert.match(p1.fingerprint, /^[0-9a-f]{64}$/);
});

Deno.test("observeReview: service-unavailable and finding-cap overflow are unavailable", async () => {
  const service = new FakeReviewService();
  service.readResult = defaultServiceReceipt({
    status: "unavailable",
    requestId: null,
    resultId: null,
    completedAt: null,
    summary: null,
    terminalTurnSucceeded: false,
    outputPresent: false,
  });
  const { port } = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([[PR_READ], reviewsRead([]), commentsRead([])]),
    review: service,
  });
  const unavailable = await port.observeReview(observeRequest());
  assert.ok(unavailable.ok);
  if (!unavailable.ok) return;
  assert.equal(unavailable.value.status, "unavailable");

  // More finding-bearing comments than the cap: incomplete, never a partial
  // finding set claiming completeness.
  service.readResult = completedServiceRead();
  const overCap = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([
        reviewWire({ id: 100, state: "CHANGES_REQUESTED", body: null }),
      ]),
      commentsRead(
        Array.from(
          { length: 3 },
          (_, index) => commentWire({ id: 1000 + index, body: "[P2] note" }),
        ),
      ),
    ]),
    review: service,
    findingCap: 2,
  });
  const capped = await overCap.port.observeReview(observeRequest());
  assert.ok(capped.ok);
  if (!capped.ok) return;
  assert.equal(capped.value.status, "unavailable");
});

Deno.test("observeReview: CHANGES_REQUESTED without parseable findings is unavailable", async () => {
  const service = new FakeReviewService();
  service.readResult = completedServiceRead();
  const { port } = makePort({
    script: observeScript([
      [PR_READ],
      reviewsRead([
        reviewWire({
          id: 100,
          state: "CHANGES_REQUESTED",
          body: "please fix things",
        }),
      ]),
      commentsRead([commentWire({ id: 500, body: "please fix things" })]),
    ]),
    review: service,
  });
  const observed = await port.observeReview(observeRequest());
  assert.ok(observed.ok);
  if (!observed.ok) return;
  assert.equal(observed.value.status, "unavailable");
});

Deno.test("observeReview: wrong-author comments never count as findings", async () => {
  const service = new FakeReviewService();
  service.readResult = completedServiceRead();
  const { port } = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([
        reviewWire({ id: 100, state: "APPROVED", body: "no issues found" }),
      ]),
      commentsRead([commentWire({
        id: 600,
        body: "[P1] planted by another bot",
        user: { login: "coderabbitai[bot]" },
      })]),
    ]),
    review: service,
  });
  const observed = await port.observeReview(observeRequest());
  assert.ok(observed.ok);
  if (!observed.ok) return;
  assert.equal(observed.value.status, "completed");
  assert.deepEqual(observed.value.findings, []);
});

Deno.test("review receipts: derived and validated by the frozen parser", async () => {
  const submission = {
    operationKey: "review:work-1",
    submittedAt: T0 + 1000,
    prNumber: 1,
    expectedHead: SHA1,
    expectedBase: SHA2,
    expectedReviewer: REVIEWER,
  };
  const service = new FakeReviewService();
  service.readResult = completedServiceRead({ githubReviewId: 102 });
  const { port } = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([
        reviewWire({ id: 102, state: "APPROVED", body: "no issues found" }),
      ]),
      commentsRead([]),
    ]),
    review: service,
  });
  const observed = await port.observeReview(observeRequest());
  assert.ok(observed.ok);
  if (!observed.ok) return;
  const receipt = deriveReviewReceiptV1(observed.value, submission, REPO);
  assert.equal(receipt.outcome, "completed");
  assert.equal(receipt.requestId, "req-1");
  assert.equal(receipt.resultId, "result-9");
  assert.equal(receipt.observedReviewer, REVIEWER);
  assert.equal(receipt.findingsUncounted, 0);
  assert.deepEqual(receipt.unresolvedSeverities, []);
  assert.equal(receipt.pullRequest.head, SHA1);
  assert.equal(receipt.pullRequest.base, SHA2);
  assert.equal(receipt.observedAt, T0 + 200_000);

  // Pending receipts parse too.
  service.readResult = completedServiceRead({
    status: "pending",
    requestId: "req-1",
    resultId: null,
    completedAt: null,
    terminalTurnSucceeded: false,
    outputPresent: false,
  });
  const pendingObs = await port.observeReview(observeRequest());
  assert.ok(pendingObs.ok);
  if (!pendingObs.ok) return;
  const pending = deriveReviewReceiptV1(pendingObs.value, submission, REPO);
  assert.equal(pending.outcome, "pending");
  assert.equal(pending.completedAt, null);

  // A completed observation whose service completion predates the recorded
  // submission cannot be derived: fail closed with the same parser.
  service.readResult = completedServiceRead({
    githubReviewId: 102,
    completedAt: T0 + 500,
  });
  const staleObs = await port.observeReview(observeRequest());
  assert.ok(staleObs.ok);
  if (!staleObs.ok) return;
  assert.throws(
    () => deriveReviewReceiptV1(staleObs.value, submission, REPO),
  );

  // Findings enrich the derived receipt with correct derived severities.
  service.readResult = completedServiceRead({ githubReviewId: 103 });
  const findingPort = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([
        reviewWire({ id: 103, state: "CHANGES_REQUESTED", body: null }),
      ]),
      commentsRead([
        commentWire({ id: 700, body: "[P1] broken error handling" }),
      ]),
    ]),
    review: service,
  });
  const findingObs = await findingPort.port.observeReview(observeRequest());
  assert.ok(findingObs.ok);
  if (!findingObs.ok) return;
  const findingReceipt = parseReviewReceiptV1({
    version: "v1",
    kind: "review_receipt",
    id: "review-1",
    requestId: findingObs.value.requestId,
    expectedReviewer: REVIEWER,
    observedReviewer: findingObs.value.reviewer,
    repository: REPO,
    pullRequest: { number: 1, head: SHA1, base: SHA2 },
    outcome: findingObs.value.status,
    resultId: findingObs.value.resultId,
    summary: findingObs.value.summary,
    findings: findingObs.value.findings,
    findingsUncounted: 0,
    unresolvedSeverities: ["P1"],
    submittedAt: submission.submittedAt,
    completedAt: findingObs.value.completedAt,
    observedAt: findingObs.value.receivedAt,
  });
  assert.deepEqual(findingReceipt.unresolvedSeverities, ["P1"]);
});

Deno.test("observeReview: commented review with a minus-bullet finding preserves the full message", async () => {
  const service = new FakeReviewService();
  service.readResult = completedServiceRead();
  const { port } = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([
        reviewWire({
          id: 100,
          state: "COMMENTED",
          body: "Review findings below",
        }),
      ]),
      commentsRead([
        commentWire({ id: 500, body: "- [P1] Fix credential exposure" }),
      ]),
    ]),
    review: service,
  });
  const observed = await port.observeReview(observeRequest());
  assert.ok(observed.ok);
  if (!observed.ok) return;
  assert.equal(observed.value.status, "completed");
  assert.equal(observed.value.findings.length, 1);
  const finding = observed.value.findings[0];
  assert.equal(finding.severity, "P1");
  assert.equal(finding.id, "github-comment-500");
  // The FULL original message is preserved, label and bullet included.
  assert.equal(finding.message, "- [P1] Fix credential exposure");
  assert.equal(finding.resolved, false);
  assert.match(finding.fingerprint, /^[0-9a-f]{64}$/);
});

Deno.test("observeReview: unparseable badge finding never yields completed empty findings", async () => {
  const service = new FakeReviewService();
  service.readResult = completedServiceRead();
  const { port } = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([
        reviewWire({
          id: 100,
          state: "COMMENTED",
          body: "Review findings below",
        }),
      ]),
      commentsRead([
        commentWire({
          id: 500,
          body:
            "![P1 Badge](https://example.invalid/P1) Fix credential exposure",
        }),
      ]),
    ]),
    review: service,
  });
  const observed = await port.observeReview(observeRequest());
  assert.ok(observed.ok);
  if (!observed.ok) return;
  // Incomplete finding evidence: unavailable, never a completed empty set.
  assert.equal(observed.value.status, "unavailable");
  assert.equal(observed.value.findings.length, 0);
});

Deno.test("observeReview: exact-id review binding, not latest by time", async () => {
  // The recorded result is id 100 but a LATER review by the same reviewer on
  // the same head exists: the recorded result is no longer authoritative.
  const service = new FakeReviewService();
  service.readResult = completedServiceRead();
  const { port } = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([
        reviewWire({
          id: 100,
          state: "APPROVED",
          body: "no issues found",
          submitted_at: "2026-09-07T01:00:00Z",
        }),
        reviewWire({
          id: 101,
          state: "APPROVED",
          body: "later approval",
          submitted_at: "2026-09-07T02:00:00Z",
        }),
      ]),
      commentsRead([]),
    ]),
    review: service,
  });
  const observed = await port.observeReview(observeRequest());
  assert.ok(observed.ok);
  if (!observed.ok) return;
  assert.equal(observed.value.status, "unavailable");

  // The recorded result is the latest review by the exact id: completed.
  const serviceOk = new FakeReviewService();
  serviceOk.readResult = completedServiceRead({ githubReviewId: 101 });
  const okPort = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([
        reviewWire({
          id: 100,
          state: "APPROVED",
          body: "no issues found",
          submitted_at: "2026-09-07T01:00:00Z",
        }),
        reviewWire({
          id: 101,
          state: "APPROVED",
          body: "later approval",
          submitted_at: "2026-09-07T02:00:00Z",
        }),
      ]),
      commentsRead([]),
    ]),
    review: serviceOk,
  });
  const ok = await okPort.port.observeReview(observeRequest());
  assert.ok(ok.ok);
  if (!ok.ok) return;
  assert.equal(ok.value.status, "completed");
  assert.equal(ok.value.summary, "later approval");
});

Deno.test("observeReview: missing or contradictory service binding is unavailable", async () => {
  const cases: {
    name: string;
    override: Parameters<typeof completedServiceRead>[0];
  }[] = [
    {
      name: "wrong-operation-key",
      override: { operationKey: "review:work-2" },
    },
    { name: "wrong-pr", override: { prNumber: 2 } },
    { name: "wrong-head", override: { expectedHead: SHA3 } },
    {
      name: "wrong-reviewer",
      override: { expectedReviewer: "coderabbitai[bot]" },
    },
    {
      name: "wrong-repository",
      override: {
        repository: { owner: "other", name: "repo", installationId: 2 },
      },
    },
    { name: "missing-base", override: { expectedBase: null } },
    { name: "missing-request-id", override: { requestId: null } },
    { name: "missing-github-review-id", override: { githubReviewId: null } },
  ];
  for (const item of cases) {
    const service = new FakeReviewService();
    service.readResult = completedServiceRead(item.override);
    const { port } = makePort({
      clock: new FakeClock(T0 + 200_000),
      script: observeScript([
        [PR_READ],
        [httpRespond("GET", "/repos/ubiquity/sentinel/pulls/2", 404, {})],
        reviewsRead([]),
        commentsRead([]),
      ]),
      review: service,
    });
    const observed = await port.observeReview(observeRequest());
    assert.ok(observed.ok, item.name);
    if (!observed.ok) return;
    assert.equal(observed.value.status, "unavailable", item.name);
    assert.equal(observed.value.findings.length, 0, item.name);
  }
});

Deno.test("observeReview: reviewed base comes from the service record, never the current base", async () => {
  const service = new FakeReviewService();
  service.readResult = completedServiceRead({ expectedBase: SHA3 });
  const { port } = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: [
      httpRespond(
        "GET",
        "/repos/ubiquity/sentinel/pulls/1",
        200,
        pullWire({ base: { ref: "development", sha: SHA4 } }),
      ),
      reviewsRead([reviewWire()]),
      commentsRead([]),
    ],
    review: service,
  });
  const observed = await port.observeReview(observeRequest());
  assert.ok(observed.ok);
  if (!observed.ok) return;
  assert.equal(observed.value.status, "completed");
  assert.equal(observed.value.observedBase, SHA3);
});

Deno.test("observeReview: incomplete finding evidence preserves parsed findings as unavailable", async () => {
  // One parseable P2 finding plus one unparseable marker: unavailable with
  // the parseable finding retained, never a completed clean set.
  const service = new FakeReviewService();
  service.readResult = completedServiceRead();
  const { port } = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([
        reviewWire({
          id: 100,
          state: "COMMENTED",
          body: "Review findings below",
        }),
      ]),
      commentsRead([
        commentWire({ id: 500, body: "[P2] naming is confusing" }),
        commentWire({
          id: 501,
          body:
            "![P1 Badge](https://example.invalid/P1) Fix credential exposure",
        }),
      ]),
    ]),
    review: service,
  });
  const observed = await port.observeReview(observeRequest());
  assert.ok(observed.ok);
  if (!observed.ok) return;
  assert.equal(observed.value.status, "unavailable");
  assert.equal(observed.value.findings.length, 1);
  assert.equal(observed.value.findings[0].severity, "P2");
  assert.equal(observed.value.findings[0].message, "[P2] naming is confusing");
});
