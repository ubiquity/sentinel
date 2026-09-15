/**
 * Deterministic self-target CI approval boundaries.
 *
 * These tests drive the REAL `runActionsCiApproval` helper and the REAL
 * `GitHubApiClient` over a scripted in-memory HTTP transport with small
 * cooldown-gate and repair-state fixtures. No network, no model, no real
 * token: approval is only ever submitted for the exact run and PR identity,
 * and any mismatch, ambiguity, truncation or cooldown denial submits nothing.
 */
import assert from "node:assert/strict";

import { portError, portOk } from "../../src/contracts/ports.ts";
import type {
  GitHubCooldownGateV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import type { GitHubRateLimitV1 } from "../../src/contracts/github-cooldown.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type {
  HttpRequestV1,
  HttpResponseV1,
  HttpTransportV1,
} from "../../src/github/http.ts";
import { runActionsCiApproval } from "../../src/host/actions-ci.ts";
import { FakeClock, MemoryState } from "../repair/helpers.ts";
import { SHA1, SHA2, SHA3, T0, workRecord } from "../state/helpers.ts";

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
    triggering_actor: { login: PUBLISHER },
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
