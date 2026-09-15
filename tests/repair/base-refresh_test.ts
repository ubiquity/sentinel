/**
 * Durable candidate-base refresh through the REAL repair loop: intent
 * persistence before any preparation or side effect, deterministic prepared
 * identity persisted before the push, lost-push recovery with no duplicate
 * effect, bounded waits for unknown/error cases, a known-conflict blocker and
 * the fresh-review path for the exact new head. One case wires the REAL local
 * generation adapter over a REAL temporary Git repository. No network, no
 * model call and no credentials.
 */
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import { BASE_REFRESH_CONFLICT_DETAIL } from "../../src/contracts/ports.ts";
import type {
  GitHubPort,
  GitHubPullRequestV1,
  GitHubRefV1,
  PortResultV1,
  PrepareBaseRefreshRequestV1,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { DenoGitExecutor } from "../../src/github/git-executor.ts";
import type { BaseRefreshObserverV1 } from "../../src/host/local.ts";
import { createPrepareBaseRefresh } from "../../src/host/local.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { REPO, SHA1, SHA2, SHA3, T0, workRecord } from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  type FakeGithubOptionsV1,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/repair\/base-refresh_test\.ts$/,
  "",
);
const TRUSTED_PATH = Deno.env.get("PATH") ?? "/usr/bin:/bin";
const TRUSTED_AUTHOR = "sentinel-owner";
const BASE_BRANCH = "development";
const BRANCH = "sentinel/repair/issue-1";
const OLD_HEAD = SHA3;
const PREPARED = "7f0b28dc5c6f8a1a2b3c4d5e6f7a8b9c0d1e2f3a" as GitSha;
const UNRELATED = "abcdefabcdefabcdefabcdefabcdefabcdefabcd" as GitSha;
const CHECK_POLL_MS = 5 * 60_000;

async function gitRun(
  cwd: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ ok: boolean; code: number; stdout: string }> {
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
  };
}

function gitEnv(home: string): Record<string, string> {
  return {
    PATH: TRUSTED_PATH,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "sentinel-base-refresh-loop-test",
    GIT_AUTHOR_EMAIL: "sentinel-base-refresh-loop-test@localhost",
    GIT_COMMITTER_NAME: "sentinel-base-refresh-loop-test",
    GIT_COMMITTER_EMAIL: "sentinel-base-refresh-loop-test@localhost",
  };
}

interface GitCtxV1 {
  tmp: string;
  home: string;
  repo: string;
  env: Record<string, string>;
  oldBase: GitSha;
  candidate: GitSha;
  newBase: GitSha;
  commit(name: string, content: string): Promise<GitSha>;
  revListParents(rev: string): Promise<string>;
  cleanup(): Promise<void>;
}

async function makeGitCtx(): Promise<GitCtxV1> {
  const tmp = await Deno.makeTempDir({
    prefix: "sentinel-base-refresh-loop-",
    dir: ROOT,
  });
  try {
    const home = `${tmp}/home`;
    const env = gitEnv(home);
    await Deno.mkdir(home, { recursive: true });
    const repo = `${tmp}/repo`;
    assert.ok((await gitRun(tmp, ["init", "-q", repo], env)).ok);
    assert.ok(
      (await gitRun(repo, ["checkout", "-q", "-b", BASE_BRANCH], env)).ok,
    );
    const commit = async (name: string, content: string): Promise<GitSha> => {
      await Deno.writeTextFile(`${repo}/${name}`, content);
      assert.ok((await gitRun(repo, ["add", "-A"], env)).ok);
      assert.ok((await gitRun(repo, ["commit", "-q", "-m", name], env)).ok);
      return (await gitRun(repo, ["rev-parse", "HEAD"], env)).stdout
        .trim() as GitSha;
    };
    const oldBase = await commit("shared.txt", "shared\n");
    assert.ok(
      (await gitRun(repo, ["checkout", "-q", "-b", "candidate"], env)).ok,
    );
    const candidate = await commit("shared.txt", "candidate\n");
    assert.ok((await gitRun(repo, ["checkout", "-q", BASE_BRANCH], env)).ok);
    const newBase = await commit("base.txt", "new base\n");
    return {
      tmp,
      home,
      repo,
      env,
      oldBase,
      candidate,
      newBase,
      commit,
      revListParents: async (rev) =>
        (await gitRun(repo, ["rev-list", "--parents", "-n", "1", rev], env))
          .stdout,
      cleanup: async () => {
        await Deno.remove(tmp, { recursive: true }).catch(() => {});
      },
    };
  } catch (error) {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
    throw error;
  }
}

/**
 * Recording GitHub port with exact controllable remote ref and current-PR
 * observations: only the two refs this task owns are known, and the one open
 * PR follows the live remote branch mutation.
 */
class RefreshGithub extends FakeGithub {
  remoteBase: GitSha;
  remoteBranch: GitSha | null;
  prepareCalls: PrepareBaseRefreshRequestV1[] = [];
  pushCalls: { ref: string; sha: GitSha; expected: GitSha | null }[] = [];
  remoteWrites = 0;
  lostPush = false;
  refReadFails = false;
  reviewRequests = 0;
  onPush: (() => Promise<void>) | null = null;
  onReadRef: ((ref: string) => void) | null = null;
  constructor(
    remoteBase: GitSha,
    remoteBranch: GitSha | null,
    options: FakeGithubOptionsV1 = {},
  ) {
    super(options);
    this.remoteBase = remoteBase;
    this.remoteBranch = remoteBranch;
  }
  override readRef(
    ref: string,
  ): Promise<PortResultV1<GitHubRefV1 | null>> {
    this.calls.push(`readRef:${ref}`);
    if (this.onReadRef !== null) this.onReadRef(ref);
    if (this.refReadFails) {
      return Promise.resolve(portError("unavailable", "ref read failed"));
    }
    if (ref === `refs/heads/${BASE_BRANCH}`) {
      return Promise.resolve(portOk({ ref, sha: this.remoteBase }));
    }
    if (ref === `refs/heads/${BRANCH}`) {
      return Promise.resolve(
        portOk(
          this.remoteBranch === null ? null : {
            ref,
            sha: this.remoteBranch,
          },
        ),
      );
    }
    // Any other ref (including a candidate-preservation ref) is unknown: the
    // task bytes are never advertised under a ref this fixture does not own.
    return Promise.resolve(portOk(null));
  }

  /**
   * The one exact CURRENT open PR for this task: its head follows the live
   * remote branch mutation and its base is the observed remote base. A missing
   * remote branch or any other number/branch is unknown, never a merged or
   * defaulted shape.
   */
  private currentPullRequest(
    number: number,
    headRef: string,
  ): GitHubPullRequestV1 | null {
    const head = this.remoteBranch;
    if (head === null || number !== 7 || headRef !== BRANCH) {
      return null;
    }
    return {
      number: 7,
      title: "Sentinel repair",
      body: "Refs 1",
      state: "open",
      head,
      base: this.remoteBase,
      mergeSha: null,
      headRef: BRANCH,
      baseRef: BASE_BRANCH,
      author: TRUSTED_AUTHOR,
      createdAt: T0,
      updatedAt: T0,
      mergedAt: null,
      reviewDecision: "none",
    };
  }
  override readPullRequest(
    number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    this.calls.push(`readPr:${number}`);
    return Promise.resolve(portOk(this.currentPullRequest(number, BRANCH)));
  }
  override findPullRequestByHeadRef(
    headRef: string,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    this.calls.push(`findPr:${headRef}`);
    return Promise.resolve(portOk(this.currentPullRequest(7, headRef)));
  }
  override async pushHead(
    ref: string,
    sha: GitSha,
    expectedRef: GitSha | null,
  ): Promise<PortResultV1<"applied" | "ambiguous">> {
    this.calls.push(`push:${ref}:${sha.slice(0, 8)}`);
    this.pushCalls.push({ ref, sha, expected: expectedRef });
    if (this.onPush !== null) await this.onPush();
    if (this.remoteBranch !== expectedRef) {
      return portError("conflict", "candidate branch ref moved");
    }
    if (this.remoteBranch !== sha) {
      this.remoteBranch = sha;
      this.remoteWrites++;
    }
    if (this.lostPush) {
      this.lostPush = false;
      return portOk("ambiguous");
    }
    return portOk("applied");
  }
  override requestReview(request: unknown) {
    this.reviewRequests++;
    return super.requestReview(request);
  }
}

function seededSnapshot(
  work: WorkRecordV1[],
  extra: Partial<RepairStateSnapshotV1> = {},
): RepairStateSnapshotV1 {
  return {
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
    ...extra,
  };
}

/** Issue task in the delivery phase with the exact candidate bindings. */
function deliveryRecord(
  head: GitSha,
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return workRecord("issue-1", {
    repository: REPO,
    source: { kind: "issue", id: "1", revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    target: {
      base: SHA1,
      branch: BRANCH,
      checkpoint: null,
      head,
      pr: 7,
    },
    nextStep: "delivery",
    counters: { attempts: 2, retries: 1, reviewRounds: 2 },
    firstSeenAt: T0 - 5000,
    createdAt: T0 - 4000,
    updatedAt: T0,
    ...overrides,
  });
}

/** Completed clean review receipt bound to the exact reviewed PR/head/base. */
function completedReceipt(
  pullRequest: number,
  head: GitSha,
  base: GitSha,
): ReviewReceiptV1 {
  return parseReviewReceiptV1({
    version: "v1",
    kind: "review_receipt",
    id: `review-receipt:${pullRequest}:${head}`,
    requestId: "review-req-1",
    expectedReviewer: "chatgpt-codex-connector[bot]",
    observedReviewer: "chatgpt-codex-connector[bot]",
    repository: REPO,
    pullRequest: { number: pullRequest, head, base },
    outcome: "completed",
    resultId: "result-1",
    summary: null,
    findings: [],
    findingsUncounted: 0,
    unresolvedSeverities: [],
    submittedAt: T0 - 2000,
    completedAt: T0 - 1000,
    observedAt: T0 - 500,
  });
}

function makeRig(github: GitHubPort) {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  const configs = repairConfigs({
    adapter: { kind: "github" },
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  });
  const budget = new RollingStartBudget({ clock, state, configs });
  const githubCooldown = new DurableGitHubCooldownGate({ state, clock });
  const incidents = new FakeIncidents({ summaries: [], evidence: null });
  const replay = new FakeReplay();
  const model = new FakeModel({ head: SHA3, changedPaths: ["src/app.ts"] });
  const run = (stepLimit = 16) =>
    runRepairCycle({
      clock,
      state,
      configs,
      controllerSha: SHA1,
      github,
      githubCooldown,
      incidents,
      replay,
      model,
      budget,
    }, { deadline: clock.now() + 60 * 60_000, stepLimit });
  const snapshot = async () => {
    const read = await state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (!read.ok || read.value.status !== "found") {
      throw new Error("no repair state");
    }
    return read.value.snapshot;
  };
  const seed = async (
    work: WorkRecordV1[],
    extra: Partial<RepairStateSnapshotV1> = {},
  ) => {
    const written = await state.writeRepair(seededSnapshot(work, extra), null);
    assert.ok(written.ok && written.value.status === "applied");
  };
  return { clock, state, github, model, run, snapshot, seed };
}

Deno.test(
  "base refresh: a moved base persists the intent before any preparation and spends no model or review budget",
  async () => {
    const fake = new RefreshGithub(SHA2, OLD_HEAD);
    const github: GitHubPort = fake;
    const rig = makeRig(github);
    // The production guard admits a refresh only when the capability exists:
    // this explicit stub records the call, inspects the durable state BEFORE
    // returning, and refuses so the intent-before-preparation ordering and the
    // bounded wait are exercised.
    let intentAtPrepare: string | null | undefined;
    let resultIdAtPrepare: string | null | undefined;
    let headAtPrepare: GitSha | null | undefined;
    github.prepareBaseRefresh = (request) => {
      fake.prepareCalls.push(request);
      return rig.snapshot().then((snapshot) => {
        const work = snapshot.work[0];
        intentAtPrepare = work.intent?.kind;
        resultIdAtPrepare = work.intent?.resultId;
        headAtPrepare = work.target.head;
        return portError("unavailable", "prepared unavailable");
      });
    };
    const receipt = completedReceipt(7, OLD_HEAD, SHA1);
    await rig.seed([deliveryRecord(OLD_HEAD)], { reviews: [receipt] });
    const seeded = (await rig.snapshot()).work[0];

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    const work = state.work[0];
    assert.equal(work.nextStep, "delivery");
    assert.equal(work.intent?.kind, "base_refresh");
    assert.equal(work.intent?.branch, BRANCH);
    assert.equal(work.intent?.expectedHead, OLD_HEAD);
    assert.equal(work.intent?.observedBase, SHA2);
    assert.equal(work.intent?.pr, 7);
    assert.equal(work.intent?.requestId, null);
    assert.equal(work.intent?.resultId, null);
    assert.equal(work.target.base, SHA1, "target stays on the old base");
    assert.equal(work.target.head, OLD_HEAD, "the old candidate is retained");
    assert.equal(work.wait?.reason, "unavailable");
    assert.equal(work.wait?.until, T0 + CHECK_POLL_MS);
    assert.equal(fake.pushCalls.length, 0, "nothing was pushed");
    assert.equal(
      fake.prepareCalls.length,
      1,
      "the capability was consulted once",
    );
    assert.equal(
      intentAtPrepare,
      "base_refresh",
      "the intent was durable before preparation",
    );
    assert.equal(resultIdAtPrepare, null, "no prepared result existed yet");
    assert.equal(headAtPrepare, OLD_HEAD, "old candidate at preparation time");
    assert.equal(rig.model.requests.length, 0, "no model start");
    assert.equal(state.reservations.length, 0, "no budget admission");
    assert.deepEqual(work.counters, seeded.counters);
    assert.deepEqual(work.source, seeded.source);
    assert.equal(work.failingRevision, seeded.failingRevision);
    assert.deepEqual(work.controller, seeded.controller);
    assert.deepEqual(work.evidence, seeded.evidence);
    assert.equal(state.reviews.length, 1, "existing reviews are preserved");
    assert.deepEqual(state.reviews[0], receipt);
  },
);

Deno.test(
  "base refresh: an unreadable configured base waits bounded without writing an intent",
  async () => {
    const fake = new RefreshGithub(SHA2, OLD_HEAD);
    fake.refReadFails = true;
    const github: GitHubPort = fake;
    const rig = makeRig(github);
    // The capability exists so the delivery guard admits the base check, but
    // the unreadable base must wait BEFORE any preparation: invoking the
    // capability fails the test.
    github.prepareBaseRefresh = () => {
      throw new Error("prepare must not run for an unreadable base");
    };
    await rig.seed([deliveryRecord(OLD_HEAD)]);

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    const work = state.work[0];
    assert.equal(work.intent, null);
    assert.equal(work.target.base, SHA1);
    assert.equal(work.target.head, OLD_HEAD);
    assert.equal(work.wait?.reason, "unavailable");
    assert.equal(work.wait?.until, T0 + CHECK_POLL_MS);
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 0);
  },
);

Deno.test(
  "base refresh: the prepared SHA is persisted before the push and a lost push resumes with no duplicate effect",
  async () => {
    const fake = new RefreshGithub(SHA2, OLD_HEAD);
    fake.lostPush = true;
    const github: GitHubPort = fake;
    const rig = makeRig(github);
    let resultIdAtPush: string | null | undefined;
    let headAtPush: GitSha | null | undefined;
    fake.onPush = async () => {
      const work = (await rig.snapshot()).work[0];
      resultIdAtPush = work.intent?.resultId;
      headAtPush = work.target.head;
    };
    github.prepareBaseRefresh = (request) => {
      fake.prepareCalls.push(request);
      return Promise.resolve(portOk(PREPARED));
    };
    await rig.seed([deliveryRecord(OLD_HEAD)]);

    // Run 1: intent -> prepared result persisted -> exact expected-ref push
    // whose response is lost. The durable intent and old target survive.
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    let state = await rig.snapshot();
    let work = state.work[0];
    assert.equal(
      resultIdAtPush,
      PREPARED,
      "prepared SHA persisted before push",
    );
    assert.equal(headAtPush, OLD_HEAD, "target still old at push time");
    assert.equal(work.target.base, SHA1);
    assert.equal(work.target.head, OLD_HEAD);
    assert.equal(work.intent?.resultId, PREPARED);
    assert.equal(work.intent?.requestId, null);
    assert.equal(fake.pushCalls.length, 1);
    assert.equal(fake.pushCalls[0].sha, PREPARED);
    assert.equal(fake.pushCalls[0].expected, OLD_HEAD);
    assert.equal(
      fake.remoteWrites,
      1,
      "the push actually moved the remote once",
    );
    assert.equal(fake.remoteBranch, PREPARED);
    assert.equal(rig.model.requests.length, 0);
    assert.equal(
      state.reservations.length,
      0,
      "the refresh itself charges nothing",
    );

    // Run 2 (fresh run after the wait): the same deterministic object is
    // regenerated, the already-published ref is reconciled without a duplicate
    // push, and the exact new head returns through the fresh-review path.
    rig.clock.advance(CHECK_POLL_MS + 1000);
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    state = await rig.snapshot();
    work = state.work[0];
    assert.equal(fake.prepareCalls.length, 2);
    assert.equal(fake.prepareCalls[1].preparedHead, PREPARED);
    assert.equal(work.intent, null);
    assert.equal(work.target.base, SHA2, "target advanced to the new base");
    assert.equal(
      work.target.head,
      PREPARED,
      "target advanced to the prepared head",
    );
    assert.equal(work.nextStep, "review");
    assert.equal(fake.remoteWrites, 1, "no duplicate remote effect");
    assert.equal(fake.pushCalls.length, 2);
    assert.equal(
      fake.pushCalls[1].expected,
      PREPARED,
      "publish reuses the ref",
    );
    assert.equal(fake.reviewRequests, 1, "a fresh review was requested");
    assert.deepEqual(work.counters, {
      attempts: 2,
      retries: 1,
      reviewRounds: 3,
    });
    assert.equal(work.source.revision, SHA1, "source identity is preserved");
    assert.equal(state.reviews.length, 0, "no review is reused or fabricated");
    assert.equal(state.reservations.length, 1);
    assert.equal(state.reservations[0].purpose, "review_request");
    assert.equal(state.reservations[0].head, PREPARED);
    assert.equal(rig.model.requests.length, 0, "refresh never starts a model");
  },
);

Deno.test(
  "base refresh: a known conflict blocks and retains the candidate without a model",
  async () => {
    const fake = new RefreshGithub(SHA2, OLD_HEAD);
    const github: GitHubPort = fake;
    const rig = makeRig(github);
    github.prepareBaseRefresh = () =>
      Promise.resolve(portError("conflict", BASE_REFRESH_CONFLICT_DETAIL));
    await rig.seed([deliveryRecord(OLD_HEAD)]);

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    const work = state.work[0];
    assert.equal(work.nextStep, "blocked");
    assert.equal(work.blocker?.kind, "other");
    assert.equal(work.blocker?.message, "base refresh has conflicts");
    assert.equal(work.intent, null);
    assert.equal(work.target.base, SHA1);
    assert.equal(work.target.head, OLD_HEAD, "the candidate is retained");
    assert.equal(fake.pushCalls.length, 0);
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 0);
  },
);

Deno.test(
  "base refresh: an unrelated branch head is never adopted",
  async () => {
    const fake = new RefreshGithub(SHA2, UNRELATED);
    const github: GitHubPort = fake;
    const rig = makeRig(github);
    github.prepareBaseRefresh = (request) => {
      fake.prepareCalls.push(request);
      return Promise.resolve(portOk(PREPARED));
    };
    await rig.seed([deliveryRecord(OLD_HEAD)]);

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    const work = state.work[0];
    assert.equal(work.intent?.kind, "base_refresh");
    assert.equal(work.intent?.resultId, PREPARED);
    assert.equal(work.target.head, OLD_HEAD);
    assert.equal(work.target.base, SHA1);
    assert.equal(work.wait?.reason, "unavailable");
    assert.equal(fake.pushCalls.length, 0, "no push against an unknown head");
    assert.equal(
      fake.remoteBranch,
      UNRELATED,
      "the unrelated head is untouched",
    );
    assert.equal(rig.model.requests.length, 0);
  },
);

Deno.test(
  "base refresh: the real adapter/executor prepares the exact two-parent commit through the loop",
  async () => {
    const ctx = await makeGitCtx();
    try {
      const fake = new RefreshGithub(ctx.newBase, ctx.candidate);
      const github: GitHubPort = fake;
      const rig = makeRig(github);
      const observer: BaseRefreshObserverV1 = {
        readPullRequest: (_number) =>
          Promise.resolve(portOk(pullRequest(ctx.candidate))),
        readRef: (ref) => fake.readRef(ref),
      };
      github.prepareBaseRefresh = createPrepareBaseRefresh({
        git: new DenoGitExecutor({
          localDir: ctx.repo,
          remoteUrl: `file://${ctx.repo}`,
          gitHome: ctx.home,
        }),
        observer,
        baseBranch: BASE_BRANCH,
        trustedPrAuthor: TRUSTED_AUTHOR,
      });
      fake.lostPush = true;
      let remoteWritesAfterPush = 0;
      fake.onPush = () => {
        remoteWritesAfterPush = fake.remoteWrites;
        return Promise.resolve();
      };
      await rig.seed([deliveryRecord(ctx.candidate, {
        target: {
          base: ctx.oldBase,
          branch: BRANCH,
          checkpoint: null,
          head: ctx.candidate,
          pr: 7,
        },
      })]);

      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));
      let state = await rig.snapshot();
      let work = state.work[0];
      const prepared = work.intent?.resultId ?? null;
      if (prepared === null) {
        throw new Error("no prepared result was persisted");
      }
      assert.equal(work.target.head, ctx.candidate);
      assert.equal(work.target.base, ctx.oldBase);
      assert.equal(fake.remoteBranch, prepared);
      assert.equal(fake.remoteWrites, 1);
      assert.equal(
        remoteWritesAfterPush,
        0,
        "persisted before the remote write",
      );

      // A fresh loop run regenerates the identical prepared object and
      // reconciles the already-published branch without a second push.
      rig.clock.advance(CHECK_POLL_MS + 1000);
      const second = await rig.run();
      assert.equal(second.status, "idle", JSON.stringify(second));
      state = await rig.snapshot();
      work = state.work[0];
      assert.equal(work.intent, null);
      assert.equal(work.target.base, ctx.newBase);
      assert.equal(work.target.head, prepared);
      assert.equal(work.nextStep, "review");
      assert.equal(fake.remoteWrites, 1, "no duplicate remote effect");
      const parents = await ctx.revListParents(prepared);
      const parts = parents.trim().split(" ");
      assert.equal(parts.length, 3, "the prepared commit has two parents");
      assert.equal(parts[0], prepared);
      assert.equal(parts[1], ctx.candidate);
      assert.equal(parts[2], ctx.newBase);
      assert.equal(rig.model.requests.length, 0);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "base refresh: a second base movement replans the unprepared intent without losing history",
  async () => {
    const third = "c".repeat(40) as GitSha;
    const fake = new RefreshGithub(SHA2, OLD_HEAD);
    const github: GitHubPort = fake;
    const rig = makeRig(github);
    const receipt = completedReceipt(7, OLD_HEAD, SHA1);
    let calls = 0;
    github.prepareBaseRefresh = (request) => {
      fake.prepareCalls.push(request);
      calls++;
      if (calls === 1) {
        // The configured base moved AGAIN between intent persistence and
        // preparation: the adapter re-observes and refuses the stale base.
        fake.remoteBase = third;
        return Promise.resolve(
          portError("conflict", "base refresh configured base moved"),
        );
      }
      // The replanned intent then waits bounded after this failure.
      return Promise.resolve(portError("unavailable", "prepared unavailable"));
    };
    await rig.seed([
      deliveryRecord(OLD_HEAD, {
        counters: { attempts: 3, retries: 2, reviewRounds: 4 },
      }),
    ], { reviews: [receipt] });
    const seeded = (await rig.snapshot()).work[0];

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    const work = state.work[0];
    assert.equal(work.intent?.kind, "base_refresh");
    assert.equal(
      work.intent?.observedBase,
      third,
      "replanned against the newest base",
    );
    assert.equal(work.intent?.resultId, null);
    assert.equal(work.target.base, SHA1, "old target preserved");
    assert.equal(work.target.head, OLD_HEAD);
    assert.equal(work.nextStep, "delivery");
    assert.equal(fake.prepareCalls.length, 2, "one failed and one replanned");
    assert.deepEqual(work.counters, seeded.counters);
    assert.deepEqual(work.source, seeded.source);
    assert.deepEqual(work.evidence, seeded.evidence);
    assert.equal(state.reviews.length, 1);
    assert.deepEqual(state.reviews[0], receipt);
    assert.equal(fake.pushCalls.length, 0, "no push for an unprepared intent");
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 0);
  },
);

Deno.test(
  "base refresh: a newer base refreshes an already prepared candidate before fresh review",
  async () => {
    const newer = "c".repeat(40) as GitSha;
    const next = "d".repeat(40) as GitSha;
    const fake = new RefreshGithub(newer, PREPARED);
    const github: GitHubPort = fake;
    const rig = makeRig(github);
    github.prepareBaseRefresh = (request) => {
      fake.prepareCalls.push(request);
      return Promise.resolve(portOk(next));
    };
    let reviewsAtFirstPush: number | null = null;
    fake.onPush = () => {
      assert.equal(fake.reviewRequests, 0, "no review budget on any push");
      if (reviewsAtFirstPush === null) {
        reviewsAtFirstPush = fake.reviewRequests;
      }
      return Promise.resolve();
    };
    await rig.seed([
      workRecord("issue-1", {
        repository: REPO,
        source: { kind: "issue", id: "1", revision: SHA1 },
        related: { incidentId: null, issueNumber: 1 },
        target: {
          base: SHA2,
          branch: BRANCH,
          checkpoint: null,
          head: PREPARED,
          pr: 7,
        },
        nextStep: "work",
        counters: { attempts: 2, retries: 1, reviewRounds: 2 },
        firstSeenAt: T0 - 5000,
        createdAt: T0 - 4000,
        updatedAt: T0,
      }),
    ]);

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    const work = state.work[0];
    assert.equal(work.intent, null);
    assert.equal(work.target.base, newer, "advanced to the newest base");
    assert.equal(work.target.head, next);
    assert.equal(work.nextStep, "review");
    assert.equal(
      fake.prepareCalls.length,
      1,
      "refresh planned and executed before review",
    );
    assert.equal(
      fake.prepareCalls[0].expectedHead,
      PREPARED,
      "the exact saved prepared candidate is the parent",
    );
    assert.equal(fake.prepareCalls[0].previousBase, SHA2);
    assert.equal(fake.prepareCalls[0].expectedBase, newer);
    assert.equal(fake.prepareCalls[0].preparedHead, undefined);
    // New publication order: a no-op publication of the already prepared
    // candidate before the review gate, the changing base refresh, then a
    // no-op publication of the new head before the one fresh review.
    assert.deepEqual(fake.pushCalls, [
      { ref: `refs/heads/${BRANCH}`, sha: PREPARED, expected: PREPARED },
      { ref: `refs/heads/${BRANCH}`, sha: next, expected: PREPARED },
      { ref: `refs/heads/${BRANCH}`, sha: next, expected: next },
    ]);
    assert.equal(reviewsAtFirstPush, 0, "no review budget before integration");
    assert.equal(fake.reviewRequests, 1, "one fresh review for the new head");
    assert.equal(fake.remoteWrites, 1);
    assert.deepEqual(work.counters, {
      attempts: 2,
      retries: 1,
      reviewRounds: 3,
    });
    assert.equal(rig.model.requests.length, 0);
  },
);

Deno.test(
  "base refresh: a candidate ref read crossing the deadline pushes nothing",
  async () => {
    const fake = new RefreshGithub(SHA2, OLD_HEAD);
    const github: GitHubPort = fake;
    const rig = makeRig(github);
    github.prepareBaseRefresh = (request) => {
      fake.prepareCalls.push(request);
      return Promise.resolve(portOk(PREPARED));
    };
    fake.onReadRef = (ref) => {
      if (!ref.endsWith(`refs/heads/${BASE_BRANCH}`)) {
        rig.clock.advance(61 * 60_000);
      }
    };
    await rig.seed([deliveryRecord(OLD_HEAD)]);

    const outcome = await rig.run();
    assert.equal(outcome.status, "margin", JSON.stringify(outcome));
    const state = await rig.snapshot();
    const work = state.work[0];
    assert.equal(work.intent?.kind, "base_refresh");
    assert.equal(work.intent?.resultId, PREPARED, "prepared SHA retained");
    assert.equal(work.target.base, SHA1);
    assert.equal(work.target.head, OLD_HEAD);
    assert.equal(fake.pushCalls.length, 0, "no push after the deadline");
    assert.equal(fake.remoteWrites, 0);
  },
);

/** Exact open trusted-author PR shape observed by the real adapter. */
function pullRequest(head: GitSha): GitHubPullRequestV1 {
  return {
    number: 7,
    title: "Sentinel repair",
    body: "Refs 1",
    state: "open",
    head,
    base: SHA2,
    mergeSha: null,
    headRef: BRANCH,
    baseRef: BASE_BRANCH,
    author: TRUSTED_AUTHOR,
    createdAt: T0,
    updatedAt: T0,
    mergedAt: null,
    reviewDecision: "none",
  };
}
