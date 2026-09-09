/**
 * Concrete trusted causal verifier tests (plan 01) + the ReplayPort proof
 * consuming boundary.
 *
 * GROUP A–C are narrow deterministic tests of the verifier boundaries with
 * an injected SCRIPTED process runtime (no real git/deno/sandbox execution):
 * constructor binding (the consumer path is bound to the fixed
 * trusted-consumer command identity, never interchangeable), fatal UTF-8
 * rejection, exact bundle identity, symlink/non-regular rejection on EVERY
 * component of BOTH input paths, exclusive input placement, private bytes
 * confined to the original snapshot, per-run home/cache separation, exact
 * test identity (extras and omissions are no evidence), intended specific
 * failure, truncation/timeout/unsettled handling (abort before the sanitized
 * execution on an unsettled original; restricted scratch preserved on
 * uncertainty) and verified cleanup before any proof is returned.
 *
 * GROUP D keeps the ReplayPort consuming boundary: an absent, structurally
 * invalid, stale or identity-mismatched proof keeps the ordinary
 * `fixture_redacted` limitation; only a fully bound proof suppresses it —
 * through the ACTUAL process runtime and real toy git revisions.
 *
 * GROUP E exercises the REAL macOS boundary (installed sandbox-exec + the
 * embedded fixed seatbelt profile + the real Deno binary over real toy git
 * snapshots): the positive two-independent-original-SHA executions and the
 * meaningful OS/Deno denials (outside static TS/JSON imports, symlink
 * imports, runtime reads, sibling snapshot/cache reads in BOTH directions
 * with precreated public sibling sentinels and observed fixed denial
 * markers, writes, network and process) — fail closed with no proof and no
 * fallback. These are true platform-specific tests and are explicitly
 * ignored on non-macOS CI; the positive acceptance on this Mac is never
 * skipped.
 *
 * Public synthetic data only; no network, no model call, no credentials.
 * No test predicate or fake runtime stands in for the core positive causal
 * behavior (Group E positive + tests/integration/causal-capture_test.ts).
 */

import assert from "node:assert/strict";

import type { RetainedGatewayCaptureV1 } from "../../src/adapters/gateway/decrypt.ts";
import { asEncryptedArtifactDigest } from "../../src/contracts/brands.ts";
import type {
  CommandId,
  FixtureDigest,
  GitSha,
} from "../../src/contracts/brands.ts";
import type {
  PortResultV1,
  ReplayRunRequestV1,
} from "../../src/contracts/ports.ts";
import { parseRepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { WorkItemId } from "../../src/contracts/brands.ts";
import {
  CAUSAL_CONSUMER_COMMAND_ID,
  deriveExpectedFailureIdentity,
  GATEWAY_CAUSAL_VERIFIER_ID,
  gatewayCausalProofRef,
} from "../../src/replay/causal-proof.ts";
import type { GatewayCausalProofV1 } from "../../src/replay/causal-proof.ts";
import {
  CAUSAL_CONSUMER_PATH,
  GatewayLocalCausalVerifier,
} from "../../src/replay/causal-verifier.ts";
import type {
  GatewayCausalVerifierInputV1,
  GatewayLocalCausalVerifierOptionsV1,
} from "../../src/replay/causal-verifier.ts";
import { computeReplayFixtureDigest } from "../../src/replay/fixture.ts";
import type {
  ExpectedFailureV1,
  ResolvedFixtureV1,
} from "../../src/replay/fixture.ts";
import { ReplayPortImpl } from "../../src/replay/port.ts";
import type { ReplayPortOptions } from "../../src/replay/port.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import type {
  ReplayCommandInputV1,
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";
import {
  commitSymlink,
  commitWith,
  createToyApp,
  gitRun,
  testGitEnv,
  TOY_REPOSITORY,
  toyOptions,
} from "./helpers.ts";

const INCIDENT_ID = "provider-00000000-0000-4000-8000-000000000001";
const CAPTURE_ID = "synthetic-capture-2";
const ARTIFACT_DIGEST = asEncryptedArtifactDigest("c".repeat(64));
const TEST_ID = "gateway:stream-termination";
const TEST_ID_B = "gateway:second-test";
const REPLAY_COMMAND = "replay" as CommandId;
const TEST_COMMAND = "test" as CommandId;
const EXPECTED_FAILURE: ExpectedFailureV1 = {
  reason: "missing completion terminator produces 500",
  match: { kind: "contains", text: "stream terminated unexpectedly" },
};
const PRIVATE_MARKER = "PRIVATE-SENTINEL-7f3d9c1a";
const PUBLIC_MARKER = "public-model";
const ORIGINAL_SHA = "2".repeat(40) as GitSha;
const OUTPUT_DIGEST = "a1".repeat(32);

const FIXTURE_DIR =
  `tests/fixtures/gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}`;
const REQUEST_PATH = `${FIXTURE_DIR}/request.json`;
const UPSTREAM_PATH = `${FIXTURE_DIR}/upstream.json`;

function encode(text: string): Uint8Array<ArrayBuffer> {
  // Copy into a fresh ArrayBuffer: RetainedGatewayCaptureV1.body demands a
  // non-shared backing buffer.
  return new Uint8Array(new TextEncoder().encode(text));
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// Synthetic capture + composed bundle (public synthetic protocol vocabulary)
// ---------------------------------------------------------------------------

function makeCapture(
  bodyText =
    `{"model":"synthetic-model","input":"${PRIVATE_MARKER}","stream":true}`,
): RetainedGatewayCaptureV1 {
  return {
    version: 1,
    captureId: CAPTURE_ID,
    fingerprint: "f".repeat(64),
    caseGroupDigest: "g".repeat(64),
    capturedAt: 1_788_811_200_000,
    expiresAt: 1_788_864_000_000,
    requestId: "req-synthetic-1",
    gitSha: ORIGINAL_SHA,
    denoRevision: "synthetic-revision-2",
    endpoint: "/v1/responses",
    method: "POST",
    contentType: "application/json",
    compatibilityHeaders: { accept: "text/event-stream" },
    failureSignature: "synthetic",
    observation: {
      status: 502,
      stream: true,
      completed: false,
      terminalType: null,
      failureKind: "missing_sse_terminal",
      syntheticTerminalType: null,
      providerRoute: "synthetic",
    },
    clientObservation: {
      status: 502,
      stream: true,
      completed: false,
      terminalType: null,
      failureKind: "missing_sse_terminal",
      framingValid: true,
      providerRoute: "synthetic",
    },
    upstream: {
      version: 1,
      attempts: [{
        provider: "chatgpt_codex",
        status: 200,
        content_type: "text/event-stream",
        chunks_base64: [
          "ZGF0YTogIntcInR5cGVcIjpcInJlc3BvbnNlLmNyZWF0ZWRcIn0iXQ==",
        ],
        terminal: "eof",
      }],
      attempts_truncated: false,
      bytes_truncated: false,
      chunks_truncated: false,
    },
    body: encode(bodyText),
  };
}

function composedRequestBytes(): Uint8Array {
  return encode(JSON.stringify({
    endpoint: "/v1/responses",
    method: "POST",
    contentType: "application/json",
    body: `{"model":"${PUBLIC_MARKER}","input":"fixture text","stream":true}`,
  }));
}

function composedUpstreamBytes(): Uint8Array {
  return encode(JSON.stringify({
    version: 1,
    attempts: [{
      provider: "chatgpt_codex",
      status: 200,
      content_type: "text/event-stream",
      chunks_base64: [
        "ZGF0YTogIntcInR5cGVcIjpcInJlc3BvbnNlLmNyZWF0ZWRcIn0iXQ==",
      ],
      terminal: "eof",
    }],
    attempts_truncated: false,
    bytes_truncated: false,
    chunks_truncated: false,
  }));
}

function composedEntries(): { path: string; bytes: Uint8Array }[] {
  return [
    { path: REQUEST_PATH, bytes: composedRequestBytes() },
    { path: UPSTREAM_PATH, bytes: composedUpstreamBytes() },
  ];
}

async function composedDigest(
  entries: { path: string; bytes: Uint8Array }[],
): Promise<FixtureDigest> {
  return await computeReplayFixtureDigest(entries);
}

/** Verifier input over the synthetic capture + composed bundle. */
async function verifierInput(
  overrides: Partial<GatewayCausalVerifierInputV1> = {},
): Promise<GatewayCausalVerifierInputV1> {
  const entries = composedEntries();
  const bundleDigest = await composedDigest(entries);
  return {
    capture: makeCapture(),
    repository: TOY_REPOSITORY,
    incidentId: INCIDENT_ID,
    captureId: CAPTURE_ID,
    artifactDigest: ARTIFACT_DIGEST,
    fixtureRef:
      `fixture://gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}/${bundleDigest}`,
    bundleDigest,
    replayCommandId: REPLAY_COMMAND,
    testCommandId: TEST_COMMAND,
    testIds: [TEST_ID],
    expectedFailure: EXPECTED_FAILURE,
    fixtureEntries: entries,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scripted process runtime (no real git/deno/sandbox; boundary logic only)
// ---------------------------------------------------------------------------

interface ConsumerRecord {
  input: ReplayCommandInputV1;
  snapshotText: Record<string, string>;
  /** Realpaths recorded WHILE the snapshot exists (the verifier's verified
   * cleanup removes the task directory before the proof is returned). */
  realCwd: string;
  realDenoDir: string;
}

class ScriptedRuntime implements ReplayRuntimeV1 {
  readonly runs: ReplayCommandInputV1[] = [];
  readonly consumerRecords: ConsumerRecord[] = [];
  private consumerIndex = 0;
  private readonly shaLine = `${ORIGINAL_SHA}\n`;

  constructor(
    private readonly options: {
      onClone?: (dest: string) => Promise<void>;
      consumer?: (
        input: ReplayCommandInputV1,
        index: number,
      ) => ReplayCommandResultV1;
    } = {},
  ) {}

  async run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
    this.runs.push(input);
    if (input.executable === "git") {
      if (input.args[0] === "clone") {
        const dest = input.args[input.args.length - 1]!;
        await this.options.onClone?.(dest);
        return exitedResult(0, this.shaLine);
      }
      // rev-parse --verify / checkout / rev-parse HEAD: exact SHA behavior.
      return exitedResult(0, this.shaLine);
    }
    const result = (this.options.consumer ?? (() => exitedResult(1)))(
      input,
      this.consumerIndex,
    );
    this.consumerIndex += 1;
    this.consumerRecords.push({
      input,
      snapshotText: await snapshotText(input.cwd),
      realCwd: await Deno.realPath(input.cwd),
      realDenoDir: await Deno.realPath(input.env.DENO_DIR!),
    });
    return result;
  }
}

function exitedResult(
  exitCode: number,
  stdout = "",
  stderr = "",
): ReplayCommandResultV1 {
  return {
    outcome: "exited",
    exitCode,
    stdout: encode(stdout),
    stderr: encode(stderr),
    truncated: false,
    settled: true,
    detail: "scripted",
  };
}

function intendedFailResult(): ReplayCommandResultV1 {
  return exitedResult(
    1,
    `${EXPECTED_MARKER_LINE}${EXPECTED_FAIL_LINE}`,
    "",
  );
}

function timedOutResult(settled: boolean): ReplayCommandResultV1 {
  return {
    outcome: "timed_out",
    exitCode: null,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    truncated: false,
    settled,
    detail: "scripted deadline exceeded",
  };
}

async function snapshotText(cwd: string): Promise<Record<string, string>> {
  const text: Record<string, string> = {};
  for (const path of [REQUEST_PATH, UPSTREAM_PATH]) {
    try {
      text[path] = decode(await Deno.readFile(`${cwd}/${path}`));
    } catch {
      // absent snapshot file: recorded as missing
    }
  }
  return text;
}

/** Materialize one scripted snapshot checkout at the clone destination. */
async function materialize(
  dest: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    const full = `${dest}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeFile(full, encode(text));
  }
}

/** Standard snapshot: consumer present, fixture paths NOT committed. */
function consumerFiles(): Record<string, string> {
  return {
    "scripts/replay.ts": `// trusted consumer placeholder (scripted runtime)
console.log("sentinel-replay-test:${TEST_ID}");
`,
  };
}

interface ScriptedVerifyContextV1 {
  root: string;
  scratchDir: string;
  runtime: ScriptedRuntime;
  consumers: ReplayCommandInputV1[];
  verify(
    input: GatewayCausalVerifierInputV1,
  ): Promise<GatewayCausalProofV1 | null>;
  cleanup(): Promise<void>;
}

async function scriptedContext(
  options: {
    files?: Record<string, string>;
    onClone?: (dest: string) => Promise<void>;
    consumer?: (
      input: ReplayCommandInputV1,
      index: number,
    ) => ReplayCommandResultV1;
    verifierOptions?: Partial<GatewayLocalCausalVerifierOptionsV1>;
  } = {},
): Promise<ScriptedVerifyContextV1> {
  const root = await Deno.makeTempDir({
    prefix: "causal-verifier-unit-",
    dir: Deno.cwd(),
  });
  const scratchDir = `${root}/scratch`;
  const runtime = new ScriptedRuntime({
    onClone: options.onClone ??
      ((dest) => materialize(dest, options.files ?? consumerFiles())),
    consumer: options.consumer,
  });
  const verifier = new GatewayLocalCausalVerifier({
    sourcePath: root,
    scratchDir,
    consumerPath: CAUSAL_CONSUMER_PATH,
    consumerRequestPath: REQUEST_PATH,
    consumerUpstreamPath: UPSTREAM_PATH,
    denoPath: Deno.execPath(),
    sandboxExecPath: Deno.execPath(),
    osName: "darwin",
    maxDurationMs: 15_000,
    maxOutputBytes: 262_144,
    runtime,
  });
  return {
    root,
    scratchDir,
    runtime,
    consumers: runtime.runs,
    verify: (input) => verifier.verify(input),
    cleanup: () => Deno.remove(root, { recursive: true }).catch(() => {}),
  };
}

async function scratchEntries(scratchDir: string): Promise<string[]> {
  try {
    const names: string[] = [];
    for await (const entry of Deno.readDir(scratchDir)) {
      names.push(entry.name);
    }
    return names;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// GROUP A: constructor binding and fail-closed validation (no execution)
// ---------------------------------------------------------------------------

Deno.test("causal verifier: the consumer path is bound to the fixed trusted consumer command identity", () => {
  const base: GatewayLocalCausalVerifierOptionsV1 = {
    sourcePath: "/tmp",
    scratchDir: "/tmp",
    consumerPath: CAUSAL_CONSUMER_PATH,
    consumerRequestPath: REQUEST_PATH,
    consumerUpstreamPath: UPSTREAM_PATH,
    denoPath: "/tmp",
    maxDurationMs: 15_000,
    maxOutputBytes: 262_144,
  };
  // The fixed path is accepted.
  assert.ok(
    new GatewayLocalCausalVerifier(base) instanceof
      GatewayLocalCausalVerifier,
  );
  // An interchangeable arbitrary consumerPath is rejected.
  for (
    const consumerPath of [
      "scripts/causal-consumer.ts",
      "scripts/other-consumer.ts",
      "scripts/replay.js",
    ]
  ) {
    assert.throws(
      () => new GatewayLocalCausalVerifier({ ...base, consumerPath }),
      /fixed trusted consumer path/,
      consumerPath,
    );
  }
  // A dot-segment consumer path is rejected by the exact safe-path
  // validation itself (never normalized into the fixed path): the actual
  // path-safety error is what must surface, without weakening the rejection.
  assert.throws(
    () =>
      new GatewayLocalCausalVerifier({
        ...base,
        consumerPath: "scripts/../scripts/replay.ts",
      }),
    /fixed safe root-relative paths/,
  );
});

Deno.test("causal verifier: consumer/request/upstream paths must be three distinct fixed safe paths", () => {
  const base: GatewayLocalCausalVerifierOptionsV1 = {
    sourcePath: "/tmp",
    scratchDir: "/tmp",
    consumerPath: CAUSAL_CONSUMER_PATH,
    consumerRequestPath: REQUEST_PATH,
    consumerUpstreamPath: UPSTREAM_PATH,
    denoPath: "/tmp",
    maxDurationMs: 15_000,
    maxOutputBytes: 262_144,
  };
  assert.throws(
    () =>
      new GatewayLocalCausalVerifier({
        ...base,
        consumerRequestPath: UPSTREAM_PATH,
      }),
    /must differ/,
  );
  assert.throws(
    () =>
      new GatewayLocalCausalVerifier({
        ...base,
        consumerRequestPath: "scripts/replay.ts",
      }),
    /must differ/,
  );
  assert.throws(
    () =>
      new GatewayLocalCausalVerifier({
        ...base,
        consumerUpstreamPath: "scripts/replay.ts",
      }),
    /must differ/,
  );
  assert.throws(
    () =>
      new GatewayLocalCausalVerifier({
        ...base,
        consumerRequestPath: REQUEST_PATH + "/../upstream.json",
      }),
    /fixed safe root-relative paths/,
  );
});

Deno.test("causal verifier: constructor requires absolute, bounded trusted host inputs", () => {
  const base: GatewayLocalCausalVerifierOptionsV1 = {
    sourcePath: "/tmp",
    scratchDir: "/tmp",
    consumerPath: CAUSAL_CONSUMER_PATH,
    consumerRequestPath: REQUEST_PATH,
    consumerUpstreamPath: UPSTREAM_PATH,
    denoPath: "/tmp",
    maxDurationMs: 15_000,
    maxOutputBytes: 262_144,
  };
  assert.throws(
    () => new GatewayLocalCausalVerifier({ ...base, sourcePath: "relative" }),
    /absolute local source path/,
  );
  assert.throws(
    () => new GatewayLocalCausalVerifier({ ...base, scratchDir: "relative" }),
    /absolute scratch root/,
  );
  assert.throws(
    () => new GatewayLocalCausalVerifier({ ...base, denoPath: "deno" }),
    /absolute installed Deno binary/,
  );
  assert.throws(
    () =>
      new GatewayLocalCausalVerifier({
        ...base,
        maxDurationMs: 0,
      }),
    /bounded execution deadline/,
  );
  assert.throws(
    () =>
      new GatewayLocalCausalVerifier({
        ...base,
        maxOutputBytes: 0,
      }),
    /bounded output retention/,
  );
  assert.throws(
    () =>
      new GatewayLocalCausalVerifier({
        ...base,
        sandboxExecPath: "sandbox-exec",
      }),
    /absolute sandbox-exec path/,
  );
});

Deno.test("causal verifier: malformed UTF-8 request bytes are rejected before any execution", async () => {
  const ctx = await scriptedContext();
  try {
    const malformed = await verifierInput();
    malformed.capture = makeCapture(
      JSON.stringify({ model: "synthetic", input: "\u0000\u00ff" }),
    );
    // Replace with real malformed bytes (invalid UTF-8 sequence).
    malformed.capture = {
      ...malformed.capture,
      body: new Uint8Array([
        0x7b,
        0x22,
        0x61,
        0x22,
        0x3a,
        0x22,
        0xff,
        0x22,
        0x7d,
      ]),
    };
    assert.equal(await ctx.verify(malformed), null);
    assert.equal(ctx.runtime.runs.length, 0, "no command may run");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: bundle identity and entry shape are exact before any execution", async () => {
  const ctx = await scriptedContext();
  try {
    const wrongDigest = await verifierInput({
      bundleDigest: "d".repeat(64) as FixtureDigest,
    });
    assert.equal(await ctx.verify(wrongDigest), null);

    const missingEntry = await verifierInput({
      fixtureEntries: [composedEntries()[0]!],
    });
    assert.equal(await ctx.verify(missingEntry), null);

    const extraEntry = await verifierInput();
    (extraEntry.fixtureEntries as { path: string; bytes: Uint8Array }[]).push({
      path: "tests/fixtures/extra.json",
      bytes: encode("{}"),
    });
    assert.equal(await ctx.verify(extraEntry), null);

    // Unknown test identities are rejected before execution too.
    const badIds = await verifierInput({ testIds: [] });
    assert.equal(await ctx.verify(badIds), null);

    assert.equal(ctx.runtime.runs.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: non-macOS and a missing sandbox-exec are NO proof (no fallback)", async () => {
  // Non-macOS host: the narrow macOS slice does not exist anywhere else.
  const linuxCtx = await scriptedContext({
    verifierOptions: {},
  });
  // Rebuild with osName override.
  await linuxCtx.cleanup();
  const root = await Deno.makeTempDir({
    prefix: "causal-verifier-os-",
    dir: Deno.cwd(),
  });
  try {
    const linuxRuntime = new ScriptedRuntime();
    const linuxVerifier = new GatewayLocalCausalVerifier({
      sourcePath: root,
      scratchDir: `${root}/scratch`,
      consumerPath: CAUSAL_CONSUMER_PATH,
      consumerRequestPath: REQUEST_PATH,
      consumerUpstreamPath: UPSTREAM_PATH,
      denoPath: Deno.execPath(),
      osName: "linux",
      maxDurationMs: 15_000,
      maxOutputBytes: 262_144,
      runtime: linuxRuntime,
    });
    const linuxInput = await verifierInput({
      capture: {
        ...makeCapture(),
        body: encode(
          `{"model":"synthetic-model","input":"${PRIVATE_MARKER}"}`,
        ),
      },
    });
    assert.equal(await linuxVerifier.verify(linuxInput), null);
    assert.equal(linuxRuntime.runs.length, 0);
    assert.deepEqual(await scratchEntries(`${root}/scratch`), []);

    // Missing installed sandbox-exec: no proof before any execution.
    const missingSandboxRuntime = new ScriptedRuntime();
    const missingSandboxVerifier = new GatewayLocalCausalVerifier({
      sourcePath: root,
      scratchDir: `${root}/scratch-missing-sandbox`,
      consumerPath: CAUSAL_CONSUMER_PATH,
      consumerRequestPath: REQUEST_PATH,
      consumerUpstreamPath: UPSTREAM_PATH,
      denoPath: Deno.execPath(),
      sandboxExecPath: `${root}/missing-sandbox-exec`,
      osName: "darwin",
      maxDurationMs: 15_000,
      maxOutputBytes: 262_144,
      runtime: missingSandboxRuntime,
    });
    assert.equal(
      await missingSandboxVerifier.verify(await verifierInput()),
      null,
    );
    assert.equal(missingSandboxRuntime.runs.length, 0);
    assert.deepEqual(
      await scratchEntries(`${root}/scratch-missing-sandbox`),
      [],
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// GROUP B: placement boundaries (scripted checkouts, no consumer execution)
// ---------------------------------------------------------------------------

Deno.test("causal verifier: a missing trusted consumer at the original SHA is no proof", async () => {
  const ctx = await scriptedContext({
    files: { "scripts/other.ts": "// not the bound consumer" },
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
    assert.equal(
      ctx.runtime.runs.filter((input) => input.executable !== "git").length,
      0,
      "no consumer may run without the bound script",
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: a symlink ancestor in the FIRST input path is rejected before private writes", async () => {
  const ctx = await scriptedContext({
    files: consumerFiles(),
  });
  // Replace the request path's chain: `tests` becomes a symlink.
  const onClone = async (dest: string) => {
    await materialize(dest, consumerFiles());
    try {
      await Deno.remove(`${dest}/tests`, { recursive: true });
    } catch {
      // does not exist yet
    }
    await Deno.symlink("fixtures", `${dest}/tests`);
  };
  const symlinkCtx = await scriptedContext({ onClone });
  try {
    assert.equal(await symlinkCtx.verify(await verifierInput()), null);
    assert.equal(
      symlinkCtx.runtime.runs.filter((input) => input.executable !== "git")
        .length,
      0,
    );
  } finally {
    await symlinkCtx.cleanup();
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: a symlink ancestor in the SECOND input path is rejected before private writes", async () => {
  // The request path is perfectly placeable; the upstream path's `fixtures`
  // ancestor is a symlink. Every component of BOTH paths is validated — the
  // clean first path must not short-circuit the second.
  const onClone = async (dest: string) => {
    await materialize(dest, consumerFiles());
    const fixtures = `${dest}/tests/fixtures`;
    const gateway = `${dest}/tests/gateway-replay`;
    await Deno.mkdir(gateway, { recursive: true });
    await Deno.rename(fixtures, `${dest}/tests/fixtures-real`);
    await Deno.symlink("fixtures-real", fixtures);
  };
  const ctx = await scriptedContext({ onClone });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
    assert.equal(
      ctx.runtime.runs.filter((input) => input.executable !== "git").length,
      0,
      "no consumer may run when the second path has a symlink ancestor",
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: a symlink or non-regular final input component is rejected", async () => {
  const onClone = async (dest: string) => {
    await materialize(dest, consumerFiles());
    const dir = `${dest}/${FIXTURE_DIR}`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.symlink("request.json", `${dir}/upstream.json`);
    await Deno.mkdir(`${dir}/request.json`, { recursive: true });
  };
  const ctx = await scriptedContext({ onClone });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
    assert.equal(
      ctx.runtime.runs.filter((input) => input.executable !== "git").length,
      0,
    );
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// GROUP C: execution semantics (scripted consumer runs)
// ---------------------------------------------------------------------------

const EXPECTED_MARKER_LINE = `sentinel-replay-test:${TEST_ID}\n`;
const EXPECTED_FAIL_LINE =
  `sentinel-causal-failure:stream terminated unexpectedly\n`;

Deno.test("causal verifier: proof carries exact observed evidence, private bytes stay in the original snapshot only, per-run homes/caches and verified cleanup", async () => {
  const ctx = await scriptedContext({
    consumer: () => intendedFailResult(),
  });
  try {
    const denoResolved = await Deno.realPath(Deno.execPath());
    const input = await verifierInput();
    const proof = await ctx.verify(input);
    assert.notEqual(proof, null, "a bound proof is expected");
    if (proof === null) return;

    assert.equal(proof.verifier, GATEWAY_CAUSAL_VERIFIER_ID);
    assert.equal(proof.consumerCommandId, CAUSAL_CONSUMER_COMMAND_ID);
    assert.equal(
      proof.proofRef,
      gatewayCausalProofRef(INCIDENT_ID, CAPTURE_ID, proof.bundleDigest),
    );
    assert.equal(
      proof.expectedFailureIdentity,
      await deriveExpectedFailureIdentity(EXPECTED_FAILURE),
    );
    // Observed evidence is separate from the expected-failure identity.
    for (
      const observation of [
        proof.originalObservation,
        proof.sanitizedObservation,
      ]
    ) {
      assert.equal(observation.intended, true);
      assert.equal(observation.exitCode, 1);
      assert.deepEqual(observation.observedTestIds, [TEST_ID]);
      assert.match(observation.outputDigest, /^[0-9a-f]{64}$/);
    }
    assert.notEqual(proof.originalObservation.outputDigest, "a1".repeat(32));
    assert.notEqual(
      proof.originalObservation.outputDigest,
      proof.expectedFailureIdentity,
    );
    // Private bytes never cross: no marker in the proof record.
    assert.ok(!JSON.stringify(proof).includes(PRIVATE_MARKER));

    // Two consumer executions with the fixed sandbox-exec protocol, each
    // confined to ITS OWN snapshot (cwd) and ITS OWN home/cache.
    const consumers = ctx.runtime.runs.filter((input) =>
      input.executable === Deno.execPath()
    );
    assert.equal(consumers.length, 2, "original + sanitized consumer runs");
    const [originalRun, sanitizedRun] = consumers;
    assert.notEqual(originalRun.cwd, sanitizedRun.cwd);
    assert.notEqual(originalRun.env.HOME, sanitizedRun.env.HOME);
    assert.notEqual(originalRun.env.DENO_DIR, sanitizedRun.env.DENO_DIR);
    assert.ok(sanitizedRun.env.HOME.includes("home-sanitized"));
    // The consumer path is the fixed bound script inside the snapshot.
    for (const [index, run] of consumers.entries()) {
      assert.equal(run.executable, Deno.execPath());
      assert.equal(run.args[0], "-p");
      assert.ok(
        run.args[1]!.startsWith("(version 1)"),
        "the fixed embedded deny-by-default seatbelt profile",
      );
      assert.equal(run.args[2], "-D");
      assert.ok(run.args[3]!.startsWith("DENO="));
      assert.equal(run.args[4], "-D");
      assert.ok(run.args[5]!.startsWith("SNAPSHOT="));
      assert.equal(run.args[6], "-D");
      assert.ok(run.args[7]!.startsWith("CACHE="));
      assert.equal(run.args[8], denoResolved, "the installed Deno binary");
      assert.equal(run.args[9], "run", "direct deno run, never deno task");
      assert.equal(
        run.args[run.args.length - 1],
        `${run.cwd}/scripts/replay.ts`,
      );
      assert.ok(run.args.includes("--no-config"));
      assert.ok(run.args.includes("--no-remote"));
      assert.ok(!run.args.includes("task"), "never deno task");
      assert.ok(!run.args.includes("--allow-net"));
      assert.ok(!run.args.includes("--allow-run"));
      const snapshotParam = paramValue(run.args, "SNAPSHOT");
      const cacheParam = paramValue(run.args, "CACHE");
      assert.ok(snapshotParam !== null && snapshotParam.startsWith("/"));
      assert.ok(cacheParam !== null && cacheParam.startsWith("/"));
      // Realpath-resolved substitution parameters: the OS boundary sees the
      // same resolved paths as the snapshot cwd and the run's own cache.
      // The realpaths are recorded by the recording wrapper WHILE the
      // snapshot existed (the verifier's verified cleanup removes the task
      // directory before the proof is returned).
      const record = ctx.runtime.consumerRecords[index]!;
      assert.equal(snapshotParam, record.realCwd);
      assert.equal(cacheParam, record.realDenoDir);
    }
    assert.notEqual(
      paramValue(originalRun.args, "SNAPSHOT"),
      paramValue(sanitizedRun.args, "SNAPSHOT"),
      "each run sees only its own snapshot at the OS boundary",
    );

    // Placement: the private original bytes are ONLY in the original
    // snapshot; the sanitized snapshot carries the exact composed bytes.
    for (const record of ctx.runtime.consumerRecords) {
      const snapshot = record.snapshotText;
      assert.ok(snapshot[REQUEST_PATH] !== undefined);
      assert.ok(snapshot[UPSTREAM_PATH] !== undefined);
    }
    const originalSnapshot = ctx.runtime.consumerRecords[0]!.snapshotText;
    const sanitizedSnapshot = ctx.runtime.consumerRecords[1]!.snapshotText;
    assert.ok(originalSnapshot[REQUEST_PATH]!.includes(PRIVATE_MARKER));
    assert.ok(!originalSnapshot[UPSTREAM_PATH]!.includes(PRIVATE_MARKER));
    assert.ok(!sanitizedSnapshot[REQUEST_PATH]!.includes(PRIVATE_MARKER));
    assert.deepEqual(
      sanitizedSnapshot[REQUEST_PATH],
      decode(composedRequestBytes()),
    );
    assert.deepEqual(
      sanitizedSnapshot[UPSTREAM_PATH],
      decode(composedUpstreamBytes()),
    );

    // Normal cleanup was verified before the proof was returned.
    assert.deepEqual(await scratchEntries(ctx.scratchDir), []);
  } finally {
    await ctx.cleanup();
  }
});

function paramValue(args: string[], name: string): string | null {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === "-D" && args[index + 1]!.startsWith(`${name}=`)) {
      return args[index + 1]!.slice(name.length + 1);
    }
  }
  return null;
}

Deno.test("causal verifier: extra observed test identities are no evidence", async () => {
  const ctx = await scriptedContext({
    consumer: () =>
      exitedResult(
        1,
        `${EXPECTED_MARKER_LINE}sentinel-replay-test:${TEST_ID_B}\n${EXPECTED_FAIL_LINE}`,
      ),
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: a duplicated observed test identity is no evidence", async () => {
  const ctx = await scriptedContext({
    consumer: () =>
      exitedResult(
        1,
        `${EXPECTED_MARKER_LINE}${EXPECTED_MARKER_LINE}${EXPECTED_FAIL_LINE}`,
      ),
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: reordered observed test identities are no evidence", async () => {
  const ctx = await scriptedContext({
    consumer: () =>
      exitedResult(
        1,
        `sentinel-replay-test:${TEST_ID_B}\n${EXPECTED_MARKER_LINE}${EXPECTED_FAIL_LINE}`,
      ),
  });
  try {
    const input = await verifierInput({ testIds: [TEST_ID, TEST_ID_B] });
    assert.equal(await ctx.verify(input), null);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: a missing observed test identity is no evidence", async () => {
  const ctx = await scriptedContext({
    consumer: () =>
      exitedResult(
        1,
        `${EXPECTED_MARKER_LINE}${EXPECTED_FAIL_LINE}`,
      ),
  });
  try {
    const input = await verifierInput({ testIds: [TEST_ID, TEST_ID_B] });
    assert.equal(await ctx.verify(input), null);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: an unrelated failure with the exact identity still carries no proof", async () => {
  const ctx = await scriptedContext({
    consumer: () =>
      exitedResult(
        1,
        `${EXPECTED_MARKER_LINE}${EXPECTED_FAIL_LINE}unrelated failure: boom\n`,
      ),
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: a private diagnostic line appended to the fixed protocol is no evidence (never hashed)", async () => {
  const ctx = await scriptedContext({
    consumer: () =>
      exitedResult(
        1,
        `${EXPECTED_MARKER_LINE}${EXPECTED_FAIL_LINE}${PRIVATE_MARKER}\n`,
      ),
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: any stderr is no evidence even when stdout is the exact protocol", async () => {
  const ctx = await scriptedContext({
    consumer: () =>
      exitedResult(
        1,
        `${EXPECTED_MARKER_LINE}${EXPECTED_FAIL_LINE}`,
        "unrelated failure: boom\n",
      ),
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: an unsupported expected-failure matcher is rejected before any execution", async () => {
  const ctx = await scriptedContext();
  try {
    const differentText = await verifierInput({
      expectedFailure: {
        reason: "different reason",
        match: { kind: "contains", text: "different text" },
      },
    });
    assert.equal(await ctx.verify(differentText), null);
    const regex = await verifierInput({
      expectedFailure: {
        reason: "regex reason",
        match: { kind: "regex", source: "stream.*" },
      },
    });
    assert.equal(await ctx.verify(regex), null);
    assert.equal(ctx.runtime.runs.length, 0, "no command may run");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: a zero-exit consumer is no evidence", async () => {
  const ctx = await scriptedContext({
    consumer: () =>
      exitedResult(0, `${EXPECTED_MARKER_LINE}${EXPECTED_FAIL_LINE}`),
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: truncated output is no evidence and no sanitized run follows", async () => {
  const ctx = await scriptedContext({
    consumer: (_input, index) =>
      index === 0
        ? {
          outcome: "exited",
          exitCode: 1,
          stdout: encode(EXPECTED_MARKER_LINE),
          stderr: new Uint8Array(),
          truncated: true,
          settled: true,
          detail: "bounded output exhausted",
        }
        : intendedFailResult(),
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
    assert.equal(
      ctx.runtime.runs.filter((input) => input.executable !== "git").length,
      1,
      "truncation is a settled failure: no second execution",
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: a timed-out original aborts before the sanitized execution and cleans up", async () => {
  const ctx = await scriptedContext({
    consumer: () => timedOutResult(true),
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
    assert.equal(
      ctx.runtime.runs.filter((input) => input.executable !== "git").length,
      1,
      "no sanitized execution after a timed-out original",
    );
    assert.deepEqual(await scratchEntries(ctx.scratchDir), []);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: an unsettled original preserves the restricted scratch and never runs the sanitized execution", async () => {
  const ctx = await scriptedContext({
    consumer: () => timedOutResult(false),
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
    assert.equal(
      ctx.runtime.runs.filter((input) => input.executable !== "git").length,
      1,
      "unsettled original: the sanitized execution is never attempted",
    );
    // Restricted scratch is PRESERVED on uncertainty (with the private
    // request still inside the original snapshot).
    const leftovers = await scratchEntries(ctx.scratchDir);
    assert.equal(leftovers.length, 1, "scratch preserved on uncertainty");
    const taskDir = `${ctx.scratchDir}/${leftovers[0]}`;
    const privateRequest = await Deno.readTextFile(
      `${taskDir}/original/${REQUEST_PATH}`,
    );
    assert.ok(privateRequest.includes(PRIVATE_MARKER));
  } finally {
    await ctx.cleanup(); // removes the preserved scratch only in teardown
  }
});

Deno.test("causal verifier: an unsettled sanitized run also preserves the scratch and returns no proof", async () => {
  const ctx = await scriptedContext({
    consumer: (_input, index) =>
      index === 0 ? intendedFailResult() : timedOutResult(false),
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
    const leftovers = await scratchEntries(ctx.scratchDir);
    assert.equal(leftovers.length, 1, "scratch preserved on uncertainty");
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// GROUP D: ReplayPort consuming boundary (real subprocesses, real toy git)
// ---------------------------------------------------------------------------

const here = new URL(import.meta.url);
if (here.protocol !== "file:") throw new Error("expected a file: test module");
const testsDir = decodeURIComponent(here.pathname).replace(
  /\/causal-verifier_test\.ts$/,
  "",
);

function gatewayEntries(): { path: string; bytes: Uint8Array }[] {
  return [
    {
      path: REQUEST_PATH,
      bytes: encode(JSON.stringify({
        endpoint: "/v1/responses",
        method: "POST",
        contentType: "application/json",
        body:
          '{"model":"synthetic-model","input":"fixture text","stream":true}',
      })),
    },
    {
      path: UPSTREAM_PATH,
      bytes: encode(JSON.stringify({
        version: 1,
        attempts: [{
          provider: "chatgpt_codex",
          status: 200,
          content_type: "text/event-stream",
          chunks_base64: [
            "ZGF0YTogIntcInR5cGVcIjpcInJlc3BvbnNlLmNyZWF0ZWRcIn0iXQ==",
          ],
          terminal: "eof",
        }],
        attempts_truncated: false,
        bytes_truncated: false,
        chunks_truncated: false,
      })),
    },
  ];
}

function observation(): GatewayCausalProofV1["originalObservation"] {
  return {
    intended: true,
    outputDigest: OUTPUT_DIGEST,
    observedTestIds: [TEST_ID],
    exitCode: 1,
  };
}

async function buildProof(
  bundleDigest: FixtureDigest,
  originalGitSha: GitSha,
  overrides: Partial<GatewayCausalProofV1> = {},
): Promise<GatewayCausalProofV1> {
  const fixtureRef =
    `fixture://gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}/${bundleDigest}`;
  const proof: GatewayCausalProofV1 = {
    version: "v1",
    kind: "gateway_causal_proof",
    verifier: GATEWAY_CAUSAL_VERIFIER_ID,
    proofRef: gatewayCausalProofRef(INCIDENT_ID, CAPTURE_ID, bundleDigest),
    repository: TOY_REPOSITORY,
    incidentId: INCIDENT_ID,
    captureId: CAPTURE_ID,
    artifactDigest: ARTIFACT_DIGEST,
    originalGitSha,
    fixtureRef,
    bundleDigest,
    replayCommandId: REPLAY_COMMAND,
    testCommandId: TEST_COMMAND,
    consumerCommandId: CAUSAL_CONSUMER_COMMAND_ID,
    testIds: [TEST_ID],
    expectedFailure: EXPECTED_FAILURE,
    expectedFailureIdentity: await deriveExpectedFailureIdentity(
      EXPECTED_FAILURE,
    ),
    originalObservation: observation(),
    sanitizedObservation: observation(),
    ...overrides,
  };
  return proof;
}

async function gatewayBundle(
  originalGitSha: GitSha,
  proofOverrides: Partial<GatewayCausalProofV1> = {},
): Promise<{ bundle: ResolvedFixtureV1; digest: FixtureDigest; ref: string }> {
  const entries = gatewayEntries();
  const digest = await computeReplayFixtureDigest(entries);
  const ref = `fixture://gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}/${digest}`;
  const bundle: ResolvedFixtureV1 = {
    testIds: [TEST_ID],
    expectedFailure: EXPECTED_FAILURE,
    entries,
    provenance: {
      sanitized: true,
      sanitizer: "gateway-structural-v1",
      provenanceRef: ref,
      redacted: true,
      note:
        "gateway capture redacted; re-encoded to a fixed protocol vocabulary",
    },
    causalProof: await buildProof(digest, originalGitSha, proofOverrides),
  };
  return { bundle, digest, ref };
}

/** Config whose "test" command runs one credential-free deno eval script. */
function evalConfig(
  script: string,
  maxOutputBytes = 262_144,
): RepositoryConfigV1 {
  const command = {
    executable: "deno",
    args: ["eval", "--allow-read=.", script],
    maxDurationMs: 15_000,
    maxOutputBytes,
  };
  return parseRepositoryConfigV1({
    version: "v1",
    kind: "repository_config",
    repository: TOY_REPOSITORY,
    baseBranch: "main",
    adapter: { kind: "gateway", baseUrl: "https://ai.ubq.fi" },
    commands: { replay: "replay", test: "test" },
    commandRegistry: {
      version: "v1",
      commands: { replay: command, test: command },
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

const FAIL_SCRIPT =
  `const base = "tests/fixtures/gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}"; const request = JSON.parse(await Deno.readTextFile(base + "/request.json")); const upstream = JSON.parse(await Deno.readTextFile(base + "/upstream.json")); if (request.endpoint !== "/v1/responses") Deno.exit(9); if (!upstream.attempts.every((a) => a.terminal === "eof")) Deno.exit(9); console.log("sentinel-replay-test:${TEST_ID}"); console.log("stream terminated unexpectedly"); Deno.exit(1);`;

const PASS_SCRIPT =
  `const base = "tests/fixtures/gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}"; const request = JSON.parse(await Deno.readTextFile(base + "/request.json")); const upstream = JSON.parse(await Deno.readTextFile(base + "/upstream.json")); if (request.endpoint !== "/v1/responses") Deno.exit(9); if (!upstream.attempts.every((a) => a.terminal === "eof")) Deno.exit(9); console.log("sentinel-replay-test:${TEST_ID}");`;

async function withFixture<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({
    prefix: ".causal-proof-tmp-",
    dir: testsDir,
  });
  try {
    return await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

function assertPortOk<T>(result: PortResultV1<T>): T {
  assert.ok(result.ok, `expected port ok, got ${JSON.stringify(result)}`);
  return result.value;
}

function runRequest(
  bundle: ResolvedFixtureV1,
  ref: string,
  digest: FixtureDigest,
  revision: GitSha,
  overrides: Record<string, unknown> = {},
): ReplayRunRequestV1 {
  return {
    taskId: "incident:toy-0001" as WorkItemId,
    repository: TOY_REPOSITORY,
    revision,
    commandId: TEST_COMMAND,
    fixtureRef: ref,
    fixtureDigest: digest,
    testIds: bundle.testIds,
    outputLimitBytes: 262_144,
    ...overrides,
  } as ReplayRunRequestV1;
}

function portWith(
  toyRoot: string,
  scratchDir: string,
  bundle: ResolvedFixtureV1,
  overrides: Partial<ReplayPortOptions> = {},
): ReplayPortImpl {
  return new ReplayPortImpl({
    ...toyOptions(toyRoot, scratchDir),
    fixtures: {
      resolveFixture: () => Promise.resolve({ ok: true, value: bundle }),
    },
    ...overrides,
  });
}

Deno.test("causal proof boundary: a valid proof suppresses fixture_redacted at the consuming boundary", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const { bundle, digest, ref } = await gatewayBundle(toy.originalSha);
    const port = portWith(toy.root, `${root}/scratch`, bundle, {
      config: evalConfig(FAIL_SCRIPT),
    });

    // Before-failure at the exact original revision: intended, zero limitations.
    const before = assertPortOk(
      await port.runReplay(runRequest(bundle, ref, digest, toy.originalSha)),
    );
    assert.equal(before.outcome, "failed");
    assert.equal(before.exitCode, 1);
    assert.equal(before.failure?.intended, true);
    assert.deepEqual(before.limitations, []);

    // The proof is for the immutable capture/fixture relationship: a
    // candidate revision may differ from proof.originalGitSha.
    const after = assertPortOk(
      await port.runReplay(runRequest(bundle, ref, digest, toy.candidateSha)),
    );
    assert.equal(after.outcome, "failed");
    assert.equal(after.failure?.intended, true);
    assert.deepEqual(after.limitations, []);

    // Pass side: the same permanent fixture passes with zero limitations.
    const passPort = portWith(toy.root, `${root}/scratch`, bundle, {
      config: evalConfig(PASS_SCRIPT),
    });
    const passed = assertPortOk(
      await passPort.runReplay(
        runRequest(bundle, ref, digest, toy.candidateSha),
      ),
    );
    assert.equal(passed.outcome, "passed");
    assert.equal(passed.exitCode, 0);
    assert.deepEqual(passed.limitations, []);
  });
});

Deno.test("causal proof boundary: absent or mismatched proofs keep the ordinary redacted limitation", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);

    // No proof at all: ordinary redacted fixture and its limitation.
    const noProof = await gatewayBundle(toy.originalSha);
    delete noProof.bundle.causalProof;
    const noProofPort = portWith(toy.root, `${root}/scratch`, noProof.bundle, {
      config: evalConfig(FAIL_SCRIPT),
    });
    const limited = assertPortOk(
      await noProofPort.runReplay(
        runRequest(
          noProof.bundle,
          noProof.ref,
          noProof.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.equal(limited.outcome, "failed");
    assert.equal(limited.failure?.intended, true);
    assert.deepEqual(limited.limitations, ["fixture_redacted"]);

    // Wrong bundle digest: structurally valid but not bound to the actual
    // bundle bytes → the redaction limitation stays.
    const wrongDigest = await gatewayBundle(toy.originalSha, {
      bundleDigest: "e".repeat(64) as FixtureDigest,
    });
    const wrongDigestPort = portWith(
      toy.root,
      `${root}/scratch`,
      wrongDigest.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const mismatched = assertPortOk(
      await wrongDigestPort.runReplay(
        runRequest(
          wrongDigest.bundle,
          wrongDigest.ref,
          wrongDigest.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(mismatched.limitations, ["fixture_redacted"]);

    // Wrong fixture ref (a different capture identity): the port derives the
    // incident/capture from the request ref, so the proof cannot bind.
    const wrongRefBundle = await gatewayBundle(toy.originalSha);
    const wrongRefPort = portWith(
      toy.root,
      `${root}/scratch`,
      wrongRefBundle.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const wrongRef = assertPortOk(
      await wrongRefPort.runReplay(
        runRequest(
          wrongRefBundle.bundle,
          `fixture://gateway-replay/${INCIDENT_ID}/different-capture/${wrongRefBundle.digest}`,
          wrongRefBundle.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(wrongRef.limitations, ["fixture_redacted"]);

    // Wrong command identity: the proof binds the configured test command.
    const wrongCommand = await gatewayBundle(toy.originalSha, {
      testCommandId: "other_test" as CommandId,
    });
    const wrongCommandPort = portWith(
      toy.root,
      `${root}/scratch`,
      wrongCommand.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const wrongCommandRun = assertPortOk(
      await wrongCommandPort.runReplay(
        runRequest(
          wrongCommand.bundle,
          wrongCommand.ref,
          wrongCommand.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(wrongCommandRun.limitations, ["fixture_redacted"]);

    // Wrong consumer command identity: never bound.
    const wrongConsumer = await gatewayBundle(toy.originalSha, {
      consumerCommandId: "other_consumer" as CommandId,
    });
    const wrongConsumerPort = portWith(
      toy.root,
      `${root}/scratch`,
      wrongConsumer.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const wrongConsumerRun = assertPortOk(
      await wrongConsumerPort.runReplay(
        runRequest(
          wrongConsumer.bundle,
          wrongConsumer.ref,
          wrongConsumer.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(wrongConsumerRun.limitations, ["fixture_redacted"]);

    // Wrong expected-failure identity: strictly bound to the exact failure.
    const staleIdentity = await gatewayBundle(toy.originalSha, {
      expectedFailureIdentity: "9".repeat(64),
    });
    const staleIdentityPort = portWith(
      toy.root,
      `${root}/scratch`,
      staleIdentity.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const staleIdentityRun = assertPortOk(
      await staleIdentityPort.runReplay(
        runRequest(
          staleIdentity.bundle,
          staleIdentity.ref,
          staleIdentity.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(staleIdentityRun.limitations, ["fixture_redacted"]);

    // Wrong test-id list: the proof's exact test identity must match the
    // resolved fixture identity.
    const wrongTestIds = await gatewayBundle(toy.originalSha, {
      testIds: ["other:test"],
    });
    const wrongTestIdsPort = portWith(
      toy.root,
      `${root}/scratch`,
      wrongTestIds.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const wrongTestIdsRun = assertPortOk(
      await wrongTestIdsPort.runReplay(
        runRequest(
          wrongTestIds.bundle,
          wrongTestIds.ref,
          wrongTestIds.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(wrongTestIdsRun.limitations, ["fixture_redacted"]);

    // Changed expected-failure matcher (identity re-derived for the changed
    // matcher, so structural validation passes): the resolved fixture's
    // expected failure is the trusted binding and still mismatches.
    const changedMatcher = await gatewayBundle(toy.originalSha, {
      expectedFailure: {
        reason: "different reason",
        match: { kind: "contains", text: "different text" },
      },
    });
    const changedMatcherPort = portWith(
      toy.root,
      `${root}/scratch`,
      changedMatcher.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const changedMatcherRun = assertPortOk(
      await changedMatcherPort.runReplay(
        runRequest(
          changedMatcher.bundle,
          changedMatcher.ref,
          changedMatcher.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(changedMatcherRun.limitations, ["fixture_redacted"]);

    // Wrong repository identity.
    const wrongRepository = await gatewayBundle(toy.originalSha, {
      repository: { ...TOY_REPOSITORY, name: "different-repo" },
    });
    const wrongRepositoryPort = portWith(
      toy.root,
      `${root}/scratch`,
      wrongRepository.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const wrongRepositoryRun = assertPortOk(
      await wrongRepositoryPort.runReplay(
        runRequest(
          wrongRepository.bundle,
          wrongRepository.ref,
          wrongRepository.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(wrongRepositoryRun.limitations, ["fixture_redacted"]);
  });
});

Deno.test("causal proof boundary: other limitations still fail closed alongside a valid proof", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const { bundle, digest, ref } = await gatewayBundle(toy.originalSha);

    // Truncated output keeps output_truncated even when the proof is valid.
    const truncatingConfig = evalConfig(
      "console.log('x'.repeat(4000)); console.log(\"sentinel-replay-test:" +
        TEST_ID +
        '"); console.log("stream terminated unexpectedly"); Deno.exit(1);',
      128,
    );
    const truncating = portWith(toy.root, `${root}/scratch-trunc`, bundle, {
      config: truncatingConfig,
    });
    const truncated = assertPortOk(
      await truncating.runReplay(
        runRequest(bundle, ref, digest, toy.originalSha),
      ),
    );
    assert.equal(truncated.outcome, "failed");
    assert.equal(truncated.failure?.intended, false);
    assert.deepEqual(truncated.limitations, ["output_truncated"]);

    // Unrelated failure: same valid proof, different failure reason — never
    // an intended failure, and never a clean run.
    const unrelated = assertPortOk(
      await portWith(toy.root, `${root}/scratch-unrelated`, bundle, {
        config: evalConfig(
          `console.log("sentinel-replay-test:${TEST_ID}"); console.log("unrelated boom"); Deno.exit(1);`,
        ),
      }).runReplay(runRequest(bundle, ref, digest, toy.originalSha)),
    );
    assert.equal(unrelated.outcome, "failed");
    assert.equal(unrelated.failure?.intended, false);
    assert.deepEqual(unrelated.limitations, []);

    // A request carrying test ids that do not match the trusted fixture
    // identity is rejected before any target command runs.
    const wrongRequestIds = await portWith(
      toy.root,
      `${root}/scratch-ids`,
      bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    ).runReplay(
      runRequest(bundle, ref, digest, toy.originalSha, {
        testIds: ["different:test"],
      }),
    );
    assert.ok(!wrongRequestIds.ok);
    assert.match(wrongRequestIds.error.detail, /test identity/);

    // A request fixture ref that is not the gateway grammar cannot bind the
    // proof: the ordinary redacted limitation stays (fail closed).
    const nonGatewayRefRun = await portWith(
      toy.root,
      `${root}/scratch-ref`,
      bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    ).runReplay(
      runRequest(
        bundle,
        "fixture://captures/toy/upstream.json",
        digest,
        toy.originalSha,
      ),
    );
    assert.ok(nonGatewayRefRun.ok);
    if (nonGatewayRefRun.ok) {
      assert.deepEqual(nonGatewayRefRun.value.limitations, [
        "fixture_redacted",
      ]);
    }
  });
});

Deno.test("causal proof boundary: source checkout stays untouched and scratch is cleaned", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const { bundle, digest, ref } = await gatewayBundle(toy.originalSha);
    const port = portWith(toy.root, `${root}/scratch`, bundle, {
      config: evalConfig(FAIL_SCRIPT),
    });
    const result = assertPortOk(
      await port.runReplay(runRequest(bundle, ref, digest, toy.originalSha)),
    );
    assert.deepEqual(result.limitations, []);
    const env = testGitEnv(`${root}/home`);
    const status = await gitRun(toy.root, ["status", "--porcelain"], env);
    assert.equal(status.stdout.trim(), "");
    const scratchLeft: string[] = [];
    try {
      for await (const entry of Deno.readDir(`${root}/scratch`)) {
        scratchLeft.push(entry.name);
      }
    } catch {
      // scratch dir may not exist; no leftovers then
    }
    assert.deepEqual(scratchLeft, []);
  });
});

// ---------------------------------------------------------------------------
// GROUP E: real macOS sandbox boundary (installed sandbox-exec + Deno)
// ---------------------------------------------------------------------------

const darwinOnly = Deno.build.os !== "darwin";

/**
 * The REAL trusted consumer: it calls the actual toy handler with the actual
 * input from the fixed fixture paths and emits the EXACT supported safe
 * failure protocol — one `sentinel-replay-test:<id>` line, then the single
 * fixed `sentinel-causal-failure:stream terminated unexpectedly` line on
 * stdout with empty stderr, exit 1 — ONLY for the intended outcome (502,
 * incomplete, exact failure body). Status 200 prints only the test ids and
 * exits 0; every other outcome emits only a fixed "unsupported causal
 * outcome" diagnostic and exits 2. Raw outcome.body is never printed.
 */
function causalConsumerSource(): string {
  return `import { handleStreamTrace } from "../src/app.ts";
const base = "tests/fixtures/gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}";
const request = JSON.parse(await Deno.readTextFile(base + "/request.json"));
const upstream = JSON.parse(await Deno.readTextFile(base + "/upstream.json"));
const outcome = handleStreamTrace(request, upstream);
console.log("sentinel-replay-test:${TEST_ID}");
if (outcome.status === 502 && outcome.completed === false && outcome.body === "stream terminated unexpectedly") {
  console.log("sentinel-causal-failure:stream terminated unexpectedly");
  Deno.exit(1);
}
if (outcome.status === 200) Deno.exit(0);
console.error("sentinel-causal-failure:unsupported causal outcome");
Deno.exit(2);
`;
}

function causalConsumerApp(): string {
  return `/** Toy gateway stream handler (original). */
export function handleStreamTrace(
  request: unknown,
  upstream: { attempts: { terminal: string; chunks_base64: string[] }[] },
): { status: number; body: string; completed: boolean; payload: string } {
  const req = request as { body?: string };
  let input = "";
  try {
    const parsed = JSON.parse(req.body ?? "{}") as { input?: unknown };
    input = typeof parsed.input === "string" ? parsed.input : "";
  } catch {
    // malformed request body: treated as no input
  }
  const attempt = upstream.attempts[0];
  const chunkText = new TextDecoder().decode(
    Uint8Array.from(atob(attempt.chunks_base64[0] ?? ""), (c) =>
      c.charCodeAt(0)
    ),
  );
  const completed = chunkText.includes('"type":"response.completed"') ||
    chunkText.includes("[DONE]");
  if (input.includes("PRIVATE-TRIGGER-4c9b1e27") || !completed) {
    return {
      status: 502,
      body: "stream terminated unexpectedly",
      completed: false,
      payload: "",
    };
  }
  return {
    status: 200,
    body: JSON.stringify({ payload: chunkText.slice(0, 80) }),
    completed: true,
    payload: chunkText.slice(0, 80),
  };
}
`;
}

/** One denied operation attempted by the consumer BEFORE any marker. If the
 * boundary is broken the operation succeeds and the consumer emits the
 * EXACT valid safe failure protocol so the verifier would prove it and the
 * negative test fails. */
function denialConsumerSource(operation: string): string {
  return `const base = "tests/fixtures/gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}";
const request = JSON.parse(await Deno.readTextFile(base + "/request.json"));
const upstream = JSON.parse(await Deno.readTextFile(base + "/upstream.json"));
if (request === null || upstream === null) Deno.exit(9);
${operation}
console.log("sentinel-replay-test:${TEST_ID}");
console.log("sentinel-causal-failure:stream terminated unexpectedly");
Deno.exit(1);
`;
}

/**
 * One attempted sibling snapshot/cache read with the FIXED denial protocol:
 * only an ACTUAL permission denial (Deno NotCapable/PermissionDenied, or the
 * equivalent OS denial) is the intended denial and exits 2 with a fixed
 * synthetic denial marker; a missing file or any other error exits 3 with a
 * different fixed marker so the negative test fails; a read that SUCCEEDS
 * emits the exact valid safe failure protocol (exit 1) so the verifier
 * returns a proof and the negative test fails. The attempting execution is
 * chosen by snapshot (derived from Deno.cwd(), never env), so a
 * sanitized->original attempt still lets the original run emit the valid
 * protocol first and the sanitized execution actually happens. The target is
 * derived from Deno.cwd() (never Deno.env): the sibling snapshot/cache of
 * the current run at the verifier's fixed task layout.
 */
function siblingDenialConsumerSource(
  attemptInOriginal: boolean,
  siblingRelative: string,
): string {
  const attemptGuard = attemptInOriginal ? "inOriginal" : "!inOriginal";
  return `import { handleStreamTrace } from "../src/app.ts";
const base = "tests/fixtures/gateway-replay/${INCIDENT_ID}/${CAPTURE_ID}";
const request = JSON.parse(await Deno.readTextFile(base + "/request.json"));
const upstream = JSON.parse(await Deno.readTextFile(base + "/upstream.json"));
if (request === null || upstream === null) Deno.exit(9);
const inOriginal = Deno.cwd().endsWith("/original");
if (${attemptGuard}) {
  try {
    await Deno.readTextFile(Deno.cwd() + "/${siblingRelative}");
  } catch (error) {
    if (error instanceof Deno.errors.NotCapable || error instanceof Deno.errors.PermissionDenied) {
      console.log("sentinel-causal-failure:denied");
      Deno.exit(2);
    }
    console.log("sentinel-causal-failure:unexpected-read-error");
    Deno.exit(3);
  }
  console.log("sentinel-replay-test:${TEST_ID}");
  console.log("sentinel-causal-failure:stream terminated unexpectedly");
  Deno.exit(1);
}
const outcome = handleStreamTrace(request, upstream);
console.log("sentinel-replay-test:${TEST_ID}");
if (outcome.status === 502 && outcome.completed === false && outcome.body === "stream terminated unexpectedly") {
  console.log("sentinel-causal-failure:stream terminated unexpectedly");
  Deno.exit(1);
}
if (outcome.status === 200) Deno.exit(0);
console.error("sentinel-causal-failure:unsupported causal outcome");
Deno.exit(2);
`;
}

interface CausalToyV1 {
  root: string;
  env: Record<string, string>;
  sha: GitSha;
  cleanup(): Promise<void>;
}

/**
 * Real outside-of-snapshot module targets: VALID TS/JSON files that exist in
 * the SOURCE repo tree. When the boundary holds the import is denied; when a
 * boundary is broken the module loads and the consumer would print the
 * marker + intended failure, which the tests then reject (no proof).
 */
async function outsideModuleTargets(root: string): Promise<void> {
  await Deno.writeTextFile(
    `${root}/outside.ts`,
    "export const forbidden = 1;\n",
  );
  await Deno.writeTextFile(
    `${root}/outside.json`,
    JSON.stringify({ forbidden: 1 }),
  );
  await Deno.mkdir(`${root}/outside`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/outside/app.ts`,
    "export const forbidden = 1;\n",
  );
}

async function makeCausalRepo(
  prefix: string,
  consumerFor: (root: string) => string,
  extra: { "src/app.ts"?: string; symlinkSrc?: boolean } = {},
): Promise<CausalToyV1> {
  const root = await Deno.makeTempDir({
    prefix: `sentinel-causal-verifier-${prefix}-`,
    dir: Deno.cwd(),
  });
  const env = testGitEnv(`${root}/home`);
  await Deno.mkdir(`${root}/home`, { recursive: true });
  await outsideModuleTargets(root);
  const init = await gitRun(root, ["init", "-q", "-b", "main"], env);
  assert.ok(init.ok, `toy init failed: ${init.stderr}`);
  const files: Record<string, string> = {
    "deno.json": JSON.stringify(
      {
        tasks: {
          replay: "deno run --allow-read=tests/,src/ scripts/replay.ts",
          test: "deno test --allow-read=tests/,src/ tests/",
        },
      },
      null,
      2,
    ) + "\n",
    "scripts/replay.ts": consumerFor(root),
    "src/app.ts": extra["src/app.ts"] ?? causalConsumerApp(),
  };
  let sha = await commitWith(root, env, files, "toy original: causal consumer");
  if (extra.symlinkSrc) {
    // src/ becomes a gitlink symlink pointing at a REAL directory outside
    // the snapshot; the checkout reproduces the symlink (no test-process
    // symlink permission needed).
    sha = await commitSymlink(root, env, "src", `${root}/outside`);
  }
  return {
    root,
    env,
    sha,
    cleanup: async () => {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

function concreteVerifier(
  toy: CausalToyV1,
  scratchDir: string,
  runtime?: ReplayRuntimeV1,
): GatewayLocalCausalVerifier {
  return new GatewayLocalCausalVerifier({
    sourcePath: toy.root,
    scratchDir,
    consumerPath: CAUSAL_CONSUMER_PATH,
    consumerRequestPath: REQUEST_PATH,
    consumerUpstreamPath: UPSTREAM_PATH,
    denoPath: Deno.execPath(),
    maxDurationMs: 60_000,
    maxOutputBytes: 262_144,
    ...(runtime === undefined ? {} : { runtime }),
  });
}

async function realVerify(
  toy: CausalToyV1,
  scratchDir: string,
  overrides: Partial<GatewayCausalVerifierInputV1> = {},
  runtime?: ReplayRuntimeV1,
): Promise<GatewayCausalProofV1 | null> {
  const verifier = concreteVerifier(toy, scratchDir, runtime);
  const input = await verifierInput({
    ...overrides,
    capture: {
      ...makeCapture(),
      gitSha: toy.sha,
      ...(overrides.capture ?? {}),
    },
  });
  return await verifier.verify(input);
}

Deno.test({
  name:
    "causal verifier (macOS): two independent original-SHA executions both reproduce the intended failure under the sandboxed fixed consumer protocol",
  ignore: darwinOnly,
  fn: async () => {
    const toy = await makeCausalRepo("positive", () => causalConsumerSource());
    const scratch =
      `${Deno.cwd()}/.causal-verifier-real-${crypto.randomUUID()}`;
    try {
      const proof = await realVerify(toy, scratch);
      assert.notEqual(proof, null, "no proof under the real macOS boundary");
      if (proof === null) return;
      assert.equal(proof.originalGitSha, toy.sha);
      assert.equal(proof.consumerCommandId, CAUSAL_CONSUMER_COMMAND_ID);
      assert.equal(proof.originalObservation.exitCode, 1);
      assert.equal(proof.sanitizedObservation.exitCode, 1);
      assert.deepEqual(proof.originalObservation.observedTestIds, [TEST_ID]);
      assert.deepEqual(proof.sanitizedObservation.observedTestIds, [TEST_ID]);
      // Both observations carry distinct observed outputs bound to the
      // intended specific failure, not a matcher hash.
      assert.notEqual(
        proof.originalObservation.outputDigest,
        proof.expectedFailureIdentity,
      );
      assert.notEqual(
        proof.sanitizedObservation.outputDigest,
        proof.expectedFailureIdentity,
      );
      // Cleanup verified: no restricted task dir remains.
      const leftovers: string[] = [];
      try {
        for await (const entry of Deno.readDir(scratch)) {
          leftovers.push(entry.name);
        }
      } catch {
        // never created
      }
      assert.deepEqual(leftovers, []);
    } finally {
      await toy.cleanup();
      await Deno.remove(scratch, { recursive: true }).catch(() => {});
    }
  },
});

const SIBLING_CACHE_FILE = "sentinel-causal-sibling.txt";
const SIBLING_CACHE_SENTINEL = "public sibling cache sentinel\n";

interface DenialCaseV1 {
  name: string;
  /** Committed consumer source (attempted denied op, fixed protocols). */
  source: (toyRoot: string) => string;
  /** Commit a gitlink symlink for `src` (symlink-import negative). */
  symlinkSrc?: boolean;
  /**
   * Precreates a PUBLIC synthetic sibling cache sentinel OUTSIDE the sandbox
   * before the execution that attempts the crossed-boundary read (target
   * derived from the actual consumer cwd, never env) and verifies the target
   * exists, so the denial cannot be a missing-file accident. The recording
   * wrapper records the actual command result.
   */
  prepareConsumer?: (input: ReplayCommandInputV1) => Promise<void>;
  /** Which snapshot execution must produce the intended denial (exit 2 +
   * fixed marker); undefined for the uncaught-denial cases. */
  denialInOriginal?: boolean;
}

/**
 * Trusted recording wrapper over the REAL runtime — never a fake runtime, no
 * predicate substitutes for any execution. It precreates public synthetic
 * sibling sentinels outside the sandbox, verifies they exist, and records
 * the ACTUAL command result so a denial is asserted on the correct execution.
 */
class RecordingRealRuntime implements ReplayRuntimeV1 {
  readonly runs: {
    input: ReplayCommandInputV1;
    result: ReplayCommandResultV1;
  }[] = [];

  constructor(
    private readonly inner: ReplayRuntimeV1,
    private readonly prepare: (input: ReplayCommandInputV1) => Promise<void> =
      async () => {},
  ) {}

  async run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
    await this.prepare(input);
    const result = await this.inner.run(input);
    this.runs.push({ input, result });
    return result;
  }
}

/** Precreate the sibling cache sentinel for the attempting execution only. */
function siblingCacheSentinelPrepare(
  attemptInOriginal: boolean,
): (input: ReplayCommandInputV1) => Promise<void> {
  return async (input: ReplayCommandInputV1) => {
    if (input.args[0] !== "-p") return;
    const inOriginal = input.cwd.endsWith("/original");
    if (inOriginal !== attemptInOriginal) return;
    const siblingHome = inOriginal ? "home-sanitized" : "home-original";
    const target =
      `${input.cwd}/../${siblingHome}/.cache/deno/${SIBLING_CACHE_FILE}`;
    await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeTextFile(target, SIBLING_CACHE_SENTINEL);
    const info = await Deno.lstat(target);
    assert.ok(
      info.isFile,
      "the public sibling cache sentinel must exist outside the sandbox",
    );
  };
}

/**
 * The intended sibling denial must be OBSERVED on the correct execution: the
 * attempting snapshot's consumer run exits 2 and prints the FIXED synthetic
 * denial marker — never only `verify() === null`. For a sanitized->original
 * attempt the original run must first emit the valid safe failure protocol
 * (exit 1), proving the sanitized execution actually happened.
 */
function assertDenialRun(
  recording: RecordingRealRuntime,
  name: string,
  denialInOriginal: boolean,
): void {
  const consumerRuns = recording.runs.filter((run) =>
    run.input.args[0] === "-p"
  );
  const expectedText = denialInOriginal ? "original" : "sanitized";
  const denialRun = consumerRuns.find((run) =>
    run.input.cwd.endsWith(`/${expectedText}`)
  );
  assert.ok(
    denialRun !== undefined,
    `${name}: the attempting (${expectedText}) execution must have run`,
  );
  assert.equal(denialRun!.result.exitCode, 2, `${name}: intended denial is 2`);
  const stdout = new TextDecoder().decode(denialRun!.result.stdout);
  assert.ok(
    stdout.includes("sentinel-causal-failure:denied"),
    `${name}: the fixed synthetic denial marker must be on stdout`,
  );
  if (!denialInOriginal) {
    // sanitized->original: the first (original) run emitted the valid safe
    // protocol, so the sanitized execution actually happened.
    const originalRun = consumerRuns.find((run) =>
      run.input.cwd.endsWith("/original")
    );
    assert.ok(originalRun !== undefined, `${name}: original run must exist`);
    assert.equal(originalRun!.result.exitCode, 1, `${name}: valid original`);
    const originalStdout = new TextDecoder().decode(originalRun!.result.stdout);
    assert.ok(
      originalStdout.includes(
        "sentinel-causal-failure:stream terminated unexpectedly",
      ),
      `${name}: original must print the fixed safe failure protocol`,
    );
    assert.equal(
      consumerRuns.length,
      2,
      `${name}: the sanitized execution must actually have run`,
    );
  } else {
    assert.equal(
      consumerRuns.length,
      1,
      `${name}: a denied original aborts before the sanitized run`,
    );
  }
}

const DENIAL_CASES: DenialCaseV1[] = [
  {
    name: "outside static TS import",
    source: (toyRoot) =>
      denialConsumerSource(
        `import { forbidden } from "${toyRoot}/outside.ts";\nvoid forbidden;`,
      ),
  },
  {
    name: "outside static JSON import",
    source: (toyRoot) =>
      denialConsumerSource(
        `import data from "${toyRoot}/outside.json" with { type: "json" };\nvoid data;`,
      ),
  },
  {
    name: "symlinked module import",
    source: () =>
      denialConsumerSource(
        `import { forbidden } from "../src/app.ts";\nvoid forbidden;`,
      ),
    symlinkSrc: true,
  },
  {
    name: "runtime read outside the snapshot",
    source: () =>
      denialConsumerSource(`await Deno.readTextFile("/etc/passwd");`),
  },
  {
    name: "sibling snapshot read original to sanitized",
    source: () =>
      siblingDenialConsumerSource(true, "../sanitized/scripts/replay.ts"),
    denialInOriginal: true,
  },
  {
    name: "sibling snapshot read sanitized to original",
    source: () =>
      siblingDenialConsumerSource(false, "../original/scripts/replay.ts"),
    denialInOriginal: false,
  },
  {
    name: "sibling cache read original to sanitized",
    source: () =>
      siblingDenialConsumerSource(
        true,
        `../home-sanitized/.cache/deno/${SIBLING_CACHE_FILE}`,
      ),
    prepareConsumer: siblingCacheSentinelPrepare(true),
    denialInOriginal: true,
  },
  {
    name: "sibling cache read sanitized to original",
    source: () =>
      siblingDenialConsumerSource(
        false,
        `../home-original/.cache/deno/${SIBLING_CACHE_FILE}`,
      ),
    prepareConsumer: siblingCacheSentinelPrepare(false),
    denialInOriginal: false,
  },
  {
    name: "write outside the allowed scope",
    source: () =>
      denialConsumerSource(
        `await Deno.writeTextFile(Deno.cwd() + "/leak.txt", "forbidden");`,
      ),
  },
  {
    name: "network access",
    source: () =>
      denialConsumerSource(
        `await (await fetch("https://example.com")).text();`,
      ),
  },
  {
    name: "process spawn",
    source: () =>
      denialConsumerSource(
        `await new Deno.Command("echo", { args: ["forbidden"] }).output();`,
      ),
  },
];

Deno.test({
  name:
    "causal verifier (macOS): real OS/Deno denials are no proof without any fallback",
  ignore: darwinOnly,
  fn: async () => {
    for (const denialCase of DENIAL_CASES) {
      const name = denialCase.name;
      const toy = await makeCausalRepo(
        name.replaceAll(" ", "-"),
        (root) => denialCase.source(root),
        { symlinkSrc: denialCase.symlinkSrc === true },
      );
      const scratch =
        `${Deno.cwd()}/.causal-verifier-denial-${crypto.randomUUID()}`;
      const recording = new RecordingRealRuntime(
        new DenoReplayRuntime(Deno.env.get("PATH") ?? "/usr/bin:/bin"),
        denialCase.prepareConsumer,
      );
      try {
        const proof = await realVerify(toy, scratch, {}, recording);
        assert.equal(proof, null, `${name}: a denied op must produce no proof`);
        if (denialCase.denialInOriginal !== undefined) {
          assertDenialRun(recording, name, denialCase.denialInOriginal);
        }
        // Settled denial: the restricted scratch is cleaned up.
        const leftovers: string[] = [];
        try {
          for await (const entry of Deno.readDir(scratch)) {
            leftovers.push(entry.name);
          }
        } catch {
          // never created
        }
        assert.deepEqual(
          leftovers,
          [],
          `${name}: no private scratch may remain after a settled denial`,
        );
      } finally {
        await toy.cleanup();
        await Deno.remove(scratch, { recursive: true }).catch(() => {});
      }
    }
  },
});

/** Upstream trace whose chunk completes (no intended failure remains). */
function completedUpstream(): RetainedGatewayCaptureV1["upstream"] {
  const chunk =
    'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n';
  return {
    version: 1,
    attempts: [{
      provider: "chatgpt_codex",
      status: 200,
      content_type: "text/event-stream",
      chunks_base64: [btoa(chunk)],
      terminal: "eof",
    }],
    attempts_truncated: false,
    bytes_truncated: false,
    chunks_truncated: false,
  };
}

Deno.test({
  name:
    "causal verifier (macOS): a redaction-damaged capture (private trigger lost) is no proof",
  ignore: darwinOnly,
  fn: async () => {
    const toy = await makeCausalRepo(
      "textdamage",
      () => causalConsumerSource(),
    );
    const scratch =
      `${Deno.cwd()}/.causal-verifier-damage-${crypto.randomUUID()}`;
    try {
      const triggerBody =
        `{"model":"synthetic-model","input":"PRIVATE-TRIGGER-4c9b1e27","stream":true}`;
      // The actual composition sanitizes the SAME capture: the completed
      // upstream trace plus a public request body (trigger removed). The
      // original run fails ONLY because of the private trigger; the
      // sanitized run passes → no proof.
      const sanitizedEntries = [
        {
          path: REQUEST_PATH,
          bytes: encode(JSON.stringify({
            endpoint: "/v1/responses",
            method: "POST",
            contentType: "application/json",
            body:
              '{"model":"public-model","input":"fixture text","stream":true}',
          })),
        },
        {
          path: UPSTREAM_PATH,
          bytes: encode(JSON.stringify(completedUpstream())),
        },
      ];
      const proof = await realVerify(toy, scratch, {
        capture: {
          ...makeCapture(),
          body: encode(triggerBody),
          upstream: completedUpstream(),
        },
        fixtureEntries: sanitizedEntries,
        bundleDigest: await computeReplayFixtureDigest(sanitizedEntries),
      });
      // The redaction-damaged fixture cannot reproduce the original failure:
      // the verifier returns no proof (the ordinary redacted limitation
      // stays at the consuming boundary).
      assert.equal(proof, null, "no proof when the fixture loses the trigger");
    } finally {
      await toy.cleanup();
      await Deno.remove(scratch, { recursive: true }).catch(() => {});
    }
  },
});
