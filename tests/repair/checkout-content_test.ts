/**
 * m04-repair checkout-content tests: real, disposable Git checkouts prove the
 * trusted digest is stable for an unchanged checkout and changes for tracked,
 * untracked and ignored edits, staged index contents and HEAD moves; symlinks,
 * FIFOs and oversized sparse files are rejected; a hanging or unbounded Git
 * command is killed; a missing checkout or missing Git is null. Git fixtures
 * use the state suite's credential-free runners; no network calls exist here.
 */
import assert from "node:assert/strict";

import { checkoutContentCheckpoint } from "../../src/repair/checkout-content.ts";
import { gitRun, testGitEnv } from "../state/helpers.ts";

interface Fixture {
  root: string;
  dir: string;
  env: Record<string, string>;
}

async function makeFixture(): Promise<Fixture> {
  // Create the fixture under the test cwd so the `--allow-read=.` grant can
  // see it; resolve to an absolute root so every fixture path stays inside
  // the same grant.
  const tmp = await Deno.makeTempDir({
    dir: ".",
    prefix: "checkout-content-test-",
  });
  const root = await Deno.realPath(tmp);
  const dir = `${root}/checkout`;
  const home = `${root}/home`;
  await Deno.mkdir(home, { recursive: true });
  await Deno.mkdir(dir, { recursive: true });
  const env = testGitEnv(home);
  const init = await gitRun(dir, ["init", "-q"], env);
  if (!init.ok) {
    throw new Error(`git init failed (${init.code}): ${init.stderr}`);
  }
  // Every ordinary fixture starts from a real (empty) HEAD; an unborn HEAD
  // would make every `rev-parse HEAD` call fail before the test body runs.
  const seed = await gitRun(
    dir,
    ["commit", "-q", "--allow-empty", "-m", "seed"],
    env,
  );
  if (!seed.ok) {
    throw new Error(`seed commit failed (${seed.code}): ${seed.stderr}`);
  }
  return { root, dir, env };
}

async function git(fx: Fixture, args: string[]): Promise<void> {
  const result = await gitRun(fx.dir, args, fx.env);
  if (!result.ok) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.code}): ${result.stderr}`,
    );
  }
}

async function write(fx: Fixture, name: string, text: string): Promise<void> {
  const abs = `${fx.dir}/${name}`;
  await Deno.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(abs, text);
}

function checkpoint(fx: Fixture): Promise<string | null> {
  return checkoutContentCheckpoint(fx.dir);
}

/**
 * Test-owned executable fake `git` reached only through PATH. `body` must use
 * shell builtins only, so killing the fake never leaves descendants behind.
 */
async function makeFakeGit(root: string, body: string): Promise<string> {
  const bin = `${root}/fakebin`;
  await Deno.mkdir(bin, { recursive: true });
  await Deno.writeTextFile(`${bin}/git`, `#!/bin/sh\n${body}\n`);
  await Deno.chmod(`${bin}/git`, 0o755);
  return bin;
}

/** Read the exact fake-git PID the fixture wrote with the shell builtin `$$`. */
async function readFakePid(pidFile: string): Promise<number> {
  const pid = Number((await Deno.readTextFile(pidFile)).trim());
  assert.ok(
    Number.isInteger(pid) && pid > 1,
    `implausible fake-git PID ${pid}`,
  );
  return pid;
}

/** Probe one exact PID; `kill -0` is permitted by the test run grant. */
async function pidAlive(pid: number): Promise<boolean> {
  const probe = await new Deno.Command("kill", {
    args: ["-0", String(pid)],
  }).output();
  return probe.success;
}

/** Test cleanup: terminate a surviving fixture PID so no process is leaked. */
async function killPid(pid: number): Promise<void> {
  if (await pidAlive(pid)) {
    await new Deno.Command("kill", { args: ["-9", String(pid)] }).output();
  }
}

Deno.test("checkout-content: unchanged checkout is stable and read-only", async () => {
  const fx = await makeFixture();
  try {
    await write(fx, "src/app.ts", "export const v = 1;\n");
    await git(fx, ["add", "-A"]);
    await git(fx, ["commit", "-q", "-m", "initial"]);
    const first = await checkpoint(fx);
    assert.ok(first !== null, "expected a checkpoint digest");
    assert.match(first, /^[0-9a-f]{64}$/);
    const status = await gitRun(fx.dir, ["status", "--porcelain"], fx.env);
    assert.ok(status.ok, `git status failed: ${status.stderr}`);
    assert.equal(
      status.stdout,
      "",
      "checkpoint must not write the index or worktree",
    );
    const second = await checkpoint(fx);
    assert.equal(
      second,
      first,
      "unchanged checkout must produce the same digest",
    );
  } finally {
    await Deno.remove(fx.root, { recursive: true });
  }
});

Deno.test("checkout-content: tracked edit without a new HEAD changes the digest", async () => {
  const fx = await makeFixture();
  try {
    await write(fx, "a.txt", "v1\n");
    await git(fx, ["add", "-A"]);
    await git(fx, ["commit", "-q", "-m", "c1"]);
    const before = await checkpoint(fx);
    await write(fx, "a.txt", "v2\n");
    const after = await checkpoint(fx);
    assert.ok(before !== null && after !== null, "expected digests");
    assert.notEqual(after, before);
  } finally {
    await Deno.remove(fx.root, { recursive: true });
  }
});

Deno.test("checkout-content: untracked edit changes the digest", async () => {
  const fx = await makeFixture();
  try {
    await write(fx, "u.txt", "u1\n");
    const before = await checkpoint(fx);
    await write(fx, "u.txt", "u2\n");
    const after = await checkpoint(fx);
    assert.ok(before !== null && after !== null, "expected digests");
    assert.notEqual(after, before);
  } finally {
    await Deno.remove(fx.root, { recursive: true });
  }
});

Deno.test("checkout-content: ignored file edit changes the digest", async () => {
  const fx = await makeFixture();
  try {
    await write(fx, ".gitignore", "secret.ts\n");
    await write(fx, "secret.ts", "s1\n");
    const before = await checkpoint(fx);
    await write(fx, "secret.ts", "s2\n");
    const after = await checkpoint(fx);
    assert.ok(before !== null && after !== null, "expected digests");
    assert.notEqual(
      after,
      before,
      "ignored content must be part of the checkpoint",
    );
  } finally {
    await Deno.remove(fx.root, { recursive: true });
  }
});

Deno.test("checkout-content: staged index contents change the digest", async () => {
  const fx = await makeFixture();
  try {
    await write(fx, "a.txt", "v1\n");
    await git(fx, ["add", "-A"]);
    await git(fx, ["commit", "-q", "-m", "c1"]);
    const committed = await checkpoint(fx);
    await write(fx, "a.txt", "v2\n");
    await git(fx, ["add", "-A"]);
    const staged = await checkpoint(fx);
    await write(fx, "a.txt", "v1\n");
    const uncommitted = await checkpoint(fx);
    assert.ok(
      committed !== null && staged !== null && uncommitted !== null,
      "expected digests",
    );
    assert.notEqual(staged, committed);
    assert.notEqual(
      uncommitted,
      committed,
      "staged-but-uncommitted content must differ from the committed state",
    );
  } finally {
    await Deno.remove(fx.root, { recursive: true });
  }
});

Deno.test("checkout-content: HEAD change changes the digest", async () => {
  const fx = await makeFixture();
  try {
    await write(fx, "a.txt", "v1\n");
    await git(fx, ["add", "-A"]);
    await git(fx, ["commit", "-q", "-m", "c1"]);
    const before = await checkpoint(fx);
    await git(fx, ["commit", "-q", "--allow-empty", "-m", "c2"]);
    const after = await checkpoint(fx);
    assert.ok(before !== null && after !== null, "expected digests");
    assert.notEqual(after, before);
  } finally {
    await Deno.remove(fx.root, { recursive: true });
  }
});

Deno.test("checkout-content: symlink and non-regular entries are rejected", async () => {
  const fx = await makeFixture();
  try {
    await write(fx, "target.txt", "x\n");
    await git(fx, ["add", "-A"]);
    await git(fx, ["commit", "-q", "-m", "c1"]);
    assert.ok(
      await checkpoint(fx) !== null,
      "expected a healthy checkpoint before adding a symlink",
    );
    // Deno.symlink needs unscoped read/write grants, so the link is created
    // with the permitted ln subprocess; it is still a real symlink.
    const link = await new Deno.Command("ln", {
      args: ["-s", "target.txt", `${fx.dir}/link.txt`],
    }).output();
    assert.ok(
      link.success,
      `ln failed: ${new TextDecoder().decode(link.stderr)}`,
    );
    assert.equal(await checkpoint(fx), null, "a symlink must be rejected");
    await Deno.remove(`${fx.dir}/link.txt`);

    const fifo = await new Deno.Command("mkfifo", { args: [`${fx.dir}/fifo`] })
      .output();
    assert.ok(
      fifo.success,
      `mkfifo failed: ${new TextDecoder().decode(fifo.stderr)}`,
    );
    assert.equal(await checkpoint(fx), null, "a FIFO must be rejected");
    await Deno.remove(`${fx.dir}/fifo`);

    assert.ok(
      await checkpoint(fx) !== null,
      "expected a healthy checkpoint after removing every non-regular entry",
    );
  } finally {
    await Deno.remove(fx.root, { recursive: true });
  }
});

Deno.test("checkout-content: oversized sparse file is rejected without reading it", async () => {
  const fx = await makeFixture();
  try {
    await write(fx, "base.txt", "x\n");
    await git(fx, ["add", "-A"]);
    await git(fx, ["commit", "-q", "-m", "c1"]);
    assert.ok(
      await checkpoint(fx) !== null,
      "expected a healthy checkpoint before adding the oversized file",
    );
    const handle = await Deno.open(`${fx.dir}/big.bin`, {
      write: true,
      create: true,
    });
    try {
      // One byte past the per-file limit; sparse, so it takes no real space.
      await handle.seek(4 * 1024 * 1024 + 1, Deno.SeekMode.Start);
      await handle.write(new Uint8Array([1]));
    } finally {
      handle.close();
    }
    const started = performance.now();
    assert.equal(
      await checkpoint(fx),
      null,
      "an oversized file must be rejected",
    );
    const elapsed = performance.now() - started;
    assert.ok(
      elapsed < 3000,
      `oversized payload must not be read (took ${elapsed}ms)`,
    );
  } finally {
    await Deno.remove(fx.root, { recursive: true });
  }
});

Deno.test("checkout-content: a hanging git command is killed within its timeout", async () => {
  const fx = await makeFixture();
  const originalPath = Deno.env.get("PATH");
  const pidFile = `${fx.root}/hang.pid`;
  let pid: number | null = null;
  try {
    const bin = await makeFakeGit(
      fx.root,
      `printf '%s\\n' $$ > ${pidFile}\nwhile :; do :; done`,
    );
    Deno.env.set("PATH", `${bin}:${originalPath ?? ""}`);
    const started = performance.now();
    assert.equal(
      await checkpoint(fx),
      null,
      "a hanging git must fail the checkpoint",
    );
    const elapsed = performance.now() - started;
    assert.ok(
      elapsed < 4_000,
      `the hanging git must be killed at the per-command timeout, not at the snapshot limit (took ${elapsed}ms)`,
    );
    // The exact fake-git PID (shell builtins only, no descendants) must be
    // settled: killed and reaped before the checkpoint returned.
    pid = await readFakePid(pidFile);
    assert.equal(
      await pidAlive(pid),
      false,
      `the hanging fake git PID ${pid} must be settled`,
    );
  } finally {
    Deno.env.set("PATH", originalPath ?? "");
    if (pid !== null) await killPid(pid);
    await Deno.remove(fx.root, { recursive: true });
  }
});

Deno.test("checkout-content: unbounded git output is cut off at the bound", async () => {
  const line = "a".repeat(4_096);
  const fx = await makeFixture();
  const originalPath = Deno.env.get("PATH");
  const pidFile = `${fx.root}/flood.pid`;
  let pid: number | null = null;
  try {
    const bin = await makeFakeGit(
      fx.root,
      `printf '%s\\n' $$ > ${pidFile}\nline=${line}\nwhile :; do printf '%s\\n' "$line"; done`,
    );
    Deno.env.set("PATH", `${bin}:${originalPath ?? ""}`);
    const started = performance.now();
    assert.equal(
      await checkpoint(fx),
      null,
      "unbounded git output must fail the checkpoint",
    );
    const elapsed = performance.now() - started;
    assert.ok(
      elapsed < 4_000,
      `the flooding git must be killed at the output bound (took ${elapsed}ms)`,
    );
    // Same exact-PID settlement proof for the output-bound kill path.
    pid = await readFakePid(pidFile);
    assert.equal(
      await pidAlive(pid),
      false,
      `the flooding fake git PID ${pid} must be settled`,
    );
  } finally {
    Deno.env.set("PATH", originalPath ?? "");
    if (pid !== null) await killPid(pid);
    await Deno.remove(fx.root, { recursive: true });
  }
});

Deno.test("checkout-content: missing checkout or missing Git is null", async () => {
  const fx = await makeFixture();
  // A separate, genuinely uninitialized repository (no commits yet): unlike a
  // bare directory, it is a Git worktree on its own, so the failure comes from
  // the unborn HEAD and not from the test's read grant.
  const plainTmp = await Deno.makeTempDir({
    dir: ".",
    prefix: "checkout-content-plain-",
  });
  const plain = await Deno.realPath(plainTmp);
  const plainEnv = testGitEnv(`${plain}/home`);
  await Deno.mkdir(`${plain}/home`, { recursive: true });
  const plainInit = await gitRun(plain, ["init", "-q"], plainEnv);
  if (!plainInit.ok) {
    throw new Error(
      `plain init failed (${plainInit.code}): ${plainInit.stderr}`,
    );
  }
  const originalPath = Deno.env.get("PATH");
  try {
    assert.equal(
      await checkoutContentCheckpoint(`${fx.root}/missing`),
      null,
      "a missing checkout must be null",
    );
    assert.equal(
      await checkoutContentCheckpoint(plain),
      null,
      "an uninitialized repository must be null",
    );
    Deno.env.set("PATH", "");
    try {
      assert.equal(await checkpoint(fx), null, "missing Git must be null");
    } finally {
      Deno.env.set("PATH", originalPath ?? "");
    }
  } finally {
    await Deno.remove(plainTmp, { recursive: true });
    await Deno.remove(fx.root, { recursive: true });
  }
});
