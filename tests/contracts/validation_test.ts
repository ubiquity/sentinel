// Fail-closed validation primitives: no coercion, explicit nulls, bounded
// text, full SHA / digest shapes and exact enum membership.
import assert from "node:assert/strict";

import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  isGitSha,
  isSha256Hex,
  isWorkItemId,
} from "../../src/contracts/brands.ts";
import type { ParseIssue } from "../../src/contracts/validation.ts";
import {
  expectArray,
  expectBoolean,
  expectCommandId,
  expectCount,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNullable,
  expectPattern,
  expectRecord,
  expectSha256Hex,
  expectString,
  expectTimestamp,
  expectVersion,
  fail,
  tryParse,
} from "../../src/contracts/validation.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import { expectRestrictedRef } from "../../src/contracts/shared.ts";

function rejected(
  fn: () => unknown,
  code?: string,
  pathPrefix?: string,
): ParseIssue {
  let issue: ParseIssue | undefined;
  try {
    fn();
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const issues = (error as { issues: ParseIssue[] }).issues;
      issue = issues[0];
    }
  }
  assert.ok(issue, "expected the parse to throw a RecordParseError");
  if (code) assert.equal(issue.code, code);
  if (pathPrefix) {
    assert.ok(
      issue.path.startsWith(pathPrefix),
      `path ${issue.path} !~ ${pathPrefix}`,
    );
  }
  return issue;
}

Deno.test("record: rejects non-objects, arrays and class instances", () => {
  rejected(() => expectRecord(null, "$"), "wrong_type");
  rejected(() => expectRecord([], "$"), "wrong_type");
  rejected(() => expectRecord("x", "$"), "wrong_type");
  rejected(() => expectRecord(new Date(), "$"), "wrong_type");
  assert.deepEqual(expectRecord({ a: 1 }, "$"), { a: 1 });
});

Deno.test("exact keys: unknown keys and missing keys both fail closed", () => {
  const obj = { known: 1 };
  rejected(
    () => expectExactKeys({ known: 1, extra: 2 }, ["known"], "$"),
    "unknown_key",
    "$.extra",
  );
  rejected(
    () => expectExactKeys(obj, ["known", "missing"], "$"),
    "missing_field",
    "$.missing",
  );
  // present-but-undefined counts as missing, never as explicit null
  rejected(
    () => expectExactKeys({ known: undefined }, ["known"], "$"),
    "missing_field",
  );
  expectExactKeys({ known: 1 }, ["known"], "$");
});

Deno.test("strings: no coercion and hard length bounds", () => {
  rejected(() => expectString(5, "$.s", 10), "wrong_type");
  rejected(() => expectString(true, "$.s", 10), "wrong_type");
  rejected(() => expectString("abc", "$.s", 2), "bound_exceeded");
  assert.equal(expectString("abc", "$.s", 10), "abc");
  // explicit pattern validation, no trimming
  rejected(() =>
    expectPattern(" ABC", "$.s", /^[A-Z]/, "invalid_pattern", "no spaces", 10)
  );
});

Deno.test("timestamps: finite nonnegative integers; strings never coerce", () => {
  rejected(() => expectTimestamp("1786000000000", "$.t"), "invalid_timestamp");
  rejected(() => expectTimestamp(-1, "$.t"), "invalid_timestamp");
  rejected(() => expectTimestamp(1.5, "$.t"), "invalid_timestamp");
  rejected(() => expectTimestamp(NaN, "$.t"), "invalid_timestamp");
  assert.equal(expectTimestamp(0, "$.t"), 0);
});

Deno.test("counts: nonnegative safe integers; negative/float/string rejected", () => {
  rejected(() => expectCount(-1, "$.c"), "invalid_count");
  rejected(() => expectCount(1.5, "$.c"), "invalid_count");
  rejected(() => expectCount("3", "$.c"), "invalid_count");
  rejected(
    () => expectCount(Number.MAX_SAFE_INTEGER + 2, "$.c"),
    "invalid_count",
  );
  assert.equal(expectCount(0, "$.c"), 0);
});

Deno.test("enums and versions: exact membership, no case folding", () => {
  rejected(() => expectEnum("work ", ["work", "done"], "$.e"), "invalid_enum");
  rejected(() => expectEnum("WORK", ["work", "done"], "$.e"), "invalid_enum");
  rejected(() => expectEnum("done", ["work"], "$.e"), "invalid_enum");
  rejected(() => expectEnum(1, ["work"], "$.e"), "invalid_enum");
  rejected(() => expectVersion("v2", "$"), "invalid_version");
  assert.equal(expectEnum("work", ["work", "done"], "$.e"), "work");
  assert.equal(expectVersion("v1", "$"), "v1");
});

Deno.test("booleans: real booleans only; 0/1/strings rejected", () => {
  rejected(() => expectBoolean(0, "$.b"), "invalid_boolean");
  rejected(() => expectBoolean("true", "$.b"), "invalid_boolean");
  assert.equal(expectBoolean(true, "$.b"), true);
});

Deno.test("explicit nullability: null passes, undefined fails", () => {
  rejected(
    () => expectNullable(undefined, "$.n", expectString2),
    "invalid_nullability",
  );
  assert.equal(expectNullable(null, "$.n", expectString2), null);
  assert.equal(expectNullable("x", "$.n", expectString2), "x");
});

function expectString2(v: unknown, path: string): string {
  return expectString(v, path, 10);
}

Deno.test("Git SHA: exactly 40 lowercase hex; short/uppercase/digest rejected", () => {
  const sha = "aafb7ee0598699bb7fb8a72ea133693ed64462da";
  assert.equal(expectGitSha(sha, "$.sha"), sha);
  rejected(() => expectGitSha("aafb7ee0", "$.sha"), "invalid_sha");
  rejected(() => expectGitSha(sha.toUpperCase(), "$.sha"), "invalid_sha");
  // 64-hex digest in a Git SHA slot is digest confusion
  rejected(() => expectGitSha("aa".repeat(32), "$.sha"), "invalid_sha");
});

Deno.test("SHA-256 digests: exactly 64 lowercase hex; 40-hex SHA rejected", () => {
  const d = "aa".repeat(32);
  assert.equal(expectSha256Hex(d, "$.d"), d);
  rejected(
    () => expectSha256Hex("aafb7ee0598699bb7fb8a72ea133693ed64462da", "$.d"),
    "invalid_digest",
  );
  rejected(() => expectSha256Hex("zz".repeat(32), "$.d"), "invalid_digest");
  rejected(() => expectSha256Hex(d.toUpperCase(), "$.d"), "invalid_digest");
});

Deno.test("brand predicates align with parser checks", () => {
  assert.ok(isGitSha("aafb7ee0598699bb7fb8a72ea133693ed64462da"));
  assert.ok(!isGitSha("aa".repeat(32)));
  assert.ok(isSha256Hex("aa".repeat(32)));
  assert.ok(!isSha256Hex("aafb7ee0"));
  assert.ok(isWorkItemId("incident:deadbeef-1"));
  assert.ok(!isWorkItemId("inc ident"));
});

Deno.test("command ids: lowercase snake ids only", () => {
  assert.equal(expectCommandId("replay_capture", "$.c"), "replay_capture");
  rejected(() => expectCommandId("Replay_capture", "$.c"), "invalid_pattern");
  rejected(() => expectCommandId("rm -rf /", "$.c"), "invalid_pattern");
});

Deno.test("restricted refs: opaque storage refs only, never URLs or traversal", () => {
  for (
    const ok of [
      "replay/rec-0001",
      "artifact://inbox/inc-2026-09-07-0001.pgp",
      "fixture://x.json",
      "fixture://captures/inc-2026-09-07-0001/upstream.json",
      "secret://host/injected/sentinel-github-app",
      "secret:vault-key",
    ]
  ) {
    assert.equal(expectRestrictedRef(ok, "$.ref"), ok);
  }
  // URL endpoints, file paths, traversal and port-bearing authorities are
  // never references.
  const bad = [
    "https://example.com/path",
    "http://ai.ubq.fi/x",
    "HTTPS://example.com/x",
    "file:/etc/passwd",
    "secret:/etc/passwd",
    "secret:../file",
    "secret:./file",
    "artifact://inbox/../out.pgp",
    "artifact://inbox/./out.pgp",
    "artifact://host:8080/x",
    "git://host/x",
    "a://b",
    "secret:",
    "replay/../x",
    "replay/./x",
    "artifact://inbox/x?token=1",
    "artifact://user:pw@inbox/x",
    "artifact://inbox/x#frag",
    "artifact://../x",
  ];
  for (const value of bad) {
    const issue = rejected(
      () => expectRestrictedRef(value, "$.ref"),
      "invalid_pattern",
      "$.ref",
    );
    // Fail-closed messages never echo the invalid reference value.
    assert.ok(!issue.message.includes(value));
    assert.ok(
      !issue.message.includes("example.com") &&
        !issue.message.includes("/etc/passwd") &&
        !issue.message.includes("secret"),
    );
  }
});

Deno.test("arrays: bounded and typed per item", () => {
  rejected(() => expectArray("nope", "$.a", 3, expectString2), "wrong_type");
  rejected(
    () => expectArray([1, 2, 3, 4], "$.a", 3, expectString2),
    "bound_exceeded",
  );
  assert.deepEqual(
    expectArray(["a", "b"], "$.a", 3, expectString2),
    ["a", "b"],
  );
});

Deno.test("arrays: sparse arrays are rejected, never silently skipped", () => {
  const sparse = [1, , 3] as unknown[];
  const hole = [,] as unknown[];
  const holeTrailing = [1, ,] as unknown[];
  rejected(
    () => expectArray(sparse, "$.a", 3, expectString2),
    "invalid_array",
    "$.a",
  );
  rejected(
    () => expectArray(hole, "$.a", 3, expectString2),
    "invalid_array",
    "$.a",
  );
  rejected(
    () => expectArray(holeTrailing, "$.a", 3, expectString2),
    "invalid_array",
    "$.a",
  );
  // Dense undefined elements are rejected by the item parser, not skipped.
  rejected(
    () => expectArray([undefined], "$.a", 3, expectString2),
    "wrong_type",
    "$.a[0]",
  );
});

Deno.test("parse error messages report path/code/type/length, never values", () => {
  const secret = "Bearer super-secret-value-123";
  for (
    const issue of [
      rejected(() => expectString(secret, "$.s", 8), "bound_exceeded"),
      rejected(() => expectSha256Hex(secret, "$.d"), "invalid_digest"),
      rejected(
        () =>
          expectPattern(secret, "$.p", /^[a-z]+$/, "invalid_pattern", "no", 64),
        "invalid_pattern",
      ),
      rejected(() => expectGitSha(secret, "$.g"), "invalid_sha"),
      rejected(() => expectEnum(secret, ["a"], "$.e"), "invalid_enum"),
    ]
  ) {
    assert.ok(!issue.message.includes("secret"));
    assert.ok(!issue.message.includes("Bearer"));
  }
  // Type and length are still reported.
  const digestIssue = rejected(
    () => expectSha256Hex("short", "$.d"),
    "invalid_digest",
  );
  assert.match(digestIssue.message, /string of length 5/);
});

Deno.test("tryParse converts rejection to a result, never throws", () => {
  const ok = tryParse(parseWorkRecordV1, null);
  assert.equal(ok.ok, false);
  const good = tryParse(parseWorkRecordV1, {
    version: "v1",
    kind: "work",
    repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 7 },
    id: "i:1",
    source: {
      kind: "issue",
      id: "1",
      revision: "aafb7ee0598699bb7fb8a72ea133693ed64462da",
    },
    related: { incidentId: null, issueNumber: 7 },
    fingerprint: null,
    failingRevision: "aafb7ee0598699bb7fb8a72ea133693ed64462da",
    sourceSnapshotDigest: null,
    classification: { severity: "P2", priority: 1 },
    urgency: {
      activeProduction: false,
      reproducible5xx: false,
      severeSecurityOrDataLoss: false,
    },
    dependencies: [],
    controller: { sha: "aafb7ee0598699bb7fb8a72ea133693ed64462da" },
    target: {
      base: "aafb7ee0598699bb7fb8a72ea133693ed64462da",
      branch: null,
      checkpoint: null,
      head: null,
      pr: null,
    },
    nextStep: "blocked",
    wait: null,
    blocker: {
      kind: "dependency",
      message: "upstream lock",
      since: 1786000000000,
    },
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    evidence: [],
    intent: null,
    firstSeenAt: null,
    createdAt: 1786000000000,
    updatedAt: 1786000000000,
  });
  assert.equal(good.ok, true);
});

Deno.test("fail() produces a typed issue", () => {
  const issue = rejected(
    () => fail("$.x", "invalid_value", "nope"),
    "invalid_value",
    "$.x",
  );
  assert.equal(issue.message, "nope");
});

Deno.test("canonical stringify is used by records for stable comparison", () => {
  assert.equal(
    canonicalStringify({ b: 1, a: 2 }),
    canonicalStringify({ a: 2, b: 1 }),
  );
});
