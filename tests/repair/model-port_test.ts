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
import type {
  CodexServerNotificationV1,
  CodexServerRequestV1,
  CodexSessionV1,
} from "../../src/repair/codex-transport.ts";
import {
  type CodexProtocolError,
  CodexSubprocessSession,
} from "../../src/repair/codex-transport.ts";
import {
  CodexImplementationPort,
  createRequestRuntimeReceiptVerifier,
  LocalCandidateCommitter,
  LocalCheckoutResolver,
  unavailableReceiptVerifier,
} from "../../src/repair/model-port.ts";
import type {
  ActualSessionEvidenceV1,
  ModelRerouteV1,
} from "../../src/repair/model-port.ts";
import { gitRun, REPO, SHA1, SHA3, testGitEnv } from "../state/helpers.ts";

const CHECKOUT = "/tmp/sentinel-model-checkout";

/**
 * Schema-shaped completed file-change item per the installed ThreadItem
 * schema: required changes/id/status/type, status exactly `completed`, and a
 * nonempty changes array with the required path/kind/diff fields.
 */
const SCHEMA_FILE_CHANGE_ITEM = {
  type: "fileChange",
  status: "completed",
  changes: [{
    path: "src/app.ts",
    kind: { type: "update" },
    diff: "@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n",
  }],
};

/** Recording fake CodexSessionV1; emits one terminal turn/completed event. */
class FakeCodexSession implements CodexSessionV1 {
  readonly sent: { method: string; params: unknown }[] = [];
  openCalls = 0;
  closeCalls = 0;
  closed = false;
  private notifications:
    | ((event: CodexServerNotificationV1) => void)
    | null = null;
  private turnStarted = false;

  constructor(
    /**
     * Configured `activePermissionProfile` acknowledgement; undefined omits
     * the field entirely (the legacy thread acknowledgement).
     */
    private readonly activePermissionProfile?: Record<string, unknown>,
  ) {}

  open(): void {
    this.openCalls++;
  }

  send(method: string, params: unknown): Promise<unknown> {
    this.sent.push({ method, params });
    switch (method) {
      case "initialize":
        return Promise.resolve({ userAgent: "codex-app-server/0.153.4" });
      case "thread/start": {
        const ack: Record<string, unknown> = {
          thread: { id: "thread-1" },
          model: "gpt-5.6-luna",
          reasoningEffort: "max",
          modelProvider: "sentinel-host",
        };
        if (this.activePermissionProfile !== undefined) {
          ack.activePermissionProfile = this.activePermissionProfile;
        }
        return Promise.resolve(ack);
      }
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
      // A completed run needs genuine correlated output evidence: one
      // successful file-change item for the exact thread/turn, delivered
      // before the terminal event.
      queueMicrotask(() => {
        this.notifications?.({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { ...SCHEMA_FILE_CHANGE_ITEM, id: "ok-output" },
          },
        });
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
    this.closed = true;
    return Promise.resolve();
  }
}

class ThrowingNotificationSession extends FakeCodexSession {
  override onNotification(
    _handler: (event: CodexServerNotificationV1) => void,
  ): void {
    throw new Error("synthetic registration failure");
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
    // A valid provider is required before any session opens; the custom
    // verifier below stays an ADDITIONAL restriction after the core checks.
    modelProvider: "sentinel-host",
    receiptVerifier: (evidence) => {
      verified.push(evidence);
      if (
        evidence.threadModel === "gpt-5.6-luna" &&
        evidence.terminal.status === "completed"
      ) {
        return {
          provider: evidence.threadModelProvider ?? "sentinel-host",
          observedModel: "gpt-5.6-luna",
          observedReasoning: "max",
        };
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
  assert.equal(
    "permissions" in params,
    false,
    "an omitted permission profile keeps the legacy sandbox request",
  );
  const initialize = session.sent.find(
    (frame) => frame.method === "initialize",
  );
  assert.deepEqual(
    (initialize?.params as Record<string, unknown>).capabilities,
    { experimentalApi: false, requestAttestation: false },
    "an omitted permission profile keeps the legacy capabilities",
  );
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
  "runtime prompt: thread/start and turn/start carry the runtime implementer role and request bounds",
  async () => {
    const session = new FakeCodexSession();
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
      modelProvider: "sentinel-host",
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
      maxOutputChars: 12_345,
    });
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.value.outcome, "completed");

    // The assertions read the ACTUAL session frames: the prompt is the real
    // thread/turn payload used by the runtime, not a helper-only echo.
    const threadStart = session.sent.find(
      (frame) => frame.method === "thread/start",
    );
    const turnStart = session.sent.find(
      (frame) => frame.method === "turn/start",
    );
    assert.ok(threadStart, "thread/start was sent");
    assert.ok(turnStart, "turn/start was sent");
    const baseInstructions = (threadStart?.params as Record<string, unknown>)
      .baseInstructions;
    assert.equal(typeof baseInstructions, "string");
    const turnInput = (turnStart?.params as Record<string, unknown>).input as
      | { type?: unknown; text?: unknown }[]
      | undefined;
    assert.equal(turnInput?.[0]?.type, "text");
    assert.equal(
      turnInput?.[0]?.text,
      baseInstructions,
      "the same runtime prompt is submitted on thread/start and turn/start",
    );

    const prompt = (baseInstructions as string).toLowerCase();
    for (
      const required of [
        "runtime implementer role",
        "edit only the current provided checkout",
        "do not run git add, git commit or git push",
        "worktrees",
        "delegate",
        "the trusted host owns commits, pushes, review and release",
        "do not take over master-plan orchestration",
        "protected paths",
        "credentials",
        "expected test assertions",
        "gpt-5.6-luna",
        "max reasoning",
        "total event output allowance is 12345 characters",
        "keep individual command output bounded",
        "never dump docs/build-status.md in full",
        "bounded matching sections",
        "concise final response",
      ]
    ) {
      assert.ok(
        prompt.includes(required),
        `runtime prompt carries: ${required}`,
      );
    }
    assert.equal(
      prompt.includes("minimal commit"),
      false,
      "the obsolete commit-production instruction is gone",
    );
  },
);

Deno.test(
  "model-port: permission profile gates capabilities, thread permissions and exact acknowledgement",
  async () => {
    const session = new FakeCodexSession({ id: "sentinel-repair" });
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
      modelProvider: "sentinel-host",
      permissionProfile: "sentinel-repair",
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

    const initialize = session.sent.find(
      (frame) => frame.method === "initialize",
    );
    assert.ok(initialize, "initialize was sent");
    assert.deepEqual(
      (initialize?.params as Record<string, unknown>).capabilities,
      { experimentalApi: true, requestAttestation: false },
      "experimental capabilities are enabled only for a configured profile",
    );
    const threadStart = session.sent.find(
      (frame) => frame.method === "thread/start",
    );
    assert.ok(threadStart, "thread/start was sent");
    const params = threadStart?.params as Record<string, unknown>;
    assert.equal(params.permissions, "sentinel-repair");
    assert.equal(
      "sandbox" in params,
      false,
      "the named profile replaces the legacy sandbox",
    );
    assert.equal(params.cwd, CHECKOUT);
    assert.equal(params.approvalPolicy, "never");
    const turnStart = session.sent.find(
      (frame) => frame.method === "turn/start",
    );
    assert.ok(turnStart, "turn/start was sent");
    const turnParams = turnStart?.params as Record<string, unknown>;
    assert.equal(
      "permissions" in turnParams,
      false,
      "the implementation turn inherits the thread profile",
    );
    assert.equal("sandboxPolicy" in turnParams, false);
    assert.equal(session.closeCalls, 1);
  },
);

Deno.test(
  "model-port: permission profile missing or wrong acknowledgement fails closed before any turn",
  async (t) => {
    const cases: [string, Record<string, unknown> | undefined][] = [
      ["missing", undefined],
      ["wrong", { id: "other-profile" }],
    ];
    for (const [label, ack] of cases) {
      await t.step(label, async () => {
        const session = ack === undefined
          ? new FakeCodexSession()
          : new FakeCodexSession(ack);
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
          modelProvider: "sentinel-host",
          permissionProfile: "sentinel-repair",
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
        assert.equal(
          result.ok,
          false,
          `${label} acknowledgement must fail closed`,
        );
        if (result.ok) return;
        assert.equal(result.error.kind, "unavailable");
        assert.equal(
          session.sent.some((frame) => frame.method === "turn/start"),
          false,
          "no turn starts without the exact acknowledgement",
        );
        assert.equal(session.closeCalls, 1, "the owned session settles");
      });
    }
  },
);

Deno.test(
  "model-port: invalid permission profile opens no session",
  async (t) => {
    const invalidProfiles = [
      "",
      "1bad",
      "bad profile",
      "a".repeat(65),
      "danger-full-access",
      "full-access",
    ];
    for (const profile of invalidProfiles) {
      await t.step(JSON.stringify(profile), async () => {
        const session = new FakeCodexSession({ id: profile });
        let opened = 0;
        const port = new CodexImplementationPort({
          openSession: () => {
            opened++;
            return Promise.resolve(session);
          },
          checkoutDir: CHECKOUT,
          modelProvider: "sentinel-host",
          permissionProfile: profile,
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
        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.error.kind, "unavailable");
        assert.equal(opened, 0, "no session opens for an invalid profile");
        assert.equal(session.sent.length, 0);
      });
    }
  },
);

Deno.test(
  "model-port: candidate commit waits for model session settlement",
  async () => {
    const session = new FakeCodexSession();
    let commitObservedClosed = false;
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
      commitCandidate: {
        commit: () => {
          commitObservedClosed = session.closed;
          return Promise.resolve(true);
        },
      },
      modelProvider: "sentinel-host",
      receiptVerifier: () => ({
        provider: "sentinel-host",
        observedModel: "gpt-5.6-luna",
        observedReasoning: "max",
      }),
    });
    const result = await port.runModel({
      taskId: asWorkItemId("issue-commit-order"),
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
    assert.equal(commitObservedClosed, true);
    assert.equal(session.closeCalls, 1);
  },
);

Deno.test(
  "model-port: notification registration failure clears settlement timers and stays unavailable",
  async () => {
    const session = new ThrowingNotificationSession();
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
      receiptVerifier: () => ({
        provider: "sentinel-host",
        observedModel: "gpt-5.6-luna",
        observedReasoning: "max",
      }),
    });
    const started = performance.now();
    const result = await port.runModel({
      taskId: asWorkItemId("issue-notification-registration"),
      repository: { ...REPO },
      base: SHA1,
      issue: null,
      evidence: [],
      model: "gpt-5.6-luna",
      reasoning: "max",
      maxDurationMs: 2_000,
      maxOutputChars: 10_000,
    });
    // Notification registration failure is protocol uncertainty: the sticky
    // unavailable disposition returns unavailable (never a certifiable failed
    // runtime receipt — the custom verifier is never reached without concrete
    // request/runtime evidence).
    assert.ok(!result.ok, JSON.stringify(result));
    if (!result.ok) {
      assert.equal(result.error.kind, "unavailable");
      assert.equal(result.error.detail, "notification registration failed");
    }
    assert.equal(session.closeCalls, 1);
    assert.ok(
      performance.now() - started < 500,
      "registration failure must settle without waiting for the duration timer",
    );
  },
);

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
    // result is returned before openSession is ever invoked. Without an
    // explicit modelProvider no session may open even with a verifier.
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
    modelProvider: "sentinel-host",
    checkout: {
      resolve: () =>
        Promise.resolve({ head: SHA3, checkpointSha: null, changedPaths: [] }),
    },
    receiptVerifier: () => null, // additional restriction: activation unresolved
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
      modelProvider: "sentinel-host",
      receiptVerifier: () => ({
        provider: "sentinel-host",
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

// ---------------------------------------------------------------------------
// T02 request/runtime receipt producer (concrete verifier + port validation).
// ---------------------------------------------------------------------------

/**
 * Scripted fake session: acknowledges the configured thread/turn identity
 * and delivers the registered event script in wire order at registration.
 */
class ScriptedSession implements CodexSessionV1 {
  readonly sent: { method: string; params: unknown }[] = [];
  closeCalls = 0;
  private notifications:
    | ((event: CodexServerNotificationV1) => void)
    | null = null;

  constructor(
    private readonly threadAck: Record<string, unknown>,
    private readonly turnAck: Record<string, unknown>,
    private readonly events: { method: string; params: unknown }[],
    private readonly interruptTerminalStatus?:
      | "completed"
      | "interrupted"
      | "failed",
    /**
     * Optional post-terminal close script: the port awaits `close()`, so
     * events emitted here (synchronously or after awaited ticks) arrive after
     * the terminal settlement but before the port captures final evidence.
     */
    private readonly closeScript?: (
      emit: (method: string, params: unknown) => void,
    ) => void | Promise<void>,
  ) {}

  open(): void {}

  send(method: string, params: unknown): Promise<unknown> {
    this.sent.push({ method, params });
    switch (method) {
      case "initialize":
        return Promise.resolve({ userAgent: "codex-app-server/0.153.4" });
      case "thread/start":
        return Promise.resolve(this.threadAck);
      case "turn/start":
        return Promise.resolve(this.turnAck);
      case "turn/interrupt":
        if (this.interruptTerminalStatus !== undefined) {
          // Race the interrupt with a runtime terminal event for the exact
          // thread/turn (mirrors the real app-server event order).
          this.notifications?.({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: {
                id: "turn-1",
                status: this.interruptTerminalStatus,
                durationMs: 1,
              },
            },
          });
        }
        return Promise.resolve({});
      default:
        return Promise.resolve({});
    }
  }

  notify(): void {}

  onServerRequest(): void {}

  onNotification(handler: (event: CodexServerNotificationV1) => void): void {
    this.notifications = handler;
    for (const event of this.events) handler(event);
  }

  /** Deliver one event through the registered handler, as the transport would. */
  emit(method: string, params: unknown): void {
    this.notifications?.({ method, params });
  }

  async close(): Promise<void> {
    this.closeCalls++;
    if (this.closeScript !== undefined) {
      await this.closeScript((method, params) => this.emit(method, params));
    }
  }
}

/** One genuine schema-shaped correlated file-change output item for the exact thread/turn. */
const SUCCESS_ITEM = {
  method: "item/completed",
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    item: { ...SCHEMA_FILE_CHANGE_ITEM, id: "ok-output" },
  },
};

const COMPLETED_TERMINAL = {
  method: "turn/completed",
  params: {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed", durationMs: 5 },
  },
};

function requestRuntimeEvidence(
  overrides: Partial<ActualSessionEvidenceV1> = {},
): ActualSessionEvidenceV1 {
  return {
    invocationId: "invoke-1",
    requestedModel: "gpt-5.6-luna",
    requestedProvider: "sentinel-host",
    requestedEffort: "max",
    threadId: "thread-1",
    turnId: "turn-1",
    threadModel: "gpt-5.6-luna",
    threadModelProvider: "sentinel-host",
    threadEffort: "max",
    reroutes: [],
    terminal: { status: "completed", error: null, durationMs: 5 },
    terminalOrigin: "runtime",
    loopStopped: false,
    resultItems: [{ itemId: "ok-1", type: "fileChange" }],
    outputChars: 42,
    ...overrides,
  };
}

/** A completed-run model request as the loop submits it. */
function runtimeRequest(
  overrides: Partial<ModelRunRequestV1> = {},
): ModelRunRequestV1 {
  return {
    taskId: asWorkItemId("issue-runtime"),
    repository: { ...REPO },
    base: SHA1,
    issue: null,
    evidence: [],
    model: "gpt-5.6-luna",
    reasoning: "max",
    maxDurationMs: 5_000,
    maxOutputChars: 10_000,
    ...overrides,
  };
}

Deno.test(
  "request/runtime verifier: certifies correlated completed evidence and returns validated values only",
  () => {
    const verified = createRequestRuntimeReceiptVerifier("sentinel-host")(
      requestRuntimeEvidence(),
    );
    assert.deepEqual(verified, {
      provider: "sentinel-host",
      observedModel: "gpt-5.6-luna",
      observedReasoning: "max",
    });
  },
);

Deno.test(
  "request/runtime verifier: never trusts caller strings as provider attestation and fails closed on mismatched identity/policy",
  () => {
    const verify = createRequestRuntimeReceiptVerifier("sentinel-host");
    // A caller-claimed provider string is never returned as attestation; the
    // expected provider is the only trusted provider identity.
    assert.equal(
      verify(requestRuntimeEvidence({ threadModelProvider: "other-provider" })),
      null,
      "acknowledged provider does not match the selected provider",
    );
    assert.equal(
      verify(requestRuntimeEvidence({ requestedProvider: "other-provider" })),
      null,
      "requested provider does not match the selected provider",
    );
    assert.equal(
      verify(requestRuntimeEvidence({ threadModel: "gpt-5.4" })),
      null,
      "thread model is not Luna",
    );
    assert.equal(
      verify(requestRuntimeEvidence({ threadEffort: "medium" })),
      null,
      "thread effort is not max",
    );
    assert.equal(
      verify(requestRuntimeEvidence({ requestedModel: "gpt-5.4" })),
      null,
      "requested model is not Luna",
    );
    assert.equal(
      verify(requestRuntimeEvidence({ requestedEffort: "medium" })),
      null,
      "requested effort is not max",
    );
    assert.equal(
      verify(requestRuntimeEvidence({ threadId: "" })),
      null,
      "empty thread id",
    );
    assert.equal(
      verify(requestRuntimeEvidence({ turnId: "" })),
      null,
      "empty turn id",
    );
    assert.equal(
      verify(requestRuntimeEvidence({ invocationId: "" })),
      null,
      "empty invocation id",
    );
    // The verifier itself never accepts an invalid expected provider.
    assert.equal(
      createRequestRuntimeReceiptVerifier("")(
        requestRuntimeEvidence(),
      ),
      null,
      "invalid expected provider",
    );
  },
);

Deno.test(
  "request/runtime verifier: ignores well-formed unrelated reroutes",
  () => {
    const reroutes: ModelRerouteV1[] = [{
      threadId: "thread-9",
      turnId: "turn-9",
      from: "gpt-5.6-luna",
      to: "gpt-5.4",
      reason: "capacity",
    }];
    assert.ok(
      createRequestRuntimeReceiptVerifier("sentinel-host")(
        requestRuntimeEvidence({ reroutes }),
      ) !== null,
      "a well-formed reroute for another thread/turn is ignored",
    );
  },
);

Deno.test(
  "request/runtime verifier: any matching reroute off required Luna fails even when routed back",
  () => {
    const verify = createRequestRuntimeReceiptVerifier("sentinel-host");
    const offAndBack: ModelRerouteV1[] = [
      {
        threadId: "thread-1",
        turnId: "turn-1",
        from: "gpt-5.6-luna",
        to: "gpt-5.4",
        reason: "off",
      },
      {
        threadId: "thread-1",
        turnId: "turn-1",
        from: "gpt-5.4",
        to: "gpt-5.6-luna",
        reason: "back",
      },
    ];
    assert.equal(
      verify(requestRuntimeEvidence({ reroutes: offAndBack })),
      null,
      "off Luna then routed back still fails",
    );
  },
);

Deno.test("request/runtime verifier: malformed matching reroute fails closed", () => {
  const verify = createRequestRuntimeReceiptVerifier("sentinel-host");
  assert.equal(
    verify(requestRuntimeEvidence({
      reroutes: [{
        threadId: "thread-1",
        turnId: "turn-1",
        from: "",
        to: "gpt-5.4",
        reason: null,
      }],
    })),
    null,
    "unbounded from model",
  );
  assert.equal(
    verify(requestRuntimeEvidence({
      reroutes: [{
        threadId: "thread-1",
        turnId: "turn-1",
        from: "gpt-5.6-luna",
        to: "gpt-5.6-luna",
        reason: null,
      }],
    })),
    null,
    "identity reroute is malformed",
  );
  assert.equal(
    verify(requestRuntimeEvidence({
      reroutes: [{
        threadId: "thread-1",
        turnId: "turn-1",
        from: "gpt-5.4",
        to: "gpt-5.6-luna",
        reason: null,
      }],
    })),
    null,
    "routed back from another model still fails",
  );
  assert.equal(
    verify(requestRuntimeEvidence({
      reroutes: [{
        threadId: "thread-1",
        turnId: "turn-1",
        from: "gpt-5.6-luna",
        to: "gpt-5.4",
        reason: "",
      }],
    })),
    null,
    "unbounded reason",
  );
});

Deno.test(
  "request/runtime verifier: completed needs nonempty output; failed/interrupted and host-timeout retain without it",
  () => {
    const verify = createRequestRuntimeReceiptVerifier("sentinel-host");
    assert.equal(
      verify(requestRuntimeEvidence({ resultItems: [] })),
      null,
      "completed without correlated output is not certified",
    );
    assert.ok(
      verify(requestRuntimeEvidence({
        resultItems: [],
        terminal: { status: "interrupted", error: null, durationMs: null },
      })) !== null,
      "interrupted receipts may lack output and stay certifiable",
    );
    assert.ok(
      verify(requestRuntimeEvidence({
        resultItems: [],
        terminal: { status: "failed", error: "synthetic", durationMs: null },
      })) !== null,
      "failed receipts may lack output and stay certifiable",
    );
    // Host-timeout accounting: no observed terminal (null status) with the
    // explicit `host-timeout` origin stays certifiable WITHOUT claiming a
    // terminal was observed; output is not required for failed accounting.
    assert.deepEqual(
      verify(requestRuntimeEvidence({
        resultItems: [],
        terminal: { status: null, error: null, durationMs: null },
        terminalOrigin: "host-timeout",
      })),
      {
        provider: "sentinel-host",
        observedModel: "gpt-5.6-luna",
        observedReasoning: "max",
      },
      "host-timeout stays certifiable as failed accounting without an observed terminal",
    );
    // Origin consistency: an observed terminal is only runtime evidence; a
    // null observed status is only host-timeout evidence.
    assert.equal(
      verify(requestRuntimeEvidence({
        terminal: { status: null, error: null, durationMs: null },
      })),
      null,
      "runtime origin with no observed terminal is never certified",
    );
    assert.equal(
      verify(requestRuntimeEvidence({
        terminalOrigin: "host-timeout",
      })),
      null,
      "host-timeout origin with an observed terminal is never certified",
    );
    // Loop-stop race: a completed runtime terminal with no output is only
    // certifiable when the host itself stopped the run — after which only
    // interrupted/no-candidate accounting is permitted.
    assert.ok(
      verify(requestRuntimeEvidence({
        resultItems: [],
        loopStopped: true,
      })) !== null,
      "host-stopped completed race may be certified for interrupted accounting",
    );
  },
);

Deno.test(
  "model-port: real concrete producer certifies a correlated completed run (no injected verifier)",
  async () => {
    const session = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [SUCCESS_ITEM, COMPLETED_TERMINAL],
    );
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
      checkout: {
        resolve: () =>
          Promise.resolve({
            head: SHA3,
            checkpointSha: null,
            changedPaths: ["src/app.ts"],
          }),
      },
    });
    const result = await port.runModel(runtimeRequest());
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.value.outcome, "completed");
    assert.equal(result.value.candidate?.head, SHA3);
    assert.equal(result.value.actual.evidenceKind, "request-runtime");
    assert.equal(result.value.actual.provider, "sentinel-host");
    assert.equal(result.value.actual.threadId, "thread-1");
    assert.equal(result.value.actual.turnId, "turn-1");
    assert.equal(result.value.actual.observedModel, "gpt-5.6-luna");
    assert.equal(result.value.actual.observedReasoning, "max");
    assert.equal(result.value.actual.durationMs, 5);
    assert.equal(
      result.value.actual.observedTerminalStatus,
      "completed",
      "the exact observed runtime terminal status is preserved",
    );
    assert.equal(session.closeCalls, 1);
    const threadStart = session.sent.find(
      (frame) => frame.method === "thread/start",
    );
    assert.ok(threadStart, "thread/start was sent");
    assert.equal(
      (threadStart?.params as Record<string, unknown>).modelProvider,
      "sentinel-host",
      "the selected provider is submitted explicitly on thread/start",
    );
    const turnStartIndex = session.sent.findIndex(
      (frame) => frame.method === "turn/start",
    );
    const threadStartIndex = session.sent.findIndex(
      (frame) => frame.method === "thread/start",
    );
    assert.ok(
      turnStartIndex > threadStartIndex,
      "the thread acknowledgment precedes any turn start",
    );
  },
);

Deno.test(
  "model-port: provider/model/effort mismatch in thread acknowledgment fails before any turn starts",
  async () => {
    const mismatches: Record<string, unknown>[] = [
      {
        thread: { id: "thread-1" },
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        modelProvider: "other-provider",
      },
      {
        thread: { id: "thread-1" },
        model: "gpt-5.4",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      {
        thread: { id: "thread-1" },
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
        modelProvider: "sentinel-host",
      },
    ];
    for (const threadAck of mismatches) {
      const session = new ScriptedSession(
        threadAck,
        { turn: { id: "turn-1" } },
        [],
      );
      const port = new CodexImplementationPort({
        openSession: () => Promise.resolve(session),
        checkoutDir: CHECKOUT,
        modelProvider: "sentinel-host",
      });
      const result = await port.runModel(runtimeRequest());
      assert.ok(!result.ok, JSON.stringify(result));
      if (!result.ok) assert.equal(result.error.kind, "unavailable");
      assert.equal(
        session.sent.some((frame) => frame.method === "turn/start"),
        false,
        `no model turn may start after a mismatch (${
          JSON.stringify(threadAck)
        })`,
      );
      assert.equal(
        session.closeCalls,
        1,
        "the session is settled after the fail-closed mismatch",
      );
    }
  },
);

Deno.test(
  "model-port: missing or over-bound session identities fail closed",
  async () => {
    // Missing/empty/over-bound thread id: rejected before any turn starts.
    for (const threadId of ["", "x".repeat(300)]) {
      const session = new ScriptedSession(
        {
          thread: { id: threadId },
          model: "gpt-5.6-luna",
          reasoningEffort: "max",
          modelProvider: "sentinel-host",
        },
        { turn: { id: "turn-1" } },
        [],
      );
      const port = new CodexImplementationPort({
        openSession: () => Promise.resolve(session),
        checkoutDir: CHECKOUT,
        modelProvider: "sentinel-host",
      });
      const result = await port.runModel(runtimeRequest());
      assert.ok(!result.ok, JSON.stringify(result));
      if (!result.ok) assert.equal(result.error.kind, "unavailable");
      assert.equal(
        session.sent.some((frame) => frame.method === "turn/start"),
        false,
        "a missing/over-bound thread id never spends a turn",
      );
    }
    // Missing/empty turn id: rejected after thread/start, before work begins.
    for (const turnId of ["", "y".repeat(300)]) {
      const session = new ScriptedSession(
        {
          thread: { id: "thread-1" },
          model: "gpt-5.6-luna",
          reasoningEffort: "max",
          modelProvider: "sentinel-host",
        },
        { turn: { id: turnId } },
        [],
      );
      const port = new CodexImplementationPort({
        openSession: () => Promise.resolve(session),
        checkoutDir: CHECKOUT,
        modelProvider: "sentinel-host",
      });
      const result = await port.runModel(runtimeRequest());
      assert.ok(!result.ok, JSON.stringify(result));
      if (!result.ok) assert.equal(result.error.kind, "unavailable");
      assert.equal(session.closeCalls, 1);
    }
  },
);

Deno.test(
  "model-port: well-formed unrelated reroute is ignored; matching off-Luna fails even when routed back",
  async () => {
    // Unrelated reroute: well-formed thread/turn identity, ignored completely.
    const unrelated = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [
        {
          method: "model/rerouted",
          params: {
            threadId: "thread-other",
            turnId: "turn-other",
            fromModel: "gpt-5.6-luna",
            toModel: "gpt-5.4",
          },
        },
        SUCCESS_ITEM,
        COMPLETED_TERMINAL,
      ],
    );
    const ignoringPort = new CodexImplementationPort({
      openSession: () => Promise.resolve(unrelated),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
      checkout: {
        resolve: () =>
          Promise.resolve({
            head: SHA3,
            checkpointSha: null,
            changedPaths: ["src/app.ts"],
          }),
      },
    });
    const ignored = await ignoringPort.runModel(runtimeRequest());
    assert.ok(ignored.ok, JSON.stringify(ignored));
    if (!ignored.ok) return;
    assert.equal(ignored.value.outcome, "completed");

    // Matching reroute off Luna then routed back: the sticky unavailable
    // disposition rejects routing uncertainty before ANY verifier/candidate
    // action — never a certifiable failed runtime receipt, and never a
    // candidate.
    const offAndBack = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [
        {
          method: "model/rerouted",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            fromModel: "gpt-5.6-luna",
            toModel: "gpt-5.4",
          },
        },
        {
          method: "model/rerouted",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            fromModel: "gpt-5.4",
            toModel: "gpt-5.6-luna",
          },
        },
        SUCCESS_ITEM,
        COMPLETED_TERMINAL,
      ],
    );
    const failingPort = new CodexImplementationPort({
      openSession: () => Promise.resolve(offAndBack),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
    });
    const result = await failingPort.runModel(runtimeRequest());
    assert.ok(!result.ok, JSON.stringify(result));
    if (!result.ok) {
      assert.equal(result.error.kind, "unavailable");
      assert.equal(result.error.detail, "run routed off required Luna/max");
    }
    assert.equal(offAndBack.closeCalls, 1);
  },
);

Deno.test(
  "model-port: malformed matching reroute fails closed",
  async () => {
    // Event missing a turn id: cannot be correlated, evidence is ambiguous.
    const missingTurnId = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [
        {
          method: "model/rerouted",
          params: {
            threadId: "thread-1",
            fromModel: "gpt-5.6-luna",
            toModel: "gpt-5.4",
          },
        },
        SUCCESS_ITEM,
        COMPLETED_TERMINAL,
      ],
    );
    const first = new CodexImplementationPort({
      openSession: () => Promise.resolve(missingTurnId),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
    });
    const result = await first.runModel(runtimeRequest());
    assert.ok(!result.ok, JSON.stringify(result));
    if (!result.ok) {
      assert.equal(result.error.kind, "unavailable");
      assert.equal(
        result.error.detail,
        "malformed reroute identity",
        result.error.detail ?? "",
      );
    }
    assert.equal(missingTurnId.closeCalls, 1);

    // Matching event with malformed models: fail closed.
    const malformedModels = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [
        {
          method: "model/rerouted",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            fromModel: "gpt-5.6-luna",
            toModel: 42,
          },
        },
        SUCCESS_ITEM,
        COMPLETED_TERMINAL,
      ],
    );
    const second = new CodexImplementationPort({
      openSession: () => Promise.resolve(malformedModels),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
    });
    const malformed = await second.runModel(runtimeRequest());
    assert.ok(!malformed.ok, JSON.stringify(malformed));
    if (!malformed.ok) {
      assert.equal(malformed.error.kind, "unavailable");
      assert.equal(
        malformed.error.detail,
        "malformed matching reroute",
        malformed.error.detail ?? "",
      );
    }
    assert.equal(malformedModels.closeCalls, 1);
  },
);

// ---------------------------------------------------------------------------
// Shutdown routing: correlated reroutes delivered after the terminal — while
// the notification script is still replaying at registration or during an
// awaited close — must still fail closed before ANY side effect.
// ---------------------------------------------------------------------------

const THREAD_ACK = {
  thread: { id: "thread-1" },
  model: "gpt-5.6-luna",
  reasoningEffort: "max",
  modelProvider: "sentinel-host",
};
const TURN_ACK = { turn: { id: "turn-1" } };

const OFF_POLICY_LATE_REROUTE = {
  method: "model/rerouted",
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    fromModel: "gpt-5.6-luna",
    toModel: "gpt-5.4",
  },
};

const MALFORMED_IDENTITY_LATE_REROUTE = {
  method: "model/rerouted",
  params: {
    threadId: "thread-1",
    fromModel: "gpt-5.6-luna",
    toModel: "gpt-5.4",
  },
};

const MALFORMED_MODELS_LATE_REROUTE = {
  method: "model/rerouted",
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    fromModel: "gpt-5.6-luna",
    toModel: 42,
  },
};

/** Port whose verifier/committer/resolver count every invocation. */
function lateReroutePort(
  session: ScriptedSession,
  counters: { verifier: number; commit: number; resolve: number },
): CodexImplementationPort {
  return new CodexImplementationPort({
    openSession: () => Promise.resolve(session),
    checkoutDir: CHECKOUT,
    modelProvider: "sentinel-host",
    receiptVerifier: (evidence) => {
      counters.verifier++;
      return createRequestRuntimeReceiptVerifier("sentinel-host")(evidence);
    },
    commitCandidate: {
      commit: () => {
        counters.commit++;
        return Promise.resolve(true);
      },
    },
    checkout: {
      resolve: () => {
        counters.resolve++;
        return Promise.resolve({
          head: SHA3,
          checkpointSha: null,
          changedPaths: ["src/app.ts"],
        });
      },
    },
  });
}

Deno.test(
  "shutdown routing: off-policy reroute after terminal (sync and during awaited close) is unavailable with zero side effects",
  async () => {
    // Emitted synchronously by the notification script AFTER the completed
    // terminal already settled the run.
    const afterTerminal = new ScriptedSession(
      THREAD_ACK,
      TURN_ACK,
      [SUCCESS_ITEM, COMPLETED_TERMINAL, OFF_POLICY_LATE_REROUTE],
    );
    const syncCounters = { verifier: 0, commit: 0, resolve: 0 };
    const syncResult = await lateReroutePort(afterTerminal, syncCounters)
      .runModel(runtimeRequest());
    assert.ok(!syncResult.ok, JSON.stringify(syncResult));
    if (!syncResult.ok) {
      assert.equal(syncResult.error.kind, "unavailable");
      assert.equal(
        syncResult.error.detail,
        "run routed off required Luna/max",
      );
    }
    assert.equal(afterTerminal.closeCalls, 1);
    assert.deepEqual(syncCounters, { verifier: 0, commit: 0, resolve: 0 });

    // Emitted synchronously and after an awaited tick from inside close(),
    // i.e. while the port is still completing shutdown.
    const duringClose = new ScriptedSession(
      THREAD_ACK,
      TURN_ACK,
      [SUCCESS_ITEM, COMPLETED_TERMINAL],
      undefined,
      async (emit) => {
        emit(
          OFF_POLICY_LATE_REROUTE.method,
          OFF_POLICY_LATE_REROUTE.params,
        );
        await Promise.resolve();
        emit(
          OFF_POLICY_LATE_REROUTE.method,
          OFF_POLICY_LATE_REROUTE.params,
        );
      },
    );
    const closeCounters = { verifier: 0, commit: 0, resolve: 0 };
    const closeResult = await lateReroutePort(duringClose, closeCounters)
      .runModel(runtimeRequest());
    assert.ok(!closeResult.ok, JSON.stringify(closeResult));
    if (!closeResult.ok) {
      assert.equal(closeResult.error.kind, "unavailable");
      assert.equal(
        closeResult.error.detail,
        "run routed off required Luna/max",
      );
    }
    assert.equal(duringClose.closeCalls, 1);
    assert.deepEqual(closeCounters, { verifier: 0, commit: 0, resolve: 0 });
  },
);

Deno.test(
  "shutdown routing: malformed reroute after terminal (sync and during awaited close) is unavailable with zero side effects",
  async () => {
    const afterTerminal = new ScriptedSession(
      THREAD_ACK,
      TURN_ACK,
      [SUCCESS_ITEM, COMPLETED_TERMINAL, MALFORMED_IDENTITY_LATE_REROUTE],
    );
    const syncCounters = { verifier: 0, commit: 0, resolve: 0 };
    const syncResult = await lateReroutePort(afterTerminal, syncCounters)
      .runModel(runtimeRequest());
    assert.ok(!syncResult.ok, JSON.stringify(syncResult));
    if (!syncResult.ok) {
      assert.equal(syncResult.error.kind, "unavailable");
      assert.equal(syncResult.error.detail, "malformed reroute identity");
    }
    assert.equal(afterTerminal.closeCalls, 1);
    assert.deepEqual(syncCounters, { verifier: 0, commit: 0, resolve: 0 });

    const duringClose = new ScriptedSession(
      THREAD_ACK,
      TURN_ACK,
      [SUCCESS_ITEM, COMPLETED_TERMINAL],
      undefined,
      async (emit) => {
        await Promise.resolve();
        emit(
          MALFORMED_MODELS_LATE_REROUTE.method,
          MALFORMED_MODELS_LATE_REROUTE.params,
        );
      },
    );
    const closeCounters = { verifier: 0, commit: 0, resolve: 0 };
    const closeResult = await lateReroutePort(duringClose, closeCounters)
      .runModel(runtimeRequest());
    assert.ok(!closeResult.ok, JSON.stringify(closeResult));
    if (!closeResult.ok) {
      assert.equal(closeResult.error.kind, "unavailable");
      assert.equal(closeResult.error.detail, "malformed matching reroute");
    }
    assert.equal(duringClose.closeCalls, 1);
    assert.deepEqual(closeCounters, { verifier: 0, commit: 0, resolve: 0 });
  },
);

Deno.test(
  "shutdown routing: unrelated late reroute stays ignored and a clean completed run commits only after close",
  async () => {
    let commitCalls = 0;
    let resolveCalls = 0;
    let closeCallsAtCommit = -1;
    const session = new ScriptedSession(
      THREAD_ACK,
      TURN_ACK,
      [SUCCESS_ITEM, COMPLETED_TERMINAL],
      undefined,
      async (emit) => {
        // Well-formed but unrelated identities: never correlated, so the
        // completed run stays clean and still commits.
        emit("model/rerouted", {
          threadId: "thread-other",
          turnId: "turn-other",
          fromModel: "gpt-5.6-luna",
          toModel: "gpt-5.4",
        });
        await Promise.resolve();
        emit("model/rerouted", {
          threadId: "thread-2",
          turnId: "turn-2",
          fromModel: "gpt-5.4",
          toModel: "gpt-5.4",
        });
      },
    );
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
      commitCandidate: {
        commit: () => {
          commitCalls++;
          closeCallsAtCommit = session.closeCalls;
          return Promise.resolve(true);
        },
      },
      checkout: {
        resolve: () => {
          resolveCalls++;
          return Promise.resolve({
            head: SHA3,
            checkpointSha: null,
            changedPaths: ["src/app.ts"],
          });
        },
      },
    });
    const result = await port.runModel(runtimeRequest());
    assert.ok(result.ok, JSON.stringify(result));
    if (result.ok) {
      assert.equal(result.value.outcome, "completed");
      assert.equal(result.value.actual.observedTerminalStatus, "completed");
    }
    assert.equal(session.closeCalls, 1);
    assert.equal(commitCalls, 1);
    assert.equal(resolveCalls, 1);
    assert.equal(
      closeCallsAtCommit,
      1,
      "the candidate commit runs only after the session closed",
    );
  },
);

Deno.test(
  "shutdown routing: well-formed unrelated routing events during close exceed the request output bound without side effects",
  async () => {
    const session = new ScriptedSession(
      THREAD_ACK,
      TURN_ACK,
      [SUCCESS_ITEM, COMPLETED_TERMINAL],
      undefined,
      async (emit) => {
        // Well-formed but unrelated identities: correlation alone ignores
        // them, while the bounded total must still fail the run closed.
        for (let index = 0; index < 10; index++) {
          emit("model/rerouted", {
            threadId: `thread-other-${index}`,
            turnId: `turn-other-${index}`,
            fromModel: "gpt-5.6-luna",
            toModel: "gpt-5.4",
          });
        }
        await Promise.resolve();
      },
    );
    const counters = { verifier: 0, commit: 0, resolve: 0 };
    const result = await lateReroutePort(session, counters).runModel(
      runtimeRequest({ maxOutputChars: 512 }),
    );
    assert.ok(!result.ok, JSON.stringify(result));
    if (!result.ok) {
      assert.equal(result.error.kind, "unavailable");
      assert.equal(
        result.error.detail,
        "routing evidence exceeded output bound",
      );
    }
    assert.equal(session.closeCalls, 1);
    assert.deepEqual(counters, { verifier: 0, commit: 0, resolve: 0 });
  },
);

Deno.test(
  "model-port: notification bytes without actual output never certify a completed run",
  async () => {
    const session = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [
        // Bytes only: progress notifications counted in the output total, but
        // no command/file-change/agent output item for this thread/turn.
        {
          method: "turn/progress",
          params: { delta: "x".repeat(2_000) },
        },
        {
          method: "turn/progress",
          params: { delta: "x".repeat(2_000) },
        },
        COMPLETED_TERMINAL,
      ],
    );
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
    });
    const result = await port.runModel(runtimeRequest());
    assert.ok(!result.ok, JSON.stringify(result));
    if (!result.ok) {
      assert.equal(result.error.kind, "unavailable");
      assert.equal(
        result.error.detail,
        "model receipt unavailable: completed run has no correlated output evidence",
      );
    }
    assert.equal(session.closeCalls, 1);
  },
);

Deno.test(
  "model-port: failed and interrupted receipts are retained without output",
  async () => {
    const cases: {
      status: "failed" | "interrupted";
      turnError?: Record<string, unknown>;
    }[] = [
      { status: "interrupted" },
      { status: "failed", turnError: { message: "synthetic failure" } },
    ];
    for (const item of cases) {
      const session = new ScriptedSession(
        {
          thread: { id: "thread-1" },
          model: "gpt-5.6-luna",
          reasoningEffort: "max",
          modelProvider: "sentinel-host",
        },
        { turn: { id: "turn-1" } },
        [{
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: {
              id: "turn-1",
              status: item.status,
              durationMs: null,
              ...(item.turnError === undefined
                ? {}
                : { error: item.turnError }),
            },
          },
        }],
      );
      const port = new CodexImplementationPort({
        openSession: () => Promise.resolve(session),
        checkoutDir: CHECKOUT,
        modelProvider: "sentinel-host",
      });
      const result = await port.runModel(runtimeRequest());
      assert.ok(result.ok, JSON.stringify(result));
      if (!result.ok) return;
      assert.equal(result.value.outcome, item.status);
      assert.equal(result.value.candidate, null);
      assert.equal(result.value.actual.evidenceKind, "request-runtime");
      assert.equal(result.value.actual.provider, "sentinel-host");
      assert.equal(result.value.actual.threadId, "thread-1");
      assert.equal(result.value.actual.turnId, "turn-1");
      assert.equal(
        result.value.error,
        item.status === "failed" ? "synthetic failure" : null,
      );
      assert.equal(result.value.actual.observedTerminalStatus, item.status);
      assert.equal(session.closeCalls, 1);
    }
  },
);

Deno.test(
  "model-port: a permissive injected verifier cannot bypass reroute or model-policy validation",
  async () => {
    // The injected verifier certifies unconditionally; the port must still
    // reject the off-Luna reroute as unavailable routing uncertainty — before
    // ANY verifier or candidate action, never a certifiable failed receipt.
    const session = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [
        {
          method: "model/rerouted",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            fromModel: "gpt-5.6-luna",
            toModel: "gpt-5.4",
          },
        },
        SUCCESS_ITEM,
        COMPLETED_TERMINAL,
      ],
    );
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
      receiptVerifier: () => ({
        provider: "sentinel-host",
        observedModel: "gpt-5.6-luna",
        observedReasoning: "max",
      }),
    });
    const result = await port.runModel(runtimeRequest());
    assert.ok(!result.ok, JSON.stringify(result));
    if (!result.ok) {
      assert.equal(result.error.kind, "unavailable");
      assert.equal(
        result.error.detail,
        "run routed off required Luna/max",
        "the port rejects the reroute before the verifier decides",
      );
    }
    assert.equal(session.closeCalls, 1);
  },
);

Deno.test(
  "model-port: invalid file-change/agent output events never prove output even with a permissive verifier",
  async () => {
    // Each case delivers only invalid output events for the exact thread/turn
    // followed by a completed runtime terminal. A permissive injected verifier
    // is present, yet the completed run must stay unavailable (no output,
    // no candidate): failed/declined/missing-status/empty-or-malformed
    // changes and blank/unsupported agent content cannot prove output.
    const invalidEvents: CodexServerNotificationV1[] = [
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "fc-1", type: "fileChange" },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "fc-2",
            type: "fileChange",
            status: "failed",
            changes: [{
              path: "src/app.ts",
              kind: { type: "update" },
              diff: "x",
            }],
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "fc-3",
            type: "fileChange",
            status: "declined",
            changes: [{
              path: "src/app.ts",
              kind: { type: "update" },
              diff: "x",
            }],
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "fc-4",
            type: "fileChange",
            status: "inProgress",
            changes: [{
              path: "src/app.ts",
              kind: { type: "update" },
              diff: "x",
            }],
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "fc-5",
            type: "fileChange",
            status: "completed",
            changes: [],
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "fc-6",
            type: "fileChange",
            status: "completed",
            changes: [{ path: "src/app.ts", diff: "x" }],
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "fc-7",
            type: "fileChange",
            status: "completed",
            changes: [{ path: "src/app.ts", kind: "update", diff: "x" }],
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "am-1",
            type: "agentMessage",
            content: "fallback content",
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "am-2", type: "agentMessage", text: "   " },
        },
      },
    ];
    for (const event of invalidEvents) {
      const session = new ScriptedSession(
        {
          thread: { id: "thread-1" },
          model: "gpt-5.6-luna",
          reasoningEffort: "max",
          modelProvider: "sentinel-host",
        },
        { turn: { id: "turn-1" } },
        [event, COMPLETED_TERMINAL],
      );
      const port = new CodexImplementationPort({
        openSession: () => Promise.resolve(session),
        checkoutDir: CHECKOUT,
        modelProvider: "sentinel-host",
        checkout: {
          resolve: () =>
            Promise.resolve({
              head: SHA3,
              checkpointSha: null,
              changedPaths: ["src/app.ts"],
            }),
        },
        receiptVerifier: () => ({
          provider: "sentinel-host",
          observedModel: "gpt-5.6-luna",
          observedReasoning: "max",
        }),
      });
      const result = await port.runModel(runtimeRequest());
      assert.ok(!result.ok, JSON.stringify(result));
      if (!result.ok) {
        assert.equal(result.error.kind, "unavailable");
        assert.equal(
          result.error.detail,
          "model receipt unavailable: completed run has no correlated output evidence",
        );
      }
      assert.equal(session.closeCalls, 1);
    }
  },
);

Deno.test(
  "model-port: host timeout retains failed accounting with explicit terminal origin, never an observed terminal",
  async () => {
    // The bounded host timeout elapses before any runtime terminal: the run
    // is failed ACCOUNTING with the exact identities and the `host-timeout`
    // origin; the observed terminal status is never fabricated.
    const session = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [],
    );
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
      interruptSettlementGraceMs: 20,
    });
    const result = await port.runModel({
      ...runtimeRequest(),
      maxDurationMs: 40,
    });
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.value.outcome, "failed");
    assert.equal(result.value.candidate, null);
    assert.equal(
      result.value.error,
      "host timeout without terminal settlement",
    );
    assert.equal(result.value.actual.terminalOrigin, "host-timeout");
    assert.equal(result.value.actual.evidenceKind, "request-runtime");
    assert.equal(result.value.actual.provider, "sentinel-host");
    assert.equal(result.value.actual.threadId, "thread-1");
    assert.equal(result.value.actual.turnId, "turn-1");
    assert.equal(result.value.actual.observedModel, "gpt-5.6-luna");
    assert.equal(result.value.actual.observedReasoning, "max");
    assert.equal(
      result.value.actual.observedTerminalStatus,
      null,
      "a host timeout never claims an observed terminal status",
    );
    assert.equal(session.closeCalls, 1);
  },
);

Deno.test(
  "model-port: a custom verifier never enables a missing model provider",
  async () => {
    // Without an explicit modelProvider the port stays unavailable and no
    // session opens — a callback cannot enable a missing provider.
    for (
      const verifier of [
        undefined,
        () => ({
          provider: "sentinel-host",
          observedModel: "gpt-5.6-luna",
          observedReasoning: "max",
        }),
      ]
    ) {
      let opened = 0;
      const port = new CodexImplementationPort({
        openSession: () => {
          opened++;
          throw new Error("no session may open without an explicit provider");
        },
        checkoutDir: CHECKOUT,
        receiptVerifier: verifier,
      });
      const result = await port.runModel(runtimeRequest());
      assert.ok(!result.ok, JSON.stringify(result));
      if (!result.ok) {
        assert.equal(result.error.kind, "unavailable");
        assert.equal(
          result.error.detail,
          "model receipt unavailable: actual provider model/effort could not be verified at this boundary",
        );
      }
      assert.equal(opened, 0);
    }
  },
);

Deno.test(
  "model-port: an invalid model provider stays unavailable before any session opens",
  async () => {
    for (const provider of ["", "  ", "provider\nname"]) {
      let opened = 0;
      const port = new CodexImplementationPort({
        openSession: () => {
          opened++;
          throw new Error("no session may open with an invalid provider");
        },
        checkoutDir: CHECKOUT,
        modelProvider: provider,
      });
      const result = await port.runModel(runtimeRequest());
      assert.ok(!result.ok, JSON.stringify(result));
      if (!result.ok) {
        assert.equal(result.error.kind, "unavailable");
        assert.equal(
          result.error.detail,
          "model receipt unavailable: configured provider is not a nonempty finite string",
        );
      }
      assert.equal(opened, 0);
    }
  },
);

Deno.test(
  "model-port: loop-stop race preserves the runtime terminal and permits only interrupted no-candidate accounting with the concrete verifier",
  async () => {
    // EXACT correction race: the loop guard owns the stop (steer rejected,
    // early interrupt requested) while the runtime terminal already completed
    // — before the host can return interrupted. The run uses `modelProvider`
    // with the CONCRETE default request/runtime verifier (no injected
    // permissive verifier): the completed terminal is preserved as runtime
    // evidence, no successful output exists, and only interrupted/
    // no-candidate accounting with the sanitized loop-stop marker is allowed.
    const root = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "model-port-race-", dir: Deno.cwd() }),
    );
    const home = `${root}/home`;
    await Deno.mkdir(home);
    const env = testGitEnv(home);
    const run = (args: string[]) => gitRun(root, args, env);
    try {
      assert.ok((await run(["init", "-q"])).ok);
      assert.ok(
        (await run(["commit", "-q", "--allow-empty", "-m", "seed"])).ok,
      );
      await Deno.writeTextFile(`${root}/app.ts`, "export const a = 1;\n");
      const failedCommand = {
        type: "commandExecution",
        command: "deno check app.ts",
        cwd: root,
        status: "failed",
        aggregatedOutput: "error: Type checking failed",
        exitCode: 1,
      };
      const session = new ScriptedSession(
        {
          thread: { id: "thread-1" },
          model: "gpt-5.6-luna",
          reasoningEffort: "max",
          modelProvider: "sentinel-host",
        },
        { turn: { id: "turn-1" } },
        [
          {
            method: "item/started",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: { ...failedCommand, id: "c1", status: "inProgress" },
            },
          },
          ...[1, 2, 3, 4].map((index) => ({
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: { ...failedCommand, id: `c${index}` },
            },
          })),
        ],
        "completed",
      );
      const port = new CodexImplementationPort({
        openSession: () => Promise.resolve(session),
        checkoutDir: root,
        modelProvider: "sentinel-host",
        checkout: {
          resolve: () =>
            Promise.resolve({
              head: SHA3,
              checkpointSha: null,
              changedPaths: ["src/app.ts"],
            }),
        },
      });
      const result = await port.runModel(runtimeRequest());
      assert.ok(result.ok, JSON.stringify(result));
      if (!result.ok) return;
      assert.equal(
        result.value.outcome,
        "interrupted",
        "the host-stopped run never produces success accounting",
      );
      assert.equal(result.value.error, "failed_command_loop");
      assert.equal(result.value.candidate, null);
      assert.equal(result.value.actual.evidenceKind, "request-runtime");
      assert.equal(result.value.actual.provider, "sentinel-host");
      assert.equal(result.value.actual.threadId, "thread-1");
      assert.equal(result.value.actual.turnId, "turn-1");
      assert.equal(
        result.value.actual.terminalOrigin,
        "runtime",
        "the actually observed completed runtime terminal is preserved",
      );
      assert.equal(
        result.value.actual.observedTerminalStatus,
        "completed",
        "the completed runtime terminal status survives the own loop stop",
      );
      assert.equal(session.closeCalls, 1);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "model-port: schema-malformed command-execution output never proves output even with a permissive verifier",
  async () => {
    // Each case delivers one completed/exitCode-0 command item with missing/
    // invalid command/cwd/actions (or malformed optional fields) followed by a
    // completed runtime terminal: the item can never prove output, so the
    // completed run stays unavailable and produces no candidate. The
    // failed-command-loop classification behavior of these items is untouched.
    const base = {
      id: "cmd-x",
      type: "commandExecution",
      status: "completed",
      exitCode: 0,
      command: "deno check src/app.ts",
      cwd: "/tmp/checkout",
      commandActions: [{ type: "unknown", command: "deno check src/app.ts" }],
    };
    const invalidItems: Record<string, unknown>[] = [
      { ...base, id: "cmd-missing-command", command: undefined },
      { ...base, id: "cmd-empty-command", command: "" },
      { ...base, id: "cmd-whitespace-command", command: "   " },
      { ...base, id: "cmd-overbound-command", command: "c".repeat(4097) },
      { ...base, id: "cmd-missing-cwd", cwd: undefined },
      { ...base, id: "cmd-empty-cwd", cwd: "" },
      { ...base, id: "cmd-overbound-cwd", cwd: "c".repeat(4097) },
      { ...base, id: "cmd-missing-actions", commandActions: undefined },
      { ...base, id: "cmd-nonarray-actions", commandActions: {} },
      {
        ...base,
        id: "cmd-overbound-actions",
        commandActions: Array.from({ length: 65 }, () => ({
          type: "unknown",
          command: "x",
        })),
      },
      { ...base, id: "cmd-action-missing-command", commandActions: [{}] },
      {
        ...base,
        id: "cmd-action-unknown-type",
        commandActions: [{
          type: "walk",
          command: "x",
        }],
      },
      {
        ...base,
        id: "cmd-read-missing-name-path",
        commandActions: [{
          type: "read",
          command: "cat src/app.ts",
        }],
      },
      {
        ...base,
        id: "cmd-read-bad-path",
        commandActions: [{
          type: "read",
          command: "cat src/app.ts",
          name: "read-file",
          path: 42,
        }],
      },
      {
        ...base,
        id: "cmd-list-bad-path",
        commandActions: [{
          type: "listFiles",
          command: "ls",
          path: 7,
        }],
      },
      {
        ...base,
        id: "cmd-search-bad-query",
        commandActions: [{
          type: "search",
          command: "rg x",
          query: {},
        }],
      },
      { ...base, id: "cmd-bad-optional-output", aggregatedOutput: 42 },
      { ...base, id: "cmd-bad-optional-duration", durationMs: "5" },
      { ...base, id: "cmd-negative-duration", durationMs: -1 },
      { ...base, id: "cmd-bad-optional-source", source: "root" },
      { ...base, id: "cmd-nonzero-exit", exitCode: 1 },
      { ...base, id: "cmd-noncompleted-status", status: "failed", exitCode: 0 },
    ];
    for (const item of invalidItems) {
      const session = new ScriptedSession(
        {
          thread: { id: "thread-1" },
          model: "gpt-5.6-luna",
          reasoningEffort: "max",
          modelProvider: "sentinel-host",
        },
        { turn: { id: "turn-1" } },
        [{
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item,
          },
        }, COMPLETED_TERMINAL],
      );
      const port = new CodexImplementationPort({
        openSession: () => Promise.resolve(session),
        checkoutDir: CHECKOUT,
        modelProvider: "sentinel-host",
        receiptVerifier: () => ({
          provider: "sentinel-host",
          observedModel: "gpt-5.6-luna",
          observedReasoning: "max",
        }),
      });
      const result = await port.runModel(runtimeRequest());
      assert.ok(
        !result.ok,
        `${String(item.id)}: ${JSON.stringify(result)}`,
      );
      if (!result.ok) {
        assert.equal(result.error.kind, "unavailable", String(item.id));
        assert.equal(
          result.error.detail,
          "model receipt unavailable: completed run has no correlated output evidence",
          String(item.id),
        );
      }
      assert.equal(session.closeCalls, 1, String(item.id));
    }
  },
);

Deno.test(
  "model-port: a schema-complete successful command item proves output and produces the candidate",
  async () => {
    const schemaCompleteItem = {
      id: "cmd-ok",
      type: "commandExecution",
      status: "completed",
      exitCode: 0,
      command: "deno check src/app.ts",
      cwd: "/tmp/checkout",
      commandActions: [
        { type: "unknown", command: "deno check src/app.ts" },
        {
          type: "read",
          command: "cat src/app.ts",
          name: "read-file",
          path: "/tmp/checkout/src/app.ts",
        },
        { type: "listFiles", command: "ls src" },
        {
          type: "search",
          command: "rg todo src",
          path: "/tmp/checkout/src",
          query: "todo",
        },
      ],
      aggregatedOutput: "checked",
      durationMs: 5,
      source: "agent",
    };
    const session = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [{
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: schemaCompleteItem,
        },
      }, COMPLETED_TERMINAL],
    );
    // The schema also supports an empty (bounded) commandActions array: it is
    // still a schema-complete successful command item.
    const emptyActionsSession = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [{
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            ...schemaCompleteItem,
            id: "cmd-ok-empty",
            commandActions: [],
          },
        },
      }, COMPLETED_TERMINAL],
    );
    for (
      const [name, fixture] of [
        ["schema-valid actions", session],
        ["empty actions", emptyActionsSession],
      ] as const
    ) {
      const port = new CodexImplementationPort({
        openSession: () => Promise.resolve(fixture),
        checkoutDir: CHECKOUT,
        modelProvider: "sentinel-host",
        checkout: {
          resolve: () =>
            Promise.resolve({
              head: SHA3,
              checkpointSha: null,
              changedPaths: ["src/app.ts"],
            }),
        },
      });
      const result = await port.runModel(runtimeRequest());
      assert.ok(result.ok, `${name}: ${JSON.stringify(result)}`);
      if (!result.ok) continue;
      assert.equal(result.value.outcome, "completed", name);
      assert.equal(result.value.candidate?.head, SHA3, name);
      assert.equal(
        result.value.actual.observedTerminalStatus,
        "completed",
        name,
      );
      assert.equal(fixture.closeCalls, 1, name);
    }
  },
);

Deno.test(
  "model-port: empty/over-bound terminal identities fail closed before the stale comparison; valid bounded unrelated ids stay ignored",
  async () => {
    // Identity bounds are validated BEFORE identity comparison: a malformed
    // empty/over-bound thread or turn id is protocol uncertainty (unavailable)
    // even when unrelated, while a valid bounded unrelated identity is stale
    // and ignored (never protocol uncertainty).
    const cases: {
      label: string;
      params: Record<string, unknown>;
      detail: string;
    }[] = [
      {
        label: "empty thread id",
        params: { threadId: "", turn: { id: "turn-1", status: "completed" } },
        detail: "malformed terminal thread id",
      },
      {
        label: "over-bound unrelated thread id",
        params: {
          threadId: "t".repeat(257),
          turn: { id: "turn-1", status: "completed" },
        },
        detail: "malformed terminal thread id",
      },
      {
        label: "empty turn id",
        params: {
          threadId: "thread-1",
          turn: { id: "", status: "completed" },
        },
        detail: "malformed terminal turn id",
      },
      {
        label: "over-bound unrelated turn id",
        params: {
          threadId: "thread-2",
          turn: { id: "t".repeat(257), status: "completed" },
        },
        detail: "malformed terminal turn id",
      },
    ];
    for (const item of cases) {
      const session = new ScriptedSession(
        {
          thread: { id: "thread-1" },
          model: "gpt-5.6-luna",
          reasoningEffort: "max",
          modelProvider: "sentinel-host",
        },
        { turn: { id: "turn-1" } },
        [{ method: "turn/completed", params: item.params }],
      );
      const port = new CodexImplementationPort({
        openSession: () => Promise.resolve(session),
        checkoutDir: CHECKOUT,
        modelProvider: "sentinel-host",
      });
      const result = await port.runModel(runtimeRequest());
      assert.ok(!result.ok, `${item.label}: ${JSON.stringify(result)}`);
      if (!result.ok) {
        assert.equal(result.error.kind, "unavailable", item.label);
        assert.equal(result.error.detail, item.detail, item.label);
      }
      assert.equal(session.closeCalls, 1, item.label);
    }
    // Valid bounded UNRELATED thread and turn ids are stale, not malformed:
    // the event is ignored and the run settles as a host-timeout failed
    // receipt with the explicit origin and null observed status.
    const unrelated = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [{
        method: "turn/completed",
        params: {
          threadId: "thread-2",
          turn: { id: "turn-2", status: "completed" },
        },
      }],
    );
    const unrelatedPort = new CodexImplementationPort({
      openSession: () => Promise.resolve(unrelated),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
      interruptSettlementGraceMs: 20,
    });
    const unrelatedResult = await unrelatedPort.runModel({
      ...runtimeRequest(),
      maxDurationMs: 40,
    });
    assert.ok(unrelatedResult.ok, JSON.stringify(unrelatedResult));
    if (unrelatedResult.ok) {
      assert.equal(unrelatedResult.value.outcome, "failed");
      assert.equal(
        unrelatedResult.value.error,
        "host timeout without terminal settlement",
      );
      assert.equal(unrelatedResult.value.actual.terminalOrigin, "host-timeout");
      assert.equal(unrelatedResult.value.actual.observedTerminalStatus, null);
    }
    assert.equal(unrelated.closeCalls, 1);
  },
);

// ---------------------------------------------------------------------------
// Real-subprocess fatal-visibility regression (getFailure seam).
// ---------------------------------------------------------------------------

/**
 * Fake app-server (real subprocess): answers the port protocol and, on the
 * `test/emit` handshake, writes ONE bounded stdout write containing the
 * trigger response, a schema-complete successful command item, the matching
 * completed terminal and the requested trailing corrupt frame. The write
 * happens only after the consumer registered (the wrapper sends the handshake
 * from inside onNotification), so the valid terminal is delivered before the
 * deterministic malformed/overflow/truncated stream corruption.
 */
function corruptAppServerCode(cwd: string): string {
  return `
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let buffer = "";
const line = (value) => Deno.stdout.writeSync(encoder.encode(value + "\\n"));
for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk);
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const text = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (text === "") continue;
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      continue;
    }
    if (frame === null || typeof frame !== "object" || frame.id === undefined) {
      continue;
    }
    const method = typeof frame.method === "string" ? frame.method : "";
    if (method === "initialize") {
      line(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { userAgent: "codex-app-server/0.153.4" } }));
      continue;
    }
    if (method === "thread/start") {
      line(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { thread: { id: "thread-1" }, model: "gpt-5.6-luna", reasoningEffort: "max", modelProvider: "sentinel-host" } }));
      continue;
    }
    if (method === "turn/start") {
      line(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { turn: { id: "turn-1" } } }));
      continue;
    }
    if (method === "test/emit") {
      const corrupt = frame.params && frame.params.corrupt;
      const item = {
        id: "ok-cmd-1",
        type: "commandExecution",
        status: "completed",
        exitCode: 0,
        command: "deno check src/app.ts",
        cwd: ${JSON.stringify(cwd)},
        commandActions: [{ type: "unknown", command: "deno check src/app.ts" }],
      };
      const frames = [
        { jsonrpc: "2.0", id: frame.id, result: {} },
        { jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item } },
        { jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", durationMs: 1 } } },
        corrupt === "malformed"
          ? "this is not json"
          : corrupt === "overflow"
          ? "o".repeat(513)
          : "stream ends here",
      ].map((value) => typeof value === "string" ? value : JSON.stringify(value)).join("\\n");
      // ONE stdout write: the trailing corrupt frame is unterminated for the
      // truncated variant; the child then closes stdout (EOF => unterminated
      // frame) and KEEPS RUNNING, so the bounded close waits on the live
      // child's TERM/KILL instead of canceling the pump before the EOF fail.
      Deno.stdout.writeSync(encoder.encode(frames + (corrupt === "truncated" ? "" : "\\n")));
      if (corrupt === "truncated") Deno.stdout.close();
      continue;
    }
    line(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} }));
  }
}
`;
}

/**
 * Real-subprocess wrapper for the corruption regression: it registers the
 * transport listener first and only then sends the `test/emit` handshake, so
 * the corrupt burst is deterministically written AFTER notification
 * registration (request/response handshake, no sleeps).
 */
class PostRegistrationSession implements CodexSessionV1 {
  constructor(
    private readonly inner: CodexSubprocessSession,
    private readonly corrupt: "malformed" | "overflow" | "truncated",
  ) {}

  open(): void {
    this.inner.open();
  }

  send(method: string, params: unknown): Promise<unknown> {
    return this.inner.send(method, params);
  }

  notify(method: string, params?: unknown): void {
    this.inner.notify(method, params);
  }

  onNotification(handler: (event: CodexServerNotificationV1) => void): void {
    this.inner.onNotification(handler);
    void this.inner.send("test/emit", { corrupt: this.corrupt }).catch(() => {
      // Test-only handshake; its late rejection at close is never an
      // unhandled rejection.
    });
  }

  onServerRequest(handler: (request: CodexServerRequestV1) => void): void {
    this.inner.onServerRequest(handler);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  isSettled(): boolean {
    return this.inner.isSettled();
  }

  getFailure(): CodexProtocolError | null {
    return this.inner.getFailure();
  }
}

Deno.test(
  "model-port: real transport corruption after notification registration never yields a verified completed or host-timeout receipt",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "sentinel-model-corrupt-" });
    try {
      for (
        const corrupt of ["malformed", "overflow", "truncated"] as const
      ) {
        const inner = new CodexSubprocessSession({
          command: [Deno.execPath(), "eval", corruptAppServerCode(dir)],
          cwd: dir,
          env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
          operationDeadlineMs: 30_000,
          closeTermGraceMs: 300,
          closeKillSettleMs: 700,
          // Small line bound keeps the whole corrupt burst in one bounded
          // read: the overflow frame is just over the bound, never multi-MB.
          maxLineBytes: 512,
        });
        const session = new PostRegistrationSession(inner, corrupt);
        const port = new CodexImplementationPort({
          openSession: () => Promise.resolve(session),
          checkoutDir: dir,
          modelProvider: "sentinel-host",
          interruptSettlementGraceMs: 100,
        });
        const result = await port.runModel(runtimeRequest());
        assert.ok(!result.ok, `${corrupt}: ${JSON.stringify(result)}`);
        if (!result.ok) {
          assert.equal(result.error.kind, "unavailable", corrupt);
          assert.equal(result.error.detail, "malformed_line", corrupt);
        }
        assert.notEqual(
          session.getFailure(),
          null,
          `${corrupt}: the transport observed the fatal stream error`,
        );
        assert.equal(
          session.isSettled(),
          true,
          `${corrupt}: the owned process group fully settled`,
        );
      }
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "model-port: genuine no-terminal no-fatal transport timeout keeps host-timeout failed accounting with null observed status",
  async () => {
    const dir = await Deno.makeTempDir({
      prefix: "sentinel-model-no-terminal-",
    });
    try {
      const session = new CodexSubprocessSession({
        command: [Deno.execPath(), "eval", corruptAppServerCode(dir)],
        cwd: dir,
        env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
        operationDeadlineMs: 30_000,
        closeTermGraceMs: 300,
        closeKillSettleMs: 700,
      });
      const port = new CodexImplementationPort({
        openSession: () => Promise.resolve(session),
        checkoutDir: dir,
        modelProvider: "sentinel-host",
        interruptSettlementGraceMs: 100,
      });
      const result = await port.runModel({
        ...runtimeRequest(),
        maxDurationMs: 300,
      });
      assert.ok(result.ok, JSON.stringify(result));
      if (result.ok) {
        assert.equal(result.value.outcome, "failed");
        assert.equal(
          result.value.error,
          "host timeout without terminal settlement",
        );
        assert.equal(result.value.candidate, null);
        assert.equal(result.value.actual.terminalOrigin, "host-timeout");
        assert.equal(result.value.actual.observedTerminalStatus, null);
      }
      assert.equal(
        session.getFailure(),
        null,
        "a healthy transport never manufactures a fatal error",
      );
      assert.equal(
        session.isSettled(),
        true,
        "the owned process group fully settled",
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);
