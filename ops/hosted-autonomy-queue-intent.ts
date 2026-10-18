/** Strict queue codec over the unchanged, R80-readable merge intent fields. */
import { isGitSha } from "../src/contracts/brands.ts";
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../src/contracts/canonical.ts";
import type { ReviewReceiptV1 } from "../src/contracts/review-receipt.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import { parseIntent } from "../src/contracts/work-record-intent.ts";
import type {
  IncompleteOperationV1,
  WorkRecordV1,
} from "../src/contracts/work-record.ts";
import type { QueueBinding } from "../src/github/merge-queue-types.ts";

const PREFIX = "merge-queue:v1:";
const KEY =
  /^merge-queue:v1:([1-9][0-9]*):([0-9a-f]{40}):([0-9a-f]{64})(:a1)?(:d1)?$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_=-]{1,256}$/;
const STAGES = [
  "refused",
  "not_submitted",
  "ambiguous",
  "unavailable",
  "ejected_ci_failed",
  "ejected_timeout",
  "dequeue_ambiguous",
  "owner_park",
] as const;
export type QueueIntentStage =
  | typeof STAGES[number]
  | "unresolved"
  | "dequeue_pending";
export interface QueueIntentState {
  intent: IncompleteOperationV1;
  bindingDigest: string;
  stage: QueueIntentStage;
  refusals: number;
  queueFailures: number;
  admission: 0 | 1;
}

/**
 * A first-admission unavailable result proves that this intent never reached
 * the queue.  A re-entry or an earlier refusal carries durable queue history
 * and must stay in custody even when its latest result was unavailable.
 */
export function isDefinitelyNotSubmitted(state: QueueIntentState): boolean {
  return state.stage === "not_submitted" && state.admission === 0 &&
    state.refusals === 0 && state.queueFailures === 0 &&
    state.intent.requestId === null && state.intent.resultId === null;
}

/** Finite vocabulary: no raw text, arbitrary metadata, or embedded proof object. */
export const QUEUE_FAILURE_DETAILS: ReadonlyMap<string, {
  stage: typeof STAGES[number];
  refusals: number;
  queueFailures: number;
}> = new Map(
  STAGES.flatMap((stage) =>
    [0, 1, 2, 3].flatMap((refusals) =>
      [0, 1, 2].map((queueFailures) =>
        [
          `${stage}:r${refusals}:q${queueFailures}`,
          { stage, refusals, queueFailures },
        ] as const
      )
    )
  ),
);

export function parseQueueIntent(
  record: WorkRecordV1,
): QueueIntentState | null {
  const raw = record.intent;
  if (raw === null || raw.kind !== "merge" || !raw.key.startsWith(PREFIX)) {
    return null;
  }
  let intent: IncompleteOperationV1;
  try {
    intent = parseIntent(raw, "$queue");
  } catch {
    return null;
  }
  const key = KEY.exec(intent.key);
  if (
    key === null || record.repository.owner !== "ubiquity" ||
    record.repository.name !== "ai.ubq.fi" || !isGitSha(record.target.base) ||
    !isGitSha(record.target.head) || intent.pr !== record.target.pr ||
    String(intent.pr) !== key[1] || intent.expectedHead !== key[2] ||
    intent.expectedHead !== record.target.head ||
    intent.observedBase !== record.target.base ||
    intent.branch === null || intent.branch !== record.target.branch ||
    intent.selfMerge !== undefined ||
    (intent.requestId !== null && !UUID.test(intent.requestId)) ||
    (intent.resultId !== null && !ID.test(intent.resultId))
  ) return null;
  const failure = intent.failure;
  if (failure === undefined) {
    if (key[4] !== undefined) return null;
    return {
      intent,
      bindingDigest: key[3],
      stage: key[5] === undefined ? "unresolved" : "dequeue_pending",
      refusals: 0,
      queueFailures: 0,
      admission: 0,
    };
  }
  const detail = QUEUE_FAILURE_DETAILS.get(failure.detail);
  const admission = key[4] === undefined ? 0 : 1;
  if (
    failure.kind !== "merge_queue_v1" || detail === undefined ||
    (failure.atMs < intent.startedAt &&
      !(admission === 1 && detail.queueFailures >= 1)) ||
    (admission === 1 && detail.queueFailures < 1) ||
    (detail.stage === "refused" && detail.refusals < 1) ||
    (detail.stage.startsWith("ejected_") && detail.queueFailures < 1) ||
    failure.attempts < detail.refusals + detail.queueFailures
  ) return null;
  return {
    intent,
    bindingDigest: key[3],
    ...detail,
    stage: key[5] === undefined ? detail.stage : "dequeue_pending",
    admission,
  };
}

export function queueBindingDigest(
  record: WorkRecordV1,
  binding: QueueBinding,
): Promise<string> {
  return canonicalStringifySha256({
    domain: "sentinel.queue-intent.v1",
    workId: record.id,
    branch: record.target.branch,
    ...binding,
  });
}

export async function createQueueIntent(
  record: WorkRecordV1,
  binding: QueueBinding,
  now: number,
): Promise<IncompleteOperationV1> {
  if (
    record.intent !== null || record.target.pr !== binding.pullRequest ||
    record.target.head !== binding.head ||
    record.target.base !== binding.base ||
    record.target.branch === null ||
    canonicalStringify(record.repository) !==
      canonicalStringify(binding.repository)
  ) {
    throw new TypeError("queue intent binding refused");
  }
  return parseIntent({
    kind: "merge",
    key:
      `${PREFIX}${binding.pullRequest}:${binding.head}:${await queueBindingDigest(
        record,
        binding,
      )}`,
    startedAt: now,
    branch: record.target.branch,
    expectedHead: binding.head,
    observedBase: binding.base,
    pr: binding.pullRequest,
    requestId: null,
    resultId: null,
  }, "$queue");
}

/** Locate the exact immutable receipt whose identity was committed before effects. */
export async function queueIntentBinding(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
): Promise<
  | { binding: QueueBinding; receipt: ReviewReceiptV1; state: QueueIntentState }
  | null
> {
  const state = parseQueueIntent(record);
  if (state === null) return null;
  const matches: {
    binding: QueueBinding;
    receipt: ReviewReceiptV1;
    state: QueueIntentState;
  }[] = [];
  for (const receipt of snapshot.reviews) {
    if (
      receipt.repository.owner !== record.repository.owner ||
      receipt.repository.name !== record.repository.name ||
      receipt.repository.installationId !== record.repository.installationId ||
      receipt.pullRequest.number !== record.target.pr ||
      receipt.taskAcceptance?.verdict !== "fulfilled"
    ) continue;
    const binding: QueueBinding = {
      repository: record.repository,
      pullRequest: record.target.pr!,
      base: record.target.base,
      head: record.target.head!,
      reviewRequestId: receipt.requestId,
      reviewReceiptId: receipt.id,
      taskDigest: receipt.taskAcceptance.taskDigest,
    };
    if (await queueBindingDigest(record, binding) === state.bindingDigest) {
      matches.push({ binding, receipt, state });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

export function queueFailure(
  intent: IncompleteOperationV1,
  stage: typeof STAGES[number],
  refusals: number,
  queueFailures: number,
  now: number,
  failedExecution: boolean,
): IncompleteOperationV1 {
  const detail = `${stage}:r${refusals}:q${queueFailures}`;
  if (!QUEUE_FAILURE_DETAILS.has(detail)) {
    throw new TypeError("queue failure bucket refused");
  }
  const attempts = (intent.failure?.attempts ?? 0) + Number(failedExecution);
  if (attempts < 1) {
    throw new TypeError("queue failure requires an observed failed execution");
  }
  return parseIntent({
    ...intent,
    failure: {
      kind: "merge_queue_v1",
      detail,
      atMs: failedExecution ? now : intent.failure!.atMs,
      attempts,
    },
  }, "$queue");
}
