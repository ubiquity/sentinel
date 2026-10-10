/** Lazy intake through the real client, matrix planner and temporary Git state. */
import assert from "node:assert/strict";

import { RollingStartBudget } from "../../src/budget/mod.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import { planMatrixWave } from "../../src/host/matrix.ts";
import {
  prepareMatrixIntakeV1,
  type RepairCycleDepsV1,
} from "../../src/repair/loop.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import {
  FakeAuthProvider,
  FakeCooldownGate,
  httpRespond,
  issueWire,
  ScriptedHttpTransport,
} from "./helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  repairConfigs,
} from "../repair/helpers.ts";
import {
  makeRemoteCtx,
  REPO,
  SHA1,
  T0,
  testGitEnv,
  workRecord,
} from "../state/helpers.ts";

function relationsWire(
  number: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    data: {
      repository: {
        issue: {
          number,
          blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
          subIssues: { totalCount: 0 },
          ...overrides,
        },
      },
    },
  };
}

Deno.test("issue intake matrix: lazy listing keeps parent blocker and unknown dependencies uncharged", async () => {
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-lazy-intake-test-",
  });
  try {
    const env = testGitEnv(root + "/git-home");
    await Deno.mkdir(root + "/git-home");
    const remote = await makeRemoteCtx(root, env);
    const state = createRepairStateStore({
      scratchDir: root + "/state",
      remoteUrl: remote.remoteUrl,
    });
    const clock = new FakeClock(T0 + 10_000);
    const known = Array.from(
      { length: 6 },
      (_, index) =>
        workRecord(`issue-${index + 1}`, {
          source: { kind: "issue", id: String(index + 1), revision: SHA1 },
          related: { incidentId: null, issueNumber: index + 1 },
          nextStep: "done",
        }),
    );
    const seed = parseRepairStateSnapshotV1({
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: clock.now(),
      incidents: [],
      evidence: [],
      work: known,
      reservations: [],
      reviews: [],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
      attemptMemory: [],
      lessons: [],
    });
    const seeded = await state.writeRepair(seed, null);
    assert.ok(seeded.ok && seeded.value.status === "applied");

    const listed = Array.from({ length: 10 }, (_, index) =>
      issueWire({
        number: index + 1,
        created_at: new Date(T0 - 10_000 + index).toISOString(),
      }));
    const transport = new ScriptedHttpTransport([
      httpRespond("GET", "/issues", 200, listed),
      httpRespond("GET", "/issues/7", 200, listed[6]),
      httpRespond("POST", "/graphql", 200, relationsWire(7)),
      httpRespond("GET", "/issues/8", 200, listed[7]),
      httpRespond(
        "POST",
        "/graphql",
        200,
        relationsWire(8, {
          subIssues: { totalCount: 2 },
        }),
      ),
      httpRespond("GET", "/issues/9", 200, listed[8]),
      httpRespond(
        "POST",
        "/graphql",
        200,
        relationsWire(9, {
          blockedBy: {
            nodes: [{
              number: 99,
              state: "OPEN",
              repository: { nameWithOwner: "other-org/other-repo" },
            }],
            pageInfo: { hasNextPage: false },
          },
        }),
      ),
      httpRespond("GET", "/issues/10", 200, listed[9]),
      httpRespond("POST", "/graphql", 200, {
        errors: [{ message: "unavailable" }],
      }),
    ]);
    const gate = new FakeCooldownGate();
    const client = new GitHubApiClient({
      repository: REPO,
      apiBaseUrl: "https://api.github.com",
      http: transport.fetch.bind(transport),
      auth: new FakeAuthProvider(),
      cooldownGate: gate,
      clock,
      includeIssueRelations: true,
    });
    const github = new FakeGithub({ baseSha: SHA1 });
    github.listOpenIssues = () => client.listOpenIssues();
    github.readIssue = (number) => client.readIssue(number);
    const configs = repairConfigs({
      adapter: { kind: "github" },
      liveStartLimits: { perHour: null, perSevenDays: null },
      sessionBound: { maxDurationMs: 60_000, maxOutputChars: 1_000 },
    });
    const model = new FakeModel();
    const deps: RepairCycleDepsV1 = {
      clock,
      state,
      configs,
      controllerSha: SHA1,
      github,
      githubCooldown: gate,
      incidents: new FakeIncidents(),
      replay: new FakeReplay(),
      model,
      budget: new RollingStartBudget({ state, clock, configs }),
    };
    const deadline = clock.now() + 60 * 60_000;
    const intake = await prepareMatrixIntakeV1(deps, { deadline });
    assert.equal(intake.status, "idle", JSON.stringify(intake));
    assert.equal(
      transport.requests.length,
      1,
      "intake never reads dependencies for known records",
    );

    const planned = await planMatrixWave(deps, {
      waveId: "lazy-intake-wave",
      run: { runId: 41, runAttempt: 1, launcherSha: SHA1 },
      runtimeSha: SHA1,
      generation: 1,
      deadline,
      plannedAt: clock.now(),
    });
    assert.deepEqual(
      planned.plan.cells.map((cell) => cell.request.issue?.number),
      [7],
    );
    const read = await state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    const snapshot = read.value.snapshot;
    assert.equal(
      snapshot.work.length,
      10,
      "known records are retained and never duplicated",
    );
    assert.equal(snapshot.reservations.length, 1);
    assert.equal(snapshot.reservations[0].outcome, "reserved");
    for (const number of [8, 9, 10]) {
      const record = snapshot.work.find((row) =>
        row.related.issueNumber === number
      )!;
      assert.equal(record.intent, null);
      assert.equal(record.counters.attempts, 0);
      assert.equal(record.wait?.reason, "unavailable");
      assert.equal(record.wait?.until, clock.now() + 60 * 60_000);
      assert.ok(!snapshot.reservations.some((row) => row.taskId === record.id));
    }
    assert.equal(
      model.requests.length,
      0,
      "the planner grants only; it never runs a model",
    );
    assert.deepEqual(
      transport.requests.filter((request) => request.method === "POST").map((
        request,
      ) => JSON.parse(request.body!).variables.number),
      [7, 8, 9, 10],
      "only mandatory current admission reads fetch native dependencies",
    );
    assert.deepEqual(
      snapshot.work.filter((row) => row.nextStep === "done"),
      known,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
