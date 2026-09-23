// createPullRequest / closeIssue suite: deterministic-head publication with
// exact branch precondition, reuse of the exact own PR, foreign/human
// collisions, duplicate-publication reconciliation, byte-for-byte body
// publication (including GitHub closing keywords) and idempotent issue
// closure with lost-response reconciliation.
import assert from "node:assert/strict";

import {
  httpRespond,
  issueWire,
  makePort,
  PR_AUTHOR,
  pullWire,
  refWire,
  SHA1,
  SHA2,
  SHA3,
} from "./helpers.ts";
import type { PullRequestCreateV1 } from "../../src/contracts/ports.ts";

function createRequest(
  overrides: Partial<PullRequestCreateV1> = {},
): PullRequestCreateV1 {
  return {
    title: "fix the bug",
    headRef: "sentinel/fix-1",
    baseRef: "development",
    body: "Body with Fixes #123 mention.",
    expectedBase: SHA2,
    expectedHeadRef: SHA1,
    ...overrides,
  };
}

Deno.test("createPullRequest: publishes the requested body byte-for-byte", async () => {
  // The loop builds `Resolves #N` for an issue-backed repair; the port must
  // publish that body unchanged so GitHub links the issue and the merge
  // closes it. No keyword stripping happens anywhere on this path.
  const sourceBody = "Resolves #123\n";
  const { port, transport } = makePort({
    script: [
      httpRespond("GET", "/git/ref/heads/sentinel/fix-1", 200, refWire(SHA1)),
      httpRespond("GET", "/pulls?head=", 200, []),
      httpRespond(
        "POST",
        "/repos/ubiquity/sentinel/pulls",
        201,
        pullWire({
          number: 21,
          head: { ref: "sentinel/fix-1", sha: SHA1 },
        }),
      ),
    ],
  });
  const result = await port.createPullRequest(
    createRequest({ body: sourceBody }),
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    outcome: "applied",
    number: 21,
    head: SHA1,
  });
  const post = transport.requests.find((request) => request.method === "POST");
  assert.ok(post !== undefined);
  const body = JSON.parse(post.body ?? "{}") as Record<string, unknown>;
  assert.equal(body.head, "ubiquity:sentinel/fix-1");
  assert.equal(body.base, "development");
  assert.equal(body.title, "fix the bug");
  assert.equal(body.body, sourceBody, "body published byte-for-byte");
});

Deno.test("createPullRequest: missing or mismatched head branch fails closed", async () => {
  const { port } = makePort({
    script: [httpRespond("GET", "/git/ref/heads/sentinel/fix-1", 404, {})],
  });
  const missing = await port.createPullRequest(createRequest());
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.kind, "conflict");

  const { port: port2 } = makePort({
    script: [
      httpRespond("GET", "/git/ref/heads/sentinel/fix-1", 200, refWire(SHA2)),
    ],
  });
  const mismatched = await port2.createPullRequest(createRequest());
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) assert.equal(mismatched.error.kind, "conflict");
});

Deno.test("createPullRequest: reuses only the exact own open PR, blocks collisions", async () => {
  // Exact own PR: applied without any POST.
  const { port, transport } = makePort({
    script: [
      httpRespond("GET", "/git/ref/heads/sentinel/fix-1", 200, refWire(SHA1)),
      httpRespond("GET", "/pulls?head=", 200, [pullWire({
        number: 21,
        head: { ref: "sentinel/fix-1", sha: SHA1 },
      })]),
    ],
  });
  const reused = await port.createPullRequest(createRequest());
  assert.ok(reused.ok);
  if (!reused.ok) return;
  assert.deepEqual(reused.value, {
    outcome: "applied",
    number: 21,
    head: SHA1,
  });
  assert.equal(
    transport.requests.some((request) => request.method === "POST"),
    false,
  );

  // Human-owned PR on the deterministic branch: collision blocked.
  const { port: port2 } = makePort({
    script: [
      httpRespond("GET", "/git/ref/heads/sentinel/fix-1", 200, refWire(SHA1)),
      httpRespond("GET", "/pulls?head=", 200, [pullWire({
        number: 22,
        head: { ref: "sentinel/fix-1", sha: SHA1 },
        user: { login: "octocat" },
      })]),
    ],
  });
  const human = await port2.createPullRequest(createRequest());
  assert.equal(human.ok, false);
  if (!human.ok) assert.equal(human.error.kind, "conflict");

  // Same branch but a different head: foreign collision.
  const { port: port3 } = makePort({
    script: [
      httpRespond("GET", "/git/ref/heads/sentinel/fix-1", 200, refWire(SHA1)),
      httpRespond("GET", "/pulls?head=", 200, [pullWire({
        number: 23,
        head: { ref: "sentinel/fix-1", sha: SHA2 },
      })]),
    ],
  });
  const different = await port3.createPullRequest(createRequest());
  assert.equal(different.ok, false);
  if (!different.ok) assert.equal(different.error.kind, "conflict");
});

Deno.test("createPullRequest: duplicate/ambiguous publication is reconciled by discovery", async () => {
  // 422 duplicate → discovery finds the exact own PR → applied (no guess).
  const { port } = makePort({
    script: [
      httpRespond("GET", "/git/ref/heads/sentinel/fix-1", 200, refWire(SHA1)),
      httpRespond("GET", "/pulls?head=", 200, []),
      httpRespond("POST", "/repos/ubiquity/sentinel/pulls", 422, {}),
      httpRespond("GET", "/pulls?head=", 200, [pullWire({
        number: 24,
        head: { ref: "sentinel/fix-1", sha: SHA1 },
      })]),
    ],
  });
  const duplicate = await port.createPullRequest(createRequest());
  assert.ok(duplicate.ok);
  if (!duplicate.ok) return;
  assert.deepEqual(duplicate.value, {
    outcome: "applied",
    number: 24,
    head: SHA1,
  });

  // Lost POST response, nothing discoverable → ambiguous, never a false applied.
  const { port: port2 } = makePort({
    script: [
      httpRespond("GET", "/git/ref/heads/sentinel/fix-1", 200, refWire(SHA1)),
      httpRespond("GET", "/pulls?head=", 200, []),
      {
        kind: "throw",
        method: "POST",
        urlPart: "/repos/ubiquity/sentinel/pulls",
      },
      httpRespond("GET", "/pulls?head=", 200, []),
    ],
  });
  const lost = await port2.createPullRequest(createRequest());
  assert.ok(lost.ok);
  if (!lost.ok) return;
  assert.deepEqual(lost.value, {
    outcome: "ambiguous",
    number: null,
    head: null,
  });

  // Lost POST response, human PR appears → conflict.
  const { port: port3 } = makePort({
    script: [
      httpRespond("GET", "/git/ref/heads/sentinel/fix-1", 200, refWire(SHA1)),
      httpRespond("GET", "/pulls?head=", 200, []),
      {
        kind: "throw",
        method: "POST",
        urlPart: "/repos/ubiquity/sentinel/pulls",
      },
      httpRespond("GET", "/pulls?head=", 200, [pullWire({
        number: 25,
        head: { ref: "sentinel/fix-1", sha: SHA1 },
        user: { login: "octocat" },
      })]),
    ],
  });
  const foreign = await port3.createPullRequest(createRequest());
  assert.equal(foreign.ok, false);
  if (!foreign.ok) assert.equal(foreign.error.kind, "conflict");
});

Deno.test("createPullRequest: text bounds fail closed before any call", async () => {
  const { port, transport } = makePort({
    script: [
      httpRespond("GET", "/git/ref/heads/sentinel/fix-1", 200, refWire(SHA1)),
    ],
  });
  const longBody = await port.createPullRequest(createRequest({
    body: "x".repeat(16385),
  }));
  assert.equal(longBody.ok, false);
  if (!longBody.ok) assert.equal(longBody.error.kind, "invalid");

  const longTitle = await port.createPullRequest(createRequest({
    title: "x".repeat(2049),
  }));
  assert.equal(longTitle.ok, false);
  if (!longTitle.ok) assert.equal(longTitle.error.kind, "invalid");

  // No request reached the transport for either bound violation.
  assert.equal(transport.requests.length, 0);
});

Deno.test("createPullRequest: a moved base after publication fails closed", async () => {
  const { port } = makePort({
    script: [
      httpRespond("GET", "/git/ref/heads/sentinel/fix-1", 200, refWire(SHA1)),
      httpRespond("GET", "/pulls?head=", 200, []),
      httpRespond(
        "POST",
        "/repos/ubiquity/sentinel/pulls",
        201,
        pullWire({
          number: 21,
          head: { ref: "sentinel/fix-1", sha: SHA1 },
          base: { ref: "development", sha: SHA3 },
        }),
      ),
    ],
  });
  const moved = await port.createPullRequest(createRequest());
  // expectedBase is SHA2; the published PR observes SHA3 → conflict, never a
  // silently accepted different-base publication.
  assert.equal(moved.ok, false);
  if (!moved.ok) assert.equal(moved.error.kind, "conflict");
});

Deno.test("closeIssue: idempotent closure with lost-response reconciliation", async () => {
  // Open issue: PATCH then closed.
  const { port } = makePort({
    script: [
      httpRespond(
        "GET",
        "/repos/ubiquity/sentinel/issues/7",
        200,
        issueWire({ number: 7, state: "open" }),
      ),
      httpRespond(
        "PATCH",
        "/repos/ubiquity/sentinel/issues/7",
        200,
        issueWire({
          number: 7,
          state: "closed",
          closed_at: "2026-09-07T01:00:00Z",
        }),
      ),
    ],
  });
  const closed = await port.closeIssue(7);
  assert.ok(closed.ok);
  if (!closed.ok) return;
  assert.equal(closed.value, "closed");

  // Already closed: no PATCH at all.
  const { port: port2, transport: transport2 } = makePort({
    script: [
      httpRespond(
        "GET",
        "/repos/ubiquity/sentinel/issues/7",
        200,
        issueWire({
          number: 7,
          state: "closed",
          closed_at: "2026-09-07T01:00:00Z",
        }),
      ),
    ],
  });
  const again = await port2.closeIssue(7);
  assert.ok(again.ok);
  if (!again.ok) return;
  assert.equal(again.value, "already_closed");
  assert.equal(
    transport2.requests.some((request) => request.method === "PATCH"),
    false,
  );

  // Lost PATCH response but the issue is closed on reread → closed.
  const { port: port3 } = makePort({
    script: [
      httpRespond(
        "GET",
        "/repos/ubiquity/sentinel/issues/7",
        200,
        issueWire({ number: 7, state: "open" }),
      ),
      {
        kind: "throw",
        method: "PATCH",
        urlPart: "/repos/ubiquity/sentinel/issues/7",
      },
      httpRespond(
        "GET",
        "/repos/ubiquity/sentinel/issues/7",
        200,
        issueWire({
          number: 7,
          state: "closed",
          closed_at: "2026-09-07T01:00:00Z",
        }),
      ),
    ],
  });
  const reconciled = await port3.closeIssue(7);
  assert.ok(reconciled.ok);
  if (!reconciled.ok) return;
  assert.equal(reconciled.value, "closed");

  // Reread still open → typed unavailable, no invented closure.
  const { port: port4 } = makePort({
    script: [
      httpRespond(
        "GET",
        "/repos/ubiquity/sentinel/issues/7",
        200,
        issueWire({ number: 7, state: "open" }),
      ),
      {
        kind: "throw",
        method: "PATCH",
        urlPart: "/repos/ubiquity/sentinel/issues/7",
      },
      httpRespond(
        "GET",
        "/repos/ubiquity/sentinel/issues/7",
        200,
        issueWire({ number: 7, state: "open" }),
      ),
    ],
  });
  const unconfirmed = await port4.closeIssue(7);
  assert.equal(unconfirmed.ok, false);
  if (!unconfirmed.ok) assert.equal(unconfirmed.error.kind, "unavailable");

  // Missing issue is not found, never "already closed".
  const { port: port5 } = makePort({
    script: [httpRespond("GET", "/repos/ubiquity/sentinel/issues/99", 404, {})],
  });
  const missing = await port5.closeIssue(99);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.kind, "not_found");
});

// Author identity used in fixture helpers stays consistent.
assert.ok(PR_AUTHOR.length > 0);
