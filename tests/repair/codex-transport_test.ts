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

import { CodexSubprocessSession } from "../../src/repair/codex-transport.ts";

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
