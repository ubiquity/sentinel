// pushHead suite: exact expected-ref CAS, fast-forward-only publication
// through the trusted git executor, ambiguous-effect reconciliation by
// rereading the authoritative remote identity, and real local Git behavior
// against a disposable bare repository. No credentials appear anywhere: the
// remote is a local bare repo and git runs with a clean environment.
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import type { PortResultV1 } from "../../src/contracts/ports.ts";
import { DenoGitExecutor } from "../../src/github/git-executor.ts";
import type {
  GitExecutorV1,
  GitPushResultV1,
  GitRunResultV1,
} from "../../src/github/git-executor.ts";
import { FakeGitExecutor, makePort, SHA1, SHA2, SHA3 } from "./helpers.ts";

async function gitRun(
  cwd: string,
  args: string[],
  env: Record<string, string>,
): Promise<GitRunResultV1> {
  const result = await new Deno.Command("git", {
    args,
    cwd,
    clearEnv: true,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    ok: result.success,
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/github\/push_test\.ts$/,
  "",
);

function gitEnv(home: string): Record<string, string> {
  return {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "sentinel-github-test",
    GIT_AUTHOR_EMAIL: "sentinel-github-test@localhost",
    GIT_COMMITTER_NAME: "sentinel-github-test",
    GIT_COMMITTER_EMAIL: "sentinel-github-test@localhost",
  };
}

interface GitCtx {
  tmp: string;
  env: Record<string, string>;
  work: string;
  bare: string;
  cleanup(): Promise<void>;
}

async function makeGitCtx(): Promise<GitCtx> {
  const tmp = await Deno.makeTempDir({
    prefix: "sentinel-github-push-",
    dir: ROOT,
  });
  const env = gitEnv(`${tmp}/home`);
  await Deno.mkdir(`${tmp}/home`, { recursive: true });
  const bare = `${tmp}/remote.git`;
  const work = `${tmp}/work`;
  await Deno.mkdir(work, { recursive: true });
  const initBare = await gitRun(tmp, ["init", "-q", "--bare", bare], env);
  if (!initBare.ok) throw new Error(`bare init failed: ${initBare.stderr}`);
  const initWork = await gitRun(tmp, ["init", "-q", work], env);
  if (!initWork.ok) throw new Error(`work init failed: ${initWork.stderr}`);
  const remote = await gitRun(work, ["remote", "add", "origin", bare], env);
  if (!remote.ok) throw new Error(`remote add failed: ${remote.stderr}`);
  return {
    tmp,
    env,
    work,
    bare,
    cleanup: async () => {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    },
  };
}

async function commitIn(
  work: string,
  env: Record<string, string>,
  name: string,
): Promise<GitSha> {
  await Deno.writeTextFile(`${work}/${name}.txt`, name);
  const add = await gitRun(work, ["add", "-A"], env);
  if (!add.ok) throw new Error(`add failed: ${add.stderr}`);
  const commit = await gitRun(
    work,
    ["commit", "-q", "-m", name],
    env,
  );
  if (!commit.ok) throw new Error(`commit failed: ${commit.stderr}`);
  const rev = await gitRun(work, ["rev-parse", "HEAD"], env);
  if (!rev.ok) throw new Error(`rev-parse failed: ${rev.stderr}`);
  return rev.stdout.trim() as GitSha;
}

async function remoteHead(
  bare: string,
  env: Record<string, string>,
  ref: string,
): Promise<GitSha | null> {
  const result = await gitRun(
    bare,
    ["--git-dir", bare, "rev-parse", "--verify", `--quiet`, ref],
    env,
  );
  if (!result.ok) return null;
  return result.stdout.trim() as GitSha;
}

Deno.test("pushHead: new deterministic ref publishes exactly once", async () => {
  const git = new FakeGitExecutor();
  const { port, transport } = makePort({ git });
  const result = await port.pushHead("heads/sentinel/fix-1", SHA1, null);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value, "applied");
  assert.equal(git.remoteReads.length, 1);
  assert.equal(git.remoteReads[0].ref, "heads/sentinel/fix-1");
  assert.deepEqual(git.pushes, [{
    ref: "heads/sentinel/fix-1",
    sha: SHA1,
    expectedRef: null,
  }]);
  // No remote side read was needed (branch was absent) — the port performed
  // zero HTTP requests.
  assert.equal(transport.requests.length, 0);
});

Deno.test("pushHead: expected head must match and the push must be a fast-forward", async () => {
  const git = new FakeGitExecutor();
  git.refs.set("heads/sentinel/fix-1", SHA1);
  git.refs.set("heads/sentinel/fix-2", null);
  const { port } = makePort({ git });
  const applied = await port.pushHead("heads/sentinel/fix-1", SHA2, SHA1);
  assert.ok(applied.ok);
  if (!applied.ok) return;
  assert.equal(applied.value, "applied");
  assert.deepEqual(git.ancestry[0], {
    ancestor: SHA1,
    descendant: SHA2,
    result: true,
  });

  // Expected ref absent: conflict (the branch should exist but does not).
  const missing = await port.pushHead("heads/sentinel/fix-2", SHA2, SHA1);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.kind, "conflict");

  // New deterministic ref cannot overwrite an existing one.
  const overwrite = await port.pushHead("heads/sentinel/fix-1", SHA2, null);
  assert.equal(overwrite.ok, false);
  if (!overwrite.ok) assert.equal(overwrite.error.kind, "conflict");

  // Non-fast-forward candidate: conflict before any push.
  git.ancestryEvery = false;
  const nonFf = await port.pushHead("heads/sentinel/fix-1", SHA3, SHA1);
  assert.equal(nonFf.ok, false);
  if (!nonFf.ok) assert.equal(nonFf.error.kind, "conflict");
  assert.equal(git.pushes.length, 1, "no push after a proved non-fast-forward");
});

Deno.test("pushHead: executor rejection kinds map to typed errors", async () => {
  const git = new FakeGitExecutor();
  git.refs.set("heads/x", SHA1);
  git.nextPush = { status: "non_fast_forward" };
  const { port } = makePort({ git });
  const nonFf = await port.pushHead("heads/x", SHA2, SHA1);
  assert.equal(nonFf.ok, false);
  if (!nonFf.ok) assert.equal(nonFf.error.kind, "conflict");

  git.nextPush = { status: "missing_object" };
  const missing = await port.pushHead("heads/x", SHA2, SHA1);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.kind, "invalid");

  git.nextPush = { status: "rejected" };
  const rejected = await port.pushHead("heads/x", SHA2, SHA1);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.kind, "conflict");
});

Deno.test("pushHead: ambiguous effect is reconciled by rereading the remote identity", async () => {
  // The push applied but the response was lost.
  const applied = new FakeGitExecutor();
  applied.refs.set("heads/x", SHA1);
  applied.nextPush = { status: "ambiguous" };
  applied.ambiguousAppliesEffect = true; // the effect is visible on the authoritative ref
  const { port } = makePort({ git: applied });
  const result = await port.pushHead("heads/x", SHA2, SHA1);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value, "applied");
  assert.equal(applied.remoteReads.length, 2);

  // Remote unchanged: the effect is unconfirmed and stays ambiguous.
  const unconfirmed = new FakeGitExecutor();
  unconfirmed.refs.set("heads/x", SHA1);
  unconfirmed.nextPush = { status: "ambiguous" };
  unconfirmed.ambiguousAppliesEffect = false;
  const { port: port2 } = makePort({ git: unconfirmed });
  const result2 = await port2.pushHead("heads/x", SHA2, SHA1);
  assert.ok(result2.ok);
  if (!result2.ok) return;
  assert.equal(result2.value, "ambiguous");
});

Deno.test("DenoGitExecutor: real local push, fast-forward rule and exact identity", async () => {
  const ctx = await makeGitCtx();
  try {
    const base = await commitIn(ctx.work, ctx.env, "base");
    const candidate = await commitIn(ctx.work, ctx.env, "candidate");
    const executor = new DenoGitExecutor({
      localDir: ctx.work,
      remoteUrl: ctx.bare,
      gitHome: `${ctx.tmp}/home`,
    });

    // Fresh branch: push applies and the remote identity is exact.
    const pushed = await executor.push(
      "heads/sentinel/fix-1",
      candidate,
      null,
    );
    assert.ok(pushed.ok);
    if (!pushed.ok) return;
    assert.deepEqual(pushed.value, { status: "applied" });
    const head = await remoteHead(
      ctx.bare,
      ctx.env,
      "refs/heads/sentinel/fix-1",
    );
    assert.equal(head, candidate);

    const read = await executor.readRemoteRef("heads/sentinel/fix-1");
    assert.ok(read.ok);
    if (read.ok) assert.equal(read.value, candidate);

    // Ancestry is exact: the base is an ancestor of the candidate.
    const ancestor = await executor.isAncestor(base, candidate);
    assert.ok(ancestor.ok);
    if (ancestor.ok) assert.equal(ancestor.value, true);
    const reverse = await executor.isAncestor(candidate, base);
    assert.ok(reverse.ok);
    if (reverse.ok) assert.equal(reverse.value, false);

    // A competing branch (not descending) cannot overwrite: ordinary push is
    // rejected as non-fast-forward at the remote. The competing commits live
    // in a separate repository so they share no parent with the candidate.
    const workB = `${ctx.tmp}/workB`;
    await Deno.mkdir(workB, { recursive: true });
    const initB = await gitRun(ctx.tmp, ["init", "-q", workB], ctx.env);
    if (!initB.ok) throw new Error(`workB init failed: ${initB.stderr}`);
    const executorB = new DenoGitExecutor({
      localDir: workB,
      remoteUrl: ctx.bare,
      gitHome: `${ctx.tmp}/home`,
    });
    const unrelatedTip = await commitIn(workB, ctx.env, "unrelated");
    const rejected = await executorB.push(
      "heads/sentinel/fix-1",
      unrelatedTip,
      candidate,
    );
    assert.ok(rejected.ok);
    if (!rejected.ok) return;
    assert.equal(rejected.value.status, "non_fast_forward");
    const sameHead = await remoteHead(
      ctx.bare,
      ctx.env,
      "refs/heads/sentinel/fix-1",
    );
    assert.equal(sameHead, candidate);
  } finally {
    await ctx.cleanup();
  }
});

// Compatible with the previous tests: the fake scripts below simulate race
// movement between the port's prechecks and the actual push transaction.
async function writeExecutable(
  dir: string,
  name: string,
  content: string,
): Promise<string> {
  const path = `${dir}/${name}`;
  await Deno.writeTextFile(path, content);
  await Deno.chmod(path, 0o700);
  return path;
}

/** Wraps the real executor and moves the remote ref once the first exact
 * identity read has completed (the race window between precheck and push). */
class MovingRemoteExecutor implements GitExecutorV1 {
  constructor(
    private readonly inner: GitExecutorV1,
    private readonly move: () => Promise<void>,
  ) {}
  private reads = 0;
  async readRemoteRef(ref: string): Promise<PortResultV1<GitSha | null>> {
    const read = await this.inner.readRemoteRef(ref);
    this.reads++;
    if (this.reads === 1 && read.ok) await this.move();
    return read;
  }
  isAncestor(
    ancestor: GitSha,
    descendant: GitSha,
  ): Promise<PortResultV1<boolean>> {
    return this.inner.isAncestor(ancestor, descendant);
  }
  push(
    ref: string,
    sha: GitSha,
    expectedRef: GitSha | null,
  ): Promise<PortResultV1<GitPushResultV1>> {
    return this.inner.push(ref, sha, expectedRef);
  }
}

Deno.test("pushHead: atomic exact-ref guard rejects a race moved before the push transaction", async () => {
  const ctx = await makeGitCtx();
  try {
    const base = await commitIn(ctx.work, ctx.env, "base");
    const intermediate = await commitIn(ctx.work, ctx.env, "intermediate");
    const candidate = await commitIn(ctx.work, ctx.env, "candidate");
    // Seed the bare repository with the objects so `update-ref` below is a
    // pure ref change (no objects travel over the network).
    const seed = await gitRun(
      ctx.work,
      ["push", ctx.bare, `${candidate}:refs/heads/objects`],
      ctx.env,
    );
    if (!seed.ok) throw new Error(`seed push failed: ${seed.stderr}`);
    const moveTo = async (ref: string, value: GitSha): Promise<void> => {
      const moved = await gitRun(
        ctx.bare,
        ["--git-dir", ctx.bare, "update-ref", ref, value],
        ctx.env,
      );
      if (!moved.ok) throw new Error(`update-ref failed: ${moved.stderr}`);
    };

    // Expected existing base -> intermediate before the transaction: the
    // guard rejects and the candidate is never applied.
    await moveTo("refs/heads/race", base);
    const racy = new MovingRemoteExecutor(
      new DenoGitExecutor({
        localDir: ctx.work,
        remoteUrl: ctx.bare,
        gitHome: `${ctx.tmp}/home`,
      }),
      () => moveTo("refs/heads/race", intermediate),
    );
    const { port } = makePort({ git: racy });
    const moved = await port.pushHead("heads/race", candidate, base);
    assert.equal(moved.ok, false);
    if (!moved.ok) assert.equal(moved.error.kind, "conflict");
    const afterRace = await remoteHead(ctx.bare, ctx.env, "refs/heads/race");
    assert.equal(afterRace, intermediate);
    const candidateApplied = await remoteHead(
      ctx.bare,
      ctx.env,
      "refs/heads/race",
    );
    assert.notEqual(candidateApplied, candidate);

    // Expected absent -> concurrently created base: the guard sees a value
    // where absence was expected and rejects.
    await gitRun(ctx.bare, ["update-ref", "-d", "refs/heads/race"], ctx.env);
    const created = new MovingRemoteExecutor(
      new DenoGitExecutor({
        localDir: ctx.work,
        remoteUrl: ctx.bare,
        gitHome: `${ctx.tmp}/home`,
      }),
      () => moveTo("refs/heads/race", base),
    );
    const { port: port2 } = makePort({ git: created });
    const conflict = await port2.pushHead("heads/race", candidate, null);
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.error.kind, "conflict");
    const afterCreate = await remoteHead(ctx.bare, ctx.env, "refs/heads/race");
    assert.equal(afterCreate, base);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("pushHead: after-advertisement movement is refused by receive-pack", async () => {
  const ctx = await makeGitCtx();
  try {
    const base = await commitIn(ctx.work, ctx.env, "base");
    const intermediate = await commitIn(ctx.work, ctx.env, "intermediate");
    const candidate = await commitIn(ctx.work, ctx.env, "candidate");
    // Seed the bare repository with the objects (pure ref change below).
    const seed = await gitRun(
      ctx.work,
      ["push", ctx.bare, `${candidate}:refs/heads/objects`],
      ctx.env,
    );
    if (!seed.ok) throw new Error(`seed push failed: ${seed.stderr}`);
    const setUp = await gitRun(
      ctx.bare,
      ["--git-dir", ctx.bare, "update-ref", "refs/heads/race", base],
      ctx.env,
    );
    if (!setUp.ok) throw new Error(`update-ref failed: ${setUp.stderr}`);
    // The test-only hook augmentation moves the ref AFTER the guard validated
    // the advertised value; receive-pack then enforces the stale advertised
    // value atomically and the candidate must not be applied.
    const executor = new DenoGitExecutor({
      localDir: ctx.work,
      remoteUrl: ctx.bare,
      gitHome: `${ctx.tmp}/home`,
      prePushHookExtra:
        `git --git-dir='${ctx.bare}' update-ref refs/heads/race ` +
        `'${intermediate}' '${base}'`,
    });
    const { port } = makePort({ git: executor });
    const result = await port.pushHead("heads/race", candidate, base);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, "conflict");
    const head = await remoteHead(ctx.bare, ctx.env, "refs/heads/race");
    assert.equal(head, intermediate);
    assert.notEqual(head, candidate);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("pushHead: lost push response reconciles by exact observed identity", async () => {
  const ctx = await makeGitCtx();
  try {
    await commitIn(ctx.work, ctx.env, "base");
    const candidate = await commitIn(ctx.work, ctx.env, "candidate");
    const fakeGit = await writeExecutable(
      ctx.tmp,
      "fake-git",
      `#!/bin/sh
real=$(command -v git)
is_push=0
for arg in "$@"; do
  if [ "$arg" = "push" ]; then is_push=1; fi
done
if [ "$is_push" = "1" ]; then
  "$real" "$@"
  code=$?
  if [ "$code" = "0" ]; then
    exit 3
  fi
  exit "$code"
fi
exec "$real" "$@"
`,
    );
    const executor = new DenoGitExecutor({
      localDir: ctx.work,
      remoteUrl: ctx.bare,
      gitHome: `${ctx.tmp}/home`,
      gitPath: fakeGit,
    });
    const { port } = makePort({ git: executor });
    const applied = await port.pushHead("heads/race", candidate, null);
    assert.ok(applied.ok);
    if (!applied.ok) return;
    assert.equal(applied.value, "applied");
    const head = await remoteHead(ctx.bare, ctx.env, "refs/heads/race");
    assert.equal(head, candidate);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("DenoGitExecutor: bounded output and hanging descendants settle", async () => {
  const ctx = await makeGitCtx();
  try {
    // Infinite output (they also never exit on their own): the output byte
    // bound terminates the run promptly.
    const noisy = await writeExecutable(
      ctx.tmp,
      "noisy-git",
      `#!/bin/sh
while :; do
  echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
done
`,
    );
    const overflowExec = new DenoGitExecutor({
      localDir: ctx.work,
      remoteUrl: ctx.bare,
      gitHome: `${ctx.tmp}/home`,
      gitPath: noisy,
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
    });
    let started = Date.now();
    const overflow = await overflowExec.isAncestor(SHA1, SHA2);
    assert.ok(!overflow.ok);
    if (!overflow.ok) assert.equal(overflow.error.kind, "unavailable");
    assert.ok(Date.now() - started < 10_000, "overflow settled promptly");

    // A direct child that forks a long-lived descendant holding the pipes:
    // the deadline terminates the run and the abandoned streams cannot hang
    // the caller.
    const hanging = await writeExecutable(
      ctx.tmp,
      "hanging-git",
      `#!/bin/sh
( sleep 30 ) &
kid=$!
trap 'kill $kid 2>/dev/null' TERM INT
wait
`,
    );
    const hangExec = new DenoGitExecutor({
      localDir: ctx.work,
      remoteUrl: ctx.bare,
      gitHome: `${ctx.tmp}/home`,
      gitPath: hanging,
      timeoutMs: 300,
    });
    started = Date.now();
    const hung = await hangExec.isAncestor(SHA1, SHA2);
    assert.ok(!hung.ok);
    if (!hung.ok) assert.equal(hung.error.kind, "unavailable");
    assert.ok(Date.now() - started < 10_000, "hang settled promptly");

    // A descendant that never handles the parent's death (no trap): the
    // owned process group must be TERM'd then KILL'd, not orphaned.
    const kidFile = `${ctx.tmp}/uncooperative-kid.pid`;
    const orphan = await writeExecutable(
      ctx.tmp,
      "orphan-kid-git",
      `#!/bin/sh
sleep 30 &
echo $! > '${kidFile}'
wait
`,
    );
    const orphanExec = new DenoGitExecutor({
      localDir: ctx.work,
      remoteUrl: ctx.bare,
      gitHome: `${ctx.tmp}/home`,
      gitPath: orphan,
      timeoutMs: 300,
    });
    started = Date.now();
    const orphaned = await orphanExec.isAncestor(SHA1, SHA2);
    assert.ok(!orphaned.ok);
    if (!orphaned.ok) assert.equal(orphaned.error.kind, "unavailable");
    assert.ok(Date.now() - started < 10_000, "orphan hang settled promptly");
    const kidPid = Number((await Deno.readTextFile(kidFile)).trim());
    assert.ok(Number.isSafeInteger(kidPid) && kidPid > 0);
    let kidAlive = true;
    for (let attempt = 0; attempt < 20 && kidAlive; attempt++) {
      try {
        Deno.kill(kidPid, 0);
      } catch (error) {
        if (
          error instanceof Error && error.name === "NotCapable"
        ) {
          throw new Error(
            "process-group settle verification needs --allow-run",
          );
        }
        kidAlive = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(kidAlive, false, "uncooperative descendant was settled");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("pushHead: real executor end-to-end conflict and applied reconcile", async () => {
  const ctx = await makeGitCtx();
  try {
    const base = await commitIn(ctx.work, ctx.env, "base");
    const candidate = await commitIn(ctx.work, ctx.env, "candidate");
    const executor = new DenoGitExecutor({
      localDir: ctx.work,
      remoteUrl: ctx.bare,
      gitHome: `${ctx.tmp}/home`,
    });
    const { port } = makePort({ git: executor });
    const applied = await port.pushHead(
      "heads/sentinel/fix-1",
      candidate,
      null,
    );
    assert.ok(applied.ok);
    if (!applied.ok) return;
    assert.equal(applied.value, "applied");

    // Expected ref mismatch (a competing writer moved the branch).
    const conflict = await port.pushHead(
      "heads/sentinel/fix-1",
      candidate,
      base,
    );
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.error.kind, "conflict");

    // Fast-forward to a descendant with the exact current head succeeds.
    const descendant = await commitIn(ctx.work, ctx.env, "descendant");
    const ff = await port.pushHead(
      "heads/sentinel/fix-1",
      descendant,
      candidate,
    );
    assert.ok(ff.ok);
    if (!ff.ok) return;
    assert.equal(ff.value, "applied");
    const head = await remoteHead(
      ctx.bare,
      ctx.env,
      "refs/heads/sentinel/fix-1",
    );
    assert.equal(head, descendant);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test(
  "pushHead: an already-equal remote SHA is applied from observation without local objects",
  async () => {
    const git = new FakeGitExecutor();
    git.refs.set("heads/sentinel/repair/issue-1", SHA2);
    // The candidate object is NOT available locally: any ancestry question
    // would answer false, but the equal-ref fast path must never ask it.
    git.ancestryEvery = false;
    const { port } = makePort({ git });
    const applied = await port.pushHead(
      "heads/sentinel/repair/issue-1",
      SHA2,
      SHA2,
    );
    assert.ok(applied.ok);
    if (!applied.ok) return;
    assert.equal(applied.value, "applied");
    assert.equal(git.remoteReads.length, 1);
    assert.equal(git.ancestry.length, 0, "no local ancestry check");
    assert.equal(git.pushes.length, 0, "no push for an already-published ref");

    // Expected-ref semantics stay strict: a moved or absent ref conflicts.
    const moved = await port.pushHead(
      "heads/sentinel/repair/issue-1",
      SHA3,
      SHA1,
    );
    assert.equal(moved.ok, false);
    if (!moved.ok) assert.equal(moved.error.kind, "conflict");
    const absent = await port.pushHead(
      "heads/sentinel/repair/issue-1",
      SHA2,
      null,
    );
    assert.equal(absent.ok, false);
    if (!absent.ok) assert.equal(absent.error.kind, "conflict");
    assert.equal(git.ancestry.length, 0, "no ancestry after conflicts");
    assert.equal(git.pushes.length, 0, "no push after conflicts");
  },
);
