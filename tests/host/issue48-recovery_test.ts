/**
 * Focused suite for the one-shot hosted issue-48 recovery.
 *
 * The runner core is exercised credential-free against the ACTUAL production
 * GitStateStore over disposable local bare repositories. Fixtures are minimal
 * sanitized records built through the frozen parsers; no production snapshot,
 * token, path or private payload is committed or read. Tests inject only the
 * fixed binding pins (generated fixture heads/digests) and the PR-read
 * callback. The workflow test inspects the bounded YAML source directly.
 */
import assert from "node:assert/strict";

import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { parseHostedRuntimeRecordV1 } from "../../src/contracts/hosted-supervisor.ts";
import type { HostedRuntimeRecordV1 } from "../../src/contracts/hosted-supervisor.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type {
  PortResultV1,
  RepairStateWriter,
  StateReadView,
} from "../../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
  DenoGitRunner,
  RELEASE_STATE_REF,
  REPAIR_STATE_REF,
} from "../../src/state/mod.ts";
import type {
  GitRunnerV1,
  GitRunResultV1,
  ReleaseGitStateStore,
  RepairGitStateStore,
} from "../../src/state/mod.ts";
import {
  readGitHubPullRequest,
  runIssue48Recovery,
  validateIssue48HostedIdentity,
} from "../../ops/issue48-recovery.ts";
import type {
  Issue48HostedIdentityV1,
  Issue48IdentityFailureV1,
  Issue48PullRequestViewV1,
  Issue48RecoveryBindingV1,
  Issue48RecoveryReasonV1,
  Issue48RecoveryResultV1,
} from "../../ops/issue48-recovery.ts";
import {
  FailedPushRunner,
  gitRun,
  makeRemoteCtx,
  reservation,
  reviewReceipt,
  sha256Hex,
  T0,
  testGitEnv,
  workRecord,
} from "../state/helpers.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/host\/issue48-recovery_test\.ts$/,
  "",
);

const TARGET_ID = "issue-ubiquity-sentinel-48" as WorkItemId;
const REPOSITORY = "ubiquity/sentinel";
const PR_NUMBER = 51;
const PR_HEAD = "1a".repeat(20) as GitSha;
const PR_BASE = "2b".repeat(20) as GitSha;
const OTHER_SHA = "3c".repeat(20) as GitSha;
const RUNTIME_REVISION = "4d".repeat(20) as GitSha;
const NOW = T0 + 10_000;

interface Ctx {
  tmp: string;
  env: Record<string, string>;
  bare: string;
  remoteUrl: string;
  cleanup(): Promise<void>;
}

async function makeCtx(prefix: string): Promise<Ctx> {
  const tmp = await Deno.makeTempDir({
    prefix: `sentinel-issue48-${prefix}-`,
    dir: ROOT,
  });
  const env = testGitEnv(`${tmp}/git-home`);
  await Deno.mkdir(`${tmp}/git-home`, { recursive: true });
  const remote = await makeRemoteCtx(tmp, env);
  return {
    tmp,
    env,
    bare: remote.bare,
    remoteUrl: remote.remoteUrl,
    cleanup: async () => {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    },
  };
}

async function remoteHead(ctx: Ctx, ref: string): Promise<string> {
  const result = await gitRun(ctx.tmp, [
    "--git-dir",
    ctx.bare,
    "rev-parse",
    ref,
  ], ctx.env);
  if (!result.ok) throw new Error("fixture remote head read failed");
  return result.stdout.trim();
}

/** The blocked issue-48 target: attempts 2, review round 1, retained PR 51. */
function targetRecord(overrides: Record<string, unknown> = {}) {
  return workRecord(TARGET_ID, {
    related: { incidentId: null, issueNumber: 48 },
    classification: { severity: "P2", priority: null },
    target: {
      base: PR_BASE,
      branch: null,
      checkpoint: null,
      head: PR_HEAD,
      pr: PR_NUMBER,
    },
    nextStep: "blocked",
    blocker: {
      kind: "unavailable",
      message: "hosted recovery blocked",
      since: T0 + 3000,
    },
    counters: { attempts: 2, retries: 0, reviewRounds: 1 },
    intent: {
      kind: "implementation",
      key: "impl/issue-48-attempt-2",
      startedAt: T0 + 2500,
      branch: null,
      expectedHead: PR_HEAD,
      observedBase: PR_BASE,
      pr: PR_NUMBER,
      requestId: null,
      resultId: null,
    },
    firstSeenAt: T0 + 100,
    createdAt: T0 + 200,
    updatedAt: T0 + 4000,
    ...overrides,
  });
}

/** Sanitized repair fixture: target plus unrelated 58/61 records. */
function repairFixture(
  overrides: Partial<RepairStateSnapshotV1> = {},
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0 + 1000,
    incidents: [],
    evidence: [],
    work: [
      targetRecord(),
      workRecord("issue-ubiquity-sentinel-58"),
      workRecord("issue-ubiquity-sentinel-61"),
    ],
    reservations: [
      reservation("reservation-21", {
        attempt: 2,
        purpose: "implementation",
        outcome: "submitted",
        settledAt: T0 + 500,
      }),
      reservation("reservation-58"),
    ],
    reviews: [
      reviewReceipt("review-61", {
        pullRequest: { number: 61, head: PR_HEAD, base: PR_BASE },
      }),
    ],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    ...overrides,
  });
}

function runtimeRecord(
  overrides: Partial<HostedRuntimeRecordV1> = {},
): HostedRuntimeRecordV1 {
  return parseHostedRuntimeRecordV1({
    version: "v1",
    kind: "hosted_runtime",
    id: "ubiquity/sentinel:0:production",
    activeRevision: RUNTIME_REVISION,
    generation: 1,
    lastHealthyProof: null,
    lastExecutionProof: null,
    nextOrdinaryAt: T0,
    execution: null,
    createdAt: T0,
    updatedAt: T0 + 1000,
    ...overrides,
  });
}

/** Independently mutated clone: four target fields plus snapshot metadata. */
function intendedSnapshot(
  prior: RepairStateSnapshotV1,
  targetId: WorkItemId,
  head: GitSha,
  now: number,
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: head,
    sequence: prior.sequence + 1,
    updatedAt: now,
    incidents: prior.incidents,
    evidence: prior.evidence,
    work: prior.work.map((record) =>
      record.id === targetId
        ? {
          ...record,
          nextStep: "work",
          blocker: null,
          intent: null,
          updatedAt: now,
        }
        : record
    ),
    reservations: prior.reservations,
    reviews: prior.reviews,
    replays: prior.replays,
    releaseRequests: prior.releaseRequests,
    githubCooldowns: prior.githubCooldowns,
  });
}

function bindingFor(
  repairHead: GitSha,
  repairDigest: string,
  releaseHead: GitSha,
  runtime: HostedRuntimeRecordV1,
): Issue48RecoveryBindingV1 {
  return {
    repairHead,
    repairDigest,
    releaseHead,
    runtimeId: runtime.id,
    runtimeRevision: runtime.activeRevision,
    runtimeGeneration: runtime.generation,
    pullRequestNumber: PR_NUMBER,
    pullRequestHead: PR_HEAD,
    pullRequestBase: PR_BASE,
    pullRequestRepository: REPOSITORY,
    targetId: TARGET_ID,
  };
}

interface RigCountersV1 {
  writes: number;
  prReads: number;
}

interface RigV1 {
  ctx: Ctx;
  repair: RepairGitStateStore;
  release: ReleaseGitStateStore;
  seed: RepairStateSnapshotV1;
  repairHead: GitSha;
  releaseHead: GitSha;
  binding: Issue48RecoveryBindingV1;
  prView: Issue48PullRequestViewV1;
  counters: RigCountersV1;
  state: StateReadView & RepairStateWriter;
}

async function makeRig(
  prefix: string,
  options: {
    repair?: RepairStateSnapshotV1;
    runtime?: HostedRuntimeRecordV1;
  } = {},
): Promise<RigV1> {
  const ctx = await makeCtx(prefix);
  const repair = createRepairStateStore({
    scratchDir: `${ctx.tmp}/repair`,
    remoteUrl: ctx.remoteUrl,
  });
  const release = createReleaseStateStore({
    scratchDir: `${ctx.tmp}/release`,
    remoteUrl: ctx.remoteUrl,
  });
  const seed = options.repair ?? repairFixture();
  const created = await repair.writeRepair(seed, null);
  if (!created.ok || created.value.status !== "applied") {
    throw new Error("repair fixture seed failed");
  }
  const repairHead = created.value.head;
  const runtime = options.runtime ?? runtimeRecord();
  const released = await release.writeRelease(
    parseReleaseStateSnapshotV1({
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0 + 1000,
      releases: [],
      hostedRuntimes: [runtime],
      hostedReleases: [],
      githubCooldowns: [],
    }),
    null,
  );
  if (!released.ok || released.value.status !== "applied") {
    throw new Error("release fixture seed failed");
  }
  const releaseHead = released.value.head;
  const binding = bindingFor(
    repairHead,
    await sha256Hex(canonicalStringify(seed)),
    releaseHead,
    runtime,
  );
  const counters: RigCountersV1 = { writes: 0, prReads: 0 };
  return {
    ctx,
    repair,
    release,
    seed,
    repairHead,
    releaseHead,
    binding,
    prView: {
      number: PR_NUMBER,
      state: "open",
      head: PR_HEAD,
      base: PR_BASE,
      repository: REPOSITORY,
    },
    counters,
    state: {
      readRepair: () => repair.readRepair(),
      readRelease: () => release.readRelease(),
      writeRepair: (next, expectedHead) => {
        counters.writes++;
        return repair.writeRepair(next, expectedHead);
      },
    },
  };
}

interface RigRunOverridesV1 {
  binding?: Partial<Issue48RecoveryBindingV1>;
  prView?: Issue48PullRequestViewV1;
  prResult?: PortResultV1<Issue48PullRequestViewV1>;
  now?: number;
  readPullRequest?: (
    number: number,
  ) => Promise<PortResultV1<Issue48PullRequestViewV1>>;
}

function runRig(
  rig: RigV1,
  overrides: RigRunOverridesV1 = {},
): Promise<Issue48RecoveryResultV1> {
  return runIssue48Recovery({
    state: rig.state,
    clock: { now: () => overrides.now ?? NOW },
    binding: { ...rig.binding, ...overrides.binding },
    readPullRequest: overrides.readPullRequest ?? (() => {
      rig.counters.prReads++;
      return Promise.resolve(
        overrides.prResult ?? portOk(overrides.prView ?? rig.prView),
      );
    }),
  });
}

async function expectRejected(
  rig: RigV1,
  result: Issue48RecoveryResultV1,
  reason: Issue48RecoveryReasonV1,
): Promise<void> {
  assert.equal(result.status, "failed");
  assert.equal(result.reason, reason);
  assert.equal(result.appliedHead, null);
  assert.equal(rig.counters.writes, 0);
  assert.equal(await remoteHead(rig.ctx, REPAIR_STATE_REF), rig.repairHead);
  assert.equal(await remoteHead(rig.ctx, RELEASE_STATE_REF), rig.releaseHead);
}

/** Real push followed by a lost verification read: the side effect is real. */
class LostVerificationRunner implements GitRunnerV1 {
  pushes = 0;
  private lost = false;

  constructor(private readonly inner: GitRunnerV1) {}

  async runGit(
    args: string[],
    opts: { cwd: string; env?: Readonly<Record<string, string>> },
  ): Promise<GitRunResultV1> {
    if (args[0] === "push") {
      this.pushes++;
      return await this.inner.runGit(args, opts);
    }
    if (args[0] === "ls-remote" && this.pushes > 0 && !this.lost) {
      this.lost = true;
      throw new Error("synthetic lost verification at a private path");
    }
    return await this.inner.runGit(args, opts);
  }
}

Deno.test("issue48 recovery: applies the fixed CAS transition then stays skipped", async () => {
  const rig = await makeRig("apply");
  try {
    const result = await runRig(rig);
    assert.equal(result.status, "applied");
    assert.equal(result.reason, "applied");
    assert.equal(result.beforeHead, rig.repairHead);
    const appliedHead = result.appliedHead;
    if (appliedHead === null) throw new Error("expected a proved applied head");
    assert.equal(rig.counters.writes, 1);
    assert.equal(rig.counters.prReads, 1);

    const intended = intendedSnapshot(rig.seed, TARGET_ID, rig.repairHead, NOW);
    const read = await rig.repair.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("expected applied state");
    }
    assert.equal(read.value.head, appliedHead);
    assert.equal(
      canonicalStringify(read.value.snapshot),
      canonicalStringify(intended),
    );

    // Whole-state equality: every unrelated record, charge and counter stays.
    assert.deepEqual(read.value.snapshot.reservations, rig.seed.reservations);
    assert.deepEqual(read.value.snapshot.reviews, rig.seed.reviews);
    assert.deepEqual(
      read.value.snapshot.work.filter((record) => record.id !== TARGET_ID),
      rig.seed.work.filter((record) => record.id !== TARGET_ID),
    );
    const before = rig.seed.work.find((record) => record.id === TARGET_ID);
    const after = read.value.snapshot.work.find((record) =>
      record.id === TARGET_ID
    );
    if (before === undefined || after === undefined) {
      throw new Error("expected the target work record");
    }
    assert.deepEqual(after, {
      ...before,
      nextStep: "work",
      blocker: null,
      intent: null,
      updatedAt: NOW,
    });

    // The applied commit extends the exact pinned head.
    const parent = await gitRun(rig.ctx.tmp, [
      "--git-dir",
      rig.ctx.bare,
      "rev-parse",
      `${appliedHead}^`,
    ], rig.ctx.env);
    assert.ok(parent.ok);
    assert.equal(parent.stdout.trim(), rig.repairHead);

    // A repeated call after the applied head is ordinary and never touches the
    // stale release/PR callbacks.
    let staleCalls = 0;
    const staleReader = () => {
      staleCalls++;
      return Promise.reject(new Error("stale callback must not run"));
    };
    const skippedAfter = await runRig(rig, { readPullRequest: staleReader });
    assert.equal(skippedAfter.status, "skipped_state_changed");
    assert.equal(skippedAfter.reason, "state_head_changed");
    assert.equal(skippedAfter.beforeHead, appliedHead);
    assert.equal(skippedAfter.appliedHead, null);
    assert.equal(staleCalls, 0);
    assert.equal(rig.counters.writes, 1);
    assert.equal(await remoteHead(rig.ctx, REPAIR_STATE_REF), appliedHead);

    // Later ordinary progress also stays ordinary.
    const progressed = parseRepairStateSnapshotV1({
      ...read.value.snapshot,
      stateHead: appliedHead,
      sequence: read.value.snapshot.sequence + 1,
      updatedAt: T0 + 20_000,
      work: [
        ...read.value.snapshot.work,
        workRecord("issue-ubiquity-sentinel-99"),
      ],
    });
    const progressedWrite = await rig.repair.writeRepair(
      progressed,
      appliedHead,
    );
    assert.ok(progressedWrite.ok);
    assert.equal(progressedWrite.value.status, "applied");
    const skippedLater = await runRig(rig, { readPullRequest: staleReader });
    assert.equal(skippedLater.status, "skipped_state_changed");
    assert.equal(skippedLater.reason, "state_head_changed");
    assert.equal(staleCalls, 0);
    assert.equal(rig.counters.writes, 1);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("issue48 recovery: bounded preflight rejections write nothing", async () => {
  const rig = await makeRig("reject");
  try {
    await expectRejected(
      rig,
      await runRig(rig, { binding: { repairDigest: "0".repeat(64) } }),
      "repair_digest_mismatch",
    );
    // A digest mismatch is rejected before any release or PR read.
    assert.equal(rig.counters.prReads, 0);
    await expectRejected(
      rig,
      await runRig(rig, { binding: { releaseHead: OTHER_SHA } }),
      "release_head_changed",
    );
    await expectRejected(
      rig,
      await runRig(rig, { binding: { runtimeGeneration: 2 } }),
      "runtime_mismatch",
    );
    await expectRejected(
      rig,
      await runRig(rig, { binding: { runtimeRevision: OTHER_SHA } }),
      "runtime_mismatch",
    );
    await expectRejected(
      rig,
      await runRig(rig, {
        binding: { runtimeId: "ubiquity/sentinel:0:staging" },
      }),
      "runtime_mismatch",
    );
    await expectRejected(
      rig,
      await runRig(rig, { prView: { ...rig.prView, head: OTHER_SHA } }),
      "pull_request_mismatch",
    );
    await expectRejected(
      rig,
      await runRig(rig, { prView: { ...rig.prView, base: OTHER_SHA } }),
      "pull_request_mismatch",
    );
    await expectRejected(
      rig,
      await runRig(rig, { prView: { ...rig.prView, number: 52 } }),
      "pull_request_mismatch",
    );
    await expectRejected(
      rig,
      await runRig(rig, { prView: { ...rig.prView, state: "closed" } }),
      "pull_request_mismatch",
    );
    await expectRejected(
      rig,
      await runRig(rig, {
        prView: { ...rig.prView, repository: "ubiquity/other" },
      }),
      "pull_request_mismatch",
    );
    await expectRejected(
      rig,
      await runRig(rig, {
        prResult: portError("unavailable", "synthetic PR read failure"),
      }),
      "pull_request_read_failed",
    );
    await expectRejected(rig, await runRig(rig, { now: T0 }), "clock_invalid");
    await expectRejected(rig, await runRig(rig, { now: 1.5 }), "clock_invalid");
    assert.equal(rig.counters.writes, 0);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("issue48 recovery: an active execution is not the pinned idle runtime", async () => {
  const rig = await makeRig("execution", {
    runtime: runtimeRecord({
      execution: {
        id: "9:1:repair",
        runId: 9,
        runAttempt: 1,
        launcherSha: RUNTIME_REVISION,
        purpose: "ordinary",
        revision: RUNTIME_REVISION,
        generation: 1,
        releaseId: null,
        createdAt: T0 + 500,
      },
    }),
  });
  try {
    await expectRejected(rig, await runRig(rig), "runtime_mismatch");
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("issue48 recovery: invalid target shape writes nothing", async () => {
  const unblocked = await makeRig("target-unblocked", {
    repair: repairFixture({
      work: [
        targetRecord({ nextStep: "work", blocker: null, intent: null }),
        workRecord("issue-ubiquity-sentinel-58"),
      ],
    }),
  });
  const counters = await makeRig("target-counters", {
    repair: repairFixture({
      work: [
        targetRecord({
          counters: { attempts: 1, retries: 0, reviewRounds: 1 },
        }),
        workRecord("issue-ubiquity-sentinel-58"),
      ],
    }),
  });
  try {
    await expectRejected(
      unblocked,
      await runRig(unblocked),
      "target_precondition_mismatch",
    );
    await expectRejected(
      counters,
      await runRig(counters),
      "target_precondition_mismatch",
    );
  } finally {
    await unblocked.ctx.cleanup();
    await counters.ctx.cleanup();
  }
});

Deno.test("issue48 recovery: missing repair state is a bounded failure", async () => {
  const ctx = await makeCtx("absent");
  try {
    const repair = createRepairStateStore({
      scratchDir: `${ctx.tmp}/repair`,
      remoteUrl: ctx.remoteUrl,
    });
    const release = createReleaseStateStore({
      scratchDir: `${ctx.tmp}/release`,
      remoteUrl: ctx.remoteUrl,
    });
    const runtime = runtimeRecord();
    const released = await release.writeRelease(
      parseReleaseStateSnapshotV1({
        version: "v1",
        kind: "release_state_snapshot",
        stateHead: null,
        sequence: 1,
        updatedAt: T0 + 1000,
        releases: [],
        hostedRuntimes: [runtime],
        hostedReleases: [],
        githubCooldowns: [],
      }),
      null,
    );
    if (!released.ok || released.value.status !== "applied") {
      throw new Error("release fixture seed failed");
    }
    let writes = 0;
    const state: StateReadView & RepairStateWriter = {
      readRepair: () => repair.readRepair(),
      readRelease: () => release.readRelease(),
      writeRepair: (next, expectedHead) => {
        writes++;
        return repair.writeRepair(next, expectedHead);
      },
    };
    const result = await runIssue48Recovery({
      state,
      clock: { now: () => NOW },
      binding: bindingFor(
        PR_HEAD,
        "0".repeat(64),
        released.value.head,
        runtime,
      ),
      readPullRequest: () =>
        Promise.resolve(portOk({
          number: PR_NUMBER,
          state: "open" as const,
          head: PR_HEAD,
          base: PR_BASE,
          repository: REPOSITORY,
        })),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "repair_read_failed");
    assert.equal(result.beforeHead, null);
    assert.equal(result.appliedHead, null);
    assert.equal(writes, 0);
    const refRead = await gitRun(ctx.tmp, [
      "--git-dir",
      ctx.bare,
      "rev-parse",
      "--verify",
      REPAIR_STATE_REF,
    ], ctx.env);
    assert.equal(refRead.ok, false);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("issue48 recovery: conflict and failed writes never claim applied", async () => {
  // CAS conflict: a competing legal write lands between read and write.
  const conflictRig = await makeRig("conflict");
  try {
    let attempts = 0;
    let competitorHead: GitSha | null = null;
    const state: StateReadView & RepairStateWriter = {
      readRepair: () => conflictRig.repair.readRepair(),
      readRelease: () => conflictRig.release.readRelease(),
      writeRepair: async (next, expectedHead) => {
        attempts++;
        if (competitorHead === null) {
          const competitor = parseRepairStateSnapshotV1({
            ...conflictRig.seed,
            stateHead: conflictRig.repairHead,
            sequence: 2,
            updatedAt: T0 + 20_000,
          });
          const written = await conflictRig.repair.writeRepair(
            competitor,
            conflictRig.repairHead,
          );
          if (!written.ok || written.value.status !== "applied") {
            throw new Error("competitor fixture write failed");
          }
          competitorHead = written.value.head;
        }
        return await conflictRig.repair.writeRepair(next, expectedHead);
      },
    };
    const result = await runIssue48Recovery({
      state,
      clock: { now: () => NOW },
      binding: conflictRig.binding,
      readPullRequest: () => Promise.resolve(portOk(conflictRig.prView)),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "write_conflict");
    assert.equal(result.appliedHead, null);
    assert.equal(attempts, 1);
    assert.equal(
      await remoteHead(conflictRig.ctx, REPAIR_STATE_REF),
      competitorHead,
    );
    const read = await conflictRig.repair.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("expected the competitor state");
    }
    const target = read.value.snapshot.work.find((record) =>
      record.id === TARGET_ID
    );
    assert.equal(target?.nextStep, "blocked");
  } finally {
    await conflictRig.ctx.cleanup();
  }

  // Unavailable push: no side effect, no retry, typed disposition preserved.
  const unavailableRig = await makeRig("unavailable");
  try {
    const failing = new FailedPushRunner(
      new DenoGitRunner(`${unavailableRig.ctx.tmp}/git-home`),
      "synthetic transport failure",
    );
    const store = createRepairStateStore({
      scratchDir: `${unavailableRig.ctx.tmp}/failing`,
      remoteUrl: unavailableRig.ctx.remoteUrl,
      runner: failing,
    });
    let attempts = 0;
    const state: StateReadView & RepairStateWriter = {
      readRepair: () => store.readRepair(),
      readRelease: () => store.readRelease(),
      writeRepair: (next, expectedHead) => {
        attempts++;
        return store.writeRepair(next, expectedHead);
      },
    };
    const result = await runIssue48Recovery({
      state,
      clock: { now: () => NOW },
      binding: unavailableRig.binding,
      readPullRequest: () => Promise.resolve(portOk(unavailableRig.prView)),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "write_unavailable");
    assert.equal(result.appliedHead, null);
    assert.equal(attempts, 1);
    assert.equal(failing.pushAttempts, 1);
    assert.equal(
      await remoteHead(unavailableRig.ctx, REPAIR_STATE_REF),
      unavailableRig.repairHead,
    );
  } finally {
    await unavailableRig.ctx.cleanup();
  }

  // Lost verification response: the write really happened, and the runner
  // reports ambiguous rather than concealing the side effect.
  const ambiguousRig = await makeRig("ambiguous");
  try {
    const lost = new LostVerificationRunner(
      new DenoGitRunner(`${ambiguousRig.ctx.tmp}/git-home`),
    );
    const store = createRepairStateStore({
      scratchDir: `${ambiguousRig.ctx.tmp}/lost`,
      remoteUrl: ambiguousRig.ctx.remoteUrl,
      runner: lost,
    });
    let attempts = 0;
    const state: StateReadView & RepairStateWriter = {
      readRepair: () => store.readRepair(),
      readRelease: () => store.readRelease(),
      writeRepair: (next, expectedHead) => {
        attempts++;
        return store.writeRepair(next, expectedHead);
      },
    };
    const result = await runIssue48Recovery({
      state,
      clock: { now: () => NOW },
      binding: ambiguousRig.binding,
      readPullRequest: () => Promise.resolve(portOk(ambiguousRig.prView)),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "write_ambiguous");
    assert.equal(result.appliedHead, null);
    assert.equal(attempts, 1);
    assert.equal(lost.pushes, 1);
    assert.notEqual(
      await remoteHead(ambiguousRig.ctx, REPAIR_STATE_REF),
      ambiguousRig.repairHead,
    );
    const read = await ambiguousRig.repair.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("expected the real side effect");
    }
    const target = read.value.snapshot.work.find((record) =>
      record.id === TARGET_ID
    );
    assert.equal(target?.nextStep, "work");
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("synthetic"));
    assert.ok(!serialized.includes(ambiguousRig.ctx.tmp));
  } finally {
    await ambiguousRig.ctx.cleanup();
  }

  // Readback failure: the write stands, but nothing may claim applied.
  const readbackRig = await makeRig("readback");
  try {
    let repairReads = 0;
    let writtenHead: GitSha | null = null;
    const state: StateReadView & RepairStateWriter = {
      readRepair: () => {
        repairReads++;
        if (repairReads > 1) {
          return Promise.resolve(
            portError("unavailable", "synthetic readback failure"),
          );
        }
        return readbackRig.repair.readRepair();
      },
      readRelease: () => readbackRig.release.readRelease(),
      writeRepair: async (next, expectedHead) => {
        const result = await readbackRig.repair.writeRepair(
          next,
          expectedHead,
        );
        if (result.ok && result.value.status === "applied") {
          writtenHead = result.value.head;
        }
        return result;
      },
    };
    const result = await runIssue48Recovery({
      state,
      clock: { now: () => NOW },
      binding: readbackRig.binding,
      readPullRequest: () => Promise.resolve(portOk(readbackRig.prView)),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "readback_unverified");
    assert.equal(result.appliedHead, null);
    assert.equal(repairReads, 2);
    const provedHead = writtenHead as GitSha | null;
    if (provedHead === null) throw new Error("expected a real applied write");
    assert.equal(
      await remoteHead(readbackRig.ctx, REPAIR_STATE_REF),
      provedHead,
    );
    const read = await readbackRig.repair.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("expected the unverified but real write");
    }
    const target = read.value.snapshot.work.find((record) =>
      record.id === TARGET_ID
    );
    assert.equal(target?.nextStep, "work");
  } finally {
    await readbackRig.ctx.cleanup();
  }
});

Deno.test("issue48 recovery: supervisor workflow dependency and locking contract", async () => {
  const text = await Deno.readTextFile(
    `${ROOT}/.github/workflows/supervisor.yml`,
  );
  assert.ok(text.includes("name: sentinel-supervisor"));
  assert.ok(text.includes("workflow_dispatch:"));
  assert.ok(!text.includes("schedule:"));
  assert.ok(text.includes("group: sentinel-supervisor"));

  const maintenanceAt = text.indexOf("\n  maintenance:");
  const prepareAt = text.indexOf("\n  prepare:");
  const repairAt = text.indexOf("\n  repair:");
  const finalizeAt = text.indexOf("\n  finalize:");
  assert.ok(
    maintenanceAt > 0 && prepareAt > maintenanceAt && repairAt > prepareAt &&
      finalizeAt > repairAt,
    "maintenance must precede prepare, repair and finalize",
  );
  const maintenance = text.slice(maintenanceAt, prepareAt);
  assert.ok(
    maintenance.includes("if: github.ref == 'refs/heads/sentinel-supervisor'"),
  );
  assert.ok(maintenance.includes("runs-on: ubuntu-latest"));
  assert.ok(maintenance.includes("timeout-minutes: 5"));
  assert.ok(maintenance.includes("group: sentinel-repair"));
  assert.ok(maintenance.includes("cancel-in-progress: false"));
  assert.ok(
    maintenance.includes(
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    ),
  );
  assert.ok(
    maintenance.includes(
      "denoland/setup-deno@22d081ff2d3a40755e97629de92e3bcbfa7cf2ed",
    ),
  );
  assert.ok(maintenance.includes("ref: ${{ github.sha }}"));
  assert.ok(maintenance.includes("fetch-depth: 0"));
  assert.ok(maintenance.includes("persist-credentials: false"));
  assert.ok(maintenance.includes("ops/issue48-review-quota-recovery.ts"));
  assert.ok(maintenance.includes("--no-lock"));
  assert.ok(maintenance.includes("--allow-run=git"));
  assert.ok(maintenance.includes("--allow-net=api.github.com"));
  assert.ok(maintenance.includes("GITHUB_TOKEN: ${{ github.token }}"));
  for (
    const forbidden of [
      "environment:",
      "secrets.",
      "SENTINEL_SUPERVISOR_TOKEN",
      "UOS_AI_TOKEN",
      "setup-node",
      "codex",
      "actions: write",
      "issues: write",
      "pull-requests: write",
      "checks:",
      "statuses:",
    ]
  ) {
    assert.ok(!maintenance.includes(forbidden), `forbidden: ${forbidden}`);
  }
  const permissionsAt = maintenance.indexOf("permissions:");
  const concurrencyAt = maintenance.indexOf("concurrency:");
  assert.ok(permissionsAt > 0 && concurrencyAt > permissionsAt);
  assert.equal(
    maintenance.slice(permissionsAt, concurrencyAt).replace(/\s+/g, " ").trim(),
    "permissions: contents: write pull-requests: read",
  );

  // A maintenance failure must never skip a valid ordinary run: prepare still
  // runs (always()) and repair requires prepare success explicitly.
  const prepare = text.slice(prepareAt, repairAt);
  assert.ok(prepare.includes("needs: maintenance"));
  assert.ok(
    prepare.includes(
      "if: always() && github.ref == 'refs/heads/sentinel-supervisor'",
    ),
  );
  const repair = text.slice(repairAt, finalizeAt);
  assert.ok(
    repair.includes(
      "if: ${{ !cancelled() && needs.prepare.result == 'success' && github.ref == 'refs/heads/sentinel-supervisor' && needs.prepare.outputs.run == 'true' }}",
    ),
  );
  const finalize = text.slice(finalizeAt);
  assert.ok(finalize.includes("needs: [prepare, repair]"));
  assert.ok(
    finalize.includes(
      "if: always() && github.ref == 'refs/heads/sentinel-supervisor'",
    ),
  );
  assert.ok(!finalize.includes("issue48"));
});

Deno.test("issue48 recovery: hosted identity rejection is pure and exact", () => {
  const sha = "a".repeat(40);
  const valid: Issue48HostedIdentityV1 = {
    repository: REPOSITORY,
    ref: "refs/heads/sentinel-supervisor",
    job: "maintenance",
    runId: "34874909140",
    runAttempt: "1",
    workflowRef:
      "ubiquity/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor",
    sha,
    workflowSha: sha,
    checkoutHead: sha,
    checkoutClean: true,
  };
  assert.deepEqual(validateIssue48HostedIdentity(valid), { ok: true });

  const cases: [Partial<Issue48HostedIdentityV1>, Issue48IdentityFailureV1][] =
    [
      [{ repository: "ubiquity/other" }, "repository"],
      [{ ref: "refs/heads/main" }, "ref"],
      [{ job: "prepare" }, "job"],
      [{ runId: "0" }, "run"],
      [{ runId: "abc" }, "run"],
      [{ runAttempt: "0" }, "run"],
      [
        {
          workflowRef:
            "ubiquity/sentinel/.github/workflows/dispatch.yml@refs/heads/sentinel-supervisor",
        },
        "workflow_ref",
      ],
      [{ workflowSha: "b".repeat(40) }, "sha"],
      [{ sha: "not-a-sha" }, "sha"],
      [{ checkoutHead: "b".repeat(40) }, "checkout"],
      [{ checkoutClean: false }, "checkout"],
    ];
  for (const [patch, reason] of cases) {
    assert.deepEqual(
      validateIssue48HostedIdentity({ ...valid, ...patch }),
      { ok: false, reason },
    );
  }
});

const PR_READ_TOKEN = "issue48-test-token-not-a-secret";

function prPayload(): Record<string, unknown> {
  return {
    number: PR_NUMBER,
    state: "open",
    merged: false,
    head: { sha: PR_HEAD, repo: { full_name: REPOSITORY } },
    base: { sha: PR_BASE, repo: { full_name: REPOSITORY } },
  };
}

Deno.test("issue48 recovery: bounded PR read accepts valid in-budget JSON", async () => {
  const transport: typeof fetch = (input, init) => {
    assert.equal(
      input,
      `https://api.github.com/repos/${REPOSITORY}/pulls/${PR_NUMBER}`,
    );
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("accept"), "application/vnd.github+json");
    assert.equal(headers.get("authorization"), `Bearer ${PR_READ_TOKEN}`);
    return Promise.resolve(
      new Response(JSON.stringify(prPayload()), { status: 200 }),
    );
  };
  const result = await readGitHubPullRequest(
    PR_NUMBER,
    PR_READ_TOKEN,
    transport,
  );
  if (!result.ok) throw new Error("expected a bounded PR read");
  assert.deepEqual(result.value, {
    number: PR_NUMBER,
    state: "open",
    head: PR_HEAD,
    base: PR_BASE,
    repository: REPOSITORY,
  });
});

Deno.test("issue48 recovery: oversized streamed PR bytes are cancelled early", async () => {
  const chunkCount = 8;
  const chunk = new Uint8Array(16 * 1024).fill(0x61);
  let pulled = 0;
  let cancelled = false;
  const transport: typeof fetch = () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  };
  const result = await readGitHubPullRequest(
    PR_NUMBER,
    PR_READ_TOKEN,
    transport,
  );
  if (result.ok) throw new Error("expected the oversized read to fail");
  assert.equal(result.error.kind, "invalid");
  assert.ok(cancelled, "overflow must cancel the response body");
  assert.ok(
    pulled < chunkCount,
    `the reader must stop before all content: pulled=${pulled}`,
  );
});

Deno.test("issue48 recovery: a stalled PR body aborts at the fixed deadline", async () => {
  let observedAbort = false;
  const transport: typeof fetch = (_input, init) => {
    const signal = init?.signal ?? null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => {
          observedAbort = true;
          controller.error(new DOMException("aborted", "AbortError"));
        }, { once: true });
      },
      pull() {
        return new Promise<void>(() => {});
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  };
  const startedAt = Date.now();
  const result = await readGitHubPullRequest(
    PR_NUMBER,
    PR_READ_TOKEN,
    transport,
  );
  const elapsedMs = Date.now() - startedAt;
  if (result.ok) throw new Error("expected the stalled read to time out");
  assert.equal(result.error.kind, "unavailable");
  assert.ok(observedAbort, "the stalled body must observe the abort signal");
  assert.ok(
    elapsedMs >= 9_000,
    `the fixed deadline must actually elapse: ${elapsedMs}ms`,
  );
});

Deno.test("issue48 recovery: main rejects identity before reading the token", async () => {
  const source = await Deno.readTextFile(`${ROOT}/ops/issue48-recovery.ts`);
  const mainAt = source.indexOf("export async function runIssue48RecoveryMain");
  assert.ok(mainAt > 0, "main entry point must exist in source");
  const mainSource = source.slice(mainAt);
  const rejectionAt = mainSource.indexOf('failed("identity_rejected")');
  const tokenAt = mainSource.indexOf('readEnv("GITHUB_TOKEN")');
  assert.ok(rejectionAt > 0 && tokenAt > 0);
  assert.ok(
    rejectionAt < tokenAt,
    "identity_rejected must be returned before GITHUB_TOKEN is read",
  );
});
