/**
 * Focused suite for the bounded issue-48 delivery observation.
 *
 * The one-shot is exercised credential-free against the ACTUAL production
 * repair/release GitStateStores over disposable local bare repositories, with a
 * fake GitHub reader. Fixtures are minimal sanitized records built through the
 * frozen parsers; no production snapshot, token, path or private payload is
 * committed or read.
 */
import assert from "node:assert/strict";

import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import type {
  RepairStateWriter,
  StateReadView,
} from "../../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { parseHostedReleaseRecordV1 } from "../../src/contracts/hosted-supervisor.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { releaseRequestId } from "../../src/repair/keys.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
} from "../../src/state/mod.ts";
import {
  buildIssue48ReleaseRequest,
  isHardDeliveryFailure,
  revisionIntegratedIntoBase,
  runIssue48DeliveryObservation,
} from "../../ops/issue48-delivery-observation.ts";
import type {
  Issue48DeliveryGitHubV1,
  Issue48DeliveryMergeV1,
  Issue48DeliveryResultV1,
} from "../../ops/issue48-delivery-observation.ts";
import { makeRemoteCtx, reviewReceipt, SHA1, T0 } from "../state/helpers.ts";

/** The exact self scope-0 repository identity the deployment uses. */
const SELF_REPO = {
  owner: "ubiquity",
  name: "sentinel",
  installationId: 0,
} as const;

const HEAD = "ae6ff044280a04803958fcd1f6f9304bb894249e" as GitSha;
const BASE = "f1b5a86b80ca4759ab37307484b223907bd1b1d6" as GitSha;
const MERGE = "9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293" as GitSha;
const TARGET = "issue-ubiquity-sentinel-48" as WorkItemId;
const RECEIPT_ID = `review-receipt:${"a".repeat(64)}`;

const ENV: Record<string, string> = {
  PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
  HOME: "/tmp",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "sentinel-test",
  GIT_AUTHOR_EMAIL: "sentinel-test@example.invalid",
  GIT_COMMITTER_NAME: "sentinel-test",
  GIT_COMMITTER_EMAIL: "sentinel-test@example.invalid",
};

function deliveryRecord(
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return parseWorkRecordV1({
    version: "v1",
    kind: "work",
    repository: SELF_REPO,
    id: TARGET,
    source: { kind: "issue", id: "48", revision: SHA1 },
    related: { incidentId: null, issueNumber: 48 },
    fingerprint: null,
    failingRevision: null,
    sourceSnapshotDigest: null,
    classification: { severity: "P2", priority: null },
    urgency: {
      activeProduction: false,
      reproducible5xx: false,
      severeSecurityOrDataLoss: false,
    },
    dependencies: [],
    controller: { sha: SHA1 },
    target: {
      base: BASE,
      branch: "sentinel/repair/issue-ubiquity-sentinel-48",
      checkpoint: null,
      head: HEAD,
      pr: 51,
    },
    nextStep: "delivery",
    wait: null,
    blocker: null,
    counters: { attempts: 4, retries: 0, reviewRounds: 12 },
    evidence: [{ kind: "review_receipt", ref: `artifact:${RECEIPT_ID}` }],
    intent: null,
    firstSeenAt: T0,
    createdAt: T0 + 100,
    updatedAt: T0 + 2000,
    ...overrides,
  });
}

function finding(severity: "P1" | "P2") {
  return {
    id: `github-review-1-finding-0`,
    fingerprint: "f".repeat(64),
    severity,
    path: "src/github/text.ts",
    message: `${severity} finding`,
    resolutionEvidence: null,
    resolved: false,
  };
}

function authorizingReceipt(overrides: Record<string, unknown> = {}) {
  return reviewReceipt(RECEIPT_ID, {
    repository: SELF_REPO,
    expectedReviewer: "github-actions[bot]",
    observedReviewer: "github-actions[bot]",
    pullRequest: { number: 51, head: HEAD, base: BASE },
    outcome: "completed",
    resultId: "msg_0123456789abcdef",
    completedAt: T0 + 3000,
    unresolvedSeverities: [],
    observedAt: T0 + 4000,
    ...overrides,
  });
}

function repairSnapshot(
  record: WorkRecordV1 = deliveryRecord(),
  reviews: unknown[] = [authorizingReceipt()],
  releaseRequests: unknown[] = [],
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: [record],
    reservations: [],
    reviews,
    replays: [],
    releaseRequests,
    githubCooldowns: [],
  });
}

function releaseSnapshot(
  hostedReleases: unknown[] = [],
): ReleaseStateSnapshotV1 {
  return parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    releases: [],
    hostedRuntimes: [],
    hostedReleases,
    githubCooldowns: [],
  });
}

function mergeFacts(
  overrides: Partial<Issue48DeliveryMergeV1> = {},
): Issue48DeliveryMergeV1 {
  return {
    pullRequestNumber: 51,
    state: "closed",
    merged: true,
    mergeCommitSha: MERGE,
    headSha: HEAD,
    baseRef: "development",
    author: "github-actions[bot]",
    parents: [BASE, HEAD],
    revisionOnBaseBranch: true,
    ...overrides,
  };
}

interface RigV1 {
  readonly tmp: string;
  readonly state: StateReadView & RepairStateWriter;
  readonly github: Issue48DeliveryGitHubV1["readMerge"];
  writes: number;
  writeRepair: ReturnType<typeof createRepairStateStore>["writeRepair"];
}

async function makeRig(
  prefix: string,
  options: {
    repair?: RepairStateSnapshotV1;
    release?: ReleaseStateSnapshotV1;
    merge?: Issue48DeliveryMergeV1 | null;
  } = {},
): Promise<RigV1> {
  const tmp = await Deno.makeTempDir({ prefix: `sentinel-${prefix}-` });
  const ctx = await makeRemoteCtx(tmp, ENV);
  const repair = createRepairStateStore({
    scratchDir: `${tmp}/repair`,
    remoteUrl: ctx.remoteUrl,
  });
  const release = createReleaseStateStore({
    scratchDir: `${tmp}/release`,
    remoteUrl: ctx.remoteUrl,
  });
  const repairSeed = await repair.writeRepair(
    options.repair ?? repairSnapshot(),
    null,
  );
  if (!repairSeed.ok || repairSeed.value.status !== "applied") {
    throw new Error(
      `repair fixture seed failed: ${JSON.stringify(repairSeed)}`,
    );
  }
  const releaseSeed = await release.writeRelease(
    options.release ?? releaseSnapshot(),
    null,
  );
  if (!releaseSeed.ok || releaseSeed.value.status !== "applied") {
    throw new Error(
      `release fixture seed failed: ${JSON.stringify(releaseSeed)}`,
    );
  }
  const rig: RigV1 = {
    tmp,
    state: {
      readRepair: () => repair.readRepair(),
      readRelease: () => release.readRelease(),
      writeRepair: (
        next: RepairStateSnapshotV1,
        expectedHead: GitSha | null,
      ) => {
        rig.writes++;
        return repair.writeRepair(next, expectedHead);
      },
    } as unknown as StateReadView & RepairStateWriter,
    github: () =>
      Promise.resolve(
        options.merge === null
          ? { ok: false as const }
          : { ok: true as const, value: options.merge ?? mergeFacts() },
      ),
    writes: 0,
    writeRepair: repair.writeRepair.bind(repair),
  };
  return rig;
}

async function run(
  rig: RigV1,
): Promise<Issue48DeliveryResultV1> {
  return await runIssue48DeliveryObservation({
    state: rig.state,
    github: { readMerge: rig.github },
    clock: { now: () => T0 + 5000 },
  });
}

Deno.test(
  "issue48 delivery observation: records the deterministic release request",
  async () => {
    const rig = await makeRig("delivery-applied");
    const result = await run(rig);
    assert.equal(result.status, "applied");
    assert.equal(result.reason, "applied");
    assert.equal(result.revision, MERGE);
    assert.equal(result.reviewReceiptId, RECEIPT_ID);
    assert.equal(rig.writes, 1);
    const read = await rig.state.readRepair();
    assert.ok(read.ok);
    if (!read.ok || read.value.status !== "found") throw new Error("missing");
    const requests = read.value.snapshot.releaseRequests;
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(
      request.id,
      await releaseRequestId(SELF_REPO, MERGE, 51),
    );
    assert.equal(request.revision, MERGE);
    assert.equal(request.status, "open");
    assert.equal(request.source.pullRequest, 51);
    assert.equal(request.source.head, HEAD);
    assert.equal(request.source.base, BASE);
    assert.equal(request.source.reviewReceiptId, RECEIPT_ID);
    assert.equal(request.source.reviewRequestId, `req-${RECEIPT_ID}`);
    assert.equal(request.target.environment, "production");
    // The runtime's own review authorization rule still holds for it.
    assert.deepEqual(
      request.source.base,
      read.value.snapshot.work[0].target.base,
    );
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "issue48 delivery observation: an already recorded delivery is never duplicated",
  async () => {
    const existing = await buildIssue48ReleaseRequest(
      SELF_REPO,
      MERGE,
      HEAD,
      BASE,
      authorizingReceipt(),
      T0 + 2000,
    );
    if (existing === null) throw new Error("fixture request invalid");
    const rig = await makeRig("delivery-idempotent", {
      repair: repairSnapshot(deliveryRecord(), [authorizingReceipt()], [
        existing,
      ]),
    });
    const result = await run(rig);
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "already_recorded");
    assert.equal(rig.writes, 0);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "issue48 delivery observation: an unresolved P1 never authorizes delivery",
  async () => {
    const rig = await makeRig("delivery-p1", {
      repair: repairSnapshot(deliveryRecord(), [
        authorizingReceipt({
          findings: [finding("P1")],
          unresolvedSeverities: ["P1"],
        }),
      ]),
    });
    const result = await run(rig);
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "review_not_authorizing");
    assert.equal(rig.writes, 0);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "issue48 delivery observation: an unresolved P2 still authorizes delivery",
  async () => {
    const rig = await makeRig("delivery-p2", {
      repair: repairSnapshot(deliveryRecord(), [
        authorizingReceipt({
          findings: [finding("P2")],
          unresolvedSeverities: ["P2"],
        }),
      ]),
    });
    const result = await run(rig);
    assert.equal(result.status, "applied");
    assert.equal(rig.writes, 1);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "issue48 delivery observation: a receipt bound to another head never authorizes",
  async () => {
    const rig = await makeRig("delivery-other-head", {
      repair: repairSnapshot(deliveryRecord(), [
        authorizingReceipt({
          pullRequest: { number: 51, head: SHA1, base: BASE },
        }),
      ]),
    });
    const result = await run(rig);
    assert.equal(result.reason, "review_not_authorizing");
    assert.equal(rig.writes, 0);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "issue48 delivery observation: an unmerged or differently-headed pull request is not observed",
  async () => {
    const open = await makeRig("delivery-open", {
      merge: mergeFacts({ state: "open", merged: false }),
    });
    assert.equal((await run(open)).reason, "merge_not_observed");
    assert.equal(open.writes, 0);

    const otherHead = await makeRig("delivery-merge-head", {
      merge: mergeFacts({ headSha: SHA1 }),
    });
    assert.equal((await run(otherHead)).reason, "merge_not_observed");
    assert.equal(otherHead.writes, 0);

    const oneParent = await makeRig("delivery-merge-parents", {
      merge: mergeFacts({ parents: [BASE] }),
    });
    assert.equal((await run(oneParent)).reason, "merge_not_observed");
    assert.equal(oneParent.writes, 0);

    const foreignAuthor = await makeRig("delivery-merge-author", {
      merge: mergeFacts({ author: "someone-else" }),
    });
    assert.equal((await run(foreignAuthor)).reason, "merge_not_observed");
    assert.equal(foreignAuthor.writes, 0);

    const unreachable = await makeRig("delivery-merge-compare", {
      merge: mergeFacts({ revisionOnBaseBranch: false }),
    });
    assert.equal((await run(unreachable)).reason, "merge_not_observed");
    assert.equal(unreachable.writes, 0);

    const unreadable = await makeRig("delivery-merge-unreadable", {
      merge: null,
    });
    assert.equal((await run(unreadable)).reason, "merge_not_observed");
    assert.equal(unreadable.writes, 0);

    await Promise.all(
      [open, otherHead, oneParent, foreignAuthor, unreachable, unreadable].map(
        (rig) => Deno.remove(rig.tmp, { recursive: true }),
      ),
    );
  },
);

Deno.test(
  "issue48 delivery observation: a moved target identity is refused, never rebound",
  async () => {
    const rig = await makeRig("delivery-target", {
      repair: repairSnapshot(
        deliveryRecord({
          target: {
            base: BASE,
            branch: "sentinel/repair/issue-ubiquity-sentinel-48",
            checkpoint: null,
            head: HEAD,
            pr: 52,
          },
        }),
      ),
    });
    const result = await run(rig);
    assert.equal(result.reason, "target_precondition_mismatch");
    assert.equal(rig.writes, 0);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "issue48 delivery observation: a non-terminal hosted release defers the record",
  async () => {
    const pendingRequest = await buildIssue48ReleaseRequest(
      SELF_REPO,
      MERGE,
      HEAD,
      BASE,
      authorizingReceipt(),
      T0 + 2000,
    );
    if (pendingRequest === null) throw new Error("fixture request invalid");
    const rig = await makeRig("delivery-release", {
      release: releaseSnapshot([
        parseHostedReleaseRecordV1({
          version: "v1",
          kind: "hosted_release",
          id: pendingRequest.id,
          request: pendingRequest,
          phase: "requested",
          priorRevision: BASE,
          priorProof: null,
          candidateProof: null,
          rollbackProof: null,
          pointerIntent: null,
          createdAt: T0 + 2500,
          updatedAt: T0 + 2500,
        }),
      ]),
    });
    const result = await run(rig);
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "release_not_terminal");
    assert.equal(rig.writes, 0);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "issue48 delivery observation: a missing target is a bounded skip",
  async () => {
    const absent = await makeRig("delivery-absent", {
      repair: parseRepairStateSnapshotV1({
        ...repairSnapshot(deliveryRecord(), [authorizingReceipt()]),
        work: [],
      }),
    });
    const absentResult = await run(absent);
    assert.equal(absentResult.reason, "target_missing");
    assert.equal(absent.writes, 0);
    await Deno.remove(absent.tmp, { recursive: true });

    assert.equal(isHardDeliveryFailure("write_conflict"), false);
    assert.equal(isHardDeliveryFailure("merge_not_observed"), false);
    assert.equal(isHardDeliveryFailure("identity_rejected"), true);
    assert.equal(isHardDeliveryFailure("unexpected_failure"), true);
  },
);

Deno.test(
  "issue48 delivery observation: integration evidence mirrors the runtime verifier",
  () => {
    const revision = MERGE;
    const shape = (status: string, baseSha: string, mergeSha: string) => ({
      status,
      base_commit: { sha: baseSha },
      merge_base_commit: { sha: mergeSha },
      ahead_by: status === "identical" ? 0 : 3,
      behind_by: 0,
      total_commits: status === "identical" ? 0 : 3,
    });
    assert.equal(
      revisionIntegratedIntoBase(shape("ahead", revision, revision), revision),
      true,
    );
    assert.equal(
      revisionIntegratedIntoBase(
        shape("identical", revision, revision),
        revision,
      ),
      true,
    );
    assert.equal(
      revisionIntegratedIntoBase(shape("behind", revision, revision), revision),
      false,
    );
    assert.equal(
      revisionIntegratedIntoBase(
        shape("diverged", revision, revision),
        revision,
      ),
      false,
    );
    assert.equal(
      revisionIntegratedIntoBase(shape("ahead", SHA1, revision), revision),
      false,
    );
    assert.equal(
      revisionIntegratedIntoBase(shape("ahead", revision, SHA1), revision),
      false,
    );
    assert.equal(revisionIntegratedIntoBase(null, revision), false);
    assert.equal(
      revisionIntegratedIntoBase({ status: "ahead" }, revision),
      false,
    );
  },
);
