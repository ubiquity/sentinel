/**
 * Actual-consumer tests for the fixed development-budget maintenance
 * entrypoint.
 *
 * The suite drives the real `runMaintenanceEntrypoint` over the real budget
 * controller and the frozen contract parsers. Only the external borders are
 * small in-process fakes: the bounded git process, the review port, the
 * authenticated reads and the state CAS transport. No network, no model, no
 * credentials and no GitHub writes are involved.
 */

import assert from "node:assert/strict";

import {
  asFindingFingerprint,
} from "../../.sentinel-policy-source/src/contracts/brands.ts";
import type { GitSha } from "../../.sentinel-policy-source/src/contracts/brands.ts";
import { canonicalStringify } from "../../.sentinel-policy-source/src/contracts/canonical.ts";
import { parseBudgetReservationV1 } from "../../.sentinel-policy-source/src/contracts/budget-reservation.ts";
import type { BudgetReservationV1 } from "../../.sentinel-policy-source/src/contracts/budget-reservation.ts";
import { parseReleaseRequestV1 } from "../../.sentinel-policy-source/src/contracts/release.ts";
import type { ReleaseRequestV1 } from "../../.sentinel-policy-source/src/contracts/release.ts";
import { parseReviewReceiptV1 } from "../../.sentinel-policy-source/src/contracts/review-receipt.ts";
import type { ReviewReceiptV1 } from "../../.sentinel-policy-source/src/contracts/review-receipt.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../.sentinel-policy-source/src/contracts/state-snapshots.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../../.sentinel-policy-source/src/contracts/state-snapshots.ts";
import type {
  HostedExecutionIntentV1,
  HostedRuntimeRecordV1,
} from "../../.sentinel-policy-source/src/contracts/hosted-supervisor.ts";
import { HOSTED_RUNTIME_ID } from "../../.sentinel-policy-source/src/contracts/hosted-supervisor.ts";
import {
  portError,
  portOk,
} from "../../.sentinel-policy-source/src/contracts/ports.ts";
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
  StateReadResultV1,
  StateReadView,
  StateWriteResultV1,
} from "../../.sentinel-policy-source/src/contracts/ports.ts";
import { deriveReservationId } from "../../.sentinel-policy-source/src/budget/mod.ts";
import {
  renderReviewJournalBody,
  reviewResultDigest,
} from "../../.sentinel-policy-source/src/github/review-journal.ts";
import type {
  ReviewJournalReadyV1,
  ReviewJournalV1,
} from "../../.sentinel-policy-source/src/github/review-journal.ts";
import {
  deriveReviewReceiptV1,
  reviewRecordId,
} from "../../.sentinel-policy-source/src/github/review-normalize.ts";
import type { GitHubReviewWireV1 } from "../../.sentinel-policy-source/src/github/wire.ts";
import type { CodexReviewPrepareCapabilityV1 } from "../../.sentinel-policy-source/src/github/codex-review-transport.ts";
import type {
  PreparedStructuredReviewV1,
  StructuredReviewCloseV1,
  StructuredReviewOutcomeV1,
  StructuredReviewPrepareV1,
} from "../../.sentinel-policy-source/src/github/codex-reviewer.ts";
import {
  REVIEW_MODEL,
  REVIEW_REASONING,
} from "../../.sentinel-policy-source/src/github/review-journal.ts";
import type {
  ReviewJournalExecutionV1,
  ReviewResultV1,
} from "../../.sentinel-policy-source/src/github/review-journal.ts";
import type { ReviewSnapshotV1 } from "../../.sentinel-policy-source/src/github/review-snapshot.ts";
import {
  releaseRequestId,
  reviewOperationKey,
  workItemIdForPullRequest,
} from "../../.sentinel-policy-source/src/repair/keys.ts";
import type {
  ReplayCommandInputV1,
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../../.sentinel-policy-source/src/replay/runtime.ts";
import {
  gitRun,
  makeRemoteCtx,
  testGitEnv,
  workRecord,
} from "../../.sentinel-policy-source/tests/state/helpers.ts";
import { persistHostedReceipt } from "../../.sentinel-policy-source/tests/host/hosted-receipt-fixture.ts";
import { createReleaseStateStore } from "../../.sentinel-policy-source/src/state/mod.ts";
import {
  DiagnosticReviewPrepareCapabilityV1,
  MAINTENANCE_JOB,
  MAINTENANCE_REVIEWER,
  type MaintenanceGitHubReadsV1,
  type MaintenanceInputV1,
  type MaintenanceReviewPortsV1,
  PULL_REQUEST,
  readMaintenanceRootHead,
  REPOSITORY,
  type ReviewDiagnosticRecordV1,
  REVIEWED_BASE,
  REVIEWED_HEAD,
  runMaintenanceEntrypoint,
  STATIC_IDENTITY,
  STATIC_OBSERVATION,
  STATIC_PR,
  STATIC_PRIOR,
  STATIC_RECEIPT,
  STATIC_RELEASE,
  STATIC_REQUEST,
  STATIC_SOURCE,
} from "../../ops/development-budget-maintenance.ts";

const T0 = 1789478800000;
const LAUNCHER_SHA = "d".repeat(40) as GitSha;
const MERGE_SHA = "b".repeat(40) as GitSha;
const OTHER_SHA = "c".repeat(40) as GitSha;
/** Immutable prior attempt-1 key; the successor binds a suffixed key. */
const PRIOR_OPERATION_KEY = reviewOperationKey(PULL_REQUEST, REVIEWED_HEAD);
const OPERATION_KEY = `${PRIOR_OPERATION_KEY}:attempt-2`;
const REQUEST_ID = "review-request-1";
const REQUESTED_AT = T0 + 5_000;
const WORKFLOW_REF =
  "ubiquity/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor";

/** Immutable published attempt-1 evidence (never retimestamped by tests). */
const PRIOR_RESERVATION_ID =
  "b87d501ae3da4911c1943bc50f2c662cd31bd15cd538cc1fe3b2617ee65941fd";
const PRIOR_REVIEW_ID = 5210219310;
const PRIOR_REQUEST_ID =
  "review-review:54:969edbdfd80d8c8723364038dbf3176bb1a027ce";
const PRIOR_REQUESTED_AT = 1789477005005;
const PRIOR_COMPLETED_AT = 1789477588103;
const PRIOR_WIRE_SUBMITTED_AT = 1789477601000;
const PRIOR_RESULT_SUMMARY =
  "structured review unavailable: the review did not produce a validated result";
const PRIOR_RESULT_DIGEST =
  "23c88a4968014d3a0c778bde81cfb6b9129af33a45dad7f58c72a0640f3b4fb0";

function headFor(sequence: number): GitSha {
  return sequence.toString(16).padStart(40, "0") as GitSha;
}

// ---------------------------------------------------------------------------
// Small injected borders
// ---------------------------------------------------------------------------

/** Monotonic test clock; `stepMs` advances on every read (never sleeps). */
class StepClock implements Clock {
  constructor(
    private value: number,
    private readonly stepMs = 0,
  ) {}

  now(): number {
    const current = this.value;
    this.value += this.stepMs;
    return current;
  }

  set(value: number): void {
    this.value = value;
  }
}

interface ProcessScriptV1 {
  head: GitSha;
  status: string;
}

/** Bounded git border: canned HEAD/status output per directory. */
class ScriptedProcess implements ReplayRuntimeV1 {
  readonly calls: string[][] = [];

  constructor(private readonly scripts: ReadonlyMap<string, ProcessScriptV1>) {}

  run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
    this.calls.push([...input.args]);
    const script = this.scripts.get(input.cwd);
    if (script === undefined) {
      return Promise.resolve(commandResult("spawn_failed", null, ""));
    }
    if (input.args.join(" ").endsWith("rev-parse HEAD")) {
      return Promise.resolve(commandResult("exited", 0, `${script.head}\n`));
    }
    return Promise.resolve(commandResult("exited", 0, script.status));
  }
}

function commandResult(
  outcome: ReplayCommandResultV1["outcome"],
  exitCode: number | null,
  stdout: string,
): ReplayCommandResultV1 {
  return {
    outcome,
    exitCode,
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
    truncated: false,
    settled: outcome === "exited",
    detail: "",
  };
}

/** Real bounded git border for the checkout-identity filesystem proof. */
class LocalProcess implements ReplayRuntimeV1 {
  async run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
    const result = await new Deno.Command(input.executable, {
      args: input.args,
      cwd: input.cwd,
      clearEnv: true,
      env: input.env,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      outcome: "exited",
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: false,
      settled: true,
      detail: "",
    };
  }
}

/** In-memory expected-head CAS state transport over the frozen parsers. */
class MemoryState implements StateReadView, RepairStateWriter {
  repair: RepairStateSnapshotV1;
  release: ReleaseStateSnapshotV1;
  repairHead: GitSha;
  releaseHead: GitSha;
  reads = 0;
  writes = 0;

  constructor(repair: RepairStateSnapshotV1, release: ReleaseStateSnapshotV1) {
    this.repair = repair;
    this.release = release;
    this.repairHead = headFor(repair.sequence);
    this.releaseHead = headFor(release.sequence);
  }

  readRepair(): Promise<
    PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
  > {
    this.reads++;
    return Promise.resolve(portOk({
      status: "found" as const,
      snapshot: this.repair,
      head: this.repairHead,
      ref: null,
    }));
  }

  readRelease(): Promise<
    PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>>
  > {
    this.reads++;
    return Promise.resolve(portOk({
      status: "found" as const,
      snapshot: this.release,
      head: this.releaseHead,
      ref: null,
    }));
  }

  writeRepair(
    next: RepairStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    if (expectedHead !== this.repairHead) {
      return Promise.resolve(portOk({
        status: "conflict" as const,
        currentHead: this.repairHead,
      }));
    }
    const parsed = parseRepairStateSnapshotV1(next);
    const previousHead = this.repairHead;
    this.repair = { ...parsed, stateHead: previousHead };
    this.repairHead = headFor(parsed.sequence);
    this.writes++;
    return Promise.resolve(portOk({
      status: "applied" as const,
      head: this.repairHead,
    }));
  }
}

/** Small review-port fake with call counters. */
class FakeReview implements MaintenanceReviewPortsV1 {
  readonly reviewerIdentity = MAINTENANCE_REVIEWER;
  requestCalls = 0;
  drainCalls = 0;
  settleCalls = 0;
  submitted: ReviewSubmissionV1 | null = null;

  constructor(
    private readonly submission: ReviewRequestOutcomeV1,
    private observation: ReviewObservationV1,
  ) {}

  requestReview(
    request: ReviewSubmissionV1,
  ): Promise<PortResultV1<ReviewRequestOutcomeV1>> {
    this.requestCalls++;
    this.submitted = request;
    return Promise.resolve(portOk(this.submission));
  }

  observeReview(
    _request: ReviewObservationRequestV1,
  ): Promise<PortResultV1<ReviewObservationV1>> {
    return Promise.resolve(portOk(this.observation));
  }

  drainReviews(
    _request: ReviewDrainRequestV1,
  ): Promise<PortResultV1<ReviewDrainReportV1>> {
    this.drainCalls++;
    return Promise.resolve(portOk({
      ok: true,
      operations: [],
      faults: [],
      completedAt: T0,
      deadline: _request.deadline,
      interrupted: _request.interrupt,
    }));
  }

  settle(): Promise<boolean> {
    this.settleCalls++;
    return Promise.resolve(true);
  }
}

class FakeReads implements MaintenanceGitHubReadsV1 {
  verifyCalls = 0;
  verified = true;

  constructor(
    private pull: GitHubPullRequestV1,
    private readonly reviews: GitHubReviewWireV1[] = [],
  ) {}

  setPull(pull: GitHubPullRequestV1): void {
    this.pull = pull;
  }

  readPullRequest(
    _number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    return Promise.resolve(portOk(this.pull));
  }

  readReviews(_number: number): Promise<PortResultV1<GitHubReviewWireV1[]>> {
    return Promise.resolve(portOk(this.reviews));
  }

  verifyHostedReleaseRequest(
    _request: ReleaseRequestV1,
  ): Promise<PortResultV1<boolean>> {
    this.verifyCalls++;
    return Promise.resolve(portOk(this.verified));
  }
}

// ---------------------------------------------------------------------------
// Valid fixtures built through the frozen parsers
// ---------------------------------------------------------------------------

/**
 * The exact published attempt-1 reservation. It is immutable evidence for the
 * attempt-2 admission gate and is preserved byte-for-byte by every test.
 */
function priorReservation(): BudgetReservationV1 {
  return parseBudgetReservationV1({
    version: "v1",
    kind: "budget_reservation",
    repository: REPOSITORY,
    id: PRIOR_RESERVATION_ID,
    taskId: "pr-ubiquity-sentinel-54",
    attempt: 1,
    head: REVIEWED_HEAD,
    purpose: "review_request",
    createdAt: 1789476994016,
    outcome: "submitted",
    settledAt: 1789477027883,
    proofRef: null,
  });
}

/** The exact published terminal attempt-1 ready journal. */
async function priorJournal(): Promise<ReviewJournalReadyV1> {
  const result: ReviewResultV1 = {
    verdict: "unavailable",
    summary: PRIOR_RESULT_SUMMARY,
    findings: [],
  };
  return {
    version: "v1",
    phase: "ready",
    repository: { owner: REPOSITORY.owner, name: REPOSITORY.name },
    prNumber: PULL_REQUEST,
    expectedHead: REVIEWED_HEAD,
    expectedBase: REVIEWED_BASE,
    operationKey: PRIOR_OPERATION_KEY,
    publisher: MAINTENANCE_REVIEWER,
    requestId: PRIOR_REQUEST_ID,
    requestedAt: PRIOR_REQUESTED_AT,
    reviewId: PRIOR_REVIEW_ID,
    completedAt: PRIOR_COMPLETED_AT,
    result,
    resultDigest: await reviewResultDigest(result),
    execution: null,
  };
}

/** Explicit mismatch override for the prior terminal journal fixture. */
interface PriorJournalOverrideV1 {
  completedAt?: number;
  reviewId?: number;
}

/** The exact prior journal body, with explicit mismatch overrides allowed. */
async function priorJournalBody(
  overrides: PriorJournalOverrideV1 = {},
): Promise<string> {
  const journal = await priorJournal();
  return renderReviewJournalBody({
    ...journal,
    completedAt: overrides.completedAt ?? journal.completedAt,
    reviewId: overrides.reviewId ?? journal.reviewId,
  });
}

/** Tiny prior wire helper; defaults are the exact published attempt-1 wire. */
async function priorReviewWire(
  overrides: Partial<GitHubReviewWireV1> = {},
  journalOverrides: PriorJournalOverrideV1 = {},
): Promise<GitHubReviewWireV1> {
  return {
    id: overrides.id ?? PRIOR_REVIEW_ID,
    state: overrides.state ?? "commented",
    body: overrides.body ?? await priorJournalBody(journalOverrides),
    author: overrides.author ?? MAINTENANCE_REVIEWER,
    commitSha: overrides.commitSha ?? REVIEWED_HEAD,
    submittedAt: overrides.submittedAt ?? PRIOR_WIRE_SUBMITTED_AT,
  };
}

function repairSnapshot(
  overrides: Record<string, unknown> = {},
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: [],
    reservations: [priorReservation()],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    ...overrides,
  });
}

function runtimeRecord(
  overrides: Record<string, unknown> = {},
): HostedRuntimeRecordV1 {
  return {
    version: "v1",
    kind: "hosted_runtime",
    id: HOSTED_RUNTIME_ID,
    activeRevision: REVIEWED_BASE,
    generation: 3,
    lastHealthyProof: null,
    lastExecutionProof: null,
    nextOrdinaryAt: T0,
    execution: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  } as unknown as HostedRuntimeRecordV1;
}

function releaseSnapshot(
  overrides: Record<string, unknown> = {},
): ReleaseStateSnapshotV1 {
  return parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    releases: [],
    hostedRuntimes: [runtimeRecord()],
    hostedReleases: [],
    githubCooldowns: [],
    ...overrides,
  });
}

function executionIntent(): HostedExecutionIntentV1 {
  return {
    id: `34874909140:1:repair`,
    runId: 34874909140,
    runAttempt: 1,
    launcherSha: LAUNCHER_SHA,
    purpose: "ordinary",
    revision: REVIEWED_BASE,
    generation: 3,
    releaseId: null,
    createdAt: T0,
  };
}

function finding(): ReviewReceiptV1["findings"][number] {
  return {
    id: "finding-1",
    severity: "P1",
    path: "src/example.ts",
    message: "must not infer release readiness",
    fingerprint: asFindingFingerprint("a".repeat(64)),
    resolved: false,
    resolutionEvidence: null,
  };
}

function completedObservation(
  overrides: Partial<ReviewObservationV1> = {},
): ReviewObservationV1 {
  return {
    status: "completed",
    requestId: REQUEST_ID,
    reviewer: MAINTENANCE_REVIEWER,
    resultId: "review-result-1",
    completedAt: T0 + 60_000,
    observedHead: REVIEWED_HEAD,
    observedBase: REVIEWED_BASE,
    findings: [finding()],
    summary: "one blocking finding",
    receivedAt: T0 + 61_000,
    ...overrides,
  };
}

function pendingObservation(): ReviewObservationV1 {
  return {
    status: "pending",
    requestId: "",
    reviewer: null,
    resultId: null,
    completedAt: null,
    observedHead: null,
    observedBase: null,
    findings: [],
    summary: null,
    receivedAt: T0 + 1_000,
  };
}

function openPullRequest(
  overrides: Partial<GitHubPullRequestV1> = {},
): GitHubPullRequestV1 {
  return {
    number: PULL_REQUEST,
    title: "candidate refresh",
    body: "",
    state: "open",
    head: REVIEWED_HEAD,
    base: REVIEWED_BASE,
    mergeSha: null,
    headRef: "codex/candidate",
    baseRef: "sentinel-supervisor",
    author: "github-actions[bot]",
    createdAt: T0,
    updatedAt: T0,
    mergedAt: null,
    reviewDecision: "none",
    ...overrides,
  };
}

function mergedPullRequest(
  overrides: Partial<GitHubPullRequestV1> = {},
): GitHubPullRequestV1 {
  return openPullRequest({
    state: "merged",
    mergeSha: MERGE_SHA,
    mergedAt: T0 + 120_000,
    ...overrides,
  });
}

function derivedReceipt(
  observation: ReviewObservationV1,
): ReviewReceiptV1 {
  return deriveReviewReceiptV1(observation, {
    operationKey: OPERATION_KEY,
    submittedAt: REQUESTED_AT,
    prNumber: PULL_REQUEST,
    expectedHead: REVIEWED_HEAD,
    expectedBase: REVIEWED_BASE,
    expectedReviewer: MAINTENANCE_REVIEWER,
  }, REPOSITORY);
}

function journalIntent(): ReviewJournalV1 {
  return {
    version: "v1",
    phase: "intent",
    repository: { owner: REPOSITORY.owner, name: REPOSITORY.name },
    prNumber: PULL_REQUEST,
    expectedHead: REVIEWED_HEAD,
    expectedBase: REVIEWED_BASE,
    operationKey: OPERATION_KEY,
    publisher: MAINTENANCE_REVIEWER,
    requestId: REQUEST_ID,
    requestedAt: REQUESTED_AT,
  };
}

function journalReview(body: string): GitHubReviewWireV1 {
  return {
    id: 1,
    state: "commented",
    body,
    author: MAINTENANCE_REVIEWER,
    commitSha: REVIEWED_HEAD,
    submittedAt: REQUESTED_AT,
  };
}

async function duplicateReservation() {
  const taskId = workItemIdForPullRequest(REPOSITORY, PULL_REQUEST);
  const id = await deriveReservationId({
    repository: REPOSITORY,
    taskId,
    head: REVIEWED_HEAD,
    attempt: 2,
    purpose: "review_request",
  });
  return parseBudgetReservationV1({
    version: "v1",
    kind: "budget_reservation",
    repository: REPOSITORY,
    id,
    taskId,
    attempt: 2,
    head: REVIEWED_HEAD,
    purpose: "review_request",
    createdAt: T0,
    outcome: "reserved",
    settledAt: null,
    proofRef: null,
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessV1 {
  state: MemoryState;
  review: FakeReview;
  reads: FakeReads;
  process: ScriptedProcess;
  clock: StepClock;
  stateRoot: string;
}

async function withHarness(
  options: {
    repair?: RepairStateSnapshotV1;
    release?: ReleaseStateSnapshotV1;
    pull?: GitHubPullRequestV1;
    observation?: ReviewObservationV1;
    submission?: ReviewRequestOutcomeV1;
    reviews?: GitHubReviewWireV1[];
    clockStepMs?: number;
    rootStatus?: string;
  },
  fn: (harness: HarnessV1) => Promise<void>,
): Promise<void> {
  const stateRoot = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-state-test-maintenance-",
  });
  try {
    const state = new MemoryState(
      options.repair ?? repairSnapshot(),
      options.release ?? releaseSnapshot(),
    );
    const review = new FakeReview(
      options.submission ??
        {
          outcome: "applied",
          requestId: REQUEST_ID,
          requestedAt: REQUESTED_AT,
        },
      options.observation ?? completedObservation(),
    );
    const reads = new FakeReads(
      options.pull ?? openPullRequest(),
      options.reviews ?? [await priorReviewWire()],
    );
    const process = new ScriptedProcess(
      new Map([
        [Deno.cwd(), { head: LAUNCHER_SHA, status: options.rootStatus ?? "" }],
        [
          `${Deno.cwd()}/.sentinel-policy-source`,
          { head: REVIEWED_HEAD, status: "" },
        ],
      ]),
    );
    const clock = new StepClock(T0, options.clockStepMs ?? 0);
    await fn({ state, review, reads, process, clock, stateRoot });
  } finally {
    try {
      await Deno.remove(stateRoot, { recursive: true });
    } catch {
      // Best-effort cleanup of this test's own temporary root.
    }
  }
}

function env(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return {
    GITHUB_RUN_ID: "34874909140",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REPOSITORY: "ubiquity/sentinel",
    GITHUB_REF: "refs/heads/sentinel-supervisor",
    GITHUB_SHA: LAUNCHER_SHA,
    GITHUB_WORKFLOW_SHA: LAUNCHER_SHA,
    GITHUB_WORKFLOW_REF: WORKFLOW_REF,
    GITHUB_JOB: MAINTENANCE_JOB,
    HOME: "/home/runner",
    PATH: "/usr/bin:/bin",
    GITHUB_TOKEN: "test-installation-token",
    UOS_AI_TOKEN: "test-model-token",
    ...overrides,
  };
}

function inputFor(
  harness: HarnessV1,
  overrides: Partial<MaintenanceInputV1> = {},
): MaintenanceInputV1 {
  return {
    env: env(),
    rootDir: Deno.cwd(),
    candidateDir: `${Deno.cwd()}/.sentinel-policy-source`,
    stateRoot: harness.stateRoot,
    process: harness.process,
    http: () => Promise.reject(new Error("unexpected http request")),
    clock: harness.clock,
    state: harness.state,
    review: harness.review,
    reads: harness.reads,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Identity and checkout admission
// ---------------------------------------------------------------------------

Deno.test("maintenance rejects a foreign native identity before any operation", async () => {
  await withHarness({}, async (harness) => {
    await assert.rejects(
      () =>
        runMaintenanceEntrypoint(inputFor(harness, {
          env: env({ GITHUB_JOB: "repair" }),
        })),
      (error: unknown) =>
        error instanceof Error && error.message === STATIC_IDENTITY,
    );
    assert.equal(harness.process.calls.length, 0);
    assert.equal(harness.state.reads, 0);
    assert.equal(harness.review.requestCalls, 0);
  });
});

Deno.test("maintenance rejects a workflow SHA that differs from the launcher SHA", async () => {
  await withHarness({}, async (harness) => {
    await assert.rejects(
      () =>
        runMaintenanceEntrypoint(inputFor(harness, {
          env: env({ GITHUB_WORKFLOW_SHA: OTHER_SHA }),
        })),
      (error: unknown) =>
        error instanceof Error && error.message === STATIC_IDENTITY,
    );
    assert.equal(harness.state.reads, 0);
  });
});

Deno.test("maintenance rejects a root checkout that is not the launcher revision", async () => {
  await withHarness({}, async (harness) => {
    const input = inputFor(harness, {
      process: new ScriptedProcess(
        new Map([
          [Deno.cwd(), { head: OTHER_SHA, status: "" }],
        ]),
      ),
    });
    await assert.rejects(
      () => runMaintenanceEntrypoint(input),
      (error: unknown) =>
        error instanceof Error && error.message === STATIC_SOURCE,
    );
    assert.equal(harness.state.reads, 0);
    assert.equal(harness.review.requestCalls, 0);
  });
});

Deno.test("maintenance rejects a dirty root checkout before any credential use", async () => {
  await withHarness({ rootStatus: " M src/main.ts\n" }, async (harness) => {
    await assert.rejects(
      () => runMaintenanceEntrypoint(inputFor(harness)),
      (error: unknown) =>
        error instanceof Error && error.message === STATIC_SOURCE,
    );
    assert.equal(harness.state.reads, 0);
  });
});

Deno.test("maintenance tolerates exactly the trusted candidate checkout as untracked", async () => {
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-state-test-maintenance-git-",
  });
  try {
    const gitHome = `${root}/git-home`;
    await Deno.mkdir(gitHome, { recursive: true });
    const git = testGitEnv(gitHome);
    await Deno.writeTextFile(`${root}/tracked.txt`, "launcher\n");
    assert.equal((await gitRun(root, ["init", "-q"], git)).ok, true);
    assert.equal((await gitRun(root, ["add", "-A"], git)).ok, true);
    assert.equal(
      (await gitRun(root, ["commit", "-q", "-m", "launcher"], git)).ok,
      true,
    );
    const process = new LocalProcess();
    const head = await readMaintenanceRootHead(process, root);

    // A nested candidate checkout at the exact reviewed head is trusted.
    const candidate = `${root}/.sentinel-policy-source`;
    await Deno.mkdir(candidate, { recursive: true });
    await Deno.writeTextFile(`${candidate}/candidate.txt`, "candidate\n");
    assert.equal((await gitRun(candidate, ["init", "-q"], git)).ok, true);
    assert.equal((await gitRun(candidate, ["add", "-A"], git)).ok, true);
    assert.equal(
      (await gitRun(candidate, ["commit", "-q", "-m", "candidate"], git)).ok,
      true,
    );
    assert.equal(await readMaintenanceRootHead(process, root), head);

    // Any other untracked residue still fails closed.
    await Deno.writeTextFile(`${root}/foreign.txt`, "model work\n");
    await assert.rejects(
      () => readMaintenanceRootHead(process, root),
      (error: unknown) =>
        error instanceof Error && error.message === STATIC_SOURCE,
    );
  } finally {
    try {
      await Deno.remove(root, { recursive: true });
    } catch {
      // Best-effort cleanup of this test's own temporary root.
    }
  }
});

// ---------------------------------------------------------------------------
// Runtime admission
// ---------------------------------------------------------------------------

Deno.test("maintenance defers without writes or model when a runtime execution is saved", async () => {
  await withHarness({
    release: releaseSnapshot({
      hostedRuntimes: [runtimeRecord({ execution: executionIntent() })],
    }),
  }, async (harness) => {
    const outcome = await runMaintenanceEntrypoint(inputFor(harness));
    assert.deepEqual(outcome, {
      status: "deferred",
      reason: "execution_pending",
      runId: 34874909140,
      runAttempt: 1,
    });
    assert.equal(harness.state.writes, 0);
    assert.equal(harness.review.requestCalls, 0);
    assert.equal(harness.review.drainCalls, 0);
  });
});

Deno.test("maintenance fails closed on an unexpected active runtime revision", async () => {
  await withHarness({
    release: releaseSnapshot({
      hostedRuntimes: [runtimeRecord({
        activeRevision: OTHER_SHA,
        generation: 4,
      })],
    }),
  }, async (harness) => {
    await assert.rejects(
      () => runMaintenanceEntrypoint(inputFor(harness)),
      (error: unknown) =>
        error instanceof Error && error.message === STATIC_RELEASE,
    );
    assert.equal(harness.state.writes, 0);
    assert.equal(harness.review.requestCalls, 0);
  });
});

// ---------------------------------------------------------------------------
// First review
// ---------------------------------------------------------------------------

Deno.test("maintenance charges exactly one review and appends the exact receipt", async () => {
  await withHarness({
    repair: repairSnapshot({ work: [workRecord("work-1")] }),
    pull: openPullRequest(),
    observation: completedObservation(),
  }, async (harness) => {
    const before = harness.state.repair;
    const outcome = await runMaintenanceEntrypoint(inputFor(harness));
    assert.equal(outcome.status, "reviewed");
    if (outcome.status !== "reviewed") return;
    assert.equal(outcome.admission, "admitted");
    assert.equal(outcome.operationKey, OPERATION_KEY);
    assert.equal(outcome.operationKey, `${PRIOR_OPERATION_KEY}:attempt-2`);
    assert.notEqual(outcome.operationKey, PRIOR_OPERATION_KEY);
    assert.equal(harness.review.submitted?.operationKey, OPERATION_KEY);
    assert.equal(outcome.requestId, REQUEST_ID);
    assert.equal(outcome.releaseReady, false);
    assert.equal(outcome.findingsCount, 1);
    assert.deepEqual(outcome.unresolvedSeverities, ["P1"]);

    // Exactly one real submission, one in-flow drain plus the final drain.
    assert.equal(harness.review.requestCalls, 1);
    assert.equal(
      harness.review.submitted?.expectedReviewer,
      MAINTENANCE_REVIEWER,
    );
    assert.equal(harness.review.submitted?.expectedHead, REVIEWED_HEAD);
    assert.equal(harness.review.submitted?.expectedBase, REVIEWED_BASE);
    assert.equal(harness.review.drainCalls, 2);
    assert.equal(harness.review.settleCalls, 1);

    // Both charges exist: the immutable attempt-1 reservation is preserved
    // byte-for-byte and the separately charged attempt 2 is new and distinct.
    const after = harness.state.repair;
    assert.equal(after.reservations.length, 2);
    const priorCharge = after.reservations.find((entry) =>
      entry.id === PRIOR_RESERVATION_ID
    );
    const reservation = after.reservations.find((entry) => entry.attempt === 2);
    if (priorCharge === undefined || reservation === undefined) {
      throw new Error("attempt-2 admission evidence is missing");
    }
    assert.equal(
      canonicalStringify(priorCharge),
      canonicalStringify(priorReservation()),
    );
    assert.equal(reservation.outcome, "submitted");
    assert.equal(reservation.head, REVIEWED_HEAD);
    assert.equal(reservation.attempt, 2);
    assert.equal(reservation.purpose, "review_request");
    assert.notEqual(reservation.id, PRIOR_RESERVATION_ID);
    assert.equal(
      reservation.id,
      await deriveReservationId({
        repository: REPOSITORY,
        taskId: workItemIdForPullRequest(REPOSITORY, PULL_REQUEST),
        head: REVIEWED_HEAD,
        attempt: 2,
        purpose: "review_request",
      }),
    );

    // The receipt binds the real submitted request id/time and keeps findings.
    assert.equal(after.reviews.length, 1);
    const receipt = after.reviews[0];
    assert.equal(
      receipt.id,
      reviewRecordId(OPERATION_KEY),
    );
    assert.notEqual(receipt.id, reviewRecordId(PRIOR_OPERATION_KEY));
    assert.equal(receipt.requestId, REQUEST_ID);
    assert.equal(receipt.submittedAt, REQUESTED_AT);
    assert.equal(receipt.observedReviewer, MAINTENANCE_REVIEWER);
    assert.equal(receipt.findings.length, 1);
    assert.deepEqual(receipt.unresolvedSeverities, ["P1"]);

    // Every unrelated collection is preserved byte-equivalently.
    assert.equal(
      canonicalStringify(after.work),
      canonicalStringify(before.work),
    );
    assert.equal(
      canonicalStringify(after.releaseRequests),
      canonicalStringify(before.releaseRequests),
    );

    // A second observation of the same closed interval reuses the stored
    // receipt without another submission, write or snapshot change.
    const snapshot = canonicalStringify(harness.state.repair);
    const writes = harness.state.writes;
    const requestCalls = harness.review.requestCalls;
    const duplicate = await runMaintenanceEntrypoint(inputFor(harness));
    assert.equal(duplicate.status, "reviewed");
    if (duplicate.status !== "reviewed") return;
    assert.equal(duplicate.admission, "existing");
    assert.equal(duplicate.receiptId, outcome.receiptId);
    assert.equal(duplicate.requestId, outcome.requestId);
    assert.equal(harness.review.requestCalls, requestCalls);
    assert.equal(harness.state.writes, writes);
    assert.equal(canonicalStringify(harness.state.repair), snapshot);
    assert.equal(
      canonicalStringify(
        harness.state.repair.reservations.find((entry) =>
          entry.id === PRIOR_RESERVATION_ID
        ),
      ),
      canonicalStringify(priorReservation()),
    );
  });
});

Deno.test("maintenance reconciles a duplicate attempt-2 reservation without resubmitting", async () => {
  const body = renderReviewJournalBody(journalIntent());
  const reservation = await duplicateReservation();
  await withHarness({
    repair: repairSnapshot({
      reservations: [priorReservation(), reservation],
    }),
    pull: openPullRequest(),
    observation: completedObservation(),
    reviews: [await priorReviewWire(), journalReview(body)],
  }, async (harness) => {
    const outcome = await runMaintenanceEntrypoint(inputFor(harness));
    assert.equal(outcome.status, "reviewed");
    if (outcome.status !== "reviewed") return;
    assert.equal(outcome.admission, "duplicate");
    assert.equal(outcome.operationKey, OPERATION_KEY);
    assert.equal(harness.review.requestCalls, 0);
    // One settlement write plus one receipt append; no resubmission.
    assert.equal(harness.state.writes, 2);

    const after = harness.state.repair;
    assert.equal(after.reservations.length, 2);
    const priorCharge = after.reservations.find((entry) =>
      entry.id === PRIOR_RESERVATION_ID
    );
    const duplicate = after.reservations.find((entry) => entry.attempt === 2);
    if (priorCharge === undefined || duplicate === undefined) {
      throw new Error("duplicate attempt-2 evidence is missing");
    }
    assert.equal(
      canonicalStringify(priorCharge),
      canonicalStringify(priorReservation()),
    );
    assert.equal(duplicate.id, reservation.id);
    assert.equal(duplicate.outcome, "submitted");
    assert.equal(duplicate.createdAt, T0);
    assert.equal(after.reviews.length, 1);
    assert.equal(after.reviews[0].id, reviewRecordId(OPERATION_KEY));
    // The recovered timestamp is the genuine published journal value, never a
    // value invented by this runner.
    assert.equal(after.reviews[0].submittedAt, REQUESTED_AT);
  });
});

Deno.test("maintenance defers with no write when the durable review journal is missing", async () => {
  const reservation = await duplicateReservation();
  await withHarness({
    repair: repairSnapshot({
      reservations: [priorReservation(), reservation],
    }),
    pull: openPullRequest(),
    observation: pendingObservation(),
    clockStepMs: 60_000,
  }, async (harness) => {
    const outcome = await runMaintenanceEntrypoint(inputFor(harness));
    assert.deepEqual(outcome, {
      status: "deferred",
      reason: "review_journal_unavailable",
      runId: 34874909140,
      runAttempt: 1,
    });
    assert.equal(harness.review.requestCalls, 0);
    assert.equal(harness.state.writes, 0);
    assert.equal(harness.state.repair.reservations.length, 2);
    assert.equal(
      harness.state.repair.reservations.find((entry) => entry.attempt === 2)
        ?.outcome,
      "reserved",
    );
    assert.equal(
      canonicalStringify(
        harness.state.repair.reservations.find((entry) =>
          entry.id === PRIOR_RESERVATION_ID
        ),
      ),
      canonicalStringify(priorReservation()),
    );
    assert.equal(harness.state.repair.reviews.length, 0);
  });
});

Deno.test("maintenance refuses an inexact prior reservation before any attempt-2 charge", async () => {
  const cases: { label: string; reservations: BudgetReservationV1[] }[] = [
    { label: "missing", reservations: [] },
    {
      label: "mismatched-outcome",
      reservations: [{ ...priorReservation(), outcome: "ambiguous" }],
    },
    {
      label: "mismatched-time",
      reservations: [{
        ...priorReservation(),
        createdAt: priorReservation().createdAt + 1,
      }],
    },
  ];
  for (const testCase of cases) {
    await withHarness({
      repair: repairSnapshot({ reservations: testCase.reservations }),
      pull: openPullRequest(),
      observation: completedObservation(),
    }, async (harness) => {
      const before = canonicalStringify(harness.state.repair);
      await assert.rejects(
        () => runMaintenanceEntrypoint(inputFor(harness)),
        (error: unknown) =>
          error instanceof Error && error.message === STATIC_PRIOR,
        `prior reservation ${testCase.label}`,
      );
      assert.equal(harness.review.requestCalls, 0);
      assert.equal(harness.state.writes, 0);
      assert.equal(canonicalStringify(harness.state.repair), before);
    });
  }
});

Deno.test("maintenance refuses an inexact prior terminal journal before any attempt-2 charge", async () => {
  // The constructed fixture is the exact published attempt-1 evidence.
  assert.equal((await priorJournal()).resultDigest, PRIOR_RESULT_DIGEST);
  const cases: { label: string; reviews: GitHubReviewWireV1[] }[] = [
    { label: "missing", reviews: [] },
    {
      label: "mismatched-completed-at",
      reviews: [
        await priorReviewWire({}, { completedAt: PRIOR_COMPLETED_AT + 1 }),
      ],
    },
    {
      label: "mismatched-review-id",
      reviews: [await priorReviewWire({}, { reviewId: PRIOR_REVIEW_ID + 1 })],
    },
  ];
  for (const testCase of cases) {
    await withHarness({
      repair: repairSnapshot(),
      pull: openPullRequest(),
      observation: completedObservation(),
      reviews: testCase.reviews,
    }, async (harness) => {
      const before = canonicalStringify(harness.state.repair);
      await assert.rejects(
        () => runMaintenanceEntrypoint(inputFor(harness)),
        (error: unknown) =>
          error instanceof Error && error.message === STATIC_PRIOR,
        `prior journal ${testCase.label}`,
      );
      assert.equal(harness.review.requestCalls, 0);
      assert.equal(harness.state.writes, 0);
      assert.equal(canonicalStringify(harness.state.repair), before);
    });
  }
});

Deno.test("maintenance fails closed on a mismatched PR head and a mismatched stored receipt", async () => {
  await withHarness(
    { pull: openPullRequest({ head: OTHER_SHA }) },
    async (harness) => {
      await assert.rejects(
        () => runMaintenanceEntrypoint(inputFor(harness)),
        (error: unknown) =>
          error instanceof Error && error.message === STATIC_PR,
      );
      assert.equal(harness.state.writes, 0);
      assert.equal(harness.review.requestCalls, 0);
    },
  );

  const mismatched = parseReviewReceiptV1({
    version: "v1",
    kind: "review_receipt",
    id: reviewRecordId(OPERATION_KEY),
    requestId: REQUEST_ID,
    expectedReviewer: "0x4007",
    observedReviewer: "0x4007",
    repository: REPOSITORY,
    pullRequest: {
      number: PULL_REQUEST,
      head: REVIEWED_HEAD,
      base: REVIEWED_BASE,
    },
    outcome: "completed",
    resultId: "review-result-1",
    summary: null,
    findings: [],
    findingsUncounted: 0,
    unresolvedSeverities: [],
    submittedAt: REQUESTED_AT,
    completedAt: T0 + 60_000,
    observedAt: T0 + 61_000,
  });
  await withHarness({
    repair: repairSnapshot({ reviews: [mismatched] }),
    pull: openPullRequest(),
    observation: completedObservation(),
  }, async (harness) => {
    await assert.rejects(
      () => runMaintenanceEntrypoint(inputFor(harness)),
      (error: unknown) =>
        error instanceof Error && error.message === STATIC_RECEIPT,
    );
    assert.equal(harness.review.requestCalls, 0);
    assert.equal(harness.state.writes, 0);
  });
});

// ---------------------------------------------------------------------------
// Merged PR54: release request without a new review
// ---------------------------------------------------------------------------

Deno.test("maintenance appends the exact release request for a merged PR without a new review", async () => {
  const receipt = derivedReceipt(completedObservation({ findings: [] }));
  // The merged release path re-proves the suffixed attempt-2 receipt only.
  assert.equal(receipt.id, reviewRecordId(OPERATION_KEY));
  assert.notEqual(receipt.id, reviewRecordId(PRIOR_OPERATION_KEY));
  await withHarness({
    repair: repairSnapshot({
      sequence: 2,
      reviews: [receipt],
      work: [workRecord("work-1")],
    }),
    pull: mergedPullRequest({ base: OTHER_SHA }),
    observation: completedObservation({ findings: [] }),
  }, async (harness) => {
    const before = harness.state.repair;
    const outcome = await runMaintenanceEntrypoint(inputFor(harness));
    assert.equal(outcome.status, "release_requested");
    if (outcome.status !== "release_requested") return;
    assert.equal(
      outcome.releaseRequestId,
      await releaseRequestId(REPOSITORY, MERGE_SHA, PULL_REQUEST),
    );
    assert.equal(outcome.mergeSha, MERGE_SHA);
    assert.equal(harness.review.requestCalls, 0);
    assert.equal(harness.reads.verifyCalls, 1);

    const after = harness.state.repair;
    assert.equal(after.releaseRequests.length, 1);
    const request = after.releaseRequests[0];
    assert.equal(
      request.id,
      await releaseRequestId(REPOSITORY, MERGE_SHA, PULL_REQUEST),
    );
    assert.equal(request.revision, MERGE_SHA);
    assert.equal(request.status, "open");
    assert.equal(request.target.environment, "production");
    assert.equal(request.target.repository.installationId, 0);
    assert.equal(request.source.pullRequest, PULL_REQUEST);
    assert.equal(request.source.reviewRequestId, receipt.requestId);
    assert.equal(request.source.reviewReceiptId, receipt.id);
    assert.equal(request.source.head, REVIEWED_HEAD);
    assert.equal(request.source.base, REVIEWED_BASE);
    assert.equal(request.createdAt, T0);

    // No review charge, no unrelated collection change.
    assert.equal(
      canonicalStringify(after.reservations),
      canonicalStringify(before.reservations),
    );
    assert.equal(
      canonicalStringify(after.work),
      canonicalStringify(before.work),
    );
    assert.equal(
      canonicalStringify(after.reviews),
      canonicalStringify(before.reviews),
    );

    // An identical second pass reconciles without rewriting the timestamp.
    harness.clock.set(T0 + 600_000);
    const reconciled = await runMaintenanceEntrypoint(inputFor(harness));
    assert.equal(reconciled.status, "release_requested");
    assert.equal(harness.state.repair.sequence, after.sequence);
    assert.equal(harness.state.repair.releaseRequests[0].createdAt, T0);
    assert.equal(harness.review.requestCalls, 0);
  });
});

Deno.test("maintenance fails closed on a mismatched existing release request", async () => {
  const receipt = derivedReceipt(completedObservation({ findings: [] }));
  const requestId = await releaseRequestId(REPOSITORY, MERGE_SHA, PULL_REQUEST);
  const mismatched = parseReleaseRequestV1({
    version: "v1",
    kind: "release_request",
    id: requestId,
    target: { repository: REPOSITORY, environment: "production" },
    revision: OTHER_SHA,
    source: {
      pullRequest: PULL_REQUEST,
      reviewRequestId: receipt.requestId,
      reviewReceiptId: receipt.id,
      head: REVIEWED_HEAD,
      base: REVIEWED_BASE,
    },
    status: "open",
    failureReason: null,
    createdAt: T0,
  });
  await withHarness({
    repair: repairSnapshot({
      sequence: 2,
      reviews: [receipt],
      releaseRequests: [mismatched],
    }),
    pull: mergedPullRequest(),
    observation: completedObservation({ findings: [] }),
  }, async (harness) => {
    await assert.rejects(
      () => runMaintenanceEntrypoint(inputFor(harness)),
      (error: unknown) =>
        error instanceof Error && error.message === STATIC_REQUEST,
    );
    assert.equal(harness.state.writes, 0);
    assert.equal(harness.review.requestCalls, 0);
  });
});

Deno.test("maintenance fails closed when the merged review no longer matches its receipt", async () => {
  const receipt = derivedReceipt(completedObservation({ findings: [] }));
  await withHarness({
    repair: repairSnapshot({ sequence: 2, reviews: [receipt] }),
    pull: mergedPullRequest(),
    observation: completedObservation({
      findings: [],
      resultId: "different-result",
    }),
  }, async (harness) => {
    await assert.rejects(
      () => runMaintenanceEntrypoint(inputFor(harness)),
      (error: unknown) =>
        error instanceof Error && error.message === STATIC_OBSERVATION,
    );
    assert.equal(harness.state.writes, 0);
    assert.equal(harness.review.requestCalls, 0);
  });
});

// ---------------------------------------------------------------------------
// Installed acceptance binds the exact attempt-2 receipt only
// ---------------------------------------------------------------------------

/** Mutable clock for the legal-lifecycle fixture; the suite never sleeps. */
function lifecycleClock(
  start: number,
): { now(): number; advance(ms: number): void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

Deno.test("maintenance requires the exact attempt-2 receipt for an installed runtime", async () => {
  const currentReceipt = derivedReceipt(completedObservation({ findings: [] }));
  // The same otherwise-valid receipt shape under the immutable attempt-1 key.
  const oldReceipt = deriveReviewReceiptV1(
    completedObservation({ findings: [] }),
    {
      operationKey: PRIOR_OPERATION_KEY,
      submittedAt: REQUESTED_AT,
      prNumber: PULL_REQUEST,
      expectedHead: REVIEWED_HEAD,
      expectedBase: REVIEWED_BASE,
      expectedReviewer: MAINTENANCE_REVIEWER,
    },
    REPOSITORY,
  );
  assert.equal(currentReceipt.id, reviewRecordId(OPERATION_KEY));
  assert.equal(oldReceipt.id, reviewRecordId(PRIOR_OPERATION_KEY));
  assert.notEqual(oldReceipt.id, reviewRecordId(OPERATION_KEY));

  const cases: {
    label: string;
    receipt: ReviewReceiptV1;
    refused: boolean;
  }[] = [
    {
      label: "current attempt-2 receipt",
      receipt: currentReceipt,
      refused: false,
    },
    { label: "old attempt-1 receipt", receipt: oldReceipt, refused: true },
  ];

  for (const testCase of cases) {
    const root = await Deno.makeTempDir({
      dir: Deno.cwd(),
      prefix: "sentinel-installed-receipt-",
    });
    try {
      const gitHome = `${root}/git-home`;
      await Deno.mkdir(gitHome, { recursive: true });
      const remote = await makeRemoteCtx(root, testGitEnv(gitHome));
      const store = createReleaseStateStore({
        scratchDir: `${root}/scratch`,
        remoteUrl: remote.remoteUrl,
      });
      // Exact merged-release request, bound to the case's real stored receipt.
      const request = parseReleaseRequestV1({
        version: "v1",
        kind: "release_request",
        id: await releaseRequestId(REPOSITORY, MERGE_SHA, PULL_REQUEST),
        target: { repository: REPOSITORY, environment: "production" },
        revision: MERGE_SHA,
        source: {
          pullRequest: PULL_REQUEST,
          reviewRequestId: testCase.receipt.requestId,
          reviewReceiptId: testCase.receipt.id,
          head: REVIEWED_HEAD,
          base: REVIEWED_BASE,
        },
        status: "open",
        failureReason: null,
        createdAt: T0 + 90_000,
      });
      // Drive the actual supervisor core over the real release store until the
      // accepted record exists; the clock stays after every lifecycle stamp.
      const persisted = await persistHostedReceipt({
        release: store,
        clock: lifecycleClock(T0 + 120_000),
        request,
        priorRevision: REVIEWED_BASE,
        phase: "accepted",
      });
      assert.equal(persisted.phase, "accepted", testCase.label);
      assert.equal(
        persisted.request.source.reviewReceiptId,
        testCase.receipt.id,
        testCase.label,
      );
      const read = await store.readRelease();
      if (!read.ok || read.value.status !== "found") {
        throw new Error(`${testCase.label}: release snapshot is unavailable`);
      }
      const installedRelease = read.value.snapshot;
      const installedRuntime = installedRelease.hostedRuntimes[0];
      assert.equal(installedRuntime.activeRevision, MERGE_SHA, testCase.label);
      assert.equal(installedRuntime.execution, null, testCase.label);

      await withHarness({
        repair: repairSnapshot({
          reviews: [testCase.receipt],
          releaseRequests: [request],
        }),
        release: installedRelease,
        pull: mergedPullRequest(),
        observation: completedObservation({ findings: [] }),
      }, async (harness) => {
        const beforeRepair = canonicalStringify(harness.state.repair);
        const beforeRelease = canonicalStringify(harness.state.release);
        if (testCase.refused) {
          await assert.rejects(
            () => runMaintenanceEntrypoint(inputFor(harness)),
            (error: unknown) =>
              error instanceof Error && error.message === STATIC_RECEIPT,
            testCase.label,
          );
        } else {
          const outcome = await runMaintenanceEntrypoint(inputFor(harness));
          assert.equal(outcome.status, "already_installed", testCase.label);
          if (outcome.status !== "already_installed") return;
          assert.equal(outcome.requestId, request.id);
          assert.equal(outcome.receiptId, currentReceipt.id);
          assert.equal(outcome.revision, MERGE_SHA);
          assert.equal(outcome.generation, installedRuntime.generation);
        }
        // No state write, no model/review request, no merge verification, and
        // both durable snapshots byte-for-byte preserved.
        assert.equal(harness.state.writes, 0, testCase.label);
        assert.equal(harness.review.requestCalls, 0, testCase.label);
        assert.equal(harness.reads.verifyCalls, 0, testCase.label);
        assert.equal(
          canonicalStringify(harness.state.repair),
          beforeRepair,
          testCase.label,
        );
        assert.equal(
          canonicalStringify(harness.state.release),
          beforeRelease,
          testCase.label,
        );
      });
    } finally {
      try {
        await Deno.remove(root, { recursive: true });
      } catch {
        // Best-effort cleanup of this test's own temporary root.
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Bounded prepare/start/close review diagnostics
// ---------------------------------------------------------------------------

/** Allowlisted static archive detail used for a captured-detail assertion. */
const DIAGNOSTIC_UNAVAILABLE_DETAIL =
  "structured review unavailable: the owned transport reported a fatal failure";
/** Arbitrary secret/payload that must never reach a diagnostic line. */
const DIAGNOSTIC_SECRET = "diagnostic-secret-payload-7f3a";

const DIAGNOSTIC_EXECUTION: ReviewJournalExecutionV1 = {
  ownerRunId: "owner-run",
  invocationId: "invocation-1",
  threadId: "diag-thread",
  submittedProvider: "uos",
  model: REVIEW_MODEL,
  reasoning: REVIEW_REASONING,
  startMayOccur: true,
};

function diagnosticPrepareRequest(): StructuredReviewPrepareV1 {
  return {
    snapshot: {} as ReviewSnapshotV1,
    requestId: "review-request-diag",
    invocationId: "invocation-1",
    ownerRunId: "owner-run",
    latestStartAt: T0 + 1_000,
    settleBy: T0 + 2_000,
  };
}

function diagnosticRecords(lines: string[]): ReviewDiagnosticRecordV1[] {
  return lines.map((line) => JSON.parse(line) as ReviewDiagnosticRecordV1);
}

function cleanOutcome(): StructuredReviewOutcomeV1 {
  return {
    status: "clean",
    result: null,
    resultId: null,
    actual: null,
    execution: null,
    detail: null,
  };
}

function closeOutcome(
  settled: boolean,
  timedOut: boolean,
  failure: string | null,
): StructuredReviewCloseV1 {
  return { settled, timedOut, failure };
}

function prepareCapability(
  prepare: (
    request: StructuredReviewPrepareV1,
  ) => Promise<PortResultV1<PreparedStructuredReviewV1>>,
): CodexReviewPrepareCapabilityV1 {
  return { prepare };
}

/** Small fake prepared handle: prototype methods and known immutable fields. */
class FakePreparedStructuredReviewV1 implements PreparedStructuredReviewV1 {
  readonly execution: ReviewJournalExecutionV1 = DIAGNOSTIC_EXECUTION;
  readonly threadId = "diag-thread";
  readonly invocationId = "invocation-1";
  readonly requestId = "review-request-diag";
  readonly ownerRunId = "owner-run";
  readonly latestStartAt = T0 + 1_000;
  readonly settleBy = T0 + 2_000;
  startCalls = 0;
  closeCalls = 0;
  private attempted = false;

  constructor(
    private readonly startValue: PortResultV1<StructuredReviewOutcomeV1>,
    private readonly closeValue: StructuredReviewCloseV1,
  ) {}

  startAttempted(): boolean {
    return this.attempted;
  }

  start(): Promise<PortResultV1<StructuredReviewOutcomeV1>> {
    this.startCalls += 1;
    this.attempted = true;
    return Promise.resolve(this.startValue);
  }

  close(): Promise<StructuredReviewCloseV1> {
    this.closeCalls += 1;
    return Promise.resolve(this.closeValue);
  }
}

/** Fake handle whose delegated start/close reject with original errors. */
class ThrowingPreparedStructuredReviewV1
  extends FakePreparedStructuredReviewV1 {
  constructor(
    private readonly startError: Error,
    private readonly closeError: Error,
  ) {
    super(portOk(cleanOutcome()), closeOutcome(true, false, null));
  }

  override start(): Promise<PortResultV1<StructuredReviewOutcomeV1>> {
    return Promise.reject(this.startError);
  }

  override close(): Promise<StructuredReviewCloseV1> {
    return Promise.reject(this.closeError);
  }
}

Deno.test("diagnostic prepare delegates once and forwards every immutable handle field", async () => {
  const prepared = new FakePreparedStructuredReviewV1(
    portOk(cleanOutcome()),
    closeOutcome(true, false, null),
  );
  const lines: string[] = [];
  let prepareCalls = 0;
  let received: StructuredReviewPrepareV1 | null = null;
  const wrapper = new DiagnosticReviewPrepareCapabilityV1(
    prepareCapability((request) => {
      prepareCalls += 1;
      received = request;
      return Promise.resolve(portOk(prepared));
    }),
    (line) => lines.push(line),
  );
  const request = diagnosticPrepareRequest();
  const result = await wrapper.prepare(request);
  assert.equal(prepareCalls, 1);
  assert.ok(received === request);
  if (!result.ok) throw new Error("diagnostic prepare unexpectedly rejected");
  const handle = result.value;
  assert.notEqual(handle, prepared);
  assert.equal(handle.execution, prepared.execution);
  assert.equal(handle.threadId, prepared.threadId);
  assert.equal(handle.invocationId, prepared.invocationId);
  assert.equal(handle.requestId, prepared.requestId);
  assert.equal(handle.ownerRunId, prepared.ownerRunId);
  assert.equal(handle.latestStartAt, prepared.latestStartAt);
  assert.equal(handle.settleBy, prepared.settleBy);
  assert.equal(handle.startAttempted(), false);
  assert.deepEqual(diagnosticRecords(lines), [{
    stage: "prepare",
    outcome: "prepared",
    status: null,
    detail: null,
    settled: null,
    timedOut: null,
    hasFailure: null,
    classification: null,
  }]);
});

Deno.test("diagnostic wrapper keeps rejected/start/close PortResult identity and exact delegation counts", async () => {
  const rejection = portError("unavailable", DIAGNOSTIC_UNAVAILABLE_DETAIL);
  const rejectedLines: string[] = [];
  let prepareCalls = 0;
  const rejectedWrapper = new DiagnosticReviewPrepareCapabilityV1(
    prepareCapability(() => {
      prepareCalls += 1;
      return Promise.resolve(rejection);
    }),
    (line) => rejectedLines.push(line),
  );
  const rejected = await rejectedWrapper.prepare(diagnosticPrepareRequest());
  assert.equal(prepareCalls, 1);
  assert.ok(rejected === rejection);
  assert.equal(rejected.ok, false);
  const rejectedRecord = diagnosticRecords(rejectedLines)[0];
  assert.equal(rejectedRecord.outcome, "rejected");
  assert.equal(rejectedRecord.status, "unavailable");
  assert.equal(rejectedRecord.detail, DIAGNOSTIC_UNAVAILABLE_DETAIL);

  const startValue = portOk(cleanOutcome());
  const closeValue = closeOutcome(true, false, null);
  const prepared = new FakePreparedStructuredReviewV1(startValue, closeValue);
  const lines: string[] = [];
  const wrapper = new DiagnosticReviewPrepareCapabilityV1(
    prepareCapability(() => Promise.resolve(portOk(prepared))),
    (line) => lines.push(line),
  );
  const preparedResult = await wrapper.prepare(diagnosticPrepareRequest());
  if (!preparedResult.ok) {
    throw new Error("diagnostic prepare unexpectedly rejected");
  }
  const handle = preparedResult.value;
  const firstStart = await handle.start();
  const secondStart = await handle.start();
  assert.ok(firstStart === startValue);
  assert.ok(secondStart === startValue);
  assert.equal(prepared.startCalls, 2);
  const firstClose = await handle.close();
  const secondClose = await handle.close();
  assert.ok(firstClose === closeValue);
  assert.ok(secondClose === closeValue);
  assert.equal(prepared.closeCalls, 2);
  assert.equal(prepared.startAttempted(), true);
  const startRecord = diagnosticRecords(lines).find((record) =>
    record.stage === "start"
  );
  assert.equal(startRecord?.status, "clean");
  assert.equal(startRecord?.detail, null);
});

Deno.test("diagnostic wrapper reports only unavailable for non-unavailable transport errors", async () => {
  const nonUnavailable = portError("rate_limited", DIAGNOSTIC_SECRET);
  const rejectedLines: string[] = [];
  const rejectedWrapper = new DiagnosticReviewPrepareCapabilityV1(
    prepareCapability(() => Promise.resolve(nonUnavailable)),
    (line) => rejectedLines.push(line),
  );
  const rejected = await rejectedWrapper.prepare(diagnosticPrepareRequest());
  assert.ok(rejected === nonUnavailable);
  const rejectedRecord = diagnosticRecords(rejectedLines)[0];
  assert.equal(rejectedRecord.status, "unavailable");
  assert.equal(rejectedRecord.detail, "unknown-detail");

  const closeValue = closeOutcome(true, false, null);
  const prepared = new FakePreparedStructuredReviewV1(
    nonUnavailable,
    closeValue,
  );
  const lines: string[] = [];
  const wrapper = new DiagnosticReviewPrepareCapabilityV1(
    prepareCapability(() => Promise.resolve(portOk(prepared))),
    (line) => lines.push(line),
  );
  const result = await wrapper.prepare(diagnosticPrepareRequest());
  if (!result.ok) throw new Error("diagnostic prepare unexpectedly rejected");
  const started = await result.value.start();
  assert.ok(started === nonUnavailable);
  const closed = await result.value.close();
  assert.ok(closed === closeValue);
  const records = diagnosticRecords(lines);
  const startRecord = records.find((record) => record.stage === "start");
  const closeRecord = records.find((record) => record.stage === "close");
  assert.equal(startRecord?.status, "unavailable");
  assert.equal(startRecord?.detail, "unknown-detail");
  assert.equal(closeRecord?.classification, "unavailable");
  for (const line of lines) {
    assert.ok(!line.includes(DIAGNOSTIC_SECRET));
  }
});

Deno.test("diagnostic wrapper captures allowlisted static detail and redacts arbitrary payloads", async () => {
  const prepared = new FakePreparedStructuredReviewV1(
    portOk({
      status: "clean",
      result: { summary: DIAGNOSTIC_SECRET } as unknown as ReviewResultV1,
      resultId: null,
      actual: null,
      execution: null,
      detail: DIAGNOSTIC_SECRET,
    }),
    closeOutcome(false, false, DIAGNOSTIC_SECRET),
  );
  const lines: string[] = [];
  const wrapper = new DiagnosticReviewPrepareCapabilityV1(
    prepareCapability(() => Promise.resolve(portOk(prepared))),
    (line) => lines.push(line),
  );
  const preparedResult = await wrapper.prepare(diagnosticPrepareRequest());
  if (!preparedResult.ok) {
    throw new Error("diagnostic prepare unexpectedly rejected");
  }
  const startResult = await preparedResult.value.start();
  assert.equal(startResult.ok, true);
  const closeResult = await preparedResult.value.close();
  assert.equal(closeResult.settled, false);
  const records = diagnosticRecords(lines);
  const startRecord = records.find((record) => record.stage === "start");
  const closeRecord = records.find((record) => record.stage === "close");
  if (startRecord === undefined || closeRecord === undefined) {
    throw new Error("missing diagnostic stage records");
  }
  assert.equal(startRecord.status, "clean");
  assert.equal(startRecord.detail, "unknown-detail");
  assert.equal(closeRecord.settled, false);
  assert.equal(closeRecord.timedOut, false);
  assert.equal(closeRecord.hasFailure, true);
  for (const line of lines) {
    assert.ok(!line.includes(DIAGNOSTIC_SECRET));
  }

  const rejectedLines: string[] = [];
  const rejectedWrapper = new DiagnosticReviewPrepareCapabilityV1(
    prepareCapability(() =>
      Promise.resolve(portError("unavailable", DIAGNOSTIC_SECRET))
    ),
    (line) => rejectedLines.push(line),
  );
  const rejected = await rejectedWrapper.prepare(diagnosticPrepareRequest());
  assert.equal(rejected.ok, false);
  assert.equal(diagnosticRecords(rejectedLines)[0].detail, "unknown-detail");
  for (const line of rejectedLines) {
    assert.ok(!line.includes(DIAGNOSTIC_SECRET));
  }

  const allowedLines: string[] = [];
  const allowedWrapper = new DiagnosticReviewPrepareCapabilityV1(
    prepareCapability(() =>
      Promise.resolve(portError("unavailable", DIAGNOSTIC_UNAVAILABLE_DETAIL))
    ),
    (line) => allowedLines.push(line),
  );
  const allowed = await allowedWrapper.prepare(diagnosticPrepareRequest());
  assert.equal(allowed.ok, false);
  assert.equal(
    diagnosticRecords(allowedLines)[0].detail,
    DIAGNOSTIC_UNAVAILABLE_DETAIL,
  );
});

Deno.test("diagnostic close classification reports dirty-close invalidation without changing returned values", async () => {
  const startValue = portOk(cleanOutcome());
  const dirtyClose = closeOutcome(false, true, null);
  const prepared = new FakePreparedStructuredReviewV1(startValue, dirtyClose);
  const lines: string[] = [];
  const wrapper = new DiagnosticReviewPrepareCapabilityV1(
    prepareCapability(() => Promise.resolve(portOk(prepared))),
    (line) => lines.push(line),
  );
  const preparedResult = await wrapper.prepare(diagnosticPrepareRequest());
  if (!preparedResult.ok) {
    throw new Error("diagnostic prepare unexpectedly rejected");
  }
  const handle = preparedResult.value;
  const started = await handle.start();
  const closed = await handle.close();
  assert.ok(started === startValue);
  assert.ok(closed === dirtyClose);
  const records = diagnosticRecords(lines);
  const startRecord = records.find((record) => record.stage === "start");
  const closeRecord = records.find((record) => record.stage === "close");
  if (startRecord === undefined || closeRecord === undefined) {
    throw new Error("missing diagnostic stage records");
  }
  assert.equal(startRecord.status, "clean");
  assert.equal(closeRecord.settled, false);
  assert.equal(closeRecord.timedOut, true);
  assert.equal(closeRecord.hasFailure, false);
  assert.equal(closeRecord.classification, "unavailable");

  const cleanPrepared = new FakePreparedStructuredReviewV1(
    startValue,
    closeOutcome(true, false, null),
  );
  const cleanLines: string[] = [];
  const cleanWrapper = new DiagnosticReviewPrepareCapabilityV1(
    prepareCapability(() => Promise.resolve(portOk(cleanPrepared))),
    (line) => cleanLines.push(line),
  );
  const cleanResult = await cleanWrapper.prepare(diagnosticPrepareRequest());
  if (!cleanResult.ok) {
    throw new Error("diagnostic prepare unexpectedly rejected");
  }
  await cleanResult.value.start();
  await cleanResult.value.close();
  const cleanClose = diagnosticRecords(cleanLines).find((record) =>
    record.stage === "close"
  );
  assert.equal(cleanClose?.classification, "clean");
});

Deno.test("diagnostic wrapper preserves original throws and tolerates a throwing reporter", async () => {
  const prepareError = new Error(`${DIAGNOSTIC_SECRET}:prepare`);
  const startError = new Error(`${DIAGNOSTIC_SECRET}:start`);
  const closeError = new Error(`${DIAGNOSTIC_SECRET}:close`);
  const throwingReporter = () => {
    throw new Error("reporter unavailable");
  };
  let prepareCalls = 0;
  const wrapper = new DiagnosticReviewPrepareCapabilityV1(
    prepareCapability(() => {
      prepareCalls += 1;
      return Promise.reject(prepareError);
    }),
    throwingReporter,
  );
  let caughtPrepare: unknown = null;
  try {
    await wrapper.prepare(diagnosticPrepareRequest());
  } catch (error) {
    caughtPrepare = error;
  }
  assert.ok(caughtPrepare === prepareError);
  assert.equal(prepareCalls, 1);

  const prepared = new ThrowingPreparedStructuredReviewV1(
    startError,
    closeError,
  );
  const throwingWrapper = new DiagnosticReviewPrepareCapabilityV1(
    prepareCapability(() => Promise.resolve(portOk(prepared))),
    throwingReporter,
  );
  const throwingResult = await throwingWrapper.prepare(
    diagnosticPrepareRequest(),
  );
  if (!throwingResult.ok) {
    throw new Error("diagnostic prepare unexpectedly rejected");
  }
  assert.equal(throwingResult.value.startAttempted(), false);
  let caughtStart: unknown = null;
  try {
    await throwingResult.value.start();
  } catch (error) {
    caughtStart = error;
  }
  assert.ok(caughtStart === startError);
  let caughtClose: unknown = null;
  try {
    await throwingResult.value.close();
  } catch (error) {
    caughtClose = error;
  }
  assert.ok(caughtClose === closeError);

  const healthy = new FakePreparedStructuredReviewV1(
    portOk(cleanOutcome()),
    closeOutcome(true, false, null),
  );
  const healthyWrapper = new DiagnosticReviewPrepareCapabilityV1(
    prepareCapability(() => Promise.resolve(portOk(healthy))),
    throwingReporter,
  );
  const healthyResult = await healthyWrapper.prepare(
    diagnosticPrepareRequest(),
  );
  if (!healthyResult.ok) {
    throw new Error("diagnostic prepare unexpectedly rejected");
  }
  const started = await healthyResult.value.start();
  assert.equal(started.ok, true);
  assert.equal(healthy.startCalls, 1);
  const closed = await healthyResult.value.close();
  assert.equal(closed.settled, true);
  assert.equal(healthy.closeCalls, 1);
});
