import assert from "node:assert/strict";
import { CodexImplementationPort } from "../../src/repair/model-port.ts";
import type {
  CodexServerNotificationV1,
  CodexSessionV1,
} from "../../src/repair/codex-transport.ts";
import { gitRun, REPO, SHA1, SHA3, testGitEnv } from "../state/helpers.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { checkoutContentCheckpoint } from "../../src/repair/checkout-content.ts";
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One-shot event signal that also works when fired before a waiter starts. */
function signal(): { promise: Promise<void>; fire: () => void } {
  let fire: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { promise, fire };
}

type Mode =
  | "duplicate"
  | "stale"
  | "changed-error"
  | "test"
  | "compound"
  | "search"
  | "edit"
  | "active"
  | "file-change"
  | "unsupported"
  | "hung-steer"
  | "output"
  | "late-start"
  | "stop-race"
  | "wrong-terminal";

async function probe(mode: Mode) {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ dir: ".", prefix: "reuse-boundary-" }),
  );
  const env = testGitEnv(root);
  let script = Promise.resolve();
  let callback: ((e: CodexServerNotificationV1) => void) | null = null;
  let scriptError: unknown = null;
  let steers = 0, interrupts = 0, closes = 0;
  const steerObserved = signal();
  const interruptObserved = signal();
  const emit = (method: string, params: unknown) =>
    callback?.({ method, params });
  const terminal = (status = "completed") =>
    emit("turn/completed", {
      threadId: "t",
      turn: { id: "u", status, durationMs: 1 },
    });
  const item = (i: number) => ({
    id: mode === "duplicate" ? "c1" : `c${i}`,
    type: "commandExecution",
    command: mode === "test"
      ? "deno test app.ts"
      : mode === "compound"
      ? "deno check app.ts; echo bad"
      : mode === "search"
      ? "rg absent app.ts"
      : "deno check app.ts",
    cwd: root,
    status: "failed",
    aggregatedOutput: mode === "search"
      ? ""
      : `error: Type checking failed${mode === "changed-error" ? i : ""}`,
    exitCode: 1,
  });
  const session: CodexSessionV1 = {
    send(method, params) {
      if (method === "initialize") {
        return Promise.resolve({ userAgent: "fixture" });
      }
      if (method === "thread/start") {
        return Promise.resolve({
          thread: { id: "t" },
          model: "gpt-5.6-luna",
          reasoningEffort: "max",
          modelProvider: "fixture",
        });
      }
      if (method === "turn/start") {
        return Promise.resolve({ turn: { id: "u" } });
      }
      if (method === "turn/steer") {
        steers++;
        assert.equal((params as Record<string, unknown>).expectedTurnId, "u");
        // Resolve from a later task so the model port's send continuation has
        // observed the response before the producer emits more work.
        setTimeout(() => steerObserved.fire(), 0);
        if (mode === "unsupported" || mode === "stop-race") {
          return Promise.reject(new Error("unsupported"));
        }
        if (mode === "hung-steer") return new Promise(() => {});
        return Promise.resolve({ turnId: "u" });
      }
      if (method === "turn/interrupt") {
        interrupts++;
        if (mode === "wrong-terminal") {
          emit("turn/completed", {
            threadId: "t",
            turn: { id: "old", status: "completed" },
          });
        } else terminal(mode === "stop-race" ? "completed" : "interrupted");
        interruptObserved.fire();
        return Promise.resolve({});
      }
      return Promise.reject(new Error("unexpected method"));
    },
    notify() {},
    onServerRequest() {},
    onNotification(handler) {
      callback = handler;
      script = (async () => {
        if (mode === "active") {
          emit("item/started", {
            threadId: "t",
            turnId: "u",
            item: { id: "other", type: "commandExecution" },
          });
        }
        for (let i = 1; i <= 6 && interrupts === 0; i++) {
          await pause(300);
          if (i === 4 && mode === "edit") {
            await Deno.writeTextFile(`${root}/app.ts`, "export const a = 2;\n");
          }
          if (i === 4 && mode === "file-change") {
            emit("item/completed", {
              threadId: "t",
              turnId: "u",
              item: { id: "edit", type: "fileChange" },
            });
          }
          if (mode === "output" || mode === "wrong-terminal") {
            emit("item/completed", {
              threadId: "t",
              turnId: "u",
              item: { ...item(i), aggregatedOutput: "x".repeat(2000) },
            });
            break;
          }
          const params = {
            threadId: "t",
            turnId: mode === "stale" ? "old" : "u",
            item: item(i),
          };
          emit("item/started", {
            ...params,
            item: { ...item(i), status: "inProgress" },
          });
          emit("item/completed", params);
          if (mode === "late-start" && i === 1) {
            emit("item/started", {
              ...params,
              item: { ...item(i), status: "inProgress" },
            });
          }
          if (mode === "hung-steer" && i === 4) {
            await Promise.race([
              steerObserved.promise,
              interruptObserved.promise,
            ]);
            break;
          }
        }
        // Wait for the model port's interrupt before flushing a terminal event
        // in modes whose contract requires the early-stop path. A fixed sleep
        // made the fixture race the asynchronous observation drain under the
        // full harness load.
        if (
          mode === "unsupported" || mode === "late-start" ||
          mode === "stop-race" || mode === "output" || mode === "wrong-terminal"
        ) {
          await interruptObserved.promise;
        }
        // Genuine correlated schema-shaped output item for the exact
        // thread/turn: a completed run requires nonempty output evidence (a
        // successful file-change item with status completed and a nonempty
        // valid changes array), never notification-byte counts. In stopped
        // modes this event is ignored, so it never changes their early-stop
        // contracts.
        emit("item/completed", {
          threadId: "t",
          turnId: "u",
          item: {
            id: "ok-output",
            type: "fileChange",
            status: "completed",
            changes: [{
              path: "app.ts",
              kind: { type: "update" },
              diff: "@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n",
            }],
          },
        });
        await pause(200);
        terminal();
      })().catch((error) => {
        scriptError = error;
        terminal("failed");
      });
    },
    async close() {
      await script;
      closes++;
    },
  };
  try {
    assert.ok((await gitRun(root, ["init", "-q"], env)).ok);
    assert.ok(
      (await gitRun(root, ["commit", "-q", "--allow-empty", "-m", "seed"], env))
        .ok,
    );
    await Deno.writeTextFile(`${root}/app.ts`, "export const a = 1;\n");
    assert.match(
      (await checkoutContentCheckpoint(root)) ?? "",
      /^[a-f0-9]{64}$/,
    );
    const port = new CodexImplementationPort({
      checkoutDir: root,
      interruptSettlementGraceMs: mode === "wrong-terminal" ? 30 : undefined,
      openSession: () => Promise.resolve(session),
      // Explicit provider with the CONCRETE default request/runtime receipt
      // producer (no injected permissive verifier): the core checks alone
      // decide the receipt for every mode below.
      modelProvider: "fixture",
      checkout: {
        resolve: () =>
          Promise.resolve({
            head: SHA3,
            checkpointSha: null,
            changedPaths: ["app.ts"],
          }),
      },
    });
    const started = performance.now();
    const result = await port.runModel({
      taskId: asWorkItemId("probe"),
      repository: REPO,
      base: SHA1,
      issue: null,
      evidence: [],
      model: "gpt-5.6-luna",
      reasoning: "max",
      maxDurationMs: 5000,
      maxOutputChars: mode === "output" || mode === "wrong-terminal"
        ? 1000
        : 200000,
    });
    assert.equal(scriptError, null);
    assert.equal(closes, 1);
    assert.ok(result.ok);
    if (!result.ok) return;
    if (
      mode === "unsupported" || mode === "late-start" || mode === "stop-race"
    ) {
      assert.equal(steers, 1, mode);
      assert.equal(interrupts, 1, mode);
      assert.equal(result.value.error, "failed_command_loop");
      assert.equal(result.value.candidate, null);
    } else if (mode === "output" || mode === "wrong-terminal") {
      assert.equal(interrupts, 1);
      assert.equal(result.value.candidate, null);
      if (mode === "wrong-terminal") {
        // The wrong identity was ignored and no runtime terminal arrived: the
        // host timeout keeps failed ACCOUNTING with the explicit origin and
        // never pretends an observed terminal.
        assert.equal(result.value.outcome, "failed");
        assert.equal(result.value.actual.terminalOrigin, "host-timeout");
        assert.equal(
          result.value.error,
          "host timeout without terminal settlement",
        );
      }
    } else {
      assert.equal(interrupts, 0, mode);
      assert.equal(steers, mode === "hung-steer" ? 1 : 0, mode);
      assert.equal(result.value.outcome, "completed", mode);
    }
    assert.ok(
      performance.now() - started < 4000,
      "early completion must not await default grace",
    );
  } finally {
    await script;
    await Deno.remove(root, { recursive: true });
  }
}

for (
  const mode of [
    "duplicate",
    "stale",
    "changed-error",
    "test",
    "compound",
    "search",
    "edit",
    "active",
    "file-change",
    "unsupported",
    "hung-steer",
    "output",
    "late-start",
    "stop-race",
    "wrong-terminal",
  ] as Mode[]
) {
  Deno.test(`loop-guard boundary: ${mode}`, () => probe(mode));
}
