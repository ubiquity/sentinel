/**
 * Fixed hosted supervisor composition.
 *
 * This entrypoint runs only from the protected `sentinel-supervisor` source
 * ref. Its protected prepare/finalize jobs compose hosted runtime pointer
 * selection and authenticated execution settlement through the release-role
 * App state, seeding the release ref exactly once before any gate use. The
 * repair job never receives App credentials or this environment, no model
 * token is read here, and this module never writes repair state: Deno release
 * promotion remains a separate controller.
 */

import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import {
  HOSTED_RUNTIME_ID,
  parseHostedExecutionIntentV1,
  parseHostedExecutionSettlementV1,
  parseHostedReleaseRecordV1,
} from "../contracts/hosted-supervisor.ts";
import type {
  HostedExecutionIntentV1,
  HostedExecutionSettlementV1,
  HostedPointerIntentV1,
  HostedReleaseRecordV1,
  HostedRuntimeRecordV1,
} from "../contracts/hosted-supervisor.ts";
import type {
  Clock,
  PortErrorV1,
  PortResultV1,
  ReleaseStateWriter,
  StateReadResultV1,
  StateReadView,
  StateWriteResultV1,
} from "../contracts/ports.ts";
import { portOk, SystemClock } from "../contracts/ports.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { parseReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import { tryParse } from "../contracts/validation.ts";
import { GitHubApiClient } from "../github/client.ts";
import { fetchHttpTransport } from "../github/http.ts";
import type { HttpTransportV1 } from "../github/http.ts";
import { DenoReplayRuntime } from "../replay/runtime.ts";
import type { ReplayRuntimeV1 } from "../replay/runtime.ts";
import { createReleaseStateStore, DenoGitRunner } from "../state/mod.ts";
import { HostedSupervisorCooldownGate } from "./hosted-cooldown.ts";
import {
  parseHostedEnvironment,
  readCleanGitHead,
  readHostedIdentityEnv,
} from "./hosted-runtime.ts";
import type { HostedRuntimeJobV1 } from "./hosted-runtime.ts";
import { ensurePrivateDir, githubGitAuthEnv, joinPath } from "./local.ts";

const REMOTE_URL = "https://github.com/ubiquity/sentinel.git";
const SUPERVISOR_TOKEN_ENV = "SENTINEL_SUPERVISOR_TOKEN";
const STATIC_TOKEN = "hosted supervisor credentials are unavailable";
const STATIC_STATE = "hosted supervisor release state is unavailable";
const STATIC_SEED = "hosted supervisor release state could not be seeded";

export interface HostedSupervisorBootstrapResultV1 {
  status: "seeded" | "already_present";
  head: string;
  sequence: number;
}

/**
 * Seed the release-state branch exactly once, then reread its authoritative
 * commit. A concurrent or lost write response is reconciled by the same
 * reread; no force push or replacement state is attempted.
 */
export async function ensureHostedReleaseStateSeed(
  token: string,
  scratchDir: string,
  now = Date.now(),
): Promise<HostedSupervisorBootstrapResultV1> {
  if (!isToken(token)) throw new Error(STATIC_TOKEN);
  if (typeof scratchDir !== "string" || scratchDir.length === 0) {
    throw new Error(STATIC_STATE);
  }
  const state = createReleaseStateStore({
    scratchDir,
    remoteUrl: REMOTE_URL,
    runner: new DenoGitRunner(
      joinPath(scratchDir, "git-home"),
      githubGitAuthEnv(token),
    ),
  });
  return await ensureHostedReleaseState(state, now);
}

/**
 * Seed the release-state branch exactly once through an already-built
 * release-role store, then reread its authoritative commit. A concurrent or
 * lost write response is reconciled by the same reread; a found snapshot is
 * never replaced and no force push is attempted.
 */
export async function ensureHostedReleaseState(
  state: StateReadView & ReleaseStateWriter,
  now = Date.now(),
): Promise<HostedSupervisorBootstrapResultV1> {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error(STATIC_STATE);
  const current = await state.readRelease();
  if (!current.ok) throw new Error(`${STATIC_STATE} (${current.error.kind})`);
  if (current.value.status === "found") {
    return {
      status: "already_present",
      head: current.value.head,
      sequence: current.value.snapshot.sequence,
    };
  }

  const seed = emptyReleaseState(now);
  const written = await state.writeRelease(seed, null);
  if (!written.ok) throw new Error(`${STATIC_SEED} (${written.error.kind})`);
  if (written.value.status === "applied") {
    const afterWrite = await state.readRelease();
    if (!afterWrite.ok || afterWrite.value.status !== "found") {
      throw new Error(STATIC_SEED);
    }
    return {
      status: "seeded",
      head: afterWrite.value.head,
      sequence: afterWrite.value.snapshot.sequence,
    };
  }

  // A competing supervisor may have created the absent ref, or the response
  // may have been lost after the App write. Only an authoritative reread can
  // settle that ambiguity; a conflict never causes a force overwrite.
  const reconciled = await state.readRelease();
  if (!reconciled.ok || reconciled.value.status !== "found") {
    throw new Error(STATIC_SEED);
  }
  return {
    status: "already_present",
    head: reconciled.value.head,
    sequence: reconciled.value.snapshot.sequence,
  };
}

function emptyReleaseState(now: number): ReleaseStateSnapshotV1 {
  return parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: now,
    releases: [],
    hostedRuntimes: [],
    hostedReleases: [],
    githubCooldowns: [],
  });
}

// ---------------------------------------------------------------------------
// Deterministic hosted supervisor core: prepare and finalize.
//
// The protected workflow injects the exact current run identity and a bounded
// evidence port; this module owns only deterministic transitions over the
// existing release-role store. It never starts a model, never invokes the
// runtime (the protected job executes the returned intent) and never writes
// repair state. No credentials or environment are read here.
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const MAX_TRANSITIONS = 8;
const SELF_REPOSITORY: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "sentinel",
  installationId: 0,
};

const STATIC_RUN = "hosted supervisor run identity is invalid";
const STATIC_CONFLICT =
  "hosted supervisor state moved without the exact expected snapshot";
const STATIC_EVIDENCE = "hosted supervisor execution evidence is unavailable";
const STATIC_EVIDENCE_BINDING =
  "hosted supervisor execution evidence does not bind the saved intent";
const STATIC_SETTLEMENT_PENDING =
  "hosted supervisor execution settlement is not available";
const STATIC_LAUNCHER = "hosted supervisor launcher revision is not verified";
const STATIC_SOURCE = "hosted supervisor work source is unavailable";
const STATIC_REQUEST = "hosted supervisor release request is not verified";
const STATIC_REQUEST_ACTIVE =
  "hosted supervisor release request revision is already active";
const STATIC_ACTIVE_RELEASE =
  "hosted supervisor has more than one active hosted release";
const STATIC_BOOTSTRAP_RELEASE =
  "hosted release state exists without the initial runtime";
const STATIC_BOUND = "hosted supervisor transition bound reached";
const STATIC_REFUSED = "hosted supervisor refused an invalid state transition";
const STATIC_IDLE_SETTLED = "the current run attempt is already settled";
const STATIC_IDLE_WAITING =
  "the active hosted release is waiting for its exact execution";
const STATIC_IDLE_NONE = "no eligible hosted supervisor work";

export interface HostedSupervisorRunIdentityV1 {
  runId: number;
  runAttempt: number;
  launcherSha: GitSha;
}

/** Bounded external evidence; production adapters follow in a later change. */
export interface HostedSupervisorEvidencePortV1 {
  readExecution(
    savedIntent: HostedExecutionIntentV1,
  ): Promise<PortResultV1<HostedExecutionSettlementV1 | null>>;
  verifyRevision(revision: GitSha): Promise<PortResultV1<boolean>>;
  verifyRequest(request: ReleaseRequestV1): Promise<PortResultV1<boolean>>;
}

export interface HostedSupervisorInputV1 {
  clock: Clock;
  state: StateReadView & ReleaseStateWriter;
  run: HostedSupervisorRunIdentityV1;
  evidence: HostedSupervisorEvidencePortV1;
}

export type HostedSupervisorOutcomeV1 =
  | { status: "run"; execution: HostedExecutionIntentV1 }
  | { status: "idle" | "pending"; detail: string };

interface SnapshotCursorV1 {
  snapshot: ReleaseStateSnapshotV1 | null;
  head: GitSha | null;
}

type SettlementReadV1 =
  | { ok: true; settlement: HostedExecutionSettlementV1 }
  | { ok: false; outcome: HostedSupervisorOutcomeV1 };

function pending(detail: string): HostedSupervisorOutcomeV1 {
  return { status: "pending", detail };
}

function idle(detail: string): HostedSupervisorOutcomeV1 {
  return { status: "idle", detail };
}

function executionIdOfRun(run: HostedSupervisorRunIdentityV1): string {
  return `${run.runId}:${run.runAttempt}:repair`;
}

function invalidRunIdentity(run: HostedSupervisorRunIdentityV1): boolean {
  return !Number.isSafeInteger(run.runId) || run.runId < 1 ||
    !Number.isSafeInteger(run.runAttempt) || run.runAttempt < 1 ||
    !isGitSha(run.launcherSha);
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function isTerminalPhase(phase: HostedReleaseRecordV1["phase"]): boolean {
  return phase === "accepted" || phase === "rolled_back";
}

function isSettledCurrentRun(
  runtime: HostedRuntimeRecordV1,
  run: HostedSupervisorRunIdentityV1,
): boolean {
  const settled = runtime.lastExecutionProof;
  return settled !== null && settled.execution.runId === run.runId &&
    settled.execution.runAttempt === run.runAttempt;
}

function sameRepository(
  a: RepositoryIdentityV1,
  b: RepositoryIdentityV1,
): boolean {
  return a.owner === b.owner && a.name === b.name &&
    a.installationId === b.installationId;
}

async function readCursor(
  input: HostedSupervisorInputV1,
): Promise<SnapshotCursorV1 | null> {
  try {
    const read = await input.state.readRelease();
    if (!read.ok) return null;
    if (read.value.status === "absent") return { snapshot: null, head: null };
    return { snapshot: read.value.snapshot, head: read.value.head };
  } catch {
    return null;
  }
}

/**
 * One CAS write of a normalized snapshot. A conflict/ambiguous response gets
 * exactly one authoritative reread; only the exact expected snapshot counts as
 * applied, so an unrelated newer state is never overwritten.
 */
async function commitHosted(
  input: HostedSupervisorInputV1,
  cursor: SnapshotCursorV1,
  runtime: HostedRuntimeRecordV1 | null,
  releases: readonly HostedReleaseRecordV1[],
): Promise<"applied" | "pending"> {
  const now = input.clock.now();
  const base = cursor.snapshot;
  const candidate: ReleaseStateSnapshotV1 = base === null
    ? {
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: now,
      releases: [],
      hostedRuntimes: runtime === null ? [] : [runtime],
      hostedReleases: [...releases].sort(byId),
      githubCooldowns: [],
    }
    : {
      ...base,
      releases: [...base.releases].sort(byId),
      sequence: base.sequence + 1,
      stateHead: cursor.head,
      updatedAt: now,
      hostedRuntimes: runtime === null ? [] : [runtime],
      hostedReleases: [...releases].sort(byId),
    };
  let parsed: ReleaseStateSnapshotV1;
  try {
    parsed = parseReleaseStateSnapshotV1(candidate);
  } catch {
    return "pending";
  }
  let written: PortResultV1<StateWriteResultV1> | null = null;
  try {
    written = await input.state.writeRelease(parsed, cursor.head);
  } catch {
    written = null;
  }
  if (written !== null && written.ok && written.value.status === "applied") {
    cursor.snapshot = parsed;
    cursor.head = written.value.head;
    return "applied";
  }
  try {
    const reread = await input.state.readRelease();
    if (
      reread.ok && reread.value.status === "found" &&
      canonicalStringify(reread.value.snapshot) === canonicalStringify(parsed)
    ) {
      cursor.snapshot = reread.value.snapshot;
      cursor.head = reread.value.head;
      return "applied";
    }
  } catch {
    // Fall through to pending; the caller never loops on retries.
  }
  return "pending";
}

/** Full parser + exact execution binding, even if the evidence port lies. */
async function readSettlement(
  input: HostedSupervisorInputV1,
  savedIntent: HostedExecutionIntentV1,
): Promise<SettlementReadV1> {
  // The evidence read is idempotent and read-only, so a transport-shaped
  // failure is retried a bounded number of times inside this job: one flaky
  // HTTP window must never strand the pointer's saved execution (and with it
  // the whole lane) until a human intervenes. A refusal a retry cannot change
  // (auth, rate limit, invalid input) is reported immediately, and every
  // reported failure carries its CLOSED identity so the job output names the
  // cause instead of one static string.
  let failure = STATIC_EVIDENCE;
  for (let attempt = 1; attempt <= EVIDENCE_READ_ATTEMPTS; attempt++) {
    let result: PortResultV1<HostedExecutionSettlementV1 | null>;
    try {
      result = await input.evidence.readExecution(savedIntent);
    } catch {
      failure = `${STATIC_EVIDENCE} (thrown)`;
      if (attempt < EVIDENCE_READ_ATTEMPTS) {
        await pause(EVIDENCE_RETRY_PAUSE_MS);
        continue;
      }
      break;
    }
    if (!result.ok) {
      failure = evidenceFailureDetail(STATIC_EVIDENCE, result.error);
      if (
        attempt < EVIDENCE_READ_ATTEMPTS &&
        result.error.kind === "unavailable"
      ) {
        await pause(EVIDENCE_RETRY_PAUSE_MS);
        continue;
      }
      break;
    }
    if (result.value === null) {
      return { ok: false, outcome: pending(STATIC_SETTLEMENT_PENDING) };
    }
    const parsed = tryParse(parseHostedExecutionSettlementV1, result.value);
    if (!parsed.ok) {
      const issue = parsed.issues[0];
      return {
        ok: false,
        outcome: pending(
          `${STATIC_EVIDENCE_BINDING} (invalid settlement: ${
            issue?.code ?? "unknown"
          } at ${issue?.path ?? "?"})`,
        ),
      };
    }
    if (!sameCanonical(parsed.value.execution, savedIntent)) {
      return { ok: false, outcome: pending(STATIC_EVIDENCE_BINDING) };
    }
    return { ok: true, settlement: parsed.value };
  }
  return { ok: false, outcome: pending(failure) };
}

/** Bounded attempts of one read-only evidence read inside a single job. */
const EVIDENCE_READ_ATTEMPTS = 3;
const EVIDENCE_RETRY_PAUSE_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Closed, sanitized evidence-failure identity: the port's closed error kind
 * plus, only when the port itself supplied one of its own
 * `hosted execution ...` constants, that constant. Arbitrary upstream text (a
 * response body, a redirect URL or a credential) is never propagated into the
 * job output.
 */
function evidenceFailureDetail(base: string, error: PortErrorV1): string {
  const closed = /^hosted execution [a-z ]{1,64}$/.test(error.detail)
    ? `: ${error.detail}`
    : "";
  return `${base} (${error.kind}${closed})`;
}

function sameCanonical(a: unknown, b: unknown): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}

/**
 * Attach one settlement to its release slot in the SAME write that clears the
 * execution. Failed prior/rollback and not_started settlements leave the
 * healthy-only slots and the phase unchanged.
 */
function attachReleaseSettlement(
  releases: readonly HostedReleaseRecordV1[],
  settlement: HostedExecutionSettlementV1,
  generation: number,
  now: number,
): HostedReleaseRecordV1[] {
  const releaseId = settlement.execution.releaseId;
  if (releaseId === null) return [...releases];
  const record = releases.find((item) => item.id === releaseId);
  if (record === undefined) return [...releases];
  let next = record;
  const purpose = settlement.execution.purpose;
  if (purpose === "prior") {
    if (
      record.phase === "requested" && record.priorProof === null &&
      settlement.outcome === "healthy"
    ) {
      const intent: HostedPointerIntentV1 = {
        action: "promote",
        expectedRevision: record.priorRevision,
        nextRevision: record.request.revision,
        expectedGeneration: generation,
        createdAt: now,
      };
      next = {
        ...record,
        phase: "promoting",
        priorProof: settlement,
        pointerIntent: intent,
        updatedAt: now,
      };
    }
  } else if (purpose === "candidate") {
    if (record.phase === "verifying" && record.candidateProof === null) {
      if (settlement.outcome === "healthy") {
        next = {
          ...record,
          phase: "accepted",
          candidateProof: settlement,
          updatedAt: now,
        };
      } else if (settlement.outcome === "failed") {
        next = {
          ...record,
          phase: "rollback_pending",
          candidateProof: settlement,
          updatedAt: now,
        };
      }
    }
  } else if (purpose === "rollback") {
    if (
      record.phase === "rollback_verifying" && record.rollbackProof === null &&
      settlement.outcome === "healthy"
    ) {
      next = {
        ...record,
        phase: "rolled_back",
        rollbackProof: settlement,
        updatedAt: now,
      };
    }
  }
  if (next === record) return [...releases];
  return releases.map((item) => item.id === record.id ? next : item);
}

/** Clear the saved execution, save its exact settlement and update health. */
function settleRuntime(
  input: HostedSupervisorInputV1,
  cursor: SnapshotCursorV1,
  runtime: HostedRuntimeRecordV1,
  releases: readonly HostedReleaseRecordV1[],
  settlement: HostedExecutionSettlementV1,
): Promise<"applied" | "pending"> {
  const now = input.clock.now();
  // An exact ordinary no-execution settlement restores due eligibility at the
  // observation time so a later workflow can retry; no budget is touched.
  const ordinaryNotStarted = settlement.outcome === "not_started" &&
    settlement.execution.purpose === "ordinary";
  const runtimeNext: HostedRuntimeRecordV1 = {
    ...runtime,
    execution: null,
    lastExecutionProof: settlement,
    lastHealthyProof: settlement.outcome === "healthy"
      ? settlement
      : runtime.lastHealthyProof,
    nextOrdinaryAt: ordinaryNotStarted
      ? settlement.observedAt
      : runtime.nextOrdinaryAt,
    updatedAt: now,
  };
  const releasesNext = attachReleaseSettlement(
    releases,
    settlement,
    runtime.generation,
    now,
  );
  return commitHosted(input, cursor, runtimeNext, releasesNext);
}

/** Consume a persisted pointer intent atomically (no execution in this CAS). */
function planPointerRecovery(
  runtime: HostedRuntimeRecordV1,
  releases: readonly HostedReleaseRecordV1[],
  now: number,
): {
  runtime: HostedRuntimeRecordV1;
  releases: HostedReleaseRecordV1[];
} | null {
  if (runtime.execution !== null) return null;
  const record = releases.find((item) =>
    (item.phase === "promoting" || item.phase === "rollback_pending") &&
    item.pointerIntent !== null
  );
  if (record === undefined || record.pointerIntent === null) return null;
  const intent = record.pointerIntent;
  if (
    runtime.activeRevision !== intent.expectedRevision ||
    runtime.generation !== intent.expectedGeneration
  ) {
    return null;
  }
  const phase = record.phase === "promoting"
    ? "verifying"
    : "rollback_verifying";
  return {
    runtime: {
      ...runtime,
      activeRevision: intent.nextRevision,
      generation: runtime.generation + 1,
      updatedAt: now,
    },
    releases: releases.map((item) =>
      item.id === record.id
        ? { ...item, phase, pointerIntent: null, updatedAt: now }
        : item
    ),
  };
}

async function startExecution(
  input: HostedSupervisorInputV1,
  cursor: SnapshotCursorV1,
  runtime: HostedRuntimeRecordV1,
  releases: readonly HostedReleaseRecordV1[],
  purpose: HostedExecutionIntentV1["purpose"],
  revision: GitSha,
  releaseId: string | null,
  nextOrdinaryAt?: number,
): Promise<HostedSupervisorOutcomeV1> {
  if (isSettledCurrentRun(runtime, input.run)) {
    return idle(STATIC_IDLE_SETTLED);
  }
  const now = input.clock.now();
  const parsed = tryParse(parseHostedExecutionIntentV1, {
    id: executionIdOfRun(input.run),
    runId: input.run.runId,
    runAttempt: input.run.runAttempt,
    launcherSha: input.run.launcherSha,
    purpose,
    revision,
    generation: runtime.generation,
    releaseId,
    createdAt: now,
  });
  if (!parsed.ok) return pending(STATIC_REFUSED);
  const runtimeNext: HostedRuntimeRecordV1 = {
    ...runtime,
    execution: parsed.value,
    nextOrdinaryAt: nextOrdinaryAt ?? runtime.nextOrdinaryAt,
    updatedAt: now,
  };
  const applied = await commitHosted(input, cursor, runtimeNext, releases);
  if (applied !== "applied") return pending(STATIC_CONFLICT);
  return { status: "run", execution: parsed.value };
}

async function planReleaseWork(
  input: HostedSupervisorInputV1,
  cursor: SnapshotCursorV1,
  runtime: HostedRuntimeRecordV1,
  releases: readonly HostedReleaseRecordV1[],
  release: HostedReleaseRecordV1,
): Promise<HostedSupervisorOutcomeV1 | "written" | null> {
  const now = input.clock.now();
  if (release.phase === "requested" && release.priorProof === null) {
    return await startExecution(
      input,
      cursor,
      runtime,
      releases,
      "prior",
      release.priorRevision,
      release.id,
    );
  }
  if (release.phase === "verifying" && release.candidateProof === null) {
    return await startExecution(
      input,
      cursor,
      runtime,
      releases,
      "candidate",
      release.request.revision,
      release.id,
    );
  }
  if (release.phase === "rollback_pending" && release.pointerIntent === null) {
    const intent: HostedPointerIntentV1 = {
      action: "rollback",
      expectedRevision: release.request.revision,
      nextRevision: release.priorRevision,
      expectedGeneration: runtime.generation,
      createdAt: now,
    };
    const next = { ...release, pointerIntent: intent, updatedAt: now };
    const applied = await commitHosted(
      input,
      cursor,
      runtime,
      releases.map((item) => item.id === release.id ? next : item),
    );
    return applied === "applied" ? "written" : pending(STATIC_CONFLICT);
  }
  if (
    release.phase === "rollback_verifying" && release.rollbackProof === null
  ) {
    return await startExecution(
      input,
      cursor,
      runtime,
      releases,
      "rollback",
      release.priorRevision,
      release.id,
    );
  }
  return null;
}

function isSelfOpenRequest(request: ReleaseRequestV1): boolean {
  return request.status === "open" &&
    request.target.environment === "production" &&
    sameRepository(request.target.repository, SELF_REPOSITORY);
}

/** Exact completed review binding: reviewer, PR/head/base, zero unresolved. */
function reviewAuthorizes(
  snapshot: RepairStateSnapshotV1,
  request: ReleaseRequestV1,
): boolean {
  const receiptId = request.source.reviewReceiptId;
  if (receiptId === null) return false;
  return snapshot.reviews.some((review) =>
    review.id === receiptId &&
    review.requestId === request.source.reviewRequestId &&
    sameRepository(review.repository, request.target.repository) &&
    review.pullRequest.number === request.source.pullRequest &&
    review.pullRequest.head === request.source.head &&
    review.pullRequest.base === request.source.base &&
    review.outcome === "completed" &&
    review.resultId !== null && review.completedAt !== null &&
    review.observedReviewer !== null &&
    review.observedReviewer === review.expectedReviewer &&
    review.findingsUncounted === 0 &&
    !review.unresolvedSeverities.some((s) => s === "P0" || s === "P1")
  );
}

async function selectSourceRequest(
  input: HostedSupervisorInputV1,
  releases: readonly HostedReleaseRecordV1[],
  runtime: HostedRuntimeRecordV1,
): Promise<
  | { kind: "none" }
  | { kind: "found"; request: ReleaseRequestV1 }
  | { kind: "pending"; detail: string }
> {
  let read: PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>;
  try {
    read = await input.state.readRepair();
  } catch {
    return { kind: "pending", detail: STATIC_SOURCE };
  }
  if (!read.ok) return { kind: "pending", detail: STATIC_SOURCE };
  if (read.value.status !== "found") return { kind: "none" };
  const snapshot = read.value.snapshot;
  const recorded = new Set(releases.map((item) => item.id));
  const eligible = snapshot.releaseRequests
    .filter((request) =>
      !recorded.has(request.id) && isSelfOpenRequest(request) &&
      reviewAuthorizes(snapshot, request)
    )
    .sort((a, b) =>
      a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
  const request = eligible[0];
  if (request === undefined) return { kind: "none" };
  if (request.revision === runtime.activeRevision) {
    return { kind: "pending", detail: STATIC_REQUEST_ACTIVE };
  }
  let verified: PortResultV1<boolean>;
  try {
    verified = await input.evidence.verifyRequest(request);
  } catch {
    return { kind: "pending", detail: STATIC_REQUEST };
  }
  if (!verified.ok || !verified.value) {
    return { kind: "pending", detail: STATIC_REQUEST };
  }
  return { kind: "found", request };
}

function buildRequestedReceipt(
  request: ReleaseRequestV1,
  priorRevision: GitSha,
  now: number,
): HostedReleaseRecordV1 | null {
  const parsed = tryParse(parseHostedReleaseRecordV1, {
    version: "v1",
    kind: "hosted_release",
    id: request.id,
    request,
    priorRevision,
    phase: "requested",
    priorProof: null,
    candidateProof: null,
    rollbackProof: null,
    pointerIntent: null,
    createdAt: now,
    updatedAt: now,
  });
  return parsed.ok ? parsed.value : null;
}

function ordinaryDue(
  input: HostedSupervisorInputV1,
  runtime: HostedRuntimeRecordV1,
  releases: readonly HostedReleaseRecordV1[],
): boolean {
  if (!releases.every((item) => isTerminalPhase(item.phase))) return false;
  const healthy = runtime.lastHealthyProof;
  return healthy !== null &&
    healthy.execution.revision === runtime.activeRevision &&
    healthy.execution.generation === runtime.generation &&
    input.clock.now() >= runtime.nextOrdinaryAt;
}

/**
 * Promotion-source preflight before a healthy prior settlement may persist the
 * promote intent: the reread repair request must canonical-equal the frozen
 * hosted release request, still pass the review binding, and be accepted by
 * the source verifier. Failure/unavailability changes nothing.
 */
async function authorizePromotionSource(
  input: HostedSupervisorInputV1,
  record: HostedReleaseRecordV1,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  let read: PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>;
  try {
    read = await input.state.readRepair();
  } catch {
    return { ok: false, detail: STATIC_SOURCE };
  }
  if (!read.ok) return { ok: false, detail: STATIC_SOURCE };
  if (read.value.status !== "found") {
    return { ok: false, detail: STATIC_SOURCE };
  }
  const snapshot = read.value.snapshot;
  const frozen = record.request;
  const request = snapshot.releaseRequests.find((item) =>
    item.id === frozen.id
  );
  if (
    request === undefined || !sameCanonical(request, frozen) ||
    !isSelfOpenRequest(request) || !reviewAuthorizes(snapshot, request)
  ) {
    return { ok: false, detail: STATIC_REQUEST };
  }
  let verified: PortResultV1<boolean>;
  try {
    verified = await input.evidence.verifyRequest(request);
  } catch {
    return { ok: false, detail: STATIC_REQUEST };
  }
  if (!verified.ok || !verified.value) {
    return { ok: false, detail: STATIC_REQUEST };
  }
  return { ok: true };
}

async function settleWithPreflight(
  input: HostedSupervisorInputV1,
  cursor: SnapshotCursorV1,
  runtime: HostedRuntimeRecordV1,
  releases: readonly HostedReleaseRecordV1[],
  settlement: HostedExecutionSettlementV1,
): Promise<"applied" | "pending" | { refused: string }> {
  if (
    settlement.execution.purpose === "prior" &&
    settlement.execution.releaseId !== null && settlement.outcome === "healthy"
  ) {
    const record = releases.find((item) =>
      item.id === settlement.execution.releaseId
    );
    if (record === undefined) return { refused: STATIC_REQUEST };
    const authorized = await authorizePromotionSource(input, record);
    if (!authorized.ok) return { refused: authorized.detail };
  }
  const applied = await settleRuntime(
    input,
    cursor,
    runtime,
    releases,
    settlement,
  );
  return applied;
}

/**
 * One bounded prepare. Order: reconcile the saved execution (idempotent replay
 * of the current run, exact settlement of a prior one), recover a persisted
 * pointer intent, bootstrap the initial generation-1 pointer, select an
 * eligible release, then the ordinary due pass.
 */
export async function runHostedSupervisorPrepare(
  input: HostedSupervisorInputV1,
): Promise<HostedSupervisorOutcomeV1> {
  if (invalidRunIdentity(input.run)) return pending(STATIC_RUN);
  const cursor = await readCursor(input);
  if (cursor === null) return pending(STATIC_STATE);
  let transitions = 0;
  while (transitions < MAX_TRANSITIONS) {
    const runtime = cursor.snapshot?.hostedRuntimes[0] ?? null;
    const releases = cursor.snapshot?.hostedReleases ?? [];
    const execution = runtime?.execution ?? null;

    if (runtime !== null && execution !== null) {
      if (
        execution.id === executionIdOfRun(input.run) &&
        execution.launcherSha === input.run.launcherSha
      ) {
        return { status: "run", execution };
      }
      const settlement = await readSettlement(input, execution);
      if (!settlement.ok) return settlement.outcome;
      const settled = await settleWithPreflight(
        input,
        cursor,
        runtime,
        releases,
        settlement.settlement,
      );
      if (typeof settled === "object") return pending(settled.refused);
      if (settled !== "applied") return pending(STATIC_CONFLICT);
      transitions++;
      continue;
    }
    if (runtime !== null && isSettledCurrentRun(runtime, input.run)) {
      return idle(STATIC_IDLE_SETTLED);
    }

    if (runtime === null) {
      if (releases.length > 0) return pending(STATIC_BOOTSTRAP_RELEASE);
      let verified: PortResultV1<boolean>;
      try {
        verified = await input.evidence.verifyRevision(input.run.launcherSha);
      } catch {
        return pending(STATIC_LAUNCHER);
      }
      if (!verified.ok || !verified.value) return pending(STATIC_LAUNCHER);
      const now = input.clock.now();
      const bootstrap: HostedRuntimeRecordV1 = {
        version: "v1",
        kind: "hosted_runtime",
        id: HOSTED_RUNTIME_ID,
        activeRevision: input.run.launcherSha,
        generation: 1,
        lastHealthyProof: null,
        lastExecutionProof: null,
        nextOrdinaryAt: now + HOUR_MS,
        execution: null,
        createdAt: now,
        updatedAt: now,
      };
      const applied = await commitHosted(input, cursor, bootstrap, releases);
      if (applied !== "applied") return pending(STATIC_CONFLICT);
      transitions++;
      continue;
    }

    const recovery = planPointerRecovery(runtime, releases, input.clock.now());
    if (recovery !== null) {
      const applied = await commitHosted(
        input,
        cursor,
        recovery.runtime,
        recovery.releases,
      );
      if (applied !== "applied") return pending(STATIC_CONFLICT);
      transitions++;
      continue;
    }

    if (
      runtime.generation === 1 &&
      runtime.activeRevision === input.run.launcherSha &&
      runtime.lastHealthyProof === null &&
      releases.length === 0
    ) {
      return await startExecution(
        input,
        cursor,
        runtime,
        releases,
        "bootstrap",
        input.run.launcherSha,
        null,
      );
    }

    const active = releases.filter((item) => !isTerminalPhase(item.phase));
    if (active.length > 1) return pending(STATIC_ACTIVE_RELEASE);
    const release = active[0] ?? null;
    if (release !== null) {
      const planned = await planReleaseWork(
        input,
        cursor,
        runtime,
        releases,
        release,
      );
      if (planned === "written") {
        transitions++;
        continue;
      }
      if (planned !== null) return planned;
      return idle(STATIC_IDLE_WAITING);
    }

    const selected = await selectSourceRequest(input, releases, runtime);
    if (selected.kind === "pending") return pending(selected.detail);
    if (selected.kind === "found") {
      const receipt = buildRequestedReceipt(
        selected.request,
        runtime.activeRevision,
        input.clock.now(),
      );
      if (receipt === null) return pending(STATIC_REFUSED);
      const applied = await commitHosted(
        input,
        cursor,
        runtime,
        [...releases, receipt],
      );
      if (applied !== "applied") return pending(STATIC_CONFLICT);
      transitions++;
      continue;
    }

    if (ordinaryDue(input, runtime, releases)) {
      return await startExecution(
        input,
        cursor,
        runtime,
        releases,
        "ordinary",
        runtime.activeRevision,
        null,
        input.clock.now() + HOUR_MS,
      );
    }

    if (
      runtime.lastHealthyProof === null ||
      runtime.lastHealthyProof.execution.revision !== runtime.activeRevision ||
      runtime.lastHealthyProof.execution.generation !== runtime.generation
    ) {
      return await startExecution(
        input,
        cursor,
        runtime,
        releases,
        "ordinary",
        runtime.activeRevision,
        null,
        input.clock.now() + HOUR_MS,
      );
    }
    return idle(STATIC_IDLE_NONE);
  }
  return pending(STATIC_BOUND);
}

/**
 * Settle exactly the CURRENT run/attempt's saved intent. Pending evidence or a
 * mismatched identity changes nothing.
 */
export async function runHostedSupervisorFinalize(
  input: HostedSupervisorInputV1,
): Promise<HostedSupervisorOutcomeV1> {
  if (invalidRunIdentity(input.run)) return pending(STATIC_RUN);
  const cursor = await readCursor(input);
  if (cursor === null) return pending(STATIC_STATE);
  const runtime = cursor.snapshot?.hostedRuntimes[0] ?? null;
  const releases = cursor.snapshot?.hostedReleases ?? [];
  const saved = runtime?.execution ?? null;
  if (runtime === null || saved === null) {
    if (runtime !== null && isSettledCurrentRun(runtime, input.run)) {
      return idle(STATIC_IDLE_SETTLED);
    }
    return pending(STATIC_SETTLEMENT_PENDING);
  }
  if (
    saved.id !== executionIdOfRun(input.run) ||
    saved.launcherSha !== input.run.launcherSha
  ) {
    return pending(STATIC_EVIDENCE_BINDING);
  }
  const settlement = await readSettlement(input, saved);
  if (!settlement.ok) return settlement.outcome;
  const settled = await settleWithPreflight(
    input,
    cursor,
    runtime,
    releases,
    settlement.settlement,
  );
  if (typeof settled === "object") return pending(settled.refused);
  if (settled !== "applied") return pending(STATIC_CONFLICT);
  return idle(STATIC_IDLE_SETTLED);
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 &&
    !/[\p{Cc}]/u.test(value);
}

// ---------------------------------------------------------------------------
// Production composition: prepare/finalize over the existing core.
// ---------------------------------------------------------------------------

const SUPERVISOR_REPOSITORY: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "sentinel",
  installationId: 0,
};
const NATIVE_TOKEN_ENV = "GITHUB_TOKEN";
const OUTPUT_ENV = "GITHUB_OUTPUT";
const PATH_ENV = "PATH";
const STATIC_SOURCE_CHECKOUT =
  "hosted supervisor source checkout is not the exact clean revision";
const STATIC_JOB = "hosted supervisor job identity is invalid";
const STATIC_OUTPUT = "hosted supervisor prepare output is unavailable";
const STATIC_RESULT = "hosted supervisor run result is unavailable";

export interface HostedSupervisorHostInputV1 {
  env: Readonly<Record<string, string | undefined>>;
  sourceDir: string;
  clock: Clock;
  http: HttpTransportV1;
  state: StateReadView & ReleaseStateWriter;
  process: ReplayRuntimeV1;
  /** Prepare-only exact output writer; one key=value record per call. */
  writeOutput?: (name: string, value: string) => Promise<void>;
}

export interface HostedSupervisorHostResultV1 {
  job: HostedRuntimeJobV1;
  status: HostedSupervisorOutcomeV1["status"];
  run: boolean;
  revision: GitSha | null;
  execution: HostedExecutionIntentV1 | null;
  detail: string;
}

/** Only the protected prepare/finalize jobs are accepted here. */
function supervisorJob(value: string | undefined): HostedRuntimeJobV1 {
  if (value === "prepare" || value === "finalize") return value;
  throw new Error(STATIC_JOB);
}

/**
 * Real production composition: exact native identity and the clean protected
 * source are proved BEFORE any auth, API, output or state work, then the
 * existing core prepare/finalize runs with the authenticated native client
 * behind the shared cooldown gate. Prepare writes only `run`/`revision`;
 * finalize writes no outputs and never starts a model.
 */
export async function runHostedSupervisorHost(
  input: HostedSupervisorHostInputV1,
): Promise<HostedSupervisorHostResultV1> {
  const job = supervisorJob(input.env.GITHUB_JOB);
  const identity = parseHostedEnvironment(input.env, job);
  const head = await readCleanGitHead(input.process, input.sourceDir);
  if (head !== identity.launcherSha) throw new Error(STATIC_SOURCE_CHECKOUT);
  // The prepare output sink must exist BEFORE any core, API or state work.
  const writeOutput = input.writeOutput;
  if (job === "prepare" && writeOutput === undefined) {
    throw new Error(STATIC_OUTPUT);
  }
  const nativeToken = input.env[NATIVE_TOKEN_ENV];
  if (!isToken(nativeToken)) throw new Error(STATIC_TOKEN);

  const gate = new HostedSupervisorCooldownGate({
    state: input.state,
    clock: input.clock,
  });
  const client = new GitHubApiClient({
    repository: { ...SUPERVISOR_REPOSITORY },
    apiBaseUrl: "https://api.github.com",
    http: input.http,
    auth: {
      authorizationHeader: () =>
        Promise.resolve(portOk(`Bearer ${nativeToken}`)),
    },
    cooldownGate: gate,
    clock: input.clock,
  });
  const evidence: HostedSupervisorEvidencePortV1 = {
    readExecution: (saved) => client.readHostedExecution(saved),
    verifyRevision: (revision) => client.verifyHostedRevision(revision),
    verifyRequest: (request) => client.verifyHostedReleaseRequest(request),
  };
  const core = {
    clock: input.clock,
    state: input.state,
    run: {
      runId: identity.runId,
      runAttempt: identity.runAttempt,
      launcherSha: identity.launcherSha,
    },
    evidence,
  };
  const outcome = job === "prepare"
    ? await runHostedSupervisorPrepare(core)
    : await runHostedSupervisorFinalize(core);
  if (job === "finalize") {
    return {
      job,
      status: outcome.status,
      run: false,
      revision: null,
      execution: null,
      // An `idle` outcome carries its own bounded reason; collapsing it to the
      // bare word made "the supervisor does nothing" undiagnosable.
      detail: outcome.status === "run" ? "run" : outcome.detail,
    };
  }
  if (writeOutput === undefined) throw new Error(STATIC_OUTPUT);
  if (outcome.status !== "run") {
    await writeOutput("run", "false");
    return {
      job,
      status: outcome.status,
      run: false,
      revision: null,
      execution: null,
      detail: outcome.detail,
    };
  }
  if (!isGitSha(outcome.execution.revision)) throw new Error(STATIC_RESULT);
  await writeOutput("run", "true");
  await writeOutput("revision", outcome.execution.revision);
  return {
    job,
    status: "run",
    run: true,
    revision: outcome.execution.revision,
    execution: outcome.execution,
    detail: "run",
  };
}

/**
 * Production entrypoint: named native environment only, source proof before
 * credentials/scratch, release state through the App Git token, and the native
 * GITHUB_TOKEN for every authenticated API request behind the shared cooldown
 * gate. No model token, no environment dump and no App private key.
 */
async function main(): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...readHostedIdentityEnv(),
    [PATH_ENV]: Deno.env.get(PATH_ENV),
    [NATIVE_TOKEN_ENV]: Deno.env.get(NATIVE_TOKEN_ENV),
    [SUPERVISOR_TOKEN_ENV]: Deno.env.get(SUPERVISOR_TOKEN_ENV),
    [OUTPUT_ENV]: Deno.env.get(OUTPUT_ENV),
  };
  const job = supervisorJob(env.GITHUB_JOB);
  const identity = parseHostedEnvironment(env, job);
  const process = new DenoReplayRuntime(Deno.execPath());
  const sourceDir = Deno.cwd();
  // Exact clean protected source BEFORE credentials, scratch, API or output.
  const head = await readCleanGitHead(process, sourceDir);
  if (head !== identity.launcherSha) throw new Error(STATIC_SOURCE_CHECKOUT);

  const path = env[PATH_ENV];
  const nativeToken = env[NATIVE_TOKEN_ENV];
  const appToken = env[SUPERVISOR_TOKEN_ENV];
  if (
    !isToken(nativeToken) || !isToken(appToken) ||
    typeof path !== "string" || path.length === 0
  ) {
    throw new Error(STATIC_TOKEN);
  }
  // The prepare output sink is validated before any scratch or state write.
  let writeOutput: ((name: string, value: string) => Promise<void>) | undefined;
  if (job === "prepare") {
    const outputPath = env[OUTPUT_ENV];
    if (typeof outputPath !== "string" || outputPath.length === 0) {
      throw new Error(STATIC_OUTPUT);
    }
    writeOutput = async (name, value) => {
      await Deno.writeTextFile(outputPath, `${name}=${value}\n`, {
        append: true,
        create: false,
      });
    };
  }

  const sentinelDir = joinPath(sourceDir, ".sentinel");
  const scratch = joinPath(sentinelDir, "state-scratch");
  const gitHome = joinPath(sentinelDir, "state-git-home");
  await ensurePrivateDir(scratch);
  await ensurePrivateDir(gitHome);
  const state = createReleaseStateStore({
    scratchDir: scratch,
    remoteUrl: REMOTE_URL,
    runner: new DenoGitRunner(gitHome, githubGitAuthEnv(appToken)),
  });
  const clock = new SystemClock();
  await ensureHostedReleaseState(state, clock.now());
  const result = await runHostedSupervisorHost({
    env,
    sourceDir,
    clock,
    http: fetchHttpTransport(),
    state,
    process,
    writeOutput,
  });
  // Bounded trusted result only; no raw error or credential is ever logged.
  console.log(JSON.stringify({
    job: result.job,
    status: result.status,
    run: result.run,
    revision: result.revision,
    execution: result.execution,
    detail: result.detail,
  }));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    console.error(
      message === STATIC_JOB || message === STATIC_SOURCE_CHECKOUT ||
        message === STATIC_OUTPUT || message === STATIC_TOKEN
        ? message
        : STATIC_RESULT,
    );
    Deno.exit(1);
  }
}
