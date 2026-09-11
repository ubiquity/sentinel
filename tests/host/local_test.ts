// Narrow local-host tests: fixed config parsing, isolated Codex config text
// and exclusive-lock behavior. No network, model, GitHub or real state root.
import assert from "node:assert/strict";

import {
  createLocalRepositoryConfig,
  localCheckoutKey,
  renderLocalCodexConfig,
  tryAcquireLocalHostLock,
} from "../../src/host/local.ts";

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
