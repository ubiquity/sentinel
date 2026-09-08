import assert from "node:assert/strict";
import { makeRepairRig, SHA1 } from "../integration/helpers.ts";
import { repairConfigs } from "./helpers.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { runRepairEntrypoint } from "../../src/main.ts";
import { CodexImplementationPort } from "../../src/repair/model-port.ts";
import type {
  CodexServerNotificationV1,
  CodexSessionV1,
} from "../../src/repair/codex-transport.ts";
import { checkoutContentCheckpoint } from "../../src/repair/checkout-content.ts";
import { gitRun } from "../state/helpers.ts";

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

class ScriptSession implements CodexSessionV1 {
  handler: ((event: CodexServerNotificationV1) => void) | null = null;
  job: Promise<void> = Promise.resolve();
  failure: unknown = null;
  steers = 0;
  interrupts = 0;
  closed = false;
  constructor(
    readonly number: number,
    readonly cwd: string,
    readonly order: string[],
  ) {}
  emit(method: string, params: unknown) {
    this.handler?.({ method, params });
  }
  terminal(status: string) {
    this.order.push(`terminal:${this.number}`);
    this.emit("turn/completed", {
      threadId: `t${this.number}`,
      turn: { id: `u${this.number}`, status, durationMs: 1 },
    });
  }
  send(method: string, params: unknown): Promise<unknown> {
    if (method === "initialize") {
      return Promise.resolve({ userAgent: "scripted" });
    }
    if (method === "thread/start") {
      return Promise.resolve({
        thread: { id: `t${this.number}` },
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        modelProvider: "scripted",
      });
    }
    if (method === "turn/start") {
      return Promise.resolve({ turn: { id: `u${this.number}` } });
    }
    if (method === "turn/steer") {
      assert.equal(
        (params as Record<string, unknown>).expectedTurnId,
        `u${this.number}`,
      );
      this.steers++;
      this.order.push(`steer:${this.number}`);
      return Promise.resolve({ turnId: `u${this.number}` });
    }
    if (method === "turn/interrupt") {
      this.interrupts++;
      this.order.push(`interrupt:${this.number}`);
      this.terminal("interrupted");
      return Promise.resolve({});
    }
    throw new Error(`unexpected method ${method}`);
  }
  notify() {}
  onServerRequest() {}
  onNotification(handler: (event: CodexServerNotificationV1) => void) {
    this.handler = handler;
    this.job = this.produce().catch((error) => {
      this.failure = error;
      this.terminal("failed");
    });
  }
  async produce() {
    if (this.number === 2) {
      await pause(10);
      this.terminal("failed");
      return;
    }
    for (let i = 1; i <= 6; i++) {
      if (i === 5) {
        for (let tries = 0; this.steers === 0 && tries < 60; tries++) {
          await pause(25);
        }
        assert.equal(this.steers, 1, "four failures must steer");
      }
      await pause(200);
      const item = {
        id: `c${i}`,
        type: "commandExecution",
        command: "deno check app.ts",
        cwd: this.cwd,
        status: "failed",
        aggregatedOutput: "error: Type checking failed",
        exitCode: 1,
      };
      this.emit("item/started", {
        threadId: "t1",
        turnId: "u1",
        item: { ...item, status: "inProgress" },
      });
      this.emit("item/completed", { threadId: "t1", turnId: "u1", item });
    }
    for (let tries = 0; this.interrupts === 0 && tries < 60; tries++) {
      await pause(25);
    }
    assert.equal(this.interrupts, 1, "two post-ack failures must interrupt");
  }
  async close() {
    await this.job;
    await pause(50);
    this.closed = true;
    this.order.push(`close:${this.number}`);
  }
}

Deno.test("loop-guard runtime: real entrypoint stops first loop and admits second after terminal and close", async () => {
  const issues = [{ number: 1, createdAt: 1 }, { number: 2, createdAt: 2 }];
  const rig = await makeRepairRig("reuse-primary", {
    summaries: false,
    github: { issues, openIssues: issues },
  });
  const sessions: ScriptSession[] = [];
  const order: string[] = [];
  try {
    const cwd = await Deno.realPath(rig.ctx.work);
    const init = await gitRun(cwd, [
      "commit",
      "--allow-empty",
      "-m",
      "checkpoint probe",
    ], rig.ctx.env);
    assert.ok(init.ok, init.stderr);
    assert.match(
      (await checkoutContentCheckpoint(cwd)) ?? "",
      /^[a-f0-9]{64}$/,
    );
    const configs = repairConfigs({
      sessionBound: { maxDurationMs: 4000, maxOutputChars: 200000 },
    });
    const model = new CodexImplementationPort({
      checkoutDir: cwd,
      interruptSettlementGraceMs: 100,
      receiptVerifier: (e) =>
        e.threadModel === "gpt-5.6-luna" && e.threadEffort === "max"
          ? { observedModel: "gpt-5.6-luna", observedReasoning: "max" }
          : null,
      openSession: () => {
        if (sessions.length > 0) {
          assert.ok(sessions[0].closed, "next writer started before close");
        }
        const session = new ScriptSession(sessions.length + 1, cwd, order);
        order.push(`open:${session.number}`);
        sessions.push(session);
        return Promise.resolve(session);
      },
    });
    const result = await runRepairEntrypoint({
      clock: rig.clock,
      state: rig.store,
      configs,
      controllerSha: SHA1,
      github: rig.github,
      githubCooldown: rig.githubCooldown,
      incidents: rig.incidents,
      replay: rig.replay,
      model,
      budget: new RollingStartBudget({
        clock: rig.clock,
        state: rig.store,
        configs,
      }),
    }, { deadline: rig.clock.now() + 600000, stepLimit: 16 });
    const snapshot = await rig.snapshot();
    for (const session of sessions) assert.equal(session.failure, null);
    assert.equal(
      sessions.length,
      2,
      JSON.stringify({ result, order, work: snapshot.work }),
    );
    assert.equal(sessions.reduce((n, s) => n + s.steers, 0), 1);
    assert.equal(sessions.reduce((n, s) => n + s.interrupts, 0), 1);
    assert.equal(snapshot.reservations.length, 2);
    assert.ok(
      snapshot.reservations.every((r) =>
        r.purpose === "implementation" && r.outcome === "ambiguous"
      ),
    );
    assert.ok(
      JSON.stringify(snapshot.work.find((w) => w.source.id === "1")).includes(
        "failed_command_loop",
      ),
    );
    assert.ok(order.indexOf("terminal:1") < order.indexOf("close:1"));
    assert.ok(order.indexOf("close:1") < order.indexOf("open:2"));
    console.log(
      JSON.stringify({
        result,
        order,
        reservations: snapshot.reservations.length,
      }),
    );
  } finally {
    await rig.ctx.cleanup();
  }
});
