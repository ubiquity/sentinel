/**
 * m04-repair: the bounded repair polling loop.
 *
 * Deterministic trusted code owns every id, digest, branch identity, attempt,
 * state intent, schedule and state write. The loop never sleeps and never
 * busy-waits: each run loads the authoritative repair snapshot, reconciles
 * saved operation intents against exact remote objects, polls unresolved
 * incidents, selects the next eligible action by the frozen priority order,
 * executes exactly one bounded step, persists a checkpoint (sequence + 1) and
 * repeats until no eligible work remains or the next declared operation cannot
 * fit the remaining run margin. All ports are injected; the loop has no
 * transport, no storage alternative and no inference policy of its own.
 */

import type { FixtureDigest, GitSha } from "../contracts/brands.ts";
import type {
  Clock,
  GitHubPort,
  ImplementationPort,
  IncidentAdapter,
  IsolatedReplayResultV1,
  MergeOutcomeV1,
  ModelRunReceiptV1,
  PortResultV1,
  ReplayPort,
  ReviewObservationV1,
  StateReadView,
  StateWriteResultV1,
} from "../contracts/ports.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { IncidentEvidenceV1 } from "../contracts/incident.ts";
import { parseMergeRequestV1 } from "../contracts/merge-request.ts";
import { parseReleaseRequestV1 } from "../contracts/release.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import { parseReplayResultV1 } from "../contracts/replay-result.ts";
import type { ReplayResultV1 } from "../contracts/replay-result.ts";
import {
  deriveUnresolvedSeverities,
  parseReviewReceiptV1,
} from "../contracts/review-receipt.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import { parseRepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type {
  EvidenceRefV1,
  RepositoryIdentityV1,
} from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import type { BudgetControllerV1 } from "../budget/mod.ts";
import {
  candidateBranch,
  closureIntentKey,
  implementationIntentKey,
  mergeIntentKey,
  pullRequestIntentKey,
  pushIntentKey,
  releaseRequestId,
  replayEvidenceRef,
  replayResultId,
  reviewEvidenceRef,
  reviewOperationKey,
  reviewReceiptId,
} from "./keys.ts";
import { MAX_UNFINISHED_PRS, rankEligibleWork } from "./selection.ts";
import {
  advanceToCorrection,
  advanceToDelivery,
  advanceToReview,
  applyIncidentSummary,
  assignTarget,
  clearIntent,
  countReviewRound,
  createIncidentWork,
  createIssueWork,
  markBlocked,
  markDone,
  noteCandidate,
  setIntent,
  setWait,
  startAttempt,
} from "./transitions.ts";

/** The one trusted reviewer identity for runtime Sentinel PRs. */
export const EXPECTED_REVIEWER = "chatgpt-codex-connector[bot]";

// Private finite constants (no new env/secret/CLI surface is introduced).
const INCIDENT_PAGE_LIMIT = 20;
const REVIEW_POLL_MS = 15 * 60_000;
const CHECK_POLL_MS = 5 * 60_000;
const RELEASE_POLL_MS = 5 * 60_000;
const OPERATION_MARGIN_MS = 5 * 60_000;
const DEFAULT_STEP_LIMIT = 32;
const MAX_IMPLEMENTATION_ATTEMPTS = 3;
const MAX_OUTPUT_LIMIT_BYTES = 4096;
const MODEL_ID = "gpt-5.6-luna" as const;
const REASONING = "max" as const;

export interface RepairCycleDepsV1 {
  clock: Clock;
  /** Repair read view plus the one trusted repair writer; never release write. */
  state: StateReadView & {
    writeRepair(
      next: RepairStateSnapshotV1,
      expectedHead: GitSha | null,
    ): Promise<PortResultV1<StateWriteResultV1>>;
  };
  /** Complete trusted repository configuration set (budget agreement + commands). */
  configs: readonly RepositoryConfigV1[];
  /** Exact Sentinel controller SHA that owns every new work record; immutable. */
  controllerSha: GitSha;
  github: GitHubPort;
  incidents: IncidentAdapter;
  replay: ReplayPort;
  /**
   * Trusted fixture metadata source. The frozen ReplayPort intentionally only
   * executes a request; its resolver remains host-owned. A host may also
   * expose this method on the injected replay object for one shared adapter.
   */
  fixtureIdentities?: ReplayFixtureIdentitySourceV1;
  model: ImplementationPort;
  /** The one production admission controller (RollingStartBudget). */
  budget: BudgetControllerV1;
}

/** Read-only trusted identity lookup paired with the concrete fixture resolver. */
export interface ReplayFixtureIdentitySourceV1 {
  resolveTestIds(
    fixtureRef: string,
    fixtureDigest: FixtureDigest,
  ): Promise<PortResultV1<readonly string[]>>;
}

export interface RepairCycleOptionsV1 {
  /** Absolute deadline of this run; declared operations must fit the margin. */
  deadline: number;
  /** Bounded persisted transitions per run. */
  stepLimit?: number;
}

export type RepairCycleOutcomeV1 =
  | { status: "idle"; detail: string }
  | { status: "margin"; detail: string }
  | { status: "step_limit"; steps: number }
  | { status: "state_error"; detail: string }
  | { status: "source_error"; detail: string };

interface LoopContextV1 {
  snapshot: RepairStateSnapshotV1;
  head: GitSha | null;
}

type StepResultV1 =
  | { kind: "progress" }
  | { kind: "idle" }
  | { kind: "margin"; detail: string }
  | { kind: "state_error"; detail: string };

/** One run of the bounded repair loop. */
export async function runRepairCycle(
  deps: RepairCycleDepsV1,
  options: RepairCycleOptionsV1,
): Promise<RepairCycleOutcomeV1> {
  const stepLimit = options.stepLimit ?? DEFAULT_STEP_LIMIT;
  let steps = 0;
  let sourceError: string | null = null;
  let didWork = false;

  for (;;) {
    let loaded = await loadSnapshot(deps);
    if (loaded === null) {
      // Branch creation: exactly one seeded snapshot (sequence 1), written
      // with expectedHead null; never a force overwrite of existing state.
      loaded = await seedSnapshot(deps);
      if (loaded === null) {
        return { status: "state_error", detail: "repair state unavailable" };
      }
    }
    const context: LoopContextV1 = loaded;

    if (steps === 0) {
      const intake = await pollIntake(deps, context);
      sourceError = intake.error;
      if (intake.changed) {
        if (intake.result.kind !== "progress") {
          return {
            status: "state_error",
            detail: "intake checkpoint conflict",
          };
        }
        didWork = true;
        steps++;
      }
    }

    if (steps >= stepLimit) {
      return { status: "step_limit", steps };
    }

    const rank = rankEligibleWork(
      context.snapshot,
      deps.configs,
      deps.clock.now(),
    );
    if (rank.ordered.length === 0) {
      if (!didWork && sourceError !== null) {
        return { status: "source_error", detail: sourceError };
      }
      return {
        status: "idle",
        detail: idleDetail(context.snapshot, rank.skipped),
      };
    }

    const record = context.snapshot.work.find(
      (work) => work.id === rank.ordered[0],
    );
    if (record === undefined) {
      return { status: "state_error", detail: "selected record missing" };
    }

    if (
      !(await declaredOperationFits(deps, context, record, options.deadline))
    ) {
      return {
        status: "margin",
        detail: `next operation for ${record.id} cannot fit`,
      };
    }

    const result = await executeStep(deps, context, record);
    if (result.kind === "state_error") {
      return { status: "state_error", detail: result.detail };
    }
    if (result.kind === "margin") {
      return { status: "margin", detail: result.detail };
    }
    if (result.kind === "idle") {
      if (!didWork && sourceError !== null) {
        return { status: "source_error", detail: sourceError };
      }
      return {
        status: "idle",
        detail: `no eligible work after ${steps} steps`,
      };
    }
    didWork = true;
    steps++;
  }
}

// ---------------------------------------------------------------------------
// State load/commit (expected-head compare-and-swap, never force overwrite).
// Context mutates in place after every applied write so a later commit in the
// same step never races its own earlier checkpoint.
// ---------------------------------------------------------------------------

async function loadSnapshot(
  deps: RepairCycleDepsV1,
): Promise<LoopContextV1 | null> {
  const read = await deps.state.readRepair();
  if (!read.ok || read.value.status === "absent") return null;
  return { snapshot: read.value.snapshot, head: read.value.head };
}

/** Seed the repair branch once with sequence 1 when no snapshot exists. */
async function seedSnapshot(
  deps: RepairCycleDepsV1,
): Promise<LoopContextV1 | null> {
  const now = deps.clock.now();
  const seed = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: now,
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
  });
  const written = await deps.state.writeRepair(seed, null);
  if (!written.ok || written.value.status !== "applied") return null;
  return { snapshot: seed, head: written.value.head };
}

async function persistTransition(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  mutate: (draft: RepairStateSnapshotV1) => void,
): Promise<StepResultV1> {
  const base = context.snapshot;
  const draft: RepairStateSnapshotV1 = {
    ...base,
    stateHead: context.head,
    sequence: base.sequence + 1,
    updatedAt: deps.clock.now(),
    incidents: [...base.incidents],
    evidence: [...base.evidence],
    work: [...base.work],
    reservations: [...base.reservations],
    reviews: [...base.reviews],
    replays: [...base.replays],
    releaseRequests: [...base.releaseRequests],
  };
  mutate(draft);
  let parsed: RepairStateSnapshotV1;
  try {
    parsed = parseRepairStateSnapshotV1(draft);
  } catch {
    return { kind: "state_error", detail: "invalid persisted transition" };
  }
  const written = await deps.state.writeRepair(parsed, context.head);
  if (written.ok && written.value.status === "applied") {
    context.snapshot = parsed;
    context.head = written.value.head;
    return { kind: "progress" };
  }
  // Expected-head compare-and-swap lost, ambiguous or rejected: the mutation
  // was computed against a now-stale base, so it is never blindly replayed
  // over newer authoritative state (that could overwrite a newer conflicting
  // record with a captured stale mutation). Stop safely and explicitly; the
  // next run rereads the exact authoritative state and reconciles, and every
  // mutation here is keyed by deterministic identity so an already-applied
  // effect is absorbed instead of duplicated.
  return {
    kind: "state_error",
    detail: "checkpoint CAS conflict or ambiguity",
  };
}

function replaceWorkMutation(
  next: WorkRecordV1,
): (draft: RepairStateSnapshotV1) => void {
  return (draft) => {
    const index = draft.work.findIndex((record) => record.id === next.id);
    if (index === -1) {
      throw new Error("replaceWork: work record not found");
    }
    draft.work[index] = next;
  };
}

/** Persist one work record transition. */
function persistWork(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  next: WorkRecordV1,
): Promise<StepResultV1> {
  return persistTransition(deps, context, replaceWorkMutation(next));
}

// ---------------------------------------------------------------------------
// Intake: deterministic incident and issue polling; a failed read is never empty.
// ---------------------------------------------------------------------------

interface IntakeResultV1 {
  result: StepResultV1;
  changed: boolean;
  error: string | null;
}

async function pollIntake(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
): Promise<IntakeResultV1> {
  const now = deps.clock.now();
  let cursor: string | null = null;
  let error: string | null = null;
  let changed = false;

  const updatedWork = new Map<string, WorkRecordV1>();
  const newWork: WorkRecordV1[] = [];
  const newSummaries = new Map<
    string,
    RepairStateSnapshotV1["incidents"][number]
  >();

  for (;;) {
    const page = await deps.incidents.listUnresolvedIncidents(
      cursor,
      INCIDENT_PAGE_LIMIT,
    );
    if (!page.ok) {
      error = `incident source unavailable: ${page.error.kind}`;
      break;
    }
    for (const summary of page.value.items) {
      const existing = context.snapshot.incidents.find(
        (incident) => incident.fingerprint === summary.fingerprint,
      );
      const work = context.snapshot.work.find(
        (record) => record.fingerprint === summary.fingerprint,
      ) ?? null;
      if (existing !== null && existing !== undefined) {
        // Nondecreasing refresh of the stored summary.
        if (
          summary.lastSeenAt < existing.lastSeenAt ||
          summary.count < existing.count
        ) {
          error = "incident summary counter regression";
          continue;
        }
        if (summaryChanged(existing, summary)) {
          newSummaries.set(existing.id, summary);
          if (work !== null) {
            try {
              updatedWork.set(
                work.id,
                applyIncidentSummary(work, existing, summary, now),
              );
            } catch {
              error = "incident summary identity mismatch";
            }
          }
        }
        continue;
      }
      // New incident: a trusted base must be observed before a record is owned.
      const base = await readBase(deps, summary.repository);
      if (base === null) {
        error = `base unavailable for ${summary.repository.name}`;
        continue;
      }
      newSummaries.set(summary.id, summary);
      newWork.push(createIncidentWork(summary, {
        controllerSha: deps.controllerSha,
        repository: summary.repository,
        observedBase: base,
        now,
      }));
      changed = true;
    }
    if (page.value.coverage.status === "incomplete") {
      error = "incident discovery coverage incomplete";
      break;
    }
    if (page.value.nextCursor === null) break;
    cursor = page.value.nextCursor;
  }

  // The injected GitHub port targets one configured repository. The frozen
  // GitHubIssueV1 carries no repository field, so associate its rows with the
  // sole configuration for this cycle. A multi-repository host must inject a
  // separately targeted cycle rather than guessing an issue's repository.
  const issueRepository = deps.configs.length === 1
    ? deps.configs[0].repository
    : null;
  if (issueRepository !== null) {
    const issues = await deps.github.listOpenIssues();
    if (!issues.ok) {
      error = `issue source unavailable: ${issues.error.kind}`;
    } else {
      const seenIssues = new Set<string>();
      const baseByRepository = new Map<string, GitSha | null>();
      for (const issue of issues.value) {
        if (issue.state !== "open") continue;
        const issueKey =
          `${issueRepository.owner}/${issueRepository.name}#${issue.number}`;
        if (seenIssues.has(issueKey)) continue;
        seenIssues.add(issueKey);
        const existing = context.snapshot.work.find(
          (record) =>
            record.source.kind === "issue" &&
            record.repository.owner === issueRepository.owner &&
            record.repository.name === issueRepository.name &&
            record.source.id === String(issue.number),
        );
        if (existing !== undefined) continue;

        const repositoryKey =
          `${issueRepository.owner}/${issueRepository.name}`;
        let base = baseByRepository.get(repositoryKey);
        if (base === undefined) {
          base = await readBase(deps, issueRepository);
          baseByRepository.set(repositoryKey, base);
        }
        if (base === null) {
          error = `base unavailable for ${issueRepository.name}`;
          continue;
        }
        newWork.push(createIssueWork({
          number: issue.number,
          title: issue.title,
          labels: issue.labels,
          createdAt: issue.createdAt,
        }, {
          controllerSha: deps.controllerSha,
          repository: issueRepository,
          observedBase: base,
          now,
        }));
        changed = true;
      }
    }
  }

  if (!changed && updatedWork.size === 0 && newSummaries.size === 0) {
    return { result: { kind: "progress" }, changed: false, error };
  }

  const persisted = await persistTransition(
    deps,
    context,
    (draft) => {
      for (const summary of newSummaries.values()) {
        const index = draft.incidents.findIndex(
          (incident) => incident.id === summary.id,
        );
        if (index === -1) draft.incidents.push(summary);
        else draft.incidents[index] = summary;
      }
      for (const work of newWork) {
        if (!draft.work.some((record) => record.id === work.id)) {
          draft.work.push(work);
        }
      }
      for (const [id, work] of updatedWork) {
        const index = draft.work.findIndex((record) => record.id === id);
        if (index !== -1) draft.work[index] = work;
      }
    },
  );
  return { result: persisted, changed: changed || updatedWork.size > 0, error };
}

// ---------------------------------------------------------------------------
// Scheduling: declared operations must fit the remaining margin.
// ---------------------------------------------------------------------------

function declaredOperationFits(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  deadline: number,
): boolean {
  const config = configFor(deps, record.repository);
  if (config === null) return false;
  if (
    record.nextStep === "work" &&
    (record.target.head === null ||
      headRejectedByReview(context.snapshot, record))
  ) {
    const bound = config.sessionBound;
    if (bound === null) return true;
    if (
      deps.clock.now() + bound.maxDurationMs + OPERATION_MARGIN_MS > deadline
    ) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Step dispatch.
// ---------------------------------------------------------------------------

function executeStep(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  switch (record.nextStep) {
    case "work":
      return executeWorkStep(deps, context, record);
    case "review":
      return observeReview(deps, context, record);
    case "delivery":
      return executeDeliveryStep(deps, context, record);
    case "blocked":
    case "done":
      return Promise.resolve({ kind: "idle" });
  }
}

// ---------------------------------------------------------------------------
// Work phase: deterministic evidence, reproduction, implementation, replay.
// ---------------------------------------------------------------------------

interface CarryV1 {
  beforeRun: IsolatedReplayResultV1 | null;
  fixtureRef: string | null;
  fixtureDigest: string | null;
  testIds: string[] | null;
  replayCommandId: string | null;
  beforeReason: string;
}

async function executeWorkStep(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  const config = configFor(deps, record.repository);
  if (config === null) {
    return persistWork(
      deps,
      context,
      markBlocked(
        record,
        "unavailable",
        "repository not configured",
        deps.clock.now(),
      ),
    );
  }

  // A saved implementation intent is never resubmitted; fail closed.
  if (record.intent !== null && record.intent.kind === "implementation") {
    return handleImplementationUncertainty(deps, context, record);
  }

  // Deterministic branch identity before any model work.
  if (record.target.branch === null) {
    return persistWork(
      deps,
      context,
      assignTarget(
        record,
        { base: record.target.base, branch: candidateBranch(record.id) },
        deps.clock.now(),
      ),
    );
  }

  const evidenceOk = await ensureEvidence(deps, context.snapshot, record);
  if (evidenceOk.record !== null) {
    const evidenceRecord = evidenceOk.evidence;
    return persistTransition(deps, context, (draft) => {
      const index = draft.work.findIndex((work) => work.id === record.id);
      draft.work[index] = evidenceOk.record!;
      if (evidenceRecord !== null) {
        if (!draft.evidence.some((item) => item.id === evidenceRecord.id)) {
          draft.evidence.push(evidenceRecord);
        }
      }
    });
  }

  const carry: CarryV1 = {
    beforeRun: null,
    fixtureRef: null,
    fixtureDigest: null,
    testIds: null,
    replayCommandId: null,
    beforeReason: "",
  };

  const reproduced = await ensureBeforeReplay(
    deps,
    context.snapshot,
    record,
    carry,
  );
  if (reproduced !== null) {
    return persistWork(deps, context, reproduced);
  }

  if (
    record.target.head === null ||
    headRejectedByReview(context.snapshot, record)
  ) {
    return executeImplementationStep(deps, context, record, config);
  }

  // A head exists: it is publishable only after a validated replay result, or
  // immediately for a non-incident task (no fabricated fixture here).
  const validated = await candidateValidated(deps, context, record, carry);
  if (validated.kind === "blocked") {
    return persistWork(deps, context, validated.record);
  }
  if (validated.kind === "state_error") {
    return { kind: "state_error", detail: validated.detail };
  }
  if (validated.kind === "retry") {
    return executeImplementationStep(deps, context, record, config);
  }
  return executePublishStep(deps, context, record, config);
}

/**
 * Deterministic evidence/expiry handling. Returns either a record transition
 * (with the persisted IncidentEvidenceV1, when one was fetched) or a null
 * record meaning evidence is ready.
 */
async function ensureEvidence(
  deps: RepairCycleDepsV1,
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
): Promise<
  { record: WorkRecordV1 | null; evidence: IncidentEvidenceV1 | null }
> {
  if (record.source.kind !== "incident") {
    return { record: null, evidence: null };
  }
  const incidentId = record.related.incidentId;
  if (incidentId === null) {
    return {
      record: markBlocked(
        record,
        "missing_evidence",
        "incident task without an incident id",
        deps.clock.now(),
      ),
      evidence: null,
    };
  }
  const existing = snapshot.evidence.find((item) => item.id === incidentId);
  if (existing !== undefined) return { record: null, evidence: null };
  const read = await deps.incidents.readIncident(incidentId);
  if (!read.ok) {
    return {
      record: setWait(
        record,
        { reason: "unavailable", since: deps.clock.now(), until: null },
        deps.clock.now(),
      ),
      evidence: null,
    };
  }
  if (read.value === null) {
    return {
      record: markBlocked(
        record,
        "missing_evidence",
        "incident evidence missing",
        deps.clock.now(),
      ),
      evidence: null,
    };
  }
  const evidence = read.value;
  const now = deps.clock.now();
  if (evidence.artifacts.some((artifact) => artifact.expiresAt <= now)) {
    return {
      record: markBlocked(
        record,
        "evidence_expired",
        "incident artifact expired",
        now,
      ),
      evidence: null,
    };
  }
  if (
    evidence.replay !== null &&
    (evidence.replay.fixtureRef === null ||
      evidence.replay.fixtureDigest === null)
  ) {
    return {
      record: markBlocked(
        record,
        "missing_evidence",
        "replay fixture not retained",
        now,
      ),
      evidence: null,
    };
  }
  const refs: EvidenceRefV1[] = evidence.artifacts.map((artifact) => ({
    kind: "incident_evidence",
    ref: artifact.ref,
    digest: artifact.digest,
  }));
  return {
    record: {
      ...record,
      evidence: mergeEvidence(record.evidence, refs),
      updatedAt: now,
    },
    evidence,
  };
}

/**
 * Before-replay: the same sanitized fixture/digest against the exact original
 * revision must fail for the intended reason before any model budget is spent.
 */
async function ensureBeforeReplay(
  deps: RepairCycleDepsV1,
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  carry: CarryV1,
): Promise<WorkRecordV1 | null> {
  if (record.source.kind !== "incident") return null;
  // Once a durable causal ReplayResultV1 exists for this exact task and
  // original revision, the intended before-failure is proven and never rerun —
  // including a correction round, whose candidate head is new while the
  // original revision and fixture are unchanged. The durable result supplies
  // the before-run evidence again, so a later candidate can be validated
  // without paying the reproduction another time.
  const already = snapshot.replays.find(
    (result) =>
      result.taskId === record.id &&
      result.original.revision === record.failingRevision,
  );
  if (already !== undefined) {
    carry.beforeRun = {
      outcome: already.original.outcome,
      exitCode: already.original.exitCode,
      output: already.original.output,
      failure: already.original.failure === null ? null : {
        intended: already.original.failure.intended,
        reason: already.original.failure.reason,
      },
      limitations: [],
      startedAt: 0,
      endedAt: 0,
    };
    carry.fixtureRef = already.fixture.ref;
    carry.fixtureDigest = already.fixture.digest;
    carry.testIds = usableTestIds(already.fixture.testIds);
    carry.replayCommandId = already.commands.replay;
    carry.beforeReason = already.expected.beforeReason;
    if (carry.testIds === null) {
      return markBlocked(
        record,
        "missing_evidence",
        "saved replay result has no trusted fixture test identity",
        deps.clock.now(),
      );
    }
    return null;
  }
  const evidence = snapshot.evidence.find(
    (item) => item.id === record.related.incidentId,
  );
  if (evidence === undefined || evidence === null || evidence.replay === null) {
    return markBlocked(
      record,
      "missing_evidence",
      "incident has no replay fixture",
      deps.clock.now(),
    );
  }
  if (record.failingRevision === null) {
    return markBlocked(
      record,
      "missing_evidence",
      "incident has no failing revision",
      deps.clock.now(),
    );
  }
  const replay = evidence.replay;
  const fixtureDigest = replay.fixtureDigest;
  if (fixtureDigest === null) {
    return markBlocked(
      record,
      "missing_evidence",
      "replay fixture digest not retained",
      deps.clock.now(),
    );
  }
  const testIds = await resolveFixtureTestIds(
    deps,
    replay.fixtureRef,
    fixtureDigest,
  );
  if (testIds.kind === "wait") {
    return setWait(
      record,
      { reason: "unavailable", since: deps.clock.now(), until: null },
      deps.clock.now(),
    );
  }
  if (testIds.kind === "invalid") {
    return markBlocked(
      record,
      "missing_evidence",
      "fixture has no trusted test identity",
      deps.clock.now(),
    );
  }
  carry.testIds = testIds.value;
  const run = await deps.replay.runReplay({
    taskId: record.id,
    repository: record.repository,
    revision: record.failingRevision,
    commandId: replay.commandId,
    fixtureRef: replay.fixtureRef,
    fixtureDigest,
    testIds: testIds.value,
    outputLimitBytes: MAX_OUTPUT_LIMIT_BYTES,
  });
  if (!run.ok) {
    return setWait(
      record,
      { reason: "unavailable", since: deps.clock.now(), until: null },
      deps.clock.now(),
    );
  }
  const result = run.value;
  if (
    result.outcome === "failed" && result.failure !== null &&
    result.failure.intended
  ) {
    carry.beforeRun = result;
    carry.fixtureRef = replay.fixtureRef;
    carry.fixtureDigest = fixtureDigest;
    carry.replayCommandId = replay.commandId;
    carry.beforeReason = summaryErrorType(
      snapshot,
      record.fingerprint ?? "",
    );
    return null;
  }
  if (result.outcome === "unavailable") {
    return setWait(
      record,
      { reason: "unavailable", since: deps.clock.now(), until: null },
      deps.clock.now(),
    );
  }
  return markBlocked(
    record,
    "missing_evidence",
    "original revision did not fail for the intended reason",
    deps.clock.now(),
  );
}

function summaryErrorType(
  snapshot: RepairStateSnapshotV1,
  fingerprint: string,
): string {
  const summary = snapshot.incidents.find(
    (incident) => incident.fingerprint === fingerprint,
  );
  return summary?.errorType || "unreported original failure";
}

/**
 * A completed review receipt with unresolved P0/P1 findings bound to the
 * record's CURRENT reviewed head means that head is rejected: the work step
 * must run a fresh bounded implementation and validate the NEW candidate
 * through the replay path before any publication. The rejected candidate is
 * never re-published and never re-reviewed (the frozen contract keeps a
 * head alongside a published PR, so the rejection is read from durable
 * evidence, not from a cleared field).
 */
function headRejectedByReview(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
): boolean {
  const head = record.target.head;
  const pr = record.target.pr;
  if (head === null || pr === null) return false;
  const receipt = snapshot.reviews.find(
    (review) =>
      review.pullRequest.number === pr &&
      review.pullRequest.head === head &&
      review.outcome === "completed",
  );
  return receipt !== undefined && receipt.unresolvedSeverities.length > 0;
}

/** Candidate validation before publication (incident tasks only). */
async function candidateValidated(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  carry: CarryV1,
): Promise<
  | { kind: "blocked"; record: WorkRecordV1 }
  | { kind: "state_error"; detail: string }
  | { kind: "retry" }
  | {
    kind: "ready";
  }
> {
  if (record.source.kind !== "incident") return { kind: "ready" };
  const head = record.target.head;
  if (head === null) return { kind: "retry" };
  const evidence = context.snapshot.evidence.find(
    (item) => item.id === record.related.incidentId,
  );
  if (evidence === undefined || evidence === null || evidence.replay === null) {
    return {
      kind: "blocked",
      record: markBlocked(
        record,
        "missing_evidence",
        "incident has no replay fixture for candidate validation",
        deps.clock.now(),
      ),
    };
  }
  const existing = context.snapshot.replays.find(
    (result) =>
      result.taskId === record.id &&
      result.candidate.revision === head &&
      result.candidate.outcome === "passed",
  );
  if (existing !== undefined) return { kind: "ready" };
  const config = configFor(deps, record.repository);
  if (config === null) {
    return {
      kind: "blocked",
      record: markBlocked(
        record,
        "unavailable",
        "repository not configured",
        deps.clock.now(),
      ),
    };
  }
  const fixtureDigest = evidence.replay.fixtureDigest;
  if (fixtureDigest === null) {
    return {
      kind: "blocked",
      record: markBlocked(
        record,
        "missing_evidence",
        "replay fixture digest not retained",
        deps.clock.now(),
      ),
    };
  }
  const testIds = carry.testIds;
  if (testIds === null) {
    return {
      kind: "blocked",
      record: markBlocked(
        record,
        "missing_evidence",
        "fixture test identity was not carried from before replay",
        deps.clock.now(),
      ),
    };
  }
  const run = await deps.replay.runReplay({
    taskId: record.id,
    repository: record.repository,
    revision: head,
    commandId: config.commands.test,
    fixtureRef: evidence.replay.fixtureRef,
    fixtureDigest,
    testIds,
    outputLimitBytes: MAX_OUTPUT_LIMIT_BYTES,
  });
  if (!run.ok || run.value.outcome === "unavailable") {
    return {
      kind: "blocked",
      record: setWait(
        record,
        { reason: "unavailable", since: deps.clock.now(), until: null },
        deps.clock.now(),
      ),
    };
  }
  if (run.value.outcome !== "passed") {
    return { kind: "retry" };
  }
  // Persist the durable causal ReplayResultV1 with exact identities.
  const result = await buildReplayResult(deps, record, carry, run.value);
  if (result === null) {
    return {
      kind: "blocked",
      record: markBlocked(
        record,
        "other",
        "replay result identity invalid",
        deps.clock.now(),
      ),
    };
  }
  const withEvidence = withReplayEvidence(record, result);
  const persisted = await persistTransition(deps, context, (draft) => {
    const index = draft.work.findIndex((work) => work.id === record.id);
    draft.work[index] = withEvidence;
    if (!draft.replays.some((item) => item.id === result.id)) {
      draft.replays.push(result);
    }
  });
  if (persisted.kind !== "progress") {
    // A failed transition is never converted into a "blocked" write of the
    // ORIGINAL unchanged record: that would make executeWorkStep persist a
    // no-op transition as progress and spin until step_limit. Propagate the
    // real checkpoint failure so the run stops explicitly.
    return persisted.kind === "state_error"
      ? { kind: "state_error", detail: persisted.detail }
      : { kind: "state_error", detail: "candidate replay checkpoint failed" };
  }
  return { kind: "ready" };
}

async function buildReplayResult(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
  carry: CarryV1,
  after: IsolatedReplayResultV1,
): Promise<ReplayResultV1 | null> {
  if (
    carry.beforeRun === null || carry.fixtureRef === null ||
    carry.fixtureDigest === null || carry.testIds === null ||
    carry.replayCommandId === null ||
    record.failingRevision === null || record.target.head === null
  ) {
    return null;
  }
  const config = configFor(deps, record.repository);
  if (config === null) return null;
  const id = await replayResultId(
    record.id,
    record.failingRevision,
    record.target.head,
    carry.fixtureDigest,
  );
  const result = {
    version: "v1" as const,
    kind: "replay_result" as const,
    id,
    taskId: record.id,
    repository: record.repository,
    original: readRun(carry.beforeRun, record.failingRevision),
    candidate: readRun(after, record.target.head),
    fixture: {
      ref: carry.fixtureRef,
      digest: carry.fixtureDigest,
      testIds: carry.testIds,
    },
    commands: { replay: carry.replayCommandId, test: config.commands.test },
    expected: { beforeReason: carry.beforeReason },
    limitations: [],
    createdAt: deps.clock.now(),
  };
  try {
    return parseReplayResultV1(result);
  } catch {
    return null;
  }
}

function readRun(result: IsolatedReplayResultV1, revision: GitSha) {
  return {
    revision,
    outcome: result.outcome,
    exitCode: result.exitCode,
    output: result.output,
    failure: result.failure,
  };
}

function withReplayEvidence(
  record: WorkRecordV1,
  result: ReplayResultV1,
): WorkRecordV1 {
  const ref: EvidenceRefV1 = {
    kind: "replay_result",
    ref: replayEvidenceRef(result.id),
  };
  return {
    ...record,
    evidence: mergeEvidence(record.evidence, [ref]),
    updatedAt: record.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Implementation: durable admission, durable intent, then one run.
// ---------------------------------------------------------------------------

async function executeImplementationStep(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  config: RepositoryConfigV1,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  if (record.counters.attempts >= MAX_IMPLEMENTATION_ATTEMPTS) {
    return persistWork(
      deps,
      context,
      markBlocked(
        record,
        "review_quota",
        "implementation attempt budget exhausted",
        now,
      ),
    );
  }
  const bound = config.sessionBound;
  if (bound === null) {
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "manual", since: now, until: null },
        now,
      ),
    );
  }

  const reservation = await deps.budget.reserveModelStart({
    repository: record.repository,
    taskId: record.id,
    head: record.target.base,
    attempt: record.counters.attempts + 1,
    purpose: record.counters.attempts === 0 ? "implementation" : "retry",
  });
  if (reservation.status === "deferred") {
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "budget_cap", since: now, until: reservation.retryAt },
        now,
      ),
    );
  }
  if (
    reservation.status === "duplicate" ||
    reservation.status === "disabled" ||
    reservation.status === "invalid"
  ) {
    return persistWork(
      deps,
      context,
      markBlocked(
        record,
        "unavailable",
        `model admission refused: ${reservation.status}`,
        now,
      ),
    );
  }
  if (
    reservation.status === "conflict" ||
    reservation.status === "ambiguous" ||
    reservation.status === "unavailable"
  ) {
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "unavailable", since: now, until: null },
        now,
      ),
    );
  }
  const durable = reservation;

  // The reservation write moved the state head; reload before persisting intent.
  const fresh = await loadSnapshot(deps);
  if (fresh === null) {
    return { kind: "state_error", detail: "repair state unavailable" };
  }
  const current = fresh.snapshot.work.find((work) => work.id === record.id);
  if (current === undefined) {
    return {
      kind: "state_error",
      detail: "work record vanished after admission",
    };
  }

  const attempted = startAttempt(current, deps.clock.now());
  const intent = implementationIntent(
    durable.reservation.id,
    attempted,
    deps.clock.now(),
  );
  const withIntent = setIntent(attempted, intent, deps.clock.now());
  const persisted = await persistTransition(
    deps,
    fresh,
    replaceWorkMutation(withIntent),
  );
  if (persisted.kind !== "progress") return persisted;

  // Invocation happens strictly after the durable intent exists.
  const issue = await readIssueForModel(deps, current);
  if (issue === "unavailable") {
    const blocked = await settleAndBlock(
      deps,
      durable.reservation.id,
      "ambiguous",
      withIntent,
      "issue state unavailable before model run",
      deps.clock.now(),
    );
    return persistAfterSettlement(deps, replaceWorkMutation(blocked));
  }

  const receipt = await deps.model.runModel({
    taskId: withIntent.id,
    repository: withIntent.repository,
    base: withIntent.target.base,
    issue,
    evidence: withIntent.evidence,
    model: MODEL_ID,
    reasoning: REASONING,
    maxDurationMs: bound.maxDurationMs,
    maxOutputChars: bound.maxOutputChars,
  });
  if (!receipt.ok) {
    const blocked = await settleAndBlock(
      deps,
      durable.reservation.id,
      "ambiguous",
      withIntent,
      "model run ended without a trusted receipt",
      deps.clock.now(),
    );
    return persistAfterSettlement(deps, replaceWorkMutation(blocked));
  }
  return handleModelReceipt(
    deps,
    fresh,
    withIntent,
    durable.reservation.id,
    receipt.value,
    config,
  );
}

function implementationIntent(
  reservationId: string,
  record: WorkRecordV1,
  now: number,
) {
  return {
    kind: "implementation" as const,
    key: implementationIntentKey(reservationId),
    startedAt: now,
    branch: candidateBranch(record.id),
    expectedHead: null,
    observedBase: record.target.base,
    pr: null,
    requestId: reservationId,
    resultId: null,
  };
}

async function handleModelReceipt(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  reservationId: string,
  receipt: ModelRunReceiptV1,
  config: RepositoryConfigV1,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  const candidate = receipt.candidate;
  const completed = receipt.outcome === "completed" && candidate !== null &&
    candidate.head !== null;
  if (!completed) {
    const blocked = await settleAndBlock(
      deps,
      reservationId,
      "ambiguous",
      record,
      "model run did not complete with a trusted candidate",
      now,
    );
    return persistTransition(deps, context, replaceWorkMutation(blocked));
  }
  const head = candidate!.head!;
  const protectedHit = candidate!.changedPaths.some((path) =>
    touchesProtected(config.protectedPaths, path)
  );
  // A verified bad candidate stays charged (submitted) but never publishes.
  const settled = await deps.budget.settleModelStart({
    id: reservationId,
    outcome: "submitted",
    proofRef: null,
  });
  if (settled.status !== "settled" && settled.status !== "idempotent") {
    return { kind: "state_error", detail: "budget settlement failed" };
  }
  // The settlement write advanced the state; the exact new head must be
  // observed before the candidate transition is persisted (never a stale CAS).
  const afterSettlement = await loadSnapshot(deps);
  if (afterSettlement === null) {
    return { kind: "state_error", detail: "repair state unavailable" };
  }
  // A completed run closes the implementation operation: the intent is
  // cleared only after the candidate is durably noted (never on uncertain
  // outcomes, where it remains as the manual-disposition record).
  const withCandidate = noteCandidate(clearIntent(record, now), {
    head,
    checkpoint: candidate!.checkpointSha === null
      ? null
      : { branch: candidateBranch(record.id), sha: candidate!.checkpointSha },
  }, now);
  if (protectedHit) {
    const blocked = markBlocked(
      withCandidate,
      "other",
      "candidate touches a protected path",
      now,
    );
    const r1 = await persistTransition(
      deps,
      afterSettlement,
      replaceWorkMutation(blocked),
    );
    return r1;
  }
  return persistTransition(
    deps,
    afterSettlement,
    replaceWorkMutation(withCandidate),
  );
}

async function settleAndBlock(
  deps: RepairCycleDepsV1,
  reservationId: string,
  outcome: "submitted" | "ambiguous",
  record: WorkRecordV1,
  message: string,
  now: number,
): Promise<WorkRecordV1> {
  // Settlement is done before the record moves: an uncertain start must be
  // charged (ambiguous) before the task is blocked for authoritative
  // disposition; a proven completed run settles as submitted.
  await deps.budget.settleModelStart({
    id: reservationId,
    outcome,
    proofRef: null,
  });
  return markBlocked(record, "other", message, now);
}

/**
 * Persist a record transition after a settlement write: the settlement moved
 * the authoritative head, so the exact new state is reread first and the
 * transition is applied against it (never a stale CAS reapply).
 */
async function persistAfterSettlement(
  deps: RepairCycleDepsV1,
  mutate: (draft: RepairStateSnapshotV1) => void,
): Promise<StepResultV1> {
  const fresh = await loadSnapshot(deps);
  if (fresh === null) {
    return { kind: "state_error", detail: "repair state unavailable" };
  }
  return persistTransition(deps, fresh, mutate);
}

/** Saved implementation uncertainty: charged ambiguous, blocked, never rerun. */
async function handleImplementationUncertainty(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  const reservationId = record.intent?.requestId;
  if (
    reservationId !== null && reservationId !== undefined &&
    reservationId !== ""
  ) {
    await deps.budget.settleModelStart({
      id: reservationId,
      outcome: "ambiguous",
      proofRef: null,
    });
  }
  return persistTransition(
    deps,
    context,
    replaceWorkMutation(markBlocked(
      record,
      "other",
      "implementation outcome uncertain; awaiting authoritative disposition",
      deps.clock.now(),
    )),
  );
}

// ---------------------------------------------------------------------------
// Publish phase (also reconciles every saved operation by exact remote object).
// ---------------------------------------------------------------------------

async function executePublishStep(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  config: RepositoryConfigV1,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  const head = record.target.head;
  if (head === null) {
    return { kind: "state_error", detail: "publish without candidate head" };
  }
  const branch = candidateBranch(record.id);

  if (record.intent !== null) {
    return reconcilePublishIntent(deps, context, record, config);
  }

  // The unfinished-PR cap applies only to FRESH publications. A correction of
  // an existing PR does not open another unfinished PR — it updates the branch
  // this task already owns — so it must never be blocked by the cap (matching
  // the selection rule, which caps only records with target.pr === null).
  const openPrs =
    context.snapshot.work.filter((work) =>
      work.target.pr !== null && work.nextStep !== "done"
    ).length;
  if (record.target.pr === null && openPrs >= MAX_UNFINISHED_PRS) {
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "backoff", since: now, until: now + CHECK_POLL_MS },
        now,
      ),
    );
  }

  // Push the exact candidate. For an existing PR the branch is updated only
  // against its current remote head (expected-ref compare, never a blind force).
  let expectedRemoteHead: GitSha | null = null;
  if (record.target.pr !== null) {
    const ref = await deps.github.readRef(`refs/heads/${branch}`);
    if (!ref.ok || ref.value === null) {
      return persistWork(
        deps,
        context,
        setWait(
          record,
          { reason: "unavailable", since: now, until: null },
          now,
        ),
      );
    }
    expectedRemoteHead = ref.value.sha;
  }
  const pushIntent = {
    kind: "push" as const,
    key: pushIntentKey(head),
    startedAt: now,
    branch,
    expectedHead: head,
    observedBase: record.target.base,
    pr: null,
    requestId: null,
    resultId: null,
  };
  const withIntent = setIntent(record, pushIntent, now);
  const persisted = await persistWork(deps, context, withIntent);
  if (persisted.kind !== "progress") return persisted;

  const push = await deps.github.pushHead(
    `refs/heads/${branch}`,
    head,
    expectedRemoteHead,
  );
  if (!push.ok) {
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "unavailable", since: now, until: null },
        now,
      ),
    );
  }
  if (push.value === "ambiguous") {
    return { kind: "progress" }; // reconciled next run by exact ref read
  }
  const pushedRecord = { ...record, updatedAt: now };
  if (record.target.pr !== null) {
    // Existing PR: new head needs a fresh review request, same branch.
    return requestReviewFor(deps, context, pushedRecord, record.target.pr);
  }
  return createPullRequestFor(deps, context, pushedRecord, config);
}

async function createPullRequestFor(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  config: RepositoryConfigV1,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  const head = record.target.head!;
  const branch = candidateBranch(record.id);
  const intent = {
    kind: "pull_request" as const,
    key: pullRequestIntentKey(head),
    startedAt: now,
    branch,
    expectedHead: head,
    observedBase: record.target.base,
    pr: null,
    requestId: null,
    resultId: null,
  };
  const withIntent = setIntent(record, intent, now);
  const persisted = await persistWork(deps, context, withIntent);
  if (persisted.kind !== "progress") return persisted;

  const title = record.source.kind === "incident"
    ? `Sentinel repair: ${record.source.id}`
    : `Sentinel repair: issue ${record.related.issueNumber}`;
  // No auto-close keywords anywhere in the title or body ("Refs" is inert).
  const created = await deps.github.createPullRequest({
    title: title.slice(0, 200),
    headRef: branch,
    baseRef: config.baseBranch,
    body:
      `Sentinel repair for ${record.source.kind} ${record.source.id}. Refs: ${
        record.related.issueNumber ?? ""
      }`.trim(),
    expectedBase: record.target.base,
    expectedHeadRef: head,
  });
  if (!created.ok) {
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "unavailable", since: now, until: null },
        now,
      ),
    );
  }
  if (created.value.outcome === "ambiguous") {
    return { kind: "progress" }; // reconciled next run by deterministic head ref
  }
  if (created.value.number === null || created.value.head !== head) {
    return persistWork(
      deps,
      context,
      markBlocked(
        record,
        "other",
        "PR publication identity mismatch",
        now,
      ),
    );
  }
  const withPr: WorkRecordV1 = {
    ...record,
    target: { ...record.target, pr: created.value.number },
    updatedAt: now,
  };
  const acknowledged = await persistWork(deps, context, withPr);
  if (acknowledged.kind !== "progress") return acknowledged;
  return requestReviewFor(deps, context, withPr, created.value.number);
}

async function requestReviewFor(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  prNumber: number,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  const head = record.target.head!;
  const operationKey = reviewOperationKey(prNumber, head);

  // Review requests share the one rolling model-start budget: durable
  // admission precedes invocation, with a deterministic task/head/round
  // identity, so observation/recovery never resubmits or adds a second
  // charge. No budget bypass exists here — requestReview is a GitHubPort
  // method and admission failure simply prevents invocation.
  const reservation = await deps.budget.reserveModelStart({
    repository: record.repository,
    taskId: record.id,
    head,
    attempt: record.counters.reviewRounds + 1,
    purpose: "review_request",
  });
  if (reservation.status === "deferred") {
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "budget_cap", since: now, until: reservation.retryAt },
        now,
      ),
    );
  }
  if (
    reservation.status === "duplicate" &&
    reservation.reservation.outcome !== "reserved"
  ) {
    // The same review identity was already admitted and settled, but its
    // operation intent is gone: a state contradiction, never a re-invocation.
    return persistWork(
      deps,
      context,
      markBlocked(
        record,
        "unavailable",
        "review admission already settled without an intent",
        now,
      ),
    );
  }
  if (reservation.status === "disabled" || reservation.status === "invalid") {
    return persistWork(
      deps,
      context,
      markBlocked(
        record,
        "unavailable",
        `review admission refused: ${reservation.status}`,
        now,
      ),
    );
  }
  if (
    reservation.status === "conflict" ||
    reservation.status === "ambiguous" ||
    reservation.status === "unavailable"
  ) {
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "unavailable", since: now, until: null },
        now,
      ),
    );
  }
  // admitted, or duplicate whose prior reservation is still reserved: the
  // identical admission is completed exactly once, never charged twice.
  const reservationId = reservation.reservation.id;

  // The admission write moved the state head; reload before persisting intent.
  const fresh = await loadSnapshot(deps);
  if (fresh === null) {
    return { kind: "state_error", detail: "repair state unavailable" };
  }
  const current = fresh.snapshot.work.find((work) => work.id === record.id);
  if (current === undefined) {
    return {
      kind: "state_error",
      detail: "work record vanished after review admission",
    };
  }
  const intent = {
    kind: "review_request" as const,
    key: operationKey,
    startedAt: now,
    branch: candidateBranch(record.id),
    expectedHead: head,
    observedBase: current.target.base,
    pr: prNumber,
    requestId: reservationId,
    resultId: null,
  };
  const withIntent = setIntent(current, intent, now);
  const persisted = await persistTransition(
    deps,
    fresh,
    replaceWorkMutation(withIntent),
  );
  if (persisted.kind !== "progress") return persisted;

  // Invocation happens strictly after the durable intent exists.
  const submitted = await deps.github.requestReview({
    prNumber,
    expectedHead: head,
    expectedBase: current.target.base,
    expectedReviewer: EXPECTED_REVIEWER,
    operationKey,
  });
  if (!submitted.ok) {
    // The response may have been lost after submission: the start stays
    // charged as ambiguous and the saved intent makes the next run observe
    // the exact remote review state instead of resubmitting.
    const settled = await settleReviewCharge(
      deps,
      reservationId,
      "ambiguous",
    );
    if (settled.kind !== "progress") return settled;
    return { kind: "progress" }; // observed next run; never re-request blindly
  }
  if (submitted.value.outcome === "ambiguous") {
    const settled = await settleReviewCharge(
      deps,
      reservationId,
      "ambiguous",
    );
    if (settled.kind !== "progress") return settled;
    return { kind: "progress" }; // observed next run; never re-request blindly
  }
  const settled = await settleReviewCharge(
    deps,
    reservationId,
    "submitted",
  );
  if (settled.kind !== "progress") return settled;
  return persistAfterSettlement(
    deps,
    replaceWorkMutation(
      advanceToReview(
        countReviewRound(clearIntent(withIntent, now), now),
        { pr: prNumber, head },
        {
          reason: "review_pending",
          since: submitted.value.requestedAt,
          until: Math.max(now, submitted.value.requestedAt) + REVIEW_POLL_MS,
        },
        now,
      ),
    ),
  );
}

/**
 * Durable settlement of one review admission. "ambiguous" preserves the
 * charge for a lost/uncertain response; "submitted" records the confirmed
 * invocation. An already-charged terminal outcome is idempotent in effect and
 * never adds a second charge; a contradictory terminal outcome stops safely.
 */
async function settleReviewCharge(
  deps: RepairCycleDepsV1,
  reservationId: string,
  outcome: "submitted" | "ambiguous",
): Promise<StepResultV1> {
  const settled = await deps.budget.settleModelStart({
    id: reservationId,
    outcome,
    proofRef: null,
  });
  if (settled.status === "settled" || settled.status === "idempotent") {
    return { kind: "progress" };
  }
  if (settled.status === "invalid") {
    // A contradictory terminal outcome: reconcile the exact reservation
    // before deciding. An already charged (submitted/ambiguous) reservation
    // preserves the charge; anything else fails closed.
    const read = await loadSnapshot(deps);
    if (read === null) {
      return { kind: "state_error", detail: "repair state unavailable" };
    }
    const existing = read.snapshot.reservations.find(
      (item) => item.id === reservationId,
    );
    if (
      existing !== undefined &&
      (existing.outcome === "submitted" || existing.outcome === "ambiguous")
    ) {
      return { kind: "progress" };
    }
    return { kind: "state_error", detail: "review charge contradiction" };
  }
  return { kind: "state_error", detail: "review budget settlement failed" };
}

async function reconcilePublishIntent(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  config: RepositoryConfigV1,
): Promise<StepResultV1> {
  const intent = record.intent!;
  const now = deps.clock.now();
  if (intent.kind === "push") {
    const ref = await deps.github.readRef(`refs/heads/${intent.branch}`);
    if (!ref.ok) {
      return persistWork(
        deps,
        context,
        setWait(
          record,
          { reason: "unavailable", since: now, until: null },
          now,
        ),
      );
    }
    if (ref.value === null) {
      // The push provably never applied: a new push with expectedRef null is
      // deterministic and non-duplicating.
      const cleared = clearIntent(record, now);
      return persistWork(deps, context, cleared); // next step re-pushes
    }
    if (ref.value.sha !== intent.expectedHead) {
      return persistWork(
        deps,
        context,
        markBlocked(
          record,
          "other",
          "candidate branch ref identity mismatch",
          now,
        ),
      );
    }
    const cleared = {
      ...clearIntent(record, now),
      target: { ...record.target },
    };
    const persisted = await persistWork(deps, context, cleared);
    if (persisted.kind !== "progress") return persisted;
    // The push may have succeeded immediately before the process stopped. The
    // exact ref observation above is the publication proof; continue the same
    // publication sequence now so a bounded run does not leave a pushed branch
    // without its PR (or its next review request).
    if (cleared.target.pr !== null) {
      return requestReviewFor(deps, context, cleared, cleared.target.pr);
    }
    return createPullRequestFor(deps, context, cleared, config);
  }
  if (intent.kind === "pull_request") {
    if (intent.branch === null) {
      return {
        kind: "state_error",
        detail: "PR intent without branch identity",
      };
    }
    const pr = await deps.github.findPullRequestByHeadRef(intent.branch);
    if (!pr.ok) {
      return persistWork(
        deps,
        context,
        setWait(
          record,
          { reason: "unavailable", since: now, until: null },
          now,
        ),
      );
    }
    if (pr.value !== null && pr.value.head === intent.expectedHead) {
      const updated = clearIntent(
        { ...record, target: { ...record.target, pr: pr.value.number } },
        now,
      );
      return persistWork(deps, context, updated);
    }
    if (pr.value !== null) {
      return persistWork(
        deps,
        context,
        markBlocked(
          record,
          "other",
          "PR head identity mismatch",
          now,
        ),
      );
    }
    return createPullRequestFor(
      deps,
      context,
      clearIntent(record, now),
      config,
    );
  }
  if (intent.kind === "review_request") {
    const prNumber = intent.pr;
    const head = intent.expectedHead;
    if (prNumber === null || head === null) {
      return { kind: "state_error", detail: "review intent identity missing" };
    }
    // Recovery observes the exact remote review state. The admission charge
    // is preserved as ambiguous (submission may have happened); it is never
    // resubmitted and never charged a second time.
    if (intent.requestId !== null) {
      const settled = await settleReviewCharge(
        deps,
        intent.requestId,
        "ambiguous",
      );
      if (settled.kind !== "progress") return settled;
    }
    const afterSettlement = await loadSnapshot(deps);
    if (afterSettlement === null) {
      return { kind: "state_error", detail: "repair state unavailable" };
    }
    const current = afterSettlement.snapshot.work.find(
      (work) => work.id === record.id,
    );
    if (current === undefined) {
      return {
        kind: "state_error",
        detail: "work record missing after review reconciliation",
      };
    }
    const withPr = {
      ...current,
      target: { ...current.target, pr: prNumber, head },
      nextStep: "review" as const,
      updatedAt: now,
    };
    const persisted = await persistWork(deps, afterSettlement, withPr);
    if (persisted.kind !== "progress") return persisted;
    return observeReview(deps, afterSettlement, withPr);
  }
  return { kind: "state_error", detail: "unsupported publish intent" };
}

// ---------------------------------------------------------------------------
// Review phase.
// ---------------------------------------------------------------------------

async function observeReview(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  const pr = record.target.pr;
  const head = record.target.head;
  if (pr === null || head === null) {
    return { kind: "state_error", detail: "review without PR/head identity" };
  }
  const observed = await deps.github.observeReview({
    operationKey: reviewOperationKey(pr, head),
    prNumber: pr,
    head,
  });
  if (!observed.ok) {
    const since = reviewWaitSince(record, now);
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "unavailable", since, until: now + REVIEW_POLL_MS },
        now,
      ),
    );
  }
  const value = observed.value;
  if (value.status === "pending" || value.status === "unavailable") {
    const since = reviewWaitSince(record, now);
    return persistWork(
      deps,
      context,
      setWait(
        record,
        {
          reason: "review_pending",
          since,
          until: Math.max(now, since) + REVIEW_POLL_MS,
        },
        now,
      ),
    );
  }
  return applyObservedReview(deps, context, record, value);
}

async function applyObservedReview(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  value: ReviewObservationV1,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  if (value.observedHead !== record.target.head) {
    // A review of a different head never advances this task; one pending
    // request per head remains pending and no receipt is synthesized.
    const since = reviewWaitSince(record, now);
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "review_pending", since, until: now + REVIEW_POLL_MS },
        now,
      ),
    );
  }
  const operationKey = reviewOperationKey(
    record.target.pr!,
    record.target.head!,
  );
  const id = await reviewReceiptId(operationKey, value.observedHead!);
  let receipt: ReviewReceiptV1;
  try {
    receipt = parseReviewReceiptV1({
      version: "v1",
      kind: "review_receipt",
      id,
      requestId: value.requestId,
      expectedReviewer: EXPECTED_REVIEWER,
      observedReviewer: value.reviewer,
      repository: record.repository,
      pullRequest: {
        number: record.target.pr!,
        head: value.observedHead!,
        base: value.observedBase ?? record.target.base,
      },
      outcome: value.status,
      resultId: value.resultId,
      summary: value.summary,
      findings: value.findings,
      findingsUncounted: 0,
      // Derive the distinct, canonical severity set before parsing. A review
      // may report several findings at one severity; passing duplicates makes
      // the strict receipt parser reject an otherwise valid result.
      unresolvedSeverities: deriveUnresolvedSeverities(value.findings),
      submittedAt: reviewWaitSince(record, now),
      completedAt: value.completedAt,
      observedAt: value.receivedAt,
    });
  } catch {
    const since = reviewWaitSince(record, now);
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "review_pending", since, until: now + REVIEW_POLL_MS },
        now,
      ),
    );
  }
  const unresolved = receipt.unresolvedSeverities.length > 0;
  const withEvidence: WorkRecordV1 = {
    ...record,
    evidence: mergeEvidence(record.evidence, [{
      kind: "review_receipt",
      ref: reviewEvidenceRef(receipt.id),
    }]),
    updatedAt: now,
  };
  return persistTransition(deps, context, (draft) => {
    const index = draft.work.findIndex((work) => work.id === record.id);
    draft.work[index] = unresolved
      ? advanceToCorrection(clearIntent(withEvidence, now), now)
      : advanceToDelivery(clearIntent(withEvidence, now), now);
    if (!draft.reviews.some((review) => review.id === receipt.id)) {
      draft.reviews.push(receipt);
    }
  });
}

// ---------------------------------------------------------------------------
// Delivery phase: merge → release request → acceptance → closure.
// ---------------------------------------------------------------------------

function executeDeliveryStep(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  if (record.target.pr === null || record.target.head === null) {
    return Promise.resolve({
      kind: "state_error",
      detail: "delivery without PR/head identity",
    });
  }

  if (record.intent !== null) {
    if (record.intent.kind === "issue_closure") {
      return retryClosure(deps, context, record);
    }
    if (record.intent.kind === "merge") {
      return reconcileMergeIntent(deps, context, record);
    }
  }

  // Look up the durable release request by its SOURCE identity (exact PR and
  // reviewed head); the request's `revision` is the merged revision, which is
  // never the candidate head, so it cannot be the lookup key. Retaining the
  // merged revision inside the matched request keeps one exact request per
  // PR/head and never replays a merge or fabricates a duplicate request.
  const existingRequest = context.snapshot.releaseRequests.find(
    (request) =>
      request.source.pullRequest === record.target.pr &&
      request.source.head === record.target.head,
  );
  if (existingRequest !== undefined) {
    return observeReleaseAcceptance(deps, context, record, existingRequest);
  }
  return executeMerge(deps, context, record);
}

async function executeMerge(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  const config = configFor(deps, record.repository);
  const receipt = context.snapshot.reviews.find((review) =>
    review.pullRequest.number === record.target.pr &&
    review.pullRequest.head === record.target.head &&
    review.outcome === "completed"
  );
  if (config === null || receipt === undefined || receipt === null) {
    return { kind: "state_error", detail: "merge without accepted review" };
  }
  let mergeRequest;
  try {
    mergeRequest = parseMergeRequestV1({
      pullRequestNumber: record.target.pr!,
      expectedHead: record.target.head!,
      expectedBase: record.target.base,
      review: receipt,
    }, {
      repository: record.repository,
      expectedReviewer: EXPECTED_REVIEWER,
    });
  } catch {
    // A receipt that no longer authorizes (identity/cleanliness mismatch)
    // requires authoritative disposition, not a blind re-submission.
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "review_pending", since: now, until: null },
        now,
      ),
    );
  }
  const intent = {
    kind: "merge" as const,
    key: mergeIntentKey(record.target.pr!, record.target.head!),
    startedAt: now,
    branch: candidateBranch(record.id),
    expectedHead: record.target.head,
    observedBase: record.target.base,
    pr: record.target.pr,
    requestId: receipt.requestId,
    resultId: receipt.resultId,
  };
  const withIntent = setIntent(record, intent, now);
  const persisted = await persistWork(deps, context, withIntent);
  if (persisted.kind !== "progress") return persisted;

  const merged = await deps.github.mergePullRequest(mergeRequest);
  if (!merged.ok) {
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "unavailable", since: now, until: now + CHECK_POLL_MS },
        now,
      ),
    );
  }
  return handleMergeOutcome(deps, context, record, merged.value);
}

async function handleMergeOutcome(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  outcome: MergeOutcomeV1,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  if (outcome.outcome === "merged") {
    const cleared = clearIntent(record, now);
    const receipt = context.snapshot.reviews.find((review) =>
      review.pullRequest.number === record.target.pr &&
      review.pullRequest.head === record.target.head &&
      review.outcome === "completed"
    ) ?? null;
    const request = await buildReleaseRequest(deps, record, outcome, receipt);
    if (request === null) {
      return persistWork(
        deps,
        context,
        markBlocked(
          cleared,
          "other",
          "release request identity invalid",
          now,
        ),
      );
    }
    return persistTransition(deps, context, (draft) => {
      const index = draft.work.findIndex((work) =>
        work.id === record.id
      );
      draft.work[index] = { ...cleared, updatedAt: now };
      if (!draft.releaseRequests.some((item) => item.id === request.id)) {
        draft.releaseRequests.push(request);
      }
    });
  }
  if (outcome.outcome === "ambiguous") {
    return { kind: "progress" }; // reconciled via readPullRequest next run
  }
  const reason = outcome.reason;
  if (
    reason === "checks_pending" || reason === "conflict" ||
    reason === "review_required"
  ) {
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "backoff", since: now, until: now + CHECK_POLL_MS },
        now,
      ),
    );
  }
  return persistWork(
    deps,
    context,
    setWait(
      record,
      { reason: "backoff", since: now, until: now + CHECK_POLL_MS },
      now,
    ),
  );
}

async function reconcileMergeIntent(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  if (record.target.pr === null || record.target.head === null) {
    return { kind: "state_error", detail: "merge intent without identity" };
  }
  const pr = await deps.github.readPullRequest(record.target.pr);
  if (!pr.ok) {
    return persistWork(
      deps,
      context,
      setWait(
        record,
        {
          reason: "unavailable",
          since: deps.clock.now(),
          until: deps.clock.now() + CHECK_POLL_MS,
        },
        deps.clock.now(),
      ),
    );
  }
  const pull = pr.value;
  if (pull === null) {
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "unavailable", since: deps.clock.now(), until: null },
        deps.clock.now(),
      ),
    );
  }
  if (pull.state === "merged" && pull.mergeSha !== null) {
    if (pull.head !== record.target.head) {
      // Reconcile only the head this task reviewed: an observed merged head
      // different from the saved reviewed head is an identity contradiction
      // and must never produce a release request for the wrong revision.
      return persistWork(
        deps,
        context,
        markBlocked(
          record,
          "other",
          "observed merged head identity mismatch",
          deps.clock.now(),
        ),
      );
    }
    return handleMergeOutcome(deps, context, record, {
      outcome: "merged",
      head: pull.head,
      mergeSha: pull.mergeSha,
    });
  }
  if (pull.state === "closed") {
    return persistWork(
      deps,
      context,
      markBlocked(
        record,
        "other",
        "pull request closed before merge",
        deps.clock.now(),
      ),
    );
  }
  return executeMerge(deps, context, record);
}

async function buildReleaseRequest(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
  outcome: { head: GitSha | null; mergeSha: GitSha | null },
  receipt: ReviewReceiptV1 | null,
): Promise<ReleaseRequestV1 | null> {
  const head = outcome.head ?? record.target.head;
  const revision = outcome.mergeSha ?? head;
  if (record.target.pr === null || head === null || revision === null) {
    return null;
  }
  const id = await releaseRequestId(
    record.repository,
    revision,
    record.target.pr,
  );
  const request: ReleaseRequestV1 = {
    version: "v1",
    kind: "release_request",
    id,
    target: { repository: record.repository, environment: "production" },
    revision,
    source: {
      pullRequest: record.target.pr,
      reviewRequestId: receipt?.requestId ?? "",
      reviewReceiptId: receipt?.id ?? null,
      head,
      base: record.target.base,
    },
    status: "open",
    failureReason: null,
    createdAt: deps.clock.now(),
  };
  try {
    return parseReleaseRequestV1(request);
  } catch {
    return null;
  }
}

async function observeReleaseAcceptance(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  request: ReleaseRequestV1,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  const release = await deps.state.readRelease();
  if (!release.ok || release.value.status !== "found") {
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "unavailable", since: now, until: now + RELEASE_POLL_MS },
        now,
      ),
    );
  }
  const observed = release.value.snapshot.releases.find(
    (item) => item.requestId === request.id,
  );
  if (observed === undefined) {
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "unavailable", since: now, until: now + RELEASE_POLL_MS },
        now,
      ),
    );
  }
  if (observed.phase === "accepted") {
    if (record.related.issueNumber === null) {
      return persistWork(deps, context, markDone(record, now));
    }
    const intent = {
      kind: "issue_closure" as const,
      key: closureIntentKey(record.related.issueNumber),
      startedAt: now,
      branch: null,
      expectedHead: record.target.head,
      observedBase: record.target.base,
      pr: record.target.pr,
      requestId: request.id,
      resultId: null,
    };
    const withIntent = setIntent(record, intent, now);
    const persisted = await persistWork(deps, context, withIntent);
    if (persisted.kind !== "progress") return persisted;
    return retryClosure(deps, context, withIntent);
  }
  if (observed.phase === "failed" || observed.phase === "rolled_back") {
    return persistWork(
      deps,
      context,
      markBlocked(
        record,
        "other",
        `release ${observed.phase}`,
        now,
      ),
    );
  }
  return persistWork(
    deps,
    context,
    setWait(
      record,
      { reason: "unavailable", since: now, until: now + RELEASE_POLL_MS },
      now,
    ),
  );
}

async function retryClosure(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  const issueNumber = record.related.issueNumber;
  if (issueNumber === null) {
    return persistWork(
      deps,
      context,
      markDone(clearIntent(record, deps.clock.now()), deps.clock.now()),
    );
  }
  const now = deps.clock.now();
  const closed = await deps.github.closeIssue(issueNumber);
  if (!closed.ok) {
    // Closure-only retry: the issue_closure intent remains and only the
    // closure operation is retried.
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "unavailable", since: now, until: now + CHECK_POLL_MS },
        now,
      ),
    );
  }
  return persistWork(deps, context, markDone(clearIntent(record, now), now));
}

// ---------------------------------------------------------------------------
// Helpers (deterministic; no product logic in fakes).
// ---------------------------------------------------------------------------

type FixtureTestIdsResultV1 =
  | { kind: "ok"; value: string[] }
  | { kind: "invalid" }
  | { kind: "wait" };

/**
 * Resolve fixture identities only through a trusted host capability. The
 * ReplayPort contract deliberately does not expose its internal resolver, so
 * an absent capability is missing evidence rather than permission to invent a
 * test id. A replay object may implement the same read-only capability when
 * the host uses one object for both execution and fixture resolution.
 */
async function resolveFixtureTestIds(
  deps: RepairCycleDepsV1,
  fixtureRef: string,
  fixtureDigest: FixtureDigest,
): Promise<FixtureTestIdsResultV1> {
  const replayWithIdentity = deps.replay as
    & ReplayPort
    & Partial<ReplayFixtureIdentitySourceV1>;
  const resolveTestIds = deps.fixtureIdentities?.resolveTestIds ??
    (typeof replayWithIdentity.resolveTestIds === "function"
      ? replayWithIdentity.resolveTestIds.bind(replayWithIdentity)
      : null);
  if (resolveTestIds === null) return { kind: "invalid" };
  let resolved: PortResultV1<readonly string[]>;
  try {
    resolved = await resolveTestIds(fixtureRef, fixtureDigest);
  } catch {
    return { kind: "wait" };
  }
  if (!resolved.ok) return { kind: "wait" };
  const value = usableTestIds(resolved.value);
  return value === null ? { kind: "invalid" } : { kind: "ok", value };
}

/** Validate the small identity shape before handing it to ReplayPort. */
function usableTestIds(value: readonly string[]): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    return null;
  }
  const seen = new Set<string>();
  for (const id of value) {
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9._:-]{1,64}$/.test(id) ||
      seen.has(id)
    ) {
      return null;
    }
    seen.add(id);
  }
  return [...value];
}

async function readIssueForModel(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
): Promise<
  { number: number; title: string; body: string } | null | "unavailable"
> {
  const issueNumber = record.related.issueNumber;
  if (issueNumber === null) return null;
  const read = await deps.github.readIssue(issueNumber);
  if (!read.ok) return "unavailable";
  if (read.value === null) return "unavailable";
  return {
    number: read.value.number,
    title: read.value.title,
    body: read.value.body,
  };
}

async function readBase(
  deps: RepairCycleDepsV1,
  repository: RepositoryIdentityV1,
): Promise<GitSha | null> {
  const config = configFor(deps, repository);
  if (config === null) return null;
  const ref = await deps.github.readRef(`refs/heads/${config.baseBranch}`);
  return ref.ok && ref.value !== null ? ref.value.sha : null;
}

function configFor(
  deps: RepairCycleDepsV1,
  repository: RepositoryIdentityV1,
): RepositoryConfigV1 | null {
  return deps.configs.find(
    (config) =>
      config.repository.owner === repository.owner &&
      config.repository.name === repository.name,
  ) ?? null;
}

function touchesProtected(
  protectedPaths: readonly string[],
  path: string,
): boolean {
  const candidate = normalizePathPrefix(path);
  return protectedPaths.some(
    (protectedPath) => {
      const prefix = normalizePathPrefix(protectedPath);
      if (prefix.length === 0) return true;
      return candidate === prefix ||
        candidate.startsWith(`${prefix}/`) ||
        prefix.startsWith(`${candidate}/`);
    },
  );
}

/** Normalize trusted repository-relative path prefixes before boundary checks. */
function normalizePathPrefix(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

/** Preserve the exact request timestamp across durable review waits. */
function reviewWaitSince(record: WorkRecordV1, fallback: number): number {
  if (
    record.wait?.reason === "review_pending" ||
    record.wait?.reason === "unavailable"
  ) return record.wait.since;
  if (record.intent?.kind === "review_request") {
    return record.intent.startedAt;
  }
  return Math.min(record.updatedAt, fallback);
}

function mergeEvidence(
  evidence: readonly EvidenceRefV1[],
  next: readonly EvidenceRefV1[],
): EvidenceRefV1[] {
  const merged = [...evidence];
  for (const ref of next) {
    if (
      !merged.some(
        (existing) => existing.kind === ref.kind && existing.ref === ref.ref,
      )
    ) {
      merged.push(ref);
    }
  }
  return merged;
}

/** Deterministic change test: an unchanged summary must not rewrite state. */
function summaryChanged(
  previous: RepairStateSnapshotV1["incidents"][number],
  next: RepairStateSnapshotV1["incidents"][number],
): boolean {
  return next.count !== previous.count ||
    next.lastSeenAt !== previous.lastSeenAt ||
    next.severity !== previous.severity ||
    next.context.message !== previous.context.message ||
    next.coverage.status !== previous.coverage.status ||
    JSON.stringify(next.evidenceRef) !== JSON.stringify(previous.evidenceRef);
}

function idleDetail(
  snapshot: RepairStateSnapshotV1,
  skipped: Record<string, string>,
): string {
  const terminal = snapshot.work.filter((record) => record.nextStep === "done")
    .length;
  const blocked =
    snapshot.work.filter((record) => record.nextStep === "blocked")
      .length;
  const waiting =
    Object.values(skipped).filter((reason) => reason === "waiting")
      .length;
  return (
    `${snapshot.work.length} records: ${terminal} terminal, ` +
    `${blocked} blocked, ${waiting} waiting`
  );
}
