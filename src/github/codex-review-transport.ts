/**
 * GitHubCodexReviewTransport: durable review-service transport.
 *
 * The durable operation journal is the authenticated pending GitHub review
 * itself: an intent body is created before any model work, a running body is
 * persisted (and read back byte-exact) before the single turn/start, and a
 * ready body carrying the full validated structured result is persisted before
 * publication. A fresh transport instance reconciles exclusively through those
 * authoritative records — no in-memory-only success, no process adoption from
 * remote metadata, no blind mutation retry and no duplicate model start.
 *
 * Lifecycle (hard enforced):
 *   validate identity/deadline -> immutable snapshot -> exhaustive PR review
 *   reconciliation -> exact pending intent create (lost-create reconciliation
 *   by exact identity, never a second create) -> authenticated intent readback
 *   -> prepare producer -> running journal + byte-exact readback -> deadline
 *   recheck -> exactly one start (owned promise registered before returning).
 *
 * The owned promise closes the producer session, folds the close outcome into
 * the completion (`finalizeReviewCompletion`), persists the exact ready journal
 * (or a static unavailable disposition only after process settlement is
 * proved), reconciles the exact ready bytes and submits COMMENT. Lost submit
 * responses are reconciled by exact review id; only a standing COMMENTED exact
 * author/head/body proves publication.
 *
 * There is no independent model-admission authority here: the caller's durable
 * reservation/work intent is the authority for the submission. At most three
 * operations are active at once, overlapping submissions per operation key or
 * per PR are rejected, and admission stops permanently once drain starts.
 */

import type { GitSha } from "../contracts/brands.ts";
import type {
  Clock,
  PortResultV1,
  ReviewDrainOperationV1,
  ReviewDrainReportV1,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { GitHubApiClient } from "./client.ts";
import {
  CLOSE_BOUND_MS,
  finalizeReviewCompletion,
  MAX_REVIEW_TOTAL_MS,
  type PreparedStructuredReviewV1,
  type StructuredReviewCloseV1,
  type StructuredReviewOutcomeV1,
  type StructuredReviewPrepareV1,
} from "./codex-reviewer.ts";
import {
  parseReviewJournalBody,
  renderReviewJournalBody,
  type ReviewJournalReadyV1,
  type ReviewJournalRunningV1,
  type ReviewJournalV1,
  reviewResultDigest,
  type ReviewResultV1,
} from "./review-journal.ts";
import { reviewRecordId } from "./review-normalize.ts";
import type { ReviewSnapshotV1 } from "./review-snapshot.ts";
import type { ReviewRequestReadV1 } from "./review-service.ts";
import type {
  ReviewRequestSubmitV1,
  ReviewServiceReadV1,
  ReviewServiceTransportV1,
  ReviewSubmitOutcomeV1,
} from "./review-service.ts";
import type { GitHubReviewWireV1 } from "./wire.ts";

/** Trusted immutable snapshot capability (satisfied by `GitReviewSnapshot`). */
export interface GitReviewSnapshotCaptureV1 {
  capture(
    input: { base: GitSha; head: GitSha },
  ): Promise<PortResultV1<ReviewSnapshotV1>>;
}

/** Trusted producer prepare capability (satisfied by `CodexStructuredReviewer`). */
export interface CodexReviewPrepareCapabilityV1 {
  prepare(
    request: StructuredReviewPrepareV1,
  ): Promise<PortResultV1<PreparedStructuredReviewV1>>;
}

export interface GitHubCodexReviewTransportOptionsV1 {
  /** Exact authenticated GitHub API client (no second raw HTTP client). */
  client: GitHubApiClient;
  /** Exact repository identity of the one configured target. */
  repository: RepositoryIdentityV1;
  /** Exact trusted publisher login that authors and publishes every review. */
  publisher: string;
  clock: Clock;
  /** Owning run identity persisted in every journal execution record. */
  ownerRunId: string;
  /** Concrete trusted Git snapshot producer (public capture capability). */
  snapshot: GitReviewSnapshotCaptureV1;
  /** Concrete structured reviewer (public prepare capability). */
  reviewer: CodexReviewPrepareCapabilityV1;
  /** Finite concurrent operation bound; default and maximum three. */
  maxActiveReviews?: number;
}

/** The single finite review bound used for a submission that must fit. */
export const REVIEW_TRANSPORT_TOTAL_MS = MAX_REVIEW_TOTAL_MS;

/** Static sanitized details; never an echoed value or raw error. */
const DETAIL_INPUT =
  "review transport: invalid submission identity or deadline";
const DETAIL_PUBLISHER =
  "review transport: submission publisher is not the trusted publisher";
const DETAIL_DRAIN = "review transport: review submissions are closed";
const DETAIL_OVERLAP =
  "review transport: an owned review operation is already active";
const DETAIL_CAPACITY = "review transport: active review capacity is exhausted";
const DETAIL_SNAPSHOT =
  "review transport: the immutable review snapshot is unavailable";
const DETAIL_RECONCILE =
  "review transport: remote review reconciliation is unavailable or conflicting";
const DETAIL_CREATE =
  "review transport: pending review creation was not reconciled";
const DETAIL_READBACK =
  "review transport: exact review readback did not match the durable journal";
const DETAIL_PREPARE = "review transport: structured review preparation failed";
const DETAIL_RUNNING =
  "review transport: the running journal could not be durably persisted";
const DETAIL_START = "review transport: the single review start was rejected";
const DETAIL_PUBLISH =
  "review transport: the ready journal could not be published";
const DETAIL_FAILURE =
  "review transport: review operation state is unavailable";
const DETAIL_READ = "review transport: review read failed";

/** Static sanitized summary of a standing unavailable disposition. */
const UNAVAILABLE_SUMMARY =
  "structured review unavailable: the review did not produce a validated result";

/** Exactly-one binding of one publisher record during reconciliation. */
type BoundRecordV1 =
  | { kind: "one"; review: GitHubReviewWireV1; journal: ReviewJournalV1 }
  | { kind: "none" }
  | { kind: "conflict" };

type OperationPhaseV1 =
  | "intent"
  | "running"
  | "ready"
  | "published"
  | "failed";

interface OwnedReviewV1 {
  operationKey: string;
  requestId: string;
  prNumber: number;
  expectedHead: GitSha;
  expectedBase: GitSha;
  requestedAt: number;
  latestStartAt: number;
  settleBy: number;
  phase: OperationPhaseV1;
  reviewId: number | null;
  /** True once any journal body was durably created on the remote. */
  remoteJournal: boolean;
  prepared: PreparedStructuredReviewV1 | null;
  /** The single owned close attempt; reused so close is never duplicated. */
  closePromise: Promise<StructuredReviewCloseV1> | null;
  /** In-flight submission/publication work; retained for drain, never lost. */
  submission: Promise<void> | null;
  /** False until the retained submission promise itself has settled. */
  submissionSettled: boolean;
  running: Promise<void> | null;
  /** False until the retained owned-completion promise itself has settled. */
  runningSettled: boolean;
  done: boolean;
  processSettled: boolean;
  /** A durable ready journal (published or awaiting publication). */
  readyDurable: boolean;
  fault: string | null;
}

/**
 * An owned operation is active while its admission/journal work is pending OR
 * while a retained prepared handle has not been proved settled. `done` alone is
 * not settlement: a run that ended with an UNPROVED close still owns the
 * producer process, so it must block same-key replacement and still count
 * against active capacity until the close proves settlement.
 */
function isActiveReview(op: OwnedReviewV1): boolean {
  if (!op.done) return true;
  return op.prepared !== null && !op.processSettled;
}

/** Bounded race of an owned promise against an absolute instant. */
async function waitUntil(
  promise: Promise<void>,
  deadline: number,
  now: () => number,
): Promise<"settled" | "timeout"> {
  const remaining = deadline - now();
  if (remaining <= 0) {
    // An already-expired deadline still observes already-settled owned work
    // (the settled handler is enqueued before the timeout fallback).
    return await Promise.race([
      promise.then(() => "settled" as const, () => "settled" as const),
      Promise.resolve("timeout" as const),
    ]);
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then(() => "settled" as const, () => "settled" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remaining);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export class GitHubCodexReviewTransport implements ReviewServiceTransportV1 {
  private readonly client: GitHubApiClient;
  private readonly repository: RepositoryIdentityV1;
  private readonly publisher: string;
  private readonly clock: Clock;
  private readonly ownerRunId: string;
  private readonly snapshot: GitReviewSnapshotCaptureV1;
  private readonly reviewer: CodexReviewPrepareCapabilityV1;
  private readonly maxActiveReviews: number;
  private readonly operations = new Map<string, OwnedReviewV1>();
  private draining = false;

  constructor(options: GitHubCodexReviewTransportOptionsV1) {
    this.client = options.client;
    this.repository = options.repository;
    this.publisher = options.publisher;
    this.clock = options.clock;
    this.ownerRunId = options.ownerRunId;
    this.snapshot = options.snapshot;
    this.reviewer = options.reviewer;
    const maxActive = options.maxActiveReviews ?? 3;
    this.maxActiveReviews = Number.isSafeInteger(maxActive) && maxActive > 0
      ? Math.min(maxActive, 3)
      : 3;
  }

  // -------------------------------------------------------------------------
  // submitReview
  // -------------------------------------------------------------------------

  async submitReview(
    request: ReviewRequestSubmitV1,
  ): Promise<PortResultV1<ReviewSubmitOutcomeV1>> {
    const now = this.clock.now();
    const validated = this.validateSubmission(request, now);
    if (!validated.ok) return validated.error;
    const op = validated.value;
    if (this.draining) return portError("unavailable", DETAIL_DRAIN);
    const existing = this.operations.get(op.operationKey);
    if (existing !== undefined && isActiveReview(existing)) {
      return portError("conflict", DETAIL_OVERLAP);
    }
    for (const other of this.operations.values()) {
      if (isActiveReview(other) && other.prNumber === op.prNumber) {
        return portError("conflict", DETAIL_OVERLAP);
      }
    }
    if (this.activeCount() >= this.maxActiveReviews) {
      return portError("conflict", DETAIL_CAPACITY);
    }
    this.operations.set(op.operationKey, op);

    // The admission work is owned from the first await: the promise is
    // registered before the caller can advance, and drain awaits it so a
    // submission in flight can never start a model after admission stopped.
    op.submissionSettled = false;
    const submission = (async () => {
      try {
        return await this.runSubmission(op);
      } catch {
        // A thrown transport fault is sanitized; any owned prepared session is
        // still closed (settlement is never assumed) and the operation settles
        // locally so no handle is left unowned.
        await this.closePrepared(op);
        op.phase = "failed";
        op.done = true;
        return portError("unavailable", DETAIL_FAILURE);
      }
    })();
    op.submission = submission.then(
      () => {
        op.submissionSettled = true;
      },
      () => {
        op.submissionSettled = true;
      },
    );
    return await submission;
  }

  /**
   * One bounded submission run: immutable snapshot -> exhaustive
   * reconciliation -> exact intent create/recovery -> exact authenticated
   * intent readback -> prepare -> durable running journal + byte-exact
   * readback -> deadline recheck -> exactly one start.
   */
  private async runSubmission(
    op: OwnedReviewV1,
  ): Promise<PortResultV1<ReviewSubmitOutcomeV1>> {
    // Phase A: immutable snapshot of the exact reviewed range. A failure is a
    // retryable transport failure, never a reason to start any model work.
    const captured = await this.snapshot.capture({
      base: op.expectedBase,
      head: op.expectedHead,
    });
    if (!captured.ok) return this.fail(op, DETAIL_SNAPSHOT);

    // The snapshot is awaited work: a deadline that no longer admits the full
    // review bound must not launch a last-second review. Nothing durable was
    // mutated for this operation yet beyond the local record.
    if (!this.admitsStart(op)) return this.reject(op);

    // Phase B: exhaustive reconciliation of the named PR's reviews BEFORE any
    // create. An intent or running record found here was created by an earlier
    // call: it is never permission to prepare or start a model, and a ready
    // pending journal is recovered through the observation path (readReview).
    const reconciled = await this.reconcile(op);
    if (reconciled.kind === "error") {
      return this.fail(op, reconciled.detail);
    }
    if (reconciled.kind === "published") {
      return this.adoptPublished(op, reconciled.reviewId);
    }
    if (reconciled.kind === "record") {
      return this.fail(op, DETAIL_RECONCILE);
    }

    const intentBody = this.render(this.intentJournal(op));
    if (intentBody === null) return this.fail(op, DETAIL_INPUT);
    const created = await this.client.createPendingReview(
      op.prNumber,
      op.expectedHead,
      intentBody,
    );
    if (!created.ok) return this.fail(op, created.error.detail);

    let reviewId: number;
    if (created.value.status === "applied") {
      reviewId = created.value.review.id;
    } else {
      // Lost create response: exactly one exact-identity lookup. Only a record
      // whose EXACT intent bytes are this call's expected intent proves the
      // create applied; uncertain absence never authorizes a second create.
      const recovered = await this.reconcileOwnCreate(op, intentBody);
      if (recovered.kind === "error") return this.fail(op, recovered.detail);
      if (recovered.kind === "create") {
        return this.fail(op, DETAIL_CREATE, true);
      }
      if (recovered.kind === "published") {
        return this.adoptPublished(op, recovered.reviewId);
      }
      if (recovered.kind !== "own-intent") {
        return this.fail(op, DETAIL_RECONCILE);
      }
      reviewId = recovered.reviewId;
    }
    op.reviewId = reviewId;
    op.remoteJournal = true;

    // Phase C: authenticated exact-intent readback. The raw review id, author,
    // head, the complete journal identity and the exact intended body bytes
    // must stand before any producer work.
    const intentReadback = await this.readPhase(op, reviewId, {
      phase: "intent",
      body: intentBody,
    });
    if (intentReadback.kind !== "ok") {
      return this.fail(op, DETAIL_READBACK);
    }

    if (!this.admitsStart(op)) return this.reject(op);

    // Phase D: prepare the producer (bounded; no turn exists yet).
    const prepared = await this.reviewer.prepare({
      snapshot: captured.value,
      requestId: op.requestId,
      invocationId: this.invocationId(op),
      ownerRunId: this.ownerRunId,
      latestStartAt: op.latestStartAt,
      settleBy: op.settleBy,
    });
    if (!prepared.ok) {
      return this.fail(op, DETAIL_PREPARE);
    }
    op.prepared = prepared.value;
    // Preparation is awaited work too: recheck before persisting running work.
    if (!this.admitsStart(op)) {
      await this.closePrepared(op);
      return this.reject(op);
    }

    // Phase E: durable running journal with the real prepared identity, then a
    // byte-exact readback (body AND prepared execution) BEFORE the single
    // start. An ambiguous update is reconciled by that same exact readback; the
    // update is never repeated blindly.
    const running: ReviewJournalRunningV1 = {
      ...this.intentJournal(op),
      phase: "running",
      reviewId,
      execution: prepared.value.execution,
    };
    const runningBody = this.render(running);
    if (runningBody === null) {
      await this.closePrepared(op);
      return this.fail(op, DETAIL_INPUT, true);
    }
    const persisted = await this.client.updatePendingReview(
      op.prNumber,
      reviewId,
      runningBody,
    );
    if (!persisted.ok) {
      await this.closePrepared(op);
      return this.fail(op, DETAIL_RUNNING);
    }
    const runningReadback = await this.readPhase(op, reviewId, {
      phase: "running",
      body: runningBody,
      execution: prepared.value.execution,
    });
    if (runningReadback.kind !== "ok") {
      await this.closePrepared(op);
      return this.fail(op, DETAIL_RUNNING, true);
    }
    if (!this.admitsStart(op)) {
      // The durable running journal stands; the review remains charged and a
      // fresh run observes running-without-owned-process as unavailable.
      await this.closePrepared(op);
      return this.fail(op, DETAIL_START, true);
    }
    op.phase = "running";

    // Phase F: exactly one start. The owned promise is registered BEFORE the
    // caller is allowed to advance, with rejection and finalization handlers
    // attached so the run can progress independently.
    op.runningSettled = false;
    op.running = this.ownReview(op, prepared.value);
    return portOk({
      status: "submitted",
      requestId: op.requestId,
      requestedAt: op.requestedAt,
    });
  }

  // -------------------------------------------------------------------------
  // readReview
  // -------------------------------------------------------------------------

  async readReview(
    request: ReviewRequestReadV1,
  ): Promise<PortResultV1<ReviewServiceReadV1>> {
    const operationKey = request.operationKey;
    const requestId = request.requestId;
    if (
      (operationKey === null && requestId === null) ||
      !Number.isSafeInteger(request.prNumber) || request.prNumber < 1
    ) {
      return portError("invalid", DETAIL_INPUT);
    }
    // The local fast path binds the requested PR and EVERY supplied identity:
    // the first map match alone is never an exact live operation.
    const local = this.matchLocal(request);
    if (local !== undefined && isActiveReview(local)) {
      // An exact live owned operation is the only source of a `pending` read.
      return portOk(this.liveReceipt(local));
    }

    const read = await this.client.readReviews(request.prNumber);
    if (!read.ok) return portError(read.error.kind, DETAIL_READ);
    const bound = await this.bindRecords({
      operationKey,
      requestId,
      prNumber: request.prNumber,
    }, read.value);
    if (bound.kind !== "one") return portOk(this.unavailableReceipt(request));

    // A durable ready journal awaiting publication is recovered EXACTLY here,
    // on the actual observation path: the original body and identities are
    // reused, and no snapshot, preparation, model start or new budget
    // reservation happens.
    if (bound.journal.phase === "ready" && bound.review.state === "pending") {
      return await this.publishDurableReady(
        request,
        bound.journal,
        bound.review,
      );
    }
    if (bound.journal.phase === "ready" && bound.review.state !== "commented") {
      return portOk(this.unavailableReceipt(request));
    }
    if (
      bound.journal.phase !== "ready" &&
      (bound.review.state !== "pending" || bound.review.submittedAt !== null)
    ) {
      return portOk(this.unavailableReceipt(request));
    }
    return portOk(this.journalReceipt(bound.journal, bound.review));
  }

  // -------------------------------------------------------------------------
  // drain
  // -------------------------------------------------------------------------

  /**
   * Stop admission permanently, then await or interrupt every owned review
   * operation — including an in-flight submission and an observation-driven
   * journal publication — and its journal finalization inside the supplied
   * absolute deadline. Never starts a model and never reserves budget.
   */
  async drain(input: {
    deadline: number;
    interrupt: boolean;
  }): Promise<ReviewDrainReportV1> {
    this.draining = true;
    const deadline = Number.isSafeInteger(input.deadline)
      ? input.deadline
      : this.clock.now();
    let interrupted = false;
    const operations: ReviewDrainOperationV1[] = [];
    for (const op of [...this.operations.values()]) {
      operations.push(
        await this.drainOperation(op, deadline, input.interrupt, () => {
          interrupted = true;
        }),
      );
    }
    const faults: string[] = [];
    for (const entry of operations) {
      if (entry.fault !== null) faults.push(entry.fault);
    }
    return {
      ok: operations.every((entry) => entry.outcome !== "faulted"),
      operations,
      faults,
      deadline,
      interrupted,
      completedAt: this.clock.now(),
    };
  }

  /**
   * Drain ONE owned operation inside the caller deadline. The producer's
   * bounded close grace is reserved BEFORE any owned work is awaited, so both
   * an in-flight submission and a running session wait only to the work
   * boundary. Healthy work is awaited (never eagerly interrupted) until that
   * boundary; only then is a still-running session interrupted and closed.
   * `done` is not settlement: a retained prepared handle is always closed
   * inside the caller deadline, and an unsettled session is never reported as
   * a settled process. Closing an unstarted prepared session is not an
   * interruption.
   */
  private async drainOperation(
    op: OwnedReviewV1,
    deadline: number,
    interrupt: boolean,
    markInterrupted: () => void,
  ): Promise<ReviewDrainOperationV1> {
    const now = () => this.clock.now();
    const remaining = deadline - now();
    const closeReserve = remaining > 0
      ? Math.min(CLOSE_BOUND_MS, remaining)
      : 0;
    // Everything except the reserved close grace is owned work time.
    const workDeadline = deadline - closeReserve;

    // An in-flight submission stays owned: admission already stopped, so it
    // cannot reach a model start, and the drain waits for it to settle inside
    // the work window before the close grace begins.
    const submission = op.submission;
    if (submission !== null && !op.submissionSettled) {
      const raced = await waitUntil(submission, workDeadline, now);
      if (raced === "timeout") op.fault ??= DETAIL_FAILURE;
    }

    const running = op.running;
    if (running !== null && !op.runningSettled) {
      const raced = await waitUntil(running, workDeadline, now);
      if (raced === "timeout") {
        if (interrupt && op.prepared !== null && !op.processSettled) {
          // A session that was actually started is the only interruption.
          markInterrupted();
          await this.closeWithin(op, deadline, now);
        }
        // The owned completion (ready journal write/readback and the COMMENT
        // publication) is proved ONLY by the SAME retained promise settling
        // inside the caller deadline. A proved process close alone is not
        // finalization proof: without this wait a successful drain could be
        // reported while the owned journal work is still in flight.
        if (!op.runningSettled) {
          const finished = await waitUntil(running, deadline, now);
          if (finished === "timeout") op.fault ??= DETAIL_FAILURE;
        }
      }
    } else if (op.prepared !== null && !op.processSettled) {
      // No owned start exists (or the operation is already `done` with an
      // unproved close): close the retained prepared session. This is never
      // reported as an interruption.
      await this.closeWithin(op, deadline, now);
    }
    return this.drainEntry(op);
  }

  /**
   * Start (or reuse) the single owned close and await it only inside the
   * caller deadline. The exact close promise and the retained prepared handle
   * stay owned when caller time is gone: the operation is faulted and never
   * reported as settled.
   */
  private async closeWithin(
    op: OwnedReviewV1,
    deadline: number,
    now: () => number,
  ): Promise<void> {
    const close = this.closePrepared(op);
    const raced = await waitUntil(close.then(() => {}), deadline, now);
    if (raced === "timeout") op.fault ??= DETAIL_FAILURE;
  }

  private drainEntry(op: OwnedReviewV1): ReviewDrainOperationV1 {
    const phase: ReviewDrainOperationV1["phase"] = !op.remoteJournal
      ? "none"
      : op.phase === "published"
      ? "published"
      : op.readyDurable
      ? "ready"
      : op.phase === "running"
      ? "running"
      : "intent";
    let outcome: ReviewDrainOperationV1["outcome"];
    if (op.fault !== null) {
      outcome = "faulted";
    } else if (!op.submissionSettled || !op.runningSettled) {
      // Owned submission/journal finalization is still pending: `done` may be
      // set locally, but no successful drain may be reported without proof.
      op.fault ??= DETAIL_FAILURE;
      outcome = "faulted";
    } else if (!op.processSettled && op.prepared !== null) {
      // A producer session is still owned and was not proved settled.
      outcome = "faulted";
    } else if (op.readyDurable && op.phase !== "published") {
      // A durable ready journal awaiting publication is restart-recoverable.
      outcome = "recoverable";
    } else {
      // No owned live process remains: either the review was published, or the
      // operation never materialized remotely, or the durable charge stands as
      // an abandoned intent/running journal that a fresh host reads as
      // unavailable. All are safe to exit with.
      outcome = "settled";
    }
    return {
      operationKey: op.operationKey,
      outcome,
      processSettled: op.processSettled,
      durable: op.readyDurable,
      phase,
      fault: op.fault,
    };
  }

  // -------------------------------------------------------------------------
  // Owned completion
  // -------------------------------------------------------------------------

  private ownReview(
    op: OwnedReviewV1,
    prepared: PreparedStructuredReviewV1,
  ): Promise<void> {
    const run = (async () => {
      let started: PortResultV1<StructuredReviewOutcomeV1> | null = null;
      let startFailed = false;
      let close: StructuredReviewCloseV1 | null = null;
      try {
        started = await prepared.start();
      } catch {
        startFailed = true;
      } finally {
        // The owned session closes on EVERY path, including a thrown start;
        // the close proves (or refuses to prove) process settlement.
        close = await this.closePrepared(op);
      }
      if (startFailed || started === null || !started.ok || close === null) {
        if (!op.processSettled) {
          op.fault = DETAIL_FAILURE;
          return;
        }
        await this.publishDisposition(op, null);
        return;
      }
      const final = finalizeReviewCompletion(started, close);
      await this.publishDisposition(op, final.ok ? final.value : null);
    })();
    return run.catch(() => {
      op.fault ??= DETAIL_FAILURE;
    }).finally(() => {
      op.done = true;
      op.runningSettled = true;
    });
  }

  /**
   * Persist the exact ready journal (or a static unavailable disposition after
   * proved process settlement), reconcile the exact bytes and submit COMMENT.
   */
  private async publishDisposition(
    op: OwnedReviewV1,
    outcome: StructuredReviewOutcomeV1 | null,
  ): Promise<void> {
    const reviewId = op.reviewId;
    if (reviewId === null) {
      op.fault = DETAIL_FAILURE;
      return;
    }
    // A failed disposition is published ONLY after the owned process is proved
    // settled: an unsettled session stays owned and is never relabelled.
    if (!op.processSettled) {
      op.fault = DETAIL_FAILURE;
      return;
    }
    const completedAt = this.clock.now();
    const result = outcome === null ? null : outcome.result;
    const execution = outcome === null ? null : outcome.execution;
    let journal: ReviewJournalReadyV1;
    if (
      outcome !== null && outcome.status !== "unavailable" && result !== null &&
      execution !== null && result.verdict !== "unavailable"
    ) {
      journal = {
        ...this.intentJournal(op),
        phase: "ready",
        reviewId,
        completedAt,
        result,
        resultDigest: await reviewResultDigest(result),
        execution,
      };
    } else {
      const unavailableResult: ReviewResultV1 = {
        verdict: "unavailable",
        summary: UNAVAILABLE_SUMMARY,
        findings: [],
      };
      journal = {
        ...this.intentJournal(op),
        phase: "ready",
        reviewId,
        completedAt,
        result: unavailableResult,
        resultDigest: await reviewResultDigest(unavailableResult),
        execution: null,
      };
    }
    // A validated result may still be too large for the journal's duplicated
    // human-readable/base64 representation. Replace only that unpublished
    // result with the bounded terminal disposition; never publish a partial
    // rendering or leave the settled running journal behind.
    let body = this.render(journal);
    if (body === null) {
      const unavailableResult: ReviewResultV1 = {
        verdict: "unavailable",
        summary: UNAVAILABLE_SUMMARY,
        findings: [],
      };
      journal = {
        ...journal,
        result: unavailableResult,
        resultDigest: await reviewResultDigest(unavailableResult),
        execution: null,
      };
      body = this.render(journal);
    }
    if (body === null) {
      op.fault = DETAIL_PUBLISH;
      return;
    }
    const updated = await this.client.updatePendingReview(
      op.prNumber,
      reviewId,
      body,
    );
    if (!updated.ok) {
      op.fault = DETAIL_PUBLISH;
      return;
    }
    // An ambiguous update is reconciled by this exact readback; the update is
    // never repeated blindly.
    const readback = await this.readPhase(op, reviewId, {
      phase: "ready",
      body,
    });
    if (readback.kind !== "ok") {
      op.fault = DETAIL_READBACK;
      return;
    }
    op.readyDurable = true;
    const published = await this.submitPublication(op, reviewId, body);
    if (!published) return;
    op.phase = "published";
  }

  /**
   * Publication resume for a durable ready journal discovered by the
   * observation path without any live owned process: the ORIGINAL requestedAt/
   * requestId/operation/base/head/reviewId/completedAt and the exact standing
   * body are reused. No snapshot, preparation, model start, budget reservation
   * or journal rewrite happens; only the exact COMMENT submission and its
   * standing readback.
   */
  private async publishDurableReady(
    request: ReviewRequestReadV1,
    journal: ReviewJournalReadyV1,
    review: GitHubReviewWireV1,
  ): Promise<PortResultV1<ReviewServiceReadV1>> {
    const body = review.body;
    if (body === null || !Number.isSafeInteger(review.id)) {
      return portOk(this.unavailableReceipt(request));
    }
    const now = this.clock.now();
    const op: OwnedReviewV1 = {
      operationKey: journal.operationKey,
      requestId: journal.requestId,
      prNumber: journal.prNumber,
      expectedHead: journal.expectedHead,
      expectedBase: journal.expectedBase,
      requestedAt: journal.requestedAt,
      latestStartAt: now,
      settleBy: now,
      phase: "ready",
      reviewId: review.id,
      remoteJournal: true,
      prepared: null,
      closePromise: null,
      submission: null,
      submissionSettled: true,
      running: null,
      runningSettled: true,
      done: false,
      processSettled: true,
      readyDurable: true,
      fault: null,
    };
    // The publication is owned journal work: drain awaits it and a concurrent
    // submission for the same operation/PR is rejected as overlapping.
    this.operations.set(op.operationKey, op);
    op.submissionSettled = false;
    const publication = (async () => {
      try {
        const published = await this.submitPublication(op, review.id, body);
        if (published) {
          op.phase = "published";
          return true;
        }
        op.fault = DETAIL_PUBLISH;
        return false;
      } catch {
        op.fault = DETAIL_PUBLISH;
        return false;
      } finally {
        op.done = true;
      }
    })();
    op.submission = publication.then(
      () => {
        op.submissionSettled = true;
      },
      () => {
        op.submissionSettled = true;
      },
    );
    if (!await publication) return portOk(this.unavailableReceipt(request));
    const read = await this.client.readPullReview(op.prNumber, review.id);
    if (!read.ok || read.value === null) {
      return portOk(this.unavailableReceipt(request));
    }
    const standing = read.value;
    const standingJournal = await this.parseBody(standing.body);
    if (
      standing.id !== review.id || standing.author !== this.publisher ||
      standing.commitSha !== journal.expectedHead ||
      standing.state !== "commented" || standing.submittedAt === null ||
      standing.body !== body || standingJournal === null ||
      standingJournal.phase !== "ready" ||
      standingJournal.reviewId !== review.id
    ) {
      return portOk(this.unavailableReceipt(request));
    }
    return portOk(this.journalReceipt(standingJournal, standing));
  }

  /**
   * A standing COMMENTED exact journal for this operation already exists (the
   * original submission was published): adopt the durable outcome without any
   * model work and report the submission as admitted.
   */
  private adoptPublished(
    op: OwnedReviewV1,
    reviewId: number,
  ): PortResultV1<ReviewSubmitOutcomeV1> {
    op.reviewId = reviewId;
    op.phase = "published";
    op.processSettled = true;
    op.remoteJournal = true;
    op.readyDurable = true;
    op.done = true;
    return portOk({
      status: "submitted",
      requestId: op.requestId,
      requestedAt: op.requestedAt,
    });
  }

  /**
   * Submit exactly one COMMENT and prove the standing exact publication: the
   * raw id, authenticated publisher, raw head, commented state, submission
   * timestamp, exact intended body bytes and every journal identity must
   * stand. A lost submit response is reconciled by this exact id read only.
   */
  private async submitPublication(
    op: OwnedReviewV1,
    reviewId: number,
    body: string,
  ): Promise<boolean> {
    const submitted = await this.client.submitReview(
      op.prNumber,
      reviewId,
      body,
    );
    if (!submitted.ok) return false;
    const read = await this.client.readPullReview(op.prNumber, reviewId);
    if (!read.ok || read.value === null) return false;
    const review = read.value;
    if (
      review.id !== reviewId || review.author !== this.publisher ||
      review.commitSha !== op.expectedHead || review.state !== "commented" ||
      review.submittedAt === null || review.body !== body
    ) {
      return false;
    }
    const journal = await this.parseBody(review.body);
    if (journal === null || journal.phase !== "ready") return false;
    if (!this.journalIdentityMatches(op, reviewId, journal)) return false;
    return true;
  }

  // -------------------------------------------------------------------------
  // Reconciliation helpers
  // -------------------------------------------------------------------------

  /**
   * Pre-create reconciliation: an intent/running record created by an earlier
   * call is NEVER permission to prepare or start a model, and a ready pending
   * journal is recovered through the observation path only.
   */
  private async reconcile(
    op: OwnedReviewV1,
  ): Promise<
    | { kind: "create" }
    | { kind: "record"; reviewId: number }
    | { kind: "published"; reviewId: number }
    | { kind: "error"; detail: string }
  > {
    const bound = await this.reconcileRead(op);
    if (bound.kind === "error") return bound;
    if (bound.kind === "conflict") {
      return { kind: "error", detail: DETAIL_RECONCILE };
    }
    if (bound.kind === "none") return { kind: "create" };
    if (bound.review.state === "commented") {
      return { kind: "published", reviewId: bound.review.id };
    }
    return { kind: "record", reviewId: bound.review.id };
  }

  /**
   * Lost-create reconciliation: only a record whose EXACT intent bytes are this
   * call's expected intent proves the create applied; uncertain absence never
   * authorizes a blind second create.
   */
  private async reconcileOwnCreate(
    op: OwnedReviewV1,
    ownIntentBody: string,
  ): Promise<
    | { kind: "create" }
    | { kind: "own-intent"; reviewId: number }
    | { kind: "record"; reviewId: number }
    | { kind: "published"; reviewId: number }
    | { kind: "error"; detail: string }
  > {
    const bound = await this.reconcileRead(op);
    if (bound.kind === "error") return bound;
    if (bound.kind === "conflict") {
      return { kind: "error", detail: DETAIL_RECONCILE };
    }
    if (bound.kind === "none") return { kind: "create" };
    if (bound.review.state === "commented") {
      return { kind: "published", reviewId: bound.review.id };
    }
    if (
      bound.journal.phase === "intent" && bound.review.body === ownIntentBody
    ) {
      return { kind: "own-intent", reviewId: bound.review.id };
    }
    return { kind: "record", reviewId: bound.review.id };
  }

  private async reconcileRead(
    op: OwnedReviewV1,
  ): Promise<BoundRecordV1 | { kind: "error"; detail: string }> {
    const read = await this.client.readReviews(op.prNumber);
    if (!read.ok) return { kind: "error", detail: DETAIL_RECONCILE };
    const bound = await this.bindRecords({
      operationKey: op.operationKey,
      requestId: op.requestId,
      prNumber: op.prNumber,
      expectedBase: op.expectedBase,
      expectedHead: op.expectedHead,
    }, read.value);
    if (bound.kind === "conflict") {
      return { kind: "error", detail: DETAIL_RECONCILE };
    }
    return bound;
  }

  /**
   * Exhaustive, strictly bound reconciliation of the named PR's publisher
   * records. Every matching pending AND published record is counted and
   * validated before adoption; exactly ONE fully bound record is required, so
   * a COMMENTED record can never hide a duplicate pending one. A publisher
   * pending draft that is not this exact operation, an unreadable draft, a
   * malformed state, a wrong head or a mismatched review id is a conflict.
   */
  private async bindRecords(
    expectation: {
      operationKey: string | null;
      requestId: string | null;
      prNumber: number;
      /** When known (submission/reconciliation), the exact reviewed base. */
      expectedBase?: GitSha | null;
      /**
       * When known (submission/reconciliation), the exact reviewed head. The
       * observation path has no caller head and leaves this undefined; the
       * normalizer then binds the requested head itself.
       */
      expectedHead?: GitSha | null;
    },
    reviews: GitHubReviewWireV1[],
  ): Promise<BoundRecordV1> {
    const candidates: {
      review: GitHubReviewWireV1;
      journal: ReviewJournalV1;
    }[] = [];
    for (const review of reviews) {
      if (review.author !== this.publisher) continue;
      const journal = await this.parseBody(review.body);
      if (journal === null) {
        // An unreadable publisher draft can never be adopted or overwritten.
        if (review.state === "pending") return { kind: "conflict" };
        continue;
      }
      const exactIdentity = (expectation.operationKey === null ||
        journal.operationKey === expectation.operationKey) &&
        (expectation.requestId === null ||
          journal.requestId === expectation.requestId) &&
        (expectation.expectedBase === undefined ||
          expectation.expectedBase === null ||
          journal.expectedBase === expectation.expectedBase) &&
        (expectation.expectedHead === undefined ||
          expectation.expectedHead === null ||
          journal.expectedHead === expectation.expectedHead) &&
        journal.repository.owner === this.repository.owner &&
        journal.repository.name === this.repository.name &&
        journal.prNumber === expectation.prNumber &&
        journal.publisher === this.publisher &&
        review.commitSha !== null && journal.expectedHead === review.commitSha;
      if (!exactIdentity) {
        // A publisher pending draft that is not this exact operation is a
        // foreign/unrelated/conflicting draft: never edited, never adopted.
        if (review.state === "pending") return { kind: "conflict" };
        continue;
      }
      if (journal.phase === "intent") {
        if (review.state !== "pending" || review.submittedAt !== null) {
          return { kind: "conflict" };
        }
        candidates.push({ review, journal });
        continue;
      }
      // Only running/ready journals carry the durable review id.
      if (journal.reviewId !== review.id) return { kind: "conflict" };
      if (journal.phase === "running") {
        if (review.state !== "pending" || review.submittedAt !== null) {
          return { kind: "conflict" };
        }
        candidates.push({ review, journal });
        continue;
      }
      if (review.state === "commented") {
        if (review.submittedAt === null) return { kind: "conflict" };
        candidates.push({ review, journal });
        continue;
      }
      if (review.state !== "pending" || review.submittedAt !== null) {
        return { kind: "conflict" };
      }
      candidates.push({ review, journal });
    }
    if (candidates.length === 0) return { kind: "none" };
    if (candidates.length > 1) return { kind: "conflict" };
    return {
      kind: "one",
      review: candidates[0].review,
      journal: candidates[0].journal,
    };
  }

  /**
   * Exact phase readback: raw review id, authenticated publisher, raw head,
   * the complete journal identity (repository/PR/base/head/operation/request/
   * publisher/requestedAt), exact intended body bytes and the pending state
   * with NO submission timestamp. Running additionally requires the persisted
   * execution to equal the prepared execution.
   */
  private async readPhase(
    op: OwnedReviewV1,
    reviewId: number,
    expected: {
      phase: "intent" | "running" | "ready";
      body: string;
      execution?: PreparedStructuredReviewV1["execution"];
    },
  ): Promise<
    { kind: "ok"; journal: ReviewJournalV1 } | { kind: "error"; detail: string }
  > {
    const read = await this.client.readPullReview(op.prNumber, reviewId);
    if (!read.ok || read.value === null) {
      return { kind: "error", detail: DETAIL_READBACK };
    }
    const review = read.value;
    if (
      review.id !== reviewId || review.author !== this.publisher ||
      review.commitSha !== op.expectedHead
    ) {
      return { kind: "error", detail: DETAIL_READBACK };
    }
    const journal = await this.parseBody(review.body);
    if (journal === null) return { kind: "error", detail: DETAIL_READBACK };
    if (!this.journalIdentityMatches(op, reviewId, journal)) {
      return { kind: "error", detail: DETAIL_READBACK };
    }
    if (journal.phase !== expected.phase) {
      return { kind: "error", detail: DETAIL_READBACK };
    }
    if (review.body !== expected.body) {
      return { kind: "error", detail: DETAIL_READBACK };
    }
    // A durable pending journal has no submission timestamp.
    if (review.state !== "pending" || review.submittedAt !== null) {
      return { kind: "error", detail: DETAIL_READBACK };
    }
    if (expected.phase === "running") {
      if (journal.phase !== "running") {
        return { kind: "error", detail: DETAIL_READBACK };
      }
      if (
        JSON.stringify(journal.execution) !== JSON.stringify(expected.execution)
      ) {
        return { kind: "error", detail: DETAIL_READBACK };
      }
    }
    return { kind: "ok", journal };
  }

  /**
   * Exact journal identity against one owned operation. Intent journals carry
   * no durable review id: the raw review id readback binds them instead.
   */
  private journalIdentityMatches(
    op: OwnedReviewV1,
    reviewId: number,
    journal: ReviewJournalV1,
  ): boolean {
    if (journal.repository.owner !== this.repository.owner) return false;
    if (journal.repository.name !== this.repository.name) return false;
    if (journal.prNumber !== op.prNumber) return false;
    if (journal.expectedHead !== op.expectedHead) return false;
    if (journal.expectedBase !== op.expectedBase) return false;
    if (journal.operationKey !== op.operationKey) return false;
    if (journal.requestId !== op.requestId) return false;
    if (journal.publisher !== this.publisher) return false;
    if (journal.requestedAt !== op.requestedAt) return false;
    if (journal.phase === "intent") return true;
    return journal.reviewId === reviewId;
  }

  private async parseBody(
    body: string | null,
  ): Promise<ReviewJournalV1 | null> {
    if (body === null) return null;
    try {
      return await parseReviewJournalBody(body);
    } catch {
      return null;
    }
  }

  private render(journal: ReviewJournalV1): string | null {
    try {
      return renderReviewJournalBody(journal);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Receipts
  // -------------------------------------------------------------------------

  private liveReceipt(op: OwnedReviewV1): ReviewServiceReadV1 {
    return {
      status: "pending",
      requestId: op.requestId,
      resultId: null,
      completedAt: null,
      summary: null,
      resultDigest: null,
      terminalTurnSucceeded: false,
      outputPresent: false,
      operationKey: op.operationKey,
      githubReviewId: op.reviewId,
      repository: this.repository,
      prNumber: op.prNumber,
      expectedHead: op.expectedHead,
      expectedBase: op.expectedBase,
      expectedReviewer: this.publisher,
    };
  }

  private unavailableReceipt(
    request: ReviewRequestReadV1,
  ): ReviewServiceReadV1 {
    return {
      status: "unavailable",
      requestId: request.requestId,
      resultId: null,
      completedAt: null,
      summary: null,
      resultDigest: null,
      terminalTurnSucceeded: false,
      outputPresent: false,
      operationKey: request.operationKey,
      githubReviewId: null,
      repository: this.repository,
      prNumber: request.prNumber,
      expectedHead: null,
      expectedBase: null,
      expectedReviewer: null,
    };
  }

  /**
   * Exact receipt derived from one standing authenticated review record. Only
   * a COMMENTED exact ready journal by the publisher on the exact head can be
   * `completed`; clean/findings additionally require observed runtime
   * completion and a bound result identity.
   */
  private journalReceipt(
    journal: ReviewJournalV1,
    review: GitHubReviewWireV1,
  ): ReviewServiceReadV1 {
    const base: ReviewServiceReadV1 = {
      status: "unavailable",
      requestId: journal.requestId,
      resultId: null,
      completedAt: null,
      summary: null,
      resultDigest: null,
      terminalTurnSucceeded: false,
      outputPresent: false,
      operationKey: journal.operationKey,
      githubReviewId: review.id,
      repository: this.repository,
      prNumber: journal.prNumber,
      expectedHead: journal.expectedHead,
      expectedBase: journal.expectedBase,
      expectedReviewer: journal.publisher,
    };
    if (
      journal.phase !== "ready" || review.state !== "commented" ||
      review.submittedAt === null
    ) {
      return base;
    }
    if (journal.result.verdict === "unavailable") {
      return {
        ...base,
        completedAt: journal.completedAt,
        summary: journal.result.summary,
        resultDigest: journal.resultDigest,
      };
    }
    const execution = journal.execution;
    if (
      execution === null || execution.actual.terminalOrigin !== "runtime" ||
      execution.actual.observedTerminalStatus !== "completed"
    ) {
      return {
        ...base,
        completedAt: journal.completedAt,
        summary: journal.result.summary,
        resultDigest: journal.resultDigest,
      };
    }
    return {
      ...base,
      status: "completed",
      resultId: execution.resultId,
      completedAt: journal.completedAt,
      summary: journal.result.summary,
      resultDigest: journal.resultDigest,
      terminalTurnSucceeded: true,
      outputPresent: true,
    };
  }

  // -------------------------------------------------------------------------
  // Submission validation and small helpers
  // -------------------------------------------------------------------------

  private validateSubmission(
    request: ReviewRequestSubmitV1,
    now: number,
  ): { ok: true; value: OwnedReviewV1 } | {
    ok: false;
    error: PortResultV1<never>;
  } {
    const invalid = portError("invalid", DETAIL_INPUT);
    if (typeof request !== "object" || request === null) {
      return { ok: false, error: invalid };
    }
    if (
      typeof request.operationKey !== "string" ||
      request.operationKey.length === 0 ||
      request.operationKey.length > 256
    ) {
      return { ok: false, error: invalid };
    }
    if (!Number.isSafeInteger(request.prNumber) || request.prNumber < 1) {
      return { ok: false, error: invalid };
    }
    if (
      typeof request.expectedHead !== "string" ||
      typeof request.expectedBase !== "string" ||
      !/^[0-9a-f]{40}$/.test(request.expectedHead) ||
      !/^[0-9a-f]{40}$/.test(request.expectedBase)
    ) {
      return { ok: false, error: invalid };
    }
    if (request.expectedReviewer !== this.publisher) {
      return { ok: false, error: portError("invalid", DETAIL_PUBLISHER) };
    }
    if (
      !Number.isSafeInteger(request.latestStartAt) ||
      !Number.isSafeInteger(request.settleBy) ||
      request.latestStartAt <= now ||
      request.settleBy <= request.latestStartAt ||
      request.settleBy - request.latestStartAt > this.reviewTotalMs()
    ) {
      return { ok: false, error: invalid };
    }
    const op: OwnedReviewV1 = {
      operationKey: request.operationKey,
      requestId: reviewRecordId(request.operationKey),
      prNumber: request.prNumber,
      expectedHead: request.expectedHead as GitSha,
      expectedBase: request.expectedBase as GitSha,
      requestedAt: now,
      latestStartAt: request.latestStartAt,
      settleBy: request.settleBy,
      phase: "intent",
      reviewId: null,
      remoteJournal: false,
      prepared: null,
      closePromise: null,
      submission: null,
      submissionSettled: true,
      running: null,
      runningSettled: true,
      done: false,
      processSettled: false,
      readyDurable: false,
      fault: null,
    };
    return { ok: true, value: op };
  }

  private reviewTotalMs(): number {
    return REVIEW_TRANSPORT_TOTAL_MS;
  }

  /**
   * True while the full review bound still fits before latestStartAt/settleBy
   * AND admission has not stopped. Once drain starts, an admitted submission
   * that is still awaiting work can never reach a model start.
   */
  private admitsStart(op: OwnedReviewV1): boolean {
    if (this.draining) return false;
    const now = this.clock.now();
    return now < op.latestStartAt && now < op.settleBy;
  }

  private invocationId(op: OwnedReviewV1): string {
    return `review-invocation-${op.operationKey}`.slice(0, 256);
  }

  private intentJournal(op: OwnedReviewV1) {
    return {
      version: "v1" as const,
      phase: "intent" as const,
      repository: {
        owner: this.repository.owner,
        name: this.repository.name,
      },
      prNumber: op.prNumber,
      expectedHead: op.expectedHead,
      expectedBase: op.expectedBase,
      operationKey: op.operationKey,
      publisher: this.publisher,
      requestId: op.requestId,
      requestedAt: op.requestedAt,
    };
  }

  private activeCount(): number {
    let count = 0;
    for (const op of this.operations.values()) {
      if (isActiveReview(op)) count++;
    }
    return count;
  }

  /**
   * The local fast-path match binds the requested PR and EVERY supplied
   * identity on every path: an unknown operation key never falls back to a
   * request-id match, and a request id never matches a different operation
   * key. A supplied identifier that does not match exactly is `undefined`.
   */
  private matchLocal(
    request: ReviewRequestReadV1,
  ): OwnedReviewV1 | undefined {
    for (const op of this.operations.values()) {
      if (op.prNumber !== request.prNumber) continue;
      if (
        request.operationKey !== null &&
        op.operationKey !== request.operationKey
      ) {
        continue;
      }
      if (request.requestId !== null && op.requestId !== request.requestId) {
        continue;
      }
      return op;
    }
    return undefined;
  }

  /**
   * Close the one owned prepared session. The single close promise is reused
   * (never a concurrent duplicate close), the handle is retained until
   * settlement is actually proved, and an unproved close is a fault — never a
   * silent success.
   */
  private closePrepared(op: OwnedReviewV1): Promise<StructuredReviewCloseV1> {
    const prepared = op.prepared;
    if (op.closePromise === null && prepared !== null) {
      op.closePromise = (async () => {
        try {
          return await prepared.close();
        } catch {
          return {
            settled: false,
            failure: DETAIL_FAILURE,
            timedOut: false,
          };
        }
      })();
    }
    const close = op.closePromise;
    if (close === null) {
      return Promise.resolve({
        settled: op.processSettled,
        failure: null,
        timedOut: false,
      });
    }
    return close.then((result) => {
      if (result.settled) {
        op.processSettled = true;
        op.prepared = null;
        return result;
      }
      // The handle stays owned: an unsettled process is never discarded and
      // is never reported as settled.
      op.fault ??= DETAIL_FAILURE;
      return result;
    });
  }

  /** Bounded deferral of a submission that no longer fits admission. */
  private reject(op: OwnedReviewV1): PortResultV1<ReviewSubmitOutcomeV1> {
    op.phase = "failed";
    op.done = true;
    return portOk({ status: "rejected" });
  }

  private fail(
    op: OwnedReviewV1,
    detail: string,
    ambiguous = false,
  ): PortResultV1<ReviewSubmitOutcomeV1> {
    op.phase = "failed";
    op.done = true;
    if (ambiguous) {
      return portOk({ status: "ambiguous" });
    }
    return portError("unavailable", detail);
  }
}
