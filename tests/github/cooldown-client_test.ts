import assert from "node:assert/strict";
import { classifyGitHubRateLimit } from "../../src/github/rate-limit.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import {
  type GitHubCooldownGateV1,
  portError,
  portOk,
} from "../../src/contracts/ports.ts";

Deno.test("github client cooldown classification and request ordering", async () => {
  const now = 1786000000000;
  const response = (
    status: number,
    headers: Record<string, string> = {},
    bodyText = "",
  ) => ({ status, headers: new Headers(headers), bodyText });
  const cases = [
    {
      name: "ordinary forbidden",
      res: response(403, {}, "Resource not accessible by integration"),
      kind: null,
    },
    {
      name: "401 never throttle",
      res: response(
        401,
        { "x-ratelimit-remaining": "0" },
        "secondary rate limit",
      ),
      kind: null,
    },
    {
      name: "primary longest reset",
      res: response(403, {
        "x-ratelimit-remaining": "0",
        "retry-after": "30",
        "x-ratelimit-reset": String(now / 1000 + 7200),
      }),
      kind: "primary",
      deadline: now + 7200000,
    },
    {
      name: "primary longest retry",
      res: response(403, {
        "x-ratelimit-remaining": "0",
        "retry-after": "7200",
        "x-ratelimit-reset": String(now / 1000 + 30),
      }),
      kind: "primary",
      deadline: now + 7200000,
    },
    {
      name: "secondary date",
      res: response(403, {
        "retry-after": new Date(now + 3600000).toUTCString(),
      }, "You have exceeded a secondary rate limit."),
      kind: "secondary",
      deadline: now + 3600000,
    },
    {
      name: "secondary fallback",
      res: response(403, {}, "You have exceeded a secondary rate limit."),
      kind: "secondary",
      deadline: now + 60000,
      fallback: true,
    },
    {
      name: "secondary malformed",
      res: response(429, { "retry-after": "bad" }),
      kind: "secondary",
      deadline: now + 60000,
      fallback: true,
    },
    {
      name: "primary missing manual",
      res: response(403, { "x-ratelimit-remaining": "0" }),
      kind: "primary",
      deadline: null,
    },
    {
      name: "overflow never clamped",
      res: response(403, {
        "x-ratelimit-remaining": "0",
        "retry-after": "99999999999999999999999999999999999",
        "x-ratelimit-reset": String(now / 1000 + 30),
      }),
      kind: "primary",
      deadline: null,
    },
    {
      name: "reset ignored when not exhausted",
      res: response(429, {
        "x-ratelimit-remaining": "10",
        "retry-after": "120",
        "x-ratelimit-reset": String(now / 1000 + 7200),
      }),
      kind: "secondary",
      deadline: now + 120000,
    },
  ] as const;
  for (const c of cases) {
    const result = await classifyGitHubRateLimit(c.res, now);
    assert.equal(result?.kind ?? null, c.kind, c.name);
    if (c.kind !== null) {
      assert.equal(result?.retryNotBefore, c.deadline, c.name);
      assert.match(result!.observationId, /^[0-9a-f]{64}$/);
      if ("fallback" in c) assert.equal(result?.fallback, c.fallback);
    }
  }
  for (
    const mode of [
      "blocked-before-auth",
      "blocked-after-auth",
      "persist-failure",
      "record-first",
    ]
  ) {
    const order: string[] = [];
    let calls = 0;
    const gate: GitHubCooldownGateV1 = {
      beforeRequest: () => {
        order.push("gate");
        calls++;
        return Promise.resolve(
          (mode === "blocked-before-auth" ||
              mode === "blocked-after-auth" && calls === 2)
            ? portError("rate_limited", "cooldown")
            : portOk(undefined),
        );
      },
      recordRateLimit: (_id, metadata) => {
        order.push("record");
        assert.equal(metadata.retryNotBefore, now + 120000);
        return Promise.resolve(
          mode === "persist-failure"
            ? portError("unavailable", "state conflict")
            : portOk(undefined),
        );
      },
    };
    const client = new GitHubApiClient({
      repository: { owner: "uos", name: "fixture", installationId: 42 },
      apiBaseUrl: "https://api.github.com",
      clock: { now: () => now },
      cooldownGate: gate,
      auth: {
        authorizationHeader: () => {
          order.push("auth");
          return Promise.resolve(portOk("Bearer synthetic"));
        },
      },
      http: () => {
        order.push("http");
        return Promise.resolve(response(429, { "retry-after": "120" }));
      },
    });
    const result = await client.listOpenIssues();
    assert.equal(result.ok, false);
    if (mode === "blocked-before-auth") assert.deepEqual(order, ["gate"]);
    if (mode === "blocked-after-auth") {
      assert.deepEqual(order, ["gate", "auth", "gate"]);
    }
    if (mode === "persist-failure" || mode === "record-first") {
      assert.deepEqual(order, ["gate", "auth", "gate", "http", "record"]);
      if (!result.ok) {
        assert.equal(
          result.error.kind,
          mode === "persist-failure" ? "unavailable" : "rate_limited",
        );
        if (mode === "record-first") {
          assert.equal(result.error.rateLimit?.retryNotBefore, now + 120000);
        }
      }
    }
  }
  console.log(
    "PASS 10 classification cases and 4 actual-client request ordering cases",
  );
});

Deno.test("RFC-850 Retry-After years resolve from the observation time", async () => {
  const observedAt = Date.UTC(2026, 8, 15);
  const response = (retryAfter: string) => ({
    status: 403,
    headers: new Headers({
      "x-ratelimit-remaining": "0",
      "retry-after": retryAfter,
    }),
    bodyText: "",
  });

  const nearFuture = await classifyGitHubRateLimit(
    response("Wednesday, 06-Nov-75 08:49:37 GMT"),
    observedAt,
  );
  assert.equal(
    nearFuture?.retryNotBefore,
    Date.UTC(2075, 10, 6, 8, 49, 37),
  );
  assert.equal(nearFuture?.fallback, false);

  const beyondFutureWindow = await classifyGitHubRateLimit(
    response("Saturday, 06-Nov-76 08:49:37 GMT"),
    observedAt,
  );
  assert.equal(beyondFutureWindow?.retryNotBefore, observedAt);
  assert.equal(beyondFutureWindow?.fallback, false);

  const stalePastDate = await classifyGitHubRateLimit(
    response("Saturday, 01-Jan-00 00:00:00 GMT"),
    Date.UTC(2070, 5, 1),
  );
  assert.equal(stalePastDate?.retryNotBefore, Date.UTC(2070, 5, 1));
  assert.equal(stalePastDate?.fallback, false);

  const nearDateUpperBound = await classifyGitHubRateLimit(
    response("Saturday, 06-Nov-60 08:49:37 GMT"),
    new Date(Date.UTC(275650, 8, 15)).getTime(),
  );
  assert.equal(
    nearDateUpperBound?.retryNotBefore,
    Date.parse("Saturday, 06-Nov-275660 08:49:37 GMT"),
  );
  assert.equal(nearDateUpperBound?.fallback, false);

  const outsideDateRange = Number.MAX_SAFE_INTEGER;
  const unrepresentablePrimary = await classifyGitHubRateLimit(
    response("Wednesday, 06-Nov-75 08:49:37 GMT"),
    outsideDateRange,
  );
  assert.equal(unrepresentablePrimary?.retryNotBefore, null);
  assert.equal(unrepresentablePrimary?.fallback, false);

  const unrepresentableSecondary = await classifyGitHubRateLimit(
    {
      status: 429,
      headers: new Headers({
        "retry-after": "Wednesday, 06-Nov-75 08:49:37 GMT",
      }),
      bodyText: "",
    },
    outsideDateRange,
  );
  assert.equal(unrepresentableSecondary?.retryNotBefore, null);
  assert.equal(unrepresentableSecondary?.fallback, false);
});
