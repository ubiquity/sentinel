/** Pure custody and authorization decisions; all observations come from the coordinator. */
import { isGitSha } from "../src/contracts/brands.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import type {
  QueueBinding,
  QueueDriftReason,
  QueueMembership,
  QueuePolicyDecision,
  QueueRead,
} from "../src/github/merge-queue-types.ts";

export type QueueMode = "off" | "observe" | "on";
const MODES: readonly QueueMode[] = ["off", "observe", "on"];
export const QUEUE_DEFINITIVE_REFUSALS = 3;
export const QUEUE_ADMISSION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** The variable can only lower the reviewed code ceiling; invalid values disable. */
export function effectiveQueueMode(
  ceiling: QueueMode,
  variable: unknown,
): QueueMode {
  if (variable === undefined || variable === null || variable === "") {
    return ceiling;
  }
  const level = MODES.indexOf(variable as QueueMode);
  return level < 0 ? "off" : MODES[Math.min(MODES.indexOf(ceiling), level)];
}
function realGatewayPull(record: WorkRecordV1): boolean {
  return record.repository.owner === "ubiquity" &&
    record.repository.name === "ai.ubq.fi" &&
    Number.isSafeInteger(record.target.pr) && (record.target.pr ?? 0) > 0 &&
    isGitSha(record.target.head);
}
/** PR-less already-satisfied-at-base review uses the same wait and is excluded. */
export function isQueueHeld(record: WorkRecordV1): boolean {
  return realGatewayPull(record) && record.wait?.reason === "backoff" &&
    record.wait.until === null;
}
/** A namespace identifies custody only when its complete PR/head identity agrees. */
export function isQueueMarked(record: WorkRecordV1): boolean {
  const intent = record.intent;
  return realGatewayPull(record) && intent?.kind === "merge" &&
    intent.pr === record.target.pr &&
    intent.expectedHead === record.target.head &&
    intent.observedBase === record.target.base &&
    intent.key.startsWith(
      `merge-queue:v1:${record.target.pr}:${record.target.head}:`,
    ) &&
    /^merge-queue:v1:[1-9][0-9]*:[0-9a-f]{40}:[0-9a-f]{64}(?::a1)?(?::d1)?$/
      .test(
        intent.key,
      );
}
/** A damaged/stale queue intent still requires observation, never a legacy fallback. */
export function hasQueueIntentNamespace(record: WorkRecordV1): boolean {
  return record.repository.owner === "ubiquity" &&
    record.repository.name === "ai.ubq.fi" &&
    record.intent?.kind === "merge" &&
    (record.intent.key.startsWith("merge-queue:v1:") ||
      record.intent.failure?.kind === "merge_queue_v1");
}
/** Even a malformed durable queue namespace forbids legacy proof fallback. */
export function hasQueueDeliveryProvenance(record: WorkRecordV1): boolean {
  return record.evidence.some((evidence) =>
    evidence.ref.startsWith("artifact:review-receipt/merge-queue-v1")
  );
}
/** The immutable activation boundary survives a later enqueue kill switch. */
export function requiresStrictQueueProof(input: {
  proofActivated: boolean;
  record: WorkRecordV1;
  anyQueueEvidence: boolean;
}): boolean {
  return input.proofActivated || input.anyQueueEvidence ||
    isQueueHeld(input.record) || hasQueueIntentNamespace(input.record) ||
    hasQueueDeliveryProvenance(input.record);
}
/** True means a native queue read is mandatory; false is NOT an empty queue claim. */
export function queueCustodyRequired(input: {
  mode: QueueMode;
  effectiveQueueRule: boolean | null;
  records: readonly WorkRecordV1[];
}): boolean {
  return input.mode !== "off" || input.effectiveQueueRule !== false ||
    input.records.some((record) =>
      isQueueHeld(record) || hasQueueIntentNamespace(record) ||
      (record.nextStep !== "done" && hasQueueDeliveryProvenance(record))
    );
}

export interface QueueAuthorizationFacts {
  binding: QueueBinding;
  membership: QueueRead<QueueMembership>;
  /** True only from the existing trusted latest-receipt authorization gate. */
  reviewAuthorized: boolean | null;
  latestReceiptId: string | null;
  taskDigest: string | null;
  optedOut: boolean | null;
  headCiGreen: boolean | null;
  workflowAccepted: boolean | null;
  rulesAccepted: boolean | null;
  exactPatch: boolean | null;
  pathsDisjoint: boolean | null;
  tipEligible: boolean | null;
  /** Own persisted enqueue intent AND exact authenticated native enqueuer/entry. */
  ownsEntry: boolean;
  definitiveRefusals: number;
  /** Original intent start only while admission is unresolved; null after observed admission. */
  admissionStartedAt: number | null;
  now: number;
  admissionAmbiguous: boolean;
  reentry: boolean;
  failedQueueAdmissions: number;
}

/** Null authorization fields are incomplete evidence, never a refusal. */
export function hasCompleteQueueAuthorizationFacts(
  facts: QueueAuthorizationFacts,
): boolean {
  return facts.reviewAuthorized !== null && facts.latestReceiptId !== null &&
    facts.taskDigest !== null && facts.optedOut !== null &&
    facts.headCiGreen !== null && facts.workflowAccepted !== null &&
    facts.rulesAccepted !== null && facts.exactPatch !== null &&
    facts.pathsDisjoint !== null && facts.tipEligible !== null;
}

function sameBindingPull(
  facts: QueueAuthorizationFacts,
  membership: QueueMembership,
): boolean {
  const { binding } = facts;
  const { pull } = membership;
  return pull.repository.owner === binding.repository.owner &&
    pull.repository.name === binding.repository.name &&
    pull.repository.installationId === binding.repository.installationId &&
    pull.number === binding.pullRequest && pull.baseRef === "development";
}
function drift(
  facts: QueueAuthorizationFacts,
  membership: QueueMembership,
): QueueDriftReason | null {
  if (membership.pull.head !== facts.binding.head) return "head_changed";
  if (facts.optedOut === true) return "opted_out";
  if (
    facts.taskDigest !== null && facts.taskDigest !== facts.binding.taskDigest
  ) return "task_changed";
  if (
    facts.latestReceiptId !== null &&
    facts.latestReceiptId !== facts.binding.reviewReceiptId
  ) return "review_changed";
  if (facts.reviewAuthorized === false) return "blocking_review";
  if (facts.workflowAccepted === false) return "workflow_changed";
  if (facts.rulesAccepted === false) return "rules_changed";
  if (facts.pathsDisjoint === false) return "path_overlap";
  return null;
}

/** No effects, state writes, new review rounds or reservation refunds. */
export function decideQueuePolicy(
  facts: QueueAuthorizationFacts,
): QueuePolicyDecision {
  const hold = (): QueuePolicyDecision => ({
    action: "hold",
    reason: "proof_unavailable",
  });
  if (
    facts.binding.repository.owner !== "ubiquity" ||
    facts.binding.repository.name !== "ai.ubq.fi"
  ) return hold();
  if (facts.membership.status !== "complete") {
    return { action: "hold", reason: "queue_unavailable" };
  }
  const member = facts.membership.value;
  if (!sameBindingPull(facts, member) || member.mergedRevision !== null) {
    return hold();
  }
  const changed = drift(facts, member);
  if (changed !== null) {
    if (member.entry === null) return hold();
    return facts.ownsEntry
      ? { action: "dequeue_owned", entryId: member.entry.id, reason: changed }
      : { action: "owner_park", reason: "foreign_entry_drift" };
  }
  if (member.entry !== null) {
    return {
      action: "hold",
      reason: facts.ownsEntry ? "queued" : "foreign_entry",
    };
  }
  if (
    !Number.isSafeInteger(facts.now) ||
    !Number.isSafeInteger(facts.definitiveRefusals) ||
    facts.definitiveRefusals < 0 ||
    !Number.isSafeInteger(facts.failedQueueAdmissions) ||
    facts.failedQueueAdmissions < 0
  ) return hold();
  if (facts.definitiveRefusals >= QUEUE_DEFINITIVE_REFUSALS) {
    return { action: "owner_park", reason: "refusals_exhausted" };
  }
  if (
    facts.admissionStartedAt !== null &&
    (!Number.isSafeInteger(facts.admissionStartedAt) ||
      facts.admissionStartedAt > facts.now)
  ) return hold();
  if (
    facts.admissionStartedAt !== null &&
    facts.now - facts.admissionStartedAt >= QUEUE_ADMISSION_MAX_AGE_MS
  ) {
    return { action: "owner_park", reason: "admission_unresolved" };
  }
  if (facts.admissionAmbiguous) {
    return { action: "hold", reason: "ambiguous_admission" };
  }
  if (facts.reentry && facts.failedQueueAdmissions >= 2) {
    return { action: "owner_park", reason: "repeated_queue_failure" };
  }
  if (
    facts.taskDigest !== facts.binding.taskDigest ||
    facts.latestReceiptId !== facts.binding.reviewReceiptId ||
    facts.reviewAuthorized !== true || facts.optedOut !== false ||
    facts.headCiGreen !== true ||
    facts.workflowAccepted !== true || facts.rulesAccepted !== true ||
    facts.exactPatch !== true ||
    facts.pathsDisjoint !== true || facts.tipEligible !== true
  ) return hold();
  return {
    action: facts.reentry ? "reenter" : "enqueue",
    binding: facts.binding,
  };
}
