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

/**
 * Bounded observation waits, kept well below runModel's 5000 ms ceiling with
 * load headroom. The intentional-fault negative cases use the shorter
 * explicitly test-local bound so they fail fast.
 */
const OBSERVATION_TIMEOUT_MS = 2000;
const FAULT_OBSERVATION_TIMEOUT_MS = 300;

/** Fault injection for the bounded-observation negative cases. */
type Fault =
  | "missing-observation"
  | "rejected-interrupt"
  | "throwing-interrupt";

/**
 * Bounded fixture observation: resolves when `signal` fires and otherwise
 * rejects with a clear fixture message naming the event that was never
 * observed. A missing, rejected or throwing interrupt must not leave the
 * fixture script awaiting a signal forever, because `close()` awaits that
 * script and would stall the probe far past runModel's ceiling.
 */
function observe(
  label: string,
  signal: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `loop-guard fixture: ${label} was not observed within ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );
  });
  return Promise.race([signal, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

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

async function probe(mode: Mode, fault: Fault | null = null) {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ dir: ".", prefix: "reuse-boundary-" }),
  );
  const env = testGitEnv(root);
  let script = Promise.resolve();
  let callback: ((e: CodexServerNotificationV1) => void) | null = null;
  let scriptError: unknown = null;
  let steers = 0, interrupts = 0, closes = 0;
  const observationTimeoutMs = fault === null
    ? OBSERVATION_TIMEOUT_MS
    : FAULT_OBSERVATION_TIMEOUT_MS;
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
        // Negative-case fault injection: the observation is deliberately never
        // signalled (and the request itself may reject or throw), so only the
        // bounded observation keeps the script, close() and the probe finite.
        if (fault === "throwing-interrupt") {
          throw new Error("fixture fault: turn/interrupt threw");
        }
        if (fault === "rejected-interrupt") {
          return Promise.reject(
            new Error("fixture fault: turn/interrupt rejected"),
          );
        }
        if (fault === "missing-observation") return Promise.resolve({});
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
            await observe(
              `hung-steer steer or interrupt (mode ${mode})`,
              Promise.race([
                steerObserved.promise,
                interruptObserved.promise,
              ]),
              observationTimeoutMs,
            );
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
          await observe(
            `early-stop interrupt (mode ${mode}` +
              (fault === null ? ")" : `, fault ${fault})`),
            interruptObserved.promise,
            observationTimeoutMs,
          );
        }
        await pause(200);
        terminal();
      })().catch((error) => {
        scriptError = error instanceof Error ? error : new Error(String(error));
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
      receiptVerifier: () => ({
        observedModel: "gpt-5.6-luna",
        observedReasoning: "max",
      }),
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
    if (fault !== null) {
      // Intentional interrupt fault: the bounded observation fails loudly
      // instead of hanging, the fixture records that failure, emits a failed
      // terminal and lets close()/runModel settle. The missing interrupt is
      // asserted, never replaced by a fabricated observation or a swallowed
      // error whose only purpose would be to pass.
      assert.equal(steers, 0, fault);
      assert.equal(interrupts, 1, fault);
      assert.equal(closes, 1, `${fault}: session close must settle`);
      assert.ok(
        scriptError instanceof Error,
        `${fault}: fixture script failure must be recorded`,
      );
      assert.match(
        (scriptError as Error).message,
        /interrupt.*was not observed within \d+ms/,
        fault,
      );
      assert.ok(result.ok, fault);
      if (result.ok) {
        assert.equal(result.value.outcome, "failed", fault);
        assert.equal(result.value.candidate, null, fault);
        assert.equal(result.value.error, null, fault);
      }
      assert.ok(
        performance.now() - started < 4000,
        `${fault}: bounded fixture failure must not await the default grace`,
      );
      return root;
    }
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
        assert.equal(result.value.outcome, "failed");
        assert.equal(result.value.error, "timeout without terminal settlement");
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
  Deno.test(`loop-guard boundary: ${mode}`, async () => {
    await probe(mode);
  });
}

for (
  const fault of [
    "missing-observation",
    "rejected-interrupt",
    "throwing-interrupt",
  ] as Fault[]
) {
  Deno.test(
    `loop-guard boundary: bounded interrupt observation ${fault}`,
    async () => {
      const root = await probe("output", fault);
      if (typeof root !== "string") {
        throw new Error("fault probe did not expose its temp checkout root");
      }
      // The script and close() settled, so probe() already removed the temp
      // checkout; a lingering directory would mean cleanup never ran.
      await assert.rejects(
        () => Deno.stat(root),
        (error: unknown) => error instanceof Deno.errors.NotFound,
      );
    },
  );
}
