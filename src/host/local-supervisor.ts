/**
 * The fixed trusted local supervisor (Wave C).
 *
 * One entrypoint that can install an exact reviewed and merged Sentinel repair,
 * execute that new runtime, and record exact acceptance or proven rollback
 * beneath the private local state root. It is deliberately a single fixed
 * program: it reads no model, makes no network or GitHub decision of its own,
 * takes no CLI flag, secret or revision selector, and never touches release
 * requests, work records, reservations or repair refs.
 *
 * Fixed authority and fixed evidence:
 *
 * - private `supervisor.lock` (distinct from the child's `runner.lock`) makes
 *   one supervisor invocation at a time; a held lock is an explicit busy
 *   refusal, never a wait;
 * - `active-runtime.json` is the one exact-SHA pointer; a missing pointer is a
 *   refusal (the installer initializes it to the reviewed installed runtime)
 *   and no revision is ever chosen by time, list order or the newest file;
 * - every claim of health is a fresh observed bounded child run: fresh private
 *   status receipt, unique invocation id, exact controller SHA, observed
 *   finished timestamp, a supported outcome, available state, an absent
 *   session marker and a reacquired/released runner lock after the child
 *   settled. A pointer or an intended phase can never become acceptance;
 * - promotion stages `request.revision` into `runtimes/<exact SHA>` from the
 *   private source mirror with a credential-free local clone and a detached
 *   exact checkout, then atomically renames it into place. Existing runtimes
 *   are never overwritten;
 * - the pointer only ever moves under the supervisor lock with an exact
 *   compare immediately before the atomic rename, so an unrelated newer
 *   pointer is preserved;
 * - a failed candidate is restored to the exact prior pointer and only a
 *   fresh exact prior run proof records `rolled_back`. Anything unproven stays
 *   `pending`.
 *
 * The supervisor is installed outside mutable runtime checkouts: model changes
 * cannot replace it, and no model or repair process writes its receipts or
 * pointer.
 */

import type { GitSha } from "../contracts/brands.ts";
import { isGitSha } from "../contracts/brands.ts";
import type { Clock } from "../contracts/ports.ts";
import { SystemClock } from "../contracts/ports.ts";
import type {
  LocalReleaseReceiptV1,
  LocalRunProofV1,
} from "../contracts/local-release.ts";
import {
  isLocalReleaseTerminalPhase,
  isLocalSentinelRepository,
  LOCAL_RUN_FAILED_STATUSES,
  LOCAL_RUN_HEALTHY_STATUSES,
} from "../contracts/local-release.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import { DenoReplayRuntime } from "../replay/runtime.ts";
import { createRepairStateStore } from "../state/mod.ts";
import {
  compareAndSetLocalActiveRuntime,
  ensurePrivateDir,
  findPendingLocalReleaseReceipt,
  listLocalReleaseReceipts,
  type LocalRunStatusV1,
  localSessionMarkerExists,
  probeRunnerLock,
  readLocalActiveRuntime,
  readLocalRunStatus,
  writeLocalChildLog,
  writeLocalReleaseReceipt,
} from "./local-release.ts";

/** Static, value-free detail texts (never a path, SHA, token or body). */
const DETAIL_POINTER_MISSING =
  "local supervisor refused: the private active runtime pointer is missing; the installer must initialize it to the reviewed installed runtime";
const DETAIL_POINTER_UNREADABLE =
  "local supervisor failed: the private active runtime pointer is unreadable";
const DETAIL_RECEIPTS_UNREADABLE =
  "local supervisor failed: private local release receipts are unreadable";
const DETAIL_RUNTIME_INVALID =
  "local supervisor refused: the runtime checkout is not the exact clean revision";
const DETAIL_LOCK_NOT_RELEASED =
  "local supervisor paused: the child runner lock was not released after the child settled";
const DETAIL_LOCK_HELD =
  "local supervisor paused: the child runner lock is held before a new child may start";
const DETAIL_MARKER_PRESENT =
  "local supervisor paused: the private session marker is present after the child settled";
const DETAIL_STATUS_UNREADABLE =
  "local supervisor paused: the private run status receipt is unreadable";
const DETAIL_STATUS_STALE =
  "local supervisor paused: the private run status receipt is not a fresh observed run";
const DETAIL_STATUS_DUPLICATE =
  "local supervisor paused: the private run status receipt repeats a known invocation";
const DETAIL_STATE_UNAVAILABLE =
  "local supervisor paused: the child reported its repair state as unavailable";
const DETAIL_CHILD_UNSETTLED =
  "local supervisor paused: the child process did not settle";
const DETAIL_RECEIPT_WRITE =
  "local supervisor failed: the private local release receipt could not be persisted";
const DETAIL_POINTER_CHANGED =
  "local supervisor refused: the active runtime pointer is not the expected exact revision; an unrelated newer pointer is preserved";
const DETAIL_STAGE_FAILED =
  "local supervisor failed: the candidate runtime could not be staged";
const DETAIL_STATE_ABSENT =
  "local supervisor paused: the private repair state is absent";
const DETAIL_STATE_READ =
  "local supervisor failed: the private repair state could not be read";
const DETAIL_SOURCE_UNAVAILABLE =
  "local supervisor failed: the exact source revision is not available in the local development ref";
const DETAIL_ALREADY_ACTIVE =
  "local supervisor refused: the requested revision is already the active runtime and no distinct prior revision exists for an activation receipt";
const DETAIL_CHILD_EXIT_FAILED =
  "local supervisor refused: the child process exited nonzero after it settled and left no healthy run proof";
const DETAIL_PROOF_INVALID =
  "local supervisor refused: the observed run proof was not a healthy observed run";

const REPAIR_TASK_NAME = "repair:run";
/** The local source development ref the healthy real child host refreshes. */
const LOCAL_DEVELOPMENT_REF = "refs/remotes/origin/development";
const CHILD_DEADLINE_MS = 3_600_000;
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;
const RUNTIMES_DIR = "runtimes";
const SOURCE_DIR = "source";
const STATE_GIT_DIR = "state.git";
const STATE_SCRATCH_DIR = "state-scratch";
const MAX_TRACKED_SYMLINKS = 64;
/**
 * The one OS mechanism that confines a real child's write authority: the
 * fixed platform sandbox. No platform without it ever runs a real child.
 */
const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";
/** Dedicated child cache and temp directories beneath the private state. */
const CHILD_DENO_DIR = "deno/host";
const CHILD_TMP_DIR = "tmp/host";
/**
 * Exact private state directories a sandboxed child may write and hardlink
 * beneath. Nothing else in or outside the state root is writable, so an
 * arbitrary child process, Git object link, shell or Deno subprocess cannot
 * reach the supervisor pointer, receipts, locks, runtimes or its own code.
 */
const CHILD_MUTABLE_STATE_DIRS = [
  STATE_GIT_DIR,
  STATE_SCRATCH_DIR,
  SOURCE_DIR,
  "checkouts",
  "clients",
  "tmp",
  "deno",
  "model-results",
  "review-checkout",
] as const;
/** Exact child-owned root entries the local host already writes directly. */
const CHILD_MUTABLE_STATE_FILES = [
  "runner.lock",
  "session-active.json",
  "status.json",
] as const;

/** The exact existing trusted environment the child task runs with. */
export interface LocalSupervisorEnvV1 {
  HOME: string;
  PATH: string;
  GITHUB_TOKEN: string;
  UOS_AI_TOKEN: string;
}

/** Inputs of one child execution; revisions and secrets are never shell text. */
export interface LocalSupervisorChildInputV1 {
  stateRoot: string;
  runtimeDir: string;
  revision: GitSha;
  taskName: string;
  env: Readonly<Record<string, string>>;
  /** The exact trusted Deno executable this supervisor was configured with. */
  denoExecutable: string;
  deadlineMs: number;
  logPath: string;
}

export interface LocalSupervisorChildResultV1 {
  /** True only when the child process was reaped after a normal exit. */
  settled: boolean;
  exitCode: number | null;
}

/** The one injected border: child process execution, never the state machine. */
export type LocalSupervisorChildRunnerV1 = (
  input: LocalSupervisorChildInputV1,
) => Promise<LocalSupervisorChildResultV1>;

export interface LocalSupervisorOptionsV1 {
  stateRoot: string;
  env: LocalSupervisorEnvV1;
  denoExecutable: string;
  clock?: Clock;
  runChild?: LocalSupervisorChildRunnerV1;
}

export type LocalSupervisorResultV1 =
  | { status: "busy" }
  | { status: "idle"; activeRevision: GitSha }
  | {
    status: "accepted";
    requestId: string;
    revision: GitSha;
    priorRevision: GitSha;
  }
  | {
    status: "rolled_back";
    requestId: string;
    revision: GitSha;
    priorRevision: GitSha;
  }
  | { status: "pending"; detail: string }
  | { status: "failed"; detail: string };

interface LocalSupervisorInputV1 {
  stateRoot: string;
  sourceDir: string;
  env: LocalSupervisorEnvV1;
  denoExecutable: string;
  runChild: LocalSupervisorChildRunnerV1;
}

/** Mutable per-invocation observation set: child invocations must be unique. */
type KnownInvocationsV1 = Set<string>;

type RunObservationV1 =
  | { kind: "proof"; proof: LocalRunProofV1 }
  // An objective failed run may leave no usable proof at all (for example a
  // startup failure with a nonzero exit and no fresh status receipt).
  | { kind: "failed"; proof: LocalRunProofV1 | null; detail: string }
  | { kind: "pending"; detail: string };

/**
 * Run one bounded supervisor pass. A held supervisor lock is an explicit busy
 * refusal; every other outcome is an explicit result value.
 */
export async function runLocalSupervisor(
  options: LocalSupervisorOptionsV1,
): Promise<LocalSupervisorResultV1> {
  const input = readLocalSupervisorOptions(options);
  const clock = options.clock ?? new SystemClock();
  await ensurePrivateDir(input.stateRoot);
  const lock = await tryAcquireSupervisorLock(input.stateRoot);
  if (lock === null) return { status: "busy" };
  try {
    return await supervise(input, clock);
  } catch {
    return { status: "failed", detail: DETAIL_STATE_READ };
  } finally {
    try {
      lock.close();
    } catch {
      // the pass result is already decided
    }
  }
}

async function supervise(
  input: LocalSupervisorInputV1,
  clock: Clock,
): Promise<LocalSupervisorResultV1> {
  const pointer = await readLocalActiveRuntime(input.stateRoot);
  if (!pointer.ok) {
    return { status: "failed", detail: DETAIL_POINTER_UNREADABLE };
  }
  if (pointer.value === null) {
    return { status: "failed", detail: DETAIL_POINTER_MISSING };
  }
  const activeRevision = pointer.value.revision;
  const known = await seedKnownInvocations(input.stateRoot);

  const pending = await findPendingLocalReleaseReceipt(input.stateRoot);
  if (!pending.ok) {
    return { status: "failed", detail: DETAIL_RECEIPTS_UNREADABLE };
  }
  if (pending.value !== null) {
    return await reconcile(input, clock, pending.value, activeRevision, known);
  }

  // One healthy ordinary run of the exact active runtime before any promotion.
  const active = await runAndVerify(input, clock, activeRevision, known);
  if (active.kind !== "proof") {
    return active.kind === "failed"
      ? { status: "failed", detail: active.detail }
      : { status: "pending", detail: active.detail };
  }
  if (!isHealthyOutcome(active.proof.outcome)) {
    return {
      status: "failed",
      detail:
        `local supervisor refused: the active runtime reported ${active.proof.outcome}`,
    };
  }

  const selection = await selectLocalReleaseRequest(input);
  if (selection.kind === "error") {
    return { status: "failed", detail: selection.detail };
  }
  if (selection.kind === "none") {
    return { status: "idle", activeRevision };
  }

  return await promote(
    input,
    clock,
    selection.request,
    activeRevision,
    active.proof,
    known,
  );
}

// ---------------------------------------------------------------------------
// Crash reconciliation: exact pointer/receipt identities and fresh runs only
// ---------------------------------------------------------------------------

async function reconcile(
  input: LocalSupervisorInputV1,
  clock: Clock,
  receipt: LocalReleaseReceiptV1,
  activeRevision: GitSha,
  known: KnownInvocationsV1,
): Promise<LocalSupervisorResultV1> {
  addProofInvocation(known, receipt.candidateProof);
  addProofInvocation(known, receipt.priorProof);
  const request = receipt.request;
  const target = request.revision;
  const prior = receipt.priorRevision;

  if (receipt.phase === "installing") {
    if (activeRevision === target) {
      // The pointer moved but the verifying receipt never landed: finish
      // verification against the saved exact prior proof and the receipt's
      // original immutable creation time.
      return await verifyCandidate(
        input,
        clock,
        request,
        prior,
        receipt.priorProof,
        receipt.createdAt,
        known,
      );
    }
    if (activeRevision !== prior) {
      return await failReceipt(
        input,
        clock,
        receipt,
        DETAIL_POINTER_CHANGED,
      );
    }
    // The pointer never moved. Re-verify the active prior with a fresh run,
    // then continue the one promotion this invocation is allowed. The resumed
    // install keeps the original receipt creation time.
    const priorRun = await runAndVerify(input, clock, prior, known);
    if (priorRun.kind !== "proof") {
      return priorRun.kind === "failed"
        ? { status: "failed", detail: priorRun.detail }
        : { status: "pending", detail: priorRun.detail };
    }
    if (!isHealthyOutcome(priorRun.proof.outcome)) {
      return {
        status: "failed",
        detail:
          `local supervisor refused: the active runtime reported ${priorRun.proof.outcome}`,
      };
    }
    return await installAndActivate(
      input,
      clock,
      request,
      prior,
      priorRun.proof,
      receipt.createdAt,
      known,
    );
  }

  if (receipt.phase === "verifying") {
    if (activeRevision === target) {
      return await verifyCandidate(
        input,
        clock,
        request,
        prior,
        receipt.priorProof,
        receipt.createdAt,
        known,
      );
    }
    if (activeRevision !== prior) {
      return await failReceipt(
        input,
        clock,
        receipt,
        DETAIL_POINTER_CHANGED,
      );
    }
    // The candidate is not active: never infer acceptance from that. Only the
    // exact prior revision may be restored, and only a fresh exact prior run
    // records rolled_back. When the pointer already equals that prior, the
    // rollback intent is persisted first and the same-revision compare-set
    // finishes without a candidate-to-prior swap; an unrelated pointer was
    // refused above and is never overwritten.
    return await restorePrior(
      input,
      clock,
      request,
      prior,
      receipt.priorProof,
      receipt.createdAt,
      receipt.candidateProof,
      known,
      true,
    );
  }

  if (receipt.phase === "rollback_pending") {
    if (activeRevision === target) {
      const set = await compareAndSetLocalActiveRuntime(
        input.stateRoot,
        target,
        prior,
      );
      if (set !== "applied") {
        return await failReceipt(
          input,
          clock,
          receipt,
          DETAIL_POINTER_CHANGED,
        );
      }
    } else if (activeRevision !== prior) {
      return await failReceipt(
        input,
        clock,
        receipt,
        DETAIL_POINTER_CHANGED,
      );
    }
    return await finishRollback(
      input,
      clock,
      request,
      prior,
      receipt.priorProof,
      receipt.candidateProof,
      receipt.createdAt,
      known,
    );
  }

  // A terminal receipt is never reconciled or promoted again.
  return { status: "idle", activeRevision };
}

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

async function promote(
  input: LocalSupervisorInputV1,
  clock: Clock,
  request: ReleaseRequestV1,
  priorRevision: GitSha,
  priorProof: LocalRunProofV1,
  known: KnownInvocationsV1,
): Promise<LocalSupervisorResultV1> {
  if (request.revision === priorRevision) {
    // The requested revision is already the active runtime, so there is no
    // distinct prior revision an activation receipt could record. Acceptance
    // is never inferred from the pointer: refuse without writing a receipt and
    // without any child run or pointer change.
    return { status: "failed", detail: DETAIL_ALREADY_ACTIVE };
  }
  return await installAndActivate(
    input,
    clock,
    request,
    priorRevision,
    priorProof,
    null,
    known,
  );
}

async function installAndActivate(
  input: LocalSupervisorInputV1,
  clock: Clock,
  request: ReleaseRequestV1,
  priorRevision: GitSha,
  priorProof: LocalRunProofV1,
  resumedCreatedAt: number | null,
  known: KnownInvocationsV1,
): Promise<LocalSupervisorResultV1> {
  const staged = await stageRuntime(input, request.revision);
  if (!staged.ok) return { status: "failed", detail: staged.detail };

  const now = clock.now();
  // The creation timestamp is written exactly once, by the first install. A
  // resumed install keeps the original immutable value so every later phase
  // (and the consumer's freshness check) rests on the same creation time.
  const installing = buildReceipt(
    request,
    priorRevision,
    "installing",
    null,
    priorProof,
    resumedCreatedAt === null ? now : resumedCreatedAt,
    now,
  );
  // The installing receipt (exact prior healthy proof + candidate identity) is
  // durable BEFORE any pointer change.
  if (!await persistReceipt(input.stateRoot, installing)) {
    return { status: "failed", detail: DETAIL_RECEIPT_WRITE };
  }

  const set = await compareAndSetLocalActiveRuntime(
    input.stateRoot,
    priorRevision,
    request.revision,
  );
  if (set !== "applied") {
    return await failReceipt(input, clock, installing, DETAIL_POINTER_CHANGED);
  }
  const verifying = buildReceipt(
    request,
    priorRevision,
    "verifying",
    null,
    priorProof,
    installing.createdAt,
    clock.now(),
  );
  if (!await persistReceipt(input.stateRoot, verifying)) {
    return { status: "failed", detail: DETAIL_RECEIPT_WRITE };
  }
  return await verifyCandidate(
    input,
    clock,
    request,
    priorRevision,
    priorProof,
    installing.createdAt,
    known,
  );
}

async function verifyCandidate(
  input: LocalSupervisorInputV1,
  clock: Clock,
  request: ReleaseRequestV1,
  priorRevision: GitSha,
  priorProof: LocalRunProofV1 | null,
  createdAt: number,
  known: KnownInvocationsV1,
): Promise<LocalSupervisorResultV1> {
  if (priorProof === null) {
    return { status: "pending", detail: DETAIL_STATUS_STALE };
  }
  const run = await runAndVerify(input, clock, request.revision, known);
  if (run.kind === "proof") {
    // runAndVerify only returns kind proof for a settled, exactly bound run
    // whose repair state was available; the explicit healthy check below still
    // gates acceptance so an injected or unhealthy proof can never reach it.
    if (!isHealthyOutcome(run.proof.outcome)) {
      return { status: "failed", detail: DETAIL_PROOF_INVALID };
    }
    return await acceptCandidate(
      input,
      clock,
      request,
      priorProof,
      run.proof,
      createdAt,
    );
  }
  if (run.kind === "failed") {
    return await restorePrior(
      input,
      clock,
      request,
      priorRevision,
      priorProof,
      createdAt,
      run.proof,
      known,
    );
  }
  return { status: "pending", detail: run.detail };
}

async function acceptCandidate(
  input: LocalSupervisorInputV1,
  clock: Clock,
  request: ReleaseRequestV1,
  priorProof: LocalRunProofV1,
  candidateProof: LocalRunProofV1,
  createdAt: number,
): Promise<LocalSupervisorResultV1> {
  const accepted = buildReceipt(
    request,
    priorProof.controllerSha,
    "accepted",
    candidateProof,
    priorProof,
    // The receipt keeps the original creation time: the observed candidate
    // proof must start at/after it.
    createdAt,
    clock.now(),
  );
  if (!await persistReceipt(input.stateRoot, accepted)) {
    return { status: "failed", detail: DETAIL_RECEIPT_WRITE };
  }
  return {
    status: "accepted",
    requestId: request.id,
    revision: request.revision,
    priorRevision: priorProof.controllerSha,
  };
}

async function restorePrior(
  input: LocalSupervisorInputV1,
  clock: Clock,
  request: ReleaseRequestV1,
  priorRevision: GitSha,
  priorProof: LocalRunProofV1 | null,
  createdAt: number,
  failureProof: LocalRunProofV1 | null,
  known: KnownInvocationsV1,
  /** True when the pointer was already observed at the exact prior revision. */
  alreadyPrior = false,
): Promise<LocalSupervisorResultV1> {
  if (priorProof === null) {
    return { status: "pending", detail: DETAIL_STATUS_STALE };
  }
  const now = clock.now();
  const rollbackPending = buildReceipt(
    request,
    priorRevision,
    "rollback_pending",
    failureProof,
    priorProof,
    // The rollback keeps the original immutable creation time; the baseline
    // prior proof is never rewritten into a fresher-looking receipt.
    createdAt,
    now,
  );
  // rollback_pending is durable BEFORE the pointer is restored.
  if (!await persistReceipt(input.stateRoot, rollbackPending)) {
    return { status: "failed", detail: DETAIL_RECEIPT_WRITE };
  }
  // The pointer is only ever moved under the supervisor lock with an exact
  // compare immediately before the write. When the pointer already equals the
  // prior, the same-revision compare still refuses an unrelated concurrent
  // pointer without repeating the candidate-to-prior swap.
  const set = await compareAndSetLocalActiveRuntime(
    input.stateRoot,
    alreadyPrior ? priorRevision : request.revision,
    priorRevision,
  );
  if (set !== "applied") {
    return await failReceipt(
      input,
      clock,
      rollbackPending,
      DETAIL_POINTER_CHANGED,
    );
  }
  return await finishRollback(
    input,
    clock,
    request,
    priorRevision,
    priorProof,
    failureProof,
    createdAt,
    known,
  );
}

async function finishRollback(
  input: LocalSupervisorInputV1,
  clock: Clock,
  request: ReleaseRequestV1,
  priorRevision: GitSha,
  priorProof: LocalRunProofV1 | null,
  failureProof: LocalRunProofV1 | null,
  createdAt: number,
  known: KnownInvocationsV1,
): Promise<LocalSupervisorResultV1> {
  if (priorProof === null) {
    return { status: "pending", detail: DETAIL_STATUS_STALE };
  }
  const run = await runAndVerify(input, clock, priorRevision, known);
  if (run.kind === "pending") {
    // No objective failure was observed (no settlement, no receipt, an
    // unreadable or out-of-window proof). The durable rollback_pending
    // receipt is left exactly in place so a later pass repeats the exact
    // prior restore with a fresh run. Pending is never terminal failure.
    return { status: "pending", detail: run.detail };
  }
  if (run.kind === "failed") {
    // Only an observed objective failure of the restore run may write the
    // terminal failed receipt. The failure proof of the candidate is kept;
    // the failed prior run itself is not a candidate proof.
    const failed = buildReceipt(
      request,
      priorRevision,
      "failed",
      failureProof,
      priorProof,
      createdAt,
      clock.now(),
    );
    if (!await persistReceipt(input.stateRoot, failed)) {
      return { status: "failed", detail: DETAIL_RECEIPT_WRITE };
    }
    return { status: "failed", detail: run.detail };
  }
  if (!isHealthyOutcome(run.proof.outcome)) {
    return { status: "failed", detail: DETAIL_PROOF_INVALID };
  }
  const rolledBack = buildReceipt(
    request,
    priorRevision,
    "rolled_back",
    failureProof,
    run.proof,
    // The receipt keeps its original creation time: the fresh prior proof
    // that proves the rollback must start at/after it.
    createdAt,
    clock.now(),
  );
  if (!await persistReceipt(input.stateRoot, rolledBack)) {
    return { status: "failed", detail: DETAIL_RECEIPT_WRITE };
  }
  return {
    status: "rolled_back",
    requestId: request.id,
    revision: request.revision,
    priorRevision,
  };
}

async function failReceipt(
  input: LocalSupervisorInputV1,
  clock: Clock,
  receipt: LocalReleaseReceiptV1,
  detail: string,
): Promise<LocalSupervisorResultV1> {
  const failed = {
    ...receipt,
    phase: "failed" as const,
    updatedAt: clock.now(),
  };
  if (!await persistReceipt(input.stateRoot, failed)) {
    return { status: "failed", detail: DETAIL_RECEIPT_WRITE };
  }
  return { status: "failed", detail };
}

function buildReceipt(
  request: ReleaseRequestV1,
  priorRevision: GitSha,
  phase: LocalReleaseReceiptV1["phase"],
  candidateProof: LocalRunProofV1 | null,
  priorProof: LocalRunProofV1 | null,
  createdAt: number,
  updatedAt: number,
): LocalReleaseReceiptV1 {
  return {
    version: "v1",
    kind: "local_release_receipt",
    request,
    priorRevision,
    phase,
    candidateProof,
    priorProof,
    createdAt,
    updatedAt: updatedAt < createdAt ? createdAt : updatedAt,
  };
}

async function persistReceipt(
  stateRoot: string,
  receipt: LocalReleaseReceiptV1,
): Promise<boolean> {
  try {
    await writeLocalReleaseReceipt(stateRoot, receipt);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Request selection: the oldest exact eligible local production request
// ---------------------------------------------------------------------------

type SelectionV1 =
  | { kind: "none" }
  | { kind: "found"; request: ReleaseRequestV1 }
  | { kind: "error"; detail: string };

async function selectLocalReleaseRequest(
  input: LocalSupervisorInputV1,
): Promise<SelectionV1> {
  const receipts = await listLocalReleaseReceipts(input.stateRoot);
  if (!receipts.ok) {
    return { kind: "error", detail: DETAIL_RECEIPTS_UNREADABLE };
  }
  const terminal = new Set(
    receipts.value
      .filter((receipt) => isLocalReleaseTerminalPhase(receipt.phase))
      .map((receipt) => receipt.request.id),
  );
  const store = createRepairStateStore({
    scratchDir: joinPath(input.stateRoot, STATE_SCRATCH_DIR),
    remoteUrl: joinPath(input.stateRoot, STATE_GIT_DIR),
  });
  const read = await store.readRepair();
  if (!read.ok) return { kind: "error", detail: DETAIL_STATE_READ };
  if (read.value.status !== "found") {
    return { kind: "error", detail: DETAIL_STATE_ABSENT };
  }
  const snapshot: RepairStateSnapshotV1 = read.value.snapshot;
  const candidates = snapshot.releaseRequests
    .filter((request) =>
      request.status === "open" &&
      request.target.environment === "production" &&
      isLocalSentinelRepository(request.target.repository) &&
      !terminal.has(request.id)
    )
    .sort((left, right) =>
      left.createdAt - right.createdAt ||
      (left.id < right.id ? -1 : 1)
    );
  for (const request of candidates) {
    const review = matchReviewReceipt(request, snapshot.reviews);
    if (review === null) continue;
    const ancestor = await sourceRevisionIsAncestor(input, request.revision);
    if (!ancestor.ok) return { kind: "error", detail: ancestor.detail };
    if (!ancestor.value) continue;
    return { kind: "found", request };
  }
  return { kind: "none" };
}

/**
 * The exact completed review receipt: same receipt/request identity, completed
 * with a timestamp, expected reviewer matching the observed reviewer, full
 * findings (none uncounted) and no unresolved P0/P1. Source PR/head/base and
 * repository bind exactly to the request. No new review is created here.
 */
function matchReviewReceipt(
  request: ReleaseRequestV1,
  reviews: readonly ReviewReceiptV1[],
): ReviewReceiptV1 | null {
  const receiptId = request.source.reviewReceiptId;
  if (receiptId === null) return null;
  const receipt = reviews.find((item) => item.id === receiptId);
  if (receipt === undefined) return null;
  if (receipt.requestId !== request.source.reviewRequestId) return null;
  if (receipt.outcome !== "completed" || receipt.completedAt === null) {
    return null;
  }
  if (
    receipt.observedReviewer === null ||
    receipt.observedReviewer !== receipt.expectedReviewer
  ) {
    return null;
  }
  if (receipt.findingsUncounted !== 0) return null;
  if (
    receipt.unresolvedSeverities.includes("P0") ||
    receipt.unresolvedSeverities.includes("P1")
  ) {
    return null;
  }
  const repository = receipt.repository;
  const target = request.target.repository;
  if (
    repository.owner !== target.owner ||
    repository.name !== target.name ||
    repository.installationId !== target.installationId
  ) {
    return null;
  }
  if (receipt.pullRequest.number !== request.source.pullRequest) return null;
  if (receipt.pullRequest.head !== request.source.head) return null;
  if (receipt.pullRequest.base !== request.source.base) return null;
  return receipt;
}

// ---------------------------------------------------------------------------
// Runtimes: verify, stage, never overwrite
// ---------------------------------------------------------------------------

async function runAndVerify(
  input: LocalSupervisorInputV1,
  clock: Clock,
  revision: GitSha,
  known: KnownInvocationsV1,
): Promise<RunObservationV1> {
  const verification = await verifyRuntime(input, revision);
  if (!verification.ok) {
    return { kind: "failed", proof: null, detail: verification.detail };
  }
  if (!await probeRunnerLock(input.stateRoot)) {
    return { kind: "pending", detail: DETAIL_LOCK_HELD };
  }
  // The session marker is checked before the child starts as well as after it
  // settles: a marker left by a prior run pauses this invocation instead of
  // layering a new child over an unsettled session.
  if (await localSessionMarkerExists(input.stateRoot)) {
    return { kind: "pending", detail: DETAIL_MARKER_PRESENT };
  }
  const runtimeDir = runtimePath(input.stateRoot, revision);
  const startedAt = clock.now();
  const logPath = joinPath(
    input.stateRoot,
    "supervisor-logs",
    `${revision}-${startedAt}-${crypto.randomUUID()}`,
  );
  let run: LocalSupervisorChildResultV1;
  try {
    run = await input.runChild({
      stateRoot: input.stateRoot,
      runtimeDir,
      revision,
      taskName: REPAIR_TASK_NAME,
      env: {
        HOME: input.env.HOME,
        PATH: input.env.PATH,
        GITHUB_TOKEN: input.env.GITHUB_TOKEN,
        UOS_AI_TOKEN: input.env.UOS_AI_TOKEN,
      },
      denoExecutable: input.denoExecutable,
      deadlineMs: CHILD_DEADLINE_MS,
      logPath,
    });
  } catch {
    return { kind: "pending", detail: DETAIL_CHILD_UNSETTLED };
  }
  if (!run.settled) {
    return { kind: "pending", detail: DETAIL_CHILD_UNSETTLED };
  }
  const settledAt = clock.now();
  if (await localSessionMarkerExists(input.stateRoot)) {
    return { kind: "pending", detail: DETAIL_MARKER_PRESENT };
  }
  if (!await probeRunnerLock(input.stateRoot)) {
    return { kind: "pending", detail: DETAIL_LOCK_NOT_RELEASED };
  }
  // A settled child with a nonzero exit, an absent marker and a free runner
  // lock is an objective failed run even when the status receipt is missing or
  // stale. No proof is fabricated for it: the saved exact prior proof drives
  // the ordinary rollback.
  if (run.exitCode !== 0) {
    return { kind: "failed", proof: null, detail: DETAIL_CHILD_EXIT_FAILED };
  }
  const status = await readLocalRunStatus(input.stateRoot);
  if (!status.ok || status.value === null) {
    return { kind: "pending", detail: DETAIL_STATUS_UNREADABLE };
  }
  const observed: LocalRunStatusV1 = status.value;
  if (
    observed.controllerSha !== revision ||
    !Number.isSafeInteger(observed.startedAt) ||
    !Number.isSafeInteger(observed.finishedAt)
  ) {
    return { kind: "pending", detail: DETAIL_STATUS_STALE };
  }
  // The proof must belong to this invocation's bounded window: the child
  // starts at/after the parent's recorded start, finishes at/after its own
  // start, and never finishes after the parent observed settlement. A stale or
  // future proof is never acceptance.
  if (
    observed.startedAt < startedAt ||
    observed.finishedAt < observed.startedAt ||
    observed.finishedAt > settledAt
  ) {
    return { kind: "pending", detail: DETAIL_STATUS_STALE };
  }
  if (known.has(observed.invocationId)) {
    return { kind: "pending", detail: DETAIL_STATUS_DUPLICATE };
  }
  known.add(observed.invocationId);
  const proof: LocalRunProofV1 = {
    invocationId: observed.invocationId,
    controllerSha: observed.controllerSha,
    startedAt: observed.startedAt,
    finishedAt: observed.finishedAt,
    outcome: observed.outcome,
  };
  // An explicitly failed outcome is an objective failure even when the child
  // reported its repair state as unavailable: the observed proof drives the
  // ordinary exact-prior rollback. State availability is required only before
  // a healthy proof may be accepted; a healthy missing/unavailable state is
  // never acceptance and stays pending.
  if (isFailedOutcome(observed.outcome)) {
    return {
      kind: "failed",
      proof,
      detail: `local supervisor refused: the run reported ${observed.outcome}`,
    };
  }
  if (!observed.stateAvailable) {
    return { kind: "pending", detail: DETAIL_STATE_UNAVAILABLE };
  }
  return { kind: "proof", proof };
}

async function verifyRuntime(
  input: LocalSupervisorInputV1,
  revision: GitSha,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const runtimeDir = runtimePath(input.stateRoot, revision);
  const runtimesRoot = joinPath(input.stateRoot, RUNTIMES_DIR);
  let realRoot: string;
  try {
    realRoot = await Deno.realPath(runtimesRoot);
  } catch {
    return { ok: false, detail: DETAIL_RUNTIME_INVALID };
  }
  let realRuntime: string;
  try {
    const info = await Deno.lstat(runtimeDir);
    if (!info.isDirectory) return { ok: false, detail: DETAIL_RUNTIME_INVALID };
    realRuntime = await Deno.realPath(runtimeDir);
  } catch {
    return { ok: false, detail: DETAIL_RUNTIME_INVALID };
  }
  if (
    realRuntime === realRoot || !realRuntime.startsWith(`${realRoot}/`)
  ) {
    return { ok: false, detail: DETAIL_RUNTIME_INVALID };
  }
  const head = await runGit(input, ["-C", runtimeDir, "rev-parse", "HEAD"]);
  if (
    !head.ok || head.exitCode !== 0 || head.stdout.trim() !== revision
  ) {
    return { ok: false, detail: DETAIL_RUNTIME_INVALID };
  }
  const status = await runGit(input, [
    "-C",
    runtimeDir,
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (!status.ok || status.exitCode !== 0 || status.stdout.trim() !== "") {
    return { ok: false, detail: DETAIL_RUNTIME_INVALID };
  }
  const symlinks = await verifyTrackedSymlinks(input, runtimeDir, realRuntime);
  if (!symlinks.ok) return symlinks;
  return { ok: true };
}

async function verifyTrackedSymlinks(
  input: LocalSupervisorInputV1,
  runtimeDir: string,
  realRuntime: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const listed = await runGit(input, [
    "-C",
    runtimeDir,
    "ls-files",
    "-s",
  ]);
  if (!listed.ok || listed.exitCode !== 0) {
    return { ok: false, detail: DETAIL_RUNTIME_INVALID };
  }
  const links: string[] = [];
  for (const line of listed.stdout.split("\n")) {
    if (!line.startsWith("120000 ")) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) return { ok: false, detail: DETAIL_RUNTIME_INVALID };
    links.push(line.slice(tab + 1));
    if (links.length > MAX_TRACKED_SYMLINKS) {
      return { ok: false, detail: DETAIL_RUNTIME_INVALID };
    }
  }
  for (const link of links) {
    let resolved: string;
    try {
      resolved = await Deno.realPath(joinPath(runtimeDir, link));
    } catch {
      return { ok: false, detail: DETAIL_RUNTIME_INVALID };
    }
    if (resolved !== realRuntime && !resolved.startsWith(`${realRuntime}/`)) {
      return { ok: false, detail: DETAIL_RUNTIME_INVALID };
    }
  }
  return { ok: true };
}

async function stageRuntime(
  input: LocalSupervisorInputV1,
  revision: GitSha,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const runtimesRoot = joinPath(input.stateRoot, RUNTIMES_DIR);
  const target = runtimePath(input.stateRoot, revision);
  try {
    await ensurePrivateDir(runtimesRoot);
  } catch {
    return { ok: false, detail: DETAIL_STAGE_FAILED };
  }
  let targetExists = true;
  try {
    const info = await Deno.lstat(target);
    if (!info.isDirectory) return { ok: false, detail: DETAIL_STAGE_FAILED };
  } catch {
    targetExists = false;
  }
  if (targetExists) {
    // An existing runtime is never overwritten: it is either the exact clean
    // revision (reused) or a refusal.
    const verified = await verifyRuntime(input, revision);
    return verified.ok
      ? { ok: true }
      : { ok: false, detail: DETAIL_STAGE_FAILED };
  }

  const stage = joinPath(
    runtimesRoot,
    `.stage-${revision}-${crypto.randomUUID()}`,
  );
  try {
    await ensurePrivateDir(stage);
    const cloned = await runGit(input, [
      "clone",
      "--no-hardlinks",
      "--no-checkout",
      input.sourceDir,
      stage,
    ]);
    if (!cloned.ok) throw new Error(DETAIL_STAGE_FAILED);
    // The source mirror's refreshed development tip lives on its remote-tracking
    // ref, so the exact revision's objects are carried over explicitly before
    // the detached checkout. Local path, no credentials.
    const carried = await runGit(input, [
      "-C",
      stage,
      "fetch",
      "--no-tags",
      input.sourceDir,
      "+refs/remotes/origin/development:refs/remotes/origin/development",
    ]);
    if (!carried.ok) throw new Error(DETAIL_STAGE_FAILED);
    const checkedOut = await runGit(input, [
      "-C",
      stage,
      "checkout",
      "--detach",
      revision,
    ]);
    if (!checkedOut.ok) throw new Error(DETAIL_STAGE_FAILED);
    const head = await runGit(input, ["-C", stage, "rev-parse", "HEAD"]);
    if (!head.ok || head.exitCode !== 0 || head.stdout.trim() !== revision) {
      throw new Error(DETAIL_STAGE_FAILED);
    }
    try {
      await Deno.rename(stage, target);
    } catch {
      // A concurrent writer may have created the exact same immutable runtime;
      // it is reused only when it verifies as the exact clean revision.
      const verified = await verifyRuntime(input, revision);
      if (!verified.ok) throw new Error(DETAIL_STAGE_FAILED);
    }
  } catch {
    try {
      await Deno.remove(stage, { recursive: true });
    } catch {
      // the staged temp directory is private and never part of history
    }
    return { ok: false, detail: DETAIL_STAGE_FAILED };
  }
  const verified = await verifyRuntime(input, revision);
  return verified.ok
    ? { ok: true }
    : { ok: false, detail: DETAIL_STAGE_FAILED };
}

// ---------------------------------------------------------------------------
// Source ancestry: exact revision must be contained in refreshed development
// ---------------------------------------------------------------------------

async function sourceRevisionIsAncestor(
  input: LocalSupervisorInputV1,
  revision: GitSha,
): Promise<{ ok: true; value: boolean } | { ok: false; detail: string }> {
  // The healthy real child host already refreshes the local source mirror's
  // development remote-tracking ref. The supervisor performs no fetch and
  // needs no GitHub credential for its own Git commands; a missing ref or a
  // missing exact revision object is an explicit refusal, never ancestry.
  const resolved = await runGit(input, [
    "-C",
    input.sourceDir,
    "rev-parse",
    "--verify",
    "--quiet",
    LOCAL_DEVELOPMENT_REF,
  ]);
  if (
    !resolved.ok || resolved.exitCode !== 0 || resolved.stdout.trim() === ""
  ) {
    return { ok: false, detail: DETAIL_SOURCE_UNAVAILABLE };
  }
  const ancestor = await runGit(input, [
    "-C",
    input.sourceDir,
    "merge-base",
    "--is-ancestor",
    revision,
    LOCAL_DEVELOPMENT_REF,
  ]);
  if (!ancestor.ok) return { ok: false, detail: DETAIL_SOURCE_UNAVAILABLE };
  // 0 = contained, 1 = not contained. Anything else (for example 128 for an
  // absent revision object) is a refusal, never a silent non-ancestor value.
  if (ancestor.exitCode !== 0 && ancestor.exitCode !== 1) {
    return { ok: false, detail: DETAIL_SOURCE_UNAVAILABLE };
  }
  return { ok: true, value: ancestor.exitCode === 0 };
}

// ---------------------------------------------------------------------------
// Locks, environment and bounded child/git execution
// ---------------------------------------------------------------------------

export async function tryAcquireSupervisorLock(
  stateRoot: string,
): Promise<Deno.FsFile | null> {
  await ensurePrivateDir(stateRoot);
  const file = await Deno.open(joinPath(stateRoot, "supervisor.lock"), {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  try {
    if (file.tryLockSync(true)) return file;
  } catch {
    // fall through to close + refusal
  }
  file.close();
  return null;
}

async function seedKnownInvocations(stateRoot: string): Promise<Set<string>> {
  const known = new Set<string>();
  const status = await readLocalRunStatus(stateRoot);
  if (status.ok && status.value !== null) {
    known.add(status.value.invocationId);
  }
  return known;
}

function addProofInvocation(
  known: KnownInvocationsV1,
  proof: LocalRunProofV1 | null,
): void {
  if (proof !== null) known.add(proof.invocationId);
}

/** The prepared inline profile and dedicated child cache paths. */
interface LocalChildWriteBoundaryV1 {
  profile: string;
  denoDir: string;
  tmpDir: string;
}

/**
 * The exact inherited OS write boundary for one real repair child. The child
 * keeps the trusted host's read, process and network permissions, but every
 * write, hardlink and rename is denied unless it is beneath one exact mutable
 * private state directory, on one exact child-owned receipt or on
 * `/dev/null`. `file-write-mode` on the state root itself exists only for the
 * existing `ensurePrivateDir` chmod. Each mutable top-level directory is
 * additionally unlinked-denied so an allowed directory can never be replaced
 * or renamed into authority.
 *
 * The state root and every granted directory are re-observed here: a symlinked
 * root or a symlinked mutable directory would silently expand the granted
 * subpath, so it is a refusal and never a partially granted profile. The
 * profile is an inline argv string; no child-writable profile file exists.
 */
async function prepareChildWriteBoundary(
  stateRoot: string,
): Promise<LocalChildWriteBoundaryV1 | null> {
  if (Deno.build.os !== "darwin") return null;
  try {
    const rootInfo = await Deno.lstat(stateRoot);
    if (!rootInfo.isDirectory || rootInfo.isSymlink) return null;
    const canonicalRoot = await Deno.realPath(stateRoot);
    await ensurePrivateDir(canonicalRoot);
    const mutableDirs: string[] = [];
    for (const name of CHILD_MUTABLE_STATE_DIRS) {
      const dir = joinPath(canonicalRoot, name);
      if (!await prepareMutableGrantDir(dir)) return null;
      mutableDirs.push(dir);
    }
    const denoDir = joinPath(canonicalRoot, CHILD_DENO_DIR);
    const tmpDir = joinPath(canonicalRoot, CHILD_TMP_DIR);
    for (const dir of [denoDir, tmpDir]) {
      if (!await prepareMutableGrantDir(dir)) return null;
    }
    return {
      profile: buildChildSandboxProfile(canonicalRoot, mutableDirs),
      denoDir,
      tmpDir,
    };
  } catch {
    return null;
  }
}

/**
 * One mutable grant directory. An entry that already exists is re-observed
 * BEFORE any chmod: a symlink there would otherwise redirect the mode change
 * outside the state root, so a symlink or non-directory is a refusal and no
 * existing entry is ever recreated, removed or reset. A missing entry is
 * created private, and every accepted directory must resolve to its own exact
 * path.
 */
async function prepareMutableGrantDir(dir: string): Promise<boolean> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(dir);
  } catch {
    await ensurePrivateDir(dir);
    return await Deno.realPath(dir) === dir;
  }
  if (!info.isDirectory || info.isSymlink) return false;
  await Deno.chmod(dir, 0o700);
  return await Deno.realPath(dir) === dir;
}

/**
 * The inline Seatbelt profile for one real child. The broad deny lands first,
 * the exact mutable grants land next, and the per-directory unlink denials
 * land last so an allowed directory is writable but never replaceable.
 */
function buildChildSandboxProfile(
  canonicalRoot: string,
  mutableDirs: readonly string[],
): string {
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write* file-link)",
  ];
  for (const dir of mutableDirs) {
    lines.push(
      `(allow file-write* file-link (subpath ${sandboxLiteral(dir)}))`,
    );
  }
  for (const name of CHILD_MUTABLE_STATE_FILES) {
    lines.push(
      `(allow file-write* (literal ${
        sandboxLiteral(joinPath(canonicalRoot, name))
      }))`,
    );
  }
  lines.push(`(allow file-write* (literal ${sandboxLiteral("/dev/null")}))`);
  lines.push(
    `(allow file-write-mode (literal ${sandboxLiteral(canonicalRoot)}))`,
  );
  for (const dir of mutableDirs) {
    lines.push(`(deny file-write-unlink (literal ${sandboxLiteral(dir)}))`);
  }
  return lines.join("\n");
}

/**
 * One correctly quoted SBPL string. The profile is passed as a single argv
 * element and never through a shell; a path that cannot be represented safely
 * is a refusal rather than an interpolation into the profile.
 */
function sandboxLiteral(path: string): string {
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      throw new TypeError(
        "local supervisor rejected: a child sandbox path contains a control character",
      );
    }
  }
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * The only injected implementation border: real Deno child execution. Every
 * real child is launched through the fixed platform sandbox with `DENO_DIR`
 * and `TMPDIR` redirected beneath the private state, using the same owned
 * process-group runtime as every other real subprocess. The deadline spans the
 * whole sandboxed group and its captured streams, so a descendant that
 * outlives the task leader is terminated and settlement is verified before the
 * run is reported. A platform or profile that cannot provide the boundary
 * returns a non-success result and the child is never launched unsandboxed.
 */
export async function defaultRunChild(
  input: LocalSupervisorChildInputV1,
): Promise<LocalSupervisorChildResultV1> {
  const boundary = await prepareChildWriteBoundary(input.stateRoot);
  if (boundary === null) return { settled: false, exitCode: null };
  const result = await new DenoReplayRuntime(SANDBOX_EXEC_PATH).run({
    executable: SANDBOX_EXEC_PATH,
    args: [
      "-p",
      boundary.profile,
      input.denoExecutable,
      "task",
      input.taskName,
    ],
    cwd: input.runtimeDir,
    env: {
      ...input.env,
      DENO_DIR: boundary.denoDir,
      TMPDIR: boundary.tmpDir,
    },
    maxDurationMs: input.deadlineMs,
    maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  await writeLocalChildLog(
    input.stateRoot,
    `child-${input.revision}-${Date.now()}`,
    `stdout:\n${stdout}\nstderr:\n${stderr}\n`,
  ).catch(() => {});
  // Truthful mapping: an unsettled run stays unsettled and a timed-out run
  // keeps its null exit code, so it can never be read as a successful run.
  return { settled: result.settled, exitCode: result.exitCode };
}

interface GitRunV1 {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
}

/**
 * Bounded git with explicit args, never a shell string. The run reuses the
 * shared owned-group runtime, so both captured streams are drained
 * concurrently (no full-pipe deadlock), the deadline covers the whole process
 * group, and the aggregate retained output is bounded. Owner Git configuration
 * is never consulted: a disposable private HOME, no global/system config and a
 * null hooks path keep the command credential-free. A normal nonzero exit is
 * still `ok: true` so ancestry can read its documented exit 1; only an
 * unsettled, timed-out, spawn-failed or truncated run is `ok: false`.
 */
export async function runGit(
  input: LocalSupervisorInputV1,
  args: readonly string[],
): Promise<GitRunV1> {
  const git = gitExecutable();
  try {
    const result = await new DenoReplayRuntime(git).run({
      executable: git,
      args: ["-c", "core.hooksPath=/dev/null", ...args],
      cwd: input.stateRoot,
      env: {
        PATH: input.env.PATH,
        HOME: input.stateRoot,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      maxDurationMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
    });
    const stdout = new TextDecoder().decode(result.stdout);
    if (result.outcome !== "exited" || !result.settled || result.truncated) {
      return { ok: false, exitCode: result.exitCode, stdout };
    }
    return { ok: true, exitCode: result.exitCode, stdout };
  } catch {
    return { ok: false, exitCode: null, stdout: "" };
  }
}

function gitExecutable(): string {
  try {
    Deno.statSync("/usr/bin/git");
    return "/usr/bin/git";
  } catch {
    return "git";
  }
}

function readLocalSupervisorOptions(
  options: LocalSupervisorOptionsV1,
): LocalSupervisorInputV1 {
  const record = options as unknown as Record<string, unknown>;
  const stateRoot = requireText(record?.stateRoot);
  const denoExecutable = requireText(record?.denoExecutable);
  const env = record?.env as LocalSupervisorEnvV1 | undefined;
  const home = requireText(env?.HOME);
  const path = requireText(env?.PATH);
  const githubToken = requireText(env?.GITHUB_TOKEN);
  const uosToken = requireText(env?.UOS_AI_TOKEN);
  const runChild = record?.runChild;
  return {
    stateRoot,
    sourceDir: joinPath(stateRoot, SOURCE_DIR),
    env: {
      HOME: home,
      PATH: path,
      GITHUB_TOKEN: githubToken,
      UOS_AI_TOKEN: uosToken,
    },
    denoExecutable,
    runChild: typeof runChild === "function"
      ? runChild as LocalSupervisorChildRunnerV1
      : defaultRunChild,
  };
}

function requireText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("local supervisor rejected: options are invalid");
  }
  return value;
}

function isHealthyOutcome(outcome: LocalRunProofV1["outcome"]): boolean {
  return LOCAL_RUN_HEALTHY_STATUSES.includes(outcome);
}

function isFailedOutcome(outcome: LocalRunProofV1["outcome"]): boolean {
  return LOCAL_RUN_FAILED_STATUSES.includes(outcome);
}

function runtimePath(stateRoot: string, revision: GitSha): string {
  if (!isGitSha(revision)) {
    throw new TypeError(
      "local supervisor rejected: revision is not an exact SHA",
    );
  }
  return joinPath(stateRoot, RUNTIMES_DIR, revision);
}

function joinPath(base: string, ...parts: string[]): string {
  let out = base.replace(/\/+$/, "");
  for (const part of parts) {
    out += "/" + part.replace(/^\/+|\/+$/g, "");
  }
  return out.length === 0 ? "/" : out;
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`local supervisor requires environment variable ${name}`);
  }
  return value;
}

if (import.meta.main) {
  let result: LocalSupervisorResultV1;
  try {
    const home = requireEnv("HOME");
    result = await runLocalSupervisor({
      stateRoot: joinPath(home, ".local", "state", "sentinel-local"),
      env: {
        HOME: home,
        PATH: Deno.env.get("PATH") ?? "",
        GITHUB_TOKEN: requireEnv("GITHUB_TOKEN"),
        UOS_AI_TOKEN: requireEnv("UOS_AI_TOKEN"),
      },
      denoExecutable: Deno.execPath(),
    });
  } catch {
    result = {
      status: "failed",
      detail: "local supervisor failed: trusted environment is incomplete",
    };
  }
  console.log(JSON.stringify(result));
  if (result.status === "failed") Deno.exitCode = 1;
}
