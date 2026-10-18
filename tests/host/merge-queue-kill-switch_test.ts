import assert from "node:assert/strict";
import { createHostedQueueCoordinator } from "../../ops/hosted-autonomy-queue-host.ts";
import { runHostedQueueCustody } from "../../ops/hosted-autonomy-queue-pass.ts";
import type { HostedAutonomyGitHubV1 } from "../../ops/hosted-autonomy-types.ts";
import {
  createQueueIntent,
  parseQueueIntent,
} from "../../ops/hosted-autonomy-queue-intent.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { composeLocalGitHub } from "../../src/host/local-github.ts";
import {
  codexChildEnv,
  LocalSessionTracker,
} from "../../src/host/local-client.ts";
import { buildChildEnvironment } from "../../src/host/hosted-runtime-child.ts";
import { readHostedLauncherInputs } from "../../src/host/hosted-runtime-main.ts";
import {
  QUEUE_AUTHORITY_PINS,
  QUEUE_MODE_CEILING,
  QUEUE_PROOF_ACTIVATED,
  QUEUE_PROOF_POLICY,
} from "../../src/github/queue-runtime-policy.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { DEFAULT_APP_INSTALLATION_ID } from "../../src/host/actions-target-cycles.ts";
import { FakeClock, MemoryState } from "../repair/helpers.ts";
import {
  checkRunWire,
  FakeCooldownGate,
  issueWire,
  pullWire,
} from "../github/helpers.ts";
import {
  entryWire,
  membershipWire,
  pendingWire,
  response,
  snapshotWire,
} from "../github/merge-queue-fixtures.ts";
import {
  APP,
  queueProofFacts,
  SHA1,
  SHA2,
  SHA3,
  SHA4,
  T0,
} from "./merge-queue-proof-fixtures.ts";
import { reservation } from "../state/helpers.ts";
import { authorityRig } from "./merge-queue-authority-fixtures.ts";
import {
  AFTER_TREE,
  BEFORE_TREE,
  blob,
  compareWire,
  treeWire,
  WORKFLOW_BLOB,
  WORKFLOW_BYTES,
  WORKFLOW_PATH,
  WORKFLOW_SHA256,
} from "../github/queue-delivery-reader-fixtures.ts";

// These literal configurations stand for separately reviewed future source pins.
// No production environment value can supply this trusted construction argument.
type Source = {
  mode: "off" | "observe" | "on";
  proofActivated: boolean;
  policy: typeof QUEUE_PROOF_POLICY;
  pins: typeof QUEUE_AUTHORITY_PINS;
};
const dormantSource: Source = {
  mode: "on" as const,
  proofActivated: false,
  policy: QUEUE_PROOF_POLICY,
  pins: QUEUE_AUTHORITY_PINS,
};

async function factoryRig() {
  const facts = JSON.parse(
    JSON.stringify(await queueProofFacts()).replaceAll(
      '"installationId":42',
      `"installationId":${DEFAULT_APP_INSTALLATION_ID}`,
    ),
  ) as Awaited<ReturnType<typeof queueProofFacts>>;
  const clock = new FakeClock(T0 + 5000);
  const state = new MemoryState();
  state.repairHead = SHA1;
  state.repair = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    work: [facts.record],
    reviews: [facts.receipt],
    reservations: [reservation("charged", {
      taskId: facts.record.id,
      repository: facts.record.repository,
      outcome: "ambiguous",
      settledAt: T0,
    })],
    releaseRequests: [],
    incidents: [],
    evidence: [],
    replays: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
  const calls: string[] = [];
  let activeRule = false;
  let member = false;
  let admissionReady = false;
  let refuseAdmission = false;
  let moveStateHeadBeforeAdmissionResponse = false;
  let enqueues = 0;
  const accepted = await authorityRig();
  const acceptedSource: Source = {
    ...accepted.configuration,
    policy: { ...accepted.policy, workflowSha256: WORKFLOW_SHA256 },
  };
  const github = {
    ...accepted.github,
    readIssueTask: () => Promise.resolve(facts.task),
    readPull: async () => {
      const pull = await accepted.github.readPull(7, "development");
      assert.ok(pull);
      return { ...pull, baseSha: SHA1 };
    },
  };
  const http: HttpTransportV1 = (request) => {
    const path = new URL(request.url).pathname.replace(
      "/repos/ubiquity/ai.ubq.fi",
      "",
    );
    calls.push(`${request.method} ${path}`);
    let body: unknown;
    if (path === "/pulls/7/merge-async") {
      assert.equal(request.method, "PUT");
      assert.ok(admissionReady);
      assert.equal(state.repair!.work[0].wait?.until, null);
      assert.ok(
        state.repair!.work[0].intent?.key.startsWith("merge-queue:v1:"),
      );
      assert.equal(state.repair!.reservations[0].outcome, "ambiguous");
      enqueues++;
      if (moveStateHeadBeforeAdmissionResponse) state.repairHead = SHA3;
      if (refuseAdmission) return Promise.resolve(response({}, 403));
      return Promise.resolve(
        response(pendingWire({ merge_method: "merge" }), 202),
      );
    }
    if (path === "/rules/branches/development") {
      body = activeRule
        ? [{
          id: 1,
          type: "merge_queue",
          name: null,
          ruleset_source_type: "Repository",
          ruleset_source: "ubiquity/ai.ubq.fi",
          ruleset_id: 2,
          parameters: { merge_method: "MERGE" },
        }]
        : [];
    } else if (path === "/graphql") {
      const query = String(JSON.parse(request.body ?? "{}").query ?? "");
      const entry = member
        ? entryWire({ enqueuedAt: new Date(T0 + 2000).toISOString() })
        : null;
      if (query.includes("mergeQueue(")) {
        body = snapshotWire(member ? [entry] : []);
      } else if (query.includes("mergeQueue {")) {
        body = snapshotWire(member ? [entry] : []);
      } else if (query.includes("timelineItems")) {
        return Promise.resolve(response({}, 503));
      } else {body = membershipWire(entry, {
          baseRefOid: SHA1,
          author: {
            __typename: APP.type,
            id: APP.nodeId,
            login: "ubiquity-sentinel",
          },
          mergedBy: null,
        });}
    } else if (path === "/pulls/7") {
      body = pullWire({
        number: 7,
        state: "closed",
        head: { ref: facts.pull.headRef, sha: SHA2 },
        base: { ref: "development", sha: SHA1 },
        user: { login: APP.login },
        merged_at: "2026-09-07T02:00:00Z",
        merge_commit_sha: SHA4,
        merged_by: { type: APP.type, node_id: APP.nodeId, login: APP.login },
      });
    } else if (path === "/issues/1") {
      assert.ok(facts.task !== "unavailable" && facts.task !== null);
      body = issueWire({ ...facts.task, number: 1 });
    } else if (path.endsWith("/check-runs")) {
      body = {
        total_count: 4,
        check_runs: [
          "validate",
          "verify-artifact",
          "darwin-native",
          "mac-containment",
        ].map((name, index) =>
          checkRunWire({
            id: 90 + index,
            name,
            head_sha: SHA2,
            check_suite: { id: 85 },
            app: { id: 15368, slug: "github-actions" },
          })
        ),
      };
    } else if (path.endsWith("/statuses")) body = [];
    else if (path.startsWith("/git/commits/")) {
      const revision = path.slice("/git/commits/".length);
      body = {
        sha: revision,
        tree: { sha: revision === SHA1 ? BEFORE_TREE : AFTER_TREE },
      };
    } else if (
      path === `/git/trees/${BEFORE_TREE}` ||
      path === `/git/trees/${AFTER_TREE}`
    ) {
      const tree = path.slice("/git/trees/".length);
      body = treeWire(tree as typeof SHA1, [
        blob("src/fix.ts", tree === BEFORE_TREE ? SHA1 : SHA2),
        blob(WORKFLOW_PATH, WORKFLOW_BLOB),
      ]);
    } else if (path === `/git/blobs/${WORKFLOW_BLOB}`) {
      body = {
        sha: WORKFLOW_BLOB,
        encoding: "base64",
        size: WORKFLOW_BYTES.length,
        content: btoa(WORKFLOW_BYTES),
      };
    } else if (path === `/commits/${SHA4}`) {
      body = {
        sha: SHA4,
        parents: [{ sha: SHA3 }, { sha: SHA2 }],
        author: { type: APP.type, node_id: APP.nodeId, login: APP.login },
      };
    } else if (path === "/git/ref/heads/development") {
      body = {
        ref: "refs/heads/development",
        object: { sha: SHA4, type: "commit" },
      };
    } else if (path.startsWith("/compare/")) {
      const [base, head] = path.slice("/compare/".length).split("...");
      body = compareWire(
        base as typeof SHA1,
        base as typeof SHA1,
        base === head ? "identical" : "ahead",
      );
    } else return Promise.resolve(response({}, 503));
    assert.ok(
      request.method === "GET" || path === "/graphql",
      "no external mutation belongs in this fixture",
    );
    return Promise.resolve(response(body));
  };
  // Reflect keeps the regression executable on the pre-switch factory signature.
  const coordinator = (selector: unknown, source = dormantSource) =>
    Reflect.apply(createHostedQueueCoordinator, undefined, [{
      state,
      clock,
      token: "synthetic-app-token",
      githubFor: () => github,
      queueMode: selector,
      http,
    }, source]) as ReturnType<typeof createHostedQueueCoordinator>;
  const native = (selector: unknown, source = dormantSource) => {
    const root = `${Deno.cwd()}/.sentinel-artifacts/queue-switch-unused`;
    return (Reflect.apply(composeLocalGitHub, undefined, [{
      state,
      clock,
      http,
      gate: new FakeCooldownGate(),
      token: "synthetic-app-token",
      login: APP.login,
      invocationId: "switch-test",
      repository: facts.record.repository,
      baseBranch: "development",
      stateRoot: root,
      sourcePath: `${root}/source`,
      scratch: `${root}/scratch`,
      reviewCheckout: `${root}/review`,
      reviewClientHome: `${root}/client`,
      reviewTmpDir: `${root}/tmp`,
      reviewDenoDir: `${root}/deno`,
      trustedPath: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      codexExecutable: "/usr/bin/false",
      tracker: new LocalSessionTracker(),
      queueMode: selector,
    }, source]) as ReturnType<typeof composeLocalGitHub>).nativeQueue!;
  };
  return {
    facts,
    github,
    state,
    clock,
    calls,
    coordinator,
    native,
    acceptedSource,
    get enqueues() {
      return enqueues;
    },
    readyForAdmission: () => {
      admissionReady = true;
      activeRule = true;
    },
    refuseAdmission: (value: boolean) => {
      refuseAdmission = value;
    },
    moveStateHeadBeforeAdmissionResponse: (value: boolean) => {
      moveStateHeadBeforeAdmissionResponse = value;
    },
    setRule: (value: boolean) => {
      activeRule = value;
    },
    setMember: (value: boolean) => {
      member = value;
    },
  };
}

Deno.test("production queue factories apply the same lower-only selector under a future source ceiling", async (t) => {
  for (
    const [selector, expected] of [
      [undefined, "on"],
      ["", "on"],
      ["off", "off"],
      ["observe", "observe"],
      ["on", "on"],
      ["invalid", "off"],
      [" ON ", "off"],
      [" ", "off"],
    ] as const
  ) {
    await t.step(String(selector), async () => {
      const rig = await factoryRig();
      const queue = rig.coordinator(selector);
      assert.equal(queue.config.mode, expected);
      assert.equal(queue.config.proofActivated, false);
      const decision = await rig.native(selector).inspect({
        record: rig.state.repair!.work[0],
        operation: "publication",
        deadline: rig.clock.now() + 60000,
      });
      assert.equal(decision.status, "allow", JSON.stringify(decision));
      if (decision.status === "allow") {
        assert.equal(
          decision.basis,
          expected === "off" ? "inactive_no_rule" : "native_absent",
        );
      }
      const proof = await queue.resolveDelivery!({
        snapshot: rig.state.repair!,
        observedHead: SHA1,
        record: rig.state.repair!.work[0],
        expectedRevision: SHA4,
        purpose: "delivery",
      });
      assert.equal(
        proof.status === "legacy_direct",
        expected === "off",
        JSON.stringify(proof),
      );
    });
  }
});

Deno.test("current production ceiling cannot be raised and proof activation cannot be lowered", async () => {
  assert.equal(QUEUE_MODE_CEILING, "off");
  assert.equal(QUEUE_PROOF_ACTIVATED, false);
  const rig = await factoryRig();
  const production = Reflect.apply(createHostedQueueCoordinator, undefined, [{
    state: rig.state,
    clock: rig.clock,
    token: "synthetic-app-token",
    githubFor: () => null,
    queueMode: "on",
  }]) as ReturnType<typeof createHostedQueueCoordinator>;
  assert.equal(production.config.mode, "off");
  assert.equal(production.config.proofActivated, false);
  for (const selector of ["on", "observe", "off", "invalid", undefined]) {
    const source = { ...dormantSource, mode: "off" as const };
    assert.equal(rig.coordinator(selector, source).config.mode, "off");
    const activated = { ...dormantSource, proofActivated: true };
    const queue = rig.coordinator(selector, activated);
    assert.equal(queue.config.proofActivated, true);
    const proof = await queue.resolveDelivery!({
      snapshot: rig.state.repair!,
      observedHead: SHA1,
      record: rig.state.repair!.work[0],
      expectedRevision: SHA4,
      purpose: "delivery",
    });
    assert.notEqual(proof.status, "legacy_direct");
    const decision = await rig.native(selector, activated).inspect({
      record: rig.state.repair!.work[0],
      operation: "publication",
      deadline: rig.clock.now() + 60000,
    });
    assert.equal(decision.status, "allow");
    if (decision.status === "allow") {
      assert.equal(decision.basis, "native_absent");
    }
  }
});

Deno.test("factory restart with admission off retains actual native custody and the charged queue intent", async () => {
  const rig = await factoryRig();
  const source = { ...dormantSource, proofActivated: true };
  rig.setRule(true);
  rig.setMember(true);
  const intent = await createQueueIntent(
    rig.facts.record,
    rig.facts.binding,
    T0 + 2000,
  );
  rig.state.repair!.work[0] = {
    ...rig.facts.record,
    intent: { ...intent, resultId: "MQE_7" },
    wait: { reason: "backoff", since: T0 + 2000, until: null },
  };
  const before = structuredClone(rig.state.repair!);
  for (const selector of ["off", "observe", "invalid"]) {
    rig.clock.advance(24 * 3600000);
    const queue = rig.coordinator(selector, source);
    const result = await runHostedQueueCustody({
      state: rig.state,
      clock: rig.clock,
      githubFor: () => null,
      queue,
    }, rig.clock.now() + 60000);
    assert.equal(result.ready, true, result.actions.join(" "));
    assert.ok(result.protectedRecordIds.has(rig.facts.record.id));
    assert.deepEqual(rig.state.repair!.work, before.work);
    assert.deepEqual(rig.state.repair!.reservations, before.reservations);
    assert.deepEqual(rig.state.repair!.releaseRequests, []);
    const guard = rig.native(selector, source);
    assert.deepEqual(
      await guard.inspect({
        record: rig.state.repair!.work[0],
        operation: "merge",
        deadline: rig.clock.now() + 60000,
      }),
      { status: "hold", reason: "custody", pull: null },
    );
  }
  assert.ok(
    rig.calls.some((call) => call === "POST /graphql"),
    "a restarted off host must still observe native custody",
  );
  assert.ok(
    rig.calls.every((call) =>
      call.startsWith("GET ") || call === "POST /graphql"
    ),
  );
});

Deno.test("protected launcher forwards the selector only to the runtime host, not the model client", () => {
  for (
    const selector of ["off", "observe", "on", "invalid", " ", "", undefined]
  ) {
    const inputs = readHostedLauncherInputs((key) =>
      ({
        PATH: "/usr/bin",
        GITHUB_TOKEN: "synthetic",
        UOS_AI_TOKEN: "synthetic",
        SENTINEL_MERGE_QUEUE: selector,
      } as Record<string, string | undefined>)[key]
    );
    for (const job of ["repair", "matrix_plan", "matrix_cell"] as const) {
      const child = buildChildEnvironment(
        { ...inputs, GITHUB_OUTPUT: "/owned-output" },
        { runId: 1, runAttempt: 1, launcherSha: SHA1, job },
        { home: "/owned-home", tmp: "/owned-tmp", denoDir: "/owned-cache" },
        T0,
      );
      assert.equal(child.SENTINEL_MERGE_QUEUE, selector);
    }
  }
  const worker = codexChildEnv(
    "/owned-model",
    "/owned-model-tmp",
    "/owned-model-cache",
    "/usr/bin",
  );
  assert.equal(Object.hasOwn(worker, "SENTINEL_MERGE_QUEUE"), false);
});

Deno.test("workflow binds only the protected repository selector and keeps implementation model routing", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../../.github/workflows/supervisor.yml", import.meta.url),
  );
  assert.match(
    workflow,
    /^ {2}SENTINEL_MERGE_QUEUE: \$\{\{ vars\.SENTINEL_MERGE_QUEUE \}\}$/m,
  );
  const modelLines = workflow.split("\n").filter((line) =>
    line.trim().startsWith("SENTINEL_MODEL_ID:")
  );
  assert.equal(modelLines.length, 4);
  assert.ok(
    modelLines.every((line) =>
      line.trim() ===
        "SENTINEL_MODEL_ID: ${{ vars.SENTINEL_IMPLEMENTATION_MODEL_ID || 'gpt-6.1-sol' }}"
    ),
  );
  const maintenance = workflow.slice(
    workflow.indexOf("  maintenance:"),
    workflow.indexOf("  prepare:"),
  );
  assert.match(maintenance, /--allow-env=[^\n]*SENTINEL_MERGE_QUEUE/);
});

Deno.test("actual coordinator factory switches off after a real HTTP admission and preserves its pending charged intent", async () => {
  const rig = await factoryRig();
  rig.readyForAdmission();
  for (const selector of ["off", "observe", "invalid"]) {
    const queue = rig.coordinator(selector, rig.acceptedSource);
    const result = await runHostedQueueCustody({
      state: rig.state,
      clock: rig.clock,
      githubFor: () => null,
      queue,
    }, rig.clock.now() + 60000);
    assert.equal(result.ready, true, result.actions.join(" "));
    assert.equal(rig.enqueues, 0);
    assert.equal(rig.state.repair!.work[0].intent, null);
  }
  const queue = rig.coordinator("on", rig.acceptedSource);
  const started = await runHostedQueueCustody({
    state: rig.state,
    clock: rig.clock,
    githubFor: () => null,
    queue,
  }, rig.clock.now() + 60000);
  assert.equal(rig.enqueues, 1, started.actions.join(" "));
  assert.equal(started.ready, true, started.actions.join(" "));
  const charged = structuredClone(rig.state.repair!);
  for (const selector of ["off", "invalid", "observe"]) {
    rig.clock.advance(60_000);
    const restarted = rig.coordinator(selector, rig.acceptedSource);
    const result = await runHostedQueueCustody({
      state: rig.state,
      clock: rig.clock,
      githubFor: () => null,
      queue: restarted,
    }, rig.clock.now() + 60000);
    assert.equal(result.ready, true, result.actions.join(" "));
    assert.equal(rig.enqueues, 1);
    assert.deepEqual(rig.state.repair!.work, charged.work);
    assert.deepEqual(rig.state.repair!.reservations, charged.reservations);
    assert.equal(restarted.config.proofActivated, true);
  }
});

Deno.test("actual native not-submitted admission reconciles after restart without refunding", async () => {
  const rig = await factoryRig();
  rig.readyForAdmission();
  rig.refuseAdmission(true);
  const beforeReservations = structuredClone(rig.state.repair!.reservations);
  const first = await runHostedQueueCustody({
    state: rig.state,
    clock: rig.clock,
    githubFor: () => rig.github as HostedAutonomyGitHubV1,
    queue: rig.coordinator("on", rig.acceptedSource),
  }, rig.clock.now() + 60000);
  assert.equal(first.ready, true, first.actions.join(" "));
  assert.equal(
    parseQueueIntent(rig.state.repair!.work[0])?.stage,
    "not_submitted",
  );
  const restarted = await runHostedQueueCustody({
    state: rig.state,
    clock: rig.clock,
    githubFor: () => rig.github as HostedAutonomyGitHubV1,
    queue: rig.coordinator("on", rig.acceptedSource),
  }, rig.clock.now() + 60000);
  assert.equal(restarted.ready, true, restarted.actions.join(" "));
  assert.ok(
    restarted.actions.some((action) =>
      action.endsWith(":not_submitted_reconciled")
    ),
  );
  assert.equal(rig.state.repair!.work[0].intent, null);
  assert.equal(rig.state.repair!.work[0].wait, null);
  assert.deepEqual(rig.state.repair!.reservations, beforeReservations);
});

Deno.test("late native not-submitted response with a moved state head keeps custody", async () => {
  const rig = await factoryRig();
  rig.readyForAdmission();
  rig.refuseAdmission(true);
  rig.moveStateHeadBeforeAdmissionResponse(true);
  const beforeReservations = structuredClone(rig.state.repair!.reservations);
  const first = await runHostedQueueCustody({
    state: rig.state,
    clock: rig.clock,
    githubFor: () => rig.github as HostedAutonomyGitHubV1,
    queue: rig.coordinator("on", rig.acceptedSource),
  }, rig.clock.now() + 60000);
  assert.equal(first.ready, false);
  assert.equal(
    parseQueueIntent(rig.state.repair!.work[0])?.stage,
    "unresolved",
  );
  const restarted = await runHostedQueueCustody({
    state: rig.state,
    clock: rig.clock,
    githubFor: () => rig.github as HostedAutonomyGitHubV1,
    queue: rig.coordinator("on", rig.acceptedSource),
  }, rig.clock.now() + 60000);
  assert.equal(restarted.ready, true, restarted.actions.join(" "));
  assert.equal(rig.state.repair!.work[0].intent !== null, true);
  assert.equal(rig.state.repair!.work[0].wait?.until, null);
  assert.deepEqual(rig.state.repair!.reservations, beforeReservations);
});
