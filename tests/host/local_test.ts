// Narrow local-host tests: fixed config parsing, isolated Codex config text
// and exclusive-lock behavior. No network, model, GitHub or real state root.
import assert from "node:assert/strict";

import {
  composeLocalGitHub,
  createLocalCandidateLoader,
  createLocalRepositoryConfig,
  ensureBareStateRepository,
  ensureTaskCheckout,
  finalizeLocalModelResult,
  localCheckoutKey,
  LocalCheckoutModelPort,
  type LocalModelInputV1,
  type LocalRepairHostOptionsV1,
  LocalSessionTracker,
  prepareReviewCheckout,
  prepareSourceRepository,
  readAuthenticatedLogin,
  refreshDevelopment,
  renderLocalCodexConfig,
  scopeLocalRepairIssues,
  tryAcquireLocalHostLock,
  writeLocalModelResult,
} from "../../src/host/local.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
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
import { REVIEW_MODEL } from "../../src/github/review-journal.ts";
import type { ModelRouteV1 } from "../../src/host/model-route.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { LOOP_STOP_MARKER } from "../../src/repair/model-port.ts";
import { FakeClock, FakeGithub, MemoryState } from "../repair/helpers.ts";
import { REPO, SHA1, SHA3, T0 } from "../state/helpers.ts";
import { gitRun, makeRemoteCtx, testGitEnv } from "../state/helpers.ts";

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
  assert.equal(config.liveStartLimits?.perHour, 120);
  assert.equal(config.liveStartLimits?.perSevenDays, null);
  // 30 minutes: a larger target's session must be able to finish. The bound
  // matches this same template's own `test_ci` command allowance.
  assert.equal(config.sessionBound?.maxDurationMs, 1_800_000);
  assert.equal(config.sessionBound?.maxOutputChars, 4_000_000);
  assert.equal(config.retention, null);
  assert.equal(config.stabilityPolicy, null);
  assert.equal(config.build.projectId, null);
  assert.equal(config.build.acceptance, null);
  assert.equal(config.secretRef, "secret://host/injected/sentinel-local-owner");
  assert.ok(config.protectedPaths.includes("src/host/local.ts"));
  assert.ok(config.protectedPaths.includes("src/contracts/local-release.ts"));
  assert.ok(config.protectedPaths.includes("src/host/local-release.ts"));
  assert.ok(config.protectedPaths.includes("src/host/local-supervisor.ts"));
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

/** Expected model shell PATH on this host: CommandLineTools Git when present. */
function expectedShellPath(fallback: string): string {
  const bin = "/Library/Developer/CommandLineTools/usr/bin";
  try {
    Deno.statSync(`${bin}/git`);
  } catch {
    return fallback;
  }
  return `${bin}:${fallback}`;
}

Deno.test("local Codex config isolates the model client", () => {
  const text = renderLocalCodexConfig({
    profile: "sentinel-local",
    tokenFile: "/private/clients/key/model.token",
    shellHome: "/private/checkouts/key",
    shellPath: "/usr/bin:/bin",
    shellTmpDir: "/private/tmp/key",
    shellDenoDir: "/private/deno/key",
    codexExecutable: "/home/.codex/bin/codex",
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
  assert.match(text, /^"\/home\/\.codex\/bin\/codex" = "read"$/m);
  assert.match(text, /^"\/home\/\.codex\/packages\/standalone" = "read"$/m);
  assert.match(text, /^"\/bin\/deno" = "read"$/m);
  assert.match(
    text,
    /^"\/Library\/Developer\/CommandLineTools\/usr\/share\/git-core" = "read"$/m,
  );
  assert.match(
    text,
    /^"\/Library\/Developer\/CommandLineTools\/usr\/bin" = "read"$/m,
  );
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
  assert.ok(text.includes(`PATH = "${expectedShellPath("/usr/bin:/bin")}"`));
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
    codexExecutable: "/home/.codex/bin/codex",
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
    /^"\/Library\/Developer\/CommandLineTools\/usr\/share\/git-core" = "read"$/m,
  );
  assert.match(
    text,
    /^"\/Library\/Developer\/CommandLineTools\/usr\/bin" = "read"$/m,
  );
  assert.match(
    text,
    /^\[permissions\.sentinel-review\.filesystem\.":workspace_roots"\]$/m,
  );
  assert.match(text, /^"\." = "read"$/m);
  assert.match(text, /^\[permissions\.sentinel-review\.network\]$/m);
  assert.match(text, /^enabled = false$/m);
  assert.ok(text.includes(`PATH = "${expectedShellPath("/usr/bin:/bin")}"`));
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
const DUMMY_PROVIDER = "dummy-provider-marker";
const DUMMY_THREAD = "dummy-thread-marker";
const DUMMY_TURN = "dummy-turn-marker";
const DUMMY_MODEL = "dummy-observed-model-marker";
const DUMMY_REASONING = "dummy-observed-reasoning-marker";

/** Capture console.log so advisory emission can be asserted and restored. */
function captureConsoleLog(): { lines: string[]; restore: () => void } {
  const original = console.log;
  const lines: string[] = [];
  console.log = ((...args: unknown[]) => {
    lines.push(
      args.map((arg) => typeof arg === "string" ? arg : String(arg)).join(" "),
    );
  }) as typeof console.log;
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

function modelRequest(): ModelRunRequestV1 {
  return {
    taskId: asWorkItemId("issue-42"),
    repository: { ...REPO },
    base: SHA1,
    issue: { number: 42, title: "receipt", body: DUMMY_ISSUE_BODY },
    evidence: [{ kind: "replay_result", ref: DUMMY_EVIDENCE_REF }],
    model: "gpt-reserve",
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
    provider?: string;
    threadId?: string;
    turnId?: string;
    observedModel?: string;
    observedReasoning?: string;
    durationMs?: number;
  } = {},
): PortResultV1<ModelRunReceiptV1> {
  return {
    ok: true,
    value: {
      invocationId: DUMMY_INVOCATION,
      outcome: overrides.outcome ?? "completed",
      actual: {
        evidenceKind: "request-runtime",
        provider: overrides.provider ?? "sentinel-host",
        threadId: overrides.threadId ?? "thread-1",
        turnId: overrides.turnId ?? "turn-1",
        terminalOrigin: overrides.terminalOrigin ?? "runtime",
        observedTerminalStatus: overrides.observedTerminalStatus !== undefined
          ? overrides.observedTerminalStatus
          : "completed",
        observedModel: overrides.observedModel ?? "gpt-reserve",
        observedReasoning: overrides.observedReasoning ?? "max",
        durationMs: overrides.durationMs ?? 1_234,
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
    const captured = captureConsoleLog();
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
        model: "gpt-reserve",
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
          observedModel: "gpt-reserve",
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
      captured.restore();
      await Deno.remove(stateRoot, { recursive: true });
    }
  },
);

const SAFE_DIAGNOSTIC_KEYS = [
  "base",
  "candidatePresent",
  "durationMs",
  "errorKind",
  "kind",
  "observedAt",
  "observedTerminalStatus",
  "outcome",
  "outputChars",
  "reason",
  "reasonCode",
  "taskKey",
  "terminalOrigin",
  "version",
];

Deno.test(
  "local model results: the advisory summary is strict and never leaks private fields",
  async () => {
    const stateRoot = await Deno.makeTempDir({
      dir: ".",
      prefix: "sentinel-model-diagnostics-",
    });
    const captured = captureConsoleLog();
    try {
      const request = modelRequest();
      const taskKey = await localCheckoutKey(request.taskId);
      const summary = (): Record<string, unknown> => {
        const line = captured.lines[captured.lines.length - 1];
        assert.ok(line !== undefined, "expected one advisory summary line");
        const parsed = JSON.parse(line as string) as Record<string, unknown>;
        assert.deepEqual(Object.keys(parsed).sort(), SAFE_DIAGNOSTIC_KEYS);
        return parsed;
      };

      // A receipt failure saves the minimal private report and emits exactly one
      // advisory line carrying only the safe allow-list fields.
      const failedPath = await writeLocalModelResult(
        stateRoot,
        request,
        receipt({ outcome: "failed", error: DUMMY_RAW_ERROR }),
        T0,
      );
      assert.equal(captured.lines.length, 1);
      assert.deepEqual(summary(), {
        version: "v1",
        kind: "sentinel_model_diagnostic",
        taskKey,
        base: SHA1,
        observedAt: T0,
        outcome: "failed",
        reason: "runtime_error",
        errorKind: null,
        terminalOrigin: "runtime",
        observedTerminalStatus: "completed",
        durationMs: 1_234,
        outputChars: 100,
        candidatePresent: true,
        reasonCode: null,
      });
      const failedPrivate = await Deno.readTextFile(failedPath);
      assert.equal(
        (JSON.parse(failedPrivate) as Record<string, unknown>).kind,
        "local_model_result",
      );
      assert.equal(failedPrivate.includes(DUMMY_RAW_ERROR), false);
      assert.equal((await Deno.stat(failedPath)).mode! & 0o777, 0o600);

      // The output bound and the exact loop marker keep their classifications.
      await writeLocalModelResult(
        stateRoot,
        request,
        receipt({ outcome: "failed", outputChars: 400_001 }),
        T0,
      );
      assert.equal(summary().reason, "output_limit");
      assert.equal(summary().outcome, "failed");
      await writeLocalModelResult(
        stateRoot,
        request,
        receipt({ outcome: "failed", error: LOOP_STOP_MARKER }),
        T0,
      );
      assert.equal(summary().reason, "failed_command_loop");

      // A host timeout preserves the observed null terminal status and the
      // absence of a candidate.
      await writeLocalModelResult(
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
      assert.deepEqual(summary(), {
        version: "v1",
        kind: "sentinel_model_diagnostic",
        taskKey,
        base: SHA1,
        observedAt: T0,
        outcome: "failed",
        reason: "host_timeout",
        errorKind: null,
        terminalOrigin: "host-timeout",
        observedTerminalStatus: null,
        durationMs: 1_234,
        outputChars: 100,
        candidatePresent: false,
        reasonCode: null,
      });

      // Arbitrary private receipt content (provider, thread/turn identity,
      // observed model/reasoning) never reaches the advisory line, while the
      // private report keeps that identity and still omits the raw error.
      const maliciousPath = await writeLocalModelResult(
        stateRoot,
        request,
        receipt({
          provider: DUMMY_PROVIDER,
          threadId: DUMMY_THREAD,
          turnId: DUMMY_TURN,
          observedModel: DUMMY_MODEL,
          observedReasoning: DUMMY_REASONING,
          error: DUMMY_RAW_ERROR,
        }),
        T0,
      );
      const emittedText = JSON.stringify(summary());
      for (
        const marker of [
          DUMMY_PROVIDER,
          DUMMY_THREAD,
          DUMMY_TURN,
          DUMMY_MODEL,
          DUMMY_REASONING,
          DUMMY_RAW_ERROR,
          DUMMY_ISSUE_BODY,
          DUMMY_EVIDENCE_REF,
          DUMMY_CHANGED_PATH,
          DUMMY_INVOCATION,
          SHA3,
          "checkpointSha",
        ]
      ) {
        assert.equal(
          emittedText.includes(marker),
          false,
          `advisory summary never carries ${marker}`,
        );
      }
      assert.equal(summary().candidatePresent, true);
      const maliciousPrivate = await Deno.readTextFile(maliciousPath);
      for (
        const marker of [
          DUMMY_PROVIDER,
          DUMMY_THREAD,
          DUMMY_TURN,
          DUMMY_MODEL,
          DUMMY_REASONING,
        ]
      ) {
        assert.equal(
          maliciousPrivate.includes(marker),
          true,
          `private report keeps ${marker}`,
        );
      }
      assert.equal(
        maliciousPrivate.includes(DUMMY_RAW_ERROR),
        false,
        "the private report never keeps the raw error",
      );

      // A typed port error keeps only its kind, with a null terminal and
      // counters, and its private report is still saved.
      const portFailure: PortResultV1<ModelRunReceiptV1> = {
        ok: false,
        error: { kind: "unavailable", detail: DUMMY_RAW_ERROR },
      };
      const portPath = await writeLocalModelResult(
        stateRoot,
        request,
        portFailure,
        T0,
      );
      assert.deepEqual(summary(), {
        version: "v1",
        kind: "sentinel_model_diagnostic",
        taskKey,
        base: SHA1,
        observedAt: T0,
        outcome: "port_error",
        reason: "runtime_error",
        errorKind: "unavailable",
        terminalOrigin: null,
        observedTerminalStatus: null,
        durationMs: null,
        outputChars: null,
        candidatePresent: false,
        // DUMMY_RAW_ERROR is not one of our own static strings, so the raw text
        // must map to null rather than becoming a code.
        reasonCode: null,
      });
      assert.equal(
        (await Deno.readTextFile(portPath)).includes(DUMMY_RAW_ERROR),
        false,
        "the private port-error report never keeps the raw error",
      );

      // Malformed counters or enums suppress only the advisory summary; the
      // private 0600 report is still saved unchanged.
      const before = captured.lines.length;
      for (
        const mutate of [
          (actual: Record<string, unknown>) => {
            actual.durationMs = -1;
          },
          (actual: Record<string, unknown>) => {
            actual.outputChars = 1.5;
          },
          (actual: Record<string, unknown>) => {
            actual.terminalOrigin = "made-up";
          },
          (actual: Record<string, unknown>) => {
            actual.observedTerminalStatus = "unknown";
          },
        ]
      ) {
        const broken = receipt();
        assert.equal(broken.ok, true);
        if (!broken.ok) throw new Error("unreachable");
        mutate(broken.value.actual as unknown as Record<string, unknown>);
        const brokenPath = await writeLocalModelResult(
          stateRoot,
          request,
          broken,
          T0,
        );
        assert.equal(
          captured.lines.length,
          before,
          "an invalid projection emits no summary",
        );
        assert.equal((await Deno.stat(brokenPath)).isFile, true);
        assert.equal((await Deno.stat(brokenPath)).mode! & 0o777, 0o600);
        assert.equal(
          (JSON.parse(await Deno.readTextFile(brokenPath)) as Record<
            string,
            unknown
          >).kind,
          "local_model_result",
        );
      }
    } finally {
      captured.restore();
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

// Exact literals, deliberately not imported from the host module: the contract
// is these standalone first lines, so a typo in either copy must fail here.
const LOCAL_REPAIR_MARKER = "<!-- sentinel:repair -->";
const LOCAL_SKIP_MARKER = "<!-- sentinel:skip -->";

Deno.test(
  "local issue scope: every open issue is admitted unless it opts out",
  async () => {
    const github = new FakeGithub({
      openIssues: [
        { number: 1, body: `${LOCAL_REPAIR_MARKER}\n` },
        { number: 2, body: LOCAL_REPAIR_MARKER },
        { number: 3, body: "unmarked prose" },
        { number: 4, body: "" },
        { number: 5, body: "unmarked but labelled", labels: ["bug"] },
        { number: 6, body: `${LOCAL_SKIP_MARKER}\nskip me` },
        { number: 7, body: LOCAL_SKIP_MARKER },
        { number: 8, body: `${LOCAL_SKIP_MARKER}\r\nskip me` },
        { number: 9, body: `${LOCAL_SKIP_MARKER} extra\nnot a skip` },
        { number: 10, body: ` ${LOCAL_SKIP_MARKER}\nnot a skip` },
        { number: 11, body: `intro\n${LOCAL_SKIP_MARKER}\nnot a skip` },
        { number: 12, body: "skip by label", labels: ["sentinel:skip"] },
        {
          number: 13,
          body: "skip by mixed-case label",
          labels: ["Sentinel:Skip"],
        },
        {
          number: 14,
          body: `${LOCAL_SKIP_MARKER}\nskip by marker and label`,
          labels: ["sentinel:skip"],
        },
      ],
    });
    const scoped = scopeLocalRepairIssues(github);
    assert.equal(scoped, github, "the same concrete port instance is scoped");
    const listed = await scoped.listOpenIssues();
    assert.ok(listed.ok);
    assert.deepEqual(
      listed.ok ? listed.value.map((issue) => issue.number) : [],
      [1, 2, 3, 4, 5, 9, 10, 11],
    );
    assert.deepEqual(github.calls, ["listOpenIssues"]);
  },
);

Deno.test(
  "local issue scope: read re-check admits by default and nulls opt-outs",
  async () => {
    const plain: Partial<GitHubIssueV1> = {
      number: 11,
      body: "ordinary issue body",
    };
    const github = new FakeGithub({
      issues: [
        plain,
        { number: 12, body: "skipped upstream\n" },
      ],
    });
    const scoped = scopeLocalRepairIssues(github);
    const admitted = await scoped.readIssue(11);
    assert.ok(admitted.ok);
    assert.equal(admitted.value?.number, 11);
    assert.deepEqual(await scoped.readIssue(99), portOk(null));

    // The loop re-reads the real source before admission: adding the opt-out to
    // the FakeGithub record revokes eligibility instead of consuming budget.
    plain.body = `${LOCAL_SKIP_MARKER}\nnow skipped`;
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

/**
 * Real temporary Git fixture for the checkout base tests: a source repository
 * with two linear development commits plus an unrelated (divergent) root commit
 * and a candidate commit, and a clean private state root. Credential-free local
 * commands only; testGitEnv pins Git configuration and identity.
 */
async function checkoutFixture() {
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-checkout-",
  });
  try {
    const env = testGitEnv(`${root}/git-home`);
    await Deno.mkdir(`${root}/git-home`, { recursive: true });
    await Deno.mkdir(`${root}/scratch`, { recursive: true });
    const source = `${root}/source`;
    await Deno.mkdir(source, { recursive: true });
    const git = (cwd: string, args: string[]) => gitRun(cwd, args, env);
    const must = async (cwd: string, args: string[]) => {
      const result = await git(cwd, args);
      assert.ok(result.ok, `${args.join(" ")}: ${result.stderr}`);
      return result.stdout.trim();
    };
    await must(source, ["init", "-q"]);
    await Deno.writeTextFile(`${source}/file.txt`, "one\n");
    await must(source, ["add", "file.txt"]);
    await must(source, ["commit", "-qm", "one"]);
    const oldBase = await must(source, ["rev-parse", "HEAD"]);
    const branch = await must(source, ["rev-parse", "--abbrev-ref", "HEAD"]);
    await Deno.writeTextFile(`${source}/file.txt`, "one\ntwo\n");
    await must(source, ["commit", "-qam", "two"]);
    const newBase = await must(source, ["rev-parse", "HEAD"]);
    await must(source, ["checkout", "-q", "-b", "candidate", oldBase]);
    await Deno.writeTextFile(`${source}/file.txt`, "candidate\n");
    await must(source, ["commit", "-qam", "candidate"]);
    const candidate = await must(source, ["rev-parse", "HEAD"]);
    await must(source, ["checkout", "-q", "--orphan", "divergent"]);
    await must(source, ["rm", "-q", "-rf", "."]);
    await Deno.writeTextFile(`${source}/other.txt`, "divergent\n");
    await must(source, ["add", "other.txt"]);
    await must(source, ["commit", "-qm", "divergent"]);
    const divergent = await must(source, ["rev-parse", "HEAD"]);
    await must(source, ["checkout", "-q", branch]);
    return {
      root,
      env,
      git,
      must,
      source,
      oldBase,
      newBase,
      candidate,
      divergent,
      key: await localCheckoutKey("issue-1"),
      stateRoot: `${root}/state`,
      scratch: `${root}/scratch`,
      trustedPath: env.PATH ?? "/usr/bin:/bin",
    };
  } catch (error) {
    await Deno.remove(root, { recursive: true }).catch(() => {});
    throw error;
  }
}

type CheckoutFixture = Awaited<ReturnType<typeof checkoutFixture>>;

/** Request the checkout for the fixture key at the given exact base. */
function requestCheckout(fixture: CheckoutFixture, base: string) {
  return ensureTaskCheckout({
    taskId: "issue-1",
    base: base as GitSha,
    key: fixture.key,
    stateRoot: fixture.stateRoot,
    sourcePath: fixture.source,
    scratch: fixture.scratch,
    trustedPath: fixture.trustedPath,
  });
}

/** Exact revision of `rev` inside the fixture checkout. */
async function checkoutRev(
  fixture: CheckoutFixture,
  rev: string,
): Promise<string> {
  return await fixture.must(
    `${fixture.stateRoot}/checkouts/${fixture.key}`,
    ["rev-parse", rev],
  );
}

Deno.test(
  "local checkout base: clean base movement advances the exact mapping",
  async () => {
    const fixture = await checkoutFixture();
    try {
      const checkout = `${fixture.stateRoot}/checkouts/${fixture.key}`;
      const mappingPath = `${checkout}.json`;
      const first = await requestCheckout(fixture, fixture.oldBase);
      assert.ok(first.ok);
      assert.equal(first.ok ? first.commitBase : null, fixture.oldBase);
      // An extra ref proves the SAME object store/history is reused.
      await fixture.must(checkout, [
        "update-ref",
        "refs/sentinel/probe",
        fixture.oldBase,
      ]);

      const second = await requestCheckout(fixture, fixture.newBase);
      assert.ok(second.ok);
      assert.equal(second.ok ? second.commitBase : null, fixture.newBase);
      assert.equal(await checkoutRev(fixture, "HEAD"), fixture.newBase);
      assert.equal(
        await checkoutRev(fixture, "refs/sentinel/probe"),
        fixture.oldBase,
      );
      const status = await fixture.git(checkout, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]);
      assert.ok(status.ok, status.stderr);
      assert.equal(status.stdout.trim(), "", "checkout stays clean");

      const mapping = JSON.parse(await Deno.readTextFile(mappingPath)) as {
        version: string;
        kind: string;
        taskId: string;
        base: string;
        key: string;
      };
      assert.equal(mapping.base, fixture.newBase);
      assert.equal(mapping.taskId, "issue-1");
      assert.equal(mapping.version, "v1");
      assert.equal(mapping.kind, "local_checkout");
      assert.equal(mapping.key, fixture.key);
    } finally {
      await Deno.remove(fixture.root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "local checkout base: a fresh correction checkout starts at the rejected head",
  async () => {
    const fixture = await checkoutFixture();
    try {
      const prepared = await requestCheckout(fixture, fixture.candidate);
      assert.ok(prepared.ok);
      assert.equal(
        prepared.ok ? prepared.commitBase : null,
        fixture.candidate,
        "the correction checkout is rooted at the rejected candidate",
      );
      assert.equal(await checkoutRev(fixture, "HEAD"), fixture.candidate);
      const status = await fixture.git(
        `${fixture.stateRoot}/checkouts/${fixture.key}`,
        ["status", "--porcelain", "--untracked-files=all"],
      );
      assert.ok(status.ok, status.stderr);
      assert.equal(
        status.stdout.trim(),
        "",
        "fresh correction checkout is clean",
      );
    } finally {
      await Deno.remove(fixture.root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "local checkout base: crash after movement before mapping publication recovers",
  async () => {
    const fixture = await checkoutFixture();
    try {
      const checkout = `${fixture.stateRoot}/checkouts/${fixture.key}`;
      const mappingPath = `${checkout}.json`;
      const first = await requestCheckout(fixture, fixture.oldBase);
      assert.ok(first.ok);
      await fixture.must(checkout, [
        "update-ref",
        "refs/sentinel/probe",
        fixture.oldBase,
      ]);
      // Simulate the crash: the clean detached movement happened, the mapping
      // publication did not.
      await fixture.must(checkout, [
        "checkout",
        "-q",
        "--detach",
        fixture.newBase,
      ]);
      const stale = JSON.parse(await Deno.readTextFile(mappingPath)) as {
        base: string;
      };
      assert.equal(stale.base, fixture.oldBase);

      const recovered = await requestCheckout(fixture, fixture.newBase);
      assert.ok(recovered.ok);
      assert.equal(recovered.ok ? recovered.commitBase : null, fixture.newBase);
      assert.equal(await checkoutRev(fixture, "HEAD"), fixture.newBase);
      assert.equal(
        await checkoutRev(fixture, "refs/sentinel/probe"),
        fixture.oldBase,
      );
      const mapping = JSON.parse(await Deno.readTextFile(mappingPath)) as {
        base: string;
      };
      assert.equal(mapping.base, fixture.newBase);
    } finally {
      await Deno.remove(fixture.root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "local checkout base: untracked and dirty work refuses and is preserved",
  async () => {
    const fixture = await checkoutFixture();
    try {
      const checkout = `${fixture.stateRoot}/checkouts/${fixture.key}`;
      const mappingPath = `${checkout}.json`;
      const first = await requestCheckout(fixture, fixture.oldBase);
      assert.ok(first.ok);

      await Deno.writeTextFile(`${checkout}/untracked.txt`, "work\n");
      const untracked = await requestCheckout(fixture, fixture.newBase);
      assert.equal(untracked.ok, false, "untracked work refuses the movement");
      assert.equal(await checkoutRev(fixture, "HEAD"), fixture.oldBase);
      assert.equal(
        (JSON.parse(await Deno.readTextFile(mappingPath)) as { base: string })
          .base,
        fixture.oldBase,
      );
      assert.equal(
        await Deno.readTextFile(`${checkout}/untracked.txt`),
        "work\n",
      );

      await Deno.remove(`${checkout}/untracked.txt`);
      await Deno.writeTextFile(`${checkout}/file.txt`, "modified\n");
      const dirty = await requestCheckout(fixture, fixture.newBase);
      assert.equal(dirty.ok, false, "dirty work refuses the movement");
      assert.equal(await checkoutRev(fixture, "HEAD"), fixture.oldBase);
      assert.equal(
        (JSON.parse(await Deno.readTextFile(mappingPath)) as { base: string })
          .base,
        fixture.oldBase,
      );
      assert.equal(
        await Deno.readTextFile(`${checkout}/file.txt`),
        "modified\n",
      );
    } finally {
      await Deno.remove(fixture.root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "local review checkout: exact detached independent checkout with verified reuse",
  async () => {
    const fixture = await checkoutFixture();
    try {
      const reviewCheckout = `${fixture.stateRoot}/review-checkout`;
      await Deno.mkdir(reviewCheckout, { recursive: true });
      const first = await prepareReviewCheckout({
        sourcePath: fixture.source,
        reviewCheckout,
        base: fixture.oldBase as GitSha,
        head: fixture.candidate as GitSha,
        trustedPath: fixture.trustedPath,
        scratch: fixture.scratch,
      });
      assert.ok(first.ok, first.ok ? "" : first.error.detail);

      const dotGit = await Deno.lstat(`${reviewCheckout}/.git`);
      assert.ok(
        dotGit.isDirectory && !dotGit.isSymlink,
        "the checkout owns a real local .git directory",
      );
      assert.equal(
        await localTestPathExists(
          `${reviewCheckout}/.git/objects/info/alternates`,
        ),
        false,
        "the independent checkout has no alternates",
      );
      assert.equal(
        await fixture.must(reviewCheckout, ["rev-parse", "HEAD"]),
        fixture.candidate,
        "exact candidate head",
      );
      assert.equal(
        await fixture.must(reviewCheckout, [
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ]),
        "HEAD",
        "detached HEAD",
      );
      await fixture.must(reviewCheckout, [
        "cat-file",
        "-e",
        `${fixture.oldBase}^{commit}`,
      ]);
      const status = await fixture.git(reviewCheckout, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]);
      assert.ok(status.ok, status.stderr);
      assert.equal(
        status.stdout.trim(),
        "",
        "clean tracked and untracked state",
      );
      const remotes = await fixture.git(reviewCheckout, ["remote"]);
      assert.equal(remotes.stdout.trim(), "", "no transport authority remains");
      const config = await fixture.git(reviewCheckout, [
        "config",
        "--local",
        "--list",
      ]);
      assert.equal(config.stdout.includes("remote."), false);
      assert.equal(config.stdout.includes("credential"), false);
      assert.equal(config.stdout.includes("http."), false);

      // Verified reuse moves the SAME independent checkout to a new exact
      // head without recloning, resetting or cleaning anything.
      const second = await prepareReviewCheckout({
        sourcePath: fixture.source,
        reviewCheckout,
        base: fixture.oldBase as GitSha,
        head: fixture.newBase as GitSha,
        trustedPath: fixture.trustedPath,
        scratch: fixture.scratch,
      });
      assert.ok(second.ok, second.ok ? "" : second.error.detail);
      assert.equal(
        await fixture.must(reviewCheckout, ["rev-parse", "HEAD"]),
        fixture.newBase,
      );
      assert.equal(
        await fixture.must(reviewCheckout, [
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ]),
        "HEAD",
      );
    } finally {
      await Deno.remove(fixture.root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "local review checkout: dirty, hostile and unowned directories are refused and preserved",
  async (t) => {
    const fixture = await checkoutFixture();
    try {
      const prepare = (reviewCheckout: string) =>
        prepareReviewCheckout({
          sourcePath: fixture.source,
          reviewCheckout,
          base: fixture.oldBase as GitSha,
          head: fixture.candidate as GitSha,
          trustedPath: fixture.trustedPath,
          scratch: fixture.scratch,
        });

      await t.step("unowned nonempty directory is preserved", async () => {
        const unowned = `${fixture.root}/unowned`;
        await Deno.mkdir(unowned, { recursive: true });
        await Deno.writeTextFile(`${unowned}/keep.txt`, "precious\n");
        const refused = await prepare(unowned);
        assert.equal(refused.ok, false);
        if (refused.ok) return;
        assert.equal(refused.error.kind, "unavailable");
        assert.equal(
          await Deno.readTextFile(`${unowned}/keep.txt`),
          "precious\n",
        );
      });

      await t.step("untracked work refuses reuse without erasure", async () => {
        const checkout = `${fixture.stateRoot}/review-dirty`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        await Deno.writeTextFile(`${checkout}/untracked.txt`, "work\n");
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        assert.equal(
          await Deno.readTextFile(`${checkout}/untracked.txt`),
          "work\n",
        );
        assert.equal(
          await fixture.must(checkout, ["rev-parse", "HEAD"]),
          fixture.candidate,
        );
      });

      await t.step("alternates refuse reuse without erasure", async () => {
        const checkout = `${fixture.stateRoot}/review-alt`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        await Deno.mkdir(`${checkout}/.git/objects/info`, { recursive: true });
        await Deno.writeTextFile(
          `${checkout}/.git/objects/info/alternates`,
          `${fixture.source}/.git/objects\n`,
        );
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        assert.equal(
          await localTestPathExists(
            `${checkout}/.git/objects/info/alternates`,
          ),
          true,
          "the alternates file is preserved, never silently removed",
        );
      });

      await t.step("credential config refuses reuse", async () => {
        const checkout = `${fixture.stateRoot}/review-config`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        await fixture.must(checkout, [
          "config",
          "--local",
          "credential.helper",
          "store",
        ]);
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        const config = await fixture.git(checkout, [
          "config",
          "--local",
          "--get",
          "credential.helper",
        ]);
        assert.equal(
          config.stdout.trim(),
          "store",
          "the unexpected config is preserved, never rewritten",
        );
      });

      await t.step(
        "unsafe local config keys refuse reuse without execution",
        async () => {
          const checkout = `${fixture.stateRoot}/review-unsafe-config`;
          const first = await prepare(checkout);
          assert.ok(first.ok, first.ok ? "" : first.error.detail);
          const sentinel = `${fixture.root}/executed-helper`;
          await fixture.must(checkout, [
            "config",
            "--local",
            "core.fsmonitor",
            sentinel,
          ]);
          await fixture.must(checkout, [
            "config",
            "--local",
            "filter.evil.smudge",
            `cat ${sentinel}`,
          ]);
          await fixture.must(checkout, [
            "config",
            "--local",
            "filter.evil.required",
            "true",
          ]);
          await fixture.must(checkout, [
            "config",
            "--local",
            "core.worktree",
            fixture.root,
          ]);
          const refused = await prepare(checkout);
          assert.equal(refused.ok, false);
          assert.equal(
            await localTestPathExists(sentinel),
            false,
            "no configured hook, fsmonitor or filter helper was executed",
          );
          const fsmonitor = await fixture.git(checkout, [
            "config",
            "--local",
            "--get",
            "core.fsmonitor",
          ]);
          assert.equal(
            fsmonitor.stdout.trim(),
            sentinel,
            "the unsafe config is preserved, never rewritten",
          );
          const worktree = await fixture.git(checkout, [
            "config",
            "--local",
            "--get",
            "core.worktree",
          ]);
          assert.equal(worktree.stdout.trim(), fixture.root);
        },
      );

      await t.step("commondir redirection refuses reuse", async () => {
        const checkout = `${fixture.stateRoot}/review-commondir`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        const redirected = `${fixture.root}/redirected-git`;
        await Deno.mkdir(redirected, { recursive: true });
        await Deno.writeTextFile(
          `${checkout}/.git/commondir`,
          `${redirected}\n`,
        );
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        assert.equal(
          await Deno.readTextFile(`${checkout}/.git/commondir`),
          `${redirected}\n`,
          "the commondir redirection is preserved, never removed",
        );
      });

      await t.step("symlinked critical metadata refuses reuse", async () => {
        const checkout = `${fixture.stateRoot}/review-symlink-config`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        const config = `${checkout}/.git/config`;
        const realConfig = `${checkout}/.git/config.real`;
        await Deno.copyFile(config, realConfig);
        await Deno.remove(config);
        await localTestLink(["-s", realConfig, config]);
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        const info = await Deno.lstat(config);
        assert.ok(
          info.isSymlink,
          "the symlinked critical metadata is preserved, never followed",
        );
        assert.equal(
          await Deno.readTextFile(config),
          await Deno.readTextFile(realConfig),
        );
      });

      await t.step("grafts redirection refuses reuse", async () => {
        const checkout = `${fixture.stateRoot}/review-grafts`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        const grafts = `${checkout}/.git/info/grafts`;
        await Deno.writeTextFile(grafts, `${fixture.oldBase}\n`);
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        assert.equal(
          await Deno.readTextFile(grafts),
          `${fixture.oldBase}\n`,
          "the grafts file is preserved, never removed",
        );
      });

      await t.step("loose replacement refs refuse reuse", async () => {
        const checkout = `${fixture.stateRoot}/review-replace-loose`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        const replacement = `refs/replace/${fixture.candidate}`;
        await fixture.must(checkout, [
          "update-ref",
          replacement,
          fixture.oldBase,
        ]);
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        assert.equal(
          await fixture.must(checkout, ["rev-parse", replacement]),
          fixture.oldBase,
          "the loose replacement ref is preserved, never rewritten",
        );
        assert.equal(
          await localTestPathExists(`${checkout}/.git/${replacement}`),
          true,
          "the loose replacement ref file stays in place",
        );
        assert.equal(
          await fixture.must(checkout, ["rev-parse", "HEAD"]),
          fixture.candidate,
          "a refused reuse never moves HEAD",
        );
      });

      await t.step("packed replacement refs refuse reuse", async () => {
        const checkout = `${fixture.stateRoot}/review-replace-packed`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        const replacement = `refs/replace/${fixture.candidate}`;
        await fixture.must(checkout, [
          "update-ref",
          replacement,
          fixture.oldBase,
        ]);
        await fixture.must(checkout, ["pack-refs", "--all"]);
        assert.equal(
          await localTestPathExists(`${checkout}/.git/${replacement}`),
          false,
          "the replacement ref is packed, not loose",
        );
        assert.ok(
          (await Deno.readTextFile(`${checkout}/.git/packed-refs`)).includes(
            `${replacement}\n`,
          ),
          "packed-refs carries the replacement ref",
        );
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        assert.equal(
          await fixture.must(checkout, ["rev-parse", replacement]),
          fixture.oldBase,
          "the packed replacement ref is preserved, never rewritten",
        );
        assert.equal(
          await fixture.must(checkout, ["rev-parse", "HEAD"]),
          fixture.candidate,
          "a refused reuse never moves HEAD",
        );
      });

      await t.step("symlinked FETCH_HEAD refuses reuse", async () => {
        const checkout = `${fixture.stateRoot}/review-link-fetch-head`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        const offending = `${checkout}/.git/FETCH_HEAD`;
        const target = `${fixture.root}/fetch-head-target`;
        await Deno.writeTextFile(target, "fetch head target\n");
        if (await localTestPathExists(offending)) await Deno.remove(offending);
        await localTestLink(["-s", target, offending]);
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        assert.ok(
          (await Deno.lstat(offending)).isSymlink,
          "the FETCH_HEAD symlink is preserved, never followed",
        );
        assert.equal(
          await Deno.readTextFile(target),
          "fetch head target\n",
          "the symlink target is preserved",
        );
      });

      await t.step("symlinked logs descendant refuses reuse", async () => {
        const checkout = `${fixture.stateRoot}/review-link-logs`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        const logs = `${checkout}/.git/logs`;
        const offending = `${logs}/HEAD`;
        const target = `${fixture.root}/logs-head-target`;
        await Deno.writeTextFile(target, "logs head target\n");
        await Deno.mkdir(logs, { recursive: true });
        if (await localTestPathExists(offending)) await Deno.remove(offending);
        await localTestLink(["-s", target, offending]);
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        assert.ok(
          (await Deno.lstat(offending)).isSymlink,
          "the logs descendant symlink is preserved, never followed",
        );
        assert.equal(
          await Deno.readTextFile(target),
          "logs head target\n",
          "the symlink target is preserved",
        );
      });

      await t.step("symlinked pack descendant refuses reuse", async () => {
        const checkout = `${fixture.stateRoot}/review-link-pack`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        const pack = `${checkout}/.git/objects/pack`;
        const offending = `${pack}/sentinel-link.pack`;
        const target = `${fixture.root}/pack-target`;
        await Deno.writeTextFile(target, "pack target\n");
        await Deno.mkdir(pack, { recursive: true });
        await localTestLink(["-s", target, offending]);
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        assert.ok(
          (await Deno.lstat(offending)).isSymlink,
          "the pack descendant symlink is preserved, never followed",
        );
        assert.equal(
          await Deno.readTextFile(target),
          "pack target\n",
          "the symlink target is preserved",
        );
      });

      await t.step("shared metadata file refuses reuse", async () => {
        const checkout = `${fixture.stateRoot}/review-hardlink`;
        const first = await prepare(checkout);
        assert.ok(first.ok, first.ok ? "" : first.error.detail);
        const offending = `${checkout}/.git/FETCH_HEAD`;
        const target = `${fixture.root}/shared-metadata`;
        await Deno.writeTextFile(target, "shared metadata\n");
        if (await localTestPathExists(offending)) await Deno.remove(offending);
        await localTestLink([target, offending]);
        assert.equal(
          (await Deno.lstat(offending)).nlink,
          2,
          "the fixture metadata file shares one inode with its target",
        );
        const refused = await prepare(checkout);
        assert.equal(refused.ok, false);
        assert.equal(
          await Deno.readTextFile(offending),
          "shared metadata\n",
          "the shared metadata file is preserved",
        );
        assert.equal(
          await Deno.readTextFile(target),
          "shared metadata\n",
          "the shared metadata target is preserved",
        );
        assert.equal(
          (await Deno.lstat(offending)).nlink,
          2,
          "the shared link survives the refusal",
        );
        assert.equal((await Deno.lstat(target)).nlink, 2);
      });

      await t.step("a non-directory review path is refused", async () => {
        const file = `${fixture.root}/review-file`;
        await Deno.writeTextFile(file, "not a checkout\n");
        const refused = await prepare(file);
        assert.equal(refused.ok, false);
        assert.equal(await Deno.readTextFile(file), "not a checkout\n");
      });
    } finally {
      await Deno.remove(fixture.root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "local checkout base: saved candidate, divergent base and malformed mapping refuse",
  async () => {
    const fixture = await checkoutFixture();
    try {
      const checkout = `${fixture.stateRoot}/checkouts/${fixture.key}`;
      const mappingPath = `${checkout}.json`;
      const first = await requestCheckout(fixture, fixture.oldBase);
      assert.ok(first.ok);

      // A saved candidate head is never moved onto a new base.
      await fixture.must(checkout, [
        "fetch",
        "--no-tags",
        fixture.source,
        fixture.candidate,
      ]);
      await fixture.must(checkout, [
        "checkout",
        "-q",
        "--detach",
        fixture.candidate,
      ]);
      const candidateRefused = await requestCheckout(fixture, fixture.newBase);
      assert.equal(candidateRefused.ok, false);
      assert.equal(await checkoutRev(fixture, "HEAD"), fixture.candidate);
      assert.equal(
        (JSON.parse(await Deno.readTextFile(mappingPath)) as { base: string })
          .base,
        fixture.oldBase,
      );

      // An unrelated (non-ancestor) requested base is refused untouched.
      await fixture.must(checkout, [
        "checkout",
        "-q",
        "--detach",
        fixture.oldBase,
      ]);
      const divergentRefused = await requestCheckout(
        fixture,
        fixture.divergent,
      );
      assert.equal(divergentRefused.ok, false);
      assert.equal(await checkoutRev(fixture, "HEAD"), fixture.oldBase);
      assert.equal(
        (JSON.parse(await Deno.readTextFile(mappingPath)) as { base: string })
          .base,
        fixture.oldBase,
      );

      // A malformed mapping preserves every byte and the checkout itself.
      await Deno.writeTextFile(mappingPath, "{not json\n");
      const malformedRefused = await requestCheckout(fixture, fixture.newBase);
      assert.equal(malformedRefused.ok, false);
      assert.equal(await Deno.readTextFile(mappingPath), "{not json\n");
      assert.equal(await checkoutRev(fixture, "HEAD"), fixture.oldBase);
    } finally {
      await Deno.remove(fixture.root, { recursive: true }).catch(() => {});
    }
  },
);

async function localTestPathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function localTestDirEntries(path: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(path)) names.push(entry.name);
  return names;
}

/**
 * Create one fixture link through absolute `/bin/ln` with an empty environment:
 * no scoped Deno permission beyond ordinary reads is required, and the child
 * never observes the test process environment. The command must succeed.
 */
async function localTestLink(args: string[]): Promise<void> {
  const linked = await new Deno.Command("/bin/ln", {
    args,
    clearEnv: true,
    stdout: "null",
    stderr: "null",
  }).output();
  assert.equal(linked.code, 0, `ln ${args.join(" ")} must create the fixture`);
}

Deno.test(
  "local durable git: absent and empty paths initialize, nonempty paths and symlinks are preserved",
  async () => {
    const fixture = await checkoutFixture();
    try {
      await Deno.mkdir(fixture.stateRoot, { recursive: true });
      const options: LocalRepairHostOptionsV1 = {
        stateRoot: fixture.stateRoot,
        sourceDir: fixture.source,
        controllerSha: SHA1,
        githubToken: "dummy-token",
        modelToken: "dummy-token",
        codexExecutable: "/nonexistent/sentinel-test-codex",
        denoExecutable: Deno.execPath(),
        trustedPath: fixture.trustedPath,
      };

      // An absent bare state path is initialized in place.
      const absentGit = `${fixture.root}/state.git`;
      await ensureBareStateRepository(absentGit, options, fixture.scratch);
      const absentBare = await fixture.git(absentGit, [
        "rev-parse",
        "--is-bare-repository",
      ]);
      assert.ok(absentBare.ok, absentBare.stderr);
      assert.equal(absentBare.stdout.trim(), "true");

      // An existing EMPTY state directory is still initialized, never skipped.
      const emptyGit = `${fixture.root}/empty.git`;
      await Deno.mkdir(emptyGit);
      await ensureBareStateRepository(emptyGit, options, fixture.scratch);
      const emptyBare = await fixture.git(emptyGit, [
        "rev-parse",
        "--is-bare-repository",
      ]);
      assert.ok(emptyBare.ok, emptyBare.stderr);
      assert.equal(emptyBare.stdout.trim(), "true");

      // An existing nonempty user directory is preserved exactly: no init and
      // no reset of user files.
      const keptGit = `${fixture.root}/kept.git`;
      await Deno.mkdir(keptGit);
      await Deno.writeTextFile(`${keptGit}/keep.txt`, "user work\n");
      await ensureBareStateRepository(keptGit, options, fixture.scratch);
      assert.equal(
        await Deno.readTextFile(`${keptGit}/keep.txt`),
        "user work\n",
      );
      assert.equal(
        await localTestPathExists(`${keptGit}/HEAD`),
        false,
        "a nonempty path is never initialized over user files",
      );

      // A symlink is refused before any Git runs and its target is untouched.
      const gitLinkTarget = `${fixture.root}/git-link-target`;
      await Deno.mkdir(gitLinkTarget);
      const gitLink = `${fixture.root}/git-link`;
      const gitLinked = await new Deno.Command("/bin/ln", {
        args: ["-s", gitLinkTarget, gitLink],
        clearEnv: true,
        stdout: "null",
        stderr: "null",
      }).output();
      assert.equal(gitLinked.code, 0, "the fixture symlink must be created");
      await assert.rejects(
        ensureBareStateRepository(gitLink, options, fixture.scratch),
        (error: unknown) =>
          error instanceof Error && error.message.includes(GIT_FAILED_TEXT),
      );
      assert.deepEqual(
        await localTestDirEntries(gitLinkTarget),
        [],
        "a refused symlink never initializes its target",
      );

      // The source clone helper follows the same absent/empty/preserved rules.
      const absentSource = `${fixture.root}/source-clone`;
      await prepareSourceRepository(absentSource, options, fixture.scratch);
      const absentHead = await fixture.git(absentSource, ["rev-parse", "HEAD"]);
      assert.ok(absentHead.ok, absentHead.stderr);
      assert.equal(absentHead.stdout.trim(), fixture.newBase);

      const emptySource = `${fixture.root}/empty-source`;
      await Deno.mkdir(emptySource);
      await prepareSourceRepository(emptySource, options, fixture.scratch);
      const emptyHead = await fixture.git(emptySource, ["rev-parse", "HEAD"]);
      assert.ok(emptyHead.ok, emptyHead.stderr);
      assert.equal(emptyHead.stdout.trim(), fixture.newBase);

      const keptSource = `${fixture.root}/kept-source`;
      await Deno.mkdir(keptSource);
      await Deno.writeTextFile(`${keptSource}/keep.txt`, "user work\n");
      await prepareSourceRepository(keptSource, options, fixture.scratch);
      assert.equal(
        await Deno.readTextFile(`${keptSource}/keep.txt`),
        "user work\n",
      );
      assert.equal(
        await localTestPathExists(`${keptSource}/.git`),
        false,
        "a nonempty source path is preserved, never reset by a clone",
      );

      const sourceLinkTarget = `${fixture.root}/source-link-target`;
      await Deno.mkdir(sourceLinkTarget);
      const sourceLink = `${fixture.root}/source-link`;
      const sourceLinked = await new Deno.Command("/bin/ln", {
        args: ["-s", sourceLinkTarget, sourceLink],
        clearEnv: true,
        stdout: "null",
        stderr: "null",
      }).output();
      assert.equal(sourceLinked.code, 0, "the fixture symlink must be created");
      await assert.rejects(
        prepareSourceRepository(sourceLink, options, fixture.scratch),
        (error: unknown) =>
          error instanceof Error && error.message.includes(GIT_FAILED_TEXT),
      );
      assert.deepEqual(
        await localTestDirEntries(sourceLinkTarget),
        [],
        "a refused symlink never clones into its target",
      );
    } finally {
      await Deno.remove(fixture.root, { recursive: true }).catch(() => {});
    }
  },
);

// ---------------------------------------------------------------------------
// Candidate objects: exact task-mapped producer-checkout import and the
// trusted-receipt preservation boundary.
// ---------------------------------------------------------------------------

Deno.test(
  "local candidate loader imports only the exact task-mapped candidate",
  async () => {
    // The fixture root MUST be absolute: a relative root is duplicated inside
    // nested Git commands and corrupts every later path assertion.
    const root = await Deno.realPath(
      await Deno.makeTempDir({
        dir: ".",
        prefix: "sentinel-candidate-loader-",
      }),
    );
    const home = `${root}/home`;
    const env = testGitEnv(home);
    await Deno.mkdir(home, { recursive: true });
    try {
      const ctx = await makeRemoteCtx(root, env);
      await Deno.writeTextFile(`${ctx.work}/base.txt`, "base\n");
      assert.ok((await gitRun(ctx.work, ["add", "-A"], env)).ok);
      assert.ok(
        (await gitRun(ctx.work, ["commit", "-q", "-m", "base"], env)).ok,
      );
      assert.ok(
        (await gitRun(ctx.work, ["branch", "-M", "development"], env)).ok,
      );
      const base = (await gitRun(ctx.work, ["rev-parse", "HEAD"], env))
        .stdout.trim() as GitSha;
      await Deno.writeTextFile(`${ctx.work}/candidate.txt`, "candidate\n");
      assert.ok((await gitRun(ctx.work, ["add", "-A"], env)).ok);
      assert.ok(
        (await gitRun(ctx.work, ["commit", "-q", "-m", "candidate"], env)).ok,
      );
      const head = (await gitRun(ctx.work, ["rev-parse", "HEAD"], env))
        .stdout.trim() as GitSha;

      const stateRoot = `${root}/state`;
      const taskId = asWorkItemId("issue-42");
      const key = await localCheckoutKey(taskId);
      const checkoutsDir = `${stateRoot}/checkouts`;
      const checkout = `${checkoutsDir}/${key}`;
      const mappingPath = `${checkoutsDir}/${key}.json`;
      await Deno.mkdir(checkoutsDir, { recursive: true });
      const cloneInto = async (destination: string, source: string) => {
        assert.ok(
          (await gitRun(
            root,
            ["clone", "-q", "--no-hardlinks", source, destination],
            env,
          )).ok,
        );
      };
      const mapping = (
        value: string,
        overrides: Record<string, unknown> = {},
      ) =>
        JSON.stringify({
          version: "v1",
          kind: "local_checkout",
          taskId: value,
          base,
          key,
          ...overrides,
        }) + "\n";
      const freshSource = async (name: string): Promise<string> => {
        const source = `${root}/${name}`;
        assert.ok(
          (await gitRun(root, ["init", "-q", "--bare", source], env)).ok,
        );
        return source;
      };
      const load = (source: string) =>
        createLocalCandidateLoader({
          stateRoot,
          sourcePath: source,
          scratch: home,
          trustedPath: env.PATH ?? "/usr/bin:/bin",
        });
      // A genuinely base-only mirror and checkout: a clone of ctx.work keeps
      // carrying the candidate object, which would invalidate every later
      // absence assertion.
      const baseOnly = `${root}/base-only.git`;
      assert.ok(
        (await gitRun(root, ["init", "-q", "--bare", baseOnly], env)).ok,
      );
      assert.ok(
        (await gitRun(
          ctx.work,
          ["push", "-q", baseOnly, `${base}:refs/heads/development`],
          env,
        )).ok,
      );
      const resetBaseOnlyCheckout = async () => {
        await Deno.remove(checkout, { recursive: true }).catch(() => {});
        await cloneInto(checkout, baseOnly);
        assert.ok(
          (await gitRun(checkout, ["checkout", "-q", "--detach", base], env))
            .ok,
        );
      };

      // 1. A fresh empty source mirror imports the exact candidate from the
      // exact task-mapped producer checkout.
      await cloneInto(checkout, ctx.work);
      await Deno.writeTextFile(mappingPath, mapping(taskId));
      const sourceA = await freshSource("source-a.git");
      const loaded = await load(sourceA)(taskId, head);
      assert.ok(loaded.ok, JSON.stringify(loaded));
      const imported = await gitRun(
        sourceA,
        ["rev-parse", `refs/sentinel/candidates/${key}`],
        env,
      );
      assert.equal(imported.stdout.trim(), head);
      assert.equal(
        (await gitRun(sourceA, ["cat-file", "-e", `${base}^{commit}`], env))
          .code,
        0,
      );

      // 2. The positive moved-HEAD case: HEAD is detached at the base while
      // the exact object still exists, so the exact object is imported and no
      // mutable HEAD is ever resolved.
      assert.ok(
        (await gitRun(checkout, ["checkout", "-q", "--detach", base], env)).ok,
      );
      const sourceB = await freshSource("source-b.git");
      const moved = await load(sourceB)(taskId, head);
      assert.ok(moved.ok, JSON.stringify(moved));
      assert.equal(
        (await gitRun(
          sourceB,
          ["rev-parse", `refs/sentinel/candidates/${key}`],
          env,
        )).stdout.trim(),
        head,
      );

      // 3. A source mirror that cannot be read is unavailable, never loss.
      const unreadable = await load(`${root}/no-such-source.git`)(taskId, head);
      assert.equal(unreadable.ok, false);
      assert.equal(unreadable.ok ? null : unreadable.error.kind, "unavailable");

      await resetBaseOnlyCheckout();

      // 4. A wrong-task mapping is unknown availability even though the exact
      // object is genuinely absent from this checkout: never positive loss.
      await Deno.writeTextFile(mappingPath, mapping(asWorkItemId("issue-43")));
      const wrongTask = await load(await freshSource("source-c.git"))(
        taskId,
        head,
      );
      assert.equal(wrongTask.ok, false);
      assert.equal(wrongTask.ok ? null : wrongTask.error.kind, "unavailable");

      // 5. Corrupt JSON and mismatched metadata are the same unknown state.
      await Deno.writeTextFile(mappingPath, "{ not json\n");
      const corrupt = await load(await freshSource("source-d.git"))(
        taskId,
        head,
      );
      assert.equal(corrupt.ok, false);
      assert.equal(corrupt.ok ? null : corrupt.error.kind, "unavailable");
      await Deno.writeTextFile(mappingPath, mapping(taskId, { version: "v2" }));
      const wrongVersion = await load(await freshSource("source-e.git"))(
        taskId,
        head,
      );
      assert.equal(wrongVersion.ok, false);
      assert.equal(
        wrongVersion.ok ? null : wrongVersion.error.kind,
        "unavailable",
      );

      // 6. A present path that is not a usable Git store can never prove
      // absence.
      await Deno.writeTextFile(mappingPath, mapping(taskId));
      await Deno.remove(checkout, { recursive: true });
      await Deno.writeTextFile(checkout, "not a git repository\n");
      const invalidStore = await load(await freshSource("source-f.git"))(
        taskId,
        head,
      );
      assert.equal(invalidStore.ok, false);
      assert.equal(
        invalidStore.ok ? null : invalidStore.error.kind,
        "unavailable",
      );

      // 7. An exact mapping with a proven-missing checkout is positive loss.
      await Deno.remove(checkout);
      const absentCheckout = await load(await freshSource("source-g.git"))(
        taskId,
        head,
      );
      assert.equal(absentCheckout.ok, false);
      assert.equal(
        absentCheckout.ok ? null : absentCheckout.error.kind,
        "not_found",
      );

      // 8. The exact mapped checkout without the exact object is positive
      // loss: this checkout genuinely has only the base commit.
      await resetBaseOnlyCheckout();
      const absentObject = await load(await freshSource("source-h.git"))(
        taskId,
        head,
      );
      assert.equal(absentObject.ok, false);
      assert.equal(
        absentObject.ok ? null : absentObject.error.kind,
        "not_found",
      );

      // 9. A never-published producer (no mapping, no checkout) is the same
      // proven absence.
      await Deno.remove(mappingPath);
      await Deno.remove(checkout, { recursive: true });
      const never = await load(await freshSource("source-i.git"))(taskId, head);
      assert.equal(never.ok, false);
      assert.equal(never.ok ? null : never.error.kind, "not_found");
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "local receipt finalization: a trusted completed receipt survives a failed import",
  async () => {
    const captured = captureConsoleLog();
    const stateRoot = await Deno.makeTempDir({
      dir: ".",
      prefix: "sentinel-finalize-",
    });
    try {
      const request = modelRequest();
      const original = receipt();
      assert.equal(original.ok, true);
      const key = await localCheckoutKey(request.taskId);
      const checkout = `${stateRoot}/checkouts/${key}`;
      await Deno.mkdir(checkout, { recursive: true });
      await Deno.writeTextFile(`${checkout}/keep.txt`, "keep\n");
      let imports = 0;
      const result = await finalizeLocalModelResult({
        stateRoot,
        request,
        result: original,
        observedAt: T0,
        importCandidate: () => {
          imports++;
          return Promise.resolve(false);
        },
      });
      assert.deepEqual(
        result,
        original,
        "the exact original trusted receipt is returned unchanged",
      );
      assert.equal(imports, 1);
      assert.equal(
        (await Deno.stat(`${checkout}/keep.txt`)).isFile,
        true,
        "the persistent producer checkout is preserved",
      );
      // The existing diagnostic path still saved the private minimal receipt,
      // including the exact candidate head; no publication happened here.
      const resultsDir = `${stateRoot}/model-results/${key}`;
      const files = [...Deno.readDirSync(resultsDir)];
      assert.equal(files.length, 1);
      const written = await Deno.readTextFile(
        `${resultsDir}/${files[0]!.name}`,
      );
      assert.equal(written.includes(SHA3), true);
      assert.equal(written.includes("thread-1"), true);
      assert.equal(captured.lines.length, 1);
      const advisory = JSON.parse(captured.lines[0]!) as Record<
        string,
        unknown
      >;
      assert.equal(advisory.candidatePresent, true);
    } finally {
      captured.restore();
      await Deno.remove(stateRoot, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "local receipt finalization: a diagnostic write failure keeps the completed receipt",
  async () => {
    const captured = captureConsoleLog();
    const stateRoot = await Deno.makeTempDir({
      dir: ".",
      prefix: "sentinel-finalize-failure-",
    });
    try {
      // A plain file where the model-results directory belongs forces the
      // private diagnostic write to fail through the existing path.
      await Deno.writeTextFile(`${stateRoot}/model-results`, "occupied\n");
      const request = modelRequest();
      const original = receipt();
      let imports = 0;
      const result = await finalizeLocalModelResult({
        stateRoot,
        request,
        result: original,
        observedAt: T0,
        importCandidate: () => {
          imports++;
          return Promise.resolve(false);
        },
      });
      assert.deepEqual(
        result,
        original,
        "the trusted completed receipt is never rewritten as unavailable",
      );
      assert.equal(
        imports,
        0,
        "an unsaved diagnostic never imports or publishes a candidate",
      );
      assert.equal(captured.lines.length, 1);
      assert.equal(
        captured.lines[0]!.includes("trusted completed receipt is preserved"),
        true,
        "the static diagnostic failure is reported",
      );

      // Non-completed port errors keep the original conservative behavior.
      const failure: PortResultV1<ModelRunReceiptV1> = {
        ok: false,
        error: { kind: "unavailable", detail: DUMMY_RAW_ERROR },
      };
      const conservative = await finalizeLocalModelResult({
        stateRoot,
        request,
        result: failure,
        observedAt: T0,
        importCandidate: () => {
          imports++;
          return Promise.resolve(false);
        },
      });
      assert.equal(conservative.ok, false);
      assert.equal(
        conservative.ok ? null : conservative.error.kind,
        "unavailable",
      );
      assert.equal(
        conservative.ok
          ? null
          : conservative.error.detail.includes(DUMMY_RAW_ERROR),
        false,
      );
      assert.equal(imports, 0);
      assert.equal(captured.lines.length, 1);
    } finally {
      captured.restore();
      await Deno.remove(stateRoot, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "local host: checkout failures emit a sanitized model diagnostic",
  async () => {
    // REGRESSION: the two VALID-request checkout failure exits (candidate
    // restoration and checkout preparation) must use the same finalized
    // persistence/diagnostic path as any other failed run. On the old code
    // they returned STATIC_CHECKOUT directly: nothing persisted, nothing
    // emitted, and the fixed launcher decoder had no model_checkout_unavailable
    // record to read.
    const captured = captureConsoleLog();
    const stateRoot = await Deno.makeTempDir({
      dir: ".",
      prefix: "sentinel-checkout-diagnostic-",
    });
    try {
      const request = modelRequest();
      const key = await localCheckoutKey(request.taskId);
      const port = (input: Partial<LocalModelInputV1> = {}) =>
        new LocalCheckoutModelPort({
          stateRoot,
          sourcePath: `${stateRoot}/source.git`,
          scratch: `${stateRoot}/scratch`,
          trustedPath: `${stateRoot}/trusted`,
          // Never reached: without a prepared checkout no session can launch.
          codexExecutable: "/nonexistent/sentinel-codex-marker",
          denoExecutable: "/nonexistent/sentinel-deno-marker",
          modelToken: "dummy-model-token-marker",
          tracker: new LocalSessionTracker(),
          clock: new FakeClock(T0),
          ...input,
        });
      let restorationCalls = 0;
      const thrown = await port({
        ensureCandidateObjects: () => {
          restorationCalls++;
          return Promise.reject(new Error(DUMMY_RAW_ERROR));
        },
      }).runModel({ ...request, checkoutBase: SHA3 });
      const refused = await port({
        ensureCandidateObjects: (): Promise<PortResultV1<void>> => {
          restorationCalls++;
          return Promise.resolve(portError("unavailable", DUMMY_RAW_ERROR));
        },
      }).runModel({ ...request, checkoutBase: SHA3 });
      // No checkout was prepared for either restoration refusal.
      let checkoutPrepared = false;
      try {
        await Deno.stat(`${stateRoot}/checkouts`);
        checkoutPrepared = true;
      } catch {
        checkoutPrepared = false;
      }
      assert.equal(checkoutPrepared, false, "no checkout, so no launch");

      // Second early path: a VALID request refused by checkout preparation
      // (a stale mapping without its checkout) also fails before any start.
      await Deno.mkdir(`${stateRoot}/checkouts`, { recursive: true });
      await Deno.writeTextFile(`${stateRoot}/checkouts/${key}.json`, "{}\n");
      const unprepared = await port().runModel(request);
      assert.equal(restorationCalls, 2, "both restoration seams were used");
      checkoutPrepared = false;
      try {
        await Deno.stat(`${stateRoot}/checkouts/${key}`);
        checkoutPrepared = true;
      } catch {
        checkoutPrepared = false;
      }
      assert.equal(checkoutPrepared, false, "no checkout, so no launch");

      // The original unavailable checkout failure is preserved, unchanged and
      // without any raw seam text.
      const failures = [thrown, refused, unprepared].filter((result) =>
        !result.ok
      );
      assert.equal(failures.length, 3);
      const firstDetail = thrown.ok ? null : thrown.error.detail;
      assert.equal(typeof firstDetail, "string");
      for (const failure of failures) {
        if (failure.ok) continue;
        assert.equal(failure.error.kind, "unavailable");
        assert.equal(failure.error.detail, firstDetail);
        assert.equal(failure.error.detail.includes(DUMMY_RAW_ERROR), false);
      }

      // Exactly one advisory per failure, carrying only the whitelisted static
      // checkout reason code.
      assert.equal(captured.lines.length, 3, "one diagnostic per failure");
      for (const line of captured.lines) {
        const advisory = JSON.parse(line) as Record<string, unknown>;
        assert.equal(advisory.kind, "sentinel_model_diagnostic");
        assert.equal(advisory.taskKey, key);
        assert.equal(advisory.base, SHA1);
        assert.equal(advisory.outcome, "port_error");
        assert.equal(advisory.reasonCode, "model_checkout_unavailable");
        assert.equal(advisory.candidatePresent, false);
        assert.equal(line.includes(DUMMY_RAW_ERROR), false);
      }

      // The private model-result projection was actually persisted for the
      // same failures.
      const resultsDir = `${stateRoot}/model-results/${key}`;
      const files = [...Deno.readDirSync(resultsDir)];
      assert.equal(files.length, 3);
      for (const file of files) {
        const text = await Deno.readTextFile(`${resultsDir}/${file.name}`);
        const privateResult = JSON.parse(text) as Record<string, unknown>;
        assert.equal(privateResult.kind, "local_model_result");
        assert.equal(privateResult.reason, "runtime_error");
        const result = privateResult.result as Record<string, unknown>;
        assert.equal(result.ok, false);
        assert.equal(result.errorKind, "unavailable");
        assert.equal(text.includes(DUMMY_RAW_ERROR), false);
      }
    } finally {
      captured.restore();
      await Deno.remove(stateRoot, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "base refresh fetches a newly advanced target base before integration",
  async () => {
    // The fixture root stays under the worktree so the registered read
    // permission covers it, and it is made absolute so nested Git children
    // never duplicate a relative path.
    const root = await Deno.realPath(
      await Deno.makeTempDir({ dir: ".", prefix: "sentinel-base-refresh-" }),
    );
    const env = testGitEnv(`${root}/home`);
    const mirror = `${root}/mirror`;
    const pullPath = "/repos/ubiquity/sentinel/pulls/7";
    const refPath = "/repos/ubiquity/sentinel/git/ref/heads/development";
    const trustedAuthor = "ubiquity-sentinel[bot]";
    const branch = "sentinel/repair-base-refresh";
    const requests: string[] = [];
    const admissions: number[] = [];
    // The API observation of the configured base. It is deliberately advanced
    // independently of the real remote branch below so a concurrent movement
    // can be exercised without a second fixture.
    let observedBase = "";
    try {
      await Deno.mkdir(`${root}/home`, { recursive: true });
      // The target's authenticated remote holds only the FIRST base.
      const remote = await makeRemoteCtx(root, env);
      await Deno.writeTextFile(`${remote.work}/base-0.txt`, "base-0\n");
      assert.equal((await gitRun(remote.work, ["add", "-A"], env)).ok, true);
      assert.equal(
        (await gitRun(remote.work, ["commit", "-q", "-m", "base 0"], env)).ok,
        true,
      );
      const base0 = (await gitRun(remote.work, ["rev-parse", "HEAD"], env))
        .stdout.trim();
      const firstPush = await gitRun(
        remote.work,
        ["push", "-q", "origin", "HEAD:refs/heads/development"],
        env,
      );
      assert.equal(firstPush.ok, true, firstPush.stderr);

      // The private mirror is prepared BEFORE the new base exists, and the
      // original candidate is produced locally on top of the first base.
      const cloned = await gitRun(root, [
        "clone",
        "-q",
        "--no-hardlinks",
        "--no-checkout",
        remote.bare,
        mirror,
      ], env);
      assert.equal(cloned.ok, true, cloned.stderr);
      assert.equal(
        (await gitRun(mirror, [
          "checkout",
          "-q",
          "-B",
          "development",
          base0,
        ], env)).ok,
        true,
      );
      assert.equal(
        (await gitRun(mirror, ["checkout", "-q", "-b", branch, base0], env))
          .ok,
        true,
      );
      await Deno.writeTextFile(`${mirror}/candidate.txt`, "candidate\n");
      assert.equal((await gitRun(mirror, ["add", "-A"], env)).ok, true);
      assert.equal(
        (await gitRun(mirror, ["commit", "-q", "-m", "candidate"], env)).ok,
        true,
      );
      const candidate = (await gitRun(mirror, ["rev-parse", "HEAD"], env))
        .stdout.trim();

      // The composed port's remote is the fixed GitHub URL. The fixture
      // rewrites exactly that URL to the local bare repository and refuses
      // every un-rewritten https transport, so no unexpected rewrite can
      // reach the network.
      assert.equal(
        (await gitRun(mirror, [
          "config",
          `url.file://${remote.bare}.insteadOf`,
          "https://github.com/ubiquity/sentinel.git",
        ], env)).ok,
        true,
      );
      assert.equal(
        (await gitRun(mirror, ["config", "protocol.https.allow", "never"], env))
          .ok,
        true,
      );

      // The new base is created ONLY AFTER mirror preparation and is genuinely
      // absent from the mirror before the refresh runs.
      await Deno.writeTextFile(`${remote.work}/base-1.txt`, "base-1\n");
      assert.equal((await gitRun(remote.work, ["add", "-A"], env)).ok, true);
      assert.equal(
        (await gitRun(remote.work, ["commit", "-q", "-m", "base 1"], env)).ok,
        true,
      );
      const base1 = (await gitRun(remote.work, ["rev-parse", "HEAD"], env))
        .stdout.trim();
      const secondPush = await gitRun(
        remote.work,
        ["push", "-q", "origin", "HEAD:refs/heads/development"],
        env,
      );
      assert.equal(secondPush.ok, true, secondPush.stderr);
      observedBase = base1;
      assert.equal(
        (await gitRun(mirror, ["cat-file", "-e", `${base1}^{commit}`], env))
          .ok,
        false,
        "the newly advanced base must be absent before the refresh",
      );

      // THE production composition over the fixed repository identity, with
      // the exact hardcoded GitHub remote routed to the local fixture.
      const clock = new FakeClock(T0);
      const gate: GitHubCooldownGateV1 = {
        beforeRequest: (installationId) => {
          admissions.push(installationId);
          return Promise.resolve(portOk(undefined));
        },
        recordRateLimit: () => Promise.resolve(portOk(undefined)),
      };
      const stateRoot = `${root}/state`;
      await Deno.mkdir(stateRoot, { recursive: true });
      const http: HttpTransportV1 = (request) => {
        const path = new URL(request.url).pathname;
        requests.push(`${request.method} ${path}`);
        if (request.method === "GET" && path.endsWith("/pulls/7")) {
          return Promise.resolve({
            status: 200,
            headers: new Headers(),
            bodyText: JSON.stringify({
              number: 7,
              title: "Sentinel repair",
              body: "Refs 264",
              state: "open",
              head: { ref: branch, sha: candidate },
              base: { ref: "development", sha: observedBase },
              user: { login: trustedAuthor },
              created_at: "2026-09-22T00:00:00Z",
              updated_at: "2026-09-22T00:00:00Z",
              merged_at: null,
              merge_commit_sha: null,
              review_decision: "none",
            }),
          });
        }
        if (
          request.method === "GET" &&
          path.endsWith("/git/ref/heads/development")
        ) {
          return Promise.resolve({
            status: 200,
            headers: new Headers(),
            bodyText: JSON.stringify({
              ref: "refs/heads/development",
              object: { sha: observedBase, type: "commit" },
            }),
          });
        }
        return Promise.reject(new Error(`unscripted request: ${path}`));
      };
      const compose = (name: string) =>
        composeLocalGitHub({
          clock,
          state: new MemoryState(),
          gate,
          http,
          token: "dummy-token",
          login: trustedAuthor,
          invocationId: "base-refresh-composition",
          stateRoot,
          sourcePath: mirror,
          scratch: `${root}/scratch`,
          reviewCheckout: `${root}/review`,
          reviewClientHome: `${root}/clients`,
          reviewTmpDir: `${root}/tmp`,
          reviewDenoDir: `${root}/deno`,
          trustedPath: Deno.env.get("PATH") ?? "/usr/bin:/bin",
          codexExecutable: "/usr/bin/false",
          tracker: new LocalSessionTracker(),
          repository: { ...createLocalRepositoryConfig().repository, name },
          baseBranch: "development",
        });
      const prepare = compose("sentinel").prepareBaseRefresh;
      assert.ok(
        prepare !== undefined,
        "the composed port carries the base-refresh capability",
      );
      if (prepare === undefined) return;
      const request = {
        pullRequestNumber: 7,
        branch,
        expectedHead: candidate as GitSha,
        previousBase: base0 as GitSha,
        expectedBase: base1 as GitSha,
      };

      // The refresh fetches the newly advanced base from THIS target's own
      // authenticated remote before the deterministic integration, and the
      // original candidate survives as the first parent.
      const prepared = await prepare(request);
      assert.equal(prepared.ok, true, JSON.stringify(prepared));
      if (!prepared.ok) return;
      const parents = (await gitRun(mirror, [
        "rev-list",
        "--parents",
        "-n",
        "1",
        prepared.value,
      ], env)).stdout.trim().split(" ");
      assert.deepEqual(parents, [prepared.value, candidate, base1]);
      assert.equal(
        (await gitRun(mirror, ["rev-parse", `${candidate}^{commit}`], env))
          .stdout.trim(),
        candidate,
        "the original candidate object is preserved",
      );
      assert.equal(
        (await gitRun(mirror, ["cat-file", "-e", `${base1}^{commit}`], env))
          .ok,
        true,
        "the newly advanced base is now local",
      );
      assert.ok(admissions.length > 0, "the shared cooldown gate was admitted");
      assert.ok(
        admissions.every((id) => id === 0),
        "every admission is scoped to this repository's installation",
      );
      assert.ok(requests.includes(`GET ${pullPath}`));
      assert.ok(requests.includes(`GET ${refPath}`));

      // A concurrent advance the API observation has not seen is a bounded
      // conflict: the fetched branch head is not the observed base, so nothing
      // is integrated and no unobserved base is adopted.
      await Deno.writeTextFile(`${remote.work}/base-2.txt`, "base-2\n");
      assert.equal((await gitRun(remote.work, ["add", "-A"], env)).ok, true);
      assert.equal(
        (await gitRun(remote.work, ["commit", "-q", "-m", "base 2"], env)).ok,
        true,
      );
      const thirdPush = await gitRun(
        remote.work,
        ["push", "-q", "origin", "HEAD:refs/heads/development"],
        env,
      );
      assert.equal(thirdPush.ok, true, thirdPush.stderr);
      const conflicted = await prepare(request);
      assert.equal(conflicted.ok, false);
      if (!conflicted.ok) {
        assert.equal(conflicted.error.kind, "conflict");
      }

      // A failed fetch fails closed: the fixed remote rewrite now points at an
      // absent fixture, and the adapter still observed the exact PR/base
      // first, so the refusal comes from the fetch step before integration.
      assert.equal(
        (await gitRun(mirror, [
          "config",
          `url.file://${remote.bare}.insteadOf`,
          `file://${root}/absent-target.git`,
        ], env)).ok,
        true,
      );
      const unavailable = await prepare(request);
      assert.equal(unavailable.ok, false);
      if (!unavailable.ok) {
        assert.equal(unavailable.error.kind, "unavailable");
      }

      // Own-repository scope: a port composed for another repository fetches
      // from THAT repository's own remote (routed here to its own local
      // fixture) and refuses a head that is not the observed base. The
      // un-rewritten https transport stays refused by the fixture policy.
      await Deno.mkdir(`${root}/foreign`, { recursive: true });
      const foreign = await makeRemoteCtx(`${root}/foreign`, env);
      await Deno.writeTextFile(`${foreign.work}/foreign.txt`, "foreign\n");
      assert.equal((await gitRun(foreign.work, ["add", "-A"], env)).ok, true);
      assert.equal(
        (await gitRun(foreign.work, ["commit", "-q", "-m", "foreign"], env))
          .ok,
        true,
      );
      const foreignBase = (await gitRun(foreign.work, [
        "rev-parse",
        "HEAD",
      ], env)).stdout.trim();
      const foreignPush = await gitRun(
        foreign.work,
        ["push", "-q", "origin", "HEAD:refs/heads/development"],
        env,
      );
      assert.equal(foreignPush.ok, true, foreignPush.stderr);
      assert.notEqual(foreignBase, base1);
      assert.equal(
        (await gitRun(mirror, [
          "config",
          `url.file://${foreign.bare}.insteadOf`,
          "https://github.com/ubiquity/other.git",
        ], env)).ok,
        true,
      );
      const foreignPrepare = compose("other").prepareBaseRefresh;
      assert.ok(foreignPrepare !== undefined);
      if (foreignPrepare !== undefined) {
        const foreignRefused = await foreignPrepare(request);
        assert.equal(foreignRefused.ok, false);
        if (!foreignRefused.ok) {
          assert.equal(foreignRefused.error.kind, "conflict");
        }
      }
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "local composition forwards the configured review model and provider to the reviewer",
  async () => {
    const configuredRoute: ModelRouteV1 = {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-flash",
      reasoning: "max",
      apiKeyEnv: "SENTINEL_DEEPSEEK_API_KEY",
    };
    const root = await Deno.realPath(
      await Deno.makeTempDir({ dir: ".", prefix: "sentinel-review-model-" }),
    );
    try {
      for (
        const dir of [
          "state",
          "source",
          "scratch",
          "review",
          "clients",
          "tmp",
          "deno",
        ]
      ) {
        await Deno.mkdir(`${root}/${dir}`, { recursive: true });
      }
      const gate: GitHubCooldownGateV1 = {
        beforeRequest: () => Promise.resolve(portOk(undefined)),
        recordRateLimit: () => Promise.resolve(portOk(undefined)),
      };
      const http: HttpTransportV1 = () =>
        Promise.reject(new Error("no request in this composition test"));
      const compose = (route?: ModelRouteV1) =>
        composeLocalGitHub({
          clock: new FakeClock(T0),
          state: new MemoryState(),
          gate,
          http,
          token: "dummy-token",
          login: "ubiquity-sentinel[bot]",
          invocationId: "configured-review-model",
          stateRoot: `${root}/state`,
          sourcePath: `${root}/source`,
          scratch: `${root}/scratch`,
          reviewCheckout: `${root}/review`,
          reviewClientHome: `${root}/clients`,
          reviewTmpDir: `${root}/tmp`,
          reviewDenoDir: `${root}/deno`,
          trustedPath: Deno.env.get("PATH") ?? "/usr/bin:/bin",
          codexExecutable: "/usr/bin/false",
          tracker: new LocalSessionTracker(),
          route,
        });
      // The composed review service owns exactly the reviewer this composition
      // built; its trusted binding proves which provider/model were forwarded.
      // The port is widened through unknown BEFORE the private fields are
      // read, so the accessor itself never names an undeclared port property.
      const reviewerOf = (port: ReturnType<typeof composeLocalGitHub>) =>
        (port as unknown as {
          reviewService: {
            reviewer: {
              provider: string;
              model: string;
              prepare: (request: unknown) => Promise<PortResultV1<unknown>>;
            };
          };
        }).reviewService.reviewer;

      const configured = reviewerOf(compose(configuredRoute));
      assert.equal(configured.provider, "deepseek");
      assert.equal(
        configured.model,
        "deepseek-flash",
        "the route-selected model is forwarded, not the frozen default",
      );

      // A present route whose runtime model is missing must NOT become the
      // omitted-caller default: the reviewer is bound to a value its bounded
      // model validation refuses at prepare, before any session opens.
      const malformedRoute = {
        ...configuredRoute,
        model: undefined,
      } as unknown as ModelRouteV1;
      const malformed = reviewerOf(compose(malformedRoute));
      assert.equal(malformed.provider, "deepseek");
      assert.equal(
        malformed.model,
        "",
        "a present malformed route model is never replaced by the default",
      );
      const refused = await malformed.prepare({});
      assert.equal(refused.ok, false);
      if (!refused.ok) {
        assert.match(String(refused.error.detail), /review model/);
      }

      // Omitted callers keep the frozen local provider and review model.
      const fallback = reviewerOf(compose());
      assert.equal(fallback.provider, "uos");
      assert.equal(fallback.model, REVIEW_MODEL);
      const fallbackRefused = await fallback.prepare({});
      assert.equal(
        fallbackRefused.ok,
        false,
        "the omitted-caller default is not a malformed model refusal",
      );
      if (!fallbackRefused.ok) {
        assert.match(String(fallbackRefused.error.detail), /request identity/);
      }
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
);
