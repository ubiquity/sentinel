// Review request/observation suite: exactly-one submission with exact
// PR/head/base/reviewer binding, operation-key reconciliation across lost
// responses, and fail-closed normalization — pending, structured completed
// clean, structured finding-bearing, stale heads, wrong authors, CodeRabbit,
// malformed service evidence, impossible completion times, old prose bodies.
// Completion authorization consumes ONLY the strict structured journal, so the
// positive fixtures below render a real ready journal whose digest, result id
// and completion time bind to the service receipt; prose fixtures remain as
// explicit negative coverage. Receipt derivation is validated by the frozen
// parser.
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  ReviewObservationRequestV1,
  ReviewSubmissionV1,
} from "../../src/contracts/ports.ts";
import {
  deriveUnresolvedSeverities,
  parseReviewReceiptV1,
} from "../../src/contracts/review-receipt.ts";
import {
  renderReviewJournalBody,
  REVIEW_MODEL,
  REVIEW_REASONING,
  type ReviewJournalReadyV1,
  reviewResultDigest,
  type ReviewResultV1,
} from "../../src/github/review-journal.ts";
import { deriveReviewReceiptV1 } from "../../src/github/review-normalize.ts";
import type { ReviewServiceReadV1 } from "../../src/github/review-service.ts";
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
    latestStartAt: T0 + 60_000,
    settleBy: T0 + 660_000,
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

// ---------------------------------------------------------------------------
// Structured review fixtures (the production completion authority)
// ---------------------------------------------------------------------------

const STRUCTURED_CLEAN: ReviewResultV1 = {
  verdict: "clean",
  summary: "no issues found",
  findings: [],
};

const STRUCTURED_FINDINGS: ReviewResultV1 = {
  verdict: "findings",
  summary: "two issues found",
  findings: [
    {
      priority: 1,
      title: "Broken error handling",
      body: "The handler swallows errors.\n\nIt must surface them.",
      path: "src/main.ts",
      lineStart: 10,
      lineEnd: 12,
    },
    {
      priority: 2,
      title: "Naming is confusing",
      body: "Rename the flag.",
      path: "src/main.ts",
      lineStart: 20,
      lineEnd: 20,
    },
  ],
};

interface StructuredFixtureOptionsV1 {
  result?: ReviewResultV1;
  reviewId?: number;
  expectedBase?: GitSha;
  requestedAt?: number;
  completedAt?: number;
  service?: Partial<ReviewServiceReadV1>;
  wire?: Record<string, unknown>;
}

/** One internally consistent ready journal for the canonical identities. */
async function readyJournalFor(
  options: StructuredFixtureOptionsV1 = {},
): Promise<ReviewJournalReadyV1> {
  const result = options.result ?? STRUCTURED_CLEAN;
  const reviewId = options.reviewId ?? 100;
  const requestedAt = options.requestedAt ?? T0 + 1000;
  const completedAt = options.completedAt ?? T0 + 120_000;
  return {
    version: "v1",
    phase: "ready",
    repository: { owner: REPO.owner, name: REPO.name },
    prNumber: 1,
    expectedHead: SHA1,
    expectedBase: options.expectedBase ?? SHA2,
    operationKey: "review:work-1",
    publisher: REVIEWER,
    requestId: "req-1",
    requestedAt,
    reviewId,
    completedAt,
    result,
    resultDigest: await reviewResultDigest(result),
    execution: {
      ownerRunId: "run-1",
      invocationId: "review-invocation-review:work-1",
      threadId: "thread-1",
      submittedProvider: "openai",
      model: REVIEW_MODEL,
      reasoning: REVIEW_REASONING,
      startMayOccur: true,
      turnId: "turn-1",
      resultId: "result-9",
      actual: {
        evidenceKind: "request-runtime",
        provider: "openai",
        threadId: "thread-1",
        turnId: "turn-1",
        terminalOrigin: "runtime",
        observedTerminalStatus: "completed",
        observedModel: REVIEW_MODEL,
        observedReasoning: REVIEW_REASONING,
        durationMs: 5,
        outputChars: 10,
      },
    },
  };
}

/**
 * One internally consistent structured completion: the rendered ready journal,
 * its exact standing GitHub review wire and the service receipt bound to the
 * SAME digest, result id, review id and completion time.
 */
async function completedFixture(
  options: StructuredFixtureOptionsV1 = {},
): Promise<{
  body: string;
  review: Record<string, unknown>;
  service: ReviewServiceReadV1;
}> {
  const journal = await readyJournalFor(options);
  const body = renderReviewJournalBody(journal);
  return {
    body,
    review: reviewWire({
      id: journal.reviewId,
      state: "COMMENTED",
      body,
      commit_id: SHA1,
      submitted_at: "2026-09-07T01:00:00Z",
      ...options.wire,
    }),
    service: completedServiceRead({
      resultDigest: journal.resultDigest,
      completedAt: journal.completedAt,
      summary: journal.result.summary,
      githubReviewId: journal.reviewId,
      expectedBase: journal.expectedBase,
      ...options.service,
    }),
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
    latestStartAt: T0 + 60_000,
    settleBy: T0 + 660_000,
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
  const fixture = await completedFixture();
  service.readResult = fixture.service;
  const { port } = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([{
        ...fixture.review,
        user: { login: "coderabbitai[bot]" },
      }]),
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
      reviewsRead([{ ...fixture.review, commit_id: SHA2 }]),
      commentsRead([]),
    ],
    review: service,
  });
  const stale = await stalePort.port.observeReview(observeRequest());
  assert.ok(stale.ok);
  if (!stale.ok) return;
  assert.equal(stale.value.status, "unavailable");
  assert.equal(stale.value.observedHead, SHA2);

  // A standing review on the wrong head never matches the journal identity.
  const wrongHeadPort = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([{ ...fixture.review, commit_id: SHA3 }]),
      commentsRead([]),
    ]),
    review: service,
  });
  const wrongHead = await wrongHeadPort.port.observeReview(observeRequest());
  assert.ok(wrongHead.ok);
  if (!wrongHead.ok) return;
  assert.equal(wrongHead.value.status, "unavailable");

  // Malformed completion evidence: missing terminal success/output/result.
  for (
    const override of [
      { terminalTurnSucceeded: false },
      { outputPresent: false },
      { resultId: null },
      { completedAt: null },
    ]
  ) {
    service.readResult = completedServiceRead({
      resultDigest: fixture.service.resultDigest,
      ...override,
    });
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
    resultDigest: fixture.service.resultDigest,
    completedAt: T0 + 10_000_000,
  });
  const future = await port.observeReview(observeRequest());
  assert.ok(future.ok);
  if (!future.ok) return;
  assert.equal(future.value.status, "unavailable");
});

Deno.test("observeReview: completed clean requires the exact reviewer review on the exact head", async () => {
  const service = new FakeReviewService();
  const fixture = await completedFixture();
  service.readResult = fixture.service;
  const { port } = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([fixture.review]),
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
        ...fixture.review,
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

Deno.test("observeReview: finding-bearing completions carry the full structured findings", async () => {
  const service = new FakeReviewService();
  const fixture = await completedFixture({ result: STRUCTURED_FINDINGS });
  service.readResult = fixture.service;
  const { port } = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([fixture.review]),
      commentsRead([]),
    ]),
    review: service,
  });
  const observed = await port.observeReview(observeRequest());
  assert.ok(observed.ok);
  if (!observed.ok) return;
  assert.equal(observed.value.status, "completed");
  assert.equal(observed.value.summary, STRUCTURED_FINDINGS.summary);
  assert.equal(observed.value.findings.length, 2);
  const severities = observed.value.findings
    .map((finding) => finding.severity)
    .sort();
  assert.deepEqual(severities, ["P1", "P2"]);
  const p1 = observed.value.findings.find((finding) =>
    finding.severity === "P1"
  );
  assert.ok(p1 !== undefined);
  assert.equal(p1.path, "src/main.ts");
  assert.equal(p1.resolved, false);
  assert.match(p1.id, /^github-review-100-finding-\d+$/);
  // Fingerprints are SHA-256 of the canonical finding identity.
  assert.match(p1.fingerprint, /^[0-9a-f]{64}$/);
  // The FULL title, body, path and line range are preserved in the message.
  assert.ok(p1.message.includes("Broken error handling"));
  assert.ok(p1.message.includes("It must surface them."));
  assert.ok(p1.message.includes("src/main.ts:10-12"));
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

  // More structured findings than the cap: incomplete, never a partial
  // finding set claiming completeness.
  const overCapResult: ReviewResultV1 = {
    verdict: "findings",
    summary: "three findings",
    findings: [
      {
        priority: 1,
        title: "One",
        body: "first",
        path: "src/main.ts",
        lineStart: 1,
        lineEnd: 1,
      },
      {
        priority: 2,
        title: "Two",
        body: "second",
        path: "src/main.ts",
        lineStart: 2,
        lineEnd: 2,
      },
      {
        priority: 3,
        title: "Three",
        body: "third",
        path: "src/main.ts",
        lineStart: 3,
        lineEnd: 3,
      },
    ],
  };
  const fixture = await completedFixture({ result: overCapResult });
  service.readResult = fixture.service;
  const overCap = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([fixture.review]),
      commentsRead([]),
    ]),
    review: service,
    findingCap: 2,
  });
  const capped = await overCap.port.observeReview(observeRequest());
  assert.ok(capped.ok);
  if (!capped.ok) return;
  assert.equal(capped.value.status, "unavailable");
});

Deno.test("observeReview: old clean prose is never completed evidence", async () => {
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
          body: "## Codex review\n\nNo issues found. Looks good to merge.",
        }),
      ]),
      commentsRead([
        commentWire({ id: 500, body: "[P1] broken error handling" }),
      ]),
    ]),
    review: service,
  });
  const observed = await port.observeReview(observeRequest());
  assert.ok(observed.ok);
  if (!observed.ok) return;
  assert.equal(observed.value.status, "unavailable");
  assert.equal(observed.value.findings.length, 0);

  // CHANGES_REQUESTED prose without a structured journal is equally
  // unavailable — never an invented finding set.
  const changesPort = makePort({
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
  const changes = await changesPort.port.observeReview(observeRequest());
  assert.ok(changes.ok);
  if (!changes.ok) return;
  assert.equal(changes.value.status, "unavailable");
});

Deno.test("observeReview: an unaccounted same-author comment makes completion unavailable", async () => {
  const service = new FakeReviewService();
  const fixture = await completedFixture();
  service.readResult = fixture.service;
  const { port } = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([fixture.review]),
      commentsRead([commentWire({ id: 500, body: "extra structured note" })]),
    ]),
    review: service,
  });
  const unaccounted = await port.observeReview(observeRequest());
  assert.ok(unaccounted.ok);
  if (!unaccounted.ok) return;
  assert.equal(unaccounted.value.status, "unavailable");
  assert.equal(unaccounted.value.findings.length, 0);

  // A FOREIGN-author comment is not evidence the journal must account for.
  const foreignPort = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([fixture.review]),
      commentsRead([commentWire({
        id: 600,
        body: "[P1] planted by another bot",
        user: { login: "coderabbitai[bot]" },
      })]),
    ]),
    review: service,
  });
  const observed = await foreignPort.port.observeReview(observeRequest());
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
  const fixture = await completedFixture({ reviewId: 102 });
  service.readResult = fixture.service;
  const { port } = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([fixture.review]),
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
  const staleFixture = await completedFixture({
    reviewId: 102,
    requestedAt: T0 - 5000,
    completedAt: T0 + 500,
  });
  service.readResult = staleFixture.service;
  const staleObsPort = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([staleFixture.review]),
      commentsRead([]),
    ]),
    review: service,
  });
  const staleObs = await staleObsPort.port.observeReview(observeRequest());
  assert.ok(staleObs.ok);
  if (!staleObs.ok) return;
  assert.equal(staleObs.value.status, "completed");
  assert.throws(
    () => deriveReviewReceiptV1(staleObs.value, submission, REPO),
  );

  // Findings enrich the derived receipt with correct derived severities.
  const findingFixture = await completedFixture({
    reviewId: 103,
    result: STRUCTURED_FINDINGS,
  });
  service.readResult = findingFixture.service;
  const findingPort = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([findingFixture.review]),
      commentsRead([]),
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
    // The unresolved severity set must be derived from the exact observed
    // P1/P2 findings; a hard-coded inconsistent set fails the frozen parser.
    unresolvedSeverities: deriveUnresolvedSeverities(findingObs.value.findings),
    submittedAt: submission.submittedAt,
    completedAt: findingObs.value.completedAt,
    observedAt: findingObs.value.receivedAt,
  });
  assert.deepEqual(findingReceipt.unresolvedSeverities, ["P1", "P2"]);
});

Deno.test(
  "observeReview: APPROVED and CHANGES_REQUESTED never complete the transport contract",
  async () => {
    for (const state of ["APPROVED", "CHANGES_REQUESTED"]) {
      // ONLY the state changes: the exact ready journal body, the bound
      // service receipt, the head and the submission timestamp stay otherwise
      // valid. The transport contract is COMMENTED only.
      const fixture = await completedFixture({ wire: { state } });
      const service = new FakeReviewService();
      service.readResult = fixture.service;
      const { port } = makePort({
        clock: new FakeClock(T0 + 200_000),
        script: observeScript([
          [PR_READ],
          reviewsRead([fixture.review]),
          commentsRead([]),
        ]),
        review: service,
      });
      const observed = await port.observeReview(observeRequest());
      assert.ok(observed.ok);
      if (!observed.ok) return;
      assert.equal(observed.value.status, "unavailable", state);
      assert.equal(observed.value.findings.length, 0, state);
      assert.equal(fixture.review.state, state);
    }
  },
);

Deno.test("observeReview: exact-id review binding, not latest by time", async () => {
  // The recorded result is id 100 but a LATER structured review by the same
  // reviewer on the same head exists: the recorded result is no longer
  // authoritative.
  const service = new FakeReviewService();
  const earlier = await completedFixture({
    reviewId: 100,
    wire: { submitted_at: "2026-09-07T01:00:00Z" },
  });
  const later = await completedFixture({
    reviewId: 101,
    result: { verdict: "clean", summary: "later approval", findings: [] },
    wire: { submitted_at: "2026-09-07T02:00:00Z" },
  });
  service.readResult = earlier.service;
  const { port } = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([earlier.review, later.review]),
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
  serviceOk.readResult = later.service;
  const okPort = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([earlier.review, later.review]),
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
  const fixture = await completedFixture();
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
    { name: "wrong-result-digest", override: { resultDigest: "0".repeat(64) } },
    { name: "wrong-completed-at", override: { completedAt: T0 + 1 } },
  ];
  for (const item of cases) {
    const service = new FakeReviewService();
    service.readResult = completedServiceRead({
      resultDigest: fixture.service.resultDigest,
      ...item.override,
    });
    const { port } = makePort({
      clock: new FakeClock(T0 + 200_000),
      script: observeScript([
        [PR_READ],
        reviewsRead([fixture.review]),
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
  const fixture = await completedFixture({ expectedBase: SHA3 });
  service.readResult = fixture.service;
  const { port } = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: [
      httpRespond(
        "GET",
        "/repos/ubiquity/sentinel/pulls/1",
        200,
        pullWire({ base: { ref: "development", sha: SHA4 } }),
      ),
      reviewsRead([fixture.review]),
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

Deno.test("observeReview: a mismatched structured digest or head is unavailable", async () => {
  const service = new FakeReviewService();
  // The standing body's result digest no longer matches its result: the
  // journal parser rejects it, so no completion is ever inferred.
  const journal = await readyJournalFor();
  const tampered = renderReviewJournalBody({
    ...journal,
    resultDigest: "0".repeat(64),
  });
  service.readResult = completedServiceRead({
    resultDigest: "0".repeat(64),
  });
  const { port } = makePort({
    clock: new FakeClock(T0 + 200_000),
    script: observeScript([
      [PR_READ],
      reviewsRead([reviewWire({
        id: 100,
        state: "COMMENTED",
        body: tampered,
        commit_id: SHA1,
      })]),
      commentsRead([]),
    ]),
    review: service,
  });
  const observed = await port.observeReview(observeRequest());
  assert.ok(observed.ok);
  if (!observed.ok) return;
  assert.equal(observed.value.status, "unavailable");
  assert.equal(observed.value.findings.length, 0);
});
