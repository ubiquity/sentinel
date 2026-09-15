/**
 * WorkRecordV1: the durable per-work-item record owned by the repair state.
 * Source identity, controller SHA and the original failing revision are
 * immutable; target/checkpoint/head/PR and the lifecycle fields move forward.
 * Waiting is a reason on a next step, never a second conflicting lifecycle.
 */

import {
  asIncidentFingerprint,
  asSourceSnapshotDigest,
  asWorkItemId,
  isGitSha,
} from "./brands.ts";
import type {
  GitSha,
  IncidentFingerprint,
  SourceSnapshotDigest,
  WorkItemId,
} from "./brands.ts";
import {
  parseEvidenceRefs,
  parseRepositoryIdentity,
  parseSeverity,
} from "./shared.ts";
import type {
  EvidenceRefV1,
  RepositoryIdentityV1,
  SeverityV1,
} from "./shared.ts";
import {
  expectArray,
  expectBoolean,
  expectCount,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectNullableString,
  expectPattern,
  expectPositiveInt,
  expectRecord,
  expectSha256Hex,
  expectTimestamp,
  expectVersion,
  fail,
  MaxItems,
  MaxText,
} from "./validation.ts";

export type NextStepV1 = "work" | "review" | "delivery" | "blocked" | "done";
export type WorkWaitReasonV1 =
  | "budget_cap"
  | "review_pending"
  | "backoff"
  | "unavailable"
  | "manual";
export type BlockerKindV1 =
  | "stale_source"
  | "missing_evidence"
  | "evidence_expired"
  | "dependency"
  | "review_quota"
  | "unavailable"
  | "other";
export type IncompleteOpKindV1 =
  | "pull_request"
  | "review_request"
  | "merge"
  | "issue_closure"
  | "push"
  | "implementation"
  | "replay"
  | "base_refresh"
  | "candidate_preservation";
export type TaskSourceKindV1 = "issue" | "incident" | "review_backlog";

export interface WorkWaitV1 {
  reason: WorkWaitReasonV1;
  since: number;
  /** Timestamp the wait ends (next retry/review arrival); null when unknown. */
  until: number | null;
}

export interface WorkBlockerV1 {
  kind: BlockerKindV1;
  message: string;
  since: number;
}

/**
 * Typed exact identity of an incomplete external operation. Recovery after a
 * push/review/merge needs the exact head, observed base, deterministic branch,
 * PR number and the external request/result identities — never a free-text
 * detail or model-supplied JSON. `pr`/`requestId`/`resultId` stay null until
 * the object exists; the key remains the deterministic idempotency key.
 *
 * `base_refresh` reuses these fields: `expectedHead` is the old candidate,
 * `observedBase` the newly observed configured base and `resultId` the exact
 * deterministic prepared commit once generated (null before preparation). It
 * has no external request id, and `target` stays on the old base/head until the
 * prepared commit was actually published.
 */
export interface IncompleteOperationV1 {
  kind: IncompleteOpKindV1;
  /** Deterministic idempotency key for the persisted-before-effects intent. */
  key: string;
  startedAt: number;
  /** Deterministic branch the operation uses; null when not branch-scoped. */
  branch: string | null;
  /** Exact head expected/pushed; null when not applicable. */
  expectedHead: GitSha | null;
  /** Base observed before starting; null when not applicable. */
  observedBase: GitSha | null;
  /** PR number; null before creation or for non-PR operations. */
  pr: number | null;
  /** External request id (e.g. review request); null before it exists. */
  requestId: string | null;
  /** External result id (e.g. review result, merge SHA); null before result. */
  resultId: string | null;
}

/** Explicit selection urgency attached to a work item at intake. */
export interface SelectionUrgencyV1 {
  /** Active production incident feeding this work item. */
  activeProduction: boolean;
  /** Reproducible unresolved 5xx group. */
  reproducible5xx: boolean;
  /** Known severe security/data-loss work. */
  severeSecurityOrDataLoss: boolean;
}

/**
 * V1 candidate-preservation binding for one produced Git candidate. Written
 * only by the trusted future candidate-preservation writer; this reader never
 * produces it. `operationKey` is the producing operation key (the existing
 * bounded intent-key identity), and `ref` is the exact preservation ref.
 */
export interface CandidatePreservationV1 {
  operationKey: string;
  base: GitSha;
  head: GitSha;
  ref: string;
}

/**
 * V1 candidate state attached to a work target. `preserved: null` means the
 * record is parked before/without a preserved candidate and is NOT evidence
 * that any candidate is durable. Absence of the whole group is the exact
 * legacy shape and is never defaulted when parsing.
 */
export interface CandidateStateV1 {
  preserved: CandidatePreservationV1 | null;
  publishedHead: GitSha | null;
}

export interface WorkTargetV1 {
  /** Target base validated at the last action. */
  base: GitSha;
  /** Checkpoint branch name; null when no checkpoint branch exists. */
  branch: string | null;
  checkpoint: { branch: string; sha: GitSha } | null;
  /** Candidate head; null until a candidate is produced. */
  head: GitSha | null;
  /** PR number; null until published. */
  pr: number | null;
  /**
   * Optional V1 candidate state. Absent on every legacy record; present only
   * for records the candidate-preservation writer owns. Never injected.
   */
  candidateState?: CandidateStateV1;
}

export interface WorkCountersV1 {
  /** Total candidate invocations (work actions actually run). */
  attempts: number;
  /** Automatic retries of failed work; observation never increments either. */
  retries: number;
  /** Codex review rounds used on this work item. */
  reviewRounds: number;
}

export interface WorkRecordV1 {
  version: "v1";
  kind: "work";
  /** Repository this work item belongs to (stable source identity). */
  repository: RepositoryIdentityV1;
  id: WorkItemId;
  /** Immutable source identity: kind plus the exact captured revision. */
  source: { kind: TaskSourceKindV1; id: string; revision: string };
  related: { incidentId: string | null; issueNumber: number | null };
  /** Stable incident fingerprint for incident tasks; null otherwise. */
  fingerprint: IncidentFingerprint | null;
  /** Original failing target revision; immutable, never rewritten on resume. */
  failingRevision: GitSha | null;
  /** Digest of the captured source snapshot (provenance), if captured. */
  sourceSnapshotDigest: SourceSnapshotDigest | null;
  classification: { severity: SeverityV1; priority: number | null };
  /** Explicit selection urgency; no module-owned side map is required. */
  urgency: SelectionUrgencyV1;
  /** Other work items that must complete first (bounded, exact ids). */
  dependencies: WorkItemId[];
  /** Sentinel controller commit that owns this record; immutable. */
  controller: { sha: GitSha };
  target: WorkTargetV1;
  nextStep: NextStepV1;
  wait: WorkWaitV1 | null;
  blocker: WorkBlockerV1 | null;
  counters: WorkCountersV1;
  evidence: EvidenceRefV1[];
  intent: IncompleteOperationV1 | null;
  /** Source first seen (incident) / issue creation; null when unknown. */
  firstSeenAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * True when a record carries V1 candidate state: either a candidateState group
 * on the target or a candidate_preservation intent. This is the ONLY parking
 * predicate old readers may use. `preserved: null` is parked work, not missing
 * state, so the descriptor value itself is deliberately never inspected.
 */
export function hasCandidateState(record: WorkRecordV1): boolean {
  return record.target.candidateState !== undefined ||
    (record.intent !== null && record.intent.kind === "candidate_preservation");
}

const KEYS = [
  "version",
  "kind",
  "repository",
  "id",
  "source",
  "related",
  "fingerprint",
  "failingRevision",
  "sourceSnapshotDigest",
  "classification",
  "urgency",
  "dependencies",
  "controller",
  "target",
  "nextStep",
  "wait",
  "blocker",
  "counters",
  "evidence",
  "intent",
  "firstSeenAt",
  "createdAt",
  "updatedAt",
] as const;
const SOURCE_KEYS = ["kind", "id", "revision"] as const;
const RELATED_KEYS = ["incidentId", "issueNumber"] as const;
const CLASSIFICATION_KEYS = ["severity", "priority"] as const;
const URGENCY_KEYS = [
  "activeProduction",
  "reproducible5xx",
  "severeSecurityOrDataLoss",
] as const;
const CONTROLLER_KEYS = ["sha"] as const;
const TARGET_KEYS = ["base", "branch", "checkpoint", "head", "pr"] as const;
const TARGET_CANDIDATE_KEYS = [...TARGET_KEYS, "candidateState"] as const;
const CANDIDATE_STATE_KEYS = ["preserved", "publishedHead"] as const;
const CANDIDATE_PRESERVATION_KEYS = [
  "operationKey",
  "base",
  "head",
  "ref",
] as const;
/** Exact preservation ref identity: one 64-hex digest ref body, no variants. */
const PRESERVATION_REF_PATTERN =
  /^refs\/heads\/sentinel-candidates\/[0-9a-f]{64}$/;
/** A producing reservation id is the trusted derived 64-hex SHA-256 id. */
const CANDIDATE_PRESERVATION_KEY_PATTERN = /^impl:[0-9a-f]{64}$/;
const CHECKPOINT_KEYS = ["branch", "sha"] as const;
const WAIT_KEYS = ["reason", "since", "until"] as const;
const BLOCKER_KEYS = ["kind", "message", "since"] as const;
const COUNTERS_KEYS = ["attempts", "retries", "reviewRounds"] as const;
const INTENT_KEYS = [
  "kind",
  "key",
  "startedAt",
  "branch",
  "expectedHead",
  "observedBase",
  "pr",
  "requestId",
  "resultId",
] as const;

export function parseWorkRecordV1(input: unknown): WorkRecordV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, ["work"], "$.kind");

  const repository = parseRepositoryIdentity(obj.repository, "$.repository");

  const id = asWorkItemId(
    expectPattern(
      obj.id,
      "$.id",
      /^[A-Za-z0-9._:-]{1,256}$/,
      "invalid_pattern",
      "expected deterministic work item id",
      MaxText.recordId,
    ),
  );

  const sourceObj = expectRecord(obj.source, "$.source");
  expectExactKeys(sourceObj, SOURCE_KEYS, "$.source");
  const sourceKind = expectEnum(
    sourceObj.kind,
    ["issue", "incident", "review_backlog"],
    "$.source.kind",
  );
  const sourceId = expectNonEmptyString(
    sourceObj.id,
    "$.source.id",
    MaxText.recordId,
  );
  const sourceRevision = expectNonEmptyString(
    sourceObj.revision,
    "$.source.revision",
    MaxText.recordId,
  );

  const relatedObj = expectRecord(obj.related, "$.related");
  expectExactKeys(relatedObj, RELATED_KEYS, "$.related");
  const incidentId = expectNullableString(
    relatedObj.incidentId,
    "$.related.incidentId",
    MaxText.recordId,
  );
  const issueNumber = expectNullable(
    relatedObj.issueNumber,
    "$.related.issueNumber",
    expectPositiveInt,
  );

  const fingerprint = expectNullable(
    obj.fingerprint,
    "$.fingerprint",
    (v, p) => asIncidentFingerprint(expectSha256Hex(v, p)),
  );
  const failingRevision = expectNullable(
    obj.failingRevision,
    "$.failingRevision",
    expectGitSha,
  );
  const sourceSnapshotDigest = expectNullable(
    obj.sourceSnapshotDigest,
    "$.sourceSnapshotDigest",
    (v, p) => asSourceSnapshotDigest(expectSha256Hex(v, p)),
  );

  const classificationObj = expectRecord(
    obj.classification,
    "$.classification",
  );
  expectExactKeys(classificationObj, CLASSIFICATION_KEYS, "$.classification");
  const classification = {
    severity: parseSeverity(
      classificationObj.severity,
      "$.classification.severity",
    ),
    priority: expectNullable(
      classificationObj.priority,
      "$.classification.priority",
      expectPriority,
    ),
  };

  const urgencyObj = expectRecord(obj.urgency, "$.urgency");
  expectExactKeys(urgencyObj, URGENCY_KEYS, "$.urgency");
  const urgency: SelectionUrgencyV1 = {
    activeProduction: expectBoolean(
      urgencyObj.activeProduction,
      "$.urgency.activeProduction",
    ),
    reproducible5xx: expectBoolean(
      urgencyObj.reproducible5xx,
      "$.urgency.reproducible5xx",
    ),
    severeSecurityOrDataLoss: expectBoolean(
      urgencyObj.severeSecurityOrDataLoss,
      "$.urgency.severeSecurityOrDataLoss",
    ),
  };

  const dependencies = parseDependencies(obj.dependencies, "$.dependencies");

  const controllerObj = expectRecord(obj.controller, "$.controller");
  expectExactKeys(controllerObj, CONTROLLER_KEYS, "$.controller");
  const controller = {
    sha: expectGitSha(controllerObj.sha, "$.controller.sha"),
  };

  const target = parseTarget(obj.target, "$.target");

  const nextStep = expectEnum(
    obj.nextStep,
    ["work", "review", "delivery", "blocked", "done"],
    "$.nextStep",
  );

  const wait = expectNullable(obj.wait, "$.wait", parseWait);
  const blocker = expectNullable(obj.blocker, "$.blocker", parseBlocker);
  const counters = parseCounters(obj.counters, "$.counters");
  const evidence = parseEvidenceRefs(obj.evidence, "$.evidence");
  const intent = expectNullable(obj.intent, "$.intent", parseIntent);

  const firstSeenAt = expectNullable(
    obj.firstSeenAt,
    "$.firstSeenAt",
    expectTimestamp,
  );
  const createdAt = expectTimestamp(obj.createdAt, "$.createdAt");
  const updatedAt = expectTimestamp(obj.updatedAt, "$.updatedAt");

  // Fail-closed lifecycle checks.
  if (createdAt > updatedAt) {
    fail(
      "$.createdAt",
      "invalid_lifecycle",
      "createdAt cannot be after updatedAt",
    );
  }
  if (firstSeenAt !== null && firstSeenAt > updatedAt) {
    fail(
      "$.firstSeenAt",
      "invalid_lifecycle",
      "firstSeenAt cannot be after updatedAt",
    );
  }
  if (counters.retries > counters.attempts) {
    fail(
      "$.counters.retries",
      "invalid_lifecycle",
      "retries cannot exceed attempts",
    );
  }
  if (nextStep === "blocked" && blocker === null) {
    fail(
      "$.blocker",
      "invalid_lifecycle",
      'nextStep "blocked" requires a blocker',
    );
  }
  if (nextStep !== "blocked" && blocker !== null) {
    fail(
      "$.blocker",
      "invalid_lifecycle",
      'blocker present only while nextStep is "blocked"',
    );
  }
  if (nextStep === "done") {
    if (intent !== null) {
      fail(
        "$.intent",
        "invalid_lifecycle",
        'nextStep "done" cannot have an open operation intent',
      );
    }
    if (wait !== null) {
      fail("$.wait", "invalid_lifecycle", 'nextStep "done" cannot be waiting');
    }
  }
  if (target.pr !== null && target.head === null) {
    fail(
      "$.target.pr",
      "invalid_lifecycle",
      "a published PR requires a target head",
    );
  }
  if (sourceKind === "incident" && fingerprint === null) {
    fail(
      "$.fingerprint",
      "invalid_lifecycle",
      "incident tasks require a fingerprint",
    );
  }
  if (sourceKind === "issue" && issueNumber === null) {
    fail(
      "$.related.issueNumber",
      "invalid_lifecycle",
      "issue tasks require an issue number",
    );
  }
  // A candidate-preservation intent is only coherent while the record is
  // parked with no preserved descriptor yet, and its expected head/observed
  // base bind exactly to the target it was persisted for. The intent branch is
  // the preservation ref, never target.branch, so it is not compared here.
  if (intent !== null && intent.kind === "candidate_preservation") {
    const candidateState = target.candidateState;
    if (candidateState === undefined) {
      fail(
        "$.target.candidateState",
        "invalid_lifecycle",
        "candidate_preservation requires candidateState",
      );
    }
    if (candidateState.preserved !== null) {
      fail(
        "$.target.candidateState.preserved",
        "invalid_lifecycle",
        "candidate_preservation requires preserved:null",
      );
    }
    if (intent.expectedHead !== target.head) {
      fail(
        "$.intent.expectedHead",
        "invalid_lifecycle",
        "candidate_preservation expectedHead must equal target.head",
      );
    }
    if (intent.observedBase !== target.base) {
      fail(
        "$.intent.observedBase",
        "invalid_lifecycle",
        "candidate_preservation observedBase must equal target.base",
      );
    }
  }

  return {
    version: "v1",
    kind: "work",
    repository,
    id,
    source: { kind: sourceKind, id: sourceId, revision: sourceRevision },
    related: { incidentId, issueNumber },
    fingerprint,
    failingRevision,
    sourceSnapshotDigest,
    classification,
    urgency,
    dependencies,
    controller,
    target,
    nextStep,
    wait,
    blocker,
    counters,
    evidence,
    intent,
    firstSeenAt,
    createdAt,
    updatedAt,
  };
}

/** Issue priority labels are ordered numbers; missing priority is explicit null. */
function expectPriority(value: unknown, path: string): number {
  return expectPositiveInt(value, path);
}

function parseTarget(input: unknown, path: string): WorkTargetV1 {
  const obj = expectRecord(input, path);
  // Absence of `candidateState` is the exact legacy shape. A present key (even
  // `undefined`, which expectExactKeys treats as missing) is the new shape and
  // must carry a complete, exact group — a default is never injected.
  const hasCandidateStateKey = Object.prototype.hasOwnProperty.call(
    obj,
    "candidateState",
  );
  expectExactKeys(
    obj,
    hasCandidateStateKey ? TARGET_CANDIDATE_KEYS : TARGET_KEYS,
    path,
  );
  const base = expectGitSha(obj.base, `${path}.base`);
  const branch = expectNullableString(
    obj.branch,
    `${path}.branch`,
    MaxText.branch,
  );
  const checkpoint = expectNullable(
    obj.checkpoint,
    `${path}.checkpoint`,
    parseCheckpoint,
  );
  const head = expectNullable(obj.head, `${path}.head`, expectGitSha);
  const pr = expectNullable(obj.pr, `${path}.pr`, expectPositiveInt);
  if (!hasCandidateStateKey) return { base, branch, checkpoint, head, pr };
  return {
    base,
    branch,
    checkpoint,
    head,
    pr,
    candidateState: parseCandidateState(
      obj.candidateState,
      `${path}.candidateState`,
      { base, branch, head },
    ),
  };
}

function parseCandidateState(
  input: unknown,
  path: string,
  target: { base: GitSha; branch: string | null; head: GitSha | null },
): CandidateStateV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, CANDIDATE_STATE_KEYS, path);
  if (target.branch === null) {
    fail(
      path,
      "invalid_lifecycle",
      "candidateState requires a nonnull target branch",
    );
  }
  const preserved = expectNullable(
    obj.preserved,
    `${path}.preserved`,
    (value, preservedPath) =>
      parseCandidatePreservation(value, preservedPath, target),
  );
  const publishedHead = expectNullable(
    obj.publishedHead,
    `${path}.publishedHead`,
    expectGitSha,
  );
  // A null candidate head cannot carry preservation evidence or a published
  // head: both would claim an exact SHA the target does not hold.
  if (target.head === null && (preserved !== null || publishedHead !== null)) {
    fail(
      path,
      "invalid_lifecycle",
      "a null target head requires null preserved and publishedHead",
    );
  }
  return { preserved, publishedHead };
}

function parseCandidatePreservation(
  input: unknown,
  path: string,
  target: { base: GitSha; head: GitSha | null },
): CandidatePreservationV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, CANDIDATE_PRESERVATION_KEYS, path);
  const operationKey = expectNonEmptyString(
    obj.operationKey,
    `${path}.operationKey`,
    MaxText.token,
  );
  const base = expectGitSha(obj.base, `${path}.base`);
  const head = expectGitSha(obj.head, `${path}.head`);
  const ref = expectPattern(
    obj.ref,
    `${path}.ref`,
    PRESERVATION_REF_PATTERN,
    "invalid_pattern",
    "expected refs/heads/sentinel-candidates/<64-hex>",
    MaxText.ref,
  );
  // The descriptor must describe THIS target: a preserved candidate bound to
  // another base/head is corrupted state, never silently rebound.
  if (base !== target.base || head !== target.head) {
    fail(
      path,
      "invalid_lifecycle",
      "preserved candidate base/head must equal target base/head",
    );
  }
  return { operationKey, base, head, ref };
}

function parseCheckpoint(
  input: unknown,
  path: string,
): { branch: string; sha: GitSha } {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, CHECKPOINT_KEYS, path);
  return {
    branch: expectNonEmptyString(obj.branch, `${path}.branch`, MaxText.branch),
    sha: expectGitSha(obj.sha, `${path}.sha`),
  };
}

function parseWait(input: unknown, path: string): WorkWaitV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, WAIT_KEYS, path);
  const reason = expectEnum(
    obj.reason,
    ["budget_cap", "review_pending", "backoff", "unavailable", "manual"],
    `${path}.reason`,
  );
  const since = expectTimestamp(obj.since, `${path}.since`);
  const until = expectNullable(obj.until, `${path}.until`, expectTimestamp);
  if (until !== null && until < since) {
    fail(
      `${path}.until`,
      "invalid_lifecycle",
      "wait until cannot precede since",
    );
  }
  return { reason, since, until };
}

function parseBlocker(input: unknown, path: string): WorkBlockerV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, BLOCKER_KEYS, path);
  return {
    kind: expectEnum(
      obj.kind,
      [
        "stale_source",
        "missing_evidence",
        "evidence_expired",
        "dependency",
        "review_quota",
        "unavailable",
        "other",
      ],
      `${path}.kind`,
    ),
    message: expectNonEmptyString(
      obj.message,
      `${path}.message`,
      MaxText.message,
    ),
    since: expectTimestamp(obj.since, `${path}.since`),
  };
}

function parseCounters(input: unknown, path: string): WorkCountersV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, COUNTERS_KEYS, path);
  return {
    attempts: expectCount(obj.attempts, `${path}.attempts`),
    retries: expectCount(obj.retries, `${path}.retries`),
    reviewRounds: expectCount(obj.reviewRounds, `${path}.reviewRounds`),
  };
}

function parseIntent(input: unknown, path: string): IncompleteOperationV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, INTENT_KEYS, path);
  const kind = expectEnum(
    obj.kind,
    [
      "pull_request",
      "review_request",
      "merge",
      "issue_closure",
      "push",
      "implementation",
      "replay",
      "base_refresh",
      "candidate_preservation",
    ],
    `${path}.kind`,
  );
  const expectedHead = expectNullable(
    obj.expectedHead,
    `${path}.expectedHead`,
    expectGitSha,
  );
  const observedBase = expectNullable(
    obj.observedBase,
    `${path}.observedBase`,
    expectGitSha,
  );
  const pr = expectNullable(obj.pr, `${path}.pr`, expectPositiveInt);
  const branch = expectNullableString(
    obj.branch,
    `${path}.branch`,
    MaxText.branch,
  );
  const requestId = expectNullableString(
    obj.requestId,
    `${path}.requestId`,
    MaxText.recordId,
  );
  const resultId = expectNullableString(
    obj.resultId,
    `${path}.resultId`,
    MaxText.recordId,
  );
  const startedAt = expectTimestamp(obj.startedAt, `${path}.startedAt`);
  const key = expectNonEmptyString(obj.key, `${path}.key`, MaxText.token);

  // Fail-closed exact-identity rules per operation kind.
  if (kind === "pull_request" || kind === "push") {
    if (expectedHead === null) {
      fail(
        `${path}.expectedHead`,
        "invalid_lifecycle",
        "push/PR intent requires an expected head",
      );
    }
    if (branch === null) {
      fail(
        `${path}.branch`,
        "invalid_lifecycle",
        "push/PR intent requires a deterministic branch",
      );
    }
    if (kind === "push" && pr !== null) {
      fail(
        `${path}.pr`,
        "invalid_lifecycle",
        "push intent has no PR before creation",
      );
    }
    if (kind === "push" && (requestId !== null || resultId !== null)) {
      fail(
        `${path}.requestId`,
        "invalid_lifecycle",
        "push intent has no external request/result identity",
      );
    }
  }
  if (kind === "review_request" || kind === "merge") {
    if (pr === null) {
      fail(
        `${path}.pr`,
        "invalid_lifecycle",
        "review/merge intent requires a PR number",
      );
    }
    if (expectedHead === null) {
      fail(
        `${path}.expectedHead`,
        "invalid_lifecycle",
        "review/merge intent requires the expected head",
      );
    }
  }
  if (kind === "review_request" && branch === null) {
    fail(
      `${path}.branch`,
      "invalid_lifecycle",
      "review_request intent requires a deterministic branch",
    );
  }
  if (kind === "base_refresh") {
    // Exact old candidate/new base binding plus the exact PR and branch; the
    // prepared commit result id is a Git SHA once it exists, never free text.
    if (branch === null) {
      fail(
        `${path}.branch`,
        "invalid_lifecycle",
        "base_refresh intent requires a deterministic branch",
      );
    }
    if (expectedHead === null) {
      fail(
        `${path}.expectedHead`,
        "invalid_lifecycle",
        "base_refresh intent requires the old candidate head",
      );
    }
    if (observedBase === null) {
      fail(
        `${path}.observedBase`,
        "invalid_lifecycle",
        "base_refresh intent requires the observed new base",
      );
    }
    if (pr === null) {
      fail(
        `${path}.pr`,
        "invalid_lifecycle",
        "base_refresh intent requires a PR number",
      );
    }
    if (requestId !== null) {
      fail(
        `${path}.requestId`,
        "invalid_lifecycle",
        "base_refresh intent has no external request id",
      );
    }
    if (resultId !== null && !isGitSha(resultId)) {
      fail(
        `${path}.resultId`,
        "invalid_lifecycle",
        "base_refresh result id must be an exact git SHA",
      );
    }
  }
  if (kind === "candidate_preservation") {
    // Shape only: this reader never derives the preservation ref or writes it.
    // The key binds one producing reservation (`impl:<requestId>`), `branch`
    // is the full preservation ref (NOT target.branch), and the base/head are
    // exact nonnull SHAs; there is no PR or external result identity.
    if (!CANDIDATE_PRESERVATION_KEY_PATTERN.test(key)) {
      fail(
        `${path}.key`,
        "invalid_lifecycle",
        "candidate_preservation key must be impl:<producing reservation id>",
      );
    }
    if (requestId === null || key !== `impl:${requestId}`) {
      fail(
        `${path}.requestId`,
        "invalid_lifecycle",
        "candidate_preservation requestId must be the producing reservation id",
      );
    }
    if (branch === null || !PRESERVATION_REF_PATTERN.test(branch)) {
      fail(
        `${path}.branch`,
        "invalid_lifecycle",
        "candidate_preservation branch must be the exact preservation ref",
      );
    }
    if (expectedHead === null) {
      fail(
        `${path}.expectedHead`,
        "invalid_lifecycle",
        "candidate_preservation requires the expected candidate head",
      );
    }
    if (observedBase === null) {
      fail(
        `${path}.observedBase`,
        "invalid_lifecycle",
        "candidate_preservation requires the observed base",
      );
    }
    if (pr !== null) {
      fail(
        `${path}.pr`,
        "invalid_lifecycle",
        "candidate_preservation has no PR",
      );
    }
    if (resultId !== null) {
      fail(
        `${path}.resultId`,
        "invalid_lifecycle",
        "candidate_preservation has no external result id",
      );
    }
  }
  return {
    kind,
    key,
    startedAt,
    branch,
    expectedHead,
    observedBase,
    pr,
    requestId,
    resultId,
  };
}

function parseDependencies(input: unknown, path: string): WorkItemId[] {
  return expectArray(
    input,
    path,
    MaxItems.dependencies,
    (item, itemPath) =>
      asWorkItemId(
        expectPattern(
          item,
          itemPath,
          /^[A-Za-z0-9._:-]{1,256}$/,
          "invalid_pattern",
          "expected deterministic work item id",
          MaxText.recordId,
        ),
      ),
  );
}
