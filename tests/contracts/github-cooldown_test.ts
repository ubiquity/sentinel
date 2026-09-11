// Strict GitHub rate-limit/cooldown contract tests: valid roundtrips, exact
// key discipline, fail-closed timestamp/id/digest rules, explicit null manual
// cooldown, fallback combinations, snapshot collection requiredness/duplicate
// enforcement and the portError metadata seam.
import assert from "node:assert/strict";

import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  GITHUB_FALLBACK_MIN_BACKOFF_MS,
  parseGitHubCooldownV1,
  parseGitHubRateLimitV1,
} from "../../src/contracts/github-cooldown.ts";
import type {
  GitHubCooldownV1,
  GitHubRateLimitV1,
} from "../../src/contracts/github-cooldown.ts";
import type {
  GitHubCooldownGateV1,
  PortErrorV1,
} from "../../src/contracts/ports.ts";
import { portError } from "../../src/contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { RecordParseError, tryParse } from "../../src/contracts/validation.ts";
import type {
  ParseIssue,
  ParseRecordResult,
} from "../../src/contracts/validation.ts";

const T = 1786000000000;
const OBSERVATION_ID = "ab".repeat(32); // exactly 64 lowercase hex chars

function rateLimit(
  overrides: Partial<GitHubRateLimitV1> = {},
): GitHubRateLimitV1 {
  return {
    kind: "primary",
    observedAt: T,
    retryNotBefore: T + 60_000,
    observationId: OBSERVATION_ID,
    fallback: false,
    ...overrides,
  };
}

function cooldown(
  overrides: Partial<GitHubCooldownV1> = {},
): GitHubCooldownV1 {
  return {
    installationId: 7,
    retryNotBefore: T + 60_000,
    observedAt: T,
    observationId: OBSERVATION_ID,
    secondaryBackoff: 0,
    ...overrides,
  };
}

function repairSnapshot(
  githubCooldowns: GitHubCooldownV1[],
): RepairStateSnapshotV1 {
  return {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T,
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns,
  };
}

function firstIssue(result: ParseRecordResult<unknown>): ParseIssue {
  assert.equal(result.ok, false, "expected rejection");
  if (result.ok) throw new Error("unreachable");
  return result.issues[0] as ParseIssue;
}

Deno.test("rate limit: valid primary record roundtrips strictly", () => {
  const valid = rateLimit();
  const parsed = parseGitHubRateLimitV1(valid);
  assert.deepEqual(parsed, valid);
  assert.equal(canonicalStringify(parsed), canonicalStringify(valid));
  // A primary limit may also carry an explicit null deadline: manual
  // fail-closed is a real observation, never a computed fallback.
  const manual = rateLimit({ retryNotBefore: null });
  assert.equal(parseGitHubRateLimitV1(manual).retryNotBefore, null);
  assert.equal(tryParse(parseGitHubRateLimitV1, manual).ok, true);
});

Deno.test("rate limit: valid secondary record and fallback boundary roundtrip", () => {
  // Server-hinted secondary deadline, not a computed fallback.
  const hinted = rateLimit({
    kind: "secondary",
    retryNotBefore: T + 90_000,
  });
  assert.equal(parseGitHubRateLimitV1(hinted).fallback, false);
  // Bounded fallback at the exact documented minimum backoff.
  const fallback = rateLimit({
    kind: "secondary",
    retryNotBefore: T + GITHUB_FALLBACK_MIN_BACKOFF_MS,
    fallback: true,
  });
  assert.deepEqual(parseGitHubRateLimitV1(fallback), fallback);
});

Deno.test("rate limit: unknown keys fail closed", () => {
  const issue = firstIssue(tryParse(parseGitHubRateLimitV1, {
    ...rateLimit(),
    version: "v1",
  }));
  assert.equal(issue.code, "unknown_key");
  assert.equal(issue.path, "$.version");
});

Deno.test("rate limit: fallback combinations are invalid", () => {
  // fallback on a primary limit.
  assert.equal(
    firstIssue(tryParse(parseGitHubRateLimitV1, rateLimit({ fallback: true })))
      .path,
    "$.fallback",
  );
  // fallback without a deadline (null is never converted to a fallback).
  assert.equal(
    firstIssue(tryParse(
      parseGitHubRateLimitV1,
      rateLimit({
        kind: "secondary",
        retryNotBefore: null,
        fallback: true,
      }),
    )).path,
    "$.fallback",
  );
  // fallback with a deadline shorter than the documented minimum.
  assert.equal(
    firstIssue(tryParse(
      parseGitHubRateLimitV1,
      rateLimit({
        kind: "secondary",
        retryNotBefore: T + GITHUB_FALLBACK_MIN_BACKOFF_MS - 1,
        fallback: true,
      }),
    )).code,
    "invalid_lifecycle",
  );
});

Deno.test("rate limit: unsafe timestamps are rejected", () => {
  assert.equal(
    firstIssue(tryParse(parseGitHubRateLimitV1, rateLimit({ observedAt: -1 })))
      .code,
    "invalid_timestamp",
  );
  assert.equal(
    firstIssue(tryParse(parseGitHubRateLimitV1, rateLimit({ observedAt: 1.5 })))
      .code,
    "invalid_timestamp",
  );
  assert.equal(
    firstIssue(tryParse(
      parseGitHubRateLimitV1,
      rateLimit({
        retryNotBefore: T - 1,
      }),
    )).code,
    "invalid_lifecycle",
  );
  assert.equal(
    firstIssue(tryParse(
      parseGitHubRateLimitV1,
      rateLimit({
        retryNotBefore: 1.5,
      }),
    )).code,
    "invalid_timestamp",
  );
});

Deno.test("rate limit: invalid observation ids are rejected", () => {
  // Uppercase is not a valid lowercase hex digest.
  assert.equal(
    firstIssue(tryParse(
      parseGitHubRateLimitV1,
      rateLimit({
        observationId: OBSERVATION_ID.toUpperCase(),
      }),
    )).code,
    "invalid_digest",
  );
  assert.equal(
    firstIssue(tryParse(
      parseGitHubRateLimitV1,
      rateLimit({
        observationId: "ab".repeat(31),
      }),
    )).code,
    "invalid_digest",
  );
  assert.equal(
    firstIssue(tryParse(
      parseGitHubRateLimitV1,
      rateLimit({
        observationId: "z".repeat(64),
      }),
    )).code,
    "invalid_digest",
  );
});

Deno.test("cooldown: valid record roundtrips strictly", () => {
  const valid = cooldown();
  assert.deepEqual(parseGitHubCooldownV1(valid), valid);
  assert.equal(
    canonicalStringify(parseGitHubCooldownV1(valid)),
    canonicalStringify(valid),
  );
  // A null retryNotBefore is a durable manual fail-closed record and must
  // roundtrip as an explicit null, never be silently converted to a deadline.
  const manual = parseGitHubCooldownV1(cooldown({ retryNotBefore: null }));
  assert.equal(manual.retryNotBefore, null);
  assert.equal(
    canonicalStringify(manual),
    canonicalStringify({
      ...cooldown(),
      retryNotBefore: null,
    }),
  );
});

Deno.test("cooldown: unknown keys and missing keys fail closed", () => {
  assert.equal(
    firstIssue(tryParse(parseGitHubCooldownV1, {
      ...cooldown(),
      kind: "github_cooldown",
    })).code,
    "unknown_key",
  );
  assert.equal(
    firstIssue(tryParse(parseGitHubCooldownV1, {
      ...cooldown(),
      version: "v1",
    })).code,
    "unknown_key",
  );
  const missing = { ...cooldown() } as Partial<GitHubCooldownV1>;
  delete missing.secondaryBackoff;
  const issue = firstIssue(tryParse(parseGitHubCooldownV1, missing));
  assert.equal(issue.code, "missing_field");
  assert.equal(issue.path, "$.secondaryBackoff");
});

Deno.test("cooldown: unsafe installation ids are rejected", () => {
  for (const installationId of [-1, 1.5, 2 ** 53, Number.NaN]) {
    const issue = firstIssue(tryParse(
      parseGitHubCooldownV1,
      cooldown({
        installationId,
      }),
    ));
    assert.equal(issue.code, "invalid_count", `id ${installationId}`);
  }
  // Scope 0 is the explicit no-App local owner scope and is valid.
  const local = tryParse(
    parseGitHubCooldownV1,
    cooldown({ installationId: 0 }),
  );
  assert.equal(local.ok, true);
  if (local.ok) assert.equal(local.value.installationId, 0);
  assert.equal(
    tryParse(parseGitHubCooldownV1, cooldown({ installationId: 1 })).ok,
    true,
  );
});

Deno.test("cooldown: unsafe timestamps and backoff are rejected", () => {
  assert.equal(
    firstIssue(tryParse(parseGitHubCooldownV1, cooldown({ observedAt: -1 })))
      .code,
    "invalid_timestamp",
  );
  assert.equal(
    firstIssue(tryParse(
      parseGitHubCooldownV1,
      cooldown({
        retryNotBefore: T - 1,
      }),
    )).code,
    "invalid_lifecycle",
  );
  for (const secondaryBackoff of [-1, 11, 1.5, 2 ** 53]) {
    assert.equal(
      firstIssue(
        tryParse(parseGitHubCooldownV1, cooldown({ secondaryBackoff })),
      )
        .code,
      "invalid_count",
      `backoff ${secondaryBackoff}`,
    );
  }
  assert.equal(
    tryParse(parseGitHubCooldownV1, cooldown({ secondaryBackoff: 10 })).ok,
    true,
  );
});

Deno.test("cooldown: invalid observation ids are rejected", () => {
  assert.equal(
    firstIssue(tryParse(
      parseGitHubCooldownV1,
      cooldown({
        observationId: OBSERVATION_ID.toUpperCase(),
      }),
    )).code,
    "invalid_digest",
  );
});

Deno.test("snapshot: githubCooldowns is a required collection", () => {
  const raw = structuredClone(repairSnapshot([])) as unknown as Record<
    string,
    unknown
  >;
  delete raw.githubCooldowns;
  const issue = firstIssue(tryParse(parseRepairStateSnapshotV1, raw));
  assert.equal(issue.code, "missing_field");
  assert.equal(issue.path, "$.githubCooldowns");
});

Deno.test("snapshot: unknown key next to githubCooldowns fails closed", () => {
  const raw = structuredClone(repairSnapshot([])) as unknown as Record<
    string,
    unknown
  >;
  raw.extra = true;
  assert.equal(
    firstIssue(tryParse(parseRepairStateSnapshotV1, raw)).code,
    "unknown_key",
  );
});

Deno.test("snapshot: duplicate installation ids are rejected", () => {
  const raw = repairSnapshot([
    cooldown({ installationId: 7 }),
    cooldown({ installationId: 7, observationId: "cd".repeat(32) }),
  ]);
  const issue = firstIssue(tryParse(parseRepairStateSnapshotV1, raw));
  assert.equal(issue.code, "invalid_lifecycle");
  assert.equal(issue.path, "$.githubCooldowns[1].installationId");
  // Distinct installations are valid and preserved in order.
  const distinct = repairSnapshot([
    cooldown({ installationId: 7 }),
    cooldown({ installationId: 8 }),
  ]);
  const parsed = parseRepairStateSnapshotV1(distinct);
  assert.equal(parsed.githubCooldowns.length, 2);
  assert.deepEqual(parsed.githubCooldowns, distinct.githubCooldowns);
});

Deno.test("snapshot: cooldown collection is bounded", () => {
  const raw = repairSnapshot(
    Array.from(
      { length: 2048 },
      (_, index) => cooldown({ installationId: index + 1 }),
    ),
  );
  assert.deepEqual(
    parseRepairStateSnapshotV1(raw).githubCooldowns,
    raw.githubCooldowns,
  );
  const tooMany = repairSnapshot(
    Array.from(
      { length: 2049 },
      (_, index) => cooldown({ installationId: index + 1 }),
    ),
  );
  const issue = firstIssue(tryParse(parseRepairStateSnapshotV1, tooMany));
  assert.equal(issue.code, "bound_exceeded");
  assert.equal(issue.path, "$.githubCooldowns");
});

Deno.test("portError: rate-limit metadata is preserved and old shape is unchanged", () => {
  const withMeta = portError(
    "rate_limited",
    "secondary limit exceeded",
    rateLimit({ kind: "secondary", fallback: true }),
  );
  assert.equal(withMeta.ok, false);
  if (withMeta.ok) throw new Error("unreachable");
  assert.equal(withMeta.error.kind, "rate_limited");
  assert.deepEqual(
    withMeta.error.rateLimit,
    parseGitHubRateLimitV1(rateLimit({
      kind: "secondary",
      fallback: true,
    })),
  );

  // Without the third parameter the error object keeps its exact old shape.
  const plain: PortErrorV1 = { kind: "unavailable", detail: "down" };
  const bare = portError("unavailable", "down");
  assert.equal(bare.ok, false);
  if (bare.ok) throw new Error("unreachable");
  assert.deepEqual(bare.error, plain);
  assert.ok(!("rateLimit" in bare.error));
});

Deno.test("portError: non rate_limited kind rejects metadata", () => {
  assert.throws(
    () => portError("auth_failed", "bad token", rateLimit()),
    TypeError,
  );
});

Deno.test("portError: invalid metadata is rejected via the strict parser", () => {
  assert.throws(
    () =>
      portError(
        "rate_limited",
        "secondary limit exceeded",
        { ...rateLimit(), fallback: true } as unknown as GitHubRateLimitV1,
      ),
    RecordParseError,
  );
});

Deno.test("GitHubCooldownGateV1: structural implementation satisfies the interface", async () => {
  const calls: string[] = [];
  const gate: GitHubCooldownGateV1 = {
    beforeRequest(installationId: number) {
      calls.push(`before:${installationId}`);
      return Promise.resolve({ ok: true as const, value: undefined });
    },
    recordRateLimit(
      installationId: number,
      observed: GitHubRateLimitV1,
    ) {
      calls.push(`record:${installationId}:${observed.kind}`);
      return Promise.resolve({ ok: true as const, value: undefined });
    },
  };
  const before = await gate.beforeRequest(7);
  assert.ok(before.ok);
  const recorded = await gate.recordRateLimit(7, rateLimit());
  assert.ok(recorded.ok);
  assert.deepEqual(calls, ["before:7", "record:7:primary"]);
});
