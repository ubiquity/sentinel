import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { GitHubQueueDeliveryClient } from "../../src/github/client-queue-delivery.ts";
import {
  createNativeQueueGuard,
  type NativeQueueGuardOptions,
} from "../../src/github/native-queue-guard.ts";
import { CHECK_POLL_MS } from "../../src/repair/loop-bounds.ts";
import {
  holdQueueRecord,
  queueRefusalIsTransient,
} from "../../src/repair/loop-queue-guard.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { GitHubBranchRuleWireV1 } from "../../src/github/wire.ts";
import { createQueueDeliveryReader } from "../../src/github/queue-delivery-reader.ts";
import { QUEUE_PROOF_POLICY } from "../../src/github/queue-runtime-policy.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { executePublishStep } from "../../src/repair/loop-publication.ts";
import {
  FakeAuthProvider,
  FakeCooldownGate,
  FakeGitExecutor,
  makePort,
} from "../../tests/github/helpers.ts";
import { r80Available, withR80Parsers } from "../host/r80-contracts.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "../../tests/repair/helpers.ts";
import {
  exactOpenPr,
  preservedIssueWork,
  PRODUCING_RESERVATION,
} from "../../tests/repair/loop-candidate-fixtures.ts";
import { seededSnapshot } from "../../tests/repair/loop-rig.ts";
import {
  reservation,
  SHA1,
  SHA2,
  SHA3,
  T0,
} from "../../tests/state/helpers.ts";
import { runHostedQueueCustody } from "../../ops/hosted-autonomy-queue-pass.ts";
import type { HostedAutonomyDepsV1 } from "../../ops/hosted-autonomy-types.ts";

function rig() {
  const record = preservedIssueWork("issue-1", SHA2);
  const state = new MemoryState();
  const clock = new FakeClock(T0 + 5_000);
  const github = new FakeGithub({
    baseSha: SHA1,
    candidateLifecycle: {
      refs: { [`refs/heads/${record.target.branch}`]: SHA2 },
      pullRequests: [exactOpenPr(7, SHA2, record.target.branch!)],
      prepareBaseRefresh: () => Promise.resolve(portOk(SHA2)),
    },
  });
  const configs = repairConfigs({
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 400_000 },
  });
  state.repair = seededSnapshot([record], {
    reservations: [reservation(PRODUCING_RESERVATION, {
      taskId: record.id,
      outcome: "submitted",
      settledAt: T0 + 1_000,
    })],
  });
  state.repairHead = SHA1;
  const deps = {
    state,
    clock,
    github,
    configs,
    model: new FakeModel(),
    controllerSha: SHA1,
    budget: new RollingStartBudget({ state, clock, configs }),
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    incidents: new FakeIncidents({ summaries: [] }),
    replay: new FakeReplay(),
  };
  const context = {
    snapshot: state.repair,
    head: SHA1,
    executionBaseline: record,
    bounds: {
      runDeadline: clock.now() + 3_600_000,
      modelCutoff: clock.now() + 3_600_000,
    },
  };
  return { record, state, clock, github, deps, context };
}

Deno.test("native dormant state read recovers without permanent custody", async () => {
  const r = rig();
  let ruleReads = 0;
  let queueReads = 0;
  const client = new GitHubQueueDeliveryClient({
    repository: r.record.repository,
    clock: r.clock,
    apiBaseUrl: "https://api.github.com",
    auth: new FakeAuthProvider(),
    cooldownGate: new FakeCooldownGate(),
    http: () => Promise.reject(new Error("No network is authorized")),
  }, null);
  client.readBranchRules = () => {
    ruleReads++;
    return Promise.resolve(portOk([]));
  };
  client.readQueuePull = () => {
    queueReads++;
    return Promise.resolve({ status: "unavailable", reason: "permission" });
  };
  const reader = createQueueDeliveryReader({
    repository: r.record.repository,
    clock: r.clock,
    client,
    policy: QUEUE_PROOF_POLICY,
  });
  const guard = createNativeQueueGuard({
    repository: r.record.repository,
    state: r.state,
    clock: r.clock,
    client,
    reader,
    policy: QUEUE_PROOF_POLICY,
    mode: "off",
    proofActivated: false,
  });
  r.github.nativeQueue = guard;
  const read = r.state.readRepair.bind(r.state);
  let failed = false;
  r.state.readRepair = () => {
    if (!failed) {
      failed = true;
      return Promise.resolve(
        portError("unavailable", "one transient state read"),
      );
    }
    return read();
  };
  const result = await executePublishStep(
    r.deps,
    r.context,
    r.record,
    r.deps.configs[0],
  );
  assert.deepEqual(result, { kind: "progress" });
  const held = r.state.repair!.work[0];
  assert.deepEqual(held.wait, {
    reason: "unavailable",
    since: r.clock.now(),
    until: r.clock.now() + CHECK_POLL_MS,
  });
  assert.deepEqual(held.target, r.record.target);
  assert.deepEqual(held.intent, r.record.intent);
  assert.deepEqual(held.counters, r.record.counters);
  assert.equal(r.github.pushes.length, 0);
  r.clock.advance(24 * 3_600_000);
  const afterRecovery = await guard.inspect({
    record: held,
    operation: "publication",
    deadline: r.clock.now() + 60_000,
  });
  let launcherQueueReads = 0;
  const never = () =>
    Promise.reject(new Error("Unexpected queue authority call"));
  const launcherDeps: HostedAutonomyDepsV1 = {
    state: r.state,
    clock: r.clock,
    githubFor: () => null,
    queue: {
      repository: r.record.repository,
      config: {
        mode: "off",
        proofActivated: false,
        appActor: null,
        probation: true,
      },
      readEffectiveQueueRule: () =>
        Promise.resolve({ status: "complete", value: false }),
      surface: {
        readQueue: () => {
          launcherQueueReads++;
          return Promise.resolve({
            status: "unavailable",
            reason: "permission",
          });
        },
        readPullMembership: never,
        readPullEvidence: never,
        enqueue: never,
        poll: never,
        dequeue: never,
      },
      authorization: { readAuthorization: never, readRemoval: never },
    },
  };
  const launcher = await runHostedQueueCustody(
    launcherDeps,
    r.clock.now() + 60_000,
  );
  assert.equal(
    afterRecovery.status,
    "allow",
    "A single transient state-read error must not create irreversible queue custody on the dormant path",
  );
  assert.equal(launcher.ready, true);
  assert.equal(launcherQueueReads, 0);
  assert.equal(queueReads, 0);
  assert.ok(ruleReads > 0);
  r.context.bounds.runDeadline = r.clock.now() + 3_600_000;
  r.context.bounds.modelCutoff = r.clock.now() + 3_600_000;
  const resumed = await executePublishStep(
    r.deps,
    r.context,
    held,
    r.deps.configs[0],
  );
  assert.equal(resumed.kind, "progress", JSON.stringify(resumed));
  assert.equal(r.state.repair!.work[0].target.pr, 7);
  assert.ok(ruleReads > 1, "resumption must re-read the effective rule");
});

function guardRig(
  overrides: Partial<Pick<NativeQueueGuardOptions, "mode" | "proofActivated">> =
    {},
) {
  const r = rig();
  const flags = { active: false, rules: 0, native: 0 };
  const client = new GitHubQueueDeliveryClient({
    repository: r.record.repository,
    clock: r.clock,
    apiBaseUrl: "https://api.github.com",
    auth: new FakeAuthProvider(),
    cooldownGate: new FakeCooldownGate(),
    http: () => Promise.reject(new Error("No network is authorized")),
  }, null);
  client.readBranchRules = () => {
    flags.rules++;
    return Promise.resolve(
      portOk(
        flags.active ? [{ type: "merge_queue" } as GitHubBranchRuleWireV1] : [],
      ),
    );
  };
  client.readQueuePull = () => {
    flags.native++;
    return Promise.resolve({ status: "unavailable", reason: "permission" });
  };
  const options: NativeQueueGuardOptions = {
    repository: r.record.repository,
    state: r.state,
    clock: r.clock,
    client,
    reader: createQueueDeliveryReader({
      repository: r.record.repository,
      clock: r.clock,
      client,
      policy: QUEUE_PROOF_POLICY,
    }),
    policy: QUEUE_PROOF_POLICY,
    mode: "off",
    proofActivated: false,
    ...overrides,
  };
  const guard = createNativeQueueGuard(options);
  r.github.nativeQueue = guard;
  return { ...r, options, flags, client, guard };
}

Deno.test("dormant guard temporary failures retry fresh state and rules without native permission", async (t) => {
  for (
    const failure of [
      "state_error",
      "state_throw",
      "state_absent",
      "deadline",
      "rule_throw",
      "rule_deadline",
      "final_error",
      "final_throw",
      "final_move",
    ] as const
  ) {
    await t.step(failure, async () => {
      const f = guardRig();
      const read = f.state.readRepair.bind(f.state);
      const rules = f.client.readBranchRules.bind(f.client);
      let reads = 0;
      f.state.readRepair = () => {
        reads++;
        if (
          (failure === "state_error" && reads === 1) ||
          (failure === "final_error" && reads === 2)
        ) {
          return Promise.resolve(
            portError("unavailable", "temporary state failure"),
          );
        }
        if (
          (failure === "state_throw" && reads === 1) ||
          (failure === "final_throw" && reads === 2)
        ) {
          return Promise.reject(new Error("temporary state failure"));
        }
        if (failure === "state_absent" && reads === 1) {
          return Promise.resolve(
            portOk({ status: "absent", currentHead: null, ref: null }),
          );
        }
        if (failure === "final_move" && reads === 2) f.state.repairHead = SHA3;
        return read();
      };
      f.client.readBranchRules = () => {
        if (failure === "rule_throw") {
          return Promise.reject(new Error("temporary rules failure"));
        }
        if (failure === "rule_deadline") f.clock.advance(60_000);
        return rules("development");
      };
      const first = await f.guard.inspect({
        record: f.record,
        operation: "publication",
        deadline: f.clock.now() + (failure === "deadline" ? 0 : 60_000),
      });
      assert.deepEqual(first, {
        status: "hold",
        reason: "inactive_observation_unavailable",
        pull: null,
      });
      assert.equal(f.github.pushes.length, 0);
      f.state.readRepair = read;
      f.client.readBranchRules = rules;
      f.clock.advance(CHECK_POLL_MS + 1);
      assert.deepEqual(
        await f.guard.inspect({
          record: f.state.repair!.work[0],
          operation: "publication",
          deadline: f.clock.now() + 60_000,
        }),
        { status: "allow", basis: "inactive_no_rule" },
      );
      assert.equal(f.flags.native, 0);
      assert.ok(f.flags.rules > 0);
    });
  }
});

Deno.test("dormant temporary wait uses CAS and preserves all charged work on conflicts", async (t) => {
  for (const movement of ["conflict", "moved"] as const) {
    await t.step(movement, async () => {
      const f = guardRig();
      let before = structuredClone(f.state.repair);
      const read = f.state.readRepair.bind(f.state);
      f.state.readRepair = () => {
        f.state.readRepair = read;
        if (movement === "moved") {
          f.state.repairHead = SHA3;
          f.state.repair = {
            ...f.state.repair!,
            work: [{ ...f.record, updatedAt: f.record.updatedAt + 1 }],
          };
          before = structuredClone(f.state.repair);
        }
        return Promise.resolve(portError("unavailable", "temporary failure"));
      };
      if (movement === "conflict") f.state.conflictRepairNext = true;
      const result = await executePublishStep(
        f.deps,
        f.context,
        f.record,
        f.deps.configs[0],
      );
      assert.equal(result.kind, "state_error");
      assert.deepEqual(f.state.repair, before);
      assert.equal(f.github.pushes.length, 0);
      assert.equal(f.deps.model.requests.length, 0);
    });
  }
});

Deno.test("activation and positive queue observations never receive a dormant retry refusal", async (t) => {
  for (
    const scenario of [
      "activated",
      "mode_on",
      "positive_rule_deadline",
      "positive_rule_throw",
      "final_custody",
    ] as const
  ) {
    await t.step(scenario, async () => {
      const f = guardRig({
        proofActivated: scenario === "activated",
        mode: scenario === "mode_on" ? "on" : "off",
      });
      const read = f.state.readRepair.bind(f.state);
      if (scenario === "activated" || scenario === "mode_on") {
        f.state.readRepair = () => Promise.reject(new Error("temporary read"));
      } else if (scenario === "final_custody") {
        let reads = 0;
        f.state.readRepair = () => {
          if (++reads === 2) {
            f.state.repair!.work[0] = {
              ...f.record,
              wait: { reason: "backoff", since: T0, until: null },
            };
            f.state.repairHead = SHA3;
          }
          return read();
        };
      } else {
        f.flags.active = true;
        const rules = f.client.readBranchRules.bind(f.client);
        f.client.readBranchRules = () => {
          if (scenario === "positive_rule_deadline") f.clock.advance(60_000);
          return rules("development");
        };
        f.client.readQueuePull = () =>
          Promise.reject(new Error("native unavailable after active rule"));
      }
      const result = await f.guard.inspect({
        record: f.record,
        operation: "publication",
        deadline: f.clock.now() + 60_000,
      });
      assert.equal(result.status, "hold");
      if (result.status === "hold") {
        assert.notEqual(result.reason, "inactive_observation_unavailable");
      }
    });
  }
});

Deno.test("a transient final-effect refusal cannot replace queue intent or provenance custody", async (t) => {
  for (const marker of ["intent", "provenance"] as const) {
    await t.step(marker, async () => {
      const f = guardRig();
      const record: WorkRecordV1 = marker === "intent"
        ? {
          ...f.record,
          intent: {
            kind: "merge",
            key: "merge-queue:v1:damaged",
            branch: f.record.target.branch,
            expectedHead: SHA2,
            observedBase: SHA1,
            pr: 7,
            startedAt: T0,
            requestId: null,
            resultId: "MQE_7",
          },
        }
        : {
          ...f.record,
          evidence: [...f.record.evidence, {
            kind: "review_receipt",
            ref: "artifact:review-receipt/merge-queue-v1/damaged",
          }],
        };
      f.state.repair!.work[0] = record;
      f.context.snapshot = f.state.repair!;
      const before = structuredClone(f.state.repair!);
      assert.equal(
        (await holdQueueRecord(f.deps, f.context, record, true)).kind,
        "progress",
      );
      assert.deepEqual(f.state.repair!.work[0], {
        ...record,
        wait: { reason: "backoff", since: f.clock.now(), until: null },
        updatedAt: f.clock.now(),
      });
      assert.deepEqual(f.state.repair!.reservations, before.reservations);
      const result = await f.guard.inspect({
        record: f.state.repair!.work[0],
        operation: "publication",
        deadline: f.clock.now() + 60_000,
      });
      assert.deepEqual(result, {
        status: "hold",
        reason: "custody",
        pull: null,
      });
      assert.equal(f.flags.rules, 0);
    });
  }
  assert.equal(
    queueRefusalIsTransient({
      detail: "native queue custody hold: inactive_observation_unavailable",
    }),
    true,
  );
  assert.equal(
    queueRefusalIsTransient({
      detail: "native queue custody hold: observation_unavailable",
    }),
    true,
  );
});

async function finalEffectFailure() {
  const f = guardRig();
  f.record = preservedIssueWork("issue-1", SHA2, {
    publishedHead: null,
    pr: null,
  });
  f.state.repair = { ...f.state.repair!, work: [f.record] };
  f.context.snapshot = f.state.repair;
  f.context.executionBaseline = f.record;
  const git = new FakeGitExecutor();
  const { port } = makePort({
    repository: f.record.repository,
    nativeQueue: f.guard,
    git,
    clock: f.clock,
  });
  const read = f.state.readRepair.bind(f.state);
  f.github.readRef = () => Promise.resolve(portOk(null));
  f.github.pushHead = (...args) => {
    f.state.readRepair = () => {
      f.state.readRepair = read;
      return Promise.resolve(
        portError("unavailable", "final effect state read"),
      );
    };
    return port.pushHead(...args);
  };
  const before = structuredClone(f.state.repair!);
  const result = await executePublishStep(
    f.deps,
    f.context,
    f.record,
    f.deps.configs[0],
  );
  assert.equal(result.kind, "progress");
  const held = f.state.repair!.work[0];
  assert.deepEqual(held.wait, {
    reason: "unavailable",
    since: f.clock.now(),
    until: f.clock.now() + CHECK_POLL_MS,
  });
  assert.equal(held.intent?.kind, "push");
  assert.deepEqual(held.target, before.work[0].target);
  assert.deepEqual(held.counters, before.work[0].counters);
  assert.deepEqual(f.state.repair!.reservations, before.reservations);
  assert.equal(git.pushes.length, 0);
  assert.equal(f.deps.model.requests.length, 0);
  return f.state.repair!;
}

Deno.test(
  "actual final native port refusal keeps a finite wait and the publication intent",
  async () => {
    await finalEffectFailure();
  },
);

Deno.test({
  name:
    "actual R80 parser accepts dormant retry wait and retained publication charge",
  ignore: !await r80Available(),
  fn: async () => {
    const snapshot = await finalEffectFailure();
    await withR80Parsers((r80) => {
      assert.deepEqual(r80.parseRepairStateSnapshotV1(snapshot), snapshot);
    });
  },
});
