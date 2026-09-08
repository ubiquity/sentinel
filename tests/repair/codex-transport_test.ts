/**
 * m04-repair codex transport tests: serialized app-server stdin writes and
 * bounded close/termination with owned-process-group descendant settlement.
 *
 * The fake app-server is a local `/bin/sh` or `deno eval` process; it parses
 * every complete stdin line as JSON-RPC and answers request ids in arrival
 * order, so a partial/interleaved frame is observable as a malformed
 * notification or a missing response. No credentials, no network, no model
 * call exists in this suite.
 */
import assert from "node:assert/strict";

import {
  CodexProtocolError,
  CodexSubprocessSession,
} from "../../src/repair/codex-transport.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/repair\/codex-transport_test\.ts$/,
  "",
);

function envForTest(): Record<string, string> {
  return { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" };
}

function tmpDir(prefix: string): Promise<string> {
  return Deno.makeTempDir({
    prefix: `sentinel-repair-test-transport-${prefix}-`,
    dir: ROOT,
  });
}

/**
 * Fake app-server: answers every complete JSON-RPC request line with the same
 * id, and announces each frame's arrival (in order) as a notification. A
 * malformed/interleaved frame is announced as `malformed` instead of a
 * response, so the client can assert no frame was corrupted.
 */
const SERVER_CODE = `
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const write = (frame) => Deno.stdout.writeSync(encoder.encode(JSON.stringify(frame) + "\\n"));
let buffer = "";
for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk);
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      write({ method: "malformed", params: { saw: line.length } });
      continue;
    }
    if (frame !== null && typeof frame === "object" && frame.id !== undefined) {
      write({ method: "arrival", params: { id: frame.id } });
      write({ jsonrpc: "2.0", id: frame.id, result: { saw: true } });
    }
  }
}
`;

/**
 * Fake app-server that emits a related event, the terminal event and a
 * progress event at startup — before any listener can be registered — then
 * answers requests normally (with an optional `noise` notification ahead of
 * the response to observe live post-registration delivery).
 */
const BURST_SERVER_CODE = `
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const write = (frame) => Deno.stdout.writeSync(encoder.encode(JSON.stringify(frame) + "\\n"));
write({ method: "model/rerouted", params: { fromModel: "gpt-5.6", toModel: "gpt-5.6-luna" } });
write({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", durationMs: 7 } } });
write({ method: "turn/progress", params: { idx: 1 } });
let buffer = "";
for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk);
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      write({ method: "malformed", params: { saw: line.length } });
      continue;
    }
    if (frame !== null && typeof frame === "object" && frame.id !== undefined) {
      const params = frame.params ?? {};
      if (typeof params === "object" && params.noise === true) {
        write({ method: "arrival", params: { id: frame.id } });
      }
      write({ jsonrpc: "2.0", id: frame.id, result: { saw: true } });
    }
  }
}
`;

/**
 * Fake app-server that answers the first request with a large notification
 * burst (no consumer registered) and only then the response line, so the
 * client's notification byte bound must trip before any delivery.
 */
const OVERBOUND_SERVER_CODE = `
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const write = (frame) => Deno.stdout.writeSync(encoder.encode(JSON.stringify(frame) + "\\n"));
const pad = "x".repeat(200);
let buffer = "";
for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk);
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame !== null && typeof frame === "object" && frame.id !== undefined) {
      for (let n = 0; n < 40; n++) {
        write({ method: "turn/progress", params: { n, pad } });
      }
      write({ jsonrpc: "2.0", id: frame.id, result: { saw: true } });
    }
  }
}
`;

/**
 * Fake app-server that answers the first request with, in one write: the
 * terminal notification, the response line, an oversized notification (over
 * maxNotificationBytes) and one more terminal notification after the failing
 * frame. The client must not deliver the retained terminal or the trailing
 * frame after the byte-bound failure, and the failure must stay sticky.
 */
const OVERFLOW_RESPONSE_SERVER_CODE = `
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const write = (frame) => Deno.stdout.writeSync(encoder.encode(JSON.stringify(frame) + "\\n"));
for await (const chunk of Deno.stdin.readable) {
  const line = decoder.decode(chunk).trim();
  if (line === "") continue;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  const frames = [
    { jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } },
    { jsonrpc: "2.0", id: request.id, result: { turn: { id: "turn-1" } } },
    { jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "x".repeat(600) } },
    { jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-2", turn: { id: "turn-2", status: "completed" } } },
  ];
  Deno.stdout.writeSync(encoder.encode(frames.map((f) => JSON.stringify(f)).join("\\n") + "\\n"));
}
`;

Deno.test(
  "codex transport: concurrent app-server writes are serialized into complete frames",
  async () => {
    const dir = await tmpDir("serialized");
    try {
      const session = new CodexSubprocessSession({
        command: [Deno.execPath(), "eval", SERVER_CODE],
        cwd: dir,
        env: envForTest(),
        operationDeadlineMs: 30_000,
      });
      session.open();
      const arrivals: number[] = [];
      let malformed = 0;
      session.onNotification((event) => {
        if (event.method === "arrival") {
          const params = event.params as { id: number };
          arrivals.push(params.id);
        }
        if (event.method === "malformed") malformed++;
      });
      const count = 40;
      const pending: Promise<unknown>[] = [];
      for (let index = 0; index < count; index++) {
        pending.push(
          session.send(`req-${index}`, { n: index, pad: "p".repeat(2048) }),
        );
      }
      const settled = await Promise.all(pending);
      assert.equal(settled.length, count, "every request settles");
      for (let index = 0; index < count; index++) {
        assert.deepEqual(
          settled[index],
          { saw: true },
          `frame ${index} intact`,
        );
      }
      assert.deepEqual(
        arrivals,
        Array.from({ length: count }, (_, index) => index + 1),
        "frames arrived one complete JSON-RPC frame at a time, in send order",
      );
      assert.equal(malformed, 0, "no interleaved/partial frame was observed");
      await session.close();
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "codex transport: close is bounded and settles owned descendants that hold the pipes",
  async () => {
    const dir = await tmpDir("close");
    try {
      const kidFile = `${dir}/kid.pid`;
      // The direct child dies on TERM; the backgrounded descendant ignores
      // TERM and keeps the captured stdout/stderr pipes open — close must
      // signal the owned group (TERM then KILL), stay bounded and prove the
      // descendant is gone.
      const script = `#!/bin/sh
sh -c 'trap "" TERM INT; while :; do sleep 1; done' &
echo $! > '${kidFile}'
wait
`;
      const bin = `${dir}/server`;
      await Deno.writeTextFile(bin, script);
      await Deno.chmod(bin, 0o700);
      const session = new CodexSubprocessSession({
        command: [bin],
        cwd: dir,
        env: envForTest(),
        operationDeadlineMs: 60_000,
        closeTermGraceMs: 300,
        closeKillSettleMs: 700,
      });
      session.open();
      let kidPid = 0;
      for (let attempt = 0; attempt < 100 && kidPid === 0; attempt++) {
        try {
          kidPid = Number((await Deno.readTextFile(kidFile)).trim());
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      assert.ok(
        Number.isSafeInteger(kidPid) && kidPid > 0,
        "uncooperative descendant was recorded",
      );
      const started = Date.now();
      await session.close();
      const elapsed = Date.now() - started;
      assert.ok(
        elapsed < 10_000,
        `close returned within a bound (${elapsed}ms)`,
      );
      let kidAlive = true;
      for (let attempt = 0; attempt < 40 && kidAlive; attempt++) {
        try {
          Deno.kill(kidPid, 0);
        } catch (error) {
          if (
            error instanceof Error && error.name === "NotCapable"
          ) {
            throw new Error(
              "descendant settle verification needs --allow-run",
            );
          }
          kidAlive = false;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(
        kidAlive,
        false,
        "uncooperative descendant was settled by the owned group",
      );
      // Close is idempotent and still bounded.
      await session.close();
      assert.ok(Date.now() - started < 20_000, "second close also bounded");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test("codex transport: close without open and send after close settle", async () => {
  const dir = await tmpDir("neveropened");
  try {
    const session = new CodexSubprocessSession({
      command: [Deno.execPath(), "eval", SERVER_CODE],
      cwd: dir,
      env: envForTest(),
      operationDeadlineMs: 30_000,
    });
    // Never opened: close resolves immediately and a send rejects closed.
    await session.close();
    let rejected = false;
    try {
      await session.send("req-1", {});
    } catch (error) {
      rejected = error instanceof Error &&
        error.message.includes("session closed");
    }
    assert.equal(rejected, true, "send after close fails closed");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test(
  "codex transport: pre-registration notifications are retained and delivered once in wire order",
  async () => {
    const dir = await tmpDir("backlog");
    try {
      const session = new CodexSubprocessSession({
        command: [Deno.execPath(), "eval", BURST_SERVER_CODE],
        cwd: dir,
        env: envForTest(),
        operationDeadlineMs: 30_000,
      });
      session.open();
      // The response line follows the startup burst on the same stream, so
      // once this settles the pump has processed (and, with no listener
      // registered, retained) every pre-registration notification.
      const first = await session.send("barrier", {});
      assert.deepEqual(first, { saw: true });
      const seen: string[] = [];
      session.onNotification((event) => {
        seen.push(event.method);
        if (event.method === "turn/completed") {
          assert.deepEqual(event.params, {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", durationMs: 7 },
          });
        }
      });
      assert.deepEqual(
        seen,
        ["model/rerouted", "turn/completed", "turn/progress"],
        "pre-registration notifications drained exactly once, in wire order",
      );
      const after = await session.send("after", { noise: true });
      assert.deepEqual(after, { saw: true });
      assert.deepEqual(
        seen,
        ["model/rerouted", "turn/completed", "turn/progress", "arrival"],
        "post-registration delivery follows the drained backlog without reorder or duplication",
      );
      await session.close();
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "codex transport: over-bound notifications before registration fail closed",
  async () => {
    const dir = await tmpDir("overbound");
    try {
      const session = new CodexSubprocessSession({
        command: [Deno.execPath(), "eval", OVERBOUND_SERVER_CODE],
        cwd: dir,
        env: envForTest(),
        operationDeadlineMs: 30_000,
        maxNotificationBytes: 4_096,
      });
      session.open();
      // No consumer is registered; the byte bound must fail the operation
      // closed before the burst (or the trailing response) is delivered.
      let failure: unknown = null;
      try {
        await session.send("req-over", {});
      } catch (error) {
        failure = error;
      }
      assert.ok(
        failure instanceof Error,
        "over-bound startup notifications fail closed before any delivery",
      );
      assert.equal(
        failure?.message,
        "codex notification byte bound exceeded",
      );
      await session.close();
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "codex transport: fatal overflow with response ordering discards backlog, blocks registration and stays sticky",
  async () => {
    const dir = await tmpDir("overflow-fatal");
    try {
      const session = new CodexSubprocessSession({
        command: [Deno.execPath(), "eval", OVERFLOW_RESPONSE_SERVER_CODE],
        cwd: dir,
        env: envForTest(),
        operationDeadlineMs: 30_000,
        maxNotificationBytes: 300,
      });
      session.open();
      const delivered: string[] = [];
      let responseAccepted = false;
      let registrationRejected = false;
      try {
        // One write carries terminal, then the response, then the oversize
        // frame; the response resolves before the pump reaches the failure.
        await session.send("turn/start", {});
        responseAccepted = true;
        session.onNotification((event) => delivered.push(event.method));
      } catch (error) {
        registrationRejected = error instanceof CodexProtocolError &&
          error.message.includes("codex notification byte bound exceeded");
      }
      assert.equal(
        responseAccepted,
        true,
        "response frame precedes the oversize frame in the same write",
      );
      assert.equal(
        registrationRejected,
        true,
        "consumer registration after the fatal byte-bound failure fails explicitly",
      );
      assert.deepEqual(
        delivered,
        [],
        "neither the retained terminal nor the frame after the failing frame is delivered",
      );
      // The failure is sticky: later send and registration attempts fail with
      // the same canonical error.
      let laterRejected = false;
      try {
        await session.send("after-overflow", {});
      } catch (error) {
        laterRejected = error instanceof CodexProtocolError &&
          error.message === "codex notification byte bound exceeded";
      }
      assert.equal(
        laterRejected,
        true,
        "send after fatal failure rejects with the sticky error",
      );
      assert.throws(
        () => session.onNotification(() => {}),
        /codex notification byte bound exceeded/,
        "re-registration after fatal failure throws the sticky error",
      );
      // Bounded close still settles the owned child after the fatal failure.
      await session.close();
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);
