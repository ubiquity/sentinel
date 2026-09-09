/**
 * Replay process runtime (m03-owned).
 *
 * The runtime is the injection border for replay children: the production
 * implementation is DenoReplayRuntime — Deno's `node:child_process` spawn
 * with `detached: true` on POSIX, so the spawned command is the leader of
 * its OWN process group (child pid equals the process group id, verified
 * locally under installed Deno). The runtime records that one group id and
 * signals only it; the recorded owned group is how `maxDurationMs` is
 * enforced across the whole subprocess + captured-stream lifetime:
 *
 *   - Direct-parent exit is NOT completion. The run stays open while a
 *     descendant still holds the captured pipes (the parent may be long
 *     gone) or remains a member of the owned group, and the deadline keeps
 *     ticking until every captured stream has settled and the owned group is
 *     provably empty.
 *   - At the deadline the OWNED group is SIGTERMed; a bounded grace later a
 *     lingering (TERM-ignoring) member is SIGKILLed; the runtime then awaits
 *     close (reaping) plus stream settlement and verifies the group is empty
 *     (`kill(-pgid, 0)` -> ESRCH). A run never reports `exited` while an
 *     owned descendant or a timer remains: timeout/uncertain cleanup is
 *     `timed_out` with `settled: false` so the port returns unavailable and
 *     preserves its scratch for inspection.
 *   - A leftover owned descendant that closed its pipes but kept running is
 *     terminated at completion (the same bounded TERM-to-KILL sequence), so
 *     no owned descendant outlives a run.
 *   - Unsupported platforms are rejected before any execution.
 *
 * Trust boundary: an owned process group is an ownership/lifetime boundary,
 * NOT an OS security sandbox against deliberately escaping target code — a
 * target test program can still read workstation files even though the
 * environment is complete-only (no inherited host variables). The ReplayPort
 * therefore still refuses to run target-controlled commands unless the
 * caller injected a trusted restricted-host attestation (see port.ts).
 *
 * Deno/node-compat notes (verified on Deno 2.9.6 / macOS):
 *   - The child receives exactly the provided env; the node compatibility
 *     layer additionally copies the host's `NODE_V8_COVERAGE` entry unless
 *     the provided env already defines it, so this runtime always defines it
 *     (empty) to keep the child environment complete and credential-free.
 *   - Group signaling requires full `--allow-run` and the node layer reads
 *     the host `NODE_V8_COVERAGE` (so the matching env grant is needed even
 *     when the variable is unset); the harness wiring must grant both.
 *
 * Bounded streaming: both captured streams are drained concurrently to EOF
 * (never a deadlock on a full pipe) while only the first `maxOutputBytes`
 * combined are retained; excess bytes are discarded and flagged. The
 * retained prefix is what the digests cover; truncation is reported.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { kill } from "node:process";

export interface ReplayCommandInputV1 {
  /** Executable name or absolute path (argv element 0, never a shell string). */
  executable: string;
  /** Exact argv elements; no shell is ever involved. */
  args: string[];
  cwd: string;
  /** Complete child environment (the runtime clears everything else). */
  env: Readonly<Record<string, string>>;
  /** Wall-clock bound over the whole subprocess + captured-stream lifetime. */
  maxDurationMs: number;
  /** Combined retained byte bound (stdout + stderr); beyond this bytes are discarded. */
  maxOutputBytes: number;
}

export type ReplayCommandOutcomeV1 = "exited" | "spawn_failed" | "timed_out";

export interface ReplayCommandResultV1 {
  outcome: ReplayCommandOutcomeV1;
  /**
   * Null for spawn_failed/timed_out. For a run that exits normally this is
   * the child exit code; on signal death the code is 128 + signal.
   */
  exitCode: number | null;
  /** Retained prefix of stdout (empty for spawn_failed). */
  stdout: Uint8Array;
  /** Retained prefix of stderr (empty for spawn_failed). */
  stderr: Uint8Array;
  /** True when either stream produced more bytes than its retained bound. */
  truncated: boolean;
  /**
   * True when the OWNED process group is provably empty at completion (no
   * owned descendant and no in-flight signal/timer remains). False means the
   * run could not be proved settled and callers must treat it as uncertain
   * cleanup (unavailable, scratch preserved). spawn_failed/unsupported are
   * always settled: nothing was spawned.
   */
  settled: boolean;
  /** Bounded diagnostic text; never raw child output. */
  detail: string;
}

export interface ReplayRuntimeV1 {
  run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1>;
}

const TERM_GRACE_MS = 250;
const GROUP_POLL_MS = 25;
const STREAM_MARGIN_MS = 500;

/** POSIX platforms where a detached child leads its own signalable group. */
const SUPPORTED_POSIX_OS = new Set([
  "aix",
  "darwin",
  "freebsd",
  "illumos",
  "linux",
  "netbsd",
  "openbsd",
  "solaris",
]);

/** Signal -> conventional exit code (128 + signal), for signal deaths. */
const SIGNAL_EXIT_CODE: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGSTKFLT: 16,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGURG: 23,
  SIGXCPU: 24,
  SIGXFSZ: 25,
  SIGVTALRM: 26,
  SIGPROF: 27,
  SIGWINCH: 28,
  SIGIO: 29,
  SIGPWR: 30,
  SIGSYS: 31,
};

export interface DenoReplayRuntimeOptions {
  /** Platform override for deterministic tests; defaults to Deno.build.os. */
  osName?: string;
}

/**
 * Production Deno subprocess runtime: owned process group (POSIX), complete
 * child environment, bounded combined output and a deadline that spans the
 * full subprocess + captured-stream lifetime.
 */
export class DenoReplayRuntime implements ReplayRuntimeV1 {
  private readonly osName: string;
  private ownedGroupId: number | null = null;

  constructor(
    private readonly spawnPath: string,
    options: DenoReplayRuntimeOptions = {},
  ) {
    this.osName = options.osName ?? Deno.build.os;
  }

  /**
   * Process group id of the most recent run (diagnostic/test proof that no
   * owned descendant remains); null when the last run never spawned.
   */
  lastOwnedGroupId(): number | null {
    return this.ownedGroupId;
  }

  async run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
    if (!SUPPORTED_POSIX_OS.has(this.osName)) {
      this.ownedGroupId = null;
      return {
        outcome: "spawn_failed",
        exitCode: null,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        truncated: false,
        settled: true,
        detail: `unsupported platform for the owned process-group runtime: ` +
          `${this.osName} (supported POSIX platforms only)`,
      };
    }

    let child: ChildProcess;
    try {
      child = spawn(input.executable, input.args, {
        cwd: input.cwd,
        // Owned process group: the child is the group leader (pid == pgid),
        // so signaling -pid reaches exactly this run's descendants and
        // nothing else. Never signal a non-recorded pid.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...input.env, NODE_V8_COVERAGE: "" },
      });
    } catch (error) {
      this.ownedGroupId = null;
      return {
        outcome: "spawn_failed",
        exitCode: null,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        truncated: false,
        settled: true,
        detail: `could not spawn ${input.executable}: ${describeThrow(error)}`,
      };
    }

    const groupId = child.pid ?? null;
    this.ownedGroupId = groupId;

    // Consume the first terminal event BEFORE any early return: an unhandled
    // node 'error' event (e.g. ENOENT for a missing executable) would
    // otherwise become an uncaught exception in the host process.
    const firstEvent = new Promise<
      | { kind: "error"; error: unknown }
      | { kind: "close"; code: number | null; signal: string | null }
    >((resolve) => {
      child.once("error", (error) => resolve({ kind: "error", error }));
      child.once(
        "close",
        (code, signal) => resolve({ kind: "close", code, signal }),
      );
    });

    if (groupId === null) {
      // The spawn failed asynchronously (missing executable, permission
      // denied): no group was created, nothing was signaled or left behind.
      destroyStreams(child);
      const event = await within(firstEvent, STREAM_MARGIN_MS);
      return {
        outcome: "spawn_failed",
        exitCode: null,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        truncated: false,
        settled: true,
        detail: `could not spawn ${input.executable}: ` +
          (event?.kind === "error"
            ? describeThrow(event.error)
            : "no pid was recorded"),
      };
    }

    let closeCode: number | null = null;
    let closeSignal: string | null = null;
    let spawnError: unknown = null;
    const closed = firstEvent.then((event) => {
      if (event.kind === "error") {
        spawnError = event.error;
      } else {
        closeCode = event.code;
        closeSignal = event.signal;
      }
    });

    const collector = new BoundedCollector(input.maxOutputBytes);
    const streamsDone = Promise.allSettled([
      collector.collect(child.stdout, "stdout"),
      collector.collect(child.stderr, "stderr"),
    ]);

    let timedOut = false;
    let termination: Promise<"empty" | "uncertain"> | null = null;
    let signalDeadline: (() => void) | null = null;
    const deadline = new Promise<void>((resolve) => {
      signalDeadline = resolve;
    });
    const killTimer = setTimeout(() => {
      timedOut = true;
      signalDeadline?.();
      if (termination === null) {
        termination = terminateOwnedGroup(groupId);
      }
    }, input.maxDurationMs);

    let state: "closed" | "uncertain" = "uncertain";
    try {
      state = await new Promise<"closed" | "uncertain">((resolve) => {
        let done = false;
        const settle = (value: "closed" | "uncertain") => {
          if (!done) {
            done = true;
            resolve(value);
          }
        };
        closed.then(() => {
          if (spawnError !== null) {
            // Nothing ran; the spawn failure path below reports it. No owned
            // group exists.
            settle("closed");
            return;
          }
          // Close means both the direct child reaped AND the captured pipes
          // reached EOF. If the owned group still has members, a descendant
          // is running (e.g. one that closed its pipes): the run is NOT
          // complete until that owned descendant is terminated.
          if (!groupAlive(groupId)) {
            settle("closed");
            return;
          }
          if (termination === null) {
            termination = terminateOwnedGroup(groupId);
          }
          termination!.then((result) =>
            settle(result === "empty" ? "closed" : "uncertain")
          );
        });
        deadline.then(() => {
          // The timer sets `termination` synchronously before these
          // microtasks run, so it is always non-null here.
          termination!.then(async (result) => {
            if (result === "empty" && await within(closed, STREAM_MARGIN_MS)) {
              settle("closed");
            } else {
              settle("uncertain");
            }
          });
        });
      });
    } finally {
      clearTimeout(killTimer);
    }

    if (spawnError !== null) {
      // The spawn failed asynchronously (ENOENT/etc.): no group was created.
      // Detach the never-connected pipes so the collectors settle.
      destroyStreams(child);
      await within(streamsDone, STREAM_MARGIN_MS);
      return {
        outcome: "spawn_failed",
        exitCode: null,
        stdout: collector.stdout(),
        stderr: collector.stderr(),
        truncated: collector.truncated,
        settled: true,
        detail: `could not spawn ${input.executable}: ` +
          `${describeThrow(spawnError)}`,
      };
    }

    // Stream settlement: with 'close' observed, EOF has already been
    // delivered; the margin is a fail-closed guard for unexpected stream
    // errors or a pipe held by a process outside the owned group.
    const streamOutcome = await within(streamsDone, STREAM_MARGIN_MS);
    if (streamOutcome === null) {
      // A pipe still open after close cannot be owned by the (empty) group:
      // settlement cannot be proved, so the scratch must be preserved.
      return {
        outcome: "timed_out",
        exitCode: null,
        stdout: collector.stdout(),
        stderr: collector.stderr(),
        truncated: collector.truncated,
        settled: false,
        detail: `captured stream settlement could not be proven for ` +
          `${input.executable}; scratch must be preserved`,
      };
    }
    if (streamOutcome.some((r) => r.status === "rejected")) {
      // A rejected reader is a concrete settlement (nothing can write more).
      return {
        outcome: "spawn_failed",
        exitCode: null,
        stdout: collector.stdout(),
        stderr: collector.stderr(),
        truncated: collector.truncated,
        settled: true,
        detail: `captured stream failed for ${input.executable}`,
      };
    }

    if (state === "uncertain") {
      return {
        outcome: "timed_out",
        exitCode: null,
        stdout: collector.stdout(),
        stderr: collector.stderr(),
        truncated: collector.truncated,
        settled: false,
        detail: `owned descendants could not be proved settled after ` +
          `maxDurationMs=${input.maxDurationMs}; scratch must be preserved`,
      };
    }
    if (timedOut) {
      return {
        outcome: "timed_out",
        exitCode: null,
        stdout: collector.stdout(),
        stderr: collector.stderr(),
        truncated: collector.truncated,
        settled: true,
        detail: `command exceeded maxDurationMs=${input.maxDurationMs}`,
      };
    }
    const exitCode = exitCodeFor(closeCode, closeSignal);
    return {
      outcome: "exited",
      exitCode,
      stdout: collector.stdout(),
      stderr: collector.stderr(),
      truncated: collector.truncated,
      settled: true,
      detail: `command exited with code ${exitCode ?? "signal"}`,
    };
  }
}

/**
 * Bounded owned-group termination: SIGTERM the recorded group, wait (up to
 * the grace) for the group to become provably empty, then SIGKILL and wait
 * again. Only `-groupId` is ever signaled.
 */
async function terminateOwnedGroup(
  groupId: number,
): Promise<"empty" | "uncertain"> {
  try {
    signalGroup(groupId, "SIGTERM");
  } catch {
    return "uncertain";
  }
  const afterTerm = await waitGroupEmpty(groupId, TERM_GRACE_MS);
  if (afterTerm === "empty") return "empty";
  try {
    signalGroup(groupId, "SIGKILL");
  } catch {
    return "uncertain";
  }
  const afterKill = await waitGroupEmpty(groupId, TERM_GRACE_MS);
  return afterKill === "empty" ? "empty" : "uncertain";
}

function signalGroup(groupId: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    kill(-groupId, signal);
  } catch (error) {
    // NotFound already means an empty group; anything else must not be
    // swallowed — it makes settlement unprovable.
    if (!isGroupMissing(error)) throw error;
  }
}

async function waitGroupEmpty(
  groupId: number,
  maxMs: number,
): Promise<"empty" | "pending"> {
  if (maxMs <= 0) return groupAlive(groupId) ? "pending" : "empty";
  const deadline = Date.now() + maxMs;
  while (true) {
    if (!groupAlive(groupId)) return "empty";
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "pending";
    await delay(Math.min(GROUP_POLL_MS, remaining));
  }
}

/** True while any member of the owned group exists (0 = probe signal). */
function groupAlive(groupId: number): boolean {
  try {
    kill(-groupId, 0);
    return true;
  } catch (error) {
    if (isGroupMissing(error)) return false;
    // Cannot verify: fail closed by treating the group as alive.
    return true;
  }
}

function isGroupMissing(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "ESRCH" || error instanceof Deno.errors.NotFound;
}

function exitCodeFor(
  code: number | null,
  signal: string | null,
): number | null {
  if (code !== null) return code;
  if (signal === null) return null;
  const base = SIGNAL_EXIT_CODE[signal];
  return base === undefined ? null : 128 + base;
}

function destroyStreams(child: ChildProcess): void {
  try {
    child.stdout?.destroy();
  } catch {
    // Best effort; nothing to reap.
  }
  try {
    child.stderr?.destroy();
  } catch {
    // Best effort; nothing to reap.
  }
}

/**
 * Resolve `promise` if it settles within `timeoutMs`; else resolve null.
 * The timer is always cleared or consumed exactly once — no timer outlives
 * the returned promise.
 */
function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);
    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Concurrent, bounded collector for both streams. One shared byte budget
 * covers the combined retained output (stdout + stderr), matching the
 * registry contract; the retained prefix is what digests cover and any
 * overage sets `truncated`. Both streams are drained concurrently to EOF so
 * a full pipe can never deadlock the run.
 */
class BoundedCollector {
  truncated = false;
  private remaining: number;
  private readonly stdoutChunks: Uint8Array[] = [];
  private readonly stderrChunks: Uint8Array[] = [];
  private stdoutTotal = 0;
  private stderrTotal = 0;

  constructor(budget: number) {
    this.remaining = budget;
  }

  stdout(): Uint8Array {
    return joinChunks(this.stdoutChunks, this.stdoutTotal);
  }

  stderr(): Uint8Array {
    return joinChunks(this.stderrChunks, this.stderrTotal);
  }

  async collect(
    stream: AsyncIterable<Uint8Array> | null,
    slot: "stdout" | "stderr",
  ): Promise<void> {
    if (stream === null) return;
    const chunks = slot === "stdout" ? this.stdoutChunks : this.stderrChunks;
    for await (const value of stream) {
      if (this.remaining === 0) {
        this.truncated = true;
        continue;
      }
      const take = Math.min(value.byteLength, this.remaining);
      chunks.push(value.subarray(0, take));
      if (slot === "stdout") {
        this.stdoutTotal += take;
      } else {
        this.stderrTotal += take;
      }
      this.remaining -= take;
      if (take < value.byteLength) this.truncated = true;
    }
  }
}

function joinChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Bounded error text for diagnostics; never raw child output. */
function describeThrow(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const single = text.replace(/[\r\n\t]+/g, " ").trim();
  return single.length === 0 ? "unknown error" : single.slice(0, 160);
}
