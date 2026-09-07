/**
 * m04-repair test helpers: fake ports (recording, no product logic) and a
 * memory state capability with exact-identity CAS plus sequence validation
 * mirroring the real GitStateStore transition rules. Real-Git acceptance tests
 * reuse the disposable local bare remote helpers from the state suite and the
 * real RollingStartBudget; no model call, no network and no credentials exist
 * in this suite.
 */
import assert from "node:assert/strict";

import type { FixtureDigest, GitSha } from "../../src/contracts/brands.ts";
import type {
  Clock,
  GitHubIssueV1,
  GitHubPort,
  GitHubPullRequestV1,
  ImplementationPort,
  IncidentAdapter,
  IncidentPageV1,
  IsolatedReplayResultV1,
  MergeOutcomeV1,
  ModelRunReceiptV1,
  ModelRunRequestV1,
  PortResultV1,
  RepairStateWriter,
  ReplayPort,
  ReplayRunRequestV1,
  ReviewObservationV1,
  StateReadResultV1,
  StateReadView,
  StateWriteResultV1,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { REPO, SHA1, SHA2, T0 } from "../state/helpers.ts";
import { repositoryConfig } from "../budget/helpers.ts";
import type { IncidentSummaryV1 } from "../../src/contracts/incident.ts";
import type { IncidentEvidenceV1 } from "../../src/contracts/incident.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";

/** Deterministic fake clock with explicit ticks; never real waits. */
export class FakeClock implements Clock {
  private current: number;
  constructor(start: number = T0) {
    this.current = start;
  }
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

let memorySeq = 0;
function nextHead(): GitSha {
  memorySeq++;
  return `00000000000000000000000000000000000000${
    memorySeq
      .toString(16)
      .padStart(6, "0")
  }`.slice(-40) as GitSha;
}

/** Expected-head memory state with the real store's sequence rule. */
export class MemoryState implements StateReadView, RepairStateWriter {
  repair: RepairStateSnapshotV1 | null = null;
  release: { snapshot: unknown; head: GitSha | null } | null = null;
  repairHead: GitSha | null = null;
  repairWrites = 0;
  ambiguousRepairNext = false;
  conflictRepairNext = false;
  sequenceRule = true;

  readRepair(): Promise<
    PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
  > {
    if (this.repair === null) {
      return Promise.resolve(portOk({
        status: "absent",
        currentHead: this.repairHead,
        ref: "refs/heads/sentinel-state/repair",
      }));
    }
    return Promise.resolve(portOk({
      status: "found",
      snapshot: this.repair,
      head: this.repairHead ?? SHA1,
      ref: "refs/heads/sentinel-state/repair",
    }));
  }

  writeRepair(
    next: RepairStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    this.repairWrites++;
    if (this.ambiguousRepairNext) {
      this.ambiguousRepairNext = false;
      return Promise.resolve(portOk({
        status: "ambiguous",
        currentHead: this.repairHead,
      }));
    }
    if (this.conflictRepairNext) {
      this.conflictRepairNext = false;
      return Promise.resolve(portOk({
        status: "conflict",
        currentHead: this.repairHead,
      }));
    }
    if (this.repairHead !== expectedHead) {
      const recorded = this.repairHead;
      return Promise.resolve(portOk({
        status: "conflict",
        currentHead: recorded,
      }));
    }
    let parsed: RepairStateSnapshotV1;
    try {
      parsed = parseRepairStateSnapshotV1(next);
    } catch {
      return Promise.resolve(portError("invalid", "invalid snapshot"));
    }
    if (this.sequenceRule) {
      const expectedSequence = this.repair === null
        ? 1
        : this.repair.sequence + 1;
      if (parsed.sequence !== expectedSequence) {
        return Promise.resolve(portOk({
          status: "conflict",
          currentHead: this.repairHead,
        }));
      }
      if (this.repair !== null && parsed.updatedAt < this.repair.updatedAt) {
        return Promise.resolve(portError("invalid", "time regression"));
      }
    }
    this.repair = parsed;
    this.repairHead = nextHead();
    return Promise.resolve(
      portOk({ status: "applied", head: this.repairHead }),
    );
  }

  readRelease(): Promise<PortResultV1<StateReadResultV1<never>>> {
    if (this.release === null) {
      return Promise.resolve(portOk({
        status: "absent",
        currentHead: null,
        ref: "refs/heads/sentinel-state/release",
      }));
    }
    return Promise.resolve(portOk({
      status: "found",
      snapshot: this.release.snapshot as never,
      head: this.release.head ?? SHA1,
      ref: "refs/heads/sentinel-state/release",
    }));
  }

  setRelease(snapshot: unknown): void {
    this.release = { snapshot, head: SHA2 };
  }
}

export interface FakeGithubOptionsV1 {
  baseSha?: GitSha;
  issues?: Partial<GitHubIssueV1>[];
  openIssues?: Partial<GitHubIssueV1>[];
  pullRequest?: Partial<GitHubPullRequestV1> | null;
  /** Exact SHA served for the candidate branch ref when no push preceded it. */
  branchRefSha?: GitSha | null;
  review?: Partial<ReviewObservationV1> | null;
  reviewUnavailable?: boolean;
  reviewRequestedAt?: number;
  pushOutcome?: "applied" | "ambiguous";
  pushFailNext?: boolean;
  createOutcome?: "applied" | "ambiguous";
  createFailNext?: boolean;
  reviewRequestOutcome?: "applied" | "ambiguous";
  reviewRequestFailNext?: boolean;
  mergeOutcome?: MergeOutcomeV1;
  mergeFailNext?: boolean;
  closeOutcome?: "closed" | "already_closed";
  closeFailNext?: boolean;
}

/** Recording fake GitHubPort; product logic never lives here. */
export class FakeGithub implements GitHubPort {
  readonly calls: string[] = [];
  readonly pushes: { ref: string; sha: GitSha; expected: GitSha | null }[] = [];
  reviewObservations: ReviewObservationV1 | null = null;
  reviewStatus: "pending" | "completed" | "unavailable" = "pending";
  completedReviewAt: number | null = null;
  prNumber = 7;
  releasedHead: GitSha | null = null;
  private readonly options: FakeGithubOptionsV1;

  constructor(options: FakeGithubOptionsV1 = {}) {
    this.options = options;
  }

  readIssue(issueNumber: number): Promise<PortResultV1<GitHubIssueV1 | null>> {
    this.calls.push(`readIssue:${issueNumber}`);
    const issue = this.options.issues?.find((candidate) =>
      candidate.number === issueNumber
    );
    if (issue === undefined) return Promise.resolve(portOk(null));
    return Promise.resolve(portOk({
      number: issueNumber,
      title: issue.title ?? `issue ${issueNumber}`,
      body: issue.body ?? "",
      state: "open",
      author: null,
      labels: issue.labels ?? [],
      createdAt: issue.createdAt ?? T0,
      updatedAt: T0,
      closedAt: null,
    }));
  }

  listOpenIssues(): Promise<PortResultV1<GitHubIssueV1[]>> {
    this.calls.push("listOpenIssues");
    return Promise.resolve(
      portOk((this.options.openIssues ?? []).map((issue) => ({
        number: issue.number ?? 0,
        title: issue.title ?? `issue ${issue.number ?? 0}`,
        body: issue.body ?? "",
        state: issue.state ?? "open",
        author: issue.author ?? null,
        labels: issue.labels ?? [],
        createdAt: issue.createdAt ?? T0,
        updatedAt: issue.updatedAt ?? T0,
        closedAt: issue.closedAt ?? null,
      }))),
    );
  }

  findPullRequestByHeadRef(
    headRef: string,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    this.calls.push(`findPr:${headRef}`);
    if (this.prNumber === 0) return Promise.resolve(portOk(null));
    return Promise.resolve(portOk(this.pullRequest()));
  }

  readPullRequest(
    number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    this.calls.push(`readPr:${number}`);
    if (this.prNumber === 0) return Promise.resolve(portOk(null));
    return Promise.resolve(portOk(this.pullRequest()));
  }

  readChecks(_head: GitSha) {
    return Promise.resolve(portOk({ head: _head, checks: [] }));
  }

  readProtections(_baseBranch: string) {
    return Promise.resolve(portOk({
      branch: _baseBranch,
      protected: false,
      requiredStatusChecks: [],
      requiredApprovingReviewCount: 0,
      requireBranchUpToDate: false,
      enforceAdmins: false,
    }));
  }

  readRef(
    ref: string,
  ): Promise<PortResultV1<{ ref: string; sha: GitSha } | null>> {
    this.calls.push(`readRef:${ref}`);
    if (ref.endsWith("refs/heads/development")) {
      return Promise.resolve(portOk({
        ref,
        sha: this.options.baseSha ?? SHA1,
      }));
    }
    if (
      this.options.branchRefSha !== null &&
      this.options.branchRefSha !== undefined
    ) {
      // A pre-existing candidate branch (e.g. an existing-PR correction with
      // no push recorded by this fake yet).
      return Promise.resolve(portOk({ ref, sha: this.options.branchRefSha }));
    }
    // Candidate branch: present once a push was applied.
    if (this.pushes.length > 0) {
      const last = this.pushes[this.pushes.length - 1];
      return Promise.resolve(portOk({ ref, sha: last.sha }));
    }
    return Promise.resolve(portOk(null));
  }

  pushHead(
    ref: string,
    sha: GitSha,
    expectedRef: GitSha | null,
  ): Promise<PortResultV1<"applied" | "ambiguous">> {
    this.calls.push(`push:${ref}:${sha.slice(0, 8)}`);
    if (this.options.pushFailNext) {
      this.options.pushFailNext = false;
      return Promise.resolve(
        portError("unavailable", "push transport failure"),
      );
    }
    this.pushes.push({ ref, sha, expected: expectedRef });
    this.releasedHead = sha;
    // A lost push response is a one-shot condition: the ref is recorded and
    // later reconciles against the exact remote ref; retries are honest.
    const outcome = this.options.pushOutcome ?? "applied";
    this.options.pushOutcome = undefined;
    return Promise.resolve(portOk(outcome));
  }

  createPullRequest(_request: unknown): Promise<
    PortResultV1<{
      outcome: "applied" | "ambiguous";
      number: number | null;
      head: GitSha | null;
    }>
  > {
    this.calls.push("createPr");
    if (this.options.createFailNext) {
      this.options.createFailNext = false;
      return Promise.resolve(portError("unavailable", "create failure"));
    }
    if (this.options.createOutcome === "ambiguous") {
      return Promise.resolve(portOk({
        outcome: "ambiguous",
        number: null,
        head: null,
      }));
    }
    this.prNumber = 7;
    return Promise.resolve(portOk({
      outcome: "applied",
      number: 7,
      head: this.releasedHead,
    }));
  }

  requestReview(_request: unknown): Promise<
    PortResultV1<{
      outcome: "applied" | "ambiguous";
      requestId: string | null;
      requestedAt: number;
    }>
  > {
    this.calls.push("requestReview");
    if (this.options.reviewRequestFailNext) {
      this.options.reviewRequestFailNext = false;
      return Promise.resolve(
        portError("unavailable", "review request failure"),
      );
    }
    if (this.options.reviewRequestOutcome === "ambiguous") {
      return Promise.resolve(portOk({
        outcome: "ambiguous",
        requestId: null,
        requestedAt: T0,
      }));
    }
    return Promise.resolve(portOk({
      outcome: "applied",
      requestId: "review-req-1",
      requestedAt: this.options.reviewRequestedAt ?? T0,
    }));
  }

  observeReview(_request: unknown): Promise<PortResultV1<ReviewObservationV1>> {
    this.calls.push("observeReview");
    if (this.options.reviewUnavailable) {
      return Promise.resolve(
        portError("unavailable", "review transport failure"),
      );
    }
    if (this.reviewStatus === "pending") {
      return Promise.resolve(portOk({
        status: "pending",
        requestId: "review-req-1",
        reviewer: null,
        resultId: null,
        completedAt: null,
        observedHead: this.releasedHead,
        observedBase: this.options.baseSha ?? SHA1,
        findings: [],
        summary: null,
        receivedAt: T0,
      }));
    }
    return Promise.resolve(portOk(this.reviewObservation()));
  }

  mergePullRequest(_request: unknown): Promise<PortResultV1<MergeOutcomeV1>> {
    this.calls.push("merge");
    if (this.options.mergeFailNext) {
      this.options.mergeFailNext = false;
      return Promise.resolve(
        portError("unavailable", "merge transport failure"),
      );
    }
    return Promise.resolve(portOk(
      this.options.mergeOutcome ?? {
        outcome: "merged",
        head: this.releasedHead ?? SHA1,
        mergeSha: this.releasedHead ?? SHA1,
      },
    ));
  }

  closeIssue(
    issueNumber: number,
  ): Promise<PortResultV1<"closed" | "already_closed">> {
    this.calls.push(`closeIssue:${issueNumber}`);
    if (this.options.closeFailNext) {
      this.options.closeFailNext = false;
      return Promise.resolve(
        portError("unavailable", "closure transport failure"),
      );
    }
    return Promise.resolve(portOk(this.options.closeOutcome ?? "closed"));
  }

  /** Deliver a completed review for the current release head. */
  completeReview(findings: unknown[] = [], at: number = T0 + 1000): void {
    this.reviewStatus = "completed";
    this.completedReviewAt = at;
    this.reviewObservations = {
      status: "completed",
      requestId: "review-req-1",
      reviewer: "chatgpt-codex-connector[bot]",
      resultId: "result-1",
      completedAt: at,
      observedHead: this.releasedHead,
      observedBase: this.options.baseSha ?? SHA1,
      findings: findings as never[],
      summary: null,
      receivedAt: at + 1,
    };
  }

  private reviewObservation(): ReviewObservationV1 {
    return this.reviewObservations ?? {
      status: "completed",
      requestId: "review-req-1",
      reviewer: "chatgpt-codex-connector[bot]",
      resultId: "result-1",
      completedAt: T0 + 1000,
      observedHead: this.releasedHead,
      observedBase: this.options.baseSha ?? SHA1,
      findings: [],
      summary: null,
      receivedAt: T0 + 1001,
    };
  }

  private pullRequest(): GitHubPullRequestV1 {
    const base: GitHubPullRequestV1 = {
      number: 7,
      title: "Sentinel repair",
      body: "Refs placeholder",
      state: this.releasedHead === null ? "open" : "merged",
      head: this.releasedHead ?? SHA1,
      base: this.options.baseSha ?? SHA1,
      mergeSha: this.releasedHead ?? null,
      headRef: "sentinel/repair/x",
      baseRef: "development",
      author: null,
      createdAt: T0,
      updatedAt: T0,
      mergedAt: this.releasedHead === null ? null : T0,
      reviewDecision: "approved",
    };
    return { ...base, ...this.options.pullRequest };
  }
}

export interface FakeIncidentOptionsV1 {
  summaries?: IncidentSummaryV1[];
  evidence?: IncidentEvidenceV1 | null;
  failListNext?: boolean;
  coverageIncomplete?: boolean;
}

/** Recording fake IncidentAdapter. */
export class FakeIncidents implements IncidentAdapter {
  readonly listCalls = 0;
  readonly readCalls: string[] = [];
  private summaries: IncidentSummaryV1[];
  private evidenceById = new Map<string, IncidentEvidenceV1>();
  private readonly options: FakeIncidentOptionsV1;

  constructor(options: FakeIncidentOptionsV1 = {}) {
    this.options = options;
    this.summaries = options.summaries ?? [];
    if (options.evidence !== null && options.evidence !== undefined) {
      this.evidenceById.set(options.evidence.incidentId, options.evidence);
    }
  }

  /** Deterministic test-side injection; never used by product logic. */
  setSummaries(summaries: IncidentSummaryV1[]): void {
    this.summaries = summaries;
  }

  setEvidence(evidence: IncidentEvidenceV1[]): void {
    this.evidenceById = new Map(
      evidence.map((item) => [item.incidentId, item]),
    );
  }

  listUnresolvedIncidents(
    cursor: string | null,
    _limit: number,
  ): Promise<PortResultV1<IncidentPageV1>> {
    if (this.options.failListNext) {
      return Promise.resolve(
        portError("unavailable", "listing transport failure"),
      );
    }
    const page: IncidentPageV1 = {
      items: cursor === null ? this.summaries : [],
      coverage: this.options.coverageIncomplete
        ? {
          status: "incomplete",
          reason: "bounded scan",
          nextCursor: "next",
        }
        : { status: "complete" },
      nextCursor: null,
    };
    return Promise.resolve(portOk(page));
  }

  readIncident(
    incidentId: string,
  ): Promise<PortResultV1<IncidentEvidenceV1 | null>> {
    this.readCalls.push(incidentId);
    return Promise.resolve(portOk(this.evidenceById.get(incidentId) ?? null));
  }

  readArtifact(_ref: string, _maxBytes: number) {
    return Promise.resolve(portOk(null));
  }
}

export interface FakeReplayOptionsV1 {
  before?: Partial<IsolatedReplayResultV1>;
  after?: Partial<IsolatedReplayResultV1>;
  /** Trusted fixture identity returned to the repair loop. */
  testIds?: string[];
  /** Force the before run to a port error. */
  beforeFail?: boolean;
  afterFail?: boolean;
}

/** Scripted deterministic ReplayPort. */
export class FakeReplay implements ReplayPort {
  readonly requests: ReplayRunRequestV1[] = [];
  private readonly options: FakeReplayOptionsV1;

  constructor(options: FakeReplayOptionsV1 = {}) {
    this.options = options;
  }

  resolveTestIds(
    _fixtureRef: string,
    _fixtureDigest: FixtureDigest,
  ): Promise<PortResultV1<readonly string[]>> {
    return Promise.resolve(
      portOk(this.options.testIds ?? ["repair:regression"]),
    );
  }

  runReplay(
    request: ReplayRunRequestV1,
  ): Promise<PortResultV1<IsolatedReplayResultV1>> {
    this.requests.push(request);
    const atOriginal = request.revision === SHA2;
    if (atOriginal) {
      if (this.options.beforeFail) {
        return Promise.resolve(
          portError("unavailable", "replay transport failure"),
        );
      }
      return Promise.resolve(portOk({
        outcome: "failed",
        exitCode: 1,
        output: {
          stdoutDigest: "b".repeat(64) as never,
          stderrDigest: null,
          truncated: false,
        },
        failure: { intended: true, reason: "fixture reproduced" },
        limitations: [],
        startedAt: T0,
        endedAt: T0 + 10,
        ...this.options.before,
      }));
    }
    if (this.options.afterFail) {
      return Promise.resolve(
        portError("unavailable", "after transport failure"),
      );
    }
    return Promise.resolve(portOk({
      outcome: "passed",
      exitCode: 0,
      output: {
        stdoutDigest: "c".repeat(64) as never,
        stderrDigest: null,
        truncated: false,
      },
      failure: null,
      limitations: [],
      startedAt: T0,
      endedAt: T0 + 20,
      ...this.options.after,
    }));
  }
}

export interface FakeModelOptionsV1 {
  head?: GitSha | null;
  /** Per-call candidate heads in order; the last value repeats. */
  heads?: GitSha[];
  changedPaths?: string[];
  checkoutSha?: GitSha | null;
  outcome?: ModelRunReceiptV1["outcome"];
  /** Return a port error instead of a receipt (e.g. unavailable boundary). */
  portError?: boolean;
  throwNext?: boolean;
}

/** Fake ImplementationPort; records every call (zero-duplicate-start proof). */
export class FakeModel implements ImplementationPort {
  readonly requests: ModelRunRequestV1[] = [];
  private readonly options: FakeModelOptionsV1 = {};
  constructor(options: FakeModelOptionsV1 = {}) {
    this.options = options;
  }

  runModel(
    request: ModelRunRequestV1,
  ): Promise<PortResultV1<ModelRunReceiptV1>> {
    this.requests.push(request);
    if (this.options.throwNext) {
      this.options.throwNext = false;
      return Promise.reject(new Error("simulated transport crash"));
    }
    if (this.options.portError) {
      return Promise.resolve(portError(
        "unavailable",
        "model receipt unavailable: actual provider model/effort could not be verified at this boundary",
      ));
    }
    const index = this.requests.length - 1;
    const head = this.options.heads !== undefined
      ? this.options.heads[Math.min(index, this.options.heads.length - 1)]
      : (this.options.head ?? SHA2);
    const completed = this.options.outcome !== "failed" &&
      this.options.outcome !== "interrupted";
    return Promise.resolve(portOk({
      invocationId: `invoke-${this.requests.length}`,
      outcome: this.options.outcome ?? "completed",
      actual: {
        observedModel: "gpt-5.6-luna",
        observedReasoning: "max",
        durationMs: 100,
        outputChars: 500,
      },
      candidate: completed
        ? {
          head,
          checkpointSha: this.options.checkoutSha ?? null,
          changedPaths: this.options.changedPaths ?? ["src/app.ts"],
        }
        : null,
      error: null,
    }));
  }
}

/** Deterministic config set for the synthetic repository (budget caps high). */
export function repairConfigs(
  overrides: Record<string, unknown> = {},
): RepositoryConfigV1[] {
  return [repositoryConfig(REPO, { perHour: 5, perSevenDays: 20 }, {
    protectedPaths: ["src/handler.ts"],
    ...overrides,
  })];
}

/** Basic assertions shared by the loop acceptance tests. */
export function assertRecordValid(record: WorkRecordV1): void {
  assert.ok(record.id.length > 0);
  assert.ok(record.repository.owner === REPO.owner);
  assert.ok(record.controller.sha.length === 40);
}

/**
 * Run-bound test device: advances the fake clock exactly once when the
 * before-run replay executes (the step directly before an implementation
 * start). A consumed before-run is replayed once more when the candidate is
 * validated, so the device arms itself; the after-run (candidate revision) is
 * left untouched and the rest of a lifecycle step is exercised at the advanced
 * time without a second jump.
 */
export class AdvancingFakeReplay extends FakeReplay {
  private advanced = false;
  constructor(
    private readonly clock: FakeClock,
    private readonly advanceMs: number,
    options: FakeReplayOptionsV1 = {},
  ) {
    super(options);
  }

  override runReplay(
    request: ReplayRunRequestV1,
  ): Promise<PortResultV1<IsolatedReplayResultV1>> {
    if (!this.advanced && request.revision === SHA2) {
      this.clock.advance(this.advanceMs);
      this.advanced = true;
    }
    return super.runReplay(request);
  }
}

/**
 * Run-bound test device: advances the fake clock when a candidate branch push
 * succeeds (the deterministic publication step directly before a review
 * request), so a review start can be observed past the model cutoff.
 */
export class AdvancingFakeGithub extends FakeGithub {
  constructor(
    private readonly clock: FakeClock,
    private readonly advanceMs: number,
    options: FakeGithubOptionsV1 = {},
  ) {
    super(options);
  }

  override pushHead(
    ref: string,
    sha: GitSha,
    expectedRef: GitSha | null,
  ): Promise<PortResultV1<"applied" | "ambiguous">> {
    this.clock.advance(this.advanceMs);
    return super.pushHead(ref, sha, expectedRef);
  }
}
