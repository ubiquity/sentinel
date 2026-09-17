/**
 * Focused suite for the one-shot hosted issue-48 review-quota recovery.
 *
 * The runner core is exercised credential-free against the ACTUAL production
 * repair GitStateStore over disposable local bare repositories. Fixtures are
 * minimal sanitized records built through the frozen parsers; no production
 * snapshot, token, path or private payload is committed or read. Tests inject
 * only the binding pins and the clock.
 */
import assert from "node:assert/strict";

import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { parseHostedRuntimeRecordV1 } from "../../src/contracts/hosted-supervisor.ts";
import type { HostedRuntimeRecordV1 } from "../../src/contracts/hosted-supervisor.ts";
import type {
  RepairStateWriter,
  StateReadView,
  StateWriteResultV1,
} from "../../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
  RELEASE_STATE_REF,
  REPAIR_STATE_REF,
} from "../../src/state/mod.ts";
import {
  buildNextQuotaSnapshot,
  ISSUE48_QUOTA_BLOCKER_PREFIX,
  ISSUE48_QUOTA_CANDIDATE_BLOCKER_PREFIX,
  runIssue48QuotaRecovery,
  targetPreconditionHolds,
  validateIssue48QuotaHostedIdentity,
} from "../../ops/issue48-review-quota-recovery.ts";
import type {
  Issue48QuotaRecoveryBindingV1,
  Issue48QuotaRecoveryResultV1,
} from "../../ops/issue48-review-quota-recovery.ts";
import {
  makeRemoteCtx,
  REPO,
  reservation,
  reviewReceipt,
  SHA1,
} from "../state/helpers.ts";

const T0 = 1_700_000_000_000;
const SHA_A = "a".repeat(40) as GitSha;
const HEAD = "ae6ff044280a04803958fcd1f6f9304bb894249e" as GitSha;
const BASE = "f1b5a86b80ca4759ab37307484b223907bd1b1d6" as GitSha;
const RUNTIME_REVISION = "87193550640078f190ab94d7f8ca0f00bbef9124" as GitSha;
const RUN_ID = "35173122742";
const LAUNCHER = "1a117931dd7047ed2c132ff0ae66d899074100e9" as GitSha;
const TARGET = "issue-ubiquity-sentinel-48" as WorkItemId;
const EVIDENCE_REF =
  "artifact:review-receipt/review-receipt:2e4e595978d5ca887abcad4a31b0ac94ea7d548227792f85b0d210078d3c1446";
const RECEIPT_ID =
  "review-receipt:2e4e595978d5ca887abcad4a31b0ac94ea7d548227792f85b0d210078d3c1446";

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

export function quotaWorkRecord(
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return parseWorkRecordV1({
    version: "v1",
    kind: "work",
    repository: REPO,
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
    nextStep: "blocked",
    wait: null,
    blocker: {
      kind: "review_quota",
      message:
        `${ISSUE48_QUOTA_BLOCKER_PREFIX} (structured review unavailable: a command execution item was malformed or contradictory)`,
      since: T0 + 1000,
    },
    counters: { attempts: 4, retries: 0, reviewRounds: 5 },
    evidence: [{ kind: "review_receipt", ref: EVIDENCE_REF }],
    intent: null,
    firstSeenAt: T0,
    createdAt: T0 + 100,
    updatedAt: T0 + 2000,
    ...overrides,
  });
}

function repairSnapshot(
  record: WorkRecordV1 = quotaWorkRecord(),
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
    reviews: [reviewReceipt(RECEIPT_ID)],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
  });
}

function repairSnapshotWithReservations(
  record: WorkRecordV1,
  reservations: { id: string; outcome: string }[],
): RepairStateSnapshotV1 {
  const base = repairSnapshot(record);
  return parseRepairStateSnapshotV1({
    ...base,
    reservations: reservations.map((item) =>
      reservation(item.id, {
        taskId: record.id,
        head: record.target.head,
        outcome: item.outcome,
      })
    ),
  });
}

function runtimeRecord(
  overrides: Partial<HostedRuntimeRecordV1> = {},
): HostedRuntimeRecordV1 {
  const revision = overrides.activeRevision ?? RUNTIME_REVISION;
  const generation = overrides.generation ?? 1;
  const proof = {
    execution: {
      id: `${RUN_ID}:1:repair`,
      runId: Number(RUN_ID),
      runAttempt: 1,
      launcherSha: LAUNCHER,
      purpose: "ordinary" as const,
      revision,
      generation,
      releaseId: null,
      createdAt: T0 + 500,
    },
    workflowId: 357012162,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: "ubiquity/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: 1,
    startedAt: T0 + 600,
    finishedAt: T0 + 700,
    observedAt: T0 + 800,
    outcome: "healthy" as const,
    startupReady: true,
    settled: true,
    baseSha: BASE,
    terminalAt: T0 + 700,
    logDigest: "d".repeat(64),
  };
  const parsed = parseHostedRuntimeRecordV1({
    version: "v1",
    kind: "hosted_runtime",
    id: "ubiquity/sentinel:0:production",
    activeRevision: revision,
    generation,
    lastHealthyProof: proof,
    lastExecutionProof: proof,
    nextOrdinaryAt: T0 + 100_000,
    execution: null,
    createdAt: T0,
    updatedAt: T0 + 900,
    ...overrides,
  });
  return parsed;
}

interface RigV1 {
  readonly tmp: string;
  readonly remoteUrl: string;
  readonly repair: ReturnType<typeof createRepairStateStore>;
  readonly release: ReturnType<typeof createReleaseStateStore>;
  readonly binding: Issue48QuotaRecoveryBindingV1;
  readonly state: StateReadView & RepairStateWriter;
  writes: number;
  repairHead: GitSha;
  releaseHead: GitSha;
}

async function makeRig(
  prefix: string,
  options: {
    repair?: RepairStateSnapshotV1;
    runtime?: HostedRuntimeRecordV1;
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
  const seed = options.repair ?? repairSnapshot();
  const created = await repair.writeRepair(seed, null);
  if (!created.ok || created.value.status !== "applied") {
    throw new Error(`repair fixture seed failed: ${JSON.stringify(created)}`);
  }
  const runtime = options.runtime ?? runtimeRecord();
  const bare = {
    ...runtime,
    execution: null,
    lastHealthyProof: null,
    lastExecutionProof: null,
    updatedAt: T0 + 1000,
  };
  const created0 = await release.writeRelease(
    parseReleaseStateSnapshotV1({
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0 + 1000,
      releases: [],
      hostedRuntimes: [bare],
      hostedReleases: [],
      githubCooldowns: [],
    }),
    null,
  );
  if (!created0.ok || created0.value.status !== "applied") {
    throw new Error(`release fixture seed failed: ${JSON.stringify(created0)}`);
  }
  const proof = runtime.lastHealthyProof;
  const proofExecution = proof === null ? null : proof.execution;
  const executing = {
    ...bare,
    execution: bare.execution ?? proofExecution,
    updatedAt: T0 + 1100,
  };
  const started = await release.writeRelease(
    parseReleaseStateSnapshotV1({
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: created0.value.head,
      sequence: 2,
      updatedAt: T0 + 1100,
      releases: [],
      hostedRuntimes: [executing],
      hostedReleases: [],
      githubCooldowns: [],
    }),
    created0.value.head,
  );
  if (!started.ok || started.value.status !== "applied") {
    throw new Error(`release fixture seed failed: ${JSON.stringify(started)}`);
  }
  const settledRuntime = proof === null ? executing : {
    ...bare,
    execution: null,
    lastHealthyProof: proof,
    lastExecutionProof: proof,
    updatedAt: T0 + 1200,
  };
  const released = await release.writeRelease(
    parseReleaseStateSnapshotV1({
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: started.value.head,
      sequence: 3,
      updatedAt: T0 + 1200,
      releases: [],
      hostedRuntimes: [settledRuntime],
      hostedReleases: [],
      githubCooldowns: [],
    }),
    started.value.head,
  );
  if (!released.ok || released.value.status !== "applied") {
    throw new Error(`release fixture seed failed: ${JSON.stringify(released)}`);
  }
  let releaseHead = released.value.head;
  // A caller-supplied in-flight execution is a further legal write after the
  // settlement: the pointer keeps its settled proofs and starts one new
  // execution, exactly as the live supervisor does.
  const inFlight = options.runtime?.execution ?? null;
  if (inFlight !== null) {
    const running = await release.writeRelease(
      parseReleaseStateSnapshotV1({
        version: "v1",
        kind: "release_state_snapshot",
        stateHead: releaseHead,
        sequence: 4,
        updatedAt: T0 + 1300,
        releases: [],
        hostedRuntimes: [{
          ...settledRuntime,
          execution: inFlight,
          updatedAt: T0 + 1300,
        }],
        hostedReleases: [],
        githubCooldowns: [],
      }),
      releaseHead,
    );
    if (!running.ok || running.value.status !== "applied") {
      throw new Error(
        `release fixture seed failed: ${JSON.stringify(running)}`,
      );
    }
    releaseHead = running.value.head;
  }
  const rig: RigV1 = {
    tmp,
    remoteUrl: ctx.remoteUrl,
    repair,
    release,
    binding: {
      targetId: TARGET,
      counters: { attempts: 4, retries: 0, reviewRounds: 5 },
      grantedImplementationAttempts: 1,
      evidenceRef: EVIDENCE_REF,
      reviewIds: [RECEIPT_ID],
      pullRequestNumber: 51,
      pullRequestHead: HEAD,
      pullRequestBase: BASE,
      repository: "ubiquity/sentinel",
      runtimeId: "ubiquity/sentinel:0:production",
      runtimeRevision: RUNTIME_REVISION,
      runtimeGeneration: 1,
    },
    state: {
      readRepair: () => repair.readRepair(),
      readRelease: () => release.readRelease(),
      writeRepair: (next, expectedHead) => {
        rig.writes++;
        return repair.writeRepair(next, expectedHead);
      },
    },
    writes: 0,
    repairHead: created.value.head,
    releaseHead,
  };
  return rig;
}

function runRig(
  rig: RigV1,
  overrides: {
    binding?: Partial<Issue48QuotaRecoveryBindingV1>;
    now?: number;
  } = {},
): Promise<Issue48QuotaRecoveryResultV1> {
  return runIssue48QuotaRecovery({
    state: rig.state,
    clock: { now: () => overrides.now ?? T0 + 10_000 },
    binding: { ...rig.binding, ...overrides.binding },
  });
}

async function cleanup(rig: RigV1): Promise<void> {
  await Deno.remove(rig.tmp, { recursive: true }).catch(() => {});
}

async function remoteHead(rig: RigV1, ref: string): Promise<string | null> {
  const result = await new Deno.Command("git", {
    args: ["ls-remote", rig.remoteUrl, ref],
    clearEnv: true,
    env: ENV,
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!result.success) return null;
  const line = new TextDecoder().decode(result.stdout).trim();
  return line === "" ? null : line.split(/\s+/)[0];
}

Deno.test(
  "issue48 review quota recovery: a blocked review-quota task returns to work with every charge preserved",
  async () => {
    const rig = await makeRig("quota-apply");
    try {
      const before = await rig.repair.readRepair();
      assert.ok(before.ok && before.value.status === "found");
      const result = await runRig(rig);
      assert.equal(result.status, "applied", JSON.stringify(result));
      assert.equal(result.reason, "applied");
      assert.equal(result.beforeHead, rig.repairHead);
      assert.notEqual(result.appliedHead, null);
      assert.equal(rig.writes, 1);

      const after = await rig.repair.readRepair();
      assert.ok(after.ok && after.value.status === "found");
      if (!after.ok || after.value.status !== "found") return;
      const record = after.value.snapshot.work[0]!;
      assert.equal(record.nextStep, "work");
      assert.equal(record.blocker, null);
      assert.equal(record.intent, null);
      // Exactly one implementation attempt is granted back; every other
      // counter, the evidence, the target and the accepted receipt survive.
      assert.deepEqual(record.counters, {
        attempts: rig.binding.counters.attempts - 1,
        retries: rig.binding.counters.retries,
        reviewRounds: rig.binding.counters.reviewRounds,
      });
      assert.deepEqual(record.target.head, HEAD);
      assert.deepEqual(record.target.base, BASE);
      assert.deepEqual(record.target.pr, 51);
      assert.equal(record.evidence.length, 1);
      assert.equal(record.evidence[0]!.ref, EVIDENCE_REF);
      assert.ok(after.value.snapshot.reviews.some((r) => r.id === RECEIPT_ID));
      // Only the target record and the snapshot metadata changed.
      const priorSnapshot = before.value.snapshot;
      assert.equal(after.value.snapshot.sequence, priorSnapshot.sequence + 1);
      assert.deepEqual(
        after.value.snapshot.reservations,
        priorSnapshot.reservations,
      );
      assert.deepEqual(after.value.snapshot.reviews, priorSnapshot.reviews);
      assert.equal(
        after.value.snapshot.updatedAt >= priorSnapshot.updatedAt,
        true,
      );
      // The release ref is untouched: this one-shot owns no release state.
      assert.equal(await remoteHead(rig, RELEASE_STATE_REF), rig.releaseHead);
      assert.equal(await remoteHead(rig, REPAIR_STATE_REF), result.appliedHead);
    } finally {
      await cleanup(rig);
    }
  },
);

Deno.test(
  "issue48 review quota recovery: a task still waiting at review is advanced the same way",
  async () => {
    const waiting = quotaWorkRecord({
      nextStep: "review",
      wait: { reason: "review_pending", since: T0 + 500, until: T0 + 5000 },
      blocker: null,
    });
    const rig = await makeRig("quota-waiting", {
      repair: repairSnapshot(waiting),
    });
    try {
      const result = await runRig(rig);
      assert.equal(result.status, "applied", JSON.stringify(result));
      const after = await rig.repair.readRepair();
      assert.ok(after.ok && after.value.status === "found");
      if (!after.ok || after.value.status !== "found") return;
      const recovered = after.value.snapshot.work[0]!;
      assert.equal(recovered.nextStep, "work");
      assert.equal(recovered.wait, null, "the wait is cleared with the block");
      assert.deepEqual(after.value.snapshot.work[0]!.counters, {
        attempts: rig.binding.counters.attempts - 1,
        retries: rig.binding.counters.retries,
        reviewRounds: rig.binding.counters.reviewRounds,
      });
    } finally {
      await cleanup(rig);
    }
  },
);

Deno.test(
  "issue48 review quota recovery: every drifted precondition is a zero-write refusal",
  async () => {
    const cases: {
      name: string;
      record?: Record<string, unknown>;
      binding?: Partial<Issue48QuotaRecoveryBindingV1>;
      runtime?: Partial<HostedRuntimeRecordV1>;
      reservations?: { id: string; outcome: string }[];
      expected: string;
    }[] = [
      {
        name: "candidate-failure-blocker-is-cleared",
        record: {
          blocker: {
            kind: "other",
            message:
              `${ISSUE48_QUOTA_CANDIDATE_BLOCKER_PREFIX}: implementation`,
            since: T0 + 1000,
          },
        },
        expected: "applied",
      },
      {
        name: "unrelated-other-blocker",
        record: {
          blocker: {
            kind: "other",
            message: "candidate preservation descriptor unavailable",
            since: T0 + 1000,
          },
        },
        expected: "target_precondition_mismatch",
      },
      {
        name: "granted-budget-outside-the-closed-set",
        binding: { grantedImplementationAttempts: 2 as unknown as 0 | 1 },
        expected: "target_precondition_mismatch",
      },
      {
        name: "counter-drift",
        record: { counters: { attempts: 4, retries: 0, reviewRounds: 4 } },
        expected: "target_precondition_mismatch",
      },
      {
        name: "different-blocker",
        record: {
          blocker: { kind: "unavailable", message: "other", since: T0 + 1000 },
        },
        expected: "target_precondition_mismatch",
      },
      {
        name: "blocker-message-not-the-quota-reason",
        record: {
          blocker: {
            kind: "review_quota",
            message: "repository not configured",
            since: T0 + 1000,
          },
        },
        expected: "target_precondition_mismatch",
      },
      {
        name: "open-intent",
        record: {
          intent: {
            kind: "merge",
            key: "merge:51:x",
            startedAt: T0 + 1000,
            branch: "sentinel/repair/issue-ubiquity-sentinel-48",
            expectedHead: HEAD,
            observedBase: BASE,
            pr: 51,
            requestId: "req",
            resultId: "res",
          },
        },
        expected: "target_precondition_mismatch",
      },
      {
        name: "moved-pr-head",
        record: {
          target: {
            base: BASE,
            branch: "sentinel/repair/issue-ubiquity-sentinel-48",
            checkpoint: null,
            head: SHA_A,
            pr: 51,
          },
        },
        expected: "target_precondition_mismatch",
      },
      {
        name: "missing-accepted-receipt",
        record: { evidence: [] },
        expected: "target_precondition_mismatch",
      },
      {
        name: "different-runtime-pointer",
        runtime: { activeRevision: SHA_A },
        expected: "runtime_mismatch",
      },
      {
        name: "in-flight-execution",
        runtime: {
          execution: {
            id: `${RUN_ID}:2:repair`,
            runId: Number(RUN_ID),
            runAttempt: 2,
            launcherSha: LAUNCHER,
            purpose: "ordinary",
            revision: RUNTIME_REVISION,
            generation: 1,
            releaseId: null,
            createdAt: T0 + 1000,
          },
        },
        expected: "runtime_mismatch",
      },
    ];
    for (const item of cases) {
      const rig = await makeRig(`quota-refuse-${item.name}`, {
        repair: repairSnapshotWithReservations(
          quotaWorkRecord(item.record ?? {}),
          item.reservations ?? [],
        ),
        runtime: item.runtime === undefined
          ? undefined
          : runtimeRecord(item.runtime),
      });
      try {
        const result = await runRig(rig, { binding: item.binding });
        if (item.expected === "applied") {
          assert.equal(
            result.status,
            "applied",
            `${item.name}: ${result.reason}`,
          );
          assert.equal(rig.writes, 1, item.name);
          continue;
        }
        assert.equal(result.status, "failed", `${item.name}: ${result.reason}`);
        assert.equal(result.reason, item.expected, item.name);
        assert.equal(rig.writes, 0, item.name);
        assert.equal(
          await remoteHead(rig, REPAIR_STATE_REF),
          rig.repairHead,
          item.name,
        );
      } finally {
        await cleanup(rig);
      }
    }
  },
);

Deno.test(
  "issue48 review quota recovery: an already advanced task is a zero-write skip",
  async () => {
    const rig = await makeRig("quota-skip", {
      repair: repairSnapshot(
        quotaWorkRecord({ nextStep: "work", blocker: null }),
      ),
    });
    try {
      const result = await runRig(rig);
      assert.equal(result.status, "skipped", JSON.stringify(result));
      assert.equal(result.reason, "already_recovered");
      assert.equal(rig.writes, 0);
      assert.equal(await remoteHead(rig, REPAIR_STATE_REF), rig.repairHead);
    } finally {
      await cleanup(rig);
    }
  },
);

Deno.test(
  "issue48 review quota recovery: a conflicting expected head never writes",
  async () => {
    const rig = await makeRig("quota-conflict");
    try {
      // The state moves BETWEEN the operator's read and its write: the
      // expected-head CAS must refuse and nothing may be overwritten.
      let moved = false;
      const racing: StateReadView & RepairStateWriter = {
        readRepair: async () => {
          const read = await rig.repair.readRepair();
          if (!moved && read.ok && read.value.status === "found") {
            moved = true;
            const advanced = await rig.repair.writeRepair(
              parseRepairStateSnapshotV1({
                ...read.value.snapshot,
                stateHead: read.value.head,
                sequence: read.value.snapshot.sequence + 1,
                updatedAt: T0 + 3000,
              }),
              read.value.head,
            );
            assert.ok(advanced.ok, JSON.stringify(advanced));
          }
          return read;
        },
        readRelease: () => rig.release.readRelease(),
        writeRepair: (next, expectedHead) =>
          rig.repair.writeRepair(next, expectedHead),
      };
      const result = await runIssue48QuotaRecovery({
        state: racing,
        clock: { now: () => T0 + 10_000 },
        binding: rig.binding,
      });
      assert.equal(result.status, "failed", JSON.stringify(result));
      assert.equal(result.reason, "write_conflict");
      const after = await rig.repair.readRepair();
      assert.ok(after.ok && after.value.status === "found");
      if (!after.ok || after.value.status !== "found") return;
      assert.equal(
        after.value.snapshot.work[0]!.nextStep,
        "blocked",
        "the racing recovery never mutated the record",
      );
    } finally {
      await cleanup(rig);
    }
  },
);

Deno.test(
  "issue48 review quota recovery: hosted identity is required and the clock must be sane",
  async () => {
    const base = {
      repository: "ubiquity/sentinel",
      ref: "refs/heads/sentinel-supervisor",
      job: "maintenance",
      runId: RUN_ID,
      runAttempt: "1",
      workflowRef:
        "ubiquity/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor",
      sha: LAUNCHER,
      workflowSha: LAUNCHER,
      checkoutHead: LAUNCHER,
      checkoutClean: true,
    };
    assert.ok(validateIssue48QuotaHostedIdentity(base).ok);
    assert.equal(
      validateIssue48QuotaHostedIdentity({ ...base, job: "prepare" }).ok,
      false,
    );
    assert.equal(
      validateIssue48QuotaHostedIdentity({ ...base, ref: "refs/heads/dev" }).ok,
      false,
    );
    assert.equal(
      validateIssue48QuotaHostedIdentity({ ...base, checkoutClean: false }).ok,
      false,
    );

    const rig = await makeRig("quota-clock");
    try {
      const result = await runRig(rig, { now: T0 });
      assert.equal(result.status, "failed", JSON.stringify(result));
      assert.equal(result.reason, "clock_invalid");
      assert.equal(rig.writes, 0);
    } finally {
      await cleanup(rig);
    }
  },
);

Deno.test(
  "issue48 review quota recovery: the transition preserves every other field by reference",
  () => {
    const record = quotaWorkRecord();
    const snapshot = repairSnapshot(record);
    const next = buildNextQuotaSnapshot(snapshot, TARGET, SHA_A, T0 + 5000, 1);
    assert.equal(next.stateHead, SHA_A);
    assert.equal(next.sequence, snapshot.sequence + 1);
    assert.equal(next.updatedAt, T0 + 5000);
    assert.deepEqual(next.reviews, snapshot.reviews);
    assert.deepEqual(next.reservations, snapshot.reservations);
    assert.deepEqual(next.releaseRequests, snapshot.releaseRequests);
    const updated = next.work[0]!;
    const {
      nextStep,
      wait,
      blocker,
      intent,
      counters,
      updatedAt,
      ...rest
    } = updated;
    const {
      nextStep: _n,
      wait: _w,
      blocker: _b,
      intent: _i,
      counters: _c,
      updatedAt: _u,
      ...priorRest
    } = record;
    assert.equal(nextStep, "work");
    assert.equal(wait, null);
    assert.equal(blocker, null);
    assert.equal(intent, null);
    assert.equal(updatedAt, T0 + 5000);
    assert.deepEqual(counters, { attempts: 3, retries: 0, reviewRounds: 5 });
    assert.equal(canonicalStringify(rest), canonicalStringify(priorRest));
    assert.ok(targetPreconditionHolds(record, {
      targetId: TARGET,
      counters: { attempts: 4, retries: 0, reviewRounds: 5 },
      grantedImplementationAttempts: 1,
      evidenceRef: EVIDENCE_REF,
      reviewIds: [RECEIPT_ID],
      pullRequestNumber: 51,
      pullRequestHead: HEAD,
      pullRequestBase: BASE,
      repository: "ubiquity/sentinel",
      runtimeId: "ubiquity/sentinel:0:production",
      runtimeRevision: RUNTIME_REVISION,
      runtimeGeneration: 1,
    }));
  },
);

Deno.test(
  "issue48 review quota recovery: applied results are reported only after a verified readback",
  async () => {
    const rig = await makeRig("quota-readback");
    try {
      const result = await runRig(rig);
      assert.equal(result.status, "applied");
      const after = await rig.repair.readRepair();
      assert.ok(after.ok && after.value.status === "found");
      if (!after.ok || after.value.status !== "found") return;
      assert.equal(after.value.head, result.appliedHead);
      assert.equal(
        after.value.snapshot.stateHead,
        result.beforeHead,
        "the written snapshot records the exact parent head",
      );
    } finally {
      await cleanup(rig);
    }
  },
);

Deno.test(
  "issue48 review quota recovery: write failures are typed and never retried",
  async () => {
    const rig = await makeRig("quota-write-failure");
    try {
      let calls = 0;
      const failing: StateReadView & RepairStateWriter = {
        readRepair: () => rig.repair.readRepair(),
        readRelease: () => rig.release.readRelease(),
        writeRepair: () => {
          calls++;
          return Promise.resolve({
            ok: false as const,
            error: { kind: "rate_limited" as const, detail: "synthetic" },
          }) as Promise<never>;
        },
      };
      const result = await runIssue48QuotaRecovery({
        state: failing as StateReadView & RepairStateWriter,
        clock: { now: () => T0 + 10_000 },
        binding: rig.binding,
      });
      assert.equal(result.status, "failed");
      assert.equal(result.reason, "write_rate_limited");
      assert.equal(calls, 1, "exactly one write attempt");
      assert.equal(await remoteHead(rig, REPAIR_STATE_REF), rig.repairHead);
    } finally {
      await cleanup(rig);
    }
  },
);

// The state field the runtime keeps after a successful write must validate.
Deno.test(
  "issue48 review quota recovery: the written snapshot passes the frozen parser",
  async () => {
    const rig = await makeRig("quota-parser");
    try {
      const result = await runRig(rig);
      assert.equal(result.status, "applied");
      const after = await rig.repair.readRepair();
      assert.ok(after.ok && after.value.status === "found");
      if (!after.ok || after.value.status !== "found") return;
      const parsed = parseRepairStateSnapshotV1(after.value.snapshot);
      assert.equal(
        canonicalStringify(parsed),
        canonicalStringify(after.value.snapshot),
      );
      const written: StateWriteResultV1 = {
        status: "applied",
        head: rig.repairHead,
      };
      assert.equal(written.status, "applied");
    } finally {
      await cleanup(rig);
    }
  },
);
