/**
 * ActionsReleaseReceiptV1: the hosted, read-only release receipt for the
 * explicit self scope (`ubiquity/sentinel`, installationId 0).
 *
 * It attests that an exact merged release request was already accepted by a
 * successful real runtime execution of the trusted repair host: the exact
 * scheduled/dispatched workflow attempt, its `repair` job and
 * `Repair polling run` step, and that step's single terminal JSON record.
 * The receipt never carries raw logs, signed URLs or credentials — only the
 * strict identity and a SHA-256 digest of the downloaded log text.
 */

import { canonicalStringify } from "./canonical.ts";
import type { GitSha } from "./brands.ts";
import { parseReleaseRequestV1 } from "./release.ts";
import type { ReleaseRequestV1 } from "./release.ts";
import {
  expectArray,
  expectBoolean,
  expectCount,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectPositiveInt,
  expectRecord,
  expectSha256Hex,
  expectTimestamp,
  expectVersion,
  fail,
  MaxText,
} from "./validation.ts";

export const ACTIONS_RELEASE_REPOSITORY = "ubiquity/sentinel";
export const ACTIONS_RELEASE_WORKFLOW_ID = 353743354;
export const ACTIONS_RELEASE_WORKFLOW_PATH = ".github/workflows/repair.yml";
export const ACTIONS_RELEASE_BRANCH = "development";
export const ACTIONS_RELEASE_JOB_NAME = "repair";
export const ACTIONS_RELEASE_STEP_NAME = "Repair polling run";
export const ACTIONS_RELEASE_LOGIN = "github-actions[bot]";
/** Timestamp precision allowance between API server times and log lines. */
export const ACTIONS_RELEASE_TIME_SLACK_MS = 999;

export type ActionsReleaseEventV1 = "schedule" | "workflow_dispatch";
export type ActionsReleaseOutcomeV1 = "idle" | "margin" | "step_limit";

export interface ActionsRunProofV1 {
  repository: typeof ACTIONS_RELEASE_REPOSITORY;
  workflowId: typeof ACTIONS_RELEASE_WORKFLOW_ID;
  workflowPath: typeof ACTIONS_RELEASE_WORKFLOW_PATH;
  branch: typeof ACTIONS_RELEASE_BRANCH;
  event: ActionsReleaseEventV1;
  controllerSha: GitSha;
  baseSha: GitSha;
  runId: number;
  runAttempt: number;
  jobId: number;
  startedAt: number;
  finishedAt: number;
  terminalAt: number;
  observedAt: number;
  outcome: ActionsReleaseOutcomeV1;
  startupReady: true;
  settled: true;
  login: typeof ACTIONS_RELEASE_LOGIN;
  logDigest: string;
}

export interface ActionsReleaseReceiptV1 {
  version: "v1";
  kind: "actions_release_receipt";
  request: ReleaseRequestV1;
  proof: ActionsRunProofV1;
}

const RECEIPT_KEYS = ["version", "kind", "request", "proof"] as const;
const PROOF_KEYS = [
  "repository",
  "workflowId",
  "workflowPath",
  "branch",
  "event",
  "controllerSha",
  "baseSha",
  "runId",
  "runAttempt",
  "jobId",
  "startedAt",
  "finishedAt",
  "terminalAt",
  "observedAt",
  "outcome",
  "startupReady",
  "settled",
  "login",
  "logDigest",
] as const;

export function parseActionsReleaseReceiptV1(
  input: unknown,
): ActionsReleaseReceiptV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, RECEIPT_KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, ["actions_release_receipt"], "$.kind");
  const request = parseReleaseRequestV1(obj.request);
  const proof = parseActionsRunProof(obj.proof, "$.proof");
  if (proof.startedAt > proof.terminalAt) {
    fail(
      "$.proof.terminalAt",
      "invalid_lifecycle",
      "terminal record cannot precede the run start",
    );
  }
  if (proof.terminalAt > proof.finishedAt + ACTIONS_RELEASE_TIME_SLACK_MS) {
    fail(
      "$.proof.terminalAt",
      "invalid_lifecycle",
      "terminal record is after the job completion window",
    );
  }
  if (proof.finishedAt > proof.observedAt + ACTIONS_RELEASE_TIME_SLACK_MS) {
    fail(
      "$.proof.finishedAt",
      "invalid_lifecycle",
      "job completion is after the observation time",
    );
  }
  const receipt: ActionsReleaseReceiptV1 = {
    version: "v1",
    kind: "actions_release_receipt",
    request,
    proof,
  };
  // The parser enforces the request binding itself (self scope-0 production
  // open request with a review reference, exact controller/base revision and
  // start not before the request). The consumer still re-parses AND binds the
  // returned value to the request it supplied: two independent boundaries.
  if (!actionsReceiptBindsRequest(receipt, request)) {
    fail(
      "$.proof",
      "invalid_lifecycle",
      "receipt does not bind the self production request",
    );
  }
  return receipt;
}

function parseActionsRunProof(
  input: unknown,
  path: string,
): ActionsRunProofV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, PROOF_KEYS, path);
  const repository = expectNonEmptyString(
    obj.repository,
    `${path}.repository`,
    MaxText.owner + 1 + MaxText.name,
  );
  if (repository !== ACTIONS_RELEASE_REPOSITORY) {
    fail(`${path}.repository`, "invalid_value", "unexpected repository");
  }
  const workflowId = expectPositiveInt(obj.workflowId, `${path}.workflowId`);
  if (workflowId !== ACTIONS_RELEASE_WORKFLOW_ID) {
    fail(`${path}.workflowId`, "invalid_value", "unexpected workflow id");
  }
  const workflowPath = expectNonEmptyString(
    obj.workflowPath,
    `${path}.workflowPath`,
    MaxText.path,
  );
  if (workflowPath !== ACTIONS_RELEASE_WORKFLOW_PATH) {
    fail(`${path}.workflowPath`, "invalid_value", "unexpected workflow path");
  }
  const branch = expectNonEmptyString(
    obj.branch,
    `${path}.branch`,
    MaxText.branch,
  );
  if (branch !== ACTIONS_RELEASE_BRANCH) {
    fail(`${path}.branch`, "invalid_value", "unexpected branch");
  }
  const login = expectNonEmptyString(obj.login, `${path}.login`, MaxText.login);
  if (login !== ACTIONS_RELEASE_LOGIN) {
    fail(`${path}.login`, "invalid_value", "unexpected run login");
  }
  const startupReady = expectBoolean(
    obj.startupReady,
    `${path}.startupReady`,
  );
  if (startupReady !== true) {
    fail(
      `${path}.startupReady`,
      "invalid_lifecycle",
      "model startup must be proven ready",
    );
  }
  const settled = expectBoolean(obj.settled, `${path}.settled`);
  if (settled !== true) {
    fail(
      `${path}.settled`,
      "invalid_lifecycle",
      "owned sessions must be proven settled",
    );
  }
  return {
    repository: ACTIONS_RELEASE_REPOSITORY,
    workflowId: ACTIONS_RELEASE_WORKFLOW_ID,
    workflowPath: ACTIONS_RELEASE_WORKFLOW_PATH,
    branch: ACTIONS_RELEASE_BRANCH,
    event: expectEnum(
      obj.event,
      ["schedule", "workflow_dispatch"],
      `${path}.event`,
    ),
    controllerSha: expectGitSha(obj.controllerSha, `${path}.controllerSha`),
    baseSha: expectGitSha(obj.baseSha, `${path}.baseSha`),
    runId: expectPositiveInt(obj.runId, `${path}.runId`),
    runAttempt: expectPositiveInt(obj.runAttempt, `${path}.runAttempt`),
    jobId: expectPositiveInt(obj.jobId, `${path}.jobId`),
    startedAt: expectTimestamp(obj.startedAt, `${path}.startedAt`),
    finishedAt: expectTimestamp(obj.finishedAt, `${path}.finishedAt`),
    terminalAt: expectTimestamp(obj.terminalAt, `${path}.terminalAt`),
    observedAt: expectTimestamp(obj.observedAt, `${path}.observedAt`),
    outcome: expectEnum(
      obj.outcome,
      ["idle", "margin", "step_limit"],
      `${path}.outcome`,
    ),
    startupReady: true,
    settled: true,
    login: ACTIONS_RELEASE_LOGIN,
    logDigest: expectSha256Hex(obj.logDigest, `${path}.logDigest`),
  };
}

/**
 * The exact self production open request bound to this receipt: the embedded
 * request must canonicalize identically, the self scope-0 repository and
 * production environment are mandatory, an accepted review receipt must be
 * referenced, and the proof controller/base revision must be the requested
 * revision, started no earlier than the request itself.
 */
export function actionsReceiptBindsRequest(
  receipt: ActionsReleaseReceiptV1,
  request: ReleaseRequestV1,
): boolean {
  let sameRequest: boolean;
  try {
    sameRequest = canonicalStringify(receipt.request) ===
      canonicalStringify(request);
  } catch {
    return false;
  }
  if (!sameRequest) return false;
  const repository = request.target.repository;
  if (
    repository.installationId !== 0 || repository.owner !== "ubiquity" ||
    repository.name !== "sentinel"
  ) {
    return false;
  }
  if (request.target.environment !== "production") return false;
  if (request.status !== "open") return false;
  if (request.source.reviewReceiptId === null) return false;
  const proof = receipt.proof;
  if (
    proof.controllerSha !== request.revision ||
    proof.baseSha !== request.revision
  ) {
    return false;
  }
  if (proof.startedAt < request.createdAt) return false;
  if (proof.startedAt > proof.terminalAt) return false;
  if (proof.terminalAt > proof.finishedAt + ACTIONS_RELEASE_TIME_SLACK_MS) {
    return false;
  }
  if (proof.finishedAt > proof.observedAt + ACTIONS_RELEASE_TIME_SLACK_MS) {
    return false;
  }
  return true;
}

/** Canonical map of normalised tree entries used for authority comparison. */
export function actionsAuthorityFiles(): readonly string[] {
  return [
    ".github/workflows/repair.yml",
    "deno.json",
    "src/host/actions.ts",
    "src/host/actions-preflight.ts",
    "src/host/local.ts",
    "src/main.ts",
  ];
}

export function actionsOptionalAuthorityFiles(): readonly string[] {
  return [
    "src/host/actions-release.ts",
    "src/contracts/actions-release.ts",
    "src/host/actions-ci.ts",
  ];
}

/** Bounded list of tree entries; truncated trees are rejected upstream. */
export const ACTIONS_RELEASE_TREE_MAX_ENTRIES = 100_000;
export const ACTIONS_RELEASE_RUN_MAX = 100;
export const ACTIONS_RELEASE_LOG_MAX_BYTES = 8 * 1024 * 1024;

/** Exported for tests: strict count helper used by the client too. */
export function actionsReleaseCiApprovalCounts(
  input: unknown,
  path: string,
): { approved: number; pending: number; unavailable: number } {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, ["approved", "pending", "unavailable"], path);
  return {
    approved: expectCount(obj.approved, `${path}.approved`),
    pending: expectCount(obj.pending, `${path}.pending`),
    unavailable: expectCount(obj.unavailable, `${path}.unavailable`),
  };
}

/** Exported for tests: bounded array helper for authority tree entries. */
export function actionsReleaseTreeEntries(
  input: unknown,
  path: string,
): unknown[] {
  return expectArray(
    input,
    path,
    ACTIONS_RELEASE_TREE_MAX_ENTRIES,
    (value) => value,
  );
}
