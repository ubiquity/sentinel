// Narrow local-host tests: fixed config parsing, isolated Codex config text
// and exclusive-lock behavior. No network, model, GitHub or real state root.
import assert from "node:assert/strict";

import {
  createLocalRepositoryConfig,
  localCheckoutKey,
  type LocalRepairHostOptionsV1,
  readAuthenticatedLogin,
  refreshDevelopment,
  renderLocalCodexConfig,
  scopeLocalRepairIssues,
  tryAcquireLocalHostLock,
  writeLocalModelResult,
} from "../../src/host/local.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type {
  GitHubCooldownGateV1,
  GitHubIssueV1,
  ModelRunReceiptV1,
  ModelRunRequestV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { LOOP_STOP_MARKER } from "../../src/repair/model-port.ts";
import { FakeClock, FakeGithub, MemoryState } from "../repair/helpers.ts";
import { REPO, SHA1, SHA3, T0 } from "../state/helpers.ts";

Deno.test("local repository config parses with fixed local scope", () => {
  const config = createLocalRepositoryConfig();
  assert.equal(config.repository.owner, "ubiquity");
  assert.equal(config.repository.name, "sentinel");
  assert.equal(config.repository.installationId, 0);
  assert.equal(config.adapter.kind, "github");
  assert.equal(config.baseBranch, "development");
  assert.deepEqual(config.commands, {
    replay: "replay_capture",
    test: "test_ci",
  });
  assert.equal(config.liveStartLimits?.perHour, 1);
  assert.equal(config.liveStartLimits?.perSevenDays, 168);
  assert.equal(config.sessionBound?.maxDurationMs, 1_200_000);
  assert.equal(config.sessionBound?.maxOutputChars, 400_000);
  assert.equal(config.retention, null);
  assert.equal(config.stabilityPolicy, null);
  assert.equal(config.build.projectId, null);
  assert.equal(config.build.acceptance, null);
  assert.equal(config.secretRef, "secret://host/injected/sentinel-local-owner");
  assert.ok(config.protectedPaths.includes("src/host/local.ts"));
  assert.ok(config.protectedPaths.includes("src/budget/"));
  assert.ok(!config.protectedPaths.includes("src/"));
  const specs = Object.values(config.commandRegistry.commands);
  assert.equal(specs.length, 2);
  const local = specs.find((spec) => spec.args.includes("test:local"));
  assert.ok(local !== undefined);
  assert.deepEqual(local.args, ["task", "test:local"]);
  const replay = specs.find((spec) => spec.args.includes("replay:capture"));
  assert.ok(replay !== undefined);
  assert.deepEqual(replay.args, ["task", "replay:capture"]);
});

Deno.test("local Codex config isolates the model client", () => {
  const text = renderLocalCodexConfig({
    profile: "sentinel-local",
    tokenFile: "/private/clients/key/model.token",
    shellHome: "/private/checkouts/key",
    shellPath: "/usr/bin:/bin",
    shellTmpDir: "/private/tmp/key",
    shellDenoDir: "/private/deno/key",
    codexDistributionDir: "/home/.codex/packages/standalone",
    denoExecutable: "/bin/deno",
    writeGrants: ["/private/tmp/key", "/private/deno/key"],
  });
  assert.match(text, /^approval_policy = "never"$/m);
  assert.match(text, /^allow_login_shell = false$/m);
  assert.match(text, /^default_permissions = "sentinel-local"$/m);
  assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:8000\/v1"/);
  assert.match(text, /command = "\/bin\/cat"/);
  assert.match(text, /args = \["\/private\/clients\/key\/model\.token"\]/);
  assert.match(text, /^\[permissions\.sentinel-local\.filesystem\]$/m);
  assert.match(text, /^":minimal" = "read"$/m);
  assert.match(text, /^"\/home\/\.codex\/packages\/standalone" = "read"$/m);
  assert.match(text, /^"\/bin\/deno" = "read"$/m);
  assert.match(text, /^"\/private\/tmp\/key" = "write"$/m);
  assert.match(text, /^"\/private\/deno\/key" = "write"$/m);
  assert.match(
    text,
    /^\[permissions\.sentinel-local\.filesystem\.":workspace_roots"\]$/m,
  );
  assert.match(text, /^"\." = "write"$/m);
  assert.match(text, /^"\.git" = "read"$/m);
  assert.match(text, /^"\.codex" = "read"$/m);
  assert.match(text, /^\[permissions\.sentinel-local\.network\]$/m);
  assert.match(text, /^enabled = false$/m);
  assert.match(text, /^inherit = "none"$/m);
  assert.match(text, /HOME = "\/private\/checkouts\/key"/);
  // allow_login_shell is top level, never nested in the shell policy table.
  const shell = text.slice(text.indexOf("[shell_environment_policy]"));
  assert.ok(!shell.includes("allow_login_shell"));
  // The former invented read/write arrays and network boolean are gone.
  assert.ok(!text.includes("read = ["));
  assert.ok(!text.includes("write = ["));
  assert.ok(!text.includes("network = false"));
  // The token value is never written; only its file path is referenced.
  assert.ok(!text.includes("Bearer"));
  assert.ok(!text.includes("GITHUB_TOKEN"));
});

Deno.test("review Codex config is read-only", () => {
  const text = renderLocalCodexConfig({
    profile: "sentinel-review",
    tokenFile: "/private/clients/review/model.token",
    shellHome: "/private/review-checkout",
    shellPath: "/usr/bin:/bin",
    shellTmpDir: "/private/tmp/review",
    shellDenoDir: "/private/deno/review",
    codexDistributionDir: "/home/.codex/packages/standalone",
    denoExecutable: "/bin/deno",
    writeGrants: [],
  });
  assert.match(text, /^default_permissions = "sentinel-review"$/m);
  assert.match(text, /^\[permissions\.sentinel-review\.filesystem\]$/m);
  assert.match(text, /^":minimal" = "read"$/m);
  assert.match(text, /^"\/bin\/deno" = "read"$/m);
  assert.match(
    text,
    /^\[permissions\.sentinel-review\.filesystem\.":workspace_roots"\]$/m,
  );
  assert.match(text, /^"\." = "read"$/m);
  assert.match(text, /^\[permissions\.sentinel-review\.network\]$/m);
  assert.match(text, /^enabled = false$/m);
  assert.ok(!text.includes('= "write"'));
  assert.ok(!text.includes("sentinel-local"));
});

Deno.test("task checkout keys are stable and distinct", async () => {
  const first = await localCheckoutKey("issue-42");
  const second = await localCheckoutKey("issue-42");
  const other = await localCheckoutKey("issue-43");
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^[0-9a-f]{64}$/);
});

Deno.test("state lock refuses a second overlapping writer", async () => {
  const root = await Deno.makeTempDir({ dir: ".", prefix: "sentinel-lock-" });
  try {
    const first = await tryAcquireLocalHostLock(root);
    assert.notEqual(first, null);
    assert.equal(await tryAcquireLocalHostLock(root), null);
    first!.close();
    const reacquired = await tryAcquireLocalHostLock(root);
    assert.notEqual(reacquired, null);
    reacquired!.close();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Startup gate ordering: durable cooldown admission precedes EVERY remote
// refresh/login request, and a confirmed rate-limit response is persisted
// through the same durable gate before the static startup failure.
// ---------------------------------------------------------------------------

/** Valid empty repair snapshot (same shape as tests/repair/local-owner_test.ts). */
function emptySnapshot(): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
  });
}

async function seededState(): Promise<MemoryState> {
  const state = new MemoryState();
  const seeded = await state.writeRepair(emptySnapshot(), null);
  assert.equal(seeded.ok, true);
  return state;
}

/** One ordered event log for gate admission, HTTP and persistence. */
function countingGate(
  inner: GitHubCooldownGateV1,
  events: string[],
): GitHubCooldownGateV1 {
  return {
    beforeRequest: (installationId) => {
      events.push(`beforeRequest:${installationId}`);
      return inner.beforeRequest(installationId);
    },
    recordRateLimit: (installationId, rateLimit) => {
      events.push(`recordRateLimit:${installationId}`);
      return inner.recordRateLimit(installationId, rateLimit);
    },
  };
}

/** Poison paths: any real Git execution here would fail, never succeed. */
const POISON_OPTIONS: LocalRepairHostOptionsV1 = {
  stateRoot: "/nonexistent/sentinel-poison-state",
  sourceDir: "/nonexistent/sentinel-poison-source",
  controllerSha: SHA1,
  githubToken: "dummy-token",
  modelToken: "dummy-token",
  codexExecutable: "/nonexistent/sentinel-poison-codex",
  denoExecutable: "/nonexistent/sentinel-poison-deno",
  trustedPath: "/nonexistent/sentinel-poison-bin",
};

const POISON_SOURCE = "/nonexistent/sentinel-poison-source";
const POISON_SCRATCH = "/nonexistent/sentinel-poison-scratch";

const GIT_FAILED_TEXT = "git command failed";

Deno.test(
  "local refresh: durable refusal and a throwing gate stop before any Git or network",
  async () => {
    const clock = new FakeClock(T0);
    const state = await seededState();
    const gate = new DurableGitHubCooldownGate({ state, clock });
    const recorded = await gate.recordRateLimit(0, {
      kind: "primary",
      observedAt: T0,
      retryNotBefore: T0 + 60_000,
      observationId: "b".repeat(64),
      fallback: false,
    });
    assert.equal(recorded.ok, true);

    // Refused admission: the static failure is thrown before any fetch, and
    // the poison paths never produce a SHA.
    await assert.rejects(
      refreshDevelopment(POISON_SOURCE, POISON_OPTIONS, POISON_SCRATCH, gate),
      (error: unknown) =>
        error instanceof Error && error.message.includes(GIT_FAILED_TEXT),
    );

    // A gate restarted from the same durable state refuses identically.
    const restarted = new DurableGitHubCooldownGate({ state, clock });
    await assert.rejects(
      refreshDevelopment(
        POISON_SOURCE,
        POISON_OPTIONS,
        POISON_SCRATCH,
        restarted,
      ),
      (error: unknown) =>
        error instanceof Error && error.message.includes(GIT_FAILED_TEXT),
    );

    // A gate that faults on its FIRST operation proves no Git command ran
    // before admission: the synthetic fault is the only observed error.
    const throwing: GitHubCooldownGateV1 = {
      beforeRequest: () => Promise.reject(new Error("synthetic gate fault")),
      recordRateLimit: () => Promise.resolve(portOk(undefined)),
    };
    await assert.rejects(
      refreshDevelopment(
        POISON_SOURCE,
        POISON_OPTIONS,
        POISON_SCRATCH,
        throwing,
      ),
      /synthetic gate fault/,
    );
  },
);

Deno.test(
  "local login: 429 Retry-After is persisted exactly once before the static failure and survives a restart",
  async () => {
    const clock = new FakeClock(T0);
    const state = await seededState();
    const events: string[] = [];
    const inner = new DurableGitHubCooldownGate({ state, clock });
    const http: HttpTransportV1 = () => {
      events.push("http");
      return Promise.resolve({
        status: 429,
        headers: new Headers({ "retry-after": "3600" }),
        bodyText: "",
      });
    };
    await assert.rejects(
      readAuthenticatedLogin(
        "dummy-token",
        http,
        countingGate(inner, events),
        clock,
      ),
      /authenticated GitHub login is unavailable/,
    );
    // Admission first, exactly one response, exactly one persistence.
    assert.deepEqual(events, [
      "beforeRequest:0",
      "http",
      "recordRateLimit:0",
    ]);

    // The persisted durable refusal survives a restarted gate: zero HTTP.
    const restarted = new DurableGitHubCooldownGate({ state, clock });
    let restartedHttp = 0;
    await assert.rejects(
      readAuthenticatedLogin(
        "dummy-token",
        () => {
          restartedHttp++;
          return Promise.resolve({
            status: 200,
            headers: new Headers(),
            bodyText: JSON.stringify({ login: "owner" }),
          });
        },
        restarted,
        clock,
      ),
      /authenticated GitHub login is unavailable/,
    );
    assert.equal(restartedHttp, 0);
  },
);

Deno.test(
  "local login: 403 primary reset is persisted before the static failure and survives a restart",
  async () => {
    const clock = new FakeClock(T0);
    const state = await seededState();
    const resetSeconds = Math.floor((T0 + 90_000) / 1000);
    const events: string[] = [];
    const inner = new DurableGitHubCooldownGate({ state, clock });
    const http: HttpTransportV1 = () => {
      events.push("http");
      return Promise.resolve({
        status: 403,
        headers: new Headers({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetSeconds),
        }),
        bodyText: "",
      });
    };
    await assert.rejects(
      readAuthenticatedLogin(
        "dummy-token",
        http,
        countingGate(inner, events),
        clock,
      ),
      /authenticated GitHub login is unavailable/,
    );
    assert.deepEqual(events, [
      "beforeRequest:0",
      "http",
      "recordRateLimit:0",
    ]);
    const read = await state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (read.ok && read.value.status === "found") {
      assert.equal(read.value.snapshot.githubCooldowns.length, 1);
      assert.equal(
        read.value.snapshot.githubCooldowns[0]?.installationId,
        0,
      );
      assert.equal(
        read.value.snapshot.githubCooldowns[0]?.retryNotBefore,
        resetSeconds * 1000,
      );
    }

    const restarted = new DurableGitHubCooldownGate({ state, clock });
    let restartedHttp = 0;
    await assert.rejects(
      readAuthenticatedLogin(
        "dummy-token",
        () => {
          restartedHttp++;
          return Promise.resolve({
            status: 200,
            headers: new Headers(),
            bodyText: JSON.stringify({ login: "owner" }),
          });
        },
        restarted,
        clock,
      ),
      /authenticated GitHub login is unavailable/,
    );
    assert.equal(restartedHttp, 0);
  },
);

Deno.test(
  "local login: failed or throwing persistence is a static failure with no follow-on request; generic 403 invents no throttle",
  async () => {
    const clock = new FakeClock(T0);
    const state = await seededState();

    // Generic 403 without a confirmed limit: classifier returns null, so
    // nothing is persisted and no throttle is invented.
    const genericEvents: string[] = [];
    const genericGate = countingGate(
      new DurableGitHubCooldownGate({ state, clock }),
      genericEvents,
    );
    let genericHttp = 0;
    await assert.rejects(
      readAuthenticatedLogin(
        "dummy-token",
        () => {
          genericHttp++;
          genericEvents.push("http");
          return Promise.resolve({
            status: 403,
            headers: new Headers(),
            bodyText: "",
          });
        },
        genericGate,
        clock,
      ),
      /authenticated GitHub login is unavailable/,
    );
    assert.equal(genericHttp, 1);
    assert.deepEqual(genericEvents, ["beforeRequest:0", "http"]);

    // Failed (returned) and throwing persistence: the confirmed response is
    // persisted exactly once, then the static failure is thrown and no
    // follow-on request is attempted.
    for (const mode of ["return", "throw"] as const) {
      const events: string[] = [];
      let httpCalls = 0;
      const failingState = {
        readRepair: state.readRepair.bind(state),
        readRelease: state.readRelease.bind(state),
        writeRepair: mode === "return"
          ? () =>
            Promise.resolve(
              portError("unavailable", "synthetic state failure"),
            )
          : () => {
            throw new Error("synthetic write fault");
          },
      };
      const failingGate = countingGate(
        new DurableGitHubCooldownGate({ state: failingState, clock }),
        events,
      );
      await assert.rejects(
        readAuthenticatedLogin(
          "dummy-token",
          () => {
            httpCalls++;
            events.push("http");
            return Promise.resolve({
              status: 429,
              headers: new Headers({ "retry-after": "3600" }),
              bodyText: "",
            });
          },
          failingGate,
          clock,
        ),
        /authenticated GitHub login is unavailable/,
        mode,
      );
      assert.equal(httpCalls, 1, mode);
      assert.deepEqual(events, [
        "beforeRequest:0",
        "http",
        "recordRateLimit:0",
      ], mode);
    }
  },
);

// ---------------------------------------------------------------------------
// Private local model-result receipts: minimal explicit projection, unique
// 0600 files in 0700 directories and fixed reason classification. Real
// temporary directory only; no model, network or external call.
// ---------------------------------------------------------------------------

const DUMMY_ISSUE_BODY = "dummy-issue-body-secret-marker";
const DUMMY_EVIDENCE_REF = "dummy-evidence-ref-marker";
const DUMMY_CHANGED_PATH = "src/dummy-changed-path-marker.ts";
const DUMMY_RAW_ERROR = "dummy-raw-error-marker";
const DUMMY_INVOCATION = "dummy-invocation-marker";

function modelRequest(): ModelRunRequestV1 {
  return {
    taskId: asWorkItemId("issue-42"),
    repository: { ...REPO },
    base: SHA1,
    issue: { number: 42, title: "receipt", body: DUMMY_ISSUE_BODY },
    evidence: [{ kind: "replay_result", ref: DUMMY_EVIDENCE_REF }],
    model: "gpt-5.6-luna",
    reasoning: "max",
    maxDurationMs: 1_200_000,
    maxOutputChars: 400_000,
  };
}

/** Receipt fixture with explicit overrides; candidate defaults to present. */
function receipt(
  overrides: {
    outcome?: ModelRunReceiptV1["outcome"];
    error?: string | null;
    terminalOrigin?: "runtime" | "host-timeout";
    observedTerminalStatus?: "completed" | "interrupted" | "failed" | null;
    outputChars?: number;
    candidate?: boolean;
  } = {},
): PortResultV1<ModelRunReceiptV1> {
  return {
    ok: true,
    value: {
      invocationId: DUMMY_INVOCATION,
      outcome: overrides.outcome ?? "completed",
      actual: {
        evidenceKind: "request-runtime",
        provider: "sentinel-host",
        threadId: "thread-1",
        turnId: "turn-1",
        terminalOrigin: overrides.terminalOrigin ?? "runtime",
        observedTerminalStatus: overrides.observedTerminalStatus !== undefined
          ? overrides.observedTerminalStatus
          : "completed",
        observedModel: "gpt-5.6-luna",
        observedReasoning: "max",
        durationMs: 1_234,
        outputChars: overrides.outputChars ?? 100,
      },
      candidate: overrides.candidate === false ? null : {
        head: SHA3,
        checkpointSha: null,
        changedPaths: [DUMMY_CHANGED_PATH],
      },
      error: overrides.error ?? null,
    },
  };
}

Deno.test(
  "local model results: private projection is minimal, unique and mode 0600",
  async () => {
    const stateRoot = await Deno.makeTempDir({
      dir: ".",
      prefix: "sentinel-model-results-",
    });
    try {
      const request = modelRequest();
      const first = await writeLocalModelResult(
        stateRoot,
        request,
        receipt(),
        T0,
      );
      const second = await writeLocalModelResult(
        stateRoot,
        request,
        receipt(),
        T0 + 1,
      );
      assert.notEqual(first, second, "every result keeps a unique filename");
      assert.equal((await Deno.stat(first)).isFile, true);
      assert.equal((await Deno.stat(second)).isFile, true);

      const text = await Deno.readTextFile(first);
      const written = JSON.parse(text) as Record<string, unknown>;
      assert.equal(written.version, "v1");
      assert.equal(written.kind, "local_model_result");
      assert.equal(written.taskId, "issue-42");
      assert.equal(written.base, SHA1);
      assert.deepEqual(written.requested, {
        model: "gpt-5.6-luna",
        reasoning: "max",
        maxDurationMs: 1_200_000,
        maxOutputChars: 400_000,
      });
      assert.equal(written.observedAt, T0);
      assert.equal(written.reason, null);
      assert.deepEqual(written.result, {
        ok: true,
        outcome: "completed",
        actual: {
          provider: "sentinel-host",
          threadId: "thread-1",
          turnId: "turn-1",
          terminalOrigin: "runtime",
          observedTerminalStatus: "completed",
          observedModel: "gpt-5.6-luna",
          observedReasoning: "max",
          durationMs: 1_234,
          outputChars: 100,
        },
        candidate: { head: SHA3, changedPathCount: 1 },
      });

      // The explicit allow-list never serializes request/result payloads,
      // changed paths, raw errors, invocation identity or credentials.
      for (
        const marker of [
          DUMMY_ISSUE_BODY,
          DUMMY_EVIDENCE_REF,
          DUMMY_CHANGED_PATH,
          DUMMY_INVOCATION,
          "dummy-token",
          "checkpointSha",
        ]
      ) {
        assert.equal(
          text.includes(marker),
          false,
          `private projection never serializes ${marker}`,
        );
      }

      // 0600 file, 0700 directories.
      assert.equal((await Deno.stat(first)).mode! & 0o777, 0o600);
      assert.equal((await Deno.stat(second)).mode! & 0o777, 0o600);
      assert.equal(
        (await Deno.stat(`${stateRoot}/model-results`)).mode! & 0o777,
        0o700,
      );
      const key = await localCheckoutKey("issue-42");
      assert.equal(
        (await Deno.stat(`${stateRoot}/model-results/${key}`)).mode! & 0o777,
        0o700,
      );

      // output_limit wins when the actual output exceeds the request bound.
      const limited = await writeLocalModelResult(
        stateRoot,
        request,
        receipt({ outputChars: 400_001 }),
        T0,
      );
      assert.equal(
        (JSON.parse(await Deno.readTextFile(limited)) as Record<
          string,
          unknown
        >)
          .reason,
        "output_limit",
      );

      // The exact loop-stop marker keeps its own classification.
      const loop = await writeLocalModelResult(
        stateRoot,
        request,
        receipt({ outcome: "failed", error: LOOP_STOP_MARKER }),
        T0,
      );
      assert.equal(
        (JSON.parse(await Deno.readTextFile(loop)) as Record<string, unknown>)
          .reason,
        "failed_command_loop",
      );

      // A host timeout preserves the observed null terminal status and the
      // raw receipt error is never serialized.
      const timeout = await writeLocalModelResult(
        stateRoot,
        request,
        receipt({
          outcome: "failed",
          terminalOrigin: "host-timeout",
          observedTerminalStatus: null,
          error: DUMMY_RAW_ERROR,
          candidate: false,
        }),
        T0,
      );
      const timeoutText = await Deno.readTextFile(timeout);
      const timeoutWritten = JSON.parse(timeoutText) as Record<string, unknown>;
      assert.equal(timeoutWritten.reason, "host_timeout");
      assert.equal(
        ((timeoutWritten.result as Record<string, unknown>)
          .actual as Record<string, unknown>).observedTerminalStatus,
        null,
      );
      assert.equal(timeoutText.includes(DUMMY_RAW_ERROR), false);

      // Any other non-null receipt error is runtime_error.
      const failed = await writeLocalModelResult(
        stateRoot,
        request,
        receipt({ outcome: "failed", error: DUMMY_RAW_ERROR }),
        T0,
      );
      const failedText = await Deno.readTextFile(failed);
      assert.equal(
        (JSON.parse(failedText) as Record<string, unknown>).reason,
        "runtime_error",
      );
      assert.equal(failedText.includes(DUMMY_RAW_ERROR), false);

      // A port-level error keeps only its error kind, never its raw detail.
      const unavailable: PortResultV1<ModelRunReceiptV1> = {
        ok: false,
        error: { kind: "unavailable", detail: DUMMY_RAW_ERROR },
      };
      const portFailureText = await Deno.readTextFile(
        await writeLocalModelResult(stateRoot, request, unavailable, T0),
      );
      const portFailure = JSON.parse(portFailureText) as Record<
        string,
        unknown
      >;
      assert.deepEqual(portFailure.result, {
        ok: false,
        errorKind: "unavailable",
      });
      assert.equal(portFailure.reason, "runtime_error");
      assert.equal(portFailureText.includes(DUMMY_RAW_ERROR), false);
    } finally {
      await Deno.remove(stateRoot, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Local issue scope: only actual coding tasks are admitted. The concrete port
// instance, its unrelated methods and the class `this` binding stay intact.
// ---------------------------------------------------------------------------

/** FakeGithub with injectable per-method faults; reuses every other method. */
class FaultyIssueGithub extends FakeGithub {
  listFault: PortResultV1<never> | null = null;
  readFault: PortResultV1<never> | null = null;
  override listOpenIssues(): Promise<PortResultV1<GitHubIssueV1[]>> {
    if (this.listFault !== null) return Promise.resolve(this.listFault);
    return super.listOpenIssues();
  }
  override readIssue(
    issueNumber: number,
  ): Promise<PortResultV1<GitHubIssueV1 | null>> {
    if (this.readFault !== null) return Promise.resolve(this.readFault);
    return super.readIssue(issueNumber);
  }
}

Deno.test(
  "local issue scope: only exact bug or enhancement tasks without question",
  async () => {
    const github = new FakeGithub({
      openIssues: [
        { number: 1, labels: ["bug"] },
        { number: 2, labels: ["enhancement"] },
        { number: 3, labels: ["bug", "question"] },
        { number: 4 },
        { number: 5, labels: ["documentation"] },
        { number: 6, labels: ["bugfix"] },
        { number: 7, labels: ["Bug"] },
      ],
    });
    const scoped = scopeLocalRepairIssues(github);
    assert.equal(scoped, github, "the same concrete port instance is scoped");
    const listed = await scoped.listOpenIssues();
    assert.ok(listed.ok);
    assert.deepEqual(
      listed.ok ? listed.value.map((issue) => issue.number) : [],
      [1, 2],
    );
    assert.deepEqual(github.calls, ["listOpenIssues"]);
  },
);

Deno.test(
  "local issue scope: read re-check admits eligible issues and nulls the rest",
  async () => {
    const labels = ["enhancement"];
    const github = new FakeGithub({
      issues: [
        { number: 11, labels },
        { number: 12, labels: ["question"] },
      ],
    });
    const scoped = scopeLocalRepairIssues(github);
    const admitted = await scoped.readIssue(11);
    assert.ok(admitted.ok);
    assert.equal(admitted.value?.number, 11);
    assert.deepEqual(await scoped.readIssue(12), portOk(null));
    assert.deepEqual(await scoped.readIssue(99), portOk(null));

    // The loop re-reads before admission: an issue that becomes a question
    // after listing is refused instead of consuming budget.
    labels.splice(0, labels.length, "question");
    assert.deepEqual(await scoped.readIssue(11), portOk(null));
  },
);

Deno.test(
  "local issue scope: port errors pass through and other methods keep behavior",
  async () => {
    const github = new FaultyIssueGithub();
    const listFault = portError("rate_limited", "list fault");
    const readFault = portError("unavailable", "read fault");
    github.listFault = listFault;
    github.readFault = readFault;
    const scoped = scopeLocalRepairIssues(github);
    assert.equal(await scoped.listOpenIssues(), listFault);
    assert.equal(await scoped.readIssue(1), readFault);

    const other = new FakeGithub();
    const scopedOther = scopeLocalRepairIssues(other);
    const ref = await scopedOther.readRef("refs/heads/development");
    assert.ok(ref.ok, "an unrelated class method still works");
    assert.equal(ref.ok ? ref.value?.sha : null, SHA1);
    assert.deepEqual(other.calls, ["readRef:refs/heads/development"]);
  },
);
