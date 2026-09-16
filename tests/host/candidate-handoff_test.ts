/**
 * M14 V1 regression: the actual unpublished correction handoff.
 *
 * Reproduced production sequence (issue 48 / PR 51): an installed run completed
 * one implementation session and returned candidate H1 while the owned PR
 * branch still carried the rejected H0, and the state base B0 moved to B1
 * during that same model call. The production receipt handler persisted H1 to
 * `target.head`; the next work step requested a candidate-base refresh before
 * H1 was ever published; the real `createPrepareBaseRefresh` correctly required
 * the PR head to be H1, observed H0 and refused. The runner-private mirror was
 * the only demonstrated copy of H1 and it was later lost.
 *
 * This regression drives that exact sequence through the real production
 * consumers in two processes:
 *
 * 1. The parent seeds real repair state (real `RepairGitStateStore`) over a real
 *    bare remote whose `development` ref is B0 and whose owned candidate branch
 *    is H0, with a completed current-head review carrying an unresolved P1.
 *    It runs the real entrypoint (`runRepairEntrypoint`: real receipt handler,
 *    real `RollingStartBudget`, real `DurableGitHubCooldownGate`) over the real
 *    `GitHubPortImpl`/`DenoGitExecutor` composed by `composeGitHubHost`. The
 *    only fake external boundary is the injected `ImplementationPort`, which
 *    commits the distinct real H1 atop H0 in a private producer repository,
 *    imports its objects into the trusted source mirror as an actual model
 *    import would, and moves `development` B0 -> B1 before its valid FakeModel
 *    receipt is consumed. H1 is never pushed to any remote ref. After the
 *    receipt the parent keeps driving bounded one-step production calls until
 *    the bare remote actually retains a content-addressed candidate ref at
 *    exactly H1 (or the real loop stops making progress); the fixture only
 *    observes that ref with `git for-each-ref` and never writes it.
 * 2. After that boundary the parent removes the entire producer workspace and
 *    the trusted source mirror, keeps only the independent remote/state stores
 *    plus a JSON scenario description (identities and counters, never Git
 *    object contents), and starts `candidate-handoff-worker.ts` as a separate
 *    `deno run` process with a fresh empty Git object store, no
 *    alternates/cache/shared clone and no producer files. The child composes
 *    the same real restorer/loop/publication/refresh consumers; its model port
 *    throws on any call. Fixture context travels on stdin JSON only.
 *
 * Asserted behavior: the real production preserver retains H1 under its
 * operation-bound ref during the bounded producer handoff, and the fresh child
 * restores H1 into an empty object store, publishes it to the owned branch,
 * integrates B1, preserves the exact H2 successor and admits the refreshed
 * head to review — with zero new implementation calls and historical
 * reservations unchanged. Every assertion message retains the producer head,
 * the actual old remote head and the saved state so a failing production
 * boundary is identifiable.
 *
 * No network, no credentials, no model call, no GitHub write, no deployment.
 */

import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import type {
  ImplementationPort,
  ModelRunReceiptV1,
  ModelRunRequestV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import { portError } from "../../src/contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  createLocalRepositoryConfig,
  createPrepareBaseRefresh,
  unavailableIncidents,
  unavailableReplay,
} from "../../src/host/local.ts";
import {
  createActionsCandidateRestorer,
  createCandidatePreserver,
} from "../../src/host/actions-candidates.ts";
import { composeGitHubHost } from "../../src/host/github.ts";
import { runRepairEntrypoint } from "../../src/main.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import {
  baseRefreshIntentKey,
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
  workItemIdForIssue,
} from "../../src/repair/keys.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import { FakeAuthProvider, FakeReviewService } from "../github/helpers.ts";
import { FakeClock, FakeModel } from "../repair/helpers.ts";
import {
  gitRun,
  reservation,
  reviewReceipt,
  T0,
  workRecord,
} from "../state/helpers.ts";
import {
  type CandidateHandoffObservationV1,
  type CandidateHandoffScenarioV1,
  createExactCandidateLoader,
  createRemoteRefReader,
  makeRefReadingTransport,
} from "./candidate-handoff-worker.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/host\/candidate-handoff_test\.ts$/,
  "",
);
const WORKER_PATH = `${ROOT}/tests/host/candidate-handoff-worker.ts`;
const TRUSTED_PATH = Deno.env.get("PATH") ?? "/usr/bin:/bin";
const REPOSITORY: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "sentinel",
  installationId: 0,
};
const ISSUE_NUMBER = 48;
const PR_NUMBER = 51;
const BASE_BRANCH = "development";
const TRUSTED_AUTHOR = "sentinel[bot]";
const TRUSTED_REVIEWER = "chatgpt-codex-connector[bot]";
const PRODUCER_BRANCH = "sentinel-producer";
const NOW = T0 + 2000;

function gitEnv(home: string): Record<string, string> {
  return {
    PATH: TRUSTED_PATH,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "sentinel-candidate-handoff-test",
    GIT_AUTHOR_EMAIL: "sentinel-candidate-handoff-test@localhost",
    GIT_COMMITTER_NAME: "sentinel-candidate-handoff-test",
    GIT_COMMITTER_EMAIL: "sentinel-candidate-handoff-test@localhost",
  };
}

function expectOk(result: { ok: boolean }, message: string): void {
  assert.ok(result.ok, message);
}

async function head(
  cwd: string,
  env: Record<string, string>,
): Promise<GitSha> {
  const read = await gitRun(cwd, ["rev-parse", "HEAD"], env);
  assert.ok(read.ok, "fixture rev-parse failed");
  return read.stdout.trim() as GitSha;
}

async function remoteRef(
  gitDir: string,
  env: Record<string, string>,
  ref: string,
): Promise<GitSha | null> {
  const read = await gitRun(gitDir, [
    "--git-dir",
    gitDir,
    "rev-parse",
    "--verify",
    "--quiet",
    ref,
  ], env);
  return read.ok ? read.stdout.trim() as GitSha : null;
}

async function hasObject(
  repo: string,
  env: Record<string, string>,
  sha: GitSha,
): Promise<boolean> {
  return (await gitRun(repo, ["cat-file", "-e", `${sha}^{commit}`], env)).ok;
}

/** Actual retained candidate refs on the bare remote, read without writing. */
async function retainedCandidateRef(
  gitDir: string,
  env: Record<string, string>,
  expected: GitSha,
): Promise<string | null> {
  const read = await gitRun(gitDir, [
    "--git-dir",
    gitDir,
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/heads/sentinel-candidates/",
  ], env);
  if (!read.ok) return null;
  for (const line of read.stdout.split("\n")) {
    const [ref, sha] = line.trim().split(/\s+/);
    if (ref === undefined || sha === undefined) continue;
    if (!/^refs\/heads\/sentinel-candidates\/[0-9a-f]{64}$/.test(ref)) {
      continue;
    }
    if (sha === expected) return ref;
  }
  return null;
}

/** One fake external boundary: produce real H1, import it, move the base. */
class ProducerModel implements ImplementationPort {
  calls = 0;
  constructor(private readonly produce: () => Promise<GitSha>) {}
  async runModel(
    request: ModelRunRequestV1,
  ): Promise<PortResultV1<ModelRunReceiptV1>> {
    this.calls += 1;
    // A second implementation start is never part of this handoff: fail before
    // any further candidate could be produced.
    if (this.calls > 1) {
      throw new Error(
        "ProducerModel: a second implementation call is not permitted",
      );
    }
    const head = await this.produce();
    // The existing valid FakeModel receipt helper is the trust boundary, and
    // the receipt's changed path must match the real H1 Git change.
    return await new FakeModel({ head, changedPaths: ["candidate.txt"] })
      .runModel(request);
  }
}

Deno.test(
  "candidate handoff: the unpublished correction survives producer teardown and lands with the moved base before review",
  async () => {
    const tmp = await Deno.makeTempDir({
      prefix: "sentinel-candidate-handoff-",
      dir: ROOT,
    });
    try {
      const home = `${tmp}/home`;
      await Deno.mkdir(home, { recursive: true });
      const env = gitEnv(home);

      // ---------------------------------------------------------------------
      // Real bare remote: development = B0, owned candidate branch = H0.
      // ---------------------------------------------------------------------
      const remoteGitDir = `${tmp}/remote.git`;
      const remoteWork = `${tmp}/remote-work`;
      expectOk(
        await gitRun(tmp, ["init", "-q", "--bare", remoteGitDir], env),
        "fixture bare remote init failed",
      );
      await Deno.mkdir(remoteWork, { recursive: true });
      expectOk(
        await gitRun(remoteWork, ["init", "-q"], env),
        "fixture work init failed",
      );
      expectOk(
        await gitRun(remoteWork, ["checkout", "-q", "-b", BASE_BRANCH], env),
        "fixture development checkout failed",
      );
      await Deno.writeTextFile(`${remoteWork}/shared.txt`, "shared B0\n");
      expectOk(await gitRun(remoteWork, ["add", "-A"], env), "fixture add");
      expectOk(
        await gitRun(remoteWork, ["commit", "-q", "-m", "base B0"], env),
        "fixture base commit failed",
      );
      const b0 = await head(remoteWork, env);
      expectOk(
        await gitRun(
          remoteWork,
          ["remote", "add", "origin", `file://${remoteGitDir}`],
          env,
        ),
        "fixture remote add failed",
      );
      expectOk(
        await gitRun(remoteWork, ["push", "-q", "origin", BASE_BRANCH], env),
        "fixture base push failed",
      );

      const workId = workItemIdForIssue(REPOSITORY, ISSUE_NUMBER);
      const branch = candidateBranch(workId);
      expectOk(
        await gitRun(remoteWork, ["checkout", "-q", "-b", branch], env),
        "fixture candidate branch failed",
      );
      await Deno.writeTextFile(`${remoteWork}/candidate.txt`, "candidate H0\n");
      expectOk(await gitRun(remoteWork, ["add", "-A"], env), "fixture add");
      expectOk(
        await gitRun(remoteWork, ["commit", "-q", "-m", "candidate H0"], env),
        "fixture candidate commit failed",
      );
      const h0 = await head(remoteWork, env);
      expectOk(
        await gitRun(
          remoteWork,
          ["push", "-q", "origin", `refs/heads/${branch}`],
          env,
        ),
        "fixture candidate push failed",
      );
      expectOk(
        await gitRun(remoteWork, ["checkout", "-q", BASE_BRANCH], env),
        "fixture return to development failed",
      );
      assert.notEqual(h0, b0, "fixture candidate must differ from the base");
      assert.equal(
        await remoteRef(remoteGitDir, env, `refs/heads/${BASE_BRANCH}`),
        b0,
        "fixture remote development must be B0",
      );
      assert.equal(
        await remoteRef(remoteGitDir, env, `refs/heads/${branch}`),
        h0,
        "fixture remote candidate branch must be H0",
      );

      // ---------------------------------------------------------------------
      // Private producer repository (H1 is committed by the model call) and
      // the trusted source mirror that receives the actual model import.
      // ---------------------------------------------------------------------
      const producerDir = `${tmp}/producer`;
      const mirrorDir = `${tmp}/mirror`;
      await Deno.mkdir(producerDir, { recursive: true });
      expectOk(
        await gitRun(producerDir, ["init", "-q"], env),
        "producer init failed",
      );
      expectOk(
        await gitRun(
          producerDir,
          ["remote", "add", "origin", `file://${remoteGitDir}`],
          env,
        ),
        "producer remote add failed",
      );
      expectOk(
        await gitRun(
          producerDir,
          ["fetch", "-q", "origin", `refs/heads/${branch}`],
          env,
        ),
        "producer fetch failed",
      );
      expectOk(
        await gitRun(
          producerDir,
          ["checkout", "-q", "-b", PRODUCER_BRANCH, "FETCH_HEAD"],
          env,
        ),
        "producer checkout failed",
      );
      await Deno.mkdir(mirrorDir, { recursive: true });
      expectOk(
        await gitRun(mirrorDir, ["init", "-q"], env),
        "mirror init failed",
      );
      expectOk(
        await gitRun(
          mirrorDir,
          ["remote", "add", "origin", `file://${remoteGitDir}`],
          env,
        ),
        "mirror remote add failed",
      );
      expectOk(
        await gitRun(mirrorDir, [
          "fetch",
          "-q",
          "origin",
          `refs/heads/${BASE_BRANCH}`,
          `refs/heads/${branch}`,
        ], env),
        "mirror fetch failed",
      );

      // ---------------------------------------------------------------------
      // Real repair state: B0/H0 target, rejected current-head review (P1).
      // ---------------------------------------------------------------------
      expectOk(
        await gitRun(tmp, ["init", "-q", "--bare", `${tmp}/state.git`], env),
        "state bare init failed",
      );
      const state = createRepairStateStore({
        scratchDir: `${tmp}/state-scratch`,
        remoteUrl: `${tmp}/state.git`,
      });
      const seeded = parseRepairStateSnapshotV1({
        version: "v1",
        kind: "repair_state_snapshot",
        stateHead: null,
        sequence: 1,
        updatedAt: T0,
        incidents: [],
        evidence: [],
        work: [
          workRecord(workId, {
            repository: REPOSITORY,
            source: { kind: "issue", id: String(ISSUE_NUMBER), revision: b0 },
            related: { incidentId: null, issueNumber: ISSUE_NUMBER },
            failingRevision: b0,
            classification: { severity: "P3", priority: null },
            controller: { sha: b0 },
            target: {
              base: b0,
              branch,
              checkpoint: null,
              head: h0,
              pr: PR_NUMBER,
            },
            nextStep: "work",
            counters: { attempts: 1, retries: 0, reviewRounds: 1 },
            firstSeenAt: T0,
            createdAt: T0 + 100,
            updatedAt: T0 + 1000,
          }),
        ],
        reservations: [
          reservation("reservation-48-review", {
            repository: REPOSITORY,
            taskId: workId,
            attempt: 1,
            head: h0,
            purpose: "review_request",
            createdAt: T0 - 5000,
            outcome: "submitted",
            settledAt: T0 - 4000,
            proofRef: null,
          }),
        ],
        reviews: [
          reviewReceipt("review-51-h0", {
            requestId: "review-request-51",
            expectedReviewer: TRUSTED_REVIEWER,
            observedReviewer: TRUSTED_REVIEWER,
            repository: REPOSITORY,
            pullRequest: { number: PR_NUMBER, head: h0, base: b0 },
            outcome: "completed",
            resultId: "result-51-h0",
            summary: null,
            findings: [{
              id: "finding-51-1",
              severity: "P1",
              path: "candidate.txt",
              message: "correction required",
              fingerprint: "e".repeat(64),
              resolved: false,
              resolutionEvidence: null,
            }],
            findingsUncounted: 0,
            unresolvedSeverities: ["P1"],
            submittedAt: T0 - 2000,
            completedAt: T0 - 1000,
            observedAt: T0 - 500,
          }),
        ],
        replays: [],
        releaseRequests: [],
        githubCooldowns: [],
      });
      const seededWrite = await state.writeRepair(seeded, null);
      assert.ok(
        seededWrite.ok && seededWrite.value.status === "applied",
        "fixture repair state seed failed",
      );

      // ---------------------------------------------------------------------
      // Fresh empty child object store (no alternates, cache or shared clone).
      // ---------------------------------------------------------------------
      const childRoot = `${tmp}/child`;
      await Deno.mkdir(childRoot, { recursive: true });
      const childSource = `${childRoot}/source`;
      const childScratch = `${childRoot}/scratch`;
      const observationPath = `${childRoot}/observation.json`;
      await Deno.mkdir(childSource, { recursive: true });
      await Deno.mkdir(childScratch, { recursive: true });
      expectOk(
        await gitRun(childSource, ["init", "-q"], env),
        "child object store init failed",
      );
      assert.equal(
        (await gitRun(childSource, ["rev-list", "--all", "--count"], env))
          .stdout.trim(),
        "0",
        "child object store must start empty",
      );

      // ---------------------------------------------------------------------
      // Producer pass through the real entrypoint, stopped at the receipt
      // handler's durable boundary (one model call, real state writes).
      // ---------------------------------------------------------------------
      const clock = new FakeClock(NOW);
      const gate = new DurableGitHubCooldownGate({ state, clock });
      const config = createLocalRepositoryConfig();
      const producerHttp = makeRefReadingTransport({
        repository: REPOSITORY,
        pullRequestNumber: PR_NUMBER,
        issueNumber: ISSUE_NUMBER,
        candidateBranch: branch,
        baseBranch: BASE_BRANCH,
        trustedPrAuthor: TRUSTED_AUTHOR,
        readRef: createRemoteRefReader(remoteGitDir, env),
      });
      const host = composeGitHubHost({
        repository: REPOSITORY,
        http: producerHttp,
        auth: new FakeAuthProvider(),
        cooldownGate: gate,
        clock,
        reviewService: new FakeReviewService(),
        trustedPrAuthor: TRUSTED_AUTHOR,
        trustedReviewer: TRUSTED_REVIEWER,
        trustedResolutionAuthors: [TRUSTED_AUTHOR],
        includeIssueRelations: true,
        git: {
          localDir: mirrorDir,
          remoteUrl: `file://${remoteGitDir}`,
          gitHome: home,
          gitPath: "git",
        },
      });
      const candidates = createActionsCandidateRestorer({
        state,
        gate,
        token: "candidate-handoff-fixture-token",
        http: producerHttp,
        clock,
        sourcePath: mirrorDir,
        scratch: home,
        trustedPath: TRUSTED_PATH,
        gitExecutable: "git",
        remoteUrl: `file://${remoteGitDir}`,
        apiBaseUrl: "https://api.github.com",
      });
      host.port.prepareBaseRefresh = createPrepareBaseRefresh({
        git: host.git,
        observer: host.port,
        baseBranch: BASE_BRANCH,
        trustedPrAuthor: TRUSTED_AUTHOR,
        ensureCandidateObjects: (value) => candidates.ensure(value),
      });
      // The REAL candidate-preservation capability on THAT same port, state,
      // executor, source mirror, cooldown gate and HTTP transport. The exact
      // object loader verifies the requested SHA (never target.head).
      host.port.preserveCandidate = createCandidatePreserver({
        state,
        gate,
        token: "candidate-handoff-fixture-token",
        http: producerHttp,
        clock,
        sourcePath: mirrorDir,
        scratch: home,
        trustedPath: TRUSTED_PATH,
        gitExecutable: "git",
        remoteUrl: `file://${remoteGitDir}`,
        apiBaseUrl: "https://api.github.com",
        port: host.port,
        protectedPaths: config.protectedPaths,
        ensureLocalCandidate: createExactCandidateLoader({
          sourcePath: mirrorDir,
          env,
        }),
      });

      const produced: GitSha[] = [];
      const model = new ProducerModel(async () => {
        // Distinct real H1 atop H0 in the private producer repository.
        await Deno.writeTextFile(
          `${producerDir}/candidate.txt`,
          "candidate H1 correction\n",
        );
        expectOk(
          await gitRun(producerDir, ["add", "-A"], env),
          "producer add failed",
        );
        expectOk(
          await gitRun(
            producerDir,
            ["commit", "-q", "-m", "candidate H1"],
            env,
          ),
          "producer commit failed",
        );
        const h1 = await head(producerDir, env);
        produced.push(h1);
        // Actual model import: the objects become available in the producer's
        // trusted source mirror (and nowhere else).
        expectOk(
          await gitRun(
            mirrorDir,
            ["fetch", "--no-tags", producerDir, PRODUCER_BRANCH],
            env,
          ),
          "mirror import failed",
        );
        assert.equal(
          await hasObject(mirrorDir, env, h1),
          true,
          "H1 objects must exist in the trusted source mirror after import",
        );
        // Development moves B0 -> B1 during this one model call, before the
        // receipt is consumed.
        await Deno.writeTextFile(`${remoteWork}/base-moved.txt`, "moved B1\n");
        expectOk(
          await gitRun(remoteWork, ["add", "-A"], env),
          "base add failed",
        );
        expectOk(
          await gitRun(remoteWork, ["commit", "-q", "-m", "base B1"], env),
          "base commit failed",
        );
        expectOk(
          await gitRun(remoteWork, ["push", "-q", "origin", BASE_BRANCH], env),
          "base push failed",
        );
        return h1;
      });

      const budget = new RollingStartBudget({
        clock,
        state,
        configs: [config],
      });
      const entrypointDeps = {
        clock,
        state,
        configs: [config],
        controllerSha: b0,
        github: host.port,
        githubCooldown: gate,
        incidents: unavailableIncidents,
        replay: unavailableReplay,
        model,
        budget,
      };
      const runOneStep = () =>
        runRepairEntrypoint(entrypointDeps, {
          deadline: clock.now() + 60 * 60_000,
          stepLimit: 1,
        });

      // First actual model-receipt step: produces real H1, imports it into the
      // trusted source mirror and moves the base B0 -> B1 before the receipt
      // handler persists it. The returned status is deliberately not
      // constrained; the receipt is this fixture's setup boundary, not the
      // handoff cut.
      await runOneStep();
      assert.equal(model.calls, 1, "the fixture model must be called once");
      assert.equal(produced.length, 1, "no real candidate was produced");
      const h1 = produced[0];
      const b1 = await head(remoteWork, env);
      assert.notEqual(
        b1,
        b0,
        "the fixture base must move during the model call",
      );

      const afterProducer = await state.readRepair();
      if (!afterProducer.ok || afterProducer.value.status !== "found") {
        throw new Error("producer state read failed");
      }
      // Freeze the original accounting baseline straight from the receipt-time
      // snapshot, before any handoff step can mutate or restate it.
      const reservationsAfterProducer = afterProducer.value.snapshot
        .reservations;
      const producerWork = afterProducer.value.snapshot.work.find((work) =>
        work.id === workId
      );
      if (producerWork === undefined) {
        throw new Error("producer work record missing");
      }
      assert.equal(
        producerWork.target.head,
        h1,
        "the receipt handler must persist H1 to target.head",
      );
      assert.equal(producerWork.target.base, b0, "the base must still be B0");
      assert.equal(producerWork.target.pr, PR_NUMBER);
      assert.equal(producerWork.nextStep, "work");
      assert.equal(
        await remoteRef(remoteGitDir, env, `refs/heads/${BASE_BRANCH}`),
        b1,
        "B1 must be the remote base after the model call",
      );

      // ---------------------------------------------------------------------
      // Semantic handoff cut: continue with at most eight one-step production
      // calls until the bare remote actually retains the candidate at exactly
      // H1 under the content-addressed candidate namespace. The fixture only
      // observes real refs through `git for-each-ref`; it never writes them. A
      // ref that is still absent after the bounded handoff is a real
      // preservation failure reported by the assertions below.
      // ---------------------------------------------------------------------
      const MAX_HANDOFF_STEPS = 8;
      let handoffSteps = 0;
      let handoffStatus = "retained_after_receipt";
      let retainedRef: string | null = await retainedCandidateRef(
        remoteGitDir,
        env,
        h1,
      );
      while (retainedRef === null && handoffSteps < MAX_HANDOFF_STEPS) {
        const outcome = await runOneStep();
        handoffSteps += 1;
        handoffStatus = outcome.status;
        retainedRef = await retainedCandidateRef(remoteGitDir, env, h1);
        if (retainedRef !== null) break;
        // Any non-step_limit stop (idle/margin/state or source error) means the
        // real loop can make no further progress toward retention.
        if (outcome.status !== "step_limit") break;
      }
      assert.equal(
        model.calls,
        1,
        "the bounded handoff must not start a second implementation call",
      );
      assert.equal(produced.length, 1, "no second candidate may be produced");

      // Diagnostics only: whether production retained or published the
      // candidate during the bounded handoff is production behavior, never a
      // fixture invariant.
      const branchAfterHandoff = await remoteRef(
        remoteGitDir,
        env,
        `refs/heads/${branch}`,
      );
      const reservationsState = await state.readRepair();
      if (!reservationsState.ok || reservationsState.value.status !== "found") {
        throw new Error("producer state read after handoff failed");
      }
      assert.deepEqual(
        reservationsState.value.snapshot.reservations,
        reservationsAfterProducer,
        "preservation handoff must not alter historical accounting or " +
          "admit an early review",
      );

      // ---------------------------------------------------------------------
      // Producer teardown: remove the producer workspace and trusted source
      // mirror; keep only the remote, the state store and the JSON scenario.
      // ---------------------------------------------------------------------
      await Deno.remove(producerDir, { recursive: true });
      await Deno.remove(mirrorDir, { recursive: true });
      await Deno.remove(remoteWork, { recursive: true });
      assert.equal(
        await hasObject(childSource, env, h1),
        false,
        "the fresh child store must not contain H1 before the child runs",
      );

      const scenario: CandidateHandoffScenarioV1 = {
        repository: { ...REPOSITORY },
        remoteUrl: `file://${remoteGitDir}`,
        remoteGitDir,
        stateRemoteUrl: `${tmp}/state.git`,
        childSource,
        childScratch,
        observationPath,
        baseBranch: BASE_BRANCH,
        candidateBranch: branch,
        issueNumber: ISSUE_NUMBER,
        pullRequestNumber: PR_NUMBER,
        trustedPrAuthor: TRUSTED_AUTHOR,
        trustedReviewer: TRUSTED_REVIEWER,
        controllerSha: b0,
        producerHead: h1,
        oldRemoteHead: h0,
        oldBase: b0,
        newBase: b1,
        now: clock.now(),
        stepLimit: 8,
      };
      await Deno.writeTextFile(
        `${tmp}/scenario.json`,
        JSON.stringify(scenario, null, 2) + "\n",
      );

      // ---------------------------------------------------------------------
      // Separate process with the fresh object store: same real consumers.
      // ---------------------------------------------------------------------
      const childProcess = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--no-check",
          "--allow-read",
          "--allow-write",
          "--allow-run",
          "--allow-env=HOME,PATH,NODE_V8_COVERAGE",
          WORKER_PATH,
        ],
        cwd: ROOT,
        clearEnv: true,
        env: {
          PATH: TRUSTED_PATH,
          HOME: home,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const stdin = childProcess.stdin.getWriter();
      await stdin.write(new TextEncoder().encode(JSON.stringify(scenario)));
      await stdin.close();
      const childResult = await childProcess.output();
      const stderr = new TextDecoder().decode(childResult.stderr);
      const stdout = new TextDecoder().decode(childResult.stdout);
      const observationText = await Deno.readTextFile(observationPath).catch(
        () => null,
      );
      if (observationText === null) {
        assert.fail(
          `candidate-handoff worker produced no observation ` +
            `(code=${childResult.code}, stderr=${stderr}, stdout=${stdout})`,
        );
      }
      const observations = JSON.parse(
        observationText,
      ) as CandidateHandoffObservationV1;
      if (observations.workerError !== null) {
        assert.fail(
          `candidate-handoff worker failed before observing production: ` +
            `${observations.workerError}; stderr=${stderr}`,
        );
      }

      // ---------------------------------------------------------------------
      // The desired end state. On this base the first assertion fails because
      // the real recovery consumer cannot obtain the durable H1: the runner
      // private mirror was the only copy and it is gone.
      // ---------------------------------------------------------------------
      const savedState = JSON.stringify({
        base: observations.targetBase,
        head: observations.targetHead,
        nextStep: observations.targetNextStep,
        intent: observations.targetIntentKind,
        wait: observations.targetWaitReason,
      });
      const context = `producerHead=${h1} oldRemoteHead=${h0} oldBase=${b0} ` +
        `newBase=${b1} branchAfterHandoff=${branchAfterHandoff} ` +
        `handoffSteps=${handoffSteps}/${MAX_HANDOFF_STEPS} ` +
        `handoffStatus=${handoffStatus} retainedRef=${retainedRef} ` +
        `baseFetchOk=${observations.baseFetchOk} ` +
        `fetchedBase=${observations.fetchedBase} ` +
        `h1AbsentBeforeRestore=${observations.h1AbsentBeforeRestore} ` +
        `boundary=${observations.boundary} ` +
        `restore=${JSON.stringify(observations.restore)} ` +
        `publishedHead=${observations.publishedHead} ` +
        `reviewedParents=${JSON.stringify(observations.reviewedParents)} ` +
        `cycle=${observations.cycleStatus}/${observations.cycleDetail}/` +
        `${observations.cycleError} savedState=${savedState}`;

      assert.equal(
        observations.baseFetchOk,
        true,
        `the fresh child must load the moved base B1 before recovery; ` +
          context,
      );
      assert.equal(
        observations.fetchedBase,
        b1,
        `the fetched base ref must be exactly B1; ${context}`,
      );
      assert.equal(
        observations.h1AbsentBeforeRestore,
        true,
        `H1 must be absent before the real restorer runs; ${context}`,
      );
      assert.equal(
        observations.restore.ok,
        true,
        `H1 must be restorable in the fresh object store; ${context}`,
      );
      assert.equal(
        observations.h1ObjectPresent,
        true,
        `H1 objects must be present in the fresh object store; ${context}`,
      );
      assert.equal(
        observations.modelCalls,
        0,
        `zero new implementation calls are allowed; ${context}`,
      );
      assert.equal(
        observations.staleReviewAttempts,
        0,
        `no review attempt may target an unpublished head; ${context}`,
      );
      assert.notEqual(
        observations.publishedHead,
        h0,
        `H1 must be published to the owned branch; ${context}`,
      );
      assert.equal(
        observations.reviewedHead,
        observations.publishedHead,
        `the reviewed head must be the published head; ${context}`,
      );
      assert.equal(
        observations.reviewedHeadH1Ancestor,
        true,
        `H1 must be an ancestor of the reviewed head; ${context}`,
      );
      assert.equal(
        observations.reviewedHeadB1Ancestor,
        true,
        `B1 must be an ancestor of the reviewed head; ${context}`,
      );
      assert.equal(
        observations.targetBase,
        b1,
        `the durable target base must advance to B1; ${context}`,
      );
      assert.equal(
        observations.targetHead,
        observations.publishedHead,
        `the durable target head must be the published head; ${context}`,
      );
      assert.equal(
        observations.targetNextStep,
        "review",
        `the endpoint is fresh-review admission on the refreshed head; ` +
          context,
      );
      assert.equal(
        observations.reservations.length,
        reservationsAfterProducer.length + 1,
        `exactly one new reservation is permitted; ${context}`,
      );
      for (const parentReservation of reservationsAfterProducer) {
        const unchanged = observations.reservations.find((entry) =>
          entry.id === parentReservation.id
        );
        assert.ok(
          unchanged !== undefined,
          `reservation ${parentReservation.id} must survive; ${context}`,
        );
        assert.deepEqual(
          unchanged,
          parentReservation,
          `reservation ${parentReservation.id} must remain byte-identical; ` +
            context,
        );
      }
      const addedReservations = observations.reservations.filter((entry) =>
        !reservationsAfterProducer.some((parentReservation) =>
          parentReservation.id === entry.id
        )
      );
      assert.equal(
        addedReservations.length,
        1,
        `exactly one additional reservation is permitted; ${context}`,
      );
      assert.equal(
        addedReservations[0].taskId,
        workId,
        `the additional reservation must belong to this task; ${context}`,
      );
      assert.equal(
        addedReservations[0].purpose,
        "review_request",
        `no new implementation reservation is permitted; ${context}`,
      );
      assert.equal(
        addedReservations[0].head,
        observations.reviewedHead,
        `the review reservation must bind the reviewed head; ${context}`,
      );
      assert.equal(
        addedReservations[0].outcome,
        "submitted",
        `the additional reservation must be submitted; ${context}`,
      );

      assert.equal(
        observations.reviewSubmissions.length,
        1,
        `exactly one actual review submission is required; ${context}`,
      );
      const submission = observations.reviewSubmissions[0];
      assert.equal(
        submission.expectedHead,
        observations.publishedHead,
        `the review request must bind the published head; ${context}`,
      );
      assert.equal(
        submission.expectedBase,
        b1,
        `the review request must bind B1; ${context}`,
      );
      assert.equal(
        submission.accepted,
        true,
        `the only review submission must be accepted; ${context}`,
      );
    } finally {
      // A failed removal never replaces the original assertion error.
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  },
);

// ---------------------------------------------------------------------------
// M14 V10: two REAL crash cuts through the same production consumers.
//
// Cut 1: the remote H1 preservation succeeds, but the acknowledgement that
// would attach the descriptor to durable repair state is never applied.
//
// Cut 2: the prepared H2 successor of a base refresh is REALLY preserved
// before the task push, then the child returns one bounded `unavailable`.
// Another process with a NEW empty object store resumes from the saved H2.
// ---------------------------------------------------------------------------

/** Production `CHECK_POLL_MS`, used only as a fixture clock offset. */
const FIXTURE_CHECK_POLL_MS = 5 * 60_000;

/** Static safe detail for the fixture's injected acknowledgement rejection. */
const INJECTED_ACK_UNAVAILABLE_DETAIL =
  "fixture injected preservation acknowledgement rejection";

interface PreservationRefV1 {
  ref: string;
  sha: GitSha;
}

/** Actual operation-bound refs on the bare remote, read without writing. */
async function preservationRefs(
  gitDir: string,
  env: Record<string, string>,
): Promise<PreservationRefV1[]> {
  const read = await gitRun(gitDir, [
    "--git-dir",
    gitDir,
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/heads/sentinel-candidates/",
  ], env);
  if (!read.ok) return [];
  const refs: PreservationRefV1[] = [];
  for (const line of read.stdout.split("\n")) {
    const [ref, sha] = line.trim().split(/\s+/);
    if (ref === undefined || sha === undefined) continue;
    if (!/^refs\/heads\/sentinel-candidates\/[0-9a-f]{64}$/.test(ref)) continue;
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    refs.push({ ref, sha: sha as GitSha });
  }
  return refs.sort((left, right) => left.ref.localeCompare(right.ref));
}

/**
 * Shared parent-side fixture: real bare remote (development B0, candidate H0),
 * private producer repository, trusted source mirror, real repair state seeded
 * with the rejected current-head review and the real production host wiring.
 *
 * `interceptPreservationAcknowledgement` installs the cut-1 fault on the
 * producer's OWN state writer: the exact transition that clears a pending
 * `candidate_preservation` intent while attaching the descriptor is never
 * applied. The caller receives a genuine static `unavailable` error, so the
 * interrupted producer stops at that boundary with the durable intent intact
 * for the fresh-child recovery. All other writes and every read stay on the
 * real store.
 */
async function setupCandidateFaultFixture(
  tmp: string,
  options: { interceptPreservationAcknowledgement?: boolean } = {},
) {
  const home = `${tmp}/home`;
  await Deno.mkdir(home, { recursive: true });
  const env = gitEnv(home);

  const remoteGitDir = `${tmp}/remote.git`;
  const remoteWork = `${tmp}/remote-work`;
  expectOk(
    await gitRun(tmp, ["init", "-q", "--bare", remoteGitDir], env),
    "fixture bare remote init failed",
  );
  await Deno.mkdir(remoteWork, { recursive: true });
  expectOk(
    await gitRun(remoteWork, ["init", "-q"], env),
    "fixture work init failed",
  );
  expectOk(
    await gitRun(remoteWork, ["checkout", "-q", "-b", BASE_BRANCH], env),
    "fixture development checkout failed",
  );
  await Deno.writeTextFile(`${remoteWork}/shared.txt`, "shared B0\n");
  expectOk(await gitRun(remoteWork, ["add", "-A"], env), "fixture add");
  expectOk(
    await gitRun(remoteWork, ["commit", "-q", "-m", "base B0"], env),
    "fixture base commit failed",
  );
  const b0 = await head(remoteWork, env);
  expectOk(
    await gitRun(
      remoteWork,
      ["remote", "add", "origin", `file://${remoteGitDir}`],
      env,
    ),
    "fixture remote add failed",
  );
  expectOk(
    await gitRun(remoteWork, ["push", "-q", "origin", BASE_BRANCH], env),
    "fixture base push failed",
  );

  const workId = workItemIdForIssue(REPOSITORY, ISSUE_NUMBER);
  const branch = candidateBranch(workId);
  expectOk(
    await gitRun(remoteWork, ["checkout", "-q", "-b", branch], env),
    "fixture candidate branch failed",
  );
  await Deno.writeTextFile(`${remoteWork}/candidate.txt`, "candidate H0\n");
  expectOk(await gitRun(remoteWork, ["add", "-A"], env), "fixture add");
  expectOk(
    await gitRun(remoteWork, ["commit", "-q", "-m", "candidate H0"], env),
    "fixture candidate commit failed",
  );
  const h0 = await head(remoteWork, env);
  expectOk(
    await gitRun(
      remoteWork,
      ["push", "-q", "origin", `refs/heads/${branch}`],
      env,
    ),
    "fixture candidate push failed",
  );
  expectOk(
    await gitRun(remoteWork, ["checkout", "-q", BASE_BRANCH], env),
    "fixture return to development failed",
  );
  assert.notEqual(h0, b0, "fixture candidate must differ from the base");
  assert.equal(
    await remoteRef(remoteGitDir, env, `refs/heads/${BASE_BRANCH}`),
    b0,
    "fixture remote development must be B0",
  );
  assert.equal(
    await remoteRef(remoteGitDir, env, `refs/heads/${branch}`),
    h0,
    "fixture remote candidate branch must be H0",
  );

  const producerDir = `${tmp}/producer`;
  const mirrorDir = `${tmp}/mirror`;
  await Deno.mkdir(producerDir, { recursive: true });
  expectOk(
    await gitRun(producerDir, ["init", "-q"], env),
    "producer init failed",
  );
  expectOk(
    await gitRun(
      producerDir,
      ["remote", "add", "origin", `file://${remoteGitDir}`],
      env,
    ),
    "producer remote add failed",
  );
  expectOk(
    await gitRun(
      producerDir,
      ["fetch", "-q", "origin", `refs/heads/${branch}`],
      env,
    ),
    "producer fetch failed",
  );
  expectOk(
    await gitRun(
      producerDir,
      ["checkout", "-q", "-b", PRODUCER_BRANCH, "FETCH_HEAD"],
      env,
    ),
    "producer checkout failed",
  );
  await Deno.mkdir(mirrorDir, { recursive: true });
  expectOk(
    await gitRun(mirrorDir, ["init", "-q"], env),
    "mirror init failed",
  );
  expectOk(
    await gitRun(
      mirrorDir,
      ["remote", "add", "origin", `file://${remoteGitDir}`],
      env,
    ),
    "mirror remote add failed",
  );
  expectOk(
    await gitRun(mirrorDir, [
      "fetch",
      "-q",
      "origin",
      `refs/heads/${BASE_BRANCH}`,
      `refs/heads/${branch}`,
    ], env),
    "mirror fetch failed",
  );

  expectOk(
    await gitRun(tmp, ["init", "-q", "--bare", `${tmp}/state.git`], env),
    "state bare init failed",
  );
  const state = createRepairStateStore({
    scratchDir: `${tmp}/state-scratch`,
    remoteUrl: `${tmp}/state.git`,
  });
  let ackRejections = 0;
  if (options.interceptPreservationAcknowledgement === true) {
    const original = state.writeRepair.bind(state);
    state.writeRepair = async (next, expectedHead) => {
      if (expectedHead !== null) {
        const current = await state.readRepair();
        if (
          current.ok && current.value.status === "found" &&
          current.value.head === expectedHead
        ) {
          const before = current.value.snapshot.work.find((work) =>
            work.id === workId
          );
          const after = next.work.find((work) => work.id === workId);
          const beforeCandidate = before?.target.candidateState;
          const afterCandidate = after?.target.candidateState;
          if (
            before !== undefined && before.intent?.kind ===
              "candidate_preservation" &&
            beforeCandidate !== undefined &&
            beforeCandidate.preserved === null &&
            after !== undefined && after.intent === null &&
            afterCandidate !== undefined && afterCandidate.preserved !== null
          ) {
            // Injected acknowledgement loss: the descriptor transition is
            // NEVER applied and no state write occurs. The caller observes a
            // genuine static `unavailable` boundary instead of a forged
            // `applied`, so the interrupted producer stops here rather than
            // inventing a follow-on transition from a forged head; the durable
            // preservation intent survives for the fresh child.
            ackRejections += 1;
            return portError("unavailable", INJECTED_ACK_UNAVAILABLE_DETAIL);
          }
        }
      }
      return await original(next, expectedHead);
    };
  }

  const seeded = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: [
      workRecord(workId, {
        repository: REPOSITORY,
        source: { kind: "issue", id: String(ISSUE_NUMBER), revision: b0 },
        related: { incidentId: null, issueNumber: ISSUE_NUMBER },
        failingRevision: b0,
        classification: { severity: "P3", priority: null },
        controller: { sha: b0 },
        target: {
          base: b0,
          branch,
          checkpoint: null,
          head: h0,
          pr: PR_NUMBER,
        },
        nextStep: "work",
        counters: { attempts: 1, retries: 0, reviewRounds: 1 },
        firstSeenAt: T0,
        createdAt: T0 + 100,
        updatedAt: T0 + 1000,
      }),
    ],
    reservations: [
      reservation("reservation-48-review", {
        repository: REPOSITORY,
        taskId: workId,
        attempt: 1,
        head: h0,
        purpose: "review_request",
        createdAt: T0 - 5000,
        outcome: "submitted",
        settledAt: T0 - 4000,
        proofRef: null,
      }),
    ],
    reviews: [
      reviewReceipt("review-51-h0", {
        requestId: "review-request-51",
        expectedReviewer: TRUSTED_REVIEWER,
        observedReviewer: TRUSTED_REVIEWER,
        repository: REPOSITORY,
        pullRequest: { number: PR_NUMBER, head: h0, base: b0 },
        outcome: "completed",
        resultId: "result-51-h0",
        summary: null,
        findings: [{
          id: "finding-51-1",
          severity: "P1",
          path: "candidate.txt",
          message: "correction required",
          fingerprint: "e".repeat(64),
          resolved: false,
          resolutionEvidence: null,
        }],
        findingsUncounted: 0,
        unresolvedSeverities: ["P1"],
        submittedAt: T0 - 2000,
        completedAt: T0 - 1000,
        observedAt: T0 - 500,
      }),
    ],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
  });
  const seededWrite = await state.writeRepair(seeded, null);
  assert.ok(
    seededWrite.ok && seededWrite.value.status === "applied",
    "fixture repair state seed failed",
  );

  const clock = new FakeClock(NOW);
  const gate = new DurableGitHubCooldownGate({ state, clock });
  const config = createLocalRepositoryConfig();
  const http = makeRefReadingTransport({
    repository: REPOSITORY,
    pullRequestNumber: PR_NUMBER,
    issueNumber: ISSUE_NUMBER,
    candidateBranch: branch,
    baseBranch: BASE_BRANCH,
    trustedPrAuthor: TRUSTED_AUTHOR,
    readRef: createRemoteRefReader(remoteGitDir, env),
  });
  const host = composeGitHubHost({
    repository: REPOSITORY,
    http,
    auth: new FakeAuthProvider(),
    cooldownGate: gate,
    clock,
    reviewService: new FakeReviewService(),
    trustedPrAuthor: TRUSTED_AUTHOR,
    trustedReviewer: TRUSTED_REVIEWER,
    trustedResolutionAuthors: [TRUSTED_AUTHOR],
    includeIssueRelations: true,
    git: {
      localDir: mirrorDir,
      remoteUrl: `file://${remoteGitDir}`,
      gitHome: home,
      gitPath: "git",
    },
  });
  const candidates = createActionsCandidateRestorer({
    state,
    gate,
    token: "candidate-handoff-fixture-token",
    http,
    clock,
    sourcePath: mirrorDir,
    scratch: home,
    trustedPath: TRUSTED_PATH,
    gitExecutable: "git",
    remoteUrl: `file://${remoteGitDir}`,
    apiBaseUrl: "https://api.github.com",
  });
  host.port.prepareBaseRefresh = createPrepareBaseRefresh({
    git: host.git,
    observer: host.port,
    baseBranch: BASE_BRANCH,
    trustedPrAuthor: TRUSTED_AUTHOR,
    ensureCandidateObjects: (value) => candidates.ensure(value),
  });
  host.port.preserveCandidate = createCandidatePreserver({
    state,
    gate,
    token: "candidate-handoff-fixture-token",
    http,
    clock,
    sourcePath: mirrorDir,
    scratch: home,
    trustedPath: TRUSTED_PATH,
    gitExecutable: "git",
    remoteUrl: `file://${remoteGitDir}`,
    apiBaseUrl: "https://api.github.com",
    port: host.port,
    protectedPaths: config.protectedPaths,
    ensureLocalCandidate: createExactCandidateLoader({
      sourcePath: mirrorDir,
      env,
    }),
  });

  const produced: GitSha[] = [];
  const produceH1 = async (): Promise<GitSha> => {
    await Deno.writeTextFile(
      `${producerDir}/candidate.txt`,
      "candidate H1 correction\n",
    );
    expectOk(
      await gitRun(producerDir, ["add", "-A"], env),
      "producer add failed",
    );
    expectOk(
      await gitRun(producerDir, ["commit", "-q", "-m", "candidate H1"], env),
      "producer commit failed",
    );
    const h1 = await head(producerDir, env);
    produced.push(h1);
    expectOk(
      await gitRun(
        mirrorDir,
        ["fetch", "--no-tags", producerDir, PRODUCER_BRANCH],
        env,
      ),
      "mirror import failed",
    );
    assert.equal(
      await hasObject(mirrorDir, env, h1),
      true,
      "H1 objects must exist in the trusted source mirror after import",
    );
    await Deno.writeTextFile(`${remoteWork}/base-moved.txt`, "moved B1\n");
    expectOk(
      await gitRun(remoteWork, ["add", "-A"], env),
      "base add failed",
    );
    expectOk(
      await gitRun(remoteWork, ["commit", "-q", "-m", "base B1"], env),
      "base commit failed",
    );
    expectOk(
      await gitRun(remoteWork, ["push", "-q", "origin", BASE_BRANCH], env),
      "base push failed",
    );
    return h1;
  };
  const model = new ProducerModel(produceH1);
  const budget = new RollingStartBudget({ clock, state, configs: [config] });
  const entrypointDeps = {
    clock,
    state,
    configs: [config],
    controllerSha: b0,
    github: host.port,
    githubCooldown: gate,
    incidents: unavailableIncidents,
    replay: unavailableReplay,
    model,
    budget,
  };
  const runOneStep = () =>
    runRepairEntrypoint(entrypointDeps, {
      deadline: clock.now() + 60 * 60_000,
      stepLimit: 1,
    });

  return {
    tmp,
    home,
    env,
    remoteGitDir,
    remoteWork,
    producerDir,
    mirrorDir,
    branch,
    workId,
    b0,
    h0,
    state,
    clock,
    gate,
    config,
    host,
    candidates,
    model,
    produced,
    runOneStep,
    ackRejections: () => ackRejections,
  };
}

/** Start the fresh-process worker exactly like the original fixture does. */
async function runHandoffWorker(
  scenario: CandidateHandoffScenarioV1,
): Promise<CandidateHandoffObservationV1> {
  const childProcess = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-check",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env=HOME,PATH,NODE_V8_COVERAGE",
      WORKER_PATH,
    ],
    cwd: ROOT,
    clearEnv: true,
    env: {
      PATH: TRUSTED_PATH,
      HOME: scenario.childScratch,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const stdin = childProcess.stdin.getWriter();
  await stdin.write(new TextEncoder().encode(JSON.stringify(scenario)));
  await stdin.close();
  const childResult = await childProcess.output();
  const stderr = new TextDecoder().decode(childResult.stderr);
  const stdout = new TextDecoder().decode(childResult.stdout);
  const observationText = await Deno.readTextFile(scenario.observationPath)
    .catch(
      () => null,
    );
  if (observationText === null) {
    assert.fail(
      `candidate-handoff worker produced no observation ` +
        `(code=${childResult.code}, stderr=${stderr}, stdout=${stdout})`,
    );
  }
  const observation = JSON.parse(
    observationText,
  ) as CandidateHandoffObservationV1;
  if (observation.workerError !== null) {
    assert.fail(
      `candidate-handoff worker failed before observing production: ` +
        `${observation.workerError}; stderr=${stderr}`,
    );
  }
  return observation;
}

/** The full fresh-child endpoint: H1 published, B1 integrated, reviewed. */
function assertFreshChildCompletion(input: {
  observation: CandidateHandoffObservationV1;
  h1: GitSha;
  h0: GitSha;
  b1: GitSha;
  reservationsBefore: readonly BudgetReservationV1[];
  workId: string;
  context: string;
}): void {
  const { observation, h1, h0, b1, reservationsBefore, workId, context } =
    input;
  assert.equal(
    observation.baseFetchOk,
    true,
    `the fresh child must load the moved base B1 before recovery; ${context}`,
  );
  assert.equal(
    observation.fetchedBase,
    b1,
    `the fetched base ref must be exactly B1; ${context}`,
  );
  assert.equal(
    observation.h1AbsentBeforeRestore,
    true,
    `H1 must be absent before the real restorer runs; ${context}`,
  );
  assert.equal(
    observation.restore.ok,
    true,
    `H1 must be restorable in the fresh object store; ${context}`,
  );
  assert.equal(
    observation.h1ObjectPresent,
    true,
    `H1 objects must be present in the fresh object store; ${context}`,
  );
  assert.equal(
    observation.modelCalls,
    0,
    `zero new implementation calls are allowed; ${context}`,
  );
  assert.equal(
    observation.staleReviewAttempts,
    0,
    `no review attempt may target an unpublished head; ${context}`,
  );
  assert.notEqual(
    observation.publishedHead,
    h0,
    `H1 must be published to the owned branch; ${context}`,
  );
  assert.notEqual(
    observation.publishedHead,
    null,
    `a published head is required; ${context}`,
  );
  assert.equal(
    observation.reviewedHead,
    observation.publishedHead,
    `the reviewed head must be the published head; ${context}`,
  );
  assert.equal(
    observation.reviewedHeadH1Ancestor,
    true,
    `H1 must be an ancestor of the reviewed head (${h1}); ${context}`,
  );
  assert.equal(
    observation.reviewedHeadB1Ancestor,
    true,
    `B1 must be an ancestor of the reviewed head; ${context}`,
  );
  assert.equal(
    observation.targetBase,
    b1,
    `the durable target base must advance to B1; ${context}`,
  );
  assert.equal(
    observation.targetHead,
    observation.publishedHead,
    `the durable target head must be the published head; ${context}`,
  );
  assert.equal(
    observation.targetNextStep,
    "review",
    `the endpoint is fresh-review admission on the refreshed head; ${context}`,
  );
  assert.equal(
    observation.reservations.length,
    reservationsBefore.length + 1,
    `exactly one new reservation is permitted; ${context}`,
  );
  for (const parentReservation of reservationsBefore) {
    const unchanged = observation.reservations.find((entry) =>
      entry.id === parentReservation.id
    );
    assert.ok(
      unchanged !== undefined,
      `reservation ${parentReservation.id} must survive; ${context}`,
    );
    assert.deepEqual(
      unchanged,
      parentReservation,
      `reservation ${parentReservation.id} must remain byte-identical; ` +
        context,
    );
  }
  const addedReservations = observation.reservations.filter((entry) =>
    !reservationsBefore.some((parentReservation) =>
      parentReservation.id === entry.id
    )
  );
  assert.equal(
    addedReservations.length,
    1,
    `exactly one additional reservation is permitted; ${context}`,
  );
  assert.equal(
    addedReservations[0]!.taskId,
    workId,
    `the additional reservation must belong to this task; ${context}`,
  );
  assert.equal(
    addedReservations[0]!.purpose,
    "review_request",
    `no new implementation reservation is permitted; ${context}`,
  );
  assert.equal(
    addedReservations[0]!.head,
    observation.reviewedHead,
    `the review reservation must bind the reviewed head; ${context}`,
  );
  assert.equal(
    addedReservations[0]!.outcome,
    "submitted",
    `the additional reservation must be submitted; ${context}`,
  );
  assert.equal(
    observation.reviewSubmissions.length,
    1,
    `exactly one actual review submission is required; ${context}`,
  );
  const submission = observation.reviewSubmissions[0]!;
  assert.equal(
    submission.expectedHead,
    observation.publishedHead,
    `the review request must bind the published head; ${context}`,
  );
  assert.equal(
    submission.expectedBase,
    b1,
    `the review request must bind B1; ${context}`,
  );
  assert.equal(
    submission.accepted,
    true,
    `the only review submission must be accepted; ${context}`,
  );
}

Deno.test(
  "candidate handoff cut 1: a rejected preservation acknowledgement never publishes H1 and a fresh process restores it from the durable intent",
  async () => {
    const tmp = await Deno.makeTempDir({
      prefix: "sentinel-candidate-ack-loss-",
      dir: ROOT,
    });
    try {
      const fx = await setupCandidateFaultFixture(tmp, {
        interceptPreservationAcknowledgement: true,
      });
      const env = fx.env;

      // One-step receipt cut: real H1 is produced, imported and the base moves
      // B0 -> B1 before the receipt is consumed. The preservation intent is
      // durable and the acknowledgement is still outstanding.
      await fx.runOneStep();
      assert.equal(fx.model.calls, 1, "the fixture model must be called once");
      const h1 = fx.produced[0]!;
      const b1 = await head(fx.remoteWork, env);
      assert.notEqual(b1, fx.b0, "the fixture base must move during the call");
      const afterProducer = await fx.state.readRepair();
      if (!afterProducer.ok || afterProducer.value.status !== "found") {
        throw new Error("producer state read failed");
      }
      const producerWork = afterProducer.value.snapshot.work.find((work) =>
        work.id === fx.workId
      );
      if (producerWork === undefined) {
        throw new Error("producer work record missing");
      }
      const reservationsBefore = afterProducer.value.snapshot.reservations;
      assert.equal(
        producerWork.target.head,
        h1,
        "the receipt handler must persist H1 to target.head",
      );
      assert.equal(
        producerWork.target.base,
        fx.b0,
        "the base must still be B0",
      );
      assert.equal(
        producerWork.target.candidateState?.preserved ?? null,
        null,
        "no descriptor may exist before the acknowledgement is durable",
      );
      assert.equal(
        producerWork.intent?.kind,
        "candidate_preservation",
        "the original preservation intent must stay durable",
      );
      assert.equal(
        producerWork.intent?.expectedHead,
        h1,
        "the durable intent must bind H1",
      );
      assert.equal(
        producerWork.intent?.observedBase,
        fx.b0,
        "the durable intent must bind B0",
      );
      assert.equal(
        await remoteRef(fx.remoteGitDir, env, `refs/heads/${fx.branch}`),
        fx.h0,
        "the candidate branch must still carry H0",
      );

      // Bounded producer handoff: at most eight one-step calls until the real
      // H1 operation ref exists. The injected acknowledgement rejection makes
      // the interrupted step return a genuine state error; only ACTUAL remote
      // ref creations count. Repeated-call idempotency is covered by the
      // existing preserver tests, not by this crash cut.
      const MAX_HANDOFF_STEPS = 8;
      let handoffSteps = 0;
      let handoffStatus = "retained_after_receipt";
      let refs = await preservationRefs(fx.remoteGitDir, env);
      while (refs.length === 0 && handoffSteps < MAX_HANDOFF_STEPS) {
        const outcome = await fx.runOneStep();
        handoffSteps += 1;
        handoffStatus = outcome.status;
        refs = await preservationRefs(fx.remoteGitDir, env);
        if (refs.length > 0) break;
        if (outcome.status !== "step_limit") break;
      }
      refs = await preservationRefs(fx.remoteGitDir, env);
      const handoffContext = `producerHead=${h1} oldRemoteHead=${fx.h0} ` +
        `oldBase=${fx.b0} newBase=${b1} steps=${handoffSteps}/` +
        `${MAX_HANDOFF_STEPS} status=${handoffStatus} ` +
        `preservationRefs=${JSON.stringify(refs)} ` +
        `ackRejections=${fx.ackRejections()}`;
      assert.equal(
        fx.model.calls,
        1,
        `the bounded handoff must not start a second implementation call; ` +
          handoffContext,
      );
      assert.equal(
        refs.length,
        1,
        `exactly one actual preservation ref creation is permitted; ` +
          handoffContext,
      );
      const implementationReservations = reservationsBefore.filter((entry) =>
        entry.taskId === fx.workId &&
        (entry.purpose === "implementation" || entry.purpose === "retry") &&
        entry.outcome === "submitted"
      );
      assert.equal(
        implementationReservations.length,
        1,
        `exactly one submitted implementation reservation is required; ` +
          handoffContext,
      );
      const expectedOperationRef = await candidatePreservationRef(
        REPOSITORY,
        fx.workId,
        implementationIntentKey(implementationReservations[0]!.id),
      );
      assert.equal(
        refs[0]!.ref,
        expectedOperationRef,
        `the retained ref must be the exact operation-bound ref; ` +
          handoffContext,
      );
      assert.equal(
        refs[0]!.sha,
        h1,
        `the actual operation ref must carry H1; ${handoffContext}`,
      );
      assert.ok(
        fx.ackRejections() >= 1,
        `the injected acknowledgement must have been refused; ${handoffContext}`,
      );

      const afterHandoff = await fx.state.readRepair();
      if (!afterHandoff.ok || afterHandoff.value.status !== "found") {
        throw new Error("producer state read after handoff failed");
      }
      const handoffWork = afterHandoff.value.snapshot.work.find((work) =>
        work.id === fx.workId
      );
      assert.equal(
        handoffWork?.target.head,
        h1,
        `the durable original target H1 must survive; ${handoffContext}`,
      );
      assert.equal(
        handoffWork?.target.base,
        fx.b0,
        `the durable original base B0 must survive; ${handoffContext}`,
      );
      assert.equal(
        handoffWork?.intent?.kind,
        "candidate_preservation",
        `the durable original intent must survive; ${handoffContext}`,
      );
      assert.equal(
        handoffWork?.target.candidateState?.preserved ?? null,
        null,
        `the rejected acknowledgement must never be durable; ${handoffContext}`,
      );
      assert.deepEqual(
        afterHandoff.value.snapshot.reservations,
        reservationsBefore,
        `accounting must be unchanged by the rejected acknowledgement; ` +
          handoffContext,
      );
      assert.equal(
        await remoteRef(fx.remoteGitDir, env, `refs/heads/${fx.branch}`),
        fx.h0,
        `H0 must remain published; the rejected acknowledgement must not ` +
          `publish H1; ${handoffContext}`,
      );

      // Producer teardown, exactly as the ordinary fixture.
      await Deno.remove(fx.producerDir, { recursive: true });
      await Deno.remove(fx.mirrorDir, { recursive: true });
      await Deno.remove(fx.remoteWork, { recursive: true });

      const childRoot = `${tmp}/child`;
      const childSource = `${childRoot}/source`;
      const childScratch = `${childRoot}/scratch`;
      const observationPath = `${childRoot}/observation.json`;
      await Deno.mkdir(childSource, { recursive: true });
      await Deno.mkdir(childScratch, { recursive: true });
      expectOk(
        await gitRun(childSource, ["init", "-q"], env),
        "child object store init failed",
      );
      assert.equal(
        (await gitRun(childSource, ["rev-list", "--all", "--count"], env))
          .stdout.trim(),
        "0",
        "child object store must start empty",
      );
      assert.equal(
        await hasObject(childSource, env, h1),
        false,
        "the fresh child store must not contain H1 before the child runs",
      );

      const scenario: CandidateHandoffScenarioV1 = {
        repository: { ...REPOSITORY },
        remoteUrl: `file://${fx.remoteGitDir}`,
        remoteGitDir: fx.remoteGitDir,
        stateRemoteUrl: `${tmp}/state.git`,
        childSource,
        childScratch,
        observationPath,
        baseBranch: BASE_BRANCH,
        candidateBranch: fx.branch,
        issueNumber: ISSUE_NUMBER,
        pullRequestNumber: PR_NUMBER,
        trustedPrAuthor: TRUSTED_AUTHOR,
        trustedReviewer: TRUSTED_REVIEWER,
        controllerSha: fx.b0,
        producerHead: h1,
        oldRemoteHead: fx.h0,
        oldBase: fx.b0,
        newBase: b1,
        now: fx.clock.now(),
        stepLimit: 8,
      };
      const observations = await runHandoffWorker(scenario);
      const savedState = JSON.stringify({
        base: observations.targetBase,
        head: observations.targetHead,
        nextStep: observations.targetNextStep,
        intent: observations.targetIntentKind,
        wait: observations.targetWaitReason,
      });
      const context = `${handoffContext} ` +
        `baseFetchOk=${observations.baseFetchOk} ` +
        `fetchedBase=${observations.fetchedBase} ` +
        `h1AbsentBeforeRestore=${observations.h1AbsentBeforeRestore} ` +
        `boundary=${observations.boundary} ` +
        `restore=${JSON.stringify(observations.restore)} ` +
        `publishedHead=${observations.publishedHead} ` +
        `reviewedParents=${JSON.stringify(observations.reviewedParents)} ` +
        `cycle=${observations.cycleStatus}/${observations.cycleDetail}/` +
        `${observations.cycleError} savedState=${savedState}`;
      assertFreshChildCompletion({
        observation: observations,
        h1,
        h0: fx.h0,
        b1,
        reservationsBefore,
        workId: fx.workId,
        context,
      });
      // The child reconciles the SAME H1 operation ref and then preserves the
      // refreshed successor under its own exact base-refresh-bound ref.
      const refsAfterChild = await preservationRefs(fx.remoteGitDir, env);
      assert.equal(
        refsAfterChild.length,
        2,
        `H1 plus the refreshed successor must be preserved; ${context}`,
      );
      const h1RefAfterChild = refsAfterChild.find((entry) => entry.sha === h1);
      assert.equal(
        h1RefAfterChild?.ref,
        expectedOperationRef,
        `the child must reuse the exact H1 operation ref; ${context}`,
      );
      const expectedSuccessorRef = await candidatePreservationRef(
        REPOSITORY,
        fx.workId,
        baseRefreshIntentKey(PR_NUMBER, h1, b1),
      );
      const successorRef = refsAfterChild.find((entry) =>
        entry.ref === expectedSuccessorRef
      );
      assert.ok(
        successorRef !== undefined,
        `the refreshed successor must be preserved under its exact ref; ` +
          context,
      );
      assert.equal(
        successorRef!.sha,
        observations.publishedHead,
        `the refreshed operation ref must carry the published head; ${context}`,
      );
    } finally {
      // A failed removal never replaces the original assertion error.
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "candidate handoff cut 2: a prepared H2 preserved before the task push is resumed from durable state by another empty-store process",
  async () => {
    const tmp = await Deno.makeTempDir({
      prefix: "sentinel-candidate-refresh-crash-",
      dir: ROOT,
    });
    try {
      const fx = await setupCandidateFaultFixture(tmp);
      const env = fx.env;

      // Receipt cut, then bounded one-step calls until the real remote
      // candidate branch actually carries H1. The producer is stopped BEFORE
      // the base refresh: the next step would prepare and preserve H2.
      await fx.runOneStep();
      assert.equal(fx.model.calls, 1, "the fixture model must be called once");
      const h1 = fx.produced[0]!;
      const b1 = await head(fx.remoteWork, env);
      assert.notEqual(b1, fx.b0, "the fixture base must move during the call");
      const MAX_PUBLISH_STEPS = 8;
      let publishSteps = 0;
      let branchNow = await remoteRef(
        fx.remoteGitDir,
        env,
        `refs/heads/${fx.branch}`,
      );
      while (branchNow !== h1 && publishSteps < MAX_PUBLISH_STEPS) {
        const outcome = await fx.runOneStep();
        publishSteps += 1;
        branchNow = await remoteRef(
          fx.remoteGitDir,
          env,
          `refs/heads/${fx.branch}`,
        );
        if (branchNow === h1) break;
        if (outcome.status !== "step_limit") break;
      }
      assert.equal(
        branchNow,
        h1,
        `the real remote must publish H1 before the base refresh; ` +
          `steps=${publishSteps}`,
      );
      const beforeChild = await fx.state.readRepair();
      if (!beforeChild.ok || beforeChild.value.status !== "found") {
        throw new Error("producer state read failed");
      }
      const beforeChildWork = beforeChild.value.snapshot.work.find((work) =>
        work.id === fx.workId
      );
      if (beforeChildWork === undefined) {
        throw new Error("producer work record missing");
      }
      const reservationsBeforeChild = beforeChild.value.snapshot.reservations;
      assert.equal(beforeChildWork.target.head, h1);
      assert.equal(beforeChildWork.target.base, fx.b0);
      assert.equal(beforeChildWork.target.candidateState?.preserved?.head, h1);
      assert.equal(beforeChildWork.target.candidateState?.publishedHead, h1);
      // The producer may already have persisted the base-refresh intent while
      // publishing H1: `ensureBaseRefreshIntent` records the deterministic
      // intent with a null resultId and only the next step prepares (and
      // assigns) the successor, so a null resultId here is valid. Only the
      // exact H1 intent bindings are required here, and the H2 preservation
      // must still be outstanding.
      if (beforeChildWork.intent !== null) {
        assert.equal(beforeChildWork.intent.kind, "base_refresh");
        assert.equal(beforeChildWork.intent.expectedHead, h1);
        assert.equal(beforeChildWork.intent.observedBase, b1);
      }
      const refsBeforeChild = await preservationRefs(fx.remoteGitDir, env);
      assert.equal(
        refsBeforeChild.length,
        1,
        "only the H1 preservation may exist before the refresh",
      );
      assert.equal(refsBeforeChild[0]!.sha, h1);

      // Producer teardown.
      await Deno.remove(fx.producerDir, { recursive: true });
      await Deno.remove(fx.mirrorDir, { recursive: true });
      await Deno.remove(fx.remoteWork, { recursive: true });

      // Child A: fresh empty store; the REAL preservation of the prepared H2
      // completes, then exactly one unavailable is returned before the push.
      const childARoot = `${tmp}/child-a`;
      const childASource = `${childARoot}/source`;
      const childAScratch = `${childARoot}/scratch`;
      const childAObservation = `${childARoot}/observation.json`;
      await Deno.mkdir(childASource, { recursive: true });
      await Deno.mkdir(childAScratch, { recursive: true });
      expectOk(
        await gitRun(childASource, ["init", "-q"], env),
        "child A object store init failed",
      );
      assert.equal(
        (await gitRun(childASource, ["rev-list", "--all", "--count"], env))
          .stdout.trim(),
        "0",
        "child A object store must start empty",
      );
      const scenarioA: CandidateHandoffScenarioV1 = {
        repository: { ...REPOSITORY },
        remoteUrl: `file://${fx.remoteGitDir}`,
        remoteGitDir: fx.remoteGitDir,
        stateRemoteUrl: `${tmp}/state.git`,
        childSource: childASource,
        childScratch: childAScratch,
        observationPath: childAObservation,
        baseBranch: BASE_BRANCH,
        candidateBranch: fx.branch,
        issueNumber: ISSUE_NUMBER,
        pullRequestNumber: PR_NUMBER,
        trustedPrAuthor: TRUSTED_AUTHOR,
        trustedReviewer: TRUSTED_REVIEWER,
        controllerSha: fx.b0,
        producerHead: h1,
        oldRemoteHead: fx.h0,
        oldBase: fx.b0,
        newBase: b1,
        now: fx.clock.now(),
        stepLimit: 8,
        interruptBaseRefreshPreserve: true,
      };
      const observationA = await runHandoffWorker(scenarioA);
      const contextA = `h1=${h1} h0=${fx.h0} b0=${fx.b0} b1=${b1} ` +
        `boundary=${observationA.boundary} fault=${observationA.fault} ` +
        `faultHead=${observationA.faultHead} ` +
        `faultResultId=${observationA.faultResultId} ` +
        `targetIntentResultId=${observationA.targetIntentResultId} ` +
        `targetHead=${observationA.targetHead} ` +
        `faultTargetHead=${observationA.faultTargetHead} ` +
        `faultDescriptorHead=${observationA.faultDescriptorHead} ` +
        `faultPublishedHead=${observationA.faultPublishedHead} ` +
        `publishedHead=${observationA.publishedHead} ` +
        `preserveCalls=${observationA.faultPreserveCalls} ` +
        `cycle=${observationA.cycleStatus}/${observationA.cycleDetail}/` +
        `${observationA.cycleError}`;
      assert.equal(
        observationA.boundary,
        "base_refresh_preserve_unavailable",
        `the child must stop at the bounded preservation interruption; ` +
          contextA,
      );
      assert.equal(
        observationA.fault,
        "base_refresh_preserve_unavailable",
        `the interruption must be the exact base-refresh preserve cut; ` +
          contextA,
      );
      assert.equal(
        observationA.faultUnavailableReturned,
        true,
        `the real preservation must be followed by one unavailable; ` +
          contextA,
      );
      assert.ok(
        observationA.faultHead !== null,
        `the prepared successor H2 must be observed; ${contextA}`,
      );
      const h2 = observationA.faultHead!;
      assert.notEqual(h2, h1);
      assert.equal(
        observationA.faultResultId,
        h2,
        `the durable base_refresh resultId must be the prepared H2; ` +
          contextA,
      );
      assert.equal(
        observationA.targetIntentResultId,
        h2,
        `the persisted intent must retain resultId H2; ${contextA}`,
      );
      assert.equal(
        observationA.targetIntentKind,
        "base_refresh",
        `the durable intent must be the base refresh; ${contextA}`,
      );
      assert.equal(
        observationA.faultTargetHead,
        h1,
        `the durable target must remain H1; ${contextA}`,
      );
      assert.equal(
        observationA.targetHead,
        h1,
        `the durable target must remain H1 after the interruption; ` +
          contextA,
      );
      assert.equal(
        observationA.faultDescriptorHead,
        h1,
        `the retained descriptor must remain H1; ${contextA}`,
      );
      assert.equal(
        observationA.faultPublishedHead,
        h1,
        `the durable published head must remain H1; ${contextA}`,
      );
      assert.equal(
        observationA.modelCalls,
        0,
        `no implementation call is permitted; ${contextA}`,
      );
      assert.equal(
        observationA.reviewSubmissions.length,
        0,
        `no review may be charged before the task push; ${contextA}`,
      );
      assert.equal(
        await remoteRef(fx.remoteGitDir, env, `refs/heads/${fx.branch}`),
        h1,
        `the task ref must remain H1; ${contextA}`,
      );
      const refsAfterA = await preservationRefs(fx.remoteGitDir, env);
      assert.equal(
        refsAfterA.length,
        2,
        `H1 and the really preserved H2 operation refs are required; ` +
          contextA,
      );
      const h1Ref = refsAfterA.find((entry) => entry.sha === h1);
      const h2Ref = refsAfterA.find((entry) => entry.sha === h2);
      assert.ok(
        h1Ref !== undefined,
        `the H1 operation ref must remain; ${contextA}`,
      );
      assert.ok(
        h2Ref !== undefined,
        `the H2 operation ref must remain; ${contextA}`,
      );
      const expectedH2Ref = await candidatePreservationRef(
        REPOSITORY,
        fx.workId,
        baseRefreshIntentKey(PR_NUMBER, h1, b1),
      );
      assert.equal(
        h2Ref!.ref,
        expectedH2Ref,
        `the retained H2 ref must be the exact base-refresh-bound ref; ` +
          contextA,
      );
      const afterChildA = await fx.state.readRepair();
      if (!afterChildA.ok || afterChildA.value.status !== "found") {
        throw new Error("state read after child A failed");
      }
      assert.deepEqual(
        afterChildA.value.snapshot.reservations,
        reservationsBeforeChild,
        `no new review charge may exist at the interruption; ${contextA}`,
      );

      // Child A's process store is deleted; another NEW empty object store
      // resumes strictly after the production poll bound.
      await Deno.remove(childASource, { recursive: true });
      await Deno.remove(childAScratch, { recursive: true });
      await Deno.remove(childARoot, { recursive: true });

      const childBRoot = `${tmp}/child-b`;
      const childBSource = `${childBRoot}/source`;
      const childBScratch = `${childBRoot}/scratch`;
      const childBObservation = `${childBRoot}/observation.json`;
      await Deno.mkdir(childBSource, { recursive: true });
      await Deno.mkdir(childBScratch, { recursive: true });
      expectOk(
        await gitRun(childBSource, ["init", "-q"], env),
        "child B object store init failed",
      );
      assert.equal(
        (await gitRun(childBSource, ["rev-list", "--all", "--count"], env))
          .stdout.trim(),
        "0",
        "child B object store must start empty",
      );
      assert.equal(
        await hasObject(childBSource, env, h2),
        false,
        "the resuming store must not contain H2 before it runs",
      );
      const scenarioB: CandidateHandoffScenarioV1 = {
        ...scenarioA,
        childSource: childBSource,
        childScratch: childBScratch,
        observationPath: childBObservation,
        now: scenarioA.now + FIXTURE_CHECK_POLL_MS + 1,
        interruptBaseRefreshPreserve: undefined,
      };
      const observationB = await runHandoffWorker(scenarioB);
      const savedStateB = JSON.stringify({
        base: observationB.targetBase,
        head: observationB.targetHead,
        nextStep: observationB.targetNextStep,
        intent: observationB.targetIntentKind,
        wait: observationB.targetWaitReason,
      });
      const contextB = `${contextA} | resumedNow=${scenarioB.now} ` +
        `boundary=${observationB.boundary} ` +
        `restore=${JSON.stringify(observationB.restore)} ` +
        `fetchedBase=${observationB.fetchedBase} ` +
        `publishedHead=${observationB.publishedHead} ` +
        `reviewedHead=${observationB.reviewedHead} ` +
        `reviewedParents=${JSON.stringify(observationB.reviewedParents)} ` +
        `cycle=${observationB.cycleStatus}/${observationB.cycleDetail}/` +
        `${observationB.cycleError} savedState=${savedStateB}`;
      assertFreshChildCompletion({
        observation: observationB,
        h1,
        h0: fx.h0,
        b1,
        reservationsBefore: reservationsBeforeChild,
        workId: fx.workId,
        context: contextB,
      });
      assert.equal(
        observationB.publishedHead,
        h2,
        `the resumed process must publish the exact saved H2; ${contextB}`,
      );
      assert.equal(
        observationB.reviewedHead,
        h2,
        `the resumed process must review the exact saved H2; ${contextB}`,
      );
      assert.equal(
        observationB.modelCalls,
        0,
        `the resumed process must not start a model; ${contextB}`,
      );
      const refsAfterB = await preservationRefs(fx.remoteGitDir, env);
      assert.equal(
        refsAfterB.length,
        2,
        `both H1/H2 operation refs must remain after recovery; ${contextB}`,
      );
      assert.equal(
        refsAfterB.find((entry) => entry.sha === h1)?.ref,
        expectedOperationRefOf(refsAfterA, h1),
        `the H1 operation ref identity must not change; ${contextB}`,
      );
      assert.equal(
        refsAfterB.find((entry) => entry.sha === h2)?.ref,
        expectedH2Ref,
        `the H2 operation ref identity must not change; ${contextB}`,
      );
      assert.equal(
        await remoteRef(fx.remoteGitDir, env, `refs/heads/${fx.branch}`),
        h2,
        `the task ref must advance to the exact saved H2; ${contextB}`,
      );
      const afterChildB = await fx.state.readRepair();
      if (!afterChildB.ok || afterChildB.value.status !== "found") {
        throw new Error("state read after child B failed");
      }
      assert.deepEqual(
        afterChildB.value.snapshot.reservations,
        observationB.reservations,
        `the durable accounting must equal the observed accounting; ` +
          contextB,
      );
    } finally {
      // A failed removal never replaces the original assertion error.
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  },
);

function expectedOperationRefOf(
  refs: readonly PreservationRefV1[],
  sha: GitSha,
): string | undefined {
  return refs.find((entry) => entry.sha === sha)?.ref;
}
