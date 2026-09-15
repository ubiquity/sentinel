/**
 * One-shot hosted issue-48 recovery.
 *
 * This supervisor-owned helper performs exactly one fixed repair-state
 * transition: the persisted work item `issue-ubiquity-sentinel-48` moves from
 * its stale blocked state back to `work` with its blocker and implementation
 * intent cleared, so the ordinary hosted supervisor can admit the next attempt
 * through its own admission path. It is NOT a general maintenance framework:
 * it writes no release state, reserves no budget, changes no cadence and
 * touches no other record.
 *
 * Safety envelope:
 * - `runIssue48RecoveryMain` refuses to touch credentials or state unless the
 *   process is the hosted `maintenance` job of the protected
 *   `sentinel-supervisor` workflow at the exact dispatched source commit with
 *   a clean checkout. Identity is verified before any state operation.
 * - The repair ref is read FIRST. Any observed head other than the exact
 *   pinned recovery head is an ordinary zero-write `skipped_state_changed`
 *   outcome: once anything moved, this helper makes no claim and no change.
 * - Every preflight (snapshot digest, release head, sole hosted runtime, PR
 *   identity, target shape, clock) must hold before the single CAS write.
 * - Exactly one `writeRepair` is attempted; its typed disposition is
 *   preserved and never retried. An applied outcome is reported only after a
 *   full readback proves the returned head, the entire canonical snapshot and
 *   the unchanged release head. Uncertain outcomes are never rolled back.
 * - The result is one bounded static JSON line; raw inputs, tokens, paths,
 *   snapshots and process output are never printed.
 *
 * The exported core takes injected state/clock/binding/PR-read dependencies so
 * tests run credential-free against real temporary local Git state. Only
 * `runIssue48RecoveryMain` uses the fixed production pins and GITHUB identity.
 */

import type { GitSha, WorkItemId } from "../src/contracts/brands.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import type { HostedRuntimeRecordV1 } from "../src/contracts/hosted-supervisor.ts";
import type {
  PortErrorKindV1,
  PortResultV1,
  RepairStateWriter,
  StateReadResultV1,
  StateReadView,
  StateWriteResultV1,
} from "../src/contracts/ports.ts";
import { portError, portOk } from "../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import { githubGitAuthEnv } from "../src/host/local.ts";
import { createRepairStateStore, DenoGitRunner } from "../src/state/mod.ts";

/** The only remote this helper talks to; fixed, never configurable. */
export const ISSUE48_REMOTE_URL = "https://github.com/ubiquity/sentinel.git";

/** The only repository identity this helper accepts. */
export const ISSUE48_REPOSITORY = "ubiquity/sentinel";

/** Exact hosted workflow identity that may run the maintenance job. */
export const ISSUE48_WORKFLOW_REF =
  "ubiquity/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor";

/** Fixed production binding of the reviewed one-shot recovery. */
export interface Issue48RecoveryBindingV1 {
  /** Exact repair-ref head whose snapshot this one-shot may advance. */
  repairHead: GitSha;
  /** SHA-256 of canonicalStringify(snapshot), without a trailing newline. */
  repairDigest: string;
  /** Exact release-ref head that must stay pinned through the write. */
  releaseHead: GitSha;
  /** Sole hosted runtime identity and pointer. */
  runtimeId: string;
  runtimeRevision: GitSha;
  runtimeGeneration: number;
  /** Exact open PR identity required before the transition. */
  pullRequestNumber: number;
  pullRequestHead: GitSha;
  pullRequestBase: GitSha;
  pullRequestRepository: string;
  /** Exact target work item id. */
  targetId: WorkItemId;
}

/** Reviewed production pins; the main entry point uses only this value. */
export const ISSUE48_PRODUCTION_BINDING: Issue48RecoveryBindingV1 = {
  repairHead: "71dd998e74c06d78ab96ae6256e4e27cce59d1ad" as GitSha,
  repairDigest:
    "726f662b7c46308f11de94dae469c8ab3b19eeb86746f3cc6f13d12a6b7482a4",
  releaseHead: "9d5bf76fa1f36952caebb6e2cb992b71b33802f2" as GitSha,
  runtimeId: "ubiquity/sentinel:0:production",
  runtimeRevision: "20aae115b44ed740c37e2452de4d5530b66430ec" as GitSha,
  runtimeGeneration: 5,
  pullRequestNumber: 51,
  pullRequestHead: "0e689889b9486f020b7e6a7638e6c81fe181bd0d" as GitSha,
  pullRequestBase: "1d618965c2cb8d0bcaa4fc298ed0973c4b9fa9ca" as GitSha,
  pullRequestRepository: ISSUE48_REPOSITORY,
  targetId: "issue-ubiquity-sentinel-48" as WorkItemId,
};

/** Bounded read-only PR identity observed by the injected callback. */
export interface Issue48PullRequestViewV1 {
  number: number;
  state: "open" | "closed" | "merged";
  head: GitSha;
  base: GitSha;
  repository: string;
}

export type Issue48PullRequestReaderV1 = (
  number: number,
) => Promise<PortResultV1<Issue48PullRequestViewV1>>;

export interface Issue48RecoveryDepsV1 {
  state: StateReadView & RepairStateWriter;
  clock: { now(): number };
  binding: Issue48RecoveryBindingV1;
  readPullRequest: Issue48PullRequestReaderV1;
}

/** Closed set of static result reasons; never built from raw error text. */
export type Issue48RecoveryReasonV1 =
  | "applied"
  | "state_head_changed"
  | "identity_rejected"
  | "unexpected_failure"
  | "repair_read_failed"
  | "repair_digest_mismatch"
  | "release_read_failed"
  | "release_head_changed"
  | "runtime_mismatch"
  | "pull_request_read_failed"
  | "pull_request_mismatch"
  | "target_precondition_mismatch"
  | "clock_invalid"
  | "snapshot_invalid"
  | "write_conflict"
  | "write_ambiguous"
  | "write_unavailable"
  | "write_auth_failed"
  | "write_rate_limited"
  | "write_not_found"
  | "write_invalid"
  | "readback_unverified";

export type Issue48RecoveryStatusV1 =
  | "applied"
  | "skipped_state_changed"
  | "failed";

/** One bounded result. Heads are present only where actually proved. */
export interface Issue48RecoveryResultV1 {
  status: Issue48RecoveryStatusV1;
  reason: Issue48RecoveryReasonV1;
  beforeHead: GitSha | null;
  appliedHead: GitSha | null;
}

function failed(
  reason: Issue48RecoveryReasonV1,
  beforeHead: GitSha | null = null,
): Issue48RecoveryResultV1 {
  return { status: "failed", reason, beforeHead, appliedHead: null };
}

function skipped(beforeHead: GitSha | null): Issue48RecoveryResultV1 {
  return {
    status: "skipped_state_changed",
    reason: "state_head_changed",
    beforeHead,
    appliedHead: null,
  };
}

function writeFailureReason(kind: PortErrorKindV1): Issue48RecoveryReasonV1 {
  switch (kind) {
    case "unavailable":
      return "write_unavailable";
    case "auth_failed":
      return "write_auth_failed";
    case "rate_limited":
      return "write_rate_limited";
    case "not_found":
      return "write_not_found";
    case "conflict":
      return "write_conflict";
    case "invalid":
      return "write_invalid";
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function runtimeMatches(
  runtimes: readonly HostedRuntimeRecordV1[],
  binding: Issue48RecoveryBindingV1,
): boolean {
  if (runtimes.length !== 1) return false;
  const runtime = runtimes[0];
  if (runtime === undefined) return false;
  return runtime.id === binding.runtimeId &&
    runtime.activeRevision === binding.runtimeRevision &&
    runtime.generation === binding.runtimeGeneration &&
    runtime.execution === null;
}

function pullRequestMatches(
  view: Issue48PullRequestViewV1,
  binding: Issue48RecoveryBindingV1,
): boolean {
  return view.number === binding.pullRequestNumber &&
    view.state === "open" &&
    view.head === binding.pullRequestHead &&
    view.base === binding.pullRequestBase &&
    view.repository === binding.pullRequestRepository;
}

function targetPreconditionHolds(
  record: WorkRecordV1,
  binding: Issue48RecoveryBindingV1,
): boolean {
  return record.nextStep === "blocked" &&
    record.blocker !== null &&
    record.intent !== null &&
    record.intent.kind === "implementation" &&
    record.counters.attempts === 2 &&
    record.counters.retries === 0 &&
    record.counters.reviewRounds === 1 &&
    record.target.pr === binding.pullRequestNumber &&
    record.target.head === binding.pullRequestHead &&
    record.target.base === binding.pullRequestBase;
}

/**
 * Clone the complete snapshot and change ONLY the four target work fields plus
 * the snapshot metadata. Every other record, reservation, review, charge,
 * target and counter is preserved by reference.
 */
function buildNextSnapshot(
  prior: RepairStateSnapshotV1,
  targetId: WorkItemId,
  observedHead: GitSha,
  now: number,
): RepairStateSnapshotV1 {
  const work = prior.work.map((record) =>
    record.id === targetId
      ? {
        ...record,
        nextStep: "work" as const,
        blocker: null,
        intent: null,
        updatedAt: now,
      }
      : record
  );
  return {
    version: prior.version,
    kind: prior.kind,
    stateHead: observedHead,
    sequence: prior.sequence + 1,
    updatedAt: now,
    incidents: prior.incidents,
    evidence: prior.evidence,
    work,
    reservations: prior.reservations,
    reviews: prior.reviews,
    replays: prior.replays,
    releaseRequests: prior.releaseRequests,
    githubCooldowns: prior.githubCooldowns,
  };
}

async function readRepairSafely(
  state: StateReadView,
): Promise<PortResultV1<StateReadResultV1<RepairStateSnapshotV1>> | null> {
  try {
    return await state.readRepair();
  } catch {
    return null;
  }
}

async function readReleaseSafely(
  state: StateReadView,
): Promise<PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>> | null> {
  try {
    return await state.readRelease();
  } catch {
    return null;
  }
}

/**
 * Run exactly one bounded attempt of the fixed recovery against the injected
 * state. Returns a static result; never throws for a typed failure and never
 * retries or rolls back.
 */
export async function runIssue48Recovery(
  deps: Issue48RecoveryDepsV1,
): Promise<Issue48RecoveryResultV1> {
  const binding = deps.binding;

  // Repair FIRST: once its observed head moved, any later progress is ordinary
  // and this one-shot claims nothing and writes nothing.
  const repairRead = await readRepairSafely(deps.state);
  if (repairRead === null || !repairRead.ok) {
    return failed("repair_read_failed");
  }
  // A missing ref is a bounded failure, never an empty success: only a real
  // observed head may decide between recovery and an ordinary skip.
  if (repairRead.value.status !== "found") return failed("repair_read_failed");
  const observedHead = repairRead.value.head;
  if (observedHead !== binding.repairHead) return skipped(observedHead);

  let snapshot: RepairStateSnapshotV1;
  try {
    snapshot = parseRepairStateSnapshotV1(repairRead.value.snapshot);
  } catch {
    return failed("repair_read_failed", observedHead);
  }

  // The pinned head must carry the exact reviewed snapshot bytes.
  const digest = await sha256Hex(canonicalStringify(snapshot));
  if (digest !== binding.repairDigest) {
    return failed("repair_digest_mismatch", observedHead);
  }

  const releaseRead = await readReleaseSafely(deps.state);
  if (releaseRead === null || !releaseRead.ok) {
    return failed("release_read_failed", observedHead);
  }
  if (releaseRead.value.status !== "found") {
    return failed("release_head_changed", observedHead);
  }
  if (releaseRead.value.head !== binding.releaseHead) {
    return failed("release_head_changed", observedHead);
  }
  let release: ReleaseStateSnapshotV1;
  try {
    release = parseReleaseStateSnapshotV1(releaseRead.value.snapshot);
  } catch {
    return failed("release_read_failed", observedHead);
  }
  if (!runtimeMatches(release.hostedRuntimes, binding)) {
    return failed("runtime_mismatch", observedHead);
  }

  let pullRequest: PortResultV1<Issue48PullRequestViewV1>;
  try {
    pullRequest = await deps.readPullRequest(binding.pullRequestNumber);
  } catch {
    return failed("pull_request_read_failed", observedHead);
  }
  if (!pullRequest.ok) return failed("pull_request_read_failed", observedHead);
  if (!pullRequestMatches(pullRequest.value, binding)) {
    return failed("pull_request_mismatch", observedHead);
  }

  const target = snapshot.work.find((record) => record.id === binding.targetId);
  if (target === undefined || !targetPreconditionHolds(target, binding)) {
    return failed("target_precondition_mismatch", observedHead);
  }

  const now = deps.clock.now();
  if (
    !Number.isSafeInteger(now) ||
    now < Math.max(snapshot.updatedAt, target.updatedAt)
  ) {
    return failed("clock_invalid", observedHead);
  }

  let next: RepairStateSnapshotV1;
  try {
    next = buildNextSnapshot(snapshot, binding.targetId, observedHead, now);
    parseRepairStateSnapshotV1(next);
  } catch {
    return failed("snapshot_invalid", observedHead);
  }

  // Exactly one write attempt; the typed disposition is preserved below.
  let write: PortResultV1<StateWriteResultV1> | null;
  try {
    write = await deps.state.writeRepair(next, observedHead);
  } catch {
    return failed("write_unavailable", observedHead);
  }
  if (write === null) return failed("write_unavailable", observedHead);
  if (!write.ok) {
    return failed(writeFailureReason(write.error.kind), observedHead);
  }
  if (write.value.status === "conflict") {
    return failed("write_conflict", write.value.currentHead);
  }
  if (write.value.status === "ambiguous") {
    return failed("write_ambiguous", write.value.currentHead);
  }
  const writtenHead = write.value.head;

  // An applied response is never enough: prove the returned head, the whole
  // canonical snapshot and the pinned release head by an actual readback.
  const readback = await readRepairSafely(deps.state);
  if (readback === null || !readback.ok) {
    return failed("readback_unverified", observedHead);
  }
  if (readback.value.status !== "found") {
    return failed("readback_unverified", observedHead);
  }
  if (readback.value.head !== writtenHead) {
    return failed("readback_unverified", observedHead);
  }
  if (
    canonicalStringify(readback.value.snapshot) !== canonicalStringify(next)
  ) {
    return failed("readback_unverified", observedHead);
  }
  const releaseReadback = await readReleaseSafely(deps.state);
  if (
    releaseReadback === null || !releaseReadback.ok ||
    releaseReadback.value.status !== "found" ||
    releaseReadback.value.head !== binding.releaseHead
  ) {
    return failed("readback_unverified", observedHead);
  }

  return {
    status: "applied",
    reason: "applied",
    beforeHead: observedHead,
    appliedHead: writtenHead,
  };
}

// ---------------------------------------------------------------------------
// Hosted identity: main refuses to use credentials or state unless the process
// is the protected maintenance job at the exact dispatched source commit.
// ---------------------------------------------------------------------------

export interface Issue48HostedIdentityV1 {
  repository: string | null;
  ref: string | null;
  job: string | null;
  runId: string | null;
  runAttempt: string | null;
  workflowRef: string | null;
  sha: string | null;
  workflowSha: string | null;
  checkoutHead: string | null;
  checkoutClean: boolean;
}

export type Issue48IdentityFailureV1 =
  | "repository"
  | "ref"
  | "job"
  | "run"
  | "workflow_ref"
  | "sha"
  | "checkout";

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;

function isRunId(value: string | null): boolean {
  if (value === null || !RUN_ID_PATTERN.test(value)) return false;
  return Number.isSafeInteger(Number(value));
}

export function validateIssue48HostedIdentity(
  input: Issue48HostedIdentityV1,
): { ok: true } | { ok: false; reason: Issue48IdentityFailureV1 } {
  if (input.repository !== ISSUE48_REPOSITORY) {
    return { ok: false, reason: "repository" };
  }
  if (input.ref !== "refs/heads/sentinel-supervisor") {
    return { ok: false, reason: "ref" };
  }
  if (input.job !== "maintenance") return { ok: false, reason: "job" };
  if (!isRunId(input.runId) || !isRunId(input.runAttempt)) {
    return { ok: false, reason: "run" };
  }
  if (input.workflowRef !== ISSUE48_WORKFLOW_REF) {
    return { ok: false, reason: "workflow_ref" };
  }
  if (
    input.sha === null || !GIT_SHA_PATTERN.test(input.sha) ||
    input.workflowSha !== input.sha
  ) {
    return { ok: false, reason: "sha" };
  }
  if (input.checkoutHead !== input.sha || !input.checkoutClean) {
    return { ok: false, reason: "checkout" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Main: hosted identity, fixed remote, token-scoped PR read, one JSON result.
// ---------------------------------------------------------------------------

function readEnv(key: string): string | null {
  try {
    return Deno.env.get(key) ?? null;
  } catch {
    return null;
  }
}

async function readCheckoutFacts(): Promise<
  { head: string | null; clean: boolean }
> {
  const env: Record<string, string> = {
    PATH: readEnv("PATH") ?? "/usr/bin:/bin",
    HOME: readEnv("HOME") ?? "/tmp",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  try {
    const cwd = Deno.cwd();
    const head = await new Deno.Command("git", {
      args: ["rev-parse", "HEAD"],
      cwd,
      clearEnv: true,
      env,
      stdout: "piped",
      stderr: "null",
    }).output();
    const headSha = head.success
      ? new TextDecoder().decode(head.stdout).trim()
      : "";
    const status = await new Deno.Command("git", {
      args: ["status", "--porcelain"],
      cwd,
      clearEnv: true,
      env,
      stdout: "piped",
      stderr: "null",
    }).output();
    return {
      head: GIT_SHA_PATTERN.test(headSha) ? headSha : null,
      clean: status.success &&
        new TextDecoder().decode(status.stdout).trim() === "",
    };
  } catch {
    return { head: null, clean: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readPositiveInt(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function readNested(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

/** Bounded strict extraction; any missing/malformed part is a static failure. */
function parsePullRequestView(
  input: unknown,
): Issue48PullRequestViewV1 | null {
  if (!isRecord(input)) return null;
  const number = readPositiveInt(input, "number");
  const state = readString(input, "state");
  const merged = input["merged"];
  const head = readNested(input, "head");
  const base = readNested(input, "base");
  if (number === null || state === null || head === null || base === null) {
    return null;
  }
  const headSha = readString(head, "sha");
  const baseSha = readString(base, "sha");
  const headRepo = readNested(head, "repo");
  const baseRepo = readNested(base, "repo");
  const headName = headRepo === null ? null : readString(headRepo, "full_name");
  const baseName = baseRepo === null ? null : readString(baseRepo, "full_name");
  if (
    headSha === null || baseSha === null || headName === null ||
    baseName === null || !GIT_SHA_PATTERN.test(headSha) ||
    !GIT_SHA_PATTERN.test(baseSha)
  ) {
    return null;
  }
  if (headName !== ISSUE48_REPOSITORY || baseName !== ISSUE48_REPOSITORY) {
    return null;
  }
  const rawState = merged === true ? "merged" : state;
  let viewState: Issue48PullRequestViewV1["state"];
  if (rawState === "open" || rawState === "closed" || rawState === "merged") {
    viewState = rawState;
  } else {
    return null;
  }
  return {
    number,
    state: viewState,
    head: headSha as GitSha,
    base: baseSha as GitSha,
    repository: baseName,
  };
}

const PULL_REQUEST_RESPONSE_LIMIT = 65_536;
const PULL_REQUEST_TIMEOUT_MS = 10_000;

/**
 * One bounded read-only authenticated GET of the fixed PR path. The fixed
 * ten-second deadline stays armed through the complete body read, decode and
 * parse and is cleared only in the final cleanup. The body is read
 * incrementally by BYTE count and is cancelled as soon as it exceeds the fixed
 * maximum, so larger content is never buffered; only a fully read in-budget
 * body is decoded and parsed. The optional transport is an internal test seam
 * only: production callers always use the default `fetch`, and the fixed URL,
 * headers and deadline are never configurable.
 */
export async function readGitHubPullRequest(
  number: number,
  token: string,
  transport: typeof fetch = fetch,
): Promise<PortResultV1<Issue48PullRequestViewV1>> {
  const url =
    `https://api.github.com/repos/${ISSUE48_REPOSITORY}/pulls/${number}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PULL_REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await transport(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "sentinel-issue48-recovery",
          "x-github-api-version": "2022-11-28",
        },
      });
    } catch {
      return portError("unavailable", "GitHub pull request read failed");
    }
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // Best-effort body release; the static failure below is unaffected.
      }
      return portError(
        response.status === 404 ? "not_found" : "unavailable",
        "GitHub pull request read failed",
      );
    }
    if (response.body === null) {
      return portError("invalid", "GitHub pull request response was not JSON");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let readBytes = 0;
    let overflowed = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        readBytes += chunk.value.byteLength;
        if (readBytes > PULL_REQUEST_RESPONSE_LIMIT) {
          overflowed = true;
          break;
        }
        chunks.push(chunk.value);
      }
    } catch {
      return portError("unavailable", "GitHub pull request read failed");
    } finally {
      // Overflow stops the stream instead of buffering the remaining body.
      if (overflowed) {
        try {
          await reader.cancel();
        } catch {
          // Best-effort stop; the static failure below is unaffected.
        }
      }
    }
    if (overflowed) {
      return portError("invalid", "GitHub pull request response was too large");
    }
    const body = new Uint8Array(readBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return portError("invalid", "GitHub pull request response was not JSON");
    }
    const view = parsePullRequestView(parsed);
    if (view === null) {
      return portError("invalid", "GitHub pull request identity was malformed");
    }
    return portOk(view);
  } finally {
    clearTimeout(timer);
  }
}

function report(result: Issue48RecoveryResultV1): number {
  console.log(JSON.stringify(result));
  return result.status === "failed" ? 1 : 0;
}

/**
 * Hosted entry point. Verifies identity, then runs the one-shot. Exits nonzero
 * only on a real failure; `skipped_state_changed` is a zero-write ordinary
 * outcome and exits zero.
 */
export async function runIssue48RecoveryMain(): Promise<number> {
  const facts = await readCheckoutFacts();
  const validated = validateIssue48HostedIdentity({
    repository: readEnv("GITHUB_REPOSITORY"),
    ref: readEnv("GITHUB_REF"),
    job: readEnv("GITHUB_JOB"),
    runId: readEnv("GITHUB_RUN_ID"),
    runAttempt: readEnv("GITHUB_RUN_ATTEMPT"),
    workflowRef: readEnv("GITHUB_WORKFLOW_REF"),
    sha: readEnv("GITHUB_SHA"),
    workflowSha: readEnv("GITHUB_WORKFLOW_SHA"),
    checkoutHead: facts.head,
    checkoutClean: facts.clean,
  });
  // Identity is rejected before any credential is read: an unauthenticated
  // process must never touch the token path.
  if (!validated.ok) return report(failed("identity_rejected"));
  const token = readEnv("GITHUB_TOKEN");
  if (token === null || token.length === 0) {
    return report(failed("identity_rejected"));
  }

  let result: Issue48RecoveryResultV1;
  try {
    // Private scratch and git home under the task checkout, owner-only.
    const scratch = `${Deno.cwd()}/.issue48-recovery`;
    Deno.mkdirSync(scratch, { recursive: true, mode: 0o700 });
    try {
      Deno.chmodSync(scratch, 0o700);
    } catch {
      // Best-effort hardening; the caller's umask still applies.
    }
    const runner = new DenoGitRunner(
      `${scratch}/git-home`,
      githubGitAuthEnv(token),
    );
    const state = createRepairStateStore({
      scratchDir: `${scratch}/state`,
      remoteUrl: ISSUE48_REMOTE_URL,
      runner,
    });
    result = await runIssue48Recovery({
      state,
      clock: { now: () => Date.now() },
      binding: ISSUE48_PRODUCTION_BINDING,
      readPullRequest: (number) => readGitHubPullRequest(number, token),
    });
  } catch {
    result = failed("unexpected_failure");
  }
  return report(result);
}

if (import.meta.main) {
  Deno.exitCode = await runIssue48RecoveryMain();
}
