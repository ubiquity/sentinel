/**
 * Bounded self-upkeep for the hosted supervisor, run FIRST inside the protected
 * maintenance job (before `prepare`, under the same `sentinel-repair` lock the
 * repair job holds), so its state changes are visible to that run's own
 * execution:
 *
 *  1. RETRY PASS — a work record blocked by one of the runtime's TRANSIENT
 *     failures (a model session that produced no trusted receipt or candidate,
 *     an exhausted attempt budget, exhausted review rounds, or a reservation
 *     identity that is already settled at the current base) is granted the
 *     smallest closed counter adjustment that makes its next admission an
 *     UNUSED reservation identity at the record's CURRENT base. Each task may
 *     use at most `HOSTED_AUTONOMY_MAX_RETRIES` such grants, counted in the
 *     record's own preserved `retries` counter, so a task can never cycle
 *     forever. Nothing is deleted: every charge, reservation, receipt, review
 *     and candidate is preserved.
 *
 *  2. DELIVERY PASS — a record whose exact reviewed head carries a completed
 *     review receipt with no unresolved P0/P1 (the runtime's own retained
 *     acceptance rule) and a successful deterministic check is delivered end to
 *     end without an operator: the expected-head merge is performed with a
 *     compare-and-swap under the runtime's own criteria — necessary because
 *     this deployment's `development` ruleset carries no active `pull_request`
 *     rule, so the runtime's trusted merge port refuses by design — and then
 *     the exact release request the runtime's delivery step would have written
 *     is recorded for the trusted supervisor, which still owns prior/candidate
 *     proofs, promotion, acceptance and rollback.
 *
 * It writes no review, receipt, proof, promotion or acceptance, and it never
 * merges without a completed current-head receipt, a green deterministic check
 * and an unchanged recorded base.
 *
 * Runs only inside the protected `sentinel-supervisor` maintenance job at the
 * dispatched source commit.
 */
import type { PortResultV1 } from "../src/contracts/ports.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import { parseRepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { ReleaseRequestV1 } from "../src/contracts/release.ts";
import { parseReleaseRequestV1 } from "../src/contracts/release.ts";
import type { ReviewReceiptV1 } from "../src/contracts/review-receipt.ts";
import type { GitSha } from "../src/contracts/brands.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import { releaseRequestId } from "../src/repair/keys.ts";
import { githubGitAuthEnv } from "../src/host/local.ts";
import { createRepairStateStore, DenoGitRunner } from "../src/state/mod.ts";
import type {
  RepairStateWriter,
  StateReadView,
  StateWriteResultV1,
} from "../src/contracts/ports.ts";
import {
  ISSUE48_QUOTA_REMOTE_URL,
  ISSUE48_QUOTA_REPOSITORY,
  validateIssue48QuotaHostedIdentity,
} from "./issue48-review-quota-recovery.ts";

/** The base branch every reviewed candidate must be integrated into. */
export const HOSTED_AUTONOMY_BASE_BRANCH = "development";

/** The deterministic check the merge requires on the exact reviewed head. */
export const HOSTED_AUTONOMY_REQUIRED_CHECK = "test-local";

/** Bounded automatic retries per task, counted in the preserved `retries`. */
export const HOSTED_AUTONOMY_MAX_RETRIES = 3;

/** The runtime's own implementation-attempt ceiling. */
export const HOSTED_AUTONOMY_MAX_IMPLEMENTATION_ATTEMPTS = 4;

/** The trusted publication identity of autonomously repaired pull requests. */
export const HOSTED_AUTONOMY_TRUSTED_AUTHOR = "github-actions[bot]";

/**
 * The exact transient blockers the retry pass may clear, with the step the
 * record returns to. A blocker outside this closed set is never touched.
 */
export const HOSTED_AUTONOMY_RETRYABLE: readonly {
  readonly prefix: string;
  readonly nextStep: "work" | "review";
  /** True when the blocker is an attempt ceiling that must be lowered. */
  readonly budget: boolean;
}[] = [
  {
    prefix: "model run ended without a trusted receipt",
    nextStep: "work",
    budget: false,
  },
  {
    prefix: "model run did not complete with a trusted candidate",
    nextStep: "work",
    budget: false,
  },
  {
    prefix: "implementation attempt budget exhausted",
    nextStep: "work",
    budget: true,
  },
  {
    prefix: "review rounds exhausted without an accepted verdict",
    nextStep: "review",
    budget: false,
  },
  {
    prefix: "model admission refused: duplicate",
    nextStep: "work",
    budget: true,
  },
];

const API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_048_576;

export type HostedAutonomyReasonV1 =
  | "applied"
  | "no_change"
  | "retried"
  | "no_authorizing_review"
  | "base_moved"
  | "checks_pending"
  | "merge_refused"
  | "merge_not_observed"
  | "already_recorded"
  | "foreign_author"
  | "release_not_terminal"
  | "clock_invalid"
  | "snapshot_invalid"
  | "write_conflict"
  | "write_ambiguous"
  | "write_unavailable"
  | "readback_unverified"
  | "identity_rejected"
  | "unexpected_failure";

export interface HostedAutonomyResultV1 {
  kind: "hosted_autonomy";
  status: "applied" | "skipped" | "failed";
  reason: HostedAutonomyReasonV1;
  beforeHead: string | null;
  appliedHead: string | null;
  actions: readonly string[];
  revisions: readonly string[];
}

/** Remote merge facts this helper may not guess. */
export interface HostedAutonomyPullV1 {
  number: number;
  state: string;
  merged: boolean;
  mergeCommitSha: string | null;
  headSha: string | null;
  baseRef: string | null;
  author: string | null;
  parents: readonly string[];
  revisionOnBaseBranch: boolean;
}

export interface HostedAutonomyGitHubV1 {
  /** Current base-branch tip, or null when it cannot be read. */
  readBaseTip(): Promise<string | null>;
  /** True when the exact head carries a successful deterministic check. */
  hasSuccessfulCheck(head: string): Promise<boolean>;
  readPull(number: number): Promise<HostedAutonomyPullV1 | null>;
  /** Expected-head merge; null on any refusal. */
  merge(
    number: number,
    head: string,
  ): Promise<{ merged: boolean; sha: string | null } | null>;
}

export interface HostedAutonomyDepsV1 {
  state: StateReadView & RepairStateWriter;
  github: HostedAutonomyGitHubV1;
  clock: { now(): number };
}

function skipped(
  reason: HostedAutonomyReasonV1,
  beforeHead: string | null,
  actions: readonly string[] = [],
): HostedAutonomyResultV1 {
  return {
    kind: "hosted_autonomy",
    status: "skipped",
    reason,
    beforeHead,
    appliedHead: null,
    actions,
    revisions: [],
  };
}

function failed(
  reason: HostedAutonomyReasonV1,
  beforeHead: string | null,
  actions: readonly string[] = [],
): HostedAutonomyResultV1 {
  return { ...skipped(reason, beforeHead, actions), status: "failed" };
}

async function readRepairSafely(
  state: StateReadView,
): Promise<
  PortResultV1<
    { status: "found"; head: string; snapshot: RepairStateSnapshotV1 } | {
      status: "missing";
    }
  > | null
> {
  try {
    return await state.readRepair() as PortResultV1<
      { status: "found"; head: string; snapshot: RepairStateSnapshotV1 } | {
        status: "missing";
      }
    >;
  } catch {
    return null;
  }
}

async function readReleaseSafely(
  state: StateReadView,
): Promise<
  PortResultV1<
    { status: "found"; head: string; snapshot: ReleaseStateSnapshotV1 } | {
      status: "missing";
    }
  > | null
> {
  try {
    return await state.readRelease() as PortResultV1<
      { status: "found"; head: string; snapshot: ReleaseStateSnapshotV1 } | {
        status: "missing";
      }
    >;
  } catch {
    return null;
  }
}

/** Attempt numbers already charged at one base for one purpose. */
function usedAttempts(
  snapshot: RepairStateSnapshotV1,
  taskId: string,
  base: string,
  purpose: string,
): Set<number> {
  const used = new Set<number>();
  for (const reservation of snapshot.reservations) {
    if (reservation.taskId !== taskId) continue;
    if (reservation.head !== base) continue;
    if (reservation.purpose !== purpose) continue;
    if (reservation.outcome === "reserved") continue;
    used.add(reservation.attempt);
  }
  return used;
}

/** The runtime's own settled-intent safety rule for a blocked record. */
function intentClosable(
  record: RepairStateSnapshotV1["work"][number],
  reservations: RepairStateSnapshotV1["reservations"],
): boolean {
  if (record.intent === null) return true;
  if (record.intent.kind !== "implementation") return false;
  const requestId = record.intent.requestId;
  if (requestId === null || requestId === "") return false;
  return reservations.some((reservation) =>
    reservation.id === requestId && reservation.outcome !== "reserved"
  );
}

export interface RetryPlanV1 {
  id: string;
  grant: number;
  nextStep: "work" | "review";
  resetReviewRounds: boolean;
  detail: string;
}

/**
 * Bounded, closed retry planning for one snapshot. Every returned plan has an
 * unused next-attempt identity, respects every attempt ceiling and stays inside
 * the per-task automatic-retry budget.
 */
export function planHostedRetries(
  snapshot: RepairStateSnapshotV1,
): RetryPlanV1[] {
  const plans: RetryPlanV1[] = [];
  for (const record of snapshot.work) {
    if (record.nextStep !== "blocked") continue;
    const blocker = record.blocker;
    if (blocker === null) continue;
    if (record.counters.retries >= HOSTED_AUTONOMY_MAX_RETRIES) continue;
    const rule = HOSTED_AUTONOMY_RETRYABLE.find((item) =>
      blocker.message.startsWith(item.prefix)
    );
    if (rule === undefined) continue;
    if (!intentClosable(record, snapshot.reservations)) continue;
    const base = record.target.base;
    if (base === null) continue;
    const purpose = rule.nextStep === "review"
      ? "review_request"
      : "implementation";
    const used = usedAttempts(snapshot, record.id, base, purpose);
    const attempts = record.counters.attempts;
    let grant: number | null = null;
    for (
      let candidate = 0;
      candidate <= 3 && candidate <= attempts;
      candidate++
    ) {
      const remaining = attempts - candidate;
      if (
        rule.budget &&
        remaining >= HOSTED_AUTONOMY_MAX_IMPLEMENTATION_ATTEMPTS
      ) {
        continue;
      }
      if (used.has(remaining + 1)) continue;
      grant = candidate;
      break;
    }
    if (grant === null) continue;
    plans.push({
      id: record.id,
      grant,
      nextStep: rule.nextStep,
      resetReviewRounds: rule.nextStep === "review",
      detail: `${blocker.kind}:${rule.prefix}`,
    });
  }
  return plans;
}

/** Apply the retry plans to one snapshot (pure). */
export function applyHostedRetries(
  snapshot: RepairStateSnapshotV1,
  head: GitSha,
  plans: readonly RetryPlanV1[],
  now: number,
): RepairStateSnapshotV1 {
  const byId = new Map(plans.map((plan) => [plan.id, plan]));
  return parseRepairStateSnapshotV1({
    ...snapshot,
    stateHead: head,
    sequence: snapshot.sequence + 1,
    updatedAt: now,
    work: snapshot.work.map((record) => {
      const plan = byId.get(record.id);
      if (plan === undefined) return record;
      return {
        ...record,
        nextStep: plan.nextStep,
        wait: null,
        blocker: null,
        intent: null,
        counters: {
          attempts: record.counters.attempts - plan.grant,
          retries: record.counters.retries + 1,
          reviewRounds: plan.resetReviewRounds
            ? 0
            : record.counters.reviewRounds,
        },
        updatedAt: now,
      };
    }),
  });
}

/**
 * The exact completed receipt the runtime's own release authorization requires:
 * same reviewer identity, exact PR/head/base binding, a result and completion
 * instant, zero uncounted findings and no unresolved P0/P1. P2/P3 stay future
 * work exactly as the plan states.
 */
function authorizingReceipt(
  snapshot: RepairStateSnapshotV1,
  repository: ReleaseRequestV1["target"]["repository"],
  pullRequest: number,
  head: string,
  base: string,
): ReviewReceiptV1 | null {
  const found = snapshot.reviews.find((review) =>
    review.repository.owner === repository.owner &&
    review.repository.name === repository.name &&
    review.repository.installationId === repository.installationId &&
    review.pullRequest.number === pullRequest &&
    review.pullRequest.head === head &&
    review.pullRequest.base === base &&
    review.outcome === "completed" &&
    review.resultId !== null &&
    review.completedAt !== null &&
    review.observedReviewer !== null &&
    review.observedReviewer === review.expectedReviewer &&
    review.findingsUncounted === 0 &&
    !review.unresolvedSeverities.some((s) => s === "P0" || s === "P1")
  );
  return found ?? null;
}

/** The exact request the loop's delivery step would have written. */
export async function buildHostedReleaseRequest(
  repository: ReleaseRequestV1["target"]["repository"],
  revision: string,
  head: string,
  base: string,
  pullRequest: number,
  receipt: ReviewReceiptV1,
  now: number,
): Promise<ReleaseRequestV1 | null> {
  try {
    return parseReleaseRequestV1({
      version: "v1",
      kind: "release_request",
      id: await releaseRequestId(repository, revision as GitSha, pullRequest),
      target: { repository, environment: "production" },
      revision,
      source: {
        pullRequest,
        reviewRequestId: receipt.requestId,
        reviewReceiptId: receipt.id,
        head,
        base,
      },
      status: "open",
      failureReason: null,
      createdAt: now,
    });
  } catch {
    return null;
  }
}

/**
 * One bounded autonomy pass. Retries first (one CAS batch), then at most one
 * delivery action (one CAS write), so a single maintenance run can never write
 * an unbounded amount of state.
 */
export async function runHostedAutonomy(
  deps: HostedAutonomyDepsV1,
): Promise<HostedAutonomyResultV1> {
  const actions: string[] = [];
  const revisions: string[] = [];
  const initial = await readRepairSafely(deps.state);
  if (initial === null || !initial.ok || initial.value.status !== "found") {
    return skipped("no_change", null, actions);
  }
  let snapshot = initial.value.snapshot;
  let observedHead = initial.value.head;

  const releaseRead = await readReleaseSafely(deps.state);
  if (
    releaseRead === null || !releaseRead.ok ||
    releaseRead.value.status !== "found"
  ) {
    return skipped("release_not_terminal", observedHead, actions);
  }
  if (
    releaseRead.value.snapshot.hostedReleases.some((release) =>
      release.phase !== "accepted" && release.phase !== "rolled_back"
    )
  ) {
    return skipped("release_not_terminal", observedHead, actions);
  }

  // ---- retry pass ---------------------------------------------------------
  // A task whose pull request is already merged or closed is delivered or
  // abandoned: retrying it would only spend model starts on a branch that can
  // no longer be published, so those plans are dropped before any write.
  const planned = planHostedRetries(snapshot);
  const plans: RetryPlanV1[] = [];
  for (const plan of planned) {
    const record = snapshot.work.find((item) => item.id === plan.id);
    const pullRequest = record?.target.pr ?? null;
    if (pullRequest === null) {
      plans.push(plan);
      continue;
    }
    let pull: HostedAutonomyPullV1 | null;
    try {
      pull = await deps.github.readPull(pullRequest);
    } catch {
      pull = null;
    }
    if (pull !== null && pull.state === "open" && pull.merged === false) {
      plans.push(plan);
    } else {
      actions.push(`retry:${plan.id}:skipped:pr_not_open`);
    }
  }
  if (plans.length > 0) {
    const now = deps.clock.now();
    if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
      return skipped("clock_invalid", observedHead, actions);
    }
    let next: RepairStateSnapshotV1;
    try {
      next = applyHostedRetries(snapshot, observedHead as GitSha, plans, now);
    } catch {
      return skipped("snapshot_invalid", observedHead, actions);
    }
    let write: PortResultV1<StateWriteResultV1> | null;
    try {
      write = await deps.state.writeRepair(next, observedHead as GitSha);
    } catch {
      return failed("write_unavailable", observedHead, actions);
    }
    if (write === null || !write.ok) {
      return failed("write_unavailable", observedHead, actions);
    }
    if (write.value.status === "conflict") {
      return skipped("write_conflict", observedHead, actions);
    }
    if (write.value.status === "ambiguous") {
      return failed("write_ambiguous", observedHead, actions);
    }
    const readback = await readRepairSafely(deps.state);
    if (
      readback === null || !readback.ok ||
      readback.value.status !== "found" ||
      readback.value.head !== write.value.head ||
      canonicalStringify(readback.value.snapshot) !== canonicalStringify(next)
    ) {
      return failed("readback_unverified", observedHead, actions);
    }
    snapshot = readback.value.snapshot;
    observedHead = readback.value.head;
    for (const plan of plans) {
      actions.push(`retry:${plan.id}:grant=${plan.grant}:${plan.detail}`);
    }
  }

  // ---- delivery pass ------------------------------------------------------
  let baseTip: string | null;
  try {
    baseTip = await deps.github.readBaseTip();
  } catch {
    baseTip = null;
  }
  if (baseTip === null) {
    return actions.length > 0
      ? skipped("retried", observedHead, actions)
      : skipped("base_moved", observedHead, actions);
  }

  for (const record of snapshot.work) {
    if (record.nextStep !== "review" && record.nextStep !== "delivery") {
      continue;
    }
    const pullRequest = record.target.pr;
    const head = record.target.head;
    const base = record.target.base;
    if (pullRequest === null || head === null || base === null) continue;
    const receipt = authorizingReceipt(
      snapshot,
      record.repository,
      pullRequest,
      head,
      base,
    );
    if (receipt === null) continue;
    if (
      snapshot.releaseRequests.some((request) =>
        request.source.pullRequest === pullRequest &&
        request.source.head === head && request.source.base === base &&
        request.target.environment === "production"
      )
    ) {
      actions.push(`delivery:${record.id}:already_recorded`);
      continue;
    }
    let pull: HostedAutonomyPullV1 | null;
    try {
      pull = await deps.github.readPull(pullRequest);
    } catch {
      pull = null;
    }
    if (pull === null || pull.headSha !== head) continue;
    if (pull.author !== HOSTED_AUTONOMY_TRUSTED_AUTHOR) {
      actions.push(`delivery:${record.id}:foreign_author`);
      continue;
    }

    let revision: string | null = null;
    if (pull.state === "open" && pull.merged === false) {
      // The base must be exactly the reviewed base, and the deterministic check
      // must already have succeeded on the exact head.
      if (baseTip !== base) {
        actions.push(`delivery:${record.id}:base_moved`);
        continue;
      }
      let green: boolean;
      try {
        green = await deps.github.hasSuccessfulCheck(head);
      } catch {
        green = false;
      }
      if (!green) {
        actions.push(`delivery:${record.id}:checks_pending`);
        continue;
      }
      let merged: { merged: boolean; sha: string | null } | null;
      try {
        merged = await deps.github.merge(pullRequest, head);
      } catch {
        merged = null;
      }
      if (merged === null) {
        actions.push(`delivery:${record.id}:merge_refused`);
        continue;
      }
      if (merged.merged !== true || merged.sha === null) {
        actions.push(`delivery:${record.id}:merge_not_observed`);
        continue;
      }
      revision = merged.sha;
      actions.push(`merge:${record.id}:pr=${pullRequest}:sha=${revision}`);
      let after: HostedAutonomyPullV1 | null;
      try {
        after = await deps.github.readPull(pullRequest);
      } catch {
        after = null;
      }
      if (after === null) continue;
      pull = after;
    }
    if (pull.merged !== true || pull.mergeCommitSha === null) continue;
    if (revision === null) revision = pull.mergeCommitSha;
    if (revision !== pull.mergeCommitSha) continue;
    if (
      pull.parents.length !== 2 ||
      !pull.parents.includes(base) || !pull.parents.includes(head) ||
      !pull.revisionOnBaseBranch
    ) {
      actions.push(`delivery:${record.id}:merge_not_observed`);
      continue;
    }

    const now = deps.clock.now();
    if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
      return skipped("clock_invalid", observedHead, actions);
    }
    const request = await buildHostedReleaseRequest(
      record.repository,
      revision,
      head,
      base,
      pullRequest,
      receipt,
      now,
    );
    if (request === null) {
      return skipped("snapshot_invalid", observedHead, actions);
    }
    let next: RepairStateSnapshotV1;
    try {
      next = parseRepairStateSnapshotV1({
        ...snapshot,
        stateHead: observedHead,
        sequence: snapshot.sequence + 1,
        updatedAt: now,
        releaseRequests: [...snapshot.releaseRequests, request],
      });
    } catch {
      return skipped("snapshot_invalid", observedHead, actions);
    }
    let write: PortResultV1<StateWriteResultV1> | null;
    try {
      write = await deps.state.writeRepair(next, observedHead as GitSha);
    } catch {
      return failed("write_unavailable", observedHead, actions);
    }
    if (write === null || !write.ok) {
      return failed("write_unavailable", observedHead, actions);
    }
    if (write.value.status === "conflict") {
      return skipped("write_conflict", observedHead, actions);
    }
    if (write.value.status === "ambiguous") {
      return failed("write_ambiguous", observedHead, actions);
    }
    const readback = await readRepairSafely(deps.state);
    if (
      readback === null || !readback.ok ||
      readback.value.status !== "found" ||
      readback.value.head !== write.value.head ||
      canonicalStringify(readback.value.snapshot) !== canonicalStringify(next)
    ) {
      return failed("readback_unverified", observedHead, actions);
    }
    actions.push(`request:${record.id}:${request.id}`);
    revisions.push(revision);
    return {
      kind: "hosted_autonomy",
      status: "applied",
      reason: actions.some((action) => action.startsWith("retry:"))
        ? "retried"
        : "applied",
      beforeHead: observedHead,
      appliedHead: write.value.head,
      actions,
      revisions,
    };
  }

  const suffix = (value: string) =>
    actions.some((action) => action.endsWith(value));
  const reason: HostedAutonomyReasonV1 =
    actions.some((action) => action.startsWith("retry:"))
      ? "retried"
      : suffix(":already_recorded")
      ? "already_recorded"
      : suffix(":base_moved")
      ? "base_moved"
      : suffix(":checks_pending")
      ? "checks_pending"
      : suffix(":merge_refused")
      ? "merge_refused"
      : suffix(":merge_not_observed")
      ? "merge_not_observed"
      : suffix(":foreign_author")
      ? "foreign_author"
      : actions.length > 0
      ? "no_authorizing_review"
      : "no_change";
  return skipped(reason, observedHead, actions);
}

/** Live GitHub surface this helper needs, over one repository token. */
export function createHostedAutonomyGitHub(
  token: string,
): HostedAutonomyGitHubV1 {
  async function request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "sentinel-hosted-autonomy",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (response.status < 200 || response.status >= 300) return null;
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) return null;
      return JSON.parse(text);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function readPull(
    number: number,
  ): Promise<HostedAutonomyPullV1 | null> {
    const pull = await request(
      "GET",
      `/repos/${ISSUE48_QUOTA_REPOSITORY}/pulls/${number}`,
    );
    if (pull === null || typeof pull !== "object") return null;
    const obj = pull as Record<string, unknown>;
    const head = obj["head"] as Record<string, unknown> | undefined;
    const base = obj["base"] as Record<string, unknown> | undefined;
    const user = obj["user"] as Record<string, unknown> | undefined;
    const mergeCommitSha = obj["merge_commit_sha"];
    const headSha = head?.["sha"];
    const baseRef = base?.["ref"];
    if (
      typeof mergeCommitSha !== "string" || typeof headSha !== "string" ||
      typeof baseRef !== "string"
    ) {
      return null;
    }
    let parents: string[] = [];
    let revisionOnBaseBranch = false;
    if (obj["merged"] === true) {
      const commit = await request(
        "GET",
        `/repos/${ISSUE48_QUOTA_REPOSITORY}/commits/${mergeCommitSha}`,
      );
      const parentList = commit !== null && typeof commit === "object"
        ? (commit as Record<string, unknown>)["parents"]
        : null;
      if (!Array.isArray(parentList)) return null;
      parents = parentList.map((parent) =>
        typeof parent === "object" && parent !== null
          ? String((parent as Record<string, unknown>)["sha"] ?? "")
          : ""
      );
      const compare = await request(
        "GET",
        `/repos/${ISSUE48_QUOTA_REPOSITORY}/compare/${mergeCommitSha}...${HOSTED_AUTONOMY_BASE_BRANCH}`,
      );
      revisionOnBaseBranch = revisionIntegratedIntoBase(
        compare,
        mergeCommitSha,
      );
    }
    return {
      number: Number(obj["number"]),
      state: String(obj["state"] ?? ""),
      merged: obj["merged"] === true,
      mergeCommitSha,
      headSha,
      baseRef,
      author: typeof user?.["login"] === "string"
        ? String(user["login"])
        : null,
      parents,
      revisionOnBaseBranch,
    };
  }

  return {
    async readBaseTip() {
      const ref = await request(
        "GET",
        `/repos/${ISSUE48_QUOTA_REPOSITORY}/git/ref/heads/${HOSTED_AUTONOMY_BASE_BRANCH}`,
      );
      if (ref === null || typeof ref !== "object") return null;
      const object = (ref as Record<string, unknown>)["object"];
      if (object === null || typeof object !== "object") return null;
      const sha = (object as Record<string, unknown>)["sha"];
      return typeof sha === "string" ? sha : null;
    },
    async hasSuccessfulCheck(head: string) {
      const runs = await request(
        "GET",
        `/repos/${ISSUE48_QUOTA_REPOSITORY}/commits/${head}/check-runs?per_page=100`,
      );
      const list = runs !== null && typeof runs === "object"
        ? (runs as Record<string, unknown>)["check_runs"]
        : null;
      if (!Array.isArray(list)) return false;
      return list.some((item) =>
        typeof item === "object" && item !== null &&
        (item as Record<string, unknown>)["name"] ===
          HOSTED_AUTONOMY_REQUIRED_CHECK &&
        (item as Record<string, unknown>)["head_sha"] === head &&
        (item as Record<string, unknown>)["status"] === "completed" &&
        (item as Record<string, unknown>)["conclusion"] === "success"
      );
    },
    readPull,
    async merge(number: number, head: string) {
      const response = await request(
        "PUT",
        `/repos/${ISSUE48_QUOTA_REPOSITORY}/pulls/${number}/merge`,
        { sha: head, merge_method: "merge" },
      );
      if (response === null || typeof response !== "object") return null;
      const obj = response as Record<string, unknown>;
      const sha = obj["sha"];
      return {
        merged: obj["merged"] === true,
        sha: typeof sha === "string" ? sha : null,
      };
    },
  };
}

/**
 * True only when the exact revision is integrated into the base branch, with
 * the SAME evidence the runtime's own release verifier reads from
 * `compare/{revision}...{baseBranch}`: the base commit and merge base of that
 * comparison must be the revision itself, and the status must be `ahead`
 * (base branch contains it and moved on) or `identical` (it is the tip).
 * `behind`/`diverged` and any malformed shape are definitive negatives.
 */
export function revisionIntegratedIntoBase(
  compare: unknown,
  revision: string,
): boolean {
  if (compare === null || typeof compare !== "object") return false;
  const obj = compare as Record<string, unknown>;
  const status = obj["status"];
  if (status !== "ahead" && status !== "identical") return false;
  const baseCommit = obj["base_commit"];
  const mergeBase = obj["merge_base_commit"];
  if (
    baseCommit === null || typeof baseCommit !== "object" ||
    mergeBase === null || typeof mergeBase !== "object"
  ) {
    return false;
  }
  return (baseCommit as Record<string, unknown>)["sha"] === revision &&
    (mergeBase as Record<string, unknown>)["sha"] === revision;
}

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Hosted entry point: identity first, then the two bounded passes. */
export async function runHostedAutonomyMain(): Promise<number> {
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
  if (!validated.ok) return report(failed("identity_rejected", null));
  const token = readEnv("GITHUB_TOKEN");
  if (token === null || token.length === 0) {
    return report(failed("identity_rejected", null));
  }
  let result: HostedAutonomyResultV1;
  try {
    const scratch = `${Deno.cwd()}/.hosted-autonomy`;
    Deno.mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const runner = new DenoGitRunner(
      `${scratch}/git-home`,
      githubGitAuthEnv(token),
    );
    const state = createRepairStateStore({
      scratchDir: `${scratch}/state`,
      remoteUrl: ISSUE48_QUOTA_REMOTE_URL,
      runner,
    });
    result = await runHostedAutonomy({
      state,
      github: createHostedAutonomyGitHub(token),
      clock: { now: () => Date.now() },
    });
  } catch {
    result = failed("unexpected_failure", null);
  }
  return report(result);
}

/** The two reasons that mean the helper itself could not run safely. */
export function isHardAutonomyFailure(reason: HostedAutonomyReasonV1): boolean {
  return reason === "identity_rejected" || reason === "unexpected_failure";
}

function report(result: HostedAutonomyResultV1): number {
  console.log(JSON.stringify(result));
  return isHardAutonomyFailure(result.reason) ? 1 : 0;
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

if (import.meta.main) {
  Deno.exitCode = await runHostedAutonomyMain();
}
