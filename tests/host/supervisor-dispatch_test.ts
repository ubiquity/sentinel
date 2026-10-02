/**
 * Behavioral tests for the bounded supervisor stale-run recovery dispatcher.
 *
 * These tests drive the REAL `runSupervisorDispatch` entrypoint over a
 * scripted in-memory GitHub REST transport with a frozen clock: no network,
 * no sleep, no model, no token and no GitHub write ever leaves this process.
 * The fake serves complete paginated run/job listings and records the exact
 * request order, so the recovery decision (never a helper's internal state)
 * is what is asserted:
 *
 * - a stalled queued finalizer is force-cancelled once and then the fixed ref
 *   is dispatched; the acknowledgement is ordered before the dispatch;
 * - a genuinely running job is never cancelled, a recent queue is never
 *   cancelled, and a protected pending deployment blocks cancellation;
 * - identity movement between scan and re-check refuses the cancellation;
 * - an incomplete paginated listing can never authorize a cancellation;
 * - an active job on a LATER page blocks cancellation;
 * - the 18-day unmaterialized phantom's 409 is logged as a bounded refusal and
 *   neither starves the real queued owner nor halts the ordinary dispatch;
 * - at most one force-cancel is acknowledged per pass;
 * - the exit code reports the dispatch outcome, and a missing token fails
 *   closed before any request.
 */
import assert from "node:assert/strict";

import type {
  HttpRequestV1,
  HttpResponseV1,
  HttpTransportV1,
} from "../../src/github/http.ts";
import {
  PER_PAGE,
  RECOVERY_BUDGET_MS,
  runSupervisorDispatch,
  SUPERVISOR_REF,
  SUPERVISOR_WORKFLOW_PATH,
  type SupervisorDispatchResultV1,
} from "../../src/host/supervisor-dispatch.ts";

const REPO = "/repos/ubiquity/sentinel";
const RUNS_PATH = `${REPO}/actions/workflows/supervisor.yml/runs`;
const DISPATCH_PATH = `${REPO}/actions/workflows/supervisor.yml/dispatches`;
const NOW_MS = Date.parse("2026-10-02T09:00:00Z");
/** Wedged run 36862385999: last useful transition 2026-10-01T12:35:52Z. */
const STALE_CREATED_ISO = "2026-10-01T12:32:00Z";
const STALE_ISO = "2026-10-01T12:35:52Z";
/** Four minutes before the frozen now: a fresh queue, not a stall. */
const RECENT_ISO = "2026-10-02T08:56:00Z";
const WEDGED_RUN = 36_862_385_999;
/** Ancient queued run 34874909140 with no jobs since 2026-09-14. */
const PHANTOM_RUN = 34_874_909_140;
const HEAD_SHA = "7e10afe36079386811be4b964c5f748b48b64f85";

function jsonResponse(status: number, body: unknown): HttpResponseV1 {
  return {
    status,
    headers: new Headers(),
    bodyText: JSON.stringify(body),
  };
}

/** The complete job history of the real wedged run (2026-10-01 snapshot). */
function wedgedJobs(): unknown[] {
  return [
    jobItem({
      id: 110370601087,
      created_at: "2026-10-01T12:34:57Z",
      started_at: "2026-10-01T12:35:01Z",
      completed_at: "2026-10-01T12:35:37Z",
      runner_id: 1000047132,
      runner_name: "GitHub Actions 1000047132",
    }),
    jobItem({
      id: 110370856112,
      created_at: "2026-10-01T12:35:38Z",
      started_at: "2026-10-01T12:35:41Z",
      completed_at: STALE_ISO,
      runner_id: 1000047133,
      runner_name: "GitHub Actions 1000047133",
    }),
    // The real wedged finalize: queued with an explicit null runner.
    jobItem({
      id: 110370944847,
      status: "queued",
      conclusion: null,
      created_at: STALE_ISO,
      started_at: STALE_ISO,
      completed_at: null,
      runner_id: null,
      runner_name: null,
    }),
    // The real skipped repair job also carries explicit null runner fields.
    jobItem({
      id: 110370946653,
      conclusion: "skipped",
      created_at: STALE_ISO,
      started_at: STALE_ISO,
      completed_at: STALE_ISO,
      runner_id: null,
      runner_name: null,
    }),
  ];
}

/** A quiet run whose only queued job has waited since the given instant. */
function quietJobs(atIso: string): unknown[] {
  return [
    jobItem({
      id: 5,
      created_at: atIso,
      started_at: atIso,
      completed_at: atIso,
    }),
    jobItem({
      id: 6,
      status: "queued",
      conclusion: null,
      created_at: atIso,
      started_at: atIso,
      completed_at: null,
      runner_id: null,
      runner_name: null,
    }),
  ];
}

function runItem(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: WEDGED_RUN,
    status: "queued",
    conclusion: null,
    path: SUPERVISOR_WORKFLOW_PATH,
    head_branch: SUPERVISOR_REF,
    head_sha: HEAD_SHA,
    created_at: STALE_CREATED_ISO,
    updated_at: STALE_ISO,
    ...overrides,
  };
}

function jobItem(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1,
    status: "completed",
    conclusion: "success",
    created_at: STALE_ISO,
    started_at: STALE_ISO,
    completed_at: STALE_ISO,
    runner_id: 1000047132,
    runner_name: "GitHub Actions 1000047132",
    ...overrides,
  };
}

/**
 * Scripted GitHub REST: exact routes, complete pagination shaped like the real
 * API (`total_count` plus a `per_page`/`page` slice), and recorded call order.
 */
class FakeApi {
  readonly calls: HttpRequestV1[] = [];
  /** Run listing items keyed by the `status` query value. */
  readonly runList = new Map<string, unknown[]>();
  /** Overrides the run listing's reported `total_count`. */
  readonly runTotal = new Map<string, number>();
  /** Complete job items per run id, sliced into `PER_PAGE` pages. */
  readonly jobs = new Map<number, unknown[]>();
  /** Overrides the job listing's reported `total_count`. */
  readonly jobTotal = new Map<number, number>();
  /** Per-page override keyed `<runId>:<page>` for a changing `total_count`. */
  readonly jobTotalByPage = new Map<string, number>();
  /** Fresh run record returned by the pre-action re-read. */
  readonly runById = new Map<number, unknown>();
  /** `pending_deployments` payload per run id; defaults to empty. */
  readonly pending = new Map<number, unknown>();
  /** `force-cancel` response status per run id; defaults to 202. */
  readonly cancelStatus = new Map<number, number>();
  dispatchStatus = 204;

  readonly transport: HttpTransportV1 = (request) => {
    this.calls.push(request);
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "POST" && path === DISPATCH_PATH) {
      return Promise.resolve(jsonResponse(this.dispatchStatus, {}));
    }
    const cancel = /\/actions\/runs\/(\d+)\/force-cancel$/.exec(path);
    if (request.method === "POST" && cancel !== null) {
      const id = Number(cancel[1]);
      return Promise.resolve(
        jsonResponse(this.cancelStatus.get(id) ?? 202, {}),
      );
    }
    if (request.method === "GET" && path === RUNS_PATH) {
      const status = url.searchParams.get("status") ?? "";
      const items = this.runList.get(status) ?? [];
      return Promise.resolve(
        jsonResponse(200, {
          total_count: this.runTotal.get(status) ?? items.length,
          workflow_runs: pageSlice(items, url),
        }),
      );
    }
    const jobs = /\/actions\/runs\/(\d+)\/jobs$/.exec(path);
    if (request.method === "GET" && jobs !== null) {
      const id = Number(jobs[1]);
      const items = this.jobs.get(id) ?? [];
      const page = url.searchParams.get("page") ?? "1";
      return Promise.resolve(
        jsonResponse(200, {
          total_count: this.jobTotalByPage.get(`${id}:${page}`) ??
            this.jobTotal.get(id) ?? items.length,
          jobs: pageSlice(items, url),
        }),
      );
    }
    const pending = /\/actions\/runs\/(\d+)\/pending_deployments$/.exec(path);
    if (request.method === "GET" && pending !== null) {
      const id = Number(pending[1]);
      return Promise.resolve(
        jsonResponse(200, this.pending.get(id) ?? []),
      );
    }
    const run = /\/actions\/runs\/(\d+)$/.exec(path);
    if (request.method === "GET" && run !== null) {
      const item = this.runById.get(Number(run[1]));
      return Promise.resolve(
        item === undefined ? jsonResponse(404, {}) : jsonResponse(200, item),
      );
    }
    return Promise.reject(new Error("unscripted request"));
  };

  cancelCalls(): HttpRequestV1[] {
    return this.calls.filter((call) =>
      call.method === "POST" && call.url.includes("/force-cancel")
    );
  }

  dispatchCalls(): HttpRequestV1[] {
    return this.calls.filter((call) =>
      call.method === "POST" && new URL(call.url).pathname === DISPATCH_PATH
    );
  }
}

function pageSlice(items: unknown[], url: URL): unknown[] {
  const page = Number(url.searchParams.get("page") ?? "1");
  const start = (page - 1) * PER_PAGE;
  return items.slice(start, start + PER_PAGE);
}

/**
 * One dispatcher pass over the scripted API. `advanceMsPerRequest` models slow
 * GitHub reads: the injected clock advances before each request is served, so
 * elapsed recovery time is real to the budget check and tests never sleep.
 */
function makePass(api: FakeApi, advanceMsPerRequest = 0) {
  const logs: Record<string, unknown>[] = [];
  let nowMs = NOW_MS;
  const clock = { now: () => nowMs };
  const transport: HttpTransportV1 = advanceMsPerRequest === 0
    ? api.transport
    : (request) => {
      nowMs += advanceMsPerRequest;
      return api.transport(request);
    };
  return {
    logs,
    clock,
    run: (): Promise<SupervisorDispatchResultV1> =>
      runSupervisorDispatch({
        http: transport,
        token: "dummy-token",
        clock,
        log: (line) => logs.push(line),
      }),
    logFor: (event: string): Record<string, unknown> | undefined =>
      logs.find((line) => line.event === event),
  };
}

/** The real 2026-10-01 wedge, scripted for scan and pre-action re-read. */
function wedgeApi(): FakeApi {
  const api = new FakeApi();
  api.runList.set("queued", [runItem()]);
  api.jobs.set(WEDGED_RUN, wedgedJobs());
  api.runById.set(WEDGED_RUN, runItem());
  api.pending.set(WEDGED_RUN, []);
  return api;
}

Deno.test("supervisor dispatch: stalled queued finalizer recovers, then the fixed ref is dispatched", async () => {
  const api = wedgeApi();
  const pass = makePass(api);
  const result = await pass.run();
  assert.deepEqual(result, {
    exitCode: 0,
    dispatched: true,
    recovery: "recovered",
    cancelledRunId: WEDGED_RUN,
  });
  const cancelled = api.cancelCalls();
  assert.equal(cancelled.length, 1);
  assert.equal(
    new URL(cancelled[0].url).pathname,
    `${REPO}/actions/runs/${WEDGED_RUN}/force-cancel`,
  );
  assert.equal(cancelled[0].body, null);
  const dispatched = api.dispatchCalls();
  assert.equal(dispatched.length, 1);
  assert.deepEqual(JSON.parse(dispatched[0].body ?? ""), {
    ref: SUPERVISOR_REF,
  });
  assert.ok(
    api.calls.indexOf(cancelled[0]) < api.calls.indexOf(dispatched[0]),
    "the force-cancel acknowledgement precedes the dispatch",
  );
});

Deno.test("supervisor dispatch: a genuinely running repair job is never cancelled", async () => {
  const api = new FakeApi();
  api.runList.set("in_progress", [
    runItem({
      id: 99,
      status: "in_progress",
      created_at: "2026-10-02T06:00:00Z",
      updated_at: "2026-10-02T06:00:05Z",
    }),
  ]);
  api.jobs.set(99, [
    jobItem({
      id: 11,
      status: "in_progress",
      conclusion: null,
      created_at: "2026-10-02T06:00:00Z",
      started_at: "2026-10-02T06:00:05Z",
      completed_at: null,
      runner_id: 6001,
      runner_name: "runner-1",
    }),
  ]);
  const pass = makePass(api);
  const result = await pass.run();
  assert.equal(result.recovery, "none");
  assert.equal(result.cancelledRunId, null);
  assert.equal(api.cancelCalls().length, 0);
  assert.equal(result.dispatched, true);
});

Deno.test("supervisor dispatch: a newly queued successor is never cancelled", async () => {
  const api = new FakeApi();
  api.runList.set("queued", [
    runItem({ id: 77, created_at: RECENT_ISO, updated_at: RECENT_ISO }),
  ]);
  api.jobs.set(77, [
    jobItem({
      id: 21,
      status: "queued",
      conclusion: null,
      created_at: RECENT_ISO,
      started_at: RECENT_ISO,
      completed_at: null,
      runner_id: null,
      runner_name: null,
    }),
  ]);
  const pass = makePass(api);
  const result = await pass.run();
  assert.equal(result.recovery, "none");
  assert.equal(api.cancelCalls().length, 0);
  assert.equal(result.dispatched, true);
});

Deno.test("supervisor dispatch: identity movement during the re-check refuses the cancellation", async () => {
  const api = wedgeApi();
  api.runById.set(WEDGED_RUN, runItem({ head_sha: "a".repeat(40) }));
  const pass = makePass(api);
  const result = await pass.run();
  assert.equal(result.recovery, "refused");
  assert.equal(result.cancelledRunId, null);
  assert.equal(api.cancelCalls().length, 0);
  assert.equal(result.dispatched, true);
  assert.equal(
    pass.logFor("recovery_recheck_refused")?.reason,
    "identity_changed",
  );
});

Deno.test("supervisor dispatch: incomplete pagination can never authorize a cancellation", async () => {
  // (a) The run listing reports more runs than its terminal page returned.
  const runsIncomplete = new FakeApi();
  runsIncomplete.runList.set("queued", [runItem()]);
  runsIncomplete.runTotal.set("queued", 2);
  runsIncomplete.jobs.set(WEDGED_RUN, wedgedJobs());
  runsIncomplete.runById.set(WEDGED_RUN, runItem());
  const runsPass = makePass(runsIncomplete);
  const runsResult = await runsPass.run();
  assert.equal(runsResult.recovery, "incomplete");
  assert.equal(runsResult.dispatched, true);
  assert.equal(runsIncomplete.cancelCalls().length, 0);

  // (b) The stale candidate's job listing is incomplete.
  const jobsIncomplete = new FakeApi();
  jobsIncomplete.runList.set("queued", [runItem()]);
  jobsIncomplete.jobs.set(WEDGED_RUN, [wedgedJobs()[0]]);
  jobsIncomplete.jobTotal.set(WEDGED_RUN, 3);
  jobsIncomplete.runById.set(WEDGED_RUN, runItem());
  const jobsPass = makePass(jobsIncomplete);
  const jobsResult = await jobsPass.run();
  assert.equal(jobsResult.recovery, "incomplete");
  assert.equal(jobsResult.dispatched, true);
  assert.equal(jobsIncomplete.cancelCalls().length, 0);
});

Deno.test("supervisor dispatch: an active job on a later page blocks the cancellation", async () => {
  const api = new FakeApi();
  api.runList.set("queued", [runItem()]);
  const jobs = Array.from(
    { length: PER_PAGE },
    (_, index) => jobItem({ id: 100 + index }),
  );
  jobs.push(jobItem({
    id: 999,
    status: "in_progress",
    conclusion: null,
    created_at: "2026-10-02T08:00:00Z",
    started_at: "2026-10-02T08:00:00Z",
    completed_at: null,
    runner_id: 6002,
    runner_name: "runner-2",
  }));
  api.jobs.set(WEDGED_RUN, jobs);
  api.runById.set(WEDGED_RUN, runItem());
  const pass = makePass(api);
  const result = await pass.run();
  assert.equal(result.recovery, "none");
  assert.equal(api.cancelCalls().length, 0);
  assert.equal(result.dispatched, true);
  assert.ok(
    api.calls.some((call) => call.url.includes("page=2")),
    "the complete job listing reached its second page",
  );
  assert.equal(
    pass.logFor("recovery_candidate_rejected")?.reason,
    "active_job",
  );
});

Deno.test("supervisor dispatch: an unfinished job with an assigned runner is never cancelled", async () => {
  // (a) Queued with a positive runner_id while runner_name is null.
  const assigned = wedgeApi();
  assigned.jobs.set(WEDGED_RUN, [
    ...wedgedJobs(),
    jobItem({
      id: 7,
      status: "queued",
      conclusion: null,
      created_at: STALE_ISO,
      started_at: STALE_ISO,
      completed_at: null,
      runner_id: 424242,
      runner_name: null,
    }),
  ]);
  const assignedPass = makePass(assigned);
  const assignedResult = await assignedPass.run();
  assert.equal(assignedResult.cancelledRunId, null);
  assert.equal(assigned.cancelCalls().length, 0);
  assert.equal(assignedResult.dispatched, true);

  // (b) Queued with the runner fields omitted entirely: not "unassigned".
  const missing = wedgeApi();
  missing.jobs.set(WEDGED_RUN, [
    ...wedgedJobs(),
    {
      id: 8,
      status: "queued",
      conclusion: null,
      created_at: STALE_ISO,
      started_at: STALE_ISO,
      completed_at: null,
    },
  ]);
  const missingPass = makePass(missing);
  const missingResult = await missingPass.run();
  assert.equal(missingResult.cancelledRunId, null);
  assert.equal(missing.cancelCalls().length, 0);
  assert.equal(missingResult.dispatched, true);
});

Deno.test("supervisor dispatch: duplicate job ids across pages can never authorize a cancellation", async () => {
  const api = new FakeApi();
  api.runList.set("queued", [runItem()]);
  const firstPage = Array.from(
    { length: PER_PAGE },
    (_, index) => jobItem({ id: 100 + index }),
  );
  const repeated = firstPage.slice(PER_PAGE / 2).map((job) => ({ ...job }));
  api.jobs.set(WEDGED_RUN, [...firstPage, ...repeated]);
  api.runById.set(WEDGED_RUN, runItem());
  const pass = makePass(api);
  const result = await pass.run();
  assert.equal(result.cancelledRunId, null);
  assert.equal(api.cancelCalls().length, 0);
  assert.equal(result.dispatched, true);
  assert.ok(
    api.calls.some((call) => call.url.includes("page=2")),
    "the duplicated ids were only visible on the second page",
  );
});

Deno.test("supervisor dispatch: a changed total_count across pages can never authorize a cancellation", async () => {
  const api = new FakeApi();
  api.runList.set("queued", [runItem()]);
  const firstPageTotal = PER_PAGE + 50;
  api.jobs.set(
    WEDGED_RUN,
    Array.from(
      { length: PER_PAGE + 51 },
      (_, index) => jobItem({ id: 500 + index }),
    ),
  );
  api.jobTotalByPage.set(`${WEDGED_RUN}:1`, firstPageTotal);
  api.jobTotalByPage.set(`${WEDGED_RUN}:2`, firstPageTotal + 1);
  api.runById.set(WEDGED_RUN, runItem());
  const pass = makePass(api);
  const result = await pass.run();
  assert.equal(result.cancelledRunId, null);
  assert.equal(api.cancelCalls().length, 0);
  assert.equal(result.dispatched, true);
});

Deno.test("supervisor dispatch: the phantom 409 neither starves the real owner nor halts dispatch", async () => {
  const api = new FakeApi();
  const phantom = runItem({
    id: PHANTOM_RUN,
    head_sha: "2a24c4d9" + "0".repeat(32),
    created_at: "2026-09-14T17:27:00Z",
    updated_at: "2026-09-14T17:27:00Z",
  });
  api.runList.set("queued", [phantom, runItem()]);
  api.jobs.set(PHANTOM_RUN, []);
  api.runById.set(PHANTOM_RUN, phantom);
  api.pending.set(PHANTOM_RUN, []);
  api.cancelStatus.set(PHANTOM_RUN, 409);
  api.jobs.set(WEDGED_RUN, wedgedJobs());
  api.runById.set(WEDGED_RUN, runItem());
  const pass = makePass(api);
  const result = await pass.run();
  assert.equal(result.recovery, "recovered");
  assert.equal(result.cancelledRunId, WEDGED_RUN);
  const cancelled = api.cancelCalls();
  assert.equal(cancelled.length, 2);
  assert.equal(
    new URL(cancelled[0].url).pathname,
    `${REPO}/actions/runs/${PHANTOM_RUN}/force-cancel`,
  );
  assert.equal(
    new URL(cancelled[1].url).pathname,
    `${REPO}/actions/runs/${WEDGED_RUN}/force-cancel`,
  );
  assert.deepEqual(pass.logFor("recovery_cancel_refused"), {
    event: "recovery_cancel_refused",
    runId: PHANTOM_RUN,
    reason: "refused_not_queued",
  });
  assert.equal(api.dispatchCalls().length, 1);
  assert.equal(result.exitCode, 0);
});

Deno.test("supervisor dispatch: at most one force-cancel is acknowledged per pass", async () => {
  const api = new FakeApi();
  const older = runItem({
    id: 1,
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-01T10:05:00Z",
  });
  const newer = runItem({
    id: 2,
    created_at: "2026-10-01T11:00:00Z",
    updated_at: "2026-10-01T11:05:00Z",
  });
  api.runList.set("queued", [newer, older]);
  api.jobs.set(1, quietJobs("2026-10-01T10:05:00Z"));
  api.jobs.set(2, quietJobs("2026-10-01T11:05:00Z"));
  api.runById.set(1, older);
  api.runById.set(2, newer);
  const pass = makePass(api);
  const result = await pass.run();
  assert.equal(result.recovery, "recovered");
  assert.equal(result.cancelledRunId, 1);
  const cancelled = api.cancelCalls();
  assert.equal(cancelled.length, 1);
  assert.equal(
    new URL(cancelled[0].url).pathname,
    `${REPO}/actions/runs/1/force-cancel`,
  );
  assert.equal(api.dispatchCalls().length, 1);
});

Deno.test("supervisor dispatch: a protected pending deployment blocks cancellation", async () => {
  const api = wedgeApi();
  api.pending.set(WEDGED_RUN, [{
    environment: { id: 1, name: "sentinel-supervisor" },
    wait_timer: 0,
  }]);
  const pass = makePass(api);
  const result = await pass.run();
  assert.equal(result.recovery, "none");
  assert.equal(result.cancelledRunId, null);
  assert.equal(api.cancelCalls().length, 0);
  assert.equal(result.dispatched, true);
});

Deno.test("supervisor dispatch: a rejected dispatch is reported as exit code 1", async () => {
  const api = wedgeApi();
  api.dispatchStatus = 500;
  const pass = makePass(api);
  const result = await pass.run();
  assert.equal(result.exitCode, 1);
  assert.equal(result.dispatched, false);
  assert.equal(result.recovery, "recovered");
});

Deno.test("supervisor dispatch: a missing dispatcher token fails closed without any request", async () => {
  const api = wedgeApi();
  const logs: Record<string, unknown>[] = [];
  const result = await runSupervisorDispatch({
    http: api.transport,
    token: "",
    clock: { now: () => NOW_MS },
    log: (line) => logs.push(line),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.dispatched, false);
  assert.equal(api.calls.length, 0);
  assert.equal(logs[0].outcome, "missing_token");
});

Deno.test("supervisor dispatch: slow recovery reads that exhaust the budget still reach the ordinary dispatch", async () => {
  const api = new FakeApi();
  const runIds = Array.from({ length: 250 }, (_, index) => 1000 + index);
  api.runList.set("queued", runIds.map((id) => runItem({ id })));
  for (const id of runIds) {
    api.jobs.set(id, wedgedJobs());
    api.runById.set(id, runItem({ id }));
  }
  // Every read costs 10s against the fixed recovery budget.
  const pass = makePass(api, 10_000);
  const result = await pass.run();
  assert.equal(result.dispatched, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.cancelledRunId, null);
  assert.equal(api.cancelCalls().length, 0);
  // The scan stopped far short of the 250 candidates, so the budget (not the
  // listing size) ended recovery.
  assert.ok(
    api.calls.length <= 10,
    `recovery stopped after ${api.calls.length} requests`,
  );
  const stopped = pass.logFor("recovery_budget_exhausted");
  assert.equal(stopped?.phase, "scan");
  assert.ok(
    Number(stopped?.elapsedMs) > 0 &&
      Number(stopped?.elapsedMs) <= RECOVERY_BUDGET_MS,
    "the budget stop is inside the fixed recovery budget",
  );
});
