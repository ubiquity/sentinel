/**
 * Hosted candidate-object restorer and trusted candidate preserver.
 *
 * A fresh hosted Actions clone contains only the development history: a
 * durable candidate produced by an earlier run has no local objects, so a
 * resumed review snapshot or a later merge-ancestry check would fail against
 * an absent object. The restorer lazily restores exactly the durable candidate
 * bound to an existing nonterminal scope-0 work record, immediately before the
 * snapshot capture, ancestry check, or correction checkout that needs it.
 *
 * The preserver stores one exact produced candidate in a create-only,
 * operation-bound remote ref and proves that a NEW empty object store can
 * retrieve the exact objects. It revalidates the durable operation binding
 * before any external read, validates publication in the trusted source mirror
 * BEFORE sending any object, reuses the SAME port readRef/pushHead methods and
 * never forces, overwrites or deletes a ref. Neither helper mutates work/budget
 * state, starts a model, contacts a PR/review/release surface or runs before
 * deterministic bookkeeping.
 */

import { isGitSha } from "../contracts/brands.ts";
import type { GitSha, WorkItemId } from "../contracts/brands.ts";
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type {
  CandidatePreservationRequestV1,
  Clock,
  GitHubCooldownGateV1,
  GitHubPort,
  PortResultV1,
  StateReadView,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type {
  CandidatePreservationV1,
  WorkRecordV1,
} from "../contracts/work-record.ts";
import { GitHubApiClient } from "../github/client.ts";
import type { HttpTransportV1 } from "../github/http.ts";
import { GitReviewSnapshot } from "../github/review-snapshot.ts";
import {
  baseRefreshIntentKey,
  candidatePreservationRef,
  implementationIntentKey,
} from "../repair/keys.ts";
import { DenoReplayRuntime } from "../replay/runtime.ts";
import type { ReplayRuntimeV1 } from "../replay/runtime.ts";
import { githubGitAuthEnv } from "./local.ts";

/** Fixed self remote; the trusted fetch target unless a test injects one. */
export const ACTIONS_CANDIDATES_REMOTE_URL =
  "https://github.com/ubiquity/sentinel.git";

const SELF_REPOSITORY: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "sentinel",
  installationId: 0,
};
const CANDIDATE_BRANCH_PREFIX = "sentinel/repair/";
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;
const STATIC_INPUT = "candidate restore input is invalid";
const STATIC_BINDING = "candidate restore has no exact durable binding";
const STATIC_REMOTE = "candidate restore remote identity is not exact";
const STATIC_FETCH = "candidate restore fetch did not verify";
const STATIC_PRESERVE_INPUT = "candidate preservation request is invalid";
const STATIC_PRESERVE_BINDING =
  "candidate preservation has no exact durable binding";
const STATIC_PRESERVE_LOCAL =
  "candidate preservation local candidate objects are unavailable";
const STATIC_PRESERVE_CONFLICT =
  "candidate preservation ref conflicts with an existing head";
const STATIC_PRESERVE_REMOTE =
  "candidate preservation remote ref did not verify";
const STATIC_PRESERVE_PUSH = "candidate preservation push did not verify";
const STATIC_PRESERVE_PROOF = "candidate preservation fresh-store proof failed";
// Git refs must reject control characters, so the control range is intentional.
// deno-lint-ignore no-control-regex
const FORBIDDEN_BRANCH = /[\u0000-\u001f\u007f ~^:?*\\\[\]]/;
/** Exact preservation ref identity: one 64-hex digest ref body, no variants. */
const PRESERVATION_REF_PATTERN =
  /^refs\/heads\/sentinel-candidates\/[0-9a-f]{64}$/;

export interface ActionsCandidateRestoreRequestV1 {
  base: GitSha;
  head: GitSha;
}

export interface ActionsCandidateRestorerV1 {
  /** Ensure the exact base/head commit objects exist locally. */
  ensure(input: ActionsCandidateRestoreRequestV1): Promise<PortResultV1<void>>;
}

export interface ActionsCandidateRestorerInputV1 {
  state: StateReadView;
  gate: GitHubCooldownGateV1;
  token: string;
  http: HttpTransportV1;
  clock: Clock;
  /** Private trusted source object repository (never a worktree write). */
  sourcePath: string;
  /** Private git home for the credential child environment. */
  scratch: string;
  trustedPath: string;
  gitExecutable: string;
  /** Injectable bounded subprocess runtime; default `DenoReplayRuntime`. */
  runtime?: ReplayRuntimeV1;
  /** Fixed self remote; overridden ONLY by tests with a fixture file:// URL. */
  remoteUrl?: string;
  /** Trusted API base for tests; production uses the public API. */
  apiBaseUrl?: string;
}

/**
 * Trusted candidate-preservation factory input. The repository identity and
 * the authenticated read/push transport are fixed by `port` (the SAME host
 * port instance); `token`/`http`/`apiBaseUrl` mirror the restorer inputs and
 * are consumed by that port, never by a second transport here. The trusted
 * callback supplies the exact candidate objects for one task/head, and
 * `protectedPaths` is the trusted configured publication allowlist.
 */
export interface ActionsCandidatePreserverInputV1 {
  state: StateReadView;
  gate: GitHubCooldownGateV1;
  token: string;
  http: HttpTransportV1;
  clock: Clock;
  /** Private trusted source object repository (validated, never a model cwd). */
  sourcePath: string;
  /** Private owned scratch root for the fresh empty object store. */
  scratch: string;
  trustedPath: string;
  gitExecutable: string;
  /** Injectable bounded subprocess runtime; default `DenoReplayRuntime`. */
  runtime?: ReplayRuntimeV1;
  /** Fixed self remote; overridden ONLY by tests with a fixture file:// URL. */
  remoteUrl?: string;
  /** Trusted API base for tests; production uses the public API. */
  apiBaseUrl?: string;
  /** THE same host port instance: authenticated readRef + create-only push. */
  port: Pick<GitHubPort, "readRef" | "pushHead">;
  /** Trusted configured protected paths (from the real repository config). */
  protectedPaths: readonly string[];
  /**
   * Trusted exact-object loader: ensure the exact candidate `head` exists in
   * the private source mirror, importing it from the exact task-mapped
   * producer checkout when needed. `not_found` is a proven absence;
   * transport/auth/read failures are `unavailable`.
   */
  ensureLocalCandidate(
    taskId: WorkItemId,
    head: GitSha,
  ): Promise<PortResultV1<void>>;
}

/** Safe exact candidate branch: prefixed, slash-separated, no forbidden refs. */
function isDurableCandidateBranch(branch: unknown): branch is string {
  if (
    typeof branch !== "string" || branch.length === 0 || branch.length > 256
  ) {
    return false;
  }
  if (!branch.startsWith(CANDIDATE_BRANCH_PREFIX)) return false;
  if (FORBIDDEN_BRANCH.test(branch)) return false;
  if (
    branch.includes("..") || branch.includes("@{") || branch.includes("//") ||
    branch.endsWith("/") || branch.endsWith(".") || branch.endsWith(".lock")
  ) {
    return false;
  }
  return branch.split("/").every((part) =>
    part.length > 0 && !part.startsWith(".") && !part.startsWith("-") &&
    !part.endsWith(".lock")
  );
}

/** Exact shape of one operation-bound preservation ref. */
function isPreservationRef(ref: unknown): ref is string {
  return typeof ref === "string" && PRESERVATION_REF_PATTERN.test(ref);
}

/** Exact self-scope repository identity shared by both hosted helpers. */
function isSelfRepository(repository: RepositoryIdentityV1): boolean {
  return repository.installationId === SELF_REPOSITORY.installationId &&
    repository.owner === SELF_REPOSITORY.owner &&
    repository.name === SELF_REPOSITORY.name;
}

/** Exact repository identity equality (owner/name/installation). */
function sameRepository(
  left: RepositoryIdentityV1,
  right: RepositoryIdentityV1,
): boolean {
  return left.installationId === right.installationId &&
    left.owner === right.owner && left.name === right.name;
}

/**
 * Exact persisted base-refresh recovery binding.
 *
 * After the prepared result was persisted, the push may or may not have
 * happened: the durable record still points at the OLD candidate while its
 * intent carries the exact deterministic `resultId` (the remote ref then
 * carries either the old candidate or that exact prepared commit). This
 * helper returns that exact commit ONLY when every old binding still matches
 * (branch, PR, expected head, non-null observed base and no request id), so a
 * remote head is accepted solely for that one exact persisted operation. The
 * durable record is never altered here, and the base-refresh adapter separately
 * recomputes the deterministic commit and requires equality with the persisted
 * result, so an unrelated head is never adopted.
 */
function baseRefreshRestoreTarget(record: WorkRecordV1): GitSha | null {
  const intent = record.intent;
  if (intent === null || intent.kind !== "base_refresh") return null;
  if (intent.resultId === null || !isGitSha(intent.resultId)) return null;
  if (intent.requestId !== null) return null;
  if (intent.branch === null || intent.pr === null) return null;
  if (record.target.branch === null || record.target.pr === null) return null;
  if (intent.branch !== record.target.branch) return null;
  if (intent.pr !== record.target.pr) return null;
  if (intent.expectedHead !== record.target.head) return null;
  if (intent.observedBase === null) return null;
  return intent.resultId;
}

/** One exact restore destination plus the SHA(s) it may legitimately carry. */
interface RestoreTargetV1 {
  ref: string;
  accepted: GitSha[];
}

/**
 * Recompute the exact operation/task/ref binding for one request pair.
 *
 * A record WITHOUT candidate state keeps the legacy task-branch restoration
 * (including the exact persisted base-refresh prepared commit). A record WITH
 * candidate state is restored ONLY through its operation-bound refs: the
 * retained original descriptor, a pending `candidate_preservation` intent ref
 * or a persisted `base_refresh` result ref. A missing/mismatched descriptor or
 * intent yields no target, so the caller can never fall back to a different
 * mutable PR/task head.
 */
async function restorableTargets(
  record: WorkRecordV1,
  base: GitSha,
  head: GitSha,
): Promise<RestoreTargetV1[]> {
  const candidateState = record.target.candidateState;
  const intent = record.intent;
  const newShape = candidateState !== undefined ||
    (intent !== null && intent.kind === "candidate_preservation");
  if (!newShape) {
    if (record.target.base !== base || record.target.head !== head) return [];
    if (!isDurableCandidateBranch(record.target.branch)) return [];
    const ref = `refs/heads/${record.target.branch}`;
    const accepted: GitSha[] = [head];
    const prepared = baseRefreshRestoreTarget(record);
    if (prepared !== null && prepared !== head) accepted.push(prepared);
    return [{ ref, accepted }];
  }
  const targets: RestoreTargetV1[] = [];
  const preserved = candidateState?.preserved ?? null;
  if (preserved !== null) {
    const expectedRef = await candidatePreservationRef(
      record.repository,
      record.id,
      preserved.operationKey,
    );
    if (
      expectedRef === preserved.ref && preserved.base === base &&
      preserved.head === head
    ) {
      targets.push({ ref: preserved.ref, accepted: [preserved.head] });
    }
  }
  if (intent !== null && intent.kind === "candidate_preservation") {
    if (
      isPreservationRef(intent.branch) && intent.expectedHead === head &&
      intent.observedBase === base
    ) {
      const expectedRef = await candidatePreservationRef(
        record.repository,
        record.id,
        intent.key,
      );
      if (expectedRef === intent.branch) {
        targets.push({ ref: intent.branch, accepted: [head] });
      }
    }
  }
  if (intent !== null && intent.kind === "base_refresh") {
    // The new-format shape must carry the SAME full binding the preserver
    // revalidates: exact PR/branch/old-head target, no request id, the
    // deterministic refresh key and the retained original descriptor whose
    // derived ref is the only accepted remote identity.
    const resultId = intent.resultId;
    const observedBase = intent.observedBase;
    const preserved = candidateState?.preserved ?? null;
    if (
      resultId !== null && isGitSha(resultId) &&
      observedBase !== null && observedBase === base && resultId === head &&
      intent.requestId === null &&
      intent.pr !== null && intent.branch !== null &&
      intent.pr === record.target.pr &&
      intent.branch === record.target.branch &&
      intent.expectedHead !== null &&
      intent.expectedHead === record.target.head &&
      intent.key ===
        baseRefreshIntentKey(intent.pr, intent.expectedHead, observedBase) &&
      preserved !== null && preserved.base === record.target.base &&
      preserved.head === record.target.head
    ) {
      const preservedRef = await candidatePreservationRef(
        record.repository,
        record.id,
        preserved.operationKey,
      );
      const ref = await candidatePreservationRef(
        record.repository,
        record.id,
        intent.key,
      );
      if (preservedRef === preserved.ref && isPreservationRef(ref)) {
        targets.push({ ref, accepted: [resultId] });
      }
    }
  }
  return targets;
}

export function createActionsCandidateRestorer(
  input: ActionsCandidateRestorerInputV1,
): ActionsCandidateRestorerV1 {
  const remoteUrl = input.remoteUrl ?? ACTIONS_CANDIDATES_REMOTE_URL;
  const runtime = input.runtime ?? new DenoReplayRuntime(input.trustedPath);
  const auth = {
    authorizationHeader: () => Promise.resolve(portOk(`Bearer ${input.token}`)),
  };
  let client: GitHubApiClient | null = null;
  const github = (): GitHubApiClient => {
    client ??= new GitHubApiClient({
      repository: { ...SELF_REPOSITORY },
      apiBaseUrl: input.apiBaseUrl ?? "https://api.github.com",
      http: input.http,
      auth,
      cooldownGate: input.gate,
      clock: input.clock,
    });
    return client;
  };

  const runGit = async (
    args: string[],
  ): Promise<{ code: number; stdout: string } | null> => {
    let result;
    try {
      result = await runtime.run({
        executable: input.gitExecutable,
        args: ["-c", "core.hooksPath=/dev/null", ...args],
        cwd: input.sourcePath,
        env: {
          PATH: input.trustedPath,
          HOME: input.scratch,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          ...githubGitAuthEnv(input.token),
        },
        maxDurationMs: GIT_TIMEOUT_MS,
        maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
      });
    } catch {
      return null;
    }
    // Only a normal, fully settled, untruncated exit yields a usable result.
    if (result.outcome !== "exited" || !result.settled || result.truncated) {
      return null;
    }
    return {
      code: result.exitCode ?? 1,
      stdout: new TextDecoder().decode(result.stdout),
    };
  };

  const hasCommit = async (sha: GitSha): Promise<boolean> => {
    const read = await runGit([
      "rev-parse",
      "--verify",
      "--quiet",
      `${sha}^{commit}`,
    ]);
    return read !== null && read.code === 0 && read.stdout.trim() === sha;
  };

  return {
    async ensure(value: ActionsCandidateRestoreRequestV1) {
      const base = value?.base;
      const head = value?.head;
      if (!isGitSha(base) || !isGitSha(head)) {
        return portError("invalid", STATIC_INPUT);
      }
      // Already available local immutable objects: no network, state or model.
      if (await hasCommit(base) && await hasCommit(head)) {
        return portOk(undefined);
      }
      // The exact durable nonterminal self binding; missing/ambiguous refuses.
      const targets: RestoreTargetV1[] = [];
      try {
        const read = await input.state.readRepair();
        if (!read.ok || read.value.status !== "found") {
          return portError("unavailable", STATIC_BINDING);
        }
        for (const work of read.value.snapshot.work) {
          if (
            !isSelfRepository(work.repository) || work.nextStep === "done"
          ) {
            continue;
          }
          targets.push(...await restorableTargets(work, base, head));
        }
      } catch {
        return portError("unavailable", STATIC_BINDING);
      }
      if (targets.length !== 1) {
        return portError("unavailable", STATIC_BINDING);
      }
      const target = targets[0]!;
      // Authenticated exact remote identity through the SAME client/gate path.
      // The remote is observed ONCE and the accepted identity is selected from
      // that observation: the exact operation-bound head, or — only for the
      // exact validated legacy base_refresh binding — the exact persisted
      // prepared result. Every other head refuses.
      const before = await github().readRef(target.ref);
      if (!before.ok) return before;
      if (before.value === null) {
        return portError("unavailable", STATIC_REMOTE);
      }
      if (!target.accepted.includes(before.value.sha)) {
        return portError("conflict", STATIC_REMOTE);
      }
      const restoreTarget = before.value.sha;
      // Durable cooldown immediately before the one authenticated fetch.
      let cooled: PortResultV1<void>;
      try {
        cooled = await input.gate.beforeRequest(
          SELF_REPOSITORY.installationId,
        );
      } catch {
        return portError("unavailable", STATIC_FETCH);
      }
      if (!cooled.ok) return portError("unavailable", STATIC_FETCH);
      // At most one exact fetch of the fixed remote and exact durable ref.
      const fetched = await runGit([
        "fetch",
        "--no-tags",
        remoteUrl,
        target.ref,
      ]);
      if (fetched === null || fetched.code !== 0) {
        return portError("unavailable", STATIC_FETCH);
      }
      const fetchedHead = await runGit([
        "rev-parse",
        "--verify",
        "--quiet",
        "FETCH_HEAD^{commit}",
      ]);
      if (
        fetchedHead === null || fetchedHead.code !== 0 ||
        fetchedHead.stdout.trim() !== restoreTarget
      ) {
        return portError("unavailable", STATIC_FETCH);
      }
      // The requested candidate/base objects must exist after the exact fetch
      // (a prepared refresh commit contains both the old head and the new base).
      if (!(await hasCommit(base)) || !(await hasCommit(head))) {
        return portError("unavailable", STATIC_FETCH);
      }
      // Re-read the authenticated remote after the fetch: drift refuses.
      const after = await github().readRef(target.ref);
      if (
        !after.ok || after.value === null ||
        after.value.sha !== restoreTarget
      ) {
        return portError("unavailable", STATIC_REMOTE);
      }
      return portOk(undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// Trusted candidate preservation (create-only operation-bound remote ref)
// ---------------------------------------------------------------------------

/** Bounded credential-scoped git run used ONLY by the fresh-store proof. */
type PreserverGitRunV1 = (
  cwd: string,
  args: string[],
  credentials: boolean,
) => Promise<PreserverGitResultV1 | null>;

/**
 * One bounded git result. `settled` is false exactly when the owned process
 * group could not be proved settled; `exited` is false for a spawn failure or
 * timeout. A runtime throw is reported as a null result and is treated as
 * unsettled by the proof.
 */
interface PreserverGitResultV1 {
  code: number;
  stdout: string;
  settled: boolean;
  truncated: boolean;
  exited: boolean;
}

/** Exact commit object state in one private object store. */
async function exactCommitAt(
  runGit: PreserverGitRunV1,
  cwd: string,
  sha: GitSha,
): Promise<boolean | null> {
  const read = await runGit(
    cwd,
    ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`],
    false,
  );
  if (read === null || !read.exited || !read.settled || read.truncated) {
    return null;
  }
  if (read.code === 1) return false;
  if (read.code !== 0) return null;
  return read.stdout.trim() === sha ? true : null;
}

/** True/false when proved; null when a stat failure makes the path unknown. */
async function pathPresent(path: string): Promise<boolean | null> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? false : null;
  }
}

/**
 * Trusted candidate preservation over the SAME host port instance.
 *
 * The exact durable binding is revalidated BEFORE any external read: exactly
 * one nonterminal self-scope record for the task, present candidate state whose
 * recorded published head equals the request, and one of the two exact
 * operation shapes — a pending `candidate_preservation` intent bound to a
 * genuine submitted implementation reservation, or a persisted `base_refresh`
 * result bound to its deterministic key and the retained original descriptor.
 *
 * Then, in one bounded sequence: read the exact operation ref (a different
 * existing SHA is a conflict; the exact existing SHA is reconciliation and is
 * never pushed again); if absent, ensure the candidate locally through the
 * trusted callback and run the trusted publication validator in the source
 * mirror BEFORE sending any object; create the ref only through the SAME port
 * `pushHead(ref, head, null)`, reconciling one ambiguous response with exactly
 * one authenticated reread; and finally prove durability by fetching only the
 * fixed remote and exact operation ref into a NEW empty bare object store,
 * verifying the exact head/base objects, ancestry and the absence of
 * shallow/replace/alternate masking, then re-validating publication in that
 * credential-free store and re-reading the authenticated ref. Only then is
 * success returned. No model, PR, task-branch, review or release effect exists
 * here.
 */
export function createCandidatePreserver(
  input: ActionsCandidatePreserverInputV1,
): GitHubPort["preserveCandidate"] {
  const remoteUrl = input.remoteUrl ?? ACTIONS_CANDIDATES_REMOTE_URL;
  const runtime = input.runtime ?? new DenoReplayRuntime(input.trustedPath);
  const runGit: PreserverGitRunV1 = async (cwd, args, credentials) => {
    let result;
    try {
      result = await runtime.run({
        executable: input.gitExecutable,
        args: ["-c", "core.hooksPath=/dev/null", ...args],
        cwd,
        env: {
          PATH: input.trustedPath,
          HOME: input.scratch,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          ...(credentials ? githubGitAuthEnv(input.token) : {}),
        },
        maxDurationMs: GIT_TIMEOUT_MS,
        maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
      });
    } catch {
      // A runtime throw leaves settlement unproven: it is carried as a null
      // (unsettled) result instead of being discarded as a plain failure.
      return null;
    }
    return {
      code: result.exitCode ?? 1,
      stdout: result.outcome === "exited"
        ? new TextDecoder().decode(result.stdout)
        : "",
      settled: result.settled,
      truncated: result.truncated,
      exited: result.outcome === "exited",
    };
  };
  // The validator is credential-free trusted code over the trusted source
  // mirror; it never inherits the fetch token.
  const validator = new GitReviewSnapshot({
    trustedPath: input.trustedPath,
    repositoryDir: input.sourcePath,
    gitExecutable: input.gitExecutable,
  });

  /**
   * Exact durable-binding resolution. Returns the exact preservation ref ONLY
   * for the two accepted shapes; every other state is unavailable.
   */
  const resolveRef = async (
    record: WorkRecordV1,
    reservations: readonly BudgetReservationV1[],
    candidate: CandidatePreservationV1,
    publishedHead: GitSha | null,
  ): Promise<PortResultV1<string>> => {
    const candidateState = record.target.candidateState;
    const intent = record.intent;
    if (candidateState === undefined || intent === null) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (candidateState.publishedHead !== publishedHead) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    let operationKey: string;
    if (intent.kind === "candidate_preservation") {
      // (a) A pending preservation intent: no preserved descriptor yet, the
      // descriptor describes exactly this target, and the producing
      // implementation reservation is a genuine submitted attempt.
      if (candidateState.preserved !== null) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      if (
        candidate.base !== record.target.base ||
        candidate.head !== record.target.head
      ) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      if (
        intent.expectedHead !== candidate.head ||
        intent.observedBase !== candidate.base
      ) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      if (
        intent.requestId === null ||
        intent.key !== implementationIntentKey(intent.requestId)
      ) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      if (candidate.operationKey !== intent.key) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      if (intent.branch !== candidate.ref) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      if (intent.pr !== null || intent.resultId !== null) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      const matching = reservations.filter((entry) =>
        entry.id === intent.requestId
      );
      if (matching.length !== 1) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      const reservation = matching[0]!;
      if (reservation.taskId !== record.id) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      if (!sameRepository(reservation.repository, record.repository)) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      if (reservation.outcome !== "submitted") {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      if (
        reservation.purpose !== "implementation" &&
        reservation.purpose !== "retry"
      ) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      if (reservation.head !== candidate.base) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      if (reservation.attempt !== record.counters.attempts) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      operationKey = intent.key;
    } else if (intent.kind === "base_refresh") {
      // (b) A persisted prepared result: the descriptor is the sealed refresh
      // commit, the intent still retains the old candidate binding, and the
      // recorded original descriptor is untouched.
      if (
        intent.resultId === null || !isGitSha(intent.resultId) ||
        candidate.head !== intent.resultId
      ) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      if (
        intent.observedBase === null ||
        candidate.base !== intent.observedBase
      ) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      if (candidate.operationKey !== intent.key) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      if (intent.requestId !== null) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      if (intent.pr === null || intent.branch === null) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      if (
        intent.pr !== record.target.pr || intent.branch !== record.target.branch
      ) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      if (
        intent.expectedHead === null ||
        intent.expectedHead !== record.target.head
      ) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      if (
        intent.key !== baseRefreshIntentKey(
          intent.pr,
          intent.expectedHead,
          intent.observedBase,
        )
      ) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      const preserved = candidateState.preserved;
      if (preserved === null) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      if (
        preserved.base !== record.target.base ||
        preserved.head !== record.target.head
      ) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      const preservedRef = await candidatePreservationRef(
        record.repository,
        record.id,
        preserved.operationKey,
      );
      if (preservedRef !== preserved.ref) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      operationKey = intent.key;
    } else {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    const ref = await candidatePreservationRef(
      record.repository,
      record.id,
      operationKey,
    );
    if (candidate.ref !== ref || !isPreservationRef(ref)) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    return portOk(ref);
  };

  return async (request: CandidatePreservationRequestV1) => {
    const taskId = request?.taskId;
    const candidate: CandidatePreservationV1 | undefined = request?.candidate;
    const publishedHead = request?.publishedHead ?? null;
    if (
      typeof taskId !== "string" || taskId.length === 0 ||
      candidate === undefined ||
      !isGitSha(candidate.base) || !isGitSha(candidate.head) ||
      typeof candidate.operationKey !== "string" ||
      candidate.operationKey.length === 0 ||
      !isPreservationRef(candidate.ref) ||
      (publishedHead !== null && !isGitSha(publishedHead))
    ) {
      return portError("invalid", STATIC_PRESERVE_INPUT);
    }
    // 1. Strict durable state binding BEFORE any external read.
    let record: WorkRecordV1 | null = null;
    let reservations: readonly BudgetReservationV1[] = [];
    try {
      const read = await input.state.readRepair();
      if (!read.ok || read.value.status !== "found") {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      const matches = read.value.snapshot.work.filter((work) =>
        isSelfRepository(work.repository) && work.id === taskId &&
        work.nextStep !== "done"
      );
      if (matches.length !== 1) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      record = matches[0]!;
      reservations = read.value.snapshot.reservations;
    } catch {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (record === null) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    const binding = await resolveRef(
      record,
      reservations,
      candidate,
      publishedHead,
    );
    if (!binding.ok) return binding;
    const ref = binding.value;
    // 2. Authenticated exact operation-ref read through the SAME port.
    const before = await input.port.readRef(ref);
    if (!before.ok) return before;
    if (before.value !== null && before.value.sha !== candidate.head) {
      return portError("conflict", STATIC_PRESERVE_CONFLICT);
    }
    // 3. Absent ref: trusted local objects + source-mirror publication
    //    validation BEFORE any object is sent, then one create-only push.
    if (before.value === null) {
      let ensured: PortResultV1<void>;
      try {
        ensured = await input.ensureLocalCandidate(taskId, candidate.head);
      } catch {
        return portError("unavailable", STATIC_PRESERVE_LOCAL);
      }
      if (!ensured.ok) return ensured;
      const validated = await validator.validatePublication({
        base: candidate.base,
        head: candidate.head,
        publishedHead,
        protectedPaths: input.protectedPaths,
      });
      if (!validated.ok) return validated;
      const pushed = await input.port.pushHead(ref, candidate.head, null);
      if (!pushed.ok) return pushed;
      if (pushed.value === "ambiguous") {
        // Exactly one authenticated reread; a lost response never repeats the
        // push and never claims an unconfirmed effect.
        const reread = await input.port.readRef(ref);
        if (!reread.ok) return reread;
        if (reread.value === null) {
          return portError("unavailable", STATIC_PRESERVE_PUSH);
        }
        if (reread.value.sha !== candidate.head) {
          return portError("conflict", STATIC_PRESERVE_CONFLICT);
        }
      }
    }
    // 4. Fresh empty object-store proof: only the fixed remote and the exact
    //    operation ref are fetched; the identities, ancestry and absence of
    //    shallow/replace/alternate masking are all verified, publication is
    //    re-validated credential-free in that store, and the authenticated ref
    //    is re-read afterwards.
    const proved = await freshStoreProof({
      runGit,
      gate: input.gate,
      remoteUrl,
      ref,
      candidate,
      publishedHead,
      protectedPaths: input.protectedPaths,
      trustedPath: input.trustedPath,
      gitExecutable: input.gitExecutable,
      scratch: input.scratch,
    });
    if (!proved.ok) return proved;
    const after = await input.port.readRef(ref);
    if (!after.ok) return after;
    if (after.value === null) {
      return portError("unavailable", STATIC_PRESERVE_REMOTE);
    }
    if (after.value.sha !== candidate.head) {
      return portError("conflict", STATIC_PRESERVE_CONFLICT);
    }
    return portOk(undefined);
  };
}

/**
 * One bounded fresh-store durability proof. A NEW empty bare object store is
 * created in owned private scratch; exactly the fixed remote and exact
 * operation ref are fetched with bounded credential-scoped Git; `FETCH_HEAD`
 * must equal the candidate head and the exact head/base commit objects and
 * ancestry must be present without shallow, replace or alternate masking. The
 * trusted excluded `publishedHead` is fetched only when it is genuinely
 * missing and its exact identity is then re-proved. Publication is revalidated
 * credential-free inside this store. The exact task-owned store is removed
 * after every child process has settled.
 */
async function freshStoreProof(input: {
  runGit: PreserverGitRunV1;
  gate: GitHubCooldownGateV1;
  remoteUrl: string;
  ref: string;
  candidate: CandidatePreservationV1;
  publishedHead: GitSha | null;
  protectedPaths: readonly string[];
  trustedPath: string;
  gitExecutable: string;
  scratch: string;
}): Promise<PortResultV1<void>> {
  const {
    runGit,
    gate,
    remoteUrl,
    ref,
    candidate,
    publishedHead,
    protectedPaths,
    trustedPath,
    gitExecutable,
    scratch,
  } = input;
  let store: string;
  try {
    store = await Deno.makeTempDir({
      dir: scratch,
      prefix: "sentinel-candidate-store-",
    });
  } catch {
    return portError("unavailable", STATIC_PRESERVE_PROOF);
  }
  // True when any child run could not be proved settled, or when the
  // validator failed without proving the settlement of its own processes: the
  // exact task-owned store is then preserved for diagnosis instead of removed.
  let uncertain = false;
  /**
   * Bounded run for this proof. Null is an unusable result: a runtime throw or
   * an unproved settlement is recorded as uncertainty; a spawn failure or a
   * truncation is a settled dead end.
   */
  const run: PreserverGitRunV1 = async (cwd, args, credentials) => {
    const result = await runGit(cwd, args, credentials);
    if (result === null || !result.settled) {
      uncertain = true;
      return null;
    }
    if (!result.exited || result.truncated) return null;
    return result;
  };
  try {
    const init = await run(store, ["init", "--bare", "-q"], false);
    if (init === null || init.code !== 0) {
      return portError("unavailable", STATIC_PRESERVE_PROOF);
    }
    // Durable cooldown immediately before the one credential-scoped fetch.
    let cooled: PortResultV1<void>;
    try {
      cooled = await gate.beforeRequest(SELF_REPOSITORY.installationId);
    } catch {
      return portError("unavailable", STATIC_PRESERVE_PROOF);
    }
    if (!cooled.ok) return cooled;
    const fetched = await run(
      store,
      ["fetch", "--no-tags", remoteUrl, ref],
      true,
    );
    if (fetched === null || fetched.code !== 0) {
      return portError("unavailable", STATIC_PRESERVE_PROOF);
    }
    const fetchedHead = await run(
      store,
      ["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"],
      false,
    );
    if (
      fetchedHead === null || fetchedHead.code !== 0 ||
      fetchedHead.stdout.trim() !== candidate.head
    ) {
      return portError("unavailable", STATIC_PRESERVE_PROOF);
    }
    // No shallow, replace-object or alternate masking may hide a different
    // object graph.
    const shallow = await run(
      store,
      ["rev-parse", "--is-shallow-repository"],
      false,
    );
    if (
      shallow === null || shallow.code !== 0 ||
      shallow.stdout.trim() !== "false"
    ) {
      return portError("unavailable", STATIC_PRESERVE_PROOF);
    }
    const replaced = await run(
      store,
      ["for-each-ref", "--format=%(refname)", "refs/replace"],
      false,
    );
    if (
      replaced === null || replaced.code !== 0 ||
      replaced.stdout.trim() !== ""
    ) {
      return portError("unavailable", STATIC_PRESERVE_PROOF);
    }
    // An unreadable alternates path is unknown availability, never absence.
    const alternates = await pathPresent(`${store}/objects/info/alternates`);
    if (alternates === null || alternates) {
      return portError("unavailable", STATIC_PRESERVE_PROOF);
    }
    const basePresent = await exactCommitAt(run, store, candidate.base);
    if (basePresent === null || !basePresent) {
      return portError("unavailable", STATIC_PRESERVE_PROOF);
    }
    // The exact excluded published head is fetched only when the candidate
    // fetch did not already carry it, and its recorded identity is re-proved.
    if (publishedHead !== null) {
      const publishedPresent = await exactCommitAt(run, store, publishedHead);
      if (publishedPresent === null) {
        return portError("unavailable", STATIC_PRESERVE_PROOF);
      }
      if (!publishedPresent) {
        // The second authenticated fetch needs its OWN durable cooldown
        // immediately before it; a refused or throwing gate performs no fetch.
        let secondCooled: PortResultV1<void>;
        try {
          secondCooled = await gate.beforeRequest(
            SELF_REPOSITORY.installationId,
          );
        } catch {
          return portError("unavailable", STATIC_PRESERVE_PROOF);
        }
        if (!secondCooled.ok) return secondCooled;
        const publishedFetch = await run(
          store,
          ["fetch", "--no-tags", remoteUrl, publishedHead],
          true,
        );
        if (publishedFetch === null || publishedFetch.code !== 0) {
          return portError("unavailable", STATIC_PRESERVE_PROOF);
        }
        const confirmed = await run(
          store,
          ["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"],
          false,
        );
        if (
          confirmed === null || confirmed.code !== 0 ||
          confirmed.stdout.trim() !== publishedHead
        ) {
          return portError("unavailable", STATIC_PRESERVE_PROOF);
        }
      }
    }
    const ancestry = await run(
      store,
      ["merge-base", "--is-ancestor", candidate.base, candidate.head],
      false,
    );
    if (ancestry === null || ancestry.code !== 0) {
      return portError("unavailable", STATIC_PRESERVE_PROOF);
    }
    // Credential-free revalidation inside the freshly fetched exact objects.
    const freshValidator = new GitReviewSnapshot({
      trustedPath,
      repositoryDir: store,
      gitExecutable,
    });
    // Its interface does not prove that the validator's own process group
    // settled, so uncertainty is raised BEFORE the call and cleared only by a
    // returned success; a thrown validation also keeps the owned store.
    uncertain = true;
    let validated: PortResultV1<void>;
    try {
      validated = await freshValidator.validatePublication({
        base: candidate.base,
        head: candidate.head,
        publishedHead,
        protectedPaths,
      });
    } catch {
      return portError("unavailable", STATIC_PRESERVE_PROOF);
    }
    if (!validated.ok) return validated;
    uncertain = false;
    return portOk(undefined);
  } finally {
    // Clean only the exact task-owned store after every child run settled;
    // an unproved settlement keeps the owned scratch intact.
    if (!uncertain) {
      await Deno.remove(store, { recursive: true }).catch(() => {});
    }
  }
}
