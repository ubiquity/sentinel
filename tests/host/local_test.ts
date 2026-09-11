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
  tryAcquireLocalHostLock,
} from "../../src/host/local.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { GitHubCooldownGateV1 } from "../../src/contracts/ports.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { FakeClock, MemoryState } from "../repair/helpers.ts";
import { SHA1, T0 } from "../state/helpers.ts";

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
const LOGIN_FAILED_TEXT = "authenticated GitHub login is unavailable";

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
