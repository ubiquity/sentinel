// Scripted authenticated HTTP suite for the review journal client
// operations: exact request shapes, exact IDs, COMMENT-only submission,
// ambiguous-on-lost, typed errors and pre-request input validation. No live
// GitHub is ever contacted.
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  GitHubApiClient,
  type ReviewMutationOutcomeV1,
} from "../../src/github/client.ts";
import type { HttpRequestV1, HttpResponseV1 } from "../../src/github/http.ts";
import type { GitHubAuthProviderV1 } from "../../src/github/auth.ts";
import type { GitHubCooldownGateV1 } from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import {
  FakeAuthProvider,
  FakeClock,
  FakeCooldownGate,
  httpRespond,
  httpThrow,
  REPO,
  reviewWire,
  ScriptedHttpTransport,
  SHA1,
  T0,
} from "./helpers.ts";
import type { ScriptEntry } from "./helpers.ts";

const PR = 1;
const REVIEW_ID = 100;
const BODY =
  "<!--sentinel-review-journal-v1\nZml4\n-->\n\n# Model review: clean";

function makeClient(
  script: ScriptEntry[] = [],
  options: {
    auth?: GitHubAuthProviderV1;
    gate?: GitHubCooldownGateV1;
    requestDeadlineMs?: number;
    http?: (request: HttpRequestV1) => Promise<HttpResponseV1>;
  } = {},
): { client: GitHubApiClient; transport: ScriptedHttpTransport } {
  const transport = new ScriptedHttpTransport(script);
  const client = new GitHubApiClient({
    repository: REPO,
    apiBaseUrl: "https://api.github.com",
    http: options.http ?? transport.fetch.bind(transport),
    auth: options.auth ?? new FakeAuthProvider(),
    cooldownGate: options.gate ?? new FakeCooldownGate(),
    clock: new FakeClock(T0),
    requestDeadlineMs: options.requestDeadlineMs,
  });
  return { client, transport };
}

function applied(
  result: { ok: boolean; value?: unknown },
): ReviewMutationOutcomeV1 {
  assert.ok(result.ok);
  return result.value as ReviewMutationOutcomeV1;
}

/** Genuine GitHub PENDING review response: `submitted_at` is omitted. */
function pendingWireWithoutSubmittedAt(): Record<string, unknown> {
  const wire = reviewWire({ state: "PENDING", body: BODY });
  delete wire.submitted_at;
  return wire;
}

Deno.test("client review: create pending review sends commit_id+body and never an event", async () => {
  const { client, transport } = makeClient([
    httpRespond(
      "POST",
      "/pulls/1/reviews",
      201,
      reviewWire({
        state: "PENDING",
        submitted_at: null,
        body: BODY,
      }),
    ),
  ]);
  const result = await client.createPendingReview(PR, SHA1, BODY);
  const outcome = applied(result);
  assert.equal(outcome.status, "applied");
  assert.equal(outcome.review.id, REVIEW_ID);
  assert.equal(outcome.review.state, "pending");
  assert.equal(outcome.review.commitSha, SHA1);
  assert.equal(transport.requests.length, 1);
  const sent = transport.requests[0];
  assert.equal(sent.method, "POST");
  assert.equal(
    sent.url,
    "https://api.github.com/repos/ubiquity/sentinel/pulls/1/reviews",
  );
  const payload = JSON.parse(sent.body ?? "null") as Record<string, unknown>;
  assert.deepEqual(payload, { commit_id: SHA1, body: BODY });
  assert.equal("event" in payload, false);
  assert.equal(
    sent.headers.get("authorization"),
    "Bearer ghs_synthetic_token_0001",
  );
});

Deno.test("client review: update pending review PUTs the exact id and body", async () => {
  const { client, transport } = makeClient([
    httpRespond(
      "PUT",
      "/pulls/1/reviews/100",
      200,
      reviewWire({
        id: REVIEW_ID,
        state: "PENDING",
        submitted_at: null,
        body: BODY,
      }),
    ),
  ]);
  const result = await client.updatePendingReview(PR, REVIEW_ID, BODY);
  const outcome = applied(result);
  assert.equal(outcome.status, "applied");
  assert.equal(outcome.review.id, REVIEW_ID);
  const sent = transport.requests[0];
  assert.equal(sent.method, "PUT");
  assert.equal(
    sent.url,
    "https://api.github.com/repos/ubiquity/sentinel/pulls/1/reviews/100",
  );
  assert.deepEqual(JSON.parse(sent.body ?? "null"), { body: BODY });
});

Deno.test("client review: submit sends event COMMENT only and never APPROVE", async () => {
  const { client, transport } = makeClient([
    httpRespond(
      "POST",
      "/pulls/1/reviews/100/events",
      200,
      reviewWire({
        id: REVIEW_ID,
        state: "COMMENTED",
        body: BODY,
      }),
    ),
  ]);
  const result = await client.submitReview(PR, REVIEW_ID, BODY);
  const outcome = applied(result);
  assert.equal(outcome.status, "applied");
  assert.equal(outcome.review.state, "commented");
  const sent = transport.requests[0];
  assert.equal(sent.method, "POST");
  assert.equal(
    sent.url,
    "https://api.github.com/repos/ubiquity/sentinel/pulls/1/reviews/100/events",
  );
  assert.deepEqual(JSON.parse(sent.body ?? "null"), {
    event: "COMMENT",
    body: BODY,
  });
  assert.equal(sent.body?.includes("APPROVE"), false);
});

Deno.test("client review: exact review read maps 404 to null and parses 200", async () => {
  const missing = makeClient([
    httpRespond("GET", "/pulls/1/reviews/100", 404, {}),
  ]);
  const notFound = await missing.client.readPullReview(PR, REVIEW_ID);
  assert.ok(notFound.ok);
  assert.equal(notFound.value, null);

  const found = makeClient([
    httpRespond(
      "GET",
      "/pulls/1/reviews/100",
      200,
      reviewWire({
        id: REVIEW_ID,
        state: "COMMENTED",
        body: BODY,
      }),
    ),
  ]);
  const present = await found.client.readPullReview(PR, REVIEW_ID);
  assert.ok(present.ok);
  assert.equal(present.value?.id, REVIEW_ID);
  assert.equal(present.value?.state, "commented");
  assert.equal(found.transport.requests.length, 1);
});

Deno.test("client review: genuine pending responses without submitted_at are accepted", async () => {
  const created = makeClient([
    httpRespond(
      "POST",
      "/pulls/1/reviews",
      201,
      pendingWireWithoutSubmittedAt(),
    ),
  ]);
  const createOutcome = applied(
    await created.client.createPendingReview(PR, SHA1, BODY),
  );
  assert.equal(createOutcome.status, "applied");
  assert.equal(createOutcome.review.state, "pending");
  assert.equal(createOutcome.review.submittedAt, null);

  const updated = makeClient([
    httpRespond(
      "PUT",
      "/pulls/1/reviews/100",
      200,
      pendingWireWithoutSubmittedAt(),
    ),
  ]);
  const updateOutcome = applied(
    await updated.client.updatePendingReview(PR, REVIEW_ID, BODY),
  );
  assert.equal(updateOutcome.status, "applied");
  assert.equal(updateOutcome.review.state, "pending");
  assert.equal(updateOutcome.review.submittedAt, null);

  const read = makeClient([
    httpRespond(
      "GET",
      "/pulls/1/reviews/100",
      200,
      pendingWireWithoutSubmittedAt(),
    ),
  ]);
  const readResult = await read.client.readPullReview(PR, REVIEW_ID);
  assert.ok(readResult.ok);
  assert.equal(readResult.value?.state, "pending");
  assert.equal(readResult.value?.submittedAt, null);
});

Deno.test("client review: submitted COMMENTED response without submitted_at is rejected", async () => {
  const wire = reviewWire({ state: "COMMENTED", body: BODY });
  delete wire.submitted_at;
  const { client, transport } = makeClient([
    httpRespond("POST", "/pulls/1/reviews/100/events", 200, wire),
  ]);
  const result = await client.submitReview(PR, REVIEW_ID, BODY);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "invalid");
    assert.equal(result.error.detail, "GitHub API response is malformed");
  }
  assert.equal(transport.requests.length, 1);
});

Deno.test("client review: lost response stays ambiguous with exactly one HTTP call", async () => {
  const { client, transport } = makeClient([
    httpThrow("POST", "/pulls/1/reviews/100/events"),
  ]);
  const result = await client.submitReview(PR, REVIEW_ID, BODY);
  const outcome = applied(result);
  assert.equal(outcome.status, "ambiguous");
  assert.equal(transport.requests.length, 1);
});

Deno.test("client review: malformed response is a static invalid error", async () => {
  const { client } = makeClient([
    httpRespond("POST", "/pulls/1/reviews", 201, "not json at all"),
  ]);
  const result = await client.createPendingReview(PR, SHA1, BODY);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "invalid");
    assert.equal(result.error.detail, "GitHub API response is malformed");
  }
});

Deno.test("client review: unexpected mutation response state and non-2xx are typed", async () => {
  const approved = makeClient([
    httpRespond(
      "POST",
      "/pulls/1/reviews",
      201,
      reviewWire({
        state: "APPROVED",
        body: BODY,
      }),
    ),
  ]);
  const wrongState = await approved.client.createPendingReview(PR, SHA1, BODY);
  assert.equal(wrongState.ok, false);
  if (!wrongState.ok) assert.equal(wrongState.error.kind, "invalid");

  const gone = makeClient([
    httpRespond("POST", "/pulls/1/reviews/100/events", 404, {}),
  ]);
  const missing = await gone.client.submitReview(PR, REVIEW_ID, BODY);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.kind, "not_found");
});

Deno.test("client review: authentication failure is typed and nothing is sent", async () => {
  const auth = new FakeAuthProvider("Bearer synthetic", {
    kind: "auth_failed",
    detail: "GitHub API authentication failed",
  });
  const { client, transport } = makeClient([], { auth });
  const result = await client.createPendingReview(PR, SHA1, BODY);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "auth_failed");
  assert.equal(transport.requests.length, 0);
});

Deno.test("client review: durable cooldown gate blocks before authentication", async () => {
  const calls = { gate: 0, auth: 0 };
  const gate: GitHubCooldownGateV1 = {
    beforeRequest: () => {
      calls.gate++;
      return Promise.resolve(portError("rate_limited", "cooldown"));
    },
    recordRateLimit: () => Promise.resolve(portOk(undefined)),
  };
  const auth: GitHubAuthProviderV1 = {
    authorizationHeader: () => {
      calls.auth++;
      return Promise.resolve(portOk("Bearer synthetic"));
    },
  };
  const { client, transport } = makeClient([], { gate, auth });
  const result = await client.updatePendingReview(PR, REVIEW_ID, BODY);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "rate_limited");
  assert.equal(calls.gate, 1);
  assert.equal(calls.auth, 0);
  assert.equal(transport.requests.length, 0);
});

Deno.test("client review: deadline over a hung transport submits once and stays ambiguous", async () => {
  const sent: HttpRequestV1[] = [];
  const http = (request: HttpRequestV1): Promise<HttpResponseV1> => {
    sent.push(request);
    return new Promise<HttpResponseV1>(() => {});
  };
  const { client } = makeClient([], { http, requestDeadlineMs: 30 });
  const started = Date.now();
  const result = await client.submitReview(PR, REVIEW_ID, BODY);
  const outcome = applied(result);
  assert.equal(outcome.status, "ambiguous");
  assert.equal(sent.length, 1);
  assert.ok(
    Date.now() - started < 2_000,
    "hung transport settled by the deadline",
  );
});

Deno.test("client review: rate-limit status is typed with a durable observation", async () => {
  const gate = new FakeCooldownGate();
  const { client } = makeClient([
    httpRespond("POST", "/pulls/1/reviews/100/events", 429, {}, {
      "retry-after": "120",
    }),
  ], { gate });
  const result = await client.submitReview(PR, REVIEW_ID, BODY);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "rate_limited");
    assert.equal(gate.recorded.length, 1);
  }
});

Deno.test("client review: invalid ids, head and body are rejected before any request", async () => {
  const { client, transport } = makeClient([]);
  const badHead = "not-a-sha" as GitSha;
  const oversized = "x".repeat(60_001);
  const results = [
    await client.createPendingReview(0, SHA1, BODY),
    await client.createPendingReview(PR, badHead, BODY),
    await client.createPendingReview(PR, SHA1, ""),
    await client.createPendingReview(PR, SHA1, oversized),
    await client.updatePendingReview(PR, -3, BODY),
    await client.updatePendingReview(1.5, REVIEW_ID, BODY),
    await client.submitReview(PR, REVIEW_ID, "y".repeat(60_001)),
    await client.readPullReview(PR, 0),
  ];
  for (const result of results) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, "invalid");
  }
  assert.equal(transport.requests.length, 0);
});

Deno.test("client review: undefined or null required slots are rejected before any request", async () => {
  const { client, transport } = makeClient([]);
  const results = [
    // read requires pr and reviewId.
    await client.readPullReview(PR, undefined as unknown as number),
    await client.readPullReview(PR, null as unknown as number),
    // create requires pr, head and body.
    await client.createPendingReview(PR, undefined as unknown as GitSha, BODY),
    await client.createPendingReview(PR, null as unknown as GitSha, BODY),
    await client.createPendingReview(PR, SHA1, undefined as unknown as string),
    // update/submit require pr, reviewId and body.
    await client.updatePendingReview(PR, undefined as unknown as number, BODY),
    await client.submitReview(PR, REVIEW_ID, undefined as unknown as string),
    await client.submitReview(PR, null as unknown as number, BODY),
  ];
  for (const result of results) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, "invalid");
  }
  assert.equal(transport.requests.length, 0);
});
