// Test-only helpers for the Git state suite. Records are built as raw JSON
// and passed through the actual frozen contract parsers, so this file carries
// no duplicated validation logic; the suite injects transport wrappers only.
import type { GitRunnerV1, GitRunResultV1 } from "../../src/state/mod.ts";
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import { parseBudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import {
  parseIncidentEvidenceV1,
  parseIncidentSummaryV1,
} from "../../src/contracts/incident.ts";
import type {
  IncidentEvidenceV1,
  IncidentSummaryV1,
} from "../../src/contracts/incident.ts";
import {
  parseReleaseRecordV1,
  parseReleaseRequestV1,
} from "../../src/contracts/release.ts";
import type {
  ReleaseRecordV1,
  ReleaseRequestV1,
} from "../../src/contracts/release.ts";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";

export const REPO = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 7,
} as const;

export const SHA1 = "aafb7ee0598699bb7fb8a72ea133693ed64462da" as GitSha;
export const SHA2 = "6dc35d06e757107b91eb58232bd15e5f671d79b4" as GitSha;
export const SHA3 = "4a21c96d46e6f98c3c04125cafce34e255e710e3" as GitSha;
export const DEP_0 = { gitSha: SHA2, revisionId: "dep-0000" };
export const DEP_1 = { gitSha: SHA1, revisionId: "dep-0001" };
export const DEP_2 = { gitSha: SHA3, revisionId: "dep-0002" };

export const T0 = 1786000000000;

function workId(value: string): WorkItemId {
  return value as WorkItemId;
}

/** Minimal valid work record, parsed by the frozen parser. */
export function workRecord(
  id: string,
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return parseWorkRecordV1({
    version: "v1",
    kind: "work",
    repository: REPO,
    id: workId(id),
    source: { kind: "issue", id: id, revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    fingerprint: null,
    failingRevision: SHA1,
    sourceSnapshotDigest: null,
    classification: { severity: "P3", priority: null },
    urgency: {
      activeProduction: false,
      reproducible5xx: false,
      severeSecurityOrDataLoss: false,
    },
    dependencies: [],
    controller: { sha: SHA1 },
    target: {
      base: SHA1,
      branch: null,
      checkpoint: null,
      head: null,
      pr: null,
    },
    nextStep: "work",
    wait: null,
    blocker: null,
    counters: { attempts: 0, retries: 0, reviewRounds: 0 },
    evidence: [],
    intent: null,
    firstSeenAt: null,
    createdAt: T0,
    updatedAt: T0 + 1000,
    ...overrides,
  });
}

/** Minimal valid budget reservation, parsed by the frozen parser. */
export function reservation(
  id: string,
  overrides: Record<string, unknown> = {},
): BudgetReservationV1 {
  return parseBudgetReservationV1({
    version: "v1",
    kind: "budget_reservation",
    repository: REPO,
    id,
    taskId: workId(`task:${id}`),
    attempt: 1,
    head: SHA1,
    purpose: "implementation",
    createdAt: T0,
    outcome: "reserved",
    settledAt: null,
    proofRef: null,
    ...overrides,
  });
}

/** Minimal valid release request, parsed by the frozen parser. */
export function releaseRequest(
  id: string,
  overrides: Record<string, unknown> = {},
): ReleaseRequestV1 {
  return parseReleaseRequestV1({
    version: "v1",
    kind: "release_request",
    id,
    target: { repository: REPO, environment: "production" },
    revision: SHA1,
    source: {
      pullRequest: 1,
      reviewRequestId: "review-req-1",
      reviewReceiptId: null,
      head: SHA1,
      base: SHA2,
    },
    status: "open",
    failureReason: null,
    createdAt: T0,
    ...overrides,
  });
}

/** Minimal valid incident summary, parsed by the frozen parser. */
export function incidentSummary(
  id: string,
  overrides: Record<string, unknown> = {},
): IncidentSummaryV1 {
  return parseIncidentSummaryV1({
    version: "v1",
    kind: "incident_summary",
    repository: REPO,
    id,
    fingerprint: "d".repeat(64),
    severity: "P3",
    firstSeenAt: T0,
    lastSeenAt: T0 + 5000,
    count: 1,
    failingRevision: SHA2,
    errorType: "GatewayError",
    context: { message: "upstream terminated", location: null, sample: [] },
    provenance: {
      source: "gateway",
      endpoint: "https://ai.ubq.fi",
      capturedAt: T0,
      capturedBy: null,
    },
    coverage: { status: "complete" },
    evidenceRef: null,
    ...overrides,
  });
}

/** Minimal valid pending review receipt, parsed by the frozen parser. */
export function reviewReceipt(
  id: string,
  overrides: Record<string, unknown> = {},
): ReviewReceiptV1 {
  return parseReviewReceiptV1({
    version: "v1",
    kind: "review_receipt",
    id,
    requestId: `req-${id}`,
    expectedReviewer: "chatgpt-codex-connector[bot]",
    observedReviewer: null,
    repository: REPO,
    pullRequest: { number: 12, head: SHA1, base: SHA2 },
    outcome: "pending",
    resultId: null,
    summary: null,
    findings: [],
    findingsUncounted: 0,
    unresolvedSeverities: [],
    submittedAt: T0 + 1000,
    completedAt: null,
    observedAt: T0 + 2000,
    ...overrides,
  });
}

/** Minimal valid incident evidence, parsed by the frozen parser. */
export function incidentEvidence(
  id: string,
  overrides: Record<string, unknown> = {},
): IncidentEvidenceV1 {
  return parseIncidentEvidenceV1({
    version: "v1",
    kind: "incident_evidence",
    repository: REPO,
    id,
    incidentId: `inc:${id}`,
    fingerprint: "d".repeat(64),
    failingRevision: SHA2,
    artifacts: [{
      ref: `artifact://inbox/${id}.pgp`,
      digest: "e".repeat(64),
      sizeBytes: 4096,
      expiresAt: T0 + 100000000,
      contentType: "application/octet-stream",
    }],
    replay: null,
    provenance: {
      source: "gateway",
      endpoint: "https://ai.ubq.fi",
      capturedAt: T0,
      capturedBy: null,
    },
    coverage: { status: "complete" },
    ...overrides,
  });
}

/** Minimal valid release record, parsed by the frozen parser. */
export function releaseRecord(
  id: string,
  overrides: Record<string, unknown> = {},
): ReleaseRecordV1 {
  return parseReleaseRecordV1({
    version: "v1",
    kind: "release_record",
    repository: REPO,
    environment: "production",
    id,
    requestId: `request-${id}`,
    requestRevision: SHA1,
    candidate: { identity: DEP_1, buildTransactionId: `txn-${id}` },
    prior: { identity: DEP_0, verifiedHealthyAt: T0 },
    phase: "requested",
    intent: null,
    observed: { identity: null, domain: null, verified: false, at: null },
    monitoring: {
      startedAt: null,
      samples: 0,
      continuous: false,
      lastSampleAt: null,
    },
    acceptance: null,
    receipts: { promote: null, rollback: null, error: null },
    createdAt: T0,
    updatedAt: T0 + 1000,
    ...overrides,
  });
}

/** A metrics sample for a fixed identity and window (complete coverage). */
export function sample(
  identity: { gitSha: GitSha; revisionId: string },
  sampledAt: number,
  requestCount: number | null = 100,
  overrides: Record<string, unknown> = {},
) {
  return {
    identity,
    windowStart: sampledAt - 30_000,
    windowEnd: sampledAt,
    sampledAt,
    domain: "https://ai.ubq.fi",
    requestCount,
    fiveXxCount: requestCount === null ? null : 0,
    timeoutCount: requestCount === null ? null : 0,
    streamFailureCount: requestCount === null ? null : 0,
    upstreamWideFault: requestCount === null ? null : false,
    coverage: { status: "complete" as const },
    ...overrides,
  };
}

/**
 * A claimable "monitoring" release record whose next transition can be an
 * accepted result with coherent identity/window/coverage evidence.
 */
export function monitoredReleaseRecord(
  id: string,
  phase: "monitoring" | "accepted",
  overrides: Record<string, unknown> = {},
): ReleaseRecordV1 {
  const structured = phase === "accepted";
  return releaseRecord(id, {
    phase,
    intent: { action: "promote", key: `promote/${id}`, persistedAt: T0 + 2000 },
    observed: {
      identity: DEP_1,
      domain: "https://ai.ubq.fi",
      verified: true,
      at: T0 + 3000,
    },
    monitoring: {
      startedAt: T0 + 3000,
      samples: 1,
      continuous: true,
      lastSampleAt: T0 + 33_000,
    },
    acceptance: structured
      ? {
        identity: DEP_1,
        windowMs: 1800000,
        sampleIntervalMs: 30000,
        continuous: true,
        baseline: [sample(DEP_0, T0 + 1000, 1000)],
        samples: [sample(DEP_1, T0 + 33_000, 100)],
        thresholdResults: [{
          metric: "five_xx_rate",
          observedRate: 0.01,
          baselineRate: 0.01,
          maxRate: 0.02,
          maxIncrease: 0.01,
          passed: true,
        }],
        passed: true,
      }
      : null,
    receipts: {
      promote: {
        action: "promote",
        ok: true,
        statusCode: 204,
        observedIdentity: DEP_1,
        observedDomain: "https://ai.ubq.fi",
        at: T0 + 2000,
        detail: null,
      },
      rollback: null,
      error: null,
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Credential-free git for tests: clearEnv with only PATH/temp HOME and
// config isolation; no user/system config or hooks can inject credentials.
// ---------------------------------------------------------------------------

export function testGitEnv(home: string): Record<string, string> {
  return {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "sentinel-state-test",
    GIT_AUTHOR_EMAIL: "sentinel-state-test@localhost",
    GIT_COMMITTER_NAME: "sentinel-state-test",
    GIT_COMMITTER_EMAIL: "sentinel-state-test@localhost",
  };
}

/** SHA-256 hex of a string, matching the store's digest filename scheme. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function gitRun(
  cwd: string,
  args: string[],
  env: Record<string, string>,
): Promise<GitRunResultV1> {
  const result = await new Deno.Command("git", {
    args,
    cwd,
    clearEnv: true,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    ok: result.success,
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

/** Create a disposable bare remote repository plus a working repo for raw pushes. */
export async function makeRemoteCtx(
  root: string,
  env: Record<string, string>,
): Promise<{ bare: string; work: string; remoteUrl: string }> {
  const bare = `${root}/remote.git`;
  const work = `${root}/work`;
  await Deno.mkdir(bare, { recursive: true });
  await Deno.mkdir(work, { recursive: true });
  const init = await gitRun(root, ["init", "-q", "--bare", bare], env);
  if (!init.ok) throw new Error(`bare init failed: ${init.stderr}`);
  const workInit = await gitRun(root, ["init", "-q", work], env);
  if (!workInit.ok) throw new Error(`work init failed: ${workInit.stderr}`);
  const addRemote = await gitRun(
    work,
    ["remote", "add", "origin", bare],
    env,
  );
  if (!addRemote.ok) throw new Error(`remote add failed: ${addRemote.stderr}`);
  return { bare, work, remoteUrl: bare };
}

/**
 * Push an arbitrary raw file tree on top of `parent` onto the state ref in
 * the bare repository (test-side only; the store never does this).
 */
export async function pushRawTree(
  ctx: { bare: string; work: string },
  parent: GitSha,
  ref: string,
  files: Record<string, string>,
  env: Record<string, string>,
): Promise<GitRunResultV1> {
  const fetch = await gitRun(
    ctx.work,
    ["fetch", "-q", "origin", parent],
    env,
  );
  if (!fetch.ok) throw new Error(`fetch failed: ${fetch.stderr}`);
  await gitRun(ctx.work, ["checkout", "-q", "FETCH_HEAD"], env);
  for await (const entry of Deno.readDir(ctx.work)) {
    if (entry.name === ".git") continue;
    await Deno.remove(`${ctx.work}/${entry.name}`, { recursive: true });
  }
  for (const [path, text] of Object.entries(files)) {
    const full = `${ctx.work}/${path}`;
    await Deno.mkdir(
      full.slice(0, full.lastIndexOf("/")),
      { recursive: true },
    );
    await Deno.writeTextFile(full, text);
  }
  await gitRun(ctx.work, ["add", "-A"], env);
  const commit = await gitRun(
    ctx.work,
    ["commit", "-q", "-m", "raw tree"],
    env,
  );
  if (!commit.ok) throw new Error(`commit failed: ${commit.stderr}`);
  return gitRun(ctx.work, ["push", "-q", "origin", `HEAD:${ref}`], env);
}

/** Barrier transport wrapper: both stores synchronize on their first ls-remote. */
export class BarrierRunner implements GitRunnerV1 {
  private arrived = 0;
  private release: () => void = () => {};
  private readonly gate: Promise<void>;

  constructor(private readonly inner: GitRunnerV1) {
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  async runGit(
    args: string[],
    opts: { cwd: string; env?: Readonly<Record<string, string>> },
  ): Promise<GitRunResultV1> {
    if (args[0] === "ls-remote") {
      this.arrived++;
      if (this.arrived >= 2) this.release();
      await this.gate;
    }
    return this.inner.runGit(args, opts);
  }
}

/** Transport wrapper: runs the real push, then reports its response as lost. */
export class LostPushResponseRunner implements GitRunnerV1 {
  pushAttempts = 0;

  constructor(private readonly inner: GitRunnerV1) {}

  async runGit(
    args: string[],
    opts: { cwd: string; env?: Readonly<Record<string, string>> },
  ): Promise<GitRunResultV1> {
    if (args[0] === "push") {
      this.pushAttempts++;
      const result = await this.inner.runGit(args, opts);
      return { ...result, ok: false, code: 1 };
    }
    return this.inner.runGit(args, opts);
  }
}

/**
 * Transport wrapper: throws (with an exception text that would leak a path if
 * it ever escaped) whenever the argument predicate matches, otherwise behaves
 * like the real transport. Used to prove the store translates runner throws
 * into sanitized typed failures and reconciles thrown verification responses
 * against the authoritative ref.
 */
export class ThrowingRunner implements GitRunnerV1 {
  throwCount = 0;

  constructor(
    private readonly inner: GitRunnerV1,
    private readonly throwOn: (args: string[]) => boolean,
  ) {}

  async runGit(
    args: string[],
    opts: { cwd: string; env?: Readonly<Record<string, string>> },
  ): Promise<GitRunResultV1> {
    if (this.throwOn(args)) {
      this.throwCount++;
      throw new Error(`synthetic transport failure at ${args.join(" ")}`);
    }
    return await this.inner.runGit(args, opts);
  }
}

/**
 * Transport wrapper: runs the real operation first and only then throws on a
 * matching call — a response lost AFTER the side effect happened, so the
 * authoritative ref (not the response) decides the outcome.
 */
export class ThrowAfterRunner implements GitRunnerV1 {
  throwCount = 0;

  constructor(
    private readonly inner: GitRunnerV1,
    private readonly throwOn: (args: string[]) => boolean,
  ) {}

  async runGit(
    args: string[],
    opts: { cwd: string; env?: Readonly<Record<string, string>> },
  ): Promise<GitRunResultV1> {
    const result = await this.inner.runGit(args, opts);
    if (this.throwOn(args)) {
      this.throwCount++;
      throw new Error(`synthetic lost response at ${args.join(" ")}`);
    }
    return result;
  }
}

/**
 * Transport wrapper: replaces the exact ls-remote stdout with a canned
 * response (or marks the lookup as a transport failure). Used to prove the
 * strict ls-remote rules: malformed/nonmatching/duplicate responses are
 * invalid, never empty, while a genuinely zero-line response is absent.
 */
export class FakeLsRemoteRunner implements GitRunnerV1 {
  constructor(
    private readonly inner: GitRunnerV1,
    private readonly canned: { ok: boolean; stdout: string } | null,
  ) {}

  async runGit(
    args: string[],
    opts: { cwd: string; env?: Readonly<Record<string, string>> },
  ): Promise<GitRunResultV1> {
    if (args[0] === "ls-remote" && this.canned !== null) {
      return {
        ok: this.canned.ok,
        code: this.canned.ok ? 0 : 128,
        stdout: this.canned.stdout,
        stderr: "",
      };
    }
    return await this.inner.runGit(args, opts);
  }
}
