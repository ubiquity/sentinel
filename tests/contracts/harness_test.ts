// Hermetic-harness regression: the harness must wait for removal of its
// task-created temp home on BOTH success and failure before exiting. The
// regression under test is the failure path: the previous harness called
// `Deno.exit(1)` from inside the try block, which terminates the process
// without running the finally cleanup, and its cleanup call was not awaited.
//
// This test runs the actual test-local.ts harness from a disposable cwd whose
// deliberately unformatted file makes `deno fmt --check` (the first step)
// fail, then asserts the harness exited non-zero and left no
// `sentinel-test-local-*` directory behind. No new flags or environment
// switches are introduced: the harness is invoked exactly like
// `deno task test:local` from the disposable cwd.
import assert from "node:assert/strict";

// Repository root, derived without any remote package: the harness lives at
// <root>/tests/contracts/harness_test.ts.
const here = new URL(import.meta.url);
if (here.protocol !== "file:") throw new Error("expected a file: test module");
const rootDir = decodeURIComponent(here.pathname).replace(
  /\/tests\/contracts\/harness_test\.ts$/,
  "",
);

Deno.test("test:local failure path removes its temp home before exiting", async () => {
  // The workspace root is always writable in the harness context, so the
  // disposable cwd lives there (gitignored via /sentinel-harness-failure-*/).
  const disposable = await Deno.makeTempDir({
    prefix: "sentinel-harness-failure-",
    dir: rootDir,
  });
  try {
    // Deliberately unformatted file: `deno fmt --check` fails on it.
    // Deliberately unformatted file: `deno fmt --check` fails on it. The
    // disposable cwd also carries a minimal local deno.json so the harness
    // (run from that cwd) does not inherit this repository's fmt include
    // list via config discovery from a parent directory.
    await Deno.writeTextFile(`${disposable}/bad-format.ts`, "const x=1;  \n");
    await Deno.writeTextFile(
      `${disposable}/deno.json`,
      JSON.stringify({ fmt: { include: ["bad-format.ts"] } }),
    );
    const result = await new Deno.Command("deno", {
      args: [
        "run",
        "--allow-env=PATH",
        "--allow-run=deno",
        "--allow-write",
        `${rootDir}/test-local.ts`,
      ],
      cwd: disposable,
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        HOME: `${disposable}/home`,
        DENO_DIR: `${disposable}/deno-cache`,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const output = new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr);
    assert.equal(result.success, false, `harness should fail, got: ${output}`);
    assert.match(output, /test:local failed at step: deno fmt --check/);
    // The harness must have awaited the removal of its temp home before
    // exiting; no sentinel-test-local-* directory may remain.
    const leftovers = [];
    for await (const entry of Deno.readDir(disposable)) {
      if (entry.name.startsWith("sentinel-test-local-")) {
        leftovers.push(entry.name);
      }
    }
    assert.deepEqual(leftovers, []);
  } finally {
    await Deno.remove(disposable, { recursive: true }).catch(() => {});
  }
});
