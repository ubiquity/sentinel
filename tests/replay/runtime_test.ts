// Replay runtime suite (m03): exercises the ACTUAL DenoReplayRuntime — the
// node:child_process detached process-group runtime — with tiny local
// commands only. No network, no model calls, no indefinite children. These
// cases prove the two acceptance regressions:
//   1. Direct-parent exit is NOT completion: a descendant that keeps the
//      captured pipe open (or keeps running) must make the run time out
//      promptly within maxDurationMs instead of returning "exited".
//   2. A TERM-ignoring child is SIGKILLed inside the bounded grace, and no
//      owned descendant or timer remains at completion.
import assert from "node:assert/strict";
import { kill } from "node:process";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import type { ReplayCommandInputV1 } from "../../src/replay/runtime.ts";

const here = new URL(import.meta.url);
if (here.protocol !== "file:") throw new Error("expected a file: test module");
const testsDir = decodeURIComponent(here.pathname).replace(
  /\/runtime_test\.ts$/,
  "",
);

async function withFixture<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({
    prefix: ".replay-runtime-",
    dir: testsDir,
  });
  try {
    return await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

function runtime(): DenoReplayRuntime {
  return new DenoReplayRuntime(Deno.env.get("PATH") ?? "/usr/bin:/bin");
}

function command(
  root: string,
  args: string[],
  maxDurationMs: number,
  maxOutputBytes = 64 * 1024,
): ReplayCommandInputV1 {
  return {
    executable: "/bin/sh",
    args,
    cwd: root,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      HOME: `${root}/home`,
      NO_COLOR: "1",
    },
    maxDurationMs,
    maxOutputBytes,
  };
}

/** The recorded owned group must be provably empty after the run. */
function assertGroupGone(run: DenoReplayRuntime): void {
  const groupId = run.lastOwnedGroupId();
  assert.ok(groupId !== null, "runtime must record the owned group id");
  try {
    kill(-groupId, 0);
    assert.fail(`owned process group ${groupId} still exists after the run`);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    assert.ok(
      code === "ESRCH" || error instanceof Deno.errors.NotFound,
      `expected group ${groupId} gone, got ${String(error)}`,
    );
  }
}

Deno.test(
  "descendant holding captured output after parent exit times out promptly",
  async () => {
    await withFixture(async (root) => {
      const run = runtime();
      const started = Date.now();
      const result = await run.run(command(
        root,
        ["-c", "(sleep 0.2) & exit 0"],
        50,
      ));
      const elapsed = Date.now() - started;
      assert.equal(result.outcome, "timed_out", "must NOT report exited");
      assert.equal(result.exitCode, null);
      assert.equal(result.settled, true, "owned group must be settled");
      assert.match(result.detail, /exceeded maxDurationMs/);
      assert.ok(
        elapsed < 2000,
        `timeout must fire promptly, took ${elapsed}ms`,
      );
      assertGroupGone(run);
    });
  },
);

Deno.test(
  "TERM-ignoring child is SIGKILLed inside the bounded grace and settled",
  async () => {
    await withFixture(async (root) => {
      const run = runtime();
      const started = Date.now();
      const result = await run.run(command(
        root,
        ["-c", "trap '' TERM; sleep 30"],
        100,
      ));
      const elapsed = Date.now() - started;
      assert.equal(result.outcome, "timed_out");
      assert.equal(result.exitCode, null);
      assert.equal(result.settled, true, "KILL must settle the owned group");
      assert.match(result.detail, /exceeded maxDurationMs/);
      assert.ok(
        elapsed < 3000,
        `TERM-to-KILL must stay bounded, took ${elapsed}ms`,
      );
      assertGroupGone(run);
    });
  },
);

Deno.test(
  "leftover owned descendant without pipes is terminated before exit",
  async () => {
    await withFixture(async (root) => {
      const run = runtime();
      const started = Date.now();
      // The direct parent exits 0; a descendant closes its pipes and keeps
      // running in the owned group. Parent exit alone is not completion.
      const result = await run.run(command(
        root,
        ["-c", "sleep 30 >/dev/null 2>&1 & exit 0"],
        5000,
      ));
      const elapsed = Date.now() - started;
      assert.equal(result.outcome, "exited");
      assert.equal(result.exitCode, 0);
      assert.equal(result.settled, true, "owned group must be empty");
      assert.ok(
        elapsed < 2000,
        `leftover cleanup must be prompt, took ${elapsed}ms`,
      );
      assertGroupGone(run);
    });
  },
);

Deno.test("normal exit still captures bounded output and exit code", async () => {
  await withFixture(async (root) => {
    const run = runtime();
    const result = await run.run(command(
      root,
      ["-c", "printf 'hello'; printf 'oops' >&2; exit 3"],
      5000,
    ));
    assert.equal(result.outcome, "exited");
    assert.equal(result.exitCode, 3);
    assert.equal(result.settled, true);
    assert.equal(new TextDecoder().decode(result.stdout), "hello");
    assert.equal(new TextDecoder().decode(result.stderr), "oops");
    assert.equal(result.truncated, false);
  });
});

Deno.test("output cap retains a bounded prefix and flags truncation", async () => {
  await withFixture(async (root) => {
    const run = runtime();
    const result = await run.run(command(
      root,
      // Keep the producer POSIX-sh compatible: ubuntu's /bin/sh is dash and
      // does not expand bash's {1..5000} brace range.
      ["-c", "i=0; while [ $i -lt 5000 ]; do printf x; i=$((i + 1)); done"],
      5000,
      128,
    ));
    assert.equal(result.outcome, "exited");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.byteLength, 128);
    assert.equal(result.truncated, true);
    assert.equal(result.settled, true);
  });
});

Deno.test("spawn failure is settled and reported; nothing is signaled", async () => {
  await withFixture(async (root) => {
    const run = runtime();
    const result = await run.run({
      executable: "sentinel-no-such-executable-xyz",
      args: [],
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      maxDurationMs: 1000,
      maxOutputBytes: 64 * 1024,
    });
    assert.equal(result.outcome, "spawn_failed");
    assert.equal(result.settled, true, "nothing was spawned");
    assert.equal(result.exitCode, null);
    assert.match(result.detail, /could not spawn/);
  });
});

Deno.test("unsupported platforms are rejected before any execution", async () => {
  await withFixture(async (root) => {
    const run = new DenoReplayRuntime(
      Deno.env.get("PATH") ?? "/usr/bin:/bin",
      { osName: "windows" },
    );
    const result = await run.run(command(
      root,
      ["-c", "exit 0"],
      1000,
    ));
    assert.equal(result.outcome, "spawn_failed");
    assert.equal(result.settled, true, "nothing was spawned");
    assert.match(result.detail, /unsupported platform/);
    assert.equal(run.lastOwnedGroupId(), null);
  });
});
