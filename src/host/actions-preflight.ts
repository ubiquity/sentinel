/**
 * Finite credential-free Codex startup diagnostic.
 *
 * Proves the installed app-server can be spawned, initialized and can
 * acknowledge a `thread/start` bound to the runtime model/provider/reasoning
 * and the sentinel-local permission profile WITHOUT any model operation: no
 * `turn/start`, no authoritative token, no host credentials. It runs before
 * budget admission so an actual GitHub-runner startup-boundary failure is
 * attributed exactly instead of being lost inside the first model reservation
 * (the observed hosted failure was a five-second `server_error` with no
 * detail). Passing this diagnostic is NOT repair-delivery success.
 */
import { CodexSubprocessSession } from "../repair/codex-transport.ts";
import { ensurePrivateDir, ensureTaskClient, joinPath } from "./local.ts";

const MODEL = "gpt-5.6-luna";
const REASONING = "max";
const PROVIDER = "uos";
const PROFILE = "sentinel-local";
const BASE_URL = "http://127.0.0.1:1/v1";
const TOKEN = "unused-no-model-call";
const OPERATION_DEADLINE_MS = 20_000;
const ERROR_CAP = 2_000;
const KIND = "sentinel_startup_preflight";
const INSIDE_MARKER = "sentinel-inside-probe-marker";
const OUTSIDE_MARKER = "sentinel-outside-probe-marker";
const OVERWRITE_MARKER = "sentinel-outside-probe-overwrite";

function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ kind: KIND, ...entry }));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

/** Bound any failure message; the probe holds no secret or private payload. */
function boundedMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    ERROR_CAP,
  );
}

/**
 * One `command/exec` sandbox probe. The response is the verified
 * `{ exitCode, stdout, stderr }` evidence shape.
 */
async function execProbe(
  session: CodexSubprocessSession,
  cwd: string,
  command: string[],
): Promise<{ exitCode: number; stdout: string }> {
  const record = asRecord(
    await session.send("command/exec", {
      command,
      cwd,
      permissionProfile: PROFILE,
      timeoutMs: 5_000,
      outputBytesCap: 2_048,
    }),
  );
  if (
    record === null || typeof record.exitCode !== "number" ||
    typeof record.stdout !== "string"
  ) {
    throw new Error("command/exec response missing exitCode/stdout evidence");
  }
  return { exitCode: record.exitCode, stdout: record.stdout };
}

/** Resolve the installed codex from the explicit trusted PATH and realPath it. */
async function resolveCodex(path: string): Promise<string> {
  for (const directory of path.split(":")) {
    const candidate = joinPath(directory.length > 0 ? directory : "/", "codex");
    try {
      if (!(await Deno.stat(candidate)).isDirectory) {
        return await Deno.realPath(candidate);
      }
    } catch {
      // Continue through the explicitly trusted PATH only.
    }
  }
  throw new Error("installed codex executable not found on PATH");
}

async function main(): Promise<void> {
  // The only host input read is PATH; no credential is ever resolved.
  const path = Deno.env.get("PATH");
  if (path === undefined || path.length === 0) {
    throw new Error("PATH is required to resolve the installed codex");
  }
  let root: string | null = null;
  let session: CodexSubprocessSession | null = null;
  let passed = false;
  let primary: unknown = null;
  let stage = "temp_root";
  try {
    // Unique private root (0700); client/tmp/deno are private subdirectories.
    // An independent fixture avoids loading parent repository AGENTS.md
    // instructions. Linux synthetic mounts require host readback for
    // outside-write protection.
    root = await Deno.makeTempDir({ prefix: "sentinel-preflight-" });
    const checkout = joinPath(root, "checkout");
    const clientHome = joinPath(root, "client");
    const tmpDir = joinPath(root, "tmp");
    const denoDir = joinPath(root, "deno");
    const insideMarker = joinPath(checkout, "inside-marker.txt");
    const outsideMarker = joinPath(root, "outside-marker.txt");

    stage = "resolve_codex";
    const codexExecutable = await resolveCodex(path);
    log({ stage, codexExecutable });

    stage = "client";
    await ensurePrivateDir(checkout);
    await ensureTaskClient({
      clientHome,
      tmpDir,
      denoDir,
      checkout,
      token: TOKEN,
      codexExecutable,
      denoExecutable: Deno.execPath(),
      trustedPath: path,
      baseUrl: BASE_URL,
    });
    // Trusted-host fixture outside the checkout: the sandboxed session must
    // neither read nor overwrite it.
    await Deno.writeTextFile(outsideMarker, OUTSIDE_MARKER, { mode: 0o600 });
    log({ stage });

    stage = "open";
    session = new CodexSubprocessSession({
      command: [codexExecutable, "app-server"],
      cwd: checkout,
      // Minimal child environment: PATH plus temp HOME/CODEX_HOME/TMPDIR/DENO_DIR.
      env: {
        PATH: path,
        HOME: clientHome,
        CODEX_HOME: clientHome,
        TMPDIR: tmpDir,
        DENO_DIR: denoDir,
      },
      operationDeadlineMs: OPERATION_DEADLINE_MS,
    });
    session.open();
    log({ stage });

    stage = "initialize";
    const initialized = asRecord(
      await session.send("initialize", {
        clientInfo: { name: "sentinel-actions-preflight", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }),
    );
    if (initialized === null || typeof initialized.userAgent !== "string") {
      throw new Error("initialize response missing evidence");
    }
    session.notify("initialized", {});
    log({ stage });

    // No turn/start and no model operation is ever submitted: this stops at
    // the startup acknowledgement boundary.
    stage = "thread_start";
    const response = asRecord(
      await session.send("thread/start", {
        model: MODEL,
        modelProvider: PROVIDER,
        cwd: checkout,
        approvalPolicy: "never",
        ephemeral: true,
        permissions: PROFILE,
        config: { model_reasoning_effort: REASONING },
      }),
    );
    const threadId = asRecord(response?.thread)?.id;
    if (typeof threadId !== "string" || threadId.length === 0) {
      throw new Error("thread/start response missing a thread id");
    }
    if (
      response === null || response.model !== MODEL ||
      response.modelProvider !== PROVIDER ||
      response.reasoningEffort !== REASONING
    ) {
      throw new Error(
        "thread/start response does not acknowledge model/provider/reasoning",
      );
    }
    if (asRecord(response.activePermissionProfile)?.id !== PROFILE) {
      throw new Error(
        "thread/start response does not acknowledge the permission profile",
      );
    }
    log({ stage, threadId });

    // Sandbox boundary probes after the thread acknowledgement. No model turn
    // is submitted and the child holds no host credential; the trusted host
    // owns the marker outside the checkout. Only booleans are logged.
    stage = "sandbox_inside_write";
    const inside = await execProbe(session, checkout, [
      "/bin/sh",
      "-c",
      `printf %s ${INSIDE_MARKER} > "$1"`,
      "sentinel-probe",
      insideMarker,
    ]);
    if (inside.exitCode !== 0) {
      throw new Error("sandbox inside write did not succeed");
    }
    if (await Deno.readTextFile(insideMarker) !== INSIDE_MARKER) {
      throw new Error("sandbox inside write not observed on host");
    }
    log({ stage, ok: true });

    stage = "sandbox_outside_read";
    const read = await execProbe(session, checkout, [
      "/bin/cat",
      outsideMarker,
    ]);
    if (read.exitCode === 0 || read.stdout.includes(OUTSIDE_MARKER)) {
      throw new Error("sandbox outside read was not denied");
    }
    log({ stage, ok: true });

    stage = "sandbox_outside_write";
    const write = await execProbe(session, checkout, [
      "/bin/sh",
      "-c",
      `printf %s ${OVERWRITE_MARKER} > "$1"`,
      "sentinel-probe",
      outsideMarker,
    ]);
    // Linux may accept a write into its synthetic mount; the unchanged real
    // host marker is authoritative, not the command's exit status.
    if (await Deno.readTextFile(outsideMarker) !== OUTSIDE_MARKER) {
      throw new Error("sandbox outside marker changed");
    }
    log({
      stage,
      ok: true,
      hostWritePrevented: true,
      commandExitCode: write.exitCode,
    });

    passed = true;
  } catch (error) {
    // The probe holds no real token, prompt or private task data, so the
    // bounded message is safe to surface for the hosted startup boundary.
    primary = error;
    log({ pass: false, stage, error: boundedMessage(error) });
  }

  // Cleanup is sequential, never a throwing `finally`: the primary startup
  // failure survives, and cleanup failure is reported only when no primary
  // exists. An unsettled session is never cleaned up, and the probe root is
  // removed only after settlement is observed. Pass is emitted last.
  let cleanup: unknown = null;
  let settled = session === null;
  if (session !== null) {
    try {
      await session.close();
      settled = session.isSettled();
      if (!settled) {
        cleanup = new Error("codex preflight session did not settle");
      }
    } catch (error) {
      cleanup = error;
    }
  }
  if (root !== null && settled) {
    try {
      await Deno.remove(root, { recursive: true });
    } catch (error) {
      if (cleanup === null) cleanup = error;
    }
  }
  if (primary !== null) {
    if (cleanup !== null) {
      log({ pass: false, stage: "cleanup", error: boundedMessage(cleanup) });
    }
    throw primary;
  }
  if (cleanup !== null) {
    log({ pass: false, stage: "close", error: boundedMessage(cleanup) });
    throw cleanup;
  }
  if (passed) log({ pass: true });
}

if (import.meta.main) {
  await main();
}
