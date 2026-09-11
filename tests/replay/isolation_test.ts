// Linux replay isolation suite (T05a): compact deterministic
// argv/mount/environment/scratch-boundary checks with a RECORDING runtime
// (not a second sandbox implementation) plus Linux-only REAL bwrap runs with
// Deno. No credentials, no model calls, no paid or successful external
// network use, no unrelated processes touched, and every temp directory is
// test-owned and removed while preserving the primary failure.
//
// Missing bwrap on Linux is a REAL test failure (not a skip); non-Linux hosts
// skip the bwrap-dependent cases explicitly.
import assert from "node:assert/strict";
import { LinuxReplayIsolation } from "../../src/replay/isolation.ts";
import type { ReplayCheckoutAccessV1 } from "../../src/replay/isolation.ts";
import type { ReplayIsolationAttestationV1 } from "../../src/replay/port.ts";
import type {
  ReplayCommandInputV1,
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";

const LINUX = Deno.build.os === "linux";
const here = new URL(import.meta.url);
if (here.protocol !== "file:") throw new Error("expected a file: test module");
const testsDir = decodeURIComponent(here.pathname).replace(
  /\/isolation_test\.ts$/,
  "",
);

interface Sandbox {
  scratchRoot: string;
  checkout: string;
}

/** Test-owned disposable scratch: one scratch root and one checkout inside. */
async function withSandbox<T>(
  fn: (sandbox: Sandbox) => T | Promise<T>,
): Promise<T> {
  const scratchRoot = await Deno.makeTempDir({
    prefix: ".replay-isolation-",
    dir: testsDir,
  });
  const checkout = `${scratchRoot}/checkout`;
  await Deno.mkdir(checkout);
  try {
    return await fn({ scratchRoot, checkout });
  } finally {
    await Deno.remove(scratchRoot, { recursive: true }).catch(() => {});
  }
}

function command(
  cwd: string,
  overrides: Partial<ReplayCommandInputV1> = {},
): ReplayCommandInputV1 {
  return {
    executable: "deno",
    args: ["--version"],
    cwd,
    env: {},
    maxDurationMs: 3000,
    maxOutputBytes: 64 * 1024,
    ...overrides,
  };
}

function result(
  overrides: Partial<ReplayCommandResultV1> = {},
): ReplayCommandResultV1 {
  return {
    outcome: "exited",
    exitCode: 0,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    truncated: false,
    settled: true,
    detail: "recorded",
    ...overrides,
  };
}

/** Recording runtime: captures the composed bwrap invocation, never spawns. */
class RecordingRuntime implements ReplayRuntimeV1 {
  readonly calls: ReplayCommandInputV1[] = [];
  constructor(private readonly recorded: ReplayCommandResultV1) {}

  run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
    this.calls.push({ ...input, args: [...input.args] });
    return Promise.resolve(this.recorded);
  }
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function lastJsonLine(bytes: Uint8Array): Record<string, unknown> {
  const lines = decode(bytes).split("\n").filter((line) =>
    line.trim().length > 0
  );
  const line = lines[lines.length - 1];
  assert.ok(line !== undefined, "expected JSON on stdout");
  return JSON.parse(line) as Record<string, unknown>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Deterministic checks (no bwrap needed)
// ---------------------------------------------------------------------------

Deno.test("isolation constructor rejects an untrusted scratch root", async () => {
  assert.throws(() => new LinuxReplayIsolation("/"), TypeError);
  assert.throws(() => new LinuxReplayIsolation("relative/scratch"), TypeError);
  assert.throws(() => new LinuxReplayIsolation(""), TypeError);
  assert.throws(
    () =>
      new LinuxReplayIsolation(
        `${testsDir}/.replay-missing-${crypto.randomUUID()}`,
      ),
    TypeError,
  );
  assert.throws(
    () => new LinuxReplayIsolation(`${testsDir}/isolation_test.ts`),
    TypeError,
  );
  await withSandbox(({ scratchRoot }) => {
    const iso = new LinuxReplayIsolation(scratchRoot);
    const attestation: ReplayIsolationAttestationV1 = iso.attestation;
    assert.equal(attestation.version, "v1");
    assert.equal(attestation.restrictedExecution, true);
    for (
      const value of [
        attestation.host,
        attestation.boundary,
        attestation.attestationRef,
      ]
    ) {
      assert.equal(typeof value, "string");
      assert.ok(value.length > 0, "attestation text must be descriptive");
    }
    assert.match(attestation.boundary, /bubblewrap/);
    assert.equal(
      new LinuxReplayIsolation(scratchRoot).attestation.attestationRef,
      attestation.attestationRef,
    );
  });
});

Deno.test("isolation fails closed on non-Linux platforms and invalid access", async () => {
  await withSandbox(async ({ scratchRoot, checkout }) => {
    const runtime = new RecordingRuntime(result());
    const unsupported = new LinuxReplayIsolation(scratchRoot, {
      runtime,
      osName: "darwin",
    });
    const platform = await unsupported.run(command(checkout), "read-write");
    assert.equal(platform.outcome, "spawn_failed");
    assert.equal(platform.settled, true);
    assert.equal(platform.exitCode, null);
    assert.equal(platform.stdout.byteLength, 0);
    assert.equal(platform.stderr.byteLength, 0);
    assert.match(platform.detail, /Linux/);

    const linux = new LinuxReplayIsolation(scratchRoot, {
      runtime,
      osName: "linux",
    });
    const invalidAccess: unknown[] = [
      "read-only ",
      "READ-ONLY",
      "write",
      "",
      undefined,
      null,
      true,
      1,
    ];
    for (const access of invalidAccess) {
      const denied = await linux.run(
        command(checkout),
        access as ReplayCheckoutAccessV1,
      );
      assert.equal(denied.outcome, "spawn_failed", `access ${String(access)}`);
      assert.equal(denied.settled, true);
      assert.equal(denied.exitCode, null);
    }
    assert.equal(runtime.calls.length, 0, "rejections must not spawn");
  });
});

Deno.test("isolation rejects invalid inputs and cwds outside the scratch root", async () => {
  await withSandbox(async ({ scratchRoot, checkout }) => {
    const runtime = new RecordingRuntime(result());
    const iso = new LinuxReplayIsolation(scratchRoot, {
      runtime,
      osName: "linux",
    });
    await Deno.writeTextFile(`${checkout}/not-a-dir`, "file");
    await Deno.mkdir(`${scratchRoot}/sibling`);

    const badCwds = [
      scratchRoot, // must be a STRICT descendant
      `${scratchRoot}/sibling/../../..`,
      testsDir,
      `${checkout}/not-a-dir`,
      `${scratchRoot}/missing-${crypto.randomUUID()}`,
      "checkout",
      "/",
    ];
    for (const cwd of badCwds) {
      const denied = await iso.run(command(cwd), "read-only");
      assert.equal(denied.outcome, "spawn_failed", `cwd ${cwd}`);
      assert.equal(denied.settled, true);
      assert.equal(denied.exitCode, null);
      assert.equal(denied.stdout.byteLength, 0);
      assert.equal(denied.stderr.byteLength, 0);
    }

    const badInputs: unknown[] = [
      null,
      true,
      command(checkout, { executable: "" }),
      command(checkout, { executable: true as unknown as string }),
      command(checkout, { args: true as unknown as string[] }),
      command(checkout, { args: ["ok", 7 as unknown as string] }),
      command(checkout, { cwd: undefined as unknown as string }),
      command(checkout, { maxDurationMs: 0 }),
      command(checkout, { maxDurationMs: true as unknown as number }),
      command(checkout, { maxOutputBytes: Number.NaN }),
    ];
    for (const bad of badInputs) {
      const denied = await iso.run(bad as ReplayCommandInputV1, "read-only");
      assert.equal(denied.outcome, "spawn_failed");
      assert.equal(denied.settled, true);
    }
    assert.equal(runtime.calls.length, 0, "rejections must not spawn");
  });
});

// ---------------------------------------------------------------------------
// Deterministic argv/mount/environment composition (needs bwrap present)
// ---------------------------------------------------------------------------

Deno.test({
  name: "isolation rejects missing, non-regular and escaping executables",
  ignore: !LINUX,
  fn: async () => {
    await withSandbox(async ({ scratchRoot, checkout }) => {
      const runtime = new RecordingRuntime(result());
      const iso = new LinuxReplayIsolation(scratchRoot, { runtime });
      await Deno.writeTextFile(`${checkout}/tool.sh`, "#!/bin/sh\nexit 0\n");
      await Deno.mkdir(`${scratchRoot}/sibling`);
      await Deno.writeTextFile(
        `${scratchRoot}/sibling/tool.sh`,
        "#!/bin/sh\nexit 0\n",
      );

      const badExecutables = [
        "/usr/bin", // non-regular
        `/usr/bin/sentinel-t05-${crypto.randomUUID()}`, // missing
        `${scratchRoot}/sibling/tool.sh`, // outside /usr and the checkout
        "../sibling/tool.sh", // relative escape
        "./missing-tool.sh", // relative missing
        `sentinel-t05-missing-${crypto.randomUUID()}`, // bare missing
      ];
      for (const executable of badExecutables) {
        const denied = await iso.run(
          command(checkout, { executable }),
          "read-only",
        );
        assert.equal(denied.outcome, "spawn_failed", executable);
        assert.equal(denied.settled, true);
        assert.equal(denied.exitCode, null);
      }
      assert.equal(runtime.calls.length, 0, "rejections must not spawn");
    });
  },
});

Deno.test({
  name: "isolation composes the fixed bwrap argv and sandbox environment",
  ignore: !LINUX,
  fn: async () => {
    await withSandbox(async ({ scratchRoot, checkout }) => {
      const recorded = result({
        stdout: new TextEncoder().encode("recorded"),
      });
      const runtime = new RecordingRuntime(recorded);
      const iso = new LinuxReplayIsolation(scratchRoot, { runtime });
      await Deno.writeTextFile(`${checkout}/tool.sh`, "#!/bin/sh\nexit 0\n");
      const realScratch = await Deno.realPath(scratchRoot);
      const realCheckout = await Deno.realPath(checkout);

      const canary = `sentinel-t05-env-${crypto.randomUUID()}`;
      const argv = [
        "--flag",
        "value with spaces",
        "$(echo pwned)",
        ";",
        "--",
        "-x",
      ];
      const composed = command(checkout, {
        executable: "./tool.sh",
        args: argv,
        env: { SENTINEL_T05_ENV_CANARY: canary },
        maxDurationMs: 1234,
        maxOutputBytes: 4567,
      });

      const returned = await iso.run(composed, "read-write");
      assert.equal(returned, recorded, "runtime result must pass through");
      assert.equal(runtime.calls.length, 1);
      const call = runtime.calls[0];
      assert.equal(call.executable, "/usr/bin/bwrap");
      assert.equal(call.cwd, "/");
      assert.deepEqual(call.env, {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        NODE_V8_COVERAGE: "",
      });
      assert.equal(call.maxDurationMs, 1234);
      assert.equal(call.maxOutputBytes, 4567);

      const fixedPrefix = [
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
        "--setenv",
        "PATH",
        "/usr/local/bin:/usr/bin:/bin",
        "--setenv",
        "HOME",
        "/tmp/home",
        "--setenv",
        "DENO_DIR",
        "/tmp/deno",
        "--setenv",
        "TMPDIR",
        "/tmp",
        "--setenv",
        "NO_COLOR",
        "1",
        "--setenv",
        "NODE_V8_COVERAGE",
        "",
        "--ro-bind",
        "/usr",
        "/usr",
        "--symlink",
        "usr/bin",
        "/bin",
        "--symlink",
        "usr/lib",
        "/lib",
        "--symlink",
        "usr/lib64",
        "/lib64",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--dir",
        "/tmp/home",
        "--dir",
        "/tmp/deno",
      ];
      assert.deepEqual(call.args.slice(0, fixedPrefix.length), fixedPrefix);

      const tailLength = 7 + argv.length;
      assert.deepEqual(call.args.slice(-tailLength), [
        "--bind",
        realCheckout,
        realCheckout,
        "--chdir",
        realCheckout,
        "--",
        `${realCheckout}/tool.sh`,
        ...argv,
      ]);
      const dirs = call.args.flatMap((arg, index) =>
        arg === "--dir" ? [call.args[index + 1]] : []
      );
      assert.ok(
        dirs.includes(realScratch),
        "the checkout's parent directory must be created",
      );
      const mounts: Array<[string, string]> = [];
      for (let i = 0; i < call.args.length - 2; i++) {
        if (call.args[i] === "--bind" || call.args[i] === "--ro-bind") {
          mounts.push([call.args[i + 1], call.args[i + 2]]);
        }
      }
      assert.deepEqual(mounts, [["/usr", "/usr"], [
        realCheckout,
        realCheckout,
      ]], "only /usr and the exact checkout may be mounted");
      assert.ok(
        !call.args.some((arg) => arg.includes(canary)),
        "input.env must never reach the sandbox",
      );

      const readOnly = await iso.run(composed, "read-only");
      assert.equal(readOnly, recorded);
      assert.deepEqual(
        runtime.calls[1].args.slice(-tailLength),
        [
          "--ro-bind",
          realCheckout,
          realCheckout,
          "--chdir",
          realCheckout,
          "--",
          `${realCheckout}/tool.sh`,
          ...argv,
        ],
      );

      const bare = await iso.run(
        command(checkout, { executable: "env", args: [] }),
        "read-only",
      );
      assert.equal(bare, recorded);
      const bareArgs = runtime.calls[2].args;
      assert.equal(bareArgs[bareArgs.length - 2], "--");
      assert.match(bareArgs[bareArgs.length - 1], /^\/usr\/.*\/env$/);
    });
  },
});

// ---------------------------------------------------------------------------
// Linux-only real bwrap runs
// ---------------------------------------------------------------------------

Deno.test({
  name: "isolation confines real commands, children, environment and network",
  ignore: !LINUX,
  fn: async () => {
    await withSandbox(async ({ scratchRoot, checkout }) => {
      const canaryKey = `SENTINEL_T05_CANARY_${
        crypto.randomUUID().replace(/-/g, "")
      }`;
      const canaryValue = `canary-${crypto.randomUUID()}`;
      const siblingCanary = `${scratchRoot}/sibling/canary.txt`;
      const scratchCanary = `${scratchRoot}/scratch-canary.txt`;
      const hiddenModule = `${scratchRoot}/sibling/hidden.ts`;
      await Deno.writeTextFile(`${checkout}/probe-input.txt`, "own-input");
      await Deno.mkdir(`${scratchRoot}/sibling`);
      await Deno.writeTextFile(siblingCanary, "sibling-canary");
      await Deno.writeTextFile(scratchCanary, "scratch-canary");
      await Deno.writeTextFile(hiddenModule, "export const hidden = 1;\n");

      // A child command with the SAME permissions must remain inside the
      // boundary (mount namespace, not Deno permissions, is the boundary).
      const childCode = `try { await Deno.readTextFile(${
        JSON.stringify(siblingCanary)
      }); console.log("escaped"); } catch { console.log("blocked"); }`;
      const probe = `
const out = {
  cwd: Deno.cwd(),
  env: Deno.env.toObject(),
  readOwn: false,
  wroteOwn: false,
  readScratchCanary: false,
  readSiblingCanary: false,
  importedSibling: false,
  childRan: false,
  childEscaped: false,
  interfaces: [],
  net: "unknown",
};
try { out.readOwn = (await Deno.readTextFile("probe-input.txt")) === "own-input"; } catch {}
try { await Deno.writeTextFile("probe-output.txt", "written"); out.wroteOwn = true; } catch {}
try { await Deno.readTextFile(${
        JSON.stringify(scratchCanary)
      }); out.readScratchCanary = true; } catch {}
try { await Deno.readTextFile(${
        JSON.stringify(siblingCanary)
      }); out.readSiblingCanary = true; } catch {}
try { await import(${
        JSON.stringify(hiddenModule)
      }); out.importedSibling = true; } catch {}
out.interfaces = (await Deno.readTextFile("/proc/net/dev")).split("\\n")
  .filter((line) => line.includes(":"))
  .map((line) => line.split(":")[0].trim())
  .filter((name) => name.length > 0);
try { const conn = await Deno.connect({ hostname: "1.1.1.1", port: 80 }); conn.close(); out.net = "connected"; } catch { out.net = "denied"; }
const child = await new Deno.Command(Deno.execPath(), {
  args: ["eval", "--allow-all", ${JSON.stringify(childCode)}],
  stdout: "piped",
  stderr: "piped",
}).output();
out.childRan = child.success;
out.childEscaped = new TextDecoder().decode(child.stdout).includes("escaped");
console.log(JSON.stringify(out));
`;

      const iso = new LinuxReplayIsolation(scratchRoot);
      const run = await iso.run({
        executable: "deno",
        args: ["eval", "--allow-all", probe],
        cwd: checkout,
        env: { [canaryKey]: canaryValue },
        maxDurationMs: 3000,
        maxOutputBytes: 64 * 1024,
      }, "read-write");

      assert.equal(run.settled, true, run.detail);
      assert.equal(
        run.outcome,
        "exited",
        `${run.detail} ${decode(run.stderr)}`,
      );
      assert.equal(run.exitCode, 0, decode(run.stderr));
      const out = lastJsonLine(run.stdout);
      const realCheckout = await Deno.realPath(checkout);
      assert.equal(out.cwd, realCheckout);
      assert.equal(out.readOwn, true);
      assert.equal(out.wroteOwn, true);
      assert.equal(out.readScratchCanary, false, "scratch root is not mounted");
      assert.equal(
        out.readSiblingCanary,
        false,
        "sibling checkout is not mounted",
      );
      assert.equal(
        out.importedSibling,
        false,
        "dynamic import cannot escape the boundary",
      );
      assert.equal(out.childRan, true);
      assert.equal(out.childEscaped, false, "children share the boundary");
      assert.equal(out.net, "denied", "external network is denied");
      assert.deepEqual(out.interfaces, ["lo"]);
      const env = out.env as Record<string, string>;
      // Observed Deno may prepend only its private cache shim directory
      // (node_compat_bin under the fixed DENO_DIR=/tmp/deno) to PATH. Accept
      // exactly that value or the bare sandbox PATH; no other variant.
      assert.ok(
        env.PATH === "/usr/local/bin:/usr/bin:/bin" ||
          env.PATH ===
            "/tmp/deno/node_compat_bin:/usr/local/bin:/usr/bin:/bin",
        `sandbox env PATH: ${env.PATH}`,
      );
      for (
        const [key, value] of Object.entries({
          HOME: "/tmp/home",
          DENO_DIR: "/tmp/deno",
          TMPDIR: "/tmp",
          NO_COLOR: "1",
          NODE_V8_COVERAGE: "",
        })
      ) {
        assert.equal(env[key], value, `sandbox env ${key}`);
      }
      // No incoming and no representative host variable may be forwarded.
      // bwrap itself owns the sandbox PWD (its --chdir working directory,
      // since --clearenv unsets all but PWD before it applies --chdir) and may
      // add at most its own container marker; PWD is therefore asserted for
      // its exact sandbox value below instead of absence.
      assert.ok(
        !Object.hasOwn(env, canaryKey),
        "input.env must not be forwarded",
      );
      for (
        const hostKey of [
          "SHELL",
          "USER",
          "LOGNAME",
          "LANG",
          "SSH_AUTH_SOCK",
        ]
      ) {
        assert.ok(
          !Object.hasOwn(env, hostKey),
          `host env ${hostKey} must not be forwarded`,
        );
      }
      assert.ok(
        Object.hasOwn(env, "PWD"),
        "bwrap must supply the sandbox working directory as PWD",
      );
      assert.equal(
        env.PWD,
        realCheckout,
        `sandbox env PWD must be the exact checkout: ${String(env.PWD)}`,
      );
      assert.ok(
        Object.keys(env).length <= 8,
        `unexpected sandbox environment: ${Object.keys(env).join(",")}`,
      );
      assert.ok(!decode(run.stdout).includes(canaryValue));

      // Host-visible effects: only the exact checkout changed.
      assert.equal(
        await Deno.readTextFile(`${checkout}/probe-output.txt`),
        "written",
      );
      assert.equal(
        await Deno.readTextFile(`${checkout}/probe-input.txt`),
        "own-input",
      );
      assert.equal(await Deno.readTextFile(siblingCanary), "sibling-canary");
      assert.equal(await Deno.readTextFile(scratchCanary), "scratch-canary");
    });
  },
});

Deno.test({
  name: "isolation read-only access denies writes to the checkout",
  ignore: !LINUX,
  fn: async () => {
    await withSandbox(async ({ scratchRoot, checkout }) => {
      await Deno.writeTextFile(`${checkout}/probe-input.txt`, "own-input");
      const probe = `
const out = { read: null, wrote: false };
try { out.read = await Deno.readTextFile("probe-input.txt"); } catch {}
try { await Deno.writeTextFile("probe-output.txt", "written"); out.wrote = true; } catch {}
console.log(JSON.stringify(out));
`;
      const iso = new LinuxReplayIsolation(scratchRoot);
      const run = await iso.run({
        executable: "deno",
        args: ["eval", "--allow-all", probe],
        cwd: checkout,
        env: {},
        maxDurationMs: 3000,
        maxOutputBytes: 32 * 1024,
      }, "read-only");

      assert.equal(run.settled, true, run.detail);
      assert.equal(
        run.outcome,
        "exited",
        `${run.detail} ${decode(run.stderr)}`,
      );
      assert.equal(run.exitCode, 0, decode(run.stderr));
      const out = lastJsonLine(run.stdout);
      assert.equal(out.read, "own-input");
      assert.equal(out.wrote, false);
      assert.equal(await exists(`${checkout}/probe-output.txt`), false);
    });
  },
});

Deno.test({
  name: "isolation timeout and detached descendants cannot survive teardown",
  ignore: !LINUX,
  fn: async () => {
    await withSandbox(async ({ scratchRoot, checkout }) => {
      const iso = new LinuxReplayIsolation(scratchRoot);
      const timedOut = await iso.run({
        executable: "deno",
        args: ["eval", "--allow-all", "while (true) {}"],
        cwd: checkout,
        env: {},
        maxDurationMs: 1000,
        maxOutputBytes: 16 * 1024,
      }, "read-only");
      assert.equal(timedOut.outcome, "timed_out");
      assert.equal(timedOut.settled, true);
      assert.equal(timedOut.exitCode, null);

      // A detached (setsid) grandchild of the target must die with the
      // namespace; if it survived it would write this host-visible marker.
      const marker = `${checkout}/survivor-${crypto.randomUUID()}.txt`;
      const grandchild = `setTimeout(() => { Deno.writeTextFileSync(${
        JSON.stringify(marker)
      }, "alive"); }, 900);`;
      const probe = `
const { spawn } = await import("node:child_process");
const child = spawn(Deno.execPath(), ["eval", "--allow-all", ${
        JSON.stringify(grandchild)
      }], { detached: true, stdio: "ignore" });
child.unref();
console.log("spawned");
`;
      const run = await iso.run({
        executable: "deno",
        args: ["eval", "--allow-all", probe],
        cwd: checkout,
        env: {},
        maxDurationMs: 3000,
        maxOutputBytes: 16 * 1024,
      }, "read-write");
      assert.equal(run.settled, true, run.detail);
      assert.equal(
        run.outcome,
        "exited",
        `${run.detail} ${decode(run.stderr)}`,
      );
      assert.ok(decode(run.stdout).includes("spawned"));

      await delay(1400);
      assert.equal(
        await exists(marker),
        false,
        "detached descendant survived namespace teardown",
      );
    });
  },
});
