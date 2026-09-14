/**
 * Hosted runtime terminal schema: the single trusted JSON record a protected
 * launcher emits AFTER the actual selected child runtime settles. It carries
 * only runtime outcome metadata; the authenticated GitHub job/step and log
 * frame supply the platform identity separately. The child runtime cannot
 * print this terminal directly because the launch wrapper captures its stdout.
 */

import type { GitSha } from "./brands.ts";
import { parseHostedExecutionIntentV1 } from "./hosted-supervisor.ts";
import type { HostedExecutionIntentV1 } from "./hosted-supervisor.ts";
import {
  expectBoolean,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNullable,
  expectRecord,
  expectTimestamp,
  expectVersion,
  fail,
} from "./validation.ts";

/** Exact fixed runtime step carrying the selected child execution. */
export const HOSTED_RUNTIME_STEP_NAME = "Run selected Sentinel runtime";

export interface HostedRuntimeTerminalV1 {
  version: "v1";
  kind: "hosted_runtime_terminal";
  /** Full immutable execution intent this terminal settles. */
  execution: HostedExecutionIntentV1;
  /** Must equal execution.revision exactly. */
  controllerSha: GitSha;
  startedAt: number;
  finishedAt: number;
  outcome: "healthy" | "failed";
  startupReady: boolean;
  settled: true;
  baseSha: GitSha | null;
}

const TERMINAL_KEYS = [
  "version",
  "kind",
  "execution",
  "controllerSha",
  "startedAt",
  "finishedAt",
  "outcome",
  "startupReady",
  "settled",
  "baseSha",
] as const;

export function parseHostedRuntimeTerminalV1(
  input: unknown,
  path = "$",
): HostedRuntimeTerminalV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, TERMINAL_KEYS, path);
  expectVersion(obj.version, `${path}.version`);
  expectEnum(obj.kind, ["hosted_runtime_terminal"], `${path}.kind`);

  const execution = parseHostedExecutionIntentV1(
    obj.execution,
    `${path}.execution`,
  );
  const controllerSha = expectGitSha(
    obj.controllerSha,
    `${path}.controllerSha`,
  );
  if (controllerSha !== execution.revision) {
    fail(
      `${path}.controllerSha`,
      "invalid_lifecycle",
      "terminal controller must equal the execution revision",
    );
  }
  const startedAt = expectTimestamp(obj.startedAt, `${path}.startedAt`);
  const finishedAt = expectTimestamp(obj.finishedAt, `${path}.finishedAt`);
  if (startedAt < execution.createdAt) {
    fail(
      `${path}.startedAt`,
      "invalid_lifecycle",
      "terminal start cannot precede its execution intent",
    );
  }
  if (finishedAt < startedAt) {
    fail(
      `${path}.finishedAt`,
      "invalid_lifecycle",
      "terminal finish cannot precede its start",
    );
  }
  const outcome = expectEnum(
    obj.outcome,
    ["healthy", "failed"],
    `${path}.outcome`,
  );
  const startupReady = expectBoolean(
    obj.startupReady,
    `${path}.startupReady`,
  );
  const settled = expectBoolean(obj.settled, `${path}.settled`);
  if (settled !== true) {
    fail(
      `${path}.settled`,
      "invalid_lifecycle",
      "an unsettled terminal is never proof",
    );
  }
  const baseSha = expectNullable(obj.baseSha, `${path}.baseSha`, expectGitSha);
  if (outcome === "healthy") {
    if (!startupReady) {
      fail(
        `${path}.startupReady`,
        "invalid_lifecycle",
        "a healthy terminal requires startupReady true",
      );
    }
    if (baseSha === null) {
      fail(
        `${path}.baseSha`,
        "invalid_lifecycle",
        "a healthy terminal requires the observed base SHA",
      );
    }
  }
  return {
    version: "v1",
    kind: "hosted_runtime_terminal",
    execution,
    controllerSha,
    startedAt,
    finishedAt,
    outcome,
    startupReady,
    settled: true,
    baseSha,
  };
}
