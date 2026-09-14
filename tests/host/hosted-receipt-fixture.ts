/**
 * Shared legal-lifecycle receipt fixture for the hosted consumer suites.
 *
 * This helper drives the ACTUAL `runHostedSupervisorPrepare` core over a real
 * release store until it persists the requested phase, so consumer tests read
 * a genuinely reachable receipt instead of hand-writing an illegal transition.
 * It injects only external evidence and a read-only repair request/review view;
 * the caller's real repair state is never mutated, and no store/parser guard is
 * weakened or reimplemented here.
 */

import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import {
  parseHostedRunProofV1,
} from "../../src/contracts/hosted-supervisor.ts";
import type {
  HostedExecutionIntentV1,
  HostedReleaseRecordV1,
  HostedRunProofV1,
} from "../../src/contracts/hosted-supervisor.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type {
  Clock,
  ReleaseStateWriter,
  StateReadView,
} from "../../src/contracts/ports.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { runHostedSupervisorPrepare } from "../../src/host/actions-supervisor.ts";
import type {
  HostedSupervisorEvidencePortV1,
  HostedSupervisorOutcomeV1,
} from "../../src/host/actions-supervisor.ts";

/** Monotonic test clock; the fixture advances it, tests never sleep. */
export interface HostedReceiptClockV1 extends Clock {
  advance(ms: number): void;
}

export type HostedReceiptPhaseV1 =
  | "requested"
  | "verifying"
  | "accepted"
  | "rolled_back";

export interface PersistHostedReceiptInputV1 {
  /** Real release store: actual CAS writes and the persisted record. */
  release: StateReadView & ReleaseStateWriter;
  clock: HostedReceiptClockV1;
  /** Exact reviewed self production request the receipt must bind. */
  request: ReleaseRequestV1;
  /** Bootstrap/prior revision; the core derives priorRevision from it. */
  priorRevision: GitSha;
  phase: HostedReceiptPhaseV1;
  /** First run id; each step uses a unique run so nothing is replayed. */
  runIdStart?: number;
}

const MAX_STEPS = 8;
const STEP_CLOCK_MS = 5_000;
const DUMMY_HEAD = "a".repeat(40) as GitSha;
const DIGEST = "d".repeat(64);

/**
 * Advance the real supervisor core legally into the requested phase and return
 * the exact persisted record. `requested` stops with the saved prior execution;
 * `verifying` stops with the saved candidate launch intent.
 */
export async function persistHostedReceipt(
  input: PersistHostedReceiptInputV1,
): Promise<HostedReleaseRecordV1> {
  const state = fixtureState(input);
  const evidence = fixtureEvidence(input);
  let runId = input.runIdStart ?? 1;
  for (let step = 0; step < MAX_STEPS; step++) {
    const snapshot = await readSnapshot(input.release);
    const record = snapshot.hostedReleases[0] ?? null;
    const execution = snapshot.hostedRuntimes[0]?.execution ?? null;
    if (record !== null && record.phase === input.phase) {
      if (input.phase === "requested" || input.phase === "verifying") {
        if (execution !== null) return record;
      } else {
        return record;
      }
    }
    input.clock.advance(STEP_CLOCK_MS);
    const outcome: HostedSupervisorOutcomeV1 = await runHostedSupervisorPrepare(
      {
        clock: input.clock,
        state,
        run: {
          runId: runId++,
          runAttempt: 1,
          launcherSha: input.priorRevision,
        },
        evidence,
      },
    );
    assert.ok(
      outcome.status === "run" || outcome.status === "idle",
      `hosted receipt fixture step ${step}: ${JSON.stringify(outcome)}`,
    );
  }
  throw new Error("hosted receipt fixture bound reached");
}

/** Read-only repair view: the exact request + matching completed review. */
function fixtureState(
  input: PersistHostedReceiptInputV1,
): StateReadView & ReleaseStateWriter {
  const review = completedReview(input.request);
  const snapshot = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: input.clock.now(),
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [review],
    replays: [],
    releaseRequests: [input.request],
    githubCooldowns: [],
  });
  return {
    readRepair: () =>
      Promise.resolve(portOk({
        status: "found" as const,
        snapshot,
        head: DUMMY_HEAD,
        ref: null,
      })),
    readRelease: () => input.release.readRelease(),
    writeRelease: (next, expectedHead) =>
      input.release.writeRelease(next, expectedHead),
  };
}

/** Injected external evidence only; the repair view above is the authority. */
function fixtureEvidence(
  input: PersistHostedReceiptInputV1,
): HostedSupervisorEvidencePortV1 {
  return {
    readExecution: (saved: HostedExecutionIntentV1) =>
      Promise.resolve(portOk(fixtureProof(saved, input.phase))),
    verifyRevision: () => Promise.resolve(portOk(true)),
    verifyRequest: (request: ReleaseRequestV1) =>
      Promise.resolve(portOk(request.id === input.request.id)),
  };
}

/** Full proof of the ACTUAL saved intent; candidate fails only for rollback. */
function fixtureProof(
  saved: HostedExecutionIntentV1,
  phase: HostedReceiptPhaseV1,
): HostedRunProofV1 {
  const healthy = !(saved.purpose === "candidate" && phase === "rolled_back");
  return parseHostedRunProofV1({
    execution: saved,
    workflowId: 357012162,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: "ubiquity/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: 7,
    startedAt: saved.createdAt + 1000,
    finishedAt: saved.createdAt + 2000,
    observedAt: saved.createdAt + 3000,
    outcome: healthy ? "healthy" : "failed",
    startupReady: healthy,
    settled: true,
    baseSha: healthy ? saved.revision : null,
    terminalAt: healthy ? saved.createdAt + 1500 : null,
    logDigest: DIGEST,
  });
}

function completedReview(request: ReleaseRequestV1): ReviewReceiptV1 {
  const receiptId = request.source.reviewReceiptId;
  if (receiptId === null) {
    throw new Error("hosted receipt fixture requires a reviewed request");
  }
  return parseReviewReceiptV1({
    version: "v1",
    kind: "review_receipt",
    id: receiptId,
    requestId: request.source.reviewRequestId,
    expectedReviewer: "chatgpt-codex-connector[bot]",
    observedReviewer: "chatgpt-codex-connector[bot]",
    repository: { ...request.target.repository },
    pullRequest: {
      number: request.source.pullRequest,
      head: request.source.head,
      base: request.source.base,
    },
    outcome: "completed",
    resultId: "result-fixture",
    summary: null,
    findings: [],
    findingsUncounted: 0,
    unresolvedSeverities: [],
    submittedAt: request.createdAt - 2000,
    completedAt: request.createdAt - 1000,
    observedAt: request.createdAt - 500,
  });
}

async function readSnapshot(
  release: StateReadView,
): Promise<ReleaseStateSnapshotV1> {
  const read = await release.readRelease();
  if (!read.ok) throw new Error("hosted receipt fixture state is unavailable");
  if (read.value.status === "absent") {
    return parseReleaseStateSnapshotV1({
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: 0,
      releases: [],
      hostedRuntimes: [],
      hostedReleases: [],
      githubCooldowns: [],
    });
  }
  return parseReleaseStateSnapshotV1(read.value.snapshot);
}
