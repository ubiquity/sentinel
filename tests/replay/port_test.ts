// ReplayPort module suite (m03): exercises the ACTUAL Deno process/Git
// runtime and the actual port on tiny local toy git repositories — no
// network, no model calls, no paid upstream. The toy app has an original
// bug commit, a fixed candidate commit and an unrelated breakage; the same
// trusted sanitized fixture bundle (regression test + recorded upstream
// data) is applied in scratch to every checkout.
import assert from "node:assert/strict";
import type {
  CommandId,
  FixtureDigest,
  GitSha,
  WorkItemId,
} from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  portOk,
  type PortResultV1,
  type ReplayRunRequestV1,
} from "../../src/contracts/ports.ts";
import { parseRepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import { SENTINEL_REPLAY_INPUT_PATH } from "../../src/replay/causal-verifier.ts";
import { computeReplayFixtureDigest } from "../../src/replay/fixture.ts";
import type { ResolvedFixtureV1 } from "../../src/replay/fixture.ts";
import { ReplayPortImpl } from "../../src/replay/port.ts";
import type { ReplayPortOptions } from "../../src/replay/port.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import type {
  ReplayCommandInputV1,
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";
import {
  bundleDigest,
  commitSymlink,
  commitWith,
  createToyApp,
  FIXTURE_JSON,
  gitRun,
  makePort,
  REGRESSION_TEST,
  REPLAY_SCRIPT,
  replayRequest,
  revParse,
  sha256HexText,
  testGitEnv,
  TOY_BUNDLE_FILES,
  TOY_REPOSITORY,
  toyBundle,
  toyConfig,
  ToyFixtureResolver,
  toyOptions,
  toyPolicy,
} from "./helpers.ts";

const here = new URL(import.meta.url);
if (here.protocol !== "file:") throw new Error("expected a file: test module");
const testsDir = decodeURIComponent(here.pathname).replace(
  /\/port_test\.ts$/,
  "",
);

async function withFixture<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({
    prefix: ".replay-tmp-",
    dir: testsDir,
  });
  try {
    return await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

function assertPortOk<T>(
  result: PortResultV1<T>,
): T {
  assert.ok(result.ok, `expected port ok, got ${JSON.stringify(result)}`);
  return result.value;
}

/** Port whose trusted resolver serves exactly the given fixture bundle. */
function portWithBundle(
  toyRoot: string,
  scratchDir: string,
  bundle: ResolvedFixtureV1,
  overrides: Partial<ReplayPortOptions> = {},
): ReplayPortImpl {
  return new ReplayPortImpl({
    ...toyOptions(toyRoot, scratchDir),
    fixtures: new ToyFixtureResolver(bundle),
    ...overrides,
  });
}

function configWithCommand(
  commandId: "test" | "replay",
  command: {
    executable: string;
    args: string[];
    maxDurationMs: number;
    maxOutputBytes: number;
  },
): RepositoryConfigV1 {
  const base = toyConfig();
  return parseRepositoryConfigV1({
    version: "v1",
    kind: "repository_config",
    repository: TOY_REPOSITORY,
    baseBranch: "main",
    adapter: { kind: "gateway", baseUrl: "https://ai.ubq.fi" },
    commands: { replay: "replay", test: "test" },
    commandRegistry: {
      version: "v1",
      commands: {
        ...base.commandRegistry.commands,
        [commandId]: command,
      },
    },
    protectedPaths: ["src/"],
    build: { projectId: null, acceptance: null },
    secretRef: null,
    liveStartLimits: null,
    sessionBound: null,
    retention: null,
    stabilityPolicy: null,
  });
}

const text = new TextEncoder();

Deno.test("fail-before/pass-after on exact heads with matching digest", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const port = makePort(toy.root, `${root}/scratch`);
    const bundle = toyBundle();

    const originalReq = await replayRequest(bundle, toy.originalSha);
    const original = assertPortOk(await port.runReplay(originalReq));
    assert.equal(original.outcome, "failed", "original must fail");
    assert.equal(original.exitCode, 1);
    assert.equal(original.failure?.intended, true, "failure must be intended");
    assert.equal(
      original.failure?.reason,
      "missing completion terminator produces 500",
    );
    assert.ok(original.output !== null, "failed run keeps bounded output");
    assert.ok(
      original.output.stdoutDigest !== null,
      "failed run records stdout digest",
    );
    assert.deepEqual(original.limitations, []);

    // The candidate is the DELIVERED head: it already contains the permanent
    // regression test + fixture bytes, so ReplayPort must accept the
    // byte-identical existing files (no rewrite) and pass. This is the
    // required actual-candidate route, not a raw CI subprocess.
    const candidateReq = await replayRequest(bundle, toy.candidateSha);
    const candidate = assertPortOk(await port.runReplay(candidateReq));
    assert.equal(candidate.outcome, "passed", "candidate must pass");
    assert.equal(candidate.exitCode, 0);
    assert.equal(candidate.failure, null);
    assert.ok(candidate.output?.stdoutDigest !== null);
    assert.deepEqual(candidate.limitations, []);

    // Independent exact-head verification with a real second clone.
    const verifyDir = `${root}/verify`;
    await Deno.mkdir(verifyDir);
    const clone = await gitRun(
      root,
      ["clone", "-q", "--no-local", toy.root, verifyDir],
      toy.env,
    );
    assert.ok(clone.ok, `verify clone failed: ${clone.stderr}`);
    for (const sha of [toy.originalSha, toy.candidateSha]) {
      const check = await gitRun(
        verifyDir,
        ["rev-parse", "--verify", `${sha}^{commit}`],
        toy.env,
      );
      assert.ok(check.ok, `revision ${sha} must exist`);
      assert.equal(check.stdout.trim(), sha);
    }
    // The candidate's tree really contains the permanent bundle bytes.
    const onCandidate = await gitRun(
      verifyDir,
      ["ls-tree", "-r", "--name-only", toy.candidateSha],
      toy.env,
    );
    assert.ok(onCandidate.ok);
    for (const path of Object.keys(TOY_BUNDLE_FILES)) {
      assert.ok(
        onCandidate.stdout.split("\n").includes(path),
        `candidate must contain delivered bundle file ${path}`,
      );
    }

    // Matching fixture digest recomputed independently from the same bytes.
    const expectedDigest = await bundleDigest({
      "tests/regression_test.ts": REGRESSION_TEST,
      "tests/fixtures/upstream.json": FIXTURE_JSON,
      "scripts/replay.ts": REPLAY_SCRIPT,
    });
    assert.equal(originalReq.fixtureDigest, expectedDigest);
    assert.equal(candidateReq.fixtureDigest, expectedDigest);

    // The shared source working directory is untouched by replay runs.
    const status = await gitRun(toy.root, ["status", "--porcelain"], toy.env);
    assert.equal(status.stdout.trim(), "");
    assert.equal(await revParse(toy.root, toy.env), toy.unrelatedSha);

    // No disposable task scratch leftovers.
    const leftovers = [];
    for await (const entry of Deno.readDir(`${root}/scratch`)) {
      leftovers.push(entry.name);
    }
    assert.deepEqual(leftovers, []);

    // Independent raw confirmation that the delivered head's permanent
    // regression is wired into the toy's normal CI command: a fresh
    // checkout of the candidate head passes `deno task test`.
    const ciDir = `${root}/ci`;
    await Deno.mkdir(ciDir);
    const ciClone = await gitRun(
      root,
      ["clone", "-q", "--no-local", toy.root, ciDir],
      toy.env,
    );
    assert.ok(ciClone.ok);
    await gitRun(ciDir, ["checkout", "-q", toy.candidateSha], toy.env);
    const ci = await new Deno.Command("deno", {
      args: ["task", "test"],
      cwd: ciDir,
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        HOME: `${root}/ci-home`,
        DENO_DIR: `${root}/ci-home/.cache/deno`,
        NO_COLOR: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const ciOutput = new TextDecoder().decode(ci.stdout) +
      new TextDecoder().decode(ci.stderr);
    assert.equal(
      ci.success,
      true,
      `wired CI command must pass on delivered head: ${ciOutput}`,
    );
  });
});

Deno.test("configured replay command id resolves and runs", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const port = makePort(toy.root, `${root}/scratch`);
    const bundle = toyBundle();

    const original = assertPortOk(
      await port.runReplay(
        await replayRequest(bundle, toy.originalSha, { commandId: "replay" }),
      ),
    );
    assert.equal(original.outcome, "failed");
    assert.equal(original.failure?.intended, true);

    const candidate = assertPortOk(
      await port.runReplay(
        await replayRequest(bundle, toy.candidateSha, { commandId: "replay" }),
      ),
    );
    assert.equal(candidate.outcome, "passed");
    assert.equal(candidate.exitCode, 0);
  });
});

Deno.test("wrong revision is unavailable, never an original regression", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const port = makePort(toy.root, `${root}/scratch`);
    const bundle = toyBundle();
    const wrongSha = "0".repeat(40) as ReplayRunRequestV1["revision"];

    const run = assertPortOk(
      await port.runReplay(await replayRequest(bundle, wrongSha)),
    );
    assert.equal(run.outcome, "unavailable");
    assert.equal(run.exitCode, null);
    assert.equal(run.output, null);
    assert.equal(run.failure, null);
    assert.match(port.lastUnavailableDetail(), /not present in the source/);
  });
});

Deno.test("fixture digest mismatch is rejected before any command", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const port = makePort(toy.root, `${root}/scratch`);
    const bundle = toyBundle();
    const result = await port.runReplay(
      await replayRequest(bundle, toy.originalSha, {
        fixtureDigest: "0".repeat(64),
      }),
    );
    assert.ok(!result.ok, "digest mismatch must fail closed");
    assert.equal(result.error.kind, "invalid");
    assert.match(result.error.detail, /digest mismatch/);
  });
});

Deno.test("malicious fixture entry paths are rejected", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    for (
      const path of [
        "/etc/passwd",
        "../escape.txt",
        "tests\\evil.txt",
        "tests//x.ts",
        "tests/./x.ts",
        "a/b/c/../../x.ts",
      ]
    ) {
      const bundle = toyBundle({
        entries: [{ path, bytes: text.encode("x") }],
      });
      const port = portWithBundle(toy.root, `${root}/scratch`, bundle);
      const result = await port.runReplay(
        await replayRequest(bundle, toy.originalSha),
      );
      assert.ok(!result.ok, `path must be rejected: ${path}`);
      assert.equal(result.error.kind, "invalid");
      assert.match(result.error.detail, /unsafe fixture entry path/);
    }
  });
});

Deno.test("secret-bearing fixture content is rejected", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const secrets = [
      "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n",
      "Authorization: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n",
      "AKIAIOSFODNN7EXAMPLE\n",
      "cli_token=sk-abcdefghijklmnopqrstuvwxyz123456\n",
    ];
    for (const secret of secrets) {
      const bundle = toyBundle({
        entries: [{
          path: "tests/fixtures/leak.txt",
          bytes: text.encode(secret),
        }],
      });
      const port = portWithBundle(toy.root, `${root}/scratch`, bundle);
      const result = await port.runReplay(
        await replayRequest(bundle, toy.originalSha),
      );
      assert.ok(!result.ok, "secret-shaped content must be rejected");
      assert.equal(result.error.kind, "invalid");
      assert.match(result.error.detail, /secret-shaped text/);
    }
  });
});

Deno.test("bundle outside trusted scope or targeting protected paths is rejected", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);

    const outOfScope = toyBundle({
      entries: [{ path: "etc/passwd.txt", bytes: text.encode("x") }],
    });
    const outOfScopePort = portWithBundle(
      toy.root,
      `${root}/scratch`,
      outOfScope,
    );
    const outOfScopeResult = await outOfScopePort.runReplay(
      await replayRequest(outOfScope, toy.originalSha),
    );
    assert.ok(!outOfScopeResult.ok);
    assert.match(outOfScopeResult.error.detail, /outside trusted bundle scope/);

    // A scope that overlaps protectedPaths is caught by the protected-path
    // check even though the path shape itself is safe.
    const policy = toyPolicy();
    const protectedBundle = toyBundle({
      entries: [{ path: "src/app.ts", bytes: text.encode("x") }],
    });
    const protectedPort = portWithBundle(
      toy.root,
      `${root}/scratch`,
      protectedBundle,
      {
        policy: { ...policy, bundleScopes: ["tests/", "scripts/", "src/"] },
      },
    );
    const protectedResult = await protectedPort.runReplay(
      await replayRequest(protectedBundle, toy.originalSha),
    );
    assert.ok(!protectedResult.ok);
    assert.match(protectedResult.error.detail, /protected path/);
  });
});

Deno.test("unattested sanitization is refused, attested redaction is limited", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);

    const unattested = toyBundle({
      provenance: { ...toyBundle().provenance, sanitized: false },
    });
    const unattestedPort = portWithBundle(
      toy.root,
      `${root}/scratch`,
      unattested,
    );
    const refused = await unattestedPort.runReplay(
      await replayRequest(unattested, toy.originalSha),
    );
    assert.ok(!refused.ok);
    assert.match(refused.error.detail, /sanitization attestation/);

    const redacted = toyBundle({
      provenance: { ...toyBundle().provenance, redacted: true },
    });
    const redactedPort = portWithBundle(
      toy.root,
      `${root}/scratch`,
      redacted,
    );
    const original = assertPortOk(
      await redactedPort.runReplay(
        await replayRequest(redacted, toy.originalSha),
      ),
    );
    assert.equal(original.outcome, "failed");
    assert.equal(original.failure?.intended, true);
    assert.deepEqual(original.limitations, ["fixture_redacted"]);
    const candidate = assertPortOk(
      await redactedPort.runReplay(
        await replayRequest(redacted, toy.candidateSha),
      ),
    );
    assert.equal(candidate.outcome, "passed");
    assert.deepEqual(candidate.limitations, ["fixture_redacted"]);
  });
});

Deno.test("missing executable and unrelated non-zero are unavailable/failed", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const bundle = toyBundle();

    const missingPort = makePort(toy.root, `${root}/scratch`, {
      config: configWithCommand("test", {
        executable: "sentinel-no-such-executable-xyz",
        args: ["task", "test"],
        maxDurationMs: 15000,
        maxOutputBytes: 262144,
      }),
    });
    const missing = assertPortOk(
      await missingPort.runReplay(
        await replayRequest(bundle, toy.originalSha),
      ),
    );
    assert.equal(missing.outcome, "unavailable");
    assert.match(missingPort.lastUnavailableDetail(), /could not spawn/);

    // Unrelated breakage: same bundle, different failure reason.
    const port = makePort(toy.root, `${root}/scratch`);
    const unrelated = assertPortOk(
      await port.runReplay(await replayRequest(bundle, toy.unrelatedSha)),
    );
    assert.equal(unrelated.outcome, "failed");
    assert.equal(
      unrelated.failure?.intended,
      false,
      "unrelated failure is not intended",
    );
  });
});

Deno.test("bounded child timeout is killed, reaped and unavailable", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const bundle = toyBundle();
    const port = makePort(toy.root, `${root}/scratch`, {
      config: configWithCommand("test", {
        executable: "deno",
        args: ["eval", "setTimeout(() => {}, 10000)"],
        maxDurationMs: 150,
        maxOutputBytes: 262144,
      }),
    });
    const started = Date.now();
    const run = assertPortOk(
      await port.runReplay(await replayRequest(bundle, toy.originalSha)),
    );
    const elapsed = Date.now() - started;
    assert.equal(run.outcome, "unavailable", "timeout must be unavailable");
    assert.equal(run.exitCode, null);
    assert.ok(elapsed < 8000, `timeout must fire promptly, took ${elapsed}ms`);
    assert.match(port.lastUnavailableDetail(), /exceeded maxDurationMs/);
  });
});

Deno.test("output cap preserves bounded hashes and truncation limitation", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const bundle = toyBundle();
    const port = makePort(toy.root, `${root}/scratch`, {
      config: configWithCommand("test", {
        executable: "deno",
        args: ["eval", "console.log('x'.repeat(4000)); Deno.exit(1)"],
        maxDurationMs: 15000,
        maxOutputBytes: 128,
      }),
    });
    const run = assertPortOk(
      await port.runReplay(await replayRequest(bundle, toy.originalSha)),
    );
    assert.equal(run.outcome, "failed");
    assert.equal(
      run.failure?.intended,
      false,
      "truncated output cannot be intended",
    );
    assert.equal(run.output?.truncated, true);
    assert.ok(run.limitations.includes("output_truncated"));
    assert.equal(
      run.output?.stdoutDigest,
      await sha256HexText("x".repeat(128)),
    );
  });
});

Deno.test("a no-op exit-0 command is never a passing regression", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const bundle = toyBundle();
    const port = makePort(toy.root, `${root}/scratch`, {
      config: configWithCommand("test", {
        executable: "deno",
        args: ["eval", "console.log('no tests ran')"],
        maxDurationMs: 15000,
        maxOutputBytes: 262144,
      }),
    });
    const run = assertPortOk(
      await port.runReplay(await replayRequest(bundle, toy.candidateSha)),
    );
    assert.equal(run.outcome, "unavailable", "no-op must not pass");
    assert.equal(run.exitCode, null);
    assert.equal(run.failure, null);
  });
});

Deno.test("repository mismatch is invalid; isolation is mandatory", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const port = makePort(toy.root, `${root}/scratch`);
    const bundle = toyBundle();
    const mismatch = await port.runReplay(
      await replayRequest(bundle, toy.originalSha, {
        repository: { ...TOY_REPOSITORY, owner: "other" },
      }),
    );
    assert.ok(!mismatch.ok);
    assert.match(
      mismatch.error.detail,
      /does not match the configured repository/,
    );

    assert.throws(
      () => makePort(toy.root, `${root}/scratch2`, { isolation: undefined }),
      TypeError,
      "missing isolation capability must refuse construction",
    );
    assert.throws(
      () =>
        makePort(toy.root, `${root}/scratch3`, {
          isolation: {
            attestation: {
              version: "v1",
              host: "not-restricted",
              restrictedExecution: false,
              boundary: "untrusted",
              attestationRef: "fixture://isolation/untrusted",
            },
          },
        }),
      TypeError,
      "unattested isolation must refuse construction",
    );
  });
});

Deno.test("checked-out symlink ancestors are rejected at materialization", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const symlinkSha = await commitSymlink(toy.root, toy.env);
    const port = makePort(toy.root, `${root}/scratch`);
    const bundle = toyBundle();
    const run = await port.runReplay(
      await replayRequest(bundle, symlinkSha),
    );
    assert.ok(!run.ok, "symlink ancestor must fail closed");
    assert.equal(run.error.kind, "invalid");
    assert.match(run.error.detail, /resolves through a symlink/);
  });
});

Deno.test("injected runtime boundary faults surface as unavailable", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const realRuntime = new DenoReplayRuntime(
      Deno.env.get("PATH") ?? "/usr/bin:/bin",
    );
    class ThrowingRuntime implements ReplayRuntimeV1 {
      constructor(private readonly inner: ReplayRuntimeV1) {}
      run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
        if (input.executable === "deno") {
          return Promise.reject(
            new Error("synthetic transport failure at the runtime border"),
          );
        }
        return this.inner.run(input);
      }
    }
    const port = makePort(toy.root, `${root}/scratch`, {
      runtime: new ThrowingRuntime(realRuntime),
    });
    const bundle = toyBundle();
    const run = await port.runReplay(
      await replayRequest(bundle, toy.originalSha),
    );
    assert.ok(!run.ok);
    assert.equal(run.error.kind, "unavailable");
    assert.match(run.error.detail, /synthetic transport failure/);
  });
});

Deno.test("request commands resolve only against the trusted registry", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const port = makePort(toy.root, `${root}/scratch`);
    const bundle = toyBundle();
    // Malformed ids are rejected by the shape guard; a valid-format unknown
    // id and — critically — an inherited Object.prototype member name
    // ("constructor") must be rejected by the own-property registry lookup.
    for (
      const commandId of [
        "not in registry",
        "toString",
        "nope",
        "constructor",
      ]
    ) {
      const result = await port.runReplay(
        await replayRequest(bundle, toy.originalSha, { commandId }),
      );
      assert.ok(!result.ok, `command ${commandId} must not resolve`);
      assert.equal(result.error.kind, "invalid");
      if (commandId === "nope" || commandId === "constructor") {
        assert.match(
          result.error.detail,
          /not in the trusted command registry/,
        );
      }
    }
  });
});

Deno.test(
  "byte-identical bundle targets are accepted; different bytes, directories and symlink targets are rejected",
  async () => {
    await withFixture(async (root) => {
      const toy = await createToyApp(`${root}/toy`);
      const bundle = toyBundle();

      // The delivered candidate head ALREADY contains the permanent bundle
      // bytes: ReplayPort must accept them without rewriting and pass.
      const delivered = assertPortOk(
        await portWithBundle(
          toy.root,
          `${root}/scratch`,
          bundle,
        ).runReplay(await replayRequest(bundle, toy.candidateSha)),
      );
      assert.equal(delivered.outcome, "passed");
      assert.equal(delivered.exitCode, 0);

      // Different bytes at a bundle target are rejected, never rewritten.
      const tamperedSha = await commitWith(
        toy.root,
        toy.env,
        { "tests/regression_test.ts": "// DIFFERENT bytes and no marker\n" },
        "tamper: different regression bytes",
      );
      const tampered = await portWithBundle(
        toy.root,
        `${root}/scratch`,
        bundle,
      ).runReplay(await replayRequest(bundle, tamperedSha));
      assert.ok(!tampered.ok, "different bytes must fail closed");
      assert.equal(tampered.error.kind, "invalid");
      assert.match(tampered.error.detail, /different bytes/);

      // A directory where a bundle file must live is rejected. The file
      // committed by the candidate is replaced by a directory holding one
      // file (git cannot track empty directories).
      await Deno.remove(`${toy.root}/tests/fixtures/upstream.json`);
      const dirSha = await commitWith(
        toy.root,
        toy.env,
        { "tests/fixtures/upstream.json/deeper.txt": "x" },
        "tamper: bundle target is a directory",
      );
      const asDir = await portWithBundle(
        toy.root,
        `${root}/scratch`,
        bundle,
      ).runReplay(await replayRequest(bundle, dirSha));
      assert.ok(!asDir.ok, "directory target must fail closed");
      assert.equal(asDir.error.kind, "invalid");
      assert.match(asDir.error.detail, /is a directory/);

      // A symlink AT the bundle target is rejected (in addition to the
      // symlink-ancestor case below).
      const symlinkSha = await commitSymlink(
        toy.root,
        toy.env,
        "tests/fixtures/upstream.json",
        "../src/app.ts",
      );
      const asLink = await portWithBundle(
        toy.root,
        `${root}/scratch`,
        bundle,
      ).runReplay(await replayRequest(bundle, symlinkSha));
      assert.ok(!asLink.ok, "symlink target must fail closed");
      assert.equal(asLink.error.kind, "invalid");
      assert.match(asLink.error.detail, /resolves through a symlink/);

      // Both exact rebuilt heads stay immutable and the digest is unchanged.
      assert.equal(await revParse(toy.root, toy.env), symlinkSha);
      assert.equal(
        (await replayRequest(bundle, toy.candidateSha)).fixtureDigest,
        await bundleDigest({
          "tests/regression_test.ts": REGRESSION_TEST,
          "tests/fixtures/upstream.json": FIXTURE_JSON,
          "scripts/replay.ts": REPLAY_SCRIPT,
        }),
      );
    });
  },
);

Deno.test(
  "descendant retaining captured output after parent exit times out as unavailable",
  async () => {
    await withFixture(async (root) => {
      const toy = await createToyApp(`${root}/toy`);
      const bundle = toyBundle();
      const port = makePort(toy.root, `${root}/scratch`, {
        config: configWithCommand("test", {
          executable: "/bin/sh",
          // The direct parent exits 0 immediately while a descendant keeps
          // the captured stdout pipe open and keeps running: parent exit is
          // NOT completion and the deadline must fire promptly.
          args: ["-c", "(sleep 0.2) & exit 0"],
          maxDurationMs: 50,
          maxOutputBytes: 262144,
        }),
      });
      const started = Date.now();
      const run = assertPortOk(
        await port.runReplay(await replayRequest(bundle, toy.originalSha)),
      );
      const elapsed = Date.now() - started;
      assert.equal(run.outcome, "unavailable", "run must time out");
      assert.equal(run.exitCode, null);
      assert.equal(run.failure, null);
      assert.equal(run.output, null);
      assert.ok(
        elapsed < 2000,
        `timeout must fire promptly, took ${elapsed}ms`,
      );
      assert.match(port.lastUnavailableDetail(), /exceeded maxDurationMs/);
    });
  },
);

Deno.test(
  "an unsettled runtime result is unavailable and preserves the scratch",
  async () => {
    await withFixture(async (root) => {
      const toy = await createToyApp(`${root}/toy`);
      const realRuntime = new DenoReplayRuntime(
        Deno.env.get("PATH") ?? "/usr/bin:/bin",
      );
      class UnsettledRuntime implements ReplayRuntimeV1 {
        constructor(private readonly inner: ReplayRuntimeV1) {}
        run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
          if (input.executable === "deno") {
            // Exit 0 WITH the expected test marker would normally pass — but
            // settlement is not proven, so the port must treat the run as
            // unavailable and KEEP the scratch for inspection.
            return Promise.resolve({
              outcome: "exited",
              exitCode: 0,
              stdout: text.encode(
                "sentinel-replay-test:gateway:stream-termination\n",
              ),
              stderr: new Uint8Array(),
              truncated: false,
              settled: false,
              detail: "synthetic: owned descendant could not be proved settled",
            });
          }
          return this.inner.run(input);
        }
      }
      const port = makePort(toy.root, `${root}/scratch`, {
        runtime: new UnsettledRuntime(realRuntime),
      });
      const bundle = toyBundle();
      const run = assertPortOk(
        await port.runReplay(await replayRequest(bundle, toy.candidateSha)),
      );
      assert.equal(run.outcome, "unavailable", "unsettled must be unavailable");
      assert.equal(run.exitCode, null);
      assert.equal(run.failure, null);
      assert.match(
        port.lastUnavailableDetail(),
        /settlement could not be proven/,
      );
      assert.match(port.lastUnavailableDetail(), /scratch preserved/);

      // The preserved scratch still exists and contains the checkout.
      const preserved = [];
      for await (const entry of Deno.readDir(`${root}/scratch`)) {
        preserved.push(entry.name);
      }
      assert.equal(preserved.length, 1, "scratch must be preserved");
      const taskDir = `${root}/scratch/${preserved[0]}`;
      const entries = [];
      for await (const entry of Deno.readDir(taskDir)) {
        entries.push(entry.name);
      }
      assert.ok(entries.includes("checkout"), "checkout must survive");
      await Deno.remove(taskDir, { recursive: true }).catch(() => {});
    });
  },
);

// ---------------------------------------------------------------------------
// Gateway dispatch metadata (candidate ReplayPort path)
//
// A valid frozen gateway fixture reference selects the dispatch protocol: the
// candidate checkout receives the fixed root `.sentinel-replay-input.json`
// record — exact canonical {version,requestPath,upstreamPath,testIds} bound to
// the resolved incident/capture paths and to the trusted resolved test ids —
// materialized OUTSIDE the digested two-entry bundle. The committed toy
// consumer and regression test below read ONLY that record, so a missing
// dispatcher cannot pass by hardcoded fixture reads. Non-gateway references
// are unchanged. This toy proves dispatch/selection wiring, not the target
// gateway converter (tested separately in its own repository).
// ---------------------------------------------------------------------------

const GATEWAY_INCIDENT = "provider-00000000-0000-4000-8000-0000000000aa";
const GATEWAY_CAPTURE = "synthetic-capture-2";
const GATEWAY_TEST_ID = "gateway:stream-termination";
const GATEWAY_TEST_ID_B = "gateway:second-test";
const GATEWAY_DIR =
  `tests/fixtures/gateway-replay/${GATEWAY_INCIDENT}/${GATEWAY_CAPTURE}`;
const GATEWAY_REQUEST_PATH = `${GATEWAY_DIR}/request.json`;
const GATEWAY_UPSTREAM_PATH = `${GATEWAY_DIR}/upstream.json`;

const GATEWAY_REQUEST_TEXT = JSON.stringify({
  endpoint: "/v1/responses",
  method: "POST",
  contentType: "application/json",
  body: JSON.stringify({
    model: "synthetic-model",
    input: "hello",
    stream: true,
  }),
});

const GATEWAY_UPSTREAM_TEXT = JSON.stringify({
  version: 1,
  attempts: [{
    provider: "chatgpt_codex",
    status: 200,
    content_type: "text/event-stream",
    chunks_base64: [btoa('data: {"type":"response.created"}\n\n')],
    terminal: "eof",
  }],
  attempts_truncated: false,
  bytes_truncated: false,
  chunks_truncated: false,
});

const GATEWAY_DENO_JSON = JSON.stringify(
  {
    tasks: {
      replay: "deno run --allow-read=. scripts/replay.ts",
      test: "deno test --allow-read=. tests/",
    },
  },
  null,
  2,
) + "\n";

/** Independent expectation of the exact canonical dispatch metadata bytes. */
function gatewayDispatchText(
  testIds: readonly string[] = [GATEWAY_TEST_ID],
): string {
  return canonicalStringify({
    version: "v1",
    requestPath: GATEWAY_REQUEST_PATH,
    upstreamPath: GATEWAY_UPSTREAM_PATH,
    testIds: [...testIds],
  });
}

/** Toy gateway handler: original 502s on an incomplete recorded stream. */
function gatewayAppSource(kind: "original" | "fixed"): string {
  const outcome = kind === "original"
    ? `const completed = chunkText.includes('"type":"response.completed"') ||
    chunkText.includes("[DONE]");
  if (!completed) {
    return { status: 502, body: "stream terminated unexpectedly", completed: false };
  }`
    : `// CANDIDATE FIX: the recorded stream is complete without a separate
  // terminator; tolerate the missing completion event.`;
  return `/** Toy gateway stream handler (${kind}). */
export function handleStreamTrace(
  _request: unknown,
  upstream: { attempts: { terminal: string; chunks_base64: string[] }[] },
): { status: number; body: string; completed: boolean } {
  const attempt = upstream.attempts[0];
  const chunkText = new TextDecoder().decode(
    Uint8Array.from(atob(attempt.chunks_base64[0] ?? ""), (c) => c.charCodeAt(0)),
  );
  ${outcome}
  return { status: 200, body: JSON.stringify({ payload: chunkText.slice(0, 80) }), completed: true };
}
`;
}

/**
 * Committed trusted consumer: it selects its inputs EXCLUSIVELY through the
 * fixed root dispatch metadata record and verifies that the record names the
 * exact expected request/upstream paths and the exact ordered trusted ids. A
 * missing, malformed or differently-selected dispatcher exits 3 (settled,
 * non-intended), so a missing dispatcher can never pass.
 */
function gatewayConsumerSource(
  expectedIds: readonly string[] = [GATEWAY_TEST_ID],
): string {
  return `import { handleStreamTrace } from "../src/app.ts";
const expectedRequest = "${GATEWAY_REQUEST_PATH}";
const expectedUpstream = "${GATEWAY_UPSTREAM_PATH}";
const expectedIds = ${JSON.stringify(expectedIds)};
const dispatchBytes = await Deno.readFile("${SENTINEL_REPLAY_INPUT_PATH}");
if (dispatchBytes.byteLength > 16 * 1024) Deno.exit(3);
const dispatch = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(dispatchBytes));
if (dispatch.version !== "v1") Deno.exit(3);
if (Object.keys(dispatch).sort().join(",") !== "requestPath,testIds,upstreamPath,version") Deno.exit(3);
if (dispatch.requestPath !== expectedRequest) Deno.exit(3);
if (dispatch.upstreamPath !== expectedUpstream) Deno.exit(3);
if (JSON.stringify(dispatch.testIds) !== JSON.stringify(expectedIds)) Deno.exit(3);
const request = JSON.parse(await Deno.readTextFile(dispatch.requestPath));
const upstream = JSON.parse(await Deno.readTextFile(dispatch.upstreamPath));
const outcome = handleStreamTrace(request, upstream);
for (const id of expectedIds) console.log("sentinel-replay-test:" + id);
if (outcome.status === 502) {
  console.error("stream terminated unexpectedly");
  Deno.exit(1);
}
if (outcome.status === 200) Deno.exit(0);
console.error("unsupported outcome");
Deno.exit(2);
`;
}

/** Permanent regression test: the same dispatch-driven input selection. */
function gatewayRegressionSource(
  expectedIds: readonly string[] = [GATEWAY_TEST_ID],
): string {
  return `import assert from "node:assert/strict";
import { handleStreamTrace } from "../src/app.ts";

Deno.test("gateway: recorded stream termination regression", async () => {
  const expectedRequest = "${GATEWAY_REQUEST_PATH}";
  const expectedUpstream = "${GATEWAY_UPSTREAM_PATH}";
  const dispatchBytes = await Deno.readFile("${SENTINEL_REPLAY_INPUT_PATH}");
  assert.ok(dispatchBytes.byteLength <= 16 * 1024);
  const dispatch = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(dispatchBytes));
  assert.equal(dispatch.version, "v1");
  assert.deepEqual(Object.keys(dispatch).sort(), ["requestPath", "testIds", "upstreamPath", "version"]);
  assert.equal(dispatch.requestPath, expectedRequest);
  assert.equal(dispatch.upstreamPath, expectedUpstream);
  assert.deepEqual(dispatch.testIds, ${JSON.stringify(expectedIds)});
  const request = JSON.parse(await Deno.readTextFile(dispatch.requestPath));
  const upstream = JSON.parse(await Deno.readTextFile(dispatch.upstreamPath));
  const outcome = handleStreamTrace(request, upstream);
  assert.equal(outcome.status, 200, "expected 200 but got " + outcome.status + ": " + outcome.body);
  for (const id of ${JSON.stringify(expectedIds)}) {
    console.log("sentinel-replay-test:" + id);
  }
});
`;
}

interface GatewayToyV1 {
  root: string;
  env: Record<string, string>;
  originalSha: GitSha;
  cleanup(): Promise<void>;
}

async function makeGatewayToy(
  root: string,
  expectedIds: readonly string[] = [GATEWAY_TEST_ID],
): Promise<GatewayToyV1> {
  await Deno.mkdir(root, { recursive: true });
  const env = testGitEnv(`${root}/home`);
  await Deno.mkdir(`${root}/home`, { recursive: true });
  const init = await gitRun(root, ["init", "-q", "-b", "main"], env);
  assert.ok(init.ok, `gateway toy init failed: ${init.stderr}`);
  await commitWith(root, env, {
    "deno.json": GATEWAY_DENO_JSON,
    "src/app.ts": gatewayAppSource("original"),
    "scripts/replay.ts": gatewayConsumerSource(expectedIds),
    "tests/regression_test.ts": gatewayRegressionSource(expectedIds),
  }, "gateway toy original: recorded stream termination produces 502");
  const originalSha = await revParse(root, env);
  return {
    root,
    env,
    originalSha,
    cleanup: () => Deno.remove(root, { recursive: true }).catch(() => {}),
  };
}

async function commitGatewayCandidate(
  toy: GatewayToyV1,
  extra: Record<string, string> = {},
): Promise<GitSha> {
  return await commitWith(toy.root, toy.env, {
    "src/app.ts": gatewayAppSource("fixed"),
    [GATEWAY_REQUEST_PATH]: GATEWAY_REQUEST_TEXT,
    [GATEWAY_UPSTREAM_PATH]: GATEWAY_UPSTREAM_TEXT,
    ...extra,
  }, "gateway toy candidate: fix + permanent recorded fixture");
}

async function gatewayBundle(
  testIds: readonly string[] = [GATEWAY_TEST_ID],
  entries?: { path: string; bytes: Uint8Array }[],
): Promise<{ bundle: ResolvedFixtureV1; digest: FixtureDigest; ref: string }> {
  const bundleEntries = entries ?? [
    { path: GATEWAY_REQUEST_PATH, bytes: text.encode(GATEWAY_REQUEST_TEXT) },
    { path: GATEWAY_UPSTREAM_PATH, bytes: text.encode(GATEWAY_UPSTREAM_TEXT) },
  ];
  const digest = await computeReplayFixtureDigest(bundleEntries);
  const ref =
    `fixture://gateway-replay/${GATEWAY_INCIDENT}/${GATEWAY_CAPTURE}/${digest}`;
  const bundle: ResolvedFixtureV1 = {
    testIds: [...testIds],
    expectedFailure: {
      reason: "recorded stream termination produces 502",
      match: { kind: "contains", text: "stream terminated unexpectedly" },
    },
    entries: bundleEntries,
    provenance: {
      sanitized: true,
      sanitizer: "toy-sanitizer",
      provenanceRef: "fixture://provenance/toy/gateway",
      redacted: false,
      note: "synthetic recorded gateway fixture; no credentials",
    },
  };
  return { bundle, digest, ref };
}

function gatewayPort(
  toyRoot: string,
  scratchDir: string,
  bundle: ResolvedFixtureV1,
): ReplayPortImpl {
  return new ReplayPortImpl({
    ...toyOptions(toyRoot, scratchDir),
    fixtures: { resolveFixture: () => Promise.resolve(portOk(bundle)) },
  });
}

function gatewayRequest(
  bundle: ResolvedFixtureV1,
  ref: string,
  digest: FixtureDigest,
  revision: GitSha,
  overrides: Record<string, unknown> = {},
): ReplayRunRequestV1 {
  return {
    taskId: "incident:gateway-0001" as WorkItemId,
    repository: TOY_REPOSITORY,
    revision,
    commandId: "replay" as CommandId,
    fixtureRef: ref,
    fixtureDigest: digest,
    testIds: bundle.testIds,
    outputLimitBytes: 262_144,
    ...overrides,
  } as ReplayRunRequestV1;
}

Deno.test(
  "gateway dispatch: fail-before/pass-after materializes the dispatcher for both replay and test commands",
  async () => {
    await withFixture(async (root) => {
      const toy = await makeGatewayToy(`${root}/toy`);
      try {
        const { bundle, digest, ref } = await gatewayBundle();
        const port = gatewayPort(toy.root, `${root}/scratch`, bundle);

        // Original revision: the dispatcher is materialized OUTSIDE the
        // two-entry bundle and the committed consumer selects the exact
        // fixture through it; a missing dispatcher would exit 3 and could
        // never be an intended failure.
        const before = assertPortOk(
          await port.runReplay(
            gatewayRequest(bundle, ref, digest, toy.originalSha),
          ),
        );
        assert.equal(before.outcome, "failed");
        assert.equal(before.exitCode, 1);
        assert.equal(before.failure?.intended, true);
        assert.deepEqual(before.limitations, []);

        // Candidate revision: the two fixture entries are committed but the
        // dispatcher is NOT, so the passing regression depends on ReplayPort
        // materializing it — and the ordinary test command (not the replay
        // command) receives the same trusted metadata.
        const candidateSha = await commitGatewayCandidate(toy);
        const after = assertPortOk(
          await port.runReplay(
            gatewayRequest(bundle, ref, digest, candidateSha, {
              commandId: "test",
            }),
          ),
        );
        assert.equal(after.outcome, "passed");
        assert.equal(after.exitCode, 0);
        assert.deepEqual(after.limitations, []);

        // The shared source working directory is untouched.
        const status = await gitRun(
          toy.root,
          ["status", "--porcelain"],
          toy.env,
        );
        assert.equal(status.stdout.trim(), "");
      } finally {
        await toy.cleanup();
      }
    });
  },
);

Deno.test(
  "gateway dispatch: a candidate that already carries the byte-identical dispatcher is accepted untouched",
  async () => {
    await withFixture(async (root) => {
      const toy = await makeGatewayToy(`${root}/toy`);
      try {
        const { bundle, digest, ref } = await gatewayBundle();
        const candidateSha = await commitGatewayCandidate(toy, {
          [SENTINEL_REPLAY_INPUT_PATH]: gatewayDispatchText(),
        });
        const port = gatewayPort(toy.root, `${root}/scratch`, bundle);
        const after = assertPortOk(
          await port.runReplay(
            gatewayRequest(bundle, ref, digest, candidateSha, {
              commandId: "test",
            }),
          ),
        );
        assert.equal(after.outcome, "passed");
        assert.equal(after.exitCode, 0);
        assert.deepEqual(after.limitations, []);

        // The delivered bytes are exactly the canonical record, untouched by
        // the replay materialization.
        const committed = await gitRun(
          toy.root,
          ["show", `${candidateSha}:${SENTINEL_REPLAY_INPUT_PATH}`],
          toy.env,
        );
        assert.ok(committed.ok, `show failed: ${committed.stderr}`);
        assert.equal(committed.stdout, gatewayDispatchText());
      } finally {
        await toy.cleanup();
      }
    });
  },
);

Deno.test(
  "gateway dispatch: foreign dispatcher bytes are rejected and never rewritten",
  async () => {
    await withFixture(async (root) => {
      const toy = await makeGatewayToy(`${root}/toy`);
      try {
        const { bundle, digest, ref } = await gatewayBundle();
        const foreign = JSON.stringify({
          version: "v1",
          requestPath: "tests/elsewhere/request.json",
          upstreamPath: "tests/elsewhere/upstream.json",
          testIds: [GATEWAY_TEST_ID],
        });
        const candidateSha = await commitGatewayCandidate(toy, {
          [SENTINEL_REPLAY_INPUT_PATH]: foreign,
        });
        const result = await gatewayPort(
          toy.root,
          `${root}/scratch`,
          bundle,
        ).runReplay(
          gatewayRequest(bundle, ref, digest, candidateSha, {
            commandId: "test",
          }),
        );
        assert.ok(!result.ok, "foreign dispatcher bytes must fail closed");
        assert.equal(result.error.kind, "invalid");
        assert.match(result.error.detail, /different bytes/);
        assert.match(result.error.detail, /\.sentinel-replay-input\.json/);

        // The committed foreign bytes are unchanged (never rewritten).
        const committed = await gitRun(
          toy.root,
          ["show", `${candidateSha}:${SENTINEL_REPLAY_INPUT_PATH}`],
          toy.env,
        );
        assert.ok(committed.ok);
        assert.equal(committed.stdout, foreign);
      } finally {
        await toy.cleanup();
      }
    });
  },
);

Deno.test(
  "gateway dispatch: symlinked and directory dispatcher targets are rejected",
  async () => {
    await withFixture(async (root) => {
      const { bundle, digest, ref } = await gatewayBundle();

      // A symlink AT the dispatcher path (committed as a gitlink entry).
      const linkToy = await makeGatewayToy(`${root}/toy-link`);
      try {
        const symlinkSha = await commitSymlink(
          linkToy.root,
          linkToy.env,
          SENTINEL_REPLAY_INPUT_PATH,
          "deno.json",
        );
        const asLink = await gatewayPort(
          linkToy.root,
          `${root}/scratch-link`,
          bundle,
        ).runReplay(gatewayRequest(bundle, ref, digest, symlinkSha));
        assert.ok(!asLink.ok, "symlinked dispatcher must fail closed");
        assert.equal(asLink.error.kind, "invalid");
        assert.match(asLink.error.detail, /resolves through a symlink/);
      } finally {
        await linkToy.cleanup();
      }

      // A directory at the dispatcher path (git cannot track an empty
      // directory, so it holds one file).
      const dirToy = await makeGatewayToy(`${root}/toy-dir`);
      try {
        const dirSha = await commitWith(dirToy.root, dirToy.env, {
          [`${SENTINEL_REPLAY_INPUT_PATH}/deeper.txt`]: "x",
        }, "gateway toy tamper: dispatcher target is a directory");
        const asDir = await gatewayPort(
          dirToy.root,
          `${root}/scratch-dir`,
          bundle,
        ).runReplay(gatewayRequest(bundle, ref, digest, dirSha));
        assert.ok(!asDir.ok, "directory dispatcher must fail closed");
        assert.equal(asDir.error.kind, "invalid");
        assert.match(asDir.error.detail, /is a directory/);
      } finally {
        await dirToy.cleanup();
      }
    });
  },
);

Deno.test(
  "gateway dispatch: missing, ambiguous or extra gateway bundle entries are rejected",
  async () => {
    await withFixture(async (root) => {
      const toy = await makeGatewayToy(`${root}/toy`);
      try {
        const expected = {
          request: {
            path: GATEWAY_REQUEST_PATH,
            bytes: text.encode(GATEWAY_REQUEST_TEXT),
          },
          upstream: {
            path: GATEWAY_UPSTREAM_PATH,
            bytes: text.encode(GATEWAY_UPSTREAM_TEXT),
          },
        };

        // Extra entry (a third file in the gateway bundle).
        const extra = await gatewayBundle([GATEWAY_TEST_ID], [
          expected.request,
          expected.upstream,
          { path: `${GATEWAY_DIR}/extra.json`, bytes: text.encode("{}") },
        ]);
        const extraRun = await gatewayPort(
          toy.root,
          `${root}/scratch-extra`,
          extra.bundle,
        ).runReplay(
          gatewayRequest(
            extra.bundle,
            extra.ref,
            extra.digest,
            toy.originalSha,
          ),
        );
        assert.ok(!extraRun.ok, "an extra entry must fail closed");
        assert.equal(extraRun.error.kind, "invalid");
        assert.match(
          extraRun.error.detail,
          /exactly the fixed request and upstream entries/,
        );

        // Wrong capture directory: the two paths are not the resolved ones.
        const wrongDir = await gatewayBundle([GATEWAY_TEST_ID], [
          {
            path:
              `tests/fixtures/gateway-replay/${GATEWAY_INCIDENT}/other-capture/request.json`,
            bytes: text.encode(GATEWAY_REQUEST_TEXT),
          },
          expected.upstream,
        ]);
        const wrongDirRun = await gatewayPort(
          toy.root,
          `${root}/scratch-wrong-dir`,
          wrongDir.bundle,
        ).runReplay(
          gatewayRequest(
            wrongDir.bundle,
            wrongDir.ref,
            wrongDir.digest,
            toy.originalSha,
          ),
        );
        assert.ok(!wrongDirRun.ok, "wrong selected paths must fail closed");
        assert.equal(wrongDirRun.error.kind, "invalid");
        assert.match(
          wrongDirRun.error.detail,
          /exactly the fixed request and upstream entries/,
        );

        // Ambiguous (duplicate) entry path: rejected by the bundle validation
        // before any command can run.
        const duplicate = await gatewayBundle([GATEWAY_TEST_ID], [
          expected.request,
          expected.request,
        ]);
        const duplicateRun = await gatewayPort(
          toy.root,
          `${root}/scratch-duplicate`,
          duplicate.bundle,
        ).runReplay(
          gatewayRequest(
            duplicate.bundle,
            duplicate.ref,
            duplicate.digest,
            toy.originalSha,
          ),
        );
        assert.ok(!duplicateRun.ok, "an ambiguous entry must fail closed");
        assert.equal(duplicateRun.error.kind, "invalid");
        assert.match(duplicateRun.error.detail, /duplicate fixture entry path/);
      } finally {
        await toy.cleanup();
      }
    });
  },
);

Deno.test(
  "gateway dispatch: a malformed reserved gateway reference is rejected instead of falling back",
  async () => {
    await withFixture(async (root) => {
      const toy = await makeGatewayToy(`${root}/toy`);
      try {
        const { bundle, digest } = await gatewayBundle();
        // Reserved gateway references outside the frozen grammar: a capture id
        // containing a colon (allowed by the restricted-ref pattern but never
        // by the gateway identity grammar) and the bare reserved namespace
        // (no trailing slash or path).
        for (
          const malformedRef of [
            `fixture://gateway-replay/${GATEWAY_INCIDENT}/capture:broken/${digest}`,
            "fixture://gateway-replay",
          ]
        ) {
          const result = await gatewayPort(
            toy.root,
            `${root}/scratch`,
            bundle,
          ).runReplay(
            gatewayRequest(bundle, malformedRef, digest, toy.originalSha),
          );
          assert.ok(
            !result.ok,
            `reserved reference ${malformedRef} must fail closed`,
          );
          assert.equal(result.error.kind, "invalid");
          assert.match(
            result.error.detail,
            /malformed gateway fixture reference/,
          );
        }
      } finally {
        await toy.cleanup();
      }
    });
  },
);

Deno.test(
  "gateway dispatch: metadata binds the trusted resolved ids and rejects a different id set",
  async () => {
    await withFixture(async (root) => {
      const resolvedIds = [GATEWAY_TEST_ID, GATEWAY_TEST_ID_B];
      const toy = await makeGatewayToy(`${root}/toy`, resolvedIds);
      try {
        const { bundle, digest, ref } = await gatewayBundle(resolvedIds);
        const candidateSha = await commitGatewayCandidate(toy);
        const port = gatewayPort(toy.root, `${root}/scratch`, bundle);

        // The request lists the same id SET in a different order: the
        // identity check is exact-set, and the metadata must bind the trusted
        // resolved order the committed consumer verifies.
        const reordered = assertPortOk(
          await port.runReplay(
            gatewayRequest(bundle, ref, digest, candidateSha, {
              commandId: "test",
              testIds: [GATEWAY_TEST_ID_B, GATEWAY_TEST_ID],
            }),
          ),
        );
        assert.equal(reordered.outcome, "passed");
        assert.equal(reordered.exitCode, 0);

        // A request whose id set differs from the resolved identity is
        // rejected before any command runs.
        const mismatched = await port.runReplay(
          gatewayRequest(bundle, ref, digest, candidateSha, {
            testIds: [GATEWAY_TEST_ID],
          }),
        );
        assert.ok(!mismatched.ok, "a different id set must fail closed");
        assert.equal(mismatched.error.kind, "invalid");
        assert.match(mismatched.error.detail, /test identity/);
      } finally {
        await toy.cleanup();
      }
    });
  },
);

Deno.test(
  "gateway dispatch: non-gateway references are unchanged and receive no dispatcher",
  async () => {
    await withFixture(async (root) => {
      const toy = await makeGatewayToy(`${root}/toy`);
      try {
        const { bundle, digest } = await gatewayBundle();
        // The same gateway-shaped bundle under a non-gateway reference: no
        // dispatcher is materialized, so the metadata-reading consumer exits
        // without the trusted marker and the run is never an intended
        // regression.
        const nonGatewayRef = "fixture://captures/toy/gateway.json";
        const run = assertPortOk(
          await gatewayPort(toy.root, `${root}/scratch`, bundle).runReplay(
            gatewayRequest(bundle, nonGatewayRef, digest, toy.originalSha),
          ),
        );
        assert.equal(run.outcome, "failed");
        assert.equal(run.failure?.intended, false);
      } finally {
        await toy.cleanup();
      }
    });
  },
);
