/**
 * Bounded stale-run recovery before the five-minute supervisor dispatch.
 *
 * A real wedge (2026-10-01, run 36862385999) held the run-level
 * `sentinel-supervisor` concurrency group for about twenty hours with its last
 * job (`finalize`) stuck `queued` and no runner. Normal cancellation left the
 * `always()` finalizer queued; every five-minute dispatch created only a new
 * pending successor; only the supported force-cancel settled the run and
 * released the group. This module restores bounded self-healing without
 * weakening the existing scheduled dispatch:
 *
 * 1. It lists the COMPLETE `queued` and `in_progress` run listings of the exact
 *    `.github/workflows/supervisor.yml` workflow on the `sentinel-supervisor`
 *    ref, paginating every page and validating that `total_count` never
 *    changes, that item ids are unique across pages, and that the final count
 *    matches the terminal page. Any malformed, inconsistent or failed read
 *    fails closed: that read can never authorize a cancellation.
 * 2. For each candidate it reads the COMPLETE job listing and requires no
 *    `in_progress` job, no runner attached to an unfinished job (only the
 *    API's explicit no-runner `runner_id` null/0 with a null `runner_name`
 *    counts as unassigned), no queued job waiting less than `STALE_OWNER_MS`,
 *    and no useful transition (run creation/update or job create/start/
 *    complete) inside `STALE_OWNER_MS`. `pending_deployments` must be empty,
 *    so a protected deployment is never cancelled.
 * 3. It selects the OLDEST eligible owner only, re-reads that run and its jobs
 *    immediately before acting, and refuses when status, identity or the
 *    stalled checkpoint moved. A newly created pending successor is churn and
 *    never counts as progress.
 * 4. It force-cancels at most one owner per pass through the supported
 *    `force-cancel` endpoint and awaits the API acknowledgement. A classified
 *    refusal (for example the ancient unmaterialized phantom's 409) is logged,
 *    never retried for that run, and never stops the next candidate or the
 *    ordinary dispatch.
 * 5. Recovery is bounded by a fixed wall-clock budget (`RECOVERY_BUDGET_MS`)
 *    read from the injected clock. Before each recovery request the remaining
 *    budget must still cover the existing whole-request HTTP deadline, so one
 *    already-in-flight request cannot overrun the budget. Once exhausted, no
 *    cancellation is authorized and recovery stops, leaving the rest of the
 *    five-minute job for the ordinary dispatch.
 * 6. It then performs the existing dispatch of `supervisor.yml` at
 *    `sentinel-supervisor` with the same `GH_TOKEN` the dispatcher already
 *    holds, whatever recovery did. The process exit code reports the dispatch
 *    outcome (0 accepted, 1 not accepted).
 *
 * Capability boundary: no new environment variable, secret, CLI flag,
 * dependency, model call, state write or external service. Every read and
 * write goes through the injected `HttpTransportV1`, time comes from the
 * injected `Clock`, and output is concise structured JSON log lines that never
 * echo a response body, credential or `ok` field.
 */

import { type Clock, SystemClock } from "../contracts/ports.ts";
import {
  DEFAULT_HTTP_DEADLINE_MS,
  fetchHttpTransport,
  headerMap,
  type HttpRequestV1,
  type HttpResponseV1,
  type HttpTransportV1,
} from "../github/http.ts";

/** Exact repository the scheduled dispatcher owns. */
export const SUPERVISOR_REPOSITORY = "ubiquity/sentinel";
/** Exact supervisor workflow file name used by the Actions endpoints. */
export const SUPERVISOR_WORKFLOW_FILE = "supervisor.yml";
/** Exact supervisor workflow path every candidate run must match. */
export const SUPERVISOR_WORKFLOW_PATH = ".github/workflows/supervisor.yml";
/** Exact protected ref every candidate run must match. */
export const SUPERVISOR_REF = "sentinel-supervisor";
/** Minimum quiet period with no useful transition before a run is stale. */
export const STALE_OWNER_MS = 30 * 60 * 1000;
/** Per-page bound used for every workflow-run and job listing page. */
export const PER_PAGE = 100;
/** Bounded pagination: a listing without a validated terminal page fails. */
export const MAX_LIST_PAGES = 10;
/** Bounded refusals per pass; at most one acknowledged force-cancel. */
export const MAX_CANCEL_ATTEMPTS = 3;
/**
 * Fixed wall-clock budget for the whole recovery pass, measured from the
 * injected clock. It leaves the rest of the five-minute job for checkout,
 * setup and the ordinary bounded dispatch request.
 */
export const RECOVERY_BUDGET_MS = 90 * 1000;

/**
 * Refusal reason and log event emitted when the fixed recovery budget stops a
 * pass. It is never a cancellation authorization.
 */
const RECOVERY_BUDGET_REASON = "recovery_budget_exhausted";

const API_BASE = "https://api.github.com";
const RUN_LIST_PATH =
  `/repos/${SUPERVISOR_REPOSITORY}/actions/workflows/${SUPERVISOR_WORKFLOW_FILE}/runs`;
const DISPATCH_PATH =
  `/repos/${SUPERVISOR_REPOSITORY}/actions/workflows/${SUPERVISOR_WORKFLOW_FILE}/dispatches`;

/** One structured log line; bounded identifiers and reason codes only. */
export type SupervisorLogV1 = (line: Record<string, unknown>) => void;

/** Injected capabilities of one dispatcher pass. */
export interface SupervisorDispatchDepsV1 {
  /** The GitHub REST transport; production binds the real fetch. */
  http: HttpTransportV1;
  /** Existing dispatcher credential (`GH_TOKEN`); never logged. */
  token: string;
  /** Injected clock; tests freeze it. */
  clock: Clock;
  /** Optional structured log sink; defaults to one JSON line per event. */
  log?: SupervisorLogV1;
}

/** Bounded recovery outcome of one pass. */
export type SupervisorRecoveryV1 =
  | "none"
  | "recovered"
  | "refused"
  | "incomplete";

export interface SupervisorDispatchResultV1 {
  /** 0 when the fixed-ref dispatch was acknowledged, 1 otherwise. */
  exitCode: number;
  dispatched: boolean;
  recovery: SupervisorRecoveryV1;
  /** The single force-cancelled run of this pass, when one was recovered. */
  cancelledRunId: number | null;
}

/** One workflow-run record reduced to the fields recovery reasons about. */
export interface SupervisorRunV1 {
  id: number;
  status: string;
  path: string;
  headBranch: string;
  headSha: string;
  createdAt: string;
  updatedAt: string;
}

/** One job record reduced to the fields recovery reasons about. */
export interface SupervisorJobV1 {
  id: number;
  status: string;
  conclusion: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Assigned runner id; `null` (or `0`) is the API's no-runner value. */
  runnerId: number | null;
  runnerName: string | null;
}

interface CandidateV1 {
  run: SupervisorRunV1;
  /** Latest useful transition observed anywhere in the run. */
  stalledSinceMs: number;
}

type DecodedV1<T> =
  | { valid: true; value: T }
  | { valid: false; reason: string };

interface PageV1<T> {
  items: T[];
  totalCount: number;
}

const accepted = <T>(value: T): DecodedV1<T> => ({ valid: true, value });
const refused = (reason: string): DecodedV1<never> => ({
  valid: false,
  reason,
});

/**
 * Run one bounded recovery pass and then the existing fixed-ref dispatch.
 *
 * The dispatch always runs when a token exists, even when recovery was
 * skipped, refused or incomplete: a stale-run repair never replaces the
 * ordinary scheduling path.
 */
export async function runSupervisorDispatch(
  deps: SupervisorDispatchDepsV1,
): Promise<SupervisorDispatchResultV1> {
  const log = deps.log ?? defaultLog;
  if (deps.token === "") {
    log({ event: "dispatch_pass", outcome: "missing_token", exitCode: 1 });
    return {
      exitCode: 1,
      dispatched: false,
      recovery: "incomplete",
      cancelledRunId: null,
    };
  }

  const startedMs = deps.clock.now();
  const recoveryDeadlineMs = startedMs + RECOVERY_BUDGET_MS;
  const scan = await scanStaleOwners(deps, startedMs, recoveryDeadlineMs, log);
  if (scan.budgetExhausted) logBudgetStop(deps, startedMs, "scan", log);

  let cancelledRunId: number | null = null;
  let attempts = 0;
  for (const candidate of scan.candidates) {
    if (attempts >= MAX_CANCEL_ATTEMPTS) {
      log({ event: "recovery_bounded", attempts });
      break;
    }
    attempts += 1;
    const runId = candidate.run.id;
    const rechecked = await recheckCandidate(
      deps,
      candidate,
      startedMs,
      recoveryDeadlineMs,
    );
    if (!rechecked.valid) {
      log({
        event: "recovery_recheck_refused",
        runId,
        reason: rechecked.reason,
      });
      if (rechecked.reason === RECOVERY_BUDGET_REASON) {
        logBudgetStop(deps, startedMs, "recheck", log);
        break;
      }
      continue;
    }
    const cancelled = await forceCancel(deps, runId, recoveryDeadlineMs);
    if (!cancelled.valid) {
      log({
        event: "recovery_cancel_refused",
        runId,
        reason: cancelled.reason,
      });
      if (cancelled.reason === RECOVERY_BUDGET_REASON) {
        logBudgetStop(deps, startedMs, "cancel", log);
        break;
      }
      continue;
    }
    cancelledRunId = runId;
    log({
      event: "recovery_cancelled",
      runId,
      stalledSince: new Date(candidate.stalledSinceMs).toISOString(),
      http: cancelled.value,
    });
    break;
  }

  const recovery: SupervisorRecoveryV1 = cancelledRunId !== null
    ? "recovered"
    : attempts > 0
    ? "refused"
    : scan.incomplete
    ? "incomplete"
    : "none";

  const dispatched = await dispatchSupervisor(deps);
  const exitCode = dispatched.valid ? 0 : 1;
  log({
    event: "dispatch_pass",
    recovery,
    cancelledRunId,
    scannedRuns: scan.scannedRuns,
    dispatches: dispatched.valid,
    exitCode,
    ...(dispatched.valid ? {} : { dispatchError: dispatched.reason }),
  });
  return {
    exitCode,
    dispatched: dispatched.valid,
    recovery,
    cancelledRunId,
  };
}

interface ScanV1 {
  candidates: CandidateV1[];
  incomplete: boolean;
  /** The fixed recovery budget stopped the scan; nothing is authorized. */
  budgetExhausted: boolean;
  scannedRuns: number;
}

/**
 * Complete paginated scan of both target statuses, then per-candidate complete
 * job and `pending_deployments` reads. A failed run listing fails the whole
 * scan; a failed candidate read only removes that candidate's authorization.
 * When the recovery budget runs out mid-scan nothing is authorized at all,
 * because the oldest owner is no longer provably known.
 */
async function scanStaleOwners(
  deps: SupervisorDispatchDepsV1,
  nowMs: number,
  recoveryDeadlineMs: number,
  log: SupervisorLogV1,
): Promise<ScanV1> {
  const exhausted = (): ScanV1 => ({
    candidates: [],
    incomplete: true,
    budgetExhausted: true,
    scannedRuns: 0,
  });
  const runs: SupervisorRunV1[] = [];
  for (const status of ["queued", "in_progress"]) {
    const listed = await listAllPages(
      deps,
      RUN_LIST_PATH,
      { branch: SUPERVISOR_REF, status },
      "workflow_runs",
      decodeRun,
      recoveryDeadlineMs,
    );
    if (!listed.valid) {
      log({ event: "recovery_scan_incomplete", status, reason: listed.reason });
      if (listed.reason === RECOVERY_BUDGET_REASON) return exhausted();
      return {
        candidates: [],
        incomplete: true,
        budgetExhausted: false,
        scannedRuns: 0,
      };
    }
    runs.push(...listed.value.items);
  }

  const candidates: CandidateV1[] = [];
  let incomplete = false;
  for (const run of runs) {
    const jobs = await listAllPages(
      deps,
      `/repos/${SUPERVISOR_REPOSITORY}/actions/runs/${run.id}/jobs`,
      {},
      "jobs",
      decodeJob,
      recoveryDeadlineMs,
    );
    if (!jobs.valid) {
      log({
        event: "recovery_candidate_skipped",
        runId: run.id,
        reason: jobs.reason,
      });
      if (jobs.reason === RECOVERY_BUDGET_REASON) return exhausted();
      incomplete = true;
      continue;
    }
    const evaluated = evaluateRun(run, jobs.value.items, nowMs);
    if (!evaluated.valid) {
      log({
        event: "recovery_candidate_rejected",
        runId: run.id,
        reason: evaluated.reason,
      });
      continue;
    }
    const pending = await readPendingDeployments(
      deps,
      run.id,
      recoveryDeadlineMs,
    );
    if (!pending.valid) {
      log({
        event: "recovery_candidate_skipped",
        runId: run.id,
        reason: pending.reason,
      });
      if (pending.reason === RECOVERY_BUDGET_REASON) return exhausted();
      incomplete = true;
      continue;
    }
    if (!pending.value.clear) {
      log({
        event: "recovery_candidate_rejected",
        runId: run.id,
        reason: "pending_deployment",
      });
      continue;
    }
    candidates.push(evaluated.value);
  }
  candidates.sort((left, right) =>
    left.stalledSinceMs - right.stalledSinceMs || left.run.id - right.run.id
  );
  return {
    candidates,
    incomplete,
    budgetExhausted: false,
    scannedRuns: runs.length,
  };
}

/**
 * Re-read the selected run and its complete job listing immediately before
 * acting. Any identity, status or stalled-checkpoint movement refuses the
 * cancellation for this pass.
 */
async function recheckCandidate(
  deps: SupervisorDispatchDepsV1,
  candidate: CandidateV1,
  nowMs: number,
  recoveryDeadlineMs: number,
): Promise<DecodedV1<CandidateV1>> {
  const runId = candidate.run.id;
  const read = await readJson(
    deps,
    apiRequest(
      deps.token,
      "GET",
      apiUrl(`/repos/${SUPERVISOR_REPOSITORY}/actions/runs/${runId}`),
    ),
    recoveryDeadlineMs,
  );
  if (!read.valid) return read;
  const fresh = decodeRun(read.value);
  if (!fresh.valid) return fresh;
  const run = fresh.value;
  if (
    run.id !== candidate.run.id ||
    run.path !== candidate.run.path ||
    run.headBranch !== candidate.run.headBranch ||
    run.headSha !== candidate.run.headSha ||
    run.status !== candidate.run.status ||
    run.createdAt !== candidate.run.createdAt
  ) {
    return refused("identity_changed");
  }
  const jobs = await listAllPages(
    deps,
    `/repos/${SUPERVISOR_REPOSITORY}/actions/runs/${runId}/jobs`,
    {},
    "jobs",
    decodeJob,
    recoveryDeadlineMs,
  );
  if (!jobs.valid) return jobs;
  const evaluated = evaluateRun(run, jobs.value.items, nowMs);
  if (!evaluated.valid) return evaluated;
  if (evaluated.value.stalledSinceMs !== candidate.stalledSinceMs) {
    return refused("state_changed");
  }
  const pending = await readPendingDeployments(
    deps,
    runId,
    recoveryDeadlineMs,
  );
  if (!pending.valid) return pending;
  if (!pending.value.clear) return refused("pending_deployment");
  return evaluated;
}

/** Pure eligibility decision for one complete run/job snapshot. */
function evaluateRun(
  run: SupervisorRunV1,
  jobs: SupervisorJobV1[],
  nowMs: number,
): DecodedV1<CandidateV1> {
  if (run.path !== SUPERVISOR_WORKFLOW_PATH) {
    return refused("workflow_mismatch");
  }
  if (run.headBranch !== SUPERVISOR_REF) return refused("ref_mismatch");
  if (run.status !== "queued" && run.status !== "in_progress") {
    return refused("status_not_stalled");
  }
  const createdAtMs = Date.parse(run.createdAt);
  const updatedAtMs = Date.parse(run.updatedAt);
  if (Number.isNaN(createdAtMs) || Number.isNaN(updatedAtMs)) {
    return refused("timestamp_invalid");
  }
  let stalledSinceMs = Math.max(createdAtMs, updatedAtMs);
  for (const job of jobs) {
    if (job.status === "in_progress") return refused("active_job");
    if (job.status !== "completed" && job.status !== "queued") {
      return refused("unknown_job_status");
    }
    if (job.status !== "completed") {
      // An unfinished job counts as unassigned only with the API's explicit
      // no-runner id and no runner name. A positive id or any name means a
      // runner may be (or is) attached, so the run is never cancelled.
      if (job.runnerId !== null && job.runnerId !== 0) {
        return refused("active_runner");
      }
      if (job.runnerName !== null) return refused("active_runner");
    }
    const createdMs = Date.parse(job.createdAt);
    const startedMs = job.startedAt === null ? null : Date.parse(job.startedAt);
    const completedMs = job.completedAt === null
      ? null
      : Date.parse(job.completedAt);
    if (
      Number.isNaN(createdMs) ||
      (startedMs !== null && Number.isNaN(startedMs)) ||
      (completedMs !== null && Number.isNaN(completedMs))
    ) {
      return refused("timestamp_invalid");
    }
    for (const moment of [createdMs, startedMs, completedMs]) {
      if (moment !== null && moment > stalledSinceMs) stalledSinceMs = moment;
    }
    if (job.status === "queued") {
      const waitingSince = startedMs ?? createdMs;
      if (nowMs - waitingSince < STALE_OWNER_MS) {
        return refused("recent_queued_job");
      }
    }
  }
  if (nowMs - stalledSinceMs < STALE_OWNER_MS) {
    return refused("recent_transition");
  }
  return accepted({ run, stalledSinceMs });
}

/**
 * Complete paginated listing: every page is read until a terminal page, every
 * page must report the same `total_count`, item ids must be unique across
 * pages, and the final count must equal the collected item count. Any
 * inconsistent, duplicated, overlong or unterminated listing fails closed, so
 * an omitted or hidden item can never be authorized away.
 */
async function listAllPages<T extends { id: number }>(
  deps: SupervisorDispatchDepsV1,
  path: string,
  query: Record<string, string>,
  collection: string,
  decodeItem: (raw: unknown) => DecodedV1<T>,
  recoveryDeadlineMs: number,
): Promise<DecodedV1<PageV1<T>>> {
  const items: T[] = [];
  const seenIds = new Set<number>();
  let totalCount = -1;
  for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
    const read = await readJson(
      deps,
      apiRequest(
        deps.token,
        "GET",
        apiUrl(path, {
          ...query,
          per_page: String(PER_PAGE),
          page: String(page),
        }),
      ),
      recoveryDeadlineMs,
    );
    if (!read.valid) return read;
    const decoded = decodePage(read.value, collection, decodeItem);
    if (!decoded.valid) return decoded;
    if (totalCount >= 0 && decoded.value.totalCount !== totalCount) {
      return refused("pagination_total_changed");
    }
    totalCount = decoded.value.totalCount;
    for (const item of decoded.value.items) {
      if (seenIds.has(item.id)) return refused("pagination_duplicate");
      seenIds.add(item.id);
      items.push(item);
    }
    if (items.length > totalCount) return refused("pagination_inconsistent");
    if (decoded.value.items.length < PER_PAGE) {
      if (items.length !== totalCount) return refused("pagination_incomplete");
      return accepted({ items, totalCount });
    }
  }
  return refused("pagination_incomplete");
}

/** Read one run's `pending_deployments`; a protected deployment blocks it. */
async function readPendingDeployments(
  deps: SupervisorDispatchDepsV1,
  runId: number,
  recoveryDeadlineMs: number,
): Promise<DecodedV1<{ clear: boolean }>> {
  const read = await readJson(
    deps,
    apiRequest(
      deps.token,
      "GET",
      apiUrl(
        `/repos/${SUPERVISOR_REPOSITORY}/actions/runs/${runId}/pending_deployments`,
      ),
    ),
    recoveryDeadlineMs,
  );
  if (!read.valid) return read;
  if (!Array.isArray(read.value)) {
    return refused("malformed_pending_deployments");
  }
  return accepted({ clear: read.value.length === 0 });
}

/** The supported force-cancel call; a non-2xx is a classified refusal. */
async function forceCancel(
  deps: SupervisorDispatchDepsV1,
  runId: number,
  recoveryDeadlineMs: number,
): Promise<DecodedV1<number>> {
  if (recoveryBudgetExhausted(deps, recoveryDeadlineMs)) {
    return refused(RECOVERY_BUDGET_REASON);
  }
  let response: HttpResponseV1;
  try {
    response = await deps.http(
      apiRequest(
        deps.token,
        "POST",
        apiUrl(
          `/repos/${SUPERVISOR_REPOSITORY}/actions/runs/${runId}/force-cancel`,
        ),
      ),
    );
  } catch {
    return refused("transport_error");
  }
  if (response.status >= 200 && response.status < 300) {
    return accepted(response.status);
  }
  return refused(cancelRefusalReason(response.status));
}

/** Stable refusal classes; no response body or header value is echoed. */
function cancelRefusalReason(status: number): string {
  if (status === 409) return "refused_not_queued";
  if (status === 403) return "refused_forbidden";
  if (status === 404) return "refused_not_found";
  return `http_${status}`;
}

/** The existing fixed-ref dispatch, unchanged in identity and credential. */
async function dispatchSupervisor(
  deps: SupervisorDispatchDepsV1,
): Promise<DecodedV1<number>> {
  let response: HttpResponseV1;
  try {
    response = await deps.http(
      apiRequest(
        deps.token,
        "POST",
        apiUrl(DISPATCH_PATH),
        JSON.stringify({ ref: SUPERVISOR_REF }),
      ),
    );
  } catch {
    return refused("transport_error");
  }
  if (response.status >= 200 && response.status < 300) {
    return accepted(response.status);
  }
  return refused(`http_${response.status}`);
}

function decodePage<T>(
  value: unknown,
  collection: string,
  decodeItem: (raw: unknown) => DecodedV1<T>,
): DecodedV1<PageV1<T>> {
  if (!isRecord(value)) return refused("malformed_page");
  const total = value["total_count"];
  if (
    typeof total !== "number" || !Number.isSafeInteger(total) || total < 0
  ) {
    return refused("malformed_total_count");
  }
  const list = value[collection];
  if (!Array.isArray(list)) return refused("malformed_page");
  const items: T[] = [];
  for (const raw of list) {
    const decoded = decodeItem(raw);
    if (!decoded.valid) return decoded;
    items.push(decoded.value);
  }
  return accepted({ items, totalCount: total });
}

function decodeRun(raw: unknown): DecodedV1<SupervisorRunV1> {
  if (!isRecord(raw)) return refused("malformed_run");
  const id = raw["id"];
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    return refused("malformed_run_id");
  }
  const status = raw["status"];
  if (typeof status !== "string" || status === "") {
    return refused("malformed_run_status");
  }
  const path = raw["path"];
  if (typeof path !== "string" || path === "") {
    return refused("malformed_run_path");
  }
  const headBranch = raw["head_branch"];
  if (typeof headBranch !== "string" || headBranch === "") {
    return refused("malformed_run_branch");
  }
  const headSha = raw["head_sha"];
  if (typeof headSha !== "string" || headSha === "") {
    return refused("malformed_run_sha");
  }
  const createdAt = raw["created_at"];
  const updatedAt = raw["updated_at"];
  if (
    typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt)) ||
    typeof updatedAt !== "string" || Number.isNaN(Date.parse(updatedAt))
  ) {
    return refused("malformed_run_timestamp");
  }
  return accepted({
    id,
    status,
    path,
    headBranch,
    headSha,
    createdAt,
    updatedAt,
  });
}

function decodeJob(raw: unknown): DecodedV1<SupervisorJobV1> {
  if (!isRecord(raw)) return refused("malformed_job");
  const id = raw["id"];
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    return refused("malformed_job_id");
  }
  const status = raw["status"];
  if (typeof status !== "string" || status === "") {
    return refused("malformed_job_status");
  }
  const createdAt = raw["created_at"];
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    return refused("malformed_job_timestamp");
  }
  const conclusion = optionalString(raw["conclusion"]);
  const startedAt = optionalString(raw["started_at"]);
  const completedAt = optionalString(raw["completed_at"]);
  // Runner assignment must be explicit: the real API returns `runner_id` as a
  // non-negative integer or null, and `runner_name` as a string or null. A
  // missing or malformed field is never treated as "no runner".
  const runnerId = nullableRunnerId(raw["runner_id"]);
  const runnerName = nullableString(raw["runner_name"]);
  if (
    conclusion === undefined ||
    startedAt === undefined ||
    completedAt === undefined ||
    runnerId === undefined ||
    runnerName === undefined
  ) {
    return refused("malformed_job_field");
  }
  return accepted({
    id,
    status,
    conclusion,
    createdAt,
    startedAt,
    completedAt,
    runnerId,
    runnerName,
  });
}

/** `undefined` means missing or malformed; `null` is the API's no-runner. */
function nullableRunnerId(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  return undefined;
}

/** `undefined` means missing or malformed; `null` is the API's explicit absence. */
function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
  return undefined;
}

/** `undefined` means malformed; `null` is the API's explicit absence. */
function optionalString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apiUrl(path: string, query: Record<string, string> = {}): string {
  const url = new URL(`${API_BASE}${path}`);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

function apiRequest(
  token: string,
  method: "GET" | "POST",
  url: string,
  body: string | null = null,
): HttpRequestV1 {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "sentinel-supervisor-dispatch",
    "x-github-api-version": "2022-11-28",
  };
  if (body !== null) headers["content-type"] = "application/json";
  return { method, url, headers: headerMap(headers), body };
}

async function readJson(
  deps: SupervisorDispatchDepsV1,
  request: HttpRequestV1,
  recoveryDeadlineMs: number,
): Promise<DecodedV1<unknown>> {
  if (recoveryBudgetExhausted(deps, recoveryDeadlineMs)) {
    return refused(RECOVERY_BUDGET_REASON);
  }
  let response: HttpResponseV1;
  try {
    response = await deps.http(request);
  } catch {
    return refused("transport_error");
  }
  if (response.status !== 200) return refused(`http_${response.status}`);
  try {
    return accepted(JSON.parse(response.bodyText) as unknown);
  } catch {
    return refused("malformed_json");
  }
}

/**
 * True once another recovery request could push the pass past its fixed
 * budget. The existing whole-request HTTP deadline is the worst-case overshoot
 * of one request already in flight, so that much headroom stays reserved.
 */
function recoveryBudgetExhausted(
  deps: SupervisorDispatchDepsV1,
  recoveryDeadlineMs: number,
): boolean {
  return deps.clock.now() + DEFAULT_HTTP_DEADLINE_MS > recoveryDeadlineMs;
}

/** One concise line when the fixed budget ended recovery for this pass. */
function logBudgetStop(
  deps: SupervisorDispatchDepsV1,
  startedMs: number,
  phase: string,
  log: SupervisorLogV1,
): void {
  log({
    event: RECOVERY_BUDGET_REASON,
    phase,
    elapsedMs: deps.clock.now() - startedMs,
    budgetMs: RECOVERY_BUDGET_MS,
  });
}

function defaultLog(line: Record<string, unknown>): void {
  console.log(JSON.stringify(line));
}

if (import.meta.main) {
  const result = await runSupervisorDispatch({
    http: fetchHttpTransport(),
    token: Deno.env.get("GH_TOKEN") ?? "",
    clock: new SystemClock(),
  });
  Deno.exit(result.exitCode);
}
