/**
 * Hosted candidate restoration: REAL restorer, REAL git fetch into real
 * shallow single-branch clones, and the REAL snapshot/ancestry consumers that
 * need the objects. No network, no model, no credentials: the fixed remote is
 * replaced only in the real git fetch argv by a fixture file:// bare repo.
 */
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubRateLimitV1 } from "../../src/contracts/github-cooldown.ts";
import type {
  GitHubCooldownGateV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { DenoGitExecutor } from "../../src/github/git-executor.ts";
import type {
  HttpRequestV1,
  HttpResponseV1,
  HttpTransportV1,
} from "../../src/github/http.ts";
import { GitReviewSnapshot } from "../../src/github/review-snapshot.ts";
import { createActionsCandidateRestorer } from "../../src/host/actions-candidates.ts";
import { FakeClock, MemoryState } from "../repair/helpers.ts";
import { SHA1, T0, workRecord } from "../state/helpers.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/host\/actions-candidates_test\.ts$/,
  "",
);
const TRUSTED_PATH = Deno.env.get("PATH") ?? "/usr/bin:/bin";
const SELF_REPO = {
  owner: "ubiquity",
  name: "sentinel",
  installationId: 0,
} as const;
const BRANCH = "sentinel/repair/issue-1";

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
    GIT_AUTHOR_NAME: "sentinel-candidates-test",
    GIT_AUTHOR_EMAIL: "sentinel-candidates-test@localhost",
    GIT_COMMITTER_NAME: "sentinel-candidates-test",
    GIT_COMMITTER_EMAIL: "sentinel-candidates-test@localhost",
  };
}

interface CandidateCtxV1 {
  tmp: string;
  env: Record<string, string>;
  bare: string;
  base: GitSha;
  head: GitSha;
  clone(): Promise<string>;
  cleanup(): Promise<void>;
}

async function commitIn(
  work: string,
  env: Record<string, string>,
  name: string,
): Promise<GitSha> {
  await Deno.writeTextFile(`${work}/${name}.txt`, name);
  assert.ok((await gitRun(work, ["add", "-A"], env)).ok);
  assert.ok((await gitRun(work, ["commit", "-q", "-m", name], env)).ok);
  const rev = await gitRun(work, ["rev-parse", "HEAD"], env);
  return rev.stdout.trim() as GitSha;
}

async function makeCandidateCtx(): Promise<CandidateCtxV1> {
  const tmp = await Deno.makeTempDir({
    prefix: "sentinel-candidates-",
    dir: ROOT,
  });
  try {
    const env = gitEnv(`${tmp}/home`);
    await Deno.mkdir(`${tmp}/home`, { recursive: true });
    const bare = `${tmp}/remote.git`;
    const work = `${tmp}/work`;
    await Deno.mkdir(work, { recursive: true });
    assert.ok((await gitRun(tmp, ["init", "-q", "--bare", bare], env)).ok);
    assert.ok((await gitRun(tmp, ["init", "-q", work], env)).ok);
    assert.ok(
      (await gitRun(work, ["remote", "add", "origin", bare], env)).ok,
    );
    const base = await commitIn(work, env, "base");
    assert.ok((await gitRun(work, ["branch", "-M", "development"], env)).ok);
    assert.ok(
      (await gitRun(work, ["push", "-q", "origin", "development"], env)).ok,
    );
    assert.ok((await gitRun(work, ["checkout", "-q", "-b", BRANCH], env)).ok);
    const head = await commitIn(work, env, "candidate");
    assert.ok(
      (await gitRun(
        work,
        ["push", "-q", "origin", `refs/heads/${BRANCH}`],
        env,
      )).ok,
    );
    const clone = async (): Promise<string> => {
      const dest = `${tmp}/clone-${crypto.randomUUID()}`;
      const cloned = await gitRun(tmp, [
        "clone",
        "-q",
        "--depth=1",
        "--single-branch",
        "--branch",
        "development",
        `file://${bare}`,
        dest,
      ], env);
      if (!cloned.ok) throw new Error(`clone failed: ${cloned.stderr}`);
      return dest;
    };
    return {
      tmp,
      env,
      bare,
      base,
      head,
      clone,
      cleanup: async () => {
        await Deno.remove(tmp, { recursive: true }).catch(() => {});
      },
    };
  } catch (error) {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
    throw error;
  }
}

class FakeGate implements GitHubCooldownGateV1 {
  deny = false;
  readonly admissions: number[] = [];
  beforeRequest(installationId: number): Promise<PortResultV1<void>> {
    this.admissions.push(installationId);
    return Promise.resolve(
      this.deny
        ? portError("rate_limited", "installation is cooling down")
        : portOk(undefined),
    );
  }
  recordRateLimit(
    _installationId: number,
    _rateLimit: GitHubRateLimitV1,
  ): Promise<PortResultV1<void>> {
    return Promise.resolve(portOk(undefined));
  }
}

/** Fake authenticated ref API: exact self ref metadata, recorded requests. */
class RefHttp {
  readonly requests: HttpRequestV1[] = [];
  sha: GitSha;
  fail = false;
  constructor(sha: GitSha) {
    this.sha = sha;
  }
  readonly transport: HttpTransportV1 = (request) => {
    this.requests.push(request);
    if (this.fail) return Promise.reject(new Error("transport down"));
    const pathname = new URL(request.url).pathname;
    const marker = "/git/ref/";
    const ref = "refs/" +
      pathname.slice(pathname.indexOf(marker) + marker.length);
    return Promise.resolve(
      {
        status: 200,
        headers: new Headers(),
        bodyText: JSON.stringify({ ref, object: { sha: this.sha } }),
      } satisfies HttpResponseV1,
    );
  };
}

function snapshot(
  work: RepairStateSnapshotV1["work"],
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work,
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
  });
}

function candidateRecord(
  ctx: CandidateCtxV1,
  overrides: Record<string, unknown> = {},
) {
  return workRecord("candidates-1", {
    repository: { ...SELF_REPO },
    source: { kind: "issue", id: "1", revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    target: {
      base: ctx.base,
      branch: BRANCH,
      checkpoint: null,
      head: ctx.head,
      pr: 12,
    },
    nextStep: "review",
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    updatedAt: T0 + 1000,
    ...overrides,
  });
}

function restorer(
  ctx: CandidateCtxV1,
  state: MemoryState,
  gate: FakeGate,
  http: RefHttp,
  sourcePath: string,
  remoteUrl: string = `file://${ctx.bare}`,
) {
  return createActionsCandidateRestorer({
    state,
    gate,
    token: "dummy-token",
    http: http.transport,
    clock: new FakeClock(T0),
    sourcePath,
    scratch: `${ctx.tmp}/home`,
    trustedPath: TRUSTED_PATH,
    gitExecutable: "git",
    remoteUrl,
    apiBaseUrl: "https://api.github.com",
  });
}

async function objectPresent(
  clone: string,
  env: Record<string, string>,
  sha: GitSha,
): Promise<boolean> {
  const read = await gitRun(clone, ["cat-file", "-e", `${sha}^{commit}`], env);
  return read.code === 0;
}

Deno.test(
  "actions candidates: restores the exact durable candidate for snapshot and ancestry",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const state = new MemoryState();
      state.repair = snapshot([candidateRecord(ctx)]);
      const gate = new FakeGate();
      const http = new RefHttp(ctx.head);
      const first = await ctx.clone();
      assert.equal(
        await objectPresent(first, ctx.env, ctx.head),
        false,
        "the candidate object starts absent in a fresh shallow clone",
      );
      const firstRestorer = restorer(ctx, state, gate, http, first);
      const ensured = await firstRestorer.ensure({
        base: ctx.base,
        head: ctx.head,
      });
      assert.ok(ensured.ok, JSON.stringify(ensured));
      assert.equal(await objectPresent(first, ctx.env, ctx.head), true);
      // The real snapshot producer captures only after the restore.
      const producer = new GitReviewSnapshot({
        trustedPath: TRUSTED_PATH,
        repositoryDir: first,
        gitExecutable: "git",
      });
      const captured = await producer.capture({
        base: ctx.base,
        head: ctx.head,
      });
      assert.ok(captured.ok, JSON.stringify(captured));
      // A SECOND fresh clone independently restores before real ancestry.
      const second = await ctx.clone();
      assert.equal(await objectPresent(second, ctx.env, ctx.head), false);
      const secondRestorer = restorer(ctx, state, gate, http, second);
      assert.ok(
        (await secondRestorer.ensure({ base: ctx.base, head: ctx.head })).ok,
      );
      const executor = new DenoGitExecutor({
        localDir: second,
        remoteUrl: ctx.bare,
        gitHome: `${ctx.tmp}/home`,
      });
      const ancestor = await executor.isAncestor(ctx.base, ctx.head);
      assert.ok(ancestor.ok && ancestor.value === true);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "actions candidates: already-local objects need no API read and no fetch",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const state = new MemoryState();
      state.repair = snapshot([candidateRecord(ctx)]);
      const gate = new FakeGate();
      const http = new RefHttp(ctx.head);
      const clone = await ctx.clone();
      const sut = restorer(ctx, state, gate, http, clone);
      assert.ok((await sut.ensure({ base: ctx.base, head: ctx.head })).ok);
      const reads = http.requests.length;
      const recheck = await sut.ensure({ base: ctx.base, head: ctx.head });
      assert.ok(recheck.ok);
      assert.equal(
        http.requests.length,
        reads,
        "already-local immutable objects are never re-fetched",
      );
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "actions candidates: missing, foreign, ambiguous or wrong bindings refuse without fetch",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const variants: Array<{
        name: string;
        work: (ctx: CandidateCtxV1) => RepairStateSnapshotV1["work"];
      }> = [
        { name: "no record", work: () => [] },
        {
          name: "foreign repository",
          work: (value) =>
            snapshot([
              candidateRecord(value, {
                repository: {
                  owner: "ubiquity",
                  name: "ai.ubq.fi",
                  installationId: 7,
                },
              }),
            ]).work,
        },
        {
          name: "wrong head",
          work: (value) =>
            snapshot([
              candidateRecord(value, {
                target: {
                  base: value.base,
                  branch: BRANCH,
                  checkpoint: null,
                  head: SHA1,
                  pr: 12,
                },
              }),
            ])
              .work,
        },
        {
          name: "unprefixed branch",
          work: (value) =>
            snapshot([
              candidateRecord(value, {
                target: {
                  base: value.base,
                  branch: "feature/x",
                  checkpoint: null,
                  head: value.head,
                  pr: 12,
                },
              }),
            ])
              .work,
        },
        {
          name: "ambiguous records",
          // Two DISTINCT valid work ids bound to the SAME exact candidate:
          // the parser accepts both and the restorer must refuse ambiguity.
          work: (value) =>
            snapshot([
              candidateRecord(value),
              candidateRecord(value, { id: "candidates-2" }),
            ]).work,
        },
      ];
      for (const variant of variants) {
        const state = new MemoryState();
        state.repair = snapshot(variant.work(ctx));
        const gate = new FakeGate();
        const http = new RefHttp(ctx.head);
        const clone = await ctx.clone();
        const refused = await restorer(ctx, state, gate, http, clone).ensure({
          base: ctx.base,
          head: ctx.head,
        });
        assert.equal(refused.ok, false, variant.name);
        assert.equal(http.requests.length, 0, `${variant.name}: no API read`);
        assert.equal(
          await objectPresent(clone, ctx.env, ctx.head),
          false,
          `${variant.name}: no fetch`,
        );
      }
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "actions candidates: moved ref, cooldown denial and fetch/transport failures refuse",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      // Moved remote ref: the authenticated observation is not the candidate.
      const movedState = new MemoryState();
      movedState.repair = snapshot([candidateRecord(ctx)]);
      const movedHttp = new RefHttp(ctx.base);
      const movedClone = await ctx.clone();
      const moved = await restorer(
        ctx,
        movedState,
        new FakeGate(),
        movedHttp,
        movedClone,
      ).ensure({ base: ctx.base, head: ctx.head });
      assert.equal(moved.ok, false);
      assert.equal(movedHttp.requests.length, 1);
      assert.equal(await objectPresent(movedClone, ctx.env, ctx.head), false);

      // Durable cooldown denial: zero HTTP and zero fetch.
      const cooledState = new MemoryState();
      cooledState.repair = snapshot([candidateRecord(ctx)]);
      const cooledGate = new FakeGate();
      cooledGate.deny = true;
      const cooledHttp = new RefHttp(ctx.head);
      const cooledClone = await ctx.clone();
      const cooled = await restorer(
        ctx,
        cooledState,
        cooledGate,
        cooledHttp,
        cooledClone,
      ).ensure({ base: ctx.base, head: ctx.head });
      assert.equal(cooled.ok, false);
      assert.equal(cooledHttp.requests.length, 0);
      assert.equal(await objectPresent(cooledClone, ctx.env, ctx.head), false);

      // Fetch failure (missing fixture remote): unavailable, never partial.
      const fetchState = new MemoryState();
      fetchState.repair = snapshot([candidateRecord(ctx)]);
      const fetchHttp = new RefHttp(ctx.head);
      const fetchClone = await ctx.clone();
      const fetchFailed = await restorer(
        ctx,
        fetchState,
        new FakeGate(),
        fetchHttp,
        fetchClone,
        `file://${ctx.tmp}/missing.git`,
      ).ensure({ base: ctx.base, head: ctx.head });
      assert.equal(fetchFailed.ok, false);
      assert.equal(await objectPresent(fetchClone, ctx.env, ctx.head), false);

      // Injected transport failure: unavailable without a fetch.
      const failedState = new MemoryState();
      failedState.repair = snapshot([candidateRecord(ctx)]);
      const failedHttp = new RefHttp(ctx.head);
      failedHttp.fail = true;
      const failedClone = await ctx.clone();
      const transportFailed = await restorer(
        ctx,
        failedState,
        new FakeGate(),
        failedHttp,
        failedClone,
      ).ensure({ base: ctx.base, head: ctx.head });
      assert.equal(transportFailed.ok, false);
      assert.equal(await objectPresent(failedClone, ctx.env, ctx.head), false);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "actions candidates: restores the prepared base-refresh commit after a lost state response",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      // The candidate branch now carries the exact deterministic prepared
      // commit (old candidate first parent, moved base second parent) while
      // the durable record still points at the old candidate.
      const work = `${ctx.tmp}/work`;
      assert.ok(
        (await gitRun(work, ["checkout", "-q", "development"], ctx.env)).ok,
      );
      await Deno.writeTextFile(`${work}/refresh-base.txt`, "new base\n");
      assert.ok((await gitRun(work, ["add", "-A"], ctx.env)).ok);
      assert.ok(
        (await gitRun(work, ["commit", "-q", "-m", "new base"], ctx.env)).ok,
      );
      const newBase = (await gitRun(work, ["rev-parse", "HEAD"], ctx.env))
        .stdout.trim() as GitSha;
      const executor = new DenoGitExecutor({
        localDir: work,
        remoteUrl: ctx.bare,
        gitHome: `${ctx.tmp}/home`,
      });
      const integrated = await executor.integrateBase(ctx.head, newBase);
      assert.ok(integrated.ok, JSON.stringify(integrated));
      const prepared = integrated.value;
      assert.ok(
        (await gitRun(
          work,
          ["push", "-q", "origin", `${prepared}:refs/heads/${BRANCH}`],
          ctx.env,
        )).ok,
      );

      const state = new MemoryState();
      state.repair = snapshot([
        candidateRecord(ctx, {
          intent: {
            kind: "base_refresh",
            key: `base_refresh:12:${ctx.head}:${newBase}`,
            startedAt: T0,
            branch: BRANCH,
            expectedHead: ctx.head,
            observedBase: newBase,
            pr: 12,
            requestId: null,
            resultId: prepared,
          },
          nextStep: "delivery",
        }),
      ]);
      const durableBefore = structuredClone(state.repair);
      const clone = await ctx.clone();
      assert.equal(await objectPresent(clone, ctx.env, ctx.head), false);
      const ensured = await restorer(
        ctx,
        state,
        new FakeGate(),
        new RefHttp(prepared),
        clone,
      ).ensure({ base: ctx.base, head: ctx.head });
      assert.ok(ensured.ok, JSON.stringify(ensured));
      assert.equal(await objectPresent(clone, ctx.env, ctx.head), true);
      assert.equal(await objectPresent(clone, ctx.env, newBase), true);
      assert.equal(await objectPresent(clone, ctx.env, prepared), true);
      assert.deepEqual(
        state.repair,
        durableBefore,
        "the durable record is never altered by the restore",
      );

      // Crash after persisting the prepared result but BEFORE the push: the
      // remote ref still carries the OLD candidate. A fresh shallow clone must
      // accept that exact observed head, fetch it and restore the old objects
      // (and the old base) without touching the durable record.
      assert.ok(
        (await gitRun(
          work,
          [
            "push",
            "-q",
            "--force",
            "origin",
            `${ctx.head}:refs/heads/${BRANCH}`,
          ],
          ctx.env,
        )).ok,
      );
      const prePushClone = await ctx.clone();
      assert.equal(
        await objectPresent(prePushClone, ctx.env, ctx.head),
        false,
      );
      const prePush = await restorer(
        ctx,
        state,
        new FakeGate(),
        new RefHttp(ctx.head),
        prePushClone,
      ).ensure({ base: ctx.base, head: ctx.head });
      assert.ok(prePush.ok, JSON.stringify(prePush));
      assert.equal(await objectPresent(prePushClone, ctx.env, ctx.head), true);
      assert.equal(await objectPresent(prePushClone, ctx.env, ctx.base), true);
      assert.deepEqual(
        state.repair,
        durableBefore,
        "prepared-before-push restore never alters state",
      );

      // An unrelated remote head (neither the durable candidate nor the exact
      // persisted prepared commit) is refused without a fetch.
      const unrelated = "1234567890abcdef1234567890abcdef12345678" as GitSha;
      const unrelatedClone = await ctx.clone();
      const refused = await restorer(
        ctx,
        state,
        new FakeGate(),
        new RefHttp(unrelated),
        unrelatedClone,
      ).ensure({ base: ctx.base, head: ctx.head });
      assert.equal(refused.ok, false);
      assert.equal(
        await objectPresent(unrelatedClone, ctx.env, ctx.head),
        false,
      );
    } finally {
      await ctx.cleanup();
    }
  },
);
