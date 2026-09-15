/**
 * m04-repair selection tests: the frozen plan priority order, WIP cap,
 * dependency and wait/terminal/blocked skipping, plus stable repo/source
 * tie-breaks. Pure functions only; no ports, no Git, no model calls.
 */
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  MAX_UNFINISHED_PRS,
  rankEligibleWork,
} from "../../src/repair/selection.ts";
import { SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";
import { repairConfigs } from "./helpers.ts";

const NOW = T0 + 60_000;

function snapshot(
  work: WorkRecordV1[],
  extra: Partial<RepairStateSnapshotV1> = {},
): RepairStateSnapshotV1 {
  return {
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
    ...extra,
  };
}

function work(id: string, overrides: Record<string, unknown> = {}) {
  return workRecord(id, overrides);
}

Deno.test("selection: delivery bookkeeping outranks new incident work", () => {
  const delivery = work("issue-1", {
    nextStep: "delivery",
    target: { base: SHA1, branch: "b", checkpoint: null, head: SHA2, pr: 7 },
  });
  const incident = work("incident-2", {
    source: { kind: "incident", id: "inc-2", revision: SHA2 },
    related: { incidentId: "inc-2", issueNumber: null },
    fingerprint: "d".repeat(64),
    urgency: {
      activeProduction: true,
      reproducible5xx: false,
      severeSecurityOrDataLoss: false,
    },
  });
  const ranked = rankEligibleWork(
    snapshot([delivery, incident]),
    repairConfigs(),
    NOW,
  );
  assert.deepEqual(ranked.ordered, [delivery.id, incident.id]);
});

Deno.test("selection: delivery updates use numeric ordering across digit boundaries", () => {
  const updatedNine = work("delivery-9", {
    nextStep: "delivery",
    createdAt: 0,
    updatedAt: 9,
  });
  const updatedTen = work("delivery-10", {
    nextStep: "delivery",
    createdAt: 0,
    updatedAt: 10,
  });
  const ranked = rankEligibleWork(
    snapshot([updatedTen, updatedNine]),
    repairConfigs(),
    NOW,
  );
  assert.deepEqual(ranked.ordered, [updatedNine.id, updatedTen.id]);
});

Deno.test("selection: active incidents by severity then oldest first seen", () => {
  const p0 = work("incident-p0", {
    source: { kind: "incident", id: "p0", revision: SHA2 },
    related: { incidentId: "p0", issueNumber: null },
    fingerprint: "a".repeat(64),
    classification: { severity: "P0", priority: null },
    urgency: {
      activeProduction: true,
      reproducible5xx: false,
      severeSecurityOrDataLoss: false,
    },
    firstSeenAt: T0 + 100,
  });
  const p1 = work("incident-p1", {
    source: { kind: "incident", id: "p1", revision: SHA2 },
    related: { incidentId: "p1", issueNumber: null },
    fingerprint: "b".repeat(64),
    classification: { severity: "P1", priority: null },
    urgency: {
      activeProduction: true,
      reproducible5xx: false,
      severeSecurityOrDataLoss: false,
    },
    firstSeenAt: T0,
  });
  const ranked = rankEligibleWork(snapshot([p1, p0]), repairConfigs(), NOW);
  assert.deepEqual(ranked.ordered, [p0.id, p1.id]);
});

Deno.test("selection: P0/P1 correction ranks before reproducible 5xx and backlog", () => {
  const p1 = work("issue-p1", {
    source: { kind: "issue", id: "p1", revision: SHA2 },
    classification: { severity: "P1", priority: null },
    urgency: {
      activeProduction: false,
      reproducible5xx: false,
      severeSecurityOrDataLoss: false,
    },
  });
  const fivexx = work("issue-5xx", {
    source: { kind: "issue", id: "5xx", revision: SHA2 },
    classification: { severity: "P2", priority: null },
    urgency: {
      activeProduction: false,
      reproducible5xx: true,
      severeSecurityOrDataLoss: false,
    },
  });
  const backlog = work("issue-1", {
    source: { kind: "issue", id: "1", revision: SHA2 },
    classification: { severity: "P3", priority: 42 },
  });
  const ranked = rankEligibleWork(
    snapshot([backlog, fivexx, p1]),
    repairConfigs(),
    NOW,
  );
  assert.deepEqual(ranked.ordered, [p1.id, fivexx.id, backlog.id]);
});

Deno.test("selection: numeric priority descending, missing priority last", () => {
  const high = work("issue-7", {
    source: { kind: "issue", id: "7", revision: SHA2 },
    classification: { severity: "P2", priority: 7 },
    firstSeenAt: T0 + 200,
  });
  const low = work("issue-3", {
    source: { kind: "issue", id: "3", revision: SHA2 },
    classification: { severity: "P2", priority: 3 },
    firstSeenAt: T0,
  });
  const none = work("issue-0", {
    source: { kind: "issue", id: "0", revision: SHA2 },
    classification: { severity: "P2", priority: null },
    firstSeenAt: T0 + 50,
  });
  const ranked = rankEligibleWork(
    snapshot([none, low, high]),
    repairConfigs(),
    NOW,
  );
  assert.deepEqual(ranked.ordered, [high.id, low.id, none.id]);
});

Deno.test("selection: priority ordering supports contract-safe values above one million", () => {
  const maximum = work("issue-maximum", {
    classification: { severity: "P2", priority: Number.MAX_SAFE_INTEGER },
  });
  const aboveMillion = work("issue-1000002", {
    classification: { severity: "P2", priority: 1_000_002 },
  });
  const millionAndOne = work("issue-1000001", {
    classification: { severity: "P2", priority: 1_000_001 },
  });
  const minimum = work("issue-minimum", {
    classification: { severity: "P2", priority: 1 },
  });
  const none = work("issue-missing", {
    classification: { severity: "P2", priority: null },
  });
  const ranked = rankEligibleWork(
    snapshot([none, millionAndOne, maximum, minimum, aboveMillion]),
    repairConfigs(),
    NOW,
  );
  assert.deepEqual(ranked.ordered, [
    maximum.id,
    aboveMillion.id,
    millionAndOne.id,
    minimum.id,
    none.id,
  ]);
});

Deno.test("selection: stable repository/source tie-break, never selection by list order", () => {
  const a = work("issue-1", {
    source: { kind: "issue", id: "a", revision: SHA2 },
    classification: { severity: "P3", priority: 1 },
    firstSeenAt: T0,
  });
  const b = work("issue-2", {
    source: { kind: "issue", id: "b", revision: SHA2 },
    classification: { severity: "P3", priority: 1 },
    firstSeenAt: T0 + 1,
  });
  const ranked = rankEligibleWork(snapshot([b, a]), repairConfigs(), NOW);
  assert.deepEqual(ranked.ordered, [a.id, b.id]);
});

Deno.test("selection: waiting, blocked, terminal and dependency records are skipped", () => {
  const waiting = work("issue-9", {
    source: { kind: "issue", id: "9", revision: SHA2 },
    nextStep: "review",
    wait: { reason: "review_pending", since: T0, until: NOW + 1000 },
    target: { base: SHA1, branch: "b", checkpoint: null, head: SHA2, pr: 7 },
  });
  const blocked = work("issue-8", {
    source: { kind: "issue", id: "8", revision: SHA2 },
    nextStep: "blocked",
    blocker: {
      kind: "missing_evidence",
      message: "missing fixture",
      since: T0,
    },
  });
  const done = work("issue-7", {
    source: { kind: "issue", id: "7", revision: SHA2 },
    nextStep: "done",
  });
  const dependent = work("issue-6", {
    source: { kind: "issue", id: "6", revision: SHA2 },
    dependencies: ["issue-5"],
    classification: { severity: "P1", priority: null },
  });
  const eligible = work("issue-1", {
    source: { kind: "issue", id: "1", revision: SHA2 },
    classification: { severity: "P2", priority: 5 },
  });
  const ranked = rankEligibleWork(
    snapshot([waiting, blocked, done, dependent, eligible]),
    repairConfigs(),
    NOW,
  );
  assert.deepEqual(ranked.ordered, [eligible.id]);
  assert.equal(ranked.skipped[waiting.id], "waiting");
  assert.equal(ranked.skipped[blocked.id], "blocked");
  assert.equal(ranked.skipped[done.id], "terminal");
  assert.equal(ranked.skipped[dependent.id], "dependency");
});

Deno.test("selection: WIP cap skips fresh publications at three unfinished PRs", () => {
  const fresh = work("issue-1", {
    source: { kind: "issue", id: "1", revision: SHA2 },
    classification: { severity: "P2", priority: 9 },
  });
  const prs = Array.from(
    { length: MAX_UNFINISHED_PRS },
    (_, index) =>
      work(`issue-${index + 10}`, {
        source: { kind: "issue", id: `${index + 10}`, revision: SHA2 },
        nextStep: "review",
        wait: { reason: "review_pending", since: T0, until: NOW + 100000 },
        target: {
          base: SHA1,
          branch: "b",
          checkpoint: null,
          head: SHA2 as GitSha,
          pr: index + 20,
        },
      }),
  );
  const ranked = rankEligibleWork(
    snapshot([fresh, ...prs]),
    repairConfigs(),
    NOW,
  );
  assert.deepEqual(ranked.ordered, []);
  assert.equal(ranked.skipped[fresh.id], "wip");
});

Deno.test("selection: an existing-PR correction is never WIP-skipped", () => {
  const correction = work("issue-1", {
    source: { kind: "issue", id: "1", revision: SHA2 },
    classification: { severity: "P2", priority: 9 },
    nextStep: "work",
    target: {
      base: SHA1,
      branch: "b",
      checkpoint: null,
      head: SHA2 as GitSha,
      pr: 7,
    },
  });
  const prs = Array.from(
    { length: MAX_UNFINISHED_PRS },
    (_, index) =>
      work(`issue-${index + 10}`, {
        source: { kind: "issue", id: `${index + 10}`, revision: SHA2 },
        nextStep: "review",
        wait: { reason: "review_pending", since: T0, until: NOW + 100000 },
        target: {
          base: SHA1,
          branch: "b",
          checkpoint: null,
          head: SHA2 as GitSha,
          pr: index + 20,
        },
      }),
  );
  const ranked = rankEligibleWork(
    snapshot([correction, ...prs]),
    repairConfigs(),
    NOW,
  );
  assert.deepEqual(
    ranked.ordered,
    [correction.id],
    "the correction of an already-owned PR remains eligible at the cap",
  );
  assert.equal(ranked.skipped[correction.id], undefined);
});
