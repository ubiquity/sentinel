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

Deno.test("metrics samples: denominator-bounded counts, missing telemetry is null", () => {
  const sample = parseMetricsSample(
    {
      sampledAt: 1786000000000,
      domain: null,
      requestCount: 100,
      fiveXxCount: 1,
      timeoutCount: 0,
      streamFailureCount: 0,
      upstreamWideFault: false,
    },
    "$",
  );
  assert.equal(sample.requestCount, 100);
  // A count above the denominator is a corrupted sample.
  const over = tryParse(
    (input) => parseMetricsSample(input, "$"),
    {
      sampledAt: 1786000000000,
      domain: null,
      requestCount: 10,
      fiveXxCount: 11,
      timeoutCount: 0,
      streamFailureCount: 0,
      upstreamWideFault: false,
    },
  );
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.issues[0]?.path, "$.fiveXxCount");
  // Missing denominator must not masquerade as a 0-rate sample.
  const missing = tryParse(
    (input) => parseMetricsSample(input, "$"),
    {
      sampledAt: 1786000000000,
      domain: null,
      requestCount: null,
      fiveXxCount: 0,
      timeoutCount: null,
      streamFailureCount: null,
      upstreamWideFault: null,
    },
  );
  assert.equal(missing.ok, false);
  // Fully missing telemetry is explicit nulls.
  const unavailable = parseMetricsSample(
    {
      sampledAt: 1786000000000,
      domain: null,
      requestCount: null,
      fiveXxCount: null,
      timeoutCount: null,
      streamFailureCount: null,
      upstreamWideFault: null,
    },
    "$",
  );
  assert.equal(unavailable.requestCount, null);
  assert.equal(unavailable.upstreamWideFault, null);
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
