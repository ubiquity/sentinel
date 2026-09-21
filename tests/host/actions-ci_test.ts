/**
 * Deterministic self-target CI approval boundaries and multi-target host
 * cycles.
 *
 * These tests drive the REAL `runActionsCiApproval` helper and the REAL
 * `GitHubApiClient` over a scripted in-memory HTTP transport with small
 * cooldown-gate and repair-state fixtures. No network, no model, no real
 * token: approval is only ever submitted for the exact run and PR identity,
 * and any mismatch, ambiguity, truncation or cooldown denial submits nothing.
 *
 * The multi-target section drives the REAL `runActionsTargetCycles` host loop
 * and the REAL `runRepairEntrypoint` over REAL per-repository
 * `composeLocalGitHub` ports with a scripted transport: every committed target
 * is read through its own port under its own installation scope, on one shared
 * budget, model port and absolute deadline.
 */
import assert from "node:assert/strict";

import { RollingStartBudget } from "../../src/budget/mod.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type {
  GitHubCooldownGateV1,
  GitHubPort,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import type { GitHubRateLimitV1 } from "../../src/contracts/github-cooldown.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type {
  HttpRequestV1,
  HttpResponseV1,
  HttpTransportV1,
} from "../../src/github/http.ts";
import {
  parseAppInstallationId,
  runActionsTargetCycles,
  scopeTargetConfigV1,
  targetsDiagnosticV1,
} from "../../src/host/actions.ts";
import type { ActionsTargetCyclesResultV1 } from "../../src/host/actions.ts";
import { runActionsCiApproval } from "../../src/host/actions-ci.ts";
import {
  composeLocalGitHub,
  createLocalRepositoryConfig,
  LocalSessionTracker,
  unavailableIncidents,
  unavailableReplay,
} from "../../src/host/local.ts";
import { createTargetConfigV1 } from "../../src/host/targets.ts";
import { runRepairEntrypoint } from "../../src/main.ts";
import { FakeClock, FakeModel, MemoryState } from "../repair/helpers.ts";
import {
  gitRun,
  makeRemoteCtx,
  SHA1,
  SHA2,
  SHA3,
  T0,
  testGitEnv,
  workRecord,
} from "../state/helpers.ts";

const SELF_REPO = {
  owner: "ubiquity",
  name: "sentinel",
  installationId: 0,
} as const;
const HEAD = SHA3;
const HEAD_REF = "sentinel/repair/issue-1";
const PR_NUMBER = 30;
const RUN_ID = 34_722_408_066;
const PUBLISHER = "github-actions[bot]";
/** Login of the surviving `ubiquity-sentinel` App's bot identity. */
const APP_PUBLISHER = "ubiquity-sentinel[bot]";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const API_BASE = "https://api.github.com";
/** Real raw PR repository id and minimal API URL for ubiquity/sentinel. */
const REPO_ID = 1_362_069_392;
const REPO_API_URL = "https://api.github.com/repos/ubiquity/sentinel";
const PULL_PATH = `/repos/ubiquity/sentinel/pulls/${PR_NUMBER}`;
const LIST_PATH = "/repos/ubiquity/sentinel/actions/workflows/ci.yml/runs";
const RUN_PATH = `/repos/ubiquity/sentinel/actions/runs/${RUN_ID}`;
const APPROVE_PATH = `${RUN_PATH}/approve`;

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponseV1 {
  return {
    status,
    headers: new Headers(headers),
    bodyText: typeof body === "string" ? body : JSON.stringify(body),
  };
}

type Handler = (
  request: HttpRequestV1,
) => HttpResponseV1 | Promise<HttpResponseV1>;

/** One scripted transport: exact method+path routes, recorded call order. */
class ScriptedHttp {
  readonly calls: HttpRequestV1[] = [];
  private readonly routes = new Map<string, Handler>();
  on(method: string, path: string, handler: Handler): void {
    this.routes.set(`${method} ${path}`, handler);
  }
  readonly transport: HttpTransportV1 = (request) => {
    this.calls.push(request);
    const pathname = new URL(request.url).pathname;
    const handler = this.routes.get(`${request.method} ${pathname}`);
    if (handler === undefined) {
      return Promise.reject(new Error("unscripted request"));
    }
    return Promise.resolve(handler(request));
  };
  posts(): HttpRequestV1[] {
    return this.calls.filter((call) => call.method === "POST");
  }
}

class FakeGate implements GitHubCooldownGateV1 {
  readonly admissions: number[] = [];
  readonly recorded: GitHubRateLimitV1[] = [];
  deny = false;
  beforeRequest(installationId: number): Promise<PortResultV1<void>> {
    this.admissions.push(installationId);
    if (this.deny) {
      return Promise.resolve(
        portError("rate_limited", "installation is cooling down"),
      );
    }
    return Promise.resolve(portOk(undefined));
  }
  recordRateLimit(
    _installationId: number,
    rateLimit: GitHubRateLimitV1,
  ): Promise<PortResultV1<void>> {
    this.recorded.push(rateLimit);
    return Promise.resolve(portOk(undefined));
  }
}

/** Actual raw PR shape: head/base.repo are full repository objects. */
function pullBody(
  overrides: {
    number?: number;
    state?: string;
    author?: string;
    headSha?: string;
    headRef?: string;
    headRepo?: string;
    headRepoId?: number;
    baseRepoId?: number;
    baseRef?: string;
  } = {},
): unknown {
  return {
    number: overrides.number ?? PR_NUMBER,
    state: overrides.state ?? "open",
    user: { login: overrides.author ?? PUBLISHER },
    head: {
      sha: overrides.headSha ?? HEAD,
      ref: overrides.headRef ?? HEAD_REF,
      repo: {
        id: overrides.headRepoId ?? REPO_ID,
        name: "sentinel",
        full_name: overrides.headRepo ?? "ubiquity/sentinel",
        url: REPO_API_URL,
      },
    },
    base: {
      ref: overrides.baseRef ?? "development",
      repo: {
        id: overrides.baseRepoId ?? REPO_ID,
        name: "sentinel",
        full_name: "ubiquity/sentinel",
        url: REPO_API_URL,
      },
    },
  };
}

/**
 * Actual workflow-run shape: `pull_requests[].head/base.repo` are the minimal
 * `{ id, name, url }` API objects, while `head_repository` is a full object.
 */
function runBody(
  overrides: {
    id?: number;
    attempt?: number;
    actor?: string;
    triggeringActor?: string;
    path?: string;
    headSha?: string;
    headRepo?: string;
    status?: string;
    conclusion?: string | null;
    prNumber?: number;
    assocRepoId?: number;
    assocRepoName?: string;
    assocRepoUrl?: string;
  } = {},
): Record<string, unknown> {
  const conclusion = overrides.conclusion === undefined
    ? "action_required"
    : overrides.conclusion;
  const associationRepo = () => ({
    id: overrides.assocRepoId ?? REPO_ID,
    name: overrides.assocRepoName ?? "sentinel",
    url: overrides.assocRepoUrl ?? REPO_API_URL,
  });
  return {
    id: overrides.id ?? RUN_ID,
    run_attempt: overrides.attempt ?? 1,
    event: "pull_request",
    path: overrides.path ?? WORKFLOW_PATH,
    head_sha: overrides.headSha ?? HEAD,
    head_branch: HEAD_REF,
    head_repository: { full_name: overrides.headRepo ?? "ubiquity/sentinel" },
    actor: { login: overrides.actor ?? PUBLISHER },
    triggering_actor: { login: overrides.triggeringActor ?? PUBLISHER },
    status: overrides.status ?? "completed",
    conclusion,
    pull_requests: [{
      number: overrides.prNumber ?? PR_NUMBER,
      head: {
        sha: HEAD,
        ref: HEAD_REF,
        repo: associationRepo(),
      },
      base: {
        ref: "development",
        repo: associationRepo(),
      },
    }],
  };
}

function runsBody(runs: unknown[], total = runs.length): unknown {
  return { total_count: total, workflow_runs: runs };
}

/** M15 V1 self-candidate preservation identity for the CI fixtures. */
const CANDIDATE_REF = `refs/heads/sentinel-candidates/${"ab".repeat(32)}`;
const PRODUCING_RESERVATION = "cd".repeat(32);

function candidateRecord(
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return workRecord("issue-1", {
    repository: { ...SELF_REPO },
    source: { kind: "issue", id: "1", revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    target: {
      base: SHA1,
      branch: HEAD_REF,
      checkpoint: null,
      head: HEAD,
      pr: PR_NUMBER,
      // Valid Stage2 candidate state: the preserved descriptor and the
      // published head both bind to the exact target base/head, so the
      // ordinary CI tests exercise the real candidate eligibility path.
      candidateState: {
        preserved: {
          operationKey: `impl:${PRODUCING_RESERVATION}`,
          base: SHA1,
          head: HEAD,
          ref: CANDIDATE_REF,
        },
        publishedHead: HEAD,
      },
    },
    nextStep: "review",
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    ...overrides,
  });
}

function snapshot(work: WorkRecordV1[]): RepairStateSnapshotV1 {
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

function makeRig(work: WorkRecordV1[] = [candidateRecord()]) {
  const state = new MemoryState();
  state.repair = snapshot(work);
  const gate = new FakeGate();
  const http = new ScriptedHttp();
  http.on("GET", PULL_PATH, () => response(200, pullBody()));
  http.on("GET", LIST_PATH, () => response(200, runsBody([runBody()])));
  http.on("GET", RUN_PATH, () => response(200, runBody()));
  http.on("POST", APPROVE_PATH, () => response(201, {}));
  return {
    state,
    gate,
    http,
    run: () =>
      runActionsCiApproval({
        state,
        gate,
        http: http.transport,
        token: "dummy-token",
        clock: new FakeClock(T0),
        apiBaseUrl: API_BASE,
      }),
  };
}

Deno.test(
  "ci approval: approves the single exact own action_required run",
  async () => {
    const rig = makeRig();
    const summary = await rig.run();
    assert.deepEqual(summary, { approved: 1, pending: 0, unavailable: 0 });
    assert.equal(rig.http.posts().length, 1);
    assert.equal(new URL(rig.http.posts()[0]!.url).pathname, APPROVE_PATH);
    // Read-only identity reads precede the single POST: PR, bounded list,
    // exact run, exact PR again, then the approval.
    assert.deepEqual(
      rig.http.calls.map((call) =>
        `${call.method} ${new URL(call.url).pathname}`
      ),
      [
        `GET ${PULL_PATH}`,
        `GET ${LIST_PATH}`,
        `GET ${RUN_PATH}`,
        `GET ${PULL_PATH}`,
        `POST ${APPROVE_PATH}`,
      ],
    );
  },
);

Deno.test(
  "ci approval: a pull request and run published by the sentinel App are approved during the transition",
  async () => {
    for (const login of [PUBLISHER, APP_PUBLISHER]) {
      const rig = makeRig();
      rig.http.on(
        "GET",
        PULL_PATH,
        () => response(200, pullBody({ author: login })),
      );
      rig.http.on(
        "GET",
        LIST_PATH,
        () =>
          response(
            200,
            runsBody([runBody({ actor: login, triggeringActor: login })]),
          ),
      );
      rig.http.on(
        "GET",
        RUN_PATH,
        () => response(200, runBody({ actor: login, triggeringActor: login })),
      );
      const summary = await rig.run();
      assert.deepEqual(
        summary,
        { approved: 1, pending: 0, unavailable: 0 },
        login,
      );
      assert.equal(rig.http.posts().length, 1, login);
      assert.equal(
        new URL(rig.http.posts()[0]!.url).pathname,
        APPROVE_PATH,
        login,
      );
    }
  },
);

Deno.test(
  "ci approval: wrong head, actor, repo, workflow, PR association or moved PR never submits",
  async () => {
    const cases: Array<{ name: string; script: (rig: RigV1) => void }> = [
      {
        name: "wrong run head",
        script: (rig) =>
          rig.http.on(
            "GET",
            LIST_PATH,
            () => response(200, runsBody([runBody({ headSha: SHA1 })])),
          ),
      },
      {
        name: "wrong actor",
        script: (rig) =>
          rig.http.on(
            "GET",
            LIST_PATH,
            () => response(200, runsBody([runBody({ actor: "octocat" })])),
          ),
      },
      {
        name: "foreign repository",
        script: (rig) =>
          rig.http.on(
            "GET",
            LIST_PATH,
            () =>
              response(
                200,
                runsBody([runBody({ headRepo: "attacker/sentinel" })]),
              ),
          ),
      },
      {
        name: "wrong workflow",
        script: (rig) =>
          rig.http.on(
            "GET",
            LIST_PATH,
            () =>
              response(
                200,
                runsBody([runBody({ path: ".github/workflows/other.yml" })]),
              ),
          ),
      },
      {
        name: "wrong PR association",
        script: (rig) =>
          rig.http.on(
            "GET",
            LIST_PATH,
            () => response(200, runsBody([runBody({ prNumber: 31 })])),
          ),
      },
      {
        name: "association repository id",
        script: (rig) =>
          rig.http.on(
            "GET",
            LIST_PATH,
            () =>
              response(
                200,
                runsBody([runBody({ assocRepoId: REPO_ID + 1 })]),
              ),
          ),
      },
      {
        name: "association repository name",
        script: (rig) =>
          rig.http.on(
            "GET",
            LIST_PATH,
            () =>
              response(
                200,
                runsBody([runBody({ assocRepoName: "other" })]),
              ),
          ),
      },
      {
        name: "association repository url",
        script: (rig) =>
          rig.http.on(
            "GET",
            LIST_PATH,
            () =>
              response(
                200,
                runsBody([
                  runBody({
                    assocRepoUrl:
                      "https://api.github.com/repos/attacker/sentinel",
                  }),
                ]),
              ),
          ),
      },
      {
        name: "raw PR repository id disagreement",
        script: (rig) =>
          rig.http.on(
            "GET",
            PULL_PATH,
            () => response(200, pullBody({ headRepoId: REPO_ID + 1 })),
          ),
      },
      {
        name: "closed PR",
        script: (rig) =>
          rig.http.on(
            "GET",
            PULL_PATH,
            () => response(200, pullBody({ state: "closed" })),
          ),
      },
      {
        name: "moved current PR",
        script: (rig) => {
          let reads = 0;
          rig.http.on("GET", PULL_PATH, () => {
            reads++;
            return response(
              200,
              reads === 1 ? pullBody() : pullBody({ headSha: SHA1 }),
            );
          });
        },
      },
    ];
    for (const testCase of cases) {
      const rig = makeRig();
      testCase.script(rig);
      const summary = await rig.run();
      assert.deepEqual(
        summary,
        { approved: 0, pending: 0, unavailable: 1 },
        testCase.name,
      );
      assert.equal(
        rig.http.posts().length,
        0,
        `${testCase.name}: no approval POST`,
      );
    }
  },
);

Deno.test(
  "ci approval: a later invocation observing a queued run never submits again",
  async () => {
    const rig = makeRig();
    const first = await rig.run();
    assert.deepEqual(first, { approved: 1, pending: 0, unavailable: 0 });
    // The same candidate still lists the run, but GitHub now reports it queued
    // (no longer awaiting approval): observation only, never a second POST.
    rig.http.on(
      "GET",
      LIST_PATH,
      () =>
        response(
          200,
          runsBody([runBody({ status: "queued", conclusion: null })]),
        ),
    );
    const second = await rig.run();
    assert.deepEqual(second, { approved: 0, pending: 1, unavailable: 0 });
    assert.equal(rig.http.posts().length, 1, "no second approval POST");
  },
);

Deno.test(
  "ci approval: a lost approval response reconciles without a duplicate POST",
  async () => {
    const reconciled = makeRig();
    reconciled.http.on(
      "POST",
      APPROVE_PATH,
      () => Promise.reject(new Error("connection reset")),
    );
    let runReads = 0;
    reconciled.http.on("GET", RUN_PATH, () => {
      runReads++;
      return response(
        200,
        runReads === 1
          ? runBody()
          : runBody({ status: "queued", conclusion: null }),
      );
    });
    assert.deepEqual(
      await reconciled.run(),
      { approved: 1, pending: 0, unavailable: 0 },
    );
    assert.equal(reconciled.http.posts().length, 1, "exactly one POST");
    assert.equal(runReads, 2, "the same run was re-read to reconcile");

    const unresolved = makeRig();
    unresolved.http.on(
      "POST",
      APPROVE_PATH,
      () => Promise.reject(new Error("connection reset")),
    );
    assert.deepEqual(
      await unresolved.run(),
      { approved: 0, pending: 0, unavailable: 1 },
    );
    assert.equal(
      unresolved.http.posts().length,
      1,
      "no duplicate POST after a lost response",
    );
  },
);

Deno.test(
  "ci approval: cooldown denial sends no HTTP and an observed 429 is recorded",
  async () => {
    const denied = makeRig();
    denied.gate.deny = true;
    assert.deepEqual(
      await denied.run(),
      { approved: 0, pending: 0, unavailable: 1 },
    );
    assert.equal(denied.http.calls.length, 0, "no HTTP while cooling down");
    assert.deepEqual(denied.gate.admissions, [0]);

    const limited = makeRig();
    limited.http.on(
      "GET",
      PULL_PATH,
      () => response(429, "", { "retry-after": "3600" }),
    );
    assert.deepEqual(
      await limited.run(),
      { approved: 0, pending: 0, unavailable: 1 },
    );
    assert.equal(limited.gate.recorded.length, 1, "the 429 is recorded");
    assert.equal(limited.http.posts().length, 0);
  },
);

Deno.test(
  "ci approval: a malformed, unbounded, linked or ambiguous run list never submits",
  async () => {
    const bounded = makeRig();
    bounded.http.on(
      "GET",
      LIST_PATH,
      () => response(200, runsBody([runBody()], 101)),
    );
    assert.deepEqual(
      await bounded.run(),
      { approved: 0, pending: 0, unavailable: 1 },
    );
    assert.equal(bounded.http.posts().length, 0);

    const linked = makeRig();
    linked.http.on(
      "GET",
      LIST_PATH,
      () =>
        response(200, runsBody([runBody()]), {
          link: `<${API_BASE}${LIST_PATH}?page=2>; rel="next"`,
        }),
    );
    assert.deepEqual(
      await linked.run(),
      { approved: 0, pending: 0, unavailable: 1 },
    );
    assert.equal(linked.http.posts().length, 0);

    const malformed = makeRig();
    malformed.http.on("GET", LIST_PATH, () => response(200, "{not json"));
    assert.deepEqual(
      await malformed.run(),
      { approved: 0, pending: 0, unavailable: 1 },
    );
    assert.equal(malformed.http.posts().length, 0);

    const ambiguous = makeRig();
    ambiguous.http.on(
      "GET",
      LIST_PATH,
      () =>
        response(
          200,
          runsBody([runBody({ id: RUN_ID }), runBody({ id: RUN_ID + 1 })]),
        ),
    );
    assert.deepEqual(
      await ambiguous.run(),
      { approved: 0, pending: 0, unavailable: 1 },
    );
    assert.equal(
      ambiguous.http.posts().length,
      0,
      "ambiguous runs never submit",
    );
  },
);

Deno.test(
  "ci approval: a wrong exact-run id or changed attempt never submits or reports approval",
  async () => {
    const wrongId = makeRig();
    wrongId.http.on(
      "GET",
      RUN_PATH,
      () => response(200, runBody({ id: RUN_ID + 1 })),
    );
    assert.deepEqual(
      await wrongId.run(),
      { approved: 0, pending: 0, unavailable: 1 },
    );
    assert.equal(wrongId.http.posts().length, 0);

    const changedAttempt = makeRig();
    changedAttempt.http.on(
      "GET",
      RUN_PATH,
      () => response(200, runBody({ attempt: 2 })),
    );
    assert.deepEqual(
      await changedAttempt.run(),
      { approved: 0, pending: 0, unavailable: 1 },
    );
    assert.equal(changedAttempt.http.posts().length, 0);

    // A lost POST whose reconciliation read returns a different attempt must
    // never be reported as an approval, and never POST twice.
    const lostAttempt = makeRig();
    lostAttempt.http.on(
      "POST",
      APPROVE_PATH,
      () => Promise.reject(new Error("connection reset")),
    );
    let reads = 0;
    lostAttempt.http.on("GET", RUN_PATH, () => {
      reads++;
      return response(
        200,
        reads === 1
          ? runBody()
          : runBody({ attempt: 2, status: "queued", conclusion: null }),
      );
    });
    assert.deepEqual(
      await lostAttempt.run(),
      { approved: 0, pending: 0, unavailable: 1 },
    );
    assert.equal(lostAttempt.http.posts().length, 1, "one POST, never two");
    assert.equal(reads, 2, "the reconciliation read ran for the same run");
  },
);

type RigV1 = ReturnType<typeof makeRig>;

// ---------------------------------------------------------------------------
// M15 V1 candidate state: incomplete (unpreserved/unpublished) new-format
// records are filtered BEFORE the bounded slice, so they are never
// auto-approved and never starve a later eligible candidate.
// ---------------------------------------------------------------------------

/** Incomplete self candidate: valid PR/head/branch but nothing preserved. */
function incompleteCandidateRecord(index: number): WorkRecordV1 {
  const pr = 40 + index;
  const head = SHA2;
  return workRecord(`incomplete-${index}`, {
    repository: { ...SELF_REPO },
    source: { kind: "issue", id: `${100 + index}`, revision: SHA1 },
    related: { incidentId: null, issueNumber: 100 + index },
    target: {
      base: SHA1,
      branch: `sentinel/repair/incomplete-${index}`,
      checkpoint: null,
      head,
      pr,
      candidateState: { preserved: null, publishedHead: null },
    },
    nextStep: "review",
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
  });
}

Deno.test(
  "ci approval: incomplete unpublished candidates are filtered before the three-candidate slice",
  async () => {
    const incomplete = [0, 1, 2].map(incompleteCandidateRecord);
    // The valid candidate is LAST: without pre-slice filtering the three
    // incomplete records would occupy every approval slot.
    const rig = makeRig([...incomplete, candidateRecord()]);
    let incompletePrReads = 0;
    for (const record of incomplete) {
      const pr = record.target.pr as number;
      const head = record.target.head as string;
      const headRef = record.target.branch as string;
      rig.http.on(
        "GET",
        `/repos/ubiquity/sentinel/pulls/${pr}`,
        () => {
          incompletePrReads++;
          return response(
            200,
            pullBody({ number: pr, headSha: head, headRef }),
          );
        },
      );
    }
    const summary = await rig.run();
    assert.deepEqual(summary, { approved: 1, pending: 0, unavailable: 0 });
    assert.equal(incompletePrReads, 0, "no API call for an incomplete PR");
    assert.equal(rig.http.posts().length, 1, "one approval POST");
    assert.equal(
      new URL(rig.http.posts()[0]!.url).pathname,
      APPROVE_PATH,
      "the valid candidate is approved",
    );
    assert.deepEqual(
      rig.http.calls.map((call) =>
        `${call.method} ${new URL(call.url).pathname}`
      ),
      [
        `GET ${PULL_PATH}`,
        `GET ${LIST_PATH}`,
        `GET ${RUN_PATH}`,
        `GET ${PULL_PATH}`,
        `POST ${APPROVE_PATH}`,
      ],
      "exactly the valid fourth record is read and approved",
    );
  },
);

// ---------------------------------------------------------------------------
// Multi-target host: one separately targeted cycle per committed repository,
// sharing the state store, cooldown gate, admission budget, model port and one
// absolute run deadline.
// ---------------------------------------------------------------------------

/** A second committed target, distinct from the sentinel self-repository. */
const FOREIGN_REPO = "ai.ubq.fi";
/** A third committed target that the deadline test never starts. */
const THIRD_REPO = "web";
/** The one fixed App installation scope every non-sentinel target uses. */
const APP_INSTALLATION = parseAppInstallationId(undefined);

function unique(values: readonly number[]): number[] {
  return [...new Set(values)];
}

function issueReadPaths(http: ScriptedHttp): string[] {
  return http.calls
    .filter((call) =>
      call.method === "GET" && new URL(call.url).pathname.endsWith("/issues")
    )
    .map((call) => new URL(call.url).pathname);
}

interface TargetHostRigV1 {
  configs: RepositoryConfigV1[];
  clock: FakeClock;
  state: MemoryState;
  gate: FakeGate;
  http: ScriptedHttp;
  budget: RollingStartBudget;
  /** The exact production port composition, targeted at one config. */
  compose(config: RepositoryConfigV1): GitHubPort;
}

/**
 * The committed configurations exactly as the host scopes them: the sentinel
 * self-target keeps the reserved no-App scope 0 and every foreign target is
 * addressed under the App installation scope. Ports are the REAL
 * `composeLocalGitHub` composition over the scripted transport.
 */
function makeTargetHostRig(names: readonly string[]): TargetHostRigV1 {
  const self = createLocalRepositoryConfig();
  const configs = names.map((name) => {
    const config = createTargetConfigV1(
      self,
      { slug: `ubiquity/${name}`, owner: "ubiquity", name },
      name === "sentinel" ? self.baseBranch : "main",
    );
    return scopeTargetConfigV1(config, self.repository, APP_INSTALLATION);
  });
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  const gate = new FakeGate();
  const http = new ScriptedHttp();
  for (const name of names) {
    http.on("GET", `/repos/ubiquity/${name}/issues`, () => response(200, []));
  }
  const tracker = new LocalSessionTracker();
  const budget = new RollingStartBudget({ clock, state, configs });
  return {
    configs,
    clock,
    state,
    gate,
    http,
    budget,
    compose: (config) =>
      composeLocalGitHub({
        clock,
        state,
        gate,
        http: http.transport,
        token: "dummy-token",
        login: APP_PUBLISHER,
        invocationId: `test-${config.repository.name}`,
        stateRoot: "/tmp/sentinel-multi-target-state",
        sourcePath: "/tmp/sentinel-multi-target-source",
        scratch: "/tmp/sentinel-multi-target-scratch",
        reviewCheckout: "/tmp/sentinel-multi-target-review",
        reviewClientHome: "/tmp/sentinel-multi-target-clients",
        reviewTmpDir: "/tmp/sentinel-multi-target-tmp",
        reviewDenoDir: "/tmp/sentinel-multi-target-deno",
        trustedPath: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        codexExecutable: "/usr/bin/false",
        tracker,
        repository: config.repository,
      }),
  };
}

/** The one shared capability set, with explicit test overrides. */
function targetCycleInput(
  rig: TargetHostRigV1,
  overrides: Partial<Parameters<typeof runActionsTargetCycles>[0]> = {},
): Parameters<typeof runActionsTargetCycles>[0] {
  return {
    clock: rig.clock,
    state: rig.state,
    configs: rig.configs,
    controllerSha: SHA1,
    githubCooldown: rig.gate,
    incidents: unavailableIncidents,
    replay: unavailableReplay,
    model: new FakeModel(),
    budget: rig.budget,
    deadline: rig.clock.now() + 60 * 60_000,
    stepLimit: 16,
    modelStartsEnabled: false,
    composeGithub: rig.compose,
    ...overrides,
  };
}

Deno.test(
  "actions host: two committed targets produce two targeted cycles that read every target's issues",
  async () => {
    const rig = makeTargetHostRig(["sentinel", FOREIGN_REPO]);
    const configsPerCycle: string[][] = [];
    const admissionsPerCycle: number[][] = [];
    const outcomes: unknown[] = [];
    const reported: ActionsTargetCyclesResultV1[] = [];
    let boundary = 0;
    const result = await runActionsTargetCycles(targetCycleInput(rig, {
      report: (value) => {
        reported.push(value);
      },
      runCycle: async (deps, options) => {
        boundary = rig.gate.admissions.length;
        configsPerCycle.push(
          deps.configs.map((config) =>
            `${config.repository.owner}/${config.repository.name}`
          ),
        );
        const outcome = await runRepairEntrypoint(deps, options);
        admissionsPerCycle.push(rig.gate.admissions.slice(boundary));
        outcomes.push(outcome);
        return outcome;
      },
    }));

    // EVERY committed target is addressed exactly once, and each cycle is
    // injected the SOLE configuration its port was composed for.
    assert.deepEqual(result.addressed, [
      "ubiquity/sentinel",
      `ubiquity/${FOREIGN_REPO}`,
    ]);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(configsPerCycle, [
      ["ubiquity/sentinel"],
      [`ubiquity/${FOREIGN_REPO}`],
    ]);
    // The REAL entrypoint read one issue list per target, in setting order,
    // through the port the host composed for that exact repository.
    assert.deepEqual(issueReadPaths(rig.http), [
      "/repos/ubiquity/sentinel/issues",
      `/repos/ubiquity/${FOREIGN_REPO}/issues`,
    ]);
    // The sentinel self-target keeps the reserved no-App scope 0; the foreign
    // target is gated under the one App installation scope.
    assert.deepEqual(
      admissionsPerCycle.map(unique),
      [[0], [APP_INSTALLATION]],
      "each cycle is gated under its own target's installation scope",
    );
    // The aggregate uses the LAST addressed cycle's outcome.
    assert.equal(outcomes.length, 2);
    assert.equal(result.outcome, outcomes[1]);
    // One advisory report of the same pass, and the diagnostic line is never a
    // child status record.
    assert.equal(reported.length, 1);
    assert.equal(reported[0]!.outcome, result.outcome);
    assert.deepEqual(reported[0]!.addressed, result.addressed);
    assert.deepEqual(reported[0]!.skipped, []);
    const line = targetsDiagnosticV1({
      addressed: result.addressed,
      skipped: result.skipped,
      failed: result.failed,
    });
    assert.equal(Object.hasOwn(line, "status"), false);
    assert.deepEqual(line, {
      version: "v1",
      kind: "sentinel_targets_diagnostic",
      addressed: ["ubiquity/sentinel", `ubiquity/${FOREIGN_REPO}`],
      skipped: [],
      failed: [],
    });
  },
);

Deno.test(
  "actions host: a non-sentinel target uses the App installation scope while sentinel keeps 0",
  () => {
    assert.equal(APP_INSTALLATION, 155_687_488);
    assert.equal(parseAppInstallationId("4242"), 4242);
    assert.throws(() => parseAppInstallationId("0"));
    assert.throws(() => parseAppInstallationId("-1"));
    assert.throws(() => parseAppInstallationId("155687488x"));

    const self = createLocalRepositoryConfig();
    const sentinel = createTargetConfigV1(self, {
      slug: "ubiquity/sentinel",
      owner: "ubiquity",
      name: "sentinel",
    }, "development");
    const foreign = createTargetConfigV1(self, {
      slug: `ubiquity/${FOREIGN_REPO}`,
      owner: "ubiquity",
      name: FOREIGN_REPO,
    }, "main");
    const scopedSelf = scopeTargetConfigV1(sentinel, self.repository, 970_001);
    const scopedForeign = scopeTargetConfigV1(
      foreign,
      self.repository,
      970_001,
    );
    assert.equal(scopedSelf.repository.installationId, 0);
    assert.equal(scopedForeign.repository.installationId, 970_001);
    // Nothing except the identity changes: the trusted template still owns
    // every command, limit and protected path.
    assert.deepEqual(
      { ...scopedForeign, repository: null },
      { ...foreign, repository: null },
    );
  },
);

Deno.test(
  "actions host: an exhausted shared deadline stops before the next target cycle",
  async () => {
    const rig = makeTargetHostRig(["sentinel", FOREIGN_REPO, THIRD_REPO]);
    const composed: string[] = [];
    let cycles = 0;
    const result = await runActionsTargetCycles(targetCycleInput(rig, {
      deadline: rig.clock.now() + 10 * 60_000,
      composeGithub: (config) => {
        composed.push(`${config.repository.owner}/${config.repository.name}`);
        return rig.compose(config);
      },
      runCycle: async (deps, options) => {
        cycles++;
        const outcome = await runRepairEntrypoint(deps, options);
        // The one absolute deadline is now exhausted; the next check must stop
        // the run instead of restarting the clock for the next cycle.
        rig.clock.advance(11 * 60_000);
        return outcome;
      },
    }));

    assert.equal(cycles, 1, "only the first target was attempted");
    assert.deepEqual(result.addressed, ["ubiquity/sentinel"]);
    assert.deepEqual(result.skipped, [
      `ubiquity/${FOREIGN_REPO}`,
      `ubiquity/${THIRD_REPO}`,
    ]);
    assert.deepEqual(composed, ["ubiquity/sentinel"]);
    assert.deepEqual(issueReadPaths(rig.http), [
      "/repos/ubiquity/sentinel/issues",
    ]);
    assert.ok(result.outcome !== null);
  },
);

Deno.test(
  "actions host: a composed port reads the supplied repository under the supplied installation scope",
  async () => {
    const rig = makeTargetHostRig([FOREIGN_REPO]);
    const port = composeLocalGitHub({
      clock: rig.clock,
      state: rig.state,
      gate: rig.gate,
      http: rig.http.transport,
      token: "dummy-token",
      login: APP_PUBLISHER,
      invocationId: "test-override",
      stateRoot: "/tmp/sentinel-multi-target-state",
      sourcePath: "/tmp/sentinel-multi-target-source",
      scratch: "/tmp/sentinel-multi-target-scratch",
      reviewCheckout: "/tmp/sentinel-multi-target-review",
      reviewClientHome: "/tmp/sentinel-multi-target-clients",
      reviewTmpDir: "/tmp/sentinel-multi-target-tmp",
      reviewDenoDir: "/tmp/sentinel-multi-target-deno",
      trustedPath: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      codexExecutable: "/usr/bin/false",
      tracker: new LocalSessionTracker(),
      // The owner/name identity and the gate scope are supplied separately;
      // the explicit scope wins for every cooldown-gated request.
      repository: { owner: "ubiquity", name: FOREIGN_REPO, installationId: 0 },
      installationId: 970_001,
    });
    const listed = await port.listOpenIssues();
    assert.ok(listed.ok);
    assert.deepEqual(issueReadPaths(rig.http), [
      `/repos/ubiquity/${FOREIGN_REPO}/issues`,
    ]);
    assert.ok(rig.gate.admissions.length > 0);
    assert.deepEqual(unique(rig.gate.admissions), [970_001]);
  },
);

Deno.test(
  "actions host: the App installation scope is allowlisted in the workflow and both tasks",
  async () => {
    const workflow = await Deno.readTextFile(
      new URL("../../.github/workflows/supervisor.yml", import.meta.url),
    );
    const repairJob = workflow.split("Run selected Sentinel runtime")[1] ?? "";
    assert.ok(
      repairJob.includes('SENTINEL_APP_INSTALLATION_ID: "155687488"'),
      "the repair job passes the fixed App installation scope",
    );
    assert.ok(
      /--allow-env=\S*SENTINEL_APP_INSTALLATION_ID/.test(repairJob),
      "the repair launcher may read the App installation scope",
    );
    const manifest = JSON.parse(
      await Deno.readTextFile(new URL("../../deno.json", import.meta.url)),
    ) as { tasks: Record<string, string> };
    for (const task of ["repair:actions", "supervisor:run"]) {
      assert.ok(
        manifest.tasks[task].includes("SENTINEL_APP_INSTALLATION_ID"),
        `${task} may read the App installation scope`,
      );
    }
  },
);

Deno.test(
  "actions host: a target whose own preparation fails is recorded and never reported as addressed",
  async () => {
    const rig = makeTargetHostRig(["sentinel", FOREIGN_REPO]);
    const prepared: string[] = [];
    const addressed: string[][] = [];
    const result = await runActionsTargetCycles(targetCycleInput(rig, {
      prepareTarget: async (config) => {
        const slug = `${config.repository.owner}/${config.repository.name}`;
        prepared.push(slug);
        // The foreign target's own remote is unreachable for this run: only
        // THAT target fails, and the self-target must still be repaired.
        if (slug.endsWith(FOREIGN_REPO)) {
          throw new Error("target mirror fetch failed");
        }
      },
      runCycle: async (deps, options) => {
        addressed.push(
          deps.configs.map((config) =>
            `${config.repository.owner}/${config.repository.name}`
          ),
        );
        return await runRepairEntrypoint(deps, options);
      },
    }));

    assert.deepEqual(prepared, [
      "ubiquity/sentinel",
      `ubiquity/${FOREIGN_REPO}`,
    ]);
    assert.deepEqual(addressed, [["ubiquity/sentinel"]]);
    assert.deepEqual(result.addressed, ["ubiquity/sentinel"]);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.failed, [
      `ubiquity/${FOREIGN_REPO}: target mirror fetch failed`,
    ]);
    // A failed target is neither addressed nor skipped: the two lists stay
    // disjoint so the diagnostic can never read as a success claim.
    for (const entry of result.failed) {
      assert.equal(
        result.addressed.some((slug) => entry.startsWith(slug)),
        false,
      );
      assert.equal(result.skipped.length, 0);
    }
  },
);

Deno.test(
  "actions host: a foreign target's own mirror resolves its base commit while the sentinel mirror cannot",
  async () => {
    // Real offline git: two independent repositories. The sentinel mirror is
    // seeded from the sentinel checkout only, exactly as the hosted host does,
    // so it provably cannot resolve a foreign repository's commit; that is the
    // defect this test pins.
    const root = await Deno.makeTempDir({ prefix: "sentinel-target-mirror-" });
    // A private credential-free git home: no user/system config, no hooks and
    // no credential helper can leak in from this host.
    const home = `${root}/git-home`;
    await Deno.mkdir(home, { recursive: true });
    const env = testGitEnv(home);
    try {
      const sentinel = await makeRemoteCtx(`${root}/sentinel`, env);
      const foreign = await makeRemoteCtx(`${root}/foreign`, env);
      const commit = async (
        work: string,
        file: string,
        message: string,
      ): Promise<GitSha> => {
        await Deno.writeTextFile(`${work}/${file}`, `${message}\n`);
        assert.ok((await gitRun(work, ["add", "-A"], env)).ok);
        assert.ok(
          (await gitRun(work, ["commit", "-q", "-m", message], env)).ok,
        );
        const rev = await gitRun(work, ["rev-parse", "HEAD"], env);
        assert.ok(rev.ok);
        return rev.stdout.trim() as GitSha;
      };

      const sentinelBase = await commit(
        sentinel.work,
        "a.txt",
        "sentinel base",
      );
      assert.ok(
        (await gitRun(
          sentinel.work,
          ["push", "-q", "origin", "HEAD:refs/heads/development"],
          env,
        )).ok,
      );
      const foreignBase = await commit(foreign.work, "b.txt", "foreign base");
      assert.ok(
        (await gitRun(
          foreign.work,
          ["push", "-q", "origin", "HEAD:refs/heads/main"],
          env,
        )).ok,
      );

      // The sentinel mirror is seeded from the sentinel checkout. The foreign
      // commit object is NOT in it, which is exactly why a shared mirror
      // cannot serve a foreign target.
      const sentinelMirror = `${root}/mirror-sentinel`;
      assert.ok(
        (await gitRun(
          root,
          ["clone", "-q", "--no-hardlinks", sentinel.work, sentinelMirror],
          env,
        )).ok,
      );
      const absent = await gitRun(
        sentinelMirror,
        ["cat-file", "-e", `${foreignBase}^{commit}`],
        env,
      );
      assert.equal(
        absent.ok,
        false,
        "the sentinel mirror lacks foreign objects",
      );

      // The foreign target's OWN mirror, seeded from its own remote, resolves
      // that target's base commit and nothing of sentinel's.
      const foreignMirror = `${root}/mirror-foreign`;
      assert.ok(
        (await gitRun(
          root,
          [
            "clone",
            "-q",
            "--no-hardlinks",
            "--no-checkout",
            foreign.remoteUrl,
            foreignMirror,
          ],
          env,
        )).ok,
      );
      assert.ok(
        (await gitRun(
          foreignMirror,
          [
            "fetch",
            "-q",
            "--no-tags",
            foreign.remoteUrl,
            "+refs/heads/main:refs/remotes/origin/main",
          ],
          env,
        )).ok,
      );
      const resolved = await gitRun(
        foreignMirror,
        ["rev-parse", "refs/remotes/origin/main"],
        env,
      );
      assert.ok(resolved.ok);
      assert.equal(resolved.stdout.trim(), foreignBase);
      const detached = await gitRun(
        foreignMirror,
        ["checkout", "-q", "--detach", foreignBase],
        env,
      );
      assert.ok(detached.ok, "the foreign mirror can check out its own base");
      // Sentinel's object is genuinely absent from the foreign mirror, so the
      // two mirrors are disjoint and neither can silently serve the other.
      const sentinelAbsent = await gitRun(
        foreignMirror,
        ["cat-file", "-e", `${sentinelBase}^{commit}`],
        env,
      );
      assert.equal(sentinelAbsent.ok, false);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);
