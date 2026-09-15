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
  parseBudgetReservationV1,
} from "../.sentinel-policy-source/src/contracts/budget-reservation.ts";
import type { BudgetReservationV1 } from "../.sentinel-policy-source/src/contracts/budget-reservation.ts";
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
  createLocalRepositoryConfig,
  ensurePrivateDir,
  ensureReviewClient,
  githubGitAuthEnv,
  joinPath,
  LocalSessionTracker,
} from "../.sentinel-policy-source/src/host/local.ts";
import { composeGitHubHost } from "../.sentinel-policy-source/src/host/github.ts";
import type { GitHubAuthProviderV1 } from "../.sentinel-policy-source/src/github/auth.ts";
import {
  CodexStructuredReviewer,
  finalizeReviewCompletion,
} from "../.sentinel-policy-source/src/github/codex-reviewer.ts";
import type {
  PreparedStructuredReviewV1,
  StructuredReviewCloseV1,
  StructuredReviewOutcomeV1,
  StructuredReviewPrepareV1,
} from "../.sentinel-policy-source/src/github/codex-reviewer.ts";
import type { CodexReviewPrepareCapabilityV1 } from "../.sentinel-policy-source/src/github/codex-review-transport.ts";
import { GitHubCodexReviewTransport } from "../.sentinel-policy-source/src/github/codex-review-transport.ts";
import { GitReviewSnapshot } from "../.sentinel-policy-source/src/github/review-snapshot.ts";
import { CodexSubprocessSession } from "../.sentinel-policy-source/src/repair/codex-transport.ts";
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
/** The prior published attempt-1 key; verification only, never a new artifact. */
const PRIOR_OPERATION_KEY = reviewOperationKey(PULL_REQUEST, REVIEWED_HEAD);
/** The one fixed operation key every attempt-2 artifact binds. */
const ATTEMPT_2_OPERATION_KEY = `${PRIOR_OPERATION_KEY}:attempt-2`;
/** The separately charged successor is exactly attempt 2: never attempt 3. */
const ATTEMPT_2 = 2;
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
export const STATIC_PRIOR =
  "sentinel maintenance prior review attempt is not exact";
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
  STATIC_PRIOR,
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

/**
 * Bounded per-stage review diagnostics for the fixed maintenance operator.
 *
 * One bounded JSON line is reported for each prepare/start/close stage so a
 * future separately charged review attempt can distinguish a transport or
 * journal-render fault from a genuine reviewer failure. The reporter is a
 * local test seam only: it is never read from the environment, CLI or any
 * runtime configuration, and a throwing reporter is swallowed so diagnostics
 * can never alter review flow. Records carry only static stage/status literals
 * and an allowlisted archive detail; review results, findings, request input,
 * exception text, paths, tokens and arbitrary payloads are never included.
 */
export type ReviewDiagnosticReporterV1 = (line: string) => void;

export interface ReviewDiagnosticRecordV1 {
  /** Fixed stage identity. */
  stage: "prepare" | "start" | "close";
  /** Fixed per-stage disposition; never payload-derived. */
  outcome: "prepared" | "rejected" | "threw" | "ok" | "error" | "closed";
  /** Fixed diagnostic status (clean/findings/unavailable); null when N/A. */
  status: string | null;
  /** Allowlisted static archive detail or the fixed unknown marker. */
  detail: string | null;
  /** Close-only settlement proof; null for prepare/start. */
  settled: boolean | null;
  /** Close-only bounded-wait marker; null for prepare/start. */
  timedOut: boolean | null;
  /** Close-only transport-failure presence; null for prepare/start. */
  hasFailure: boolean | null;
  /**
   * Close-only `finalizeReviewCompletion` classification
   * (clean/findings/unavailable) used for diagnosis only; null when no start
   * result exists.
   */
  classification: string | null;
}

/** Fixed marker for a nonallowlisted or non-string detail. */
const REVIEW_UNKNOWN_DETAIL = "unknown-detail";

/**
 * Finite allowlist of the exact static failure details defined by the archived
 * reviewer (including its static close-failure marker). Any other string is
 * reported as the fixed unknown marker, so arbitrary values can never reach
 * the diagnostic journal.
 */
const REVIEW_SAFE_DETAILS: ReadonlySet<string> = new Set([
  "structured review unavailable: the configured provider is not a nonempty finite string",
  "structured review unavailable: the configured permission profile is not a valid named profile",
  "structured review unavailable: the supplied absolute deadlines do not admit a bounded start",
  "structured review unavailable: the prepare request identity is missing or over bound",
  "structured review unavailable: the complete review prompt exceeded its finite bound",
  "structured review unavailable: app-server preparation failed",
  "structured review unavailable: app-server preparation failed and the owned session did not settle",
  "structured review start rejected: the single start attempt was already consumed",
  "structured review unavailable: latestStartAt elapsed before turn submission",
  "structured review unavailable: the settlement deadline elapsed before turn submission",
  "structured review unavailable: notification registration failed",
  "structured review unavailable: the session issued a forbidden server request",
  "structured review unavailable: the single turn submission was not acknowledged",
  "structured review unavailable: the turn submission response had no exact turn id",
  "structured review unavailable: the session event bound was exceeded",
  "structured review unavailable: early session buffering exceeded its finite bound",
  "structured review unavailable: a session item identity was malformed",
  "structured review unavailable: a forbidden or unsupported session item was reported",
  "structured review unavailable: the echoed user message was not the exact submitted input",
  "structured review unavailable: an agent message was malformed",
  "structured review unavailable: the agent message bound was exceeded",
  "structured review unavailable: terminal evidence was malformed",
  "structured review unavailable: contradictory duplicate terminal evidence",
  "structured review unavailable: routing evidence was malformed",
  "structured review unavailable: routing evidence exceeded its bound",
  "structured review unavailable: the run was routed off the required Luna/max",
  "structured review unavailable: the owned session was closed before completion",
  "structured review unavailable: no exact runtime terminal was observed",
  "structured review unavailable: the runtime terminal was not completed",
  "structured review unavailable: no final agent message was delivered",
  "structured review unavailable: the final agent message was ambiguous or duplicated",
  "structured review unavailable: the structured result was malformed",
  "structured review unavailable: the structured result exceeded the accepted bound",
  "structured review unavailable: a finding does not reference a changed candidate file",
  "structured review unavailable: a finding line range is outside the candidate file",
  "structured review unavailable: the request/runtime receipt could not be verified",
  "structured review unavailable: the owned transport reported a fatal failure",
  "structured review unavailable: the review reported insufficient evidence",
  "structured review unavailable: the owned session did not settle cleanly after completion",
  "close_failed",
]);

/** Map any detail to an allowlisted static string or the fixed unknown marker. */
function safeReviewDetail(detail: unknown): string {
  return typeof detail === "string" && REVIEW_SAFE_DETAILS.has(detail)
    ? detail
    : REVIEW_UNKNOWN_DETAIL;
}

/** One bounded diagnostic line; a failing reporter never alters review flow. */
function writeReviewDiagnostic(
  reporter: ReviewDiagnosticReporterV1,
  record: ReviewDiagnosticRecordV1,
): void {
  try {
    reporter(JSON.stringify(record));
  } catch {
    // Diagnostics are observational only; never let them change flow.
  }
}

/** Production reporter: one bounded static JSON line per stage. */
function logReviewDiagnostic(line: string): void {
  console.log(line);
}

function emptyDiagnostic(
  stage: ReviewDiagnosticRecordV1["stage"],
  outcome: ReviewDiagnosticRecordV1["outcome"],
  status: string | null,
  detail: string | null,
): ReviewDiagnosticRecordV1 {
  return {
    stage,
    outcome,
    status,
    detail,
    settled: null,
    timedOut: null,
    hasFailure: null,
    classification: null,
  };
}

/**
 * Diagnostic wrapper over a prepared review handle. Every immutable field is
 * forwarded explicitly (never spread: the original is a class instance whose
 * prototype methods would disappear) and `startAttempted` stays bound to the
 * original handle. `start`/`close` delegate exactly once per caller call and
 * return the original values unchanged by identity.
 */
class DiagnosticPreparedStructuredReviewV1
  implements PreparedStructuredReviewV1 {
  readonly execution: PreparedStructuredReviewV1["execution"];
  readonly threadId: string;
  readonly invocationId: string;
  readonly requestId: string;
  readonly ownerRunId: string;
  readonly latestStartAt: number;
  readonly settleBy: number;

  private readonly original: PreparedStructuredReviewV1;
  private readonly startAttemptedOriginal: () => boolean;
  private readonly reporter: ReviewDiagnosticReporterV1;
  private startResult: PortResultV1<StructuredReviewOutcomeV1> | null = null;

  constructor(
    original: PreparedStructuredReviewV1,
    reporter: ReviewDiagnosticReporterV1,
  ) {
    this.original = original;
    this.execution = original.execution;
    this.threadId = original.threadId;
    this.invocationId = original.invocationId;
    this.requestId = original.requestId;
    this.ownerRunId = original.ownerRunId;
    this.latestStartAt = original.latestStartAt;
    this.settleBy = original.settleBy;
    this.startAttemptedOriginal = original.startAttempted.bind(original);
    this.reporter = reporter;
  }

  startAttempted(): boolean {
    return this.startAttemptedOriginal();
  }

  /** Exactly-once (per caller call) delegated start; original identity kept. */
  async start(): Promise<PortResultV1<StructuredReviewOutcomeV1>> {
    let result: PortResultV1<StructuredReviewOutcomeV1>;
    try {
      result = await this.original.start();
    } catch (error) {
      writeReviewDiagnostic(
        this.reporter,
        emptyDiagnostic("start", "threw", null, REVIEW_UNKNOWN_DETAIL),
      );
      throw error;
    }
    this.startResult = result;
    writeReviewDiagnostic(this.reporter, {
      stage: "start",
      outcome: result.ok ? "ok" : "error",
      status: result.ok ? result.value.status : "unavailable",
      detail: result.ok
        ? (result.value.detail === null
          ? null
          : safeReviewDetail(result.value.detail))
        : safeReviewDetail(result.error.detail),
      settled: null,
      timedOut: null,
      hasFailure: null,
      classification: null,
    });
    return result;
  }

  /**
   * Delegated idempotent close; original close result identity is kept. The
   * finalize classification is diagnostic only and never substitutes an
   * outcome or changes the returned close value.
   */
  async close(): Promise<StructuredReviewCloseV1> {
    let result: StructuredReviewCloseV1;
    try {
      result = await this.original.close();
    } catch (error) {
      writeReviewDiagnostic(
        this.reporter,
        emptyDiagnostic("close", "threw", null, REVIEW_UNKNOWN_DETAIL),
      );
      throw error;
    }
    const finalized = this.startResult === null
      ? null
      : finalizeReviewCompletion(this.startResult, result);
    writeReviewDiagnostic(this.reporter, {
      stage: "close",
      outcome: "closed",
      status: null,
      detail: null,
      settled: result.settled,
      timedOut: result.timedOut,
      hasFailure: result.failure !== null,
      classification: finalized === null
        ? null
        : (finalized.ok ? finalized.value.status : "unavailable"),
    });
    return result;
  }
}

/**
 * Bounded diagnostic wrapper over the existing prepare capability. It never
 * changes review results, deadlines, authority or result acceptance: rejected
 * PortResult objects and thrown exceptions are returned/rethrown unchanged,
 * successful prepares wrap the handle, and start/close values keep their
 * original identity.
 */
export class DiagnosticReviewPrepareCapabilityV1
  implements CodexReviewPrepareCapabilityV1 {
  private readonly inner: CodexReviewPrepareCapabilityV1;
  private readonly reporter: ReviewDiagnosticReporterV1;

  constructor(
    inner: CodexReviewPrepareCapabilityV1,
    reporter: ReviewDiagnosticReporterV1 = logReviewDiagnostic,
  ) {
    this.inner = inner;
    this.reporter = reporter;
  }

  async prepare(
    request: StructuredReviewPrepareV1,
  ): Promise<PortResultV1<PreparedStructuredReviewV1>> {
    let result: PortResultV1<PreparedStructuredReviewV1>;
    try {
      result = await this.inner.prepare(request);
    } catch (error) {
      writeReviewDiagnostic(
        this.reporter,
        emptyDiagnostic("prepare", "threw", null, REVIEW_UNKNOWN_DETAIL),
      );
      throw error;
    }
    if (!result.ok) {
      writeReviewDiagnostic(this.reporter, {
        stage: "prepare",
        outcome: "rejected",
        status: "unavailable",
        detail: safeReviewDetail(result.error.detail),
        settled: null,
        timedOut: null,
        hasFailure: null,
        classification: null,
      });
      return result;
    }
    writeReviewDiagnostic(
      this.reporter,
      emptyDiagnostic("prepare", "prepared", null, null),
    );
    return portOk(
      new DiagnosticPreparedStructuredReviewV1(result.value, this.reporter),
    );
  }
}

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

/**
 * Immutable published attempt-1 evidence. The reservation and its
 * authenticated terminal `ready` journal are exact public records of one real
 * completed attempt; the reservation is never reset, refunded or rewritten and
 * exists only to prove that the separately charged attempt 2 is admissible.
 * Every literal below is fixed: nothing is selected by time or list order.
 */
const PRIOR_REVIEW_ID = 5_210_219_310;
const PRIOR_REQUEST_ID =
  "review-review:54:969edbdfd80d8c8723364038dbf3176bb1a027ce";
const PRIOR_REQUESTED_AT = 1_789_477_005_005;
const PRIOR_COMPLETED_AT = 1_789_477_588_103;
const PRIOR_SUBMITTED_AT = 1_789_477_601_000;
const PRIOR_RESULT_SUMMARY =
  "structured review unavailable: the review did not produce a validated result";
const PRIOR_RESULT_DIGEST =
  "23c88a4968014d3a0c778bde81cfb6b9129af33a45dad7f58c72a0640f3b4fb0";

/** The exact durable attempt-1 reservation this operator must not alter. */
function priorReservationV1(): BudgetReservationV1 {
  return parseBudgetReservationV1({
    version: "v1",
    kind: "budget_reservation",
    repository: REPOSITORY,
    id: "b87d501ae3da4911c1943bc50f2c662cd31bd15cd538cc1fe3b2617ee65941fd",
    taskId: "pr-ubiquity-sentinel-54",
    attempt: 1,
    head: REVIEWED_HEAD,
    purpose: "review_request",
    createdAt: 1_789_476_994_016,
    outcome: "submitted",
    settledAt: 1_789_477_027_883,
    proofRef: null,
  });
}

/**
 * Small fixed admission gate for the separately charged attempt 2: the exact
 * attempt-1 reservation and its exact authenticated terminal journal must both
 * already be published before any attempt-2 charge or model call. Any missing,
 * malformed or mismatched evidence refuses with the fixed sanitized message and
 * no write. This is not a generic retry framework and not a review-id-only
 * guard: the prior record identity and every journal field are exact.
 */
async function requirePriorUnavailableAttempt(
  before: RepairStateSnapshotV1,
  reads: MaintenanceGitHubReadsV1,
): Promise<void> {
  const expected = priorReservationV1();
  const charged = before.reservations.filter((entry) =>
    canonicalStringify(entry) === canonicalStringify(expected)
  );
  if (charged.length !== 1) throw new Error(STATIC_PRIOR);

  let reviews: PortResultV1<GitHubReviewWireV1[]>;
  try {
    reviews = await reads.readReviews(PULL_REQUEST);
  } catch {
    throw new Error(STATIC_PRIOR);
  }
  if (!reviews.ok) throw new Error(STATIC_PRIOR);
  const selected = reviews.value.filter((review) =>
    review.id === PRIOR_REVIEW_ID
  );
  if (selected.length !== 1) throw new Error(STATIC_PRIOR);
  const wire = selected[0];
  if (
    wire.state !== "commented" ||
    wire.author !== MAINTENANCE_REVIEWER ||
    wire.commitSha !== REVIEWED_HEAD ||
    wire.submittedAt !== PRIOR_SUBMITTED_AT ||
    wire.body === null
  ) {
    throw new Error(STATIC_PRIOR);
  }
  let journal: ReviewJournalV1;
  try {
    journal = await parseReviewJournalBody(wire.body);
  } catch {
    throw new Error(STATIC_PRIOR);
  }
  if (
    journal.version !== "v1" ||
    journal.phase !== "ready" ||
    journal.repository.owner !== REPOSITORY.owner ||
    journal.repository.name !== REPOSITORY.name ||
    journal.prNumber !== PULL_REQUEST ||
    journal.expectedHead !== REVIEWED_HEAD ||
    journal.expectedBase !== REVIEWED_BASE ||
    journal.operationKey !== PRIOR_OPERATION_KEY ||
    journal.publisher !== MAINTENANCE_REVIEWER ||
    journal.requestId !== PRIOR_REQUEST_ID ||
    journal.requestedAt !== PRIOR_REQUESTED_AT ||
    journal.reviewId !== PRIOR_REVIEW_ID ||
    journal.completedAt !== PRIOR_COMPLETED_AT ||
    journal.execution !== null ||
    journal.resultDigest !== PRIOR_RESULT_DIGEST ||
    journal.result.verdict !== "unavailable" ||
    journal.result.summary !== PRIOR_RESULT_SUMMARY ||
    journal.result.findings.length !== 0
  ) {
    throw new Error(STATIC_PRIOR);
  }
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
  // A valid completed receipt under an old or other operation key is a
  // different operation and can never prove this installed attempt-2 outcome.
  if (receiptId !== reviewRecordId(ATTEMPT_2_OPERATION_KEY)) {
    throw new Error(STATIC_RECEIPT);
  }
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

/**
 * Open PR54: the separately charged attempt 2 (or a reconcile-only duplicate)
 * after the exact terminal attempt-1 evidence. Never an automatic attempt 3.
 */
async function runReviewFlow(
  input: ReviewFlowInputV1,
): Promise<MaintenanceOutcomeV1> {
  const operationKey = ATTEMPT_2_OPERATION_KEY;
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

  // The successor start is admissible only against the exact published
  // terminal attempt-1 evidence, before any attempt-2 charge or model call.
  await requirePriorUnavailableAttempt(before.snapshot, input.reads);

  const reserved = await input.budget.reserveModelStart({
    repository: REPOSITORY,
    taskId: workItemIdForPullRequest(REPOSITORY, PULL_REQUEST),
    head: REVIEWED_HEAD,
    attempt: ATTEMPT_2,
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
  const operationKey = ATTEMPT_2_OPERATION_KEY;
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
  const auth: GitHubAuthProviderV1 = {
    authorizationHeader: () => Promise.resolve(portOk(`Bearer ${input.token}`)),
  };
  const client = new GitHubApiClient({
    repository: REPOSITORY,
    apiBaseUrl: API_BASE_URL,
    http: input.http,
    auth,
    cooldownGate: gate,
    clock: input.clock,
    includeIssueRelations: true,
  });
  const snapshot = new GitReviewSnapshot({
    trustedPath: input.trustedPath,
    repositoryDir: input.candidateDir,
    gitExecutable: "/usr/bin/git",
  });
  const reviewer = new CodexStructuredReviewer({
    provider: "uos",
    sessionCwd: reviewCheckout,
    permissionProfile: "sentinel-review",
    openSession: ({ cwd }) =>
      tracker.open(() =>
        new CodexSubprocessSession({
          command: [codexExecutable, "app-server"],
          cwd,
          env: {
            PATH: input.trustedPath,
            HOME: reviewClientHome,
            CODEX_HOME: reviewClientHome,
            TMPDIR: reviewTmpDir,
            DENO_DIR: reviewDenoDir,
          },
          operationDeadlineMs: 1_200_000,
        })
      ),
  });
  const reviewService = new GitHubCodexReviewTransport({
    client,
    repository: REPOSITORY,
    publisher: MAINTENANCE_REVIEWER,
    clock: input.clock,
    ownerRunId: input.invocationId,
    snapshot,
    reviewer: new DiagnosticReviewPrepareCapabilityV1(reviewer),
    maxActiveReviews: 1,
  });
  const host = composeGitHubHost({
    repository: REPOSITORY,
    http: input.http,
    auth,
    cooldownGate: gate,
    clock: input.clock,
    reviewService,
    trustedPrAuthor: MAINTENANCE_REVIEWER,
    trustedReviewer: MAINTENANCE_REVIEWER,
    trustedResolutionAuthors: [MAINTENANCE_REVIEWER],
    git: {
      localDir: input.candidateDir,
      remoteUrl: REMOTE_URL,
      gitHome: joinPath(input.stateRoot, "state-scratch"),
      extraEnv: githubGitAuthEnv(input.token),
      gitPath: "/usr/bin/git",
      timeoutMs: 120_000,
      maxOutputBytes: 1_048_576,
    },
    includeIssueRelations: true,
  });
  if (host.port.reviewerIdentity !== MAINTENANCE_REVIEWER) {
    throw new Error(STATIC_IDENTITY);
  }
  return {
    review: {
      reviewerIdentity: host.port.reviewerIdentity,
      requestReview: (request) => host.port.requestReview(request),
      observeReview: (request) => host.port.observeReview(request),
      drainReviews: (request) => host.port.drainReviews(request),
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
