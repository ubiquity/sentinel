/**
 * Hosted supervisor storage contracts (records only, no behavior).
 *
 * The protected supervisor runs its prepare/finalize phases on separate
 * runners from the ordinary runtime. These records persist that separation in
 * the EXISTING release state Git storage: they are separate collections
 * (`hostedRuntimes`, `hostedReleases`) and never fabricate a Deno
 * ReleaseRecordV1. Nothing here promotes, verifies or writes state by itself;
 * the parsers and the snapshot transition validator are the whole surface.
 *
 * Fixed identity of the one hosted scope: the self repository at the explicit
 * no-App installation scope 0, the fixed supervisor workflow and the fixed
 * supervisor ref. The runtime model policy is unchanged and lives elsewhere.
 */

import type { GitSha } from "./brands.ts";
import { canonicalStringify } from "./canonical.ts";
import { parseReleaseRequestV1 } from "./release.ts";
import type { ReleaseRequestV1 } from "./release.ts";
import {
  expectBoolean,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectNullableString,
  expectPositiveInt,
  expectRecord,
  expectSha256Hex,
  expectTimestamp,
  expectVersion,
  fail,
  MaxText,
  tryParse,
} from "./validation.ts";

/** Fixed runtime record id of the one hosted self production runtime. */
export const HOSTED_RUNTIME_ID = "ubiquity/sentinel:0:production";
/** Fixed supervisor workflow identity. */
export const HOSTED_SUPERVISOR_WORKFLOW_ID = 357012162;
export const HOSTED_SUPERVISOR_WORKFLOW_PATH =
  ".github/workflows/supervisor.yml";
export const HOSTED_SUPERVISOR_REF = "refs/heads/sentinel-supervisor";
export const HOSTED_SUPERVISOR_REPOSITORY = "ubiquity/sentinel";
/**
 * Actions run metadata has one-second/whole-second clock precision: adjacent
 * timestamps written by the platform may differ by up to 999 ms in either
 * direction without being a contradiction.
 */
export const HOSTED_ACTIONS_CLOCK_TOLERANCE_MS = 999;

export type HostedExecutionPurposeV1 =
  | "bootstrap"
  | "ordinary"
  | "prior"
  | "candidate"
  | "rollback";
export type HostedRunOutcomeV1 = "healthy" | "failed";
export type HostedReleasePhaseV1 =
  | "requested"
  | "promoting"
  | "verifying"
  | "accepted"
  | "rollback_pending"
  | "rollback_verifying"
  | "rolled_back";
export type HostedPointerActionV1 = "promote" | "rollback";

/**
 * One exact hosted execution request. `id` is the exact deterministic
 * `runId:runAttempt:repair` identity; `launcherSha` is the immutable launcher
 * (workflow/controller) revision and is deliberately separate from the
 * execution revision and from any observed base SHA.
 */
export interface HostedExecutionIntentV1 {
  id: string;
  runId: number;
  runAttempt: number;
  launcherSha: GitSha;
  purpose: HostedExecutionPurposeV1;
  revision: GitSha;
  generation: number;
  /** Release this execution belongs to; null exactly for bootstrap/ordinary. */
  releaseId: string | null;
  createdAt: number;
}

/**
 * Immutable proof of one completed hosted job: the FULL execution intent, the
 * fixed workflow/repository/ref identity, positive job id, the platform
 * timestamps, the observed outcome and the exact log digest. `settled` is
 * always true (an unsettled run is never proof) and a healthy proof must carry
 * the startup flag, the observed base SHA and the terminal instant.
 */
export interface HostedRunProofV1 {
  execution: HostedExecutionIntentV1;
  workflowId: number;
  workflowPath: string;
  repository: string;
  ref: string;
  jobId: number;
  startedAt: number;
  finishedAt: number;
  observedAt: number;
  outcome: HostedRunOutcomeV1;
  startupReady: boolean;
  settled: true;
  baseSha: GitSha | null;
  terminalAt: number | null;
  logDigest: string;
}

/**
 * No-execution settlement: the exact repair job was skipped or absent for this
 * execution intent, proven from the exact job listing. It deliberately has no
 * start time, startup flag, base SHA, terminal instant or log digest: no
 * execution evidence is fabricated. `finishedAt`/`observedAt` are the listing
 * observation times and `evidenceDigest` is the digest of that listing.
 */
export interface HostedNotStartedProofV1 {
  execution: HostedExecutionIntentV1;
  workflowId: number;
  workflowPath: string;
  repository: string;
  ref: string;
  /** Exact repair job id when skipped; null when the listing has no repair job. */
  jobId: number | null;
  finishedAt: number;
  observedAt: number;
  outcome: "not_started";
  evidenceDigest: string;
}

/**
 * How one execution ended: a real run proof (healthy/failed) or an explicit
 * no-execution settlement. Only real run proofs may ever claim health.
 */
export type HostedExecutionSettlementV1 =
  | HostedRunProofV1
  | HostedNotStartedProofV1;

/**
 * The one hosted runtime pointer. `lastHealthyProof` may belong to an earlier
 * generation while a candidate is under verification; `execution` (when
 * present) must bind the exact pointer revision and generation.
 * `lastExecutionProof` is the settlement of the immediately previous
 * execution (run proof or no-execution proof): it is written atomically with
 * clearing that exact execution, so an unknown settlement is never silently
 * lost and a new execution can only start in a LATER write.
 */
export interface HostedRuntimeRecordV1 {
  version: "v1";
  kind: "hosted_runtime";
  id: string;
  activeRevision: GitSha;
  generation: number;
  lastHealthyProof: HostedRunProofV1 | null;
  /** Settlement of the cleared previous execution; never a health claim. */
  lastExecutionProof: HostedExecutionSettlementV1 | null;
  nextOrdinaryAt: number;
  execution: HostedExecutionIntentV1 | null;
  createdAt: number;
  updatedAt: number;
}

/** Persisted-before-effect pointer intent (promote or rollback). */
export interface HostedPointerIntentV1 {
  action: HostedPointerActionV1;
  expectedRevision: GitSha;
  nextRevision: GitSha;
  expectedGeneration: number;
  createdAt: number;
}

/**
 * One hosted release receipt. `id` is exactly the release request id and the
 * request is stored in full (strict ReleaseRequestV1). Proofs are immutable
 * once present; the pointer intent is the only promotable movement authority.
 * `priorProof`/`rollbackProof` are healthy-only: a failed prior or rollback
 * execution is recorded solely in the runtime `lastExecutionProof` and leaves
 * the release in `requested`/`rollback_verifying` for a deterministic retry.
 * `candidateProof` records the FIRST exact candidate result, healthy or failed.
 */
export interface HostedReleaseRecordV1 {
  version: "v1";
  kind: "hosted_release";
  id: string;
  request: ReleaseRequestV1;
  priorRevision: GitSha;
  phase: HostedReleasePhaseV1;
  priorProof: HostedRunProofV1 | null;
  candidateProof: HostedRunProofV1 | null;
  rollbackProof: HostedRunProofV1 | null;
  pointerIntent: HostedPointerIntentV1 | null;
  createdAt: number;
  updatedAt: number;
}

const EXECUTION_KEYS = [
  "id",
  "runId",
  "runAttempt",
  "launcherSha",
  "purpose",
  "revision",
  "generation",
  "releaseId",
  "createdAt",
] as const;
const PROOF_KEYS = [
  "execution",
  "workflowId",
  "workflowPath",
  "repository",
  "ref",
  "jobId",
  "startedAt",
  "finishedAt",
  "observedAt",
  "outcome",
  "startupReady",
  "settled",
  "baseSha",
  "terminalAt",
  "logDigest",
] as const;
const NOT_STARTED_KEYS = [
  "execution",
  "workflowId",
  "workflowPath",
  "repository",
  "ref",
  "jobId",
  "finishedAt",
  "observedAt",
  "outcome",
  "evidenceDigest",
] as const;
const RUNTIME_KEYS = [
  "version",
  "kind",
  "id",
  "activeRevision",
  "generation",
  "lastHealthyProof",
  "lastExecutionProof",
  "nextOrdinaryAt",
  "execution",
  "createdAt",
  "updatedAt",
] as const;
const POINTER_KEYS = [
  "action",
  "expectedRevision",
  "nextRevision",
  "expectedGeneration",
  "createdAt",
] as const;
const HOSTED_RELEASE_KEYS = [
  "version",
  "kind",
  "id",
  "request",
  "priorRevision",
  "phase",
  "priorProof",
  "candidateProof",
  "rollbackProof",
  "pointerIntent",
  "createdAt",
  "updatedAt",
] as const;

export function parseHostedExecutionIntentV1(
  input: unknown,
  path = "$",
): HostedExecutionIntentV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, EXECUTION_KEYS, path);

  const runId = expectPositiveInt(obj.runId, `${path}.runId`);
  const runAttempt = expectPositiveInt(obj.runAttempt, `${path}.runAttempt`);
  const id = expectNonEmptyString(obj.id, `${path}.id`, MaxText.recordId);
  if (id !== `${runId}:${runAttempt}:repair`) {
    fail(
      `${path}.id`,
      "invalid_lifecycle",
      "execution id must be exactly runId:runAttempt:repair",
    );
  }
  const launcherSha = expectGitSha(obj.launcherSha, `${path}.launcherSha`);
  const purpose = expectEnum(
    obj.purpose,
    ["bootstrap", "ordinary", "prior", "candidate", "rollback"],
    `${path}.purpose`,
  );
  const revision = expectGitSha(obj.revision, `${path}.revision`);
  const generation = expectPositiveInt(obj.generation, `${path}.generation`);
  const releaseId = expectNullableString(
    obj.releaseId,
    `${path}.releaseId`,
    MaxText.recordId,
  );
  const createdAt = expectTimestamp(obj.createdAt, `${path}.createdAt`);

  const unscoped = purpose === "bootstrap" || purpose === "ordinary";
  if (unscoped !== (releaseId === null)) {
    fail(
      `${path}.releaseId`,
      "invalid_lifecycle",
      "releaseId is null exactly for bootstrap/ordinary executions",
    );
  }
  return {
    id,
    runId,
    runAttempt,
    launcherSha,
    purpose,
    revision,
    generation,
    releaseId,
    createdAt,
  };
}

export function parseHostedRunProofV1(
  input: unknown,
  path = "$",
): HostedRunProofV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, PROOF_KEYS, path);

  const execution = parseHostedExecutionIntentV1(
    obj.execution,
    `${path}.execution`,
  );
  const workflowId = expectPositiveInt(obj.workflowId, `${path}.workflowId`);
  if (workflowId !== HOSTED_SUPERVISOR_WORKFLOW_ID) {
    fail(
      `${path}.workflowId`,
      "invalid_lifecycle",
      "proof workflow id is not the fixed supervisor workflow",
    );
  }
  const workflowPath = expectNonEmptyString(
    obj.workflowPath,
    `${path}.workflowPath`,
    MaxText.path,
  );
  if (workflowPath !== HOSTED_SUPERVISOR_WORKFLOW_PATH) {
    fail(
      `${path}.workflowPath`,
      "invalid_lifecycle",
      "proof workflow path is not the fixed supervisor workflow",
    );
  }
  const repository = expectNonEmptyString(
    obj.repository,
    `${path}.repository`,
    MaxText.name + MaxText.owner + 1,
  );
  if (repository !== HOSTED_SUPERVISOR_REPOSITORY) {
    fail(
      `${path}.repository`,
      "invalid_lifecycle",
      "proof repository is not the fixed supervisor repository",
    );
  }
  const ref = expectNonEmptyString(obj.ref, `${path}.ref`, MaxText.ref);
  if (ref !== HOSTED_SUPERVISOR_REF) {
    fail(
      `${path}.ref`,
      "invalid_lifecycle",
      "proof ref is not the fixed supervisor ref",
    );
  }
  const jobId = expectPositiveInt(obj.jobId, `${path}.jobId`);
  const startedAt = expectTimestamp(obj.startedAt, `${path}.startedAt`);
  const finishedAt = expectTimestamp(obj.finishedAt, `${path}.finishedAt`);
  const observedAt = expectTimestamp(obj.observedAt, `${path}.observedAt`);
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
      "an unsettled run is never proof",
    );
  }
  const baseSha = expectNullable(obj.baseSha, `${path}.baseSha`, expectGitSha);
  const terminalAt = expectNullable(
    obj.terminalAt,
    `${path}.terminalAt`,
    expectTimestamp,
  );
  const logDigest = expectSha256Hex(obj.logDigest, `${path}.logDigest`);

  const tolerance = HOSTED_ACTIONS_CLOCK_TOLERANCE_MS;
  if (startedAt + tolerance < execution.createdAt) {
    fail(
      `${path}.startedAt`,
      "invalid_lifecycle",
      "startedAt precedes the execution intent beyond clock tolerance",
    );
  }
  if (finishedAt < startedAt) {
    fail(
      `${path}.finishedAt`,
      "invalid_lifecycle",
      "finishedAt cannot precede startedAt",
    );
  }
  if (observedAt + tolerance < finishedAt) {
    fail(
      `${path}.observedAt`,
      "invalid_lifecycle",
      "observedAt precedes finishedAt beyond clock tolerance",
    );
  }
  if (
    terminalAt !== null &&
    (terminalAt + tolerance < startedAt ||
      terminalAt > finishedAt + tolerance)
  ) {
    fail(
      `${path}.terminalAt`,
      "invalid_lifecycle",
      "terminalAt must fall within the observed job bounds",
    );
  }
  if (outcome === "healthy") {
    if (!startupReady) {
      fail(
        `${path}.startupReady`,
        "invalid_lifecycle",
        "a healthy proof requires startupReady true",
      );
    }
    if (baseSha === null) {
      fail(
        `${path}.baseSha`,
        "invalid_lifecycle",
        "a healthy proof requires the observed base SHA",
      );
    }
    if (terminalAt === null) {
      fail(
        `${path}.terminalAt`,
        "invalid_lifecycle",
        "a healthy proof requires the terminal instant",
      );
    }
  }
  return {
    execution,
    workflowId,
    workflowPath,
    repository,
    ref,
    jobId,
    startedAt,
    finishedAt,
    observedAt,
    outcome,
    startupReady,
    settled: true,
    baseSha,
    terminalAt,
    logDigest,
  };
}

export function parseHostedNotStartedProofV1(
  input: unknown,
  path = "$",
): HostedNotStartedProofV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, NOT_STARTED_KEYS, path);

  const execution = parseHostedExecutionIntentV1(
    obj.execution,
    `${path}.execution`,
  );
  const workflowId = expectPositiveInt(obj.workflowId, `${path}.workflowId`);
  if (workflowId !== HOSTED_SUPERVISOR_WORKFLOW_ID) {
    fail(
      `${path}.workflowId`,
      "invalid_lifecycle",
      "settlement workflow id is not the fixed supervisor workflow",
    );
  }
  const workflowPath = expectNonEmptyString(
    obj.workflowPath,
    `${path}.workflowPath`,
    MaxText.path,
  );
  if (workflowPath !== HOSTED_SUPERVISOR_WORKFLOW_PATH) {
    fail(
      `${path}.workflowPath`,
      "invalid_lifecycle",
      "settlement workflow path is not the fixed supervisor workflow",
    );
  }
  const repository = expectNonEmptyString(
    obj.repository,
    `${path}.repository`,
    MaxText.name + MaxText.owner + 1,
  );
  if (repository !== HOSTED_SUPERVISOR_REPOSITORY) {
    fail(
      `${path}.repository`,
      "invalid_lifecycle",
      "settlement repository is not the fixed supervisor repository",
    );
  }
  const ref = expectNonEmptyString(obj.ref, `${path}.ref`, MaxText.ref);
  if (ref !== HOSTED_SUPERVISOR_REF) {
    fail(
      `${path}.ref`,
      "invalid_lifecycle",
      "settlement ref is not the fixed supervisor ref",
    );
  }
  const jobId = expectNullable(obj.jobId, `${path}.jobId`, expectPositiveInt);
  const finishedAt = expectTimestamp(obj.finishedAt, `${path}.finishedAt`);
  const observedAt = expectTimestamp(obj.observedAt, `${path}.observedAt`);
  const outcome = expectEnum(
    obj.outcome,
    ["not_started"],
    `${path}.outcome`,
  );
  const evidenceDigest = expectSha256Hex(
    obj.evidenceDigest,
    `${path}.evidenceDigest`,
  );
  const tolerance = HOSTED_ACTIONS_CLOCK_TOLERANCE_MS;
  if (finishedAt + tolerance < execution.createdAt) {
    fail(
      `${path}.finishedAt`,
      "invalid_lifecycle",
      "finishedAt precedes the execution intent beyond clock tolerance",
    );
  }
  if (observedAt + tolerance < finishedAt) {
    fail(
      `${path}.observedAt`,
      "invalid_lifecycle",
      "observedAt precedes finishedAt beyond clock tolerance",
    );
  }
  return {
    execution,
    workflowId,
    workflowPath,
    repository,
    ref,
    jobId,
    finishedAt,
    observedAt,
    outcome,
    evidenceDigest,
  };
}

/** Discriminated settlement parser: never treats no-execution as a run. */
export function parseHostedExecutionSettlementV1(
  input: unknown,
  path = "$",
): HostedExecutionSettlementV1 {
  const obj = expectRecord(input, path);
  if (obj.outcome === "not_started") {
    return parseHostedNotStartedProofV1(input, path);
  }
  return parseHostedRunProofV1(input, path);
}

export function parseHostedRuntimeRecordV1(
  input: unknown,
  path = "$",
): HostedRuntimeRecordV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, RUNTIME_KEYS, path);
  expectVersion(obj.version, `${path}.version`);
  expectEnum(obj.kind, ["hosted_runtime"], `${path}.kind`);

  const id = expectNonEmptyString(obj.id, `${path}.id`, MaxText.recordId);
  if (id !== HOSTED_RUNTIME_ID) {
    fail(
      `${path}.id`,
      "invalid_lifecycle",
      "hosted runtime id is not the fixed self production runtime",
    );
  }
  const activeRevision = expectGitSha(
    obj.activeRevision,
    `${path}.activeRevision`,
  );
  const generation = expectPositiveInt(obj.generation, `${path}.generation`);
  const lastHealthyProof = expectNullable(
    obj.lastHealthyProof,
    `${path}.lastHealthyProof`,
    parseHostedRunProofV1,
  );
  if (lastHealthyProof !== null && lastHealthyProof.outcome !== "healthy") {
    fail(
      `${path}.lastHealthyProof`,
      "invalid_lifecycle",
      "lastHealthyProof must be a healthy proof",
    );
  }
  const lastExecutionProof = expectNullable(
    obj.lastExecutionProof,
    `${path}.lastExecutionProof`,
    parseHostedExecutionSettlementV1,
  );
  const nextOrdinaryAt = expectTimestamp(
    obj.nextOrdinaryAt,
    `${path}.nextOrdinaryAt`,
  );
  const execution = expectNullable(
    obj.execution,
    `${path}.execution`,
    parseHostedExecutionIntentV1,
  );
  if (execution !== null) {
    if (execution.revision !== activeRevision) {
      fail(
        `${path}.execution.revision`,
        "invalid_lifecycle",
        "an execution must bind the runtime pointer revision",
      );
    }
    if (execution.generation !== generation) {
      fail(
        `${path}.execution.generation`,
        "invalid_lifecycle",
        "an execution must bind the runtime pointer generation",
      );
    }
    // A settled execution is never still active, and a healthy proof of the
    // active execution would claim a settlement that removal contradicts. The
    // deterministic execution id is the identity: altered metadata must not
    // launder a settled execution back into the active slot.
    if (
      lastExecutionProof !== null &&
      lastExecutionProof.execution.id === execution.id
    ) {
      fail(
        `${path}.lastExecutionProof`,
        "invalid_lifecycle",
        "the active execution cannot already be its own settlement proof",
      );
    }
    if (
      lastHealthyProof !== null &&
      lastHealthyProof.execution.id === execution.id
    ) {
      fail(
        `${path}.lastHealthyProof`,
        "invalid_lifecycle",
        "the active execution cannot already have a healthy settlement",
      );
    }
  }
  const createdAt = expectTimestamp(obj.createdAt, `${path}.createdAt`);
  const updatedAt = expectTimestamp(obj.updatedAt, `${path}.updatedAt`);
  if (createdAt > updatedAt) {
    fail(
      `${path}.createdAt`,
      "invalid_lifecycle",
      "createdAt cannot be after updatedAt",
    );
  }
  if (nextOrdinaryAt < createdAt) {
    fail(
      `${path}.nextOrdinaryAt`,
      "invalid_lifecycle",
      "nextOrdinaryAt cannot precede createdAt",
    );
  }
  return {
    version: "v1",
    kind: "hosted_runtime",
    id,
    activeRevision,
    generation,
    lastHealthyProof,
    lastExecutionProof,
    nextOrdinaryAt,
    execution,
    createdAt,
    updatedAt,
  };
}

export function parseHostedPointerIntentV1(
  input: unknown,
  path = "$",
): HostedPointerIntentV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, POINTER_KEYS, path);
  const action = expectEnum(
    obj.action,
    ["promote", "rollback"],
    `${path}.action`,
  );
  const expectedRevision = expectGitSha(
    obj.expectedRevision,
    `${path}.expectedRevision`,
  );
  const nextRevision = expectGitSha(
    obj.nextRevision,
    `${path}.nextRevision`,
  );
  if (expectedRevision === nextRevision) {
    fail(
      `${path}.nextRevision`,
      "invalid_lifecycle",
      "a pointer intent must move to a different revision",
    );
  }
  const expectedGeneration = expectPositiveInt(
    obj.expectedGeneration,
    `${path}.expectedGeneration`,
  );
  const createdAt = expectTimestamp(obj.createdAt, `${path}.createdAt`);
  return {
    action,
    expectedRevision,
    nextRevision,
    expectedGeneration,
    createdAt,
  };
}

export function parseHostedReleaseRecordV1(
  input: unknown,
  path = "$",
): HostedReleaseRecordV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, HOSTED_RELEASE_KEYS, path);
  expectVersion(obj.version, `${path}.version`);
  expectEnum(obj.kind, ["hosted_release"], `${path}.kind`);

  const request = parseReleaseRequestV1(obj.request);
  const id = expectNonEmptyString(obj.id, `${path}.id`, MaxText.recordId);
  if (id !== request.id) {
    fail(
      `${path}.id`,
      "invalid_lifecycle",
      "hosted release id must equal the release request id",
    );
  }
  // Exact self scope-0 production open reviewed request: no other repository,
  // installation, environment, status or review-less request is representable.
  const repository = request.target.repository;
  if (
    repository.owner !== "ubiquity" || repository.name !== "sentinel" ||
    repository.installationId !== 0
  ) {
    fail(
      `${path}.request.target.repository`,
      "invalid_lifecycle",
      "hosted release request must target the self scope-0 repository",
    );
  }
  if (request.target.environment !== "production") {
    fail(
      `${path}.request.target.environment`,
      "invalid_lifecycle",
      "hosted release request must target production",
    );
  }
  if (request.status !== "open") {
    fail(
      `${path}.request.status`,
      "invalid_lifecycle",
      "hosted release request must be open",
    );
  }
  if (request.source.reviewReceiptId === null) {
    fail(
      `${path}.request.source.reviewReceiptId`,
      "invalid_lifecycle",
      "hosted release request must be a reviewed request",
    );
  }
  const priorRevision = expectGitSha(
    obj.priorRevision,
    `${path}.priorRevision`,
  );
  if (priorRevision === request.revision) {
    fail(
      `${path}.priorRevision`,
      "invalid_lifecycle",
      "hosted release priorRevision must differ from the request revision",
    );
  }
  const phase = expectEnum(
    obj.phase,
    [
      "requested",
      "promoting",
      "verifying",
      "accepted",
      "rollback_pending",
      "rollback_verifying",
      "rolled_back",
    ],
    `${path}.phase`,
  );
  const priorProof = expectNullable(
    obj.priorProof,
    `${path}.priorProof`,
    parseHostedRunProofV1,
  );
  const candidateProof = expectNullable(
    obj.candidateProof,
    `${path}.candidateProof`,
    parseHostedRunProofV1,
  );
  const rollbackProof = expectNullable(
    obj.rollbackProof,
    `${path}.rollbackProof`,
    parseHostedRunProofV1,
  );
  const pointerIntent = expectNullable(
    obj.pointerIntent,
    `${path}.pointerIntent`,
    parseHostedPointerIntentV1,
  );
  const createdAt = expectTimestamp(obj.createdAt, `${path}.createdAt`);
  const updatedAt = expectTimestamp(obj.updatedAt, `${path}.updatedAt`);

  expectProofBinding(
    priorProof,
    "prior",
    priorRevision,
    id,
    `${path}.priorProof`,
  );
  expectProofBinding(
    candidateProof,
    "candidate",
    request.revision,
    id,
    `${path}.candidateProof`,
  );
  expectProofBinding(
    rollbackProof,
    "rollback",
    priorRevision,
    id,
    `${path}.rollbackProof`,
  );
  if (priorProof !== null && priorProof.outcome !== "healthy") {
    fail(
      `${path}.priorProof`,
      "invalid_lifecycle",
      "the prior proof must be healthy",
    );
  }
  if (rollbackProof !== null && rollbackProof.outcome !== "healthy") {
    fail(
      `${path}.rollbackProof`,
      "invalid_lifecycle",
      "the rollback proof must be healthy",
    );
  }

  if (createdAt < request.createdAt) {
    fail(
      `${path}.createdAt`,
      "invalid_lifecycle",
      "hosted release createdAt cannot precede the release request",
    );
  }
  if (createdAt > updatedAt) {
    fail(
      `${path}.createdAt`,
      "invalid_lifecycle",
      "createdAt cannot be after updatedAt",
    );
  }
  for (
    const [index, proof] of [
      priorProof,
      candidateProof,
      rollbackProof,
    ].entries()
  ) {
    if (proof !== null && proof.execution.createdAt < createdAt) {
      fail(
        `${path}.proofs[${index}].execution.createdAt`,
        "invalid_lifecycle",
        "saved proof executions cannot precede the hosted receipt",
      );
    }
  }

  if (phase !== "requested") {
    // promoting and every later phase depend on an attested prior proof.
    if (priorProof === null) {
      fail(
        `${path}.priorProof`,
        "invalid_lifecycle",
        "promoting and later phases require the prior proof",
      );
    }
  }
  if (phase === "promoting") {
    expectPointerIntent(
      pointerIntent,
      "promote",
      priorRevision,
      request.revision,
      `${path}.pointerIntent`,
    );
  } else if (phase === "rollback_pending") {
    if (pointerIntent !== null) {
      expectPointerIntent(
        pointerIntent,
        "rollback",
        request.revision,
        priorRevision,
        `${path}.pointerIntent`,
      );
    }
  } else if (pointerIntent !== null) {
    fail(
      `${path}.pointerIntent`,
      "invalid_lifecycle",
      "a pointer intent exists only while promoting or rollback_pending",
    );
  }
  if (phase === "accepted") {
    if (candidateProof === null || candidateProof.outcome !== "healthy") {
      fail(
        `${path}.candidateProof`,
        "invalid_lifecycle",
        "accepted requires a healthy candidate proof",
      );
    }
  }
  if (
    phase === "rollback_pending" || phase === "rollback_verifying" ||
    phase === "rolled_back"
  ) {
    if (candidateProof === null || candidateProof.outcome !== "failed") {
      fail(
        `${path}.candidateProof`,
        "invalid_lifecycle",
        "rollback phases require the failed candidate proof",
      );
    }
  }
  if (phase === "rolled_back") {
    if (rollbackProof === null || rollbackProof.outcome !== "healthy") {
      fail(
        `${path}.rollbackProof`,
        "invalid_lifecycle",
        "rolled_back requires the healthy rollback proof",
      );
    }
  }

  return {
    version: "v1",
    kind: "hosted_release",
    id,
    request,
    priorRevision,
    phase,
    priorProof,
    candidateProof,
    rollbackProof,
    pointerIntent,
    createdAt,
    updatedAt,
  };
}

function expectProofBinding(
  proof: HostedRunProofV1 | null,
  purpose: HostedExecutionPurposeV1,
  revision: GitSha,
  releaseId: string,
  path: string,
): void {
  if (proof === null) return;
  if (
    proof.execution.purpose !== purpose ||
    proof.execution.revision !== revision ||
    proof.execution.releaseId !== releaseId
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "hosted run proof does not bind the exact release, purpose and revision",
    );
  }
}

function expectPointerIntent(
  intent: HostedPointerIntentV1 | null,
  action: HostedPointerActionV1,
  expectedRevision: GitSha,
  nextRevision: GitSha,
  path: string,
): void {
  if (
    intent === null || intent.action !== action ||
    intent.expectedRevision !== expectedRevision ||
    intent.nextRevision !== nextRevision
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "hosted pointer intent does not match the phase movement",
    );
  }
}

/**
 * Strict full-request binding for a saved hosted receipt: the stored request
 * must canonical-equal a freshly parsed request. A foreign, malformed or
 * mutated request never binds.
 */
export function hostedReceiptBindsRequest(
  record: HostedReleaseRecordV1,
  request: ReleaseRequestV1,
): boolean {
  const parsedRecord = tryParse(parseHostedReleaseRecordV1, record);
  const parsedRequest = tryParse(parseReleaseRequestV1, request);
  if (!parsedRecord.ok || !parsedRequest.ok) return false;
  return parsedRecord.value.request.id === parsedRequest.value.id &&
    canonicalStringify(parsedRecord.value.request) ===
      canonicalStringify(parsedRequest.value);
}

function sameCanonical(a: unknown, b: unknown): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}

/**
 * Fail-closed hosted transition validation over the two separate record
 * collections. It runs after the existing Deno release checks and returns a
 * bounded static message (never a payload) or null. Rules:
 *
 * - an existing runtime never disappears; id/createdAt are immutable and
 *   updatedAt never moves backward;
 * - the active revision/generation pair is unchanged or moves by exactly one
 *   generation, no active execution on either side and the PRIOR snapshot's
 *   matching persisted intent advanced in the same write; the same revision
 *   can never change generation;
 * - an execution is retained unchanged, cleared atomically with its exact
 *   settlement saved in `lastExecutionProof` (run proof or explicit
 *   no-execution settlement), or started as a NEW intent in a later write; an
 *   old execution is never replaced or rebound, so an unknown settlement is
 *   never silently lost;
 * - only a healthy settlement may also update `lastHealthyProof` (to the same
 *   exact proof), and a newly attached release proof must bind the exact
 *   execution settled in the same write;
 * - a first runtime starts at generation 1 with no historical health or
 *   execution proof;
 * - an existing release record never disappears; request, priorRevision and
 *   createdAt are immutable; a proof once present is immutable; terminal
 *   receipts are entirely immutable; phases only advance along the fixed
 *   order (same phase may persist repeatedly); a pointer intent once set only
 *   clears on the exact corresponding generation+1 movement;
 * - a new release record starts at `requested` with no proofs and no intent.
 */
export function validateHostedStateTransition(
  priorRuntimes: readonly HostedRuntimeRecordV1[],
  priorReleases: readonly HostedReleaseRecordV1[],
  nextRuntimes: readonly HostedRuntimeRecordV1[],
  nextReleases: readonly HostedReleaseRecordV1[],
): string | null {
  for (const priorRuntime of priorRuntimes) {
    const nextRuntime = nextRuntimes.find(
      (runtime) => runtime.id === priorRuntime.id,
    );
    if (nextRuntime === undefined) {
      return "existing hosted runtime cannot disappear";
    }
    if (nextRuntime.createdAt !== priorRuntime.createdAt) {
      return "hosted runtime createdAt is immutable";
    }
    if (nextRuntime.updatedAt < priorRuntime.updatedAt) {
      return "hosted runtime updatedAt cannot move backward";
    }

    const priorExecution = priorRuntime.execution;
    const nextExecution = nextRuntime.execution;
    const priorSettlement = priorRuntime.lastExecutionProof;
    const nextSettlement = nextRuntime.lastExecutionProof;

    // Execution lifetime: retained unchanged, cleared atomically with its exact
    // settlement proof, or newly started in a LATER write after a clear. A
    // direct old -> new replacement is never allowed, even with a proof.
    if (priorExecution !== null && nextExecution !== null) {
      if (!sameCanonical(priorExecution, nextExecution)) {
        return "an existing hosted runtime execution cannot be replaced";
      }
    } else if (priorExecution !== null && nextExecution === null) {
      if (
        nextSettlement === null ||
        !sameCanonical(nextSettlement.execution, priorExecution)
      ) {
        return "hosted runtime execution cannot be cleared without its exact settlement proof";
      }
    } else if (priorExecution === null && nextExecution !== null) {
      // An already settled execution is never rebound to the current attempt,
      // even with altered metadata: the deterministic execution id is the
      // identity and a rerun starts a NEW run/attempt id.
      if (
        (priorSettlement !== null &&
          priorSettlement.execution.id === nextExecution.id) ||
        (priorRuntime.lastHealthyProof !== null &&
          priorRuntime.lastHealthyProof.execution.id === nextExecution.id)
      ) {
        return "a settled hosted runtime execution cannot be rebound";
      }
    }

    // Proof pointers only move with the exact settlement of the execution
    // being cleared in this same write; arbitrary proofs are refused.
    if (!sameCanonical(priorSettlement, nextSettlement)) {
      if (priorExecution === null || nextExecution !== null) {
        return "hosted runtime lastExecutionProof can only change on its exact execution settlement";
      }
    }
    const settledNow = !sameCanonical(priorSettlement, nextSettlement);
    if (
      settledNow && nextSettlement !== null &&
      nextSettlement.outcome === "not_started"
    ) {
      // No-execution settlement only clears the intent: it never claims
      // health, attaches a release proof or moves the pointer in this write.
      if (
        !sameCanonical(
          priorRuntime.lastHealthyProof,
          nextRuntime.lastHealthyProof,
        )
      ) {
        return "a not_started settlement preserves lastHealthyProof";
      }
      if (
        nextRuntime.activeRevision !== priorRuntime.activeRevision ||
        nextRuntime.generation !== priorRuntime.generation
      ) {
        return "a not_started settlement cannot move the runtime pointer";
      }
    }
    if (
      priorRuntime.lastHealthyProof !== null &&
      nextRuntime.lastHealthyProof !== null &&
      nextRuntime.lastHealthyProof.execution.createdAt <
        priorRuntime.lastHealthyProof.execution.createdAt
    ) {
      return "hosted runtime healthy proof cannot move backward";
    }
    if (
      !sameCanonical(
        priorRuntime.lastHealthyProof,
        nextRuntime.lastHealthyProof,
      )
    ) {
      if (
        nextRuntime.lastHealthyProof === null ||
        nextRuntime.lastHealthyProof.outcome !== "healthy"
      ) {
        return "hosted runtime lastHealthyProof can only move to a healthy proof";
      }
      if (priorExecution === null || nextExecution !== null) {
        return "hosted runtime lastHealthyProof can only change on its exact execution settlement";
      }
      if (!sameCanonical(nextRuntime.lastHealthyProof, nextSettlement)) {
        return "a healthy settlement must update both runtime proofs to the same exact proof";
      }
    }

    // Pointer movement: exactly one generation, no active execution on either
    // side, and the exact prior persisted intent advanced in the same write.
    if (
      nextRuntime.activeRevision !== priorRuntime.activeRevision ||
      nextRuntime.generation !== priorRuntime.generation
    ) {
      if (nextRuntime.generation !== priorRuntime.generation + 1) {
        return "hosted runtime pointer movement requires exactly one generation increment";
      }
      if (nextRuntime.activeRevision === priorRuntime.activeRevision) {
        return "the same hosted runtime revision cannot change generation";
      }
      if (priorExecution !== null || nextExecution !== null) {
        return "hosted runtime pointer movement requires no active execution";
      }
      const matched = priorReleases.some((release) => {
        const intent = release.pointerIntent;
        if (intent === null) return false;
        if (intent.expectedRevision !== priorRuntime.activeRevision) {
          return false;
        }
        if (intent.expectedGeneration !== priorRuntime.generation) {
          return false;
        }
        if (intent.nextRevision !== nextRuntime.activeRevision) {
          return false;
        }
        const advanced = nextReleases.find((item) => item.id === release.id);
        if (advanced === undefined || advanced.pointerIntent !== null) {
          return false;
        }
        if (intent.action === "promote") {
          return release.phase === "promoting" &&
            advanced.phase === "verifying";
        }
        return release.phase === "rollback_pending" &&
          advanced.phase === "rollback_verifying";
      });
      if (!matched) {
        return "hosted runtime pointer movement has no exact persisted pointer intent and phase advance";
      }
    }
  }
  for (const nextRuntime of nextRuntimes) {
    if (priorRuntimes.some((runtime) => runtime.id === nextRuntime.id)) {
      continue;
    }
    if (priorRuntimes.length > 0) {
      return "a hosted runtime cannot introduce another runtime identity";
    }
    if (nextRuntime.generation !== 1) {
      return "the first hosted runtime must start at generation 1";
    }
    if (nextRuntime.lastHealthyProof !== null) {
      return "the first hosted runtime cannot claim a healthy proof";
    }
    if (nextRuntime.lastExecutionProof !== null) {
      return "the first hosted runtime cannot claim historical proof";
    }
  }

  const priorRuntimeRecord = priorRuntimes[0] ?? null;
  const nextRuntimeRecord = nextRuntimes[0] ?? null;
  const notStartedNow = priorRuntimeRecord !== null &&
    nextRuntimeRecord !== null &&
    !sameCanonical(
      priorRuntimeRecord.lastExecutionProof,
      nextRuntimeRecord.lastExecutionProof,
    ) &&
    nextRuntimeRecord.lastExecutionProof !== null &&
    nextRuntimeRecord.lastExecutionProof.outcome === "not_started";

  for (const priorRecord of priorReleases) {
    const nextRecord = nextReleases.find(
      (release) => release.id === priorRecord.id,
    );
    if (nextRecord === undefined) {
      return "existing hosted release cannot disappear";
    }
    if (!sameCanonical(priorRecord.request, nextRecord.request)) {
      return "hosted release request is immutable";
    }
    if (priorRecord.priorRevision !== nextRecord.priorRevision) {
      return "hosted release priorRevision is immutable";
    }
    if (priorRecord.createdAt !== nextRecord.createdAt) {
      return "hosted release createdAt is immutable";
    }
    if (nextRecord.updatedAt < priorRecord.updatedAt) {
      return "hosted release updatedAt cannot move backward";
    }
    for (
      const key of ["priorProof", "candidateProof", "rollbackProof"] as const
    ) {
      const priorProof = priorRecord[key];
      const nextProof = nextRecord[key];
      if (priorProof !== null) {
        if (nextProof === null || !sameCanonical(priorProof, nextProof)) {
          return "an existing hosted release proof is immutable";
        }
      } else if (nextProof !== null) {
        // A newly attached proof must be the EXACT full settlement recorded in
        // this same write (a real run proof, never no-execution), and it must
        // also bind the prior active execution being cleared; an unrelated
        // syntactically valid proof is never accepted.
        if (notStartedNow) {
          return "a not_started settlement cannot attach a release proof";
        }
        const priorExecution = priorRuntimes[0]?.execution ?? null;
        const nextRuntime = nextRuntimes[0] ?? null;
        const settlement = nextRuntime?.lastExecutionProof ?? null;
        if (
          priorExecution === null || nextRuntime === null ||
          nextRuntime.execution !== null || settlement === null ||
          settlement.outcome === "not_started" ||
          !sameCanonical(nextProof, settlement) ||
          !sameCanonical(nextProof.execution, priorExecution)
        ) {
          return "a newly attached hosted release proof must bind the exact settled execution";
        }
      }
    }
    if (
      priorRecord.phase === "accepted" || priorRecord.phase === "rolled_back"
    ) {
      if (!sameCanonical(priorRecord, nextRecord)) {
        return "a terminal hosted release receipt is immutable";
      }
      continue;
    }
    const allowed: Record<HostedReleasePhaseV1, HostedReleasePhaseV1[]> = {
      requested: ["requested", "promoting"],
      promoting: ["promoting", "verifying"],
      verifying: ["verifying", "accepted", "rollback_pending"],
      accepted: ["accepted"],
      rollback_pending: ["rollback_pending", "rollback_verifying"],
      rollback_verifying: ["rollback_verifying", "rolled_back"],
      rolled_back: ["rolled_back"],
    };
    if (!allowed[priorRecord.phase].includes(nextRecord.phase)) {
      return "hosted release phase transition is not allowed";
    }
    // A promoting/rollback_pending phase advance is the ATOMIC pointer
    // movement: exactly one generation, no active execution anywhere, the
    // prior intent cleared, and the matching release advanced.
    if (
      (priorRecord.phase === "promoting" && nextRecord.phase === "verifying") ||
      (priorRecord.phase === "rollback_pending" &&
        nextRecord.phase === "rollback_verifying")
    ) {
      const priorRuntime = priorRuntimes[0] ?? null;
      const nextRuntime = nextRuntimes[0] ?? null;
      const intent = priorRecord.pointerIntent;
      const action = priorRecord.phase === "promoting" ? "promote" : "rollback";
      const moved = intent !== null && intent.action === action &&
        priorRuntime !== null && nextRuntime !== null &&
        priorRuntime.execution === null && nextRuntime.execution === null &&
        priorRuntime.activeRevision === intent.expectedRevision &&
        priorRuntime.generation === intent.expectedGeneration &&
        nextRuntime.activeRevision === intent.nextRevision &&
        nextRuntime.generation === intent.expectedGeneration + 1;
      if (!moved) {
        return "a hosted release phase advance requires the exact atomic pointer movement";
      }
    }
    if (priorRecord.pointerIntent !== null) {
      if (nextRecord.pointerIntent !== null) {
        if (
          !sameCanonical(priorRecord.pointerIntent, nextRecord.pointerIntent)
        ) {
          return "a set hosted release pointer intent cannot change";
        }
      } else {
        const priorRuntime = priorRuntimes[0] ?? null;
        const nextRuntime = nextRuntimes[0] ?? null;
        const intent = priorRecord.pointerIntent;
        const moved = priorRuntime !== null && nextRuntime !== null &&
          priorRuntime.activeRevision === intent.expectedRevision &&
          priorRuntime.generation === intent.expectedGeneration &&
          nextRuntime.activeRevision === intent.nextRevision &&
          nextRuntime.generation === intent.expectedGeneration + 1;
        if (!moved) {
          return "hosted release pointer intent can only clear on the exact pointer movement";
        }
      }
    }
  }
  for (const nextRecord of nextReleases) {
    if (priorReleases.some((release) => release.id === nextRecord.id)) {
      continue;
    }
    if (
      nextRecord.phase !== "requested" || nextRecord.priorProof !== null ||
      nextRecord.candidateProof !== null ||
      nextRecord.rollbackProof !== null || nextRecord.pointerIntent !== null
    ) {
      return "a new hosted release must start at requested with no proofs or pointer intent";
    }
  }
  return null;
}
