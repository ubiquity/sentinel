/**
 * Linux replay isolation (T05a concrete isolation foundation).
 *
 * `LinuxReplayIsolation` is the one production boundary that runs a
 * target-controlled replay command on the restricted execution host. It is
 * deliberately small: no container framework, no configurable binary paths,
 * no environment or CLI surface and no shell. Everything the target can
 * reach is decided here:
 *
 *   - Linux only, fail closed. On any other platform `run` returns a static
 *     `spawn_failed` result, so a target command is never invoked outside the
 *     boundary.
 *   - The constructor requires an existing trusted `scratchRoot`; a run cwd
 *     must realpath to a STRICT descendant of it and be a directory. Only
 *     that exact checkout is bound into the sandbox at its own absolute path:
 *     the scratch root itself, sibling checkouts, the source repository, the
 *     host home and the host `/tmp` are never mounted.
 *   - Executables are resolved without a shell. Bare names are searched only
 *     in the fixed `/usr/local/bin:/usr/bin:/bin`; absolute paths must
 *     realpath under `/usr/` or inside the checkout; relative paths must stay
 *     inside the checkout. Missing, non-regular or escaping executables are
 *     rejected before anything is spawned.
 *   - Every run is a fixed `/usr/bin/bwrap` invocation:
 *     `--unshare-all --die-with-parent --new-session --clearenv`, a read-only
 *     `/usr` (with `usr/bin`, `usr/lib` and `usr/lib64` symlinks so the fixed
 *     paths resolve), private `/proc` and `/dev`, a tmpfs `/tmp` containing
 *     `/tmp/home` and `/tmp/deno`, only the needed destination parent
 *     directories, the exact checkout bound read-only or read-write at the
 *     same absolute path, and the exact cwd via `--chdir`.
 *   - The sandbox environment is the fixed non-secret set PATH, HOME,
 *     DENO_DIR, TMPDIR, NO_COLOR and an empty NODE_V8_COVERAGE. Neither
 *     `input.env` nor the host environment is forwarded, and the bwrap
 *     process itself runs with a minimal fixed PATH and empty coverage.
 *
 * A read-write bind is required for real replays whose tests create temporary
 * files in the disposable checkout; read-only is for causal private
 * snapshots. The caller's `maxDurationMs`/`maxOutputBytes` and the underlying
 * runtime result (deadline, bounded output, settlement) are returned
 * unchanged. The instance attestation is the descriptive restricted-host
 * capability the frozen ReplayPort contract consumes.
 */

import type { ReplayIsolationAttestationV1 } from "./port.ts";
import { DenoReplayRuntime } from "./runtime.ts";
import type {
  ReplayCommandInputV1,
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "./runtime.ts";

/** Checkout mount mode for one isolated replay command run. */
export type ReplayCheckoutAccessV1 = "read-only" | "read-write";

export interface LinuxReplayIsolationOptions {
  /** Deterministic test injection; production defaults to DenoReplayRuntime. */
  runtime?: ReplayRuntimeV1;
  /** Platform override for deterministic unsupported-platform tests only. */
  osName?: string;
}

/** Fixed bubblewrap binary; never configurable. */
const BWRAP_PATH = "/usr/bin/bwrap";
/** Fixed executable search path, used both outside and inside the sandbox. */
const SANDBOX_PATH = "/usr/local/bin:/usr/bin:/bin";
/** Minimal outer environment for the bwrap process itself. */
const OUTER_ENV: Readonly<Record<string, string>> = {
  PATH: SANDBOX_PATH,
  NODE_V8_COVERAGE: "",
};
/** Complete fixed sandbox environment (set inside `--clearenv`). */
const SANDBOX_ENV: ReadonlyArray<readonly [string, string]> = [
  ["PATH", SANDBOX_PATH],
  ["HOME", "/tmp/home"],
  ["DENO_DIR", "/tmp/deno"],
  ["TMPDIR", "/tmp"],
  ["NO_COLOR", "1"],
  ["NODE_V8_COVERAGE", ""],
];
const PATH_DIRS: readonly string[] = SANDBOX_PATH.split(":");
/** Roots already present in the sandbox before the checkout is bound. */
const PROVISIONED_DIRS: ReadonlySet<string> = new Set([
  "/usr",
  "/proc",
  "/dev",
  "/tmp",
  "/bin",
  "/lib",
  "/lib64",
]);
const MAX_DETAIL = 160;

export class LinuxReplayIsolation {
  /**
   * Descriptive attestation of the boundary this instance enforces. It
   * matches the frozen `ReplayIsolationAttestationV1` contract consumed by
   * ReplayPort; `run` is the actual enforcement point.
   */
  readonly attestation: ReplayIsolationAttestationV1;
  private readonly runtime: ReplayRuntimeV1;
  private readonly osName: string;
  private readonly scratchRoot: string;

  constructor(scratchRoot: string, options: LinuxReplayIsolationOptions = {}) {
    this.scratchRoot = requireTrustedScratchRoot(scratchRoot);
    this.osName = options.osName ?? Deno.build.os;
    this.runtime = options.runtime ?? new DenoReplayRuntime(SANDBOX_PATH);
    this.attestation = {
      version: "v1",
      host: "linux-bwrap-namespace",
      restrictedExecution: true,
      boundary:
        "bubblewrap --unshare-all namespace: read-only /usr, private /proc and /dev, tmpfs /tmp, and only the exact checkout bound at its own absolute path",
      attestationRef: "isolation://linux/bwrap-unshare-all",
    };
  }

  /**
   * Run one target-controlled command inside the boundary. Every rejection is
   * a static, bounded `spawn_failed`/`settled: true` result; only a fully
   * validated invocation reaches the runtime.
   */
  async run(
    input: ReplayCommandInputV1,
    access: ReplayCheckoutAccessV1,
  ): Promise<ReplayCommandResultV1> {
    if (this.osName !== "linux") {
      return rejected(
        "isolation rejected: Linux is the only supported execution platform",
      );
    }
    if (access !== "read-only" && access !== "read-write") {
      return rejected(
        "isolation rejected: checkout access must be read-only or read-write",
      );
    }
    const shape = inputShapeError(input);
    if (shape !== null) return rejected(shape);

    const scratch = await realDirectory(this.scratchRoot);
    if (scratch === null) {
      return rejected("isolation rejected: scratch root is not a directory");
    }
    const checkout = await realDirectory(input.cwd);
    if (checkout === null) {
      return rejected("isolation rejected: cwd is missing or not a directory");
    }
    if (!isStrictDescendant(checkout, scratch)) {
      return rejected(
        "isolation rejected: cwd is not a strict descendant of the scratch root",
      );
    }

    const executable = await resolveExecutable(input.executable, checkout);
    if (!executable.ok) return rejected(executable.reason);
    if (!(await isRegularFile(BWRAP_PATH))) {
      return rejected(
        "isolation rejected: /usr/bin/bwrap is missing or not a regular binary",
      );
    }

    return await this.runtime.run({
      executable: BWRAP_PATH,
      args: bwrapArgs(checkout, executable.path, input.args, access),
      // The host cwd is irrelevant: bwrap enters the exact checkout with
      // `--chdir` after the mount setup.
      cwd: "/",
      env: OUTER_ENV,
      maxDurationMs: input.maxDurationMs,
      maxOutputBytes: input.maxOutputBytes,
    });
  }
}

// ---------------------------------------------------------------------------
// Validation and resolution helpers
// ---------------------------------------------------------------------------

/** Constructor guard: an existing, real, absolute, non-root directory. */
function requireTrustedScratchRoot(scratchRoot: string): string {
  if (
    typeof scratchRoot !== "string" || scratchRoot.length === 0 ||
    !scratchRoot.startsWith("/") || scratchRoot.includes("\0")
  ) {
    throw new TypeError(
      "LinuxReplayIsolation scratchRoot must be a real absolute path",
    );
  }
  let real: string;
  try {
    real = Deno.realPathSync(scratchRoot);
  } catch {
    throw new TypeError(
      "LinuxReplayIsolation scratchRoot must be an existing directory",
    );
  }
  if (real === "/") {
    throw new TypeError(
      "LinuxReplayIsolation scratchRoot must not be the filesystem root",
    );
  }
  let info: Deno.FileInfo;
  try {
    info = Deno.statSync(real);
  } catch {
    throw new TypeError(
      "LinuxReplayIsolation scratchRoot must be an existing directory",
    );
  }
  if (!info.isDirectory) {
    throw new TypeError("LinuxReplayIsolation scratchRoot must be a directory");
  }
  return real;
}

function inputShapeError(input: ReplayCommandInputV1): string | null {
  if (input === null || typeof input !== "object") {
    return "isolation rejected: invalid command input";
  }
  if (
    typeof input.executable !== "string" || input.executable.length === 0 ||
    input.executable.includes("\0")
  ) {
    return "isolation rejected: invalid executable";
  }
  if (
    !Array.isArray(input.args) ||
    input.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  ) {
    return "isolation rejected: invalid argv";
  }
  if (
    typeof input.cwd !== "string" || input.cwd.length === 0 ||
    !input.cwd.startsWith("/") || input.cwd.includes("\0")
  ) {
    return "isolation rejected: cwd must be an absolute path";
  }
  if (
    typeof input.maxDurationMs !== "number" ||
    !Number.isFinite(input.maxDurationMs) || input.maxDurationMs <= 0
  ) {
    return "isolation rejected: invalid maxDurationMs";
  }
  if (
    typeof input.maxOutputBytes !== "number" ||
    !Number.isFinite(input.maxOutputBytes) || input.maxOutputBytes <= 0
  ) {
    return "isolation rejected: invalid maxOutputBytes";
  }
  return null;
}

/** Real path of an existing directory, or null (never throws). */
async function realDirectory(path: string): Promise<string | null> {
  if (
    typeof path !== "string" || path.length === 0 ||
    !path.startsWith("/") || path.includes("\0")
  ) {
    return null;
  }
  try {
    const real = await Deno.realPath(path);
    if (real === "/") return null;
    const info = await Deno.stat(real);
    return info.isDirectory ? real : null;
  } catch {
    return null;
  }
}

/** Real path of an existing regular file at `path`, or null. */
async function isRegularFile(path: string): Promise<boolean> {
  try {
    const info = await Deno.stat(path);
    return info.isFile;
  } catch {
    return false;
  }
}

async function realRegularFile(path: string): Promise<string | null> {
  try {
    const real = await Deno.realPath(path);
    const info = await Deno.stat(real);
    return info.isFile ? real : null;
  } catch {
    return null;
  }
}

function isStrictDescendant(path: string, root: string): boolean {
  return path !== root && path.startsWith(`${root}/`);
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

type ExecutableResolution =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * Shell-free executable resolution. Only two destinations are reachable
 * inside the sandbox: read-only `/usr` and the bound checkout itself.
 */
async function resolveExecutable(
  executable: string,
  checkout: string,
): Promise<ExecutableResolution> {
  const missing =
    "isolation rejected: executable is missing or not a regular file";
  if (executable.startsWith("/")) {
    const real = await realRegularFile(executable);
    if (real === null) return { ok: false, reason: missing };
    if (real.startsWith("/usr/") || within(real, checkout)) {
      return { ok: true, path: real };
    }
    return {
      ok: false,
      reason: "isolation rejected: executable escapes the isolation boundary",
    };
  }
  if (executable.includes("/")) {
    const real = await realRegularFile(`${checkout}/${executable}`);
    if (real === null) return { ok: false, reason: missing };
    if (within(real, checkout)) return { ok: true, path: real };
    return {
      ok: false,
      reason: "isolation rejected: relative executable escapes the checkout",
    };
  }
  for (const dir of PATH_DIRS) {
    const real = await realRegularFile(`${dir}/${executable}`);
    if (real === null) continue;
    if (!real.startsWith("/usr/")) {
      return {
        ok: false,
        reason: "isolation rejected: executable resolves outside /usr",
      };
    }
    return { ok: true, path: real };
  }
  return {
    ok: false,
    reason: "isolation rejected: executable not found in the fixed PATH",
  };
}

/**
 * Only the parent directories the checkout destination actually needs are
 * created, and it is bound at the SAME absolute path (argv is never
 * translated).
 */
function neededParentDirs(destination: string): string[] {
  // A read-only /usr already provides every directory below it.
  if (destination.startsWith("/usr/")) return [];
  const segments = destination.split("/").filter((segment) =>
    segment.length > 0
  );
  const dirs: string[] = [];
  let current = "";
  for (let i = 0; i < segments.length - 1; i++) {
    current += `/${segments[i]}`;
    if (PROVISIONED_DIRS.has(current)) continue;
    dirs.push(current);
  }
  return dirs;
}

function bwrapArgs(
  checkout: string,
  executable: string,
  argv: readonly string[],
  access: ReplayCheckoutAccessV1,
): string[] {
  const args: string[] = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
  ];
  for (const [key, value] of SANDBOX_ENV) args.push("--setenv", key, value);
  args.push(
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/tmp/home",
    "--dir",
    "/tmp/deno",
  );
  for (const dir of neededParentDirs(checkout)) args.push("--dir", dir);
  args.push(
    access === "read-only" ? "--ro-bind" : "--bind",
    checkout,
    checkout,
    "--chdir",
    checkout,
    "--",
    executable,
    ...argv,
  );
  return args;
}

/** Static, bounded fail-closed result: nothing was spawned. */
function rejected(detail: string): ReplayCommandResultV1 {
  const single = detail.replace(/[\r\n\t]+/g, " ").trim();
  return {
    outcome: "spawn_failed",
    exitCode: null,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    truncated: false,
    settled: true,
    detail: single.slice(0, MAX_DETAIL),
  };
}
