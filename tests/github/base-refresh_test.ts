/**
 * Deterministic candidate-base refresh: the REAL DenoGitExecutor over real
 * temporary Git repositories plus the REAL local generation adapter composed
 * in `src/host/local.ts`. No network, no model, no credentials and no GitHub
 * write: only the read-only observation capability is a bounded stub, and the
 * git integration runs against disposable local repositories.
 */
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import { BASE_REFRESH_CONFLICT_DETAIL } from "../../src/contracts/ports.ts";
import type {
  GitHubPullRequestV1,
  GitHubRefV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { DenoGitExecutor } from "../../src/github/git-executor.ts";
import { createPrepareBaseRefresh } from "../../src/host/local.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/github\/base-refresh_test\.ts$/,
  "",
);
const TRUSTED_PATH = Deno.env.get("PATH") ?? "/usr/bin:/bin";
const TRUSTED_AUTHOR = "sentinel-owner";
const BASE_BRANCH = "development";
const BRANCH = "sentinel/repair/issue-1";
const OTHER_SHA = "1234567890abcdef1234567890abcdef12345678" as GitSha;

async function gitRun(
  cwd: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
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

function gitEnv(home: string): Record<string, string> {
  return {
    PATH: TRUSTED_PATH,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "sentinel-base-refresh-test",
    GIT_AUTHOR_EMAIL: "sentinel-base-refresh-test@localhost",
    GIT_COMMITTER_NAME: "sentinel-base-refresh-test",
    GIT_COMMITTER_EMAIL: "sentinel-base-refresh-test@localhost",
  };
}

interface RefreshCtxV1 {
  tmp: string;
  env: Record<string, string>;
  repo: string;
  oldBase: GitSha;
  candidate: GitSha;
  newBase: GitSha;
  conflictingBase: GitSha;
  git(args: string[]): Promise<{ ok: boolean; stdout: string }>;
  cleanup(): Promise<void>;
}

async function commitIn(
  repo: string,
  env: Record<string, string>,
  name: string,
  content: string,
): Promise<GitSha> {
  await Deno.writeTextFile(`${repo}/${name}`, content);
  assert.ok((await gitRun(repo, ["add", "-A"], env)).ok);
  assert.ok((await gitRun(repo, ["commit", "-q", "-m", name], env)).ok);
  const rev = await gitRun(repo, ["rev-parse", "HEAD"], env);
  assert.ok(rev.ok);
  return rev.stdout.trim() as GitSha;
}

async function makeRefreshCtx(): Promise<RefreshCtxV1> {
  const tmp = await Deno.makeTempDir({
    prefix: "sentinel-base-refresh-",
    dir: ROOT,
  });
  try {
    const env = gitEnv(`${tmp}/home`);
    await Deno.mkdir(`${tmp}/home`, { recursive: true });
    const repo = `${tmp}/repo`;
    assert.ok((await gitRun(tmp, ["init", "-q", repo], env)).ok);
    assert.ok(
      (await gitRun(repo, ["checkout", "-q", "-b", BASE_BRANCH], env)).ok,
    );
    const oldBase = await commitIn(repo, env, "shared.txt", "shared\n");
    assert.ok(
      (await gitRun(repo, ["checkout", "-q", "-b", "candidate"], env)).ok,
    );
    const candidate = await commitIn(repo, env, "shared.txt", "candidate\n");
    assert.ok((await gitRun(repo, ["checkout", "-q", BASE_BRANCH], env)).ok);
    const newBase = await commitIn(repo, env, "base.txt", "new base\n");
    // A conflicting base branch: it diverges from the OLD base and edits the
    // same file the candidate edited.
    assert.ok(
      (await gitRun(repo, ["checkout", "-q", "-b", "conflict", oldBase], env))
        .ok,
    );
    const conflictingBase = await commitIn(
      repo,
      env,
      "shared.txt",
      "conflicting base\n",
    );
    assert.ok((await gitRun(repo, ["checkout", "-q", BASE_BRANCH], env)).ok);
    return {
      tmp,
      env,
      repo,
      oldBase,
      candidate,
      newBase,
      conflictingBase,
      git: async (args) => {
        const result = await gitRun(repo, args, env);
        return { ok: result.ok, stdout: result.stdout };
      },
      cleanup: async () => {
        await Deno.remove(tmp, { recursive: true }).catch(() => {});
      },
    };
  } catch (error) {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
    throw error;
  }
}

function executor(ctx: RefreshCtxV1): DenoGitExecutor {
  return new DenoGitExecutor({
    localDir: ctx.repo,
    remoteUrl: `file://${ctx.repo}`,
    gitHome: `${ctx.tmp}/home`,
  });
}

/** Read-only observation stub: no GitHub client, no cooldown, no write. */
class ObserverStub {
  pull: GitHubPullRequestV1 | null;
  base: GitSha;
  refFail = false;
  readonly refReads: string[] = [];
  constructor(pull: GitHubPullRequestV1 | null, base: GitSha) {
    this.pull = pull;
    this.base = base;
  }
  readPullRequest(
    _number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    return Promise.resolve(portOk(this.pull));
  }
  readRef(ref: string): Promise<PortResultV1<GitHubRefV1 | null>> {
    this.refReads.push(ref);
    if (this.refFail) {
      return Promise.resolve(portError("unavailable", "ref read failed"));
    }
    return Promise.resolve(portOk({ ref, sha: this.base }));
  }
}

function pullRequest(
  ctx: RefreshCtxV1,
  overrides: Partial<GitHubPullRequestV1> = {},
): GitHubPullRequestV1 {
  return {
    number: 7,
    title: "Sentinel repair",
    body: "Refs 1",
    state: "open",
    head: ctx.candidate,
    base: ctx.newBase,
    mergeSha: null,
    headRef: BRANCH,
    baseRef: BASE_BRANCH,
    author: TRUSTED_AUTHOR,
    createdAt: 1,
    updatedAt: 1,
    mergedAt: null,
    reviewDecision: "none",
    ...overrides,
  };
}

function adapter(
  ctx: RefreshCtxV1,
  observer: ObserverStub,
  ensureCandidateObjects?: (input: {
    base: GitSha;
    head: GitSha;
  }) => Promise<PortResultV1<void>>,
) {
  return createPrepareBaseRefresh({
    git: executor(ctx),
    observer,
    baseBranch: BASE_BRANCH,
    trustedPrAuthor: TRUSTED_AUTHOR,
    ensureCandidateObjects,
  });
}

Deno.test(
  "base refresh executor: deterministic two-parent commit preserves both sides without touching refs or index",
  async () => {
    const ctx = await makeRefreshCtx();
    try {
      const git = executor(ctx);
      const headBefore = (await ctx.git(["rev-parse", "HEAD"])).stdout.trim();
      const branchBefore = (
        await ctx.git(["rev-parse", `refs/heads/candidate`])
      ).stdout.trim();
      const statusBefore = (await ctx.git(["status", "--porcelain"])).stdout;
      const first = await git.integrateBase(ctx.candidate, ctx.newBase);
      const second = await git.integrateBase(ctx.candidate, ctx.newBase);
      assert.ok(first.ok, JSON.stringify(first));
      assert.ok(second.ok, JSON.stringify(second));
      assert.equal(
        first.value,
        second.value,
        "the same parents always produce the identical prepared SHA",
      );
      const parents = await ctx.git([
        "rev-list",
        "--parents",
        "-n",
        "1",
        first.value,
      ]);
      const parts = parents.stdout.trim().split(" ");
      assert.equal(parts.length, 3, "exactly two parents");
      assert.equal(parts[0], first.value);
      assert.equal(
        parts[1],
        ctx.candidate,
        "old candidate is the first parent",
      );
      assert.equal(parts[2], ctx.newBase, "new base is the second parent");
      const candidateSide = await ctx.git([
        "show",
        `${first.value}:shared.txt`,
      ]);
      assert.equal(candidateSide.stdout, "candidate\n");
      const baseSide = await ctx.git(["show", `${first.value}:base.txt`]);
      assert.equal(baseSide.stdout, "new base\n");
      assert.equal(
        (await ctx.git(["rev-parse", "HEAD"])).stdout.trim(),
        headBefore,
        "no checkout/ref movement",
      );
      assert.equal(
        (await ctx.git(["rev-parse", "refs/heads/candidate"])).stdout.trim(),
        branchBefore,
        "the candidate branch is untouched",
      );
      assert.equal(
        (await ctx.git(["status", "--porcelain"])).stdout,
        statusBefore,
        "the index and worktree are untouched",
      );
      // The base is already an ancestor of the head: a refresh STILL creates a
      // new deterministic two-parent commit from the exact head/base, never
      // reusing the head identity (the reviewed base changes, so the refreshed
      // candidate must carry its own identity for the fresh review).
      const refreshed = await git.integrateBase(ctx.newBase, ctx.oldBase);
      assert.ok(refreshed.ok, JSON.stringify(refreshed));
      assert.notEqual(refreshed.value, ctx.newBase);
      const repeated = await git.integrateBase(ctx.newBase, ctx.oldBase);
      assert.ok(repeated.ok, JSON.stringify(repeated));
      assert.equal(repeated.value, refreshed.value, "deterministic identity");
      const refreshedParents = (
        await ctx.git(["rev-list", "--parents", "-n", "1", refreshed.value])
      ).stdout.trim().split(" ");
      assert.equal(refreshedParents.length, 3, "exactly two parents");
      assert.equal(
        refreshedParents[1],
        ctx.newBase,
        "head is the first parent",
      );
      assert.equal(
        refreshedParents[2],
        ctx.oldBase,
        "base is the second parent",
      );
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "base refresh executor: a conflict fails closed with a bounded error and no side effect",
  async () => {
    const ctx = await makeRefreshCtx();
    try {
      const git = executor(ctx);
      const headBefore = (await ctx.git(["rev-parse", "HEAD"])).stdout.trim();
      const statusBefore = (await ctx.git(["status", "--porcelain"])).stdout;
      const conflicted = await git.integrateBase(
        ctx.candidate,
        ctx.conflictingBase,
      );
      assert.equal(conflicted.ok, false);
      if (conflicted.ok) return;
      assert.equal(conflicted.error.kind, "conflict");
      assert.equal(conflicted.error.detail, BASE_REFRESH_CONFLICT_DETAIL);
      assert.equal(
        (await ctx.git(["rev-parse", "HEAD"])).stdout.trim(),
        headBefore,
      );
      assert.equal(
        (await ctx.git(["status", "--porcelain"])).stdout,
        statusBefore,
      );
      // Missing input objects fail closed without a bounded payload.
      const missing = await git.integrateBase(ctx.candidate, OTHER_SHA);
      assert.equal(missing.ok, false);
      assert.equal(
        (await ctx.git(["rev-parse", "HEAD"])).stdout.trim(),
        headBefore,
      );
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "base refresh adapter: exact PR/branch/base observation then deterministic integration",
  async () => {
    const ctx = await makeRefreshCtx();
    try {
      const observer = new ObserverStub(pullRequest(ctx), ctx.newBase);
      const ensured: { base: GitSha; head: GitSha }[] = [];
      const prepare = adapter(ctx, observer, (value) => {
        ensured.push(value);
        return Promise.resolve(portOk(undefined));
      });
      const result = await prepare({
        pullRequestNumber: 7,
        branch: BRANCH,
        expectedHead: ctx.candidate,
        previousBase: ctx.oldBase,
        expectedBase: ctx.newBase,
      });
      assert.ok(result.ok, JSON.stringify(result));
      const direct = await executor(ctx).integrateBase(
        ctx.candidate,
        ctx.newBase,
      );
      assert.ok(direct.ok);
      assert.equal(result.value, direct.value);
      assert.deepEqual(ensured, [{ base: ctx.oldBase, head: ctx.candidate }]);
      assert.deepEqual(observer.refReads, [`refs/heads/${BASE_BRANCH}`]);
      // Recovery: the PR head may already be the exact persisted prepared
      // commit; the regenerated commit must be identical to it.
      const recovered = new ObserverStub(
        pullRequest(ctx, { head: result.value }),
        ctx.newBase,
      );
      const recovery = await adapter(ctx, recovered)({
        pullRequestNumber: 7,
        branch: BRANCH,
        expectedHead: ctx.candidate,
        previousBase: ctx.oldBase,
        expectedBase: ctx.newBase,
        preparedHead: result.value,
      });
      assert.ok(recovery.ok, JSON.stringify(recovery));
      assert.equal(recovery.value, result.value);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "base refresh adapter: wrong author, head, branches and moved base fail closed",
  async () => {
    const ctx = await makeRefreshCtx();
    try {
      const request = {
        pullRequestNumber: 7,
        branch: BRANCH,
        expectedHead: ctx.candidate,
        previousBase: ctx.oldBase,
        expectedBase: ctx.newBase,
      };
      const variants: Array<{ name: string; observer: ObserverStub }> = [
        {
          name: "foreign author",
          observer: new ObserverStub(
            pullRequest(ctx, { author: "someone-else" }),
            ctx.newBase,
          ),
        },
        {
          name: "wrong head",
          observer: new ObserverStub(
            pullRequest(ctx, { head: ctx.conflictingBase }),
            ctx.newBase,
          ),
        },
        {
          name: "wrong head branch",
          observer: new ObserverStub(
            pullRequest(ctx, { headRef: "feature/x" }),
            ctx.newBase,
          ),
        },
        {
          name: "wrong base branch",
          observer: new ObserverStub(
            pullRequest(ctx, { baseRef: "main" }),
            ctx.newBase,
          ),
        },
        {
          name: "moved base",
          observer: new ObserverStub(pullRequest(ctx), ctx.oldBase),
        },
        {
          name: "closed PR",
          observer: new ObserverStub(
            pullRequest(ctx, { state: "closed" }),
            ctx.newBase,
          ),
        },
      ];
      for (const variant of variants) {
        const rejected = await adapter(ctx, variant.observer)(request);
        assert.equal(rejected.ok, false, variant.name);
      }
      // A recovery prepared head that is not the regenerated deterministic
      // commit is refused even when the observed head is the old candidate.
      const mismatched = await adapter(
        ctx,
        new ObserverStub(pullRequest(ctx), ctx.newBase),
      )({
        ...request,
        preparedHead: OTHER_SHA,
      });
      assert.equal(mismatched.ok, false);
      if (!mismatched.ok) {
        assert.equal(
          mismatched.error.detail,
          "base refresh prepared identity mismatch",
        );
      }
      // A failed exact-object restore propagates as unavailability without
      // running the integration.
      const restoreFailed = await adapter(
        ctx,
        new ObserverStub(pullRequest(ctx), ctx.newBase),
        () => Promise.resolve(portError("unavailable", "restore failed")),
      )(request);
      assert.equal(restoreFailed.ok, false);
      // An unwritable/missing ref read is unavailable, never assumed equal.
      const refFailed = new ObserverStub(pullRequest(ctx), ctx.newBase);
      refFailed.refFail = true;
      const unreadable = await adapter(ctx, refFailed)(request);
      assert.equal(unreadable.ok, false);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "base refresh adapter: a prepared recovery regenerates despite a later base while an unprepared refresh rejects",
  async () => {
    const ctx = await makeRefreshCtx();
    try {
      const prepared = await executor(ctx).integrateBase(
        ctx.candidate,
        ctx.newBase,
      );
      assert.ok(prepared.ok, JSON.stringify(prepared));
      const request = {
        pullRequestNumber: 7,
        branch: BRANCH,
        expectedHead: ctx.candidate,
        previousBase: ctx.oldBase,
        expectedBase: ctx.newBase,
      };
      // The configured base advanced after the prepared commit was persisted:
      // publishing that exact frozen candidate is still allowed.
      const recovered = await adapter(
        ctx,
        new ObserverStub(pullRequest(ctx), ctx.conflictingBase),
      )({ ...request, preparedHead: prepared.value });
      assert.ok(recovered.ok, JSON.stringify(recovered));
      assert.equal(recovered.value, prepared.value);

      // The same moved base still rejects an UNPREPARED refresh: the exact
      // expectedBase precondition holds while no prepared SHA is persisted.
      const unprepared = await adapter(
        ctx,
        new ObserverStub(pullRequest(ctx), ctx.conflictingBase),
      )(request);
      assert.equal(unprepared.ok, false);
      if (!unprepared.ok) {
        assert.equal(
          unprepared.error.detail,
          "base refresh configured base moved",
        );
      }

      // A persisted prepared HEAD that no longer regenerates byte-identically
      // is refused, even with a moved base: no unrelated commit is adopted.
      const mismatched = await adapter(
        ctx,
        new ObserverStub(pullRequest(ctx), ctx.conflictingBase),
      )({ ...request, preparedHead: OTHER_SHA });
      assert.equal(mismatched.ok, false);
    } finally {
      await ctx.cleanup();
    }
  },
);
