import assert from "node:assert/strict";
import { makeRepairRig, SHA1 } from "./helpers.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { runRepairEntrypoint } from "../../src/main.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "../repair/helpers.ts";
import { workRecord } from "../state/helpers.ts";
import {
  FakeGitExecutor,
  FakeReviewService,
  makePort,
} from "../github/helpers.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";

Deno.test("cooldown entrypoint: restart and fault modes keep zero further HTTP/auth/Git/review/model/reservation", async () => {
  for (const mode of ["restart", "fault"]) {
    const rig = await makeRepairRig(`cooldown-entry-${mode}`, {
      summaries: false,
    });
    try {
      await rig.run();
      const read = await rig.store.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      if (!read.ok || read.value.status !== "found") {
        throw Error("fixture state");
      }
      const seeded = structuredClone(read.value.snapshot);
      seeded.stateHead = read.value.head;
      seeded.sequence++;
      seeded.work = [
        workRecord("w:cooldown", {
          repository: {
            owner: "ubiquity",
            name: "sentinel",
            installationId: 42,
          },
        }),
      ];
      const wrote = await rig.store.writeRepair(seeded, read.value.head);
      assert.ok(wrote.ok && wrote.value.status === "applied");
      const state = mode === "fault"
        ? {
          readRepair: rig.store.readRepair.bind(rig.store),
          readRelease: rig.store.readRelease.bind(rig.store),
          writeRepair: () =>
            Promise.resolve(
              portError("unavailable", "synthetic state failure"),
            ),
        }
        : rig.store;
      const initialGate = new DurableGitHubCooldownGate({
        state,
        clock: rig.clock,
      });
      let auth = 0, http = 0;
      const git = new FakeGitExecutor(), review = new FakeReviewService();
      const options = {
        clock: rig.clock,
        cooldownGate: initialGate,
        git,
        review,
        auth: {
          authorizationHeader: () => {
            auth++;
            return Promise.resolve(portOk("Bearer synthetic"));
          },
        },
        http: () => {
          http++;
          return Promise.resolve({
            status: 429,
            headers: new Headers({ "retry-after": "7200" }),
            bodyText: "",
          });
        },
      };
      const first = makePort(options).port;
      assert.equal((await first.listOpenIssues()).ok, false);
      assert.equal(http, 1);
      const gate = mode === "restart"
        ? new DurableGitHubCooldownGate({ state: rig.store, clock: rig.clock })
        : initialGate;
      const port = makePort({ ...options, cooldownGate: gate }).port;
      const configs = repairConfigs({
        repository: { owner: "ubiquity", name: "sentinel", installationId: 42 },
        sessionBound: { maxDurationMs: 240000, maxOutputChars: 200000 },
      });
      const outcome = await runRepairEntrypoint({
        clock: rig.clock,
        state: rig.store,
        configs,
        controllerSha: SHA1,
        github: port,
        githubCooldown: gate,
        incidents: rig.incidents,
        replay: rig.replay,
        model: rig.model,
        budget: new RollingStartBudget({
          clock: rig.clock,
          state: rig.store,
          configs,
        }),
      }, { deadline: rig.clock.now() + 1800000, stepLimit: 16 });
      const snapshot = await rig.snapshot();
      assert.equal(auth, 1);
      assert.equal(http, 1);
      assert.equal(git.remoteReads.length, 0);
      assert.equal(git.pushes.length, 0);
      assert.equal(review.submits.length, 0);
      assert.equal(review.reads.length, 0);
      assert.equal(rig.model.requests.length, 0);
      assert.equal(snapshot.reservations.length, 0);
      assert.notEqual(outcome.status, "step_limit");
      if (mode === "fault") assert.equal(outcome.status, "state_error");
      console.log(
        `PASS ${mode}: actual client/state/entrypoint with zero further HTTP/auth/Git/review/model/reservation; outcome=${outcome.status}`,
      );
    } finally {
      await rig.ctx.cleanup();
    }
  }
});

Deno.test("cooldown ambiguity: lost response keeps durable intent, cooldown and exact reconciliation with one mutation", async () => {
  for (const mode of ["pr", "merge"]) {
    const rig = await makeRepairRig(`cooldown-lost-${mode}`);
    try {
      const gate = new DurableGitHubCooldownGate({
        state: rig.store,
        clock: rig.clock,
      });
      const configs = repairConfigs({
        sessionBound: { maxDurationMs: 240000, maxOutputChars: 200000 },
      });
      const run = () =>
        runRepairEntrypoint({
          clock: rig.clock,
          state: rig.store,
          configs,
          controllerSha: SHA1,
          github: rig.github,
          githubCooldown: gate,
          incidents: rig.incidents,
          replay: rig.replay,
          model: rig.model,
          budget: new RollingStartBudget({
            clock: rig.clock,
            state: rig.store,
            configs,
          }),
        }, { deadline: rig.clock.now() + 1800000, stepLimit: 16 });
      const throttle = () =>
        gate.recordRateLimit(7, {
          kind: "secondary",
          observedAt: rig.clock.now(),
          retryNotBefore: rig.clock.now() + 7200000,
          observationId: "a".repeat(64),
          fallback: false,
        });
      let mutations = 0;
      if (mode === "pr") {
        const create = rig.github.createPullRequest.bind(rig.github);
        rig.github.createPullRequest = async (...args) => {
          mutations++;
          await create(...args);
          assert.equal((await throttle()).ok, true);
          return portOk({ outcome: "ambiguous", number: null, head: null });
        };
      }
      if (mode === "merge") {
        await run();
        rig.github.completeReview([], rig.clock.now() + 1000);
        rig.clock.advance(960000);
        const read = rig.github.readPullRequest.bind(rig.github);
        let merged = false;
        rig.github.readPullRequest = async (...args) => {
          const result = await read(...args);
          if (merged && result.ok && result.value) {
            return portOk({
              ...result.value,
              state: "merged",
              mergeSha: result.value.head,
            });
          }
          return result;
        };
        rig.github.mergePullRequest = async () => {
          mutations++;
          merged = true;
          assert.equal((await throttle()).ok, true);
          return portOk({ outcome: "ambiguous", head: null, mergeSha: null });
        };
      }
      await run();
      assert.equal(mutations, 1);
      let snapshot = await rig.snapshot();
      assert.ok(
        snapshot.work.some((w) =>
          w.intent?.kind === (mode === "pr" ? "pull_request" : "merge")
        ),
        "lost mutation intent not retained",
      );
      const calls = rig.github.calls.length;
      const reservations = snapshot.reservations.length;
      await run();
      assert.equal(rig.github.calls.length, calls);
      assert.equal((await rig.snapshot()).reservations.length, reservations);
      assert.equal(mutations, 1);
      rig.clock.advance(7200000);
      await run();
      snapshot = await rig.snapshot();
      assert.equal(mutations, 1, "mutation repeated after cooldown");
      if (mode === "pr") {
        assert.ok(snapshot.work.some((w) => w.target.pr === 7));
      } else assert.equal(snapshot.releaseRequests.length, 1);
      console.log(
        `PASS ${mode}: lost response, durable intent, cooldown and exact reconciliation with one mutation`,
      );
    } finally {
      await rig.ctx.cleanup();
    }
  }
});

Deno.test("cooldown bounds: gate wait cannot start GitHub intake after total run deadline", async () => {
  const clock = new FakeClock(),
    state = new MemoryState(),
    github = new FakeGithub();
  const configs = repairConfigs();
  const deadline = clock.now() + 600000;
  await runRepairEntrypoint({
    clock,
    state,
    configs,
    controllerSha: SHA1,
    github,
    githubCooldown: {
      beforeRequest: () => {
        clock.advance(600000);
        return Promise.resolve(portOk(undefined));
      },
      recordRateLimit: () => Promise.resolve(portOk(undefined)),
    },
    incidents: new FakeIncidents(),
    replay: new FakeReplay(),
    model: new FakeModel(),
    budget: new RollingStartBudget({ clock, state, configs }),
  }, { deadline });
  assert.equal(
    github.calls.length,
    0,
    "awaited gate crossed run deadline but GitHub intake still started",
  );
  assert.equal(state.repair?.reservations.length, 0);
  console.log(
    "PASS gate wait cannot start GitHub intake after total run deadline",
  );
});

Deno.test("cooldown admission: awaited gate cannot consume an ineligible model reservation", async () => {
  for (const mode of ["implementation-fit", "review-cutoff"]) {
    const clock = new FakeClock(), state = new MemoryState();
    const github = new FakeGithub({
      issues: [{ number: 1, title: "synthetic issue" }],
      openIssues: [{ number: 1, title: "synthetic issue" }],
    });
    const configs = repairConfigs({
      sessionBound: { maxDurationMs: 240000, maxOutputChars: 200000 },
    });
    const model = new FakeModel();
    let prepared = false, advanced = false;
    const read = github.readIssue.bind(github);
    github.readIssue = async (...args) => {
      const result = await read(...args);
      if (mode === "implementation-fit") prepared = true;
      return result;
    };
    const create = github.createPullRequest.bind(github);
    github.createPullRequest = async (...args) => {
      const result = await create(...args);
      if (mode === "review-cutoff") prepared = true;
      return result;
    };
    await runRepairEntrypoint({
      clock,
      state,
      configs,
      controllerSha: SHA1,
      github,
      githubCooldown: {
        beforeRequest: () => {
          if (prepared && !advanced) {
            advanced = true;
            clock.advance(mode === "implementation-fit" ? 120000 : 5400000);
          }
          return Promise.resolve(portOk(undefined));
        },
        recordRateLimit: () => Promise.resolve(portOk(undefined)),
      },
      incidents: new FakeIncidents(),
      replay: new FakeReplay(),
      model,
      budget: new RollingStartBudget({ clock, state, configs }),
    }, {
      // The initial hard deadline must still leave the declared 240000ms
      // session plus the 300000ms review-drain and 300000ms operation
      // margins; the 120000ms gate advance then makes it ineligible.
      deadline: clock.now() +
        (mode === "implementation-fit" ? 900000 : 7200000),
      stepLimit: 16,
    });
    assert.equal(advanced, true, "test did not reach admission gate");
    if (mode === "implementation-fit") {
      assert.equal(model.requests.length, 0);
      assert.equal(
        state.repair?.reservations.length,
        0,
        "model no longer fit after gate but reservation was created",
      );
    } else {
      assert.equal(github.calls.includes("requestReview"), false);
      assert.equal(
        state.repair?.reservations.filter((r) => r.purpose === "review_request")
          .length,
        0,
        "review cutoff crossed in gate but reservation was created",
      );
    }
    console.log(
      `PASS ${mode}: awaited gate cannot consume an ineligible model reservation`,
    );
  }
});
