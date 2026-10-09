/**
 * Fast lane: exercise the real Sentinel machinery locally in seconds.
 *
 * Commands:
 *   check [base]  Run fmt/lint/check on the TypeScript files changed against
 *                 <base> (default: origin/sentinel-supervisor).
 *   probe         Read-only live probe of the matrix recovery machinery
 *                 against the production repair/release state and GitHub
 *                 artifacts. Same code the hosted repair job runs; writes
 *                 nothing. Optional args: runtimeSha launcherSha runId runAttempt
 *                 (defaults come from the pending or last recorded execution).
 *
 * Usage:
 *   deno task fast
 *   GH_TOKEN=$(gh auth token) deno task fast:probe
 */
import { SystemClock } from "../src/contracts/ports.ts";
import { createRepairStateStore, DenoGitRunner } from "../src/state/mod.ts";
import { githubGitAuthEnv } from "../src/host/local.ts";
import {
  createActionsMatrixArtifactHttpTransport,
  createActionsMatrixArtifactTransport,
} from "../src/host/matrix-artifacts.ts";
import { closedCWaveHandledReservations } from "../src/host/modern-matrix-recovery.ts";

const REPO_URL = "https://github.com/ubiquity/sentinel.git";

function sh(
  command: string,
  args: string[],
): { code: number; stdout: string; stderr: string } {
  const out = new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  const decoder = new TextDecoder();
  return {
    code: out.code,
    stdout: decoder.decode(out.stdout),
    stderr: decoder.decode(out.stderr),
  };
}

function check(base: string): number {
  const changed = new Set<string>();
  for (
    const args of [
      ["diff", "--name-only", base],
      ["ls-files", "--others", "--exclude-standard"],
    ]
  ) {
    const result = sh("git", args);
    if (result.code !== 0) {
      console.error("fast: check: git " + args.join(" ") + " failed");
      console.error(result.stderr.trim());
      return 1;
    }
    for (const line of result.stdout.split("\n")) {
      if (/\.(ts|tsx)$/.test(line.trim())) changed.add(line.trim());
    }
  }
  const files = [...changed].sort();
  if (files.length === 0) {
    console.log("fast: check: no changed TypeScript files vs " + base);
    return 0;
  }
  console.log("fast: check: " + files.length + " changed file(s) vs " + base);
  let failed = 0;
  for (
    const [label, args] of [
      ["fmt", ["fmt", "--check", ...files]],
      ["lint", ["lint", ...files]],
      ["check", ["check", ...files]],
    ] as const
  ) {
    const result = sh("deno", args as unknown as string[]);
    if (result.code === 0) {
      console.log("fast: " + label + ": PASS (" + files.length + " files)");
    } else {
      failed += 1;
      console.log("fast: " + label + ": FAIL");
      const output = (result.stdout + result.stderr).trim();
      if (output.length > 0) console.log(output);
    }
  }
  return failed === 0 ? 0 : 1;
}

function resolveToken(): string {
  const fromEnv = Deno.env.get("GH_TOKEN");
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  const result = sh("gh", ["auth", "token"]);
  if (result.code !== 0 || result.stdout.trim().length === 0) {
    throw new Error(
      "no GitHub token: set GH_TOKEN or run `gh auth login` on this host",
    );
  }
  return result.stdout.trim();
}

async function probe(args: string[]): Promise<number> {
  const token = resolveToken();
  const scratch = (Deno.env.get("TMPDIR") ?? "/tmp") +
    "/sentinel-fast-lane";
  await Deno.mkdir(scratch, { recursive: true });
  const clock = new SystemClock();
  const state = createRepairStateStore({
    scratchDir: scratch,
    remoteUrl: REPO_URL,
    runner: new DenoGitRunner(
      scratch + "/state-git-home",
      githubGitAuthEnv(token),
    ),
  });
  const repair = await state.readRepair();
  const release = await state.readRelease();
  if (
    !repair.ok || repair.value.status !== "found" || !release.ok ||
    release.value.status !== "found"
  ) {
    console.log(JSON.stringify({ probe: "state_unavailable" }));
    return 1;
  }
  const snapshot = repair.value.snapshot;
  const runtime = release.value.snapshot.hostedRuntimes[0];
  const execution = runtime?.execution ??
    runtime?.lastExecutionProof?.execution;
  const handled = closedCWaveHandledReservations(snapshot);
  const charged = snapshot.work.flatMap((record) => {
    const intent = record.intent;
    if (
      record.nextStep !== "work" ||
      (intent?.kind !== "implementation" &&
        intent?.kind !== "candidate_preservation") ||
      intent.requestId === null || handled.has(intent.requestId)
    ) return [];
    return [{
      taskId: record.id,
      repository: record.repository,
      reservationId: intent.requestId,
      intentKey: intent.key,
      expectedBase: record.target.base,
      attempt: record.counters.attempts,
    }];
  });
  const runtimeSha =
    (args[0] ?? execution?.revision ?? runtime?.activeRevision) as
      | string
      | undefined;
  const launcherSha = (args[1] ?? execution?.launcherSha) as string | undefined;
  const runId = Number(args[2] ?? execution?.runId ?? 0);
  const runAttempt = Number(args[3] ?? execution?.runAttempt ?? 1);
  console.log(JSON.stringify({
    probe: "inputs",
    charged: charged.length,
    activeRevision: runtime?.activeRevision ?? null,
    generation: runtime?.generation ?? null,
    execution: execution
      ? {
        id: execution.id,
        purpose: execution.purpose,
        revision: execution.revision,
        generation: execution.generation,
      }
      : null,
    runtimeSha: runtimeSha ?? null,
    launcherSha: launcherSha ?? null,
    consumerRun: { runId, runAttempt },
  }));
  if (
    charged.length === 0 || runtimeSha === undefined ||
    launcherSha === undefined || runId <= 0
  ) {
    console.log(
      JSON.stringify({ probe: "skip", detail: "no pending recovery inputs" }),
    );
    return 0;
  }
  const transport = createActionsMatrixArtifactTransport({
    state,
    token,
    http: createActionsMatrixArtifactHttpTransport(),
    clock,
    artifactRoot: scratch + "/artifacts",
  });
  try {
    const waves = await transport.recover({
      requests: charged,
      runtimeSha: runtimeSha as never,
      launcherSha: launcherSha as never,
      consumerRun: {
        runId,
        runAttempt,
        launcherSha: launcherSha as never,
      },
      deadline: clock.now() + 180_000,
    });
    console.log(JSON.stringify({
      probe: "outcome",
      outcome: "ok",
      waves: waves.length,
      cells: waves.reduce((total, wave) => total + wave.plan.cells.length, 0),
    }));
    return 0;
  } catch (error) {
    const { MatrixHistoricalRuntimeMismatch } = await import(
      "../src/host/matrix-artifact-port.ts"
    );
    if (error instanceof MatrixHistoricalRuntimeMismatch) {
      console.log(JSON.stringify({
        probe: "outcome",
        outcome: "mismatch",
        affected: error.evidence.affected.length,
        run: error.evidence.run,
        waveRuntime: error.evidence.runtimeSha,
      }));
      return 0;
    }
    console.log(JSON.stringify({
      probe: "outcome",
      outcome: "refusal",
      detail: error instanceof Error ? error.message : String(error),
    }));
    return 1;
  }
}

if (import.meta.main) {
  const command = Deno.args[0] ?? "check";
  let code: number;
  if (command === "check") {
    code = check(Deno.args[1] ?? "origin/sentinel-supervisor");
  } else if (command === "probe") {
    code = await probe(Deno.args.slice(1));
  } else {
    console.error(
      "usage: fast-lane.ts check [base] | probe [runtimeSha launcherSha runId runAttempt]",
    );
    code = 64;
  }
  Deno.exit(code);
}
