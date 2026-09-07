/**
 * Hermetic local test harness (root toolchain, foundation-owned).
 *
 * Every toolchain step runs in a child process with clearEnv:true, inheriting
 * only PATH and a temporary HOME (with DENO_DIR under it). No workstation
 * credentials and no user Deno configuration reach the children; no remote
 * test packages are imported, so no network is ever needed. Deno task
 * inheritance alone is not enough — the credential-free boundary is drawn
 * here at the child-process level.
 *
 * Run with: deno task test:local
 *
 * Required harness permissions: --allow-env=PATH (read PATH for children),
 * --allow-run=deno,git (spawn deno/git), --allow-write (temporary HOME).
 * The state tests spawn their own disposable git children with clearEnv, so
 * the git permission is required here even though the toolchain steps are
 * Deno-only.
 *
 * Exit discipline: the harness must wait for removal of the task-created
 * temp home on BOTH success and failure before exiting. `Deno.exit` from
 * inside the try block would terminate the process without running the
 * finally cleanup, so failures set a flag, break out of the step loop, run
 * the awaited cleanup, and only then exit non-zero.
 */
const root = Deno.cwd();
const path = Deno.env.get("PATH") ?? "/usr/bin:/bin";
// The temporary HOME is created inside the workspace: the OS temp directory
// is not writable in every local harness context, and the temp tree never
// enters the fmt/lint/test scopes.
const tempHome = await Deno.makeTempDir({
  prefix: "sentinel-test-local-",
  dir: root,
});
const env = {
  PATH: path,
  HOME: tempHome,
  DENO_DIR: `${tempHome}/.cache/deno`,
};

const steps: { name: string; args: string[] }[] = [
  { name: "fmt", args: ["fmt", "--check"] },
  { name: "lint", args: ["lint"] },
  {
    name: "check",
    args: [
      "check",
      "src/contracts/mod.ts",
      "src/state/mod.ts",
      "src/budget/mod.ts",
    ],
  },
  {
    name: "test",
    args: [
      "test",
      "--allow-read=.",
      "--allow-run=deno",
      "--allow-run=git",
      "--allow-write",
      "--allow-env=PATH",
      "tests/contracts/",
      "tests/state/",
      "tests/budget/",
    ],
  },
];

/**
 * Awaited removal of exactly this task's temp home. Paths are never
 * constructed from scratch contents and no other directory is removed.
 */
async function cleanup(): Promise<void> {
  try {
    await Deno.remove(tempHome, { recursive: true });
  } catch {
    // Best-effort removal; the step result is still reported truthfully.
  }
}

let failed = false;
try {
  for (const step of steps) {
    const child = new Deno.Command("deno", {
      args: step.args,
      cwd: root,
      clearEnv: true,
      env,
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    const status = await child.status;
    if (!status.success) {
      console.error(`test:local failed at step: deno ${step.args.join(" ")}`);
      failed = true;
      break;
    }
  }
} finally {
  await cleanup();
}

if (failed) Deno.exit(1);
console.log(
  "test:local: all checks passed in credential-free child environments",
);
