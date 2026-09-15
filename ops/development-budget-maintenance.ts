/**
 * Fixed-input development-budget PR54 maintenance entrypoint (native Actions).
 *
 * One bounded operation for the exact reviewed PR54 identity, moved inside the
 * existing `sentinel-repair` native concurrency group so it drains through the
 * same serialized slot as the supervisor. It is NOT a generalized operator
 * framework and NOT a production interface: every identity is a fixed literal,
 * there are no arguments, no new environment inputs and no new capability.
 *
 * The entrypoint runs only as the native `maintenance` job of
 * `.github/workflows/supervisor.yml` at `refs/heads/sentinel-supervisor`, with
 * an exact launcher SHA and clean checkouts, and validates that identity before
 * any credential, state or model operation. The immutable candidate source is
 * imported from `.sentinel-policy-source` (checked out at the reviewed head) so
 * the fixed operator always runs the exact frozen ports.
 *
 * Behavior:
 *  - a saved non-null runtime execution defers without writes or model so the
 *    supervisor's prepare step can reconcile it;
 *  - an accepted fixed release reports already-installed with exact
 *    request/receipt/revision proof and never requests another review;
 *  - an open PR54 reserves through the real rolling budget and submits exactly
 *    one real review, then appends the derived receipt with expected-head CAS;
 *  - a duplicate reservation in a fresh runner only reconciles the durable
 *    reservation and the remote review journal (never a resubmission);
 *  - a merged PR54 re-proves the published review and appends the exact
 *    ReleaseRequestV1 to repair state only.
 *
 * Credentials are read at live execution only (the existing GITHUB_TOKEN and
 * UOS_AI_TOKEN); values are never printed, persisted or forwarded to logs, and
 * failures are static and sanitized.
 */

import { isGitSha } from "../.sentinel-policy-source/src/contracts/brands.ts";
import type { GitSha } from "../.sentinel-policy-source/src/contracts/brands.ts";
import {
  portOk,
  SystemClock,
} from "../.sentinel-policy-source/src/contracts/ports.ts";
import type {
  Clock,
  GitHubPullRequestV1,
  PortResultV1,
  RepairStateWriter,
  ReviewDrainReportV1,
  ReviewDrainRequestV1,
  ReviewObservationRequestV1,
  ReviewObservationV1,
  ReviewRequestOutcomeV1,
  ReviewSubmissionV1,
  StateReadView,
} from "../.sentinel-policy-source/src/contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../.sentinel-policy-source/src/contracts/shared.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../.sentinel-policy-source/src/contracts/state-snapshots.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../.sentinel-policy-source/src/contracts/state-snapshots.ts";
import type { ReviewReceiptV1 } from "../.sentinel-policy-source/src/contracts/review-receipt.ts";
import { parseReleaseRequestV1 } from "../.sentinel-policy-source/src/contracts/release.ts";
import type { ReleaseRequestV1 } from "../.sentinel-policy-source/src/contracts/release.ts";
import { canonicalStringify } from "../.sentinel-policy-source/src/contracts/canonical.ts";
import {
  HOSTED_RUNTIME_ID,
} from "../.sentinel-policy-source/src/contracts/hosted-supervisor.ts";
import { RollingStartBudget } from "../.sentinel-policy-source/src/budget/mod.ts";
import { HostedRepairCooldownGate } from "../.sentinel-policy-source/src/host/hosted-cooldown.ts";
import {
  HOSTED_RUNTIME_WORKFLOW_REF,
  readCleanGitHead,
} from "../.sentinel-policy-source/src/host/hosted-runtime.ts";
import { ACTIONS_UOS_BASE_URL } from "../.sentinel-policy-source/src/host/actions.ts";
import {
  composeLocalGitHub,
  createLocalRepositoryConfig,
  ensurePrivateDir,
  ensureReviewClient,
  githubGitAuthEnv,
  joinPath,
  LocalSessionTracker,
} from "../.sentinel-policy-source/src/host/local.ts";
import {
  createRepairStateStore,
  DenoGitRunner,
} from "../.sentinel-policy-source/src/state/mod.ts";
import { REVIEW_TRANSPORT_TOTAL_MS } from "../.sentinel-policy-source/src/github/codex-review-transport.ts";
import { fetchHttpTransport } from "../.sentinel-policy-source/src/github/http.ts";
import type { HttpTransportV1 } from "../.sentinel-policy-source/src/github/http.ts";
import { GitHubApiClient } from "../.sentinel-policy-source/src/github/client.ts";
import type { GitHubReviewWireV1 } from "../.sentinel-policy-source/src/github/wire.ts";
import type { ReviewJournalV1 } from "../.sentinel-policy-source/src/github/review-journal.ts";
import { parseReviewJournalBody } from "../.sentinel-policy-source/src/github/review-journal.ts";
import {
  completedReviewMatchesReceipt,
  deriveReviewReceiptV1,
  reviewRecordId,
} from "../.sentinel-policy-source/src/github/review-normalize.ts";
import type { ReviewNormalizationV1 } from "../.sentinel-policy-source/src/github/review-normalize.ts";
import {
  releaseRequestId,
  reviewOperationKey,
  workItemIdForPullRequest,
} from "../.sentinel-policy-source/src/repair/keys.ts";
import { DenoReplayRuntime } from "../.sentinel-policy-source/src/replay/runtime.ts";
import type { ReplayRuntimeV1 } from "../.sentinel-policy-source/src/replay/runtime.ts";

/** Fixed native job id this entrypoint is allowed to run as. */
export const MAINTENANCE_JOB = "maintenance";
/** Reviewed PR54 identity (immutable literals, never selected by time/order). */
export const PULL_REQUEST = 54;
export const REVIEWED_HEAD =
  "969edbdfd80d8c8723364038dbf3176bb1a027ce" as GitSha;
export const REVIEWED_BASE =
  "1d618965c2cb8d0bcaa4fc298ed0973c4b9fa9ca" as GitSha;
/** Native Actions token identity; the reviewer is never read from `/user`. */
export const MAINTENANCE_REVIEWER = "github-actions[bot]";
/** Initial hosted runtime state this fixed release starts from. */
export const INITIAL_ACTIVE_REVISION = REVIEWED_BASE;
export const INITIAL_GENERATION = 3;
/** Ignored trusted candidate checkout inside the protected workflow source. */
export const CANDIDATE_DIR_NAME = ".sentinel-policy-source";

export const REPOSITORY: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "sentinel",
  installationId: 0,
};

const REMOTE_URL = "https://github.com/ubiquity/sentinel.git";
const API_BASE_URL = "https://api.github.com";
const INVOCATION_ID = "sentinel-development-budget-pr54-v3";
const REVIEW_START_WINDOW_MS = 120_000;
const REVIEW_SETTLE_BY_MS = REVIEW_TRANSPORT_TOTAL_MS;
const REVIEW_OVERALL_MS = REVIEW_TRANSPORT_TOTAL_MS + 180_000;
const REVIEW_RECONCILE_WINDOW_MS = 120_000;
const FINAL_DRAIN_MS = 60_000;
const OBSERVE_ATTEMPTS = 6;
const OBSERVE_WAIT_MS = 15_000;

export const STATIC_IDENTITY =
  "sentinel maintenance native identity is not exact";
export const STATIC_SOURCE =
  "sentinel maintenance source checkout is not exact";
export const STATIC_ENV = "sentinel maintenance credentials are unavailable";
export const STATIC_RELEASE = "sentinel maintenance release state is not exact";
export const STATIC_REPAIR = "sentinel maintenance repair state is not exact";
export const STATIC_PR =
  "sentinel maintenance pull request identity is not exact";
export const STATIC_POLICY =
  "sentinel maintenance review budget policy is not exact";
export const STATIC_ADMISSION =
  "sentinel maintenance review admission was not granted";
export const STATIC_OBSERVATION =
  "sentinel maintenance review observation is not complete";
export const STATIC_REQUESTED_AT =
  "sentinel maintenance review requested timestamp is unavailable";
export const STATIC_RECEIPT =
  "sentinel maintenance review receipt is not exact";
export const STATIC_REQUEST =
  "sentinel maintenance release request is not exact";
export const STATIC_VERIFY =
  "sentinel maintenance merge verification did not pass";
export const STATIC_SETTLEMENT =
  "sentinel maintenance review sessions did not settle";
export const STATIC_FAILED = "sentinel maintenance operator failed closed";
const STATIC_MESSAGES: ReadonlySet<string> = new Set([
  STATIC_IDENTITY,
  STATIC_SOURCE,
  STATIC_ENV,
  STATIC_RELEASE,
  STATIC_REPAIR,
  STATIC_PR,
  STATIC_POLICY,
  STATIC_ADMISSION,
  STATIC_OBSERVATION,
  STATIC_REQUESTED_AT,
  STATIC_RECEIPT,
  STATIC_REQUEST,
  STATIC_VERIFY,
  STATIC_SETTLEMENT,
  STATIC_FAILED,
]);

const REPAIR_COLLECTIONS = [
  "incidents",
  "evidence",
  "work",
  "reservations",
  "reviews",
  "replays",
  "releaseRequests",
  "githubCooldowns",
] as const;

/** Native identity read for this one job (named reads only). */
export interface MaintenanceIdentityV1 {
  runId: number;
  runAttempt: number;
  launcherSha: GitSha;
}

/** The review-port subset this fixed operation actually consumes. */
export interface MaintenanceReviewPortsV1 {
  readonly reviewerIdentity: string;
  requestReview(
    request: ReviewSubmissionV1,
  ): Promise<PortResultV1<ReviewRequestOutcomeV1>>;
  observeReview(
    request: ReviewObservationRequestV1,
  ): Promise<PortResultV1<ReviewObservationV1>>;
  drainReviews(
    request: ReviewDrainRequestV1,
  ): Promise<PortResultV1<ReviewDrainReportV1>>;
  /** Ensure every owned session settled; never throws. */
  settle(): Promise<boolean>;
}

/** The read/verify subset consumed through the real API client. */
export interface MaintenanceGitHubReadsV1 {
  readPullRequest(
    number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>>;
  readReviews(number: number): Promise<PortResultV1<GitHubReviewWireV1[]>>;
  verifyHostedReleaseRequest(
    request: ReleaseRequestV1,
  ): Promise<PortResultV1<boolean>>;
}

export type MaintenanceDeferralReasonV1 =
  | "execution_pending"
  | "review_journal_unavailable";

export type MaintenanceOutcomeV1 =
  | {
    status: "deferred";
    reason: MaintenanceDeferralReasonV1;
    runId: number;
    runAttempt: number;
  }
  | {
    status: "already_installed";
    requestId: string;
    receiptId: string;
    revision: GitSha;
    generation: number;
  }
  | {
    status: "reviewed";
    admission: "admitted" | "duplicate" | "existing";
    operationKey: string;
    receiptId: string;
    requestId: string;
    reservationId: string | null;
    releaseReady: boolean;
    findingsCount: number;
    findingsUncounted: number;
    unresolvedSeverities: string[];
  }
  | {
    status: "release_requested";
    releaseRequestId: string;
    receiptId: string;
    mergeSha: GitSha;
    environment: "production";
  };

export interface MaintenanceInputV1 {
  /** Complete named environment read by the production entrypoint. */
  env: Readonly<Record<string, string | undefined>>;
  /** Protected workflow source checkout (the installed launcher). */
  rootDir: string;
  /** Exact candidate checkout inside the protected source. */
  candidateDir: string;
  /** Private per-run scratch root on the runner. */
  stateRoot: string;
  /** Bounded process border used for the fixed checkout identity reads. */
  process: ReplayRuntimeV1;
  http: HttpTransportV1;
  clock: Clock;
  /** Test seam: pre-built repair state capability (production builds it). */
  state?: StateReadView & RepairStateWriter;
  /** Test seam: review ports (production composes the real host port). */
  review?: MaintenanceReviewPortsV1;
  /** Test seam: reads/verification (production uses the real API client). */
  reads?: MaintenanceGitHubReadsV1;
}

/** All named environment keys this entrypoint may read. */
export function readMaintenanceEnv(): Record<string, string | undefined> {
  return {
    GITHUB_RUN_ID: Deno.env.get("GITHUB_RUN_ID"),
    GITHUB_RUN_ATTEMPT: Deno.env.get("GITHUB_RUN_ATTEMPT"),
    GITHUB_REPOSITORY: Deno.env.get("GITHUB_REPOSITORY"),
    GITHUB_REF: Deno.env.get("GITHUB_REF"),
    GITHUB_SHA: Deno.env.get("GITHUB_SHA"),
    GITHUB_WORKFLOW_SHA: Deno.env.get("GITHUB_WORKFLOW_SHA"),
    GITHUB_WORKFLOW_REF: Deno.env.get("GITHUB_WORKFLOW_REF"),
    GITHUB_JOB: Deno.env.get("GITHUB_JOB"),
    HOME: Deno.env.get("HOME"),
    PATH: Deno.env.get("PATH"),
    GITHUB_TOKEN: Deno.env.get("GITHUB_TOKEN"),
    UOS_AI_TOKEN: Deno.env.get("UOS_AI_TOKEN"),
  };
}

function parsePositiveDecimal(value: string | undefined): number {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) failIdentity();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) failIdentity();
  return parsed;
}

/**
 * The fixed native identity: repository, protected ref, exact workflow path at
 * that ref, positive run/attempt, `GITHUB_SHA === GITHUB_WORKFLOW_SHA` and the
 * dedicated `maintenance` job. Any mismatch is a static refusal.
 */
export function parseMaintenanceEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): MaintenanceIdentityV1 {
  const runId = parsePositiveDecimal(env.GITHUB_RUN_ID);
  const runAttempt = parsePositiveDecimal(env.GITHUB_RUN_ATTEMPT);
  if (env.GITHUB_REPOSITORY !== "ubiquity/sentinel") failIdentity();
  if (env.GITHUB_REF !== "refs/heads/sentinel-supervisor") failIdentity();
  const sha = env.GITHUB_SHA;
  if (!isGitSha(sha)) failIdentity();
  if (sha !== env.GITHUB_WORKFLOW_SHA) failIdentity();
  if (env.GITHUB_WORKFLOW_REF !== HOSTED_RUNTIME_WORKFLOW_REF) failIdentity();
  if (env.GITHUB_JOB !== MAINTENANCE_JOB) failIdentity();
  return { runId, runAttempt, launcherSha: sha };
}

function isAllowedUntracked(line: string): boolean {
  return line === `?? ${CANDIDATE_DIR_NAME}/` ||
    line === `?? ${CANDIDATE_DIR_NAME}`;
}

/**
 * Clean root source identity: HEAD must be the launcher SHA and the only
 * tolerated untracked entry is the trusted immutable candidate checkout, which
 * is separately verified at its exact reviewed head. Model work never appears
 * here; any other modified or untracked path fails closed.
 */
export async function readMaintenanceRootHead(
  process: ReplayRuntimeV1,
  dir: string,
): Promise<GitSha> {
  const head = await boundedGit(process, dir, ["rev-parse", "HEAD"]);
  if (head === null || !isGitSha(head)) throw new Error(STATIC_SOURCE);
  const status = await boundedGit(process, dir, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (status === null) throw new Error(STATIC_SOURCE);
  const residue = status.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !isAllowedUntracked(line));
  if (residue.length > 0) throw new Error(STATIC_SOURCE);
  return head;
}

async function boundedGit(
  process: ReplayRuntimeV1,
  dir: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    const result = await process.run({
      executable: "/usr/bin/git",
      args: ["-c", "core.hooksPath=/dev/null", "-C", dir, ...args],
      cwd: dir,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: dir,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      maxDurationMs: 10_000,
      maxOutputBytes: 64 * 1024,
    });
    if (
      result.outcome !== "exited" || !result.settled || result.truncated ||
      result.exitCode !== 0
    ) {
      return null;
    }
    return new TextDecoder().decode(result.stdout).trim();
  } catch {
    return null;
  }
}

function failIdentity(): never {
  throw new Error(STATIC_IDENTITY);
}

function progress(stage: string, status: string): void {
  console.log(JSON.stringify({ stage, status }));
}

function requireEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(STATIC_ENV);
  }
  return value;
}

async function resolveExecutable(
  name: string,
  trustedPath: string,
): Promise<string> {
  for (const directory of trustedPath.split(":")) {
    const candidate = joinPath(directory.length > 0 ? directory : "/", name);
    try {
      const info = await Deno.stat(candidate);
      if (!info.isDirectory) {
        try {
          return await Deno.realPath(candidate);
        } catch {
          return candidate;
        }
      }
    } catch {
      // Continue through the explicitly trusted PATH only.
    }
  }
  throw new Error(STATIC_ENV);
}

async function readStrictRepair(
  state: StateReadView & RepairStateWriter,
): Promise<{ snapshot: RepairStateSnapshotV1; head: GitSha }> {
  let read: Awaited<ReturnType<StateReadView["readRepair"]>>;
  try {
    read = await state.readRepair();
  } catch {
    throw new Error(STATIC_REPAIR);
  }
  if (!read.ok || read.value.status !== "found") {
    throw new Error(STATIC_REPAIR);
  }
  try {
    return {
      snapshot: parseRepairStateSnapshotV1(read.value.snapshot),
      head: read.value.head,
    };
  } catch {
    throw new Error(STATIC_REPAIR);
  }
}

async function readStrictRelease(
  state: StateReadView & RepairStateWriter,
): Promise<ReleaseStateSnapshotV1> {
  let read: Awaited<ReturnType<StateReadView["readRelease"]>>;
  try {
    read = await state.readRelease();
  } catch {
    throw new Error(STATIC_RELEASE);
  }
  if (!read.ok || read.value.status !== "found") {
    throw new Error(STATIC_RELEASE);
  }
  let snapshot: ReleaseStateSnapshotV1;
  try {
    snapshot = parseReleaseStateSnapshotV1(read.value.snapshot);
  } catch {
    throw new Error(STATIC_RELEASE);
  }
  if (snapshot.hostedRuntimes.length !== 1) throw new Error(STATIC_RELEASE);
  if (snapshot.hostedRuntimes[0].id !== HOSTED_RUNTIME_ID) {
    throw new Error(STATIC_RELEASE);
  }
  return snapshot;
}

/** Exact fixed PR/head/base/reviewer identity of one receipt. */
function validateReceiptIdentity(receipt: ReviewReceiptV1): void {
  if (
    receipt.repository.owner !== REPOSITORY.owner ||
    receipt.repository.name !== REPOSITORY.name ||
    receipt.repository.installationId !== 0 ||
    receipt.pullRequest.number !== PULL_REQUEST ||
    receipt.pullRequest.head !== REVIEWED_HEAD ||
    receipt.pullRequest.base !== REVIEWED_BASE ||
    receipt.expectedReviewer !== MAINTENANCE_REVIEWER ||
    receipt.observedReviewer !== MAINTENANCE_REVIEWER ||
    receipt.outcome !== "completed" ||
    receipt.requestId.length === 0 ||
    receipt.resultId === null ||
    receipt.completedAt === null
  ) {
    throw new Error(STATIC_RECEIPT);
  }
}

/** Exact identity plus release-safe findings (no P0/P1, none uncounted). */
function validateReceiptReleasable(receipt: ReviewReceiptV1): void {
  validateReceiptIdentity(receipt);
  if (
    receipt.findingsUncounted !== 0 ||
    receipt.unresolvedSeverities.some((s) => s === "P0" || s === "P1")
  ) {
    throw new Error(STATIC_RECEIPT);
  }
}

function releaseReady(receipt: ReviewReceiptV1): boolean {
  return receipt.outcome === "completed" &&
    receipt.findingsUncounted === 0 &&
    !receipt.unresolvedSeverities.some((s) => s === "P0" || s === "P1");
}

/** Observation projected onto the normalization shape compared by the API. */
function asNormalization(
  observation: ReviewObservationV1,
): ReviewNormalizationV1 {
  return {
    status: observation.status,
    requestId: observation.requestId,
    reviewer: observation.reviewer,
    resultId: observation.resultId,
    completedAt: observation.completedAt,
    observedHead: observation.observedHead,
    observedBase: observation.observedBase,
    summary: observation.summary,
    findings: observation.findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      path: finding.path,
      message: finding.message,
    })),
    findingsUncounted: 0,
  };
}

function exactCompletedObservation(observation: ReviewObservationV1): boolean {
  return observation.status === "completed" &&
    observation.requestId.length > 0 &&
    observation.reviewer === MAINTENANCE_REVIEWER &&
    observation.resultId !== null &&
    observation.completedAt !== null &&
    observation.observedHead === REVIEWED_HEAD &&
    observation.observedBase === REVIEWED_BASE;
}

async function observeCompleted(
  review: MaintenanceReviewPortsV1,
  operationKey: string,
  deadline: number,
  clock: Clock,
): Promise<ReviewObservationV1 | null> {
  for (let attempt = 0; attempt < OBSERVE_ATTEMPTS; attempt++) {
    if (clock.now() >= deadline) break;
    try {
      const observed = await review.observeReview({
        operationKey,
        prNumber: PULL_REQUEST,
        head: REVIEWED_HEAD,
      });
      if (observed.ok && exactCompletedObservation(observed.value)) {
        return observed.value;
      }
    } catch {
      // Bounded retry only; no payload is surfaced.
    }
    if (
      attempt + 1 < OBSERVE_ATTEMPTS && clock.now() + OBSERVE_WAIT_MS < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, OBSERVE_WAIT_MS));
    }
  }
  return null;
}

/** Recover the genuine requested timestamp from published journals only. */
async function recoverRequestedAt(
  reads: MaintenanceGitHubReadsV1,
  operationKey: string,
): Promise<number> {
  const reviews = await reads.readReviews(PULL_REQUEST);
  if (!reviews.ok) throw new Error(STATIC_REQUESTED_AT);
  const found = new Set<string>();
  for (const review of reviews.value) {
    if (review.author !== MAINTENANCE_REVIEWER) continue;
    if (review.commitSha !== REVIEWED_HEAD) continue;
    if (review.body === null) continue;
    let journal: ReviewJournalV1;
    try {
      journal = await parseReviewJournalBody(review.body);
    } catch {
      continue;
    }
    if (journal.operationKey !== operationKey) continue;
    if (
      journal.repository.owner !== REPOSITORY.owner ||
      journal.repository.name !== REPOSITORY.name ||
      journal.prNumber !== PULL_REQUEST ||
      journal.expectedHead !== REVIEWED_HEAD ||
      journal.expectedBase !== REVIEWED_BASE ||
      journal.publisher !== MAINTENANCE_REVIEWER
    ) {
      throw new Error(STATIC_REQUESTED_AT);
    }
    found.add(`${journal.requestId}\u0000${journal.requestedAt}`);
  }
  if (found.size !== 1) throw new Error(STATIC_REQUESTED_AT);
  const pair = [...found][0];
  const requestedAt = Number(pair.split("\u0000")[1]);
  if (!Number.isSafeInteger(requestedAt) || requestedAt <= 0) {
    throw new Error(STATIC_REQUESTED_AT);
  }
  return requestedAt;
}

/** Append exactly this receipt with one expected-head CAS and one readback. */
async function appendReceipt(
  state: StateReadView & RepairStateWriter,
  clock: Clock,
  receipt: ReviewReceiptV1,
): Promise<void> {
  const read = await readStrictRepair(state);
  const before = read.snapshot;
  const existing = before.reviews.find((entry) => entry.id === receipt.id) ??
    null;
  if (existing !== null) {
    if (canonicalStringify(existing) !== canonicalStringify(receipt)) {
      throw new Error(STATIC_RECEIPT);
    }
    progress("receipt", "reconciled");
    return;
  }
  const next = parseRepairStateSnapshotV1({
    ...before,
    stateHead: read.head,
    sequence: before.sequence + 1,
    updatedAt: Math.max(clock.now(), before.updatedAt),
    reviews: [...before.reviews, receipt].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    ),
  });
  let applied = false;
  try {
    const written = await state.writeRepair(next, read.head);
    applied = written.ok && written.value.status === "applied";
  } catch {
    applied = false;
  }
  let after: RepairStateSnapshotV1;
  try {
    after = (await readStrictRepair(state)).snapshot;
  } catch {
    throw new Error(STATIC_REPAIR);
  }
  const appended = after.reviews.find((entry) => entry.id === receipt.id) ??
    null;
  if (
    appended === null ||
    canonicalStringify(appended) !== canonicalStringify(receipt) ||
    canonicalStringify(after.reviews) !== canonicalStringify(next.reviews)
  ) {
    throw new Error(STATIC_REPAIR);
  }
  for (const key of REPAIR_COLLECTIONS) {
    if (key === "reviews") continue;
    if (canonicalStringify(after[key]) !== canonicalStringify(before[key])) {
      throw new Error(STATIC_REPAIR);
    }
  }
  progress("receipt", applied ? "applied" : "reconciled");
}

/** Release-request identity excluding the creation timestamp. */
function releaseRequestIdentity(value: ReleaseRequestV1): unknown {
  return {
    version: value.version,
    kind: value.kind,
    id: value.id,
    target: value.target,
    revision: value.revision,
    source: value.source,
    status: value.status,
    failureReason: value.failureReason,
  };
}

/** Append exactly this request with one expected-head CAS and one readback. */
async function appendReleaseRequest(
  state: StateReadView & RepairStateWriter,
  clock: Clock,
  request: ReleaseRequestV1,
): Promise<ReleaseRequestV1> {
  const read = await readStrictRepair(state);
  const before = read.snapshot;
  const existing =
    before.releaseRequests.find((entry) => entry.id === request.id) ?? null;
  if (existing !== null) {
    if (
      canonicalStringify(releaseRequestIdentity(existing)) !==
        canonicalStringify(releaseRequestIdentity(request))
    ) {
      throw new Error(STATIC_REQUEST);
    }
    progress("release_request", "reconciled");
    return existing;
  }
  const next = parseRepairStateSnapshotV1({
    ...before,
    stateHead: read.head,
    sequence: before.sequence + 1,
    updatedAt: Math.max(clock.now(), before.updatedAt),
    releaseRequests: [...before.releaseRequests, request].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    ),
  });
  let applied = false;
  try {
    const written = await state.writeRepair(next, read.head);
    applied = written.ok && written.value.status === "applied";
  } catch {
    applied = false;
  }
  let after: RepairStateSnapshotV1;
  try {
    after = (await readStrictRepair(state)).snapshot;
  } catch {
    throw new Error(STATIC_REPAIR);
  }
  const appended =
    after.releaseRequests.find((entry) => entry.id === request.id) ?? null;
  if (
    appended === null ||
    canonicalStringify(releaseRequestIdentity(appended)) !==
      canonicalStringify(releaseRequestIdentity(request)) ||
    canonicalStringify(after.releaseRequests) !==
      canonicalStringify(next.releaseRequests)
  ) {
    throw new Error(STATIC_REPAIR);
  }
  for (const key of REPAIR_COLLECTIONS) {
    if (key === "releaseRequests") continue;
    if (canonicalStringify(after[key]) !== canonicalStringify(before[key])) {
      throw new Error(STATIC_REPAIR);
    }
  }
  progress("release_request", applied ? "applied" : "reconciled");
  return request;
}

/**
 * Accepted-install proof: exactly one accepted hosted release for this fixed
 * PR/head must bind the runtime's active revision plus the authentic stored
 * receipt and its real request id.
 */
async function readInstalledOutcome(
  state: StateReadView & RepairStateWriter,
  snapshot: ReleaseStateSnapshotV1,
): Promise<MaintenanceOutcomeV1> {
  const runtime = snapshot.hostedRuntimes[0];
  const accepted = snapshot.hostedReleases.filter((record) =>
    record.phase === "accepted" &&
    record.request.source.pullRequest === PULL_REQUEST &&
    record.request.source.head === REVIEWED_HEAD
  );
  if (accepted.length !== 1) throw new Error(STATIC_RELEASE);
  const record = accepted[0];
  if (runtime.activeRevision !== record.request.revision) {
    throw new Error(STATIC_RELEASE);
  }
  const receiptId = record.request.source.reviewReceiptId;
  if (receiptId === null) throw new Error(STATIC_RECEIPT);
  const repair = await readStrictRepair(state);
  const receipt = repair.snapshot.reviews.find((entry) =>
    entry.id === receiptId
  );
  if (receipt === undefined) throw new Error(STATIC_RECEIPT);
  validateReceiptReleasable(receipt);
  if (
    receipt.requestId !== record.request.source.reviewRequestId ||
    receipt.pullRequest.head !== record.request.source.head ||
    receipt.pullRequest.base !== record.request.source.base
  ) {
    throw new Error(STATIC_RECEIPT);
  }
  progress("runtime", "installed");
  return {
    status: "already_installed",
    requestId: record.request.id,
    receiptId: receipt.id,
    revision: record.request.revision,
    generation: runtime.generation,
  };
}

interface ReviewFlowInputV1 {
  state: StateReadView & RepairStateWriter;
  review: MaintenanceReviewPortsV1;
  reads: MaintenanceGitHubReadsV1;
  clock: Clock;
  budget: RollingStartBudget;
  runId: number;
  runAttempt: number;
}

/** Open PR54: exactly one real review (or a reconcile-only duplicate). */
async function runReviewFlow(
  input: ReviewFlowInputV1,
): Promise<MaintenanceOutcomeV1> {
  const operationKey = reviewOperationKey(PULL_REQUEST, REVIEWED_HEAD);
  const receiptId = reviewRecordId(operationKey);
  const before = await readStrictRepair(input.state);
  const existing =
    before.snapshot.reviews.find((entry) => entry.id === receiptId) ?? null;
  if (existing !== null) {
    // The existing receipt may be revalidated and reused if exact; it is never
    // regenerated with changed timestamps.
    validateReceiptIdentity(existing);
    const observation = await observeCompleted(
      input.review,
      operationKey,
      input.clock.now() + REVIEW_RECONCILE_WINDOW_MS,
      input.clock,
    );
    if (observation === null) throw new Error(STATIC_OBSERVATION);
    if (
      !completedReviewMatchesReceipt(asNormalization(observation), existing)
    ) {
      throw new Error(STATIC_RECEIPT);
    }
    progress("review", "reconciled");
    return {
      status: "reviewed",
      admission: "existing",
      operationKey,
      receiptId: existing.id,
      requestId: existing.requestId,
      reservationId: null,
      releaseReady: releaseReady(existing),
      findingsCount: existing.findings.length,
      findingsUncounted: existing.findingsUncounted,
      unresolvedSeverities: [...existing.unresolvedSeverities],
    };
  }

  const reserved = await input.budget.reserveModelStart({
    repository: REPOSITORY,
    taskId: workItemIdForPullRequest(REPOSITORY, PULL_REQUEST),
    head: REVIEWED_HEAD,
    attempt: 1,
    purpose: "review_request",
  });
  if (reserved.status !== "admitted" && reserved.status !== "duplicate") {
    throw new Error(STATIC_ADMISSION);
  }
  const reservation = reserved.reservation;
  progress("admission", reserved.status);

  const startedAt = input.clock.now();
  const overallDeadline = startedAt + REVIEW_OVERALL_MS;
  let observation: ReviewObservationV1 | null = null;
  let requestedAt: number | null = null;

  if (reserved.status === "admitted") {
    const submission = await input.review.requestReview({
      prNumber: PULL_REQUEST,
      expectedHead: REVIEWED_HEAD,
      expectedBase: REVIEWED_BASE,
      expectedReviewer: MAINTENANCE_REVIEWER,
      operationKey,
      latestStartAt: startedAt + REVIEW_START_WINDOW_MS,
      settleBy: startedAt + REVIEW_SETTLE_BY_MS,
    });
    const confirmed = submission.ok && submission.value.outcome === "applied";
    const settled = await input.budget.settleModelStart({
      id: reservation.id,
      outcome: confirmed ? "submitted" : "ambiguous",
      proofRef: null,
    });
    if (settled.status !== "settled" && settled.status !== "idempotent") {
      throw new Error(STATIC_ADMISSION);
    }
    progress("settlement", settled.status);
    const drained = await input.review.drainReviews({
      deadline: overallDeadline,
      interrupt: false,
    });
    if (!drained.ok || !drained.value.ok) {
      throw new Error(STATIC_OBSERVATION);
    }
    observation = await observeCompleted(
      input.review,
      operationKey,
      overallDeadline,
      input.clock,
    );
    if (observation === null) throw new Error(STATIC_OBSERVATION);
    if (
      confirmed && submission.ok &&
      Number.isSafeInteger(submission.value.requestedAt) &&
      submission.value.requestedAt > 0
    ) {
      requestedAt = submission.value.requestedAt;
    }
  } else {
    // A duplicate reservation is reconciliation only: never resubmit, no new
    // attempt and no refund. The durable reservation and the remote journal
    // are authoritative; a missing or unsettled journal defers without any
    // write so a later run can reconcile it.
    if (reservation.outcome === "confirmed_not_submitted") {
      throw new Error(STATIC_ADMISSION);
    }
    observation = await observeCompleted(
      input.review,
      operationKey,
      input.clock.now() + REVIEW_RECONCILE_WINDOW_MS,
      input.clock,
    );
    if (observation === null) {
      progress("review", "deferred");
      return {
        status: "deferred",
        reason: "review_journal_unavailable",
        runId: input.runId,
        runAttempt: input.runAttempt,
      };
    }
    const settled = await input.budget.settleModelStart({
      id: reservation.id,
      outcome: "submitted",
      proofRef: null,
    });
    if (settled.status !== "settled" && settled.status !== "idempotent") {
      throw new Error(STATIC_ADMISSION);
    }
    progress("settlement", settled.status);
  }

  if (requestedAt === null) {
    requestedAt = await recoverRequestedAt(input.reads, operationKey);
  }
  if (observation === null) throw new Error(STATIC_OBSERVATION);
  const receipt = deriveReviewReceiptV1(observation, {
    operationKey,
    submittedAt: requestedAt,
    prNumber: PULL_REQUEST,
    expectedHead: REVIEWED_HEAD,
    expectedBase: REVIEWED_BASE,
    expectedReviewer: MAINTENANCE_REVIEWER,
  }, REPOSITORY);
  validateReceiptIdentity(receipt);
  await appendReceipt(input.state, input.clock, receipt);
  progress("observation", "completed");
  return {
    status: "reviewed",
    admission: reserved.status === "admitted" ? "admitted" : "duplicate",
    operationKey,
    receiptId: receipt.id,
    requestId: receipt.requestId,
    reservationId: reservation.id,
    releaseReady: releaseReady(receipt),
    findingsCount: receipt.findings.length,
    findingsUncounted: receipt.findingsUncounted,
    unresolvedSeverities: [...receipt.unresolvedSeverities],
  };
}

/** Merged PR54: re-prove the published review, then append the exact request. */
async function runReleaseFlow(
  input: ReviewFlowInputV1,
  pull: GitHubPullRequestV1,
): Promise<MaintenanceOutcomeV1> {
  const operationKey = reviewOperationKey(PULL_REQUEST, REVIEWED_HEAD);
  const receiptId = reviewRecordId(operationKey);
  const repair = await readStrictRepair(input.state);
  const receipt = repair.snapshot.reviews.find((entry) =>
    entry.id === receiptId
  );
  if (receipt === undefined) throw new Error(STATIC_RECEIPT);
  validateReceiptReleasable(receipt);
  const observation = await observeCompleted(
    input.review,
    operationKey,
    input.clock.now() + REVIEW_RECONCILE_WINDOW_MS,
    input.clock,
  );
  if (observation === null) throw new Error(STATIC_OBSERVATION);
  if (!completedReviewMatchesReceipt(asNormalization(observation), receipt)) {
    throw new Error(STATIC_OBSERVATION);
  }
  if (pull.mergeSha === null) throw new Error(STATIC_VERIFY);
  const request = parseReleaseRequestV1({
    version: "v1",
    kind: "release_request",
    id: await releaseRequestId(REPOSITORY, pull.mergeSha, PULL_REQUEST),
    target: { repository: REPOSITORY, environment: "production" },
    revision: pull.mergeSha,
    source: {
      pullRequest: PULL_REQUEST,
      reviewRequestId: receipt.requestId,
      reviewReceiptId: receipt.id,
      head: REVIEWED_HEAD,
      base: REVIEWED_BASE,
    },
    status: "open",
    failureReason: null,
    createdAt: input.clock.now(),
  });
  if (
    request.revision !== pull.mergeSha ||
    request.source.reviewReceiptId !== receipt.id ||
    request.source.reviewRequestId !== receipt.requestId ||
    request.source.head !== REVIEWED_HEAD ||
    request.source.base !== REVIEWED_BASE
  ) {
    throw new Error(STATIC_REQUEST);
  }
  let verified: PortResultV1<boolean>;
  try {
    verified = await input.reads.verifyHostedReleaseRequest(request);
  } catch {
    throw new Error(STATIC_VERIFY);
  }
  if (!verified.ok || verified.value !== true) {
    throw new Error(STATIC_VERIFY);
  }
  progress("merge_verification", "exact");
  const recorded = await appendReleaseRequest(
    input.state,
    input.clock,
    request,
  );
  return {
    status: "release_requested",
    releaseRequestId: recorded.id,
    receiptId: receipt.id,
    mergeSha: recorded.revision,
    environment: "production",
  };
}

/**
 * One bounded maintenance pass. Identity, both fixed checkouts and the strict
 * release snapshot are validated before any credential, state write or model
 * work; a saved runtime execution defers immediately.
 */
export async function runMaintenanceEntrypoint(
  input: MaintenanceInputV1,
): Promise<MaintenanceOutcomeV1> {
  const identity = parseMaintenanceEnvironment(input.env);

  // Exact clean root checkout at the launcher SHA plus the immutable candidate
  // checkout at the exact reviewed head, before any credential or state read.
  const rootHead = await readMaintenanceRootHead(input.process, input.rootDir);
  if (rootHead !== identity.launcherSha) throw new Error(STATIC_SOURCE);
  // The immutable candidate checkout must be the exact reviewed head with a
  // clean tracked tree; its `.git` never makes the trusted root look dirty.
  let candidateHead: GitSha;
  try {
    candidateHead = await readCleanGitHead(input.process, input.candidateDir);
  } catch {
    throw new Error(STATIC_SOURCE);
  }
  if (candidateHead !== REVIEWED_HEAD) throw new Error(STATIC_SOURCE);
  progress("identity", "exact");

  const token = requireEnv(input.env, "GITHUB_TOKEN");
  const modelToken = requireEnv(input.env, "UOS_AI_TOKEN");
  const trustedPath = requireEnv(input.env, "PATH");

  await ensurePrivateDir(input.stateRoot);
  const scratch = joinPath(input.stateRoot, "state-scratch");
  const state = input.state ?? createRepairStateStore({
    scratchDir: scratch,
    remoteUrl: REMOTE_URL,
    runner: new DenoGitRunner(
      joinPath(input.stateRoot, "state-git-home"),
      githubGitAuthEnv(token),
    ),
  });

  const release = await readStrictRelease(state);
  const runtime = release.hostedRuntimes[0];
  // A saved execution is not this fixed operation's work: defer without any
  // write or model so the supervisor's prepare can reconcile it.
  if (runtime.execution !== null) {
    progress("runtime", "deferred");
    return {
      status: "deferred",
      reason: "execution_pending",
      runId: identity.runId,
      runAttempt: identity.runAttempt,
    };
  }
  if (runtime.activeRevision !== INITIAL_ACTIVE_REVISION) {
    return await readInstalledOutcome(state, release);
  }
  if (runtime.generation !== INITIAL_GENERATION) {
    throw new Error(STATIC_RELEASE);
  }

  let review = input.review;
  let reads = input.reads;
  if (review === undefined || reads === undefined) {
    const composed = await composeMaintenancePorts({
      state,
      clock: input.clock,
      http: input.http,
      token,
      modelToken,
      trustedPath,
      candidateDir: input.candidateDir,
      stateRoot: input.stateRoot,
      invocationId: INVOCATION_ID,
    });
    if (review === undefined) review = composed.review;
    if (reads === undefined) reads = composed.reads;
  }
  const reviewPorts: MaintenanceReviewPortsV1 = review;
  const readPorts: MaintenanceGitHubReadsV1 = reads;

  let settlementFailed = false;
  let outcome: MaintenanceOutcomeV1 | null = null;
  try {
    const config = createLocalRepositoryConfig();
    const limits = config.liveStartLimits;
    if (
      limits === null || limits.perHour !== 120 || limits.perSevenDays !== null
    ) {
      throw new Error(STATIC_POLICY);
    }
    const pull = await readPorts.readPullRequest(PULL_REQUEST);
    if (!pull.ok) throw new Error(STATIC_PR);
    if (pull.value === null) throw new Error(STATIC_PR);
    const pr = pull.value;
    if (
      pr.head !== REVIEWED_HEAD ||
      (pr.state === "open" && pr.base !== REVIEWED_BASE)
    ) {
      throw new Error(STATIC_PR);
    }
    const flow: ReviewFlowInputV1 = {
      state,
      review: reviewPorts,
      reads: readPorts,
      clock: input.clock,
      budget: new RollingStartBudget({
        clock: input.clock,
        state,
        configs: [config],
      }),
      runId: identity.runId,
      runAttempt: identity.runAttempt,
    };
    if (pr.state === "open") {
      outcome = await runReviewFlow(flow);
    } else if (pr.state === "merged") {
      outcome = await runReleaseFlow(flow, pr);
    } else {
      throw new Error(STATIC_PR);
    }
  } finally {
    try {
      const drained = await reviewPorts.drainReviews({
        deadline: input.clock.now() + FINAL_DRAIN_MS,
        interrupt: true,
      });
      if (!drained.ok || !drained.value.ok) settlementFailed = true;
    } catch {
      settlementFailed = true;
    }
    if (!await reviewPorts.settle()) settlementFailed = true;
  }
  if (settlementFailed) throw new Error(STATIC_SETTLEMENT);
  if (outcome === null) throw new Error(STATIC_FAILED);
  return outcome;
}

interface ComposeInputV1 {
  state: StateReadView & RepairStateWriter;
  clock: Clock;
  http: HttpTransportV1;
  token: string;
  modelToken: string;
  trustedPath: string;
  candidateDir: string;
  stateRoot: string;
  invocationId: string;
}

/** Production composition: the real host port plus the real API client. */
async function composeMaintenancePorts(input: ComposeInputV1): Promise<{
  review: MaintenanceReviewPortsV1;
  reads: MaintenanceGitHubReadsV1;
}> {
  const gate = new HostedRepairCooldownGate({
    state: input.state,
    clock: input.clock,
  });
  const reviewCheckout = joinPath(input.stateRoot, "review-checkout");
  const reviewClientHome = joinPath(input.stateRoot, "clients", "review");
  const reviewTmpDir = joinPath(input.stateRoot, "tmp", "review");
  const reviewDenoDir = joinPath(input.stateRoot, "deno", "review");
  const codexExecutable = await resolveExecutable("codex", input.trustedPath);
  await ensureReviewClient({
    reviewCheckout,
    reviewClientHome,
    reviewTmpDir,
    reviewDenoDir,
    token: input.modelToken,
    codexExecutable,
    denoExecutable: Deno.execPath(),
    trustedPath: input.trustedPath,
    baseUrl: ACTIONS_UOS_BASE_URL,
  });
  const tracker = new LocalSessionTracker();
  const github = composeLocalGitHub({
    clock: input.clock,
    state: input.state,
    gate,
    http: input.http,
    token: input.token,
    login: MAINTENANCE_REVIEWER,
    invocationId: input.invocationId,
    sourcePath: input.candidateDir,
    scratch: joinPath(input.stateRoot, "state-scratch"),
    reviewCheckout,
    reviewClientHome,
    reviewTmpDir,
    reviewDenoDir,
    trustedPath: input.trustedPath,
    codexExecutable,
    tracker,
    modelBaseUrl: ACTIONS_UOS_BASE_URL,
  });
  if (github.reviewerIdentity !== MAINTENANCE_REVIEWER) {
    throw new Error(STATIC_IDENTITY);
  }
  const client = new GitHubApiClient({
    repository: REPOSITORY,
    apiBaseUrl: API_BASE_URL,
    http: input.http,
    auth: {
      authorizationHeader: () =>
        Promise.resolve(portOk(`Bearer ${input.token}`)),
    },
    cooldownGate: gate,
    clock: input.clock,
  });
  return {
    review: {
      reviewerIdentity: github.reviewerIdentity,
      requestReview: (request) => github.requestReview(request),
      observeReview: (request) => github.observeReview(request),
      drainReviews: (request) => github.drainReviews(request),
      settle: () => tracker.settleAll(),
    },
    reads: {
      readPullRequest: (number) => client.readPullRequest(number),
      readReviews: (number) => client.readReviews(number),
      verifyHostedReleaseRequest: (request) =>
        client.verifyHostedReleaseRequest(request),
    },
  };
}

async function main(): Promise<void> {
  const env = readMaintenanceEnv();
  // Native identity is the first check; the private scratch path is derived
  // only after it is exact.
  const identity = parseMaintenanceEnvironment(env);
  const home = requireEnv(env, "HOME");
  const rootDir = Deno.cwd();
  const outcome = await runMaintenanceEntrypoint({
    env,
    rootDir,
    candidateDir: joinPath(rootDir, CANDIDATE_DIR_NAME),
    stateRoot: joinPath(
      home,
      ".sentinel-maintenance",
      `${identity.runId}-${identity.runAttempt}`,
    ),
    process: new DenoReplayRuntime(Deno.execPath()),
    http: fetchHttpTransport(),
    clock: new SystemClock(),
  });
  console.log(JSON.stringify(outcome));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    console.error(JSON.stringify({
      stage: "maintenance",
      status: "failed",
      error: STATIC_MESSAGES.has(message) ? message : STATIC_FAILED,
    }));
    Deno.exit(1);
  }
}
