/**
 * m19 trusted matrix runtime: plan / cell / ingest.
 *
 * - `planMatrixWave` is the trusted serialized planner. It reuses the repair
 *   cycle's own bounds, selection, the exact implementation-readiness
 *   predicate, prerequisite checks, durable admission and implementation-intent
 *   preparation (`prepareImplementationStart`), and returns one immutable grant
 *   per admitted task. It never runs a model and never grants review,
 *   delivery, correction or already-intended records.
 * - `runMatrixCell` executes exactly ONE already-admitted `ModelRunRequestV1`
 *   through the injected isolated implementation port, after comparing the
 *   TRUSTED actual workflow run/attempt/runtime revision/generation (supplied
 *   by the host, never read from the grant) and re-reading the current source
 *   issue and the durable intent/reservation identity. It has no state-writer
 *   capability and passes no credentials to the model.
 * - `ingestMatrixResults` is the trusted serialized consumer. It re-reads
 *   authoritative state per cell, parses every artifact strictly, rejects
 *   foreign/conflicting/mismatched output and unverifiable receipts, preserves
 *   siblings, and reuses the production receipt consumer
 *   (`handleModelReceipt`) or the production failed-start settlement.
 *
 * Result artifacts are untrusted: their receipts are re-verified against the
 * exact planned request before any state update. Acceptance stays with the
 * existing receipt, candidate, replay and review consumers.
 */
import { canonicalStringify } from "../contracts/canonical.ts";
import { deriveReservationId } from "../budget/mod.ts";
import type { GitSha } from "../contracts/brands.ts";
import {
  MATRIX_CELL_PATH,
  MATRIX_CELL_RESULT_VERSION,
  MATRIX_PLAN_PATH,
  MATRIX_PLAN_VERSION,
  MATRIX_RESULT_PATH,
  MATRIX_RESULTS_DIR,
  matrixBundleFileNameV1,
  type MatrixCellActualIdentityV1,
  type MatrixCellBundleV1,
  type MatrixCellGrantV1,
  matrixCellIdV1,
  type MatrixCellPlanV1,
  type MatrixCellResultV1,
  matrixDigestV1,
  type MatrixPlanV1,
  type MatrixRunIdentityV1,
  MAX_MATRIX_ARTIFACT_BYTES,
  MAX_MATRIX_CELLS,
  tryParseMatrixCellGrantV1,
  tryParseMatrixCellResultV1,
  tryParseMatrixPlanV1,
} from "../contracts/matrix.ts";
import type {
  Clock,
  GitHubPort,
  ImplementationPort,
  ModelRunReceiptV1,
  StateReadView,
} from "../contracts/ports.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "../repair/keys.ts";
import {
  createRunBounds,
  handleModelReceipt,
  isMatrixImplementationReadyV1,
  loadRepairContext,
  OPERATION_MARGIN_MS,
  prepareImplementationStart,
  type RepairCycleDepsV1,
  type RunBoundsV1,
  settleFailedImplementation,
} from "../repair/loop.ts";
import { rankEligibleWork } from "../repair/selection.ts";
import type {
  MatrixBundleExporterV1,
  MatrixBundleImporterV1,
} from "./matrix-git.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function configForRepository(
  deps: RepairCycleDepsV1,
  repository: RepositoryIdentityV1,
): RepositoryConfigV1 | null {
  return deps.configs.find((config) =>
    config.repository.owner === repository.owner &&
    config.repository.name === repository.name &&
    config.repository.installationId === repository.installationId
  ) ?? null;
}

function sameRepository(
  a: RepositoryIdentityV1,
  b: RepositoryIdentityV1,
): boolean {
  return a.owner === b.owner && a.name === b.name &&
    a.installationId === b.installationId;
}

/**
 * Re-verify a deserialized receipt projection against the exact planned
 * request and the host's trusted expected provider. The production model port
 * verifies raw request/runtime session evidence in-process; an artifact cannot
 * inherit that trust, so the projection is re-checked here and any mismatch
 * refuses the result before a state update.
 */
function receiptIdentityMatches(
  receipt: ModelRunReceiptV1,
  request: { model: string; reasoning: string },
  expectedProvider: string,
): boolean {
  return receipt.actual.evidenceKind === "request-runtime" &&
    receipt.actual.observedModel === request.model &&
    receipt.actual.observedReasoning === request.reasoning &&
    receipt.actual.provider === expectedProvider;
}

export function verifyMatrixReceiptV1(
  receipt: ModelRunReceiptV1,
  request: {
    model: string;
    reasoning: string;
    maxDurationMs: number;
    maxOutputChars: number;
  },
  expectedProvider: string,
): boolean {
  if (!receiptIdentityMatches(receipt, request, expectedProvider)) return false;
  if (receipt.actual.durationMs > request.maxDurationMs) return false;
  if (receipt.actual.outputChars > request.maxOutputChars) return false;
  if (receipt.outcome === "completed") {
    return receipt.actual.terminalOrigin === "runtime" &&
      receipt.actual.observedTerminalStatus === "completed" &&
      receipt.candidate !== null &&
      receipt.candidate.head !== null;
  }
  return receipt.candidate === null;
}

/** A correlated terminal with no candidate can prove failure, never success. */
function interruptedOutputFailure(
  result: MatrixCellResultV1,
  cell: MatrixCellPlanV1,
  expectedProvider: string,
): boolean {
  const receipt = result.receipt;
  if (
    result.status !== "completed" || receipt === null ||
    receipt.outcome !== "interrupted" || receipt.candidate !== null ||
    result.bundle !== null ||
    !receiptIdentityMatches(receipt, cell.request, expectedProvider)
  ) return false;
  const actual = receipt.actual;
  return actual.terminalOrigin === "runtime" &&
    actual.observedTerminalStatus === "interrupted" &&
    typeof receipt.invocationId === "string" &&
    receipt.invocationId.length > 0 &&
    typeof actual.threadId === "string" && actual.threadId.length > 0 &&
    typeof actual.turnId === "string" && actual.turnId.length > 0 &&
    Number.isSafeInteger(actual.durationMs) && actual.durationMs >= 0 &&
    Number.isSafeInteger(cell.request.maxDurationMs) &&
    cell.request.maxDurationMs > 0 &&
    actual.durationMs <= cell.request.maxDurationMs &&
    Number.isSafeInteger(actual.outputChars) &&
    Number.isSafeInteger(cell.request.maxOutputChars) &&
    cell.request.maxOutputChars > 0 &&
    actual.outputChars > cell.request.maxOutputChars;
}

/** Identical duplicate bytes for one cell are a replay; different bytes conflict. */
export function matrixResultsConflictV1(
  a: MatrixCellResultV1,
  b: MatrixCellResultV1,
): boolean {
  return canonicalStringify(a) !== canonicalStringify(b);
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export interface MatrixPlanOptionsV1 {
  waveId: string;
  run: MatrixRunIdentityV1;
  /** Trusted runtime implementation revision the wave is running. */
  runtimeSha: GitSha;
  /** Trusted hosted runtime pointer generation the wave is running. */
  generation: number;
  /** Absolute planner deadline; clamped by the shared run ceiling. */
  deadline: number;
  plannedAt: number;
  runStartedAt?: number;
  modelStartsEnabled?: boolean;
  /** Exact target source port while ranking all repositories on one shared budget/state. */
  githubForRepository?: (repository: RepositoryIdentityV1) => GitHubPort;
  /**
   * Optional planning bound. Defaults to the platform matrix ceiling
   * (`MAX_MATRIX_CELLS`) and is never allowed above it.
   */
  maxCells?: number;
}

export interface MatrixPlanReportV1 {
  plan: MatrixPlanV1;
  /** Ranked records this planner considered. */
  attempted: number;
  /** Grants admitted into the plan. */
  prepared: number;
  /** Considered records that are not fresh implementation starts. */
  notReady: number;
  /** Records whose preparation persisted a wait/refusal step instead. */
  deferred: number;
}

/**
 * Trusted planner. Only records whose NEXT step is a fresh implementation
 * start receive a grant (`isMatrixImplementationReadyV1`); review, delivery,
 * correction, preservation and already-intended records are left to the
 * ordinary serial lifecycle. Every admitted grant has a durable reservation, a
 * persisted implementation intent and the exact request the cell will run; the
 * planner re-reads authoritative state before each candidate.
 */
export async function planMatrixWave(
  deps: RepairCycleDepsV1,
  options: MatrixPlanOptionsV1,
): Promise<MatrixPlanReportV1> {
  const bounds = createRunBounds(deps, {
    deadline: options.deadline,
    runStartedAt: options.runStartedAt,
    modelStartsEnabled: options.modelStartsEnabled,
  });
  const limit = Math.min(
    options.maxCells ?? MAX_MATRIX_CELLS,
    MAX_MATRIX_CELLS,
  );
  const attemptedIds = new Set<string>();
  const cells: MatrixCellPlanV1[] = [];
  const manifest = (entries: MatrixCellPlanV1[]): MatrixPlanV1 => ({
    version: MATRIX_PLAN_VERSION,
    kind: "matrix_plan",
    waveId: options.waveId,
    run: options.run,
    plannedAt: options.plannedAt,
    cells: entries,
  });
  let attempted = 0;
  let deferred = 0;
  let notReady = 0;

  while (cells.length < limit) {
    const context = await loadRepairContext(deps, bounds);
    if (context === null) break;
    const now = deps.clock.now();
    if (now >= bounds.modelCutoff || now >= bounds.runDeadline) break;
    const ranked = rankEligibleWork(context.snapshot, deps.configs, now);
    const nextId = ranked.ordered.find((id) => {
      if (attemptedIds.has(id)) return false;
      const record = context.snapshot.work.find((work) => work.id === id);
      if (record === undefined) return false;
      const config = configForRepository(deps, record.repository);
      return config !== null &&
        isMatrixImplementationReadyV1(record, context.snapshot, config);
    });
    if (nextId === undefined) break;
    attemptedIds.add(nextId);
    const record = context.snapshot.work.find((work) => work.id === nextId);
    if (record === undefined) continue;
    const config = configForRepository(deps, record.repository);
    if (config === null) continue;
    attempted++;
    if (!isMatrixImplementationReadyV1(record, context.snapshot, config)) {
      notReady++;
      continue;
    }
    const outcome = await prepareImplementationStart(
      options.githubForRepository === undefined
        ? deps
        : { ...deps, github: options.githubForRepository(record.repository) },
      context,
      record,
      config,
      async (request) => {
        const reservationId = await deriveReservationId({
          repository: record.repository,
          taskId: record.id,
          head: request.base,
          attempt: record.counters.attempts + 1,
          purpose: record.counters.attempts === 0 ? "implementation" : "retry",
        });
        const candidate: MatrixCellPlanV1 = {
          cellId: await matrixCellIdV1(
            options.waveId,
            record.id,
            reservationId,
          ),
          taskId: record.id,
          repository: record.repository,
          reservationId,
          intentKey: implementationIntentKey(reservationId),
          expectedBase: request.base,
          runtimeSha: options.runtimeSha,
          generation: options.generation,
          requestDigest: await matrixDigestV1(request),
          request,
        };
        // Use exactly the publisher's formatting and UTF-8 byte count BEFORE
        // any reservation/attempt/intent is saved. Smaller later tasks may fit.
        return new TextEncoder().encode(
          JSON.stringify(manifest([...cells, candidate]), null, 2) + "\n",
        ).length <= MAX_MATRIX_ARTIFACT_BYTES;
      },
    );
    if (outcome.kind !== "prepared") {
      deferred++;
      // An ordinary fresh-base refresh is progress, not a failed admission.
      // Reconsider that same task against its persisted current base.
      if (outcome.kind === "progress") {
        const refreshed = await deps.state.readRepair();
        if (
          refreshed.ok && refreshed.value.status === "found" &&
          refreshed.value.snapshot.work.some((entry) =>
            entry.id === record.id && entry.target.base !== record.target.base
          )
        ) {
          attemptedIds.delete(record.id);
        }
      }
      continue;
    }
    const request = outcome.request;
    const cellId = await matrixCellIdV1(
      options.waveId,
      record.id,
      outcome.reservationId,
    );
    cells.push({
      cellId,
      taskId: record.id,
      repository: outcome.record.repository,
      reservationId: outcome.reservationId,
      intentKey: outcome.record.intent?.key ??
        implementationIntentKey(outcome.reservationId),
      expectedBase: request.base,
      runtimeSha: options.runtimeSha,
      generation: options.generation,
      requestDigest: await matrixDigestV1(request),
      request,
    });
  }

  return {
    plan: { ...manifest(cells), plannedAt: deps.clock.now() },
    attempted,
    prepared: cells.length,
    notReady,
    deferred,
  };
}

// ---------------------------------------------------------------------------
// Cell
// ---------------------------------------------------------------------------

export interface MatrixCellDepsV1 {
  /** Trusted fresh clock and original shared run bounds; never artifact claims. */
  clock: Clock;
  bounds: RunBoundsV1;
  /** Full configured session maximum, with the ordinary publication margin. */
  sessionBound: RepositoryConfigV1["sessionBound"];
  /** Read-only authoritative state view; the cell can never write state. */
  state: StateReadView;
  /**
   * Trusted per-cell GitHub port with scoped source-read credentials only. The
   * host composes the real opt-out scope (`scopeLocalRepairIssues`), so a
   * newly added `sentinel:skip` label revokes the read and refuses the start.
   */
  github: Pick<GitHubPort, "readIssue">;
  /** Isolated, credential-free implementation port (existing contract). */
  model: ImplementationPort;
  /**
   * Trusted candidate-object carrier over the isolated cell checkout. Absent
   * means a completed head cannot be transferred, so the cell refuses the
   * result as failed/ambiguous instead of claiming a recoverable candidate.
   */
  bundle?: MatrixBundleExporterV1;
}

function resultBinding(
  grant: MatrixCellGrantV1,
): Omit<
  MatrixCellResultV1,
  "status" | "receipt" | "bundle" | "detail" | "completedAt"
> {
  const { cell } = grant;
  return {
    version: MATRIX_CELL_RESULT_VERSION,
    kind: "matrix_cell_result",
    waveId: grant.waveId,
    cellId: cell.cellId,
    taskId: cell.taskId,
    repository: cell.repository,
    run: grant.run,
    runtimeSha: cell.runtimeSha,
    generation: cell.generation,
    reservationId: cell.reservationId,
    intentKey: cell.intentKey,
    requestDigest: cell.requestDigest,
  };
}

/**
 * Execute exactly one granted `ModelRunRequestV1`. The grant is not
 * self-authenticating: the trusted `actual` identity from the dispatched host
 * must match the grant's run/attempt/launcher/runtime revision/generation, so
 * a rerun or an already-owned cell cannot reuse a still-reserved admission.
 * All pre-start checks are read-only; any refusal is a `not_started`/`failed`
 * result with no model call, and the ingester keeps the charge.
 */
export async function runMatrixCell(
  deps: MatrixCellDepsV1,
  grant: MatrixCellGrantV1,
  actual: MatrixCellActualIdentityV1,
  now: number,
): Promise<MatrixCellResultV1> {
  const { cell } = grant;
  const binding = resultBinding(grant);
  const refuse = (
    status: "failed" | "not_started",
    detail: string,
  ): MatrixCellResultV1 => ({
    ...binding,
    status,
    receipt: null,
    bundle: null,
    detail,
    completedAt: deps.clock.now(),
  });

  // Trusted actual identity, never the grant's own claim.
  if (
    actual.run.runId !== grant.run.runId ||
    actual.run.runAttempt !== grant.run.runAttempt ||
    actual.run.launcherSha !== grant.run.launcherSha
  ) {
    return refuse(
      "failed",
      "actual workflow run identity does not match grant",
    );
  }
  if (
    actual.runtimeSha !== cell.runtimeSha ||
    actual.generation !== cell.generation
  ) {
    return refuse(
      "failed",
      "actual runtime revision/generation does not match grant",
    );
  }

  if (cell.requestDigest !== await matrixDigestV1(cell.request)) {
    return refuse("failed", "planned request digest mismatch");
  }
  if (cell.request.taskId !== cell.taskId) {
    return refuse("failed", "planned request task identity mismatch");
  }
  if (cell.request.base !== cell.expectedBase) {
    return refuse("failed", "planned request base mismatch");
  }
  if (
    cell.request.repository.owner !== cell.repository.owner ||
    cell.request.repository.name !== cell.repository.name ||
    cell.request.repository.installationId !== cell.repository.installationId
  ) {
    return refuse("failed", "planned request repository mismatch");
  }

  // Fresh source re-read through the host's opt-out-scoped port: a skip label,
  // close or change after planning consumes no inference.
  const issueNumber = cell.request.issue?.number ?? null;
  if (issueNumber !== null) {
    const read = await deps.github.readIssue(issueNumber);
    if (!read.ok) {
      return refuse("not_started", "source issue read is unavailable");
    }
    const issue = read.value;
    if (issue === null || issue.state !== "open") {
      return refuse("not_started", "source issue is no longer eligible");
    }
    const planned = cell.request.issue;
    if (
      planned !== null &&
      (issue.title !== planned.title || issue.body !== planned.body)
    ) {
      return refuse("not_started", "source issue changed after planning");
    }
    const relations = issue.relations;
    if (
      relations !== undefined &&
      (relations.subIssueCount > 0 || relations.openBlockers.length > 0)
    ) {
      return refuse("not_started", "source issue has open native dependencies");
    }
  }

  // Durable identity: the exact reservation and implementation intent planned
  // by the trusted planner must still be current.
  const stateRead = await deps.state.readRepair();
  if (!stateRead.ok || stateRead.value.status !== "found") {
    return refuse("not_started", "authoritative repair state is unavailable");
  }
  const record = stateRead.value.snapshot.work.find((work) =>
    work.id === cell.taskId
  );
  if (record === undefined) {
    return refuse("not_started", "planned task is not in authoritative state");
  }
  if (
    !sameRepository(record.repository, cell.repository) ||
    record.source.kind !== "issue" ||
    record.related.issueNumber !== issueNumber || cell.request.issue === null
  ) {
    return refuse(
      "not_started",
      "planned task source/repository does not match authoritative state",
    );
  }
  const intent = record.intent;
  if (
    intent === null || intent.kind !== "implementation" ||
    intent.requestId !== cell.reservationId || intent.key !== cell.intentKey ||
    intent.observedBase !== cell.expectedBase || intent.expectedHead !== null
  ) {
    return refuse(
      "not_started",
      "planned implementation intent is not current",
    );
  }
  if (record.target.base !== cell.expectedBase) {
    return refuse("not_started", "planned base is no longer current");
  }
  const reservation = stateRead.value.snapshot.reservations.find((entry) =>
    entry.id === cell.reservationId
  );
  if (
    reservation === undefined || reservation.outcome !== "reserved" ||
    !sameRepository(reservation.repository, record.repository) ||
    reservation.taskId !== record.id ||
    reservation.head !== cell.expectedBase ||
    reservation.attempt !== record.counters.attempts ||
    (reservation.purpose !== "implementation" &&
      reservation.purpose !== "retry")
  ) {
    return refuse("not_started", "planned reservation is not reserved");
  }

  // Source and durable-intent reads were awaited wall-clock work. Recheck at
  // the final start boundary with the full configured session and margin.
  const startsAt = deps.clock.now();
  if (
    deps.sessionBound === null ||
    startsAt >= deps.bounds.modelCutoff ||
    startsAt + deps.sessionBound.maxDurationMs + OPERATION_MARGIN_MS >
      deps.bounds.runDeadline
  ) {
    return refuse(
      "not_started",
      "implementation start is past the model cutoff or no longer fits the run bounds",
    );
  }

  // Exactly one model session; the port owns the isolated, credential-free
  // checkout and validates the request against its configured model/effort.
  const receipt = await deps.model.runModel(cell.request);
  if (!receipt.ok) {
    return refuse("failed", `model run failed (${receipt.error.kind})`);
  }
  // Candidate objects must be durably carried by a real bounded bundle before
  // a completed result exists: a candidate head with no transferred objects
  // stays failed/ambiguous, never a fabricated recovery.
  const candidate = receipt.value.candidate;
  let bundle: MatrixCellBundleV1 | null = null;
  if (candidate !== null && candidate.head !== null) {
    if (deps.bundle === undefined) {
      return refuse("failed", "candidate bundle capability is unavailable");
    }
    const file = matrixBundleFileNameV1(cell.cellId);
    const created = await deps.bundle.create({
      base: cell.request.base,
      head: candidate.head,
      checkpointSha: candidate.checkpointSha,
      file,
    });
    if (created === null) {
      return refuse("failed", "candidate bundle could not be created");
    }
    bundle = {
      file,
      digest: created.digest,
      head: candidate.head,
      checkpointSha: candidate.checkpointSha,
    };
  }
  return {
    ...binding,
    status: "completed",
    receipt: {
      ...receipt.value,
      // Runtime error text stays in private model evidence. Export only a fixed
      // classification; the exact trusted loop-stop marker retains its meaning.
      error: receipt.value.error === null ||
          receipt.value.error === "failed_command_loop"
        ? receipt.value.error
        : "runtime_error",
    },
    bundle,
    detail: null,
    completedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Ingester
// ---------------------------------------------------------------------------

export type MatrixIngestDispositionV1 =
  | "ingested"
  | "missing"
  | "duplicate"
  | "conflict"
  | "foreign"
  | "absent"
  | "binding_mismatch"
  | "receipt_rejected"
  | "candidate_unavailable"
  | "state_error";

export interface MatrixIngestEntryV1 {
  cellId: string;
  disposition: MatrixIngestDispositionV1;
  detail: string | null;
}

export interface MatrixIngestReportV1 {
  waveId: string;
  entries: MatrixIngestEntryV1[];
  ingested: number;
}

export interface MatrixIngestOptionsV1 {
  deadline: number;
  runStartedAt?: number;
  /** Trusted provider identity the runtime route must have used. */
  expectedProvider: string;
  /**
   * Trusted per-target bundle importer. A completed result with a candidate
   * head is rejected as `candidate_unavailable` unless its bundle digest and
   * objects verify into this importer's repository.
   */
  bundleImporter?: MatrixBundleImporterV1;
}

function resultMatchesCell(
  plan: MatrixPlanV1,
  cell: MatrixCellPlanV1,
  result: MatrixCellResultV1,
): boolean {
  return result.waveId === plan.waveId &&
    result.cellId === cell.cellId &&
    result.taskId === cell.taskId &&
    sameRepository(result.repository, cell.repository) &&
    result.run.runId === plan.run.runId &&
    result.run.runAttempt === plan.run.runAttempt &&
    result.run.launcherSha === plan.run.launcherSha &&
    result.runtimeSha === cell.runtimeSha &&
    result.generation === cell.generation &&
    result.reservationId === cell.reservationId &&
    result.intentKey === cell.intentKey &&
    result.requestDigest === cell.requestDigest;
}

/**
 * Trusted, serialized, idempotent ingestion. Results are applied one cell at a
 * time against a FRESH authoritative context, so a successful sibling is never
 * rolled back and a restarted finalizer cannot double-apply. Conflicting
 * duplicate artifacts for one cell are rejected instead of picking the first;
 * identical reruns stay idempotent. A missing result changes nothing: the
 * durable reservation/intent stays charged and unreconciled. A completed
 * result whose receipt does not re-verify against the exact planned request
 * causes NO state update.
 */
export async function ingestMatrixResults(
  deps: RepairCycleDepsV1,
  plan: MatrixPlanV1,
  results: readonly MatrixCellResultV1[],
  options: MatrixIngestOptionsV1,
): Promise<MatrixIngestReportV1> {
  const bounds: RunBoundsV1 = createRunBounds(deps, {
    deadline: options.deadline,
    runStartedAt: options.runStartedAt,
  });
  const entries: MatrixIngestEntryV1[] = [];
  const cellById = new Map(plan.cells.map((cell) => [cell.cellId, cell]));
  const chosen = new Map<string, MatrixCellResultV1>();
  const conflicted = new Set<string>();

  for (const result of results) {
    const cell = cellById.get(result.cellId);
    if (cell === undefined) {
      entries.push({
        cellId: result.cellId,
        disposition: "foreign",
        detail: "result does not belong to this wave plan",
      });
      continue;
    }
    const existing = chosen.get(result.cellId);
    if (existing !== undefined) {
      if (matrixResultsConflictV1(existing, result)) {
        chosen.delete(result.cellId);
        conflicted.add(result.cellId);
      }
      continue;
    }
    if (conflicted.has(result.cellId)) continue;
    if (!resultMatchesCell(plan, cell, result)) {
      entries.push({
        cellId: result.cellId,
        disposition: "binding_mismatch",
        detail: "result binding does not match the grant",
      });
      continue;
    }
    chosen.set(result.cellId, result);
  }

  for (const cellId of conflicted) {
    entries.push({
      cellId,
      disposition: "conflict",
      detail: "conflicting duplicate result artifacts for one cell",
    });
  }

  let ingested = 0;
  for (const cell of plan.cells) {
    if (conflicted.has(cell.cellId)) continue;
    const result = chosen.get(cell.cellId);
    if (result === undefined) {
      entries.push({
        cellId: cell.cellId,
        disposition: "missing",
        detail: "no result artifact; durable charge stays unreconciled",
      });
      continue;
    }
    const context = await loadRepairContext(deps, bounds);
    if (context === null) {
      entries.push({
        cellId: cell.cellId,
        disposition: "state_error",
        detail: "repair state unavailable",
      });
      break;
    }
    const record = context.snapshot.work.find((work) =>
      work.id === cell.taskId
    );
    if (record === undefined) {
      entries.push({
        cellId: cell.cellId,
        disposition: "absent",
        detail: "planned task is no longer present",
      });
      continue;
    }
    const reservation = context.snapshot.reservations.find((entry) =>
      entry.id === cell.reservationId
    );
    if (
      !sameRepository(record.repository, cell.repository) ||
      record.source.kind !== "issue" ||
      record.related.issueNumber !== cell.request.issue?.number ||
      record.target.base !== cell.expectedBase ||
      reservation === undefined ||
      !sameRepository(reservation.repository, record.repository) ||
      reservation.taskId !== record.id ||
      reservation.head !== cell.expectedBase ||
      reservation.attempt !== record.counters.attempts ||
      (reservation.purpose !== "implementation" &&
        reservation.purpose !== "retry")
    ) {
      entries.push({
        cellId: cell.cellId,
        disposition: "binding_mismatch",
        detail: "grant does not bind authoritative task/admission",
      });
      continue;
    }
    const config = configForRepository(deps, cell.repository);
    if (config === null) {
      entries.push({
        cellId: cell.cellId,
        disposition: "binding_mismatch",
        detail: "repository is not configured",
      });
      continue;
    }
    const intent = record.intent;
    if (
      intent?.kind === "candidate_preservation" &&
      intent.requestId === cell.reservationId &&
      intent.key === cell.intentKey
    ) {
      // The receipt was already consumed. Restore only its exact saved objects;
      // never settle this admission again or reopen implementation.
      const candidate = result.receipt?.candidate;
      const expectedRef = await candidatePreservationRef(
        record.repository,
        record.id,
        cell.intentKey,
      );
      if (
        reservation.outcome !== "submitted" || reservation.settledAt === null ||
        result.status !== "completed" || result.receipt === null ||
        candidate?.head === null ||
        candidate === undefined || candidate === null ||
        candidate.head !== record.target.head ||
        candidate.checkpointSha !== (record.target.checkpoint?.sha ?? null) ||
        (record.target.checkpoint !== null &&
          record.target.checkpoint.branch !== candidateBranch(record.id)) ||
        intent.expectedHead !== record.target.head ||
        intent.observedBase !== cell.expectedBase ||
        intent.branch !== expectedRef || intent.pr !== null ||
        intent.resultId !== null ||
        record.target.candidateState?.preserved !== null ||
        !verifyMatrixReceiptV1(
          result.receipt,
          cell.request,
          options.expectedProvider,
        )
      ) {
        entries.push({
          cellId: cell.cellId,
          disposition: "binding_mismatch",
          detail: "saved preservation does not bind authenticated candidate",
        });
        continue;
      }
      if (
        options.bundleImporter === undefined || result.bundle === null ||
        result.bundle.head !== candidate.head ||
        result.bundle.checkpointSha !== candidate.checkpointSha ||
        result.bundle.file !== matrixBundleFileNameV1(cell.cellId) ||
        !await options.bundleImporter.import({
          base: cell.expectedBase,
          file: result.bundle.file,
          digest: result.bundle.digest,
          head: candidate.head!,
          checkpointSha: candidate.checkpointSha,
        })
      ) {
        entries.push({
          cellId: cell.cellId,
          disposition: "candidate_unavailable",
          detail: "saved candidate artifact objects are unavailable",
        });
        continue;
      }
      entries.push({
        cellId: cell.cellId,
        disposition: "duplicate",
        detail:
          "receipt already consumed; exact saved candidate objects rehydrated",
      });
      continue;
    }
    if (
      intent === null || intent.kind !== "implementation" ||
      intent.requestId !== cell.reservationId || intent.key !== cell.intentKey
    ) {
      // Already consumed by an earlier/duplicate ingest or reconciled by the
      // ordinary cycle: replaying this artifact is a no-op.
      entries.push({
        cellId: cell.cellId,
        disposition: "duplicate",
        detail: "implementation intent already consumed",
      });
      continue;
    }
    if (interruptedOutputFailure(result, cell, options.expectedProvider)) {
      if (
        reservation.outcome === "ambiguous" && reservation.settledAt !== null &&
        record.nextStep === "blocked"
      ) {
        entries.push({
          cellId: cell.cellId,
          disposition: "duplicate",
          detail: "authenticated interrupted output failure already accounted",
        });
        continue;
      }
      const step = await settleFailedImplementation(
        deps,
        context,
        record,
        cell.reservationId,
        "model run did not complete with a trusted candidate: interrupted output bound exceeded",
      );
      if (step.kind === "state_error") {
        entries.push({
          cellId: cell.cellId,
          disposition: "state_error",
          detail: step.detail,
        });
        continue;
      }
    } else if (result.status === "completed" && result.receipt !== null) {
      if (
        !verifyMatrixReceiptV1(
          result.receipt,
          cell.request,
          options.expectedProvider,
        )
      ) {
        // No state update: the reservation/intent stay charged and
        // unreconciled so a later trusted reconciliation can decide.
        entries.push({
          cellId: cell.cellId,
          disposition: "receipt_rejected",
          detail: "receipt does not verify against the exact planned request",
        });
        continue;
      }
      const candidateHead = result.receipt.candidate?.head ?? null;
      if (candidateHead !== null) {
        // The candidate objects must become REAL objects in the trusted
        // per-target mirror before the production consumer runs: digest,
        // bundle verification, fetch, head presence and base ancestry are all
        // actual Git checks by the importer. Missing bytes stay unavailable.
        if (options.bundleImporter === undefined || result.bundle === null) {
          entries.push({
            cellId: cell.cellId,
            disposition: "candidate_unavailable",
            detail: "candidate bundle importer or bundle is unavailable",
          });
          continue;
        }
        const imported = await options.bundleImporter.import({
          base: cell.expectedBase,
          file: result.bundle.file,
          digest: result.bundle.digest,
          head: candidateHead,
          checkpointSha: result.bundle.checkpointSha,
        });
        if (!imported) {
          entries.push({
            cellId: cell.cellId,
            disposition: "candidate_unavailable",
            detail: "candidate bundle did not verify into the trusted mirror",
          });
          continue;
        }
      }
      const step = await handleModelReceipt(
        deps,
        context,
        record,
        cell.reservationId,
        result.receipt,
        config,
      );
      if (step.kind === "state_error") {
        entries.push({
          cellId: cell.cellId,
          disposition: "state_error",
          detail: step.detail,
        });
        continue;
      }
    } else {
      const step = await settleFailedImplementation(
        deps,
        context,
        record,
        cell.reservationId,
        result.detail ?? "matrix cell produced no trusted receipt",
      );
      if (step.kind === "state_error") {
        entries.push({
          cellId: cell.cellId,
          disposition: "state_error",
          detail: step.detail,
        });
        continue;
      }
    }
    entries.push({
      cellId: cell.cellId,
      disposition: "ingested",
      detail: null,
    });
    ingested++;
  }

  return { waveId: plan.waveId, entries, ingested };
}

// ---------------------------------------------------------------------------
// Artifact IO and callable host entrypoints (fixed paths, no new flags/env)
// ---------------------------------------------------------------------------

async function writeJsonArtifact(
  path: string,
  value: unknown,
): Promise<string> {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (new TextEncoder().encode(text).length > MAX_MATRIX_ARTIFACT_BYTES) {
    throw new Error("matrix artifact exceeds the bounded size");
  }
  const slash = path.lastIndexOf("/");
  if (slash > 0) await Deno.mkdir(path.slice(0, slash), { recursive: true });
  await Deno.writeTextFile(path, text);
  return await matrixDigestV1(value);
}

async function readJsonArtifact(path: string): Promise<unknown> {
  const text = await Deno.readTextFile(path);
  if (new TextEncoder().encode(text).length > MAX_MATRIX_ARTIFACT_BYTES) {
    throw new Error("matrix artifact exceeds the bounded size");
  }
  return JSON.parse(text) as unknown;
}

/** Planner entrypoint: writes the immutable plan artifact, returns its digest. */
export async function runMatrixPlanEntrypoint(input: {
  deps: RepairCycleDepsV1;
  options: MatrixPlanOptionsV1;
  planPath?: string;
}): Promise<MatrixPlanReportV1 & { planDigest: string }> {
  const report = await planMatrixWave(input.deps, input.options);
  const planDigest = await writeJsonArtifact(
    input.planPath ?? MATRIX_PLAN_PATH,
    report.plan,
  );
  return { ...report, planDigest };
}

/**
 * Cell entrypoint: reads one strictly parsed grant artifact, runs it under the
 * host's TRUSTED actual identity, and writes one result artifact.
 */
export async function runMatrixCellEntrypoint(input: {
  deps: MatrixCellDepsV1;
  actual: MatrixCellActualIdentityV1;
  cellPath?: string;
  resultPath?: string;
  completedAt?: number;
}): Promise<MatrixCellResultV1> {
  const raw = await readJsonArtifact(input.cellPath ?? MATRIX_CELL_PATH);
  const parsed = tryParseMatrixCellGrantV1(raw);
  if (!parsed.ok) {
    throw new Error("cell grant artifact is malformed");
  }
  const result = await runMatrixCell(
    input.deps,
    parsed.value,
    input.actual,
    input.completedAt ?? Date.now(),
  );
  await writeJsonArtifact(input.resultPath ?? MATRIX_RESULT_PATH, result);
  return result;
}

/** Ingester entrypoint: strictly parses the plan and every result artifact. */
export async function runMatrixIngestEntrypoint(input: {
  deps: RepairCycleDepsV1;
  options: MatrixIngestOptionsV1;
  planPath?: string;
  resultsDir?: string;
}): Promise<MatrixIngestReportV1> {
  const rawPlan = await readJsonArtifact(input.planPath ?? MATRIX_PLAN_PATH);
  const plan = tryParseMatrixPlanV1(rawPlan);
  if (!plan.ok) {
    throw new Error("plan artifact is malformed");
  }
  const results: MatrixCellResultV1[] = [];
  const dir = input.resultsDir ?? MATRIX_RESULTS_DIR;
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const raw = await readJsonArtifact(`${dir}/${entry.name}`);
      const parsed = tryParseMatrixCellResultV1(raw);
      if (!parsed.ok) continue;
      results.push(parsed.value);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return await ingestMatrixResults(
    input.deps,
    plan.value,
    results,
    input.options,
  );
}
