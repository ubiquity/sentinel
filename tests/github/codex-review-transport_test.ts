/**
 * T03: durable GitHub Codex review transport acceptance.
 *
 * The scripted HTTP handler below is a DURABLE remote store shared by fresh
 * transport instances (read/write through the real `GitHubApiClient`); the
 * producer is the real recording `CodexStructuredReviewer` over a scripted
 * app-server session and the snapshot producer is the real `GitReviewSnapshot`
 * against real temporary Git repositories. No live GitHub, model, network or
 * paid call is made; every wait is milliseconds or driven by a controllable
 * promise.
 */

import assert from "node:assert/strict";
import { asGitSha, type GitSha } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import { CodexStructuredReviewer } from "../../src/github/codex-reviewer.ts";
import {
  GitHubCodexReviewTransport,
  type GitReviewSnapshotCaptureV1,
} from "../../src/github/codex-review-transport.ts";
import {
  parseReviewJournalBody,
  renderReviewJournalBody,
  REVIEW_MODEL,
  REVIEW_REASONING,
  type ReviewJournalReadyExecutionV1,
  type ReviewJournalReadyV1,
  type ReviewJournalRunningV1,
  reviewResultDigest,
  type ReviewResultV1,
} from "../../src/github/review-journal.ts";
import {
  GitReviewSnapshot,
  reviewSnapshotDigest,
  type ReviewSnapshotV1,
} from "../../src/github/review-snapshot.ts";
import type { HttpRequestV1, HttpResponseV1 } from "../../src/github/http.ts";
import type {
  CodexProtocolError,
  CodexServerNotificationV1,
  CodexSessionV1,
} from "../../src/repair/codex-transport.ts";
import {
  FakeAuthProvider,
  FakeClock,
  FakeCooldownGate,
  REPO,
  REVIEWER,
  T0,
} from "./helpers.ts";

const API = "https://api.github.com";
const PROVIDER = "openai";
const OWNER_RUN_ID = "run-transport-1";
const PR = 1;
const BASE: GitSha = asGitSha("a".repeat(40));
const HEAD: GitSha = asGitSha("b".repeat(40));
const OP_KEY = "review:work-1:head-b";
const REQUEST_ID = `review-${OP_KEY}`.slice(0, 256);
const LATEST_START = T0 + 60_000;
const SETTLE_BY = T0 + 600_000;

const ACCOUNT_CONTENT =
  "export function deposit(balance: number, amount: number) {\n" +
  '  if (amount < 0) throw new Error("negative");\n' +
  "  return balance + amount;\n" +
  "}\n";

const CLEAN_RESULT: ReviewResultV1 = {
  verdict: "clean",
  summary: "The supplied change matches the specification.",
  findings: [],
};

const FINDINGS_RESULT: ReviewResultV1 = {
  verdict: "findings",
  summary: "deposit subtracts the amount instead of adding it.",
  findings: [{
    priority: 1,
    title: "Deposit uses subtraction",
    body:
      "The specification requires `deposit(balance, amount)` to return `balance + amount`.\n\nThis implementation returns `balance - amount`.",
    path: "account.ts",
    lineStart: 1,
    lineEnd: 3,
  }],
};

// ---------------------------------------------------------------------------
// Durable scripted remote store (real GitHubApiClient endpoints)
// ---------------------------------------------------------------------------

interface StoredReviewV1 {
  id: number;
  prNumber: number;
  author: string;
  state: "pending" | "commented";
  body: string | null;
  head: GitSha;
  submittedAt: number | null;
}

function jsonResponse(status: number, value: unknown): HttpResponseV1 {
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    bodyText: JSON.stringify(value),
  };
}

function reviewJson(review: StoredReviewV1): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    id: review.id,
    user: { login: review.author },
    state: review.state === "pending" ? "PENDING" : "COMMENTED",
    body: review.body,
    commit_id: review.head,
  };
  // Genuine GitHub PENDING reviews omit `submitted_at`; a submitted review
  // carries the standing timestamp.
  if (review.state === "commented") {
    wire.submitted_at = new Date(review.submittedAt ?? T0).toISOString();
  }
  return wire;
}

class DurableReviewStore {
  readonly reviews = new Map<number, StoredReviewV1>();
  readonly requests: string[] = [];
  readonly submittedBodies: string[] = [];
  nextId = 100;
  creates = 0;
  updates = 0;
  submits = 0;
  /** Simulated lost responses: the write still applies (or not) and throws. */
  lostCreate = false;
  lostCreateApplies = true;
  lostUpdate = false;
  lostSubmit = false;
  /** A tampered durable running body: the readback must reject it. */
  tamperUpdates = false;
  failUpdate = false;
  /**
   * Controllable gate: while non-null, the running-journal PUT waits for it.
   * Tests always release the gate before returning (no leaked promise).
   */
  updateGate: Promise<void> | null = null;
  /**
   * Controllable gate: while non-null, the READY-journal PUT (the second PUT
   * for one review, i.e. the finalization after the owned process closed)
   * waits for it. Tests always release the gate before returning.
   */
  readyUpdateGate: Promise<void> | null = null;
  private readonly updateCounts = new Map<number, number>();

  handle = async (request: HttpRequestV1): Promise<HttpResponseV1> => {
    const path = request.url.startsWith(API)
      ? request.url.slice(API.length).split("?")[0]
      : request.url;
    this.requests.push(`${request.method} ${path}`);
    const list = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/.exec(path);
    const exact = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews\/(\d+)$/.exec(
      path,
    );
    const events =
      /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews\/(\d+)\/events$/.exec(
        path,
      );

    if (request.method === "GET" && list !== null) {
      const prNumber = Number(list[1]);
      const items = [...this.reviews.values()].filter((review) =>
        review.prNumber === prNumber
      );
      return Promise.resolve(jsonResponse(200, items.map(reviewJson)));
    }
    if (request.method === "GET" && exact !== null) {
      const review = this.reviews.get(Number(exact[2]));
      if (review === undefined) {
        return Promise.resolve(jsonResponse(404, { message: "Not Found" }));
      }
      return Promise.resolve(jsonResponse(200, reviewJson(review)));
    }
    if (request.method === "POST" && list !== null) {
      this.creates++;
      const payload = JSON.parse(request.body ?? "{}") as {
        commit_id: GitSha;
        body: string;
      };
      const created: StoredReviewV1 = {
        id: this.nextId++,
        prNumber: Number(list[1]),
        author: REVIEWER,
        state: "pending",
        body: payload.body,
        head: payload.commit_id,
        submittedAt: null,
      };
      if (this.lostCreate) {
        if (this.lostCreateApplies) this.reviews.set(created.id, created);
        return Promise.reject(new Error("synthetic lost create response"));
      }
      this.reviews.set(created.id, created);
      return Promise.resolve(jsonResponse(201, reviewJson(created)));
    }
    if (request.method === "PUT" && exact !== null) {
      this.updates++;
      const reviewId = Number(exact[2]);
      const priorUpdates = this.updateCounts.get(reviewId) ?? 0;
      this.updateCounts.set(reviewId, priorUpdates + 1);
      const gate = this.updateGate;
      if (gate !== null) await gate;
      if (priorUpdates > 0) {
        const readyGate = this.readyUpdateGate;
        if (readyGate !== null) await readyGate;
      }
      const review = this.reviews.get(Number(exact[2]));
      if (review === undefined) {
        return Promise.resolve(jsonResponse(404, { message: "Not Found" }));
      }
      if (this.failUpdate) {
        return Promise.resolve(
          jsonResponse(500, { message: "synthetic server error" }),
        );
      }
      const payload = JSON.parse(request.body ?? "{}") as { body: string };
      review.body = this.tamperUpdates ? `${payload.body}\n` : payload.body;
      if (this.lostUpdate) {
        return Promise.reject(new Error("synthetic lost update response"));
      }
      return Promise.resolve(jsonResponse(200, reviewJson(review)));
    }
    if (request.method === "POST" && events !== null) {
      this.submits++;
      const review = this.reviews.get(Number(events[2]));
      if (review === undefined) {
        return Promise.resolve(jsonResponse(404, { message: "Not Found" }));
      }
      const payload = JSON.parse(request.body ?? "{}") as {
        event: string;
        body: string;
      };
      assert.equal(payload.event, "COMMENT");
      this.submittedBodies.push(payload.body);
      review.state = "commented";
      review.submittedAt = T0;
      review.body = payload.body;
      if (this.lostSubmit) {
        return Promise.reject(new Error("synthetic lost submit response"));
      }
      return Promise.resolve(jsonResponse(200, reviewJson(review)));
    }
    return Promise.resolve(jsonResponse(404, { message: "unexpected" }));
  };
}

// ---------------------------------------------------------------------------
// Recording app-server session (real reviewer, no model call)
// ---------------------------------------------------------------------------

class RecordingSession implements CodexSessionV1 {
  readonly sent: string[] = [];
  readonly params: unknown[] = [];
  opened = 0;
  closed = 0;
  settled = true;
  failure: CodexProtocolError | null = null;
  result: ReviewResultV1 = CLEAN_RESULT;
  failStart = false;
  /** A turn whose response only settles when the session is closed. */
  hangStart = false;
  /** Real milliseconds before the terminal events arrive. */
  delayMs = 0;
  readonly turnId = "turn-1";
  readonly threadId = "thread-1";

  private handler: ((event: CodexServerNotificationV1) => void) | null = null;
  private readonly backlog: CodexServerNotificationV1[] = [];
  private readonly closeWaiters: ((error: Error) => void)[] = [];

  open(): void {
    this.opened++;
  }

  send(method: string, params: unknown): Promise<unknown> {
    this.sent.push(method);
    this.params.push(params);
    if (method === "initialize") {
      return Promise.resolve({ userAgent: "scripted/0.1.0" });
    }
    if (method === "thread/start") {
      return Promise.resolve({
        thread: { id: this.threadId },
        model: REVIEW_MODEL,
        modelProvider: PROVIDER,
        reasoningEffort: REVIEW_REASONING,
      });
    }
    if (method === "turn/start") {
      if (this.hangStart) {
        return new Promise<unknown>((_resolve, reject) => {
          this.closeWaiters.push(reject);
        });
      }
      if (this.failStart) {
        return Promise.reject(new Error("scripted submission failure"));
      }
      const emit = () => {
        this.emit("item/started", this.item("item-1", ""));
        this.emit(
          "item/completed",
          this.item("item-1", JSON.stringify(this.result)),
        );
        this.emit("turn/completed", {
          threadId: this.threadId,
          turn: { id: this.turnId, status: "completed", durationMs: 5 },
        });
      };
      if (this.delayMs > 0) setTimeout(emit, this.delayMs);
      else emit();
      return Promise.resolve({
        turn: { id: this.turnId, status: "inProgress" },
      });
    }
    return Promise.resolve({});
  }

  notify(): void {}

  onNotification(handler: (event: CodexServerNotificationV1) => void): void {
    this.handler = handler;
    const backlog = [...this.backlog];
    this.backlog.length = 0;
    for (const event of backlog) handler(event);
  }

  onServerRequest(): void {}

  close(): Promise<void> {
    this.closed++;
    const waiters = [...this.closeWaiters];
    this.closeWaiters.length = 0;
    for (const reject of waiters) {
      reject(new Error("scripted session closed during an owned turn"));
    }
    return Promise.resolve();
  }

  isSettled(): boolean {
    return this.settled;
  }

  getFailure(): CodexProtocolError | null {
    return this.failure;
  }

  turnStarts(): number {
    return this.sent.filter((method) => method === "turn/start").length;
  }

  private item(id: string, text: string): unknown {
    return {
      threadId: this.threadId,
      turnId: this.turnId,
      item: { type: "agentMessage", id, text },
    };
  }

  private emit(method: string, params: unknown): void {
    const event = { method, params } as CodexServerNotificationV1;
    if (this.handler === null) this.backlog.push(event);
    else this.handler(event);
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function snapshotFixture(
  overrides: Partial<ReviewSnapshotV1> = {},
): Promise<ReviewSnapshotV1> {
  const draft: ReviewSnapshotV1 = {
    version: "v1",
    base: BASE,
    head: HEAD,
    mergeBase: BASE,
    diff: "diff --git a/account.ts b/account.ts\n",
    files: [{
      path: "account.ts",
      kind: "modified",
      content: ACCOUNT_CONTENT,
    }],
    digest: "",
    ...overrides,
  };
  const digest = await reviewSnapshotDigest(draft);
  return { ...draft, digest };
}

function makeClient(
  store: DurableReviewStore,
  clock: FakeClock,
): GitHubApiClient {
  return new GitHubApiClient({
    repository: REPO,
    apiBaseUrl: API,
    http: (request) => store.handle(request),
    auth: new FakeAuthProvider(),
    cooldownGate: new FakeCooldownGate(),
    clock,
  });
}

function makeReviewer(
  session: RecordingSession,
  clock: FakeClock,
): CodexStructuredReviewer {
  return new CodexStructuredReviewer({
    provider: PROVIDER,
    openSession: () => session,
    sessionCwd: "/tmp/sentinel-review-transport",
    now: () => clock.now(),
  });
}

interface HarnessV1 {
  store: DurableReviewStore;
  clock: FakeClock;
  sessions: RecordingSession[];
  snapshotCaptures: () => number;
  transport: GitHubCodexReviewTransport;
  freshTransport: () => GitHubCodexReviewTransport;
}

function makeHarness(
  options: {
    store?: DurableReviewStore;
    session?: RecordingSession;
    snapshot?: GitReviewSnapshotCaptureV1;
    maxActiveReviews?: number;
  } = {},
): HarnessV1 {
  const store = options.store ?? new DurableReviewStore();
  const clock = new FakeClock(T0);
  const sessions: RecordingSession[] = [];
  let captures = 0;
  const inner: GitReviewSnapshotCaptureV1 = options.snapshot ?? {
    capture: async () => portOk(await snapshotFixture()),
  };
  const snapshot: GitReviewSnapshotCaptureV1 = {
    async capture(input) {
      captures++;
      return await inner.capture(input);
    },
  };
  const build = (): GitHubCodexReviewTransport =>
    new GitHubCodexReviewTransport({
      client: makeClient(store, clock),
      repository: REPO,
      publisher: REVIEWER,
      clock,
      ownerRunId: OWNER_RUN_ID,
      snapshot,
      reviewer: {
        prepare: (request) => {
          const session = options.session ?? new RecordingSession();
          sessions.push(session);
          return makeReviewer(session, clock).prepare(request);
        },
      },
      maxActiveReviews: options.maxActiveReviews,
    });
  return {
    store,
    clock,
    sessions,
    snapshotCaptures: () => captures,
    transport: build(),
    freshTransport: build,
  };
}

function submission(
  overrides: Partial<
    Parameters<GitHubCodexReviewTransport["submitReview"]>[0]
  > = {},
) {
  return {
    operationKey: OP_KEY,
    prNumber: PR,
    expectedHead: HEAD,
    expectedBase: BASE,
    expectedReviewer: REVIEWER,
    latestStartAt: LATEST_START,
    settleBy: SETTLE_BY,
    ...overrides,
  };
}

function readyExecution(
  overrides: Partial<ReviewJournalReadyExecutionV1> = {},
): ReviewJournalReadyExecutionV1 {
  return {
    ownerRunId: OWNER_RUN_ID,
    invocationId: `review-invocation-${OP_KEY}`.slice(0, 256),
    threadId: "thread-1",
    submittedProvider: PROVIDER,
    model: REVIEW_MODEL,
    reasoning: REVIEW_REASONING,
    startMayOccur: true,
    turnId: "turn-1",
    resultId: "result-1",
    actual: {
      evidenceKind: "request-runtime",
      provider: PROVIDER,
      threadId: "thread-1",
      turnId: "turn-1",
      terminalOrigin: "runtime",
      observedTerminalStatus: "completed",
      observedModel: REVIEW_MODEL,
      observedReasoning: REVIEW_REASONING,
      durationMs: 5,
      outputChars: 10,
    },
    ...overrides,
  };
}

async function readyJournal(
  result: ReviewResultV1,
  overrides: Partial<ReviewJournalReadyV1> = {},
): Promise<ReviewJournalReadyV1> {
  return {
    version: "v1",
    phase: "ready",
    repository: { owner: REPO.owner, name: REPO.name },
    prNumber: PR,
    expectedHead: HEAD,
    expectedBase: BASE,
    operationKey: OP_KEY,
    publisher: REVIEWER,
    requestId: REQUEST_ID,
    requestedAt: T0 - 5_000,
    reviewId: 100,
    completedAt: T0 - 1_000,
    result,
    resultDigest: await reviewResultDigest(result),
    execution: readyExecution(),
    ...overrides,
  };
}

function seed(
  store: DurableReviewStore,
  body: string,
  state: "pending" | "commented",
  options: { id?: number; author?: string; head?: GitSha } = {},
): StoredReviewV1 {
  const review: StoredReviewV1 = {
    id: options.id ?? 100,
    prNumber: PR,
    author: options.author ?? REVIEWER,
    state,
    body,
    head: options.head ?? HEAD,
    submittedAt: state === "commented" ? T0 - 1_000 : null,
  };
  store.reviews.set(review.id, review);
  return review;
}

function onlyReview(store: DurableReviewStore): StoredReviewV1 {
  const review = [...store.reviews.values()][0];
  if (review === undefined) throw new Error("no stored review");
  return review;
}

async function settle(
  transport: GitHubCodexReviewTransport,
  interrupt = false,
): Promise<void> {
  const drain = await transport.drain({
    deadline: T0 + 600_000,
    interrupt,
  });
  assert.equal(drain.ok, true, drain.faults.join(","));
}

// ---------------------------------------------------------------------------
// End-to-end: real Git snapshot + real reviewer + durable store
// ---------------------------------------------------------------------------

const PATH = Deno.env.get("PATH") ?? "/usr/bin:/bin";
const here = new URL(import.meta.url);
const testsDir = here.protocol === "file:"
  ? decodeURIComponent(here.pathname).replace(
    /\/codex-review-transport_test\.ts$/,
    "",
  )
  : ".";

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    args,
    cwd,
    clearEnv: true,
    env: {
      PATH,
      HOME: cwd,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Sentinel Test",
      GIT_AUTHOR_EMAIL: "sentinel-test@example.invalid",
      GIT_COMMITTER_NAME: "Sentinel Test",
      GIT_COMMITTER_EMAIL: "sentinel-test@example.invalid",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${
        new TextDecoder().decode(result.stderr)
      }`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}

/** Real temporary Git range with one changed file, cleaned up afterwards. */
async function withRealGitRange<T>(
  fn: (input: {
    base: GitSha;
    head: GitSha;
    snapshot: GitReviewSnapshotCaptureV1;
  }) => Promise<T>,
): Promise<T> {
  const repo = await Deno.makeTempDir({
    prefix: ".review-transport-",
    dir: testsDir,
  });
  try {
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "sentinel-test@example.invalid"]);
    await git(repo, ["config", "user.name", "Sentinel Test"]);
    await Deno.writeTextFile(
      `${repo}/account.ts`,
      "export const deposit = 0;\n",
    );
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "base"]);
    const base = asGitSha((await git(repo, ["rev-parse", "HEAD"])).trim());
    await Deno.writeTextFile(`${repo}/account.ts`, ACCOUNT_CONTENT);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "head"]);
    const head = asGitSha((await git(repo, ["rev-parse", "HEAD"])).trim());
    const snapshot = new GitReviewSnapshot({
      trustedPath: PATH,
      repositoryDir: repo,
    });
    return await fn({ base, head, snapshot });
  } finally {
    await Deno.remove(repo, { recursive: true }).catch(() => {});
  }
}

Deno.test(
  "transport: real Git snapshot and recording session publish one exact clean COMMENT",
  async () => {
    await withRealGitRange(async ({ base, head, snapshot }) => {
      const session = new RecordingSession();
      session.result = CLEAN_RESULT;
      const h = makeHarness({ session, snapshot });
      const submitted = await h.transport.submitReview(
        submission({ expectedBase: base, expectedHead: head }),
      );
      assert.equal(submitted.ok, true);
      assert.equal(submitted.ok ? submitted.value.status : "", "submitted");
      await settle(h.transport);
      const review = onlyReview(h.store);
      assert.equal(review.state, "commented");
      assert.equal(review.head, head);
      assert.equal(session.opened, 1);
      assert.equal(session.turnStarts(), 1);
      assert.equal(session.closed, 1);
      assert.equal(h.store.creates, 1);
      assert.equal(
        h.store.requests.filter((entry) =>
          entry === "POST /repos/ubiquity/sentinel/pulls/1/reviews"
        ).length,
        1,
        "exactly one review object is created",
      );
      // One running update and one ready update, then exactly one COMMENT.
      assert.equal(h.store.updates, 2);
      assert.equal(h.store.submits, 1);
      const body = review.body ?? "";
      const journal = await parseReviewJournalBody(body);
      assert.ok(journal.phase === "ready");
      assert.deepEqual(journal.result, CLEAN_RESULT);
      // The durable review binding is proved on the PARSED journal identity,
      // never by a substring of the rendered body.
      assert.equal(journal.expectedBase, base);
      assert.equal(journal.expectedHead, head);

      // A fresh transport instance reads the durable completion, not a memory.
      const read = await h.freshTransport().readReview({
        operationKey: OP_KEY,
        requestId: null,
        prNumber: PR,
      });
      assert.equal(read.ok, true);
      if (read.ok) {
        assert.equal(read.value.status, "completed");
        assert.equal(
          read.value.resultDigest,
          await reviewResultDigest(CLEAN_RESULT),
        );
        assert.equal(read.value.expectedReviewer, REVIEWER);
        assert.equal(read.value.expectedHead, head);
      }
    });
  },
);

Deno.test(
  "transport: full multiline findings are published intact",
  async () => {
    await withRealGitRange(async ({ base, head, snapshot }) => {
      const session = new RecordingSession();
      session.result = FINDINGS_RESULT;
      const h = makeHarness({ session, snapshot });
      const submitted = await h.transport.submitReview(
        submission({ expectedBase: base, expectedHead: head }),
      );
      assert.equal(submitted.ok, true);
      await settle(h.transport);
      const review = onlyReview(h.store);
      const body = review.body ?? "";
      const journal = await parseReviewJournalBody(body);
      assert.ok(journal.phase === "ready");
      assert.deepEqual(journal.result, FINDINGS_RESULT);
      assert.ok(body.includes("Deposit uses subtraction"));
      assert.ok(body.includes("`balance - amount`"));

      const read = await h.freshTransport().readReview({
        operationKey: OP_KEY,
        requestId: null,
        prNumber: PR,
      });
      assert.equal(read.ok, true);
      if (read.ok) {
        assert.equal(read.value.status, "completed");
        assert.equal(read.value.summary, FINDINGS_RESULT.summary);
      }
    });
  },
);

// ---------------------------------------------------------------------------
// Strict consumers: prose, digest, publisher, duplicates, foreign drafts
// ---------------------------------------------------------------------------

Deno.test(
  "transport: old clean prose is never adopted as completion",
  async () => {
    const h = makeHarness();
    seed(
      h.store,
      "## Codex review\n\nNo issues found. Looks good to merge.",
      "commented",
    );
    const read = await h.transport.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value.status, "unavailable");
  },
);

Deno.test(
  "transport: a digest mismatch in the standing ready body is unavailable",
  async () => {
    const h = makeHarness();
    const journal = await readyJournal(CLEAN_RESULT);
    seed(
      h.store,
      renderReviewJournalBody({
        ...journal,
        resultDigest: "0".repeat(64),
      }),
      "commented",
    );
    const read = await h.transport.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value.status, "unavailable");
  },
);

Deno.test(
  "transport: wrong publisher, head or base never completes",
  async () => {
    const foreign = makeHarness();
    seed(
      foreign.store,
      renderReviewJournalBody(await readyJournal(CLEAN_RESULT)),
      "commented",
      { author: "someone-else[bot]" },
    );
    const readForeign = await foreign.transport.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(readForeign.ok, true);
    if (readForeign.ok) assert.equal(readForeign.value.status, "unavailable");

    const wrongHead = makeHarness();
    seed(
      wrongHead.store,
      renderReviewJournalBody(await readyJournal(CLEAN_RESULT)),
      "commented",
      { head: asGitSha("c".repeat(40)) },
    );
    const readHead = await wrongHead.transport.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(readHead.ok, true);
    if (readHead.ok) assert.equal(readHead.value.status, "unavailable");

    const wrongBase = makeHarness();
    // A durable intent for the exact operation on a DIFFERENT base is never
    // upgraded into a preparation or start: the submission stays unavailable.
    seed(
      wrongBase.store,
      renderReviewJournalBody({
        version: "v1",
        phase: "intent",
        repository: { owner: REPO.owner, name: REPO.name },
        prNumber: PR,
        expectedHead: HEAD,
        expectedBase: asGitSha("d".repeat(40)),
        operationKey: OP_KEY,
        publisher: REVIEWER,
        requestId: REQUEST_ID,
        requestedAt: T0 - 5_000,
      }),
      "pending",
    );
    const readBase = await wrongBase.transport.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(readBase.ok, true);
    if (readBase.ok) assert.equal(readBase.value.status, "unavailable");
    const submittedBase = await wrongBase.transport.submitReview(submission());
    assert.equal(submittedBase.ok, false);
    assert.equal(wrongBase.sessions.length, 0);
    assert.equal(wrongBase.store.creates, 0);
  },
);

Deno.test(
  "transport: a COMMENTED record cannot hide a duplicate pending record",
  async () => {
    const h = makeHarness();
    const body = renderReviewJournalBody(await readyJournal(CLEAN_RESULT));
    seed(h.store, body, "commented", { id: 100 });
    seed(h.store, body, "pending", { id: 101 });
    const read = await h.transport.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value.status, "unavailable");

    // A fresh submission reconciles the same conflict and never starts a model.
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, false);
    assert.equal(h.sessions.length, 0);
    assert.equal(h.store.creates, 0);
  },
);

Deno.test(
  "transport: foreign and unrelated publisher drafts block adoption",
  async () => {
    const h = makeHarness();
    seed(
      h.store,
      renderReviewJournalBody(
        await readyJournal(CLEAN_RESULT, { operationKey: "review:other" }),
      ),
      "pending",
      { id: 200 },
    );
    const read = await h.transport.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value.status, "unavailable");

    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, false);
    assert.equal(h.sessions.length, 0);
    assert.equal(h.store.creates, 0);
  },
);

// ---------------------------------------------------------------------------
// Durable running journal, lost writes, no duplicate model
// ---------------------------------------------------------------------------

Deno.test(
  "transport: a tampered running readback prevents the single start",
  async () => {
    const h = makeHarness();
    h.store.tamperUpdates = true;
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    assert.equal(submitted.ok ? submitted.value.status : "", "ambiguous");
    const session = h.sessions[0];
    assert.equal(session.turnStarts(), 0);
    assert.equal(session.closed, 1);
    // The durable journal stands: a fresh host reads it as unavailable
    // (charged), never as a completed review and never as a restart.
    const read = await h.freshTransport().readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value.status, "unavailable");
    assert.equal(h.store.submits, 0);
  },
);

Deno.test(
  "transport: a rejected running update with no readback proof prevents the start",
  async () => {
    const h = makeHarness();
    h.store.failUpdate = true;
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, false);
    const session = h.sessions[0];
    assert.equal(session.turnStarts(), 0);
    assert.equal(session.closed, 1);
  },
);

Deno.test(
  "transport: a lost create is recovered from the exact intent without a second create",
  async () => {
    const h = makeHarness();
    h.store.lostCreate = true;
    h.store.lostCreateApplies = true;
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    assert.equal(submitted.ok ? submitted.value.status : "", "submitted");
    await settle(h.transport);
    assert.equal(h.store.creates, 1);
    assert.equal(h.sessions[0].turnStarts(), 1);
    assert.equal(onlyReview(h.store).state, "commented");
  },
);

Deno.test(
  "transport: an uncertain lost create is ambiguous and never creates twice",
  async () => {
    const h = makeHarness();
    h.store.lostCreate = true;
    h.store.lostCreateApplies = false;
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    assert.equal(submitted.ok ? submitted.value.status : "", "ambiguous");
    assert.equal(h.store.creates, 1);
    assert.equal(h.sessions.length, 0);
    assert.equal(h.store.reviews.size, 0);
  },
);

Deno.test(
  "transport: a lost running update is reconciled by the exact readback before the start",
  async () => {
    const h = makeHarness();
    h.store.lostUpdate = true;
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    assert.equal(submitted.ok ? submitted.value.status : "", "submitted");
    await settle(h.transport);
    // Exactly one running update (never retried) plus the ready update.
    assert.equal(h.store.updates, 2);
    assert.equal(h.sessions[0].turnStarts(), 1);
  },
);

Deno.test(
  "transport: a lost submit response is reconciled by exact id and publishes once",
  async () => {
    const h = makeHarness();
    h.store.lostSubmit = true;
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    await settle(h.transport);
    assert.equal(h.store.submits, 1);
    assert.equal(h.store.creates, 1);
    assert.equal(onlyReview(h.store).state, "commented");
    const read = await h.freshTransport().readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value.status, "completed");
  },
);

Deno.test(
  "transport: a stale running journal on a fresh host is unavailable and never restarts the model",
  async () => {
    const h = makeHarness();
    const running: ReviewJournalRunningV1 = {
      version: "v1",
      phase: "running",
      repository: { owner: REPO.owner, name: REPO.name },
      prNumber: PR,
      expectedHead: HEAD,
      expectedBase: BASE,
      operationKey: OP_KEY,
      publisher: REVIEWER,
      requestId: REQUEST_ID,
      requestedAt: T0 - 5_000,
      reviewId: 100,
      execution: readyExecution(),
    };
    seed(h.store, renderReviewJournalBody(running), "pending");

    const fresh = h.freshTransport();
    const read = await fresh.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value.status, "unavailable");

    // A new submission for the same review identity reconciles the durable
    // record, stays charged and never prepares or starts a model.
    const submitted = await fresh.submitReview(submission());
    assert.equal(submitted.ok, false);
    assert.equal(h.sessions.length, 0);
    assert.equal(h.store.creates, 0);
  },
);

Deno.test(
  "transport: a ready pending journal is published from readReview with no inference",
  async () => {
    const h = makeHarness();
    const journal = await readyJournal(CLEAN_RESULT);
    seed(h.store, renderReviewJournalBody(journal), "pending");

    const fresh = h.freshTransport();
    const read = await fresh.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.value.status, "completed");
      assert.equal(read.value.completedAt, journal.completedAt);
      assert.equal(read.value.resultDigest, journal.resultDigest);
      assert.equal(read.value.resultId, "result-1");
      assert.equal(read.value.requestId, journal.requestId);
    }
    const review = onlyReview(h.store);
    assert.equal(review.state, "commented");
    // No snapshot, no prepare, no model start, no new review object and the
    // ORIGINAL journal bytes are the submitted body.
    assert.equal(h.snapshotCaptures(), 0);
    assert.equal(h.sessions.length, 0);
    assert.equal(h.store.creates, 0);
    assert.equal(h.store.updates, 0);
    assert.equal(h.store.submits, 1);
    assert.equal(h.store.submittedBodies[0], review.body);
  },
);

Deno.test(
  "transport: a durable unavailable disposition never completes clean",
  async () => {
    const session = new RecordingSession();
    session.failStart = true;
    const h = makeHarness({ session });
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    await settle(h.transport);
    const review = onlyReview(h.store);
    const unavailable = await parseReviewJournalBody(review.body ?? "");
    assert.ok(unavailable.phase === "ready");
    assert.equal(unavailable.result.verdict, "unavailable");
    const read = await h.freshTransport().readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.value.status, "unavailable");
      assert.equal(read.value.terminalTurnSucceeded, false);
    }
  },
);

Deno.test(
  "transport: an unproved close keeps ownership and publishes no disposition",
  async () => {
    const session = new RecordingSession();
    session.hangStart = true;
    session.settled = false;
    const h = makeHarness({ session });
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    const report = await h.transport.drain({ deadline: T0, interrupt: true });
    assert.equal(report.ok, false);
    assert.equal(report.operations[0].outcome, "faulted");
    assert.equal(report.operations[0].processSettled, false);
    assert.equal(report.interrupted, true);
    const read = await h.transport.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) assert.notEqual(read.value.status, "completed");
    assert.equal(h.store.submits, 0);
  },
);

// ---------------------------------------------------------------------------
// Overlap and drain
// ---------------------------------------------------------------------------

Deno.test(
  "transport: one live review overlaps a second implementation target",
  async () => {
    const session = new RecordingSession();
    session.delayMs = 50;
    const h = makeHarness({ session });
    const first = await h.transport.submitReview(submission());
    assert.equal(first.ok, true);
    // The review is live and independent: the one implementation writer can
    // advance another task while it runs. A second review for the SAME PR is
    // rejected as overlapping.
    const overlap = await h.transport.submitReview(
      submission({ operationKey: "review:work-2" }),
    );
    assert.equal(overlap.ok, false);
    const read = await h.transport.readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value.status, "pending");
    assert.equal(session.turnStarts(), 1);
    // The healthy review still completes and settles normally.
    await settle(h.transport);
    assert.equal(onlyReview(h.store).state, "commented");
  },
);

Deno.test(
  "transport: drain awaits a healthy review without an eager interruption",
  async () => {
    const session = new RecordingSession();
    session.delayMs = 5;
    const h = makeHarness({ session });
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    const report = await h.transport.drain({
      deadline: T0 + 600_000,
      interrupt: true,
    });
    assert.equal(report.ok, true);
    assert.equal(report.operations.length, 1);
    assert.equal(report.operations[0].outcome, "settled");
    assert.equal(report.operations[0].phase, "published");
    assert.equal(report.operations[0].processSettled, true);
    // Never interrupted merely because input.interrupt was true.
    assert.equal(report.interrupted, false);
    assert.equal(session.turnStarts(), 1);
    assert.equal(session.closed, 1);
  },
);

Deno.test(
  "transport: drain stops admission and a late submission never starts a model",
  async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = new RecordingSession();
    const h = makeHarness({
      session,
      snapshot: {
        async capture() {
          await gate;
          return portOk(await snapshotFixture());
        },
      },
    });
    const pending = h.transport.submitReview(submission());
    const report = await h.transport.drain({ deadline: T0, interrupt: true });
    // The in-flight submission could not be awaited inside the caller's
    // deadline: ownership is retained and the operation is reported faulted.
    assert.equal(report.ok, false);
    assert.equal(report.operations[0].outcome, "faulted");
    release!();
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(
      result.ok ? result.value.status : "",
      "rejected",
      "a submission awaiting work during drain must not start",
    );
    assert.equal(session.turnStarts(), 0);
    assert.equal(h.store.creates, 0);
  },
);

Deno.test(
  "transport: a short deadline rejects a last-second review before any create",
  async () => {
    const h = makeHarness();
    const late = await h.transport.submitReview(
      submission({ latestStartAt: T0, settleBy: T0 + 100_000 }),
    );
    assert.equal(late.ok, false);
    assert.equal(h.store.creates, 0);

    // The clock crosses the full-review bound while the snapshot is captured.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated = makeHarness({
      snapshot: {
        async capture() {
          await gate;
          return portOk(await snapshotFixture());
        },
      },
    });
    const pending = gated.transport.submitReview(submission());
    gated.clock.advance(120_000);
    release!();
    const rejected = await pending;
    assert.equal(rejected.ok, true);
    assert.equal(rejected.ok ? rejected.value.status : "", "rejected");
    assert.equal(gated.store.creates, 0);
    assert.equal(gated.sessions.length, 0);
  },
);

// ---------------------------------------------------------------------------
// v3 identity and deadline corrections
// ---------------------------------------------------------------------------

const OTHER_HEAD: GitSha = asGitSha("e".repeat(40));

/** Finite, real-time wait for a controllable test condition. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("control condition was not reached");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** A close whose settlement lands after a controllable real delay. */
class DelayedCloseSession extends RecordingSession {
  closeCalls = 0;
  constructor(private readonly closeDelayMs: number) {
    super();
  }
  override async close(): Promise<void> {
    this.closeCalls++;
    await new Promise((resolve) => setTimeout(resolve, this.closeDelayMs));
    await super.close();
  }
}

Deno.test(
  "transport: an unknown operation key never falls back to a request-id match",
  async () => {
    const session = new RecordingSession();
    session.delayMs = 50;
    const h = makeHarness({ session });
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    // The live owned operation carries REQUEST_ID, but this read names a
    // DIFFERENT operation key: every supplied identifier must match exactly,
    // so the local live receipt is never returned.
    const read = await h.transport.readReview({
      operationKey: "review:unknown-operation",
      requestId: REQUEST_ID,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.notEqual(
        read.value.status,
        "pending",
        "an unknown operation key must not match another operation by request id",
      );
    }
    // The exact identity still resolves locally while the operation is live.
    const exact = await h.transport.readReview({
      operationKey: OP_KEY,
      requestId: REQUEST_ID,
      prNumber: PR,
    });
    assert.equal(exact.ok, true);
    await settle(h.transport);
  },
);

Deno.test(
  "transport: a published journal for a different head is never adopted by identity",
  async () => {
    const store = new DurableReviewStore();
    const h = makeHarness({ store });
    // A standing COMMENTED ready journal for the SAME operation key/request id
    // but a DIFFERENT head: it must never be adopted as this submission.
    seed(
      store,
      renderReviewJournalBody(await readyJournal(CLEAN_RESULT)),
      "commented",
    );
    const fresh = h.freshTransport();
    const submitted = await fresh.submitReview(
      submission({ expectedHead: OTHER_HEAD }),
    );
    assert.equal(submitted.ok, true);
    assert.equal(submitted.ok ? submitted.value.status : "", "submitted");
    // The different-head record was NOT adopted: this submission reconciled it
    // as a foreign record and created/published its own exact-head review.
    assert.equal(store.creates, 1, "no adoption of the foreign-head record");
    await settle(fresh);
    assert.equal(store.submits, 1, "this submission published its own review");
    const created = [...store.reviews.values()].find((review) =>
      review.head === OTHER_HEAD
    );
    assert.ok(created, "the exact-head review exists");
  },
);

Deno.test(
  "transport: drain never awaits an owned close past the caller deadline",
  async () => {
    const session = new DelayedCloseSession(150);
    session.hangStart = true;
    session.settled = false;
    const h = makeHarness({ session });
    const submitted = await h.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    const started = Date.now();
    const report = await h.transport.drain({
      deadline: h.clock.now() + 5,
      interrupt: true,
    });
    const elapsed = Date.now() - started;
    // Caller time is gone: the close was initiated and its exact promise is
    // retained, but the drain reports the unsettled fault honestly instead of
    // waiting past the deadline.
    assert.equal(report.ok, false);
    assert.equal(report.operations[0].outcome, "faulted");
    assert.equal(report.operations[0].processSettled, false);
    assert.equal(report.interrupted, true);
    assert.ok(
      elapsed < 120,
      `the drain returned inside the caller deadline (${elapsed}ms)`,
    );
    // Release the outstanding close so no owned promise is left pending.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(session.closeCalls, 1, "the close is never duplicated");
    assert.equal(h.sessions.length, 1);
  },
);

Deno.test(
  "transport: a hung prestart submission retains and closes its prepared handle",
  async () => {
    const store = new DurableReviewStore();
    let release!: () => void;
    store.updateGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = new RecordingSession();
    const h = makeHarness({ store, session });
    const submitted = h.transport.submitReview(submission());
    await waitFor(() => store.updates >= 1);
    const report = await h.transport.drain({
      deadline: h.clock.now() + 5,
      interrupt: true,
    });
    assert.equal(report.ok, false);
    assert.equal(report.operations[0].outcome, "faulted");
    assert.equal(report.operations[0].processSettled, true);
    assert.equal(report.operations[0].durable, false);
    assert.equal(report.operations[0].phase, "intent");
    assert.equal(
      report.interrupted,
      false,
      "closing an unstarted prepared session is not an interruption",
    );
    assert.equal(session.turnStarts(), 0, "no model start exists");
    assert.equal(session.closed, 1, "the owned handle was closed");
    // Release the gated running update: the submission settles with no leak.
    release();
    const settled = await submitted;
    assert.equal(settled.ok, true);
    assert.equal(settled.ok ? settled.value.status : "", "ambiguous");
  },
);

Deno.test(
  "transport: only an actually started session is interrupted",
  async () => {
    // (a) An unstarted prepared handle is closed, never "interrupted".
    const preStore = new DurableReviewStore();
    let releasePre!: () => void;
    preStore.updateGate = new Promise<void>((resolve) => {
      releasePre = resolve;
    });
    const preSession = new RecordingSession();
    const pre = makeHarness({ store: preStore, session: preSession });
    const pendingSubmit = pre.transport.submitReview(submission());
    await waitFor(() => preStore.updates >= 1);
    const preReport = await pre.transport.drain({
      deadline: pre.clock.now() + 5,
      interrupt: true,
    });
    assert.equal(preReport.interrupted, false);
    assert.equal(preReport.operations[0].processSettled, true);
    releasePre();
    await pendingSubmit;

    // (b) A session that actually started and outlives the work boundary IS
    // interrupted, and its unproved close is never reported as settled.
    const startedSession = new RecordingSession();
    startedSession.hangStart = true;
    startedSession.settled = false;
    const run = makeHarness({ session: startedSession });
    const submitted = await run.transport.submitReview(submission());
    assert.equal(submitted.ok, true);
    const runReport = await run.transport.drain({
      deadline: run.clock.now() + 5,
      interrupt: true,
    });
    assert.equal(runReport.interrupted, true);
    assert.equal(runReport.operations[0].outcome, "faulted");
    assert.equal(runReport.operations[0].processSettled, false);
  },
);

Deno.test(
  "transport: drain proves owned journal finalization, not only the process close",
  async () => {
    const store = new DurableReviewStore();
    let releaseReady!: () => void;
    const readyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    store.readyUpdateGate = readyGate;
    const session = new RecordingSession();
    // The owned turn only settles when the session closes, and that close DOES
    // prove process settlement. The ready journal PUT/readback (and therefore
    // the COMMENT) stays gated afterwards.
    session.hangStart = true;
    session.settled = true;
    const h = makeHarness({ store, session });
    try {
      const submitted = await h.transport.submitReview(submission());
      assert.equal(submitted.ok, true);
      assert.equal(submitted.ok ? submitted.value.status : "", "submitted");

      const report = await h.transport.drain({
        deadline: h.clock.now() + 50,
        interrupt: true,
      });
      // The process close settled, but the owned journal finalization is still
      // pending: a drain may NOT report success on the proved close alone.
      assert.equal(report.ok, false);
      assert.equal(report.operations[0].outcome, "faulted");
      assert.equal(report.operations[0].processSettled, true);
      assert.equal(report.operations[0].durable, false);
      assert.equal(store.updates, 2, "the ready PUT was attempted");
      assert.equal(
        store.submits,
        0,
        "no COMMENT before finalization is proved",
      );
    } finally {
      // Every gate is released even when an assertion above failed.
      releaseReady();
    }
    // The retained owned promise still finalizes the journal: exactly one
    // COMMENT, and because the close interrupted a failed turn/start the
    // journal completes with the durable disposition `unavailable` for a fresh
    // reader rather than a completed review.
    await waitFor(() => store.submits === 1);
    assert.equal(onlyReview(store).state, "commented");
    const read = await h.freshTransport().readReview({
      operationKey: OP_KEY,
      requestId: null,
      prNumber: PR,
    });
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.value.status, "unavailable");
  },
);

Deno.test(
  "transport: an unproved close keeps ownership against a same-key retry",
  async () => {
    const session = new RecordingSession();
    session.failStart = true;
    session.settled = false;
    const h = makeHarness({ session, maxActiveReviews: 1 });
    const first = await h.transport.submitReview(submission());
    assert.equal(first.ok, true);
    assert.equal(first.ok ? first.value.status : "", "submitted");
    // The owned run ends with an UNPROVED close: `done` is set locally, but the
    // retained prepared handle still owns the producer process.
    await waitFor(() => session.closed >= 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A same-key resubmission before any drain may never replace the operation
    // and drop the retained process ownership.
    const retry = await h.transport.submitReview(submission());
    assert.equal(
      retry.ok,
      false,
      "no replacement while settlement is unproved",
    );
    assert.equal(retry.ok ? "" : retry.error.kind, "conflict");
    // The retained operation still counts against active capacity.
    const other = await h.transport.submitReview(
      submission({ operationKey: "review:work-2", prNumber: 2 }),
    );
    assert.equal(
      other.ok,
      false,
      "the retained handle still occupies capacity",
    );
    assert.equal(other.ok ? "" : other.error.kind, "conflict");
    // No new prepare, start or review object: the original owned session and
    // the single durable intent stand.
    assert.equal(h.sessions.length, 1);
    assert.equal(session.opened, 1);
    assert.equal(session.turnStarts(), 1);
    assert.equal(h.store.creates, 1);

    // The drain still reports the RETAINED original handle, never a
    // replacement, and the close is never duplicated.
    const report = await h.transport.drain({ deadline: T0, interrupt: true });
    assert.equal(report.operations.length, 1);
    assert.equal(report.operations[0].operationKey, OP_KEY);
    assert.equal(report.operations[0].outcome, "faulted");
    assert.equal(report.operations[0].processSettled, false);
    assert.equal(session.closed, 1, "the close is never duplicated");
    assert.equal(h.sessions.length, 1, "no replacement session was prepared");
    assert.equal(
      h.store.submits,
      0,
      "no disposition without proved settlement",
    );
  },
);
