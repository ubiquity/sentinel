/**
 * ReplayResultV1: outcome of one isolated before/after validation. The exact
 * original and candidate revisions, the sanitized fixture/test digest, the
 * configured command identities, the intended failure reason and every
 * limitation are recorded. Failure must be for the intended reason; if the
 * original failure cannot be reproduced or the candidate is not verified, that
 * is a recorded limitation and never claimed as causal proof.
 */

import { asFixtureDigest, asWorkItemId } from "./brands.ts";
import type { CommandId, FixtureDigest, GitSha, WorkItemId } from "./brands.ts";
import type { RepositoryIdentityV1 } from "./shared.ts";
import { expectRestrictedRef, parseRepositoryIdentity } from "./shared.ts";
import {
  describeValue,
  expectArray,
  expectBoolean,
  expectCommandId,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectPattern,
  expectRecord,
  expectSha256Hex,
  expectTimestamp,
  expectVersion,
  fail,
  MaxItems,
  MaxText,
} from "./validation.ts";

export type ReplayRunOutcomeV1 = "passed" | "failed" | "unavailable";
export type ReplayLimitationV1 =
  | "original_not_reproduced"
  | "candidate_not_verified"
  | "fixture_redacted"
  | "upstream_dependent"
  | "output_truncated";

export interface ReplayOutputV1 {
  stdoutDigest: FixtureDigest | null;
  stderrDigest: FixtureDigest | null;
  truncated: boolean;
}

export interface ReplayFailureV1 {
  /** Whether the failure matches the intended failure reason. */
  intended: boolean;
  reason: string;
}

export interface ReplayRunV1 {
  revision: GitSha;
  outcome: ReplayRunOutcomeV1;
  exitCode: number | null;
  output: ReplayOutputV1 | null;
  failure: ReplayFailureV1 | null;
}

export interface ReplayResultV1 {
  version: "v1";
  kind: "replay_result";
  id: string;
  taskId: WorkItemId;
  repository: RepositoryIdentityV1;
  original: ReplayRunV1;
  candidate: ReplayRunV1;
  fixture: { ref: string; digest: FixtureDigest; testIds: string[] };
  commands: { replay: CommandId; test: CommandId };
  /** Intended before failure reason; the before run must fail for this reason. */
  expected: { beforeReason: string };
  limitations: ReplayLimitationV1[];
  createdAt: number;
}

const KEYS = [
  "version",
  "kind",
  "id",
  "taskId",
  "repository",
  "original",
  "candidate",
  "fixture",
  "commands",
  "expected",
  "limitations",
  "createdAt",
] as const;
const RUN_KEYS = [
  "revision",
  "outcome",
  "exitCode",
  "output",
  "failure",
] as const;
const OUTPUT_KEYS = ["stdoutDigest", "stderrDigest", "truncated"] as const;
const FAILURE_KEYS = ["intended", "reason"] as const;
const FIXTURE_KEYS = ["ref", "digest", "testIds"] as const;
const COMMANDS_KEYS = ["replay", "test"] as const;
const EXPECTED_KEYS = ["beforeReason"] as const;

const LIMITATIONS = [
  "original_not_reproduced",
  "candidate_not_verified",
  "fixture_redacted",
  "upstream_dependent",
  "output_truncated",
] as const;

export function parseReplayResultV1(input: unknown): ReplayResultV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, ["replay_result"], "$.kind");

  const id = expectNonEmptyString(obj.id, "$.id", MaxText.recordId);
  const taskId = asWorkItemId(
    expectPattern(
      obj.taskId,
      "$.taskId",
      /^[A-Za-z0-9._:-]{1,256}$/,
      "invalid_pattern",
      "expected deterministic work item id",
      MaxText.recordId,
    ),
  );
  const repository = parseRepositoryIdentity(obj.repository, "$.repository");
  const original = parseRun(obj.original, "$.original");
  const candidate = parseRun(obj.candidate, "$.candidate");

  const fixtureObj = expectRecord(obj.fixture, "$.fixture");
  expectExactKeys(fixtureObj, FIXTURE_KEYS, "$.fixture");
  const ref = expectRestrictedRef(fixtureObj.ref, "$.fixture.ref");
  const digest = asFixtureDigest(
    expectSha256Hex(fixtureObj.digest, "$.fixture.digest"),
  );
  const testIds = expectStringArrayOf(fixtureObj.testIds, "$.fixture.testIds");

  const commandsObj = expectRecord(obj.commands, "$.commands");
  expectExactKeys(commandsObj, COMMANDS_KEYS, "$.commands");
  const commands = {
    replay: expectCommandId(commandsObj.replay, "$.commands.replay"),
    test: expectCommandId(commandsObj.test, "$.commands.test"),
  };

  const expectedObj = expectRecord(obj.expected, "$.expected");
  expectExactKeys(expectedObj, EXPECTED_KEYS, "$.expected");
  const beforeReason = expectNonEmptyString(
    expectedObj.beforeReason,
    "$.expected.beforeReason",
    MaxText.message,
  );

  const limitations = expectArray(
    obj.limitations,
    "$.limitations",
    MaxItems.limitations,
    (item, itemPath) => expectEnum(item, LIMITATIONS, itemPath),
  );

  const createdAt = expectTimestamp(obj.createdAt, "$.createdAt");

  // Fail-closed causality: unless the original failed for the intended reason
  // and the candidate passed, the record must carry a limitation — otherwise
  // it would claim causal proof it did not obtain.
  const causal = original.outcome === "failed" &&
    original.failure !== null &&
    original.failure.intended &&
    candidate.outcome === "passed";
  if (!causal && limitations.length === 0) {
    fail(
      "$.limitations",
      "invalid_lifecycle",
      "non-causal replay result requires at least one limitation",
    );
  }

  return {
    version: "v1",
    kind: "replay_result",
    id,
    taskId,
    repository,
    original,
    candidate,
    fixture: { ref, digest, testIds },
    commands,
    expected: { beforeReason },
    limitations,
    createdAt,
  };
}

function parseRun(input: unknown, path: string): ReplayRunV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, RUN_KEYS, path);
  const revision = expectGitSha(obj.revision, `${path}.revision`);
  const outcome = expectEnum(
    obj.outcome,
    ["passed", "failed", "unavailable"],
    `${path}.outcome`,
  );
  const exitCode = expectNullable(
    obj.exitCode,
    `${path}.exitCode`,
    expectExitCode,
  );
  const output = expectNullable(obj.output, `${path}.output`, parseOutput);
  const failure = expectNullable(obj.failure, `${path}.failure`, parseFailure);

  if (outcome === "failed" && failure === null) {
    fail(
      `${path}.failure`,
      "invalid_lifecycle",
      "failed run requires a failure detail",
    );
  }
  if (outcome !== "failed" && failure !== null) {
    fail(
      `${path}.failure`,
      "invalid_lifecycle",
      "non-failed run cannot carry a failure detail",
    );
  }
  if (outcome === "unavailable") {
    if (exitCode !== null) {
      fail(
        `${path}.exitCode`,
        "invalid_lifecycle",
        "unavailable run has no exit code",
      );
    }
    if (output !== null) {
      fail(
        `${path}.output`,
        "invalid_lifecycle",
        "unavailable run has no output",
      );
    }
  }
  return { revision, outcome, exitCode, output, failure };
}

function expectExitCode(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < -1) {
    fail(
      path,
      "invalid_count",
      `expected safe integer exit code, got ${describeValue(value)}`,
    );
  }
  return value;
}

function parseOutput(input: unknown, path: string): ReplayOutputV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, OUTPUT_KEYS, path);
  return {
    stdoutDigest: expectNullable(
      obj.stdoutDigest,
      `${path}.stdoutDigest`,
      (v, p) => asFixtureDigest(expectSha256Hex(v, p)),
    ),
    stderrDigest: expectNullable(
      obj.stderrDigest,
      `${path}.stderrDigest`,
      (v, p) => asFixtureDigest(expectSha256Hex(v, p)),
    ),
    truncated: expectBoolean(obj.truncated, `${path}.truncated`),
  };
}

function parseFailure(input: unknown, path: string): ReplayFailureV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, FAILURE_KEYS, path);
  return {
    intended: expectBoolean(obj.intended, `${path}.intended`),
    reason: expectNonEmptyString(obj.reason, `${path}.reason`, MaxText.message),
  };
}

function expectStringArrayOf(value: unknown, path: string): string[] {
  return expectArray(
    value,
    path,
    MaxItems.testIds,
    (item, itemPath) => expectNonEmptyString(item, itemPath, MaxText.label),
  );
}
