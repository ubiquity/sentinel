/**
 * Bounded local status reporting: the real producer in src/host/local.ts and
 * the real embedded renderer extracted unchanged from
 * .github/workflows/local-status.yml. Records are built through the frozen
 * contract parsers (tests/state/helpers.ts) and the private status file is a
 * real temporary file. No network, model, GitHub or live state is touched; the
 * renderer child runs with clearEnv and only the finite paths it needs.
 */
import assert from "node:assert/strict";

import {
  createLocalRepositoryConfig,
  type LocalStatusInputV1,
  writeLocalStatus,
} from "../../src/host/local.ts";
import { readLocalRunStatus } from "../../src/host/local-release.ts";
import { HOUR_WINDOW_MS, SEVEN_DAY_WINDOW_MS } from "../../src/budget/mod.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type {
  PortResultV1,
  RepairStateWriter,
  StateReadResultV1,
  StateReadView,
  StateWriteResultV1,
} from "../../src/contracts/ports.ts";
import {
  parseRepairStateSnapshotV1,
  type ReleaseStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { reservation, SHA1, SHA2, workRecord } from "../state/helpers.ts";

const NOW = Date.now();
const FINISHED = NOW - 30_000;
const STARTED = FINISHED - 60_000;
const HOUR = HOUR_WINDOW_MS;
const WEEK = SEVEN_DAY_WINDOW_MS;
const MAX_TEXT = 50_000;
const MAX_DISPATCH_BYTES = 65_535;
const ENCODER = new TextEncoder();

// ---------------------------------------------------------------------------
// Real parsed fixtures and injected state reads
// ---------------------------------------------------------------------------

function repairSnapshot(
  work: readonly WorkRecordV1[] = [],
  reservations: readonly BudgetReservationV1[] = [],
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: FINISHED,
    incidents: [],
    evidence: [],
    work: [...work],
    reservations: [...reservations],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
  });
}

/**
 * Intentionally synthetic injected stress snapshot: the large-history case
 * exceeds the frozen 2048-record container cap, so every record is still
 * parsed individually by the frozen reservation parser while this helper
 * assembles the container without the container-level re-parse. It is not a
 * real serialized parsed state file; the serialized state test below covers
 * that read path.
 */
function extendedRepairSnapshot(
  work: readonly WorkRecordV1[],
  reservations: readonly BudgetReservationV1[],
): RepairStateSnapshotV1 {
  return { ...repairSnapshot(work), reservations: [...reservations] };
}

class StatusState implements StateReadView, RepairStateWriter {
  reads = 0;
  writes = 0;

  constructor(
    private readonly snapshot: RepairStateSnapshotV1 | null,
    private readonly failRead = false,
  ) {}

  readRepair(): Promise<
    PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
  > {
    this.reads++;
    if (this.failRead || this.snapshot === null) {
      return Promise.resolve(
        portError("unavailable", "private repair state is unreadable"),
      );
    }
    return Promise.resolve(portOk({
      status: "found",
      snapshot: this.snapshot,
      head: SHA1,
      ref: "refs/heads/sentinel-state/repair",
    }));
  }

  readRelease(): Promise<
    PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>>
  > {
    return Promise.resolve(
      portError("unavailable", "release state is not used by status reporting"),
    );
  }

  writeRepair(
    _next: RepairStateSnapshotV1,
    _expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    this.writes++;
    return Promise.resolve(
      portError("unavailable", "status reporting must not write state"),
    );
  }
}

/**
 * State view backed by a real serialized fixture file: every read parses the
 * file contents with the frozen snapshot parser instead of returning an
 * in-memory object. Used to prove the producer and renderer never rewrite the
 * state fixture bytes.
 */
class FileStatusState implements StateReadView, RepairStateWriter {
  reads = 0;
  writes = 0;

  constructor(private readonly path: string) {}

  readRepair(): Promise<
    PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
  > {
    this.reads++;
    try {
      const text = Deno.readTextFileSync(this.path);
      const snapshot = parseRepairStateSnapshotV1(JSON.parse(text));
      return Promise.resolve(portOk({
        status: "found",
        snapshot,
        head: SHA1,
        ref: "refs/heads/sentinel-state/repair",
      }));
    } catch {
      return Promise.resolve(
        portError("unavailable", "fixture repair state is unreadable"),
      );
    }
  }

  readRelease(): Promise<
    PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>>
  > {
    return Promise.resolve(
      portError("unavailable", "release state is not used by status reporting"),
    );
  }

  writeRepair(
    _next: RepairStateSnapshotV1,
    _expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    this.writes++;
    return Promise.resolve(
      portError("unavailable", "status reporting must not write state"),
    );
  }
}

function work(
  id: string,
  nextStep: WorkRecordV1["nextStep"] = "work",
  issueNumber = 1,
): WorkRecordV1 {
  return workRecord(id, {
    createdAt: FINISHED - 600_000,
    updatedAt: FINISHED - 300_000,
    related: { incidentId: null, issueNumber },
    nextStep,
    blocker: nextStep === "blocked"
      ? {
        kind: "dependency",
        message: "waiting on an upstream dependency",
        since: FINISHED - 500_000,
      }
      : null,
  });
}

function blockedWork(id: string, issueNumber: number): WorkRecordV1 {
  return work(id, "blocked", issueNumber);
}

function chargedReservation(
  id: string,
  createdAt: number,
  overrides: Record<string, unknown> = {},
): BudgetReservationV1 {
  return reservation(id, { createdAt, ...overrides });
}

/** `count` simultaneous charged reservations with distinct bounded ids. */
function chargedReservations(
  prefix: string,
  count: number,
  createdAt: number,
): BudgetReservationV1[] {
  return Array.from(
    { length: count },
    (_value, index) =>
      chargedReservation(
        `${prefix}-${String(index).padStart(3, "0")}`,
        createdAt,
      ),
  );
}

// ---------------------------------------------------------------------------
// Real producer invocation
// ---------------------------------------------------------------------------

interface ProducedStatusV1 {
  status: Record<string, unknown>;
  fileText: string;
  logLine: string;
}

interface WorkAggregatesV1 {
  total: number;
  byNextStep: Record<string, number>;
  unknownSteps: number;
  blocked: number;
  omitted: number;
  omittedBlocked: number;
}

interface ReservationAggregatesV1 {
  total: number;
  open: number;
  settled: number;
  chargedHour: number;
  chargedSevenDays: number;
  omitted: number;
}

function workAggregates(status: Record<string, unknown>): WorkAggregatesV1 {
  const aggregates = status.aggregates as { work: WorkAggregatesV1 } | null;
  assert.ok(aggregates !== null, "available status carries aggregates");
  return aggregates!.work;
}

function reservationAggregates(
  status: Record<string, unknown>,
): ReservationAggregatesV1 {
  const aggregates = status.aggregates as
    | { reservations: ReservationAggregatesV1 }
    | null;
  assert.ok(aggregates !== null, "available status carries aggregates");
  return aggregates!.reservations;
}

function detail(status: Record<string, unknown>, key: string) {
  const list = status[key];
  assert.ok(Array.isArray(list), `${key} is an array`);
  return list as Array<Record<string, unknown>>;
}

async function makeRoot(prefix: string): Promise<string> {
  return await Deno.makeTempDir({ dir: ".", prefix });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function produce(
  state: StateReadView & RepairStateWriter,
  root: string,
  overrides: Partial<LocalStatusInputV1> = {},
): Promise<ProducedStatusV1> {
  const statusPath = `${root}/status.json`;
  const input: LocalStatusInputV1 = {
    state,
    statusPath,
    invocationId: "invocation-0001",
    controllerSha: SHA1,
    targetBaseSha: SHA2,
    login: "owner",
    config: createLocalRepositoryConfig(),
    startedAt: STARTED,
    finishedAt: FINISHED,
    outcome: { status: "idle", detail: "no eligible work" },
    ...overrides,
  };
  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (...data: unknown[]) => {
    logged.push(data.map((value) => String(value)).join(" "));
  };
  try {
    await writeLocalStatus(input);
  } finally {
    console.log = originalLog;
  }
  assert.equal(logged.length, 1, "exactly one status log line");
  assert.ok(!logged[0].includes("\n"), "the log line is a single line");
  const fileText = await Deno.readTextFile(statusPath);
  const status = JSON.parse(fileText) as Record<string, unknown>;
  assert.deepEqual(JSON.parse(logged[0]), status);
  assert.equal(
    logged[0],
    JSON.stringify(status),
    "compact single-line JSON log",
  );
  const info = await Deno.stat(statusPath);
  assert.equal((info.mode ?? 0) & 0o777, 0o600, "status file stays private");

  // Every produced shape must stay inside the documented bounds.
  assert.equal(status.kind, "sentinel_local_status");
  assert.equal(status.version, "v1");
  assert.equal(status.reportVersion, "v2");
  assert.ok(fileText.length <= MAX_TEXT, `file code units ${fileText.length}`);
  assert.ok(
    ENCODER.encode(fileText).length <= MAX_TEXT,
    `file UTF-8 bytes ${ENCODER.encode(fileText).length}`,
  );
  const envelope = ENCODER.encode(
    JSON.stringify({ inputs: { status: fileText } }),
  ).length;
  assert.ok(envelope <= MAX_DISPATCH_BYTES, `dispatch envelope ${envelope}`);
  assert.ok(detail(status, "work").length <= 200);
  assert.ok(detail(status, "reservations").length <= 200);
  return { status, fileText, logLine: logged[0] };
}

async function produceSnapshot(
  snapshot: RepairStateSnapshotV1,
  root: string,
  overrides: Partial<LocalStatusInputV1> = {},
): Promise<ProducedStatusV1> {
  return await produce(new StatusState(snapshot), root, overrides);
}

function assertUnavailable(produced: ProducedStatusV1): void {
  const status = produced.status;
  assert.equal(status.state, "unavailable");
  assert.equal(status.aggregates, null);
  assert.equal(status.summary, "unavailable");
  assert.deepEqual(status.work, []);
  assert.deepEqual(status.reservations, []);
  assert.equal(status.nextEligibleStartAt, null);
}

// ---------------------------------------------------------------------------
// Real embedded renderer, extracted unchanged from the workflow YAML
// ---------------------------------------------------------------------------

const WORKFLOW_URL = new URL(
  "../../.github/workflows/local-status.yml",
  import.meta.url,
);

let rendererSourceCache: string | null = null;

function rendererSource(): string {
  if (rendererSourceCache !== null) return rendererSourceCache;
  const lines = Deno.readTextFileSync(WORKFLOW_URL).split("\n");
  const start = lines.findIndex((line) => line.trim() === "deno eval '");
  const end = lines.findIndex((line, index) =>
    index > start && line.trim() === "'"
  );
  assert.ok(start >= 0, "the workflow embeds the renderer");
  assert.ok(end > start, "the embedded renderer is terminated");
  rendererSourceCache = lines.slice(start + 1, end).join("\n");
  return rendererSourceCache;
}

interface RenderResultV1 {
  code: number;
  summary: string;
  stdout: string;
  stderr: string;
}

async function render(raw: string | undefined): Promise<RenderResultV1> {
  const root = await makeRoot("sentinel-local-render-");
  try {
    const eventPath = `${root}/event.json`;
    const summaryPath = `${root}/summary.md`;
    await Deno.writeTextFile(
      eventPath,
      JSON.stringify({ inputs: raw === undefined ? {} : { status: raw } }),
    );
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["eval", rendererSource()],
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    let summary = "";
    try {
      summary = await Deno.readTextFile(summaryPath);
    } catch {
      summary = "";
    }
    return {
      code: output.code,
      summary,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function expectRecorded(
  raw: string,
  verdict: "GREEN" | "RED",
  fragment: string,
): Promise<RenderResultV1> {
  const result = await render(raw);
  assert.ok(
    result.summary.includes(`Result: RECORDED - ${verdict}`),
    result.summary || result.stderr,
  );
  assert.ok(result.summary.includes(fragment), result.summary);
  assert.equal(result.code, verdict === "GREEN" ? 0 : 1);
  return result;
}

async function expectRejected(
  raw: string | undefined,
  fragment: string,
): Promise<RenderResultV1> {
  const result = await render(raw);
  assert.ok(result.summary.includes("NOT RECORDED"), result.summary);
  assert.ok(result.summary.includes(fragment), result.summary);
  assert.equal(result.code, 1);
  return result;
}

function mutated(
  produced: ProducedStatusV1,
  change: (status: Record<string, unknown>) => void,
): string {
  const clone = JSON.parse(produced.fileText) as Record<string, unknown>;
  change(clone);
  return JSON.stringify(clone);
}

// ---------------------------------------------------------------------------
// Producer: complete aggregates and bounded detail
// ---------------------------------------------------------------------------

Deno.test("status projection: 0/199/200/201 records keep complete totals", async () => {
  const root = await makeRoot("sentinel-local-status-");
  try {
    for (const size of [0, 199, 200, 201]) {
      const workRecords = Array.from(
        { length: size },
        (_value, index) =>
          work(`w-${String(index).padStart(4, "0")}`, "work", index + 1),
      );
      const reservations = Array.from(
        { length: size },
        (_value, index) =>
          chargedReservation(
            `r-${String(index).padStart(4, "0")}`,
            FINISHED - 1000,
          ),
      );
      const produced = await produceSnapshot(
        repairSnapshot(workRecords, reservations),
        root,
      );
      const W = workAggregates(produced.status);
      const R = reservationAggregates(produced.status);
      const workDetail = detail(produced.status, "work");
      const reservationDetail = detail(produced.status, "reservations");
      // Complete totals come from the known input size, never from the lists.
      assert.equal(W.total, size);
      assert.equal(W.byNextStep.work, size);
      assert.equal(W.byNextStep.blocked, 0);
      assert.equal(W.blocked, 0);
      assert.equal(W.unknownSteps, 0);
      assert.equal(W.omittedBlocked, 0);
      assert.equal(W.omitted, size - workDetail.length);
      assert.equal(R.total, size);
      assert.equal(R.open, size);
      assert.equal(R.settled, 0);
      assert.equal(R.omitted, size - reservationDetail.length);
      // Independent bounds: detail stays at or below 200 items and the
      // serialized status still fits every text/envelope bound even when the
      // byte cap constrains the retained detail below 200.
      assert.ok(workDetail.length <= 200, `work detail ${workDetail.length}`);
      assert.ok(
        reservationDetail.length <= 200,
        `reservation detail ${reservationDetail.length}`,
      );
      assert.ok(produced.fileText.length <= MAX_TEXT);
      assert.ok(ENCODER.encode(produced.fileText).length <= MAX_TEXT);
      assert.ok(
        ENCODER.encode(
          JSON.stringify({ inputs: { status: produced.fileText } }),
        ).length <= MAX_DISPATCH_BYTES,
      );
      assert.equal(
        produced.status.summary,
        W.omitted === 0 && R.omitted === 0 ? "complete" : "truncated",
      );
      assert.equal(
        produced.status.state,
        undefined,
        "available state omits state",
      );
      if (size === 0) {
        assert.equal(R.chargedHour, 0);
        assert.equal(R.chargedSevenDays, 0);
        assert.equal(produced.status.nextEligibleStartAt, null);
      } else {
        assert.equal(R.chargedHour, size);
        assert.equal(R.chargedSevenDays, size);
        // All charges sit one second inside the rolling hour and are
        // simultaneous; 199/200/201 exceed the 168 seven-day cap, so the
        // weekly threshold is the later exact retry, not the hourly one.
        assert.equal(
          produced.status.nextEligibleStartAt,
          FINISHED - 1000 + WEEK,
        );
      }
      if (size === 199 || size === 201) {
        const rendered = await expectRecorded(
          produced.fileText,
          "GREEN",
          `${size} total`,
        );
        assert.ok(
          rendered.summary.includes(
            produced.status.summary === "truncated"
              ? "Report detail: truncated"
              : "Report detail: complete",
          ),
          rendered.summary,
        );
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("status projection: 10000 lifetime reservations stay complete and bounded", async () => {
  const root = await makeRoot("sentinel-local-large-");
  try {
    const reservations = Array.from(
      { length: 10_000 },
      (_value, index) =>
        chargedReservation(
          `res-${String(index).padStart(5, "0")}`,
          FINISHED - 21 * 24 * 3_600_000 + index,
        ),
    );
    const workRecords = Array.from(
      { length: 500 },
      (_value, index) =>
        work(`w-${String(index).padStart(4, "0")}`, "work", index + 1),
    );
    const produced = await produceSnapshot(
      extendedRepairSnapshot(workRecords, reservations),
      root,
    );
    const W = workAggregates(produced.status);
    const R = reservationAggregates(produced.status);
    const workDetail = detail(produced.status, "work");
    const reservationDetail = detail(produced.status, "reservations");
    // This container is an intentionally synthetic injected stress snapshot:
    // it is above the frozen 2048-record container cap and assembled from
    // individually parsed reservations, not read from a serialized state file.
    assert.equal(W.total, 500);
    assert.equal(W.omitted, 500 - workDetail.length);
    assert.ok(workDetail.length <= 200);
    assert.equal(R.total, 10_000);
    assert.equal(R.open, 10_000);
    assert.equal(R.omitted, 10_000 - reservationDetail.length);
    assert.ok(R.omitted >= 9_800);
    assert.ok(reservationDetail.length <= 200);
    assert.equal(R.chargedHour, 0);
    assert.equal(R.chargedSevenDays, 0);
    assert.equal(produced.status.summary, "truncated");
    assert.equal(produced.status.nextEligibleStartAt, null);
    // Truncation alone is not a failure: the real renderer stays GREEN.
    await expectRecorded(
      produced.fileText,
      "GREEN",
      "Report detail: truncated",
    );
    await expectRecorded(produced.fileText, "GREEN", "10000 total");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Producer: exact budget semantics
// ---------------------------------------------------------------------------

Deno.test("status projection: exact rolling hour and seven-day semantics", async () => {
  const root = await makeRoot("sentinel-local-budget-");
  try {
    const status = async (reservations: BudgetReservationV1[]) =>
      await produceSnapshot(repairSnapshot([], reservations), root);

    const none = await status([]);
    assert.equal(reservationAggregates(none.status).chargedHour, 0);
    assert.equal(none.status.nextEligibleStartAt, null);

    // 59 charges leave the rolling hour below its 60-start cap.
    const underHour = await status(
      chargedReservations("hour-under", 59, FINISHED - 1000),
    );
    const underHourAgg = reservationAggregates(underHour.status);
    assert.equal(underHourAgg.chargedHour, 59);
    assert.equal(underHourAgg.chargedSevenDays, 59);
    assert.equal(underHour.status.nextEligibleStartAt, null);

    // 60 charges reach the cap: the oldest charge retires first.
    const atHour = await status(
      chargedReservations("hour-at", 60, FINISHED - 1000),
    );
    const atHourAgg = reservationAggregates(atHour.status);
    assert.equal(atHourAgg.chargedHour, 60);
    assert.equal(atHourAgg.chargedSevenDays, 60);
    assert.equal(atHour.status.nextEligibleStartAt, FINISHED - 1000 + HOUR);

    // 61 charges use the 60th most recent charge: the newest and the oldest
    // charge alone would each give a false retry.
    const overHour = await status([
      chargedReservation("hour-new", FINISHED - 100),
      ...chargedReservations("hour-mid", 59, FINISHED - 2000),
      chargedReservation("hour-old", FINISHED - 5000),
    ]);
    const overHourAgg = reservationAggregates(overHour.status);
    assert.equal(overHourAgg.chargedHour, 61);
    assert.equal(overHourAgg.chargedSevenDays, 61);
    assert.equal(overHour.status.nextEligibleStartAt, FINISHED - 2000 + HOUR);

    // Window is (finishedAt - HOUR, finishedAt]: the exact lower bound is out.
    const atBoundary = await status(
      chargedReservations("hour-boundary", 60, FINISHED - HOUR),
    );
    assert.equal(reservationAggregates(atBoundary.status).chargedHour, 0);
    assert.equal(atBoundary.status.nextEligibleStartAt, null);
    const justOutside = await status(
      chargedReservations("hour-outside", 60, FINISHED - HOUR - 1),
    );
    assert.equal(reservationAggregates(justOutside.status).chargedHour, 0);
    const justInside = await status(
      chargedReservations("hour-inside", 60, FINISHED - HOUR + 1),
    );
    assert.equal(reservationAggregates(justInside.status).chargedHour, 60);
    assert.equal(
      justInside.status.nextEligibleStartAt,
      FINISHED - HOUR + 1 + HOUR,
    );

    // Exactly the observation timestamp is inside both windows.
    const atNow = await status(
      chargedReservations("hour-now", 60, FINISHED),
    );
    const atNowAgg = reservationAggregates(atNow.status);
    assert.equal(atNowAgg.chargedHour, 60);
    assert.equal(atNowAgg.chargedSevenDays, 60);
    assert.equal(atNow.status.nextEligibleStartAt, FINISHED + HOUR);

    // 167/168/169 charges inside the week but outside the hour.
    const weekly = (count: number) =>
      Array.from({ length: count }, (_value, index) =>
        chargedReservation(
          `week-${String(index).padStart(3, "0")}`,
          FINISHED - HOUR - 1000 - index * 60_000,
        ));
    const under = await status(weekly(167));
    assert.equal(reservationAggregates(under.status).chargedSevenDays, 167);
    assert.equal(under.status.nextEligibleStartAt, null);
    const atWeek = await status(weekly(168));
    const atWeekAgg = reservationAggregates(atWeek.status);
    assert.equal(atWeekAgg.chargedSevenDays, 168);
    assert.equal(atWeekAgg.chargedHour, 0);
    const weekThreshold = FINISHED - HOUR - 1000 - 167 * 60_000;
    assert.equal(atWeek.status.nextEligibleStartAt, weekThreshold + WEEK);
    const overWeek = await status(weekly(169));
    assert.equal(reservationAggregates(overWeek.status).chargedSevenDays, 169);
    // With 169 charges the 168th most recent is still the limiting one, so the
    // exact retry time is the same as at 168: no clipping, no false permission.
    assert.equal(overWeek.status.nextEligibleStartAt, weekThreshold + WEEK);
    assert.equal(
      overWeek.status.nextEligibleStartAt,
      atWeek.status.nextEligibleStartAt,
    );

    // Weekly lower bound: (finishedAt - WEEK, finishedAt].
    const weekBoundary = (createdAt: number) =>
      Array.from(
        { length: 168 },
        (_value, index) =>
          chargedReservation(`wk-${String(index).padStart(3, "0")}`, createdAt),
      );
    const weekUnderBoundary = await status(
      weekBoundary(FINISHED - WEEK + 1).slice(0, 167),
    );
    assert.equal(
      reservationAggregates(weekUnderBoundary.status).chargedSevenDays,
      167,
    );
    assert.equal(weekUnderBoundary.status.nextEligibleStartAt, null);
    const weekAtBoundary = await status(weekBoundary(FINISHED - WEEK));
    assert.equal(
      reservationAggregates(weekAtBoundary.status).chargedSevenDays,
      0,
    );
    assert.equal(weekAtBoundary.status.nextEligibleStartAt, null);
    const weekOutsideBoundary = await status(weekBoundary(FINISHED - WEEK - 1));
    assert.equal(
      reservationAggregates(weekOutsideBoundary.status).chargedSevenDays,
      0,
    );
    assert.equal(weekOutsideBoundary.status.nextEligibleStartAt, null);
    const weekInsideBoundary = await status(weekBoundary(FINISHED - WEEK + 1));
    assert.equal(
      reservationAggregates(weekInsideBoundary.status).chargedSevenDays,
      168,
    );
    assert.equal(
      reservationAggregates(weekInsideBoundary.status).chargedHour,
      0,
    );
    assert.equal(
      weekInsideBoundary.status.nextEligibleStartAt,
      FINISHED - WEEK + 1 + WEEK,
    );
    // 168 charges exactly at the observation time combine both caps; the
    // seven-day threshold is the later exact retry.
    const weekAtNow = await status(weekBoundary(FINISHED));
    const weekAtNowAgg = reservationAggregates(weekAtNow.status);
    assert.equal(weekAtNowAgg.chargedHour, 168);
    assert.equal(weekAtNowAgg.chargedSevenDays, 168);
    assert.equal(weekAtNow.status.nextEligibleStartAt, FINISHED + WEEK);

    // Both caps: the later of the two exact retry times wins. The 60 hourly
    // charges precede the weekly 168, so the 168th most recent charge overall
    // is weekly index 107 and its retirement is the weekly threshold.
    const bothHourCandidate = FINISHED - 4000 + HOUR;
    const both = await status([
      ...chargedReservations("both-hour", 60, FINISHED - 4000),
      ...weekly(168),
    ]);
    const bothAgg = reservationAggregates(both.status);
    assert.equal(bothAgg.chargedHour, 60);
    assert.equal(bothAgg.chargedSevenDays, 228);
    const bothWeeklyThreshold = FINISHED - HOUR - 1000 - 107 * 60_000;
    assert.ok(
      bothWeeklyThreshold + WEEK > bothHourCandidate,
      "the weekly cap is the limiting retry in this case",
    );
    assert.equal(
      both.status.nextEligibleStartAt,
      Math.max(bothHourCandidate, bothWeeklyThreshold + WEEK),
    );

    // Outcomes: only a confirmed non-submission is refunded. Sixty charged
    // outcomes reach the hour cap; the refunded entry does not count.
    const outcomes = await status([
      chargedReservation("out-reserved", FINISHED - 1000),
      chargedReservation("out-submitted", FINISHED - 1000, {
        outcome: "submitted",
        settledAt: FINISHED - 500,
      }),
      chargedReservation("out-ambiguous", FINISHED - 1000, {
        outcome: "ambiguous",
        settledAt: FINISHED - 500,
      }),
      ...chargedReservations("out-charged", 57, FINISHED - 1000),
      chargedReservation("out-refunded", FINISHED - 1000, {
        outcome: "confirmed_not_submitted",
        settledAt: FINISHED - 500,
        proofRef: "artifact://proof/refunded.json",
      }),
    ]);
    const outcomesAgg = reservationAggregates(outcomes.status);
    assert.equal(outcomesAgg.total, 61);
    assert.equal(outcomesAgg.open, 58);
    assert.equal(outcomesAgg.settled, 3);
    assert.equal(outcomesAgg.chargedHour, 60);
    assert.equal(outcomes.status.nextEligibleStartAt, FINISHED - 1000 + HOUR);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Producer: blocked visibility and stable bounded selection
// ---------------------------------------------------------------------------

Deno.test("status projection: blocked detail survives truncation and is order-stable", async () => {
  const root = await makeRoot("sentinel-local-blocked-");
  try {
    const blocked = Array.from(
      { length: 250 },
      (_value, index) =>
        blockedWork(`blk-${String(index).padStart(3, "0")}`, index + 1),
    );
    const done = Array.from(
      { length: 80 },
      (_value, index) =>
        work(`done-${String(index).padStart(3, "0")}`, "done", index + 1),
    );
    const active = Array.from(
      { length: 10 },
      (_value, index) =>
        work(`act-${String(index).padStart(3, "0")}`, "work", index + 1),
    );
    const orderedWork = [...active, ...done, ...blocked];

    const forward = await produceSnapshot(
      repairSnapshot(orderedWork, []),
      root,
    );
    const W = workAggregates(forward.status);
    assert.equal(W.total, 340);
    assert.equal(W.blocked, 250);
    assert.equal(W.byNextStep.blocked, 250);
    assert.equal(W.omitted, 140);
    assert.equal(W.omittedBlocked, 50);
    assert.equal(forward.status.summary, "truncated");
    const visible = detail(forward.status, "work").map((entry) => entry.id);
    assert.equal(visible.length, 200);
    assert.ok(visible.every((id) => String(id).startsWith("blk-")));
    assert.deepEqual(
      visible,
      blocked.slice(0, 200).map((record) => record.id),
    );

    const reversed = await produceSnapshot(
      repairSnapshot([...orderedWork].reverse(), []),
      root,
    );
    assert.deepEqual(
      detail(reversed.status, "work").map((entry) => entry.id),
      visible,
      "selection does not depend on input order",
    );

    const rendered = await expectRecorded(
      forward.fileText,
      "RED",
      "blocked work is present",
    );
    assert.ok(rendered.summary.includes("250 total"), rendered.summary);
    assert.ok(
      rendered.summary.includes("50 omitted from the bounded detail"),
      rendered.summary,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Producer: deterministic reduction of oversize optional detail
// ---------------------------------------------------------------------------

Deno.test("status projection: oversize detail is reduced deterministically", async () => {
  const root = await makeRoot("sentinel-local-reduce-");
  try {
    const longId = (index: number) => {
      const base = `blk-${String(index).padStart(3, "0")}-`;
      return base + "x".repeat(256 - base.length);
    };
    const records = Array.from(
      { length: 200 },
      (_value, index) => blockedWork(longId(index), index + 1),
    );
    const produced = await produceSnapshot(repairSnapshot(records), root);
    const W = workAggregates(produced.status);
    const visible = detail(produced.status, "work");
    assert.equal(W.total, 200);
    assert.equal(W.blocked, 200);
    assert.ok(visible.length < 200, "optional detail was reduced to fit");
    assert.equal(W.omitted, 200 - visible.length);
    assert.equal(W.omittedBlocked, 200 - visible.length);
    assert.equal(produced.status.summary, "truncated");
    // Deterministic: the surviving detail is the lexical prefix of the
    // blocked-first ordering.
    assert.deepEqual(
      visible.map((entry) => entry.id),
      records.slice(0, visible.length).map((record) => record.id),
    );

    const repeated = await produceSnapshot(repairSnapshot(records), root);
    assert.deepEqual(
      detail(repeated.status, "work"),
      visible,
      "reduction is deterministic across identical runs",
    );

    const rendered = await expectRecorded(
      produced.fileText,
      "RED",
      "blocked work is present",
    );
    assert.ok(rendered.summary.includes("200 total"), rendered.summary);
    assert.ok(
      rendered.summary.includes(
        `${200 - visible.length} omitted from the bounded detail`,
      ),
      rendered.summary,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("status projection: blocked work survives byte pressure before reservation history", async () => {
  const root = await makeRoot("sentinel-local-mixed-");
  try {
    const longTaskId = (index: number) => {
      const base = `task:r-${String(index).padStart(3, "0")}-`;
      return base + "y".repeat(256 - base.length);
    };
    const reservations = Array.from(
      { length: 200 },
      (_value, index) =>
        chargedReservation(
          `r-${String(index).padStart(3, "0")}`,
          FINISHED - 1000,
          { taskId: longTaskId(index) },
        ),
    );
    const blocked = Array.from(
      { length: 60 },
      (_value, index) =>
        blockedWork(`blk-${String(index).padStart(3, "0")}`, index + 1),
    );
    const done = Array.from(
      { length: 60 },
      (_value, index) =>
        work(`done-${String(index).padStart(3, "0")}`, "done", index + 1),
    );
    const produced = await produceSnapshot(
      repairSnapshot([...done, ...blocked], reservations),
      root,
    );
    const W = workAggregates(produced.status);
    const R = reservationAggregates(produced.status);
    const visibleWork = detail(produced.status, "work");
    const visibleReservations = detail(produced.status, "reservations");
    const visibleBlocked = visibleWork.filter((entry) =>
      entry.nextStep === "blocked"
    ).length;
    assert.equal(W.total, 120);
    assert.equal(W.blocked, 60);
    assert.equal(W.byNextStep.blocked, 60);
    assert.equal(W.omitted, 120 - visibleWork.length);
    assert.equal(W.omittedBlocked, 60 - visibleBlocked);
    assert.equal(R.total, 200);
    assert.equal(R.omitted, 200 - visibleReservations.length);
    // Optional reservation history is dropped first under byte pressure, so
    // every work record, including every blocked one, is still visible.
    assert.ok(
      visibleReservations.length < 200,
      "optional reservation history was reduced",
    );
    assert.equal(visibleWork.length, 120);
    assert.equal(visibleBlocked, 60);
    assert.equal(R.open, 200);
    assert.equal(R.chargedHour, 200);
    assert.equal(R.chargedSevenDays, 200);
    assert.equal(produced.status.summary, "truncated");
    assert.equal(
      produced.status.nextEligibleStartAt,
      FINISHED - 1000 + WEEK,
    );
    const rendered = await expectRecorded(
      produced.fileText,
      "RED",
      "blocked work is present",
    );
    assert.ok(!rendered.summary.includes("NOT RECORDED"), rendered.summary);
    assert.ok(rendered.summary.includes("200 total"), rendered.summary);
    assert.ok(rendered.summary.includes("60 total"), rendered.summary);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Producer: unknown steps and malformed state
// ---------------------------------------------------------------------------

Deno.test("status projection: unknown steps are labeled and malformed state is unavailable", async () => {
  const root = await makeRoot("sentinel-local-unknown-");
  try {
    const futureStep = {
      ...work("w-future"),
      nextStep: "mystery",
    } as unknown as WorkRecordV1;
    const unknownSnapshot = {
      ...repairSnapshot([work("w-known")]),
      work: [futureStep],
    } as unknown as RepairStateSnapshotV1;
    const unknown = await produceSnapshot(unknownSnapshot, root);
    const W = workAggregates(unknown.status);
    assert.equal(W.total, 1);
    assert.equal(W.unknownSteps, 1);
    assert.equal(W.byNextStep.work, 0);
    const entry = detail(unknown.status, "work")[0];
    assert.equal(entry.nextStep, "unknown");
    assert.ok(
      !unknown.fileText.includes("mystery"),
      "no raw unknown step text",
    );
    await expectRecorded(
      unknown.fileText,
      "RED",
      "unrecognized work steps are present",
    );

    const failedRead = await produce(new StatusState(null, true), root);
    assertUnavailable(failedRead);

    const malformedSnapshot = {
      ...repairSnapshot(),
      work: "not-an-array",
    } as unknown as RepairStateSnapshotV1;
    assertUnavailable(await produceSnapshot(malformedSnapshot, root));

    const malformedReservation = {
      ...repairSnapshot(),
      reservations: [{ ...reservation("bad-1"), createdAt: "yesterday" }],
    } as unknown as RepairStateSnapshotV1;
    assertUnavailable(await produceSnapshot(malformedReservation, root));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("status projection: invalid identity, limits and chronology fail unavailable", async () => {
  const root = await makeRoot("sentinel-local-invalid-");
  try {
    const longInvocation = "i".repeat(400);
    const badIdentity = await produceSnapshot(
      repairSnapshot([work("w-1")]),
      root,
      {
        invocationId: longInvocation,
        controllerSha: "not-a-sha" as unknown as GitSha,
      },
    );
    assertUnavailable(badIdentity);
    assert.equal(badIdentity.status.invocationId, "unavailable");
    assert.equal(badIdentity.status.controllerSha, null);
    assert.ok(!badIdentity.fileText.includes(longInvocation));
    assert.ok(badIdentity.fileText.length < 2000);

    const unordered = await produceSnapshot(
      repairSnapshot(),
      root,
      { startedAt: FINISHED + 1000, finishedAt: FINISHED },
    );
    assertUnavailable(unordered);
    assert.equal(unordered.status.startedAt, null);
    assert.equal(unordered.status.finishedAt, null);

    const nanTime = await produceSnapshot(
      repairSnapshot(),
      root,
      { startedAt: Number.NaN },
    );
    assertUnavailable(nanTime);

    const badLimits = await produceSnapshot(repairSnapshot(), root, {
      config: { ...createLocalRepositoryConfig(), liveStartLimits: null },
    });
    assertUnavailable(badLimits);

    const futureCharge = await produceSnapshot(
      repairSnapshot([], [chargedReservation("future", FINISHED + 1)]),
      root,
    );
    assertUnavailable(futureCharge);

    const futureSettlement = await produceSnapshot(
      repairSnapshot([], [
        chargedReservation("future-settled", FINISHED - 1000, {
          outcome: "submitted",
          settledAt: FINISHED + 1,
        }),
      ]),
      root,
    );
    assertUnavailable(futureSettlement);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Producer: maximum text bounds and escaping
// ---------------------------------------------------------------------------

Deno.test("status producer: max-length IDs, Unicode login and escaping round-trip", async () => {
  const root = await makeRoot("sentinel-local-text-");
  try {
    const maxId = `w${"a".repeat(255)}`;
    const maxReservationId = `r${"b".repeat(255)}`;
    const longTaskId = "t".repeat(256);
    const login = 'ø"\\中';
    const produced = await produceSnapshot(
      repairSnapshot(
        [blockedWork(maxId, 1_000_000_000_000), blockedWork("blk-1", 42)],
        [chargedReservation(maxReservationId, FINISHED - 1000, {
          taskId: longTaskId,
        })],
      ),
      root,
      { login },
    );
    assert.equal(produced.status.login, login);
    assert.equal(
      detail(produced.status, "work").map((entry) => entry.id).length,
      2,
    );
    assert.equal(detail(produced.status, "reservations")[0].taskId, longTaskId);
    assert.ok(produced.fileText.includes('\\"'), "quotes are JSON-escaped");
    assert.ok(
      produced.fileText.includes("\\u00f8") || produced.fileText.includes("ø"),
    );
    // The renderer only displays bounded numeric issue IDs: a huge id is not shown.
    const rendered = await expectRecorded(
      produced.fileText,
      "RED",
      "blocked work is present",
    );
    assert.ok(!rendered.summary.includes("#1000000000000"));
    assert.ok(rendered.summary.includes("without a bounded numeric issue id"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Producer: no state mutation, retained receipt compatibility
// ---------------------------------------------------------------------------

Deno.test("status producer: reporting leaves the complete snapshot unchanged", async () => {
  const root = await makeRoot("sentinel-local-preserve-");
  try {
    const snapshot = repairSnapshot(
      [blockedWork("blk-1", 7), work("w-1")],
      [chargedReservation("r-1", FINISHED - 1000)],
    );
    const before = JSON.stringify(snapshot);
    const state = new StatusState(snapshot);
    await produce(state, root);
    assert.equal(state.writes, 0, "reporting never writes repair state");
    assert.equal(state.reads, 1);
    assert.equal(
      JSON.stringify(snapshot),
      before,
      "snapshot bytes are unchanged",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("status producer: serialized state fixture is parsed, rendered and preserved", async () => {
  const root = await makeRoot("sentinel-local-statefile-");
  try {
    const path = `${root}/repair-state.json`;
    const snapshot = repairSnapshot(
      [blockedWork("blk-1", 11), work("w-1", "work", 12)],
      [
        chargedReservation("r-1", FINISHED - 1000),
        chargedReservation("r-2", FINISHED - 2000, {
          outcome: "submitted",
          settledAt: FINISHED - 1500,
        }),
      ],
    );
    await Deno.writeTextFile(path, JSON.stringify(snapshot, null, 2) + "\n");
    const stateBefore = await Deno.readFile(path);
    const state = new FileStatusState(path);
    const produced = await produce(state, root, {
      outcome: { status: "state_error", detail: "fixture failure detail" },
    });
    assert.equal(state.reads, 1, "the producer reads the serialized fixture");
    assert.equal(state.writes, 0, "reporting never writes repair state");
    assert.equal(workAggregates(produced.status).total, 2);
    const statusBeforeRender = await Deno.readFile(`${root}/status.json`);

    const available = await readLocalRunStatus(root);
    assert.ok(available.ok, "the produced envelope parses");
    if (!available.ok) throw new Error("unreachable");
    assert.ok(available.value !== null);
    if (available.value === null) throw new Error("unreachable");
    assert.equal(available.value.outcome, "state_error");
    assert.equal(available.value.stateAvailable, true);

    const rendered = await expectRecorded(
      produced.fileText,
      "RED",
      "blocked work is present",
    );
    assert.ok(!rendered.summary.includes("NOT RECORDED"), rendered.summary);

    // The RED report is diagnostic: it rewrites neither the parsed state
    // fixture nor the original status receipt, and it leaves no local
    // supervisor rollback or pointer artifact behind.
    assert.deepEqual(
      await Deno.readFile(path),
      stateBefore,
      "the serialized state fixture bytes are unchanged",
    );
    assert.deepEqual(
      await Deno.readFile(`${root}/status.json`),
      statusBeforeRender,
      "the status receipt bytes are unchanged by rendering",
    );
    const reread = await readLocalRunStatus(root);
    assert.ok(reread.ok);
    if (!reread.ok) throw new Error("unreachable");
    assert.ok(reread.value !== null);
    assert.equal(
      reread.value!.outcome,
      "state_error",
      "the original outcome stays original",
    );
    assert.equal(reread.value!.stateAvailable, true);
    assert.equal(await pathExists(`${root}/local-releases`), false);
    assert.equal(await pathExists(`${root}/active-runtime.json`), false);
    assert.equal(await pathExists(`${root}/supervisor.lock`), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("status producer: retained local receipt consumer reads the v1 envelope", async () => {
  const root = await makeRoot("sentinel-local-receipt-");
  try {
    const produced = await produceSnapshot(
      repairSnapshot([work("w-1")], [
        chargedReservation("r-1", FINISHED - 1000),
      ]),
      root,
    );
    const available = await readLocalRunStatus(root);
    assert.ok(available.ok, "the produced envelope parses");
    if (!available.ok) throw new Error("unreachable");
    const value = available.value;
    assert.ok(value !== null);
    if (value === null) throw new Error("unreachable");
    assert.equal(value.invocationId, "invocation-0001");
    assert.equal(value.controllerSha, SHA1);
    assert.equal(value.startedAt, STARTED);
    assert.equal(value.finishedAt, FINISHED);
    assert.equal(value.outcome, "idle");
    assert.equal(value.stateAvailable, true);
    assert.equal(produced.status.state, undefined);

    const unavailable = await produce(new StatusState(null, true), root);
    assertUnavailable(unavailable);
    const missingState = await readLocalRunStatus(root);
    assert.ok(missingState.ok);
    if (!missingState.ok) throw new Error("unreachable");
    assert.ok(missingState.value !== null);
    assert.equal(missingState.value!.stateAvailable, false);

    await Deno.writeTextFile(`${root}/status.json`, "{not json\n");
    const corrupt = await readLocalRunStatus(root);
    assert.equal(
      corrupt.ok,
      false,
      "a corrupt status is unavailable, not empty",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Embedded renderer: real producer output end to end
// ---------------------------------------------------------------------------

Deno.test("embedded renderer: real producer output renders complete and RED reports", async () => {
  const root = await makeRoot("sentinel-local-render-compose-");
  try {
    const complete = await produceSnapshot(
      repairSnapshot([work("w-1", "work", 1)]),
      root,
    );
    await expectRecorded(complete.fileText, "GREEN", "Local state: available");
    await expectRecorded(complete.fileText, "GREEN", "Rolling usage: 0 of 60");
    await expectRecorded(complete.fileText, "GREEN", "Report detail: complete");

    const unavailable = await produce(new StatusState(null, true), root);
    await expectRecorded(
      unavailable.fileText,
      "RED",
      "the local status is unavailable",
    );

    const blocked = await produceSnapshot(
      repairSnapshot(
        [blockedWork("blk-1", 9)],
        chargedReservations("r-cap", 60, FINISHED - 1000),
      ),
      root,
    );
    assert.equal(blocked.status.nextEligibleStartAt, FINISHED - 1000 + HOUR);
    const rendered = await expectRecorded(
      blocked.fileText,
      "RED",
      "blocked work is present",
    );
    assert.ok(rendered.summary.includes("Rolling usage: 60 of 60"));
    assert.ok(rendered.summary.includes("Next eligible local start (UTC):"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("embedded renderer: large lifetime history renders unchanged", async () => {
  const root = await makeRoot("sentinel-local-render-large-");
  try {
    const reservations = Array.from(
      { length: 10_000 },
      (_value, index) =>
        chargedReservation(
          `res-${String(index).padStart(5, "0")}`,
          FINISHED - 21 * 24 * 3_600_000 + index,
        ),
    );
    const produced = await produceSnapshot(
      extendedRepairSnapshot([work("w-1")], reservations),
      root,
    );
    await expectRecorded(
      produced.fileText,
      "GREEN",
      "Report detail: truncated",
    );
    await expectRecorded(produced.fileText, "GREEN", "10000 total");

    const withBlocked = await produceSnapshot(
      extendedRepairSnapshot([blockedWork("blk-1", 3)], reservations),
      root,
    );
    const rendered = await expectRecorded(
      withBlocked.fileText,
      "RED",
      "blocked work is present",
    );
    assert.ok(!rendered.summary.includes("NOT RECORDED"));
    assert.ok(rendered.summary.includes("10000 total"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("embedded renderer: rejects incompatible or inconsistent shapes", async () => {
  const root = await makeRoot("sentinel-local-render-reject-");
  try {
    const base = await produceSnapshot(
      repairSnapshot([work("w-1", "work", 1)]),
      root,
    );
    await expectRecorded(base.fileText, "GREEN", "GREEN");

    await expectRejected(
      mutated(base, (status) => delete status.reportVersion),
      "reportVersion is not v2",
    );
    await expectRejected(
      mutated(base, (status) => {
        status.reportVersion = "v1";
      }),
      "reportVersion is not v2",
    );
    await expectRejected(
      mutated(base, (status) => {
        status.version = "v2";
      }),
      "version is not v1",
    );
    await expectRejected(
      mutated(base, (status) => {
        status.kind = "sentinel_hosted_status";
      }),
      "kind is not sentinel_local_status",
    );
    await expectRejected(
      mutated(base, (status) => {
        status.model = "gpt-5.6-mini";
      }),
      "model policy",
    );
    await expectRejected(
      mutated(base, (status) => {
        (status.limits as Record<string, unknown>).perHour = 2;
      }),
      "admission limits",
    );
    await expectRejected(
      mutated(base, (status) => {
        const aggregates = status.aggregates as {
          work: { omitted: number };
        };
        aggregates.work.omitted += 1;
      }),
      "work.omitted is inconsistent",
    );
    await expectRejected(
      mutated(base, (status) => {
        const aggregates = status.aggregates as {
          work: {
            byNextStep: Record<string, number>;
            total: number;
            unknownSteps: number;
          };
        };
        aggregates.work.byNextStep.work = 0;
        aggregates.work.total = 1;
        aggregates.work.unknownSteps = 1;
      }),
      "work detail exceeds the complete work count",
    );
    await expectRejected(
      mutated(base, (status) => {
        status.summary = "truncated";
      }),
      "summary marker is inconsistent",
    );
    await expectRejected(
      mutated(base, (status) => {
        status.state = "unavailable";
      }),
      "unavailable status must carry null aggregates",
    );
    await expectRejected(
      mutated(base, (status) => {
        status.nextEligibleStartAt = FINISHED + 1000;
      }),
      "while both rolling caps have room",
    );

    const atCap = await produceSnapshot(
      repairSnapshot([], chargedReservations("r-cap", 60, FINISHED - 1000)),
      root,
    );
    await expectRejected(
      mutated(atCap, (status) => {
        status.nextEligibleStartAt = null;
      }),
      "missing while a rolling cap is reached",
    );
    await expectRejected(
      mutated(atCap, (status) => {
        status.nextEligibleStartAt = atCap.status.nextEligibleStartAt as number;
        const aggregates = status.aggregates as {
          reservations: {
            total: number;
            open: number;
            settled: number;
            chargedHour: number;
            chargedSevenDays: number;
            omitted: number;
          };
        };
        status.reservations = [];
        aggregates.reservations.total = 60;
        aggregates.reservations.open = 0;
        aggregates.reservations.settled = 60;
        aggregates.reservations.omitted = 60;
        aggregates.reservations.chargedHour = 0;
        aggregates.reservations.chargedSevenDays = 0;
        status.summary = "truncated";
      }),
      "next eligible start is set while both rolling caps have room",
    );
    await expectRejected(undefined, "status input is missing");
    await expectRejected("not json", "not valid JSON");
    await expectRejected("{}", "kind is not sentinel_local_status");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("embedded renderer: rejects contradictory aggregate counts", async () => {
  const root = await makeRoot("sentinel-local-render-aggregate-");
  try {
    const base = await produceSnapshot(
      repairSnapshot(
        [work("w-1", "work", 1)],
        [
          chargedReservation("r-open", FINISHED - 1000),
          chargedReservation("r-settled", FINISHED - 2000, {
            outcome: "submitted",
            settledAt: FINISHED - 1500,
          }),
        ],
      ),
      root,
    );
    const R = reservationAggregates(base.status);
    assert.equal(R.total, 2);
    assert.equal(R.open, 1);
    assert.equal(R.settled, 1);
    assert.equal(R.chargedHour, 2);
    assert.equal(R.chargedSevenDays, 2);

    await expectRejected(
      mutated(base, (status) => {
        const reservations = (status.aggregates as {
          reservations: { open: number; settled: number };
        }).reservations;
        reservations.open = 0;
        reservations.settled = 2;
      }),
      "reservation open counts are inconsistent with the bounded detail",
    );
    await expectRejected(
      mutated(base, (status) => {
        const reservations = (status.aggregates as {
          reservations: { open: number; settled: number };
        }).reservations;
        reservations.open = 2;
        reservations.settled = 0;
      }),
      "reservation open counts are inconsistent with the bounded detail",
    );
    await expectRejected(
      mutated(base, (status) => {
        const reservations = (status.aggregates as {
          reservations: { chargedHour: number; chargedSevenDays: number };
        }).reservations;
        reservations.chargedHour = 0;
        reservations.chargedSevenDays = 0;
        status.nextEligibleStartAt = null;
      }),
      "rolling hour usage is inconsistent with the bounded detail",
    );
    await expectRejected(
      mutated(base, (status) => {
        const reservations = (status.aggregates as {
          reservations: { chargedSevenDays: number };
        }).reservations;
        reservations.chargedSevenDays = 0;
      }),
      "rolling charged usage is inconsistent",
    );

    // A valid at-cap report cannot be rewritten to zero charged usage with a
    // null retry.
    const recent = await produceSnapshot(
      repairSnapshot(
        [],
        chargedReservations("r-recent", 60, FINISHED - 1000),
      ),
      root,
    );
    assert.equal(recent.status.nextEligibleStartAt, FINISHED - 1000 + HOUR);
    await expectRejected(
      mutated(recent, (status) => {
        const reservations = (status.aggregates as {
          reservations: { chargedHour: number; chargedSevenDays: number };
        }).reservations;
        reservations.chargedHour = 0;
        reservations.chargedSevenDays = 0;
        status.nextEligibleStartAt = null;
      }),
      "rolling hour usage is inconsistent with the bounded detail",
    );
    await expectRejected(
      mutated(recent, (status) => {
        status.nextEligibleStartAt = FINISHED - 1000 + HOUR + 1;
      }),
      "next eligible start is not the exact retry under both rolling caps",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("embedded renderer: rejects malformed work, times and outcomes", async () => {
  const root = await makeRoot("sentinel-local-render-shape-");
  try {
    const base = await produceSnapshot(
      repairSnapshot(
        [work("w-1", "work", 1), work("w-2", "work", 2)],
        [
          chargedReservation("r-open", FINISHED - 1000),
          chargedReservation("r-settled", FINISHED - 2000, {
            outcome: "submitted",
            settledAt: FINISHED - 1500,
          }),
        ],
      ),
      root,
    );
    const workAt = (status: Record<string, unknown>, index: number) =>
      (status.work as Array<Record<string, unknown>>)[index];
    const reservationAt = (status: Record<string, unknown>, index: number) =>
      (status.reservations as Array<Record<string, unknown>>)[index];

    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).id = "";
      }),
      "a work id is not a bounded non-empty string",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).id = "x".repeat(257);
      }),
      "a work id is not a bounded non-empty string",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 1).id = workAt(status, 0).id;
      }),
      "work detail repeats a work identity",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).sourceKind = "mystery";
      }),
      "a work source kind is not a known value",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).issueNumber = 0;
      }),
      "a work issue number is not null or a positive safe integer",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).issueNumber = 1.5;
      }),
      "a work issue number is not null or a positive safe integer",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).pr = "7";
      }),
      "a work PR number is not null or a positive safe integer",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).pr = 0;
      }),
      "a work PR number is not null or a positive safe integer",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).head = "abc";
      }),
      "a work head is not null or 40 lowercase hex characters",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).head = "A".repeat(40);
      }),
      "a work head is not null or 40 lowercase hex characters",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).updatedAt = FINISHED + 1;
      }),
      "a work updatedAt is after the observation time",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).updatedAt = FINISHED - 0.5;
      }),
      "a work updatedAt is not a valid time",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).updatedAt = -1;
      }),
      "a work updatedAt is not a valid time",
    );
    await expectRejected(
      mutated(base, (status) => {
        reservationAt(status, 0).createdAt = FINISHED + 1;
      }),
      "a reservation createdAt is after the observation time",
    );
    await expectRejected(
      mutated(base, (status) => {
        reservationAt(status, 0).createdAt = -1;
      }),
      "a reservation createdAt is not a valid time",
    );
    await expectRejected(
      mutated(base, (status) => {
        reservationAt(status, 0).createdAt = FINISHED - 1000.5;
      }),
      "a reservation createdAt is not a valid time",
    );
    await expectRejected(
      mutated(base, (status) => {
        reservationAt(status, 0).settledAt = FINISHED - 500;
      }),
      "a reserved reservation carries a settlement time",
    );
    await expectRejected(
      mutated(base, (status) => {
        reservationAt(status, 1).settledAt = null;
      }),
      "a settled reservation is missing a valid settlement time",
    );
    await expectRejected(
      mutated(base, (status) => {
        reservationAt(status, 1).settledAt =
          (reservationAt(status, 1).createdAt as number) - 1;
      }),
      "a reservation settled before it was created",
    );
    await expectRejected(
      mutated(base, (status) => {
        reservationAt(status, 1).settledAt = FINISHED + 1;
      }),
      "a reservation settled after the observation time",
    );
    await expectRejected(
      mutated(base, (status) => {
        status.startedAt = -1;
      }),
      "startedAt and finishedAt are not valid observation times",
    );
    await expectRejected(
      mutated(base, (status) => {
        status.finishedAt = FINISHED - 0.5;
      }),
      "startedAt and finishedAt are not valid observation times",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("embedded renderer: truncated detail keeps complete counts and bounded retry", async () => {
  const root = await makeRoot("sentinel-local-render-truncated-");
  try {
    const base = await produceSnapshot(
      repairSnapshot(
        [blockedWork("blk-1", 5)],
        [
          chargedReservation("r-000-oldest", FINISHED - 4000),
          chargedReservation("r-001-second", FINISHED - 3990),
          ...chargedReservations("r-100-mid", 58, FINISHED - 2000),
          chargedReservation("r-999-newest", FINISHED - 1000),
        ],
      ),
      root,
    );
    const R = reservationAggregates(base.status);
    assert.equal(R.total, 61);
    assert.equal(R.omitted, 0);
    assert.equal(R.chargedHour, 61);
    assert.equal(base.status.nextEligibleStartAt, FINISHED - 3990 + HOUR);

    // A valid truncated report: the newest charge is omitted from the bounded
    // detail while the complete counts and its true retry stay in place.
    const truncated = mutated(base, (status) => {
      (status.aggregates as { reservations: { omitted: number } })
        .reservations.omitted = 1;
      (status.reservations as Array<Record<string, unknown>>).pop();
      status.summary = "truncated";
    });
    const rendered = await expectRecorded(
      truncated,
      "RED",
      "blocked work is present",
    );
    assert.ok(!rendered.summary.includes("NOT RECORDED"), rendered.summary);
    assert.ok(rendered.summary.includes("61 total"), rendered.summary);
    assert.ok(rendered.summary.includes("1 omitted"), rendered.summary);
    assert.ok(
      rendered.summary.includes("Rolling usage: 61 of 60"),
      rendered.summary,
    );

    // Missing detail must not be reported as zero charged usage.
    await expectRejected(
      mutated(base, (status) => {
        const reservations = (status.aggregates as {
          reservations: { chargedHour: number; chargedSevenDays: number };
        }).reservations;
        reservations.chargedHour = 0;
        reservations.chargedSevenDays = 0;
        status.nextEligibleStartAt = null;
      }),
      "rolling hour usage is inconsistent with the bounded detail",
    );

    // A retry earlier than the visible charged history proves is rejected.
    await expectRejected(
      mutated(base, (status) => {
        (status.aggregates as { reservations: { omitted: number } })
          .reservations.omitted = 1;
        (status.reservations as Array<Record<string, unknown>>).pop();
        status.summary = "truncated";
        status.nextEligibleStartAt = FINISHED - 4000 + HOUR - 1;
      }),
      "next eligible start is earlier than the charged detail proves",
    );

    // With every reservation visible the exact retry stays enforced.
    await expectRejected(
      mutated(base, (status) => {
        status.nextEligibleStartAt = FINISHED - 1000 + HOUR + 1;
      }),
      "next eligible start is not the exact retry under both rolling caps",
    );
    await expectRejected(
      mutated(base, (status) => {
        status.nextEligibleStartAt = FINISHED;
      }),
      "next eligible start is not after the observation time",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("embedded renderer: rejects an omitted hourly charge hidden by visible weekly usage", async () => {
  const root = await makeRoot("sentinel-local-render-omitted-");
  try {
    const produced = await produceSnapshot(
      repairSnapshot([], [
        ...chargedReservations("r-hour", 60, FINISHED - 1),
        ...chargedReservations("r-wk", 60, FINISHED - 2 * HOUR),
      ]),
      root,
    );
    const R = reservationAggregates(produced.status);
    assert.equal(R.total, 120);
    assert.equal(R.open, 120);
    assert.equal(R.chargedHour, 60);
    assert.equal(R.chargedSevenDays, 120);
    assert.equal(produced.status.nextEligibleStartAt, FINISHED - 1 + HOUR);
    const visibleIds = detail(produced.status, "reservations").map((entry) =>
      entry.taskId
    );
    assert.equal(visibleIds.length, 120);
    assert.equal(visibleIds[0], "task:r-hour-000");
    assert.equal(visibleIds[119], "task:r-wk-059");

    // Truncated dispatch: only the older weekly-only charges stay visible, the
    // newer hourly charges are omitted, and the weekly aggregate is lowered to
    // match the visible detail. Every per-category bound still passes, but the
    // pair is impossible because each omitted hourly charge must also be an
    // omitted weekly charge, so the weekly aggregate cannot drop to 60.
    const truncated = mutated(produced, (status) => {
      const visible = status.reservations as Array<Record<string, unknown>>;
      status.reservations = visible.filter((entry) =>
        entry.createdAt === FINISHED - 2 * HOUR
      );
      const reservations = (status.aggregates as {
        reservations: { omitted: number; chargedSevenDays: number };
      }).reservations;
      reservations.omitted = 60;
      reservations.chargedSevenDays = 60;
      status.summary = "truncated";
    });
    await expectRejected(
      truncated,
      "omitted rolling usage is inconsistent: every omitted hourly charge is also an omitted seven-day charge",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("embedded renderer: isolated state_error and source_error outcomes are RED for that outcome", async () => {
  const root = await makeRoot("sentinel-local-render-outcome-");
  try {
    const cases = [
      {
        outcome: {
          status: "state_error" as const,
          detail: "isolated state failure",
        },
        snapshot: repairSnapshot(),
      },
      {
        outcome: {
          status: "source_error" as const,
          detail: "isolated source failure",
        },
        snapshot: repairSnapshot([work("w-1", "work", 1)]),
      },
    ];
    for (const item of cases) {
      const outcomeStatus = item.outcome.status;
      const produced = await produceSnapshot(item.snapshot, root, {
        outcome: item.outcome,
      });
      const W = workAggregates(produced.status);
      assert.equal(W.blocked, 0, "the parsed state carries no blocked work");
      assert.equal(
        W.unknownSteps,
        0,
        "the parsed state carries no unknown steps",
      );
      assert.equal(
        (produced.status.outcome as { status: string }).status,
        outcomeStatus,
        "the produced JSON preserves the original outcome status",
      );

      // The RED verdict comes from the recorded error outcome itself, not from
      // blocked or unknown parsed state.
      const rendered = await expectRecorded(
        produced.fileText,
        "RED",
        "the local run ended with " + outcomeStatus,
      );
      assert.ok(
        rendered.summary.includes(
          "Result: RECORDED - RED (the local run ended with " + outcomeStatus +
            ")",
        ),
        rendered.summary,
      );
      assert.ok(
        !rendered.summary.includes("blocked work is present"),
        rendered.summary,
      );
      assert.ok(
        !rendered.summary.includes("unrecognized work steps are present"),
        rendered.summary,
      );

      const receipt = await readLocalRunStatus(root);
      assert.ok(receipt.ok, "the produced envelope parses");
      if (!receipt.ok) throw new Error("unreachable");
      assert.ok(receipt.value !== null);
      if (receipt.value === null) throw new Error("unreachable");
      assert.equal(
        receipt.value.outcome,
        outcomeStatus,
        "the retained receipt preserves the original outcome status",
      );
      assert.equal(receipt.value.stateAvailable, true);
    }

    // A blocked report is RED because of the blocked work, not because
    // reporting invented a repair error: the idle outcome stays idle.
    const blockedOnly = await produceSnapshot(
      repairSnapshot([blockedWork("blk-1", 7)]),
      root,
    );
    const blockedRendered = await expectRecorded(
      blockedOnly.fileText,
      "RED",
      "blocked work is present",
    );
    assert.ok(
      !blockedRendered.summary.includes("the local run ended with"),
      blockedRendered.summary,
    );
    assert.equal(
      (blockedOnly.status.outcome as { status: string }).status,
      "idle",
    );
    const blockedReceipt = await readLocalRunStatus(root);
    assert.ok(blockedReceipt.ok);
    if (!blockedReceipt.ok) throw new Error("unreachable");
    assert.ok(blockedReceipt.value !== null);
    if (blockedReceipt.value === null) throw new Error("unreachable");
    assert.equal(blockedReceipt.value.outcome, "idle");
    assert.equal(blockedReceipt.value.stateAvailable, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("embedded renderer: stale and future observations stay rejected", async () => {
  const root = await makeRoot("sentinel-local-render-time-");
  try {
    const base = await produceSnapshot(repairSnapshot(), root);
    const stale = await render(mutated(base, (status) => {
      status.startedAt = NOW - 4 * 3_600_000;
      status.finishedAt = NOW - 3 * 3_600_000;
    }));
    assert.equal(stale.code, 1);
    assert.ok(stale.summary.includes("NOT RECORDED - stale local status"));
    const future = await render(mutated(base, (status) => {
      status.startedAt = NOW + 5 * 60_000;
      status.finishedAt = NOW + 10 * 60_000;
    }));
    assert.equal(future.code, 1);
    assert.ok(future.summary.includes("finishedAt is in the future"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("embedded renderer: 50000 code-unit and UTF-8 byte input bounds", async () => {
  const root = await makeRoot("sentinel-local-render-size-");
  try {
    const base = await produceSnapshot(repairSnapshot(), root);
    const text = base.fileText;
    assert.ok(text.length < MAX_TEXT);
    const padTo = (total: number) => text + " ".repeat(total - text.length);

    await expectRecorded(padTo(49_999), "GREEN", "GREEN");
    await expectRecorded(padTo(50_000), "GREEN", "GREEN");
    await expectRejected(padTo(50_001), "exceeds 50000 characters");

    // A bounded multibyte field keeps both units inside the bound.
    const unicodeWithin = mutated(base, (status) => {
      status.login = "中".repeat(50);
    });
    await expectRecorded(unicodeWithin, "GREEN", "GREEN");

    // Multibyte text can pass the code-unit bound and still exceed 50000 bytes.
    const byteOver = mutated(base, (status) => {
      status.login = "中".repeat(45_000);
    });
    assert.ok(byteOver.length <= MAX_TEXT, `code units ${byteOver.length}`);
    assert.ok(
      ENCODER.encode(byteOver).length > MAX_TEXT,
      "the byte bound is the binding one",
    );
    await expectRejected(byteOver, "exceeds 50000 UTF-8 bytes");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
