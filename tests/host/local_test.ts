// Narrow local-host tests: fixed config parsing, isolated Codex config text
// and exclusive-lock behavior. No network, model, GitHub or real state root.
import assert from "node:assert/strict";

import {
  createLocalRepositoryConfig,
  ensureBareStateRepository,
  ensureTaskCheckout,
  localCheckoutKey,
  type LocalRepairHostOptionsV1,
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
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { LOOP_STOP_MARKER } from "../../src/repair/model-port.ts";
import { FakeClock, FakeGithub, MemoryState } from "../repair/helpers.ts";
import { REPO, SHA1, SHA3, T0 } from "../state/helpers.ts";
import { gitRun, testGitEnv } from "../state/helpers.ts";

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
  assert.equal(config.liveStartLimits?.perHour, 60);
  assert.equal(config.liveStartLimits?.perSevenDays, 168);
  assert.equal(config.sessionBound?.maxDurationMs, 1_200_000);
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
        observedModel: overrides.observedModel ?? "gpt-5.6-luna",
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

// Exact literal, deliberately not imported from the host module: the contract
// is this standalone first line, so a typo in either copy must fail here.
const LOCAL_REPAIR_MARKER = "<!-- sentinel:repair -->";

Deno.test(
  "local issue scope: only the exact standalone first-line marker admits",
  async () => {
    const github = new FakeGithub({
      openIssues: [
        { number: 1, body: `${LOCAL_REPAIR_MARKER}\n` },
        { number: 2, body: LOCAL_REPAIR_MARKER },
        { number: 3, body: `${LOCAL_REPAIR_MARKER}\r\nbody` },
        { number: 4, body: `${LOCAL_REPAIR_MARKER} extra\n` },
        { number: 5, body: ` ${LOCAL_REPAIR_MARKER}\n` },
        { number: 6, body: `intro\n${LOCAL_REPAIR_MARKER}\n` },
        { number: 7, body: `> ${LOCAL_REPAIR_MARKER}\n` },
        { number: 8, body: `\`\`\`\n${LOCAL_REPAIR_MARKER}\n\`\`\`\n` },
        { number: 9, body: LOCAL_REPAIR_MARKER.slice(0, -1) },
        { number: 10, body: "unmarked prose" },
        { number: 11, body: "unmarked but labelled", labels: ["bug"] },
        // Labels have no role at all: a marked issue is admitted even while it
        // still carries the labels the repository bot removes.
        {
          number: 12,
          body: LOCAL_REPAIR_MARKER,
          labels: ["bug", "enhancement", "question"],
        },
      ],
    });
    const scoped = scopeLocalRepairIssues(github);
    assert.equal(scoped, github, "the same concrete port instance is scoped");
    const listed = await scoped.listOpenIssues();
    assert.ok(listed.ok);
    assert.deepEqual(
      listed.ok ? listed.value.map((issue) => issue.number) : [],
      [1, 2, 3, 12],
    );
    assert.deepEqual(github.calls, ["listOpenIssues"]);
  },
);

Deno.test(
  "local issue scope: read re-check admits marked issues and nulls the rest",
  async () => {
    const marked: Partial<GitHubIssueV1> = {
      number: 11,
      body: `${LOCAL_REPAIR_MARKER}\nbody`,
    };
    const github = new FakeGithub({
      issues: [
        marked,
        { number: 12, body: `body\n${LOCAL_REPAIR_MARKER}` },
      ],
    });
    const scoped = scopeLocalRepairIssues(github);
    const admitted = await scoped.readIssue(11);
    assert.ok(admitted.ok);
    assert.equal(admitted.value?.number, 11);
    assert.deepEqual(await scoped.readIssue(12), portOk(null));
    assert.deepEqual(await scoped.readIssue(99), portOk(null));

    // The loop re-reads the real source before admission: removing the marker
    // from the FakeGithub record revokes eligibility instead of consuming
    // budget.
    marked.body = "marker removed upstream";
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
