/**
 * Applier tests for the self-observation pass: bounded reads, per-pass issue
 * cap and marker dedup over a fake surface. No network, state or model access;
 * every fixture below is synthetic.
 */
// ---- applier: bounded, deduplicated filing over a fake surface ------------

import {
  type HostedAutonomyGitHubV1,
  runSelfObservationPass,
} from "../../ops/hosted-autonomy.ts";

function fakeSurface(input: {
  runs: unknown;
  jobs: unknown;
  logs: Record<number, string | null>;
  bodies: string[];
  capability?: boolean;
}) {
  const filed: { title: string; body: string }[] = [];
  const base = {
    readDefaultBranch: () => Promise.resolve("development"),
    readBaseTip: () => Promise.resolve(null),
    hasSuccessfulCheck: () => Promise.resolve(false),
    hasAllChecksGreen: () => Promise.resolve(false),
    readPull: () => Promise.resolve(null),
    readIssueOpen: () => Promise.resolve(null),
    merge: () => Promise.resolve(null),
    closeIssue: () => Promise.resolve(false),
    listParkedRuns: () => Promise.resolve([]),
    approveRun: () => Promise.resolve(false),
  };
  const observation = {
    listRuns: () => Promise.resolve(input.runs),
    listJobs: () => Promise.resolve(input.jobs),
    readJobLog: (request: { jobId: number }) =>
      Promise.resolve(input.logs[request.jobId] ?? null),
    listOpenIssueBodies: () => Promise.resolve(input.bodies),
    fileIssue: (issue: { title: string; body: string }) => {
      filed.push(issue);
      return Promise.resolve(900 + filed.length);
    },
  };
  const surface = (input.capability === false ? base : {
    ...base,
    selfObservation: observation,
  }) as unknown as HostedAutonomyGitHubV1;
  return { surface, filed };
}

import assert from "node:assert/strict";

const FAILED_RUNS = [
  {
    id: 1,
    name: "sentinel-ci",
    conclusion: "failure",
    createdAt: "2026-09-23T18:18:46Z",
  },
  {
    id: 2,
    name: "sentinel-ci",
    conclusion: "failure",
    createdAt: "2026-09-23T18:20:46Z",
  },
  {
    id: 3,
    name: "sentinel-supervisor",
    conclusion: "cancelled",
    createdAt: "2026-09-23T18:22:46Z",
  },
];

Deno.test("self observation: absent capability skips every read and write", async () => {
  const { surface, filed } = fakeSurface({
    runs: FAILED_RUNS,
    jobs: [],
    logs: {},
    bodies: [],
    capability: false,
  });
  const actions = await runSelfObservationPass({
    github: surface,
    now: Date.parse("2026-09-23T19:00:00Z"),
  });
  assert.deepEqual(actions, ["self-observation:skipped:capability_absent"]);
  assert.equal(filed.length, 0);
});

Deno.test("self observation: repeated classes are filed once and capped per pass", async () => {
  const jobs = [{ id: 11, name: "test-local", conclusion: "failure" }];
  const log = "error: AssertionError: unexpected github calls: readRef\n";
  const { surface, filed } = fakeSurface({
    runs: FAILED_RUNS,
    jobs,
    logs: { 11: log },
    bodies: [],
  });
  const actions = await runSelfObservationPass({
    github: surface,
    now: Date.parse("2026-09-23T19:00:00Z"),
  });
  assert.equal(
    filed.length,
    2,
    "one report per workflow class, within the per-pass cap",
  );
  assert.ok(
    actions.some((action) => action.startsWith("self-observation:filed:90")),
  );
  assert.ok(
    filed.every((issue) => issue.body.includes("sentinel:self-observation:")),
  );
  assert.ok(
    filed.every((issue) => !issue.body.includes("=== raw log ===")),
    "no raw log body is carried",
  );
  const keys = filed.map((issue) =>
    issue.body.match(/<!-- sentinel:self-observation:([a-z0-9:._-]+) -->/)
      ?.[1] ?? null
  );
  assert.equal(
    new Set(keys).size,
    2,
    "the two classes are distinct identities",
  );
  assert.ok(keys.every((key) => key !== null && key.startsWith("sentinel-")));

  const second = fakeSurface({
    runs: FAILED_RUNS,
    jobs,
    logs: { 11: log },
    bodies: filed.map((issue) => issue.body),
  });
  const secondActions = await runSelfObservationPass({
    github: second.surface,
    now: Date.parse("2026-09-23T19:00:00Z"),
  });
  assert.equal(
    second.filed.length,
    0,
    "an already-filed class is never refiled",
  );
  assert.ok(
    secondActions.includes("self-observation:no_change"),
    "a pass with nothing new reports no_change",
  );
});

Deno.test("self observation: an unreadable log is an explicit skip, not a report", async () => {
  const jobs = [{ id: 11, name: "test-local", conclusion: "failure" }];
  const { surface, filed } = fakeSurface({
    runs: [FAILED_RUNS[0]!],
    jobs,
    logs: { 11: null },
    bodies: [],
  });
  const actions = await runSelfObservationPass({
    github: surface,
    now: Date.parse("2026-09-23T19:00:00Z"),
  });
  assert.equal(filed.length, 0);
  assert.ok(
    actions.some((action) => action.includes("log_unavailable")),
    "the refusal is visible as an action",
  );
});
