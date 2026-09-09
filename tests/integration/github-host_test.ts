/**
 * Wave C trusted GitHub host composition seam tests.
 *
 * The host factory (`src/host/github.ts`) composes the existing concrete m01
 * GitHub modules — `createGitHubPort` (`GitHubPortImpl`) and the trusted
 * `DenoGitExecutor` — from explicit caller-supplied capabilities. These tests
 * prove:
 *
 * - composition is side-effect free: no HTTP request, token read, cooldown
 *   check, review-service call or git process starts during construction;
 * - the exact parsed repository identity and every injected capability
 *   (REST HTTP transport, installation auth provider, durable cooldown gate,
 *   clock, review-service transport, trusted resolution-authors allowlist)
 *   reach the concrete port, observed through the recorded requests,
 *   Authorization header, gate installation ids and exact review submission;
 * - the returned `git` identity is the exact concrete executor the port
 *   publishes through: a real `pushHead` against a disposable local bare
 *   remote lands on the same ref identity the returned executor reads;
 * - repository identity, trusted PR author, trusted reviewer, trusted
 *   resolution authors and git-settings faults fail closed with static
 *   TypeError texts before any instance is constructed (a malformed git
 *   settings sentinel would be the first constructor error if ordering were
 *   wrong);
 * - an optional human-resolution verifier is accepted but never touched at
 *   construction.
 *
 * No network, no model call, no credentials, no GitHub writes, no
 * deployment; git is a disposable local bare repository and every transport
 * is synthetic.
 */
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import {
  DenoGitExecutor,
  type DenoGitExecutorOptions,
} from "../../src/github/git-executor.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import {
  composeGitHubHost,
  type GitHubHostOptionsV1,
  type GitHubHostResultV1,
} from "../../src/host/github.ts";
import {
  FakeAuthProvider,
  FakeClock,
  FakeCooldownGate,
  FakeResolutionVerifier,
  FakeReviewService,
  httpRespond,
  issueWire,
  PR_AUTHOR,
  pullWire,
  REPO,
  REVIEWER,
  ScriptedHttpTransport,
  SHA1,
  SHA2,
  T0,
} from "../github/helpers.ts";
import { gitRun, makeRemoteCtx, testGitEnv } from "../state/helpers.ts";

const DB = Deno.cwd();

/** A git-settings malformed sentinel: constructing it would fail first. */
const POISON_GIT = { localDir: "", remoteUrl: "" } as DenoGitExecutorOptions;

function baseOptions(): GitHubHostOptionsV1 {
  return {
    repository: REPO,
    http: (() => {
      throw new Error("parse-time code must never run the transport");
    }) as unknown as HttpTransportV1,
    auth: {
      authorizationHeader: () =>
        Promise.reject(new Error("parse-time code must never ask for a token")),
    },
    cooldownGate: {
      beforeRequest: () =>
        Promise.reject(new Error("parse-time code must never check the gate")),
      recordRateLimit: () =>
        Promise.reject(new Error("parse-time code must never record a limit")),
    },
    clock: { now: () => T0 },
    reviewService: {
      submitReview: () =>
        Promise.reject(
          new Error("parse-time code must never submit a review"),
        ),
      readReview: () =>
        Promise.reject(new Error("parse-time code must never read a review")),
    },
    trustedPrAuthor: PR_AUTHOR,
    trustedReviewer: REVIEWER,
    trustedResolutionAuthors: [],
    git: POISON_GIT,
  };
}

interface CapabilityRigV1 {
  host: GitHubHostResultV1;
  transport: ScriptedHttpTransport;
  auth: FakeAuthProvider;
  gate: FakeCooldownGate;
  clock: FakeClock;
  review: FakeReviewService;
}

function composeCapabilityRig(): CapabilityRigV1 {
  const transport = new ScriptedHttpTransport([
    httpRespond(
      "GET",
      "/repos/ubiquity/sentinel/issues?state=open&per_page=100&page=1",
      200,
      [issueWire({ number: 7 })],
    ),
    httpRespond(
      "GET",
      "/repos/ubiquity/sentinel/pulls/1",
      200,
      pullWire(),
    ),
  ]);
  const auth = new FakeAuthProvider();
  const gate = new FakeCooldownGate();
  const clock = new FakeClock(T0);
  const review = new FakeReviewService();
  review.submitResult = { status: "ambiguous" };
  const host = composeGitHubHost({
    repository: REPO,
    http: transport.fetch.bind(transport) as HttpTransportV1,
    auth,
    cooldownGate: gate,
    clock,
    reviewService: review,
    trustedPrAuthor: PR_AUTHOR,
    trustedReviewer: REVIEWER,
    trustedResolutionAuthors: ["sentinel-approver"],
    git: {
      localDir: "/synthetic/git/work",
      remoteUrl: "/synthetic/git/remote.git",
    },
  });
  return { host, transport, auth, gate, clock, review };
}

Deno.test(
  "composeGitHubHost: composition is side-effect free and every injected capability reaches the exact port",
  async () => {
    const rig = composeCapabilityRig();
    // Construction performed zero I/O: no HTTP request, token read, cooldown
    // check, review-service call or git process.
    assert.equal(rig.transport.requests.length, 0);
    assert.equal(rig.auth.calls, 0);
    assert.deepEqual(rig.gate.beforeRequests, []);
    assert.equal(rig.review.submits.length, 0);
    assert.equal(rig.review.reads.length, 0);

    // The exact parsed repository identity drives the REST path, and the
    // injected auth provider supplies the Authorization header.
    const issues = await rig.host.port.listOpenIssues();
    assert.ok(issues.ok);
    if (!issues.ok) return;
    assert.equal(issues.value.length, 1);
    assert.equal(issues.value[0].number, 7);
    assert.equal(
      rig.transport.requests[0].url,
      "https://api.github.com/repos/ubiquity/sentinel/issues" +
        "?state=open&per_page=100&page=1",
    );
    assert.equal(
      rig.transport.requests[0].headers.get("authorization"),
      "Bearer ghs_synthetic_token_0001",
    );

    // The injected clock drives the ambiguous review outcome and the exact
    // submission reaches the injected review-service transport.
    const reviewed = await rig.host.port.requestReview({
      operationKey: "review:host-1",
      prNumber: 1,
      expectedHead: SHA1,
      expectedBase: SHA2,
      expectedReviewer: REVIEWER,
    });
    assert.ok(reviewed.ok);
    if (!reviewed.ok) return;
    assert.deepEqual(reviewed.value, {
      outcome: "ambiguous",
      requestId: null,
      requestedAt: T0,
    });
    assert.deepEqual(rig.review.submits[0], {
      operationKey: "review:host-1",
      prNumber: 1,
      expectedHead: SHA1,
      expectedBase: SHA2,
      expectedReviewer: REVIEWER,
    });
    // Every authenticated path passed the injected durable cooldown gate with
    // the exact installation identity (the client re-checks the gate before
    // auth and before each request; the review submission gates once).
    assert.deepEqual(rig.gate.beforeRequests, [
      REPO.installationId,
      REPO.installationId, // issues read: pre-auth + pre-request
      REPO.installationId,
      REPO.installationId, // pull read: pre-auth + pre-request
      REPO.installationId, // review submission: one gated remote call
    ]);
  },
);

Deno.test(
  "composeGitHubHost: the returned git identity is the exact executor the port publishes through",
  async () => {
    const tmp = await Deno.makeTempDir({
      prefix: "sentinel-integration-test-github-host-",
      dir: DB,
    });
    try {
      const env = testGitEnv(`${tmp}/git-home`);
      await Deno.mkdir(`${tmp}/git-home`, { recursive: true });
      const remote = await makeRemoteCtx(tmp, env);
      await Deno.writeTextFile(`${remote.work}/candidate.txt`, "candidate");
      const add = await gitRun(remote.work, ["add", "-A"], env);
      assert.ok(add.ok, `add failed: ${add.stderr}`);
      const commit = await gitRun(
        remote.work,
        ["commit", "-q", "-m", "candidate"],
        env,
      );
      assert.ok(commit.ok, `commit failed: ${commit.stderr}`);
      const rev = await gitRun(remote.work, ["rev-parse", "HEAD"], env);
      assert.ok(rev.ok, `rev-parse failed: ${rev.stderr}`);
      const candidate = rev.stdout.trim() as GitSha;

      const transport = new ScriptedHttpTransport([]);
      const host = composeGitHubHost({
        repository: REPO,
        http: transport.fetch.bind(transport) as HttpTransportV1,
        auth: new FakeAuthProvider(),
        cooldownGate: new FakeCooldownGate(),
        clock: new FakeClock(T0),
        reviewService: new FakeReviewService(),
        trustedPrAuthor: PR_AUTHOR,
        trustedReviewer: REVIEWER,
        trustedResolutionAuthors: [],
        git: {
          localDir: remote.work,
          remoteUrl: remote.remoteUrl,
          gitHome: `${tmp}/git-home`,
        },
      });
      assert.ok(host.git instanceof DenoGitExecutor);

      // The port publishes through the exact executor the host holds: after
      // the applied push the returned identity observes the same ref value,
      // and no HTTP request was involved at all.
      const pushed = await host.port.pushHead(
        "refs/heads/sentinel/host-git",
        candidate,
        null,
      );
      assert.ok(pushed.ok);
      if (!pushed.ok) return;
      assert.equal(pushed.value, "applied");
      assert.equal(transport.requests.length, 0);
      const observed = await host.git.readRemoteRef(
        "refs/heads/sentinel/host-git",
      );
      assert.ok(observed.ok);
      if (!observed.ok) return;
      assert.equal(observed.value, candidate);
    } finally {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "composeGitHubHost: invalid repository identity fails closed before any construction",
  () => {
    const cases: RepositoryIdentityV1[] = [
      // Zero is not a valid installation id.
      { owner: "ubiquity", name: "sentinel", installationId: 0 },
      // Exact frozen pattern: an owner cannot contain a slash.
      { owner: "ubiquity!", name: "sentinel", installationId: 42 },
      { owner: "ubiquity", name: "sentinel", installationId: -1 },
    ];
    for (const repository of cases) {
      assert.throws(
        () => composeGitHubHost({ ...baseOptions(), repository }),
        {
          name: "TypeError",
          message: "github host repository identity is invalid",
        },
      );
    }
    // An extra key is not the exact identity either.
    assert.throws(
      () =>
        composeGitHubHost({
          ...baseOptions(),
          repository: {
            owner: "ubiquity",
            name: "sentinel",
            installationId: 42,
            extra: true,
          } as unknown as RepositoryIdentityV1,
        }),
      {
        name: "TypeError",
        message: "github host repository identity is invalid",
      },
    );
  },
);

Deno.test(
  "composeGitHubHost: invalid trusted actor/reviewer inputs fail closed before any construction",
  () => {
    const parent = baseOptions();
    // Trusted PR author: missing, empty and non-string.
    assert.throws(
      () =>
        composeGitHubHost({
          ...parent,
          trustedPrAuthor: undefined as unknown as string,
        }),
      {
        name: "TypeError",
        message: "github host trusted PR author is invalid",
      },
    );
    assert.throws(
      () => composeGitHubHost({ ...parent, trustedPrAuthor: "" }),
      {
        name: "TypeError",
        message: "github host trusted PR author is invalid",
      },
    );
    assert.throws(
      () =>
        composeGitHubHost({
          ...parent,
          trustedPrAuthor: 42 as unknown as string,
        }),
      {
        name: "TypeError",
        message: "github host trusted PR author is invalid",
      },
    );
    // Trusted reviewer: empty and non-string.
    assert.throws(
      () => composeGitHubHost({ ...parent, trustedReviewer: "" }),
      { name: "TypeError", message: "github host trusted reviewer is invalid" },
    );
    assert.throws(
      () =>
        composeGitHubHost({
          ...parent,
          trustedReviewer: 42 as unknown as string,
        }),
      { name: "TypeError", message: "github host trusted reviewer is invalid" },
    );
    // Resolution authors: missing allowlist, empty entry and non-string entry.
    assert.throws(
      () =>
        composeGitHubHost({
          ...parent,
          trustedResolutionAuthors: undefined as unknown as string[],
        }),
      {
        name: "TypeError",
        message: "github host trusted resolution authors are invalid",
      },
    );
    assert.throws(
      () =>
        composeGitHubHost({
          ...parent,
          trustedResolutionAuthors: ["sentinel-approver", ""],
        }),
      {
        name: "TypeError",
        message: "github host trusted resolution authors are invalid",
      },
    );
    assert.throws(
      () =>
        composeGitHubHost({
          ...parent,
          trustedResolutionAuthors: [
            "sentinel-approver",
            42 as unknown as string,
          ],
        }),
      {
        name: "TypeError",
        message: "github host trusted resolution authors are invalid",
      },
    );
    // A login beyond the frozen login bound is rejected too.
    assert.throws(
      () =>
        composeGitHubHost({
          ...parent,
          trustedReviewer: "x".repeat(129),
        }),
      { name: "TypeError", message: "github host trusted reviewer is invalid" },
    );
  },
);

Deno.test(
  "composeGitHubHost: git settings failures stay fail-closed at the frozen executor boundary",
  () => {
    const parent = baseOptions();
    // Missing git settings: static factory rejection before construction.
    assert.throws(
      () =>
        composeGitHubHost({
          ...parent,
          git: undefined as unknown as DenoGitExecutorOptions,
        }),
      { name: "TypeError", message: "github host git settings are invalid" },
    );
    // Malformed option values are rejected by the frozen executor
    // constructor with its own static text; the port is never reached.
    assert.throws(
      () => composeGitHubHost({ ...parent, git: {} as DenoGitExecutorOptions }),
      { name: "TypeError", message: "localDir is required" },
    );
    assert.throws(
      () =>
        composeGitHubHost({
          ...parent,
          git: { localDir: "x", remoteUrl: "" },
        }),
      { name: "TypeError", message: "remoteUrl is required" },
    );
    assert.throws(
      () =>
        composeGitHubHost({
          ...parent,
          git: { localDir: "x", remoteUrl: "y", timeoutMs: 0 },
        }),
      {
        name: "TypeError",
        message: "timeoutMs must be a positive integer",
      },
    );
  },
);

Deno.test(
  "composeGitHubHost: an optional human-resolution verifier is accepted but never touched at construction",
  () => {
    const verifier = new FakeResolutionVerifier();
    const host = composeGitHubHost({
      ...baseOptions(),
      git: {
        localDir: "/synthetic/git/work",
        remoteUrl: "/synthetic/git/remote.git",
      },
      resolutionVerifier: verifier,
    });
    assert.deepEqual(verifier.checks, []);
    // The verifier is accepted alongside the exact compose result shape.
    assert.ok(host.git instanceof DenoGitExecutor);
    assert.equal(typeof host.port.readIssue, "function");
  },
);
