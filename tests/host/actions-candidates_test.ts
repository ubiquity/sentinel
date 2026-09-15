/**
 * Hosted candidate restoration: REAL restorer, REAL git fetch into real
 * shallow single-branch clones, and the REAL snapshot/ancestry consumers that
 * need the objects. No network, no model, no credentials: the fixed remote is
 * replaced only in the real git fetch argv by a fixture file:// bare repo.
 */
import assert from "node:assert/strict";

import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import type { GitHubRateLimitV1 } from "../../src/contracts/github-cooldown.ts";
import type {
  GitHubCooldownGateV1,
  GitHubPort,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { CandidatePreservationV1 } from "../../src/contracts/work-record.ts";
import { DenoGitExecutor } from "../../src/github/git-executor.ts";
import type { DenoGitExecutorOptions } from "../../src/github/git-executor.ts";
import type {
  HttpRequestV1,
  HttpResponseV1,
  HttpTransportV1,
} from "../../src/github/http.ts";
import { GitReviewSnapshot } from "../../src/github/review-snapshot.ts";
import {
  createActionsCandidateRestorer,
  createCandidatePreserver,
} from "../../src/host/actions-candidates.ts";
import { composeGitHubHost } from "../../src/host/github.ts";
import {
  baseRefreshIntentKey,
  candidatePreservationRef,
} from "../../src/repair/keys.ts";
import type {
  ReplayCommandInputV1,
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import { FakeAuthProvider, FakeReviewService } from "../github/helpers.ts";
import { FakeClock, MemoryState } from "../repair/helpers.ts";
import { reservation, SHA1, T0, workRecord } from "../state/helpers.ts";

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
  reservations: RepairStateSnapshotV1["reservations"] = [],
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
    reservations,
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

Deno.test(
  "actions candidates: new-shape base_refresh restore requires the full binding",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
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
      const taskId = CANDIDATE_TASK_ID;
      const implRef = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        CANDIDATE_OPERATION_KEY,
      );
      const refreshKey = baseRefreshIntentKey(12, ctx.head, newBase);
      const refreshRef = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        refreshKey,
      );
      // The durable operation ref carries the exact deterministic prepared
      // refresh commit; the record still retains its original descriptor.
      assert.ok(
        (await gitRun(
          work,
          ["push", "-q", "origin", `${prepared}:${refreshRef}`],
          ctx.env,
        )).ok,
      );
      const preserved = {
        operationKey: CANDIDATE_OPERATION_KEY,
        base: ctx.base,
        head: ctx.head,
        ref: implRef,
      };
      const buildRecord = (
        intentOverride: Record<string, unknown> = {},
        preservedOverride: Record<string, unknown> = {},
      ) =>
        candidateRecord(ctx, {
          target: {
            base: ctx.base,
            branch: BRANCH,
            checkpoint: null,
            head: ctx.head,
            pr: 12,
            candidateState: {
              preserved: { ...preserved, ...preservedOverride },
              publishedHead: null,
            },
          },
          intent: {
            kind: "base_refresh",
            key: refreshKey,
            startedAt: T0,
            branch: BRANCH,
            expectedHead: ctx.head,
            observedBase: newBase,
            pr: 12,
            requestId: null,
            resultId: prepared,
            ...intentOverride,
          },
          nextStep: "delivery",
        });
      const state = new MemoryState();
      state.repair = snapshot([buildRecord()]);
      const clone = await ctx.clone();
      assert.equal(await objectPresent(clone, ctx.env, ctx.head), false);
      const http = new RefHttp(prepared);
      const ensured = await restorer(ctx, state, new FakeGate(), http, clone)
        .ensure({ base: newBase, head: prepared });
      assert.ok(ensured.ok, JSON.stringify(ensured));
      assert.equal(await objectPresent(clone, ctx.env, ctx.head), true);
      assert.equal(await objectPresent(clone, ctx.env, newBase), true);
      assert.equal(await objectPresent(clone, ctx.env, prepared), true);

      // Every mismatched intent binding or retained descriptor must refuse
      // without any token-dependent read or fetch.
      const negatives: [string, () => ReturnType<typeof buildRecord>][] = [
        ["mismatched PR", () => buildRecord({ pr: 13 })],
        [
          "mismatched branch",
          () => buildRecord({ branch: "sentinel/repair/other" }),
        ],
        ["mismatched old head", () => buildRecord({ expectedHead: ctx.base })],
        [
          "mismatched key",
          () =>
            buildRecord({ key: baseRefreshIntentKey(12, ctx.head, ctx.base) }),
        ],
        [
          "mismatched observed base",
          () => buildRecord({ observedBase: ctx.base }),
        ],
        [
          "mismatched derived descriptor ref",
          () => buildRecord({}, { operationKey: `impl:${"b".repeat(64)}` }),
        ],
      ];
      for (const [label, build] of negatives) {
        const negativeState = new MemoryState();
        negativeState.repair = snapshot([build()]);
        const negativeClone = await ctx.clone();
        const negativeHttp = new RefHttp(prepared);
        const refused = await restorer(
          ctx,
          negativeState,
          new FakeGate(),
          negativeHttp,
          negativeClone,
        ).ensure({ base: newBase, head: prepared });
        assert.equal(refused.ok, false, label);
        assert.equal(
          negativeHttp.requests.length,
          0,
          `${label}: no authenticated ref read`,
        );
        assert.equal(
          await objectPresent(negativeClone, ctx.env, ctx.head),
          false,
          `${label}: nothing was fetched`,
        );
      }
    } finally {
      await ctx.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Trusted candidate preservation: REAL bare remote, REAL DenoGitExecutor
// push/CAS path and REAL GitReviewSnapshot validation; only the external HTTP
// transport is fake (it reads the same real remote refs).
// ---------------------------------------------------------------------------

const PRESERVATION_ID = "a".repeat(64);
const CANDIDATE_TASK_ID = "candidates-1" as WorkItemId;
const CANDIDATE_OPERATION_KEY = `impl:${PRESERVATION_ID}`;

/** The exact submitted implementation reservation for one candidate attempt. */
function submittedReservation(
  record: ReturnType<typeof candidateRecord>,
  overrides: Record<string, unknown> = {},
) {
  return reservation(PRESERVATION_ID, {
    repository: { ...SELF_REPO },
    taskId: record.id,
    attempt: record.counters.attempts,
    head: record.target.base,
    purpose: "implementation",
    outcome: "submitted",
    settledAt: T0 + 5,
    proofRef: null,
    ...overrides,
  });
}

/** A private trusted source mirror: a clone of the exact producer checkout. */
async function mirror(ctx: CandidateCtxV1): Promise<string> {
  const dest = `${ctx.tmp}/mirror-${crypto.randomUUID()}`;
  const cloned = await gitRun(
    ctx.tmp,
    ["clone", "-q", "--no-hardlinks", `${ctx.tmp}/work`, dest],
    ctx.env,
  );
  if (!cloned.ok) throw new Error(`mirror clone failed: ${cloned.stderr}`);
  return dest;
}

/** Exact operation descriptor for one task/base/head/operation key. */
async function candidateFor(
  taskId: WorkItemId,
  base: GitSha,
  head: GitSha,
  operationKey: string,
): Promise<CandidatePreservationV1> {
  return {
    operationKey,
    base,
    head,
    ref: await candidatePreservationRef({ ...SELF_REPO }, taskId, operationKey),
  };
}

/** Authoritative remote ref read from the real fixture bare repository. */
async function remoteSha(
  ctx: CandidateCtxV1,
  ref: string,
): Promise<GitSha | null> {
  const read = await gitRun(
    ctx.tmp,
    ["ls-remote", `file://${ctx.bare}`, ref],
    ctx.env,
  );
  assert.ok(read.ok, read.stderr);
  const line = read.stdout.trim();
  return line === "" ? null : line.split("\t")[0]!.trim() as GitSha;
}

/** Fake external HTTP transport over the REAL remote ref state. */
class RealRefHttp {
  readonly paths: string[] = [];
  constructor(private readonly reader: DenoGitExecutor) {}
  readonly transport: HttpTransportV1 = (request) => {
    const pathname = new URL(request.url).pathname;
    this.paths.push(pathname);
    const marker = "/git/ref/";
    const index = pathname.indexOf(marker);
    if (index === -1) {
      // Any PR/issue/review read is a failure: preservation must never touch
      // those surfaces.
      return Promise.reject(new Error(`unexpected non-ref read: ${pathname}`));
    }
    const ref = "refs/" + pathname.slice(index + marker.length);
    return this.reader.readRemoteRef(ref).then((read): HttpResponseV1 => {
      if (!read.ok) {
        return { status: 500, headers: new Headers(), bodyText: "" };
      }
      if (read.value === null) {
        return { status: 404, headers: new Headers(), bodyText: "" };
      }
      return {
        status: 200,
        headers: new Headers(),
        bodyText: JSON.stringify({ ref, object: { sha: read.value } }),
      };
    });
  };
}

/** The real composed port + executor over one real fixture remote. */
function candidatePort(input: {
  ctx: CandidateCtxV1;
  sourcePath: string;
  gate: FakeGate;
  gitExtra?: Partial<DenoGitExecutorOptions>;
}) {
  const reader = new DenoGitExecutor({
    localDir: input.sourcePath,
    remoteUrl: `file://${input.ctx.bare}`,
    gitHome: `${input.ctx.tmp}/home`,
    gitPath: "git",
  });
  const http = new RealRefHttp(reader);
  const host = composeGitHubHost({
    repository: { ...SELF_REPO },
    http: http.transport,
    auth: new FakeAuthProvider(),
    cooldownGate: input.gate,
    clock: new FakeClock(T0),
    reviewService: new FakeReviewService(),
    trustedPrAuthor: "sentinel[bot]",
    trustedReviewer: "chatgpt-codex-connector[bot]",
    trustedResolutionAuthors: ["sentinel[bot]"],
    git: {
      localDir: input.sourcePath,
      remoteUrl: `file://${input.ctx.bare}`,
      gitHome: `${input.ctx.tmp}/home`,
      gitPath: "git",
      ...input.gitExtra,
    },
  });
  return { host, http };
}

function preserverRun(input: {
  ctx: CandidateCtxV1;
  state: MemoryState;
  port: Pick<GitHubPort, "readRef" | "pushHead">;
  sourcePath: string;
  http: HttpTransportV1;
  gate: FakeGate;
  protectedPaths?: readonly string[];
  runtime?: ReplayRuntimeV1;
  ensure?: (taskId: WorkItemId, head: GitSha) => Promise<PortResultV1<void>>;
}) {
  return createCandidatePreserver({
    state: input.state,
    gate: input.gate,
    token: "dummy-token",
    http: input.http,
    clock: new FakeClock(T0),
    sourcePath: input.sourcePath,
    scratch: `${input.ctx.tmp}/home`,
    trustedPath: TRUSTED_PATH,
    gitExecutable: "git",
    runtime: input.runtime,
    remoteUrl: `file://${input.ctx.bare}`,
    apiBaseUrl: "https://api.github.com",
    port: input.port,
    protectedPaths: input.protectedPaths ?? [],
    ensureLocalCandidate: input.ensure ??
      (() => Promise.resolve(portOk(undefined))),
  });
}

/** Drive the real preserver over the real port/remote and record every push. */
async function preserveAttempt(input: {
  ctx: CandidateCtxV1;
  state: MemoryState;
  taskId: WorkItemId;
  sourcePath: string;
  candidate: CandidatePreservationV1;
  publishedHead?: GitSha | null;
  protectedPaths?: readonly string[];
  runtime?: ReplayRuntimeV1;
  ensure?: (taskId: WorkItemId, head: GitSha) => Promise<PortResultV1<void>>;
  gitExtra?: Partial<DenoGitExecutorOptions>;
  pushOverride?: (
    realPush: (
      ref: string,
      sha: GitSha,
      expected: GitSha | null,
    ) => Promise<PortResultV1<"applied" | "ambiguous">>,
    ref: string,
    sha: GitSha,
    expected: GitSha | null,
  ) => Promise<PortResultV1<"applied" | "ambiguous">>;
}) {
  const gate = new FakeGate();
  const { host, http } = candidatePort({
    ctx: input.ctx,
    sourcePath: input.sourcePath,
    gate,
    gitExtra: input.gitExtra,
  });
  const pushes: { ref: string; sha: GitSha; expected: GitSha | null }[] = [];
  const port: Pick<GitHubPort, "readRef" | "pushHead"> = {
    readRef: (ref) => host.port.readRef(ref),
    pushHead: async (ref, sha, expected) => {
      pushes.push({ ref, sha, expected });
      if (input.pushOverride !== undefined) {
        return await input.pushOverride(
          host.port.pushHead.bind(host.port),
          ref,
          sha,
          expected,
        );
      }
      return await host.port.pushHead(ref, sha, expected);
    },
  };
  const preserve = preserverRun({
    ctx: input.ctx,
    state: input.state,
    port,
    sourcePath: input.sourcePath,
    http: http.transport,
    gate,
    protectedPaths: input.protectedPaths,
    runtime: input.runtime,
    ensure: input.ensure,
  });
  const result = await preserve({
    taskId: input.taskId,
    candidate: input.candidate,
    publishedHead: input.publishedHead ?? null,
  });
  return { result, http, gate, pushes };
}

/** Force a truncated fetch in the fresh-store proof only. */
class TruncatingFetchRuntime implements ReplayRuntimeV1 {
  constructor(private readonly delegate: ReplayRuntimeV1) {}
  run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
    if (input.args.includes("fetch")) {
      return Promise.resolve({
        outcome: "exited",
        exitCode: 0,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        truncated: true,
        settled: true,
        detail: "truncated",
      });
    }
    return this.delegate.run(input);
  }
}

/**
 * Force one unsettled child in the fresh-store proof only. No real child is
 * spawned or intentionally left running: the runtime returns the uncertainty
 * directly, so the store-preservation behavior is asserted deterministically.
 */
class UnsettledInitRuntime implements ReplayRuntimeV1 {
  constructor(private readonly delegate: ReplayRuntimeV1) {}
  run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
    if (input.args.includes("init")) {
      return Promise.resolve({
        outcome: "timed_out",
        exitCode: null,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        truncated: false,
        settled: false,
        detail: "owned descendants could not be proved settled",
      });
    }
    return this.delegate.run(input);
  }
}

Deno.test(
  "preserver: stores the exact candidate in a create-only ref and proves a fresh empty store",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const taskId = CANDIDATE_TASK_ID;
      const ref = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        CANDIDATE_OPERATION_KEY,
      );
      const record = candidateRecord(ctx, {
        target: {
          base: ctx.base,
          branch: BRANCH,
          checkpoint: null,
          head: ctx.head,
          pr: 12,
          candidateState: { preserved: null, publishedHead: null },
        },
        intent: {
          kind: "candidate_preservation",
          key: CANDIDATE_OPERATION_KEY,
          startedAt: T0,
          branch: ref,
          expectedHead: ctx.head,
          observedBase: ctx.base,
          pr: null,
          requestId: PRESERVATION_ID,
          resultId: null,
        },
      });
      const state = new MemoryState();
      state.repair = snapshot([record], [submittedReservation(record)]);
      const durableBefore = structuredClone(state.repair);
      const mirrorPath = await mirror(ctx);
      const ensured: { taskId: string; head: GitSha }[] = [];
      const attempt = await preserveAttempt({
        ctx,
        state,
        taskId,
        sourcePath: mirrorPath,
        candidate: await candidateFor(
          taskId,
          ctx.base,
          ctx.head,
          CANDIDATE_OPERATION_KEY,
        ),
        ensure: (id, head) => {
          ensured.push({ taskId: id, head });
          return Promise.resolve(portOk(undefined));
        },
      });
      assert.ok(attempt.result.ok, JSON.stringify(attempt.result));
      assert.equal(await remoteSha(ctx, ref), ctx.head);
      assert.equal(await remoteSha(ctx, `refs/heads/${BRANCH}`), ctx.head);
      assert.equal(await remoteSha(ctx, "refs/heads/development"), ctx.base);
      assert.deepEqual(ensured, [{ taskId, head: ctx.head }]);
      assert.deepEqual(
        state.repair,
        durableBefore,
        "preservation never rewrites durable state",
      );
      assert.equal(attempt.pushes.length, 1);
      assert.deepEqual(attempt.pushes[0], {
        ref,
        sha: ctx.head,
        expected: null,
      });
      assert.ok(attempt.http.paths.length > 0);
      assert.ok(
        attempt.http.paths.every((path) => path.includes("/git/ref/")),
        "preservation never reads a PR/task/review surface",
      );
      // Exactly one candidate ref exists: the deterministic operation ref.
      const candidateRefs = await gitRun(
        ctx.bare,
        [
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads/sentinel-candidates",
        ],
        ctx.env,
      );
      assert.ok(candidateRefs.ok);
      assert.deepEqual(
        candidateRefs.stdout.trim().split("\n").filter(Boolean),
        [
          ref,
        ],
      );
      // The exact task-owned fresh store was cleaned up after settling.
      const leftovers = [...Deno.readDirSync(`${ctx.tmp}/home`)].filter(
        (entry) => entry.name.startsWith("sentinel-candidate-store-"),
      );
      assert.deepEqual(leftovers, []);

      // Recovery: delete the producer checkout and the source mirror, then run
      // the REAL preserver again from a NEW empty source with the original
      // unchanged state and intent. The exact operation ref already exists, so
      // the run must reconcile it without a push and without any
      // producer-loader call; the fresh-store durability proof still runs real.
      await Deno.remove(`${ctx.tmp}/work`, { recursive: true });
      await Deno.remove(mirrorPath, { recursive: true });
      const emptySource = `${ctx.tmp}/recovered.git`;
      await Deno.mkdir(emptySource, { recursive: true });
      assert.ok(
        (await gitRun(emptySource, ["init", "-q", "--bare"], ctx.env)).ok,
      );
      const loaderCalls = ensured.length;
      const recovery = await preserveAttempt({
        ctx,
        state,
        taskId,
        sourcePath: emptySource,
        candidate: await candidateFor(
          taskId,
          ctx.base,
          ctx.head,
          CANDIDATE_OPERATION_KEY,
        ),
        ensure: (id, head) => {
          ensured.push({ taskId: id, head });
          return Promise.resolve(portOk(undefined));
        },
      });
      assert.ok(recovery.result.ok, JSON.stringify(recovery.result));
      assert.equal(
        recovery.pushes.length,
        0,
        "the exact existing operation ref is reconciled, never pushed again",
      );
      assert.equal(
        ensured.length,
        loaderCalls,
        "already durable objects need no producer-loader call",
      );
      assert.deepEqual(
        state.repair,
        durableBefore,
        "recovery never rewrites durable state",
      );
      const recoveredLeftovers = [...Deno.readDirSync(`${ctx.tmp}/home`)]
        .filter((entry) => entry.name.startsWith("sentinel-candidate-store-"));
      assert.deepEqual(
        recoveredLeftovers,
        [],
        "the successful real fresh-store proof cleans its store",
      );
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "preserver: missing or mismatched bindings write nothing",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const taskId = CANDIDATE_TASK_ID;
      const ref = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        CANDIDATE_OPERATION_KEY,
      );
      const valid = await candidateFor(
        taskId,
        ctx.base,
        ctx.head,
        CANDIDATE_OPERATION_KEY,
      );
      const mirrorPath = await mirror(ctx);
      const preservationRecord = (overrides: Record<string, unknown> = {}) =>
        candidateRecord(ctx, {
          target: {
            base: ctx.base,
            branch: BRANCH,
            checkpoint: null,
            head: ctx.head,
            pr: 12,
            candidateState: { preserved: null, publishedHead: null },
          },
          intent: {
            kind: "candidate_preservation",
            key: CANDIDATE_OPERATION_KEY,
            startedAt: T0,
            branch: ref,
            expectedHead: ctx.head,
            observedBase: ctx.base,
            pr: null,
            requestId: PRESERVATION_ID,
            resultId: null,
          },
          ...overrides,
        });
      const stateFor = (
        record: ReturnType<typeof candidateRecord>,
        entries = [submittedReservation(record)],
      ) => {
        const state = new MemoryState();
        state.repair = snapshot([record], entries);
        return state;
      };
      const noRecord = new MemoryState();
      noRecord.repair = snapshot([]);
      const legacy = stateFor(candidateRecord(ctx, {
        target: {
          base: ctx.base,
          branch: BRANCH,
          checkpoint: null,
          head: ctx.head,
          pr: 12,
        },
        intent: null,
      }));
      const record = preservationRecord();
      const wrongReservationOutcome = stateFor(
        record,
        [submittedReservation(record, {
          outcome: "reserved",
          settledAt: null,
        })],
      );
      const wrongReservationAttempt = stateFor(
        record,
        [submittedReservation(record, { attempt: 2 })],
      );
      const variants: {
        name: string;
        state: MemoryState;
        candidate: CandidatePreservationV1;
        publishedHead?: GitSha | null;
      }[] = [
        { name: "no record", state: noRecord, candidate: valid },
        {
          name: "legacy record without candidate state",
          state: legacy,
          candidate: valid,
        },
        {
          name: "unknown operation",
          state: stateFor(preservationRecord({
            intent: {
              kind: "implementation",
              key: CANDIDATE_OPERATION_KEY,
              startedAt: T0,
              branch: BRANCH,
              expectedHead: null,
              observedBase: ctx.base,
              pr: null,
              requestId: PRESERVATION_ID,
              resultId: null,
            },
          })),
          candidate: valid,
        },
        {
          name: "wrong operation key",
          state: stateFor(record),
          candidate: await candidateFor(
            taskId,
            ctx.base,
            ctx.head,
            `impl:${"b".repeat(64)}`,
          ),
        },
        {
          name: "wrong ref",
          state: stateFor(record),
          candidate: {
            ...valid,
            ref: await candidatePreservationRef(
              { ...SELF_REPO },
              taskId,
              `impl:${"c".repeat(64)}`,
            ),
          },
        },
        {
          name: "wrong head",
          state: stateFor(record),
          candidate: { ...valid, head: ctx.base },
        },
        {
          name: "published head mismatch",
          state: stateFor(record),
          candidate: valid,
          publishedHead: SHA1,
        },
        {
          name: "unsubmitted reservation",
          state: wrongReservationOutcome,
          candidate: valid,
        },
        {
          name: "attempt mismatch",
          state: wrongReservationAttempt,
          candidate: valid,
        },
      ];
      for (const variant of variants) {
        const attempt = await preserveAttempt({
          ctx,
          state: variant.state,
          taskId,
          sourcePath: mirrorPath,
          candidate: variant.candidate,
          publishedHead: variant.publishedHead,
        });
        assert.equal(attempt.result.ok, false, variant.name);
        assert.equal(attempt.pushes.length, 0, `${variant.name}: no push`);
        assert.equal(
          await remoteSha(ctx, variant.candidate.ref),
          null,
          `${variant.name}: no ref write`,
        );
      }
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "preserver: an existing different operation head conflicts and is never overwritten",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const taskId = CANDIDATE_TASK_ID;
      const ref = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        CANDIDATE_OPERATION_KEY,
      );
      const record = candidateRecord(ctx, {
        target: {
          base: ctx.base,
          branch: BRANCH,
          checkpoint: null,
          head: ctx.head,
          pr: 12,
          candidateState: { preserved: null, publishedHead: null },
        },
        intent: {
          kind: "candidate_preservation",
          key: CANDIDATE_OPERATION_KEY,
          startedAt: T0,
          branch: ref,
          expectedHead: ctx.head,
          observedBase: ctx.base,
          pr: null,
          requestId: PRESERVATION_ID,
          resultId: null,
        },
      });
      const state = new MemoryState();
      state.repair = snapshot([record], [submittedReservation(record)]);
      const mirrorPath = await mirror(ctx);
      // The same operation destination already carries a DIFFERENT exact SHA.
      assert.ok(
        (await gitRun(
          `${ctx.tmp}/work`,
          ["push", "-q", "origin", `${ctx.base}:${ref}`],
          ctx.env,
        )).ok,
      );
      const attempt = await preserveAttempt({
        ctx,
        state,
        taskId,
        sourcePath: mirrorPath,
        candidate: await candidateFor(
          taskId,
          ctx.base,
          ctx.head,
          CANDIDATE_OPERATION_KEY,
        ),
      });
      assert.equal(attempt.result.ok, false);
      assert.equal(
        attempt.result.ok ? null : attempt.result.error.kind,
        "conflict",
      );
      assert.equal(attempt.pushes.length, 0);
      assert.equal(await remoteSha(ctx, ref), ctx.base);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "preserver: a create race cannot overwrite the raced ref",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const taskId = CANDIDATE_TASK_ID;
      const ref = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        CANDIDATE_OPERATION_KEY,
      );
      const record = candidateRecord(ctx, {
        target: {
          base: ctx.base,
          branch: BRANCH,
          checkpoint: null,
          head: ctx.head,
          pr: 12,
          candidateState: { preserved: null, publishedHead: null },
        },
        intent: {
          kind: "candidate_preservation",
          key: CANDIDATE_OPERATION_KEY,
          startedAt: T0,
          branch: ref,
          expectedHead: ctx.head,
          observedBase: ctx.base,
          pr: null,
          requestId: PRESERVATION_ID,
          resultId: null,
        },
      });
      const state = new MemoryState();
      state.repair = snapshot([record], [submittedReservation(record)]);
      const mirrorPath = await mirror(ctx);
      // After the create-only guard validated the expected absence, another
      // writer creates the ref: the atomic receive-pack transaction must reject
      // our push and the raced SHA must survive.
      const attempt = await preserveAttempt({
        ctx,
        state,
        taskId,
        sourcePath: mirrorPath,
        candidate: await candidateFor(
          taskId,
          ctx.base,
          ctx.head,
          CANDIDATE_OPERATION_KEY,
        ),
        gitExtra: {
          // The nested push must actually create the raced ref: the outer
          // guard's hooks path is disabled for it, and a failure fails the
          // hook (no `|| true`) so a silent non-race can never pass.
          prePushHookExtra:
            `git -c core.hooksPath=/dev/null push 'file://${ctx.bare}' '${ctx.base}:${ref}' >/dev/null 2>&1`,
        },
      });
      assert.equal(attempt.result.ok, false);
      assert.equal(attempt.pushes.length, 1);
      assert.equal(await remoteSha(ctx, ref), ctx.base);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "preserver: a lost push response reconciles with exactly one reread",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const taskId = CANDIDATE_TASK_ID;
      const ref = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        CANDIDATE_OPERATION_KEY,
      );
      const record = candidateRecord(ctx, {
        target: {
          base: ctx.base,
          branch: BRANCH,
          checkpoint: null,
          head: ctx.head,
          pr: 12,
          candidateState: { preserved: null, publishedHead: null },
        },
        intent: {
          kind: "candidate_preservation",
          key: CANDIDATE_OPERATION_KEY,
          startedAt: T0,
          branch: ref,
          expectedHead: ctx.head,
          observedBase: ctx.base,
          pr: null,
          requestId: PRESERVATION_ID,
          resultId: null,
        },
      });
      const state = new MemoryState();
      state.repair = snapshot([record], [submittedReservation(record)]);
      const mirrorPath = await mirror(ctx);
      // The real push APPLIES but its response is lost: the single authenticated
      // reread reconciles the exact head and no second push happens.
      let effects = 0;
      const lost = await preserveAttempt({
        ctx,
        state,
        taskId,
        sourcePath: mirrorPath,
        candidate: await candidateFor(
          taskId,
          ctx.base,
          ctx.head,
          CANDIDATE_OPERATION_KEY,
        ),
        pushOverride: async (realPush, pushRef, sha, expected) => {
          const applied = await realPush(pushRef, sha, expected);
          assert.ok(applied.ok);
          effects++;
          return portOk("ambiguous");
        },
      });
      assert.ok(lost.result.ok, JSON.stringify(lost.result));
      assert.equal(effects, 1);
      assert.equal(lost.pushes.length, 1);
      assert.equal(await remoteSha(ctx, ref), ctx.head);

      // The ambiguous response did NOT apply: the reread proves absence and
      // no success is reported.
      const absentRef = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        `impl:${"d".repeat(64)}`,
      );
      const absentRecord = candidateRecord(ctx, {
        target: {
          base: ctx.base,
          branch: BRANCH,
          checkpoint: null,
          head: ctx.head,
          pr: 12,
          candidateState: { preserved: null, publishedHead: null },
        },
        intent: {
          kind: "candidate_preservation",
          key: `impl:${"d".repeat(64)}`,
          startedAt: T0,
          branch: absentRef,
          expectedHead: ctx.head,
          observedBase: ctx.base,
          pr: null,
          requestId: "d".repeat(64),
          resultId: null,
        },
      });
      const absent = new MemoryState();
      absent.repair = snapshot([absentRecord], [
        reservation("d".repeat(64), {
          repository: { ...SELF_REPO },
          taskId: absentRecord.id,
          attempt: absentRecord.counters.attempts,
          head: ctx.base,
          purpose: "implementation",
          outcome: "submitted",
          settledAt: T0 + 5,
          proofRef: null,
        }),
      ]);
      const unconfirmed = await preserveAttempt({
        ctx,
        state: absent,
        taskId,
        sourcePath: mirrorPath,
        candidate: await candidateFor(
          taskId,
          ctx.base,
          ctx.head,
          `impl:${"d".repeat(64)}`,
        ),
        pushOverride: () => Promise.resolve(portOk("ambiguous")),
      });
      assert.equal(unconfirmed.result.ok, false);
      assert.equal(await remoteSha(ctx, absentRef), null);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "preserver: validator rejection does zero push",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const taskId = CANDIDATE_TASK_ID;
      const ref = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        CANDIDATE_OPERATION_KEY,
      );
      const record = candidateRecord(ctx, {
        target: {
          base: ctx.base,
          branch: BRANCH,
          checkpoint: null,
          head: ctx.head,
          pr: 12,
          candidateState: { preserved: null, publishedHead: null },
        },
        intent: {
          kind: "candidate_preservation",
          key: CANDIDATE_OPERATION_KEY,
          startedAt: T0,
          branch: ref,
          expectedHead: ctx.head,
          observedBase: ctx.base,
          pr: null,
          requestId: PRESERVATION_ID,
          resultId: null,
        },
      });
      const state = new MemoryState();
      state.repair = snapshot([record], [submittedReservation(record)]);
      const mirrorPath = await mirror(ctx);
      let ensured = 0;
      const attempt = await preserveAttempt({
        ctx,
        state,
        taskId,
        sourcePath: mirrorPath,
        candidate: await candidateFor(
          taskId,
          ctx.base,
          ctx.head,
          CANDIDATE_OPERATION_KEY,
        ),
        // The candidate adds candidate.txt, which the base does not contain:
        // the protected entry changed and publication must be rejected.
        protectedPaths: ["candidate.txt"],
        ensure: () => {
          ensured++;
          return Promise.resolve(portOk(undefined));
        },
      });
      assert.equal(attempt.result.ok, false);
      assert.equal(ensured, 1);
      assert.equal(attempt.pushes.length, 0);
      assert.equal(await remoteSha(ctx, ref), null);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "preserver: a truncated fresh-store fetch never reports preservation",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const taskId = CANDIDATE_TASK_ID;
      const ref = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        CANDIDATE_OPERATION_KEY,
      );
      const record = candidateRecord(ctx, {
        target: {
          base: ctx.base,
          branch: BRANCH,
          checkpoint: null,
          head: ctx.head,
          pr: 12,
          candidateState: { preserved: null, publishedHead: null },
        },
        intent: {
          kind: "candidate_preservation",
          key: CANDIDATE_OPERATION_KEY,
          startedAt: T0,
          branch: ref,
          expectedHead: ctx.head,
          observedBase: ctx.base,
          pr: null,
          requestId: PRESERVATION_ID,
          resultId: null,
        },
      });
      const state = new MemoryState();
      state.repair = snapshot([record], [submittedReservation(record)]);
      const mirrorPath = await mirror(ctx);
      const runtime = new TruncatingFetchRuntime(
        new DenoReplayRuntime(TRUSTED_PATH),
      );
      const attempt = await preserveAttempt({
        ctx,
        state,
        taskId,
        sourcePath: mirrorPath,
        candidate: await candidateFor(
          taskId,
          ctx.base,
          ctx.head,
          CANDIDATE_OPERATION_KEY,
        ),
        runtime,
      });
      assert.equal(attempt.result.ok, false);
      assert.equal(attempt.pushes.length, 1);
      assert.equal(
        await remoteSha(ctx, ref),
        ctx.head,
        "the ref exists but durability was not proved",
      );
      const leftovers = [...Deno.readDirSync(`${ctx.tmp}/home`)].filter(
        (entry) => entry.name.startsWith("sentinel-candidate-store-"),
      );
      assert.deepEqual(
        leftovers,
        [],
        "the failed proof still cleans its store",
      );
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "preserver: an unsettled proof child preserves its exact owned scratch",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const taskId = CANDIDATE_TASK_ID;
      const ref = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        CANDIDATE_OPERATION_KEY,
      );
      const record = candidateRecord(ctx, {
        target: {
          base: ctx.base,
          branch: BRANCH,
          checkpoint: null,
          head: ctx.head,
          pr: 12,
          candidateState: { preserved: null, publishedHead: null },
        },
        intent: {
          kind: "candidate_preservation",
          key: CANDIDATE_OPERATION_KEY,
          startedAt: T0,
          branch: ref,
          expectedHead: ctx.head,
          observedBase: ctx.base,
          pr: null,
          requestId: PRESERVATION_ID,
          resultId: null,
        },
      });
      const state = new MemoryState();
      state.repair = snapshot([record], [submittedReservation(record)]);
      const mirrorPath = await mirror(ctx);
      const attempt = await preserveAttempt({
        ctx,
        state,
        taskId,
        sourcePath: mirrorPath,
        candidate: await candidateFor(
          taskId,
          ctx.base,
          ctx.head,
          CANDIDATE_OPERATION_KEY,
        ),
        runtime: new UnsettledInitRuntime(new DenoReplayRuntime(TRUSTED_PATH)),
      });
      assert.equal(attempt.result.ok, false);
      assert.equal(attempt.pushes.length, 1);
      const kept = [...Deno.readDirSync(`${ctx.tmp}/home`)].filter(
        (entry) => entry.name.startsWith("sentinel-candidate-store-"),
      );
      assert.equal(
        kept.length,
        1,
        "an unproved child settlement preserves the exact owned store",
      );
      assert.equal(kept[0]!.isDirectory, true);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "preserver: a persisted base_refresh result keeps the original descriptor",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
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
          ["branch", "-q", "sentinel-prepared", prepared],
          ctx.env,
        )).ok,
      );
      const mirrorPath = await mirror(ctx);
      const taskId = CANDIDATE_TASK_ID;
      const implRef = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        CANDIDATE_OPERATION_KEY,
      );
      const refreshKey = baseRefreshIntentKey(12, ctx.head, newBase);
      const refreshRef = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        refreshKey,
      );
      const preserved = {
        operationKey: CANDIDATE_OPERATION_KEY,
        base: ctx.base,
        head: ctx.head,
        ref: implRef,
      };
      const record = candidateRecord(ctx, {
        target: {
          base: ctx.base,
          branch: BRANCH,
          checkpoint: null,
          head: ctx.head,
          pr: 12,
          candidateState: { preserved, publishedHead: null },
        },
        intent: {
          kind: "base_refresh",
          key: refreshKey,
          startedAt: T0,
          branch: BRANCH,
          expectedHead: ctx.head,
          observedBase: newBase,
          pr: 12,
          requestId: null,
          resultId: prepared,
        },
      });
      const state = new MemoryState();
      state.repair = snapshot([record]);
      const durableBefore = structuredClone(state.repair);
      const attempt = await preserveAttempt({
        ctx,
        state,
        taskId,
        sourcePath: mirrorPath,
        candidate: {
          operationKey: refreshKey,
          base: newBase,
          head: prepared,
          ref: refreshRef,
        },
      });
      assert.ok(attempt.result.ok, JSON.stringify(attempt.result));
      assert.equal(await remoteSha(ctx, refreshRef), prepared);
      assert.deepEqual(
        state.repair,
        durableBefore,
        "the original descriptor and the old target binding are never rewritten",
      );
      assert.equal(
        await remoteSha(ctx, implRef),
        null,
        "the retained original ref is not replaced by the refresh",
      );
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "actions candidates: new-shape restorer uses the operation ref, never the mutable task branch",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const taskId = CANDIDATE_TASK_ID;
      const ref = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        CANDIDATE_OPERATION_KEY,
      );
      const preserved = {
        operationKey: CANDIDATE_OPERATION_KEY,
        base: ctx.base,
        head: ctx.head,
        ref,
      };
      const work = `${ctx.tmp}/work`;
      // The mutable task branch is moved AWAY from the candidate while the
      // retained operation ref keeps carrying it.
      assert.ok(
        (await gitRun(
          work,
          [
            "push",
            "-q",
            "--force",
            "origin",
            `${ctx.base}:refs/heads/${BRANCH}`,
          ],
          ctx.env,
        )).ok,
      );
      assert.ok(
        (await gitRun(
          work,
          ["push", "-q", "origin", `${ctx.head}:${ref}`],
          ctx.env,
        ))
          .ok,
      );
      const persisted = new MemoryState();
      persisted.repair = snapshot([
        candidateRecord(ctx, {
          target: {
            base: ctx.base,
            branch: BRANCH,
            checkpoint: null,
            head: ctx.head,
            pr: 12,
            candidateState: { preserved, publishedHead: null },
          },
          intent: null,
        }),
      ]);
      const clone = await ctx.clone();
      assert.equal(await objectPresent(clone, ctx.env, ctx.head), false);
      const ensured = await restorer(
        ctx,
        persisted,
        new FakeGate(),
        new RefHttp(ctx.head),
        clone,
      ).ensure({ base: ctx.base, head: ctx.head });
      assert.ok(ensured.ok, JSON.stringify(ensured));
      assert.equal(await objectPresent(clone, ctx.env, ctx.head), true);

      // A pending candidate_preservation intent restores only its exact
      // intent-bound ref (the same moved task branch cannot satisfy it).
      const pendingRecord = candidateRecord(ctx, {
        target: {
          base: ctx.base,
          branch: BRANCH,
          checkpoint: null,
          head: ctx.head,
          pr: 12,
          candidateState: { preserved: null, publishedHead: null },
        },
        intent: {
          kind: "candidate_preservation",
          key: CANDIDATE_OPERATION_KEY,
          startedAt: T0,
          branch: ref,
          expectedHead: ctx.head,
          observedBase: ctx.base,
          pr: null,
          requestId: PRESERVATION_ID,
          resultId: null,
        },
      });
      const pendingState = new MemoryState();
      pendingState.repair = snapshot(
        [pendingRecord],
        [submittedReservation(pendingRecord)],
      );
      const pendingClone = await ctx.clone();
      const pending = await restorer(
        ctx,
        pendingState,
        new FakeGate(),
        new RefHttp(ctx.head),
        pendingClone,
      ).ensure({ base: ctx.base, head: ctx.head });
      assert.ok(pending.ok, JSON.stringify(pending));
      assert.equal(await objectPresent(pendingClone, ctx.env, ctx.head), true);
    } finally {
      await ctx.cleanup();
    }
  },
);
