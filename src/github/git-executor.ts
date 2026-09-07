/**
 * Trusted bounded Git executor for `pushHead` and merge ancestry checks.
 *
 * The executor is a narrow transport: it knows how to observe one remote ref,
 * test ancestry in the trusted local object store and perform an ordinary
 * (never forced) push of an exact local commit. Product logic — expected-ref
 * compare-and-swap, fast-forward validation, conflict classification — lives
 * in the GitHubPort implementation, never here.
 *
 * Exact-ref publication: `push` carries the expected advertised ref value
 * (null when the ref must be absent) through the executor interface and
 * enforces it inside the push transaction. A trusted temporary pre-push hook
 * (selected process-locally via `-c core.hooksPath`, never stored in the
 * candidate/repository config, never a ForceWithLease) validates the sole
 * exact destination, the new SHA and the advertised old value (all-zeros for
 * expected absence), then Git receive-pack enforces that advertised old value
 * atomically. The hook is fixed trusted code with exact validated data, lives
 * outside the model checkout, and is removed after the process settles. If
 * the guard cannot be established or its run cannot be confirmed, the push
 * fails closed (no "applied" claim).
 *
 * Process lifetime: every git run is bounded by a finite deadline and output
 * cap; an expired or over-limit run is TERM'd then KILL'd, its stream readers
 * are canceled with rejection handlers and the exit status is settled, so
 * descendants that keep pipes open after the direct parent exits cannot hang
 * the caller. Each child is spawned as the leader of its own process group
 * (`detached`), so the trusted settle signals the whole group — descendants
 * that ignore TERM are KILL'd, not orphaned. Group signaling is best-effort:
 * when the harness denies `Deno.kill` (full `--allow-run` is required for it)
 * the settle falls back to the direct child, which is still bounded and
 * cannot hang the caller.
 *
 * Credential discipline: no credential is ever placed in argv or the remote
 * config by this module. The production `DenoGitExecutor` runs git with a
 * clean environment (only PATH, a scratch HOME, explicit config isolation and
 * `GIT_TERMINAL_PROMPT=0`); the trusted host may additionally inject
 * `extraEnv` (for example `GIT_CONFIG_COUNT`-style low-level transport
 * settings) which is inherited by exactly the git child and never logged or
 * embedded in a request. `DenoGitExecutor` never prints, stores or returns
 * the remote URL or environment.
 *
 * Spawn discipline: `Deno.Command` with `clearEnv: true` binds the child
 * environment to the explicit map above, so nothing inherited — including
 * `NODE_V8_COVERAGE` — reaches the child. No node-compatible spawn is used by
 * this module; the git binary is executed directly.
 */

import type { GitSha } from "../contracts/brands.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import { createDeadline } from "./http.ts";

export type GitPushStatusV1 =
  | "applied"
  | "ambiguous"
  | "non_fast_forward"
  | "missing_object"
  | "rejected";

export interface GitPushResultV1 {
  status: GitPushStatusV1;
}

export interface GitExecutorV1 {
  /**
   * Current exact identity of the remote ref, or null when it does not exist.
   * A malformed/duplicate remote response is `invalid`, never "absent".
   */
  readRemoteRef(ref: string): Promise<PortResultV1<GitSha | null>>;
  /**
   * True exactly when `ancestor` is an ancestor of `descendant` in the
   * trusted local object store. Unknown objects are a `unavailable` failure
   * (the executor cannot prove either answer), never a false result.
   */
  isAncestor(
    ancestor: GitSha,
    descendant: GitSha,
  ): Promise<PortResultV1<boolean>>;
  /**
   * Ordinary non-force push of the exact local candidate to the remote ref,
   * atomically guarded against the expected advertised ref value (null means
   * the ref must currently be absent). A response lost after the side effect
   * is `ambiguous`; a non-fast-forward remote rejection is
   * `non_fast_forward`; an unknown local object is `missing_object`; every
   * other remote rejection (including the guard rejecting a moved upstream)
   * is `rejected`.
   */
  push(
    ref: string,
    sha: GitSha,
    expectedRef: GitSha | null,
  ): Promise<PortResultV1<GitPushResultV1>>;
}

// ---------------------------------------------------------------------------
// Production executor over the `git` CLI
// ---------------------------------------------------------------------------

export interface GitRunResultV1 {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  /** True when the run was aborted by the finite deadline. */
  timeout?: boolean;
  /** True when the run exceeded the finite output byte bound. */
  overflow?: boolean;
}

export interface DenoGitExecutorOptions {
  /** Local repo containing the trusted candidate objects. */
  localDir: string;
  /** Remote URL (no credential embedded; auth is env-injected by the host). */
  remoteUrl: string;
  /** Scratch HOME for git children; defaults to `localDir`. */
  gitHome?: string;
  /**
   * Environment additions for exactly the git children (e.g. low-level
   * credential transport settings). They are never logged or returned.
   */
  extraEnv?: Readonly<Record<string, string>>;
  /** Git binary path (default `git`); injectable for bounded fake processes. */
  gitPath?: string;
  /** Finite whole-run deadline (default 120s). */
  timeoutMs?: number;
  /** Finite output byte bound on each stream (default 256 KiB). */
  maxOutputBytes?: number;
  /**
   * Test-only trusted hook augmentation appended after the exact-ref guard
   * (used to simulate a ref movement after guard validation; production
   * callers leave it empty).
   */
  prePushHookExtra?: string;
}

/** Finite default deadline for one git child run. */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;
/** Finite default byte bound on one git stream. */
export const DEFAULT_GIT_MAX_OUTPUT_BYTES = 256 * 1024;
/** TERM grace before KILL when settling a git child. */
const GIT_TERM_GRACE_MS = 500;
/** Hard bound on waiting for the child status after KILL. */
const GIT_KILL_SETTLE_MS = 1_000;

const SHA_RE = /^[0-9a-f]{40}$/;
const ZERO_SHA = "0000000000000000000000000000000000000000";
const GUARD_MARKER = "sentinel-git-hook-reject";

export class DenoGitExecutor implements GitExecutorV1 {
  private readonly gitHome: string;
  private readonly extraEnv: Readonly<Record<string, string>>;
  private readonly gitPath: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly prePushHookExtra: string;

  constructor(private readonly options: DenoGitExecutorOptions) {
    if (typeof options.localDir !== "string" || options.localDir.length === 0) {
      throw new TypeError("localDir is required");
    }
    if (
      typeof options.remoteUrl !== "string" || options.remoteUrl.length === 0
    ) {
      throw new TypeError("remoteUrl is required");
    }
    this.gitHome = options.gitHome ?? options.localDir;
    this.extraEnv = options.extraEnv ?? {};
    this.gitPath = options.gitPath ?? "git";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ??
      DEFAULT_GIT_MAX_OUTPUT_BYTES;
    this.prePushHookExtra = options.prePushHookExtra ?? "";
    if (
      !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1
    ) {
      throw new TypeError("timeoutMs must be a positive integer");
    }
    if (
      !Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < 1
    ) {
      throw new TypeError("maxOutputBytes must be a positive integer");
    }
    if (typeof this.prePushHookExtra !== "string") {
      throw new TypeError("prePushHookExtra must be a string");
    }
  }

  async readRemoteRef(ref: string): Promise<PortResultV1<GitSha | null>> {
    const fullRef = fullRefOf(ref);
    if (!isValidRef(fullRef)) {
      return portError("invalid", "remote ref is invalid");
    }
    const result = await this.runGit([
      "ls-remote",
      this.options.remoteUrl,
      fullRef,
    ], null);
    if (!result.ok) {
      return portError("unavailable", "remote ref read failed");
    }
    const lines = result.stdout
      .split("\n")
      .filter((line) => line.length > 0);
    if (lines.length === 0) return portOk(null);
    const shas: string[] = [];
    for (const line of lines) {
      const tab = line.indexOf("\t");
      const sha = tab === -1 ? "" : line.slice(0, tab);
      const name = tab === -1 ? "" : line.slice(tab + 1);
      if (!SHA_RE.test(sha) || name !== fullRef) {
        return portError("invalid", "remote ref response is malformed");
      }
      shas.push(sha);
    }
    if (shas.length !== 1) {
      return portError("invalid", "remote ref response is ambiguous");
    }
    return portOk(shas[0] as GitSha);
  }

  async isAncestor(
    ancestor: GitSha,
    descendant: GitSha,
  ): Promise<PortResultV1<boolean>> {
    const result = await this.runGit([
      "merge-base",
      "--is-ancestor",
      ancestor,
      descendant,
    ], null);
    if (result.ok) return portOk(true);
    if (result.code === 1) return portOk(false);
    return portError("unavailable", "ancestry check failed");
  }

  async push(
    ref: string,
    sha: GitSha,
    expectedRef: GitSha | null,
  ): Promise<PortResultV1<GitPushResultV1>> {
    if (!SHA_RE.test(sha)) {
      return portError("invalid", "push requires an exact commit sha");
    }
    if (expectedRef !== null && !SHA_RE.test(expectedRef)) {
      return portError("invalid", "push requires an exact expected ref");
    }
    const fullRef = fullRefOf(ref);
    if (!isValidRef(fullRef)) {
      return portError("invalid", "push requires a valid destination ref");
    }
    // Fail closed: the exact-ref guard must be established before anything
    // is sent to the remote. The hook lives outside the model checkout.
    let hooksDir: string | null = null;
    const ranMarker = `sentinel-git-hook-ran ${sha} ${fullRef} ${
      expectedRef ?? ZERO_SHA
    }`;
    try {
      hooksDir = await Deno.makeTempDir({ prefix: "sentinel-git-hooks-" });
      await Deno.writeTextFile(
        `${hooksDir}/pre-push`,
        prePushHookScript({
          fullRef,
          sha,
          expectedOld: expectedRef ?? ZERO_SHA,
          ranMarker,
          extra: this.prePushHookExtra,
        }),
      );
      await Deno.chmod(`${hooksDir}/pre-push`, 0o700);
    } catch {
      return portError("unavailable", "push guard could not be established");
    }
    try {
      const result = await this.runGit([
        "push",
        this.options.remoteUrl,
        `${sha}:${fullRef}`,
      ], hooksDir);
      if (!result.ok) {
        if (result.timeout === true || result.overflow === true) {
          // The push may have reached the remote: the effect is unconfirmed.
          return portOk({ status: "ambiguous" });
        }
        if (result.code === 1) {
          const text = `${result.stdout}\n${result.stderr}`;
          if (text.includes(GUARD_MARKER)) {
            // The exact-ref guard rejected the transaction: a definitive
            // conflict (nothing was written).
            return portOk({ status: "rejected" });
          }
          if (
            /non-fast-forward|fetch first|rejected|needs fast-forward/i.test(
              text,
            )
          ) {
            return portOk({ status: "non_fast_forward" });
          }
          if (
            /does not match|unknown revision|not exist|not found|not a valid object/i
              .test(text)
          ) {
            return portOk({ status: "missing_object" });
          }
          if (
            /could not read from remote|unable to access|connection/i.test(
              text,
            )
          ) {
            // The push may have reached the remote: unconfirmed.
            return portOk({ status: "ambiguous" });
          }
          return portOk({ status: "rejected" });
        }
        // A child failure with no definitive rejection (spawn/response lost)
        // means the effect is unknown — the authoritative ref decides.
        return portOk({ status: "ambiguous" });
      }
      // The push succeeded: confirmation that the guard actually ran is part
      // of the trust contract (observed on the captured stream, since a
      // child-written file is not reliably observable). Without it the
      // protection is not established and nothing may be reported applied.
      if (!`${result.stdout}\n${result.stderr}`.includes(ranMarker)) {
        return portOk({ status: "ambiguous" });
      }
      return portOk({ status: "applied" });
    } finally {
      // Remove only the owned temporary hook files; RUN has already settled
      // the process tree except on an internal throw (unlink is safe on a
      // live directory, and a leak must never block the caller).
      if (hooksDir !== null) {
        await Deno.remove(hooksDir, { recursive: true }).catch(() => {});
      }
    }
  }

  private async runGit(
    args: string[],
    hooksDir: string | null,
  ): Promise<GitRunResultV1> {
    const path = Deno.env.get("PATH") ?? "/usr/bin:/bin";
    const commandArgs = hooksDir === null
      ? args
      : ["-c", `core.hooksPath=${hooksDir}`, ...args];
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command(this.gitPath, {
        args: commandArgs,
        cwd: this.options.localDir,
        clearEnv: true,
        env: {
          PATH: path,
          HOME: this.gitHome,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          ...this.extraEnv,
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        // Owned process group: the child becomes a session/group leader
        // (Detached) so the trusted settle below can TERM then KILL the whole
        // group, not only the direct parent. Every child is either awaited to
        // completion in the bounded paths or signaled by that settle, so a
        // detached run cannot outlive its operation.
        detached: true,
      }).spawn();
    } catch {
      return { ok: false, code: -1, stdout: "", stderr: "" };
    }
    const stdout = child.stdout.getReader();
    const stderr = child.stderr.getReader();
    const deadline = createDeadline(this.timeoutMs);
    const streams = (async (): Promise<{
      stdout: string;
      stderr: string;
      overflow: boolean;
    }> => {
      const out = await readStreamBounded(
        stdout,
        this.maxOutputBytes,
        deadline,
      );
      const err = await readStreamBounded(
        stderr,
        this.maxOutputBytes,
        deadline,
      );
      return {
        stdout: out.text,
        stderr: err.text,
        overflow: out.overflow || err.overflow,
      };
    })();
    // The streams may settle after the deadline fired or the readers were
    // canceled; they must never surface as an unhandled rejection.
    streams.catch(() => {});
    const status: Promise<Deno.CommandStatus> = child.status;
    status.catch(() => {});
    const never = new Promise<never>(() => {});
    let outcome:
      | {
        kind: "streams";
        value: { stdout: string; stderr: string; overflow: boolean };
      }
      | { kind: "timeout" }
      | { kind: "status-error" };
    try {
      outcome = await Promise.race([
        streams.then((value) => ({ kind: "streams" as const, value })),
        deadline.race(never).then(() => ({ kind: "timeout" as const })),
      ]);
    } catch {
      outcome = { kind: "status-error" };
    }
    const cancelReaders = (): void => {
      void stdout.cancel().catch(() => {});
      void stderr.cancel().catch(() => {});
    };
    const settle: Promise<Deno.CommandStatus | null> = (async () => {
      try {
        return await status;
      } catch {
        return null;
      }
    })();
    const partial = outcome.kind === "streams"
      ? outcome.value
      : { stdout: "", stderr: "", overflow: false };
    if (outcome.kind === "streams" && !outcome.value.overflow) {
      // Streams closed normally; the child must exit. The deadline still
      // bounds the wait (a run that never exits after closing its streams
      // would otherwise hang the caller).
      let childStatus: Deno.CommandStatus | null;
      try {
        childStatus = await deadline.race(
          settle as Promise<Deno.CommandStatus>,
        );
      } catch {
        cancelReaders();
        await terminateChild(child);
        return {
          ok: false,
          code: -1,
          stdout: partial.stdout,
          stderr: partial.stderr,
          timeout: true,
        };
      }
      if (childStatus === null) {
        return {
          ok: false,
          code: -1,
          stdout: partial.stdout,
          stderr: partial.stderr,
          timeout: true,
        };
      }
      return {
        ok: childStatus.success,
        code: childStatus.code,
        stdout: partial.stdout,
        stderr: partial.stderr,
      };
    }
    // Deadline expired, output over-limit or a stream failed: settle the child
    // (TERM then KILL, bounded status wait), cancel the pipes so descendants
    // that keep them open cannot hang the caller, and report a bounded
    // failure. The effect of a push at this point is unknown.
    cancelReaders();
    await terminateChild(child);
    return {
      ok: false,
      code: -1,
      stdout: partial.stdout,
      stderr: partial.stderr,
      ...(outcome.kind === "streams" && outcome.value.overflow
        ? { overflow: true }
        : { timeout: true }),
    };
  }
}

/** Read one stream up to `maxBytes`; over-limit completes with overflow. */
async function readStreamBounded(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
  deadline: ReturnType<typeof createDeadline>,
): Promise<{ text: string; overflow: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let step: ReadableStreamReadResult<Uint8Array>;
    try {
      step = await deadline.race(reader.read());
    } catch {
      // deadline fired or the reader was canceled after termination.
      throw new Error("stream read aborted");
    }
    if (step.done) break;
    total += step.value.byteLength;
    if (total > maxBytes) {
      return { text: "", overflow: true };
    }
    chunks.push(step.value);
  }
  if (chunks.length === 0) return { text: "", overflow: false };
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), overflow: false };
}

/**
 * TERM then KILL the whole owned process group; the caller abandons pipes.
 * When the harness does not grant group signaling (Deno.kill needs full
 * `--allow-run`), fall back to the direct child, keeping the same bounded
 * settle so nothing can hang the caller.
 */
async function terminateChild(child: Deno.ChildProcess): Promise<void> {
  signalGroup(child, "SIGTERM");
  await boundedChildStatus(child, GIT_TERM_GRACE_MS);
  signalGroup(child, "SIGKILL");
  await boundedChildStatus(child, GIT_KILL_SETTLE_MS);
}

function signalGroup(child: Deno.ChildProcess, signo: Deno.Signal): void {
  try {
    // Negative pid: the owned process group of the detached child, including
    // descendants that keep the pipes open after the direct parent exits.
    Deno.kill(-child.pid, signo);
    return;
  } catch {
    // The group is already gone (ESRCH) or group signaling is not granted
    // (NotCapable): fall through to the direct child handle.
  }
  try {
    child.kill(signo);
  } catch {
    // Already exited.
  }
}

async function boundedChildStatus(
  child: Deno.ChildProcess,
  ms: number,
): Promise<void> {
  const deadline = createDeadline(ms);
  try {
    await deadline.race(child.status as Promise<Deno.CommandStatus>);
  } catch {
    // The child did not exit within the grace: KILL is next or already sent.
  } finally {
    deadline.dispose();
  }
}

/**
 * Fixed trusted pre-push hook with the exact validated destination, candidate
 * SHA and advertised old value (all-zeros for expected absence). It rejects
 * when the pushed ref set is not exactly the expected single ref, and echoes
 * an exact run marker on stderr so the executor can positively confirm the
 * guard ran.
 */
function prePushHookScript(input: {
  fullRef: string;
  sha: string;
  expectedOld: string;
  ranMarker: string;
  extra: string;
}): string {
  const lines = [
    "#!/bin/sh",
    "set -eu",
    "count=0",
    "while IFS= read -r line; do",
    "  count=$((count + 1))",
    "  [ \"$count\" -le 1 ] || { echo 'sentinel-git-hook-reject: expected exactly one ref' >&2; exit 1; }",
    "  set -- ${line}",
    "  [ \"$#\" -eq 4 ] || { echo 'sentinel-git-hook-reject: malformed ref line' >&2; exit 1; }",
    `  [ "$2" = '${input.sha}' ] || { echo 'sentinel-git-hook-reject: candidate mismatch' >&2; exit 1; }`,
    `  [ "$3" = '${input.fullRef}' ] || { echo 'sentinel-git-hook-reject: destination mismatch' >&2; exit 1; }`,
    `  [ "$4" = '${input.expectedOld}' ] || { echo 'sentinel-git-hook-reject: expected-ref mismatch' >&2; exit 1; }`,
    "done",
    "[ \"$count\" -eq 1 ] || { echo 'sentinel-git-hook-reject: expected exactly one ref' >&2; exit 1; }",
    `echo '${input.ranMarker}' >&2`,
  ];
  if (input.extra.length > 0) lines.push(input.extra);
  return `${lines.join("\n")}\n`;
}

/** Accept `heads/x`, `refs/heads/x`; return the canonical full ref. */
export function fullRefOf(ref: string): string {
  return ref.startsWith("refs/") ? ref : `refs/${ref}`;
}

function isValidRef(ref: string): boolean {
  if (!ref.startsWith("refs/")) return false;
  const parts = ref.slice("refs/".length).split("/");
  for (const part of parts) {
    if (part.length === 0) return false;
    if (/^\.|\.$|\.\./.test(part)) return false;
    if (!/^[A-Za-z0-9._-]+$/.test(part)) return false;
  }
  return true;
}
