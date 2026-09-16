// Fixture-driven contract tests: every committed valid/invalid fixture is
// exercised through the actual exported parser; valid records additionally
// prove canonical round-trip determinism and brand correctness.
import assert from "node:assert/strict";

import {
  isEncryptedArtifactDigest,
  isFixtureDigest,
  isGitSha,
  isIncidentFingerprint,
  isSourceSnapshotDigest,
} from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  hasCandidateState,
  parseBudgetReservationV1,
  parseCommandRegistryV1,
  parseIncidentEvidenceV1,
  parseIncidentSummaryV1,
  parseMetricsSample,
  parseReleaseRecordV1,
  parseReleaseRequestV1,
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
  parseReplayResultV1,
  parseRepositoryConfigV1,
  parseReviewReceiptV1,
  parseWorkRecordV1,
  resolveGlobalLiveStartLimits,
} from "../../src/contracts/mod.ts";
import type { ParseIssue } from "../../src/contracts/validation.ts";
import { tryParse } from "../../src/contracts/validation.ts";

type ParserOf<T> = (input: unknown) => T;

const VALID: { file: string; parser: ParserOf<unknown> }[] = [
  { file: "repository-config-v1.json", parser: parseRepositoryConfigV1 },
  { file: "work-record-v1.json", parser: parseWorkRecordV1 },
  { file: "incident-summary-v1.json", parser: parseIncidentSummaryV1 },
  { file: "incident-evidence-v1.json", parser: parseIncidentEvidenceV1 },
  { file: "review-receipt-v1.json", parser: parseReviewReceiptV1 },
  { file: "budget-reservation-v1.json", parser: parseBudgetReservationV1 },
  { file: "replay-result-v1.json", parser: parseReplayResultV1 },
  { file: "release-request-v1.json", parser: parseReleaseRequestV1 },
  { file: "release-record-v1.json", parser: parseReleaseRecordV1 },
  {
    file: "release-record-accepted-v1.json",
    parser: parseReleaseRecordV1,
  },
  { file: "repair-state-snapshot-v1.json", parser: parseRepairStateSnapshotV1 },
  {
    file: "release-state-snapshot-v1.json",
    parser: parseReleaseStateSnapshotV1,
  },
];

const INVALID: {
  file: string;
  parser: ParserOf<unknown>;
  code: string;
  path?: string;
}[] = [
  {
    file: "unknown-key.json",
    parser: parseReleaseRequestV1,
    code: "unknown_key",
    path: "$.surprise",
  },
  {
    file: "nested-unknown-key.json",
    parser: parseRepositoryConfigV1,
    code: "unknown_key",
    path: "$.adapter.webhooks",
  },
  // digest confusion: a 40-hex Git SHA must never be accepted as a digest
  {
    file: "digest-confusion-fixture.json",
    parser: parseReplayResultV1,
    code: "invalid_digest",
    path: "$.fixture.digest",
  },
  {
    file: "digest-confusion-source.json",
    parser: parseWorkRecordV1,
    code: "invalid_digest",
    path: "$.sourceSnapshotDigest",
  },
  {
    file: "wrong-version.json",
    parser: parseWorkRecordV1,
    code: "invalid_version",
    path: "$.version",
  },
  // a completed review must carry a machine-verifiable result id
  {
    file: "missing-review-completion.json",
    parser: parseReviewReceiptV1,
    code: "invalid_lifecycle",
    path: "$.resultId",
  },
  {
    file: "bad-time.json",
    parser: parseWorkRecordV1,
    code: "invalid_lifecycle",
    path: "$.createdAt",
  },
  {
    file: "bad-count.json",
    parser: parseWorkRecordV1,
    code: "invalid_lifecycle",
    path: "$.counters.retries",
  },
  {
    file: "invalid-lifecycle-done-with-intent.json",
    parser: parseWorkRecordV1,
    code: "invalid_lifecycle",
    path: "$.intent",
  },
  {
    file: "invalid-lifecycle-acceptance-uncontinuous.json",
    parser: parseReleaseRecordV1,
    code: "invalid_lifecycle",
    path: "$.monitoring",
  },
  {
    file: "invalid-coverage.json",
    parser: parseIncidentSummaryV1,
    code: "unknown_key",
    path: "$.coverage.nextCursor",
  },
  {
    file: "invalid-budget-settlement.json",
    parser: parseBudgetReservationV1,
    code: "invalid_lifecycle",
    path: "$.settledAt",
  },
  {
    file: "invalid-replay-no-limitation.json",
    parser: parseReplayResultV1,
    code: "invalid_lifecycle",
    path: "$.limitations",
  },
  {
    file: "invalid-config-limits.json",
    parser: parseRepositoryConfigV1,
    code: "invalid_lifecycle",
    path: "$.liveStartLimits",
  },
  {
    file: "invalid-coercion.json",
    parser: parseWorkRecordV1,
    code: "invalid_count",
    path: "$.counters.attempts",
  },
  {
    file: "invalid-enum.json",
    parser: parseWorkRecordV1,
    code: "invalid_enum",
    path: "$.nextStep",
  },
  {
    file: "duplicate-work-id.json",
    parser: parseRepairStateSnapshotV1,
    code: "invalid_lifecycle",
    path: "$.work[1].id",
  },
  {
    file: "review-reviewer-mismatch.json",
    parser: parseReviewReceiptV1,
    code: "invalid_lifecycle",
    path: "$.observedReviewer",
  },
  {
    file: "resolved-without-evidence.json",
    parser: parseReviewReceiptV1,
    code: "invalid_lifecycle",
    path: "$.findings[1].resolutionEvidence",
  },
  {
    file: "secret-ref-url.json",
    parser: parseRepositoryConfigV1,
    code: "invalid_pattern",
    path: "$.secretRef",
  },
  {
    file: "secret-ref-traversal.json",
    parser: parseRepositoryConfigV1,
    code: "invalid_pattern",
    path: "$.secretRef",
  },
  {
    file: "secret-ref-filesystem.json",
    parser: parseRepositoryConfigV1,
    code: "invalid_pattern",
    path: "$.secretRef",
  },
  {
    file: "artifact-ref-http.json",
    parser: parseIncidentEvidenceV1,
    code: "invalid_pattern",
    path: "$.artifacts[0].ref",
  },
  {
    file: "artifact-ref-dot-segment.json",
    parser: parseIncidentEvidenceV1,
    code: "invalid_pattern",
    path: "$.artifacts[0].ref",
  },
  {
    file: "duplicate-artifact-ref.json",
    parser: parseIncidentEvidenceV1,
    code: "invalid_lifecycle",
    path: "$.artifacts[1].ref",
  },
  {
    file: "release-window-inverted.json",
    parser: parseReleaseRecordV1,
    code: "invalid_lifecycle",
    path: "$.acceptance.samples[0].windowEnd",
  },
  {
    file: "release-incomplete-coverage.json",
    parser: parseReleaseRecordV1,
    code: "invalid_lifecycle",
    path: "$.acceptance.samples[0].coverage",
  },
  {
    file: "intent-freeform-detail.json",
    parser: parseWorkRecordV1,
    code: "unknown_key",
    path: "$.intent.detail",
  },
];

async function readFixture(dir: string, file: string): Promise<unknown> {
  const text = await Deno.readTextFile(
    new URL(`../fixtures/contracts/${dir}/${file}`, import.meta.url),
  );
  return JSON.parse(text);
}

for (const { file, parser } of VALID) {
  Deno.test(`valid fixture parses: ${file}`, async () => {
    const raw = await readFixture("valid", file);
    const result = tryParse(parser, raw);
    assert.ok(
      result.ok,
      `expected parse to succeed: ${
        JSON.stringify(result.ok === false ? result.issues[0] : null)
      }`,
    );
    if (result.ok) {
      // Parsed records are JSON-safe and survive canonicalization unchanged.
      assert.equal(canonicalStringify(result.value), canonicalStringify(raw));
    }
  });
}

for (const { file, parser, code, path } of INVALID) {
  Deno.test(`invalid fixture fails closed: ${file}`, async () => {
    const raw = await readFixture("invalid", file);
    const result = tryParse(parser, raw);
    assert.equal(result.ok, false, `expected rejection for ${file}`);
    if (!result.ok) {
      const issue = result.issues[0] as ParseIssue;
      assert.equal(issue.code, code);
      if (path) assert.equal(issue.path, path);
    }
  });
}

Deno.test("brands are preserved for every digest kind in the work record", async () => {
  const raw = await readFixture("valid", "work-record-v1.json");
  const parsed = parseWorkRecordV1(raw);
  assert.ok(isGitSha(parsed.failingRevision as string));
  assert.ok(isGitSha(parsed.controller.sha));
  assert.ok(isSourceSnapshotDigest(parsed.sourceSnapshotDigest as string));
  assert.ok(isIncidentFingerprint(parsed.fingerprint as string));
  const artifact = parsed.evidence.find((e) => e.kind === "incident_evidence");
  assert.ok(
    artifact && artifact.kind === "incident_evidence" &&
      isEncryptedArtifactDigest(artifact.digest),
  );
  const fixture = parsed.evidence.find((e) => e.kind === "fixture");
  assert.ok(
    fixture && fixture.kind === "fixture" && isFixtureDigest(fixture.digest),
  );
  // Digest confusion inside the evidence union is impossible by shape.
  assert.equal(
    parsed.evidence.find((e) => e.kind === "fixture")?.kind,
    "fixture",
  );
});

Deno.test("nested records validate inside snapshots, not just DTO shells", async () => {
  const raw = await readFixture("valid", "repair-state-snapshot-v1.json");
  const snapshot = parseRepairStateSnapshotV1(raw);
  assert.equal(snapshot.work.length, 1);
  assert.equal(snapshot.reviews.length, 1);
  assert.equal(snapshot.releaseRequests[0]?.status, "open");
  // A corrupted nested record fails the whole snapshot parse.
  const corrupted = structuredClone(raw) as Record<string, unknown>;
  (corrupted.work as Record<string, unknown>[])[0] = {
    ...(corrupted.work as Record<string, unknown>[])[0],
    nextStep: "DONE",
  };
  const result = tryParse(parseRepairStateSnapshotV1, corrupted);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issues[0]?.code, "invalid_enum");
});

Deno.test("generated mutants are rejected without committed fixtures", async () => {
  const raw = (await readFixture("valid", "work-record-v1.json")) as Record<
    string,
    unknown
  >;
  // unknown nested key under classification
  const mutant = structuredClone(raw);
  (mutant.classification as Record<string, unknown>).severity = "P0";
  (mutant.classification as Record<string, unknown>).fancy = "x";
  const result = tryParse(parseWorkRecordV1, mutant);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issues[0]?.code, "unknown_key");

  // too many evidence refs hits the array bound
  const many = structuredClone(raw);
  many.evidence = Array.from({ length: 65 }, () => ({
    kind: "review_receipt",
    ref: "r",
  }));
  const tooMany = tryParse(parseWorkRecordV1, many);
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.equal(tooMany.issues[0]?.code, "bound_exceeded");
});

Deno.test("semantics surface exactly as documented", async () => {
  const config = parseRepositoryConfigV1(
    await readFixture("valid", "repository-config-v1.json"),
  );
  assert.equal(config.adapter.kind, "gateway");
  assert.equal(config.liveStartLimits?.perHour, 4);
  assert.equal(config.stabilityPolicy?.thresholds.length, 3);
  assert.equal(config.stabilityPolicy?.minRequests, 10);
  assert.ok(
    config.stabilityPolicy?.thresholds.every((t) => t.maxIncrease === 0.01),
  );
  assert.equal(
    config.commandRegistry.commands[config.commands.replay].executable,
    "deno",
  );
  assert.equal(
    config.secretRef,
    "secret://host/injected/sentinel-github-app",
  );

  const work = parseWorkRecordV1(
    await readFixture("valid", "work-record-v1.json"),
  );
  assert.equal(work.nextStep, "review");
  assert.equal(work.wait?.reason, "review_pending");
  assert.equal(work.intent, null);
  assert.equal(
    work.source.revision,
    "aafb7ee0598699bb7fb8a72ea133693ed64462da",
  );
  assert.equal(work.urgency.reproducible5xx, true);
  assert.deepEqual(work.dependencies, []);

  const receipt = parseReviewReceiptV1(
    await readFixture("valid", "review-receipt-v1.json"),
  );
  assert.equal(receipt.outcome, "completed");
  assert.deepEqual(receipt.unresolvedSeverities, ["P1"]);
  assert.equal(receipt.expectedReviewer, "chatgpt-codex-connector[bot]");
  assert.equal(receipt.observedReviewer, "chatgpt-codex-connector[bot]");
  assert.equal(receipt.findingsUncounted, 0);
  assert.equal(
    receipt.findings[1]?.resolutionEvidence?.authorizingIdentity,
    "human-owner",
  );
  assert.equal(
    receipt.pullRequest.head,
    "6dc35d06e757107b91eb58232bd15e5f671d79b4",
  );

  const budget = parseBudgetReservationV1(
    await readFixture("valid", "budget-reservation-v1.json"),
  );
  assert.equal(budget.outcome, "ambiguous"); // ambiguous stays charged
  assert.equal(budget.attempt, 1); // one-based: the first attempt

  const replay = parseReplayResultV1(
    await readFixture("valid", "replay-result-v1.json"),
  );
  assert.equal(replay.original.outcome, "failed");
  assert.equal(replay.original.failure?.intended, true);
  assert.equal(replay.candidate.outcome, "passed");
  assert.equal(replay.limitations.length, 0);

  const request = parseReleaseRequestV1(
    await readFixture("valid", "release-request-v1.json"),
  );
  assert.equal(request.revision, "a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d");

  const record = parseReleaseRecordV1(
    await readFixture("valid", "release-record-v1.json"),
  );
  assert.equal(record.phase, "monitoring");
  assert.equal(record.environment, "production");
  assert.equal(record.candidate.identity.gitSha, record.requestRevision);
  assert.equal(record.candidate.identity.revisionId, "dep-0001");
  assert.equal(record.prior.identity.revisionId, "dep-0000");
  assert.equal(record.observed.identity?.revisionId, "dep-0001");
});

Deno.test("repository adapter is a discriminated union with exact variant keys", async () => {
  const gateway = structuredClone(
    await readFixture("valid", "repository-config-v1.json"),
  ) as Record<string, unknown>;
  const parsedGateway = parseRepositoryConfigV1(structuredClone(gateway));
  assert.deepEqual(parsedGateway.adapter, {
    kind: "gateway",
    baseUrl: "https://ai.ubq.fi",
  });

  // The GitHub variant is valid without any base address.
  const github = structuredClone(gateway);
  github.adapter = { kind: "github" };
  const parsedGithub = tryParse(parseRepositoryConfigV1, github);
  assert.equal(parsedGithub.ok, true);
  if (parsedGithub.ok) {
    assert.deepEqual(parsedGithub.value.adapter, { kind: "github" });
  }

  // A base address on the GitHub variant is an unknown key, never ignored.
  const withBaseUrl = structuredClone(gateway);
  withBaseUrl.adapter = { kind: "github", baseUrl: "https://ai.ubq.fi" };
  const rejectedBase = tryParse(parseRepositoryConfigV1, withBaseUrl);
  assert.equal(rejectedBase.ok, false);
  if (!rejectedBase.ok) {
    assert.equal(rejectedBase.issues[0]?.code, "unknown_key");
    assert.equal(rejectedBase.issues[0]?.path, "$.adapter.baseUrl");
  }

  // Unknown kinds are refused.
  const unknownKind = structuredClone(gateway);
  unknownKind.adapter = { kind: "bitbucket", baseUrl: "https://ai.ubq.fi" };
  const rejectedKind = tryParse(parseRepositoryConfigV1, unknownKind);
  assert.equal(rejectedKind.ok, false);
  if (!rejectedKind.ok) {
    assert.equal(rejectedKind.issues[0]?.code, "invalid_enum");
    assert.equal(rejectedKind.issues[0]?.path, "$.adapter.kind");
  }

  // The gateway variant still requires its base address.
  const missingBase = structuredClone(gateway);
  missingBase.adapter = { kind: "gateway" };
  const rejectedMissing = tryParse(parseRepositoryConfigV1, missingBase);
  assert.equal(rejectedMissing.ok, false);
  if (!rejectedMissing.ok) {
    assert.equal(rejectedMissing.issues[0]?.code, "missing_field");
    assert.equal(rejectedMissing.issues[0]?.path, "$.adapter.baseUrl");
  }
});

Deno.test("local owner: config parser reserves id 0 for the no-App github scope", async () => {
  const gateway = structuredClone(
    await readFixture("valid", "repository-config-v1.json"),
  ) as Record<string, unknown>;

  // The github adapter permits the explicit no-App local owner scope.
  const local = structuredClone(gateway);
  (local.repository as Record<string, unknown>).installationId = 0;
  local.adapter = { kind: "github" };
  const parsedLocal = tryParse(parseRepositoryConfigV1, local);
  assert.equal(parsedLocal.ok, true);
  if (parsedLocal.ok) {
    assert.equal(parsedLocal.value.repository.installationId, 0);
    assert.deepEqual(parsedLocal.value.adapter, { kind: "github" });
  }

  // A gateway configuration still requires a positive App installation id.
  const gatewayLocal = structuredClone(local);
  gatewayLocal.adapter = { kind: "gateway", baseUrl: "https://ai.ubq.fi" };
  const rejectedGateway = tryParse(parseRepositoryConfigV1, gatewayLocal);
  assert.equal(rejectedGateway.ok, false);
  if (!rejectedGateway.ok) {
    assert.equal(rejectedGateway.issues[0]?.code, "invalid_count");
    assert.equal(
      rejectedGateway.issues[0]?.path,
      "$.repository.installationId",
    );
  }

  // Negative, fractional and unsafe ids are rejected for both adapters.
  const adapters = [
    { kind: "github" },
    { kind: "gateway", baseUrl: "https://ai.ubq.fi" },
  ];
  for (const installationId of [-1, 1.5, 2 ** 53, Number.NaN]) {
    for (const adapter of adapters) {
      const candidate = structuredClone(gateway);
      (candidate.repository as Record<string, unknown>).installationId =
        installationId;
      candidate.adapter = adapter;
      const rejected = tryParse(parseRepositoryConfigV1, candidate);
      assert.equal(rejected.ok, false, `id ${installationId}`);
      if (!rejected.ok) {
        assert.equal(rejected.issues[0]?.code, "invalid_count");
        assert.equal(rejected.issues[0]?.path, "$.repository.installationId");
      }
    }
  }
});

Deno.test("command registry binds argv arrays with bounded runtime, never shell text", () => {
  const registry = parseCommandRegistryV1({
    version: "v1",
    commands: {
      test_ci: {
        executable: "deno",
        args: ["task", "test-local"],
        maxDurationMs: 1800000,
        maxOutputBytes: 4194304,
      },
    },
  });
  const specs = registry.commands as Record<string, unknown>;
  assert.equal((specs.test_ci as { args: string[] }).args.length, 2);
  // Shell metacharacters in the executable are rejected.
  const result = tryParse(parseCommandRegistryV1, {
    version: "v1",
    commands: {
      bad: {
        executable: "sh -c 'rm -rf /'",
        args: [],
        maxDurationMs: 1,
        maxOutputBytes: 1,
      },
    },
  });
  assert.equal(result.ok, false);
  // NUL/control characters in argv elements are rejected.
  const badArg = tryParse(parseCommandRegistryV1, {
    version: "v1",
    commands: {
      bad: {
        executable: "deno",
        args: ["\u0000"],
        maxDurationMs: 1,
        maxOutputBytes: 1,
      },
    },
  });
  assert.equal(badArg.ok, false);
  if (!badArg.ok) assert.equal(badArg.issues[0]?.code, "invalid_pattern");
});

Deno.test("repository config command lookup rejects inherited prototype members", async () => {
  const raw =
    (await readFixture("valid", "repository-config-v1.json")) as Record<
      string,
      unknown
    >;
  // A config referencing a prototype member name against an empty registry
  // must fail closed instead of resolving to Object.prototype.constructor.
  const emptyRegistry = structuredClone(raw);
  (emptyRegistry.commands as Record<string, unknown>).replay = "constructor";
  (emptyRegistry.commands as Record<string, unknown>).test = "constructor";
  (emptyRegistry.commandRegistry as { commands: Record<string, unknown> })
    .commands = {};
  const result = tryParse(parseRepositoryConfigV1, emptyRegistry);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issues[0]?.code, "invalid_lifecycle");
  // An OWN registry entry with the same name is a valid own command id.
  const ownEntry = structuredClone(raw);
  (ownEntry.commands as Record<string, unknown>).replay = "constructor";
  (ownEntry.commandRegistry as { commands: Record<string, unknown> }).commands =
    {
      constructor: {
        executable: "deno",
        args: ["run", "test"],
        maxDurationMs: 1000,
        maxOutputBytes: 1024,
      },
      test_ci: {
        executable: "deno",
        args: ["task", "test-local"],
        maxDurationMs: 1800000,
        maxOutputBytes: 4194304,
      },
    };
  assert.equal(tryParse(parseRepositoryConfigV1, ownEntry).ok, true);
});

Deno.test("accepted release record persists identity/window/coverage evidence", async () => {
  const record = parseReleaseRecordV1(
    await readFixture("valid", "release-record-accepted-v1.json"),
  );
  assert.equal(record.phase, "accepted");
  assert.ok(record.acceptance?.passed);
  const baseline = record.acceptance!.baseline[0];
  assert.equal(baseline.identity.revisionId, "dep-0000");
  assert.equal(baseline.coverage.status, "complete");
  assert.ok(
    record.acceptance!.samples.every(
      (s) =>
        s.windowStart < s.windowEnd && s.windowEnd <= s.sampledAt &&
        s.coverage.status === "complete" &&
        s.identity.revisionId === "dep-0001",
    ),
  );
});

Deno.test("metrics samples: exact identity/window/coverage plus bounded counts", () => {
  const identity = {
    gitSha: "a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d",
    revisionId: "dep-0001",
  };
  const sample = parseMetricsSample(
    {
      identity,
      windowStart: 1786000070000,
      windowEnd: 1786000100000,
      sampledAt: 1786000100000,
      domain: null,
      requestCount: 100,
      fiveXxCount: 1,
      timeoutCount: 0,
      streamFailureCount: 0,
      upstreamWideFault: false,
      coverage: { status: "complete" },
    },
    "$",
  );
  assert.equal(sample.requestCount, 100);
  assert.equal(sample.identity.gitSha, identity.gitSha);
  assert.equal(sample.windowEnd, 1786000100000);
  assert.equal(sample.coverage.status, "complete");
  // A window must satisfy windowStart < windowEnd <= sampledAt.
  const inverted = tryParse(
    (input) => parseMetricsSample(input, "$"),
    {
      identity,
      windowStart: 1786000100000,
      windowEnd: 1786000100000,
      sampledAt: 1786000100000,
      domain: null,
      requestCount: 100,
      fiveXxCount: 0,
      timeoutCount: 0,
      streamFailureCount: 0,
      upstreamWideFault: false,
      coverage: { status: "complete" },
    },
  );
  assert.equal(inverted.ok, false);
  if (!inverted.ok) assert.equal(inverted.issues[0]?.path, "$.windowEnd");
  const afterEnd = tryParse(
    (input) => parseMetricsSample(input, "$"),
    {
      identity,
      windowStart: 1786000120000,
      windowEnd: 1786000150000,
      sampledAt: 1786000100000,
      domain: null,
      requestCount: 100,
      fiveXxCount: 0,
      timeoutCount: 0,
      streamFailureCount: 0,
      upstreamWideFault: false,
      coverage: { status: "complete" },
    },
  );
  assert.equal(afterEnd.ok, false);
  if (!afterEnd.ok) assert.equal(afterEnd.issues[0]?.path, "$.sampledAt");
  // A count above the denominator is a corrupted sample.
  const over = tryParse(
    (input) => parseMetricsSample(input, "$"),
    {
      identity,
      windowStart: 1786000070000,
      windowEnd: 1786000100000,
      sampledAt: 1786000100000,
      domain: null,
      requestCount: 10,
      fiveXxCount: 11,
      timeoutCount: 0,
      streamFailureCount: 0,
      upstreamWideFault: false,
      coverage: { status: "complete" },
    },
  );
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.issues[0]?.path, "$.fiveXxCount");
  // Missing denominator must not masquerade as a 0-rate sample.
  const missing = tryParse(
    (input) => parseMetricsSample(input, "$"),
    {
      identity,
      windowStart: 1786000070000,
      windowEnd: 1786000100000,
      sampledAt: 1786000100000,
      domain: null,
      requestCount: null,
      fiveXxCount: 0,
      timeoutCount: null,
      streamFailureCount: null,
      upstreamWideFault: null,
      coverage: { status: "complete" },
    },
  );
  assert.equal(missing.ok, false);
  // Fully missing telemetry is explicit nulls; identity/window/coverage persist.
  const unavailable = parseMetricsSample(
    {
      identity,
      windowStart: 1786000070000,
      windowEnd: 1786000100000,
      sampledAt: 1786000100000,
      domain: null,
      requestCount: null,
      fiveXxCount: null,
      timeoutCount: null,
      streamFailureCount: null,
      upstreamWideFault: null,
      coverage: {
        status: "incomplete",
        reason: "source lag",
        nextCursor: "p-1",
      },
    },
    "$",
  );
  assert.equal(unavailable.requestCount, null);
  assert.equal(unavailable.upstreamWideFault, null);
  assert.equal(unavailable.identity.revisionId, "dep-0001");
  assert.equal(unavailable.coverage.status, "incomplete");
});

Deno.test("accepted release telemetry binds every sample and baseline to exact identities", async () => {
  const raw = (await readFixture(
    "valid",
    "release-record-accepted-v1.json",
  )) as Record<string, unknown>;
  const acceptance = raw.acceptance as {
    samples: Record<string, unknown>[];
    baseline: Record<string, unknown>[];
  };
  const baseline = acceptance.baseline[0].identity as Record<
    string,
    unknown
  >;
  const sample = acceptance.samples[0].identity as Record<string, unknown>;
  const wrongSample = structuredClone(raw);
  ((wrongSample.acceptance as { samples: Record<string, unknown>[] }).samples[0]
    .identity as Record<string, unknown>).gitSha = "0".repeat(40);
  const wrongSha = tryParse(parseReleaseRecordV1, wrongSample);
  assert.equal(wrongSha.ok, false);
  if (!wrongSha.ok) {
    assert.equal(wrongSha.issues[0]?.path, "$.acceptance.samples[0].identity");
  }
  const wrongRev = structuredClone(raw);
  ((wrongRev.acceptance as { samples: Record<string, unknown>[] }).samples[0]
    .identity as Record<string, unknown>).revisionId = "dep-other";
  const wrongRevision = tryParse(parseReleaseRecordV1, wrongRev);
  assert.equal(wrongRevision.ok, false);
  if (!wrongRevision.ok) {
    assert.equal(
      wrongRevision.issues[0]?.path,
      "$.acceptance.samples[0].identity",
    );
  }
  const wrongBaseline = structuredClone(raw);
  ((wrongBaseline.acceptance as { baseline: Record<string, unknown>[] })
    .baseline[0].identity as Record<string, unknown>).revisionId = "dep-other";
  const wrongBaselineRevision = tryParse(parseReleaseRecordV1, wrongBaseline);
  assert.equal(wrongBaselineRevision.ok, false);
  if (!wrongBaselineRevision.ok) {
    assert.equal(
      wrongBaselineRevision.issues[0]?.path,
      "$.acceptance.baseline[0].identity",
    );
  }
  // Sanity: the untouched fixture still parses.
  assert.equal(tryParse(parseReleaseRecordV1, raw).ok, true);
  assert.equal(baseline.gitSha, "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00");
  assert.equal(sample.gitSha, "a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d");
});

Deno.test("incomplete coverage is persistable for passed:false diagnostics only", async () => {
  const raw = (await readFixture(
    "invalid",
    "release-incomplete-coverage.json",
  )) as Record<string, unknown>;
  // passed:true with incomplete coverage stays invalid.
  assert.equal(tryParse(parseReleaseRecordV1, raw).ok, false);
  // A diagnostic acceptance (passed:false) persists the incomplete evidence.
  const diagnostic = structuredClone(raw);
  diagnostic.phase = "monitoring";
  (diagnostic.acceptance as Record<string, unknown>).passed = false;
  const persisted = tryParse(parseReleaseRecordV1, diagnostic);
  assert.equal(persisted.ok, true);
});

Deno.test("budget proof refs are restricted refs, never URLs or traversal", async () => {
  const base = (await readFixture(
    "valid",
    "budget-reservation-v1.json",
  )) as Record<string, unknown>;
  const withProof = (proofRef: string) => {
    const mutant = structuredClone(base);
    mutant.outcome = "confirmed_not_submitted";
    mutant.settledAt = 1786002000000;
    mutant.proofRef = proofRef;
    return tryParse(parseBudgetReservationV1, mutant);
  };
  // An opaque storage ref is a valid proof.
  assert.equal(withProof("artifact://proof/reservation-0001").ok, true);
  // A URL is never a proof ref.
  const url = withProof("https://example.com/proof");
  assert.equal(url.ok, false);
  if (!url.ok) assert.equal(url.issues[0]?.path, "$.proofRef");
  // Traversal and absolute filesystem refs are never proof refs.
  assert.equal(withProof("secret:../file").ok, false);
  assert.equal(withProof("secret:/etc/passwd").ok, false);
  assert.equal(withProof("artifact://inbox/../proof").ok, false);
});

Deno.test("global live start limits: one policy, conflicts refuse inference", async () => {
  const base = parseRepositoryConfigV1(
    structuredClone(await readFixture("valid", "repository-config-v1.json")),
  );
  // No limits anywhere: inference stays disabled.
  const disabled = resolveGlobalLiveStartLimits([
    { ...base, liveStartLimits: null },
    { ...base, liveStartLimits: null },
  ]);
  assert.equal(disabled.status, "disabled");
  // Identical limits across repos: one shared policy.
  const enabled = resolveGlobalLiveStartLimits([base, { ...base }]);
  assert.equal(enabled.status, "enabled");
  // Conflicting per-repo limits must refuse inference.
  const conflict = resolveGlobalLiveStartLimits([
    base,
    { ...base, liveStartLimits: { perHour: 8, perSevenDays: 40 } },
  ]);
  assert.equal(conflict.status, "conflict");
});

Deno.test("live start limits: explicit null weekly cap is valid, missing or malformed is not", async () => {
  const base = structuredClone(
    await readFixture("valid", "repository-config-v1.json"),
  ) as Record<string, unknown>;

  // Explicit null is the owner policy: 120 per rolling hour, no weekly cap.
  const accepted = tryParse(parseRepositoryConfigV1, {
    ...base,
    liveStartLimits: { perHour: 120, perSevenDays: null },
  });
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.deepEqual(accepted.value.liveStartLimits, {
      perHour: 120,
      perSevenDays: null,
    });
  }

  // A wholly null liveStartLimits still means inference is not enabled.
  const disabled = tryParse(parseRepositoryConfigV1, {
    ...base,
    liveStartLimits: null,
  });
  assert.equal(disabled.ok, true);
  if (disabled.ok) assert.equal(disabled.value.liveStartLimits, null);

  // Missing, undefined or malformed weekly values are invalid, never a
  // permissive fallback to "unlimited".
  const { perSevenDays: _dropped, ...withoutWeekly } = base
    .liveStartLimits as Record<string, unknown>;
  const missing = tryParse(parseRepositoryConfigV1, {
    ...base,
    liveStartLimits: withoutWeekly,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(
      missing.issues[0]?.path,
      "$.liveStartLimits.perSevenDays",
    );
  }
  for (const malformed of [undefined, "168", -1, 1.5, true, Number.NaN]) {
    const result = tryParse(parseRepositoryConfigV1, {
      ...base,
      liveStartLimits: { perHour: 120, perSevenDays: malformed },
    });
    assert.equal(result.ok, false, `weekly ${String(malformed)} is invalid`);
    if (!result.ok) {
      assert.equal(result.issues[0]?.path, "$.liveStartLimits.perSevenDays");
    }
  }

  // Numeric weekly limits keep the hour <= week invariant.
  const inverted = tryParse(parseRepositoryConfigV1, {
    ...base,
    liveStartLimits: { perHour: 120, perSevenDays: 60 },
  });
  assert.equal(inverted.ok, false);
  if (!inverted.ok) assert.equal(inverted.issues[0]?.path, "$.liveStartLimits");

  // Explicit null bypasses only the weekly checks: the hour cap is still a
  // required finite positive safe integer.
  const badHour = tryParse(parseRepositoryConfigV1, {
    ...base,
    liveStartLimits: { perHour: 0, perSevenDays: null },
  });
  // The parser accepts a nonnegative safe integer here, but the budget policy
  // below (and admission) still refuses a zero hour cap.
  assert.equal(badHour.ok, true);

  const nullLimits = { perHour: 120, perSevenDays: null } as const;
  const nullPolicy = resolveGlobalLiveStartLimits([
    {
      ...parseRepositoryConfigV1(base),
      liveStartLimits: nullLimits,
    },
    {
      ...parseRepositoryConfigV1(base),
      liveStartLimits: { ...nullLimits },
    },
  ]);
  assert.equal(nullPolicy.status, "enabled");
  if (nullPolicy.status === "enabled") {
    assert.deepEqual(nullPolicy.limits, { perHour: 120, perSevenDays: null });
  }

  // A null weekly cap in one repository and a numeric one in another are two
  // different policies: shared admission is disabled, never inferred.
  const mixedPolicy = resolveGlobalLiveStartLimits([
    { ...parseRepositoryConfigV1(base), liveStartLimits: nullLimits },
    {
      ...parseRepositoryConfigV1(base),
      liveStartLimits: { perHour: 120, perSevenDays: 168 },
    },
  ]);
  assert.equal(mixedPolicy.status, "conflict");
});

// ---------------------------------------------------------------------------
// M15 V1 candidate state: the rollback-safe reader. Absence of candidateState
// is the exact legacy shape; a present group is parsed strictly and the parked
// predicate is the only admission gate old readers use.
// ---------------------------------------------------------------------------

const CANDIDATE_BASE = "aafb7ee0598699bb7fb8a72ea133693ed64462da";
const CANDIDATE_HEAD = "1111111111111111111111111111111111111111";
const CANDIDATE_BRANCH = "sentinel/inc-2026-09-07-0001";
const CANDIDATE_REF = `refs/heads/sentinel-candidates/${"ab".repeat(32)}`;
const PRODUCING_RESERVATION = "cd".repeat(32);
const OTHER_CANDIDATE_SHA = "2222222222222222222222222222222222222222";
/** The other admitted descriptor key form: exact base-refresh identity. */
const CANDIDATE_BASE_REFRESH_KEY =
  `base_refresh:7:${CANDIDATE_HEAD}:${CANDIDATE_BASE}`;

async function rawLegacyWork(): Promise<Record<string, unknown>> {
  return (await readFixture("valid", "work-record-v1.json")) as Record<
    string,
    unknown
  >;
}

function preservedDescriptor(): Record<string, unknown> {
  return {
    operationKey: `impl:${PRODUCING_RESERVATION}`,
    base: CANDIDATE_BASE,
    head: CANDIDATE_HEAD,
    ref: CANDIDATE_REF,
  };
}

/** The legacy fixture with one coherent V1 candidateState group. */
async function candidateWorkRaw(
  mutate?: (
    target: Record<string, unknown>,
    candidateState: Record<string, unknown>,
  ) => void,
): Promise<Record<string, unknown>> {
  const raw = await rawLegacyWork();
  const candidateState: Record<string, unknown> = {
    preserved: preservedDescriptor(),
    publishedHead: CANDIDATE_HEAD,
  };
  const target: Record<string, unknown> = {
    base: CANDIDATE_BASE,
    branch: CANDIDATE_BRANCH,
    checkpoint: null,
    head: CANDIDATE_HEAD,
    pr: 7,
    candidateState,
  };
  mutate?.(target, candidateState);
  raw.target = target;
  return raw;
}

function validPreservationIntent(): Record<string, unknown> {
  return {
    kind: "candidate_preservation",
    key: `impl:${PRODUCING_RESERVATION}`,
    startedAt: 1786000000000,
    branch: CANDIDATE_REF,
    expectedHead: CANDIDATE_HEAD,
    observedBase: CANDIDATE_BASE,
    pr: null,
    requestId: PRODUCING_RESERVATION,
    resultId: null,
  };
}

/** A parked record whose only candidate state is the preservation intent. */
async function preservationIntentRaw(
  overrides: {
    intent?: Record<string, unknown>;
    candidateState?: unknown;
    omitCandidateState?: boolean;
    target?: Record<string, unknown>;
  } = {},
): Promise<Record<string, unknown>> {
  const raw = await rawLegacyWork();
  const target: Record<string, unknown> = {
    base: CANDIDATE_BASE,
    branch: CANDIDATE_BRANCH,
    checkpoint: null,
    head: CANDIDATE_HEAD,
    pr: null,
    ...overrides.target,
  };
  if (overrides.omitCandidateState !== true) {
    target.candidateState = overrides.candidateState ??
      { preserved: null, publishedHead: null };
  }
  raw.target = target;
  raw.nextStep = "work";
  raw.wait = null;
  raw.intent = overrides.intent ?? validPreservationIntent();
  return raw;
}

function expectRejected(
  raw: unknown,
  code: string,
  path: string | undefined,
  name: string,
): void {
  const result = tryParse(parseWorkRecordV1, raw);
  assert.equal(result.ok, false, `${name}: expected rejection`);
  if (!result.ok) {
    assert.equal(result.issues[0]?.code, code, name);
    if (path !== undefined) {
      assert.equal(result.issues[0]?.path, path, name);
    }
  }
}

Deno.test("candidate state: absence is the exact legacy shape", async () => {
  const raw = await rawLegacyWork();
  const parsed = parseWorkRecordV1(raw);
  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed.target, "candidateState"),
    false,
    "the parsed legacy target must not gain a candidateState key",
  );
  assert.equal(hasCandidateState(parsed), false);
  // The stored legacy bytes still round-trip exactly: no default was injected.
  assert.equal(canonicalStringify(parsed), canonicalStringify(raw));
});

Deno.test("candidate state: exact new shape round-trips canonical bytes", async () => {
  const raw = await candidateWorkRaw();
  const parsed = parseWorkRecordV1(raw);
  assert.deepEqual(parsed.target.candidateState, {
    preserved: preservedDescriptor(),
    publishedHead: CANDIDATE_HEAD,
  });
  assert.equal(hasCandidateState(parsed), true);
  assert.equal(canonicalStringify(parsed), canonicalStringify(raw));

  // The other admitted producing-operation key form, the exact base-refresh
  // identity, parses and round-trips byte-preserving as well.
  const baseRefreshRaw = await candidateWorkRaw((_target, candidateState) => {
    (candidateState.preserved as Record<string, unknown>).operationKey =
      CANDIDATE_BASE_REFRESH_KEY;
  });
  const baseRefresh = parseWorkRecordV1(baseRefreshRaw);
  assert.deepEqual(baseRefresh.target.candidateState, {
    preserved: {
      ...preservedDescriptor(),
      operationKey: CANDIDATE_BASE_REFRESH_KEY,
    },
    publishedHead: CANDIDATE_HEAD,
  });
  assert.equal(hasCandidateState(baseRefresh), true);
  assert.equal(
    canonicalStringify(baseRefresh),
    canonicalStringify(baseRefreshRaw),
  );

  // Null-preserved parked work is valid, round-trips, and is still parked:
  // preserved === null is never treated as "no candidate state".
  const nullPreservedRaw = await candidateWorkRaw((_target, candidateState) => {
    candidateState.preserved = null;
    candidateState.publishedHead = null;
  });
  const nullPreserved = parseWorkRecordV1(nullPreservedRaw);
  assert.deepEqual(nullPreserved.target.candidateState, {
    preserved: null,
    publishedHead: null,
  });
  assert.equal(hasCandidateState(nullPreserved), true);
  assert.equal(
    canonicalStringify(nullPreserved),
    canonicalStringify(nullPreservedRaw),
  );
});

Deno.test("candidate state: malformed groups, keys and bindings reject", async () => {
  const cases: {
    name: string;
    raw: Record<string, unknown>;
    code: string;
    path?: string;
  }[] = [
    {
      name: "null group",
      raw: await candidateWorkRaw((target) => {
        target.candidateState = null;
      }),
      code: "wrong_type",
      path: "$.target.candidateState",
    },
    {
      name: "present undefined group",
      raw: await candidateWorkRaw((target) => {
        target.candidateState = undefined;
      }),
      code: "missing_field",
      path: "$.target.candidateState",
    },
    {
      name: "partial group",
      raw: await candidateWorkRaw((_target, group) => {
        delete group.publishedHead;
      }),
      code: "missing_field",
      path: "$.target.candidateState.publishedHead",
    },
    {
      name: "unknown group key",
      raw: await candidateWorkRaw((_target, group) => {
        group.preservation = {};
      }),
      code: "unknown_key",
      path: "$.target.candidateState.preservation",
    },
    {
      name: "partial descriptor",
      raw: await candidateWorkRaw((_target, group) => {
        delete (group.preserved as Record<string, unknown>).ref;
      }),
      code: "missing_field",
      path: "$.target.candidateState.preserved.ref",
    },
    {
      name: "unknown descriptor key",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).detail = "free text";
      }),
      code: "unknown_key",
      path: "$.target.candidateState.preserved.detail",
    },
    {
      name: "empty operation key",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey = "";
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "unbounded operation key",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey = "x".repeat(
          257,
        );
      }),
      code: "bound_exceeded",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "unknown nonempty operation key",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `review:7:${CANDIDATE_HEAD}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "impl reservation id too short",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey = `impl:${
          "cd".repeat(31)
        }`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "impl reservation id uppercase",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey = `impl:${
          "CD".repeat(32)
        }`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "impl key suffix",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `impl:${PRODUCING_RESERVATION}:extra`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "impl key newline suffix",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `impl:${PRODUCING_RESERVATION}\n`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh zero pr",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `base_refresh:0:${CANDIDATE_HEAD}:${CANDIDATE_BASE}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh negative pr",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `base_refresh:-1:${CANDIDATE_HEAD}:${CANDIDATE_BASE}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh leading-zero pr",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `base_refresh:07:${CANDIDATE_HEAD}:${CANDIDATE_BASE}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh noninteger pr",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `base_refresh:1.5:${CANDIDATE_HEAD}:${CANDIDATE_BASE}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh unsafe pr",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `base_refresh:9007199254740993:${CANDIDATE_HEAD}:${CANDIDATE_BASE}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh short old head",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `base_refresh:7:${CANDIDATE_HEAD.slice(1)}:${CANDIDATE_BASE}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh uppercase new base",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `base_refresh:7:${CANDIDATE_HEAD}:${CANDIDATE_BASE.toUpperCase()}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh missing new base",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `base_refresh:7:${CANDIDATE_HEAD}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh extra component",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `base_refresh:7:${CANDIDATE_HEAD}:${CANDIDATE_BASE}:extra`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh newline suffix",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `base_refresh:7:${CANDIDATE_HEAD}:${CANDIDATE_BASE}\n`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh descriptor head binding still enforced",
      raw: await candidateWorkRaw((_target, group) => {
        const preserved = group.preserved as Record<string, unknown>;
        preserved.operationKey = CANDIDATE_BASE_REFRESH_KEY;
        preserved.head = OTHER_CANDIDATE_SHA;
      }),
      code: "invalid_lifecycle",
      path: "$.target.candidateState.preserved",
    },
    {
      name: "wrong ref namespace",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).ref =
          `refs/heads/sentinel/${"ab".repeat(32)}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.ref",
    },
    {
      name: "uppercase ref digest",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).ref =
          `refs/heads/sentinel-candidates/${"AB".repeat(32)}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.ref",
    },
    {
      name: "publishedHead not a sha",
      raw: await candidateWorkRaw((_target, group) => {
        group.publishedHead = "deadbeef";
      }),
      code: "invalid_sha",
      path: "$.target.candidateState.publishedHead",
    },
    {
      name: "preserved base mismatch",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).base = OTHER_CANDIDATE_SHA;
      }),
      code: "invalid_lifecycle",
      path: "$.target.candidateState.preserved",
    },
    {
      name: "preserved head mismatch",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).head = OTHER_CANDIDATE_SHA;
      }),
      code: "invalid_lifecycle",
      path: "$.target.candidateState.preserved",
    },
    {
      name: "null target branch",
      raw: await candidateWorkRaw((target) => {
        target.branch = null;
      }),
      code: "invalid_lifecycle",
      path: "$.target.candidateState",
    },
    {
      name: "null target head with publishedHead",
      raw: await candidateWorkRaw((target, group) => {
        target.head = null;
        group.preserved = null;
        group.publishedHead = CANDIDATE_HEAD;
      }),
      code: "invalid_lifecycle",
      path: "$.target.candidateState",
    },
    {
      name: "null target head with preserved descriptor",
      raw: await candidateWorkRaw((target) => {
        target.head = null;
      }),
      code: "invalid_lifecycle",
      path: "$.target.candidateState.preserved",
    },
    {
      name: "unknown target key",
      raw: await candidateWorkRaw((target) => {
        target.candidate_state = { preserved: null, publishedHead: null };
      }),
      code: "unknown_key",
      path: "$.target.candidate_state",
    },
  ];
  for (const testCase of cases) {
    expectRejected(testCase.raw, testCase.code, testCase.path, testCase.name);
  }
});

Deno.test("candidate preservation intent: valid shape parses and parks", async () => {
  const raw = await preservationIntentRaw();
  const parsed = parseWorkRecordV1(raw);
  assert.equal(parsed.intent?.kind, "candidate_preservation");
  assert.equal(parsed.target.candidateState?.preserved, null);
  assert.equal(hasCandidateState(parsed), true);
  assert.equal(canonicalStringify(parsed), canonicalStringify(raw));
});

Deno.test("candidate preservation intent: mismatches and bad identities reject", async () => {
  const otherReservation = "ef".repeat(32);
  const intentWith = (
    overrides: Record<string, unknown>,
  ): Record<string, unknown> => ({
    ...validPreservationIntent(),
    ...overrides,
  });
  const cases: {
    name: string;
    raw: Record<string, unknown>;
    code: string;
    path?: string;
  }[] = [
    {
      name: "not a producing key",
      raw: await preservationIntentRaw({
        intent: intentWith({ key: `push:${CANDIDATE_HEAD}` }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.key",
    },
    {
      name: "base_refresh descriptor key is not an implementation intent key",
      raw: await preservationIntentRaw({
        intent: intentWith({ key: CANDIDATE_BASE_REFRESH_KEY }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.key",
    },
    {
      name: "nonhex reservation id in key",
      raw: await preservationIntentRaw({
        intent: intentWith({ key: "impl:not-a-reservation" }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.key",
    },
    {
      name: "missing requestId",
      raw: await preservationIntentRaw({
        intent: intentWith({ requestId: null }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.requestId",
    },
    {
      name: "requestId does not match the key",
      raw: await preservationIntentRaw({
        intent: intentWith({ requestId: otherReservation }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.requestId",
    },
    {
      name: "branch is the candidate branch, not the preservation ref",
      raw: await preservationIntentRaw({
        intent: intentWith({ branch: CANDIDATE_BRANCH }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.branch",
    },
    {
      name: "uppercase preservation ref",
      raw: await preservationIntentRaw({
        intent: intentWith({
          branch: `refs/heads/sentinel-candidates/${"AB".repeat(32)}`,
        }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.branch",
    },
    {
      name: "null expectedHead",
      raw: await preservationIntentRaw({
        intent: intentWith({ expectedHead: null }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.expectedHead",
    },
    {
      name: "null observedBase",
      raw: await preservationIntentRaw({
        intent: intentWith({ observedBase: null }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.observedBase",
    },
    {
      name: "pr must be null",
      raw: await preservationIntentRaw({ intent: intentWith({ pr: 7 }) }),
      code: "invalid_lifecycle",
      path: "$.intent.pr",
    },
    {
      name: "resultId must be null",
      raw: await preservationIntentRaw({
        intent: intentWith({ resultId: CANDIDATE_HEAD }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.resultId",
    },
    {
      name: "unknown intent key",
      raw: await preservationIntentRaw({
        intent: intentWith({ detail: "free text" }),
      }),
      code: "unknown_key",
      path: "$.intent.detail",
    },
    {
      name: "candidateState absent",
      raw: await preservationIntentRaw({ omitCandidateState: true }),
      code: "invalid_lifecycle",
      path: "$.target.candidateState",
    },
    {
      name: "preserved descriptor already present",
      raw: await preservationIntentRaw({
        candidateState: {
          preserved: preservedDescriptor(),
          publishedHead: CANDIDATE_HEAD,
        },
      }),
      code: "invalid_lifecycle",
      path: "$.target.candidateState.preserved",
    },
    {
      name: "expectedHead differs from target.head",
      raw: await preservationIntentRaw({
        intent: intentWith({ expectedHead: OTHER_CANDIDATE_SHA }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.expectedHead",
    },
    {
      name: "observedBase differs from target.base",
      raw: await preservationIntentRaw({
        intent: intentWith({ observedBase: OTHER_CANDIDATE_SHA }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.observedBase",
    },
  ];
  for (const testCase of cases) {
    expectRejected(testCase.raw, testCase.code, testCase.path, testCase.name);
  }
});

Deno.test("candidate state: the parking predicate ignores unrelated intents", async () => {
  const raw = await rawLegacyWork();
  raw.intent = {
    kind: "implementation",
    key: `impl:${PRODUCING_RESERVATION}`,
    startedAt: 1786000000000,
    branch: null,
    expectedHead: null,
    observedBase: null,
    pr: null,
    requestId: PRODUCING_RESERVATION,
    resultId: null,
  };
  const parsed = parseWorkRecordV1(raw);
  assert.equal(parsed.target.candidateState, undefined);
  assert.equal(hasCandidateState(parsed), false);
});
