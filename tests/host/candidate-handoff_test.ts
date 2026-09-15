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
 * Desired behavior asserted here: H1 is restored into the fresh object store,
 * published to the owned branch and incorporated with B1 before review, with
 * zero new implementation calls and historical reservations unchanged. On this
 * base the child's real recovery consumer cannot obtain H1 and the assertion
 * fails at real recovery/publication, not at test setup. Every assertion
 * message retains the producer head, the actual old remote head and the saved
 * state so the failing production boundary is identifiable.
 *
 * No network, no credentials, no model call, no GitHub write, no deployment.
 */

import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  ImplementationPort,
  ModelRunReceiptV1,
  ModelRunRequestV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  createLocalRepositoryConfig,
  createPrepareBaseRefresh,
  unavailableIncidents,
  unavailableReplay,
} from "../../src/host/local.ts";
import { createActionsCandidateRestorer } from "../../src/host/actions-candidates.ts";
import { composeGitHubHost } from "../../src/host/github.ts";
import { runRepairEntrypoint } from "../../src/main.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { candidateBranch, workItemIdForIssue } from "../../src/repair/keys.ts";
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
      // observes real refs through `git for-each-ref`; it never writes them. An
      // absent ref is the expected pre-fix observation and must not become a
      // setup failure.
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
          "--allow-run=git",
          "--allow-env=HOME,PATH",
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
