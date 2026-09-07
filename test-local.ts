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
 * --allow-run=deno (spawn deno), --allow-write (temporary HOME).
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
  { name: "check", args: ["check", "src/contracts/mod.ts"] },
  {
    name: "test",
    args: ["test", "--allow-read=tests/fixtures/contracts", "tests/contracts/"],
  },
];

function cleanup(): void {
  Deno.remove(tempHome, { recursive: true }).catch(() => {});
}

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
      Deno.exit(1);
    }
  }
  console.log(
    "test:local: all checks passed in credential-free child environments",
  );
} finally {
  cleanup();
}
