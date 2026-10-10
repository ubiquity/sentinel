import assert from "node:assert/strict";
import {
  parseReviewReceiptV1,
  reviewTaskStatementDigest,
} from "../../src/contracts/review-receipt.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import { reviewOperationKey, reviewReceiptId } from "../../src/repair/keys.ts";
import { workRecord } from "../state/helpers.ts";
import {
  checkRunWire,
  checksPageWire,
  FakeClock,
  FakeReviewService,
  issueWire,
  makePort,
  PR_AUTHOR,
  pullWire,
  refWire,
  REPO,
  REVIEWER,
  SHA1,
  SHA2,
  SHA3,
  structuredCompletedFixture,
  T0,
} from "./helpers.ts";
import type { HttpRequestV1, HttpResponseV1 } from "../../src/github/http.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { reviewEvidenceRef } from "../../src/repair/keys.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import { makeRemoteCtx, testGitEnv } from "../state/helpers.ts";
import {
  FakeIncidents,
  FakeModel,
  FakeReplay,
  repairConfigs,
} from "../repair/helpers.ts";

async function fixture() {
  const key = reviewOperationKey(1, SHA1);
  const acceptance = {
    issueNumber: 7,
    taskDigest: await reviewTaskStatementDigest({
      issueNumber: 7,
      title: "already satisfied task",
      body: "task body",
    }),
    verdict: "already_satisfied_at_base" as const,
    evidence: ["base already satisfies the exact task"],
  };
  const completion = await structuredCompletedFixture({
    operationKey: key,
    result: {
      verdict: "clean",
      summary: "no issues found",
      findings: [],
      taskAcceptance: acceptance,
    },
  });
  const review = parseReviewReceiptV1({
    version: "v1",
    kind: "review_receipt",
    id: await reviewReceiptId(key, SHA1),
    requestId: "req-1",
    expectedReviewer: REVIEWER,
    observedReviewer: REVIEWER,
    repository: REPO,
    pullRequest: { number: 1, head: SHA1, base: SHA2 },
    outcome: "completed",
    resultId: "result-9",
    summary: "no issues found",
    findings: [],
    findingsUncounted: 0,
    unresolvedSeverities: [],
    taskAcceptance: acceptance,
    submittedAt: T0 + 1000,
    completedAt: T0 + 120_000,
    observedAt: T0 + 200_000,
  });
  const record = workRecord("terminal-1", {
    repository: REPO,
    related: { incidentId: null, issueNumber: 7 },
    nextStep: "delivery",
    target: {
      base: SHA2,
      branch: "sentinel/fix-1",
      checkpoint: null,
      head: SHA1,
      pr: 1,
    },
    intent: {
      kind: "already_satisfied_closure",
      key: `satisfied:1:${SHA1}:${SHA2}`,
      startedAt: T0 + 200_000,
      branch: "sentinel/fix-1",
      expectedHead: SHA1,
      observedBase: SHA2,
      pr: 1,
      requestId: review.requestId,
      resultId: review.resultId,
    },
  });
  const state = {
    prClosed: false,
    issueClosed: false,
    head: SHA1,
    body: "task body",
    author: PR_AUTHOR,
    failPr: false,
    failIssue: false,
    tamperJournal: false,
    failCi: false,
    base: SHA2,
  };
  const requests: HttpRequestV1[] = [];
  const http = (request: HttpRequestV1): Promise<HttpResponseV1> => {
    requests.push(request);
    const path = new URL(request.url).pathname;
    let body: unknown;
    if (path.endsWith("/pulls/1")) {
      if (request.method === "PATCH") {
        state.prClosed = true;
        if (state.failPr) {
          state.failPr = false;
          return Promise.reject(new Error("lost PR response"));
        }
      }
      body = pullWire({
        state: state.prClosed ? "closed" : "open",
        head: { ref: "sentinel/fix-1", sha: state.head },
        base: { ref: "development", sha: state.base },
        body: "Resolves #7",
        user: { login: state.author },
      });
    } else if (path.endsWith("/pulls/1/reviews")) {
      body = [{
        ...completion.review,
        body: state.tamperJournal
          ? `${completion.body}tampered`
          : completion.body,
      }];
    } else if (path.endsWith("/issues")) body = [];
    else if (path.endsWith("/pulls/1/comments")) body = [];
    else if (path.endsWith("/git/ref/heads/sentinel/fix-1")) {
      body = refWire(state.head);
    } else if (path.endsWith("/git/ref/heads/development")) {
      body = refWire(state.base, "refs/heads/development");
    } else if (path.endsWith("/check-runs")) {
      body = checksPageWire([
        checkRunWire({ conclusion: state.failCi ? "failure" : "success" }),
      ]);
    } else if (path.endsWith("/statuses")) body = [];
    else if (path.endsWith("/issues/7")) {
      if (request.method === "PATCH") {
        if (state.failIssue) {
          state.failIssue = false;
          return Promise.reject(new Error("issue write unavailable"));
        }
        state.issueClosed = true;
      }
      body = issueWire({
        number: 7,
        title: "already satisfied task",
        body: state.body,
        state: state.issueClosed ? "closed" : "open",
        closed_at: state.issueClosed ? "2026-09-07T02:00:00Z" : null,
      });
    } else return Promise.reject(new Error(`unexpected fake path ${path}`));
    return Promise.resolve({
      status: 200,
      headers: new Headers(),
      bodyText: JSON.stringify(body),
    });
  };
  const service = new FakeReviewService();
  service.readResult = completion.service;
  const clock = new FakeClock(T0 + 200_000);
  const { port } = makePort({ http, review: service, clock });
  const request = { record, review, deadline: T0 + 3600_000 };
  return { port, request, state, requests, http, service, clock };
}

Deno.test("terminal adapter: ambiguous PR close reconciles without merge", async () => {
  const context = await fixture();
  context.state.failPr = true;
  assert.equal(
    (await context.port.closeAlreadySatisfiedTask(context.request)).ok,
    true,
  );
  assert.equal(context.state.prClosed, true);
  assert.equal(context.state.issueClosed, true);
  assert.equal(
    context.requests.filter((request) =>
      request.method === "PATCH" && request.url.endsWith("/pulls/1")
    ).length,
    1,
  );
  assert.equal(
    context.requests.some((request) => request.method === "PUT"),
    false,
  );
});

Deno.test("terminal adapter: PR-closed issue-open retry only closes issue", async () => {
  const context = await fixture();
  context.state.failIssue = true;
  assert.equal(
    (await context.port.closeAlreadySatisfiedTask(context.request)).ok,
    false,
  );
  assert.equal(context.state.prClosed, true);
  assert.equal(context.state.issueClosed, false);
  assert.equal(
    (await context.port.closeAlreadySatisfiedTask(context.request)).ok,
    true,
  );
  assert.equal(
    context.requests.filter((request) =>
      request.method === "PATCH" && request.url.endsWith("/pulls/1")
    ).length,
    1,
  );
  assert.equal(context.state.issueClosed, true);
});

Deno.test("terminal adapter: changed head task base author CI and journal refuse effects", async () => {
  for (
    const defect of ["head", "task", "base", "author", "ci", "journal"] as const
  ) {
    const context = await fixture();
    if (defect === "head") context.state.head = SHA3;
    if (defect === "task") context.state.body = "changed task";
    if (defect === "base") context.state.base = SHA3;
    if (defect === "author") context.state.author = "human";
    if (defect === "ci") context.state.failCi = true;
    if (defect === "journal") context.state.tamperJournal = true;
    assert.equal(
      (await context.port.closeAlreadySatisfiedTask(context.request)).ok,
      false,
      defect,
    );
    assert.equal(
      context.requests.some((request) => request.method === "PATCH"),
      false,
      defect,
    );
  }
});

Deno.test("terminal intent: strict parser binds publication and review identities", async () => {
  const { request } = await fixture();
  assert.deepEqual(parseWorkRecordV1(request.record), request.record);
  for (
    const changes of [{ expectedHead: SHA3 }, { resultId: null }, {
      key: "satisfied:wrong",
    }]
  ) {
    assert.throws(() =>
      parseWorkRecordV1({
        ...request.record,
        intent: { ...request.record.intent, ...changes },
      })
    );
  }
});

Deno.test("terminal lifecycle: real Git CAS controller and native adapter retry only issue closure", async () => {
  const context = await fixture();
  const temporary = await Deno.makeTempDir({
    dir: new URL("../../", import.meta.url).pathname,
    prefix: "terminal-connected-",
  });
  try {
    const environment = testGitEnv(`${temporary}/git-home`);
    await Deno.mkdir(`${temporary}/git-home`, { recursive: true });
    const remote = await makeRemoteCtx(temporary, environment);
    const state = createRepairStateStore({
      scratchDir: `${temporary}/scratch`,
      remoteUrl: remote.remoteUrl,
    });
    const record = {
      ...context.request.record,
      evidence: [{
        kind: "review_receipt" as const,
        ref: reviewEvidenceRef(context.request.review.id),
      }],
    };
    const written = await state.writeRepair({
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: context.clock.now(),
      incidents: [],
      evidence: [],
      work: [record],
      reservations: [],
      reviews: [context.request.review],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
      attemptMemory: [],
      lessons: [],
    }, null);
    assert.ok(
      written.ok && written.value.status === "applied",
      JSON.stringify(written),
    );
    const configs = repairConfigs().map((config) => ({
      ...config,
      repository: REPO,
    }));
    const githubCooldown = new DurableGitHubCooldownGate({
      state,
      clock: context.clock,
    });
    const { port } = makePort({
      http: context.http,
      review: context.service,
      clock: context.clock,
      cooldownGate: githubCooldown,
    });
    const model = new FakeModel();
    const run = () =>
      runRepairCycle({
        state,
        clock: context.clock,
        configs,
        controllerSha: SHA2,
        github: port,
        githubCooldown,
        model,
        incidents: new FakeIncidents({ summaries: [] }),
        replay: new FakeReplay(),
        budget: new RollingStartBudget({
          state,
          clock: context.clock,
          configs,
        }),
      }, { deadline: context.clock.now() + 3600_000, stepLimit: 8 });
    context.state.failIssue = true;
    await run();
    const pending = await state.readRepair();
    assert.ok(pending.ok && pending.value.status === "found");
    assert.equal(
      pending.value.snapshot.work[0].intent?.kind,
      "already_satisfied_closure",
    );
    assert.equal(context.state.prClosed, true);
    assert.equal(context.state.issueClosed, false);
    context.clock.advance(300_001);
    await run();
    const finished = await state.readRepair();
    assert.ok(finished.ok && finished.value.status === "found");
    assert.equal(finished.value.snapshot.work[0].nextStep, "done");
    assert.deepEqual(finished.value.snapshot.work[0].target, record.target);
    assert.equal(finished.value.snapshot.releaseRequests.length, 0);
    assert.equal(
      context.requests.filter((request) =>
        request.method === "PATCH" && request.url.endsWith("/pulls/1")
      ).length,
      1,
    );
    assert.equal(
      context.requests.some((request) => request.method === "PUT"),
      false,
    );
    assert.equal(model.requests.length, 0);
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
});
