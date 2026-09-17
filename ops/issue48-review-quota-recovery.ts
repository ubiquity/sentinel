/**
 * One-shot hosted issue-48 review-quota recovery.
 *
 * The owner directed on 2026-09-17 that the hosted runtime finish issue 48
 * after the review no-verdict recovery fix was installed. The runtime consumed
 * the plan's three review rounds for that exact head, but two of the three
 * ended without an accepted verdict for infrastructure reasons — a cancelled
 * execution on 2026-09-16 and an app-server evidence refusal on 2026-09-17 —
 * and the new fail-closed guard therefore blocks the item with `review_quota`
 * instead of polling forever. This helper performs exactly one bounded repair
 * state transition for that ONE task: `issue-ubiquity-sentinel-48` moves to
 * `work` with its blocker and intent cleared so the ordinary runtime admits the
 * next attempt through its own admission path.
 *
 * It is NOT a general maintenance framework and NOT a quota edit: it writes no
 * release state, reserves or refunds no budget, drops no receipt, evidence,
 * reservation or review, changes no policy and touches no other record. The only
 * counter it may lower is the single implementation attempt the binding grants
 * as a closed 0-or-1 value. Every historical charge and identity is preserved by
 * reference.
 *
 * Safety envelope:
 * - `runIssue48QuotaRecoveryMain` refuses to touch credentials or state unless
 *   the process is the hosted `maintenance` job of the protected
 *   `sentinel-supervisor` workflow at the exact dispatched source commit with a
 *   clean checkout. Identity is verified before any state operation.
 * - The repair ref is read FIRST. The transition applies only while the exact
 *   work item still carries the exact counters, evidence, target and PR
 *   identity this binding pins, and only while the single hosted runtime is
 *   settled, healthy at its exact revision/generation and every hosted release
 *   is terminal. A leftover implementation intent is closed ONLY when the
 *   reservation it names is provably settled, which is the proof that the
 *   failed attempt can no longer publish a candidate.
 * - Exactly one `writeRepair` with the observed head as its expected parent is
 *   attempted; its typed disposition is preserved and never retried. An applied
 *   outcome is reported only after a full readback proves the returned head, the
 *   entire canonical snapshot and the unchanged release ref. Uncertain outcomes
 *   are never rolled back.
 * - The result is one bounded static JSON line; raw inputs, tokens, paths,
 *   snapshots and process output are never printed.
 *
 * The exported core takes injected state/clock dependencies so tests run
 * credential-free against real temporary local Git state. Only
 * `runIssue48QuotaRecoveryMain` uses the fixed production pins and GITHUB
 * identity.
 */

import type { GitSha, WorkItemId } from "../src/contracts/brands.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import type { HostedRuntimeRecordV1 } from "../src/contracts/hosted-supervisor.ts";
import type {
  PortErrorKindV1,
  PortResultV1,
  RepairStateWriter,
  StateReadResultV1,
  StateReadView,
  StateWriteResultV1,
} from "../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import { githubGitAuthEnv } from "../src/host/local.ts";
import { createRepairStateStore, DenoGitRunner } from "../src/state/mod.ts";

/** The only repository identity this helper accepts. */
export const ISSUE48_QUOTA_REPOSITORY = "ubiquity/sentinel";

/** The only remote this helper talks to; fixed, never configurable. */
export const ISSUE48_QUOTA_REMOTE_URL =
  "https://github.com/ubiquity/sentinel.git";

/** Exact hosted workflow identity that may run the maintenance job. */
export const ISSUE48_QUOTA_WORKFLOW_REF =
  "ubiquity/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor";

/**
 * Exact prefix of the blocker this one-shot may clear. The runtime writes the
 * observed static reason after it; the prefix alone is never sufficient, the
 * whole message is preserved in the operation result by the runtime, never here.
 */
export const ISSUE48_QUOTA_BLOCKER_PREFIX =
  "review rounds exhausted without an accepted verdict";

/**
 * Exact prefix of the second blocker this one-shot may clear: the runtime's
 * exhausted implementation-attempt budget, which is what refuses the one
 * bounded correction a completed reviewer finding requires.
 */
export const ISSUE48_QUOTA_BUDGET_BLOCKER_PREFIX =
  "implementation attempt budget exhausted";

/**
 * Exact prefix of the third blocker this one-shot may clear: an implementation
 * session that ended without a trusted candidate (kind `other`), which is a
 * failed attempt rather than substantive progress and therefore also needs the
 * one bounded retry the owner directed.
 */
export const ISSUE48_QUOTA_CANDIDATE_BLOCKER_PREFIX =
  "model run did not complete with a trusted candidate";

/**
 * Exact prefix of the fourth blocker this one-shot may clear: the shared budget
 * refusing a reservation whose (task, base, attempt, purpose) identity is
 * already settled. The base advance below is what gives the next attempt a new
 * identity, so this closed reason is the one the recovery exists to resolve.
 */
export const ISSUE48_QUOTA_ADMISSION_BLOCKER_PREFIX =
  "model admission refused: duplicate";

/** Fixed production binding of the reviewed one-shot recovery. */
export interface Issue48QuotaRecoveryBindingV1 {
  /** Exact target work item id. */
  targetId: WorkItemId;
  /** Exact consumed counters; any drift refuses the transition. */
  counters: { attempts: number; retries: number; reviewRounds: number };
  /**
   * Implementation attempts this one-shot may grant back. The shared budget
   * derives a reservation identity from (task, base, attempt, purpose), so the
   * value is exactly the number of counter units that makes the next admission
   * an UNUSED identity at the record's current base — never a general budget
   * reset. It is a closed 0..3 value, applied once, with every charge and
   * reservation preserved and the rest of the budget untouched.
   */
  grantedImplementationAttempts: 0 | 1 | 2 | 3;
  /** Exact accepted review receipt ref that must be retained. */
  evidenceRef: string;
  /** Exact review receipt ids that must survive; a missing one refuses. */
  reviewIds: readonly string[];
  /** Exact open PR identity required before the transition. */
  pullRequestNumber: number;
  pullRequestHead: GitSha;
  pullRequestBase: GitSha;
  repository: string;
  /** Sole hosted runtime identity and pointer. */
  runtimeId: string;
  runtimeRevision: GitSha;
  runtimeGeneration: number;
}

/**
 * Reviewed production pins, read from the live state on 2026-09-17 13:30Z:
 * review round 10's P2 finding requires one more bounded correction, the record
 * is still at its unobserved `review` step so that finding is recorded first,
 * and the grant is the exact number of counter units (4 -> 2) that makes the
 * next admission (task/base/attempt 3) an UNUSED reservation identity at this
 * base.
 * The repair ref head is deliberately NOT pinned: it moves on every runtime
 * cycle, so the expected-head CAS plus the exact work-item preconditions and
 * the full readback are what authorize the single write.
 */
export const ISSUE48_QUOTA_PRODUCTION_BINDING: Issue48QuotaRecoveryBindingV1 = {
  targetId: "issue-ubiquity-sentinel-48" as WorkItemId,
  counters: { attempts: 4, retries: 0, reviewRounds: 10 },
  grantedImplementationAttempts: 2,
  evidenceRef:
    "artifact:review-receipt/review-receipt:2e4e595978d5ca887abcad4a31b0ac94ea7d548227792f85b0d210078d3c1446",
  reviewIds: [
    "review-receipt:2e4e595978d5ca887abcad4a31b0ac94ea7d548227792f85b0d210078d3c1446",
  ],
  pullRequestNumber: 51,
  pullRequestHead: "cd73f2c62ace27c28d959cd61bb9dd1e33d688c1" as GitSha,
  pullRequestBase: "0b2f389610f7cb254f335e227eb29c12e7c11960" as GitSha,
  repository: ISSUE48_QUOTA_REPOSITORY,
  runtimeId: "ubiquity/sentinel:0:production",
  runtimeRevision: "664a52ddeb4f23eafa58a32e8394754f3303f0c4" as GitSha,
  runtimeGeneration: 13,
};

export interface Issue48QuotaRecoveryDepsV1 {
  state: StateReadView & RepairStateWriter;
  clock: { now(): number };
  binding: Issue48QuotaRecoveryBindingV1;
}

/** Closed set of static result reasons; never built from raw error text. */
export type Issue48QuotaRecoveryReasonV1 =
  | "applied"
  | "already_recovered"
  | "identity_rejected"
  | "unexpected_failure"
  | "repair_read_failed"
  | "release_read_failed"
  | "runtime_mismatch"
  | "release_not_terminal"
  | "target_missing"
  | "target_precondition_mismatch"
  | "clock_invalid"
  | "snapshot_invalid"
  | "write_conflict"
  | "write_ambiguous"
  | "write_unavailable"
  | "write_auth_failed"
  | "write_rate_limited"
  | "write_not_found"
  | "write_invalid"
  | "readback_unverified";

export type Issue48QuotaRecoveryStatusV1 =
  | "applied"
  | "skipped"
  | "failed";

/** One bounded result. Heads are present only where actually proved. */
export interface Issue48QuotaRecoveryResultV1 {
  kind: "issue48_review_quota_recovery";
  status: Issue48QuotaRecoveryStatusV1;
  reason: Issue48QuotaRecoveryReasonV1;
  beforeHead: GitSha | null;
  appliedHead: GitSha | null;
}

function failed(
  reason: Issue48QuotaRecoveryReasonV1,
  beforeHead: GitSha | null = null,
): Issue48QuotaRecoveryResultV1 {
  return {
    kind: "issue48_review_quota_recovery",
    status: "failed",
    reason,
    beforeHead,
    appliedHead: null,
  };
}

function skipped(
  reason: Issue48QuotaRecoveryReasonV1,
  beforeHead: GitSha | null,
): Issue48QuotaRecoveryResultV1 {
  return {
    kind: "issue48_review_quota_recovery",
    status: "skipped",
    reason,
    beforeHead,
    appliedHead: null,
  };
}

function writeFailureReason(
  kind: PortErrorKindV1,
): Issue48QuotaRecoveryReasonV1 {
  switch (kind) {
    case "unavailable":
      return "write_unavailable";
    case "auth_failed":
      return "write_auth_failed";
    case "rate_limited":
      return "write_rate_limited";
    case "not_found":
      return "write_not_found";
    case "conflict":
      return "write_conflict";
    case "invalid":
      return "write_invalid";
  }
}

function sameCounters(
  record: WorkRecordV1,
  binding: Issue48QuotaRecoveryBindingV1,
): boolean {
  return record.counters.attempts === binding.counters.attempts &&
    record.counters.retries === binding.counters.retries &&
    record.counters.reviewRounds === binding.counters.reviewRounds;
}

/**
 * True only while the target still carries the exact identity this binding
 * pins AND is in one of the two states this one-shot may advance: waiting at
 * `review` with no pending operation, or blocked by exactly the review-quota
 * reason the runtime writes. Every other state — a done record, a different
 * blocker, an open intent, a moved PR or a different counter — refuses.
 */
export function targetPreconditionHolds(
  record: WorkRecordV1,
  binding: Issue48QuotaRecoveryBindingV1,
  /** Snapshot reservations; used to prove a failed attempt is fully settled. */
  reservations: readonly { id: string; outcome: string }[] = [],
): boolean {
  if (!sameCounters(record, binding)) return false;
  if (
    record.target.pr !== binding.pullRequestNumber ||
    record.target.head !== binding.pullRequestHead ||
    record.target.base !== binding.pullRequestBase
  ) {
    return false;
  }
  if (!record.evidence.some((ref) => ref.ref === binding.evidenceRef)) {
    return false;
  }
  if (
    binding.grantedImplementationAttempts < 0 ||
    binding.grantedImplementationAttempts > 3 ||
    binding.grantedImplementationAttempts > binding.counters.attempts
  ) {
    return false;
  }
  if (record.nextStep === "review") return record.intent === null;
  if (record.nextStep !== "blocked") return false;
  const blocker = record.blocker;
  if (blocker === null) return false;
  if (blocker.kind === "review_quota") {
    if (record.intent !== null) return false;
    return blocker.message.startsWith(ISSUE48_QUOTA_BLOCKER_PREFIX) ||
      blocker.message.startsWith(ISSUE48_QUOTA_BUDGET_BLOCKER_PREFIX);
  }
  if (blocker.kind === "unavailable") {
    if (record.intent !== null) return false;
    return blocker.message.startsWith(ISSUE48_QUOTA_ADMISSION_BLOCKER_PREFIX);
  }
  if (
    blocker.kind !== "other" ||
    !blocker.message.startsWith(ISSUE48_QUOTA_CANDIDATE_BLOCKER_PREFIX)
  ) {
    return false;
  }
  // A failed implementation attempt leaves its intent in place after the run
  // settled it. That intent may only be closed when it is provably CLOSED: it
  // names a reservation of this exact record that is settled (never reserved),
  // which is what proves the attempt cannot still publish a candidate. Any
  // other intent — including an unsettled or foreign one — refuses.
  if (record.intent === null) return true;
  if (record.intent.kind !== "implementation") return false;
  const reservationId = record.intent.requestId;
  if (reservationId === null || reservationId === "") return false;
  return reservations.some((reservation) =>
    reservation.id === reservationId && reservation.outcome !== "reserved"
  );
}

/**
 * Clone the complete snapshot and change ONLY the target work fields — an
 * unobserved `review` step is PRESERVED so the runtime records the latest
 * finding before it corrects, a blocked step returns to `work`, and the wait,
 * blocker, intent and the granted counter decrement are applied — plus the
 * snapshot metadata. Evidence, reviews, reservations, targets, blocker history and every
 * other record survive by reference.
 */
export function buildNextQuotaSnapshot(
  prior: RepairStateSnapshotV1,
  targetId: WorkItemId,
  observedHead: GitSha,
  now: number,
  grantedImplementationAttempts: 0 | 1 | 2 | 3 = 0,
): RepairStateSnapshotV1 {
  const work = prior.work.map((record) =>
    record.id === targetId
      ? {
        ...record,
        nextStep: record.nextStep === "review"
          ? ("review" as const)
          : ("work" as const),
        wait: null,
        blocker: null,
        intent: null,
        counters: grantedImplementationAttempts === 0 ? record.counters : {
          ...record.counters,
          attempts: record.counters.attempts - grantedImplementationAttempts,
        },
        updatedAt: now,
      }
      : record
  );
  return {
    version: prior.version,
    kind: prior.kind,
    stateHead: observedHead,
    sequence: prior.sequence + 1,
    updatedAt: now,
    incidents: prior.incidents,
    evidence: prior.evidence,
    work,
    reservations: prior.reservations,
    reviews: prior.reviews,
    replays: prior.replays,
    releaseRequests: prior.releaseRequests,
    githubCooldowns: prior.githubCooldowns,
  };
}

async function readRepairSafely(
  state: StateReadView,
): Promise<PortResultV1<StateReadResultV1<RepairStateSnapshotV1>> | null> {
  try {
    return await state.readRepair();
  } catch {
    return null;
  }
}

async function readReleaseSafely(
  state: StateReadView,
): Promise<PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>> | null> {
  try {
    return await state.readRelease();
  } catch {
    return null;
  }
}

/** The single hosted runtime must be settled and healthy at the pinned pointer. */
function runtimeIsSettledHealthy(
  runtimes: readonly HostedRuntimeRecordV1[],
  binding: Issue48QuotaRecoveryBindingV1,
): boolean {
  if (runtimes.length !== 1) return false;
  const runtime = runtimes[0];
  if (runtime === undefined) return false;
  if (
    runtime.id !== binding.runtimeId ||
    runtime.activeRevision !== binding.runtimeRevision ||
    runtime.generation !== binding.runtimeGeneration ||
    runtime.execution !== null
  ) {
    return false;
  }
  const healthy = runtime.lastHealthyProof;
  return healthy !== null && healthy.outcome === "healthy" &&
    healthy.execution.revision === binding.runtimeRevision &&
    healthy.execution.generation === binding.runtimeGeneration;
}

/**
 * Run exactly one bounded attempt of the recovery against the injected state.
 * Returns a static result; never throws for a typed failure and never retries
 * or rolls back.
 */
export async function runIssue48QuotaRecovery(
  deps: Issue48QuotaRecoveryDepsV1,
): Promise<Issue48QuotaRecoveryResultV1> {
  const binding = deps.binding;

  const repairRead = await readRepairSafely(deps.state);
  if (repairRead === null || !repairRead.ok) {
    return failed("repair_read_failed");
  }
  if (repairRead.value.status !== "found") return failed("repair_read_failed");
  const observedHead = repairRead.value.head;

  let snapshot: RepairStateSnapshotV1;
  try {
    snapshot = parseRepairStateSnapshotV1(repairRead.value.snapshot);
  } catch {
    return failed("repair_read_failed", observedHead);
  }

  const releaseRead = await readReleaseSafely(deps.state);
  if (releaseRead === null || !releaseRead.ok) {
    return failed("release_read_failed", observedHead);
  }
  if (releaseRead.value.status !== "found") {
    return failed("release_read_failed", observedHead);
  }
  const releaseHead = releaseRead.value.head;
  let release: ReleaseStateSnapshotV1;
  try {
    release = parseReleaseStateSnapshotV1(releaseRead.value.snapshot);
  } catch {
    return failed("release_read_failed", observedHead);
  }
  if (!runtimeIsSettledHealthy(release.hostedRuntimes, binding)) {
    return failed("runtime_mismatch", observedHead);
  }
  if (
    release.hostedReleases.some((item) =>
      item.pointerIntent !== null ||
      (item.phase !== "accepted" && item.phase !== "rolled_back")
    )
  ) {
    return failed("release_not_terminal", observedHead);
  }

  const target = snapshot.work.find((record) => record.id === binding.targetId);
  if (target === undefined) return failed("target_missing", observedHead);
  if (!targetPreconditionHolds(target, binding, snapshot.reservations)) {
    // A record that already moved on (the runtime re-armed it, another actor
    // advanced it, or the counters/identity drifted) is an ordinary zero-write
    // skip, never a failure this one-shot may push through.
    const settled = target.nextStep === "work" || target.nextStep === "done";
    return settled
      ? skipped("already_recovered", observedHead)
      : failed("target_precondition_mismatch", observedHead);
  }
  for (const reviewId of binding.reviewIds) {
    if (!snapshot.reviews.some((review) => review.id === reviewId)) {
      return failed("target_precondition_mismatch", observedHead);
    }
  }

  const now = deps.clock.now();
  if (
    !Number.isSafeInteger(now) ||
    now < Math.max(snapshot.updatedAt, target.updatedAt)
  ) {
    return failed("clock_invalid", observedHead);
  }

  let next: RepairStateSnapshotV1;
  try {
    next = buildNextQuotaSnapshot(
      snapshot,
      binding.targetId,
      observedHead,
      now,
      binding.grantedImplementationAttempts,
    );
    parseRepairStateSnapshotV1(next);
  } catch {
    return failed("snapshot_invalid", observedHead);
  }

  let write: PortResultV1<StateWriteResultV1> | null;
  try {
    write = await deps.state.writeRepair(next, observedHead);
  } catch {
    return failed("write_unavailable", observedHead);
  }
  if (write === null) return failed("write_unavailable", observedHead);
  if (!write.ok) {
    return failed(writeFailureReason(write.error.kind), observedHead);
  }
  if (write.value.status === "conflict") {
    return failed("write_conflict", write.value.currentHead);
  }
  if (write.value.status === "ambiguous") {
    return failed("write_ambiguous", write.value.currentHead);
  }
  const writtenHead = write.value.head;

  const readback = await readRepairSafely(deps.state);
  if (readback === null || !readback.ok) {
    return failed("readback_unverified", observedHead);
  }
  if (readback.value.status !== "found") {
    return failed("readback_unverified", observedHead);
  }
  if (readback.value.head !== writtenHead) {
    return failed("readback_unverified", observedHead);
  }
  if (
    canonicalStringify(readback.value.snapshot) !== canonicalStringify(next)
  ) {
    return failed("readback_unverified", observedHead);
  }
  const releaseReadback = await readReleaseSafely(deps.state);
  if (
    releaseReadback === null || !releaseReadback.ok ||
    releaseReadback.value.status !== "found" ||
    releaseReadback.value.head !== releaseHead
  ) {
    return failed("readback_unverified", observedHead);
  }

  return {
    kind: "issue48_review_quota_recovery",
    status: "applied",
    reason: "applied",
    beforeHead: observedHead,
    appliedHead: writtenHead,
  };
}

// ---------------------------------------------------------------------------
// Hosted identity: main refuses to use credentials or state unless the process
// is the protected maintenance job at the exact dispatched source commit.
// ---------------------------------------------------------------------------

export interface Issue48QuotaHostedIdentityV1 {
  repository: string | null;
  ref: string | null;
  job: string | null;
  runId: string | null;
  runAttempt: string | null;
  workflowRef: string | null;
  sha: string | null;
  workflowSha: string | null;
  checkoutHead: string | null;
  checkoutClean: boolean;
}

export type Issue48QuotaIdentityFailureV1 =
  | "repository"
  | "ref"
  | "job"
  | "run"
  | "workflow_ref"
  | "sha"
  | "checkout";

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;

function isRunId(value: string | null): boolean {
  if (value === null || !RUN_ID_PATTERN.test(value)) return false;
  return Number.isSafeInteger(Number(value));
}

export function validateIssue48QuotaHostedIdentity(
  input: Issue48QuotaHostedIdentityV1,
): { ok: true } | { ok: false; reason: Issue48QuotaIdentityFailureV1 } {
  if (input.repository !== ISSUE48_QUOTA_REPOSITORY) {
    return { ok: false, reason: "repository" };
  }
  if (input.ref !== "refs/heads/sentinel-supervisor") {
    return { ok: false, reason: "ref" };
  }
  if (input.job !== "maintenance") return { ok: false, reason: "job" };
  if (!isRunId(input.runId) || !isRunId(input.runAttempt)) {
    return { ok: false, reason: "run" };
  }
  if (input.workflowRef !== ISSUE48_QUOTA_WORKFLOW_REF) {
    return { ok: false, reason: "workflow_ref" };
  }
  if (
    input.sha === null || !GIT_SHA_PATTERN.test(input.sha) ||
    input.workflowSha !== input.sha
  ) {
    return { ok: false, reason: "sha" };
  }
  if (input.checkoutHead !== input.sha || !input.checkoutClean) {
    return { ok: false, reason: "checkout" };
  }
  return { ok: true };
}

function readEnv(key: string): string | null {
  try {
    return Deno.env.get(key) ?? null;
  } catch {
    return null;
  }
}

async function readCheckoutFacts(): Promise<
  { head: string | null; clean: boolean }
> {
  const env: Record<string, string> = {
    PATH: readEnv("PATH") ?? "/usr/bin:/bin",
    HOME: readEnv("HOME") ?? "/tmp",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  try {
    const cwd = Deno.cwd();
    const head = await new Deno.Command("git", {
      args: ["rev-parse", "HEAD"],
      cwd,
      clearEnv: true,
      env,
      stdout: "piped",
      stderr: "null",
    }).output();
    const headSha = head.success
      ? new TextDecoder().decode(head.stdout).trim()
      : "";
    const status = await new Deno.Command("git", {
      args: ["status", "--porcelain"],
      cwd,
      clearEnv: true,
      env,
      stdout: "piped",
      stderr: "null",
    }).output();
    return {
      head: GIT_SHA_PATTERN.test(headSha) ? headSha : null,
      clean: status.success &&
        new TextDecoder().decode(status.stdout).trim() === "",
    };
  } catch {
    return { head: null, clean: false };
  }
}

/**
 * True only for the two reasons that mean the one-shot itself could not run
 * safely. Every other typed reason — a drifted precondition, a moved head, a
 * non-terminal release, a lost CAS — is a bounded NO-OP of a one-shot that must
 * never make the unchanged supervisor look broken; the single JSON line is the
 * record of it.
 */
export function isHardRecoveryFailure(
  reason: Issue48QuotaRecoveryReasonV1,
): boolean {
  return reason === "identity_rejected" || reason === "unexpected_failure";
}

function report(result: Issue48QuotaRecoveryResultV1): number {
  console.log(JSON.stringify(result));
  return isHardRecoveryFailure(result.reason) ? 1 : 0;
}

/**
 * Hosted entry point. Verifies identity, then runs the one-shot. Exits nonzero
 * only on a real failure; a skip is a zero-write ordinary outcome.
 */
export async function runIssue48QuotaRecoveryMain(): Promise<number> {
  const facts = await readCheckoutFacts();
  const validated = validateIssue48QuotaHostedIdentity({
    repository: readEnv("GITHUB_REPOSITORY"),
    ref: readEnv("GITHUB_REF"),
    job: readEnv("GITHUB_JOB"),
    runId: readEnv("GITHUB_RUN_ID"),
    runAttempt: readEnv("GITHUB_RUN_ATTEMPT"),
    workflowRef: readEnv("GITHUB_WORKFLOW_REF"),
    sha: readEnv("GITHUB_SHA"),
    workflowSha: readEnv("GITHUB_WORKFLOW_SHA"),
    checkoutHead: facts.head,
    checkoutClean: facts.clean,
  });
  // Identity is rejected before any credential is read: an unauthenticated
  // process must never touch the token path.
  if (!validated.ok) return report(failed("identity_rejected"));
  const token = readEnv("GITHUB_TOKEN");
  if (token === null || token.length === 0) {
    return report(failed("identity_rejected"));
  }

  let result: Issue48QuotaRecoveryResultV1;
  try {
    const scratch = `${Deno.cwd()}/.issue48-quota-recovery`;
    Deno.mkdirSync(scratch, { recursive: true, mode: 0o700 });
    try {
      Deno.chmodSync(scratch, 0o700);
    } catch {
      // Best-effort hardening; the caller's umask still applies.
    }
    const runner = new DenoGitRunner(
      `${scratch}/git-home`,
      githubGitAuthEnv(token),
    );
    const state = createRepairStateStore({
      scratchDir: `${scratch}/state`,
      remoteUrl: ISSUE48_QUOTA_REMOTE_URL,
      runner,
    });
    result = await runIssue48QuotaRecovery({
      state,
      clock: { now: () => Date.now() },
      binding: ISSUE48_QUOTA_PRODUCTION_BINDING,
    });
  } catch {
    result = failed("unexpected_failure");
  }
  return report(result);
}

if (import.meta.main) {
  Deno.exitCode = await runIssue48QuotaRecoveryMain();
}
