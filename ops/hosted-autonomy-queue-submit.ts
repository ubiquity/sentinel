/** Before-effects intent/hold, fresh native authorization, then one async queue submission. */
import { canonicalStringify } from "../src/contracts/canonical.ts";
import { hasTakeoverCustody } from "../src/github/existing-pr-takeover-provenance.ts";
import type {
  QueueBinding,
  QueueMembership,
  QueuePullIdentity,
  QueueRead,
  QueueSnapshot,
} from "../src/github/merge-queue-types.ts";
import type {
  QueueRecordOutcome,
  QueueRecordPass,
} from "./hosted-autonomy-queue-reconcile.ts";
import {
  createQueueIntent,
  queueFailure,
  type QueueIntentState,
} from "./hosted-autonomy-queue-intent.ts";
import { queueHold } from "./hosted-autonomy-queue-writer.ts";
import {
  decideQueuePolicy,
  hasCompleteQueueAuthorizationFacts,
} from "./hosted-autonomy-queue-policy.ts";

function hasConsistentNativeAbsence(
  scan: QueueRead<QueueSnapshot>,
  member: QueueRead<QueueMembership>,
  authorizationMember: QueueRead<QueueMembership>,
  repository: QueueBinding["repository"],
  binding: QueueBinding,
  pull: QueuePullIdentity,
): boolean {
  const absent = (observed: QueueRead<QueueMembership>): boolean =>
    observed.status === "complete" && observed.value.entry === null &&
    observed.value.mergedRevision === null &&
    observed.value.pull.head === binding.head &&
    canonicalStringify(observed.value.pull) === canonicalStringify(pull);
  return scan.status === "complete" &&
    canonicalStringify(scan.value.repository) ===
      canonicalStringify(repository) &&
    scan.value.baseRef === "development" &&
    scan.value.entries.every((item) =>
      item.pull.number !== binding.pullRequest
    ) &&
    absent(member) && absent(authorizationMember);
}

export async function submitQueueAdmission(
  input: QueueRecordPass,
  binding: QueueBinding,
  pull: QueuePullIdentity,
  previous: QueueIntentState | null,
): Promise<QueueRecordOutcome> {
  const { deps, queue, writer } = input;
  const stop = (): QueueRecordOutcome => ({ ready: false, submitted: false });
  const tag = `queue:${input.record.id}`;
  let intent = previous === null
    ? await createQueueIntent(input.record, binding, deps.clock.now())
    : { ...previous.intent, requestId: null, resultId: null };
  // A proven ejection permits exactly one new admission, never an age-based retry reset.
  if (
    previous?.admission === 0 && previous.queueFailures === 1 &&
    (previous.stage === "ejected_ci_failed" ||
      previous.stage === "ejected_timeout")
  ) {
    intent = {
      ...intent,
      key: `${intent.key}:a1`,
      startedAt: deps.clock.now(),
    };
  }
  if (previous !== null && intent.failure !== undefined) {
    // Mark the next effect uncertain BEFORE submission without inventing another failed execution.
    intent = queueFailure(
      intent,
      "ambiguous",
      previous.refusals,
      previous.queueFailures,
      deps.clock.now(),
      false,
    );
  }
  let record = {
    ...queueHold(input.record, deps.clock.now()),
    intent,
    updatedAt: deps.clock.now(),
  };
  const markNotSubmitted = async (
    reason: string,
  ): Promise<QueueRecordOutcome> => {
    const failure = queueFailure(
      intent,
      "not_submitted",
      previous?.refusals ?? 0,
      previous?.queueFailures ?? 0,
      deps.clock.now(),
      true,
    );
    record = {
      ...record,
      intent: failure,
      updatedAt: deps.clock.now(),
    };
    if (!await writer.update([record])) return stop();
    writer.actions.push(`${tag}:pre_effect_not_submitted:${reason}`);
    return { ready: true, submitted: false };
  };
  if (!await writer.update([record])) {
    writer.actions.push(`${tag}:intent_unverified`);
    return stop();
  }
  // This call alone knows no effect preceded the freshly committed intent. A restart does not.
  const rules = await queue.readEffectiveQueueRule();
  const scan = await queue.surface.readQueue("development");
  const member = await queue.surface.readPullMembership(pull);
  if (
    rules.status !== "complete" || rules.value !== true ||
    scan.status !== "complete" ||
    member.status !== "complete" || member.value.entry !== null ||
    member.value.mergedRevision !== null ||
    canonicalStringify(member.value.pull) !== canonicalStringify(pull) ||
    deps.clock.now() >= input.deadline
  ) {
    writer.actions.push(`${tag}:pre_effect_observation_changed`);
    if (
      rules.status === "complete" && rules.value === false &&
      scan.status === "complete" && member.status === "complete"
    ) {
      const authorization = await queue.authorization.readAuthorization({
        snapshot: writer.observed.snapshot,
        observedHead: writer.observed.head,
        record,
        binding,
        queue: scan.value,
      });
      if (
        authorization.status === "complete" &&
        canonicalStringify(authorization.value.binding) ===
          canonicalStringify(binding) &&
        canonicalStringify(authorization.value.pull) ===
          canonicalStringify(pull) &&
        hasCompleteQueueAuthorizationFacts(authorization.value.facts) &&
        hasConsistentNativeAbsence(
          scan,
          member,
          authorization.value.facts.membership,
          queue.repository,
          binding,
          pull,
        )
      ) return await markNotSubmitted("queue_disabled");
    }
    return stop();
  }
  const auth = await queue.authorization.readAuthorization({
    snapshot: writer.observed.snapshot,
    observedHead: writer.observed.head,
    record,
    binding,
    queue: scan.value,
  });
  if (
    auth.status !== "complete" ||
    canonicalStringify(auth.value.binding) !== canonicalStringify(binding) ||
    canonicalStringify(auth.value.pull) !== canonicalStringify(pull)
  ) {
    writer.actions.push(`${tag}:pre_effect_authorization_changed`);
    return stop();
  }
  const decision = decideQueuePolicy({
    ...auth.value.facts,
    binding,
    membership: member,
    ownsEntry: false,
    definitiveRefusals: previous?.refusals ?? 0,
    admissionStartedAt: previous?.intent.resultId ? null : intent.startedAt,
    now: deps.clock.now(),
    admissionAmbiguous: false,
    reentry: (previous?.queueFailures ?? 0) > 0,
    failedQueueAdmissions: previous?.queueFailures ?? 0,
  });
  if (decision.action !== "enqueue" && decision.action !== "reenter") {
    writer.actions.push(
      `${tag}:pre_effect_${decision.action}:${
        "reason" in decision ? decision.reason : "refused"
      }`,
    );
    const facts = auth.value.facts;
    if (
      decision.action === "hold" && hasCompleteQueueAuthorizationFacts(facts) &&
      hasConsistentNativeAbsence(
        scan,
        member,
        facts.membership,
        queue.repository,
        binding,
        pull,
      )
    ) return await markNotSubmitted("authorization_refused");
    return { ready: true, submitted: false };
  }
  // A competing state writer between the readback and effect revokes this pass's authority.
  const current = await deps.state.readRepair();
  if (
    deps.clock.now() >= input.deadline ||
    !current.ok || current.value.status !== "found" ||
    current.value.head !== writer.observed.head ||
    canonicalStringify(current.value.snapshot) !==
      canonicalStringify(writer.observed.snapshot)
  ) return stop();
  let outcome;
  if (hasTakeoverCustody(record)) {
    const allowed = await queue.authorization.authorizeEnqueue?.({
      snapshot: writer.observed.snapshot,
      observedHead: writer.observed.head,
      record,
      binding,
      queue: scan.value,
      deadline: input.deadline,
    });
    if (!allowed?.ok) {
      writer.actions.push(`${tag}:existing_pr_enqueue_custody_unavailable`);
      return stop();
    }
  }
  if (deps.clock.now() >= input.deadline) return stop();
  try {
    outcome = await queue.surface.enqueue(pull);
  } catch {
    outcome = { status: "ambiguous", requestId: null } as const;
  }
  const now = deps.clock.now();
  if (outcome.status === "pending") {
    intent = { ...intent, requestId: outcome.requestId };
  } else if (outcome.status === "refused") {
    intent = queueFailure(
      intent,
      "refused",
      Math.min(3, (previous?.refusals ?? 0) + 1),
      previous?.queueFailures ?? 0,
      now,
      true,
    );
  } else if (outcome.status === "not_submitted") {
    intent = queueFailure(
      intent,
      "not_submitted",
      previous?.refusals ?? 0,
      previous?.queueFailures ?? 0,
      now,
      true,
    );
  } else {
    intent = { ...intent, requestId: outcome.requestId };
    if (outcome.status === "ambiguous") {
      intent = queueFailure(
        intent,
        "ambiguous",
        previous?.refusals ?? 0,
        previous?.queueFailures ?? 0,
        now,
        true,
      );
    }
  }
  record = { ...record, intent, updatedAt: now };
  if (!await writer.update([record])) {
    writer.actions.push(`${tag}:submission_state_unverified`);
    return { ready: false, submitted: true };
  }
  const after = await queue.surface.readPullMembership(pull);
  if (after.status !== "complete") {
    writer.actions.push(`${tag}:submission_membership_unavailable`);
    return { ready: false, submitted: true };
  }
  const entry = after.value.entry;
  if (
    entry !== null && queue.config.appActor !== null &&
    canonicalStringify(entry.enqueuer) ===
      canonicalStringify(queue.config.appActor) &&
    canonicalStringify(after.value.pull) === canonicalStringify(pull) &&
    entry.enqueuedAt >= Math.floor(intent.startedAt / 1000) * 1000 &&
    entry.enqueuedAt <= deps.clock.now()
  ) {
    record = {
      ...record,
      intent: { ...intent, resultId: entry.id },
      updatedAt: deps.clock.now(),
    };
    if (!await writer.update([record])) {
      return { ready: false, submitted: true };
    }
  }
  writer.actions.push(`${tag}:admission_${outcome.status}`);
  return { ready: true, submitted: outcome.status !== "not_submitted" };
}
