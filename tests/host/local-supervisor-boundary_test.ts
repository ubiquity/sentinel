/**
 * The real inherited OS write boundary of the fixed local supervisor.
 *
 * This test invokes the exact production `defaultRunChild` once, on darwin
 * only, against a disposable absolute temp root beneath the test workspace. A
 * fake `repair:run` Deno task runs a credential-free child script (no model,
 * no GitHub, no live state) that attempts the exact authority writes the
 * boundary must deny and the exact private writes a real bounded local run
 * performs. The parent asserts structured probe results, surviving protected
 * bytes and the normal parent-side supervisor log.
 */

import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import type { LocalSupervisorChildInputV1 } from "../../src/host/local-supervisor.ts";
import { defaultRunChild } from "../../src/host/local-supervisor.ts";

const REVISION = "0123456789abcdef0123456789abcdef01234567" as GitSha;
const PROTECTED_TEXT = "protected supervisor authority\n";
const POINTER_TEXT = '{"version":"v1","kind":"local_active_runtime"}\n';
const LOCK_TEXT = "supervisor lock\n";
const DEADLINE_MS = 120_000;
/** The real timeout test: short, but ample for shell and sandbox startup. */
const TIMEOUT_DEADLINE_MS = 2_000;
const DESCENDANT_SLEEP_SECONDS = 30;

/** Every probe the sandboxed child runs, each expected to behave as stated. */
const PROBE_NAMES = [
  "status_write",
  "scratch_write",
  "checkouts_write",
  "tmp_host_write",
  "deno_dir_write",
  "pointer_overwrite",
  "pointer_remove",
  "pointer_rename",
  "receipts_remove",
  "receipts_rename",
  "supervisor_lock_overwrite",
  "supervisor_lock_remove",
  "runtimes_write",
  "runtimes_remove",
  "runtimes_rename",
  "outside_overwrite",
  "root_extra_write",
  "root_rename",
  "mutable_root_rename",
  "protected_hardlink",
  "protected_symlink_write",
  "mutable_hardlink",
  "shell_protected",
  "shell_mutable",
] as const;

/**
 * The child-program source. It derives every path from its own location, makes
 * one attempt per probe, records `true` only for the expected outcome, then
 * writes the structured results under its granted private temp directory.
 */
const PROBE_SOURCE = String.raw`
const root = import.meta.dirname;
const stateRoot = root + "/state";
const protectedPath = root + "/outside/protected.txt";

const results = {};
async function attempt(name, expected, fn) {
  let ran = false;
  try {
    await fn();
    ran = true;
  } catch {
    ran = false;
  }
  results[name] = expected === "allowed" ? ran : !ran;
}
async function shellWrite(path, text) {
  const command = new Deno.Command("/bin/sh", {
    args: ["-c", 'printf "%s" "$2" > "$1"', "sh", path, text],
  });
  const status = await command.output();
  if (status.code !== 0) throw new Error("shell write did not succeed");
}

await attempt("status_write", "allowed", async () => {
  await Deno.writeTextFile(stateRoot + "/status.json", "status\n");
});
await attempt("scratch_write", "allowed", async () => {
  await Deno.writeTextFile(stateRoot + "/state-scratch/probe.txt", "scratch\n");
});
await attempt("checkouts_write", "allowed", async () => {
  await Deno.writeTextFile(stateRoot + "/checkouts/probe.txt", "checkout\n");
});
await attempt("tmp_host_write", "allowed", async () => {
  await Deno.writeTextFile(stateRoot + "/tmp/host/probe.txt", "tmp\n");
});
await attempt("deno_dir_write", "allowed", async () => {
  await Deno.writeTextFile(stateRoot + "/deno/host/probe.txt", "cache\n");
});
await attempt("pointer_overwrite", "denied", async () => {
  await Deno.writeTextFile(stateRoot + "/active-runtime.json", "hacked\n");
});
await attempt("pointer_remove", "denied", async () => {
  await Deno.remove(stateRoot + "/active-runtime.json");
});
await attempt("pointer_rename", "denied", async () => {
  await Deno.rename(
    stateRoot + "/active-runtime.json",
    stateRoot + "/tmp/host/pointer-moved.json",
  );
});
await attempt("receipts_remove", "denied", async () => {
  await Deno.remove(stateRoot + "/local-releases", { recursive: true });
});
await attempt("receipts_rename", "denied", async () => {
  await Deno.rename(
    stateRoot + "/local-releases",
    stateRoot + "/tmp/host/receipts-moved",
  );
});
await attempt("supervisor_lock_overwrite", "denied", async () => {
  await Deno.writeTextFile(stateRoot + "/supervisor.lock", "hacked\n");
});
await attempt("supervisor_lock_remove", "denied", async () => {
  await Deno.remove(stateRoot + "/supervisor.lock");
});
await attempt("runtimes_write", "denied", async () => {
  await Deno.writeTextFile(stateRoot + "/runtimes/probe.txt", "hacked\n");
});
await attempt("runtimes_remove", "denied", async () => {
  await Deno.remove(stateRoot + "/runtimes", { recursive: true });
});
await attempt("runtimes_rename", "denied", async () => {
  await Deno.rename(
    stateRoot + "/runtimes",
    stateRoot + "/tmp/host/runtimes-moved",
  );
});
await attempt("outside_overwrite", "denied", async () => {
  await Deno.writeTextFile(protectedPath, "hacked\n");
});
await attempt("root_extra_write", "denied", async () => {
  await Deno.writeTextFile(stateRoot + "/evil.txt", "hacked\n");
});
await attempt("root_rename", "denied", async () => {
  await Deno.rename(stateRoot, root + "/moved-state");
});
await attempt("mutable_root_rename", "denied", async () => {
  await Deno.rename(
    stateRoot + "/checkouts",
    stateRoot + "/tmp/host/moved-checkouts",
  );
});
await attempt("protected_hardlink", "denied", async () => {
  await Deno.link(protectedPath, stateRoot + "/tmp/host/protected-hardlink");
});
await attempt("protected_symlink_write", "denied", async () => {
  const link = stateRoot + "/tmp/host/protected-link";
  await Deno.symlink(protectedPath, link);
  await Deno.writeTextFile(link, "hacked\n");
});
await attempt("mutable_hardlink", "allowed", async () => {
  const source = stateRoot + "/checkouts/hardlink-source.txt";
  const dest = stateRoot + "/tmp/host/hardlink-dest.txt";
  await Deno.writeTextFile(source, "mutable\n");
  await Deno.link(source, dest);
  const text = await Deno.readTextFile(dest);
  if (text !== "mutable\n") throw new Error("unexpected hardlink content");
});
await attempt("shell_protected", "denied", async () => {
  await shellWrite(protectedPath, "hacked");
});
await attempt("shell_mutable", "allowed", async () => {
  const path = stateRoot + "/tmp/host/shell-ok.txt";
  await shellWrite(path, "shell");
  const text = await Deno.readTextFile(path);
  if (text !== "shell") throw new Error("unexpected shell content");
});

await Deno.writeTextFile(
  stateRoot + "/tmp/host/boundary-results.json",
  JSON.stringify(results) + "\n",
);
console.log(JSON.stringify({ probes: Object.keys(results).length }));
`;

/**
 * A fake `deno` executable for the timeout test: it ignores the `task` argv,
 * forks a shell `sleep` descendant that inherits (and therefore holds open)
 * the captured pipes, persists that descendant's pid under the granted private
 * TMPDIR, and then hangs so only the deadline can end the run.
 */
const FAKE_DENO_SOURCE = String.raw`#!/bin/sh
sleep ${DESCENDANT_SLEEP_SECONDS} &
echo $! > "$TMPDIR/descendant.pid"
sleep ${DESCENDANT_SLEEP_SECONDS}
`;

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test({
  name:
    "local supervisor boundary: the real sandboxed child cannot write supervisor authority",
  ignore: Deno.build.os !== "darwin",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const root =
      `${Deno.cwd()}/.local-supervisor-boundary-${crypto.randomUUID()}`;
    const stateRoot = `${root}/state`;
    const runtimeDir = `${root}/runtime`;
    const outsideDir = `${root}/outside`;
    const homeDir = `${root}/home`;
    const protectedPath = `${outsideDir}/protected.txt`;
    const resultsPath = `${stateRoot}/tmp/host/boundary-results.json`;
    try {
      for (const dir of [root, runtimeDir, outsideDir, homeDir, stateRoot]) {
        await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
      }
      await Deno.writeTextFile(protectedPath, PROTECTED_TEXT);
      await Deno.writeTextFile(
        `${stateRoot}/active-runtime.json`,
        POINTER_TEXT,
      );
      await Deno.writeTextFile(`${stateRoot}/supervisor.lock`, LOCK_TEXT);
      await Deno.mkdir(`${stateRoot}/local-releases`, { mode: 0o700 });
      await Deno.mkdir(`${stateRoot}/runtimes`, { mode: 0o700 });
      await Deno.writeTextFile(`${root}/probe.ts`, PROBE_SOURCE);
      await Deno.writeTextFile(
        `${runtimeDir}/deno.json`,
        JSON.stringify({
          tasks: {
            "repair:run":
              `${Deno.execPath()} run -A --no-config --no-lock ${root}/probe.ts`,
          },
        }),
      );

      const input: LocalSupervisorChildInputV1 = {
        stateRoot,
        runtimeDir,
        revision: REVISION,
        taskName: "repair:run",
        env: {
          HOME: homeDir,
          PATH: Deno.env.get("PATH") ?? "",
          GITHUB_TOKEN: "",
          UOS_AI_TOKEN: "",
        },
        denoExecutable: Deno.execPath(),
        deadlineMs: DEADLINE_MS,
        logPath: `${stateRoot}/supervisor-logs/unused.log`,
      };
      const result = await defaultRunChild(input);
      assert.equal(
        result.settled,
        true,
        "the sandboxed real child must settle",
      );
      assert.equal(result.exitCode, 0, "the sandboxed real child must exit 0");

      const results = JSON.parse(
        await Deno.readTextFile(resultsPath),
      ) as Record<string, boolean>;
      assert.deepEqual(
        Object.keys(results).sort(),
        [...PROBE_NAMES].sort(),
        "every boundary probe must report a structured result",
      );
      for (const name of PROBE_NAMES) {
        assert.equal(results[name], true, `boundary probe ${name} failed`);
      }

      assert.equal(
        await Deno.readTextFile(protectedPath),
        PROTECTED_TEXT,
        "the protected outside file must keep its original bytes",
      );
      assert.equal(
        await Deno.readTextFile(`${stateRoot}/active-runtime.json`),
        POINTER_TEXT,
        "the active runtime pointer must keep its original bytes",
      );
      assert.equal(
        await Deno.readTextFile(`${stateRoot}/supervisor.lock`),
        LOCK_TEXT,
        "the supervisor lock must keep its original bytes",
      );
      assert.equal(
        await exists(`${stateRoot}/evil.txt`),
        false,
        "no unlisted state root entry may appear",
      );
      assert.equal(
        await exists(`${root}/moved-state`),
        false,
        "the state root may never be replaced",
      );
      assert.ok(
        (await Deno.lstat(`${stateRoot}/checkouts`)).isDirectory,
        "a mutable top-level directory may never be replaced",
      );
      assert.ok(
        (await Deno.lstat(`${stateRoot}/local-releases`)).isDirectory,
        "the receipt directory may never be replaced",
      );
      assert.ok(
        (await Deno.lstat(`${stateRoot}/runtimes`)).isDirectory,
        "the runtime directory may never be replaced",
      );
      assert.equal(
        await Deno.readTextFile(`${stateRoot}/status.json`),
        "status\n",
        "the child writes its own bounded status receipt",
      );

      const logDir = `${stateRoot}/supervisor-logs`;
      const logs: string[] = [];
      for await (const entry of Deno.readDir(logDir)) logs.push(entry.name);
      assert.equal(
        logs.length,
        1,
        "the parent writes exactly one child log outside the sandbox",
      );
      const logText = await Deno.readTextFile(`${logDir}/${logs[0]}`);
      assert.ok(
        logText.includes("stdout:") && logText.includes('"probes"'),
        "the parent-side child log captures the real child stdout",
      );
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "local supervisor boundary: a child deadline ends the whole sandboxed group",
  ignore: Deno.build.os !== "darwin",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const root =
      `${Deno.cwd()}/.local-supervisor-timeout-${crypto.randomUUID()}`;
    const stateRoot = `${root}/state`;
    const runtimeDir = `${root}/runtime`;
    const fakeDeno = `${root}/fake-deno`;
    const descendantPidPath = `${stateRoot}/tmp/host/descendant.pid`;
    try {
      await Deno.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
      await Deno.mkdir(stateRoot, { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(fakeDeno, FAKE_DENO_SOURCE);
      await Deno.chmod(fakeDeno, 0o755);
      const input: LocalSupervisorChildInputV1 = {
        stateRoot,
        runtimeDir,
        revision: REVISION,
        taskName: "repair:run",
        env: {
          HOME: `${root}/home`,
          PATH: Deno.env.get("PATH") ?? "",
          GITHUB_TOKEN: "",
          UOS_AI_TOKEN: "",
        },
        denoExecutable: fakeDeno,
        deadlineMs: TIMEOUT_DEADLINE_MS,
        logPath: `${stateRoot}/supervisor-logs/unused.log`,
      };

      const startedAt = Date.now();
      const result = await defaultRunChild(input);
      const elapsedMs = Date.now() - startedAt;
      assert.equal(result.settled, true, "the timed-out run must still settle");
      assert.equal(result.exitCode, null, "a timeout is never a success");
      assert.ok(
        elapsedMs < TIMEOUT_DEADLINE_MS + 15_000,
        `the bounded run returned after ${elapsedMs}ms`,
      );

      // The descendant's own pid was persisted inside the granted private temp
      // directory; it must not exist after the deadline settlement.
      const descendantPid = Number(
        (await Deno.readTextFile(descendantPidPath)).trim(),
      );
      assert.ok(
        Number.isSafeInteger(descendantPid) && descendantPid > 0,
        "the descendant pid must be persisted",
      );
      const probe = await new Deno.Command("/bin/kill", {
        args: ["-0", String(descendantPid)],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).output();
      assert.notEqual(
        probe.code,
        0,
        "the owned descendant must be gone after the bounded return",
      );
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});
