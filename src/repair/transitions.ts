/**
 * m04-repair: pure record transitions. Every state change in the repair
 * snapshot is expressed here as a pure function over frozen WorkRecordV1 /
 * RepairStateSnapshotV1 values; the loop never mutates records in place.
 * Each builder re-parses its result with the frozen parser, so an invalid
 * lifecycle transition fails in deterministic code instead of being persisted
 * by accident. Immutable identities (source, controller SHA, fingerprint,
 * failing revision, created/updated ordering) are never rewritten; terminal
 * records stay terminal.
 */

import type { GitSha } from "../contracts/brands.ts";
import type { IncidentSummaryV1 } from "../contracts/incident.ts";
import { parseRepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { EvidenceRefV1 } from "../contracts/shared.ts";
import { parseWorkRecordV1 } from "../contracts/work-record.ts";
import type {
  BlockerKindV1,
  IncompleteOperationV1,
  WorkBlockerV1,
  WorkRecordV1,
  WorkWaitV1,
} from "../contracts/work-record.ts";
import { workItemIdForIncident, workItemIdForIssue } from "./keys.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

export interface IntakeContextV1 {
  controllerSha: GitSha;
  repository: RepositoryIdentityV1;
  /** Exact base branch head observed at intake; never a moving ref. */
  observedBase: GitSha;
  now: number;
}

/** Deterministic severity/priority/urgency derivation from one issue. */
export function classifyIssue(
  labels: readonly string[],
): {
  severity: "P0" | "P1" | "P2" | "P3";
  priority: number | null;
  urgency: {
    activeProduction: boolean;
    reproducible5xx: boolean;
    severeSecurityOrDataLoss: boolean;
  };
} {
  const lowered = labels.map((label) => label.toLowerCase());
  const severityLabel = lowered.find((label) => label === "p0") ??
    lowered.find((label) => label === "p1") ??
    lowered.find((label) => label === "p2") ??
    lowered.find((label) => label === "p3");
  const severity = severityLabel === "p0"
    ? "P0"
    : severityLabel === "p1"
    ? "P1"
    : severityLabel === "p3"
    ? "P3"
    : "P2";
  // Highest recognized duplicate label wins; missing priority stays null.
  const numeric = lowered
    .map((label) => {
      const match = /^(?:priority[\s:_-]*)?([1-9][0-9]{0,3})$/.exec(label);
      return match === null ? null : Number(match[1]);
    })
    .filter((value): value is number => value !== null)
    .sort((a, b) => b - a);
  const priority = numeric.length === 0 ? 0 : numeric[0];
  const text = lowered.join(" ");
  const severeSecurityOrDataLoss = /(security|data[\s_-]?loss)/.test(text);
  const reproducible5xx = /(5[0-9]{2}|five\s*xx|5xx)/.test(text);
  return {
    severity,
    priority: priority === 0 ? null : priority,
    urgency: {
      activeProduction: false,
      reproducible5xx,
      severeSecurityOrDataLoss,
    },
  };
}

/** New incident work record; identities are immutable from this moment. */
export function createIncidentWork(
  summary: IncidentSummaryV1,
  context: IntakeContextV1,
): WorkRecordV1 {
  const record = {
    version: "v1" as const,
    kind: "work" as const,
    repository: context.repository,
    id: workItemIdForIncident(context.repository, summary.fingerprint),
    source: {
      kind: "incident" as const,
      id: summary.id,
      revision: summary.failingRevision ?? summary.id,
    },
    related: { incidentId: summary.id, issueNumber: null },
    fingerprint: summary.fingerprint,
    failingRevision: summary.failingRevision,
    sourceSnapshotDigest: null,
    classification: { severity: summary.severity, priority: null },
    urgency: {
      activeProduction: true,
      reproducible5xx: /(5[0-9]{2}|five\s*xx|5xx)/i.test(
        `${summary.errorType} ${summary.context.message}`,
      ),
      severeSecurityOrDataLoss: /(security|data[\s_-]?loss)/i.test(
        `${summary.context.message} ${summary.context.sample.join(" ")}`,
      ),
    },
    dependencies: [],
    controller: { sha: context.controllerSha },
    target: {
      base: context.observedBase,
      branch: null,
      checkpoint: null,
      head: null,
      pr: null,
    },
    nextStep: "work" as const,
    wait: null,
    blocker: null,
    counters: { attempts: 0, retries: 0, reviewRounds: 0 },
    evidence: incidentEvidenceRef(summary),
    intent: null,
    firstSeenAt: summary.firstSeenAt,
    createdAt: context.now,
    updatedAt: context.now,
  };
  return expectWork(record);
}

/** New issue work record; source revision is the base observed at intake. */
export function createIssueWork(
  issue: {
    number: number;
    title: string;
    labels: string[];
    createdAt: number;
  },
  context: IntakeContextV1,
): WorkRecordV1 {
  const classified = classifyIssue(issue.labels);
  const record = {
    version: "v1" as const,
    kind: "work" as const,
    repository: context.repository,
    id: workItemIdForIssue(context.repository, issue.number),
    source: {
      kind: "issue" as const,
      id: String(issue.number),
      revision: context.observedBase,
    },
    related: { incidentId: null, issueNumber: issue.number },
    fingerprint: null,
    failingRevision: null,
    sourceSnapshotDigest: null,
    classification: {
      severity: classified.severity,
      priority: classified.priority,
    },
    urgency: classified.urgency,
    dependencies: [],
    controller: { sha: context.controllerSha },
    target: {
      base: context.observedBase,
      branch: null,
      checkpoint: null,
      head: null,
      pr: null,
    },
    nextStep: "work" as const,
    wait: null,
    blocker: null,
    counters: { attempts: 0, retries: 0, reviewRounds: 0 },
    evidence: [],
    intent: null,
    firstSeenAt: issue.createdAt,
    createdAt: context.now,
    updatedAt: context.now,
  };
  return expectWork(record);
}

/**
 * Apply a refreshed incident summary to an existing work record. Frozen rules:
 * identity/fingerprint/firstSeenAt/failing revision are fixed, count and
 * lastSeenAt are nondecreasing; severity/evidence/coverage may update. The
 * returned record always parses or a deterministic error is thrown.
 */
export function applyIncidentSummary(
  record: WorkRecordV1,
  previous: IncidentSummaryV1 | null,
  summary: IncidentSummaryV1,
  now: number,
): WorkRecordV1 {
  if (record.source.kind !== "incident" || record.fingerprint === null) {
    throw new Error("applyIncidentSummary: record is not an incident task");
  }
  if (record.fingerprint !== summary.fingerprint) {
    throw new Error("applyIncidentSummary: fingerprint identity mismatch");
  }
  if (
    record.firstSeenAt !== null && summary.firstSeenAt !== record.firstSeenAt
  ) {
    throw new Error("applyIncidentSummary: firstSeenAt identity mismatch");
  }
  if (
    previous !== null &&
    (summary.lastSeenAt < previous.lastSeenAt ||
      summary.count < previous.count)
  ) {
    throw new Error("applyIncidentSummary: summary counter regression");
  }
  const merged: WorkRecordV1 = {
    ...record,
    classification: { ...record.classification, severity: summary.severity },
    evidence: appendEvidence(record.evidence, incidentEvidenceRef(summary)),
    updatedAt: now,
  };
  return expectWork(merged);
}

/**
 * An incident evidence ref is only admitted when an encrypted artifact digest
 * is actually present; a digest-less pointer is never fabricated into a
 * digest-branded evidence identity (it is re-read through readIncident later).
 */
function incidentEvidenceRef(
  summary: IncidentSummaryV1,
): EvidenceRefV1[] {
  if (summary.evidenceRef === null || summary.evidenceRef.digest === null) {
    return [];
  }
  return [{
    kind: "incident_evidence",
    ref: summary.evidenceRef.ref,
    digest: summary.evidenceRef.digest,
  }];
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

/** Append distinct evidence refs (kind+ref), preserving existing order. */
export function appendEvidence(
  evidence: readonly EvidenceRefV1[],
  next: readonly EvidenceRefV1[],
): EvidenceRefV1[] {
  const merged = [...evidence];
  for (const ref of next) {
    if (
      !merged.some((existing) =>
        existing.kind === ref.kind && existing.ref === ref.ref
      )
    ) {
      merged.push(ref);
    }
  }
  return merged;
}

/** Assign deterministic branch/base at the start of implementation work. */
export function assignTarget(
  record: WorkRecordV1,
  target: { base: GitSha; branch: string | null },
  now: number,
): WorkRecordV1 {
  return expectWork({
    ...record,
    target: {
      ...record.target,
      base: target.base,
      branch: target.branch,
    },
    updatedAt: now,
  });
}

/** Persist an incomplete-operation intent BEFORE the external effect. */
export function setIntent(
  record: WorkRecordV1,
  intent: IncompleteOperationV1,
  now: number,
): WorkRecordV1 {
  if (record.nextStep === "done") {
    throw new Error("setIntent: terminal record cannot take an intent");
  }
  return expectWork({ ...record, intent, updatedAt: now });
}

/** Clear an intent only after the external effect is reconciled. */
export function clearIntent(record: WorkRecordV1, now: number): WorkRecordV1 {
  return expectWork({ ...record, intent: null, updatedAt: now });
}

/** One implementation attempt is about to be started (budget already admitted). */
export function startAttempt(record: WorkRecordV1, now: number): WorkRecordV1 {
  return expectWork({
    ...record,
    counters: { ...record.counters, attempts: record.counters.attempts + 1 },
    updatedAt: now,
  });
}

/** Record a locally validated candidate head/checkpoint. */
export function noteCandidate(
  record: WorkRecordV1,
  candidate: {
    head: GitSha;
    checkpoint: { branch: string; sha: GitSha } | null;
  },
  now: number,
): WorkRecordV1 {
  return expectWork({
    ...record,
    target: {
      ...record.target,
      head: candidate.head,
      checkpoint: candidate.checkpoint,
    },
    updatedAt: now,
  });
}

/** Move to the review wait after a successful publication + review request. */
export function advanceToReview(
  record: WorkRecordV1,
  target: { pr: number; head: GitSha },
  wait: WorkWaitV1,
  now: number,
): WorkRecordV1 {
  return expectWork({
    ...record,
    target: { ...record.target, pr: target.pr, head: target.head },
    nextStep: "review",
    wait,
    blocker: null,
    updatedAt: now,
  });
}

/** Completed current-head review with no unresolved P0/P1 → delivery. */
export function advanceToDelivery(
  record: WorkRecordV1,
  now: number,
): WorkRecordV1 {
  return expectWork({
    ...record,
    nextStep: "delivery",
    wait: null,
    blocker: null,
    updatedAt: now,
  });
}

/** An unresolved P0/P1 (or new head) requires a fresh correction round. */
export function advanceToCorrection(
  record: WorkRecordV1,
  now: number,
): WorkRecordV1 {
  return expectWork({
    ...record,
    nextStep: "work",
    wait: null,
    blocker: null,
    updatedAt: now,
  });
}

/** Explicit wait with a bounded retry time; the loop never sleeps. */
export function setWait(
  record: WorkRecordV1,
  wait: WorkWaitV1,
  now: number,
): WorkRecordV1 {
  return expectWork({ ...record, wait, updatedAt: now });
}

/** Clear a wait when the step moves on. */
export function clearWait(record: WorkRecordV1, now: number): WorkRecordV1 {
  if (record.wait === null) return record;
  return expectWork({ ...record, wait: null, updatedAt: now });
}

/** Deterministic blocker; blocked work is skipped but never drops other work. */
export function markBlocked(
  record: WorkRecordV1,
  kind: BlockerKindV1,
  message: string,
  now: number,
): WorkRecordV1 {
  const blocker: WorkBlockerV1 = { kind, message, since: now };
  return expectWork({
    ...record,
    nextStep: "blocked",
    blocker,
    wait: null,
    updatedAt: now,
  });
}

/** Terminal. A done record never moves again; all transitions reject it. */
export function markDone(record: WorkRecordV1, now: number): WorkRecordV1 {
  return expectWork({
    ...record,
    nextStep: "done",
    wait: null,
    blocker: null,
    intent: null,
    updatedAt: now,
  });
}

/** Retry accounting: an explicit retry of failed work, one extra attempt. */
export function countRetry(record: WorkRecordV1, now: number): WorkRecordV1 {
  return expectWork({
    ...record,
    counters: {
      ...record.counters,
      retries: record.counters.retries + 1,
      attempts: record.counters.attempts + 1,
    },
    updatedAt: now,
  });
}

/** One review request was actually submitted (not an observation). */
export function countReviewRound(
  record: WorkRecordV1,
  now: number,
): WorkRecordV1 {
  return expectWork({
    ...record,
    counters: {
      ...record.counters,
      reviewRounds: record.counters.reviewRounds + 1,
    },
    updatedAt: now,
  });
}

/** Bounded record set: one snapshot update per persisted transition. */
export function updateSnapshot(
  snapshot: RepairStateSnapshotV1,
  mutate: (draft: RepairStateSnapshotV1) => void,
  now: number,
): RepairStateSnapshotV1 {
  const draft: RepairStateSnapshotV1 = {
    ...snapshot,
    sequence: snapshot.sequence + 1,
    updatedAt: now,
    incidents: [...snapshot.incidents],
    evidence: [...snapshot.evidence],
    work: [...snapshot.work],
    reservations: [...snapshot.reservations],
    reviews: [...snapshot.reviews],
    replays: [...snapshot.replays],
    releaseRequests: [...snapshot.releaseRequests],
  };
  mutate(draft);
  return parseRepairStateSnapshotV1(draft);
}

/** Replace one work record or fail with a sanitized static error. */
export function replaceWork(
  snapshot: RepairStateSnapshotV1,
  next: WorkRecordV1,
): RepairStateSnapshotV1 {
  const index = snapshot.work.findIndex((record) => record.id === next.id);
  if (index === -1) {
    throw new Error("replaceWork: work record not found");
  }
  const work = [...snapshot.work];
  work[index] = next;
  return { ...snapshot, work };
}

/** Replace one work record or append it (deterministic idempotent upsert). */
export function upsertWork(
  snapshot: RepairStateSnapshotV1,
  next: WorkRecordV1,
): RepairStateSnapshotV1 {
  const index = snapshot.work.findIndex((record) => record.id === next.id);
  const work = [...snapshot.work];
  if (index === -1) {
    work.push(next);
  } else {
    const existing = work[index];
    if (!sameImmutableIdentity(existing, next)) {
      throw new Error("upsertWork: immutable identity mismatch");
    }
    work[index] = next;
  }
  return { ...snapshot, work };
}

/** Append one distinct record by id (no duplicate ever enters the snapshot). */
export function appendDistinct<T extends { id: string }>(
  records: readonly T[],
  next: T,
): T[] {
  if (records.some((record) => record.id === next.id)) return [...records];
  return [...records, next];
}

function sameImmutableIdentity(a: WorkRecordV1, b: WorkRecordV1): boolean {
  return a.repository.owner === b.repository.owner &&
    a.repository.name === b.repository.name &&
    a.repository.installationId === b.repository.installationId &&
    a.id === b.id &&
    a.source.kind === b.source.kind &&
    a.source.id === b.source.id &&
    a.source.revision === b.source.revision &&
    a.fingerprint === b.fingerprint &&
    a.failingRevision === b.failingRevision &&
    a.controller.sha === b.controller.sha;
}

/** Parse the record with the frozen parser; throws on invalid lifecycle. */
function expectWork(record: WorkRecordV1): WorkRecordV1 {
  return parseWorkRecordV1(record);
}
