import { isVerifiedDeliveryProof } from "../../ops/hosted-autonomy-queue-proof.ts";
import { CHECK_POLL_MS } from "./loop-bounds.ts";
import { hasQueueDeliveryProvenance } from "../github/queue-delivery-provenance.ts";
import { hasQueueIntentNamespace } from "../../ops/hosted-autonomy-queue-policy.ts";
/** Final queue guards preserve original intent, candidate identity and charged accounting. */
import { canonicalStringify } from "../contracts/canonical.ts";
import type {
  NativeDeliveryDecision,
  QueueGuardReason,
} from "../github/native-queue-guard.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import {
  isNativeQueueTarget,
  type NativeQueueOperation,
} from "../github/native-queue-guard.ts";
import { releaseRequestMatchesDelivery } from "./loop-records.ts";
import { persistTransition } from "./loop-state.ts";
import { releaseRequestReceipt } from "./loop-task-context.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";

function queueGuardReasonIsTransient(reason: QueueGuardReason): boolean {
  switch (reason) {
    case "capability_missing":
    case "rule_unavailable":
    case "observation_unavailable":
    case "inactive_observation_unavailable":
      return true;
    case "custody":
    case "member":
    case "identity_drift":
    case "merged_head":
    case "queue_required":
      return false;
  }
}

export async function holdQueueRecord(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  transient = false,
): Promise<StepResultV1> {
  record = context.snapshot.work.find((row) => row.id === record.id) ?? record;
  if (record.wait?.reason === "backoff" && record.wait.until === null) {
    return { kind: "deferred", detail: "native merge queue custody hold" };
  }
  transient &&= !hasQueueIntentNamespace(record) &&
    !hasQueueDeliveryProvenance(record);
  const now = deps.clock.now();
  if (
    transient && record.wait?.reason === "unavailable" &&
    record.wait.until !== null && record.wait.until > now
  ) {
    return {
      kind: "deferred",
      detail: "native merge queue rule observation unavailable",
    };
  }
  // Bypass fairness counters: observing external custody is not a failed execution.
  const held = await persistTransition(deps, context, (draft) => {
    const index = draft.work.findIndex((row) => row.id === record.id);
    if (index < 0) throw new Error("queue hold work identity missing");
    draft.work[index] = {
      ...record,
      wait: transient
        ? {
          reason: "unavailable",
          since: record.wait?.reason === "unavailable"
            ? record.wait.since
            : now,
          until: now + CHECK_POLL_MS,
        }
        : { reason: "backoff", since: now, until: null },
      updatedAt: now,
    };
  });
  // Keep the existing loop progress semantics. This private result marker is
  // attached only after the state write and cannot enter JSON/stdout carriers.
  return held.kind === "progress"
    ? Object.defineProperty(held, "queueHold", { value: true })
    : held;
}
export async function guardQueueOperation(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  operation: NativeQueueOperation,
  expectedHead?: GitSha | null,
): Promise<StepResultV1 | null> {
  record = context.snapshot.work.find((row) => row.id === record.id) ?? record;
  if (!isNativeQueueTarget(record.repository)) return null;
  // Exact base-only review has no pull request and must not become queue custody.
  if (
    record.target.pr === null && record.target.branch === null &&
    operation === "resume"
  ) return null;
  if (
    operation === "resume" &&
    context.snapshot.releaseRequests.some((request) =>
      releaseRequestMatchesDelivery(request, record)
    )
  ) return await guardQueueDelivery(deps, context, record);
  const guard = deps.github.nativeQueue;
  if (guard === undefined) {
    return await holdQueueRecord(deps, context, record, true);
  }
  const result = await guard.inspect({
    record,
    operation,
    expectedHead,
    deadline: context.bounds.runDeadline,
  });
  return result.status === "allow" ? null : await holdQueueRecord(
    deps,
    context,
    record,
    queueGuardReasonIsTransient(result.reason),
  );
}
export async function guardQueueDelivery(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  receipt?: ReviewReceiptV1 | null,
  revision?: GitSha,
  acceptProof?: (
    proof: Extract<
      NativeDeliveryDecision,
      { status: "verified" | "legacy_direct" }
    >,
  ) => boolean,
): Promise<StepResultV1 | null> {
  record = context.snapshot.work.find((row) => row.id === record.id) ?? record;
  if (!isNativeQueueTarget(record.repository) || record.target.pr === null) {
    return null;
  }
  const request = context.snapshot.releaseRequests.find((row) =>
    releaseRequestMatchesDelivery(row, record)
  );
  const exactReceipt = receipt === undefined
    ? request === undefined
      ? null
      : releaseRequestReceipt(context.snapshot.reviews, request)
    : receipt;
  const exactRevision = revision ?? request?.revision;
  if (
    deps.github.nativeQueue === undefined || exactReceipt === null ||
    exactRevision === undefined
  ) return await holdQueueRecord(deps, context, record, true);
  const proof = await deps.github.nativeQueue.proveDelivery({
    record,
    receipt: exactReceipt,
    revision: exactRevision,
    deadline: context.bounds.runDeadline,
  });
  if (proof.status === "verified" || proof.status === "legacy_direct") {
    const binding = proof.status === "verified"
      ? proof.delivery
      : proof.binding;
    const actualRevision = proof.status === "verified"
      ? proof.delivery.revision
      : proof.revision;
    if (
      (proof.status === "verified" &&
        !isVerifiedDeliveryProof(proof.delivery)) ||
      canonicalStringify(binding.repository) !==
        canonicalStringify(record.repository) ||
      binding.pullRequest !== record.target.pr ||
      binding.base !== record.target.base ||
      binding.head !== record.target.head ||
      binding.reviewRequestId !== exactReceipt.requestId ||
      binding.reviewReceiptId !== exactReceipt.id ||
      actualRevision !== exactRevision ||
      (exactReceipt.taskAcceptance != null &&
        binding.taskDigest !== exactReceipt.taskAcceptance.taskDigest) ||
      (acceptProof !== undefined && !acceptProof(proof))
    ) return await holdQueueRecord(deps, context, record);
    return null;
  }
  return await holdQueueRecord(
    deps,
    context,
    record,
    proof.status === "unavailable",
  );
}

/** Fixed native refusal only; unrelated transport errors retain existing retry handling. */
export function queueEffectRefused(error: { detail: string }): boolean {
  return error.detail.startsWith("native queue custody");
}

export function queueRefusalIsTransient(error: { detail: string }): boolean {
  return error.detail === "native queue custody capability missing" ||
    error.detail === "native queue custody hold: capability_missing" ||
    error.detail === "native queue custody hold: rule_unavailable" ||
    error.detail === "native queue custody hold: observation_unavailable" ||
    error.detail ===
      "native queue custody hold: inactive_observation_unavailable" ||
    error.detail === "native queue custody hold: queue_evidence_unavailable";
}
