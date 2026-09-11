// Transport lifetime and secret-boundary suite: finite operation deadlines
// (auth + request + body read), streaming byte bounds, redirect policy,
// abort-ignoring injected fetch/body readers, sanitized auth errors, signer
// hangs and ambiguous submit-after-timeout classification. All transports
// are tiny scripted fakes; never allocate a stress payload, never network.
import assert from "node:assert/strict";

import type { PortResultV1 } from "../../src/contracts/ports.ts";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { GitHubInstallationTokenProvider } from "../../src/github/auth.ts";
import type { GitHubAuthProviderV1 } from "../../src/github/auth.ts";
import { fromFetch } from "../../src/github/http.ts";
import type {
  FetchLikeV1,
  HttpResponseV1,
  HttpTransportV1,
} from "../../src/github/http.ts";
import type { HttpRequestV1 } from "../../src/github/http.ts";
import {
  checkRunWire,
  FakeClock,
  FakeCooldownGate,
  FakeGitExecutor,
  FakeReviewService,
  httpRespond,
  makePort,
  pullRequestRuleWire,
  pullWire,
  REPO,
  REVIEWER,
  rulesetWire,
  SHA1,
  SHA2,
  statusChecksRuleWire,
  statusesPageWire,
  structuredCompletedFixture,
  type StructuredReviewFixtureV1,
  T0,
} from "./helpers.ts";
import type { ScriptEntry } from "./helpers.ts";

const textEncoder = new TextEncoder();

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function fakeResponse(
  bodyText: string,
  chunks: Uint8Array[] | null,
): Awaited<ReturnType<FetchLikeV1>> {
  return {
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text() {
      return Promise.resolve(bodyText);
    },
    body: chunks === null ? null : streamOf(chunks),
  };
}

class ThrowingAuthProvider implements GitHubAuthProviderV1 {
  authorizationHeader(): Promise<PortResultV1<string>> {
    // The raw exception must never escape: no token/url.
    throw new Error(
      `raw auth failure token=ghs_super_secret_999 url=api.github.com`,
    );
  }
}

class HangingAuthProvider implements GitHubAuthProviderV1 {
  authorizationHeader(): Promise<PortResultV1<string>> {
    return new Promise(() => {});
  }
}

/** Resolves reads; writes never settle (ignores any cancel signal: the
 * submit may already have reached the server). */
class HangingWriteTransport {
  requests: HttpRequestV1[] = [];
  constructor(private readonly inner: HttpTransportV1) {}
  fetch = (request: HttpRequestV1): Promise<HttpResponseV1> => {
    this.requests.push(request);
    if (request.method === "PUT" || request.method === "POST") {
      return new Promise<HttpResponseV1>(() => {});
    }
    return this.inner(request);
  };
}

function pullEntry(
  overrides: Record<string, unknown> = {},
): ScriptEntry {
  return httpRespond(
    "GET",
    "/repos/ubiquity/sentinel/pulls/1",
    200,
    pullWire({
      number: 1,
      head: { ref: "sentinel/fix-1", sha: SHA1 },
      base: { ref: "development", sha: SHA2 },
      ...overrides,
    }),
  );
}

function completedReceipt(): ReviewReceiptV1 {
  return parseReviewReceiptV1({
    version: "v1",
    kind: "review_receipt",
    id: "review-review:work-1",
    requestId: "req-1",
    expectedReviewer: REVIEWER,
    observedReviewer: REVIEWER,
    repository: REPO,
    pullRequest: { number: 1, head: SHA1, base: SHA2 },
    outcome: "completed",
    resultId: "result-9",
    summary: "no issues found",
    findings: [],
    findingsUncounted: 0,
    unresolvedSeverities: [],
    submittedAt: T0 + 1000,
    completedAt: T0 + 120_000,
    observedAt: T0 + 130_000,
  });
}

/**
 * Merge script for the lost-PUT case. The standing completion is the exact
 * structured ready journal fixture (the structured review is the production
 * completion authority); the prose/APPROVED shape is intentionally gone.
 */
function mergeHappyScript(
  fixture: StructuredReviewFixtureV1,
): ScriptEntry[] {
  return [
    pullEntry(),
    pullEntry(),
    httpRespond(
      "GET",
      "/repos/ubiquity/sentinel/pulls/1/reviews?per_page=100&page=1",
      200,
      [fixture.review],
    ),
    httpRespond(
      "GET",
      "/repos/ubiquity/sentinel/pulls/1/comments?per_page=100&page=1",
      200,
      [],
    ),
    httpRespond(
      "GET",
      "/repos/ubiquity/sentinel/rules/branches/development?per_page=100&page=1",
      200,
      [statusChecksRuleWire(), pullRequestRuleWire()],
    ),
    httpRespond(
      "GET",
      "/repos/ubiquity/sentinel/rulesets?includes_parents=true&per_page=100&page=1",
      200,
      [rulesetWire()],
    ),
    httpRespond(
      "GET",
      `/repos/ubiquity/sentinel/commits/${SHA1}/check-runs?per_page=100&page=1`,
      200,
      { check_runs: [checkRunWire()], total_count: 1 },
    ),
    httpRespond(
      "GET",
      `/repos/ubiquity/sentinel/commits/${SHA1}/statuses?per_page=100&page=1`,
      200,
      statusesPageWire([]),
    ),
    // Reconcile read after the lost merge PUT: PR still open.
    pullEntry(),
  ];
}

Deno.test("fromFetch: passes redirect error policy and an abort signal", async () => {
  const seen: {
    redirect: string | undefined;
    signal: AbortSignal | undefined;
  }[] = [];
  const fetchFn: FetchLikeV1 = (_input, init) => {
    seen.push({ redirect: init?.redirect, signal: init?.signal });
    return Promise.resolve(fakeResponse("{}", []));
  };
  const transport = fromFetch(fetchFn);
  const response = await transport({
    method: "GET",
    url: "https://api.github.com/repos/x/y",
    headers: new Map([["accept", "application/vnd.github+json"]]),
    body: null,
  });
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].redirect, "error");
  assert.ok(seen[0].signal instanceof AbortSignal);
});

Deno.test("fromFetch: abort-ignoring headers and body cannot block past the deadline", async () => {
  // The fake ignores the abort signal and never returns headers.
  const ignoringHeaders: FetchLikeV1 = () => new Promise(() => {});
  const transport = fromFetch(ignoringHeaders, { deadlineMs: 120 });
  const started = Date.now();
  await assert.rejects(() =>
    transport({
      method: "GET",
      url: "https://api.github.com/repos/x/y",
      headers: new Map(),
      body: null,
    })
  );
  assert.ok(Date.now() - started < 2_000, "headers timeout settled");

  // The fake returns headers but its body stream never emits: the bounded
  // byte read races the same deadline and cannot hang the caller.
  const bodyNeverReads: FetchLikeV1 = () =>
    Promise.resolve({
      status: 200,
      headers: new Headers(),
      text() {
        return new Promise<string>(() => {});
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(textEncoder.encode("["));
          // Never close; the reader below stays pending.
        },
      }),
    });
  const transport2 = fromFetch(bodyNeverReads, { deadlineMs: 120 });
  const started2 = Date.now();
  await assert.rejects(() =>
    transport2({
      method: "GET",
      url: "https://api.github.com/repos/x/y",
      headers: new Map(),
      body: null,
    })
  );
  assert.ok(Date.now() - started2 < 2_000, "body timeout settled");
});

Deno.test("fromFetch: multi-chunk over-limit is a bounded failure", async () => {
  const chunks = Array.from(
    { length: 8 },
    () => textEncoder.encode("0123456789abcdef"),
  );
  const fetchFn: FetchLikeV1 = () => Promise.resolve(fakeResponse("x", chunks));
  const transport = fromFetch(fetchFn, { maxBodyBytes: 64 });
  await assert.rejects(() =>
    transport({
      method: "GET",
      url: "https://api.github.com/repos/x/y",
      headers: new Map(),
      body: null,
    })
  );
});

Deno.test("client: auth provider throws or hangs returns a sanitized typed failure", async () => {
  // A raw throw: nothing leaks (no token/url fragment), and no request was
  // issued — an auth-only failure is not a submitted write.
  const throwing = makePort({ auth: new ThrowingAuthProvider() });
  const thrown = await throwing.port.readIssue(1);
  assert.equal(thrown.ok, false);
  if (!thrown.ok) {
    assert.equal(thrown.error.kind, "auth_failed");
    assert.ok(!thrown.error.detail.includes("token"));
    assert.ok(!thrown.error.detail.includes("api.github.com"));
  }

  // A hung provider: the finite operation deadline begins before
  // authentication and settles the call.
  const hanging = makePort({
    auth: new HangingAuthProvider(),
    requestDeadlineMs: 120,
  });
  const started = Date.now();
  const hung = await hanging.port.readIssue(1);
  assert.equal(hung.ok, false);
  if (!hung.ok) assert.equal(hung.error.kind, "auth_failed");
  assert.ok(Date.now() - started < 2_000, "auth hang settled");
});

Deno.test("client: write submitted into a lost response stays ambiguous", async () => {
  const fixture = await structuredCompletedFixture();
  const script = mergeHappyScript(fixture);
  const service = new FakeReviewService();
  service.readResult = fixture.service;
  const inner = makePort({ script });
  const transport = new HangingWriteTransport(
    inner.transport.fetch.bind(inner.transport),
  );
  const { port: target } = makePort({
    script,
    http: transport.fetch,
    review: service,
    git: new FakeGitExecutor(),
    clock: new FakeClock(T0 + 200_000),
    requestDeadlineMs: 120,
  });
  const result = await target.mergePullRequest({
    pullRequestNumber: 1,
    expectedHead: SHA1,
    expectedBase: SHA2,
    review: completedReceipt(),
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    outcome: "ambiguous",
    head: null,
    mergeSha: null,
  });
  const puts = transport.requests.filter((request) => request.method === "PUT");
  assert.equal(puts.length, 1);
  assert.equal(puts[0].url.includes("/pulls/1/merge"), true);
});

Deno.test("token provider: a hung injected signer cannot block past its bound", async () => {
  const transport = {
    requests: [] as HttpRequestV1[],
    fetch(
      request: HttpRequestV1,
    ): Promise<HttpResponseV1> {
      transport.requests.push(request);
      return new Promise<HttpResponseV1>(() => {});
    },
  };
  const provider = new GitHubInstallationTokenProvider({
    appId: 12345,
    repository: REPO,
    apiBaseUrl: "https://api.github.com",
    http: transport.fetch.bind(transport),
    clock: new FakeClock(T0),
    cooldownGate: new FakeCooldownGate(),
    signer: {
      signJwt(): Promise<PortResultV1<string>> {
        // The injected signer ignores everything and never settles.
        return new Promise(() => {});
      },
    },
    signDeadlineMs: 120,
  });
  const started = Date.now();
  const result = await provider.authorizationHeader();
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "unavailable");
    assert.ok(!result.error.detail.includes("token"));
  }
  assert.equal(transport.requests.length, 0, "no request after signer hang");
  assert.ok(Date.now() - started < 2_000, "signer hang settled");
});
