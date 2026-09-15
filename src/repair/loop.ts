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
import { isGitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type {
  Clock,
  GitHubCooldownGateV1,
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
import { BASE_REFRESH_CONFLICT_DETAIL } from "../contracts/ports.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { IncidentEvidenceV1 } from "../contracts/incident.ts";
import { parseMergeRequestV1 } from "../contracts/merge-request.ts";
import { parseReleaseRequestV1 } from "../contracts/release.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import {
  localReceiptBindsRequest,
  parseLocalReleaseReceiptV1,
} from "../contracts/local-release.ts";
import type { LocalReleaseReceiptV1 } from "../contracts/local-release.ts";
import {
  hostedReceiptBindsRequest,
  parseHostedReleaseRecordV1,
} from "../contracts/hosted-supervisor.ts";
import type { HostedReleaseRecordV1 } from "../contracts/hosted-supervisor.ts";
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
import type {
  IncompleteOperationV1,
  WorkRecordV1,
} from "../contracts/work-record.ts";
import { hasCandidateState } from "../contracts/work-record.ts";
import type { BudgetControllerV1 } from "../budget/mod.ts";
import { MAX_REVIEW_TOTAL_MS } from "../github/codex-reviewer.ts";
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

// Private finite constants (no new env/secret/CLI surface is introduced).
const INCIDENT_PAGE_LIMIT = 20;
/** Full structured-review bound (one start through bounded close). */
const REVIEW_BOUND_MS = MAX_REVIEW_TOTAL_MS;
// Finite incident-scan page bound for the ACTUAL intake consumer. The gateway
// adapter's private readIncident scan enforces its own bounds, but those do
// not protect this pagination loop; a misbehaving producer (empty pages,
// never-terminating cursor, an injected frozen clock that never crosses the
// run deadline) must stop here instead of spinning. Same deterministic bound
// as the adapter's private scan (GATEWAY_MAX_SCAN_PAGES); local constant, no
// cross-module dependency and no new configuration surface.
const MAX_INCIDENT_SCAN_PAGES = 128;
const REVIEW_POLL_MS = 15 * 60_000;
const CHECK_POLL_MS = 5 * 60_000;
const RELEASE_POLL_MS = 5 * 60_000;
/**
 * Recheck interval for a native GitHub issue prerequisite that could not be
 * verified (closed/absent issue, unknown relations, parent or open native
 * blocker). One hour matches the polling cadence and costs no reservation:
 * the re-read happens on the next hourly poll.
 */
const ISSUE_PREREQUISITE_RETRY_MS = 60 * 60_000;
/**
 * The one five-minute finalization margin. The entrypoint reserves it OUTSIDE
 * the loop deadline (the cycle receives hardDeadline - this margin) so the
 * mandatory bounded review drain fits before the caller/ceiling hard deadline;
 * per-operation fit checks inside the loop stay conservative.
 */
export const OPERATION_MARGIN_MS = 5 * 60_000;
const DEFAULT_STEP_LIMIT = 32;

/** Fixed repair job ceiling (plan §4): 120 minutes. */
export const REPAIR_RUN_CEILING_MS = 120 * 60_000;
/** No NEW model work may start after 90 minutes of one run (plan §4). */
export const REPAIR_MODEL_CUTOFF_MS = 90 * 60_000;
const MAX_IMPLEMENTATION_ATTEMPTS = 4;
const MAX_OUTPUT_LIMIT_BYTES = 4096;
const MODEL_ID = "gpt-5.6-luna" as const;
const REASONING = "max" as const;
/**
 * Static parking detail for a V1 candidate-state record. The old reader has no
 * preservation writer, so the step is deferred without any task mutation,
 * model admission, push, review, merge or closure.
 */
const CANDIDATE_WRITER_UNAVAILABLE = "candidate writer unavailable";

function isCausalReplayResult(
  result: ReplayResultV1,
  record: WorkRecordV1,
): boolean {
  return result.taskId === record.id &&
    sameRepositoryIdentity(result.repository, record.repository) &&
    result.original.revision === record.failingRevision &&
    result.limitations.length === 0 &&
    result.original.outcome === "failed" &&
    result.original.failure?.intended === true &&
    result.candidate.outcome === "passed";
}

/**
 * Exact repository identity match: owner, name AND GitHub App installation id
 * are one identity — a different installation is a different repository scope,
 * never a compatible evidence source.
 */
function sameRepositoryIdentity(
  a: RepositoryIdentityV1,
  b: RepositoryIdentityV1,
): boolean {
  return a.owner === b.owner && a.name === b.name &&
    a.installationId === b.installationId;
}

/**
 * Deterministic evidence-to-task identity match: the evidence record belongs
 * to the exact incident id AND the exact repository identity. The evidence
 * record id is an immutable record identity (`evidence:<incidentId>` from the
 * gateway producer) and is never a lookup key; the incidentId field is.
 */
function evidenceMatches(
  evidence: IncidentEvidenceV1,
  incidentId: string,
  repository: RepositoryIdentityV1,
): boolean {
  return evidence.incidentId === incidentId &&
    sameRepositoryIdentity(evidence.repository, repository);
}

/**
 * The persisted evidence record matching one work task, or undefined when
 * none exists. Every consumer resolves evidence by incidentId + repository
 * identity (never by evidence record id), so a foreign record can never be
 * mistaken for this task's evidence.
 */
function evidenceForRecord(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
): IncidentEvidenceV1 | undefined {
  const incidentId = record.related.incidentId;
  if (incidentId === null) return undefined;
  return snapshot.evidence.find(
    (item) => evidenceMatches(item, incidentId, record.repository),
  );
}

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
  /**
   * The one durable GitHub cooldown gate. The trusted host MUST supply the
   * same DurableGitHubCooldownGate instance it injected into the GitHub
   * client/token acquisition and the GitHubPort implementation — there is no
   * independent/default gate here. beforeRequest is checked before any GitHub
   * read (issue intake, published ref reads) and before any model reservation
   * or publication; an ordinary rate_limited denial defers the operation
   * (a cooling installation never reaches a fake port, a state write or a
   * model reservation) and a gate fault fails closed as state_error.
   */
  githubCooldown: GitHubCooldownGateV1;
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
  /**
   * Trusted ORIGINAL run start instant (the entrypoint captured it once). The
   * 90-minute model cutoff and the 120-minute ceiling are anchored to this
   * instant, so a shortened loop deadline can never shift the model cutoff
   * later. Direct callers that omit it keep the previous behavior (the cycle
   * start is the run start).
   */
  runStartedAt?: number;
  /**
   * Trusted host confirmation that NEW model starts are available. `false`
   * makes the existing pre-admission model cutoff unreachable so the run does
   * deterministic bookkeeping only: no budget, record or total-deadline
   * behavior changes, and an omitted value keeps the existing cutoff.
   */
  modelStartsEnabled?: boolean;
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
  /** Run-relative bounds for every start decision in this run. */
  bounds: RunBoundsV1;
}

/** Effective run bounds: caller deadline clamped by the fixed ceiling. */
interface RunBoundsV1 {
  /** Total deadline: min(caller deadline, run start + 120 minutes). */
  runDeadline: number;
  /** No NEW model work may start at/after this point of the run. */
  modelCutoff: number;
}

type StepResultV1 =
  | { kind: "progress" }
  | { kind: "idle" }
  | { kind: "margin"; detail: string }
  | { kind: "state_error"; detail: string }
  | { kind: "deferred"; detail: string };

/** One run of the bounded repair loop. */
export async function runRepairCycle(
  deps: RepairCycleDepsV1,
  options: RepairCycleOptionsV1,
): Promise<RepairCycleOutcomeV1> {
  // Run-relative time bounds: the caller-supplied deadline is clamped to the
  // fixed run ceiling (the stricter of the two always wins), and no NEW model
  // work (implementation start or review request) may start after the 90-minute
  // cutoff. A NaN caller deadline is not a bound at all (every comparison
  // against NaN is false, so it must never bypass the fixed ceiling): it is
  // treated as unbounded and the ceiling governs. The real clock is the wall
  // clock; fakes advance it inside port calls so a step that crosses the
  // cutoff mid-flight still fails closed. A trusted `runStartedAt` from the
  // entrypoint anchors both bounds to the ORIGINAL run start; it is never
  // moved forward by a shortened deadline (a future value is rejected).
  const nowAtStart = deps.clock.now();
  const startedAt = options.runStartedAt !== undefined &&
      Number.isSafeInteger(options.runStartedAt) &&
      options.runStartedAt <= nowAtStart
    ? options.runStartedAt
    : nowAtStart;
  const callerDeadline = Number.isNaN(options.deadline)
    ? Number.POSITIVE_INFINITY
    : options.deadline;
  const runDeadline = Math.min(
    callerDeadline,
    startedAt + REPAIR_RUN_CEILING_MS,
  );
  // A trusted `false` from the host startup diagnostic keeps every existing
  // pre-admission guard intact but makes the model cutoff unreachable, so the
  // run can only do deterministic bookkeeping; budgets, records and the real
  // total run deadline are untouched.
  const modelCutoff = options.modelStartsEnabled === false
    ? Number.NEGATIVE_INFINITY
    : startedAt + REPAIR_MODEL_CUTOFF_MS;
  const bounds: RunBoundsV1 = { runDeadline, modelCutoff };
  const stepLimit = options.stepLimit ?? DEFAULT_STEP_LIMIT;
  let steps = 0;
  let sourceError: string | null = null;
  let didWork = false;
  // Records whose declared next operation cannot start under the current run
  // bounds are deferred so that lower-ranked deterministic work still runs;
  // the run ends in the existing typed "margin" outcome when nothing remains.
  const deferred = new Set<string>();
  // Intake is polled exactly once per run. A deferred (cooldown or bound)
  // iteration must never re-poll the sources: subsequent loop iterations reuse
  // the run-local deferral tracking instead of repeating intake reads.
  let intakePolled = false;

  for (;;) {
    if (deps.clock.now() >= runDeadline) {
      return { status: "margin", detail: "repair run deadline reached" };
    }
    let loaded = await loadSnapshot(deps, bounds);
    if (loaded === null) {
      // The state read is awaited wall-clock time: if it crossed the total
      // deadline, even the one-time seed write must not start then (a later
      // run inside its own window seeds).
      if (deps.clock.now() >= runDeadline) {
        return {
          status: "margin",
          detail: "repair run deadline reached during state read",
        };
      }
      // Branch creation: exactly one seeded snapshot (sequence 1), written
      // with expectedHead null; never a force overwrite of existing state.
      loaded = await seedSnapshot(deps, bounds);
      if (loaded === null) {
        return { status: "state_error", detail: "repair state unavailable" };
      }
    }
    const context: LoopContextV1 = { ...loaded, bounds };

    // The initial state read is awaited wall-clock time and may have crossed
    // the total deadline (fakes advance the clock inside port calls): no
    // intake read may start at/after it.
    if (deps.clock.now() >= runDeadline) {
      return {
        status: "margin",
        detail: "repair run deadline reached during state read",
      };
    }

    if (!intakePolled) {
      intakePolled = true;
      const intake = await pollIntake(deps, context);
      sourceError = intake.error;
      // A cooldown gate fault is a state trust failure, never a source error:
      // it stops the run before any external effect.
      if (intake.result.kind === "state_error") {
        return { status: "state_error", detail: intake.result.detail };
      }
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

      // Intake (and the shared cooldown gate behind it) is awaited wall-clock
      // work: the authoritative head may have moved even when no source row
      // changed. Synchronize once before any ranking/decision so unrelated
      // state movement can never admit a model against a stale context; an
      // unavailable or conflicting reread is a state trust failure.
      const synchronized = await synchronizeSnapshot(deps, context);
      if (synchronized.status === "unavailable") {
        return { status: "state_error", detail: "repair state unavailable" };
      }
      if (synchronized.status === "conflict") {
        return {
          status: "state_error",
          detail: "repair state moved with conflicting contents",
        };
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

    let selected: WorkRecordV1 | null = null;
    let cannotFit: string | null = null;
    for (const id of rank.ordered) {
      if (deferred.has(id)) continue;
      const record = context.snapshot.work.find(
        (work) => work.id === id,
      );
      if (record === undefined) {
        return { status: "state_error", detail: "selected record missing" };
      }
      if (
        declaredOperationFits(deps, context, record)
      ) {
        selected = record;
        break;
      }
      // This record cannot start under the current bounds; keep looking for
      // eligible deterministic work before giving up (never block it).
      deferred.add(id);
      cannotFit = `next operation for ${id} cannot fit`;
    }
    if (selected === null) {
      return {
        status: "margin",
        detail: deferred.size > 0
          ? "all eligible work is deferred (cooldown or run bounds)"
          : cannotFit ?? "no operation fits the remaining run margin",
      };
    }

    const result = await executeStep(deps, context, selected);
    if (result.kind === "deferred") {
      deferred.add(selected.id);
      continue;
    }
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
  bounds: RunBoundsV1,
): Promise<LoopContextV1 | null> {
  const read = await deps.state.readRepair();
  if (!read.ok || read.value.status === "absent") return null;
  return { snapshot: read.value.snapshot, head: read.value.head, bounds };
}

/** Seed the repair branch once with sequence 1 when no snapshot exists. */
async function seedSnapshot(
  deps: RepairCycleDepsV1,
  bounds: RunBoundsV1,
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
    githubCooldowns: [],
  });
  const written = await deps.state.writeRepair(seed, null);
  if (!written.ok || written.value.status !== "applied") return null;
  return { snapshot: seed, head: written.value.head, bounds };
}

async function persistTransition(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  mutate: (draft: RepairStateSnapshotV1) => void,
): Promise<StepResultV1> {
  // Safe snapshot synchronization: the durable cooldown gate writes
  // githubCooldowns through the SAME repair state store, so the authoritative
  // head may have moved since this context was loaded (also covering the
  // reread after intake). A moved head is accepted ONLY when the canonical
  // non-cooldown contents are unchanged — admitting own cooldown-only writes
  // but never blindly applying a stale work mutation atop another writer.
  const synchronized = await synchronizeSnapshot(deps, context);
  if (synchronized.status === "unavailable") {
    return { kind: "state_error", detail: "repair state unavailable" };
  }
  if (synchronized.status === "conflict") {
    return {
      kind: "state_error",
      detail: "repair state moved with conflicting contents",
    };
  }
  const base = synchronized.snapshot;
  const draft: RepairStateSnapshotV1 = {
    ...base,
    stateHead: synchronized.head,
    sequence: base.sequence + 1,
    updatedAt: deps.clock.now(),
    incidents: [...base.incidents],
    evidence: [...base.evidence],
    work: [...base.work],
    reservations: [...base.reservations],
    reviews: [...base.reviews],
    replays: [...base.replays],
    releaseRequests: [...base.releaseRequests],
    // The draft always clones the cooldown records: a synthesized snapshot
    // never shares (or mutates) the gate's persisted array.
    githubCooldowns: [...base.githubCooldowns],
  };
  mutate(draft);
  let parsed: RepairStateSnapshotV1;
  try {
    parsed = parseRepairStateSnapshotV1(draft);
  } catch {
    return { kind: "state_error", detail: "invalid persisted transition" };
  }
  const written = await deps.state.writeRepair(parsed, synchronized.head);
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

/**
 * Reread the actual strict repair state and reconcile it with the loaded
 * context. An unchanged head proceeds (the authoritative state equals the
 * loaded contents). A moved head is accepted ONLY when the canonical
 * non-cooldown contents equal the original context (excluding stateHead,
 * sequence, updatedAt and githubCooldowns): that admits the shared gate's
 * cooldown-only write while never applying a stale work mutation atop another
 * writer; any other movement is "conflict" (state_error at the caller). The
 * reread is strictly re-validated before it is compared or adopted: a read,
 * strict-parse or canonical-compare fault is "unavailable" (fail closed, never
 * trusted or written back). The context is refreshed when the gate's write is
 * accepted so the transition is computed against the authoritative head.
 */
async function synchronizeSnapshot(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
): Promise<
  | { status: "ok"; snapshot: RepairStateSnapshotV1; head: GitSha }
  | { status: "unavailable" }
  | { status: "conflict" }
> {
  try {
    const read = await deps.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      return { status: "unavailable" };
    }
    // The read view is transport-only: every reread is strictly re-parsed
    // (a corrupt row must never reach a comparison or a write-back).
    const snapshot = parseRepairStateSnapshotV1(read.value.snapshot);
    const fresh = { snapshot, head: read.value.head };
    if (fresh.head === context.head) return { status: "ok", ...fresh };
    if (!sameNonCooldownContents(context.snapshot, fresh.snapshot)) {
      return { status: "conflict" };
    }
    context.snapshot = fresh.snapshot;
    context.head = fresh.head;
    return { status: "ok", ...fresh };
  } catch {
    return { status: "unavailable" };
  }
}

/** Canonical equality of the non-cooldown snapshot contents. */
function sameNonCooldownContents(
  original: RepairStateSnapshotV1,
  other: RepairStateSnapshotV1,
): boolean {
  return canonicalStringify({
    version: original.version,
    kind: original.kind,
    incidents: original.incidents,
    evidence: original.evidence,
    work: original.work,
    reservations: original.reservations,
    reviews: original.reviews,
    replays: original.replays,
    releaseRequests: original.releaseRequests,
  }) === canonicalStringify({
    version: other.version,
    kind: other.kind,
    incidents: other.incidents,
    evidence: other.evidence,
    work: other.work,
    reservations: other.reservations,
    reviews: other.reviews,
    replays: other.replays,
    releaseRequests: other.releaseRequests,
  });
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

/** A cooldown gate fault during intake is a state trust failure: run-terminal. */
function intakeFault(detail: string): IntakeResultV1 {
  return {
    result: { kind: "state_error", detail },
    changed: false,
    error: detail,
  };
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

  // Scanner guards for this consumer: repeated cursors and an unbounded page
  // run are never normal exhaustion — they are source faults and trip the
  // existing source-error path. The run deadline alone cannot bound the scan
  // when the injected clock does not advance (frozen clock), and an empty page
  // is a real page that may legitimately continue (the producer's filtered
  // scan can return an empty slice with a continuation cursor), so it is
  // followed only under these finite guards — never converted into success.
  const seenCursors = new Set<string>();
  let pages = 0;

  // Issue-only intake: a host with exactly one configured repository whose
  // adapter is the GitHub variant reads issues only. Every gateway
  // configuration, and every multi-repository or otherwise ambiguous
  // configuration, keeps the existing incident scan and its source-error
  // behavior.
  const issueOnlyIntake = deps.configs.length === 1 &&
    deps.configs[0].adapter.kind === "github";

  for (;;) {
    // A GitHub issue-only host never scans incidents; the issue listing below
    // is its only intake source.
    if (issueOnlyIntake) break;
    // No new intake read may start at/after the total run deadline: every
    // page read is awaited wall-clock time, so the bounds are rechecked
    // between pages. A stop preserves whatever was already collected; the
    // next run resumes the same scan.
    if (deps.clock.now() >= context.bounds.runDeadline) {
      break;
    }
    if (cursor !== null) {
      if (seenCursors.has(cursor)) {
        error = "incident source cursor repeated without progress";
        break;
      }
      seenCursors.add(cursor);
    }
    pages += 1;
    if (pages > MAX_INCIDENT_SCAN_PAGES) {
      error = "incident source pagination exceeded the page bound";
      break;
    }
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
        (incident) =>
          incident.id === summary.id &&
          incident.fingerprint === summary.fingerprint &&
          sameRepositoryIdentity(incident.repository, summary.repository),
      );
      const work = context.snapshot.work.find(
        (record) =>
          record.source.kind === "incident" &&
          record.related.incidentId === summary.id &&
          record.fingerprint === summary.fingerprint &&
          sameRepositoryIdentity(record.repository, summary.repository),
      ) ?? null;
      // Old reader: a record carrying V1 candidate state is parked. Its
      // stored summary and record bytes must not change, so this incoming
      // summary is skipped entirely BEFORE any newSummaries.set or
      // applyIncidentSummary. The lookups above match the exact incident scope
      // (incident id + fingerprint + repository identity), so a parked task
      // from a different incident or repository can never suppress this
      // summary, and this exact parked task is never recreated.
      if (work !== null && hasCandidateState(work)) continue;
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
      // The page read is awaited wall-clock time: no new source read (base
      // ref) may start after the total deadline. The shared cooldown gate is
      // checked before every base read: an ordinary rate_limited denial is a
      // normal deferral (this summary is not admitted until its base is
      // observed, and no source error is fabricated); a gate fault is a state
      // trust failure which stops intake.
      if (deps.clock.now() >= context.bounds.runDeadline) {
        break;
      }
      const cooled = await checkGithubCooldown(
        deps,
        summary.repository,
        context.bounds,
      );
      if (cooled.kind === "state_error") {
        return intakeFault(cooled.detail);
      }
      if (cooled.kind === "deferred") {
        continue;
      }
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
  if (
    issueRepository !== null &&
    deps.clock.now() < context.bounds.runDeadline
  ) {
    // No new issue intake read starts at/after the total deadline (the
    // incident reads above are awaited wall-clock time). The shared cooldown
    // gate is checked before issue intake: a cooling installation never calls
    // the GitHub port (not even a fake one); an ordinary rate_limited denial
    // is a normal deferral that leaves the source state untouched, and a gate
    // fault is a state trust failure that stops the run.
    const issueCooled = await checkGithubCooldown(
      deps,
      issueRepository,
      context.bounds,
    );
    if (issueCooled.kind === "state_error") {
      return intakeFault(issueCooled.detail);
    }
    if (issueCooled.kind === "ok") {
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

          // Issue-only (github adapter) intake gates on NATIVE dependency
          // relations before any work record exists. Absent relations are
          // unknown, never empty: the row is skipped and the run reports a
          // source error instead of admitting an unverified issue. An issue
          // that is itself a parent (has sub-issues) or has open native
          // blockers is skipped without an error; it is re-listed on the next
          // poll once those dependencies close.
          if (issueOnlyIntake) {
            const relations = issue.relations;
            if (relations === undefined) {
              error = `issue relations unavailable for #${issue.number}`;
              continue;
            }
            if (
              relations.subIssueCount > 0 || relations.openBlockers.length > 0
            ) {
              continue;
            }
          }

          const repositoryKey =
            `${issueRepository.owner}/${issueRepository.name}`;
          let base = baseByRepository.get(repositoryKey);
          if (base === undefined) {
            // The issue read above is awaited wall-clock time: stop before a
            // new base-ref read after the total deadline. The gate is checked
            // before every base read; a deferral admits nothing and caches
            // nothing (the next run re-lists and re-reads).
            if (deps.clock.now() >= context.bounds.runDeadline) break;
            const baseCooled = await checkGithubCooldown(
              deps,
              issueRepository,
              context.bounds,
            );
            if (baseCooled.kind === "state_error") {
              return intakeFault(baseCooled.detail);
            }
            if (baseCooled.kind === "deferred") {
              continue;
            }
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
// Scheduling: declared operations must fit the run bounds.
// ---------------------------------------------------------------------------

/**
 * A record whose immediate next action starts NEW model work (implementation
 * or a correction session). Review/publish phases keep their deterministic
 * parts but their review request is gated at the request site (they have no
 * declared session duration of their own).
 */
function isModelStartAction(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
): boolean {
  return record.nextStep === "work" &&
    (record.target.head === null ||
      headRejectedByReview(snapshot, record));
}

/**
 * Whether the declared operation of `record` may start now: the clock must be
 * before the bounded run deadline, and a model start additionally requires the
 * full declared session plus the reserved margin AND a clock before the
 * no-new-model-work cutoff. Deterministic operations stay available within
 * the reserved margin up to the total deadline.
 */
function declaredOperationFits(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): boolean {
  const bounds = context.bounds;
  const now = deps.clock.now();
  if (now >= bounds.runDeadline) return false;
  const config = configFor(deps, record.repository);
  if (config === null) return false;
  if (isModelStartAction(context.snapshot, record)) {
    if (now >= bounds.modelCutoff) return false;
    const bound = config.sessionBound;
    if (bound === null) return true;
    if (now + bound.maxDurationMs + OPERATION_MARGIN_MS > bounds.runDeadline) {
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
  // Backstop before dispatch: even if selection ever admitted a parked record,
  // no work/review/delivery path may execute for it. This returns a static
  // deferral — never a persisted blocker or wait.
  if (hasCandidateState(record)) {
    return Promise.resolve({
      kind: "deferred",
      detail: CANDIDATE_WRITER_UNAVAILABLE,
    });
  }
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

  // A saved base-refresh intent is reconciled wherever it is observed (the
  // work step as well as delivery): the old candidate is preserved until the
  // exact deterministic prepared commit was actually published.
  if (record.intent !== null && record.intent.kind === "base_refresh") {
    return executeBaseRefreshIntent(deps, context, record);
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

  // An issue candidate with an existing PR is checked against the CURRENT
  // configured base BEFORE any fresh review budget is spent: a newer base
  // creates the next deterministic base-refresh intent first. The hook never
  // touches a pending publish/implementation/review intent, never runs for a
  // head rejected by review (that correction path is handled above), and is
  // inert when the host offers no prepareBaseRefresh capability.
  if (
    record.source.kind === "issue" &&
    record.target.pr !== null &&
    record.intent === null &&
    deps.github.prepareBaseRefresh !== undefined
  ) {
    const refresh = await ensureBaseRefreshIntent(deps, context, record);
    if (refresh !== null) return refresh;
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
  const existing = evidenceForRecord(snapshot, record);
  if (existing !== undefined) {
    const now = deps.clock.now();
    const hasDurableReplay = snapshot.replays.some(
      (result) => isCausalReplayResult(result, record),
    );
    if (
      !hasDurableReplay &&
      existing.artifacts.some((artifact) => artifact.expiresAt <= now)
    ) {
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
    return { record: null, evidence: null };
  }
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
  // A freshly returned record is validated against the exact requested
  // identity before it is persisted OR used: the same incident id must belong
  // to the same repository (owner/name/installationId). A foreign record fails
  // closed with a typed blocker and is never merged into this task.
  if (!evidenceMatches(evidence, incidentId, record.repository)) {
    return {
      record: markBlocked(
        record,
        "other",
        "incident evidence belongs to a different incident or repository",
        now,
      ),
      evidence: null,
    };
  }
  // A global evidence id collision with an already-persisted record for a
  // different incident/repository is never overwritten, silently reused or
  // rewritten as a no-progress transition: fail closed with a typed blocker.
  // (The same-identity lookup above guarantees a colliding record here is
  // always foreign.)
  const colliding = snapshot.evidence.find((item) => item.id === evidence.id);
  if (colliding !== undefined) {
    return {
      record: markBlocked(
        record,
        "other",
        "evidence id collides with an existing record for a different incident or repository",
        now,
      ),
      evidence: null,
    };
  }
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
  const evidence = evidenceForRecord(snapshot, record);
  const config = configFor(deps, record.repository);
  const now = deps.clock.now();
  if (evidence === undefined || evidence === null || evidence.replay === null) {
    return markBlocked(
      record,
      "missing_evidence",
      "incident has no replay fixture",
      now,
    );
  }
  if (config === null) {
    return markBlocked(
      record,
      "unavailable",
      "repository not configured",
      now,
    );
  }

  // A saved replay result for this task's CURRENT head is the exact proof
  // that head may be published. It is validated against the current
  // evidence/config identities BEFORE any replay or model work; an invalid
  // or mismatched record is missing evidence, stays immutable and is never
  // replaced or replayed under the same deterministic id.
  if (record.target.head !== null) {
    const savedForHead = snapshot.replays.find(
      (result) =>
        result.taskId === record.id &&
        result.candidate.revision === record.target.head,
    );
    if (savedForHead !== undefined) {
      const validated = await validateSavedReplay(
        deps,
        record,
        evidence,
        config,
        savedForHead,
      );
      if (validated.kind === "wait") {
        return setWait(
          record,
          { reason: "unavailable", since: now, until: null },
          now,
        );
      }
      if (validated.kind === "invalid") {
        return markBlocked(
          record,
          "missing_evidence",
          "saved replay result does not match current evidence identities",
          now,
        );
      }
      carryFromSavedReplay(carry, savedForHead, validated.testIds);
      return null;
    }
  }

  // General prior original-proof reuse: once a durable causal ReplayResultV1
  // exists for this exact task and original revision, the intended
  // before-failure is proven and never rerun. A correction round has a NEW
  // candidate head, so the current head is NOT part of this reuse, but the
  // repository/fixture/command/test identities still must match the current
  // evidence/config; any mismatch is the same missing-evidence block above.
  const already = snapshot.replays.find(
    (result) => isCausalReplayResult(result, record),
  );
  if (already !== undefined) {
    const validated = await validateSavedReplay(
      deps,
      record,
      evidence,
      config,
      already,
    );
    if (validated.kind === "wait") {
      return setWait(
        record,
        { reason: "unavailable", since: now, until: null },
        now,
      );
    }
    if (validated.kind === "invalid") {
      return markBlocked(
        record,
        "missing_evidence",
        "saved replay result does not match current evidence identities",
        now,
      );
    }
    carryFromSavedReplay(carry, already, validated.testIds);
    return null;
  }

  if (record.failingRevision === null) {
    return markBlocked(
      record,
      "missing_evidence",
      "incident has no failing revision",
      now,
    );
  }
  const replay = evidence.replay;
  const fixtureDigest = replay.fixtureDigest;
  if (fixtureDigest === null) {
    return markBlocked(
      record,
      "missing_evidence",
      "replay fixture digest not retained",
      now,
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
      { reason: "unavailable", since: now, until: null },
      now,
    );
  }
  if (testIds.kind === "invalid") {
    return markBlocked(
      record,
      "missing_evidence",
      "fixture has no trusted test identity",
      now,
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
      { reason: "unavailable", since: now, until: null },
      now,
    );
  }
  const result = run.value;
  // A before-run carrying limitations is never a clean intended failure:
  // block as missing evidence BEFORE the intended failure is admitted.
  if (result.limitations.length > 0) {
    return markBlocked(
      record,
      "missing_evidence",
      "original replay result carries unresolved limitations",
      now,
    );
  }
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
      { reason: "unavailable", since: now, until: null },
      now,
    );
  }
  return markBlocked(
    record,
    "missing_evidence",
    "original revision did not fail for the intended reason",
    now,
  );
}

type SavedReplayValidationV1 =
  | { kind: "ok"; testIds: readonly string[] }
  | { kind: "invalid" }
  | { kind: "wait" };

/**
 * Validate one saved replay result against the CURRENT evidence and
 * configuration identities before it may supply proof again: causal shape
 * (with exact repository identity), fixture ref/digest against the current
 * evidence replay metadata, replay command against the evidence command,
 * test command against the repository config, and a usable test-id set that
 * matches the trusted ids resolved for the exact fixture. Fixture resolution
 * unavailable is a wait; every other mismatch is invalid.
 */
async function validateSavedReplay(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
  evidence: IncidentEvidenceV1,
  config: RepositoryConfigV1,
  result: ReplayResultV1,
): Promise<SavedReplayValidationV1> {
  if (!isCausalReplayResult(result, record)) return { kind: "invalid" };
  const replay = evidence.replay;
  if (replay === null) return { kind: "invalid" };
  if (
    result.fixture.ref !== replay.fixtureRef ||
    result.fixture.digest !== replay.fixtureDigest ||
    result.commands.replay !== replay.commandId ||
    result.commands.test !== config.commands.test
  ) {
    return { kind: "invalid" };
  }
  const resolved = await resolveFixtureTestIds(
    deps,
    result.fixture.ref,
    result.fixture.digest,
  );
  if (resolved.kind === "wait") return { kind: "wait" };
  if (resolved.kind === "invalid") return { kind: "invalid" };
  const saved = usableTestIds(result.fixture.testIds);
  if (saved === null || !sameStringArray(saved, resolved.value)) {
    return { kind: "invalid" };
  }
  return { kind: "ok", testIds: resolved.value };
}

/**
 * Carry the trusted saved-original proof for a later candidate validation:
 * the reconstructed before-run copies the ACTUAL recorded limitations (never
 * a fabricated empty array) and keeps the recorded failure identity.
 */
function carryFromSavedReplay(
  carry: CarryV1,
  result: ReplayResultV1,
  testIds: readonly string[],
): void {
  carry.beforeRun = {
    outcome: result.original.outcome,
    exitCode: result.original.exitCode,
    output: result.original.output,
    failure: result.original.failure === null ? null : {
      intended: result.original.failure.intended,
      reason: result.original.failure.reason,
    },
    limitations: [...result.limitations],
    startedAt: 0,
    endedAt: 0,
  };
  carry.fixtureRef = result.fixture.ref;
  carry.fixtureDigest = result.fixture.digest;
  carry.testIds = [...testIds];
  carry.replayCommandId = result.commands.replay;
  carry.beforeReason = result.expected.beforeReason;
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
  const evidence = evidenceForRecord(context.snapshot, record);
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
  // A cached passed result for the exact current head is publish-ready only
  // when it passes the causal predicate AND every currently carried identity
  // (fixture ref/digest/test ids, replay command, config test command); any
  // mismatch or non-causal saved proof is missing evidence and the saved
  // record is never replaced, cleared or replayed under the same id.
  const existing = context.snapshot.replays.find(
    (result) =>
      result.taskId === record.id &&
      result.candidate.revision === head &&
      result.candidate.outcome === "passed",
  );
  if (
    existing !== undefined &&
    (!isCausalReplayResult(existing, record) ||
      carry.fixtureRef === null ||
      carry.fixtureDigest === null ||
      carry.testIds === null ||
      carry.replayCommandId === null ||
      existing.fixture.ref !== carry.fixtureRef ||
      existing.fixture.digest !== carry.fixtureDigest ||
      !sameStringArray(existing.fixture.testIds, carry.testIds) ||
      existing.commands.replay !== carry.replayCommandId ||
      existing.commands.test !== config.commands.test)
  ) {
    return {
      kind: "blocked",
      record: markBlocked(
        record,
        "missing_evidence",
        "saved replay result does not match current evidence identities",
        deps.clock.now(),
      ),
    };
  }
  if (existing !== undefined) return { kind: "ready" };
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
  const after = run.value;
  // Persist the durable causal ReplayResultV1 with exact identities.
  const result = await buildReplayResult(deps, record, carry, after);
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
  // An after run carrying limitations is not a clean verification: the passed
  // result (combined limitations included) is persisted above first, then the
  // task is blocked with the replay-bearing record so the durable proof
  // survives and is never replayed or replaced under the same id.
  if (after.limitations.length > 0) {
    return {
      kind: "blocked",
      record: markBlocked(
        withEvidence,
        "missing_evidence",
        "candidate replay result carries unresolved limitations",
        deps.clock.now(),
      ),
    };
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
    limitations: combineUniqueLimitations(
      carry.beforeRun.limitations,
      after.limitations,
    ),
    createdAt: deps.clock.now(),
  };
  try {
    return parseReplayResultV1(result);
  } catch {
    return null;
  }
}

/** Combined order-preserving unique limitation set across both replay runs. */
function combineUniqueLimitations(
  before: readonly string[],
  after: readonly string[],
): string[] {
  const seen = new Set<string>();
  const combined: string[] = [];
  for (const limitation of [...before, ...after]) {
    if (!seen.has(limitation)) {
      seen.add(limitation);
      combined.push(limitation);
    }
  }
  return combined;
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
  // No NEW model work after the 90-minute cutoff (or at/after the total run
  // deadline): the start is rejected before any reservation is made (nothing
  // is charged), and the record stays exactly as it was so a later run inside
  // the cutoff starts it. The step is deferred, not terminal, so lower-ranked
  // deterministic work still runs.
  const bounds = context.bounds;
  if (deps.clock.now() >= bounds.modelCutoff) {
    return {
      kind: "deferred",
      detail: "implementation start is past the model cutoff",
    };
  }
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

  // A cooling installation never reserves a model start: the shared gate is
  // checked before the issue read (the first GitHub prerequisite) and again
  // immediately before the admission below.
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind === "state_error") {
    return { kind: "state_error", detail: cooling.detail };
  }
  if (cooling.kind === "deferred") {
    return { kind: "deferred", detail: cooling.detail };
  }

  // The issue value is read BEFORE the reservation (and after the initial
  // gate): an unavailable issue returns a wait with ZERO reservation/model and
  // never an ambiguous unsent model intent. The value is kept for the model
  // invocation below.
  const issue = await readIssueForModel(deps, record);
  if (issue === "unavailable") {
    // Prerequisite gating (closed/absent issue, unknown relations, parent or
    // open native blocker) defers to the next hour with ZERO reservation and
    // zero model start: a dependency that closes by then, or a source that
    // recovers, is re-read on that poll. Not an indefinite wait.
    return persistWork(
      deps,
      context,
      setWait(
        record,
        {
          reason: "unavailable",
          since: now,
          until: now + ISSUE_PREREQUISITE_RETRY_MS,
        },
        now,
      ),
    );
  }

  // Recheck the latest shared gate and the run bounds after this awaited
  // prerequisite: a newly discovered rate limit must never consume an
  // admission, and a start that crossed the cutoff stays deferred with zero
  // reservation.
  const admissionCooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (admissionCooling.kind === "state_error") {
    return { kind: "state_error", detail: admissionCooling.detail };
  }
  if (admissionCooling.kind === "deferred") {
    return { kind: "deferred", detail: admissionCooling.detail };
  }
  // Queued issue work has no saved candidate, checkpoint, PR or open intent:
  // its target base is only the development tip captured at intake, so it may
  // have gone stale while the work waited. Refresh it through the same
  // configured-ref read before any model reservation, so admission and the
  // model request use the CURRENT development base instead of an obsolete one.
  // A base read fault keeps the record, counters and history untouched and
  // defers with the existing bounded unavailable wait (zero reservation).
  if (
    record.source.kind === "issue" &&
    record.target.head === null &&
    record.target.checkpoint === null &&
    record.target.pr === null &&
    record.intent === null
  ) {
    const latestBase = await readBase(deps, record.repository);
    if (latestBase === null) {
      return persistWork(
        deps,
        context,
        setWait(
          record,
          {
            reason: "unavailable",
            since: now,
            until: now + ISSUE_PREREQUISITE_RETRY_MS,
          },
          now,
        ),
      );
    }
    if (latestBase !== record.target.base) {
      // Persist ONLY target.base and updatedAt: the immutable source revision,
      // counters, evidence/history, creation time and every other identity are
      // preserved. The returned progress reloads the authoritative state, so
      // the admission below and the existing cooldown/bounds checks run again
      // against the refreshed record (new base, same identity).
      const refreshed: WorkRecordV1 = {
        ...record,
        target: { ...record.target, base: latestBase },
        updatedAt: deps.clock.now(),
      };
      return persistWork(deps, context, refreshed);
    }
  }

  const startsAt = deps.clock.now();
  if (
    startsAt >= bounds.modelCutoff ||
    startsAt + bound.maxDurationMs + OPERATION_MARGIN_MS > bounds.runDeadline
  ) {
    return {
      kind: "deferred",
      detail:
        "implementation start is past the model cutoff or no longer fits the run bounds",
    };
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
  const fresh = await loadSnapshot(deps, context.bounds);
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

  // Recheck the shared gate immediately before the model run: the durable
  // admission and intent writes were awaited wall-clock work. A cooldown
  // discovered now is a KNOWN-NOT-SUBMITTED denial: the start is refunded
  // with the existing confirmed_not_submitted settlement (sanitized cooldown
  // proof ref), the unsent intent is cleared, and the step defers so the
  // already-counted attempt gives the next run a fresh reservation identity.
  const runCooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (runCooling.kind === "state_error") {
    return { kind: "state_error", detail: runCooling.detail };
  }
  if (runCooling.kind === "deferred") {
    // The gate wait itself may have crossed the total run deadline, in which
    // case the denial is a run-bounds fact, not the cooldown: match the
    // refund proof ref and the returned static detail to the actual reason.
    const deadlineCrossed = deps.clock.now() >= context.bounds.runDeadline;
    const refunded = await deps.budget.settleModelStart({
      id: durable.reservation.id,
      outcome: "confirmed_not_submitted",
      proofRef: deadlineCrossed
        ? runBoundsProofRef(durable.reservation.id)
        : cooldownProofRef(durable.reservation.id),
    });
    if (refunded.status !== "settled" && refunded.status !== "idempotent") {
      return {
        kind: "state_error",
        detail: "cooldown admission settlement failed",
      };
    }
    const afterRefund = await loadSnapshot(deps, context.bounds);
    if (afterRefund === null) {
      return { kind: "state_error", detail: "repair state unavailable" };
    }
    const cleared = clearIntent(withIntent, deps.clock.now());
    const persisted = await persistTransition(
      deps,
      afterRefund,
      replaceWorkMutation(cleared),
    );
    if (persisted.kind !== "progress") return persisted;
    return {
      kind: "deferred",
      detail: deadlineCrossed
        ? "implementation start crossed the run bounds after admission"
        : "github cooldown discovered before model run",
    };
  }

  // Late-admission recheck: the durable admission and intent preparation are
  // awaited wall-clock work, so the cutoff (or the declared-maximum-plus-
  // margin fit) may have been crossed AFTER the entry gate. A start that is
  // provably never submitted is refunded with confirmed_not_submitted (never
  // charged as ambiguous or submitted), its unsent intent is cleared, and the
  // already-counted attempt gives the next run a fresh reservation identity so
  // it resumes without a duplicate start.
  const readyAt = deps.clock.now();
  if (
    readyAt >= bounds.modelCutoff ||
    readyAt + bound.maxDurationMs + OPERATION_MARGIN_MS > bounds.runDeadline
  ) {
    const refunded = await deps.budget.settleModelStart({
      id: durable.reservation.id,
      outcome: "confirmed_not_submitted",
      proofRef: runBoundsProofRef(durable.reservation.id),
    });
    if (refunded.status !== "settled" && refunded.status !== "idempotent") {
      return {
        kind: "state_error",
        detail: "late admission settlement failed",
      };
    }
    const afterRefund = await loadSnapshot(deps, context.bounds);
    if (afterRefund === null) {
      return { kind: "state_error", detail: "repair state unavailable" };
    }
    const cleared = clearIntent(withIntent, deps.clock.now());
    const persisted = await persistTransition(
      deps,
      afterRefund,
      replaceWorkMutation(cleared),
    );
    if (persisted.kind !== "progress") return persisted;
    return {
      kind: "deferred",
      detail: "implementation start crossed the run bounds after admission",
    };
  }

  const rejectedHead = headRejectedByReview(context.snapshot, withIntent);
  const receipt = await deps.model.runModel({
    taskId: withIntent.id,
    repository: withIntent.repository,
    base: withIntent.target.base,
    ...(rejectedHead && withIntent.target.head !== null
      ? { checkoutBase: withIntent.target.head }
      : {}),
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
    return persistAfterSettlement(
      deps,
      context.bounds,
      replaceWorkMutation(blocked),
    );
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
    candidate.head !== null && candidate.head !== record.target.base &&
    candidate.changedPaths.length > 0;
  if (!completed) {
    // Only OUR sanitized loop-stop marker gets the exact failed_command_loop
    // blocker message; every other incomplete receipt keeps the generic
    // message. The settlement write moved the authoritative head, so the
    // block is persisted against the reloaded state (never a stale CAS).
    const loopStopped = receipt.error === "failed_command_loop";
    const blocked = await settleAndBlock(
      deps,
      reservationId,
      "ambiguous",
      record,
      loopStopped
        ? "failed_command_loop"
        : "model run did not complete with a trusted candidate",
      now,
    );
    return persistAfterSettlement(
      deps,
      context.bounds,
      replaceWorkMutation(blocked),
    );
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
  const afterSettlement = await loadSnapshot(deps, context.bounds);
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
  bounds: RunBoundsV1,
  mutate: (draft: RepairStateSnapshotV1) => void,
): Promise<StepResultV1> {
  const fresh = await loadSnapshot(deps, bounds);
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
  // Publication is a GitHub read/write: gate before any remote effect (the
  // concrete adapter rechecks each remote call; a cooling installation never
  // reaches a fake port or writes a fresh push intent).
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind === "state_error") {
    return { kind: "state_error", detail: cooling.detail };
  }
  if (cooling.kind === "deferred") {
    return { kind: "deferred", detail: cooling.detail };
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

  // The push intent write is awaited wall-clock time: the total deadline is
  // rechecked before the first publication mutation (no push may start at or
  // after it). The durable push intent lets a later run re-push exactly once.
  if (deps.clock.now() >= context.bounds.runDeadline) {
    return {
      kind: "margin",
      detail: "publication crossed the total run deadline before push",
    };
  }

  const push = await deps.github.pushHead(
    `refs/heads/${branch}`,
    head,
    expectedRemoteHead,
  );
  if (!push.ok) {
    // The saved push intent must stay durable: the response may have been
    // lost after the write, and the next run reconciles the exact remote ref
    // before repeating rather than blindly retrying an ambiguous write.
    return persistWork(
      deps,
      context,
      setWait(
        withIntent,
        { reason: "unavailable", since: now, until: null },
        now,
      ),
    );
  }
  if (push.value === "ambiguous") {
    return { kind: "progress" }; // reconciled next run by exact ref read
  }
  // The push is a real remote mutation: it may have crossed the total
  // deadline. The finished push must not be repeated or lost, so the durable
  // push intent stays and the run stops; the next run reconciles the exact
  // ref and creates/reuses the PR once.
  if (deps.clock.now() >= context.bounds.runDeadline) {
    return {
      kind: "margin",
      detail: "publication crossed the total run deadline after push",
    };
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
  // PR creation is a GitHub write: gate before the PR intent is written (a
  // cooling installation never writes a pull_request intent it cannot act on).
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind === "state_error") {
    return { kind: "state_error", detail: cooling.detail };
  }
  if (cooling.kind === "deferred") {
    return { kind: "deferred", detail: cooling.detail };
  }
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

  // The PR intent write is awaited wall-clock time: before the PR creation
  // mutation the total deadline is rechecked. The durable pull_request intent
  // makes the next run reconcile the exact head ref and create the PR once.
  if (deps.clock.now() >= context.bounds.runDeadline) {
    return {
      kind: "margin",
      detail: "PR creation crossed the total run deadline",
    };
  }

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
    // The saved pull_request intent must stay durable: the response may have
    // been lost after the write, and the next run reconciles the exact head
    // ref before repeating rather than blindly retrying an ambiguous write.
    return persistWork(
      deps,
      context,
      setWait(
        withIntent,
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
  // A review request is NEW model work (it consumes the shared model-start
  // budget and starts a reviewer session): at/after the 90-minute cutoff OR
  // the total run deadline (a tighter caller deadline already governs it) it
  // is rejected BEFORE any reservation, and the record stays unchanged so the
  // next run inside the bounds performs it. Deferral never blocks lower-ranked
  // deterministic work (the run continues and ends in the typed margin).
  if (
    now >= context.bounds.modelCutoff ||
    now >= context.bounds.runDeadline
  ) {
    return {
      kind: "deferred",
      detail: "review request is past the run bounds",
    };
  }
  const head = record.target.head!;
  const operationKey = reviewOperationKey(prNumber, head);

  // A cooling installation never reserves a review request: the shared gate is
  // checked immediately before the admission (the only awaited prerequisite is
  // the bounds check already done above).
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind === "state_error") {
    return { kind: "state_error", detail: cooling.detail };
  }
  if (cooling.kind === "deferred") {
    return { kind: "deferred", detail: cooling.detail };
  }
  // The cooling check was awaited wall-clock work and only guards the total
  // deadline: recheck the 90-minute model cutoff (and the deadline) at the
  // current clock immediately before the admission, so a start that crossed
  // the bounds stays deferred with zero reservation.
  const requestAt = deps.clock.now();
  if (
    requestAt >= context.bounds.modelCutoff ||
    requestAt >= context.bounds.runDeadline
  ) {
    return {
      kind: "deferred",
      detail: "review request is past the run bounds",
    };
  }

  // The FULL structured-review bound must fit before the loop deadline's
  // reserved finalization margin, and no review may be admitted in the last
  // seconds merely because now < deadline. latestStartAt is additionally
  // bounded by the ORIGINAL run model cutoff, so a shortened loop deadline
  // never shifts that cutoff later. Both bounds flow through the submission,
  // the transport and the producer, which rechecks them after the snapshot,
  // after preparation and after the running-journal readback — immediately
  // before the single start.
  const latestStartAt = Math.min(
    context.bounds.modelCutoff,
    context.bounds.runDeadline - OPERATION_MARGIN_MS - REVIEW_BOUND_MS,
  );
  const settleBy = latestStartAt + REVIEW_BOUND_MS;
  if (requestAt >= latestStartAt) {
    return {
      kind: "deferred",
      detail: "review request cannot fit the remaining run bounds",
    };
  }

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
  const fresh = await loadSnapshot(deps, context.bounds);
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

  // Recheck the shared gate immediately before the requestReview call: the
  // reservation and intent writes were awaited wall-clock work. A cooldown
  // discovered now is a known-not-submitted denial: the admission is refunded
  // with the existing confirmed_not_submitted settlement (sanitized cooldown
  // proof ref), the unsent intent is cleared, and the prepared round gives the
  // next run a fresh reservation identity so it resumes without a duplicate
  // start.
  const beforeSubmit = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (beforeSubmit.kind === "state_error") {
    return { kind: "state_error", detail: beforeSubmit.detail };
  }
  if (beforeSubmit.kind === "deferred") {
    // The gate wait itself may have crossed the total run deadline, in which
    // case the denial is a run-bounds fact, not the cooldown: match the
    // refund proof ref and the returned static detail to the actual reason.
    const deadlineCrossed = deps.clock.now() >= context.bounds.runDeadline;
    const refunded = await settleReviewCharge(
      deps,
      context,
      reservationId,
      "confirmed_not_submitted",
      deadlineCrossed
        ? runBoundsProofRef(reservationId)
        : cooldownProofRef(reservationId),
    );
    if (refunded.kind !== "progress") return refunded;
    const cleared = countReviewRound(
      clearIntent(withIntent, deps.clock.now()),
      deps.clock.now(),
    );
    const persistedClear = await persistAfterSettlement(
      deps,
      context.bounds,
      replaceWorkMutation(cleared),
    );
    if (persistedClear.kind !== "progress") return persistedClear;
    return {
      kind: "deferred",
      detail: deadlineCrossed
        ? "review request crossed the run bounds after admission"
        : "github cooldown discovered before review request",
    };
  }

  // Late-admission recheck AFTER the final beforeSubmit gate: the gate wait is
  // awaited wall-clock work, so the review's latest admissible start instant
  // (bounded by the ORIGINAL model cutoff and the loop deadline minus the full
  // review bound and finalization margin) OR the total run deadline may have
  // been crossed with the grant. A review start that is provably never
  // submitted is refunded with confirmed_not_submitted, its unsent intent is
  // cleared, and the round counter it already prepared gives the next run a
  // fresh reservation identity so it resumes without a duplicate start.
  if (
    deps.clock.now() >= latestStartAt ||
    deps.clock.now() >= context.bounds.runDeadline
  ) {
    const refunded = await settleReviewCharge(
      deps,
      context,
      reservationId,
      "confirmed_not_submitted",
      runBoundsProofRef(reservationId),
    );
    if (refunded.kind !== "progress") return refunded;
    const cleared = countReviewRound(
      clearIntent(withIntent, deps.clock.now()),
      deps.clock.now(),
    );
    const persistedClear = await persistAfterSettlement(
      deps,
      context.bounds,
      replaceWorkMutation(cleared),
    );
    if (persistedClear.kind !== "progress") return persistedClear;
    return {
      kind: "deferred",
      detail: "review request crossed the run bounds after admission",
    };
  }

  // Invocation happens strictly after the durable intent exists.
  const submitted = await deps.github.requestReview({
    prNumber,
    expectedHead: head,
    expectedBase: current.target.base,
    expectedReviewer: deps.github.reviewerIdentity,
    operationKey,
    latestStartAt,
    settleBy,
  });
  if (!submitted.ok) {
    // The response may have been lost after submission: the start stays
    // charged as ambiguous and the saved intent makes the next run observe
    // the exact remote review state instead of resubmitting.
    const settled = await settleReviewCharge(
      deps,
      context,
      reservationId,
      "ambiguous",
    );
    if (settled.kind !== "progress") return settled;
    return { kind: "progress" }; // observed next run; never re-request blindly
  }
  if (submitted.value.outcome === "ambiguous") {
    const settled = await settleReviewCharge(
      deps,
      context,
      reservationId,
      "ambiguous",
    );
    if (settled.kind !== "progress") return settled;
    return { kind: "progress" }; // observed next run; never re-request blindly
  }
  const settled = await settleReviewCharge(
    deps,
    context,
    reservationId,
    "submitted",
  );
  if (settled.kind !== "progress") return settled;
  return persistAfterSettlement(
    deps,
    context.bounds,
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
 * invocation; "confirmed_not_submitted" refunds a start that is provably
 * never submitted and requires the restricted run-bound proof ref. An
 * already-charged terminal outcome is idempotent in effect and never adds a
 * second charge; a contradictory terminal outcome stops safely.
 */
async function settleReviewCharge(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  reservationId: string,
  outcome: "submitted" | "ambiguous" | "confirmed_not_submitted",
  proofRef: string | null = null,
): Promise<StepResultV1> {
  const settled = await deps.budget.settleModelStart({
    id: reservationId,
    outcome,
    proofRef,
  });
  if (settled.status === "settled" || settled.status === "idempotent") {
    return { kind: "progress" };
  }
  if (settled.status === "invalid") {
    // A contradictory terminal outcome: reconcile the exact reservation
    // before deciding. An already charged (submitted/ambiguous) reservation
    // preserves the charge; anything else fails closed.
    const read = await loadSnapshot(deps, context.bounds);
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
  // Reconciliation observes exact remote objects: gate before the first
  // external call. A cooldown deferral keeps the intent durable (it is never
  // cleared without an exact observation), so the next run reconciles the same
  // operation exactly once.
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind === "state_error") {
    return { kind: "state_error", detail: cooling.detail };
  }
  if (cooling.kind === "deferred") {
    return { kind: "deferred", detail: cooling.detail };
  }
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
    // The ref read is awaited wall-clock time: if it crossed the total
    // deadline, the push is proven applied and the push intent must stay
    // durable so the next run continues the same publication (PR creation or
    // review request) without repeating the push.
    if (deps.clock.now() >= context.bounds.runDeadline) {
      return {
        kind: "margin",
        detail: "publication continuation crossed the total run deadline",
      };
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
    // The remote PR read is awaited wall-clock time: no PR creation mutation
    // may start at/after the total deadline. The pull_request intent stays
    // durable, so the next run creates the PR exactly once.
    if (deps.clock.now() >= context.bounds.runDeadline) {
      return {
        kind: "margin",
        detail: "PR reconciliation crossed the total run deadline",
      };
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
        context,
        intent.requestId,
        "ambiguous",
      );
      if (settled.kind !== "progress") return settled;
    }
    const afterSettlement = await loadSnapshot(deps, context.bounds);
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
  // Review observation is a GitHub read: gate before the external call. A
  // cooldown deferral mutates nothing (the pending wait and review intent stay
  // durable) so the next run observes the exact remote state once.
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind === "state_error") {
    return { kind: "state_error", detail: cooling.detail };
  }
  if (cooling.kind === "deferred") {
    return { kind: "deferred", detail: cooling.detail };
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
      expectedReviewer: deps.github.reviewerIdentity,
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

async function executeDeliveryStep(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  if (record.target.pr === null || record.target.head === null) {
    return {
      kind: "state_error",
      detail: "delivery without PR/head identity",
    };
  }

  if (record.intent !== null) {
    if (record.intent.kind === "base_refresh") {
      // A saved candidate-base refresh is reconciled before any other
      // delivery effect: the old candidate is preserved until the exact
      // deterministic prepared commit was actually published.
      return executeBaseRefreshIntent(deps, context, record);
    }
    if (record.intent.kind === "issue_closure") {
      return retryClosure(deps, context, record);
    }
    if (record.intent.kind === "merge") {
      return reconcileMergeIntent(deps, context, record);
    }
  }

  // Look up the durable release request by its SOURCE identity (exact PR and
  // reviewed head); the request's `revision` is the merged revision, which is
  // never the candidate head, so it cannot be the lookup key. The lookup also
  // binds the full target scope (owner/name/installation), the production
  // environment and the reviewed base: a request for another repository scope
  // or another base can never be observed — and therefore never closed — for
  // this delivery record. Retaining the merged revision inside the matched
  // request keeps one exact request per PR/head/base and never replays a merge
  // or fabricates a duplicate request.
  const existingRequest = context.snapshot.releaseRequests.find(
    (request) => releaseRequestMatchesDelivery(request, record),
  );
  if (existingRequest !== undefined) {
    // An existing release request is delivery bookkeeping: a base movement
    // never replaces or duplicates it.
    return observeReleaseAcceptance(deps, context, record, existingRequest);
  }
  // Only an issue task with an existing candidate/PR, no other intent and an
  // available prepareBaseRefresh capability may persist a base-refresh intent:
  // an unsupported/fake port must never receive an intent it cannot execute.
  // The check happens BEFORE the merge path and never touches immutable
  // identities, counters, reviews or evidence.
  if (
    record.intent === null && record.source.kind === "issue" &&
    deps.github.prepareBaseRefresh !== undefined
  ) {
    const refresh = await ensureBaseRefreshIntent(deps, context, record);
    if (refresh !== null) return refresh;
  }
  return executeMerge(deps, context, record);
}

/**
 * Deterministic base-refresh intent identity: exact PR, old candidate head and
 * observed new base. Never time- or list-derived, so a restart reproduces the
 * identical key.
 */
function baseRefreshIntentKey(
  pullRequestNumber: number,
  expectedHead: GitSha,
  observedBase: GitSha,
): string {
  return `base_refresh:${pullRequestNumber}:${expectedHead}:${observedBase}`;
}

/**
 * Observe the actual configured base ref for an eligible issue delivery. A
 * moved base persists the durable refresh intent BEFORE any preparation or
 * side effect and performs no reservation, model call or external write. The
 * immutable record identities, counters, evidence and reviews are untouched;
 * the target stays on the old base/head until publication succeeded. Returns
 * null when the base did not move (the existing merge path is unchanged), or
 * an explicit step result for a wait/refusal/deferral.
 */
async function ensureBaseRefreshIntent(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1 | null> {
  const config = configFor(deps, record.repository);
  if (config === null) return null;
  if (
    record.target.pr === null || record.target.head === null ||
    record.target.branch === null
  ) {
    return null;
  }
  // The base read is a GitHub read: the shared gate is checked first (a
  // cooling installation never writes a refresh intent it cannot act on).
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind === "state_error") {
    return { kind: "state_error", detail: cooling.detail };
  }
  if (cooling.kind === "deferred") {
    return { kind: "deferred", detail: cooling.detail };
  }
  const readAt = deps.clock.now();
  const ref = await deps.github.readRef(`refs/heads/${config.baseBranch}`);
  if (!ref.ok || ref.value === null) {
    // The base ref could not be observed: a bounded wait, never a fabricated
    // "unchanged" base and never a refresh intent against unknown state.
    return persistWork(
      deps,
      context,
      setWait(
        record,
        {
          reason: "unavailable",
          since: readAt,
          until: readAt + CHECK_POLL_MS,
        },
        readAt,
      ),
    );
  }
  const observedBase = ref.value.sha;
  if (observedBase === record.target.base) return null;
  const intent: IncompleteOperationV1 = {
    kind: "base_refresh",
    key: baseRefreshIntentKey(
      record.target.pr,
      record.target.head,
      observedBase,
    ),
    startedAt: readAt,
    branch: record.target.branch,
    expectedHead: record.target.head,
    observedBase,
    pr: record.target.pr,
    requestId: null,
    resultId: null,
  };
  return persistWork(deps, context, setIntent(record, intent, readAt));
}

/**
 * Execute or resume one durable base-refresh intent.
 *
 * The deterministic prepared commit is regenerated through the optional
 * trusted port capability (a fresh run reproduces the identical SHA after a
 * runner disappeared) and persisted as the intent result BEFORE any push. The
 * exact branch is then read: only the old candidate head or the exact prepared
 * result are accepted. The old head is pushed with the existing expected-ref
 * pushHead; an already-published prepared commit is reconciled without a
 * duplicate push. Unknown heads, failures and lost responses leave the same
 * durable intent with a bounded wait, while a known merge conflict blocks the
 * task with the existing blocker fields and retains the candidate. On success
 * the target advances to the exact new base/prepared head, the intent is
 * cleared and nextStep returns to `work`, so the existing publication and
 * fresh-review admission handle the exact new head (an old review is never
 * reused).
 */
async function executeBaseRefreshIntent(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  const intent = record.intent;
  if (
    intent === null || intent.kind !== "base_refresh" ||
    record.target.pr === null || record.target.head === null ||
    record.target.branch === null
  ) {
    return {
      kind: "state_error",
      detail: "base refresh intent identity mismatch",
    };
  }
  const observedBase = intent.observedBase;
  const persistedPrepared = intent.resultId;
  if (
    intent.branch !== record.target.branch ||
    intent.expectedHead !== record.target.head ||
    intent.pr !== record.target.pr ||
    intent.requestId !== null ||
    observedBase === null ||
    !isGitSha(observedBase) ||
    (persistedPrepared !== null && !isGitSha(persistedPrepared))
  ) {
    return {
      kind: "state_error",
      detail: "base refresh intent identity mismatch",
    };
  }
  const config = configFor(deps, record.repository);
  if (config === null) {
    return {
      kind: "state_error",
      detail: "base refresh without repository configuration",
    };
  }
  const prepare = deps.github.prepareBaseRefresh?.bind(deps.github);
  if (prepare === undefined) {
    // Capability absence is an explicit bounded wait: the durable intent and
    // the old candidate are preserved and no deprecated path is taken.
    const at = deps.clock.now();
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "unavailable", since: at, until: at + CHECK_POLL_MS },
        at,
      ),
    );
  }
  const expectedBase: GitSha = observedBase;
  const prepared = await prepare({
    pullRequestNumber: record.target.pr,
    branch: record.target.branch,
    expectedHead: record.target.head,
    previousBase: record.target.base,
    expectedBase,
    ...(persistedPrepared === null ? {} : { preparedHead: persistedPrepared }),
  });
  if (!prepared.ok) {
    if (
      prepared.error.kind === "conflict" &&
      prepared.error.detail === BASE_REFRESH_CONFLICT_DETAIL
    ) {
      // A known deterministic merge conflict: retain the candidate, spend no
      // model work and block with the existing blocker fields. Every other
      // failure (identity mismatch, moved base, bounds, unavailable objects)
      // keeps the exact durable intent and waits bounded below.
      const at = deps.clock.now();
      return persistWork(
        deps,
        context,
        markBlocked(
          clearIntent(record, at),
          "other",
          "base refresh has conflicts",
          at,
        ),
      );
    }
    const at = deps.clock.now();
    if (persistedPrepared === null) {
      // No authorized push can exist before the prepared result was persisted.
      // Re-observe the configured base under the shared cooldown: a SECOND
      // movement after this intent was written clears ONLY this unprepared
      // intent so the next step plans a fresh one against the newest base.
      // Target, source, counters, reviews, evidence and history are preserved.
      const cooling = await checkGithubCooldown(
        deps,
        record.repository,
        context.bounds,
      );
      if (cooling.kind === "state_error") {
        return { kind: "state_error", detail: cooling.detail };
      }
      if (cooling.kind === "deferred") {
        return { kind: "deferred", detail: cooling.detail };
      }
      const currentBase = await deps.github.readRef(
        `refs/heads/${config.baseBranch}`,
      );
      const observedAt = deps.clock.now();
      if (!currentBase.ok || currentBase.value === null) {
        // A failed ref read retains the exact intent with a bounded wait.
        return persistWork(
          deps,
          context,
          setWait(
            record,
            {
              reason: "unavailable",
              since: observedAt,
              until: observedAt + CHECK_POLL_MS,
            },
            observedAt,
          ),
        );
      }
      if (currentBase.value.sha !== expectedBase) {
        // Clear only this unprepared intent; the same run replans a fresh
        // refresh against the newly observed base before any model/review
        // spend. No other intent is ever cleared here.
        return persistWork(deps, context, clearIntent(record, observedAt));
      }
    }
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "unavailable", since: at, until: at + CHECK_POLL_MS },
        at,
      ),
    );
  }
  const preparedHead = prepared.value;
  if (!isGitSha(preparedHead)) {
    return {
      kind: "state_error",
      detail: "base refresh prepared identity invalid",
    };
  }
  if (persistedPrepared !== null && persistedPrepared !== preparedHead) {
    // The persisted deterministic result must regenerate byte-identically.
    return {
      kind: "state_error",
      detail: "base refresh prepared identity mismatch",
    };
  }
  // Persist the exact prepared result BEFORE any push: a crash after a
  // successful push is then recoverable from the durable intent alone.
  let durable = record;
  if (persistedPrepared === null) {
    durable = setIntent(
      record,
      { ...intent, resultId: preparedHead },
      deps.clock.now(),
    );
    const persisted = await persistWork(deps, context, durable);
    if (persisted.kind !== "progress") return persisted;
  }
  // Recheck the total run deadline and the shared cooldown immediately before
  // the external write (the gate wait may have crossed the deadline).
  if (deps.clock.now() >= context.bounds.runDeadline) {
    return {
      kind: "margin",
      detail: "base refresh crossed the total run deadline before push",
    };
  }
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind === "state_error") {
    return { kind: "state_error", detail: cooling.detail };
  }
  if (cooling.kind === "deferred") {
    return { kind: "deferred", detail: cooling.detail };
  }
  if (deps.clock.now() >= context.bounds.runDeadline) {
    return {
      kind: "margin",
      detail: "base refresh crossed the total run deadline before push",
    };
  }
  const ref = `refs/heads/${record.target.branch}`;
  const current = await deps.github.readRef(ref);
  const readAt = deps.clock.now();
  if (!current.ok || current.value === null) {
    return persistWork(
      deps,
      context,
      setWait(
        durable,
        { reason: "unavailable", since: readAt, until: readAt + CHECK_POLL_MS },
        readAt,
      ),
    );
  }
  const currentHead = current.value.sha;
  if (currentHead === record.target.head) {
    // The candidate ref read is awaited wall-clock time: recheck the total run
    // deadline immediately before the push. A slow read that crossed the bound
    // keeps the exact durable intent/prepared SHA with zero push after cutoff.
    if (deps.clock.now() >= context.bounds.runDeadline) {
      return {
        kind: "margin",
        detail:
          "base refresh crossed the total run deadline after the ref read",
      };
    }
    // The branch still carries the old candidate: one exact expected-ref push
    // publishes the deterministic prepared commit.
    const pushed = await deps.github.pushHead(
      ref,
      preparedHead,
      record.target.head,
    );
    const pushAt = deps.clock.now();
    if (!pushed.ok || pushed.value !== "applied") {
      // Unknown/error/lost push: keep the same durable intent and wait
      // bounded; a later run reconciles the exact ref before repeating.
      return persistWork(
        deps,
        context,
        setWait(
          durable,
          {
            reason: "unavailable",
            since: pushAt,
            until: pushAt + CHECK_POLL_MS,
          },
          pushAt,
        ),
      );
    }
  } else if (currentHead !== preparedHead) {
    // Any unrelated head is never adopted: preserve the intent and wait.
    return persistWork(
      deps,
      context,
      setWait(
        durable,
        { reason: "unavailable", since: readAt, until: readAt + CHECK_POLL_MS },
        readAt,
      ),
    );
  }
  // Success: the refreshed candidate becomes the exact target and the existing
  // publication path requests a fresh review for the new head. Branch, PR,
  // checkpoint, counters, source, evidence and prior reviews are preserved.
  const doneAt = deps.clock.now();
  const refreshed: WorkRecordV1 = {
    ...durable,
    target: { ...durable.target, base: expectedBase, head: preparedHead },
    nextStep: "work",
    wait: null,
    blocker: null,
    intent: null,
    updatedAt: doneAt,
  };
  return persistWork(deps, context, refreshed);
}

/**
 * Exact delivery/release-request binding. PR and reviewed head alone are not
 * enough: the request must belong to the record's exact repository scope
 * (owner, name and installation id), be a production request, and carry the
 * same reviewed base as the record. A receipt for another scope or another
 * base is therefore never observed against this record.
 */
function releaseRequestMatchesDelivery(
  request: ReleaseRequestV1,
  record: WorkRecordV1,
): boolean {
  if (record.target.pr === null || record.target.head === null) return false;
  if (request.source.pullRequest !== record.target.pr) return false;
  if (request.source.head !== record.target.head) return false;
  if (request.source.base !== record.target.base) return false;
  if (request.target.environment !== "production") return false;
  const target = request.target.repository;
  const repository = record.repository;
  return target.owner === repository.owner &&
    target.name === repository.name &&
    target.installationId === repository.installationId;
}

async function executeMerge(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  // Merge is a GitHub write: gate before any preparation or intent write (a
  // cooling installation never writes a merge intent it cannot act on; the
  // concrete adapter separately rechecks the gate at the call).
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind === "state_error") {
    return { kind: "state_error", detail: cooling.detail };
  }
  if (cooling.kind === "deferred") {
    return { kind: "deferred", detail: cooling.detail };
  }
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
      expectedReviewer: deps.github.reviewerIdentity,
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

  // The merge intent write is awaited wall-clock time: no merge mutation may
  // start at/after the total deadline. The merge intent stays durable, so the
  // next run re-reads the exact PR gate and merges exactly once.
  if (deps.clock.now() >= context.bounds.runDeadline) {
    return {
      kind: "margin",
      detail: "merge crossed the total run deadline",
    };
  }

  const merged = await deps.github.mergePullRequest(mergeRequest);
  if (!merged.ok) {
    // The saved merge intent must stay durable: the response may have been
    // lost after the write, and the next run reconciles the exact remote PR
    // state before repeating rather than blindly retrying an ambiguous write.
    return persistWork(
      deps,
      context,
      setWait(
        withIntent,
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
  // Merge reconciliation observes the exact remote PR state: gate before the
  // read. A cooldown deferral keeps the merge intent durable so the next run
  // reconciles the exact same operation once.
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind === "state_error") {
    return { kind: "state_error", detail: cooling.detail };
  }
  if (cooling.kind === "deferred") {
    return { kind: "deferred", detail: cooling.detail };
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
  // The merge-gate read is awaited wall-clock time: it may have crossed the
  // total deadline, and the merge mutation must not start then. The merge
  // intent stays durable; the next run re-reads the gate and merges once.
  if (deps.clock.now() >= context.bounds.runDeadline) {
    return {
      kind: "margin",
      detail: "merge gate crossed the total run deadline",
    };
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

/**
 * The explicit local Sentinel scope: the no-App owner credential identity for
 * exactly `ubiquity/sentinel` (`installationId` 0). Another repository that
 * happens to share scope 0 is NOT the local Sentinel scope, so it can never
 * read or consume the Sentinel local receipt. A local request never falls back
 * to the hosted Deno release path, even when the local receipt capability is
 * absent or broken.
 */
function isLocalReleaseScope(request: ReleaseRequestV1): boolean {
  const repository = request.target.repository;
  return repository.installationId === 0 &&
    repository.owner === "ubiquity" &&
    repository.name === "sentinel";
}

/** One explicit release wait; an unreadable or pending local receipt waits. */
function waitRelease(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  now: number,
): Promise<StepResultV1> {
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

/**
 * Local acceptance only ever reads the private local activation receipt. An
 * absent capability is unavailable (never a Deno fallback), a missing/error
 * receipt waits, an accepted receipt uses the existing closure intent logic,
 * and a failed or rolled-back receipt uses the existing blocked behavior. The
 * complete receipt is parsed again here and its request binding is enforced,
 * so an injected reader cannot accept, close or block on a malformed,
 * unproven or differently-bound value.
 */
async function observeLocalReleaseAcceptance(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  request: ReleaseRequestV1,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  const readLocalRelease = deps.state.readLocalRelease;
  const readHostedRelease = deps.state.readHostedRelease;
  // Two distinct receipt authorities for the same self scope cannot both
  // attest one release: never guess which one is authoritative, wait for an
  // unambiguous host wiring instead.
  if (readLocalRelease !== undefined && readHostedRelease !== undefined) {
    return waitRelease(deps, context, record, now);
  }
  if (readHostedRelease !== undefined) {
    return await observeHostedReleaseAcceptance(
      deps,
      context,
      record,
      request,
      now,
    );
  }
  if (readLocalRelease === undefined) {
    return waitRelease(deps, context, record, now);
  }
  let observed: PortResultV1<LocalReleaseReceiptV1 | null>;
  try {
    observed = await readLocalRelease.call(deps.state, request);
  } catch {
    return waitRelease(deps, context, record, now);
  }
  if (!observed.ok || observed.value === null) {
    return waitRelease(deps, context, record, now);
  }
  let receipt: LocalReleaseReceiptV1;
  try {
    receipt = parseLocalReleaseReceiptV1(observed.value);
  } catch {
    return waitRelease(deps, context, record, now);
  }
  if (!localReceiptBindsRequest(receipt, request)) {
    return waitRelease(deps, context, record, now);
  }
  if (receipt.phase === "accepted") {
    return await acceptRelease(deps, context, record, request.id, now);
  }
  if (receipt.phase === "failed" || receipt.phase === "rolled_back") {
    return blockRelease(deps, context, record, receipt.phase, now);
  }
  return waitRelease(deps, context, record, now);
}

/**
 * Hosted acceptance reads only the protected supervisor's PERSISTED receipt
 * for the exact self production request. A missing, thrown, error, malformed,
 * foreign or differently-bound record waits; an accepted record uses the
 * existing durable closure intent and a rolled_back record uses the existing
 * blocked behavior. There is never a raw workflow-green, local or Deno
 * fallback for the self scope, and no hosted proof exists for another scope.
 */
async function observeHostedReleaseAcceptance(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  request: ReleaseRequestV1,
  now: number,
): Promise<StepResultV1> {
  const readHostedRelease = deps.state.readHostedRelease;
  if (readHostedRelease === undefined) {
    return waitRelease(deps, context, record, now);
  }
  let observed: PortResultV1<HostedReleaseRecordV1 | null>;
  try {
    observed = await readHostedRelease.call(deps.state, request);
  } catch {
    return waitRelease(deps, context, record, now);
  }
  if (!observed.ok || observed.value === null) {
    return waitRelease(deps, context, record, now);
  }
  let receipt: HostedReleaseRecordV1;
  try {
    receipt = parseHostedReleaseRecordV1(observed.value);
  } catch {
    return waitRelease(deps, context, record, now);
  }
  if (!hostedReceiptBindsRequest(receipt, request)) {
    return waitRelease(deps, context, record, now);
  }
  if (receipt.phase === "accepted") {
    return await acceptRelease(deps, context, record, request.id, now);
  }
  if (receipt.phase === "rolled_back") {
    return blockRelease(deps, context, record, "rolled_back", now);
  }
  // requested/promoting/verifying/rollback_pending/rollback_verifying carry no
  // final delivery proof and always wait.
  return waitRelease(deps, context, record, now);
}

/** Existing accepted behavior: closure intent when an issue is attached. */
async function acceptRelease(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  requestId: string,
  now: number,
): Promise<StepResultV1> {
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
    requestId,
    resultId: null,
  };
  const withIntent = setIntent(record, intent, now);
  const persisted = await persistWork(deps, context, withIntent);
  if (persisted.kind !== "progress") return persisted;
  return retryClosure(deps, context, withIntent);
}

/** Existing failed/rolled_back behavior: an ordinary blocked record. */
function blockRelease(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  phase: "failed" | "rolled_back",
  now: number,
): Promise<StepResultV1> {
  return persistWork(
    deps,
    context,
    markBlocked(record, "other", `release ${phase}`, now),
  );
}

async function observeReleaseAcceptance(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  request: ReleaseRequestV1,
): Promise<StepResultV1> {
  if (isLocalReleaseScope(request)) {
    return await observeLocalReleaseAcceptance(deps, context, record, request);
  }
  const now = deps.clock.now();
  const release = await deps.state.readRelease();
  if (!release.ok || release.value.status !== "found") {
    return waitRelease(deps, context, record, now);
  }
  const observed = release.value.snapshot.releases.find(
    (item) => item.requestId === request.id,
  );
  if (observed === undefined) {
    return waitRelease(deps, context, record, now);
  }
  if (observed.phase === "accepted") {
    return await acceptRelease(deps, context, record, request.id, now);
  }
  if (observed.phase === "failed" || observed.phase === "rolled_back") {
    return blockRelease(deps, context, record, observed.phase, now);
  }
  return waitRelease(deps, context, record, now);
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
  // The issue_closure intent is durable: the closure mutation never starts
  // at/after the total deadline (the release read may have crossed it), so
  // the next run retries the exact closure once. The shared cooldown gate is
  // checked before the closure write: a deferral keeps the closure intent.
  if (now >= context.bounds.runDeadline) {
    return {
      kind: "margin",
      detail: "issue closure crossed the total run deadline",
    };
  }
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind === "state_error") {
    return { kind: "state_error", detail: cooling.detail };
  }
  if (cooling.kind === "deferred") {
    return { kind: "deferred", detail: cooling.detail };
  }
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
  const resolveTestIds = deps.fixtureIdentities !== undefined
    ? deps.fixtureIdentities.resolveTestIds.bind(deps.fixtureIdentities)
    : (typeof replayWithIdentity.resolveTestIds === "function"
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

/** Deterministic order-sensitive identity equality for test-id sets. */
function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
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
  const issue = read.value;
  // The latest native state is authoritative: a closed issue (or one that no
  // longer exists) can never start model work, even when intake admitted it.
  if (issue === null || issue.state !== "open") return "unavailable";
  // Issue-only github-adapter intake also gates on native dependency
  // relations: unknown relations, a parent issue (sub-issues) or any open
  // native blocker defers admission. Closed blockers are already excluded by
  // the client parser; no completed WorkRecord is synthesized for them.
  const config = configFor(deps, record.repository);
  if (config?.adapter.kind === "github") {
    const relations = issue.relations;
    if (
      relations === undefined ||
      relations.subIssueCount > 0 ||
      relations.openBlockers.length > 0
    ) {
      return "unavailable";
    }
  }
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
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
  // Full scope identity: the same owner/name under a different installation
  // (positive App id vs the explicit no-App local scope 0) must never be
  // authorized through another scope's configuration.
  return deps.configs.find(
    (config) =>
      config.repository.owner === repository.owner &&
      config.repository.name === repository.name &&
      config.repository.installationId === repository.installationId,
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

/**
 * Restricted trusted proof ref for an admission whose start was provably
 * never submitted because the run bounds were crossed during preparation.
 */
function runBoundsProofRef(reservationId: string): string {
  return `artifact://sentinel/run-bounds/${reservationId}`;
}

/**
 * Restricted trusted proof ref for an admission whose start was provably
 * never submitted because the durable GitHub cooldown was discovered during
 * preparation. Same sanitized artifact-reference pattern as the run-bound
 * proof; no new storage/config surface.
 */
function cooldownProofRef(reservationId: string): string {
  return `artifact://sentinel/github-cooldown/${reservationId}`;
}

// ---------------------------------------------------------------------------
// GitHub cooldown guard: the narrow loop-side check.
// ---------------------------------------------------------------------------

type GithubCooldownCheckV1 =
  | { kind: "ok" }
  | { kind: "deferred"; detail: string }
  | { kind: "state_error"; detail: string };

/**
 * Narrow shared-gate check for one affected installation. An ordinary
 * rate_limited denial is a NORMAL cooldown deferral (the operation is skipped
 * and no source state is cleared or rewritten); a thrown gate, a latched
 * fault or any other denial kind is a state trust failure (state_error). The
 * injected gate is the exact same instance the trusted host gave the GitHub
 * client/token acquisition and the GitHubPort, so the loop guard prevents a
 * cooling installation from ever reaching a fake port or reserving a model.
 * The gate wait is awaited wall-clock time: AFTER it resolves, an otherwise
 * granted request whose wait crossed the total run deadline is a normal
 * deferral, so no intake/base read or publication/review/merge/closure begins
 * past the bound (a gate fault still retains state_error).
 */
async function checkGithubCooldown(
  deps: RepairCycleDepsV1,
  repository: RepositoryIdentityV1,
  bounds: RunBoundsV1,
): Promise<GithubCooldownCheckV1> {
  let result: PortResultV1<void>;
  try {
    result = await deps.githubCooldown.beforeRequest(
      repository.installationId,
    );
  } catch {
    return {
      kind: "state_error",
      detail: "github cooldown gate unavailable",
    };
  }
  if (!result.ok) {
    if (result.error.kind === "rate_limited") {
      return { kind: "deferred", detail: "github cooldown active" };
    }
    return {
      kind: "state_error",
      detail: "github cooldown gate denied",
    };
  }
  if (deps.clock.now() >= bounds.runDeadline) {
    return {
      kind: "deferred",
      detail: "github cooldown wait crossed the run deadline",
    };
  }
  return { kind: "ok" };
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
