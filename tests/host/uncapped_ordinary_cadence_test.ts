/**
 * Uncapped ordinary-work cadence (owner update 2026-10-02T22:05:51Z: "lift all
 * the limits"). This lane ports the validated m19 cadence change onto the
 * protected launcher: the supervisor used to stamp
 * `nextOrdinaryAt = now + HOUR_MS`, so ordinary runtime work was deferred for a
 * full hour even though the dispatch workflow runs every five minutes. That
 * cooldown — not any platform limit — was what capped useful issue work per
 * hour.
 *
 * These cases drive the REAL protected `runHostedSupervisorPrepare` /
 * `runHostedSupervisorFinalize` core over an in-memory release-role store and
 * injected evidence only: no Git, network, model, GitHub or deployment call
 * exists here. The protected recovery paths (model-disabled verification for a
 * missing health proof, same-run replay and active-execution ownership) are
 * exercised through the same real production entrypoints.
 *
 * RED before the port: five minutes after a healthy run the next dispatch was
 * still `idle` because `nextOrdinaryAt` sat an hour ahead, and a legacy
 * persisted future timestamp deferred ordinary work even longer.
 */
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import { parseHostedRunProofV1 } from "../../src/contracts/hosted-supervisor.ts";
import type {
  HostedExecutionIntentV1,
  HostedExecutionSettlementV1,
} from "../../src/contracts/hosted-supervisor.ts";
import type {
  Clock,
  PortResultV1,
  ReleaseStateWriter,
  StateReadResultV1,
  StateReadView,
  StateWriteResultV1,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import {
  runHostedSupervisorFinalize,
  runHostedSupervisorPrepare,
} from "../../src/host/actions-supervisor.ts";
import type {
  HostedSupervisorEvidencePortV1,
  HostedSupervisorInputV1,
  HostedSupervisorOutcomeV1,
} from "../../src/host/actions-supervisor.ts";

const LAUNCHER = "1".repeat(40) as GitSha;
const DIGEST = "d".repeat(64);
const HOUR_MS = 3_600_000;
const DISPATCH_MS = 5 * 60_000;

class FakeClock implements Clock {
  constructor(private current: number) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

/** In-memory release-role store with the real fail-closed CAS shape. */
class MemoryReleaseState implements StateReadView, ReleaseStateWriter {
  private snapshot: ReleaseStateSnapshotV1 | null = null;
  private head: GitSha | null = null;
  private counter = 0;

  private nextHead(): GitSha {
    this.counter++;
    return this.counter.toString(16).padStart(40, "0") as GitSha;
  }

  readRepair(): Promise<
    PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
  > {
    return Promise.resolve(portOk({
      status: "absent" as const,
      currentHead: null,
      ref: "refs/heads/sentinel-state/repair",
    }));
  }

  readRelease(): Promise<
    PortResultV1<StateReadResultV1<ReleaseStateSnapshotV1>>
  > {
    const snapshot = this.snapshot;
    if (snapshot === null) {
      return Promise.resolve(portOk({
        status: "absent" as const,
        currentHead: this.head,
        ref: "refs/heads/sentinel-state/release",
      }));
    }
    return Promise.resolve(portOk({
      status: "found" as const,
      snapshot,
      head: this.head ?? LAUNCHER,
      ref: "refs/heads/sentinel-state/release",
    }));
  }

  writeRelease(
    next: ReleaseStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    if (this.head !== expectedHead) {
      return Promise.resolve(portOk({
        status: "conflict" as const,
        currentHead: this.head,
      }));
    }
    let parsed: ReleaseStateSnapshotV1;
    try {
      parsed = parseReleaseStateSnapshotV1(next);
    } catch {
      return Promise.resolve(portError("invalid", "invalid snapshot"));
    }
    const head = this.nextHead();
    this.snapshot = parsed;
    this.head = head;
    return Promise.resolve(portOk({
      status: "applied" as const,
      head,
    }));
  }

  current(): ReleaseStateSnapshotV1 | null {
    return this.snapshot;
  }

  /** Test-side fixture seeding: a new valid snapshot at a fresh head. */
  seed(snapshot: ReleaseStateSnapshotV1): void {
    this.snapshot = parseReleaseStateSnapshotV1(snapshot);
    this.head = this.nextHead();
  }
}

class FakeEvidence implements HostedSupervisorEvidencePortV1 {
  readonly settlements = new Map<string, HostedExecutionSettlementV1 | null>();
  readonly revisions = new Set<string>();
  readonly matrixRevisions = new Set<string>();

  readExecution(
    savedIntent: HostedExecutionIntentV1,
  ): Promise<PortResultV1<HostedExecutionSettlementV1 | null>> {
    return Promise.resolve(
      portOk(this.settlements.get(savedIntent.id) ?? null),
    );
  }

  verifyRevision(revision: GitSha): Promise<PortResultV1<boolean>> {
    return Promise.resolve(portOk(this.revisions.has(revision)));
  }

  verifyMatrixOrdinaryRevision(
    revision: GitSha,
  ): Promise<PortResultV1<boolean>> {
    return Promise.resolve(portOk(this.matrixRevisions.has(revision)));
  }

  verifyRequest(): Promise<PortResultV1<boolean>> {
    return Promise.resolve(portOk(false));
  }
}

function runProof(intent: HostedExecutionIntentV1) {
  return parseHostedRunProofV1({
    execution: intent,
    workflowId: 357012162,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: "ubiquity/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: 7,
    startedAt: intent.createdAt + 1000,
    finishedAt: intent.createdAt + 2000,
    observedAt: intent.createdAt + 3000,
    outcome: "healthy",
    startupReady: true,
    settled: true,
    baseSha: intent.revision,
    terminalAt: intent.createdAt + 1500,
    logDigest: DIGEST,
  });
}

function requireRun(
  outcome: HostedSupervisorOutcomeV1,
): HostedExecutionIntentV1 {
  assert.equal(outcome.status, "run", JSON.stringify(outcome));
  if (outcome.status !== "run") throw new Error("expected a run decision");
  return outcome.execution;
}

interface RigV1 {
  clock: FakeClock;
  state: MemoryReleaseState;
  evidence: FakeEvidence;
  prepare(runId: number): Promise<HostedSupervisorOutcomeV1>;
  finalize(runId: number): Promise<HostedSupervisorOutcomeV1>;
}

function makeRig(): RigV1 {
  const clock = new FakeClock(1786000000000);
  const state = new MemoryReleaseState();
  const evidence = new FakeEvidence();
  evidence.revisions.add(LAUNCHER);
  evidence.matrixRevisions.add(LAUNCHER);
  const input = (runId: number): HostedSupervisorInputV1 => ({
    clock,
    state,
    run: { runId, runAttempt: 1, launcherSha: LAUNCHER },
    evidence,
  });
  return {
    clock,
    state,
    evidence,
    prepare: (runId) => runHostedSupervisorPrepare(input(runId)),
    finalize: (runId) => runHostedSupervisorFinalize(input(runId)),
  };
}

/** Bootstrap one generation-1 pointer and settle one healthy run. */
async function makeHealthyRig(): Promise<RigV1> {
  const rig = makeRig();
  const bootstrap = requireRun(await rig.prepare(1));
  assert.equal(bootstrap.purpose, "bootstrap");
  rig.evidence.settlements.set(bootstrap.id, runProof(bootstrap));
  assert.equal((await rig.finalize(1)).status, "idle");
  return rig;
}

Deno.test(
  "uncapped cadence: the next five-minute dispatch runs ordinary work with no hour cooldown",
  async () => {
    const rig = await makeHealthyRig();
    // The dispatch workflow fires every five minutes; only the artificial
    // cooldown could keep the next ordinary run idle at this point.
    rig.clock.advance(DISPATCH_MS);

    const outcome = await rig.prepare(2);
    assert.equal(outcome.status, "run", JSON.stringify(outcome));
    const ordinary = requireRun(outcome);
    assert.equal(ordinary.purpose, "ordinary");
    assert.equal(ordinary.revision, LAUNCHER);

    const runtime = rig.state.current()?.hostedRuntimes[0];
    assert.ok(runtime);
    assert.ok(
      runtime.nextOrdinaryAt <= ordinary.createdAt,
      `ordinary work is due immediately, got nextOrdinaryAt=${runtime.nextOrdinaryAt} at createdAt=${ordinary.createdAt}`,
    );
    assert.ok(
      runtime.nextOrdinaryAt < ordinary.createdAt + HOUR_MS,
      "the hour cooldown must be gone",
    );
  },
);

Deno.test(
  "uncapped cadence control: a settled current run/attempt never schedules a second execution",
  async () => {
    const rig = await makeHealthyRig();
    assert.equal((await rig.prepare(1)).status, "idle");
  },
);

Deno.test(
  "legacy ordinary: a persisted future hour cooldown no longer defers ordinary work",
  async () => {
    const rig = await makeHealthyRig();
    const healthy = rig.state.current();
    assert.ok(healthy !== null, "the healthy runtime state exists");
    if (healthy === null) throw new Error("unreachable");
    const runtime = healthy.hostedRuntimes[0];
    assert.ok(runtime, "one hosted runtime exists");
    assert.equal(runtime.execution, null, "no execution is active");
    assert.ok(runtime.lastHealthyProof !== null, "the runtime is healthy");

    // A legacy persisted pointer: the old implementation stamped
    // nextOrdinaryAt one hour into the future. Rewrite only that timestamp,
    // keeping the valid healthy/settled identity of the runtime.
    const legacyFuture = rig.clock.now() + HOUR_MS;
    rig.state.seed(parseReleaseStateSnapshotV1({
      ...healthy,
      sequence: healthy.sequence + 1,
      updatedAt: rig.clock.now(),
      hostedRuntimes: [{
        ...runtime,
        nextOrdinaryAt: legacyFuture,
        updatedAt: rig.clock.now(),
      }],
    }));
    assert.ok(
      legacyFuture > rig.clock.now(),
      "the seeded legacy cooldown is genuinely in the future",
    );

    // The legacy future timestamp must not defer ordinary work.
    const outcome = await rig.prepare(2);
    assert.equal(outcome.status, "run", JSON.stringify(outcome));
    const ordinary = requireRun(outcome);
    assert.equal(ordinary.purpose, "ordinary");
    assert.equal(ordinary.revision, LAUNCHER);

    // Active-ownership safeguards stay: the started execution is the only one,
    // a same-run replay is idempotent, and a different run cannot start a
    // second execution while it is active.
    const replay = requireRun(await rig.prepare(2));
    assert.equal(replay.id, ordinary.id, "same-run replay is idempotent");
    const active = await rig.prepare(3);
    assert.equal(active.status, "pending", JSON.stringify(active));
    const after = rig.state.current()?.hostedRuntimes[0];
    assert.equal(after?.execution?.id, ordinary.id);
  },
);

Deno.test(
  "uncapped cadence: a missing health proof plans model-disabled verification and ordinary work is due on the next dispatch",
  async () => {
    const rig = makeRig();
    // The only legally reachable runtime without a current health proof is the
    // first generation; the bootstrap verification must never become a
    // model-enabled ordinary run.
    const planned = requireRun(await rig.prepare(1));
    assert.notEqual(planned.purpose, "ordinary");
    assert.equal(planned.purpose, "bootstrap");
    assert.equal(planned.revision, LAUNCHER);
    let state = rig.state.current();
    assert.ok(state !== null);
    const bootstrapped = state.hostedRuntimes[0];
    assert.ok(bootstrapped);
    assert.ok(
      bootstrapped.nextOrdinaryAt <= rig.clock.now(),
      "no artificial cooldown is stamped at bootstrap",
    );
    assert.equal(bootstrapped.lastHealthyProof, null);
    assert.equal(bootstrapped.execution?.id, planned.id);

    // A healthy verification settles, and the very next dispatch is due for
    // ordinary work: the verification neither consumes nor defers the cadence.
    rig.evidence.settlements.set(planned.id, runProof(planned));
    const ordinary = requireRun(await rig.prepare(2));
    assert.equal(ordinary.purpose, "ordinary");
    assert.equal(ordinary.revision, LAUNCHER);
    state = rig.state.current();
    assert.ok(state !== null);
    assert.equal(
      state.hostedRuntimes[0].lastHealthyProof?.execution.id,
      planned.id,
    );
    assert.ok(state.hostedRuntimes[0].nextOrdinaryAt <= ordinary.createdAt);

    // Same-run replay is idempotent; an active execution still owns the
    // pointer against a different run.
    assert.equal(
      requireRun(await rig.prepare(2)).id,
      ordinary.id,
      "same-run replay is idempotent",
    );
    assert.equal((await rig.prepare(3)).status, "pending");
    assert.equal(
      rig.state.current()?.hostedRuntimes[0].execution?.id,
      ordinary.id,
    );
  },
);
