/**
 * Bounded owner-authorized one-shot: record the operator-performed,
 * expected-head merge of PR 51 as the ONE repair-state release request the
 * runtime's own delivery step would have written.
 *
 * Why this exists (recorded in docs/build-status.md): the runtime's trusted
 * merge port refuses to merge while the `development` ruleset has no active
 * `pull_request` rule. The owner removed that rule on 2026-09-16, confirmed the
 * removal again on 2026-09-17 ("delete all the blocking rules ... just push"),
 * and no branch protection may be added back. The merge is therefore performed
 * by the operator under the runtime's OWN acceptance criteria — a completed
 * current-head review receipt bound to the exact PR/head/base with no
 * unresolved P0/P1 — and this one-shot writes the single release request, with
 * the identical deterministic id and field set the loop's `buildReleaseRequest`
 * produces, after re-verifying the merge and that receipt against GitHub.
 *
 * It writes nothing else: no review, receipt, proof, promotion or acceptance.
 * The trusted supervisor still owns prior/candidate proofs, promotion,
 * acceptance and rollback; the release controller still owns promotion.
 * Running it twice is a no-op, and every drifted precondition is a bounded
 * zero-write skip rather than a partial write.
 *
 * Runs only inside the protected `sentinel-supervisor` maintenance job at the
 * dispatched source commit, with the repository `github.token`.
 */
import type { PortResultV1 } from "../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import { parseRepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { ReleaseRequestV1 } from "../src/contracts/release.ts";
import { parseReleaseRequestV1 } from "../src/contracts/release.ts";
import type { ReviewReceiptV1 } from "../src/contracts/review-receipt.ts";
import type { GitSha, WorkItemId } from "../src/contracts/brands.ts";
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

/** Exact task this one-shot may complete delivery for. */
export const ISSUE48_DELIVERY_TARGET_ID =
  "issue-ubiquity-sentinel-48" as WorkItemId;

/** Exact reviewed pull request. */
export const ISSUE48_DELIVERY_PULL_REQUEST = 51;

/** Exact base branch the reviewed candidate must be integrated into. */
export const ISSUE48_DELIVERY_BASE_BRANCH = "development";

/** Exact trusted publication identity of the repaired pull request. */
export const ISSUE48_DELIVERY_TRUSTED_AUTHOR = "github-actions[bot]";

const API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_048_576;

export type Issue48DeliveryReasonV1 =
  | "applied"
  | "already_recorded"
  | "review_not_authorizing"
  | "merge_not_observed"
  | "target_missing"
  | "target_precondition_mismatch"
  | "release_not_terminal"
  | "clock_invalid"
  | "snapshot_invalid"
  | "write_conflict"
  | "write_ambiguous"
  | "write_unavailable"
  | "readback_unverified"
  | "identity_rejected"
  | "unexpected_failure";

export interface Issue48DeliveryResultV1 {
  kind: "issue48_delivery_observation";
  status: "applied" | "skipped" | "failed";
  reason: Issue48DeliveryReasonV1;
  beforeHead: string | null;
  appliedHead: string | null;
  revision: string | null;
  reviewReceiptId: string | null;
}

/** The observed remote merge facts this one-shot may not guess. */
export interface Issue48DeliveryMergeV1 {
  pullRequestNumber: number;
  state: string;
  merged: boolean;
  mergeCommitSha: string | null;
  headSha: string | null;
  baseRef: string | null;
  author: string | null;
  parents: readonly string[];
  revisionOnBaseBranch: boolean;
}

export interface Issue48DeliveryGitHubV1 {
  readMerge(): Promise<
    { ok: true; value: Issue48DeliveryMergeV1 } | { ok: false }
  >;
}

export interface Issue48DeliveryDepsV1 {
  state: StateReadView & RepairStateWriter;
  github: Issue48DeliveryGitHubV1;
  clock: { now(): number };
}

function skipped(
  reason: Issue48DeliveryReasonV1,
  beforeHead: string | null,
): Issue48DeliveryResultV1 {
  return {
    kind: "issue48_delivery_observation",
    status: "skipped",
    reason,
    beforeHead,
    appliedHead: null,
    revision: null,
    reviewReceiptId: null,
  };
}

function failed(
  reason: Issue48DeliveryReasonV1,
  beforeHead: string | null = null,
): Issue48DeliveryResultV1 {
  return { ...skipped(reason, beforeHead), status: "failed" };
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

/**
 * The exact completed receipt the runtime's own release authorization requires:
 * same reviewer identity, exact PR/head/base binding, a result and completion
 * instant, zero uncounted findings and no unresolved P0/P1. P2/P3 stay future
 * work exactly as the plan states.
 */
function authorizingReceipt(
  snapshot: RepairStateSnapshotV1,
  pullRequest: number,
  head: string,
  base: string,
): ReviewReceiptV1 | null {
  const found = snapshot.reviews.find((review) =>
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
export async function buildIssue48ReleaseRequest(
  repository: ReleaseRequestV1["target"]["repository"],
  revision: string,
  head: string,
  base: string,
  receipt: ReviewReceiptV1,
  now: number,
): Promise<ReleaseRequestV1 | null> {
  try {
    return parseReleaseRequestV1({
      version: "v1",
      kind: "release_request",
      id: await releaseRequestId(repository, revision as GitSha, 51),
      target: { repository, environment: "production" },
      revision,
      source: {
        pullRequest: 51,
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

/** One bounded, fully preconditioned repair-state transition. */
export async function runIssue48DeliveryObservation(
  deps: Issue48DeliveryDepsV1,
): Promise<Issue48DeliveryResultV1> {
  const repairRead = await readRepairSafely(deps.state);
  if (
    repairRead === null || !repairRead.ok ||
    repairRead.value.status !== "found"
  ) {
    return skipped("target_missing", null);
  }
  const snapshot = repairRead.value.snapshot;
  const observedHead = repairRead.value.head;
  const record = snapshot.work.find((work) =>
    work.id === ISSUE48_DELIVERY_TARGET_ID
  );
  if (record === undefined) return skipped("target_missing", observedHead);
  const head = record.target.head;
  const base = record.target.base;
  if (
    record.target.pr !== ISSUE48_DELIVERY_PULL_REQUEST ||
    head === null || base === null
  ) {
    return skipped("target_precondition_mismatch", observedHead);
  }

  const releaseRead = await readReleaseSafely(deps.state);
  if (
    releaseRead === null || !releaseRead.ok ||
    releaseRead.value.status !== "found"
  ) {
    return skipped("release_not_terminal", observedHead);
  }
  const releaseSnapshot = releaseRead.value.snapshot;
  if (
    releaseSnapshot.hostedReleases.some((release) =>
      release.phase !== "accepted" && release.phase !== "rolled_back"
    )
  ) {
    return skipped("release_not_terminal", observedHead);
  }

  const receipt = authorizingReceipt(
    snapshot,
    ISSUE48_DELIVERY_PULL_REQUEST,
    head,
    base,
  );
  if (receipt === null) {
    return skipped("review_not_authorizing", observedHead);
  }

  let merge;
  try {
    merge = await deps.github.readMerge();
  } catch {
    return skipped("merge_not_observed", observedHead);
  }
  if (!merge.ok) return skipped("merge_not_observed", observedHead);
  const observed = merge.value;
  if (
    observed.pullRequestNumber !== ISSUE48_DELIVERY_PULL_REQUEST ||
    observed.state !== "closed" || observed.merged !== true ||
    observed.headSha !== head ||
    observed.baseRef !== ISSUE48_DELIVERY_BASE_BRANCH ||
    observed.author !== ISSUE48_DELIVERY_TRUSTED_AUTHOR ||
    observed.mergeCommitSha === null ||
    observed.parents.length !== 2 ||
    !observed.parents.includes(base) || !observed.parents.includes(head) ||
    !observed.revisionOnBaseBranch
  ) {
    return skipped("merge_not_observed", observedHead);
  }
  const revision = observed.mergeCommitSha;

  // Idempotence: an already-recorded request for this exact delivery (or the
  // same deterministic id) is never duplicated.
  if (
    snapshot.releaseRequests.some((request) =>
      request.source.pullRequest === ISSUE48_DELIVERY_PULL_REQUEST &&
      request.source.head === head && request.source.base === base &&
      request.target.environment === "production"
    )
  ) {
    return skipped("already_recorded", observedHead);
  }

  const now = deps.clock.now();
  if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
    return skipped("clock_invalid", observedHead);
  }

  const request = await buildIssue48ReleaseRequest(
    record.repository,
    revision,
    head,
    base,
    receipt,
    now,
  );
  if (request === null) {
    return skipped("snapshot_invalid", observedHead);
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
    return skipped("snapshot_invalid", observedHead);
  }

  let write: PortResultV1<StateWriteResultV1> | null;
  try {
    write = await deps.state.writeRepair(next, observedHead as GitSha);
  } catch {
    return failed("write_unavailable", observedHead);
  }
  if (write === null || !write.ok) {
    return failed("write_unavailable", observedHead);
  }
  if (write.value.status === "conflict") {
    return skipped("write_conflict", observedHead);
  }
  if (write.value.status === "ambiguous") {
    return failed("write_ambiguous", observedHead);
  }
  const writtenHead = write.value.head;

  const readback = await readRepairSafely(deps.state);
  if (
    readback === null || !readback.ok ||
    readback.value.status !== "found" ||
    readback.value.head !== writtenHead ||
    canonicalStringify(readback.value.snapshot) !== canonicalStringify(next)
  ) {
    return failed("readback_unverified", observedHead);
  }

  return {
    kind: "issue48_delivery_observation",
    status: "applied",
    reason: "applied",
    beforeHead: observedHead,
    appliedHead: writtenHead,
    revision,
    reviewReceiptId: receipt.id,
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

/** Bounded, credential-free-enough GitHub reader for the three observed facts. */
export function createIssue48DeliveryGitHub(
  token: string,
): Issue48DeliveryGitHubV1 {
  async function get(path: string): Promise<unknown | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "sentinel-issue48-delivery-observation",
        },
        signal: controller.signal,
      });
      if (response.status !== 200) return null;
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) return null;
      return JSON.parse(text);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async readMerge() {
      const pull = await get(
        `/repos/${ISSUE48_QUOTA_REPOSITORY}/pulls/${ISSUE48_DELIVERY_PULL_REQUEST}`,
      );
      if (pull === null || typeof pull !== "object") return { ok: false };
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
        return { ok: false };
      }
      const commit = await get(
        `/repos/${ISSUE48_QUOTA_REPOSITORY}/commits/${mergeCommitSha}`,
      );
      const parents = commit !== null && typeof commit === "object"
        ? ((commit as Record<string, unknown>)["parents"] as unknown[])
        : null;
      if (!Array.isArray(parents)) return { ok: false };
      const parentShas = parents.map((parent) =>
        typeof parent === "object" && parent !== null
          ? String((parent as Record<string, unknown>)["sha"] ?? "")
          : ""
      );
      const compare = await get(
        `/repos/${ISSUE48_QUOTA_REPOSITORY}/compare/${mergeCommitSha}...${ISSUE48_DELIVERY_BASE_BRANCH}`,
      );
      // The runtime's own verifier reads `compare/{revision}...development`:
      // development is AHEAD of an integrated revision, and the compare base
      // commit must be that exact revision. "behind"/"diverged" is never
      // integration.
      const integrated = revisionIntegratedIntoBase(compare, mergeCommitSha);
      return {
        ok: true,
        value: {
          pullRequestNumber: Number(obj["number"]),
          state: String(obj["state"] ?? ""),
          merged: obj["merged"] === true,
          mergeCommitSha,
          headSha,
          baseRef,
          author: typeof user?.["login"] === "string"
            ? String(user["login"])
            : null,
          parents: parentShas,
          revisionOnBaseBranch: integrated,
        },
      };
    },
  };
}

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Hosted entry point: identity first, then the bounded one-shot. */
export async function runIssue48DeliveryObservationMain(): Promise<number> {
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
  if (!validated.ok) return report(failed("identity_rejected"));
  const token = readEnv("GITHUB_TOKEN");
  if (token === null || token.length === 0) {
    return report(failed("identity_rejected"));
  }
  let result: Issue48DeliveryResultV1;
  try {
    const scratch = `${Deno.cwd()}/.issue48-delivery-observation`;
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
    result = await runIssue48DeliveryObservation({
      state,
      github: createIssue48DeliveryGitHub(token),
      clock: { now: () => Date.now() },
    });
  } catch {
    result = failed("unexpected_failure");
  }
  return report(result);
}

/** The two reasons that mean the one-shot itself could not run safely. */
export function isHardDeliveryFailure(
  reason: Issue48DeliveryReasonV1,
): boolean {
  return reason === "identity_rejected" || reason === "unexpected_failure";
}

function report(result: Issue48DeliveryResultV1): number {
  console.log(JSON.stringify(result));
  return isHardDeliveryFailure(result.reason) ? 1 : 0;
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
  Deno.exitCode = await runIssue48DeliveryObservationMain();
}
