// GitHubPort read suite: strict wire parsing (full SHAs, timestamps, nullable
// merge identity, issue-vs-PR distinction, check conclusions), exhaustive
// pagination with cycle/size bounds, partial reads as unavailable, sanitized
// errors and Authorization header use. All fixtures are synthetic.
import assert from "node:assert/strict";

import {
  checkRunWire,
  checksPageWire,
  commitStatusWire,
  FakeAuthProvider,
  issueWire,
  makePort,
  nonFastForwardRuleWire,
  pullRequestRuleWire,
  pullWire,
  refWire,
  reviewDecisionGraphqlWire,
  rulesetWire,
  SHA1,
  SHA2,
  SHA3,
  statusChecksRuleWire,
  statusesPageWire,
} from "./helpers.ts";
import { httpRespond } from "./helpers.ts";

const BASE = "https://api.github.com";
const ISSUES_PATH = "/repos/ubiquity/sentinel/issues";
const BASE_URL = `${BASE}${ISSUES_PATH}`;

function linkNext(url: string): Record<string, string> {
  return { link: `<${url}>; rel="next"` };
}

Deno.test("listOpenIssues: exhausts pagination and distinguishes issues from PRs", async () => {
  const page2Url = `${BASE_URL}?state=open&per_page=100&page=2`;
  const script: import("./helpers.ts").ScriptEntry[] = [
    httpRespond(
      "GET",
      `${ISSUES_PATH}?state=open&per_page=100&page=1`,
      200,
      [issueWire({ number: 1 }), {
        ...pullWire({ number: 9 }),
        pull_request: {},
      }],
      linkNext(page2Url),
    ),
    httpRespond(
      "GET",
      `${ISSUES_PATH}?state=open&per_page=100&page=2`,
      200,
      [issueWire({ number: 2, state: "closed", closed_at: null })],
    ),
  ];
  const { port, transport } = makePort({ script });
  const result = await port.listOpenIssues();
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.length, 2);
  assert.equal(result.value[0].number, 1);
  assert.equal(result.value[1].number, 2);
  // The PR item in the issue list was excluded, never treated as an issue.
  assert.equal(result.value.some((issue) => issue.number === 9), false);
  assert.equal(transport.requests.length, 2); // two pages, no network elsewhere
  assert.equal(
    transport.requests[0].url,
    `${BASE_URL}?state=open&per_page=100&page=1`,
  );
  assert.equal(
    transport.requests[0].headers.get("authorization"),
    "Bearer ghs_synthetic_token_0001",
  );
  assert.equal(transport.requests[1].url, page2Url);
});

Deno.test("listOpenIssues: pagination cycle is unavailable, never a partial list", async () => {
  const url = `${BASE_URL}?state=open&per_page=100&page=1`;
  const script = [
    httpRespond(
      "GET",
      `${ISSUES_PATH}?state=open&per_page=100&page=1`,
      200,
      [issueWire({ number: 1 })],
      linkNext(url),
    ),
  ];
  const { port } = makePort({ script });
  const result = await port.listOpenIssues();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "unavailable");
  assert.ok(result.error.detail.includes("cycle"));
});

Deno.test("listOpenIssues: page bound and mid-pagination failure are unavailable", async () => {
  // Page bound with a tiny maxPages.
  const page2 = `${BASE_URL}?state=open&per_page=100&page=2`;
  const boundScript = [
    httpRespond(
      "GET",
      `${ISSUES_PATH}?state=open&per_page=100&page=1`,
      200,
      [issueWire({ number: 1 })],
      linkNext(page2),
    ),
    httpRespond(
      "GET",
      `${ISSUES_PATH}?state=open&per_page=100&page=2`,
      200,
      [issueWire({ number: 2 })],
      linkNext(`${BASE_URL}?state=open&per_page=100&page=3`),
    ),
  ];
  const { port } = makePort({ script: boundScript, maxPages: 2 });
  const bounded = await port.listOpenIssues();
  assert.equal(bounded.ok, false);
  if (bounded.ok) return;
  assert.equal(bounded.error.kind, "unavailable");
  assert.ok(bounded.error.detail.includes("page bound"));

  // Mid-pagination 500: the partial page is not a success.
  const failScript = [
    httpRespond(
      "GET",
      `${ISSUES_PATH}?state=open&per_page=100&page=1`,
      200,
      [issueWire({ number: 1 })],
      linkNext(`${BASE_URL}?state=open&per_page=100&page=2`),
    ),
    httpRespond(
      "GET",
      `${ISSUES_PATH}?state=open&per_page=100&page=2`,
      500,
      {},
    ),
  ];
  const { port: failing } = makePort({ script: failScript });
  const failed = await failing.listOpenIssues();
  assert.equal(failed.ok, false);
  if (failed.ok) return;
  assert.equal(failed.error.kind, "unavailable");
});

Deno.test("readIssue: oversized body is unavailable (incomplete), never truncated", async () => {
  const bigBody = "x".repeat(16385);
  const { port } = makePort({
    script: [
      httpRespond(
        "GET",
        "/repos/ubiquity/sentinel/issues/1",
        200,
        issueWire({ body: bigBody }),
      ),
    ],
  });
  const result = await port.readIssue(1);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "unavailable");
    assert.ok(result.error.detail.includes("bounds"));
  }
});

Deno.test("readIssue: 404 is null, a PR resource is not an issue, malformed is invalid", async () => {
  const { port } = makePort({
    script: [
      httpRespond("GET", "/repos/ubiquity/sentinel/issues/404", 404, {}),
    ],
  });
  const missing = await port.readIssue(404);
  assert.ok(missing.ok);
  if (missing.ok) assert.equal(missing.value, null);

  const { port: prPort } = makePort({
    script: [
      httpRespond(
        "GET",
        "/repos/ubiquity/sentinel/issues/9",
        200,
        pullWire({ number: 9, pull_request: {} }),
      ),
    ],
  });
  const pr = await prPort.readIssue(9);
  assert.ok(pr.ok);
  if (pr.ok) assert.equal(pr.value, null); // a pull request is not an issue

  const { port: badPort } = makePort({
    script: [
      httpRespond(
        "GET",
        "/repos/ubiquity/sentinel/issues/1",
        200,
        issueWire({ number: "1" }),
      ),
    ],
  });
  const bad = await badPort.readIssue(1);
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.error.kind, "invalid");

  const { port: shaPort } = makePort({
    script: [
      httpRespond(
        "GET",
        "/repos/ubiquity/sentinel/issues/1",
        200,
        issueWire({ number: 1, user: { login: "octocat" } }),
      ),
    ],
  });
  const ok = await shaPort.readIssue(1);
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(ok.value?.labels[0], "bug");
});

Deno.test("readPullRequest: merged identity derived exactly from merge fields", async () => {
  const { port } = makePort({
    script: [
      httpRespond(
        "GET",
        "/repos/ubiquity/sentinel/pulls/12",
        200,
        pullWire({
          number: 12,
          state: "closed",
          merged_at: "2026-09-07T02:00:00Z",
          merge_commit_sha: SHA3,
          review_decision: "approved",
        }),
      ),
    ],
  });
  const result = await port.readPullRequest(12);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(result.value !== null);
  if (result.value === null) return;
  assert.equal(result.value.state, "merged");
  assert.equal(result.value.mergeSha, SHA3);
  assert.equal(
    result.value.mergedAt,
    new Date("2026-09-07T02:00:00Z").getTime(),
  );
  assert.equal(result.value.reviewDecision, "approved");
  assert.equal(result.value.headRef, "sentinel/fix-1");
  assert.equal(result.value.baseRef, "development");
});

Deno.test("readPullRequest: missing merge sha on a merged PR is invalid", async () => {
  const { port } = makePort({
    script: [
      httpRespond(
        "GET",
        "/repos/ubiquity/sentinel/pulls/12",
        200,
        pullWire({
          state: "closed",
          merged_at: "2026-09-07T02:00:00Z",
          merge_commit_sha: null,
        }),
      ),
    ],
  });
  const result = await port.readPullRequest(12);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "invalid");
});

Deno.test(
  "readPullRequest: unmerged test merge sha is ignored as delivery identity",
  async () => {
    const { port } = makePort({
      script: [
        httpRespond(
          "GET",
          "/repos/ubiquity/sentinel/pulls/12",
          200,
          pullWire({
            state: "open",
            merged_at: null,
            merge_commit_sha: SHA3,
          }),
        ),
      ],
    });
    const result = await port.readPullRequest(12);
    assert.ok(result.ok);
    if (!result.ok || result.value === null) return;
    assert.equal(result.value.state, "open");
    assert.equal(result.value.mergedAt, null);
    assert.equal(result.value.mergeSha, null);
  },
);

Deno.test("readPullRequest: short SHA, bad timestamp and wrong enum fail closed", async () => {
  for (
    const override of [
      { head: { ref: "sentinel/fix-1", sha: "abc123" } },
      { created_at: "not-a-date" },
      { state: "reopened" },
      { review_decision: "lgtm" },
    ]
  ) {
    const { port } = makePort({
      script: [
        httpRespond(
          "GET",
          "/repos/ubiquity/sentinel/pulls/1",
          200,
          pullWire(override),
        ),
      ],
    });
    const result = await port.readPullRequest(1);
    assert.equal(result.ok, false, JSON.stringify(override));
    if (!result.ok) assert.equal(result.error.kind, "invalid");
  }
});

Deno.test("readPullRequestReviewDecision: uses the authoritative GraphQL field", async () => {
  const { client, transport } = makePort({
    script: [
      httpRespond(
        "POST",
        "/graphql",
        200,
        reviewDecisionGraphqlWire("APPROVED"),
      ),
    ],
  });
  const result = await client.readPullRequestReviewDecision(12);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.value, "approved");
  assert.equal(transport.requests[0]?.method, "POST");
  assert.equal(transport.requests[0]?.url, `${BASE}/graphql`);
  const body = JSON.parse(transport.requests[0]?.body ?? "{}");
  assert.equal(body.variables.owner, "ubiquity");
  assert.equal(body.variables.name, "sentinel");
  assert.equal(body.variables.number, 12);
});

Deno.test("findPullRequestByHeadRef: exact single match, multiple matches conflict", async () => {
  const single = makePort({
    script: [httpRespond("GET", "/pulls?head=", 200, [pullWire({
      number: 1,
      head: { ref: "sentinel/fix-1", sha: SHA1 },
    })])],
  });
  const found = await single.port.findPullRequestByHeadRef("sentinel/fix-1");
  assert.ok(found.ok);
  if (!found.ok) return;
  assert.equal(found.value?.number, 1);
  assert.equal(found.value?.state, "open");

  // Two open PRs on one deterministic ref are ambiguous, never first-wins.
  const multiple = makePort({
    script: [httpRespond("GET", "/pulls?head=", 200, [
      pullWire({ number: 1, head: { ref: "sentinel/fix-1", sha: SHA1 } }),
      pullWire({ number: 2, head: { ref: "sentinel/fix-1", sha: SHA1 } }),
    ])],
  });
  const ambiguous = await multiple.port.findPullRequestByHeadRef(
    "sentinel/fix-1",
  );
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) assert.equal(ambiguous.error.kind, "conflict");

  const none = makePort({
    script: [httpRespond("GET", "/pulls?head=", 200, [])],
  });
  const absent = await none.port.findPullRequestByHeadRef("sentinel/other");
  assert.ok(absent.ok);
  if (absent.ok) assert.equal(absent.value, null);
});

Deno.test("readChecks: a run bound to a different head is not evidence for this head", async () => {
  const { port } = makePort({
    script: [
      httpRespond(
        "GET",
        `/repos/ubiquity/sentinel/commits/${SHA1}/check-runs?per_page=100&page=1`,
        200,
        checksPageWire([checkRunWire({ head_sha: SHA2 })]),
      ),
      httpRespond(
        "GET",
        `/repos/ubiquity/sentinel/commits/${SHA1}/statuses?per_page=100&page=1`,
        200,
        statusesPageWire([]),
      ),
    ],
  });
  const result = await port.readChecks(SHA1);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "unavailable");
    assert.ok(result.error.detail.includes("head"));
  }
});

Deno.test("listOpenIssues: item size bound is unavailable, never truncated", async () => {
  const { port } = makePort({
    script: [
      httpRespond(
        "GET",
        `${ISSUES_PATH}?state=open&per_page=100&page=1`,
        200,
        [
          issueWire({ number: 1 }),
          issueWire({ number: 2 }),
          issueWire({ number: 3 }),
        ],
      ),
    ],
    maxItems: 2,
  });
  const result = await port.listOpenIssues();
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "unavailable");
    assert.ok(result.error.detail.includes("bounds"));
  }
});

Deno.test("listOpenIssues: a next URL outside the API origin never carries the token", async () => {
  const { port } = makePort({
    script: [
      httpRespond(
        "GET",
        `${ISSUES_PATH}?state=open&per_page=100&page=1`,
        200,
        [issueWire({ number: 1 })],
        linkNext("https://evil.example/path?page=2"),
      ),
    ],
  });
  const result = await port.listOpenIssues();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "invalid");
});

Deno.test("readChecks: conclusions parsed exactly; empty checks is a real value", async () => {
  const { port } = makePort({
    script: [
      httpRespond(
        "GET",
        `/repos/ubiquity/sentinel/commits/${SHA1}/check-runs?per_page=100&page=1`,
        200,
        checksPageWire([
          checkRunWire({ name: "ci" }),
          checkRunWire({
            name: "lint",
            status: "queued",
            conclusion: null,
            completed_at: null,
          }),
          checkRunWire({
            name: "flake",
            status: "completed",
            conclusion: "failure",
          }),
        ]),
      ),
      httpRespond(
        "GET",
        `/repos/ubiquity/sentinel/commits/${SHA1}/statuses?per_page=100&page=1`,
        200,
        statusesPageWire([commitStatusWire({ context: "legacy-ci" })]),
      ),
    ],
  });
  const result = await port.readChecks(SHA1);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.head, SHA1);
  assert.equal(result.value.checks.length, 4);
  assert.equal(result.value.checks[0].conclusion, "success");
  assert.equal(result.value.checks[1].conclusion, null);
  assert.equal(result.value.checks[1].status, "queued");
  assert.equal(result.value.checks[2].conclusion, "failure");
  assert.equal(result.value.checks[3].name, "legacy-ci");
  assert.equal(result.value.checks[3].conclusion, "success");

  const { port: empty } = makePort({
    script: [
      httpRespond(
        "GET",
        `/repos/ubiquity/sentinel/commits/${SHA1}/check-runs?per_page=100&page=1`,
        200,
        checksPageWire([]),
      ),
      httpRespond(
        "GET",
        `/repos/ubiquity/sentinel/commits/${SHA1}/statuses?per_page=100&page=1`,
        200,
        statusesPageWire([]),
      ),
    ],
  });
  const emptyResult = await empty.readChecks(SHA1);
  assert.ok(emptyResult.ok);
  if (emptyResult.ok) {
    assert.deepEqual(emptyResult.value.checks, []);
    assert.equal(emptyResult.value.head, SHA1);
  }
});

Deno.test("readProtections: 404 means genuinely unprotected; strict rules parsed", async () => {
  const { port } = makePort({
    script: [
      httpRespond(
        "GET",
        "/repos/ubiquity/sentinel/branches/development/protection",
        404,
        {},
      ),
    ],
  });
  const unprotected = await port.readProtections("development");
  assert.ok(unprotected.ok);
  if (!unprotected.ok) return;
  assert.equal(unprotected.value.protected, false);
  assert.equal(unprotected.value.requiredStatusChecks.length, 0);
  assert.equal(unprotected.value.requireBranchUpToDate, false);

  const { port: strictPort } = makePort({
    script: [
      httpRespond(
        "GET",
        "/repos/ubiquity/sentinel/branches/development/protection",
        200,
        {
          required_status_checks: {
            strict: true,
            contexts: [],
            checks: [{ context: "ci", app_id: 3 }],
          },
          enforce_admins: { enabled: true },
          required_pull_request_reviews: { required_approving_review_count: 1 },
        },
      ),
    ],
  });
  const strict = await strictPort.readProtections("development");
  assert.ok(strict.ok);
  if (!strict.ok) return;
  assert.equal(strict.value.protected, true);
  assert.equal(strict.value.requireBranchUpToDate, true);
  assert.equal(strict.value.enforceAdmins, true);
  assert.deepEqual(strict.value.requiredStatusChecks, ["ci"]);
  assert.equal(strict.value.requiredApprovingReviewCount, 1);
});

Deno.test("readRef: exact identity or null; ref mismatch is invalid", async () => {
  const { port } = makePort({
    script: [
      httpRespond(
        "GET",
        "/repos/ubiquity/sentinel/git/ref/heads/sentinel/fix-1",
        200,
        refWire(SHA1),
      ),
    ],
  });
  const found = await port.readRef("heads/sentinel/fix-1");
  assert.ok(found.ok);
  if (found.ok) assert.equal(found.value?.sha, SHA1);

  const { port: missing } = makePort({
    script: [
      httpRespond(
        "GET",
        "/repos/ubiquity/sentinel/git/ref/heads/other",
        404,
        {},
      ),
    ],
  });
  const absent = await missing.readRef("refs/heads/other");
  assert.ok(absent.ok);
  if (absent.ok) assert.equal(absent.value, null);

  const { port: mismatched } = makePort({
    script: [
      httpRespond(
        "GET",
        "/repos/ubiquity/sentinel/git/ref/heads/other",
        200,
        refWire(SHA1, "refs/heads/not-other"),
      ),
    ],
  });
  const bad = await mismatched.readRef("heads/other");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.kind, "invalid");
});

Deno.test("reads: auth failure and rate limit are typed, sanitized, no URL echo", async () => {
  const auth = new FakeAuthProvider("Bearer ghs_synthetic_token_0001", {
    kind: "auth_failed",
    detail: "expired credential",
  });
  const { port } = makePort({ script: [], auth });
  const result = await port.readIssue(1);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "auth_failed");
    assert.ok(!result.error.detail.includes("ghs_synthetic"));
  }

  const { port: limited } = makePort({
    script: [
      httpRespond("GET", "/repos/ubiquity/sentinel/issues/1", 403, {}, {
        "x-ratelimit-remaining": "0",
      }),
    ],
  });
  const limitedResult = await limited.readIssue(1);
  assert.equal(limitedResult.ok, false);
  if (!limitedResult.ok) {
    assert.equal(limitedResult.error.kind, "rate_limited");
    assert.ok(!limitedResult.error.detail.includes("api.github.com"));
  }
});

Deno.test("readEffectiveProtections: branch rules paginate exhaustively and parse exact shapes", async () => {
  const base = `${BASE}/repos/ubiquity/sentinel`;
  const page1 = `${base}/rules/branches/development?per_page=100&page=1`;
  const page2 = `${base}/rules/branches/development?per_page=100&page=2`;
  const script = [
    httpRespond("GET", page1, 200, [
      statusChecksRuleWire(),
      pullRequestRuleWire(),
    ], linkNext(page2)),
    httpRespond("GET", page2, 200, [nonFastForwardRuleWire()]),
    httpRespond(
      "GET",
      `${base}/rulesets?includes_parents=true&per_page=100&page=1`,
      200,
      [rulesetWire()],
    ),
  ];
  const { port } = makePort({ script });
  const result = await port.readEffectiveProtections("development");
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value.requiredCheckNames, ["ci"]);
  assert.equal(result.value.strictRequiredChecks, true);
  assert.equal(result.value.requiredApprovingReviewCount, 0);
  assert.deepEqual(result.value.activeRuleTypes, [
    "non_fast_forward",
    "pull_request",
    "required_status_checks",
  ]);
  assert.deepEqual(result.value.unsupportedRuleTypes, []);
  assert.equal(result.value.mergeQueueActive, false);
  assert.equal(result.value.bypassUnknown, false);
  assert.deepEqual(result.value.bypassActors, []);
});

Deno.test("readEffectiveProtections: malformed or unsupported rules are retained, never guessed", async () => {
  const base = `${BASE}/repos/ubiquity/sentinel`;
  // Malformed rule shape (type is a number) fails the wire parse.
  const malformed = makePort({
    script: [
      httpRespond(
        "GET",
        `${base}/rules/branches/development?per_page=100&page=1`,
        200,
        [{ type: 7 }],
      ),
      httpRespond(
        "GET",
        `${base}/rulesets?includes_parents=true&per_page=100&page=1`,
        200,
        [rulesetWire()],
      ),
    ],
  });
  const bad = await malformed.port.readEffectiveProtections("development");
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.error.kind, "invalid");

  // Unknown rule types stay visible so the merge gate can fail closed.
  const { port } = makePort({
    script: [
      httpRespond(
        "GET",
        `${base}/rules/branches/development?per_page=100&page=1`,
        200,
        [
          statusChecksRuleWire(),
          pullRequestRuleWire(),
          { type: "required_workflows", id: 16, ruleset_id: 10 },
          { type: "something_new", id: 17, ruleset_id: 10 },
        ],
      ),
      httpRespond(
        "GET",
        `${base}/rulesets?includes_parents=true&per_page=100&page=1`,
        200,
        [rulesetWire()],
      ),
    ],
  });
  const result = await port.readEffectiveProtections("development");
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value.unsupportedRuleTypes, [
    "required_workflows",
    "something_new",
  ]);
});

Deno.test("readEffectiveProtections: omitted bypass policy is unknown and detail is fetched", async () => {
  const base = `${BASE}/repos/ubiquity/sentinel`;
  // The list omits bypass_actors/current_user_can_bypass: the exact ruleset
  // detail is fetched; if the detail still omits the policy → unknown.
  const { port, transport } = makePort({
    script: [
      httpRespond(
        "GET",
        `${base}/rules/branches/development?per_page=100&page=1`,
        200,
        [statusChecksRuleWire(), pullRequestRuleWire()],
      ),
      httpRespond(
        "GET",
        `${base}/rulesets?includes_parents=true&per_page=100&page=1`,
        200,
        [rulesetWire({ bypass_actors: null, current_user_can_bypass: null })],
      ),
      httpRespond("GET", `${base}/rulesets/10`, 200, rulesetWire()),
    ],
  });
  const result = await port.readEffectiveProtections("development");
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.bypassUnknown, false);
  const detail = transport.requests.find((request) =>
    request.url.endsWith("/rulesets/10")
  );
  assert.ok(detail !== undefined, "ruleset detail was not fetched");

  // Detail denied: the omitted policy is provably unknown and blocks.
  const denied = makePort({
    script: [
      httpRespond(
        "GET",
        `${base}/rules/branches/development?per_page=100&page=1`,
        200,
        [statusChecksRuleWire(), pullRequestRuleWire()],
      ),
      httpRespond(
        "GET",
        `${base}/rulesets?includes_parents=true&per_page=100&page=1`,
        200,
        [rulesetWire({ bypass_actors: null, current_user_can_bypass: null })],
      ),
      httpRespond("GET", `${base}/rulesets/10`, 404, {}),
    ],
  });
  const unknown = await denied.port.readEffectiveProtections("development");
  assert.ok(unknown.ok);
  if (!unknown.ok) return;
  assert.equal(unknown.value.bypassUnknown, true);
});

Deno.test("readEffectiveProtections: rules pagination cycle is unavailable", async () => {
  const base = `${BASE}/repos/ubiquity/sentinel`;
  const page1 = `${base}/rules/branches/development?per_page=100&page=1`;
  const { port } = makePort({
    script: [
      httpRespond("GET", page1, 200, [
        statusChecksRuleWire(),
        pullRequestRuleWire(),
      ], linkNext(page1)),
    ],
  });
  const result = await port.readEffectiveProtections("development");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "unavailable");
  assert.ok(result.error.detail.includes("cycle"));
});
