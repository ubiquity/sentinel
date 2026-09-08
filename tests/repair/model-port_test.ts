/**
 * m04-repair model-port tests: the runtime ImplementationPort requests the
 * bounded isolated-checkout WRITE capability (workspace-write sandbox over
 * the secret-free checkout cwd, never read-only, never full access), still
 * refuses approvals, and produces a completed receipt with the resolved
 * candidate through an injected verifier/resolver. A trusted host committer
 * can turn model edits into a local candidate when the sandbox protects
 * `.git`. The session behavior across the port is a recording fake; the one
 * real-transport case below proves only the owned lazy-open/closed-session
 * boundary (an immediate-exit child, no network, no model call exists in
 * this suite).
 */
import assert from "node:assert/strict";

import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { ModelRunRequestV1 } from "../../src/contracts/ports.ts";
import type { CodexSessionV1 } from "../../src/repair/codex-transport.ts";
import type { CodexServerNotificationV1 } from "../../src/repair/codex-transport.ts";
import { CodexSubprocessSession } from "../../src/repair/codex-transport.ts";
import {
  CodexImplementationPort,
  LocalCandidateCommitter,
  LocalCheckoutResolver,
  unavailableReceiptVerifier,
} from "../../src/repair/model-port.ts";
import type { ActualSessionEvidenceV1 } from "../../src/repair/model-port.ts";
import { gitRun, REPO, SHA1, SHA3, testGitEnv } from "../state/helpers.ts";

const CHECKOUT = "/tmp/sentinel-model-checkout";

/** Recording fake CodexSessionV1; emits one terminal turn/completed event. */
class FakeCodexSession implements CodexSessionV1 {
  readonly sent: { method: string; params: unknown }[] = [];
  openCalls = 0;
  closeCalls = 0;
  private notifications:
    | ((event: CodexServerNotificationV1) => void)
    | null = null;
  private turnStarted = false;

  open(): void {
    this.openCalls++;
  }

  send(method: string, params: unknown): Promise<unknown> {
    this.sent.push({ method, params });
    switch (method) {
      case "initialize":
        return Promise.resolve({ userAgent: "codex-app-server/0.153.4" });
      case "thread/start":
        return Promise.resolve({
          thread: { id: "thread-1" },
          model: "gpt-5.6-luna",
          reasoningEffort: "max",
          modelProvider: "sentinel-host",
        });
      case "turn/start":
        this.turnStarted = true;
        return Promise.resolve({ turn: { id: "turn-1" } });
      case "turn/interrupt":
        return Promise.resolve({});
      default:
        return Promise.resolve({});
    }
  }

  notify(method: string, params?: unknown): void {
    this.sent.push({ method, params: params ?? {} });
  }

  onNotification(handler: (event: CodexServerNotificationV1) => void): void {
    this.notifications = handler;
    if (this.turnStarted) {
      // The real app-server emits the terminal event only after the listener
      // is registered inside awaitSettlement; the fake mirrors that order.
      queueMicrotask(() => {
        this.notifications?.({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", durationMs: 5 },
          },
        });
      });
    }
  }

  onServerRequest(): void {}

  close(): Promise<void> {
    this.closeCalls++;
    return Promise.resolve();
  }
}

Deno.test("model-port: thread starts with bounded isolated-checkout write capability", async () => {
  const session = new FakeCodexSession();
  const verified: ActualSessionEvidenceV1[] = [];
  const port = new CodexImplementationPort({
    openSession: () => Promise.resolve(session),
    checkoutDir: CHECKOUT,
    checkout: {
      resolve: () =>
        Promise.resolve({
          head: SHA3,
          checkpointSha: null,
          changedPaths: ["src/app.ts"],
        }),
    },
    receiptVerifier: (evidence) => {
      verified.push(evidence);
      if (
        evidence.threadModel === "gpt-5.6-luna" &&
        evidence.terminal.status === "completed"
      ) {
        return { observedModel: "gpt-5.6-luna", observedReasoning: "max" };
      }
      return null;
    },
  });

  const result = await port.runModel({
    taskId: asWorkItemId("issue-1"),
    repository: { ...REPO },
    base: SHA1,
    issue: { number: 1, title: "title", body: "body" },
    evidence: [],
    model: "gpt-5.6-luna",
    reasoning: "max",
    maxDurationMs: 5_000,
    maxOutputChars: 10_000,
  });
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.value.outcome, "completed");
  assert.equal(result.value.candidate?.head, SHA3);
  assert.deepEqual(
    result.value.candidate?.changedPaths,
    ["src/app.ts"],
    "candidate comes from the isolated checkout resolver",
  );

  const threadStart = session.sent.find(
    (frame) => frame.method === "thread/start",
  );
  assert.ok(threadStart, "thread/start was sent");
  const params = threadStart?.params as Record<string, unknown>;
  // Bounded isolated-checkout write capability: the narrowest write-capable
  // sandbox, scoped to the checkout cwd — not read-only (a commit would be
  // impossible) and never full access.
  assert.equal(params.sandbox, "workspace-write");
  assert.equal(params.cwd, CHECKOUT, "write scope is the isolated checkout");
  assert.equal(params.approvalPolicy, "never");
  assert.equal(params.ephemeral, true);
  assert.equal(params.model, "gpt-5.6-luna");
  assert.deepEqual(
    params.config,
    { model_reasoning_effort: "max" },
    "thread defaults are pinned to the requested runtime effort",
  );
  assert.equal(
    session.sent.some((frame) =>
      frame.method === "turn/start" &&
      (frame.params as Record<string, unknown>).effort === "max"
    ),
    true,
    "max reasoning is requested on the turn",
  );
  assert.equal(session.closeCalls, 1, "the session is always closed");
  assert.equal(
    session.openCalls,
    1,
    "the lazy session is opened at the model boundary",
  );
  assert.ok(
    verified.length === 1,
    "the trusted-host verifier observed the session evidence",
  );
});

Deno.test(
  "model-port: unavailable verifier fails closed before any session opens",
  async () => {
    const request: ModelRunRequestV1 = {
      taskId: asWorkItemId("issue-3"),
      repository: { ...REPO },
      base: SHA1,
      issue: null,
      evidence: [],
      model: "gpt-5.6-luna",
      reasoning: "max",
      maxDurationMs: 5_000,
      maxOutputChars: 10_000,
    };
    // Neither an absent nor the exported unavailable verifier may cause any
    // session (or other model work) to begin: the existing typed unavailable
    // result is returned before openSession is ever invoked.
    for (const supplied of [undefined, unavailableReceiptVerifier]) {
      let opened = 0;
      const port = new CodexImplementationPort({
        openSession: () => {
          opened++;
          throw new Error("no session may open without a certifying verifier");
        },
        checkoutDir: CHECKOUT,
        receiptVerifier: supplied,
      });
      const result = await port.runModel(request);
      assert.ok(!result.ok, JSON.stringify(result));
      if (!result.ok) {
        assert.equal(result.error.kind, "unavailable");
        assert.equal(
          result.error.detail,
          "model receipt unavailable: actual provider model/effort could not be verified at this boundary",
        );
      }
      assert.equal(
        opened,
        0,
        "no session opens and no model work begins without a configured verifier",
      );
    }
  },
);

Deno.test("model-port: a missing trusted receipt fails closed and still closes the session", async () => {
  const session = new FakeCodexSession();
  const port = new CodexImplementationPort({
    openSession: () => Promise.resolve(session),
    checkoutDir: CHECKOUT,
    checkout: {
      resolve: () =>
        Promise.resolve({ head: SHA3, checkpointSha: null, changedPaths: [] }),
    },
    receiptVerifier: () => null, // default boundary: activation unresolved
  });
  const result = await port.runModel({
    taskId: asWorkItemId("issue-2"),
    repository: { ...REPO },
    base: SHA1,
    issue: null,
    evidence: [],
    model: "gpt-5.6-luna",
    reasoning: "max",
    maxDurationMs: 5_000,
    maxOutputChars: 10_000,
  });
  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.error.kind, "unavailable");
  assert.equal(
    session.closeCalls,
    1,
    "fail-closed run still settles the session",
  );
});

Deno.test(
  "model-port: a base checkout never becomes a candidate without a commit",
  async () => {
    const session = new FakeCodexSession();
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      checkout: {
        resolve: () =>
          Promise.resolve({
            head: SHA1,
            checkpointSha: null,
            changedPaths: [],
          }),
      },
      receiptVerifier: () => ({
        observedModel: "gpt-5.6-luna",
        observedReasoning: "max",
      }),
    });
    const result = await port.runModel({
      taskId: asWorkItemId("issue-no-commit"),
      repository: { ...REPO },
      base: SHA1,
      issue: null,
      evidence: [],
      model: "gpt-5.6-luna",
      reasoning: "max",
      maxDurationMs: 5_000,
      maxOutputChars: 10_000,
    });
    assert.ok(result.ok, JSON.stringify(result));
    if (result.ok) {
      assert.equal(result.value.outcome, "completed");
      assert.equal(result.value.candidate, null);
    }
  },
);

Deno.test(
  "local candidate committer: stages sandbox edits and creates one descendant",
  async () => {
    const root = await Deno.makeTempDir({ prefix: "sentinel-model-commit-" });
    const home = `${root}/home`;
    await Deno.mkdir(home);
    const env = testGitEnv(home);
    const run = (args: string[]) => gitRun(root, args, env);
    const sha = async (): Promise<GitSha> => {
      const result = await run(["rev-parse", "HEAD"]);
      assert.ok(result.ok, result.stderr);
      return result.stdout.trim() as GitSha;
    };
    try {
      let result = await run(["init", "-q"]);
      assert.ok(result.ok, result.stderr);
      await Deno.writeTextFile(`${root}/src.ts`, "before\n");
      result = await run(["add", "-A"]);
      assert.ok(result.ok, result.stderr);
      result = await run(["commit", "-q", "-m", "base"]);
      assert.ok(result.ok, result.stderr);
      const base = await sha();
      await Deno.writeTextFile(`${root}/src.ts`, "after\n");

      const committed = await new LocalCandidateCommitter(root).commit(base);
      assert.equal(committed, true);
      const head = await sha();
      assert.notEqual(head, base);
      const resolved = await new LocalCheckoutResolver(root, base).resolve();
      assert.deepEqual(resolved?.changedPaths, ["src.ts"]);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "model-port: lazy session open is idempotent and a closed session fails closed at the open boundary",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "sentinel-model-open-" });
    // The child is an immediate exit only: it proves the owned transport
    // boundary without any JSON-RPC, network or model work.
    const makeSession = () =>
      new CodexSubprocessSession({
        command: [Deno.execPath(), "eval", "Deno.exit(0)"],
        cwd: dir,
        env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
        operationDeadlineMs: 30_000,
      });
    try {
      // A session closed before it was ever opened must not respawn.
      const closedEarly = makeSession();
      await closedEarly.close();
      assert.throws(
        () => closedEarly.open(),
        /transport already closed/,
        "never-opened closed session rejects a later open",
      );

      // Opening twice is idempotent (a trusted host pre-open plus the model
      // port's lazy boundary), and a closed session fails closed at open:
      // no silent no-op while its child handle is still set.
      const session = makeSession();
      session.open();
      session.open();
      await session.close();
      assert.throws(
        () => session.open(),
        /transport already closed/,
        "opened-then-closed session rejects a later open",
      );
      let rejected = false;
      try {
        await session.send("late", {});
      } catch {
        rejected = true;
      }
      assert.equal(rejected, true, "send after close still fails closed");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "model-port: checkout inventory includes both sides of a source rename",
  async () => {
    const root = await Deno.makeTempDir({ prefix: "sentinel-model-rename-" });
    const home = `${root}/home`;
    await Deno.mkdir(home);
    const env = testGitEnv(home);
    const run = (args: string[]) => gitRun(root, args, env);
    const sha = async (ref: string): Promise<GitSha> => {
      const result = await run(["rev-parse", ref]);
      assert.ok(result.ok, result.stderr);
      return result.stdout.trim() as GitSha;
    };

    try {
      const initialized = await run(["init", "-q"]);
      assert.ok(initialized.ok, initialized.stderr);
      await Deno.mkdir(`${root}/src`);
      await Deno.writeTextFile(`${root}/src/protected.ts`, "protected\n");
      let result = await run(["add", "-A"]);
      assert.ok(result.ok, result.stderr);
      result = await run(["commit", "-q", "-m", "base"]);
      assert.ok(result.ok, result.stderr);
      const base = await sha("HEAD");

      result = await run(["mv", "src/protected.ts", "src/renamed.ts"]);
      assert.ok(result.ok, result.stderr);
      result = await run(["commit", "-q", "-m", "rename"]);
      assert.ok(result.ok, result.stderr);
      const head = await sha("HEAD");

      const resolved = await new LocalCheckoutResolver(root, base).resolve();
      assert.ok(resolved, "the local checkout identity resolves");
      assert.equal(resolved?.head, head);
      assert.deepEqual(
        [...(resolved?.changedPaths ?? [])].sort(),
        ["src/protected.ts", "src/renamed.ts"],
        "protected source removals and destination additions are both visible",
      );
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
);
