/**
 * Hosted candidate-object restorer.
 *
 * A fresh hosted Actions clone contains only the development history: a
 * durable candidate produced by an earlier run has no local objects, so a
 * resumed review snapshot or a later merge-ancestry check would fail against
 * an absent object. This helper lazily restores exactly the durable candidate
 * bound to an existing nonterminal scope-0 work record, immediately before the
 * snapshot capture, ancestry check, or correction checkout that needs it. For
 * one exact persisted `base_refresh` intent the durable record still points at
 * the OLD candidate: the remote ref must carry either that old candidate (the
 * prepared result was persisted before a push that never happened) or the
 * exact persisted intent result (the push succeeded but its state response was
 * lost). Exactly the observed commit is accepted, fetched and verified to
 * contain the requested old base/head objects. The durable record is never
 * altered. It performs at most
 * one exact fetch, never mutates work/budget state, never starts a model and
 * never runs before deterministic bookkeeping.
 */

import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import type {
  Clock,
  GitHubCooldownGateV1,
  PortResultV1,
  StateReadView,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { GitHubApiClient } from "../github/client.ts";
import type { HttpTransportV1 } from "../github/http.ts";
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
// Git refs must reject control characters, so the control range is intentional.
// deno-lint-ignore no-control-regex
const FORBIDDEN_BRANCH = /[\u0000-\u001f\u007f ~^:?*\\\[\]]/;

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
      let record: WorkRecordV1;
      try {
        const read = await input.state.readRepair();
        if (!read.ok || read.value.status !== "found") {
          return portError("unavailable", STATIC_BINDING);
        }
        const matches = read.value.snapshot.work.filter((work) =>
          work.repository.installationId === 0 &&
          work.repository.owner === "ubiquity" &&
          work.repository.name === "sentinel" &&
          work.nextStep !== "done" &&
          work.target.base === base &&
          work.target.head === head &&
          isDurableCandidateBranch(work.target.branch)
        );
        if (matches.length !== 1) {
          return portError("unavailable", STATIC_BINDING);
        }
        record = matches[0]!;
      } catch {
        return portError("unavailable", STATIC_BINDING);
      }
      const branch = record.target.branch!;
      const ref = `refs/heads/${branch}`;
      const preparedTarget = baseRefreshRestoreTarget(record);
      // Authenticated exact remote identity through the SAME client/gate path.
      // The remote is observed ONCE and the accepted identity is selected from
      // that observation: the durable candidate head, or — only for the exact
      // validated base_refresh binding — the exact persisted prepared result.
      // A crash after the prepared result was persisted but BEFORE any push
      // leaves the OLD head on the ref (equally recoverable); a successful push
      // with a lost state response leaves the exact prepared result. Every
      // other head refuses.
      const before = await github().readRef(ref);
      if (!before.ok || before.value === null) {
        return portError("unavailable", STATIC_REMOTE);
      }
      const restoreTarget = before.value.sha === head
        ? head
        : preparedTarget !== null && before.value.sha === preparedTarget
        ? preparedTarget
        : null;
      if (restoreTarget === null) {
        return portError("unavailable", STATIC_REMOTE);
      }
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
      const fetched = await runGit(["fetch", "--no-tags", remoteUrl, ref]);
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
      // The requested old candidate parents must exist after the exact fetch
      // (the prepared commit contains both the old head and the new base).
      if (!(await hasCommit(base)) || !(await hasCommit(head))) {
        return portError("unavailable", STATIC_FETCH);
      }
      // Re-read the authenticated remote after the fetch: drift refuses.
      const after = await github().readRef(ref);
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
