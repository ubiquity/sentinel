/**
 * Uncapped work-in-progress (owner update 2026-10-02T22:05:51Z: "lift all the
 * limits"). The removed unfinished-PR cap must stop gating BOTH surfaces the
 * production pipeline applies it on:
 *
 *   1. selection (`rankEligibleWork`), which currently marks every fresh
 *      record `wip` once three unfinished PRs exist; and
 *   2. publication (`runRepairCycle`), which currently parks a fresh record on
 *      its own backoff wait even after selection admitted it.
 *
 * The loop case drives the real production cycle over the real temporary Git
 * repair-state store with fake external ports (the proven `makeRig` shape from
 * the recovery loop suite). `countUnfinishedPullRequests` accounting is
 * retained; only its admission authority is expected to disappear.
 *
 * RED before implementation: selection returns no fresh record behind four
 * unfinished PRs, and the loop therefore starts no model and publishes
 * nothing. The two-unfinished-PR control must stay green, so a red result is
 * attributable to the removed cap and not to the rig.
 */
import assert from "node:assert/strict";

import { RollingStartBudget } from "../../src/budget/mod.ts";
import type { GitHubIssueV1, PortResultV1 } from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { rankEligibleWork } from "../../src/repair/selection.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import {
  makeRemoteCtx,
  SHA1,
  SHA2,
  SHA3,
  T0,
  testGitEnv,
  workRecord,
} from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  repairConfigs,
} from "./helpers.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/repair\/uncapped_work_in_progress_test\.ts$/,
  "",
);

/** One live record that owns an open unfinished pull request. */
function openPrRecord(number: number, pr: number): WorkRecordV1 {
  return workRecord(`issue-${number}`, {
    source: { kind: "issue", id: String(number), revision: SHA1 },
    related: { incidentId: null, issueNumber: number },
    target: {
      base: SHA1,
      branch: `sentinel/repair/issue-${number}`,
      checkpoint: null,
      head: SHA2,
      pr,
    },
    nextStep: "review",
    wait: { reason: "review_pending", since: T0, until: T0 + 3_600_000 },
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
  });
}

/** One fresh eligible record with no publication identity at all. */
function freshRecord(number: number): WorkRecordV1 {
  return workRecord(`issue-${number}`, {
    source: { kind: "issue", id: String(number), revision: SHA1 },
    related: { incidentId: null, issueNumber: number },
    nextStep: "work",
  });
}

function seedSnapshot(work: WorkRecordV1[]): RepairStateSnapshotV1 {
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

Deno.test(
  "uncapped WIP: selection admits every fresh record behind any number of unfinished PRs",
  () => {
    const published = [11, 12, 13, 14, 15, 16, 17, 18].map((pr, index) =>
      openPrRecord(100 + index, pr)
    );
    const fresh = [201, 202, 203, 204, 205, 206].map(freshRecord);
    const ranked = rankEligibleWork(
      seedSnapshot([...published, ...fresh]),
      repairConfigs(),
      T0,
    );

    assert.deepEqual(
      [...ranked.ordered].sort(),
      fresh.map((record) => record.id).sort(),
      JSON.stringify(ranked.skipped),
    );
    for (const record of fresh) {
      assert.equal(
        ranked.skipped[record.id],
        undefined,
        `${record.id} must never be WIP-skipped`,
      );
    }
    // The unfinished publications stay accounted, not selected while waiting.
    for (const record of published) {
      assert.equal(ranked.skipped[record.id], "waiting");
    }
  },
);

/** Issue row served to the real intake by the real loop. */
function issueRow(number: number): GitHubIssueV1 {
  return {
    number,
    title: `fresh issue ${number}`,
    body: "body",
    state: "open",
    author: null,
    labels: [],
    createdAt: T0,
    updatedAt: T0,
    closedAt: null,
    relations: { openBlockers: [], subIssueCount: 0 },
  };
}

/** Source-accurate issue listing/admission reads for the loop rig. */
class ListedGithub extends FakeGithub {
  listed: GitHubIssueV1[] = [];
  latest = new Map<number, GitHubIssueV1 | null>();

  override listOpenIssues(): Promise<PortResultV1<GitHubIssueV1[]>> {
    this.calls.push("listOpenIssues");
    return Promise.resolve(portOk(this.listed));
  }

  override readIssue(
    issueNumber: number,
  ): Promise<PortResultV1<GitHubIssueV1 | null>> {
    this.calls.push(`readIssue:${issueNumber}`);
    return Promise.resolve(portOk(this.latest.get(issueNumber) ?? null));
  }
}

export interface FreshIssueRunV1 {
  outcomeStatus: string;
  modelStarts: number;
  pushes: number;
  calls: string[];
}

/**
 * Seed `unfinished` live open-PR records plus one fresh open issue, then run
 * the actual repair cycle once over the real temporary Git state store. The
 * temp repository is always removed before returning.
 */
async function runFreshIssueBehind(
  unfinished: number,
): Promise<FreshIssueRunV1> {
  const sourceIssue = issueRow(1);
  const github = new ListedGithub({
    baseSha: SHA1,
    // The trusted preservation capability the real host composes: a completed
    // model candidate must become durable before publication, and that step
    // is not part of the removed WIP cap.
    candidateLifecycle: {
      preserveCandidate: () => Promise.resolve(portOk(undefined)),
    },
  });
  github.listed = [sourceIssue];
  github.latest.set(1, sourceIssue);

  const tmp = await Deno.makeTempDir({
    prefix: `sentinel-uncapped-wip-${unfinished}-`,
    dir: ROOT,
  });
  try {
    const env = testGitEnv(`${tmp}/git-home`);
    await Deno.mkdir(`${tmp}/git-home`, { recursive: true });
    const remote = await makeRemoteCtx(tmp, env);
    const clock = new FakeClock(T0);
    const store = createRepairStateStore({
      scratchDir: `${tmp}/scratch`,
      remoteUrl: remote.remoteUrl,
    });
    const configs = repairConfigs({
      adapter: { kind: "github" },
      sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
    });
    const budget = new RollingStartBudget({ clock, state: store, configs });
    const githubCooldown = new DurableGitHubCooldownGate({
      state: store,
      clock,
    });
    const incidents = new FakeIncidents({ summaries: [], evidence: null });
    const replay = new FakeReplay();
    const model = new FakeModel({
      head: SHA3,
      changedPaths: ["src/app.ts"],
    });

    const seeded = Array.from(
      { length: unfinished },
      (_, index) => openPrRecord(101 + index, 11 + index),
    );
    const written = await store.writeRepair(seedSnapshot(seeded), null);
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await runRepairCycle({
      clock,
      state: store,
      configs,
      controllerSha: SHA1,
      github,
      githubCooldown,
      incidents,
      replay,
      model,
      budget,
    }, { deadline: clock.now() + 60 * 60_000, stepLimit: 16 });

    return {
      outcomeStatus: outcome.status,
      modelStarts: model.requests.length,
      pushes: github.pushes.length,
      calls: [...github.calls],
    };
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

Deno.test(
  "uncapped WIP: a fresh issue starts and publishes behind four unfinished PRs",
  async () => {
    const result = await runFreshIssueBehind(4);
    assert.notEqual(result.outcomeStatus, "state_error", result.outcomeStatus);
    assert.equal(
      result.modelStarts,
      1,
      `selection must admit the fresh issue behind unfinished PRs: ${result.outcomeStatus}`,
    );
    assert.equal(
      result.pushes,
      1,
      `publication must not park the admitted fresh issue on a WIP wait: ${result.outcomeStatus}`,
    );
    assert.ok(result.calls.includes("createPr"));
  },
);

Deno.test(
  "uncapped WIP control: two unfinished PRs never blocked a fresh issue",
  async () => {
    const result = await runFreshIssueBehind(2);
    assert.notEqual(result.outcomeStatus, "state_error", result.outcomeStatus);
    assert.equal(result.modelStarts, 1, result.outcomeStatus);
    assert.equal(result.pushes, 1, result.outcomeStatus);
  },
);

Deno.test(
  "legacy quota: a future budget_cap wait is reconsidered under the uncapped policy",
  async () => {
    const runParked = async (
      waitReason: "budget_cap" | "backoff",
      limits: { perHour: number | null; perSevenDays: number | null },
    ): Promise<FreshIssueRunV1> => {
      const issueNumber = 111;
      const sourceIssue = issueRow(issueNumber);
      const github = new ListedGithub({
        baseSha: SHA1,
        candidateLifecycle: {
          preserveCandidate: () => Promise.resolve(portOk(undefined)),
        },
      });
      github.listed = [sourceIssue];
      github.latest.set(issueNumber, sourceIssue);
      const tmp = await Deno.makeTempDir({
        prefix: `sentinel-legacy-quota-${waitReason}-`,
        dir: ROOT,
      });
      try {
        const env = testGitEnv(`${tmp}/git-home`);
        await Deno.mkdir(`${tmp}/git-home`, { recursive: true });
        const remote = await makeRemoteCtx(tmp, env);
        const clock = new FakeClock(T0);
        const store = createRepairStateStore({
          scratchDir: `${tmp}/scratch`,
          remoteUrl: remote.remoteUrl,
        });
        const configs = repairConfigs({
          adapter: { kind: "github" },
          liveStartLimits: limits,
          sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
        });
        const budget = new RollingStartBudget({ clock, state: store, configs });
        const githubCooldown = new DurableGitHubCooldownGate({
          state: store,
          clock,
        });
        const incidents = new FakeIncidents({ summaries: [], evidence: null });
        const replay = new FakeReplay();
        const model = new FakeModel({
          head: SHA3,
          changedPaths: ["src/app.ts"],
        });

        const parked = workRecord(`issue-${issueNumber}`, {
          source: { kind: "issue", id: String(issueNumber), revision: SHA1 },
          related: { incidentId: null, issueNumber },
          target: {
            base: SHA1,
            branch: `sentinel/repair/issue-${issueNumber}`,
            checkpoint: null,
            head: null,
            pr: null,
          },
          nextStep: "work",
          wait: { reason: waitReason, since: T0, until: T0 + 3_600_000 },
          firstSeenAt: T0 - 60_000,
        });
        const written = await store.writeRepair(seedSnapshot([parked]), null);
        assert.ok(written.ok && written.value.status === "applied");

        const outcome = await runRepairCycle({
          clock,
          state: store,
          configs,
          controllerSha: SHA1,
          github,
          githubCooldown,
          incidents,
          replay,
          model,
          budget,
        }, { deadline: clock.now() + 60 * 60_000, stepLimit: 16 });

        return {
          outcomeStatus: outcome.status,
          modelStarts: model.requests.length,
          pushes: github.pushes.length,
          calls: [...github.calls],
        };
      } finally {
        await Deno.remove(tmp, { recursive: true }).catch(() => {});
      }
    };

    // The legacy wait is a budget-only deferral and the current policy is
    // explicitly uncapped: the parked work must be reconsidered at once.
    const uncappedParked = await runParked("budget_cap", {
      perHour: null,
      perSevenDays: null,
    });
    assert.notEqual(
      uncappedParked.outcomeStatus,
      "state_error",
      uncappedParked.outcomeStatus,
    );
    assert.equal(
      uncappedParked.modelStarts,
      1,
      `the parked work must be admitted: ${uncappedParked.outcomeStatus}`,
    );
    assert.equal(
      uncappedParked.pushes,
      1,
      `the parked work must publish: ${uncappedParked.outcomeStatus}`,
    );
    assert.ok(uncappedParked.calls.includes("createPr"));

    // Control: a non-budget wait class is never reconsidered.
    const backoff = await runParked("backoff", {
      perHour: null,
      perSevenDays: null,
    });
    assert.notEqual(
      backoff.outcomeStatus,
      "state_error",
      backoff.outcomeStatus,
    );
    assert.equal(backoff.modelStarts, 0, backoff.outcomeStatus);
    assert.equal(backoff.pushes, 0, backoff.outcomeStatus);

    // Control: a numeric policy keeps its real budget deferral.
    const numeric = await runParked("budget_cap", {
      perHour: 2,
      perSevenDays: null,
    });
    assert.notEqual(
      numeric.outcomeStatus,
      "state_error",
      numeric.outcomeStatus,
    );
    assert.equal(numeric.modelStarts, 0, numeric.outcomeStatus);
    assert.equal(numeric.pushes, 0, numeric.outcomeStatus);
  },
);
