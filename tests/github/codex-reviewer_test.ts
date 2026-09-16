/**
 * T03: structured Codex reviewer against scripted app-server sessions.
 * No model, network, GitHub or paid calls; every timeout is milliseconds and
 * driven by control promises or injected deadlines.
 */

import assert from "node:assert/strict";
import { asGitSha, type GitSha } from "../../src/contracts/brands.ts";
import {
  CodexStructuredReviewer,
  type CodexStructuredReviewerOptionsV1,
  finalizeReviewCompletion,
  type StructuredReviewOutcomeV1,
  type StructuredReviewPrepareV1,
} from "../../src/github/codex-reviewer.ts";
import {
  MAX_JOURNAL_BYTES,
  REVIEW_RESULT_OUTPUT_SCHEMA,
} from "../../src/github/review-journal.ts";
import {
  reviewSnapshotDigest,
  type ReviewSnapshotV1,
} from "../../src/github/review-snapshot.ts";
import {
  CodexProtocolError,
  type CodexServerNotificationV1,
  type CodexServerRequestV1,
  type CodexSessionV1,
} from "../../src/repair/codex-transport.ts";

const BASE: GitSha = asGitSha("a".repeat(40));
const HEAD: GitSha = asGitSha("b".repeat(40));
const PROVIDER = "openai";
const REVIEW_PROFILE = "sentinel-review";
const SESSION_CWD = "/tmp/sentinel-review-checkout";

const CLEAN_RESULT = {
  verdict: "clean",
  summary: "The supplied change matches the specification.",
  findings: [],
} as const;

const FINDINGS_RESULT = {
  verdict: "findings",
  summary: "deposit subtracts the amount instead of adding it.",
  findings: [{
    priority: 1,
    title: "Deposit uses subtraction",
    body: "The specification requires `deposit(balance, amount)` to return " +
      "`balance + amount`.\n\nThis implementation returns `balance - amount`, " +
      "so every non-negative deposit decreases the balance.",
    path: "account.ts",
    lineStart: 1,
    lineEnd: 3,
  }],
} as const;

const ACCOUNT_CONTENT =
  "export function deposit(balance: number, amount: number) {\n" +
  '  if (amount < 0) throw new Error("negative");\n' +
  "  return balance + amount;\n" +
  "}\n";

function contains(text: string, needle: string, message?: string): void {
  assert.ok(text.includes(needle), message ?? `expected ${needle} in text`);
}

/** Scripted app-server session double with an ordered pre-registration backlog. */
class ScriptedCodexSession implements CodexSessionV1 {
  readonly sent: string[] = [];
  readonly params: unknown[] = [];
  opened = 0;
  closed = 0;
  settled = true;
  failure: CodexProtocolError | null = null;
  threadAck: unknown = {
    thread: { id: "thread-1" },
    model: "gpt-5.6-luna",
    modelProvider: PROVIDER,
    reasoningEffort: "max",
    activePermissionProfile: { id: REVIEW_PROFILE },
  };
  turnId = "turn-1";
  turnResponse: unknown = null;
  turnFailure = false;
  /** Methods whose response never arrives (bounded handshake regression). */
  readonly hangMethods = new Set<string>();
  /** Per-method response delay in milliseconds. */
  sendDelayMs: Partial<Record<string, number>> = {};
  /** Emitted synchronously inside the turn/start request (early buffering). */
  plan: (session: ScriptedCodexSession) => void = () => {};
  /** Emitted on a macrotask after the turn/start response (live delivery). */
  live: ((session: ScriptedCodexSession) => void) | null = null;
  closeHook: (() => void | Promise<void>) | null = null;

  private notificationHandler:
    | ((event: CodexServerNotificationV1) => void)
    | null = null;
  private serverRequestHandler:
    | ((request: CodexServerRequestV1) => void)
    | null = null;
  private readonly backlog: CodexServerNotificationV1[] = [];

  open(): void {
    this.opened++;
  }

  async send(method: string, params: unknown): Promise<unknown> {
    this.sent.push(method);
    this.params.push(params);
    if (this.hangMethods.has(method)) return await new Promise(() => {});
    const delay = this.sendDelayMs[method];
    if (delay !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (method === "initialize") {
      return { userAgent: "scripted/0.1.0" };
    }
    if (method === "thread/start") return this.threadAck;
    if (method === "turn/start") {
      if (this.turnFailure) {
        throw new Error("scripted submission failure");
      }
      this.plan(this);
      const live = this.live;
      if (live !== null) setTimeout(() => live(this), 0);
      return this.turnResponse ??
        { turn: { id: this.turnId, status: "inProgress" } };
    }
    return {};
  }

  notify(): void {}

  onNotification(handler: (event: CodexServerNotificationV1) => void): void {
    this.notificationHandler = handler;
    const backlog = [...this.backlog];
    this.backlog.length = 0;
    for (const event of backlog) handler(event);
  }

  onServerRequest(handler: (request: CodexServerRequestV1) => void): void {
    this.serverRequestHandler = handler;
  }

  async close(): Promise<void> {
    this.closed++;
    if (this.closeHook !== null) await this.closeHook();
  }

  isSettled(): boolean {
    return this.settled;
  }

  getFailure(): CodexProtocolError | null {
    return this.failure;
  }

  emit(method: string, params: unknown): void {
    const event = { method, params };
    if (this.notificationHandler === null) {
      this.backlog.push(event);
      return;
    }
    this.notificationHandler(event);
  }

  requestServer(method: string): void {
    this.serverRequestHandler?.({ id: 1, method, params: {} });
  }

  turnStarts(): number {
    return this.sent.filter((method) => method === "turn/start").length;
  }
}

async function snapshotFixture(
  overrides: Partial<ReviewSnapshotV1> = {},
): Promise<ReviewSnapshotV1> {
  const draft: ReviewSnapshotV1 = {
    version: "v1",
    base: BASE,
    head: HEAD,
    mergeBase: BASE,
    files: [{
      path: "account.ts",
      kind: "modified",
      oldBlob: "1".repeat(40),
      newBlob: "2".repeat(40),
      oldMode: "100644",
      newMode: "100644",
      candidateLines: 4,
    }],
    digest: "",
    ...overrides,
  };
  const digest = await reviewSnapshotDigest(draft);
  return { ...draft, digest };
}

function prepareRequest(
  snapshot: ReviewSnapshotV1,
  overrides: Partial<StructuredReviewPrepareV1> = {},
): StructuredReviewPrepareV1 {
  const now = Date.now();
  return {
    snapshot,
    requestId: "request-1",
    invocationId: "invocation-1",
    ownerRunId: "run-1",
    latestStartAt: now + 60_000,
    settleBy: now + 120_000,
    ...overrides,
  };
}

function makeReviewer(
  session: ScriptedCodexSession,
  overrides: Partial<CodexStructuredReviewerOptionsV1> = {},
): CodexStructuredReviewer {
  return new CodexStructuredReviewer({
    provider: PROVIDER,
    openSession: () => session,
    sessionCwd: SESSION_CWD,
    permissionProfile: REVIEW_PROFILE,
    ...overrides,
  });
}

/**
 * One installed 0.154 `commandExecution` item shape for the trusted session
 * cwd: bounded id/command, `commandActions` best-effort classification and
 * agent provenance (source omitted).
 */
function commandItem(
  itemId: string,
  status: "inProgress" | "completed" | "failed" | "declined",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "commandExecution",
    id: itemId,
    command: "rg --no-heading -n deposit account.ts",
    commandActions: [{ type: "read" }],
    cwd: SESSION_CWD,
    status,
    ...overrides,
  };
}

function agentMessage(
  turnId: string,
  itemId: string,
  text: string,
  phase?: string | null,
): unknown {
  const item: Record<string, unknown> = {
    type: "agentMessage",
    id: itemId,
    text,
  };
  if (phase !== undefined) item.phase = phase;
  return { threadId: "thread-1", turnId, item };
}

function turnCompleted(
  turnId: string,
  status: "completed" | "interrupted" | "failed" = "completed",
): unknown {
  return {
    threadId: "thread-1",
    turn: { id: turnId, status, durationMs: 1234 },
  };
}

/** One echoed user input item exactly as the app-server returns it. */
function userItem(
  itemId: string,
  prompt: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "userMessage",
    id: itemId,
    clientId: "client-1",
    content: [{ type: "text", text: prompt, text_elements: [] }],
    ...overrides,
  };
}

function userMessage(
  turnId: string,
  item: Record<string, unknown>,
): unknown {
  return { threadId: "thread-1", turnId, item };
}

function reasoningItem(turnId: string, itemId: string): unknown {
  return {
    threadId: "thread-1",
    turnId,
    item: { type: "reasoning", id: itemId },
  };
}

/** Exact prompt the reviewer submitted in its single turn/start request. */
function submittedPrompt(session: ScriptedCodexSession): string {
  const params = session.params[2] as { input: { text: string }[] };
  return params.input[0].text;
}

async function startReview(
  session: ScriptedCodexSession,
  snapshot: ReviewSnapshotV1,
): Promise<StructuredReviewOutcomeV1> {
  const reviewer = makeReviewer(session);
  const prepared = await reviewer.prepare(prepareRequest(snapshot));
  if (!prepared.ok) assert.fail(prepared.error.detail);
  const review = prepared.value;
  const outcome = await review.start();
  if (!outcome.ok) assert.fail(outcome.error.detail);
  return outcome.value;
}

Deno.test(
  "reviewer: prepare exposes the running identity with zero turn/start and abandon closes cleanly",
  async () => {
    const session = new ScriptedCodexSession();
    const snapshot = await snapshotFixture();
    const reviewer = makeReviewer(session);
    const prepared = await reviewer.prepare(prepareRequest(snapshot));
    if (!prepared.ok) assert.fail(prepared.error.detail);
    const review = prepared.value;

    assert.deepEqual(session.sent, ["initialize", "thread/start"]);
    assert.deepEqual(
      (session.params[0] as Record<string, unknown>).capabilities,
      { experimentalApi: true },
      "the required named profile enables the experimental capabilities",
    );
    assert.equal(session.opened, 1);
    assert.equal(session.turnStarts(), 0);
    assert.equal(review.startAttempted(), false);
    assert.equal(review.execution.threadId, "thread-1");
    assert.equal(review.execution.invocationId, "invocation-1");
    assert.equal(review.execution.ownerRunId, "run-1");
    assert.equal(review.execution.submittedProvider, PROVIDER);
    assert.equal(review.execution.model, "gpt-5.6-luna");
    assert.equal(review.execution.reasoning, "max");
    assert.equal(review.execution.startMayOccur, true);
    assert.equal("turnId" in review.execution, false);

    const threadParams = session.params[1] as Record<string, unknown>;
    assert.equal(threadParams.model, "gpt-5.6-luna");
    assert.equal(threadParams.modelProvider, PROVIDER);
    assert.equal(threadParams.permissions, REVIEW_PROFILE);
    assert.equal(
      "sandbox" in threadParams,
      false,
      "the required named profile replaces the legacy sandbox",
    );
    assert.equal(threadParams.approvalPolicy, "never");
    assert.deepEqual(threadParams.config, {
      model_reasoning_effort: "max",
      review_model: "gpt-5.6-luna",
      "features.shell_tool": true,
      "features.unified_exec": false,
      "features.multi_agent": false,
      "features.apps": false,
      web_search: "disabled",
    });

    const close = await review.close();
    assert.equal(close.settled, true);
    assert.equal(close.failure, null);
    assert.equal(close.timedOut, false);
    assert.equal(session.closed, 1);
    assert.equal(session.turnStarts(), 0);
  },
);

Deno.test(
  "reviewer: exactly one start after the caller gate and bounded clean completion",
  async () => {
    const session = new ScriptedCodexSession();
    session.live = (scripted) => {
      scripted.emit(
        "item/started",
        agentMessage(scripted.turnId, "item-1", ""),
      );
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-1",
          JSON.stringify(CLEAN_RESULT),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const snapshot = await snapshotFixture();
    const reviewer = makeReviewer(session);
    const prepared = await reviewer.prepare(prepareRequest(snapshot));
    if (!prepared.ok) assert.fail(prepared.error.detail);
    const review = prepared.value;
    const outcome = await review.start();
    if (!outcome.ok) assert.fail(outcome.error.detail);
    assert.equal(outcome.value.status, "clean");
    assert.deepEqual(outcome.value.result, CLEAN_RESULT);
    assert.equal(outcome.value.resultId, "item-1");
    assert.equal(outcome.value.execution?.turnId, "turn-1");
    assert.equal(session.turnStarts(), 1);

    const again = await review.start();
    assert.equal(again.ok, false, "a repeated start must reject");
    assert.equal(session.turnStarts(), 1, "no second turn/start request");

    const turnParams = session.params[2] as {
      input: { text: string }[];
      outputSchema: unknown;
      permissions: unknown;
      approvalPolicy: unknown;
      model: unknown;
      effort: unknown;
    };
    assert.equal(turnParams.model, "gpt-5.6-luna");
    assert.equal(turnParams.effort, "max");
    assert.equal(turnParams.permissions, REVIEW_PROFILE);
    assert.deepEqual(turnParams.outputSchema, REVIEW_RESULT_OUTPUT_SCHEMA);
    const prompt = turnParams.input[0].text;
    contains(prompt, `Base ${BASE}; head ${HEAD};`);
    contains(prompt, snapshot.digest);
    contains(prompt, 'path "account.ts"; kind modified');
    contains(prompt, `oldBlob ${"1".repeat(40)}; newBlob ${"2".repeat(40)}`);
    contains(prompt, "candidateLines 4");
    contains(prompt, "--no-ext-diff");
    contains(prompt, "--no-textconv");
    assert.equal(
      prompt.includes(ACCOUNT_CONTENT.trim()),
      false,
      "no candidate content is embedded in the manifest prompt",
    );

    const closed = await review.close();
    assert.equal(closed.settled, true);
    const keptClean = finalizeReviewCompletion(outcome, closed);
    assert.equal(
      keptClean.ok,
      true,
      "an ordinary close after a clean result preserves it",
    );
    const afterClose = await review.start();
    assert.equal(afterClose.ok, false, "start after close must reject");
    assert.equal(session.turnStarts(), 1);
  },
);

Deno.test(
  "reviewer: bad thread acknowledgement fails preparation and closes the session",
  async () => {
    const session = new ScriptedCodexSession();
    session.threadAck = {
      thread: { id: "thread-1" },
      model: "gpt-5.4",
      modelProvider: PROVIDER,
      reasoningEffort: "max",
    };
    const reviewer = makeReviewer(session);
    const prepared = await reviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    assert.equal(prepared.ok, false);
    if (prepared.ok) assert.fail("expected rejection");
    assert.equal(prepared.error.kind, "unavailable");
    assert.equal(session.closed, 1);
    assert.equal(session.turnStarts(), 0);

    const provider = new ScriptedCodexSession();
    provider.threadAck = {
      thread: { id: "thread-1" },
      model: "gpt-5.6-luna",
      modelProvider: "other-provider",
      reasoningEffort: "max",
    };
    const mismatch = await makeReviewer(provider).prepare(
      prepareRequest(await snapshotFixture()),
    );
    assert.equal(mismatch.ok, false);
    assert.equal(provider.closed, 1);
    assert.equal(provider.turnStarts(), 0);
  },
);

Deno.test(
  "reviewer: permission profile binds capabilities, thread permissions and the single turn",
  async () => {
    const session = new ScriptedCodexSession();
    session.threadAck = {
      thread: { id: "thread-1" },
      model: "gpt-5.6-luna",
      modelProvider: PROVIDER,
      reasoningEffort: "max",
      activePermissionProfile: { id: "sentinel-review" },
    };
    session.live = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-1",
          JSON.stringify(CLEAN_RESULT),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const reviewer = makeReviewer(session, {
      permissionProfile: "sentinel-review",
    });
    const prepared = await reviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!prepared.ok) assert.fail(prepared.error.detail);
    assert.deepEqual(
      (session.params[0] as Record<string, unknown>).capabilities,
      { experimentalApi: true },
      "experimental capabilities are enabled only for a configured profile",
    );
    const threadParams = session.params[1] as Record<string, unknown>;
    assert.equal(threadParams.permissions, "sentinel-review");
    assert.equal(
      "sandbox" in threadParams,
      false,
      "the named profile replaces the legacy sandbox",
    );
    const profileConfig = threadParams.config as Record<string, unknown>;
    assert.equal(
      profileConfig["features.shell_tool"],
      true,
      "the named restricted profile enables the ordinary shell read tool",
    );
    assert.equal(
      profileConfig["features.unified_exec"],
      false,
      "unified exec stays disabled: only one-shot ExecCommandHandler authority",
    );
    assert.equal(profileConfig["features.multi_agent"], false);
    assert.equal(profileConfig["features.apps"], false);
    assert.equal(profileConfig.web_search, "disabled");

    const outcome = await prepared.value.start();
    if (!outcome.ok) assert.fail(outcome.error.detail);
    assert.equal(outcome.value.status, "clean");
    const turnParams = session.params[2] as Record<string, unknown>;
    assert.equal(turnParams.permissions, "sentinel-review");
    assert.equal(
      "sandboxPolicy" in turnParams,
      false,
      "the trusted profile replaces the legacy readOnly override",
    );
    assert.equal(turnParams.approvalPolicy, "never");
    assert.equal(session.turnStarts(), 1);
  },
);

Deno.test(
  "reviewer: permission profile missing or wrong acknowledgement fails preparation before any turn",
  async (t) => {
    const cases: [string, Record<string, unknown> | undefined][] = [
      ["missing", undefined],
      ["wrong", { id: "other-profile" }],
    ];
    for (const [label, ack] of cases) {
      await t.step(label, async () => {
        const session = new ScriptedCodexSession();
        session.threadAck = {
          thread: { id: "thread-1" },
          model: "gpt-5.6-luna",
          modelProvider: PROVIDER,
          reasoningEffort: "max",
          ...(ack === undefined ? {} : { activePermissionProfile: ack }),
        };
        const reviewer = makeReviewer(session, {
          permissionProfile: "sentinel-review",
        });
        const prepared = await reviewer.prepare(
          prepareRequest(await snapshotFixture()),
        );
        assert.equal(prepared.ok, false);
        if (prepared.ok) return;
        assert.equal(prepared.error.kind, "unavailable");
        assert.equal(session.turnStarts(), 0);
        assert.equal(session.closed, 1, "the owned session settles");
      });
    }
  },
);

Deno.test(
  "reviewer: missing permission profile refuses before opening any session",
  async () => {
    const session = new ScriptedCodexSession();
    const reviewer = makeReviewer(session, {
      permissionProfile: undefined as unknown as string,
    });
    const prepared = await reviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    assert.equal(prepared.ok, false);
    if (prepared.ok) return;
    assert.equal(prepared.error.kind, "unavailable");
    contains(prepared.error.detail, "permission profile");
    assert.equal(session.opened, 0, "no app-server session is ever opened");
    assert.deepEqual(session.sent, [], "no handshake or turn request is sent");
    assert.equal(session.turnStarts(), 0);
  },
);

Deno.test(
  "reviewer: invalid permission profile opens no session",
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
        const session = new ScriptedCodexSession();
        const reviewer = makeReviewer(session, {
          permissionProfile: profile,
        });
        const prepared = await reviewer.prepare(
          prepareRequest(await snapshotFixture()),
        );
        assert.equal(prepared.ok, false);
        if (prepared.ok) return;
        assert.equal(prepared.error.kind, "unavailable");
        assert.equal(session.opened, 0);
        assert.deepEqual(session.sent, []);
      });
    }
  },
);

Deno.test(
  "reviewer: early output before the turn/start response is buffered and consumed once",
  async () => {
    const session = new ScriptedCodexSession();
    session.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-early",
          JSON.stringify(CLEAN_RESULT),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const outcome = await startReview(session, await snapshotFixture());
    assert.equal(outcome.status, "clean");
    assert.equal(outcome.resultId, "item-early");
    assert.equal(outcome.execution?.turnId, "turn-1");
    assert.equal(outcome.actual?.terminalOrigin, "runtime");
    assert.equal(outcome.actual?.observedTerminalStatus, "completed");
    assert.equal(outcome.actual?.observedModel, "gpt-5.6-luna");
    assert.equal(outcome.actual?.observedReasoning, "max");
    assert.equal(outcome.actual?.provider, PROVIDER);
    assert.equal(outcome.actual?.evidenceKind, "request-runtime");
    assert.equal(outcome.detail, null);
    assert.equal(session.turnStarts(), 1);
  },
);

Deno.test(
  "reviewer: findings keep the full multiline body and bind exact journal types",
  async () => {
    const session = new ScriptedCodexSession();
    session.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-finding",
          JSON.stringify(FINDINGS_RESULT),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const outcome = await startReview(session, await snapshotFixture());
    assert.equal(outcome.status, "findings");
    assert.deepEqual(outcome.result, FINDINGS_RESULT);
    assert.equal(
      outcome.result?.findings[0].body,
      FINDINGS_RESULT.findings[0].body,
      "the complete multiline finding body is preserved",
    );
    assert.equal(outcome.resultId, "item-finding");
    const execution = outcome.execution;
    if (execution === null) assert.fail("expected a ready execution binding");
    assert.equal(execution.resultId, "item-finding");
    assert.equal(execution.turnId, "turn-1");
    assert.equal(execution.submittedProvider, PROVIDER);
    assert.deepEqual(execution.actual, outcome.actual);
    assert.equal(JSON.stringify(execution).includes(ACCOUNT_CONTENT), false);
  },
);

Deno.test(
  "reviewer: malformed, contradictory or ambiguous output cannot yield clean",
  async () => {
    const cases: { name: string; text: string; detail: string }[] = [
      {
        name: "prose",
        text: "Looks good to me, no findings.",
        detail: "malformed",
      },
      {
        name: "clean-with-findings",
        text: JSON.stringify({
          ...CLEAN_RESULT,
          findings: FINDINGS_RESULT.findings,
        }),
        detail: "malformed",
      },
      {
        name: "unknown-key",
        text: JSON.stringify({ ...CLEAN_RESULT, extra: true }),
        detail: "malformed",
      },
      {
        name: "truncated",
        text: '{"verdict":"clean","summary":"ok"',
        detail: "malformed",
      },
      {
        name: "out-of-range-priority",
        text: JSON.stringify({
          verdict: "findings",
          summary: "x",
          findings: [{ ...FINDINGS_RESULT.findings[0], priority: 9 }],
        }),
        detail: "malformed",
      },
    ];
    for (const item of cases) {
      const session = new ScriptedCodexSession();
      session.plan = (scripted) => {
        scripted.emit(
          "item/completed",
          agentMessage(scripted.turnId, "item-1", item.text),
        );
        scripted.emit("turn/completed", turnCompleted(scripted.turnId));
      };
      const outcome = await startReview(session, await snapshotFixture());
      assert.equal(outcome.status, "unavailable", item.name);
      assert.equal(outcome.result, null, item.name);
      assert.equal(outcome.execution, null, item.name);
      contains(outcome.detail ?? "", item.detail, item.name);
    }

    // Duplicate final agent messages are ambiguous, never a clean verdict.
    const duplicate = new ScriptedCodexSession();
    duplicate.plan = (scripted) => {
      const text = JSON.stringify(CLEAN_RESULT);
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", text),
      );
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-2", text),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const ambiguous = await startReview(duplicate, await snapshotFixture());
    assert.equal(ambiguous.status, "unavailable");
    contains(ambiguous.detail ?? "", "ambiguous");

    // Over-bound result output is unavailable, never truncated into a verdict.
    const oversize = JSON.stringify({
      verdict: "findings",
      summary: "oversize",
      findings: Array.from({ length: 10 }, (_, index) => ({
        priority: 1,
        title: `finding ${index}`,
        body: "x".repeat(7000),
        path: "account.ts",
        lineStart: 1,
        lineEnd: 1,
      })),
    });
    assert.ok(oversize.length > MAX_JOURNAL_BYTES);
    const overflow = new ScriptedCodexSession();
    overflow.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", oversize),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const bounded = await startReview(overflow, await snapshotFixture());
    assert.equal(bounded.status, "unavailable");
    contains(bounded.detail ?? "", "bound");
  },
);

Deno.test(
  "reviewer: commentary is not the result and a model-unavailable verdict stays unavailable",
  async () => {
    const session = new ScriptedCodexSession();
    session.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-commentary",
          "I will inspect the diff first.",
          "commentary",
        ),
      );
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-final",
          JSON.stringify(CLEAN_RESULT),
          "final_answer",
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const outcome = await startReview(session, await snapshotFixture());
    assert.equal(outcome.status, "clean");
    assert.equal(outcome.resultId, "item-final");

    const commentaryOnly = new ScriptedCodexSession();
    commentaryOnly.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-c", "analysis only", "commentary"),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const none = await startReview(commentaryOnly, await snapshotFixture());
    assert.equal(none.status, "unavailable");
    contains(none.detail ?? "", "final agent message");

    const modelUnavailable = new ScriptedCodexSession();
    modelUnavailable.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-u",
          JSON.stringify({
            verdict: "unavailable",
            summary: "insufficient evidence",
            findings: [],
          }),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const correlated = await startReview(
      modelUnavailable,
      await snapshotFixture(),
    );
    assert.equal(correlated.status, "unavailable");
    assert.equal(correlated.execution, null);
    assert.equal(correlated.resultId, "item-u");
    assert.equal(correlated.result?.verdict, "unavailable");
    assert.equal(correlated.actual?.observedTerminalStatus, "completed");
  },
);

Deno.test(
  "reviewer: lost submission and missing turn id invent no terminal identities",
  async () => {
    const lostSession = new ScriptedCodexSession();
    lostSession.turnFailure = true;
    const lostReviewer = makeReviewer(lostSession);
    const lostPrepared = await lostReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!lostPrepared.ok) assert.fail(lostPrepared.error.detail);
    const lost = await lostPrepared.value.start();
    assert.equal(lost.ok, false);
    assert.equal(lostSession.turnStarts(), 1);

    const noIdSession = new ScriptedCodexSession();
    noIdSession.turnResponse = { turn: { status: "inProgress" } };
    const noIdReviewer = makeReviewer(noIdSession);
    const noIdPrepared = await noIdReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!noIdPrepared.ok) assert.fail(noIdPrepared.error.detail);
    const missing = await noIdPrepared.value.start();
    assert.equal(missing.ok, false);
    if (missing.ok) assert.fail("expected rejection");
    contains(missing.error.detail, "turn id");
    assert.equal(noIdSession.turnStarts(), 1);
  },
);

Deno.test(
  "reviewer: off-policy routing, forbidden items and server requests never yield clean",
  async () => {
    const rerouted = new ScriptedCodexSession();
    rerouted.plan = (scripted) => {
      scripted.emit("model/rerouted", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        fromModel: "gpt-5.6-luna",
        toModel: "gpt-5.4",
        reason: "capacity",
      });
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const routing = await startReview(rerouted, await snapshotFixture());
    assert.equal(routing.status, "unavailable");
    contains(routing.detail ?? "", "routed off");

    const tool = new ScriptedCodexSession();
    tool.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: { type: "fileChange", id: "edit-1" },
      });
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const forbidden = await startReview(tool, await snapshotFixture());
    assert.equal(forbidden.status, "unavailable");
    contains(forbidden.detail ?? "", "forbidden");

    const mcp = new ScriptedCodexSession();
    mcp.plan = (scripted) => {
      scripted.emit("item/completed", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: { type: "mcpToolCall", id: "mcp-1" },
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const forbiddenMcp = await startReview(mcp, await snapshotFixture());
    assert.equal(forbiddenMcp.status, "unavailable");
    contains(forbiddenMcp.detail ?? "", "forbidden");

    const server = new ScriptedCodexSession();
    server.plan = (scripted) => {
      scripted.requestServer("item/commandExecution/requestApproval");
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const requested = await startReview(server, await snapshotFixture());
    assert.equal(requested.status, "unavailable");
    contains(requested.detail ?? "", "server request");

    const failed = new ScriptedCodexSession();
    failed.plan = (scripted) => {
      scripted.emit("turn/completed", turnCompleted(scripted.turnId, "failed"));
    };
    const failedRun = await startReview(failed, await snapshotFixture());
    assert.equal(failedRun.status, "unavailable");
    assert.equal(failedRun.actual?.observedTerminalStatus, "failed");
    assert.equal(failedRun.execution, null);
  },
);

Deno.test(
  "reviewer: correlated shell command start, output deltas and completion permit a clean review",
  async () => {
    const session = new ScriptedCodexSession();
    session.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "inProgress", { source: "agent" }),
      });
      scripted.emit("item/commandExecution/outputDelta", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        itemId: "cmd-1",
        delta: ACCOUNT_CONTENT,
      });
      scripted.emit("item/completed", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "completed"),
      });
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-final",
          JSON.stringify(CLEAN_RESULT),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const outcome = await startReview(session, await snapshotFixture());
    assert.equal(outcome.status, "clean");
    assert.equal(outcome.resultId, "item-final");
    assert.equal(outcome.execution?.turnId, "turn-1");
    assert.equal(outcome.actual?.observedTerminalStatus, "completed");
    assert.equal(session.turnStarts(), 1);
    assert.equal(
      JSON.stringify(outcome).includes(ACCOUNT_CONTENT),
      false,
      "shell output is evidence only and never becomes the review result",
    );
  },
);

Deno.test(
  "reviewer: unfinished commands, malformed or wrong command identities and interruptions never yield clean",
  async () => {
    // A started command without a completed settlement.
    const unfinished = new ScriptedCodexSession();
    unfinished.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "inProgress"),
      });
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-final",
          JSON.stringify(CLEAN_RESULT),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const pending = await startReview(unfinished, await snapshotFixture());
    assert.equal(pending.status, "unavailable");
    assert.equal(pending.execution, null);
    contains(pending.detail ?? "", "settle");

    // A delta that shares no started command item identity.
    const unknownDelta = new ScriptedCodexSession();
    unknownDelta.plan = (scripted) => {
      scripted.emit("item/commandExecution/outputDelta", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        itemId: "cmd-unknown",
        delta: "x\n",
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const uncorrelated = await startReview(
      unknownDelta,
      await snapshotFixture(),
    );
    assert.equal(uncorrelated.status, "unavailable");
    contains(uncorrelated.detail ?? "", "correlate");

    // A delta carrying a different turn identity.
    const wrongTurn = new ScriptedCodexSession();
    wrongTurn.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "inProgress"),
      });
      scripted.emit("item/commandExecution/outputDelta", {
        threadId: "thread-1",
        turnId: "turn-other",
        itemId: "cmd-1",
        delta: "x\n",
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const mismatched = await startReview(wrongTurn, await snapshotFixture());
    assert.equal(mismatched.status, "unavailable");
    contains(mismatched.detail ?? "", "correlate");

    // A malformed delta shape (non-string delta).
    const malformedDelta = new ScriptedCodexSession();
    malformedDelta.plan = (scripted) => {
      scripted.emit("item/commandExecution/outputDelta", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        itemId: "cmd-1",
        delta: 5,
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const malformed = await startReview(
      malformedDelta,
      await snapshotFixture(),
    );
    assert.equal(malformed.status, "unavailable");
    contains(malformed.detail ?? "", "correlate");

    // An unmatched command completion with no recorded start.
    const unmatched = new ScriptedCodexSession();
    unmatched.plan = (scripted) => {
      scripted.emit("item/completed", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "completed"),
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const orphan = await startReview(unmatched, await snapshotFixture());
    assert.equal(orphan.status, "unavailable");
    contains(orphan.detail ?? "", "command execution item");

    // A command start that reports a cwd other than the trusted session cwd.
    const wrongCwd = new ScriptedCodexSession();
    wrongCwd.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "inProgress", {
          cwd: "/tmp/other-checkout",
        }),
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const cwdRefused = await startReview(wrongCwd, await snapshotFixture());
    assert.equal(cwdRefused.status, "unavailable");
    contains(cwdRefused.detail ?? "", "command execution item");

    // Plugin/script provenance can never claim the agent read operation.
    const pluginSource = new ScriptedCodexSession();
    pluginSource.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "inProgress", {
          source: "plugin",
          pluginId: "plugin-1",
        }),
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const sourceRefused = await startReview(
      pluginSource,
      await snapshotFixture(),
    );
    assert.equal(sourceRefused.status, "unavailable");
    contains(sourceRefused.detail ?? "", "command execution item");

    // A start status that is already terminal is not a valid start.
    const terminalStart = new ScriptedCodexSession();
    terminalStart.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "completed"),
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const statusRefused = await startReview(
      terminalStart,
      await snapshotFixture(),
    );
    assert.equal(statusRefused.status, "unavailable");
    contains(statusRefused.detail ?? "", "command execution item");

    // A completion whose command no longer matches the recorded start.
    const wrongCommand = new ScriptedCodexSession();
    wrongCommand.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "inProgress"),
      });
      scripted.emit("item/completed", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "completed", {
          command: "rg --no-heading -n withdrawal account.ts",
        }),
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const commandRefused = await startReview(
      wrongCommand,
      await snapshotFixture(),
    );
    assert.equal(commandRefused.status, "unavailable");
    contains(commandRefused.detail ?? "", "command execution item");

    // A declined command is unavailable, never a settled read.
    const declined = new ScriptedCodexSession();
    declined.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "inProgress"),
      });
      scripted.emit("item/completed", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "declined"),
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const declinedRun = await startReview(declined, await snapshotFixture());
    assert.equal(declinedRun.status, "unavailable");
    contains(declinedRun.detail ?? "", "command execution item");

    // An ordinary failed read (for example no match) is a settled completion.
    const failedRead = new ScriptedCodexSession();
    failedRead.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "inProgress"),
      });
      scripted.emit("item/completed", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "failed"),
      });
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-final",
          JSON.stringify(CLEAN_RESULT),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const failedReadRun = await startReview(
      failedRead,
      await snapshotFixture(),
    );
    assert.equal(failedReadRun.status, "clean");

    // A started command reported twice is contradictory.
    const duplicateStart = new ScriptedCodexSession();
    duplicateStart.plan = (scripted) => {
      const started = {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "inProgress"),
      };
      scripted.emit("item/started", started);
      scripted.emit("item/started", started);
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const duplicatedStart = await startReview(
      duplicateStart,
      await snapshotFixture(),
    );
    assert.equal(duplicatedStart.status, "unavailable");
    contains(duplicatedStart.detail ?? "", "contradictory");

    // A completed command reported twice is contradictory.
    const duplicate = new ScriptedCodexSession();
    duplicate.plan = (scripted) => {
      scripted.emit("item/started", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "inProgress"),
      });
      const completed = {
        threadId: "thread-1",
        turnId: scripted.turnId,
        item: commandItem("cmd-1", "completed"),
      };
      scripted.emit("item/completed", completed);
      scripted.emit("item/completed", completed);
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const contradictory = await startReview(duplicate, await snapshotFixture());
    assert.equal(contradictory.status, "unavailable");
    contains(contradictory.detail ?? "", "contradictory");

    // Terminal interaction and connection-scoped command telemetry are refused.
    const interaction = new ScriptedCodexSession();
    interaction.plan = (scripted) => {
      scripted.emit("item/commandExecution/terminalInteraction", {
        threadId: "thread-1",
        turnId: scripted.turnId,
        itemId: "cmd-1",
        stdin: "y\n",
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const interactionRun = await startReview(
      interaction,
      await snapshotFixture(),
    );
    assert.equal(interactionRun.status, "unavailable");
    contains(interactionRun.detail ?? "", "terminal interaction");

    const connectionScoped = new ScriptedCodexSession();
    connectionScoped.plan = (scripted) => {
      scripted.emit("command/exec/outputDelta", {
        processId: "p-1",
        delta: "x",
      });
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const connectionRun = await startReview(
      connectionScoped,
      await snapshotFixture(),
    );
    assert.equal(connectionRun.status, "unavailable");
    contains(connectionRun.detail ?? "", "connection-scoped");

    // A compacted context is fatal evidence.
    const compacted = new ScriptedCodexSession();
    compacted.plan = (scripted) => {
      scripted.emit("thread/compacted", { threadId: "thread-1" });
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-final",
          JSON.stringify(CLEAN_RESULT),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const compactedRun = await startReview(compacted, await snapshotFixture());
    assert.equal(compactedRun.status, "unavailable");
    contains(compactedRun.detail ?? "", "compacted");

    // An interrupted turn is never a clean review.
    const interrupted = new ScriptedCodexSession();
    interrupted.plan = (scripted) => {
      scripted.emit(
        "turn/completed",
        turnCompleted(scripted.turnId, "interrupted"),
      );
    };
    const interruptedRun = await startReview(
      interrupted,
      await snapshotFixture(),
    );
    assert.equal(interruptedRun.status, "unavailable");
    assert.equal(interruptedRun.actual?.observedTerminalStatus, "interrupted");
    assert.equal(interruptedRun.execution, null);
  },
);

Deno.test(
  "reviewer: no runtime terminal settles as a correlated host timeout",
  async () => {
    const session = new ScriptedCodexSession();
    const snapshot = await snapshotFixture();
    const now = Date.now();
    const reviewer = makeReviewer(session);
    const prepared = await reviewer.prepare(prepareRequest(snapshot, {
      latestStartAt: now + 60_000,
      settleBy: now + 240,
    }));
    if (!prepared.ok) assert.fail(prepared.error.detail);
    const review = prepared.value;
    const outcome = await review.start();
    if (!outcome.ok) assert.fail(outcome.error.detail);
    assert.equal(outcome.value.status, "unavailable");
    assert.equal(outcome.value.execution, null);
    assert.equal(outcome.value.actual?.terminalOrigin, "host-timeout");
    assert.equal(outcome.value.actual?.observedTerminalStatus, null);
    assert.equal(outcome.value.actual?.turnId, "turn-1");
    contains(outcome.value.detail ?? "", "terminal");
    contains(session.sent.join(","), "turn/interrupt");
  },
);

Deno.test(
  "reviewer: close is bounded, idempotent and invalidates corrupted completion",
  async () => {
    // Settlement uncertainty: a clean completion cannot survive an unsettled
    // close, and the second close reuses the single owned close.
    const uncertainSession = new ScriptedCodexSession();
    uncertainSession.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const uncertainReviewer = makeReviewer(uncertainSession);
    const uncertainPrepared = await uncertainReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!uncertainPrepared.ok) assert.fail(uncertainPrepared.error.detail);
    const uncertainRun = uncertainPrepared.value;
    const outcome = await uncertainRun.start();
    if (!outcome.ok) assert.fail(outcome.error.detail);
    assert.equal(outcome.value.status, "clean");

    uncertainSession.settled = false;
    const uncertain = await uncertainRun.close();
    assert.equal(uncertain.settled, false);
    assert.equal(uncertain.timedOut, false);
    const uncertainFinal = finalizeReviewCompletion(outcome, uncertain);
    assert.equal(uncertainFinal.ok, false, "unsettled close invalidates clean");
    assert.equal(uncertainSession.closed, 1);
    const again = await uncertainRun.close();
    assert.deepEqual(again, uncertain);
    assert.equal(uncertainSession.closed, 1);

    // Corrupt transport failure after completion invalidates it as well.
    const corruptSession = new ScriptedCodexSession();
    corruptSession.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const corruptReviewer = makeReviewer(corruptSession);
    const corruptPrepared = await corruptReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!corruptPrepared.ok) assert.fail(corruptPrepared.error.detail);
    const corruptRun = corruptPrepared.value;
    const corruptOutcome = await corruptRun.start();
    if (!corruptOutcome.ok) assert.fail(corruptOutcome.error.detail);
    corruptSession.failure = new CodexProtocolError(
      "stream_output_bound_exceeded",
      "raw transport detail that must not escape",
    );
    const corrupt = await corruptRun.close();
    assert.equal(corrupt.failure, "close_failed");
    assert.equal(
      JSON.stringify(corrupt).includes("raw transport detail"),
      false,
      "no raw transport detail escapes the sanitized close outcome",
    );
    const corruptFinal = finalizeReviewCompletion(corruptOutcome, corrupt);
    assert.equal(corruptFinal.ok, false);
    if (corruptFinal.ok) assert.fail("expected rejection");
    assert.equal(corruptFinal.error.kind, "unavailable");

    // A clean outcome with a clean close survives unchanged.
    const healthy = finalizeReviewCompletion(outcome, {
      settled: true,
      failure: null,
      timedOut: false,
    });
    assert.equal(healthy.ok, true);
  },
);

Deno.test(
  "reviewer: explicit host close during a run yields unavailable, never clean",
  async () => {
    const session = new ScriptedCodexSession();
    const snapshot = await snapshotFixture();
    const reviewer = makeReviewer(session);
    const prepared = await reviewer.prepare(prepareRequest(snapshot));
    if (!prepared.ok) assert.fail(prepared.error.detail);
    const review = prepared.value;
    const starting = review.start();
    const closed = await review.close();
    assert.equal(closed.settled, true);
    assert.equal(session.closed, 1);
    const outcome = await starting;
    if (!outcome.ok) assert.fail(outcome.error.detail);
    assert.equal(outcome.value.status, "unavailable");
    assert.equal(outcome.value.execution, null);
    contains(outcome.value.detail ?? "", "closed");

    // A bounded close that cannot settle reports uncertainty within a short
    // deadline instead of hanging.
    const hung = new ScriptedCodexSession();
    hung.closeHook = () => new Promise<void>(() => {});
    const hungReviewer = makeReviewer(hung);
    const hungNow = Date.now();
    const hungPrepared = await hungReviewer.prepare(prepareRequest(
      await snapshotFixture(),
      { latestStartAt: hungNow + 60_000, settleBy: hungNow + 150 },
    ));
    if (!hungPrepared.ok) assert.fail(hungPrepared.error.detail);
    const hungOutcome = await hungPrepared.value.close();
    assert.equal(hungOutcome.settled, false);
    assert.equal(hungOutcome.timedOut, true);
    assert.ok(Date.now() - hungNow < 5_000, "close must be bounded");

    // A close that fails outright is sanitized as a static marker.
    const throwing = new ScriptedCodexSession();
    throwing.closeHook = () => Promise.reject(new Error("raw close detail"));
    const throwingReviewer = makeReviewer(throwing);
    const throwingPrepared = await throwingReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!throwingPrepared.ok) assert.fail(throwingPrepared.error.detail);
    const thrown = await throwingPrepared.value.close();
    assert.equal(thrown.settled, false);
    assert.equal(thrown.failure, "close_failed");
    assert.equal(thrown.timedOut, false);
    assert.equal(JSON.stringify(thrown).includes("raw close detail"), false);

    // Throwing settlement/failure probes are sanitized, never thrown.
    const probing = new ScriptedCodexSession();
    probing.isSettled = () => {
      throw new Error("raw isSettled detail");
    };
    probing.getFailure = () => {
      throw new Error("raw getFailure detail");
    };
    const probingReviewer = makeReviewer(probing);
    const probingPrepared = await probingReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!probingPrepared.ok) assert.fail(probingPrepared.error.detail);
    const probed = await probingPrepared.value.close();
    assert.equal(probed.settled, false);
    assert.equal(probed.failure, "close_failed");
    assert.equal(probed.timedOut, false);
    assert.equal(
      JSON.stringify(probed).includes("raw isSettled detail"),
      false,
    );
    assert.equal(
      JSON.stringify(probed).includes("raw getFailure detail"),
      false,
    );

    // A throwing failure probe during completion is sanitized as well.
    const probingRun = new ScriptedCodexSession();
    probingRun.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    probingRun.getFailure = () => {
      throw new Error("raw getFailure detail");
    };
    const probingRunReviewer = makeReviewer(probingRun);
    const probingRunPrepared = await probingRunReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!probingRunPrepared.ok) assert.fail(probingRunPrepared.error.detail);
    const probingOutcome = await probingRunPrepared.value.start();
    if (!probingOutcome.ok) assert.fail(probingOutcome.error.detail);
    assert.equal(probingOutcome.value.status, "unavailable");
    contains(probingOutcome.value.detail ?? "", "fatal failure");
    await probingRunPrepared.value.close();
  },
);

Deno.test(
  "reviewer: short, elapsed and crossed deadlines reject before any start",
  async () => {
    const session = new ScriptedCodexSession();
    const snapshot = await snapshotFixture();
    const reviewer = makeReviewer(session);
    const now = Date.now();

    const expiredSettle = await reviewer.prepare(prepareRequest(snapshot, {
      latestStartAt: now + 10_000,
      settleBy: now - 1,
    }));
    assert.equal(expiredSettle.ok, false);
    const expiredStart = await reviewer.prepare(prepareRequest(snapshot, {
      latestStartAt: now - 1,
      settleBy: now + 10_000,
    }));
    assert.equal(expiredStart.ok, false);
    assert.equal(session.opened, 0, "no session is opened for bad deadlines");

    const crossed = await reviewer.prepare(prepareRequest(snapshot, {
      latestStartAt: Date.now() + 60,
      settleBy: Date.now() + 60_000,
    }));
    if (!crossed.ok) assert.fail(crossed.error.detail);
    await new Promise((resolve) => setTimeout(resolve, 90));
    const outcome = await crossed.value.start();
    assert.equal(outcome.ok, false, "a crossed latestStartAt must reject");
    if (outcome.ok) assert.fail("expected rejection");
    contains(outcome.error.detail, "latestStartAt");
    assert.equal(session.turnStarts(), 0);
    await crossed.value.close();
  },
);

Deno.test(
  "reviewer: digest, candidate-location and prepare-identity validation fail closed",
  async () => {
    const session = new ScriptedCodexSession();
    const reviewer = makeReviewer(session);
    const snapshot = await snapshotFixture();
    const tampered: ReviewSnapshotV1 = {
      ...snapshot,
      files: [{ ...snapshot.files[0], candidateLines: 99 }],
    };
    const digest = await reviewer.prepare(prepareRequest(tampered));
    assert.equal(digest.ok, false);
    if (digest.ok) assert.fail("expected rejection");
    contains(digest.error.detail, "digest");
    assert.equal(session.opened, 0);

    const badIdentity = await reviewer.prepare(
      prepareRequest(snapshot, { requestId: "" }),
    );
    assert.equal(badIdentity.ok, false);
    assert.equal(session.opened, 0);

    const withDeletion = await snapshotFixture({
      files: [
        {
          path: "account.ts",
          kind: "modified",
          oldBlob: "1".repeat(40),
          newBlob: "2".repeat(40),
          oldMode: "100644",
          newMode: "100644",
          candidateLines: 4,
        },
        {
          path: "gone.ts",
          kind: "deleted",
          oldBlob: "3".repeat(40),
          newBlob: "0".repeat(40),
          oldMode: "100644",
          newMode: "000000",
          candidateLines: null,
        },
      ],
    });
    const cases: { name: string; finding: Record<string, unknown> }[] = [
      {
        name: "invented path",
        finding: {
          priority: 1,
          title: "invented",
          body: "not a changed file",
          path: "other.ts",
          lineStart: 1,
          lineEnd: 1,
        },
      },
      {
        name: "deleted path",
        finding: {
          priority: 1,
          title: "deleted",
          body: "the file is gone in the candidate",
          path: "gone.ts",
          lineStart: 1,
          lineEnd: 1,
        },
      },
      {
        name: "out of range",
        finding: {
          priority: 1,
          title: "range",
          body: "beyond the candidate content",
          path: "account.ts",
          lineStart: 1,
          lineEnd: 99,
        },
      },
    ];
    for (const item of cases) {
      const result = JSON.stringify({
        verdict: "findings",
        summary: "location validation",
        findings: [item.finding],
      });
      const scripted = new ScriptedCodexSession();
      scripted.plan = (live) => {
        live.emit(
          "item/completed",
          agentMessage(live.turnId, "item-1", result),
        );
        live.emit("turn/completed", turnCompleted(live.turnId));
      };
      const outcome = await startReview(scripted, withDeletion);
      assert.equal(outcome.status, "unavailable", item.name);
      assert.equal(outcome.execution, null, item.name);
    }
  },
);

Deno.test(
  "reviewer: hanging initialize and thread/start never outlive the caller deadline",
  async () => {
    // An initialize response that never arrives.
    const hangingInit = new ScriptedCodexSession();
    hangingInit.hangMethods.add("initialize");
    const initNow = Date.now();
    const initPrepared = await makeReviewer(hangingInit).prepare(
      prepareRequest(await snapshotFixture(), {
        latestStartAt: initNow + 120,
        settleBy: initNow + 400,
      }),
    );
    assert.equal(initPrepared.ok, false);
    assert.ok(Date.now() - initNow < 5_000, "prepare must stay bounded");
    assert.equal(hangingInit.turnStarts(), 0);
    assert.equal(
      hangingInit.closed,
      1,
      "the owned session is closed in deadline",
    );

    // A thread/start response that never arrives.
    const hangingThread = new ScriptedCodexSession();
    hangingThread.hangMethods.add("thread/start");
    const threadNow = Date.now();
    const threadPrepared = await makeReviewer(hangingThread).prepare(
      prepareRequest(await snapshotFixture(), {
        latestStartAt: threadNow + 120,
        settleBy: threadNow + 400,
      }),
    );
    assert.equal(threadPrepared.ok, false);
    assert.ok(Date.now() - threadNow < 5_000, "prepare must stay bounded");
    assert.deepEqual(hangingThread.sent, ["initialize", "thread/start"]);
    assert.equal(hangingThread.turnStarts(), 0);
    assert.equal(hangingThread.closed, 1);

    // A response that crosses the absolute start gate.
    const crossing = new ScriptedCodexSession();
    crossing.sendDelayMs = { initialize: 80 };
    const crossNow = Date.now();
    const crossPrepared = await makeReviewer(crossing).prepare(
      prepareRequest(await snapshotFixture(), {
        latestStartAt: crossNow + 20,
        settleBy: crossNow + 400,
      }),
    );
    assert.equal(crossPrepared.ok, false);
    assert.ok(Date.now() - crossNow < 5_000, "prepare must stay bounded");
    assert.equal(crossing.turnStarts(), 0);
    assert.equal(crossing.closed, 1);
  },
);

Deno.test(
  "reviewer: throwing registration or invalid queued evidence forbids the send",
  async () => {
    const throwingRegistration = new ScriptedCodexSession();
    throwingRegistration.onNotification = () => {
      throw new Error("raw registration detail");
    };
    const throwReviewer = makeReviewer(throwingRegistration);
    const throwPrepared = await throwReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!throwPrepared.ok) assert.fail(throwPrepared.error.detail);
    const throwRun = throwPrepared.value;
    const thrown = await throwRun.start();
    assert.equal(thrown.ok, false);
    if (thrown.ok) assert.fail("expected rejection");
    contains(thrown.error.detail, "registration");
    assert.equal(
      JSON.stringify(thrown).includes("raw registration detail"),
      false,
    );
    assert.equal(
      throwingRegistration.turnStarts(),
      0,
      "no turn/start after throwing registration",
    );
    const thrownClose = await throwRun.close();
    assert.equal(thrownClose.failure, "close_failed");
    assert.equal(typeof thrownClose.settled, "boolean");

    // Invalid evidence already queued before registration is validated during
    // registration replay, before any turn/start.
    const queued = new ScriptedCodexSession();
    queued.emit("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "item-x" },
    });
    const queuedReviewer = makeReviewer(queued);
    const queuedPrepared = await queuedReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!queuedPrepared.ok) assert.fail(queuedPrepared.error.detail);
    const queuedRun = queuedPrepared.value;
    const queuedOutcome = await queuedRun.start();
    assert.equal(queuedOutcome.ok, false);
    if (queuedOutcome.ok) assert.fail("expected rejection");
    contains(queuedOutcome.error.detail, "identity");
    assert.equal(
      queued.turnStarts(),
      0,
      "queued invalid evidence forbids the send",
    );
    await queuedRun.close();
  },
);

Deno.test(
  "reviewer: contradictory terminal and second final item are sticky after completion",
  async () => {
    const contradictory = new ScriptedCodexSession();
    contradictory.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
      scripted.emit(
        "turn/completed",
        turnCompleted(scripted.turnId, "interrupted"),
      );
    };
    const contradictoryReviewer = makeReviewer(contradictory);
    const contradictoryPrepared = await contradictoryReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!contradictoryPrepared.ok) {
      assert.fail(contradictoryPrepared.error.detail);
    }
    const contradictoryRun = contradictoryPrepared.value;
    const contradictoryOutcome = await contradictoryRun.start();
    if (!contradictoryOutcome.ok) {
      assert.fail(contradictoryOutcome.error.detail);
    }
    assert.equal(contradictoryOutcome.value.status, "unavailable");
    contains(contradictoryOutcome.value.detail ?? "", "contradictory");
    assert.equal(contradictoryOutcome.value.execution, null);
    const contradictoryClose = await contradictoryRun.close();
    assert.equal(contradictoryClose.failure, "close_failed");

    const secondFinal = new ScriptedCodexSession();
    secondFinal.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-2", JSON.stringify(CLEAN_RESULT)),
      );
    };
    const secondReviewer = makeReviewer(secondFinal);
    const secondPrepared = await secondReviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!secondPrepared.ok) assert.fail(secondPrepared.error.detail);
    const secondRun = secondPrepared.value;
    const secondOutcome = await secondRun.start();
    if (!secondOutcome.ok) assert.fail(secondOutcome.error.detail);
    assert.equal(secondOutcome.value.status, "unavailable");
    contains(secondOutcome.value.detail ?? "", "ambiguous");
    const secondClose = await secondRun.close();
    assert.equal(secondClose.failure, "close_failed");
    const finalized = finalizeReviewCompletion(secondOutcome, secondClose);
    assert.equal(finalized.ok, true);
    if (!finalized.ok) assert.fail("expected a correlated unavailable outcome");
    assert.equal(finalized.value.status, "unavailable");
    assert.equal(finalized.value.execution, null);
  },
);

Deno.test(
  "reviewer: off-policy routing or a server request during close invalidates clean",
  async () => {
    for (const kind of ["reroute", "server-request"] as const) {
      const session = new ScriptedCodexSession();
      session.plan = (scripted) => {
        scripted.emit(
          "item/completed",
          agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
        );
        scripted.emit("turn/completed", turnCompleted(scripted.turnId));
      };
      session.closeHook = () => {
        if (kind === "reroute") {
          session.emit("model/rerouted", {
            threadId: "thread-1",
            turnId: session.turnId,
            fromModel: "gpt-5.6-luna",
            toModel: "gpt-5.4",
            reason: "capacity",
          });
        } else {
          session.requestServer("item/commandExecution/requestApproval");
        }
      };
      const reviewer = makeReviewer(session);
      const prepared = await reviewer.prepare(
        prepareRequest(await snapshotFixture()),
      );
      if (!prepared.ok) assert.fail(prepared.error.detail);
      const review = prepared.value;
      const outcome = await review.start();
      if (!outcome.ok) assert.fail(outcome.error.detail);
      assert.equal(outcome.value.status, "clean", kind);
      const closed = await review.close();
      assert.equal(closed.failure, "close_failed", kind);
      assert.equal(closed.timedOut, false, kind);
      const finalized = finalizeReviewCompletion(outcome, closed);
      assert.equal(finalized.ok, false, kind);
      if (finalized.ok) assert.fail("expected rejection");
      assert.equal(finalized.error.kind, "unavailable");
      const again = await review.close();
      assert.deepEqual(again, closed, "close stays idempotent");
      assert.equal(session.closed, 1, kind);
    }
  },
);

Deno.test(
  "reviewer: a second final item delivered during close invalidates clean",
  async () => {
    const session = new ScriptedCodexSession();
    session.plan = (scripted) => {
      scripted.emit(
        "item/completed",
        agentMessage(scripted.turnId, "item-1", JSON.stringify(CLEAN_RESULT)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    session.closeHook = () => {
      session.emit(
        "item/completed",
        agentMessage(session.turnId, "item-2", JSON.stringify(CLEAN_RESULT)),
      );
    };
    const reviewer = makeReviewer(session);
    const prepared = await reviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!prepared.ok) assert.fail(prepared.error.detail);
    const review = prepared.value;
    const outcome = await review.start();
    if (!outcome.ok) assert.fail(outcome.error.detail);
    assert.equal(outcome.value.status, "clean");
    const closed = await review.close();
    assert.equal(closed.failure, "close_failed");
    const finalized = finalizeReviewCompletion(outcome, closed);
    assert.equal(
      finalized.ok,
      false,
      "duplicate final output invalidates clean",
    );
  },
);

Deno.test(
  "reviewer: full normal lifecycle accepts the prompt echo as input, never the result",
  async () => {
    const session = new ScriptedCodexSession();
    session.live = (scripted) => {
      const prompt = submittedPrompt(session);
      scripted.emit(
        "item/started",
        userMessage(scripted.turnId, userItem("user-1", prompt)),
      );
      scripted.emit(
        "item/completed",
        userMessage(scripted.turnId, userItem("user-1", prompt)),
      );
      scripted.emit(
        "item/started",
        reasoningItem(scripted.turnId, "reasoning-1"),
      );
      scripted.emit(
        "item/completed",
        reasoningItem(scripted.turnId, "reasoning-1"),
      );
      scripted.emit(
        "item/started",
        agentMessage(scripted.turnId, "item-final", ""),
      );
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-final",
          JSON.stringify(CLEAN_RESULT),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const reviewer = makeReviewer(session);
    const prepared = await reviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!prepared.ok) assert.fail(prepared.error.detail);
    const review = prepared.value;
    const outcome = await review.start();
    if (!outcome.ok) assert.fail(outcome.error.detail);
    assert.equal(outcome.value.status, "clean");
    assert.deepEqual(outcome.value.result, CLEAN_RESULT);
    assert.equal(
      outcome.value.resultId,
      "item-final",
      "the echoed user item is never the result",
    );
    assert.equal(outcome.value.execution?.turnId, "turn-1");
    assert.equal(outcome.value.execution?.resultId, "item-final");
    assert.equal(outcome.value.detail, null);
    assert.equal(session.turnStarts(), 1);

    const closed = await review.close();
    assert.equal(closed.settled, true);
    assert.equal(closed.failure, null);
    assert.equal(closed.timedOut, false);
    const finalized = finalizeReviewCompletion(outcome, closed);
    assert.equal(
      finalized.ok,
      true,
      "a settled close preserves the clean result",
    );
  },
);

Deno.test(
  "reviewer: the prompt echo alone is input evidence and never completes a review",
  async () => {
    const session = new ScriptedCodexSession();
    session.plan = (scripted) => {
      const prompt = submittedPrompt(session);
      scripted.emit(
        "item/started",
        userMessage(scripted.turnId, userItem("user-1", prompt)),
      );
      scripted.emit(
        "item/completed",
        userMessage(scripted.turnId, userItem("user-1", prompt)),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    const outcome = await startReview(session, await snapshotFixture());
    assert.equal(outcome.status, "unavailable");
    assert.equal(outcome.result, null);
    assert.equal(outcome.resultId, null);
    assert.equal(outcome.execution, null);
    contains(outcome.detail ?? "", "final agent message");
    assert.equal(outcome.actual?.observedTerminalStatus, "completed");
  },
);

Deno.test(
  "reviewer: malformed or mismatched prompt echoes fail closed before any clean verdict",
  async () => {
    const cases: {
      name: string;
      needle: string;
      build: (
        prompt: string,
      ) => {
        started: Record<string, unknown>;
        completed: Record<string, unknown>;
      };
    }[] = [
      {
        name: "unbounded item id",
        needle: "identity",
        build: (prompt) => ({
          started: userItem("", prompt),
          completed: userItem("", prompt),
        }),
      },
      {
        name: "missing content",
        needle: "user message",
        build: (prompt) => ({
          started: userItem("user-1", prompt, { content: undefined }),
          completed: userItem("user-1", prompt, { content: undefined }),
        }),
      },
      {
        name: "two text parts",
        needle: "user message",
        build: (prompt) => ({
          started: userItem("user-1", prompt, {
            content: [
              { type: "text", text: prompt, text_elements: [] },
              { type: "text", text: prompt, text_elements: [] },
            ],
          }),
          completed: userItem("user-1", prompt),
        }),
      },
      {
        name: "image content",
        needle: "user message",
        build: (prompt) => ({
          started: userItem("user-1", prompt, {
            content: [{ type: "image", url: "file:///etc/passwd" }],
          }),
          completed: userItem("user-1", prompt),
        }),
      },
      {
        name: "tool content",
        needle: "user message",
        build: (prompt) => ({
          started: userItem("user-1", prompt, {
            content: [{ type: "tool", name: "shell" }],
          }),
          completed: userItem("user-1", prompt),
        }),
      },
      {
        name: "mismatched text",
        needle: "user message",
        build: () => ({
          started: userItem("user-1", "a different prompt"),
          completed: userItem("user-1", "a different prompt"),
        }),
      },
      {
        name: "nonempty text elements",
        needle: "user message",
        build: (prompt) => ({
          started: userItem("user-1", prompt, {
            content: [{
              type: "text",
              text: prompt,
              text_elements: [{ type: "mention", text: "@account.ts" }],
            }],
          }),
          completed: userItem("user-1", prompt),
        }),
      },
      {
        name: "missing text elements",
        needle: "user message",
        build: (prompt) => ({
          started: userItem("user-1", prompt, {
            content: [{ type: "text", text: prompt }],
          }),
          completed: userItem("user-1", prompt),
        }),
      },
      {
        name: "result-shaped echo text",
        needle: "user message",
        build: () => ({
          started: userItem("user-1", JSON.stringify(CLEAN_RESULT)),
          completed: userItem("user-1", JSON.stringify(CLEAN_RESULT)),
        }),
      },
      {
        name: "different user item id",
        needle: "user message",
        build: (prompt) => ({
          started: userItem("user-1", prompt),
          completed: userItem("user-2", prompt),
        }),
      },
    ];

    for (const item of cases) {
      const session = new ScriptedCodexSession();
      session.plan = (scripted) => {
        const echo = item.build(submittedPrompt(session));
        scripted.emit(
          "item/started",
          userMessage(scripted.turnId, echo.started),
        );
        scripted.emit(
          "item/completed",
          userMessage(scripted.turnId, echo.completed),
        );
        // A later sole final result, exact completed terminal and settled
        // close are all present: only the echo violation keeps this
        // unavailable.
        scripted.emit(
          "item/completed",
          agentMessage(
            scripted.turnId,
            "item-final",
            JSON.stringify(CLEAN_RESULT),
          ),
        );
        scripted.emit("turn/completed", turnCompleted(scripted.turnId));
      };
      const reviewer = makeReviewer(session);
      const prepared = await reviewer.prepare(
        prepareRequest(await snapshotFixture()),
      );
      if (!prepared.ok) assert.fail(prepared.error.detail);
      const review = prepared.value;
      const outcome = await review.start();
      if (!outcome.ok) assert.fail(outcome.error.detail);
      assert.equal(outcome.value.status, "unavailable", item.name);
      assert.equal(outcome.value.result, null, item.name);
      assert.equal(outcome.value.execution, null, item.name);
      contains(outcome.value.detail ?? "", item.needle, item.name);
      const closed = await review.close();
      assert.equal(closed.settled, true, item.name);
      assert.equal(closed.failure, "close_failed", item.name);
      const finalized = finalizeReviewCompletion(outcome, closed);
      assert.equal(finalized.ok, true, item.name);
      if (!finalized.ok) {
        assert.fail("expected a correlated unavailable outcome");
      }
      assert.equal(finalized.value.status, "unavailable", item.name);
    }
  },
);

Deno.test(
  "reviewer: a different user item delivered during close invalidates clean",
  async () => {
    const session = new ScriptedCodexSession();
    session.plan = (scripted) => {
      const prompt = submittedPrompt(session);
      scripted.emit(
        "item/started",
        userMessage(scripted.turnId, userItem("user-1", prompt)),
      );
      scripted.emit(
        "item/completed",
        userMessage(scripted.turnId, userItem("user-1", prompt)),
      );
      scripted.emit(
        "item/completed",
        agentMessage(
          scripted.turnId,
          "item-1",
          JSON.stringify(CLEAN_RESULT),
        ),
      );
      scripted.emit("turn/completed", turnCompleted(scripted.turnId));
    };
    session.closeHook = () => {
      session.emit(
        "item/completed",
        userMessage(
          session.turnId,
          userItem("user-2", submittedPrompt(session)),
        ),
      );
    };
    const reviewer = makeReviewer(session);
    const prepared = await reviewer.prepare(
      prepareRequest(await snapshotFixture()),
    );
    if (!prepared.ok) assert.fail(prepared.error.detail);
    const review = prepared.value;
    const outcome = await review.start();
    if (!outcome.ok) assert.fail(outcome.error.detail);
    assert.equal(outcome.value.status, "clean");
    const closed = await review.close();
    assert.equal(closed.failure, "close_failed");
    const finalized = finalizeReviewCompletion(outcome, closed);
    assert.equal(
      finalized.ok,
      false,
      "a second, different user item invalidates clean",
    );
  },
);
