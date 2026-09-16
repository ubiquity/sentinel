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
  GitHubIssueV1,
  GitHubPort,
  GitHubPullRequestV1,
  GitHubRefV1,
  LegacyBaseRefreshLossProofV1,
  PortResultV1,
  StateReadResultV1,
  StateReadView,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type {
  CandidatePreservationV1,
  WorkRecordV1,
} from "../../src/contracts/work-record.ts";
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
  createLegacyBaseRefreshLossProver,
} from "../../src/host/actions-candidates.ts";
import { composeGitHubHost } from "../../src/host/github.ts";
import {
  createLocalCandidateLoader,
  localCheckoutKey,
} from "../../src/host/local.ts";
import {
  baseRefreshIntentKey,
  candidateBranch,
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
import {
  REPO,
  reservation,
  reviewReceipt,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";

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

// ---------------------------------------------------------------------------
// Legacy base-refresh candidate loss: the REAL prover factory, the REAL
// createLocalCandidateLoader and REAL bounded Git fetch into a new empty store.
// Only the authenticated GitHub read port is scripted; nothing is written.
// ---------------------------------------------------------------------------

const LEGACY_TASK_ID = CANDIDATE_TASK_ID;
const LEGACY_BRANCH = candidateBranch(CANDIDATE_TASK_ID);
const LEGACY_PR = 12;
const LEGACY_AUTHOR = "sentinel[bot]";
const LEGACY_REVIEWER = "chatgpt-codex-connector[bot]";
const LEGACY_STORE_PREFIX = "sentinel-legacy-loss-store-";

/** Scripted read-only GitHub port over explicit observations. */
class LegacyLossPort {
  readonly reviewerIdentity = LEGACY_REVIEWER;
  readonly calls: string[] = [];
  issue: PortResultV1<GitHubIssueV1 | null>;
  pull: PortResultV1<GitHubPullRequestV1 | null>;
  ref: PortResultV1<GitHubRefV1 | null>;

  constructor(init: {
    issue: PortResultV1<GitHubIssueV1 | null>;
    pull: PortResultV1<GitHubPullRequestV1 | null>;
    ref: PortResultV1<GitHubRefV1 | null>;
  }) {
    this.issue = init.issue;
    this.pull = init.pull;
    this.ref = init.ref;
  }

  readIssue(issueNumber: number): Promise<PortResultV1<GitHubIssueV1 | null>> {
    this.calls.push(`issue:${issueNumber}`);
    return Promise.resolve(this.issue);
  }

  readPullRequest(
    number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    this.calls.push(`pr:${number}`);
    return Promise.resolve(this.pull);
  }

  readRef(ref: string): Promise<PortResultV1<GitHubRefV1 | null>> {
    this.calls.push(`ref:${ref}`);
    return Promise.resolve(this.ref);
  }
}

/** Bounded runtime that records every git argv and never spawns. */
class CountingRuntime implements ReplayRuntimeV1 {
  calls = 0;
  run(_input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
    this.calls++;
    return Promise.resolve({
      outcome: "spawn_failed",
      exitCode: null,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      truncated: false,
      settled: true,
      detail: "unexpected legacy-loss git run",
    });
  }
}

/** Real runtime wrapper that records every git argv. */
class RecordingRuntime implements ReplayRuntimeV1 {
  readonly calls: string[][] = [];
  constructor(private readonly delegate: ReplayRuntimeV1) {}
  run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
    this.calls.push([...input.args]);
    return this.delegate.run(input);
  }
}

/** Real state wrapper whose SECOND read reports a different authoritative head. */
class DriftingLossState implements StateReadView {
  reads = 0;
  constructor(
    private readonly inner: MemoryState,
    private readonly secondHead: GitSha,
  ) {}
  readRepair(): Promise<
    PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
  > {
    this.reads++;
    return this.inner.readRepair().then((result) => {
      if (this.reads === 1 || !result.ok || result.value.status !== "found") {
        return result;
      }
      return portOk({ ...result.value, head: this.secondHead });
    });
  }
  readRelease(): Promise<PortResultV1<StateReadResultV1<never>>> {
    return this.inner.readRelease();
  }
}

/** Real loader whose calls are counted (the loader itself is unchanged). */
function countingCandidateLoader(): {
  load: (taskId: WorkItemId, head: GitSha) => Promise<PortResultV1<void>>;
  calls: { taskId: string; head: GitSha }[];
} {
  const calls: { taskId: string; head: GitSha }[] = [];
  return {
    calls,
    load: (taskId, head) => {
      calls.push({ taskId, head });
      return Promise.resolve(portError("not_found", "candidate is absent"));
    },
  };
}

function legacyIssue(overrides: Partial<GitHubIssueV1> = {}): GitHubIssueV1 {
  return {
    number: 1,
    title: "legacy loss",
    body: "<!-- sentinel:repair -->\n",
    state: "open",
    author: null,
    labels: [],
    createdAt: T0,
    updatedAt: T0,
    closedAt: null,
    relations: { openBlockers: [], subIssueCount: 0 },
    ...overrides,
  };
}

function legacyPull(input: {
  predecessor: GitSha;
  base?: GitSha;
  overrides?: Partial<GitHubPullRequestV1>;
}): GitHubPullRequestV1 {
  return {
    number: LEGACY_PR,
    title: "legacy loss",
    body: "",
    state: "open",
    head: input.predecessor,
    base: input.base ?? SHA1,
    mergeSha: null,
    headRef: LEGACY_BRANCH,
    baseRef: "development",
    author: LEGACY_AUTHOR,
    createdAt: T0,
    updatedAt: T0,
    mergedAt: null,
    reviewDecision: "none",
    ...input.overrides,
  };
}

function legacyReview(input: {
  id: string;
  head: GitSha;
  base: GitSha;
  overrides?: Record<string, unknown>;
}): ReviewReceiptV1 {
  return reviewReceipt(input.id, {
    expectedReviewer: LEGACY_REVIEWER,
    observedReviewer: LEGACY_REVIEWER,
    repository: { ...SELF_REPO },
    pullRequest: { number: LEGACY_PR, head: input.head, base: input.base },
    outcome: "completed",
    resultId: "result-1",
    summary: null,
    findings: [{
      id: "finding-1",
      severity: "P2",
      path: null,
      message: "correction required",
      fingerprint: "a".repeat(64),
      resolved: false,
      resolutionEvidence: null,
    }],
    findingsUncounted: 0,
    unresolvedSeverities: ["P2"],
    submittedAt: T0 + 1000,
    completedAt: T0 + 2000,
    observedAt: T0 + 3000,
    ...input.overrides,
  });
}

/** Exact covered legacy record; overrides stay explicit per test. */
function legacyRecord(input: {
  lost: GitSha;
  base: GitSha;
  observedBase: GitSha;
  nextStep?: "work" | "blocked" | "review" | "delivery";
  blocker?: unknown;
  dependencies?: string[];
  target?: Record<string, unknown>;
  intent?: Record<string, unknown>;
  workOverrides?: Record<string, unknown>;
}): WorkRecordV1 {
  return workRecord(CANDIDATE_TASK_ID, {
    repository: { ...SELF_REPO },
    source: { kind: "issue", id: "1", revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    dependencies: input.dependencies ?? [],
    target: {
      base: input.base,
      branch: LEGACY_BRANCH,
      checkpoint: null,
      head: input.lost,
      pr: LEGACY_PR,
      ...input.target,
    },
    nextStep: input.nextStep ?? "work",
    blocker: input.blocker ?? null,
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    intent: {
      kind: "base_refresh",
      key: baseRefreshIntentKey(LEGACY_PR, input.lost, input.observedBase),
      startedAt: T0,
      branch: LEGACY_BRANCH,
      expectedHead: input.lost,
      observedBase: input.observedBase,
      pr: LEGACY_PR,
      requestId: null,
      resultId: null,
      ...input.intent,
    },
    updatedAt: T0 + 1000,
    ...input.workOverrides,
  });
}

/** Exact submitted implementation reservation for one legacy attempt. */
const LEGACY_RESERVATION_ID = "a".repeat(64);

function legacyReservation(
  record: WorkRecordV1,
  overrides: Record<string, unknown> = {},
) {
  return reservation(LEGACY_RESERVATION_ID, {
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

/** Parsed durable snapshot with explicit reviews and distinct heads. */
function legacyState(
  work: RepairStateSnapshotV1["work"],
  reservations: RepairStateSnapshotV1["reservations"],
  reviews: RepairStateSnapshotV1["reviews"] = [],
  heads: { snapshotHead?: GitSha; readHead?: GitSha } = {},
): MemoryState {
  const state = new MemoryState();
  const parsed = snapshot(work, reservations);
  parsed.reviews = reviews;
  parsed.stateHead = heads.snapshotHead ?? SHA1;
  state.repair = parsed;
  state.repairHead = heads.readHead ?? SHA1;
  return state;
}

/** Real fixture: B0, moved base B1, reviewed predecessor H0 on the exact task
 * branch, and a lost correction H1 that exists in no trusted store. */
async function makeLegacyLossCtx(): Promise<{
  ctx: CandidateCtxV1;
  branch: string;
  movedBase: GitSha;
  lost: GitSha;
  sourcePath: string;
  stateRoot: string;
  producer: string;
}> {
  const ctx = await makeCandidateCtx();
  try {
    const work = `${ctx.tmp}/work`;
    const branch = LEGACY_BRANCH;
    assert.ok(
      (await gitRun(
        work,
        ["push", "-q", "origin", `${ctx.head}:refs/heads/${branch}`],
        ctx.env,
      )).ok,
    );
    // The configured base advances to B1 while B0 stays H0's parent.
    assert.ok(
      (await gitRun(work, ["checkout", "-q", "development"], ctx.env)).ok,
    );
    const movedBase = await commitIn(work, ctx.env, "moved-base");
    assert.ok(
      (await gitRun(work, ["push", "-q", "origin", "development"], ctx.env)).ok,
    );
    // H1 is produced in a disposable clone and published nowhere; the clone is
    // deleted, so H1 exists in no trusted store afterwards.
    const lostDir = `${ctx.tmp}/lost`;
    assert.ok(
      (await gitRun(
        ctx.tmp,
        ["clone", "-q", "--no-hardlinks", `file://${ctx.bare}`, lostDir],
        ctx.env,
      )).ok,
    );
    assert.ok(
      (await gitRun(lostDir, ["checkout", "-q", ctx.base], ctx.env)).ok,
    );
    const lost = await commitIn(lostDir, ctx.env, "lost-correction");
    await Deno.remove(lostDir, { recursive: true });
    assert.notEqual(lost, ctx.base);
    assert.notEqual(lost, ctx.head);
    assert.notEqual(lost, movedBase);
    // The trusted source mirror and the exact mapped producer checkout are
    // real repositories that both lack H1.
    const sourcePath = await mirror(ctx);
    const stateRoot = `${ctx.tmp}/state`;
    const key = await localCheckoutKey(CANDIDATE_TASK_ID);
    const checkouts = `${stateRoot}/checkouts`;
    await Deno.mkdir(checkouts, { recursive: true });
    const producer = `${checkouts}/${key}`;
    const cloned = await gitRun(
      ctx.tmp,
      ["clone", "-q", "--no-hardlinks", work, producer],
      ctx.env,
    );
    assert.ok(cloned.ok, cloned.stderr);
    await Deno.writeTextFile(
      `${checkouts}/${key}.json`,
      JSON.stringify({
        version: "v1",
        kind: "local_checkout",
        taskId: CANDIDATE_TASK_ID,
        key,
        base: ctx.base,
      }),
    );
    return {
      ctx,
      branch,
      movedBase,
      lost,
      sourcePath,
      stateRoot,
      producer,
    };
  } catch (error) {
    await ctx.cleanup();
    throw error;
  }
}

/** The real prover factory over one real fixture remote. */
function legacyProver(input: {
  ctx: CandidateCtxV1;
  state: StateReadView;
  port: LegacyLossPort;
  ensure: (taskId: WorkItemId, head: GitSha) => Promise<PortResultV1<void>>;
  gate?: FakeGate;
  runtime?: ReplayRuntimeV1;
  scratch?: string;
  remoteUrl?: string;
}) {
  return createLegacyBaseRefreshLossProver({
    state: input.state,
    port: input.port,
    gate: input.gate ?? new FakeGate(),
    token: "dummy-token",
    scratch: input.scratch ?? `${input.ctx.tmp}/home`,
    trustedPath: TRUSTED_PATH,
    gitExecutable: "git",
    baseBranch: "development",
    trustedPrAuthor: LEGACY_AUTHOR,
    ensureLocalCandidate: input.ensure,
    runtime: input.runtime,
    remoteUrl: input.remoteUrl ?? `file://${input.ctx.bare}`,
  });
}

function legacyStoreLeftovers(scratch: string): string[] {
  return [...Deno.readDirSync(scratch)]
    .filter((entry) => entry.name.startsWith(LEGACY_STORE_PREFIX))
    .map((entry) => entry.name)
    .sort();
}

Deno.test(
  "legacy loss: proves the exact scoped legacy candidate loss over the real loader and a fresh store",
  async () => {
    const fixture = await makeLegacyLossCtx();
    const { ctx } = fixture;
    try {
      const taskId = CANDIDATE_TASK_ID;
      const refsBefore = await gitRun(
        ctx.bare,
        ["for-each-ref", "--format=%(refname) %(objectname)"],
        ctx.env,
      );
      assert.ok(refsBefore.ok);
      const loader = createLocalCandidateLoader({
        stateRoot: fixture.stateRoot,
        sourcePath: fixture.sourcePath,
        scratch: `${ctx.tmp}/home`,
        trustedPath: TRUSTED_PATH,
      });
      let loaderCalls = 0;
      const countedLoader = (id: WorkItemId, head: GitSha) => {
        loaderCalls++;
        return loader(id, head);
      };
      // The trusted source and the exact producer checkout really lack H1.
      assert.equal(
        await objectPresent(fixture.sourcePath, ctx.env, fixture.lost),
        false,
      );
      assert.equal(
        await objectPresent(fixture.producer, ctx.env, fixture.lost),
        false,
      );
      // B0 is an ancestor of H0 while the PR's current base differs from B0.
      assert.notEqual(fixture.movedBase, ctx.base);
      assert.equal(
        (await gitRun(
          ctx.bare,
          ["merge-base", "--is-ancestor", ctx.base, ctx.head],
          ctx.env,
        )).code,
        0,
      );
      const reviews = [
        legacyReview({ id: "review-b", head: ctx.head, base: ctx.base }),
        legacyReview({ id: "review-a", head: ctx.head, base: ctx.base }),
      ];
      const record = legacyRecord({
        lost: fixture.lost,
        base: ctx.base,
        observedBase: fixture.movedBase,
      });
      // The snapshot's own stateHead deliberately differs from the read head.
      const state = legacyState(
        [record],
        [legacyReservation(record)],
        reviews,
        {
          snapshotHead: SHA2,
          readHead: SHA1,
        },
      );
      const durableBefore = structuredClone(state.repair);
      const port = new LegacyLossPort({
        issue: portOk(legacyIssue()),
        pull: portOk(legacyPull({
          predecessor: ctx.head,
          base: fixture.movedBase,
        })),
        ref: portOk({ ref: `refs/heads/${fixture.branch}`, sha: ctx.head }),
      });
      const result = await legacyProver({
        ctx,
        state,
        port,
        ensure: countedLoader,
        runtime: new DenoReplayRuntime(TRUSTED_PATH),
      })(taskId);
      assert.ok(result.ok, JSON.stringify(result));
      if (!result.ok) throw new Error("unreachable");
      const expected: LegacyBaseRefreshLossProofV1 = {
        taskId,
        repository: { ...SELF_REPO },
        stateHead: SHA1,
        shape: "legacy_base_refresh",
        lostBase: ctx.base,
        lostHead: fixture.lost,
        predecessorHead: ctx.head,
        branch: fixture.branch,
        pr: LEGACY_PR,
        intentKey: baseRefreshIntentKey(
          LEGACY_PR,
          fixture.lost,
          fixture.movedBase,
        ),
        reviewId: "review-a",
      };
      assert.deepEqual(result.value, expected);

      // The blocked+missing_evidence shape proves the identical loss.
      const blockedRecord = legacyRecord({
        lost: fixture.lost,
        base: ctx.base,
        observedBase: fixture.movedBase,
        nextStep: "blocked",
        blocker: {
          kind: "missing_evidence",
          message: "candidate is unavailable for review",
          since: T0,
        },
      });
      const blockedState = legacyState(
        [blockedRecord],
        [legacyReservation(blockedRecord)],
        reviews,
        { snapshotHead: SHA2, readHead: SHA1 },
      );
      const blockedPort = new LegacyLossPort({
        issue: portOk(legacyIssue()),
        pull: portOk(legacyPull({
          predecessor: ctx.head,
          base: fixture.movedBase,
        })),
        ref: portOk({ ref: `refs/heads/${fixture.branch}`, sha: ctx.head }),
      });
      const blocked = await legacyProver({
        ctx,
        state: blockedState,
        port: blockedPort,
        ensure: countedLoader,
        runtime: new DenoReplayRuntime(TRUSTED_PATH),
      })(taskId);
      assert.ok(blocked.ok, JSON.stringify(blocked));
      if (!blocked.ok) throw new Error("unreachable");
      assert.deepEqual(blocked.value, expected);
      assert.equal(loaderCalls, 4, "both shapes drove the real loader twice");

      // No state, remote or candidate-ref write of any kind.
      assert.equal(state.repairWrites, 0);
      assert.equal(blockedState.repairWrites, 0);
      assert.deepEqual(state.repair, durableBefore);
      assert.deepEqual(
        (await gitRun(
          ctx.bare,
          ["for-each-ref", "--format=%(refname) %(objectname)"],
          ctx.env,
        )).stdout,
        refsBefore.stdout,
        "no remote ref changed",
      );
      const candidateRefs = await gitRun(
        ctx.bare,
        [
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads/sentinel-candidates",
        ],
        ctx.env,
      );
      assert.equal(candidateRefs.stdout.trim(), "");
      assert.deepEqual(legacyStoreLeftovers(`${ctx.tmp}/home`), []);
      assert.deepEqual(port.calls, [
        "issue:1",
        `ref:refs/heads/${fixture.branch}`,
        `pr:${LEGACY_PR}`,
        "issue:1",
        `ref:refs/heads/${fixture.branch}`,
        `pr:${LEGACY_PR}`,
      ]);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "legacy loss: unsupported shapes and cheap binding negatives refuse before local or remote work",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const base = SHA1;
      const lost = SHA2;
      const observed = SHA3;
      const valid = () => legacyRecord({ lost, base, observedBase: observed });
      const emptyState = new MemoryState();
      emptyState.repair = snapshot([]);
      emptyState.repairHead = SHA1;
      const withRecord = (
        record: WorkRecordV1,
        options: {
          extra?: WorkRecordV1[];
          reservations?: ReturnType<typeof reservation>[];
        } = {},
      ) =>
        legacyState(
          [record, ...(options.extra ?? [])],
          options.reservations ?? [legacyReservation(record)],
        );
      const withVariant = (
        build: (record: WorkRecordV1) => {
          extra?: WorkRecordV1[];
          reservations?: ReturnType<typeof reservation>[];
        },
      ) => {
        const record = valid();
        return withRecord(record, build(record));
      };
      const rows: {
        name: string;
        expect: "null" | "error";
        state: StateReadView;
      }[] = [
        { name: "no record", expect: "null", state: emptyState },
        {
          name: "new-format candidate state",
          expect: "null",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            target: {
              candidateState: { preserved: null, publishedHead: null },
            },
          })),
        },
        {
          name: "pre-receipt implementation intent",
          expect: "null",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            intent: {
              kind: "implementation",
              key: `impl:${"b".repeat(64)}`,
              requestId: null,
            },
          })),
        },
        {
          name: "prepared base refresh",
          expect: "null",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            intent: { resultId: SHA3 },
          })),
        },
        {
          name: "source id mismatch",
          expect: "error",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            workOverrides: {
              source: { kind: "issue", id: "2", revision: SHA1 },
            },
          })),
        },
        {
          name: "incident-related record",
          expect: "error",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            workOverrides: {
              related: { incidentId: "inc-1", issueNumber: 1 },
            },
          })),
        },
        {
          name: "missing dependency",
          expect: "error",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            dependencies: ["other-1"],
          })),
        },
        {
          name: "unfinished dependency",
          expect: "error",
          state: withRecord(
            legacyRecord({
              lost,
              base,
              observedBase: observed,
              dependencies: ["other-1"],
            }),
            { extra: [workRecord("other-1", { nextStep: "work" })] },
          ),
        },
        {
          name: "non-deterministic branch",
          expect: "error",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            target: { branch: "sentinel/repair/other" },
          })),
        },
        {
          name: "intent key mismatch",
          expect: "error",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            intent: { key: baseRefreshIntentKey(LEGACY_PR, lost, base) },
          })),
        },
        {
          name: "intent expected head mismatch",
          expect: "error",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            intent: { expectedHead: base },
          })),
        },
        {
          name: "intent branch mismatch",
          expect: "error",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            intent: { branch: "sentinel/repair/other" },
          })),
        },
        {
          name: "intent PR mismatch",
          expect: "error",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            intent: { pr: 13 },
          })),
        },
        {
          name: "no submitted reservation",
          expect: "error",
          state: withVariant(() => ({ reservations: [] })),
        },
        {
          name: "reservation attempt mismatch",
          expect: "error",
          state: withVariant((record) => ({
            reservations: [legacyReservation(record, { attempt: 2 })],
          })),
        },
        {
          name: "unsubmitted reservation",
          expect: "error",
          state: withVariant((record) => ({
            reservations: [legacyReservation(record, {
              outcome: "reserved",
              settledAt: null,
            })],
          })),
        },
        {
          name: "foreign reservation repository",
          expect: "error",
          state: withVariant((record) => ({
            reservations: [legacyReservation(record, { repository: REPO })],
          })),
        },
        {
          name: "reservation base mismatch",
          expect: "error",
          state: withVariant((record) => ({
            reservations: [legacyReservation(record, { head: SHA2 })],
          })),
        },
        {
          name: "continuation reservation",
          expect: "error",
          state: withVariant((record) => ({
            reservations: [
              legacyReservation(record, { purpose: "continuation" }),
            ],
          })),
        },
        {
          name: "lifecycle review",
          expect: "null",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            nextStep: "review",
          })),
        },
        {
          name: "lifecycle delivery",
          expect: "null",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            nextStep: "delivery",
          })),
        },
        {
          name: "blocked by another kind",
          expect: "null",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            nextStep: "blocked",
            blocker: {
              kind: "dependency",
              message: "waiting for another work item",
              since: T0,
            },
          })),
        },
      ];
      for (const row of rows) {
        const loader = countingCandidateLoader();
        const runtime = new CountingRuntime();
        const port = new LegacyLossPort({
          issue: portOk(legacyIssue()),
          pull: portOk(legacyPull({ predecessor: ctx.head })),
          ref: portOk({
            ref: `refs/heads/${LEGACY_BRANCH}`,
            sha: ctx.head,
          }),
        });
        const result = await legacyProver({
          ctx,
          state: row.state,
          port,
          ensure: loader.load,
          runtime,
        })(LEGACY_TASK_ID);
        if (row.expect === "null") {
          assert.ok(result.ok, `${row.name}: expected an explicit null`);
          assert.equal(result.ok ? result.value : "error", null, row.name);
        } else {
          assert.equal(result.ok, false, `${row.name}: expected a refusal`);
        }
        assert.equal(port.calls.length, 0, `${row.name}: no remote read`);
        assert.equal(loader.calls.length, 0, `${row.name}: no local loader`);
        assert.equal(runtime.calls, 0, `${row.name}: no git run`);
        assert.deepEqual(
          legacyStoreLeftovers(`${ctx.tmp}/home`),
          [],
          row.name,
        );
      }
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "legacy loss: source, ref and PR boundaries stop before the fresh-store proof",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const record = legacyRecord({
        lost: SHA2,
        base: SHA1,
        observedBase: SHA3,
      });
      const reviews = [
        legacyReview({ id: "review-a", head: ctx.head, base: SHA1 }),
      ];
      const state = legacyState(
        [record],
        [legacyReservation(record)],
        reviews,
      );
      const refName = `refs/heads/${LEGACY_BRANCH}`;
      const cases: {
        name: string;
        expectKind: string;
        issue?: PortResultV1<GitHubIssueV1 | null>;
        pull?: PortResultV1<GitHubPullRequestV1 | null>;
        ref?: PortResultV1<GitHubRefV1 | null>;
      }[] = [
        {
          name: "closed source issue",
          expectKind: "conflict",
          issue: portOk(legacyIssue({ state: "closed", closedAt: T0 + 1 })),
        },
        {
          name: "unscoped source issue",
          expectKind: "unavailable",
          issue: portOk(null),
        },
        {
          name: "unknown issue relations",
          expectKind: "unavailable",
          issue: portOk(legacyIssue({ relations: undefined })),
        },
        {
          name: "subissues present",
          expectKind: "conflict",
          issue: portOk(legacyIssue({
            relations: { openBlockers: [], subIssueCount: 1 },
          })),
        },
        {
          name: "open blocker",
          expectKind: "conflict",
          issue: portOk(legacyIssue({
            relations: {
              openBlockers: [{
                owner: "ubiquity",
                name: "sentinel",
                number: 9,
              }],
              subIssueCount: 0,
            },
          })),
        },
        {
          name: "wrong issue number",
          expectKind: "unavailable",
          issue: portOk(legacyIssue({ number: 2 })),
        },
        {
          name: "missing task branch",
          expectKind: "unavailable",
          ref: portOk(null),
        },
        {
          name: "branch carries the lost head",
          expectKind: "conflict",
          ref: portOk({ ref: refName, sha: SHA2 }),
        },
        {
          name: "branch and PR disagree",
          expectKind: "conflict",
          ref: portOk({ ref: refName, sha: ctx.head }),
          pull: portOk(legacyPull({ predecessor: SHA2 })),
        },
        {
          name: "missing PR",
          expectKind: "unavailable",
          pull: portOk(null),
        },
        {
          name: "wrong PR number",
          expectKind: "conflict",
          pull: portOk(legacyPull({
            predecessor: ctx.head,
            overrides: { number: 13 },
          })),
        },
        {
          name: "moved PR head",
          expectKind: "conflict",
          pull: portOk(legacyPull({
            predecessor: ctx.head,
            overrides: { head: SHA1 },
          })),
        },
        {
          name: "wrong PR head branch",
          expectKind: "conflict",
          pull: portOk(legacyPull({
            predecessor: ctx.head,
            overrides: { headRef: "sentinel/repair/other" },
          })),
        },
        {
          name: "wrong PR base branch",
          expectKind: "conflict",
          pull: portOk(legacyPull({
            predecessor: ctx.head,
            overrides: { baseRef: "main" },
          })),
        },
        {
          name: "untrusted PR author",
          expectKind: "conflict",
          pull: portOk(legacyPull({
            predecessor: ctx.head,
            overrides: { author: "stranger" },
          })),
        },
        {
          name: "merged PR",
          expectKind: "conflict",
          pull: portOk(legacyPull({
            predecessor: ctx.head,
            overrides: {
              state: "merged",
              mergeSha: ctx.head,
              mergedAt: T0,
            },
          })),
        },
      ];
      for (const entry of cases) {
        const loader = countingCandidateLoader();
        const runtime = new CountingRuntime();
        const port = new LegacyLossPort({
          issue: entry.issue ?? portOk(legacyIssue()),
          pull: entry.pull ??
            portOk(legacyPull({ predecessor: ctx.head, base: SHA3 })),
          ref: entry.ref ?? portOk({ ref: refName, sha: ctx.head }),
        });
        const result = await legacyProver({
          ctx,
          state,
          port,
          ensure: loader.load,
          runtime,
        })(LEGACY_TASK_ID);
        assert.equal(result.ok, false, entry.name);
        assert.equal(
          result.ok ? "" : result.error.kind,
          entry.expectKind,
          entry.name,
        );
        assert.equal(
          loader.calls.length,
          1,
          `${entry.name}: local absence checked once`,
        );
        assert.equal(runtime.calls, 0, `${entry.name}: no git run`);
        assert.deepEqual(
          legacyStoreLeftovers(`${ctx.tmp}/home`),
          [],
          entry.name,
        );
      }
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "legacy loss: invalid historical review evidence is never loss",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const record = legacyRecord({
        lost: SHA2,
        base: SHA1,
        observedBase: SHA3,
      });
      const cases: { name: string; reviews: ReviewReceiptV1[] }[] = [
        { name: "no review receipt", reviews: [] },
        {
          name: "pending review",
          reviews: [legacyReview({
            id: "review-a",
            head: ctx.head,
            base: SHA1,
            overrides: {
              outcome: "pending",
              observedReviewer: null,
              resultId: null,
              completedAt: null,
              findings: [],
              unresolvedSeverities: [],
            },
          })],
        },
        {
          name: "untrusted reviewer",
          reviews: [legacyReview({
            id: "review-a",
            head: ctx.head,
            base: SHA1,
            overrides: {
              expectedReviewer: "stranger[bot]",
              observedReviewer: "stranger[bot]",
            },
          })],
        },
        {
          name: "foreign repository",
          reviews: [legacyReview({
            id: "review-a",
            head: ctx.head,
            base: SHA1,
            overrides: { repository: REPO },
          })],
        },
        {
          name: "wrong reviewed head",
          reviews: [legacyReview({ id: "review-a", head: SHA1, base: SHA1 })],
        },
        {
          name: "wrong reviewed base",
          reviews: [
            legacyReview({ id: "review-a", head: ctx.head, base: SHA3 }),
          ],
        },
        {
          name: "no unresolved severities",
          reviews: [legacyReview({
            id: "review-a",
            head: ctx.head,
            base: SHA1,
            overrides: { findings: [], unresolvedSeverities: [] },
          })],
        },
      ];
      for (const entry of cases) {
        const loader = countingCandidateLoader();
        const runtime = new CountingRuntime();
        const port = new LegacyLossPort({
          issue: portOk(legacyIssue()),
          pull: portOk(legacyPull({ predecessor: ctx.head, base: SHA3 })),
          ref: portOk({
            ref: `refs/heads/${LEGACY_BRANCH}`,
            sha: ctx.head,
          }),
        });
        const result = await legacyProver({
          ctx,
          state: legacyState(
            [record],
            [legacyReservation(record)],
            entry.reviews,
          ),
          port,
          ensure: loader.load,
          runtime,
        })(LEGACY_TASK_ID);
        assert.equal(result.ok, false, entry.name);
        assert.equal(
          result.ok ? "" : result.error.kind,
          "unavailable",
          entry.name,
        );
        assert.equal(
          loader.calls.length,
          1,
          `${entry.name}: local absence checked once`,
        );
        assert.equal(runtime.calls, 0, `${entry.name}: no git run`);
      }
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "legacy loss: local candidate availability is never absence",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const record = legacyRecord({
        lost: SHA2,
        base: SHA1,
        observedBase: SHA3,
      });
      const state = legacyState([record], [legacyReservation(record)]);
      const portFor = () =>
        new LegacyLossPort({
          issue: portOk(legacyIssue()),
          pull: portOk(legacyPull({ predecessor: ctx.head })),
          ref: portOk({
            ref: `refs/heads/${LEGACY_BRANCH}`,
            sha: ctx.head,
          }),
        });
      // Present locally: an explicit null, no remote read and no git run.
      const presentLoader = countingCandidateLoader();
      presentLoader.load = (taskId, head) => {
        presentLoader.calls.push({ taskId, head });
        return Promise.resolve(portOk(undefined));
      };
      const presentRuntime = new CountingRuntime();
      const presentPort = portFor();
      const present = await legacyProver({
        ctx,
        state,
        port: presentPort,
        ensure: presentLoader.load,
        runtime: presentRuntime,
      })(LEGACY_TASK_ID);
      assert.ok(present.ok, JSON.stringify(present));
      assert.equal(present.ok ? present.value : "error", null);
      assert.equal(presentLoader.calls.length, 1);
      assert.equal(presentPort.calls.length, 0);
      assert.equal(presentRuntime.calls, 0);

      // Unknown local availability passes through unchanged.
      const unknownLoader = countingCandidateLoader();
      unknownLoader.load = (taskId, head) => {
        unknownLoader.calls.push({ taskId, head });
        return Promise.resolve(portError("unavailable", "loader unavailable"));
      };
      const unknownRuntime = new CountingRuntime();
      const unknownPort = portFor();
      const unknown = await legacyProver({
        ctx,
        state,
        port: unknownPort,
        ensure: unknownLoader.load,
        runtime: unknownRuntime,
      })(LEGACY_TASK_ID);
      assert.equal(unknown.ok, false);
      assert.equal(unknown.ok ? "" : unknown.error.kind, "unavailable");
      assert.equal(unknownPort.calls.length, 0);
      assert.equal(unknownRuntime.calls, 0);

      // Any other typed error is forwarded with its own identity.
      const conflictLoader = countingCandidateLoader();
      conflictLoader.load = (taskId, head) => {
        conflictLoader.calls.push({ taskId, head });
        return Promise.resolve(portError("conflict", "loader conflict"));
      };
      const conflict = await legacyProver({
        ctx,
        state,
        port: portFor(),
        ensure: conflictLoader.load,
        runtime: new CountingRuntime(),
      })(LEGACY_TASK_ID);
      assert.equal(conflict.ok, false);
      assert.equal(conflict.ok ? "" : conflict.error.kind, "conflict");
      assert.equal(conflict.ok ? "" : conflict.error.detail, "loader conflict");
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "legacy loss: a recorded head reachable from the fetched branch is never absence",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const work = `${ctx.tmp}/work`;
      assert.ok(
        (await gitRun(
          work,
          ["push", "-q", "origin", `${ctx.head}:refs/heads/${LEGACY_BRANCH}`],
          ctx.env,
        )).ok,
      );
      // A shallow trusted source really lacks H1 = B0 while the full history
      // the fresh fetch carries contains it.
      const shallow = `${ctx.tmp}/shallow`;
      const cloned = await gitRun(
        ctx.tmp,
        [
          "clone",
          "-q",
          "--depth=1",
          "--single-branch",
          "--branch",
          LEGACY_BRANCH,
          `file://${ctx.bare}`,
          shallow,
        ],
        ctx.env,
      );
      assert.ok(cloned.ok, cloned.stderr);
      const record = legacyRecord({
        lost: ctx.base,
        base: ctx.base,
        observedBase: SHA3,
      });
      const reviews = [
        legacyReview({ id: "review-a", head: ctx.head, base: ctx.base }),
      ];
      const state = legacyState(
        [record],
        [legacyReservation(record)],
        reviews,
      );
      // The exact loader root exists but has no mapping or checkout at all.
      await Deno.mkdir(`${ctx.tmp}/empty-state`, { recursive: true });
      const loader = createLocalCandidateLoader({
        stateRoot: `${ctx.tmp}/empty-state`,
        sourcePath: shallow,
        scratch: `${ctx.tmp}/home`,
        trustedPath: TRUSTED_PATH,
      });
      const runtime = new RecordingRuntime(new DenoReplayRuntime(TRUSTED_PATH));
      const port = new LegacyLossPort({
        issue: portOk(legacyIssue()),
        pull: portOk(legacyPull({ predecessor: ctx.head, base: ctx.base })),
        ref: portOk({ ref: `refs/heads/${LEGACY_BRANCH}`, sha: ctx.head }),
      });
      const result = await legacyProver({
        ctx,
        state,
        port,
        ensure: loader,
        runtime,
      })(LEGACY_TASK_ID);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? "" : result.error.kind, "conflict");
      assert.ok(
        runtime.calls.some((args) => args.includes("fetch")),
        "the fresh fetch really ran",
      );
      assert.deepEqual(legacyStoreLeftovers(`${ctx.tmp}/home`), []);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "legacy loss: a refused cooldown never fetches and never claims loss",
  async () => {
    const fixture = await makeLegacyLossCtx();
    const { ctx } = fixture;
    try {
      const record = legacyRecord({
        lost: fixture.lost,
        base: ctx.base,
        observedBase: fixture.movedBase,
      });
      const reviews = [
        legacyReview({ id: "review-a", head: ctx.head, base: ctx.base }),
      ];
      const state = legacyState(
        [record],
        [legacyReservation(record)],
        reviews,
        { snapshotHead: SHA2, readHead: SHA1 },
      );
      const loader = createLocalCandidateLoader({
        stateRoot: fixture.stateRoot,
        sourcePath: fixture.sourcePath,
        scratch: `${ctx.tmp}/home`,
        trustedPath: TRUSTED_PATH,
      });
      const gate = new FakeGate();
      gate.deny = true;
      const runtime = new RecordingRuntime(new DenoReplayRuntime(TRUSTED_PATH));
      const port = new LegacyLossPort({
        issue: portOk(legacyIssue()),
        pull: portOk(legacyPull({
          predecessor: ctx.head,
          base: fixture.movedBase,
        })),
        ref: portOk({ ref: `refs/heads/${fixture.branch}`, sha: ctx.head }),
      });
      const result = await legacyProver({
        ctx,
        state,
        port,
        ensure: loader,
        runtime,
        gate,
      })(CANDIDATE_TASK_ID);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? "" : result.error.kind, "rate_limited");
      assert.equal(
        runtime.calls.some((args) => args.includes("fetch")),
        false,
        "no fetch without admission",
      );
      assert.ok(runtime.calls.length > 0, "the owned store was initialized");
      assert.equal(gate.admissions.length, 1);
      assert.deepEqual(legacyStoreLeftovers(`${ctx.tmp}/home`), []);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "legacy loss: a moved durable state head refuses after the proof",
  async () => {
    const fixture = await makeLegacyLossCtx();
    const { ctx } = fixture;
    try {
      const record = legacyRecord({
        lost: fixture.lost,
        base: ctx.base,
        observedBase: fixture.movedBase,
      });
      const reviews = [
        legacyReview({ id: "review-a", head: ctx.head, base: ctx.base }),
      ];
      const inner = legacyState(
        [record],
        [legacyReservation(record)],
        reviews,
        { snapshotHead: SHA2, readHead: SHA1 },
      );
      const drifting = new DriftingLossState(inner, SHA2);
      const loader = createLocalCandidateLoader({
        stateRoot: fixture.stateRoot,
        sourcePath: fixture.sourcePath,
        scratch: `${ctx.tmp}/home`,
        trustedPath: TRUSTED_PATH,
      });
      const runtime = new RecordingRuntime(new DenoReplayRuntime(TRUSTED_PATH));
      const port = new LegacyLossPort({
        issue: portOk(legacyIssue()),
        pull: portOk(legacyPull({
          predecessor: ctx.head,
          base: fixture.movedBase,
        })),
        ref: portOk({ ref: `refs/heads/${fixture.branch}`, sha: ctx.head }),
      });
      const result = await legacyProver({
        ctx,
        state: drifting,
        port,
        ensure: loader,
        runtime,
      })(CANDIDATE_TASK_ID);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? "" : result.error.kind, "conflict");
      assert.equal(drifting.reads, 2, "both state reads really happened");
      assert.ok(
        runtime.calls.some((args) => args.includes("fetch")),
        "the proof ran before the drift refusal",
      );
      assert.deepEqual(legacyStoreLeftovers(`${ctx.tmp}/home`), []);
    } finally {
      await ctx.cleanup();
    }
  },
);
