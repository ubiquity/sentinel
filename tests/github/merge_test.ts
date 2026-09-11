// mergePullRequest suite: exact-head merge authorization with authoritative
// re-observation of the current review (exact service-receipt binding and
// exact GitHub review id), authenticated human resolution, effective strict
// protections from the actual rules API (active rules + per-ruleset bypass
// policy), exact required checks, required approvals, candidate base ancestry,
// exact merge response reconciliation and REST non-atomic base handling. All
// fixtures are synthetic and no real external service is contacted.
import assert from "node:assert/strict";

import type { MergeRequestV1 } from "../../src/contracts/ports.ts";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { asFindingFingerprint } from "../../src/contracts/brands.ts";
import { canonicalStringifySha256 } from "../../src/contracts/canonical.ts";
import {
  findingMessage,
  type ReviewResultV1,
} from "../../src/github/review-journal.ts";
import type { ScriptedHttpTransport } from "./helpers.ts";

import {
  checkRunWire,
  checksPageWire,
  commentWire,
  commitStatusWire,
  completedServiceRead,
  FakeClock,
  FakeGitExecutor,
  FakeResolutionVerifier,
  FakeReviewService,
  httpRespond,
  makePort,
  mergeResponseWire,
  nonFastForwardRuleWire,
  pullRequestRuleWire,
  pullWire,
  REPO,
  reviewDecisionGraphqlWire,
  REVIEWER,
  reviewWire,
  RULESET_ID,
  rulesetWire,
  SHA1,
  SHA2,
  SHA3,
  SHA4,
  statusChecksRuleWire,
  statusesPageWire,
  structuredCompletedFixture,
  T0,
} from "./helpers.ts";
import type { ScriptEntry } from "./helpers.ts";

const CLOCK = new FakeClock(T0 + 200_000);
/** The canonical structured completion every positive merge fixture binds. */
const CLEAN_COMPLETION = await structuredCompletedFixture();
const RULES_PATH =
  "/repos/ubiquity/sentinel/rules/branches/development?per_page=100&page=1";
const RULESETS_PATH =
  "/repos/ubiquity/sentinel/rulesets?includes_parents=true&per_page=100&page=1";
const CHECKS_PATH =
  `/repos/ubiquity/sentinel/commits/${SHA1}/check-runs?per_page=100&page=1`;
const STATUSES_PATH =
  `/repos/ubiquity/sentinel/commits/${SHA1}/statuses?per_page=100&page=1`;

function completedCleanReceipt(
  overrides: Record<string, unknown> = {},
): ReviewReceiptV1 {
  return parseReviewReceiptV1({
    version: "v1",
    kind: "review_receipt",
    // The receipt id is derived from the submission operation key.
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
    ...overrides,
  });
}

function mergeRequest(overrides: Partial<MergeRequestV1> = {}): MergeRequestV1 {
  return {
    pullRequestNumber: 1,
    expectedHead: SHA1,
    expectedBase: SHA2,
    review: completedCleanReceipt(),
    ...overrides,
  };
}

function pullEntry(
  overrides: Record<string, unknown> = {},
  repeat = false,
): ScriptEntry {
  return {
    ...httpRespond(
      "GET",
      "/repos/ubiquity/sentinel/pulls/1",
      200,
      pullWire({
        number: 1,
        head: { ref: "sentinel/fix-1", sha: SHA1 },
        base: { ref: "development", sha: SHA2 },
        ...overrides,
      }),
    ),
    repeat,
  };
}

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

/** Default active rules: strict status checks, pull_request, non-fast-forward. */
function defaultRules(): unknown[] {
  return [
    statusChecksRuleWire(),
    pullRequestRuleWire(),
    nonFastForwardRuleWire(),
  ];
}

function rulesRead(
  rules: unknown[] = defaultRules(),
  rulesets: unknown[] = [rulesetWire()],
): ScriptEntry[] {
  return [
    httpRespond("GET", RULES_PATH, 200, rules),
    httpRespond("GET", RULESETS_PATH, 200, rulesets),
  ];
}

function checksRead(
  runs: unknown[] = [checkRunWire()],
  repeat = false,
  statuses: unknown[] = [],
): ScriptEntry[] {
  return [
    {
      ...httpRespond("GET", CHECKS_PATH, 200, checksPageWire(runs)),
      repeat,
    },
    {
      ...httpRespond("GET", STATUSES_PATH, 200, statusesPageWire(statuses)),
      repeat,
    },
  ];
}

interface HappyOptions {
  pulls?: ScriptEntry[];
  rules?: unknown[];
  rulesets?: unknown[];
  checks?: unknown[];
  statuses?: unknown[];
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  extra?: ScriptEntry[];
}

function happyScript(options: HappyOptions = {}): ScriptEntry[] {
  return [
    ...(options.pulls ?? [pullEntry(), pullEntry()]),
    reviewsRead([CLEAN_COMPLETION.review]),
    commentsRead([]),
    ...rulesRead(
      options.rules ?? defaultRules(),
      options.rulesets ?? [rulesetWire()],
    ),
    ...checksRead(
      options.checks ?? [checkRunWire()],
      false,
      options.statuses ?? [],
    ),
    {
      ...httpRespond(
        "POST",
        "/graphql",
        200,
        reviewDecisionGraphqlWire(options.reviewDecision ?? "APPROVED"),
      ),
      repeat: true,
    },
    ...(options.extra ?? []),
  ];
}

function trustedService(): FakeReviewService {
  const service = new FakeReviewService();
  service.readResult = CLEAN_COMPLETION.service;
  return service;
}

function mergedPort(script: ScriptEntry[]) {
  const service = trustedService();
  return makePort({ clock: CLOCK, script, review: service });
}

function blockedReason(
  result: Awaited<ReturnType<typeof mergeCall>>,
): string | null {
  if (!result.ok || result.value.outcome !== "blocked") return null;
  return result.value.reason;
}

function mergeCall(port: ReturnType<typeof makePort>["port"]) {
  return port.mergePullRequest(mergeRequest());
}

function putCount(transport: ScriptedHttpTransport): number {
  return transport.requests.filter((request) => request.method === "PUT")
    .length;
}

Deno.test("mergePullRequest: exact-head merge after full authoritative verification", async () => {
  const { port, transport } = mergedPort(happyScript({
    extra: [
      httpRespond(
        "PUT",
        "/repos/ubiquity/sentinel/pulls/1/merge",
        200,
        mergeResponseWire(SHA3),
      ),
    ],
  }));
  const result = await mergeCall(port);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    outcome: "merged",
    head: SHA1,
    mergeSha: SHA3,
  });
  assert.equal(putCount(transport), 1);
  const put = transport.requests.find((request) => request.method === "PUT");
  assert.ok(put !== undefined);
  assert.deepEqual(JSON.parse(put.body ?? "{}"), { sha: SHA1 });
  const rulesRequest = transport.requests.find((request) =>
    request.url.includes("/rules/branches/development")
  );
  assert.ok(rulesRequest !== undefined);
  const rulesetsRequest = transport.requests.find((request) =>
    request.url.includes("/rulesets?")
  );
  assert.ok(rulesetsRequest !== undefined);
});

Deno.test("mergePullRequest: head/base/author/closed checks fail closed with zero merge calls", async () => {
  // The request stays self-consistent; the authoritative PR differs. Each
  // case fails before the review/protection gate with no merge attempt.
  const headMoved = mergedPort([
    pullEntry({ head: { ref: "sentinel/fix-1", sha: SHA3 } }),
  ]);
  const headMismatch = await headMoved.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(headMismatch), "head_mismatch");
  assert.equal(putCount(headMoved.transport), 0);

  const baseMoved = mergedPort([
    pullEntry({ base: { ref: "development", sha: SHA4 } }),
  ]);
  const baseMismatch = await baseMoved.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(baseMismatch), "base_mismatch");
  assert.equal(putCount(baseMoved.transport), 0);

  const humanPort = mergedPort([pullEntry({ user: { login: "octocat" } })]);
  const human = await humanPort.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(human), "conflict");
  assert.equal(putCount(humanPort.transport), 0);

  const closedPort = mergedPort([
    pullEntry({ state: "closed", merged_at: null, merge_commit_sha: null }),
  ]);
  const closed = await closedPort.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(closed), "conflict");
  assert.equal(putCount(closedPort.transport), 0);

  const missingPort = mergedPort([
    httpRespond("GET", "/repos/ubiquity/sentinel/pulls/404", 404, {}),
  ]);
  const missing = await missingPort.port.mergePullRequest(mergeRequest({
    pullRequestNumber: 404,
    review: completedCleanReceipt({
      pullRequest: { number: 404, head: SHA1, base: SHA2 },
    }),
  }));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.kind, "not_found");
  assert.equal(putCount(missingPort.transport), 0);
});

Deno.test("mergePullRequest: already-merged PR reconciles to the exact merge identity", async () => {
  const { port } = mergedPort([
    pullEntry({
      state: "closed",
      merged_at: "2026-09-07T02:00:00Z",
      merge_commit_sha: SHA3,
    }),
  ]);
  const result = await port.mergePullRequest(mergeRequest());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    outcome: "merged",
    head: SHA1,
    mergeSha: SHA3,
  });
});

Deno.test("mergePullRequest: malformed or unverifiable requests are invalid", async () => {
  const { port } = mergedPort(happyScript());
  const unresolved = await port.mergePullRequest(mergeRequest({
    review: completedCleanReceipt({
      findings: [{
        id: "github-comment-500",
        severity: "P1",
        path: "src/main.ts",
        message: "[P1] broken error handling",
        fingerprint: "a".repeat(64),
        resolved: false,
        resolutionEvidence: null,
      }],
      unresolvedSeverities: ["P1"],
    }),
  }));
  assert.equal(unresolved.ok, false);
  if (!unresolved.ok) assert.equal(unresolved.error.kind, "invalid");

  const wrongReviewer = await port.mergePullRequest(mergeRequest({
    review: completedCleanReceipt({
      expectedReviewer: "coderabbitai[bot]",
      observedReviewer: "coderabbitai[bot]",
    }),
  }));
  assert.equal(wrongReviewer.ok, false);
  if (!wrongReviewer.ok) assert.equal(wrongReviewer.error.kind, "invalid");

  const wrongRepo = await port.mergePullRequest(mergeRequest({
    review: completedCleanReceipt({
      repository: { owner: "other", name: "repo", installationId: 2 },
    }),
  }));
  assert.equal(wrongRepo.ok, false);
  if (!wrongRepo.ok) assert.equal(wrongRepo.error.kind, "invalid");
});

Deno.test("mergePullRequest: authoritative review must be current and match exactly", async () => {
  // The service reports the request as pending: blocking, not merging.
  const service = new FakeReviewService();
  service.readResult = completedServiceRead({
    status: "pending",
    resultId: null,
    completedAt: null,
    terminalTurnSucceeded: false,
    outputPresent: false,
  });
  const pendingPort = makePort({
    clock: CLOCK,
    script: happyScript(),
    review: service,
  });
  const pending = await pendingPort.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(pending), "review_required");
  assert.equal(putCount(pendingPort.transport), 0);

  // A completed service read but an UNKNOWN GitHub finding (unparseable
  // badge): the normalization is unavailable and never authorizes.
  const unknownPort = mergedPort([
    pullEntry(),
    pullEntry(),
    reviewsRead([
      reviewWire({
        id: 100,
        state: "COMMENTED",
        body: "Review findings below",
      }),
    ]),
    commentsRead([commentWire({
      id: 500,
      body: "![P1 Badge](https://example.invalid/P1) Fix credential exposure",
    })]),
    ...rulesRead(),
    ...checksRead(),
  ]);
  const unknown = await unknownPort.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(unknown), "review_required");
  assert.equal(putCount(unknownPort.transport), 0);

  // The GitHub evidence contains a P1 finding but the request receipt is
  // clean: the finding set must match the authoritative normalization.
  const mismatchPort = mergedPort([
    pullEntry(),
    pullEntry(),
    reviewsRead([
      reviewWire({ id: 100, state: "CHANGES_REQUESTED", body: null }),
    ]),
    commentsRead([
      commentWire({ id: 500, body: "[P1] broken error handling" }),
    ]),
    ...rulesRead(),
    ...checksRead(),
  ]);
  const mismatch = await mismatchPort.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(mismatch), "review_required");
  assert.equal(putCount(mismatchPort.transport), 0);
});

Deno.test("mergePullRequest: wrong service receipt binding never authorizes", async () => {
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
    { name: "wrong-base", override: { expectedBase: SHA3 } },
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
    { name: "wrong-review-id", override: { githubReviewId: 999 } },
    { name: "missing-base", override: { expectedBase: null } },
  ];
  for (const item of cases) {
    const service = new FakeReviewService();
    service.readResult = completedServiceRead(item.override);
    const { port, transport } = makePort({
      clock: CLOCK,
      script: happyScript(),
      review: service,
    });
    const result = await port.mergePullRequest(mergeRequest());
    assert.equal(blockedReason(result), "review_required", item.name);
    assert.equal(putCount(transport), 0, item.name);
  }
});

Deno.test("mergePullRequest: human resolution requires the trusted authenticated resolver", async () => {
  // The authoritative GitHub evidence is one structured journal carrying the
  // same P0 finding the request receipt resolves.
  const evidenceResult: ReviewResultV1 = {
    verdict: "findings",
    summary: "data loss",
    findings: [{
      priority: 0,
      title: "Data loss",
      body: "The change loses committed data.",
      path: "src/main.ts",
      lineStart: 1,
      lineEnd: 1,
    }],
  };
  const evidenceFixture = await structuredCompletedFixture({
    result: evidenceResult,
  });
  const findingBase = {
    id: "github-review-100-finding-0",
    severity: "P0",
    path: "src/main.ts",
    message: findingMessage(evidenceResult.findings[0]),
  };
  const realFingerprint = asFindingFingerprint(
    await canonicalStringifySha256(findingBase),
  );
  const resolvedFinding = {
    ...findingBase,
    fingerprint: realFingerprint,
    resolved: true,
    resolutionEvidence: {
      authorizingIdentity: "some-human",
      reference: "resolution-ref:12345",
    },
  };
  const evidenceScript: ScriptEntry[] = [
    pullEntry(),
    pullEntry(),
    reviewsRead([evidenceFixture.review]),
    commentsRead([]),
    ...rulesRead([], []), // No active rules: the protection gate reads empty.
    ...checksRead(),
  ];
  const evidenceService = (): FakeReviewService => {
    const service = new FakeReviewService();
    service.readResult = evidenceFixture.service;
    return service;
  };
  const resolvedRequest = () =>
    mergeRequest({
      review: completedCleanReceipt({
        summary: evidenceResult.summary,
        findings: [resolvedFinding],
        unresolvedSeverities: [],
      }),
    });

  // Author allowlist alone is never authentication: without the resolver
  // integration every resolved finding fail closes.
  const allowlistOnly = makePort({
    clock: CLOCK,
    script: evidenceScript,
    review: evidenceService(),
    trustedResolutionAuthors: ["some-human"],
  });
  const noVerifier = await allowlistOnly.port.mergePullRequest(
    resolvedRequest(),
  );
  assert.equal(blockedReason(noVerifier), "review_required");
  assert.equal(putCount(allowlistOnly.transport), 0);

  // A resolver that does not authenticate (unverified) is also insufficient.
  const unverifiedPort = makePort({
    clock: CLOCK,
    script: evidenceScript,
    review: evidenceService(),
    trustedResolutionAuthors: ["some-human"],
    resolutionVerifier: new FakeResolutionVerifier(false, "some-human"),
  });
  const denied = await unverifiedPort.port.mergePullRequest(resolvedRequest());
  assert.equal(blockedReason(denied), "review_required");
  assert.equal(putCount(unverifiedPort.transport), 0);

  // The resolver must authenticate the exact recorded authorizing identity.
  const wrongIdentityPort = makePort({
    clock: CLOCK,
    script: evidenceScript,
    review: evidenceService(),
    trustedResolutionAuthors: ["some-human"],
    resolutionVerifier: new FakeResolutionVerifier(true, "other-human"),
  });
  const noIdentity = await wrongIdentityPort.port.mergePullRequest(
    resolvedRequest(),
  );
  assert.equal(blockedReason(noIdentity), "review_required");
  assert.equal(putCount(wrongIdentityPort.transport), 0);

  // A forged finding fingerprint is recomputed and rejected.
  const forgedPort = makePort({
    clock: CLOCK,
    script: evidenceScript,
    review: evidenceService(),
    trustedResolutionAuthors: ["some-human"],
    resolutionVerifier: new FakeResolutionVerifier(true, "some-human"),
  });
  const forgedResult = await forgedPort.port.mergePullRequest(mergeRequest({
    review: completedCleanReceipt({
      summary: evidenceResult.summary,
      findings: [{ ...resolvedFinding, fingerprint: "c".repeat(64) }],
      unresolvedSeverities: [],
    }),
  }));
  assert.equal(blockedReason(forgedResult), "review_required");
  assert.equal(putCount(forgedPort.transport), 0);

  // Trusted authenticated resolver + allowlisted identity: the review gate
  // passes and the adapter reaches the protection gate (no active rules).
  const verifier = new FakeResolutionVerifier(true, "some-human");
  const trustedPort = makePort({
    clock: CLOCK,
    script: evidenceScript,
    review: evidenceService(),
    trustedResolutionAuthors: ["some-human"],
    resolutionVerifier: verifier,
  });
  const gate = await trustedPort.port.mergePullRequest(resolvedRequest());
  assert.equal(blockedReason(gate), "protection_required");
  assert.equal(putCount(trustedPort.transport), 0);
  assert.equal(verifier.checks.length, 1);
  const check = verifier.checks[0];
  assert.deepEqual(check.repository, REPO);
  assert.equal(check.prNumber, 1);
  assert.equal(check.head, SHA1);
  assert.equal(check.authorizingIdentity, "some-human");
  assert.equal(check.reference, "resolution-ref:12345");
  assert.equal(check.findingFingerprint, realFingerprint);
});

Deno.test("mergePullRequest: effective protections require active strict non-bypassable rules", async () => {
  const cases: { name: string; rules?: unknown[]; rulesets?: unknown[] }[] = [
    {
      name: "no-active-rules",
      rules: [],
    },
    {
      name: "non-strict-up-to-date",
      rules: [
        statusChecksRuleWire({
          parameters: {
            required_status_checks: [{ context: "ci" }],
            strict_required_status_checks_policy: false,
          },
        }),
        pullRequestRuleWire(),
      ],
    },
    {
      name: "empty-required-checks",
      rules: [
        statusChecksRuleWire({
          parameters: {
            required_status_checks: [],
            strict_required_status_checks_policy: true,
          },
        }),
        pullRequestRuleWire(),
      ],
    },
    {
      name: "no-pull-request-rule",
      rules: [statusChecksRuleWire(), nonFastForwardRuleWire()],
    },
    {
      name: "unknown-rule-type",
      rules: [
        ...defaultRules(),
        { type: "required_linear_history", id: 14, ruleset_id: 10 },
      ],
    },
    {
      name: "merge-queue-rule",
      rules: [
        ...defaultRules(),
        { type: "merge_queue", id: 15, ruleset_id: 10 },
      ],
    },
    {
      name: "bypass-actor-configured",
      rulesets: [rulesetWire({
        bypass_actors: [{
          actor_type: "OrganizationAdmin",
          actor_id: null,
          bypass_mode: "always",
        }],
      })],
    },
    {
      name: "caller-can-bypass",
      rulesets: [rulesetWire({ current_user_can_bypass: "always" })],
    },
    {
      name: "bypass-policy-omitted",
      rulesets: [rulesetWire({
        bypass_actors: null,
        current_user_can_bypass: null,
      })],
    },
    {
      name: "ruleset-missing-from-list",
      rulesets: [],
    },
    {
      name: "thread-resolution-required",
      rules: [
        statusChecksRuleWire(),
        pullRequestRuleWire({
          parameters: {
            allowed_merge_methods: ["merge"],
            dismiss_stale_reviews_on_push: true,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_approving_review_count: 0,
            required_review_thread_resolution: true,
          },
        }),
      ],
    },
  ];
  for (const item of cases) {
    const { port, transport } = mergedPort(happyScript({
      rules: item.rules,
      rulesets: item.rulesets,
    }));
    const result = await port.mergePullRequest(mergeRequest());
    assert.equal(blockedReason(result), "protection_required", item.name);
    assert.equal(putCount(transport), 0, item.name);
  }
});

Deno.test("mergePullRequest: unidentified or contradicting ruleset evidence blocks with zero merge writes", async () => {
  const detailUrl = `/repos/ubiquity/sentinel/rulesets/${RULESET_ID}`;
  const withoutKeys = (keys: string[]) =>
    defaultRules().map((rule) => {
      const copy = { ...(rule as Record<string, unknown>) };
      for (const key of keys) delete copy[key];
      return copy;
    });
  const cases: {
    name: string;
    rules?: unknown[];
    rulesets?: unknown[];
    extra?: ScriptEntry[];
  }[] = [
    {
      name: "active-rule-identity-missing",
      // Every effective rule omits its ruleset_id: no evidence can be bound
      // to its bypass policy and the merge must never proceed.
      rules: withoutKeys(["ruleset_id"]),
      rulesets: [rulesetWire()],
    },
    {
      name: "active-rule-source-binding-missing",
      rules: withoutKeys(["ruleset_source_type", "ruleset_source"]),
      rulesets: [rulesetWire()],
    },
    {
      name: "ruleset-detail-id-mismatch",
      // The list omits the policy, and the exact detail answers the wrong
      // ruleset id: contradictory evidence, not proof of non-bypassable
      // active policy.
      rulesets: [
        rulesetWire({ bypass_actors: null, current_user_can_bypass: null }),
      ],
      extra: [
        httpRespond(
          "GET",
          detailUrl,
          200,
          rulesetWire({
            id: RULESET_ID + 1,
            bypass_actors: [],
            current_user_can_bypass: "never",
          }),
        ),
      ],
    },
    {
      name: "ruleset-detail-source-mismatch",
      rulesets: [
        rulesetWire({ bypass_actors: null, current_user_can_bypass: null }),
      ],
      extra: [
        httpRespond(
          "GET",
          detailUrl,
          200,
          rulesetWire({
            source_type: "Organization",
            source: "other-org",
            bypass_actors: [],
            current_user_can_bypass: "never",
          }),
        ),
      ],
    },
    {
      name: "ruleset-detail-not-active",
      rulesets: [
        rulesetWire({ bypass_actors: null, current_user_can_bypass: null }),
      ],
      extra: [
        httpRespond(
          "GET",
          detailUrl,
          200,
          rulesetWire({
            enforcement: "evaluate",
            bypass_actors: [],
            current_user_can_bypass: "never",
          }),
        ),
      ],
    },
    {
      name: "bypass-policy-missing",
      // Exact detail (matching id/source/enforcement) still omits the bypass
      // policy: unknown, never "no bypass actors".
      rulesets: [
        rulesetWire({ bypass_actors: null, current_user_can_bypass: null }),
      ],
      extra: [
        httpRespond(
          "GET",
          detailUrl,
          200,
          rulesetWire({
            bypass_actors: null,
            current_user_can_bypass: null,
          }),
        ),
      ],
    },
    {
      name: "list-evidence-source-mismatch",
      rulesets: [rulesetWire({
        source_type: "Organization",
        source: "other-org",
      })],
    },
    {
      name: "contributing-ruleset-not-active",
      rulesets: [rulesetWire({ enforcement: "disabled" })],
    },
  ];
  for (const item of cases) {
    const { port, transport } = mergedPort(happyScript({
      rules: item.rules ?? defaultRules(),
      rulesets: item.rulesets ?? [rulesetWire()],
      extra: item.extra ?? [],
    }));
    const result = await port.mergePullRequest(mergeRequest());
    assert.equal(blockedReason(result), "protection_required", item.name);
    assert.equal(putCount(transport), 0, item.name);
  }

  // The exact detail (matching id, source binding and active enforcement)
  // with no bypass actors resolves the omitted list policy: the exact
  // positive path is preserved.
  const positive = mergedPort(happyScript({
    rulesets: [
      rulesetWire({ bypass_actors: null, current_user_can_bypass: null }),
    ],
    extra: [
      httpRespond("GET", detailUrl, 200, rulesetWire()),
      httpRespond(
        "PUT",
        "/repos/ubiquity/sentinel/pulls/1/merge",
        200,
        mergeResponseWire(SHA3),
      ),
    ],
  }));
  const merged = await positive.port.mergePullRequest(mergeRequest());
  assert.ok(merged.ok);
  if (!merged.ok) return;
  assert.deepEqual(merged.value, {
    outcome: "merged",
    head: SHA1,
    mergeSha: SHA3,
  });
  assert.equal(putCount(positive.transport), 1);
});

Deno.test("mergePullRequest: required checks must pass on the exact head", async () => {
  const pendingPort = mergedPort(happyScript({
    checks: [
      checkRunWire({ status: "queued", conclusion: null, completed_at: null }),
    ],
  }));
  const pending = await pendingPort.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(pending), "checks_pending");
  assert.equal(putCount(pendingPort.transport), 0);

  const failedPort = mergedPort(happyScript({
    checks: [checkRunWire({ name: "ci", conclusion: "failure" })],
  }));
  const failed = await failedPort.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(failed), "checks_failed");
  assert.equal(putCount(failedPort.transport), 0);

  // Empty CI: the required check is recorded but never ran → pending.
  const emptyPort = mergedPort(happyScript({ checks: [] }));
  const empty = await emptyPort.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(empty), "checks_pending");
  assert.equal(putCount(emptyPort.transport), 0);

  // Commit statuses are historical and returned newest-first. A newer
  // successful status for a context supersedes an older pending observation.
  const historicalPort = mergedPort(happyScript({
    checks: [checkRunWire({ name: "other" })],
    statuses: [
      commitStatusWire({
        context: "ci",
        state: "success",
        created_at: "2026-09-07T01:00:00Z",
        updated_at: "2026-09-07T01:01:00Z",
      }),
      commitStatusWire({
        context: "ci",
        state: "pending",
        created_at: "2026-09-07T00:00:00Z",
        updated_at: "2026-09-07T00:01:00Z",
      }),
    ],
    extra: [
      httpRespond(
        "PUT",
        "/repos/ubiquity/sentinel/pulls/1/merge",
        200,
        mergeResponseWire(SHA3),
      ),
    ],
  }));
  const historical = await historicalPort.port.mergePullRequest(mergeRequest());
  assert.ok(historical.ok, JSON.stringify(historical));
  if (historical.ok) assert.equal(historical.value.outcome, "merged");

  // Legacy commit-status contexts share the required check namespace with
  // check-runs and must satisfy a required context when the run API has no
  // matching name.
  const legacyPort = mergedPort(happyScript({
    checks: [checkRunWire({ name: "other" })],
    statuses: [commitStatusWire({ context: "ci" })],
    extra: [
      httpRespond(
        "PUT",
        "/repos/ubiquity/sentinel/pulls/1/merge",
        200,
        mergeResponseWire(SHA3),
      ),
    ],
  }));
  const legacy = await legacyPort.port.mergePullRequest(mergeRequest());
  assert.ok(legacy.ok, JSON.stringify(legacy));
  if (legacy.ok) assert.equal(legacy.value.outcome, "merged");
});

Deno.test("mergePullRequest: required approvals must be present", async () => {
  const approverRule = pullRequestRuleWire({
    parameters: {
      allowed_merge_methods: ["merge"],
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_approving_review_count: 1,
      required_review_thread_resolution: false,
    },
  });
  const unapprovedPort = mergedPort(happyScript({
    rules: [statusChecksRuleWire(), approverRule, nonFastForwardRuleWire()],
    reviewDecision: "REVIEW_REQUIRED",
  }));
  const unapproved = await unapprovedPort.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(unapproved), "review_required");
  assert.equal(putCount(unapprovedPort.transport), 0);

  const approvedPort = mergedPort(happyScript({
    pulls: [
      pullEntry({ review_decision: "approved" }),
      pullEntry({ review_decision: "approved" }),
    ],
    rules: [statusChecksRuleWire(), approverRule, nonFastForwardRuleWire()],
    reviewDecision: "APPROVED",
    extra: [
      httpRespond(
        "PUT",
        "/repos/ubiquity/sentinel/pulls/1/merge",
        200,
        mergeResponseWire(SHA3),
      ),
    ],
  }));
  const approved = await approvedPort.port.mergePullRequest(mergeRequest());
  assert.ok(approved.ok);
  if (!approved.ok) return;
  assert.deepEqual(approved.value, {
    outcome: "merged",
    head: SHA1,
    mergeSha: SHA3,
  });
  assert.equal(putCount(approvedPort.transport), 1);
});

Deno.test("mergePullRequest: candidate must contain the exact expected base", async () => {
  const git = new FakeGitExecutor();
  git.ancestryEvery = false;
  const { port, transport } = makePort({
    clock: CLOCK,
    script: happyScript(),
    review: trustedService(),
    git,
  });
  const result = await port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(result), "base_mismatch");
  assert.equal(putCount(transport), 0);
});

Deno.test("mergePullRequest: base movement after the last precheck is reconciled", async () => {
  const { port, transport } = mergedPort([
    pullEntry(),
    pullEntry(),
    reviewsRead([CLEAN_COMPLETION.review]),
    commentsRead([]),
    ...rulesRead(),
    ...checksRead(),
    // The base moved between the precheck and the merge PUT.
    httpRespond("PUT", "/repos/ubiquity/sentinel/pulls/1/merge", 409, {}),
    pullEntry({ base: { ref: "development", sha: SHA4 } }),
  ]);
  const result = await port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(result), "base_mismatch");
  assert.equal(putCount(transport), 1);
});

Deno.test("mergePullRequest: lost merge response reconciles exactly", async () => {
  // Lost PUT but the PR is now merged: reconciled to the exact merge SHA.
  const lostApplied = mergedPort(happyScript({
    extra: [
      {
        kind: "throw",
        method: "PUT",
        urlPart: "/repos/ubiquity/sentinel/pulls/1/merge",
      },
      pullEntry({
        state: "closed",
        merged_at: "2026-09-07T02:00:00Z",
        merge_commit_sha: SHA3,
      }),
    ],
  }));
  const reconciled = await lostApplied.port.mergePullRequest(mergeRequest());
  assert.ok(reconciled.ok);
  if (!reconciled.ok) return;
  assert.deepEqual(reconciled.value, {
    outcome: "merged",
    head: SHA1,
    mergeSha: SHA3,
  });

  // Lost PUT and the PR is still open: ambiguous, never a blind retry.
  const stillOpen = mergedPort(happyScript({
    extra: [
      {
        kind: "throw",
        method: "PUT",
        urlPart: "/repos/ubiquity/sentinel/pulls/1/merge",
      },
      pullEntry(),
    ],
  }));
  const ambiguous = await stillOpen.port.mergePullRequest(mergeRequest());
  assert.ok(ambiguous.ok);
  if (!ambiguous.ok) return;
  assert.deepEqual(ambiguous.value, {
    outcome: "ambiguous",
    head: null,
    mergeSha: null,
  });

  // Lost PUT AND the reconcile read fails: the effect stays ambiguous, never
  // an error and never "no effect".
  const noObservation = mergedPort([
    pullEntry(),
    pullEntry(),
    reviewsRead([CLEAN_COMPLETION.review]),
    commentsRead([]),
    ...rulesRead(),
    ...checksRead(),
    {
      kind: "throw",
      method: "PUT",
      urlPart: "/repos/ubiquity/sentinel/pulls/1/merge",
    },
    {
      kind: "throw",
      method: "GET",
      urlPart: "/repos/ubiquity/sentinel/pulls/1",
    },
  ]);
  const unobserved = await noObservation.port.mergePullRequest(mergeRequest());
  assert.ok(unobserved.ok);
  if (!unobserved.ok) return;
  assert.deepEqual(unobserved.value, {
    outcome: "ambiguous",
    head: null,
    mergeSha: null,
  });
});

Deno.test("mergePullRequest: malformed merge response is invalid, rejected maps by re-observation", async () => {
  const malformed = mergedPort(happyScript({
    extra: [httpRespond("PUT", "/repos/ubiquity/sentinel/pulls/1/merge", 200, {
      merged: true,
      sha: "short",
    })],
  }));
  const invalid = await malformed.port.mergePullRequest(mergeRequest());
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.kind, "invalid");

  // 405 with everything still in order and no re-check clue: the safe
  // non-merge classification is protection_required after re-observation.
  const rejected = mergedPort([
    pullEntry(),
    pullEntry(),
    reviewsRead([CLEAN_COMPLETION.review]),
    commentsRead([]),
    ...rulesRead(),
    ...checksRead(),
    httpRespond("PUT", "/repos/ubiquity/sentinel/pulls/1/merge", 405, {}),
    pullEntry(),
    ...checksRead(),
  ]);
  const blocked = await rejected.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(blocked), "protection_required");
  assert.equal(putCount(rejected.transport), 1);
});

Deno.test("mergePullRequest: unreadable rules fail closed even when classic protection is green", async () => {
  // The actual rules response is malformed: the merge blocks without
  // attempting a merge, and classic protection is never consulted as proof.
  const malformed = mergedPort([
    pullEntry(),
    pullEntry(),
    reviewsRead([CLEAN_COMPLETION.review]),
    commentsRead([]),
    {
      ...httpRespond("GET", RULES_PATH, 200, [{ type: 7 }]),
      repeat: true,
    },
    httpRespond("GET", RULESETS_PATH, 200, [rulesetWire()]),
    ...checksRead(),
  ]);
  const result = await malformed.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(result), "protection_required");
  assert.equal(putCount(malformed.transport), 0);

  // A rules read that fails on the wire (rate limit) is unavailable → block.
  const failed = mergedPort([
    pullEntry(),
    pullEntry(),
    reviewsRead([CLEAN_COMPLETION.review]),
    commentsRead([]),
    {
      ...httpRespond("GET", RULES_PATH, 403, { message: "rate limit" }, {
        "x-ratelimit-remaining": "0",
      }),
      repeat: true,
    },
    httpRespond("GET", RULESETS_PATH, 200, [rulesetWire()]),
    ...checksRead(),
  ]);
  const blocked = await failed.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(blocked), "protection_required");
  assert.equal(putCount(failed.transport), 0);

  // A known rule type with unreadable parameters is unreadable policy.
  const badParams = mergedPort([
    pullEntry(),
    pullEntry(),
    reviewsRead([CLEAN_COMPLETION.review]),
    commentsRead([]),
    httpRespond("GET", RULES_PATH, 200, [
      statusChecksRuleWire({
        parameters: {
          required_status_checks: [{ context: 42 }],
          strict_required_status_checks_policy: true,
        },
      }),
      pullRequestRuleWire(),
    ]),
    httpRespond("GET", RULESETS_PATH, 200, [rulesetWire()]),
    ...checksRead(),
  ]);
  const unreadable = await badParams.port.mergePullRequest(mergeRequest());
  assert.equal(blockedReason(unreadable), "protection_required");
  assert.equal(putCount(badParams.transport), 0);
});

// Merge queue is never a fallback: no call can produce a queue-style outcome.
const _sha: GitSha = SHA4;
void _sha;
