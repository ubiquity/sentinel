/**
 * ReleaseRequestV1 and ReleaseRecordV1.
 *
 * A repair writer places a release request (exact accepted merged SHA plus
 * PR/review reference — never a model-chosen arbitrary revision). The release
 * writer exclusively owns release records: exact candidate/prior identities,
 * persisted promotion intent, the actually observed identity, monitored
 * acceptance with interrupted-coverage semantics, and rollback/error receipts.
 */

import type { GitSha } from "./brands.ts";
import {
  parseDeploymentIdentity,
  parseMetricsSample,
  parseRepositoryIdentity,
} from "./shared.ts";
import type {
  DeploymentIdentityV1,
  MetricsSampleV1,
  RepositoryIdentityV1,
} from "./shared.ts";
import type { StabilityMetricV1 } from "./repository-config.ts";
import {
  describeValue,
  expectArray,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectNullableString,
  expectPositiveInt,
  expectRecord,
  expectTimestamp,
  expectVersion,
  fail,
  MaxItems,
  MaxText,
} from "./validation.ts";

export type ReleaseRequestStatusV1 =
  | "open"
  | "fulfilled"
  | "failed"
  | "cancelled";
export type ReleaseTargetEnvironmentV1 = "production" | "isolated";
export type ReleasePhaseV1 =
  | "requested"
  | "promoting"
  | "monitoring"
  | "accepted"
  | "failed"
  | "rolled_back";
export type ReleaseIntentActionV1 = "promote" | "rollback";

export interface ReleaseRequestV1 {
  version: "v1";
  kind: "release_request";
  id: string;
  target: {
    repository: RepositoryIdentityV1;
    environment: ReleaseTargetEnvironmentV1;
  };
  /** The exact accepted merged SHA — the only revision this request may promote. */
  revision: GitSha;
  source: {
    pullRequest: number;
    reviewRequestId: string;
    reviewReceiptId: string | null;
    head: GitSha;
    base: GitSha;
  };
  status: ReleaseRequestStatusV1;
  failureReason: string | null;
  createdAt: number;
}

export interface ReleaseIntentV1 {
  action: ReleaseIntentActionV1;
  /** Deterministic idempotency key persisted before the external effect. */
  key: string;
  persistedAt: number;
}

export interface ReleaseObservedV1 {
  /** Actual exact platform identity observed after the effect; null until observed. */
  identity: DeploymentIdentityV1 | null;
  domain: string | null;
  /** Whether the observed identity was machine-verified (body/headers). */
  verified: boolean;
  at: number | null;
}

export interface ReleaseMonitoringV1 {
  startedAt: number | null;
  samples: number;
  /** False after interruption; acceptance is impossible without continuity. */
  continuous: boolean;
  lastSampleAt: number | null;
}

export interface AcceptanceThresholdResultV1 {
  metric: StabilityMetricV1;
  observedRate: number | null;
  /** Baseline rate from the persisted baseline evidence; null when unavailable. */
  baselineRate: number | null;
  maxRate: number;
  maxIncrease: number;
  passed: boolean;
}

export interface AcceptanceResultV1 {
  /** The exact controlled identity this acceptance proves, never an approximation. */
  identity: DeploymentIdentityV1;
  windowMs: number;
  sampleIntervalMs: number;
  continuous: boolean;
  /** Persisted baseline evidence (actual samples, denominators and flags). */
  baseline: MetricsSampleV1[];
  /** Persisted acceptance sample evidence; never a bare boolean. */
  samples: MetricsSampleV1[];
  thresholdResults: AcceptanceThresholdResultV1[];
  passed: boolean;
}

export interface ReleaseReceiptV1 {
  action: ReleaseIntentActionV1;
  ok: boolean;
  statusCode: number | null;
  observedIdentity: DeploymentIdentityV1 | null;
  observedDomain: string | null;
  at: number;
  detail: string | null;
}

export interface ReleaseErrorV1 {
  at: number;
  kind: string;
  detail: string;
  recovered: boolean;
}

export interface ReleaseRecordV1 {
  version: "v1";
  kind: "release_record";
  /** Repository the release targets (identity, resolves the deploy config). */
  repository: RepositoryIdentityV1;
  /** Isolated environment is a separate, representable target from production. */
  environment: ReleaseTargetEnvironmentV1;
  id: string;
  requestId: string;
  /** Recorded from the release request; the only promotable Git revision. */
  requestRevision: GitSha;
  /** Exact candidate identity (Git SHA + Deno revision id) plus the build transaction. */
  candidate: {
    identity: DeploymentIdentityV1;
    buildTransactionId: string;
  };
  /** Healthy exact prior identity attested before promotion. */
  prior: { identity: DeploymentIdentityV1; verifiedHealthyAt: number };
  phase: ReleasePhaseV1;
  intent: ReleaseIntentV1 | null;
  observed: ReleaseObservedV1;
  monitoring: ReleaseMonitoringV1;
  acceptance: AcceptanceResultV1 | null;
  receipts: {
    promote: ReleaseReceiptV1 | null;
    rollback: ReleaseReceiptV1 | null;
    error: ReleaseErrorV1 | null;
  };
  createdAt: number;
  updatedAt: number;
}

const REQUEST_KEYS = [
  "version",
  "kind",
  "id",
  "target",
  "revision",
  "source",
  "status",
  "failureReason",
  "createdAt",
] as const;
const REQUEST_TARGET_KEYS = ["repository", "environment"] as const;
const REQUEST_SOURCE_KEYS = [
  "pullRequest",
  "reviewRequestId",
  "reviewReceiptId",
  "head",
  "base",
] as const;
const RECORD_KEYS = [
  "version",
  "kind",
  "repository",
  "environment",
  "id",
  "requestId",
  "requestRevision",
  "candidate",
  "prior",
  "phase",
  "intent",
  "observed",
  "monitoring",
  "acceptance",
  "receipts",
  "createdAt",
  "updatedAt",
] as const;
const CANDIDATE_KEYS = ["identity", "buildTransactionId"] as const;
const PRIOR_KEYS = ["identity", "verifiedHealthyAt"] as const;
const INTENT_KEYS = ["action", "key", "persistedAt"] as const;
const OBSERVED_KEYS = ["identity", "domain", "verified", "at"] as const;
const MONITORING_KEYS = [
  "startedAt",
  "samples",
  "continuous",
  "lastSampleAt",
] as const;
const ACCEPTANCE_KEYS = [
  "identity",
  "windowMs",
  "sampleIntervalMs",
  "continuous",
  "baseline",
  "samples",
  "thresholdResults",
  "passed",
] as const;
const THRESHOLD_KEYS = [
  "metric",
  "observedRate",
  "baselineRate",
  "maxRate",
  "maxIncrease",
  "passed",
] as const;
const RECEIPT_KEYS = [
  "action",
  "ok",
  "statusCode",
  "observedIdentity",
  "observedDomain",
  "at",
  "detail",
] as const;
const ERROR_KEYS = ["at", "kind", "detail", "recovered"] as const;
const RECEIPTS_KEYS = ["promote", "rollback", "error"] as const;

export function parseReleaseRequestV1(input: unknown): ReleaseRequestV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, REQUEST_KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, ["release_request"], "$.kind");

  const id = expectNonEmptyString(obj.id, "$.id", MaxText.recordId);

  const targetObj = expectRecord(obj.target, "$.target");
  expectExactKeys(targetObj, REQUEST_TARGET_KEYS, "$.target");
  const target = {
    repository: parseRepositoryIdentity(
      targetObj.repository,
      "$.target.repository",
    ),
    environment: expectEnum(
      targetObj.environment,
      ["production", "isolated"],
      "$.target.environment",
    ),
  };
  const revision = expectGitSha(obj.revision, "$.revision");

  const sourceObj = expectRecord(obj.source, "$.source");
  expectExactKeys(sourceObj, REQUEST_SOURCE_KEYS, "$.source");
  const source = {
    pullRequest: expectPositiveInt(
      sourceObj.pullRequest,
      "$.source.pullRequest",
    ),
    reviewRequestId: expectNonEmptyString(
      sourceObj.reviewRequestId,
      "$.source.reviewRequestId",
      MaxText.recordId,
    ),
    reviewReceiptId: expectNullableString(
      sourceObj.reviewReceiptId,
      "$.source.reviewReceiptId",
      MaxText.recordId,
    ),
    head: expectGitSha(sourceObj.head, "$.source.head"),
    base: expectGitSha(sourceObj.base, "$.source.base"),
  };

  const status = expectEnum(
    obj.status,
    ["open", "fulfilled", "failed", "cancelled"],
    "$.status",
  );
  const failureReason = expectNullableString(
    obj.failureReason,
    "$.failureReason",
    MaxText.message,
  );
  if (
    (status === "failed" || status === "cancelled") && failureReason === null
  ) {
    fail(
      "$.failureReason",
      "invalid_lifecycle",
      "failed/cancelled request requires a reason",
    );
  }
  if ((status === "open" || status === "fulfilled") && failureReason !== null) {
    fail(
      "$.failureReason",
      "invalid_lifecycle",
      "open/fulfilled request has no failure reason",
    );
  }
  const createdAt = expectTimestamp(obj.createdAt, "$.createdAt");

  return {
    version: "v1",
    kind: "release_request",
    id,
    target,
    revision,
    source,
    status,
    failureReason,
    createdAt,
  };
}

export function parseReleaseRecordV1(input: unknown): ReleaseRecordV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, RECORD_KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, ["release_record"], "$.kind");

  const repository = parseRepositoryIdentity(obj.repository, "$.repository");
  const environment = expectEnum(
    obj.environment,
    ["production", "isolated"],
    "$.environment",
  );
  const id = expectNonEmptyString(obj.id, "$.id", MaxText.recordId);
  const requestId = expectNonEmptyString(
    obj.requestId,
    "$.requestId",
    MaxText.recordId,
  );
  const requestRevision = expectGitSha(
    obj.requestRevision,
    "$.requestRevision",
  );

  const candidateObj = expectRecord(obj.candidate, "$.candidate");
  expectExactKeys(candidateObj, CANDIDATE_KEYS, "$.candidate");
  const candidate = {
    identity: parseDeploymentIdentity(
      candidateObj.identity,
      "$.candidate.identity",
    ),
    buildTransactionId: expectNonEmptyString(
      candidateObj.buildTransactionId,
      "$.candidate.buildTransactionId",
      MaxText.recordId,
    ),
  };
  if (requestRevision !== candidate.identity.gitSha) {
    fail(
      "$.candidate.identity.gitSha",
      "invalid_lifecycle",
      "candidate Git SHA must equal the request revision",
    );
  }

  const priorObj = expectRecord(obj.prior, "$.prior");
  expectExactKeys(priorObj, PRIOR_KEYS, "$.prior");
  const prior = {
    identity: parseDeploymentIdentity(priorObj.identity, "$.prior.identity"),
    verifiedHealthyAt: expectTimestamp(
      priorObj.verifiedHealthyAt,
      "$.prior.verifiedHealthyAt",
    ),
  };
  if (sameIdentity(prior.identity, candidate.identity)) {
    fail(
      "$.prior.identity",
      "invalid_lifecycle",
      "prior and candidate identities must differ",
    );
  }

  const phase = expectEnum(
    obj.phase,
    [
      "requested",
      "promoting",
      "monitoring",
      "accepted",
      "failed",
      "rolled_back",
    ],
    "$.phase",
  );
  const intent = expectNullable(obj.intent, "$.intent", parseIntent);
  const observed = parseObserved(obj.observed, "$.observed");
  const monitoring = parseMonitoring(obj.monitoring, "$.monitoring");
  const acceptance = expectNullable(
    obj.acceptance,
    "$.acceptance",
    parseAcceptance,
  );
  const receipts = parseReceipts(obj.receipts, "$.receipts");

  const createdAt = expectTimestamp(obj.createdAt, "$.createdAt");
  const updatedAt = expectTimestamp(obj.updatedAt, "$.updatedAt");
  if (createdAt > updatedAt) {
    fail(
      "$.createdAt",
      "invalid_lifecycle",
      "createdAt cannot be after updatedAt",
    );
  }

  // Fail-closed phase rules.
  if (
    phase === "promoting" && (intent === null || intent.action !== "promote")
  ) {
    fail(
      "$.intent",
      "invalid_lifecycle",
      'phase "promoting" requires a persisted promote intent',
    );
  }
  if (phase === "accepted") {
    if (
      !observed.verified || observed.identity === null ||
      !sameIdentity(observed.identity, candidate.identity)
    ) {
      fail(
        "$.observed",
        "invalid_lifecycle",
        "accepted release requires a verified observed candidate identity",
      );
    }
    if (
      !monitoring.continuous || monitoring.samples < 1 ||
      monitoring.startedAt === null
    ) {
      fail(
        "$.monitoring",
        "invalid_lifecycle",
        "accepted release requires continuous monitoring coverage",
      );
    }
    if (acceptance === null || !acceptance.passed) {
      fail(
        "$.acceptance",
        "invalid_lifecycle",
        "accepted release requires a passing acceptance result",
      );
    }
    if (!acceptance.continuous) {
      fail(
        "$.acceptance",
        "invalid_lifecycle",
        "acceptance result cannot be continuous=false when accepted",
      );
    }
    if (!sameIdentity(acceptance.identity, candidate.identity)) {
      fail(
        "$.acceptance.identity",
        "invalid_lifecycle",
        "acceptance must reference the exact candidate identity",
      );
    }
  }
  if (phase === "rolled_back") {
    const rollback = receipts.rollback;
    if (rollback === null || !rollback.ok) {
      fail(
        "$.receipts.rollback",
        "invalid_lifecycle",
        "rolled_back requires an ok rollback receipt",
      );
    }
    if (
      rollback.observedIdentity === null ||
      !sameIdentity(rollback.observedIdentity, prior.identity)
    ) {
      fail(
        "$.receipts.rollback",
        "invalid_lifecycle",
        "rollback must restore the recorded prior identity",
      );
    }
    if (
      !observed.verified || observed.identity === null ||
      !sameIdentity(observed.identity, prior.identity)
    ) {
      fail(
        "$.observed",
        "invalid_lifecycle",
        "after rollback the observed identity must be the prior identity",
      );
    }
  }
  if (phase === "failed" && receipts.error === null) {
    fail(
      "$.receipts.error",
      "invalid_lifecycle",
      'phase "failed" requires an error receipt',
    );
  }

  return {
    version: "v1",
    kind: "release_record",
    repository,
    environment,
    id,
    requestId,
    requestRevision,
    candidate,
    prior,
    phase,
    intent,
    observed,
    monitoring,
    acceptance,
    receipts,
    createdAt,
    updatedAt,
  };
}

function sameIdentity(
  a: DeploymentIdentityV1,
  b: DeploymentIdentityV1,
): boolean {
  return a.gitSha === b.gitSha && a.revisionId === b.revisionId;
}

function parseIntent(input: unknown, path: string): ReleaseIntentV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, INTENT_KEYS, path);
  return {
    action: expectEnum(obj.action, ["promote", "rollback"], `${path}.action`),
    key: expectNonEmptyString(obj.key, `${path}.key`, MaxText.token),
    persistedAt: expectTimestamp(obj.persistedAt, `${path}.persistedAt`),
  };
}

function parseObserved(input: unknown, path: string): ReleaseObservedV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, OBSERVED_KEYS, path);
  const identity = expectNullable(
    obj.identity,
    `${path}.identity`,
    parseDeploymentIdentity,
  );
  const domain = expectNullableString(
    obj.domain,
    `${path}.domain`,
    MaxText.url,
  );
  const verified = expectBooleanOf(obj.verified, `${path}.verified`);
  const at = expectNullable(obj.at, `${path}.at`, expectTimestamp);
  if (verified && identity === null) {
    fail(
      `${path}.identity`,
      "invalid_lifecycle",
      "verified observation requires an identity",
    );
  }
  if (verified && at === null) {
    fail(
      `${path}.at`,
      "invalid_lifecycle",
      "verified observation requires a timestamp",
    );
  }
  return { identity, domain, verified, at };
}

function parseMonitoring(input: unknown, path: string): ReleaseMonitoringV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, MONITORING_KEYS, path);
  const startedAt = expectNullable(
    obj.startedAt,
    `${path}.startedAt`,
    expectTimestamp,
  );
  const samples = expectCountOf(obj.samples, `${path}.samples`);
  const continuous = expectBooleanOf(obj.continuous, `${path}.continuous`);
  const lastSampleAt = expectNullable(
    obj.lastSampleAt,
    `${path}.lastSampleAt`,
    expectTimestamp,
  );
  if (
    samples > 0 &&
    (lastSampleAt === null || startedAt === null || lastSampleAt < startedAt)
  ) {
    fail(
      `${path}.lastSampleAt`,
      "invalid_lifecycle",
      "sampled monitoring requires startedAt <= lastSampleAt",
    );
  }
  return { startedAt, samples, continuous, lastSampleAt };
}

function parseAcceptance(input: unknown, path: string): AcceptanceResultV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, ACCEPTANCE_KEYS, path);
  const identity = parseDeploymentIdentity(obj.identity, `${path}.identity`);
  const windowMs = expectPositiveInt(obj.windowMs, `${path}.windowMs`);
  const sampleIntervalMs = expectPositiveInt(
    obj.sampleIntervalMs,
    `${path}.sampleIntervalMs`,
  );
  const continuous = expectBooleanOf(obj.continuous, `${path}.continuous`);
  const baseline = expectArray(
    obj.baseline,
    `${path}.baseline`,
    MaxItems.metricsSamples,
    parseMetricsSample,
  );
  const samples = expectArray(
    obj.samples,
    `${path}.samples`,
    MaxItems.metricsSamples,
    parseMetricsSample,
  );
  const thresholdResults = expectThresholdResults(
    obj.thresholdResults,
    `${path}.thresholdResults`,
  );
  const passed = expectBooleanOf(obj.passed, `${path}.passed`);
  if (baseline.length < 1) {
    fail(path, "invalid_lifecycle", "acceptance requires baseline evidence");
  }
  if (samples.length < 1) {
    fail(
      path,
      "invalid_lifecycle",
      "acceptance requires at least one sample",
    );
  }
  return {
    identity,
    windowMs,
    sampleIntervalMs,
    continuous,
    baseline,
    samples,
    thresholdResults,
    passed,
  };
}

function expectThresholdResults(
  input: unknown,
  path: string,
): AcceptanceThresholdResultV1[] {
  if (!Array.isArray(input)) fail(path, "wrong_type", "expected array");
  if (input.length < 1 || input.length > MaxItems.thresholds) {
    fail(path, "bound_exceeded", "expected 1-8 threshold results");
  }
  return input.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const obj = expectRecord(item, itemPath);
    expectExactKeys(obj, THRESHOLD_KEYS, itemPath);
    const metric = expectEnum(
      obj.metric,
      ["five_xx_rate", "timeout_rate", "stream_failure_rate"],
      `${itemPath}.metric`,
    );
    const observedRate = expectNullableRate(
      obj.observedRate,
      `${itemPath}.observedRate`,
    );
    const baselineRate = expectNullableRate(
      obj.baselineRate,
      `${itemPath}.baselineRate`,
    );
    const maxRate = expectRateOf(obj.maxRate, `${itemPath}.maxRate`);
    const maxIncrease = expectRateOf(
      obj.maxIncrease,
      `${itemPath}.maxIncrease`,
    );
    const passed = expectBooleanOf(obj.passed, `${itemPath}.passed`);
    return {
      metric,
      observedRate,
      baselineRate,
      maxRate,
      maxIncrease,
      passed,
    };
  });
}

function parseReceipts(
  input: unknown,
  path: string,
): ReleaseRecordV1["receipts"] {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, RECEIPTS_KEYS, path);
  return {
    promote: expectNullable(obj.promote, `${path}.promote`, parseReceipt),
    rollback: expectNullable(obj.rollback, `${path}.rollback`, parseReceipt),
    error: expectNullable(obj.error, `${path}.error`, parseError),
  };
}

function parseReceipt(input: unknown, path: string): ReleaseReceiptV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, RECEIPT_KEYS, path);
  const action = expectEnum(
    obj.action,
    ["promote", "rollback"],
    `${path}.action`,
  );
  const ok = expectBooleanOf(obj.ok, `${path}.ok`);
  const statusCode = expectNullable(
    obj.statusCode,
    `${path}.statusCode`,
    expectStatusCode,
  );
  const observedIdentity = expectNullable(
    obj.observedIdentity,
    `${path}.observedIdentity`,
    parseDeploymentIdentity,
  );
  const observedDomain = expectNullableString(
    obj.observedDomain,
    `${path}.observedDomain`,
    MaxText.url,
  );
  const at = expectTimestamp(obj.at, `${path}.at`);
  const detail = expectNullableString(
    obj.detail,
    `${path}.detail`,
    MaxText.detail,
  );
  if (ok && statusCode === null && action === "promote") {
    fail(
      `${path}.statusCode`,
      "invalid_lifecycle",
      "ok promote receipt requires a status code",
    );
  }
  return {
    action,
    ok,
    statusCode,
    observedIdentity,
    observedDomain,
    at,
    detail,
  };
}

function parseError(input: unknown, path: string): ReleaseErrorV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, ERROR_KEYS, path);
  return {
    at: expectTimestamp(obj.at, `${path}.at`),
    kind: expectNonEmptyString(obj.kind, `${path}.kind`, MaxText.label),
    detail: expectNonEmptyString(obj.detail, `${path}.detail`, MaxText.detail),
    recovered: expectBooleanOf(obj.recovered, `${path}.recovered`),
  };
}

function expectBooleanOf(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    fail(
      path,
      "invalid_boolean",
      `expected boolean, got ${describeValue(value)}`,
    );
  }
  return value;
}

function expectCountOf(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(
      path,
      "invalid_count",
      `expected nonnegative safe integer, got ${describeValue(value)}`,
    );
  }
  return value;
}

function expectStatusCode(value: unknown, path: string): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 100 ||
    value > 599
  ) {
    fail(
      path,
      "invalid_value",
      `expected HTTP status code, got ${describeValue(value)}`,
    );
  }
  return value;
}

function expectRateOf(value: unknown, path: string): number {
  if (
    typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
    value > 1
  ) {
    fail(
      path,
      "invalid_value",
      `expected rate in [0,1], got ${describeValue(value)}`,
    );
  }
  return value;
}

function expectNullableRate(value: unknown, path: string): number | null {
  if (value === null) return null;
  return expectRateOf(value, path);
}
