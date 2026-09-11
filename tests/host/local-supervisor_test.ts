/**
 * Wave C local supervisor: focused actual tests with a real temporary Git
 * origin, a real private temporary state root and the real supervisor state
 * machine. The ONLY injected border is child execution (`runChild`): the fake
 * child writes the same private status/pointer side effects a real bounded
 * local run would, and the supervisor's receipts, locks, pointer compare-set,
 * staging clones and proofs all execute for real.
 *
 * No model call, no network, no GitHub, no credential, no real private state.
 * Tests are seconds long and use a controlled clock.
 */

import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import type { Clock } from "../../src/contracts/ports.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import { sameLocalReleaseRequestV1 } from "../../src/contracts/local-release.ts";
import {
  localSessionMarkerExists,
  readLocalActiveRuntime,
  readLocalReleaseReceipt,
} from "../../src/host/local-release.ts";
import type { LocalSupervisorChildInputV1 } from "../../src/host/local-supervisor.ts";
import { runLocalSupervisor } from "../../src/host/local-supervisor.ts";
import {
  gitRun,
  releaseRequest,
  reviewReceipt,
  T0,
  testGitEnv,
} from "../state/helpers.ts";
import { FakeClock } from "../repair/helpers.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/host\/local-supervisor_test\.ts$/,
  "",
);

const LOCAL_REPO = {
  owner: "ubiquity",
  name: "sentinel",
  installationId: 0,
} as const;
const REVIEWER = "chatgpt-codex-connector[bot]";

interface FixtureOptionsV1 {
  /** Reviewed head bound into the request and the review receipt. */
  reviewHead?: GitSha;
  /** Request source head (defaults to the installed prior commit). */
  requestHead?: GitSha;
  /** Bind the review receipt to the candidate head instead of the request head. */
  mismatchReviewHead?: boolean;
  /** Request revision (defaults to the candidate commit). */
  requestRevision?: GitSha;
  /** Active pointer revision (defaults to the installed prior commit). */
  pointerRevision?: GitSha;
  /** Do not write the bootstrap pointer at all. */
  omitPointer?: boolean;
  /** Write a corrupt private receipt file. */
  corruptReceipts?: boolean;
  /** Write a corrupt active-runtime pointer. */
  corruptPointer?: boolean;
}

interface FixtureV1 {
  root: string;
  stateRoot: string;
  env: Record<string, string>;
  clock: FakeClock;
  baseSha: GitSha;
  priorSha: GitSha;
  candidateSha: GitSha;
  request: ReleaseRequestV1;
  review: ReviewReceiptV1;
  cleanup(): Promise<void>;
}

function sha(value: string): GitSha {
  return value.trim() as GitSha;
}

async function commit(
  work: string,
  env: Record<string, string>,
  text: string,
): Promise<GitSha> {
  await Deno.writeTextFile(`${work}/file.txt`, `${text}\n`);
  await gitRun(work, ["add", "-A"], env);
  const done = await gitRun(work, ["commit", "-q", "-m", text], env);
  if (!done.ok) throw new Error(`commit failed: ${done.stderr}`);
  return sha((await gitRun(work, ["rev-parse", "HEAD"], env)).stdout);
}

async function cloneRuntime(
  sourceDir: string,
  target: string,
  revision: GitSha,
  env: Record<string, string>,
  cwd: string,
): Promise<void> {
  await Deno.mkdir(target, { recursive: true });
  const cloned = await gitRun(cwd, ["clone", "-q", sourceDir, target], env);
  if (!cloned.ok) throw new Error(`runtime clone failed: ${cloned.stderr}`);
  const checked = await gitRun(
    target,
    ["checkout", "-q", "--detach", revision],
    env,
  );
  if (!checked.ok) {
    throw new Error(`runtime checkout failed: ${checked.stderr}`);
  }
}

async function makeFixture(
  prefix: string,
  options: FixtureOptionsV1 = {},
): Promise<FixtureV1> {
  const root = await Deno.makeTempDir({
    prefix: `sentinel-supervisor-${prefix}-`,
    dir: ROOT,
  });
  try {
    return await buildFixture(root, options);
  } catch (error) {
    // Setup failed after this call created its own private root: remove only
    // that new root (previous diagnostic roots are never touched) and rethrow
    // the original setup error. A cleanup failure is preserved alongside it.
    try {
      await Deno.remove(root, { recursive: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "local supervisor fixture setup failed and its root could not be removed",
      );
    }
    throw error;
  }
}

async function buildFixture(
  root: string,
  options: FixtureOptionsV1,
): Promise<FixtureV1> {
  const home = `${root}/home`;
  await Deno.mkdir(home, { recursive: true });
  const env = testGitEnv(home);

  // Real origin repository with three exact commits: base, installed prior,
  // candidate. The refreshed development tip is the candidate.
  const origin = `${root}/origin.git`;
  const bare = await gitRun(root, ["init", "-q", "--bare", origin], env);
  if (!bare.ok) throw new Error(`bare init failed: ${bare.stderr}`);
  const work = `${root}/origin-work`;
  await Deno.mkdir(work, { recursive: true });
  const workInit = await gitRun(root, ["init", "-q", work], env);
  if (!workInit.ok) throw new Error(`work init failed: ${workInit.stderr}`);
  await Deno.writeTextFile(`${work}/file.txt`, "base\n");
  await gitRun(work, ["add", "-A"], env);
  await gitRun(work, ["commit", "-q", "-m", "base"], env);
  const renamed = await gitRun(work, ["branch", "-M", "development"], env);
  if (!renamed.ok) throw new Error(`branch rename failed: ${renamed.stderr}`);
  const baseSha = sha((await gitRun(work, ["rev-parse", "HEAD"], env)).stdout);
  const priorSha = await commit(work, env, "prior");
  const addedRemote = await gitRun(
    work,
    ["remote", "add", "origin", origin],
    env,
  );
  if (!addedRemote.ok) {
    throw new Error(`remote add failed: ${addedRemote.stderr}`);
  }
  const firstPush = await gitRun(
    work,
    ["push", "-q", "origin", "development"],
    env,
  );
  if (!firstPush.ok) throw new Error(`push failed: ${firstPush.stderr}`);
  const candidateSha = await commit(work, env, "candidate");
  const secondPush = await gitRun(
    work,
    ["push", "-q", "origin", "development"],
    env,
  );
  if (!secondPush.ok) throw new Error(`push failed: ${secondPush.stderr}`);

  const stateRoot = `${root}/state`;
  await Deno.mkdir(stateRoot, { recursive: true });
  const sourceDir = `${stateRoot}/source`;
  const sourceClone = await gitRun(
    root,
    ["clone", "-q", origin, sourceDir],
    env,
  );
  if (!sourceClone.ok) {
    throw new Error(`source clone failed: ${sourceClone.stderr}`);
  }
  // The healthy real child host owns the development refresh; the supervisor
  // only reads the local remote-tracking ref. Seed that exact ref directly:
  // no URL rewrite, fetch or network is involved.
  const seededRef = await gitRun(
    sourceDir,
    ["update-ref", "refs/remotes/origin/development", candidateSha],
    env,
  );
  if (!seededRef.ok) {
    throw new Error(`development ref seed failed: ${seededRef.stderr}`);
  }
  const runtimes = `${stateRoot}/runtimes`;
  await Deno.mkdir(runtimes, { recursive: true });
  await cloneRuntime(sourceDir, `${runtimes}/${priorSha}`, priorSha, env, root);
  // An unrelated newer pointer must still be an exact clean runtime.
  await cloneRuntime(sourceDir, `${runtimes}/${baseSha}`, baseSha, env, root);

  const pointerRevision = options.pointerRevision ?? priorSha;
  if (options.omitPointer !== true) {
    const text = options.corruptPointer === true
      ? "{not json\n"
      : JSON.stringify({
        version: "v1",
        kind: "local_active_runtime",
        revision: pointerRevision,
      }) + "\n";
    await Deno.writeTextFile(`${stateRoot}/active-runtime.json`, text, {
      mode: 0o600,
    });
  }

  const requestHead = options.requestHead ?? priorSha;
  const reviewHead = options.mismatchReviewHead === true
    ? candidateSha
    : options.reviewHead ?? priorSha;
  const requestRevision = options.requestRevision ?? candidateSha;
  const request = releaseRequest("release-local-1", {
    target: { repository: LOCAL_REPO, environment: "production" },
    revision: requestRevision,
    source: {
      pullRequest: 12,
      reviewRequestId: "review-req-1",
      reviewReceiptId: "review-receipt-1",
      head: requestHead,
      base: baseSha,
    },
    createdAt: T0,
  });
  const review = reviewReceipt("review-receipt-1", {
    requestId: "review-req-1",
    repository: LOCAL_REPO,
    pullRequest: { number: 12, head: reviewHead, base: baseSha },
    outcome: "completed",
    // A completed review receipt requires its nonempty observed result id.
    resultId: "review-result-1",
    observedReviewer: REVIEWER,
    submittedAt: T0 + 500,
    completedAt: T0 + 1000,
    observedAt: T0 + 2000,
    findingsUncounted: 0,
    unresolvedSeverities: [],
  });

  const stateGit = `${stateRoot}/state.git`;
  const stateInit = await gitRun(
    stateRoot,
    ["init", "-q", "--bare", stateGit],
    env,
  );
  if (!stateInit.ok) throw new Error(`state init failed: ${stateInit.stderr}`);
  const store = createRepairStateStore({
    scratchDir: `${stateRoot}/seed-scratch`,
    remoteUrl: stateGit,
  });
  const snapshot: RepairStateSnapshotV1 = {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [review],
    replays: [],
    releaseRequests: [request],
    githubCooldowns: [],
  };
  const written = await store.writeRepair(snapshot, null);
  assert.ok(written.ok && written.value.status === "applied");

  if (options.corruptReceipts === true) {
    await Deno.mkdir(`${stateRoot}/local-releases`, { recursive: true });
    await Deno.writeTextFile(
      `${stateRoot}/local-releases/corrupt.json`,
      "{not json\n",
      { mode: 0o600 },
    );
  }

  return {
    root,
    stateRoot,
    env,
    clock: new FakeClock(T0),
    baseSha,
    priorSha,
    candidateSha,
    request,
    review,
    cleanup: async () => {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

type ChildStepV1 =
  | "idle"
  | "state_error"
  | "unsettled"
  | "missing_status"
  | "startup_failure"
  | "state_unavailable"
  | "missing_state_evidence"
  | "unknown_state"
  | "future_proof"
  | "stale_child_start";

interface ChildScriptV1 {
  steps: ChildStepV1[];
  /** Side effect executed after the child "settles" (e.g. pointer tamper). */
  after?: (input: LocalSupervisorChildInputV1, index: number) => Promise<void>;
}

function makeChildRunner(
  fixture: FixtureV1,
  script: ChildScriptV1,
): {
  runChild: (
    input: LocalSupervisorChildInputV1,
  ) => Promise<{ settled: boolean; exitCode: number | null }>;
  revisions: GitSha[];
} {
  const revisions: GitSha[] = [];
  let index = 0;
  const runChild = async (input: LocalSupervisorChildInputV1) => {
    const step = script.steps[index] ?? "idle";
    const call = index;
    index++;
    revisions.push(input.revision);
    if (step === "unsettled") return { settled: false, exitCode: null };
    // A startup failure settles nonzero without writing any new status: the
    // supervisor must treat the objective exit as failed and roll back.
    if (step === "startup_failure") return { settled: true, exitCode: 1 };
    fixture.clock.advance(1000);
    const finishedAt = fixture.clock.now();
    if (step !== "missing_status") {
      const status: Record<string, unknown> = {
        version: "v1",
        kind: "sentinel_local_status",
        invocationId: `inv-${call + 1}-${crypto.randomUUID()}`,
        controllerSha: input.revision,
        startedAt: finishedAt - 500,
        finishedAt,
        outcome: {
          status: step === "state_error" ? "state_error" : "idle",
        },
        // The real successful status shape: no explicit `state`, with the
        // observed work and reservation arrays present.
        work: [],
        reservations: [],
      };
      if (step === "state_unavailable") {
        status.state = "unavailable";
        delete status.work;
        delete status.reservations;
      }
      if (step === "missing_state_evidence") {
        delete status.work;
        delete status.reservations;
      }
      if (step === "unknown_state") status.state = "available";
      if (step === "future_proof") status.finishedAt = finishedAt + 60_000;
      if (step === "stale_child_start") status.startedAt = finishedAt - 60_000;
      await Deno.writeTextFile(
        `${input.stateRoot}/status.json`,
        JSON.stringify(status) + "\n",
        { mode: 0o600 },
      );
    }
    if (script.after !== undefined) await script.after(input, call);
    return { settled: true, exitCode: 0 };
  };
  return { runChild, revisions };
}

function supervisorOptions(
  fixture: FixtureV1,
  runChild: (
    input: LocalSupervisorChildInputV1,
  ) => Promise<{ settled: boolean; exitCode: number | null }>,
) {
  return {
    stateRoot: fixture.stateRoot,
    env: {
      HOME: fixture.env.HOME,
      PATH: fixture.env.PATH,
      GITHUB_TOKEN: "test-github-token",
      UOS_AI_TOKEN: "test-model-token",
    },
    denoExecutable: Deno.execPath(),
    clock: fixture.clock as Clock,
    runChild,
  };
}

async function readPointer(stateRoot: string): Promise<string | null> {
  const pointer = await readLocalActiveRuntime(stateRoot);
  assert.ok(pointer.ok);
  if (!pointer.ok) throw new Error("pointer unreadable");
  return pointer.value === null ? null : pointer.value.revision;
}

async function runtimeHead(
  runtimeDir: string,
  env: Record<string, string>,
): Promise<string> {
  const result = await gitRun(runtimeDir, ["rev-parse", "HEAD"], env);
  assert.ok(result.ok, result.stderr);
  return result.stdout.trim();
}

Deno.test(
  "local release: supervisor installs the exact reviewed revision and records candidate proof",
  async () => {
    const fixture = await makeFixture("accept");
    try {
      const child = makeChildRunner(fixture, { steps: ["idle", "idle"] });
      const result = await runLocalSupervisor(
        supervisorOptions(fixture, child.runChild),
      );
      assert.equal(result.status, "accepted", JSON.stringify(result));
      assert.deepEqual(child.revisions, [
        fixture.priorSha,
        fixture.candidateSha,
      ]);
      assert.equal(await readPointer(fixture.stateRoot), fixture.candidateSha);

      const receipt = await readLocalReleaseReceipt(
        fixture.stateRoot,
        fixture.request,
      );
      assert.ok(receipt.ok);
      if (!receipt.ok || receipt.value === null) {
        throw new Error("receipt missing");
      }
      assert.equal(receipt.value.phase, "accepted");
      assert.equal(
        receipt.value.candidateProof?.controllerSha,
        fixture.candidateSha,
      );
      assert.equal(receipt.value.priorProof?.controllerSha, fixture.priorSha);
      assert.equal(
        await runtimeHead(
          `${fixture.stateRoot}/runtimes/${fixture.candidateSha}`,
          fixture.env,
        ),
        fixture.candidateSha,
      );
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "local release: candidate failure restores the exact prior runtime and records rolled_back",
  async () => {
    const fixture = await makeFixture("rollback");
    try {
      const child = makeChildRunner(fixture, {
        steps: ["idle", "state_error", "idle"],
      });
      const result = await runLocalSupervisor(
        supervisorOptions(fixture, child.runChild),
      );
      assert.equal(result.status, "rolled_back", JSON.stringify(result));
      assert.deepEqual(child.revisions, [
        fixture.priorSha,
        fixture.candidateSha,
        fixture.priorSha,
      ]);
      assert.equal(await readPointer(fixture.stateRoot), fixture.priorSha);

      const receipt = await readLocalReleaseReceipt(
        fixture.stateRoot,
        fixture.request,
      );
      assert.ok(receipt.ok);
      if (!receipt.ok || receipt.value === null) {
        throw new Error("receipt missing");
      }
      assert.equal(receipt.value.phase, "rolled_back");
      assert.equal(receipt.value.candidateProof?.outcome, "state_error");
      assert.equal(receipt.value.priorProof?.controllerSha, fixture.priorSha);
      assert.ok(
        (receipt.value.priorProof?.finishedAt ?? 0) >
          (receipt.value.candidateProof?.finishedAt ?? 0),
        "rolled_back requires a fresh prior run proof",
      );
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "local release: pending rollback proof stays durable and a resumed pass completes the exact prior rollback",
  async () => {
    const fixture = await makeFixture("rollbackresume");
    try {
      // First invocation: the candidate reports an objective state failure,
      // the exact prior pointer is restored, but the confirming prior run
      // never settles. No terminal receipt may be written.
      const first = makeChildRunner(fixture, {
        steps: ["idle", "state_error", "unsettled"],
      });
      const pending = await runLocalSupervisor(
        supervisorOptions(fixture, first.runChild),
      );
      assert.equal(pending.status, "pending", JSON.stringify(pending));
      assert.deepEqual(first.revisions, [
        fixture.priorSha,
        fixture.candidateSha,
        fixture.priorSha,
      ]);
      assert.equal(await readPointer(fixture.stateRoot), fixture.priorSha);
      const afterPending = await readLocalReleaseReceipt(
        fixture.stateRoot,
        fixture.request,
      );
      assert.ok(afterPending.ok && afterPending.value !== null);
      if (!afterPending.ok || afterPending.value === null) {
        throw new Error("receipt missing");
      }
      assert.equal(afterPending.value.phase, "rollback_pending");
      assert.equal(afterPending.value.priorRevision, fixture.priorSha);
      const baselinePrior = afterPending.value.priorProof;
      assert.ok(baselinePrior !== null);
      if (baselinePrior === null) {
        throw new Error("baseline prior proof missing");
      }
      assert.equal(baselinePrior.controllerSha, fixture.priorSha);
      assert.ok(
        afterPending.value.createdAt > baselinePrior.startedAt,
        "the creation timestamp is the install time, never the baseline proof start",
      );
      const candidateFailure = afterPending.value.candidateProof;
      assert.ok(candidateFailure !== null);
      if (candidateFailure === null) {
        throw new Error("candidate failure proof missing");
      }
      assert.equal(candidateFailure.outcome, "state_error");

      // The resumed pass repeats the exact prior runtime and records the
      // rollback: original creation time, request identity and the observed
      // candidate failure are unchanged, and the new prior proof is fresh.
      const second = makeChildRunner(fixture, { steps: ["idle"] });
      const result = await runLocalSupervisor(
        supervisorOptions(fixture, second.runChild),
      );
      assert.equal(result.status, "rolled_back", JSON.stringify(result));
      assert.deepEqual(second.revisions, [fixture.priorSha]);
      assert.equal(await readPointer(fixture.stateRoot), fixture.priorSha);
      const receipt = await readLocalReleaseReceipt(
        fixture.stateRoot,
        fixture.request,
      );
      assert.ok(receipt.ok && receipt.value !== null);
      if (!receipt.ok || receipt.value === null) {
        throw new Error("receipt missing");
      }
      assert.equal(receipt.value.phase, "rolled_back");
      assert.equal(receipt.value.priorRevision, fixture.priorSha);
      assert.ok(
        sameLocalReleaseRequestV1(receipt.value.request, fixture.request),
        "the resumed rollback keeps the exact request identity",
      );
      assert.equal(
        receipt.value.createdAt,
        afterPending.value.createdAt,
        "the resumed rollback keeps the original creation timestamp",
      );
      assert.equal(
        receipt.value.candidateProof?.invocationId,
        candidateFailure.invocationId,
        "the observed candidate failure is preserved, never fabricated",
      );
      const fresh = receipt.value.priorProof;
      assert.ok(fresh !== null);
      if (fresh === null) {
        throw new Error("fresh prior proof missing");
      }
      assert.equal(fresh.controllerSha, fixture.priorSha);
      assert.notEqual(
        fresh.invocationId,
        baselinePrior.invocationId,
        "the rollback proof is a new observed run, never the baseline",
      );
      assert.ok(
        fresh.startedAt >= receipt.value.createdAt,
        "the rollback proof is fresh relative to the original creation time",
      );
      assert.ok(
        fresh.startedAt >= afterPending.value.updatedAt,
        "the resumed pass ran the exact prior again",
      );
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "local release: restart reconciles a saved verifying intent against the candidate pointer",
  async () => {
    const fixture = await makeFixture("restart");
    try {
      // First invocation: the candidate child never settles, so the receipt
      // stays verifying and the pointer already points at the candidate.
      const first = makeChildRunner(fixture, {
        steps: ["idle", "unsettled"],
      });
      const pending = await runLocalSupervisor(
        supervisorOptions(fixture, first.runChild),
      );
      assert.equal(pending.status, "pending", JSON.stringify(pending));
      assert.equal(await readPointer(fixture.stateRoot), fixture.candidateSha);
      const afterCrash = await readLocalReleaseReceipt(
        fixture.stateRoot,
        fixture.request,
      );
      assert.ok(afterCrash.ok && afterCrash.value !== null);
      if (!afterCrash.ok || afterCrash.value === null) {
        throw new Error("receipt missing");
      }
      assert.equal(afterCrash.value.phase, "verifying");
      const verifyingCreatedAt = afterCrash.value.createdAt;

      // Second invocation reconciles by the exact receipt/pointer identities
      // and a fresh actual candidate run; acceptance is never inferred.
      const second = makeChildRunner(fixture, { steps: ["idle"] });
      const result = await runLocalSupervisor(
        supervisorOptions(fixture, second.runChild),
      );
      assert.equal(result.status, "accepted", JSON.stringify(result));
      assert.deepEqual(second.revisions, [fixture.candidateSha]);
      const receipt = await readLocalReleaseReceipt(
        fixture.stateRoot,
        fixture.request,
      );
      assert.ok(receipt.ok && receipt.value !== null);
      if (!receipt.ok || receipt.value === null) {
        throw new Error("receipt missing");
      }
      assert.equal(receipt.value.phase, "accepted");
      assert.equal(
        receipt.value.createdAt,
        verifyingCreatedAt,
        "the resumed acceptance keeps the original creation timestamp",
      );
      assert.ok(
        sameLocalReleaseRequestV1(receipt.value.request, fixture.request),
        "the resumed acceptance keeps the exact request identity",
      );
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "local release: a corrupt runtime index refuses verification before any child run",
  async () => {
    const fixture = await makeFixture("corruptindex");
    try {
      // A present-but-corrupt index makes `git status` exit nonzero while its
      // stdout stays empty. That is a failed verification, never a clean
      // checkout, so the active runtime may not be executed at all.
      await Deno.writeTextFile(
        `${fixture.stateRoot}/runtimes/${fixture.priorSha}/.git/index`,
        "corrupt index\n",
      );
      const child = makeChildRunner(fixture, { steps: ["idle"] });
      const result = await runLocalSupervisor(
        supervisorOptions(fixture, child.runChild),
      );
      assert.equal(result.status, "failed", JSON.stringify(result));
      assert.equal(
        child.revisions.length,
        0,
        "no child may run against an unverified runtime",
      );
      assert.equal(await readPointer(fixture.stateRoot), fixture.priorSha);
      const receipt = await readLocalReleaseReceipt(
        fixture.stateRoot,
        fixture.request,
      );
      assert.ok(receipt.ok && receipt.value === null);
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "local release: a verifying receipt whose pointer already equals the prior recovers to rolled_back",
  async () => {
    const fixture = await makeFixture("verifyingprior");
    try {
      // First invocation: the candidate is installed and the verifying receipt
      // is durable, but the candidate child never settles.
      const first = makeChildRunner(fixture, {
        steps: ["idle", "unsettled"],
      });
      const pending = await runLocalSupervisor(
        supervisorOptions(fixture, first.runChild),
      );
      assert.equal(pending.status, "pending", JSON.stringify(pending));
      assert.equal(await readPointer(fixture.stateRoot), fixture.candidateSha);
      const crash = await readLocalReleaseReceipt(
        fixture.stateRoot,
        fixture.request,
      );
      assert.ok(crash.ok && crash.value !== null);
      if (!crash.ok || crash.value === null) {
        throw new Error("receipt missing");
      }
      assert.equal(crash.value.phase, "verifying");

      // Simulate the exact-prior restore that crashed after the pointer write
      // and before the receipt transition: the pointer already equals prior.
      await Deno.writeTextFile(
        `${fixture.stateRoot}/active-runtime.json`,
        JSON.stringify({
          version: "v1",
          kind: "local_active_runtime",
          revision: fixture.priorSha,
        }) + "\n",
        { mode: 0o600 },
      );

      // Recovery persists the rollback intent and proves the exact prior with
      // one fresh prior run. The candidate-to-prior swap is not repeated, and
      // acceptance is never inferred from the pointer.
      const second = makeChildRunner(fixture, { steps: ["idle"] });
      const result = await runLocalSupervisor(
        supervisorOptions(fixture, second.runChild),
      );
      assert.equal(result.status, "rolled_back", JSON.stringify(result));
      assert.deepEqual(second.revisions, [fixture.priorSha]);
      assert.equal(await readPointer(fixture.stateRoot), fixture.priorSha);
      const receipt = await readLocalReleaseReceipt(
        fixture.stateRoot,
        fixture.request,
      );
      assert.ok(receipt.ok && receipt.value !== null);
      if (!receipt.ok || receipt.value === null) {
        throw new Error("receipt missing");
      }
      assert.equal(receipt.value.phase, "rolled_back");
      assert.equal(
        receipt.value.createdAt,
        crash.value.createdAt,
        "the original creation timestamp is retained",
      );
      assert.ok(
        sameLocalReleaseRequestV1(receipt.value.request, fixture.request),
        "the exact request identity is retained",
      );
      assert.equal(
        receipt.value.candidateProof,
        crash.value.candidateProof,
        "the saved candidate proof is preserved, never fabricated",
      );
      const freshPrior = receipt.value.priorProof;
      assert.ok(freshPrior !== null);
      if (freshPrior === null) {
        throw new Error("fresh prior proof missing");
      }
      assert.equal(freshPrior.controllerSha, fixture.priorSha);
      assert.ok(
        freshPrior.startedAt >= receipt.value.createdAt,
        "rolled_back requires a fresh exact prior run proof",
      );
      assert.notEqual(
        freshPrior.invocationId,
        crash.value.priorProof?.invocationId,
        "the rollback proof is a new observed run, never the baseline",
      );
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "local release: wrong review head refuses promotion",
  async () => {
    const fixture = await makeFixture("wronghead", {
      mismatchReviewHead: true,
    });
    try {
      const child = makeChildRunner(fixture, { steps: ["idle"] });
      const result = await runLocalSupervisor(
        supervisorOptions(fixture, child.runChild),
      );
      assert.equal(result.status, "idle", JSON.stringify(result));
      assert.equal(await readPointer(fixture.stateRoot), fixture.priorSha);
      const receipt = await readLocalReleaseReceipt(
        fixture.stateRoot,
        fixture.request,
      );
      assert.ok(receipt.ok && receipt.value === null);
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "local release: missing bootstrap pointer is refused",
  async () => {
    const fixture = await makeFixture("nopointer", { omitPointer: true });
    try {
      const child = makeChildRunner(fixture, { steps: ["idle"] });
      const result = await runLocalSupervisor(
        supervisorOptions(fixture, child.runChild),
      );
      assert.equal(result.status, "failed", JSON.stringify(result));
      assert.equal(
        child.revisions.length,
        0,
        "no child runs without a pointer",
      );
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "local release: corrupt pointer and corrupt receipt are refused",
  async () => {
    const badPointer = await makeFixture("badpointer", {
      corruptPointer: true,
    });
    try {
      const child = makeChildRunner(badPointer, { steps: ["idle"] });
      const result = await runLocalSupervisor(
        supervisorOptions(badPointer, child.runChild),
      );
      assert.equal(result.status, "failed", JSON.stringify(result));
      assert.equal(child.revisions.length, 0);
    } finally {
      await badPointer.cleanup();
    }

    const badReceipts = await makeFixture("badreceipt", {
      corruptReceipts: true,
    });
    try {
      const child = makeChildRunner(badReceipts, { steps: ["idle"] });
      const result = await runLocalSupervisor(
        supervisorOptions(badReceipts, child.runChild),
      );
      assert.equal(result.status, "failed", JSON.stringify(result));
      assert.equal(
        await readPointer(badReceipts.stateRoot),
        badReceipts.priorSha,
      );
      assert.equal(child.revisions.length, 0);
    } finally {
      await badReceipts.cleanup();
    }
  },
);

Deno.test(
  "local release: missing child proof leaves the promotion pending without acceptance",
  async () => {
    const fixture = await makeFixture("noproof");
    try {
      const child = makeChildRunner(fixture, { steps: ["missing_status"] });
      const result = await runLocalSupervisor(
        supervisorOptions(fixture, child.runChild),
      );
      assert.equal(result.status, "pending", JSON.stringify(result));
      assert.equal(await readPointer(fixture.stateRoot), fixture.priorSha);
      const receipt = await readLocalReleaseReceipt(
        fixture.stateRoot,
        fixture.request,
      );
      assert.ok(receipt.ok && receipt.value === null);
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "local release: unrelated newer pointer is preserved and the request is never promoted again",
  async () => {
    const fixture = await makeFixture("unrelated");
    try {
      const child = makeChildRunner(fixture, {
        steps: ["idle", "idle"],
        after: async (input, index) => {
          if (index !== 0) return;
          await Deno.writeTextFile(
            `${input.stateRoot}/active-runtime.json`,
            JSON.stringify({
              version: "v1",
              kind: "local_active_runtime",
              revision: fixture.baseSha,
            }) + "\n",
            { mode: 0o600 },
          );
        },
      });
      const result = await runLocalSupervisor(
        supervisorOptions(fixture, child.runChild),
      );
      assert.equal(result.status, "failed", JSON.stringify(result));
      assert.equal(await readPointer(fixture.stateRoot), fixture.baseSha);

      const receipt = await readLocalReleaseReceipt(
        fixture.stateRoot,
        fixture.request,
      );
      assert.ok(receipt.ok && receipt.value !== null);
      if (!receipt.ok || receipt.value === null) {
        throw new Error("receipt missing");
      }
      assert.equal(receipt.value.phase, "failed");

      // A terminal receipt can never be promoted again: the next invocation
      // runs the unrelated active runtime and stays idle.
      const next = makeChildRunner(fixture, { steps: ["idle"] });
      const second = await runLocalSupervisor(
        supervisorOptions(fixture, next.runChild),
      );
      assert.equal(second.status, "idle", JSON.stringify(second));
      assert.deepEqual(next.revisions, [fixture.baseSha]);
      assert.equal(await readPointer(fixture.stateRoot), fixture.baseSha);
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "local release: candidate startup failure with no new status rolls back to the exact prior",
  async () => {
    const fixture = await makeFixture("startupfail");
    try {
      const child = makeChildRunner(fixture, {
        steps: ["idle", "startup_failure", "idle"],
      });
      const result = await runLocalSupervisor(
        supervisorOptions(fixture, child.runChild),
      );
      assert.equal(result.status, "rolled_back", JSON.stringify(result));
      assert.deepEqual(child.revisions, [
        fixture.priorSha,
        fixture.candidateSha,
        fixture.priorSha,
      ]);
      assert.equal(await readPointer(fixture.stateRoot), fixture.priorSha);

      const receipt = await readLocalReleaseReceipt(
        fixture.stateRoot,
        fixture.request,
      );
      assert.ok(receipt.ok && receipt.value !== null);
      if (!receipt.ok || receipt.value === null) {
        throw new Error("receipt missing");
      }
      assert.equal(receipt.value.phase, "rolled_back");
      assert.equal(
        receipt.value.candidateProof,
        null,
        "a startup failure fabricates no candidate proof",
      );
      assert.equal(receipt.value.priorProof?.controllerSha, fixture.priorSha);
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "local release: malformed or out-of-window run evidence never yields acceptance",
  async () => {
    const cases = [
      "missing_state_evidence",
      "unknown_state",
      "state_unavailable",
      "future_proof",
      "stale_child_start",
    ] as const;
    for (const step of cases) {
      const fixture = await makeFixture(`evidence-${step}`);
      try {
        const child = makeChildRunner(fixture, { steps: [step] });
        const result = await runLocalSupervisor(
          supervisorOptions(fixture, child.runChild),
        );
        assert.equal(
          result.status,
          "pending",
          `${step}: ${JSON.stringify(result)}`,
        );
        assert.equal(
          await readPointer(fixture.stateRoot),
          fixture.priorSha,
          `${step}: the pointer never moved`,
        );
        const receipt = await readLocalReleaseReceipt(
          fixture.stateRoot,
          fixture.request,
        );
        assert.ok(
          receipt.ok && receipt.value === null,
          `${step}: no receipt may record acceptance`,
        );
      } finally {
        await fixture.cleanup();
      }
    }
  },
);

Deno.test(
  "local release: an unreadable session marker is never treated as absent",
  async () => {
    const root = await Deno.makeTempDir({
      prefix: "sentinel-marker-",
      dir: ROOT,
    });
    try {
      assert.equal(
        await localSessionMarkerExists(`${root}/missing`),
        false,
        "a proven absence is false",
      );
      const notADirectory = `${root}/state-root`;
      await Deno.writeTextFile(notADirectory, "not a directory\n");
      assert.equal(
        await localSessionMarkerExists(notADirectory),
        true,
        "a real filesystem error is conservatively present",
      );
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
);
