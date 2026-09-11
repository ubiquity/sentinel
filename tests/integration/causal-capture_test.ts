/**
 * Plan 01: one safe captured-request repair crosses the REAL repair loop.
 *
 * The actual GatewayReplayComposition (authenticated decrypt → structural
 * sanitizer → deterministic trusted fixture) is composed through the actual
 * composeRepairHost/runComposedRepairHost with the actual ReplayPortImpl
 * (credential-free git, disposable scratch clones, real `deno task replay` /
 * `deno task test` at exact revisions), a trusted causal-proof verifier
 * capability, the real CodexImplementationPort with an in-process fake
 * session/checkout/receipt-verifier, the real GitStateStore with the real
 * RollingStartBudget/DurableGitHubCooldownGate, and the recording FakeGithub.
 *
 * The positive path proves: the incident advances past missing_evidence, the
 * captured request is reproduced as an intended failure with ZERO
 * limitations under a fully bound trusted proof, a candidate is validated,
 * the identical permanent fixture runs through the candidate's ordinary deno
 * task test and passes with zero limitations, a ReplayResultV1 with exact
 * original/candidate/fixture/command/test identities and limitations [] is
 * persisted, and the loop reaches PR/review publication intent via the fake
 * GitHub transport.
 *
 * Negative paths stay blocked or unavailable as appropriate: no
 * verifier/proof, mismatched bundle digest, wrong original SHA, sanitizer
 * removing the failure (text-dependent oracle), and an unrelated nonzero
 * candidate failure — never a fabricated clean proof.
 *
 * A controlled synthetic private sentinel lives inside the authenticated
 * capture; the trusted test verifier consumes it and the test asserts it
 * never appears in committed fixture bytes, the candidate Git tree, fake
 * model/session input, public evidence/state or error text.
 *
 * Dispatch metadata: the committed toy consumer and its permanent regression
 * test select their inputs EXCLUSIVELY through the fixed root
 * `.sentinel-replay-input.json` record written by the trusted verifier (both
 * snapshots) and by the ReplayPort (candidate checkout). A missing dispatcher
 * therefore cannot pass by hardcoded fixture reads, and the metadata carries
 * only the two fixed fixture paths plus the exact ordered trusted test ids.
 * This toy proves the dispatch/selection wiring, not the target gateway
 * converter: the actual converter is tested separately in its own repository.
 *
 * Public synthetic data only; no network, no model call, no credentials.
 */

import assert from "node:assert/strict";

import { artifactRef } from "../../src/adapters/gateway/incident-adapter.ts";
import type {
  GatewayReplayComposition,
} from "../../src/adapters/gateway/replay-composition.ts";
import type { GatewayAuthProviderV1 } from "../../src/adapters/gateway/http.ts";
import {
  type ArtifactStoreLimitsV1,
  LocalArtifactStore,
} from "../../src/adapters/gateway/store.ts";
import { asFixtureDigest, asGitSha } from "../../src/contracts/brands.ts";
import type {
  CommandId,
  FixtureDigest,
  GitSha,
  WorkItemId,
} from "../../src/contracts/brands.ts";
import type {
  MergeOutcomeV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import { parseRepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  CAUSAL_CONSUMER_COMMAND_ID,
  deriveExpectedFailureIdentity,
  GATEWAY_CAUSAL_VERIFIER_ID,
  gatewayCausalProofRef,
} from "../../src/replay/causal-proof.ts";
import type { GatewayCausalProofV1 } from "../../src/replay/causal-proof.ts";
import {
  CAUSAL_SANDBOX_EXEC_PATH,
  GatewayLocalCausalVerifier,
} from "../../src/replay/causal-verifier.ts";
import type {
  GatewayCausalVerifierInputV1,
  GatewayCausalVerifierV1,
} from "../../src/replay/causal-verifier.ts";
import { markerProofParser } from "../../src/replay/fixture.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import type {
  ReplayCommandInputV1,
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";
import type { ReplayPortImpl } from "../../src/replay/port.ts";
import type { CodexSessionV1 } from "../../src/repair/codex-transport.ts";
import type { CodexServerNotificationV1 } from "../../src/repair/codex-transport.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import type { RepairHostOptionsV1 } from "../../src/host/repair.ts";
import { composeRepairHost } from "../../src/host/repair.ts";
import { runComposedRepairHost } from "../../src/host/run.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import {
  commitWith,
  gitRun,
  revParse,
  testGitEnv,
  toyIsolation,
} from "../replay/helpers.ts";
import {
  CAPTURE_ID_A,
  INCIDENT_A,
  jsonResponse,
  makeIndexPage,
  makeIndexRow,
  makeReplayPage,
  recordingTransport,
  sha256hex,
} from "../adapters/gateway/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  makeIntegrationCtx,
  REPO,
  SHA1,
  T0,
} from "./helpers.ts";

const INDEX_PATH = "/admin/sentinel/incidents";
const REPLAY_PATH = "/admin/sentinel/replay-captures";

const TEST_ID = "gateway:stream-termination";
const GATEWAY_COMMAND = "replay" as CommandId;
const TEST_COMMAND = "test" as CommandId;
const EXPECTED_FAILURE = {
  reason: "fixture reproduced the recorded upstream failure",
  match: { kind: "contains" as const, text: "stream terminated unexpectedly" },
};
const SENTINEL = "PRIVATE-SENTINEL-7f3d9c1a";
const TRIGGER = "PRIVATE-TRIGGER-4c9b1e27";

const GATEWAY_LIMITS: ArtifactStoreLimitsV1 = {
  totalMaxBytes: 1_000_000,
  artifactMaxBytes: 100_000,
  retentionMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
};

const RETAINED_NAMESPACE = "uos-sentinel-replay-v1";
const RETAINED_FINGERPRINT_NAMESPACE = "uos-sentinel-replay-v2:fingerprint";
const RETAINED_CASE_GROUP_NAMESPACE = "uos-sentinel-replay-v1:case-group";
const TEXT_ENCODER = new TextEncoder();
const RETAINED_TTL_MS = 48 * 60 * 60 * 1_000;
const TEST_ID_MARKER = `sentinel-replay-test:${TEST_ID}`;

// ---------------------------------------------------------------------------
// Producer capture crafting (independent of the decryptor; the same frozen
// HKDF/AES-GCM/gzip framing and HMAC identities over public synthetic bytes).
// ---------------------------------------------------------------------------

function standardBase64(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const remaining = bytes.byteLength - offset;
    const a = bytes[offset]!;
    const b = remaining > 1 ? bytes[offset + 1]! : 0;
    const c = remaining > 2 ? bytes[offset + 2]! : 0;
    output += alphabet[a >> 2]!;
    output += alphabet[((a & 0x03) << 4) | (b >> 4)]!;
    output += remaining > 1 ? alphabet[((b & 0x0f) << 2) | (c >> 6)]! : "=";
    output += remaining > 2 ? alphabet[c & 0x3f]! : "=";
  }
  return output;
}

function toBase64Url(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const remaining = bytes.byteLength - offset;
    const a = bytes[offset]!;
    const b = remaining > 1 ? bytes[offset + 1]! : 0;
    const c = remaining > 2 ? bytes[offset + 2]! : 0;
    output += alphabet[a >> 2]!;
    output += alphabet[((a & 0x03) << 4) | (b >> 4)]!;
    output += remaining > 1 ? alphabet[((b & 0x0f) << 2) | (c >> 6)]! : "";
    output += remaining > 2 ? alphabet[c & 0x3f]! : "";
  }
  return output;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      return `{${
        Object.keys(record).sort().map((key) =>
          `${JSON.stringify(key)}:${canonicalJson(record[key])}`
        ).join(",")
      }}`;
    }
    default:
      throw new Error(`cannot canonically serialize ${typeof value}`);
  }
}

function stableHeaderText(headers: Record<string, string>): string {
  return Object.entries(headers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}`)
    .join("\n");
}

function frameParts(value: Uint8Array): Uint8Array[] {
  const length = new Uint8Array(8);
  new DataView(length.buffer).setBigUint64(0, BigInt(value.byteLength), false);
  return [length, value];
}

function concatParts(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

async function hmacHex(
  keyBytes: Uint8Array<ArrayBuffer>,
  purpose: "fingerprint" | "case-group",
  parts: readonly Uint8Array[],
): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: TEXT_ENCODER.encode(RETAINED_NAMESPACE),
      info: TEXT_ENCODER.encode(purpose),
    },
    material,
    256,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, concatParts(parts));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function v2Fingerprint(
  keyBytes: Uint8Array<ArrayBuffer>,
  metadata: Record<string, unknown>,
  body: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const parts = [
    ...frameParts(TEXT_ENCODER.encode(RETAINED_FINGERPRINT_NAMESPACE)),
    ...frameParts(TEXT_ENCODER.encode(metadata.method as string)),
    ...frameParts(TEXT_ENCODER.encode(metadata.endpoint as string)),
    ...frameParts(
      TEXT_ENCODER.encode(
        stableHeaderText(
          metadata.compatibility_headers as Record<string, string>,
        ),
      ),
    ),
    ...frameParts(body),
    ...frameParts(TEXT_ENCODER.encode(metadata.failure_signature as string)),
    ...frameParts(TEXT_ENCODER.encode(canonicalJson(metadata.upstream))),
  ];
  return hmacHex(keyBytes, "fingerprint", parts);
}

function v2CaseGroup(
  keyBytes: Uint8Array<ArrayBuffer>,
  metadata: Record<string, unknown>,
  body: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const parts = [
    ...frameParts(TEXT_ENCODER.encode(RETAINED_CASE_GROUP_NAMESPACE)),
    ...frameParts(TEXT_ENCODER.encode(metadata.method as string)),
    ...frameParts(TEXT_ENCODER.encode(metadata.endpoint as string)),
    ...frameParts(
      TEXT_ENCODER.encode(
        stableHeaderText(
          metadata.compatibility_headers as Record<string, string>,
        ),
      ),
    ),
    ...frameParts(body),
  ];
  return hmacHex(keyBytes, "case-group", parts);
}

async function craftEnvelope(
  plaintext: Uint8Array<ArrayBuffer>,
  fingerprint: string,
  keyBytes: Uint8Array<ArrayBuffer>,
): Promise<
  { ciphertext: Uint8Array<ArrayBuffer>; iv: Uint8Array<ArrayBuffer> }
> {
  const material = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: TEXT_ENCODER.encode(RETAINED_NAMESPACE),
      info: TEXT_ENCODER.encode("encryption"),
    },
    material,
    256,
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    derived,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const compressed = new Uint8Array(
    await new Response(
      new Blob([plaintext]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: TEXT_ENCODER.encode(
          `${RETAINED_NAMESPACE}\u0000${fingerprint}`,
        ),
      },
      aesKey,
      compressed,
    ),
  );
  compressed.fill(0);
  return { ciphertext: encrypted, iv };
}

function encodeEnvelope(
  metadata: Record<string, unknown>,
  body: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const metadataBytes = TEXT_ENCODER.encode(JSON.stringify(metadata));
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, metadataBytes.byteLength, false);
  const output = new Uint8Array(4 + metadataBytes.byteLength + body.byteLength);
  output.set(size, 0);
  output.set(metadataBytes, 4);
  output.set(body, 4 + metadataBytes.byteLength);
  return output;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

interface CraftedCaptureV1 {
  manifest: Record<string, unknown>;
  chunks: string[];
  digest: string;
  fingerprint: string;
}

/**
 * One captured gateway incident bound to the exact toy original SHA. The
 * private sentinel lives in the authenticated request body, the private
 * upstream response id and the private request id — never outside the
 * encrypted artifact.
 */
async function craftCapture(
  keyBytes: Uint8Array<ArrayBuffer>,
  originalSha: GitSha,
  capturedAtMs: number,
  options: {
    bodyInput?: string;
    completed?: boolean;
  } = {},
): Promise<CraftedCaptureV1> {
  const chunkData = options.completed
    ? `data: {"type":"response.completed","response":{"id":"${SENTINEL}"}}\n\n`
    : `data: {"type":"response.created","response":{"id":"${SENTINEL}"}}\n\n`;
  const upstream = {
    version: 1,
    attempts: [{
      provider: "chatgpt_codex",
      status: 200,
      content_type: "text/event-stream",
      chunks_base64: [standardBase64(TEXT_ENCODER.encode(chunkData))],
      terminal: "eof",
    }],
    attempts_truncated: false,
    bytes_truncated: false,
    chunks_truncated: false,
  };
  const bodyInput = options.bodyInput ??
    `{"model":"synthetic-model","input":"${SENTINEL}","stream":true}`;
  const body = TEXT_ENCODER.encode(bodyInput);
  const metadata = {
    version: 2,
    captured_at_ms: capturedAtMs,
    endpoint: "/v1/responses",
    method: "POST",
    content_type: "application/json",
    compatibility_headers: { accept: "text/event-stream" },
    failure_signature:
      '{"status":502,"stream":true,"completed":false,"terminal_type":null,"failure_kind":"missing_sse_terminal","framing_valid":true,"provider_route":"synthetic"}',
    observation: {
      status: 502,
      stream: true,
      completed: false,
      terminal_type: null,
      failure_kind: "missing_sse_terminal",
      synthetic_terminal_type: null,
      provider_route: "synthetic",
    },
    client_observation: {
      status: 502,
      stream: true,
      completed: false,
      terminal_type: null,
      failure_kind: "missing_sse_terminal",
      framing_valid: true,
      provider_route: "synthetic",
    },
    request_id: SENTINEL,
    git_sha: originalSha,
    deno_revision: "synthetic-revision-2",
    upstream,
  };
  const fingerprint = await v2Fingerprint(keyBytes, metadata, body);
  const caseGroupDigest = await v2CaseGroup(keyBytes, metadata, body);
  const plaintext = encodeEnvelope(metadata, body);
  const { ciphertext, iv } = await craftEnvelope(
    plaintext,
    fingerprint,
    keyBytes,
  );
  const manifest = {
    version: 1,
    capture_id: CAPTURE_ID_A,
    fingerprint,
    case_group_digest: caseGroupDigest,
    captured_at_ms: capturedAtMs,
    expires_at_ms: capturedAtMs + RETAINED_TTL_MS,
    algorithm: "AES-256-GCM",
    compression: "gzip",
    iv: toBase64Url(iv),
    chunk_count: 1,
    ciphertext_bytes: ciphertext.byteLength,
  };
  return {
    manifest,
    chunks: [toBase64Url(ciphertext)],
    digest: await sha256hex(ciphertext),
    fingerprint,
  };
}

// ---------------------------------------------------------------------------
// Real temporary toy target repository (credential-free; original/candidate/
// unrelated). Original bug, candidate fix + permanent regression, and an
// unrelated breakage; the candidate commits the permanent fixture bytes.
// ---------------------------------------------------------------------------

function toyApp(kind: "original" | "candidate" | "unrelated"): string {
  const original = `/** Toy gateway stream handler (original). */
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
    Uint8Array.from(atob(attempt.chunks_base64[0] ?? ""), (c) => c.charCodeAt(0)),
  );
  const completed = chunkText.includes('"type":"response.completed"') ||
    chunkText.includes("[DONE]");
  if (input.includes("PRIVATE-TRIGGER-4c9b1e27") || !completed) {
    return { status: 502, body: "stream terminated unexpectedly", completed: false, payload: "" };
  }
  return { status: 200, body: JSON.stringify({ payload: chunkText.slice(0, 80) }), completed: true, payload: chunkText.slice(0, 80) };
}
`;
  const candidate = `/** Toy gateway stream handler (candidate fix). */
export function handleStreamTrace(
  _request: unknown,
  upstream: { attempts: { terminal: string; chunks_base64: string[] }[] },
): { status: number; body: string; completed: boolean; payload: string } {
  const attempt = upstream.attempts[0];
  const chunkText = new TextDecoder().decode(
    Uint8Array.from(atob(attempt.chunks_base64[0] ?? ""), (c) => c.charCodeAt(0)),
  );
  return { status: 200, body: JSON.stringify({ payload: chunkText.slice(0, 80) }), completed: true, payload: chunkText.slice(0, 80) };
}
`;
  const unrelated = `/** Toy gateway stream handler (unrelated breakage). */
export function handleStreamTrace(
  _request: unknown,
  _upstream: { attempts: { terminal: string; chunks_base64: string[] }[] },
): { status: number; body: string; completed: boolean; payload: string } {
  return { status: 503, body: "unrelated failure: boom", completed: false, payload: "" };
}
`;
  return { original, candidate, unrelated }[kind];
}

function toyRegressionTest(): string {
  return `import assert from "node:assert/strict";
import { handleStreamTrace } from "../src/app.ts";

Deno.test("gateway: stream termination honors recorded upstream", async () => {
  console.log("${TEST_ID_MARKER}");
  const expectedRequest = "tests/fixtures/gateway-replay/${INCIDENT_A}/${CAPTURE_ID_A}/request.json";
  const expectedUpstream = "tests/fixtures/gateway-replay/${INCIDENT_A}/${CAPTURE_ID_A}/upstream.json";
  const dispatchBytes = await Deno.readFile(".sentinel-replay-input.json");
  if (dispatchBytes.byteLength > 16 * 1024) Deno.exit(3);
  const dispatch = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(dispatchBytes));
  assert.equal(dispatch.version, "v1");
  assert.deepEqual(Object.keys(dispatch).sort(), ["requestPath", "testIds", "upstreamPath", "version"]);
  assert.equal(dispatch.requestPath, expectedRequest);
  assert.equal(dispatch.upstreamPath, expectedUpstream);
  assert.deepEqual(dispatch.testIds, ["${TEST_ID}"]);
  const request = JSON.parse(await Deno.readTextFile(dispatch.requestPath));
  const upstream = JSON.parse(await Deno.readTextFile(dispatch.upstreamPath));
  assert.equal(JSON.parse(request.body).model, "synthetic-model");
  const outcome = handleStreamTrace(request, upstream);
  assert.equal(
    outcome.status,
    200,
    "expected 200 but got " + outcome.status + ": " + outcome.body,
  );
});
`;
}

/**
 * The trusted fixed consumer committed at the original SHA as
 * `scripts/replay.ts` — the ONLY consumer path bound to the trusted consumer
 * command identity. It selects its inputs EXCLUSIVELY through the fixed root
 * dispatch metadata (`.sentinel-replay-input.json`, exact canonical
 * `{version,requestPath,upstreamPath,testIds}`) written by the trusted
 * verifier into both snapshots and by the ReplayPort into the candidate
 * checkout; a missing, malformed or differently-selected dispatcher exits 3,
 * so hardcoded fixture reads can never pass. It executes the actual toy
 * target handler against the selected request/upstream fixtures, prints the
 * fixed test identity, then emits the EXACT supported safe failure protocol —
 * the single fixed `sentinel-causal-failure:stream terminated unexpectedly`
 * line on stdout, empty stderr, exit 1 — ONLY for the intended outcome (502,
 * incomplete, exact failure body); status 200 prints only the test ids and
 * exits 0; every other outcome emits only a fixed "unsupported causal
 * outcome" diagnostic and exits 2. Raw request/upstream bytes and raw
 * outcome.body are never printed.
 */
function toyReplayScript(): string {
  return `import { handleStreamTrace } from "../src/app.ts";
const expectedRequest = "tests/fixtures/gateway-replay/${INCIDENT_A}/${CAPTURE_ID_A}/request.json";
const expectedUpstream = "tests/fixtures/gateway-replay/${INCIDENT_A}/${CAPTURE_ID_A}/upstream.json";
const dispatchBytes = await Deno.readFile(".sentinel-replay-input.json");
if (dispatchBytes.byteLength > 16 * 1024) Deno.exit(3);
const dispatch = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(dispatchBytes));
if (dispatch.version !== "v1") Deno.exit(3);
if (Object.keys(dispatch).sort().join(",") !== "requestPath,testIds,upstreamPath,version") Deno.exit(3);
if (dispatch.requestPath !== expectedRequest) Deno.exit(3);
if (dispatch.upstreamPath !== expectedUpstream) Deno.exit(3);
if (JSON.stringify(dispatch.testIds) !== JSON.stringify(["${TEST_ID}"])) Deno.exit(3);
const request = JSON.parse(await Deno.readTextFile(dispatch.requestPath));
const upstream = JSON.parse(await Deno.readTextFile(dispatch.upstreamPath));
const outcome = handleStreamTrace(request, upstream);
console.log("${TEST_ID_MARKER}");
if (outcome.status === 502 && outcome.completed === false && outcome.body === "stream terminated unexpectedly") {
  console.log("sentinel-causal-failure:stream terminated unexpectedly");
  Deno.exit(1);
}
if (outcome.status === 200) Deno.exit(0);
console.error("sentinel-causal-failure:unsupported causal outcome");
Deno.exit(2);
`;
}

// The toy's own task read scope mirrors the frozen root-dispatch consumer
// protocol (`--allow-read=.`): the committed consumer and the permanent
// regression test read the fixed root `.sentinel-replay-input.json`
// dispatcher, which is outside `tests/` and `src/`.
const TOY_DENO_JSON = JSON.stringify(
  {
    tasks: {
      replay: "deno run --allow-read=. scripts/replay.ts",
      test: "deno test --allow-read=. tests/",
    },
  },
  null,
  2,
) + "\n";

interface ToyRepoV1 {
  root: string;
  env: Record<string, string>;
  originalSha: GitSha;
  cleanup(): Promise<void>;
}

/** Phase 1: one real toy repo with the ORIGINAL failing revision only. */
async function makeToyRepo(prefix: string): Promise<ToyRepoV1> {
  const root = await Deno.makeTempDir({
    prefix: `sentinel-causal-capture-toy-${prefix}-`,
    dir: Deno.cwd(),
  });
  const env = testGitEnv(`${root}/home`);
  await Deno.mkdir(`${root}/home`, { recursive: true });
  const init = await gitRun(root, ["init", "-q", "-b", "main"], env);
  assert.ok(init.ok, `toy init failed: ${init.stderr}`);
  await commitWith(
    root,
    env,
    {
      "deno.json": TOY_DENO_JSON,
      "src/app.ts": toyApp("original"),
      "scripts/replay.ts": toyReplayScript(),
      "tests/regression_test.ts": toyRegressionTest(),
    },
    "toy original: missing terminator produces 502",
  );
  const originalSha = await revParse(root, env);
  return {
    root,
    env,
    originalSha,
    cleanup: async () => {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

/** Phase 2: commit the candidate fix plus the exact composed fixture bytes. */
async function commitCandidateFixture(
  toy: ToyRepoV1,
  entries: { path: string; bytes: Uint8Array }[],
): Promise<GitSha> {
  const fixedApp = toyApp("candidate");
  const files: [string, Uint8Array][] = [
    ["src/app.ts", TEXT_ENCODER.encode(fixedApp)],
    ...entries.map((entry) =>
      [entry.path, entry.bytes] as [string, Uint8Array]
    ),
  ];
  await writeCommitBytes(
    toy.root,
    toy.env,
    files,
    "toy candidate: fix + permanent regression fixture",
  );
  return revParse(toy.root, toy.env);
}

/** Phase 3: an unrelated breaking revision on top of the candidate. */
async function commitUnrelated(toy: ToyRepoV1): Promise<GitSha> {
  await writeCommit(
    toy.root,
    toy.env,
    [["src/app.ts", toyApp("unrelated")]],
    "toy unrelated: different breakage",
  );
  return revParse(toy.root, toy.env);
}

async function writeCommit(
  root: string,
  env: Record<string, string>,
  files: [string, string][],
  message: string,
): Promise<void> {
  for (const [path, text] of files) {
    const full = `${root}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, text);
  }
  await commitAll(root, env, message);
}

async function writeCommitBytes(
  root: string,
  env: Record<string, string>,
  files: [string, Uint8Array][],
  message: string,
): Promise<void> {
  for (const [path, bytes] of files) {
    const full = `${root}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeFile(full, bytes);
  }
  await commitAll(root, env, message);
}

async function commitAll(
  root: string,
  env: Record<string, string>,
  message: string,
): Promise<void> {
  const add = await gitRun(root, ["add", "-A"], env);
  if (!add.ok) throw new Error(`toy add failed: ${add.stderr}`);
  const commit = await gitRun(root, ["commit", "-q", "-m", message], env);
  if (!commit.ok) throw new Error(`toy commit failed: ${commit.stderr}`);
}

// ---------------------------------------------------------------------------
// Concrete trusted causal verifier (plan 01): the real local Deno consumer
// protocol. It materializes two independent exact-original-SHA snapshots,
// places the private original request/upstream in one disposable restricted
// verifier scratch snapshot and the exact composed sanitized bundle in the
// other, executes the SAME committed trusted consumer in both under the
// confined Deno protocol, and returns only a fully bound proof carrying
// observed execution evidence. There is no oracle and no input-string
// predicate anywhere in the verifier or the test.
// ---------------------------------------------------------------------------

/** Fixed consumer fixtures paths of the committed toy consumer. */
function causalConsumerFixtureBase(): string {
  return `tests/fixtures/gateway-replay/${INCIDENT_A}/${CAPTURE_ID_A}`;
}

function makeConcreteVerifier(
  toy: ToyRepoV1,
  tmp: string,
  runtime: ReplayRuntimeV1,
): GatewayCausalVerifierV1 {
  const base = causalConsumerFixtureBase();
  return new GatewayLocalCausalVerifier({
    sourcePath: toy.root,
    scratchDir: `${tmp}/causal-verifier-scratch`,
    // The fixed `scripts/replay.ts` consumer bound to the trusted
    // trusted-consumer command identity (an interchangeable consumer path is
    // rejected by the verifier constructor).
    consumerPath: "scripts/replay.ts",
    consumerRequestPath: `${base}/request.json`,
    consumerUpstreamPath: `${base}/upstream.json`,
    denoPath: Deno.execPath(),
    maxDurationMs: 60_000,
    maxOutputBytes: 262_144,
    runtime,
  });
}

/**
 * Negative-case mutation wrapper only: the produced proof is mutated after
 * the concrete verifier decided it, so a bound-mismatch case stays blocked
 * exactly like a missing proof. Never used to fabricate a proof.
 */
function mutateVerifier(
  inner: GatewayCausalVerifierV1,
  mutate: (proof: GatewayCausalProofV1) => GatewayCausalProofV1 | null,
): GatewayCausalVerifierV1 {
  return {
    async verify(input: GatewayCausalVerifierInputV1) {
      const proof = await inner.verify(input);
      return proof === null ? null : mutate(proof);
    },
  };
}

// ---------------------------------------------------------------------------
// Injected fake external transports (recording, no product logic).
// ---------------------------------------------------------------------------

class FakeCodexSession implements CodexSessionV1 {
  readonly sent: { method: string; params: unknown }[] = [];
  openCalls = 0;
  closeCalls = 0;
  private notifications:
    | ((event: CodexServerNotificationV1) => void)
    | null = null;
  private turnStarted = false;

  open(): void {
    this.openCalls++;
  }

  send(method: string, params: unknown): Promise<unknown> {
    this.sent.push({ method, params });
    switch (method) {
      case "initialize":
        return Promise.resolve({ userAgent: "codex-app-server/0.153.4" });
      case "thread/start":
        return Promise.resolve({
          thread: { id: "thread-1" },
          model: "gpt-5.6-luna",
          reasoningEffort: "max",
          modelProvider: "sentinel-host",
        });
      case "turn/start":
        this.turnStarted = true;
        return Promise.resolve({ turn: { id: "turn-1" } });
      case "turn/interrupt":
        return Promise.resolve({});
      default:
        return Promise.resolve({});
    }
  }

  notify(method: string, params?: unknown): void {
    this.sent.push({ method, params: params ?? {} });
  }

  onNotification(handler: (event: CodexServerNotificationV1) => void): void {
    this.notifications = handler;
    if (this.turnStarted) {
      // The real app-server emits the terminal event only after the listener
      // is registered inside awaitSettlement; the fake mirrors that order.
      // A completed run requires genuine correlated output evidence: one
      // successful file-change item for the exact thread/turn, delivered
      // before the terminal event (never notification-byte counts).
      queueMicrotask(() => {
        this.notifications?.({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "ok-output",
              type: "fileChange",
              status: "completed",
              changes: [{
                path: "src/app.ts",
                kind: { type: "update" },
                diff:
                  "@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n",
              }],
            },
          },
        });
        this.notifications?.({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", durationMs: 5 },
          },
        });
      });
    }
  }

  onServerRequest(): void {}

  close(): Promise<void> {
    this.closeCalls++;
    return Promise.resolve();
  }
}

function sessionVerifier(evidence: {
  threadModel: string | null;
  threadModelProvider: string | null;
  threadEffort: string | null;
  terminal: { status: string | null };
}):
  | { provider: string; observedModel: string; observedReasoning: string }
  | null {
  if (
    evidence.threadModel === "gpt-5.6-luna" &&
    evidence.threadEffort === "max" &&
    evidence.terminal.status === "completed"
  ) {
    return {
      provider: evidence.threadModelProvider ?? "sentinel-host",
      observedModel: "gpt-5.6-luna",
      observedReasoning: "max",
    };
  }
  return null;
}

/** Exact-head fake GitHub: each head gets its own PR number. */
class ExactHeadFakeGithub extends FakeGithub {
  private prByHead = new Map<GitSha, number>();
  private nextPr = 7;
  readonly mergedHeads: GitSha[] = [];
  readonly publishedHeads: GitSha[] = [];

  override pushHead(
    ref: string,
    sha: GitSha,
    expectedRef: GitSha | null,
  ): Promise<PortResultV1<"applied" | "ambiguous">> {
    this.publishedHeads.push(sha);
    return super.pushHead(ref, sha, expectedRef);
  }

  override createPullRequest(_request: unknown): Promise<
    PortResultV1<{
      outcome: "applied" | "ambiguous";
      number: number | null;
      head: GitSha | null;
    }>
  > {
    const request = _request as { expectedHeadRef: GitSha };
    const head = request.expectedHeadRef;
    let number = this.prByHead.get(head);
    if (number === undefined) {
      number = this.nextPr++;
      this.prByHead.set(head, number);
    }
    this.calls.push(`createPr:${number}`);
    return Promise.resolve(portOk({ outcome: "applied", number, head }));
  }

  override mergePullRequest(_request: unknown): Promise<
    PortResultV1<MergeOutcomeV1>
  > {
    const request = _request as { expectedHead: GitSha };
    const head = request.expectedHead;
    this.mergedHeads.push(head);
    return Promise.resolve(portOk({
      outcome: "merged",
      head,
      mergeSha: head,
    }));
  }
}

/** Recording wrapper over the REAL Deno replay runtime (no product logic). */
class RecordingReplayRuntime implements ReplayRuntimeV1 {
  readonly runs: {
    input: ReplayCommandInputV1;
    outcome: string | null;
    exitCode: number | null;
    outputText: string;
  }[] = [];
  constructor(private readonly inner: DenoReplayRuntime) {}

  async run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
    const result = await this.inner.run(input);
    this.runs.push({
      input,
      outcome: result.outcome,
      exitCode: result.exitCode,
      outputText: new TextDecoder().decode(result.stdout) +
        new TextDecoder().decode(result.stderr),
    });
    return result;
  }
}

// ---------------------------------------------------------------------------
// Composed repair host fixture.
// ---------------------------------------------------------------------------

function gatewayAuth(): GatewayAuthProviderV1 {
  return {
    headers: () =>
      Promise.resolve(
        {
          ok: true,
          value: { Authorization: "Bearer synthetic-token" },
        } as const,
      ),
  };
}

function composedConfig(repository: RepositoryIdentityV1): RepositoryConfigV1 {
  return parseRepositoryConfigV1({
    version: "v1",
    kind: "repository_config",
    repository,
    baseBranch: "development",
    adapter: { kind: "gateway", baseUrl: "https://ai.ubq.fi" },
    commands: { replay: "replay", test: "test" },
    commandRegistry: {
      version: "v1",
      commands: {
        replay: {
          executable: "deno",
          args: ["task", "replay"],
          maxDurationMs: 60_000,
          maxOutputBytes: 262_144,
        },
        test: {
          executable: "deno",
          args: ["task", "test"],
          maxDurationMs: 60_000,
          maxOutputBytes: 262_144,
        },
      },
    },
    protectedPaths: [],
    build: { projectId: null, acceptance: null },
    secretRef: null,
    liveStartLimits: { perHour: 5, perSevenDays: 20 },
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
    retention: null,
    stabilityPolicy: null,
  });
}

interface CausalRigV1 {
  ctx: Awaited<ReturnType<typeof makeIntegrationCtx>>;
  clock: FakeClock;
  store: ReturnType<typeof createRepairStateStore>;
  github: ExactHeadFakeGithub;
  transport: ReturnType<typeof recordingTransport>;
  gatewayStore: LocalArtifactStore;
  sessions: FakeCodexSession[];
  replayRuntime: RecordingReplayRuntime;
  options: RepairHostOptionsV1;
  /** Deterministic candidate head the fake implementation delivers. */
  setCandidateHead(head: GitSha): void;
  run(
    deadlineMs?: number,
  ): Promise<Awaited<ReturnType<typeof runComposedRepairHost>>>;
  snapshot(): Promise<RepairStateSnapshotV1>;
  cleanup(): Promise<void>;
}

async function makeCausalRig(
  toy: ToyRepoV1,
  prefix: string,
  options: {
    /**
     * When true the rig builds the CONCRETE trusted local consumer verifier
     * over the toy source (real executions of the committed consumer). A
     * mutateProof wrapper is used ONLY for negative bound-mismatch cases.
     */
    concrete?: boolean;
    mutateProof?: (proof: GatewayCausalProofV1) => GatewayCausalProofV1 | null;
    capture?: { bodyInput?: string; completed?: boolean };
  } = {},
): Promise<CausalRigV1> {
  const ctx = await makeIntegrationCtx(`causal-${prefix}`);
  const clock = new FakeClock(T0);
  const store = createRepairStateStore({
    scratchDir: `${ctx.tmp}/scratch-repair`,
    remoteUrl: ctx.remoteUrl,
  });
  const configs = [composedConfig(REPO)];
  const github = new ExactHeadFakeGithub({ baseSha: toy.originalSha });
  const keyBytes = hexToBytes(
    JSON.parse(
      await Deno.readTextFile(
        new URL("../fixtures/gateway/producer-golden-v2.json", import.meta.url),
      ),
    ).syntheticKeyHex,
  );
  const capture = await craftCapture(
    keyBytes,
    toy.originalSha,
    T0,
    options.capture,
  );
  const row = makeIndexRow({
    incident_id: INCIDENT_A,
    fingerprint: capture.fingerprint,
    failing_revision: toy.originalSha,
    severity: "P1",
    first_seen_at_ms: T0,
    last_seen_at_ms: T0 + 3_000,
    count: 7,
    provenance: {
      endpoint: "https://ai.ubq.fi",
      captured_at_ms: T0,
      captured_by: "gateway",
    },
    evidence_ref: {
      ref: artifactRef(INCIDENT_A, CAPTURE_ID_A),
      digest: capture.digest,
    },
    evidence_expires_at_ms: capture.manifest.expires_at_ms as number,
  });
  const transport = recordingTransport((url) => {
    if (url.pathname === INDEX_PATH) {
      return jsonResponse(makeIndexPage([row]));
    }
    if (url.pathname === REPLAY_PATH) {
      return jsonResponse(makeReplayPage({
        manifest: capture.manifest,
        chunks: capture.chunks,
      }));
    }
    throw new Error(`unexpected gateway transport call: ${url.pathname}`);
  });
  const gatewayStore = new LocalArtifactStore({
    root: `${ctx.tmp}/store`,
    limits: GATEWAY_LIMITS,
  });
  const opened = await gatewayStore.open();
  assert.ok(opened.ok, `store open failed: ${JSON.stringify(opened)}`);

  let candidateHead: GitSha | null = null;
  const sessions: FakeCodexSession[] = [];
  const replayRuntime = new RecordingReplayRuntime(
    new DenoReplayRuntime(Deno.env.get("PATH") ?? "/usr/bin:/bin"),
  );
  // The concrete verifier shares the same recording runtime so the test can
  // observe the actual consumer executions (boundary evidence).
  const concrete = options.concrete === true ||
    options.mutateProof !== undefined;
  const inner = concrete
    ? makeConcreteVerifier(toy, ctx.tmp, replayRuntime)
    : null;
  const verifier = inner === null
    ? undefined
    : options.mutateProof === undefined
    ? inner
    : mutateVerifier(inner, options.mutateProof);
  const optionsBag: RepairHostOptionsV1 = {
    configs,
    controllerSha: SHA1,
    clock,
    state: store,
    github,
    githubCooldown: new DurableGitHubCooldownGate({ state: store, clock }),
    gateway: {
      repository: REPO,
      transport,
      auth: gatewayAuth(),
      store: gatewayStore,
      keyBytes,
      policy: {
        publicModels: ["synthetic-model"],
        publicHeaders: { accept: ["text/event-stream"] },
      },
      commandId: GATEWAY_COMMAND,
      testCommandId: TEST_COMMAND,
      testIds: [TEST_ID],
      expectedFailure: EXPECTED_FAILURE,
      verifier,
    },
    replay: {
      source: { kind: "local", path: toy.root },
      scratchDir: `${ctx.tmp}/replay-scratch`,
      policy: {
        bundleScopes: ["tests/", "scripts/"],
        maxFixtureBytes: 512 * 1024,
        maxEntryBytes: 256 * 1024,
        proof: markerProofParser(),
      },
      isolation: toyIsolation(replayRuntime),
      runtime: replayRuntime,
    },
    model: {
      openSession: () => {
        const session = new FakeCodexSession();
        sessions.push(session);
        return Promise.resolve(session);
      },
      checkoutDir: `${ctx.tmp}/model-checkout`,
      checkout: {
        resolve: () => {
          assert.ok(
            candidateHead !== null,
            "candidate head must be set before the loop runs",
          );
          return Promise.resolve({
            head: candidateHead!,
            checkpointSha: null,
            changedPaths: ["src/app.ts"],
          });
        },
      },
      commitCandidate: { commit: () => Promise.resolve(true) },
      // Explicit selected provider: required before any session opens, and it
      // always binds the concrete request/runtime receipt producer; the
      // verifier below is only an additional restriction after those checks.
      modelProvider: "sentinel-host",
      receiptVerifier: sessionVerifier,
    },
  };
  return {
    ctx,
    clock,
    store,
    github,
    transport,
    gatewayStore,
    sessions,
    replayRuntime,
    options: optionsBag,
    setCandidateHead: (head: GitSha) => {
      candidateHead = head;
    },
    // Default logical allowance (30 logical minutes) covers implementation,
    // full review and entrypoint finalization bounds, still under the
    // production 120-minute ceiling; the fake clock means no wall-clock wait.
    run: (deadlineMs = 1_800_000) =>
      runComposedRepairHost(optionsBag, {
        deadline: clock.now() + deadlineMs,
        stepLimit: 32,
      }),
    snapshot: async () => {
      const read = await store.readRepair();
      assert.ok(read.ok && read.value.status === "found", JSON.stringify(read));
      if (!read.ok || read.value.status !== "found") {
        throw new Error("no repair state");
      }
      return read.value.snapshot;
    },
    cleanup: async () => {
      await ctx.cleanup();
    },
  };
}

/** Resolve the composed fixture + proof through the exact host composition. */
async function resolveComposedFixture(
  rig: CausalRigV1,
): Promise<{
  fixtureRef: string;
  fixtureDigest: FixtureDigest;
  entries: { path: string; bytes: Uint8Array }[];
  proof: GatewayCausalProofV1 | undefined;
}> {
  const deps = composeRepairHost(rig.options);
  const composition = deps.incidents as GatewayReplayComposition;
  const read = await composition.readIncident(INCIDENT_A);
  assert.ok(read.ok && read.value !== null, JSON.stringify(read));
  const resolved = await composition.resolveFixture(
    read.value!.replay!.fixtureRef,
  );
  assert.ok(resolved.ok, JSON.stringify(resolved));
  if (!resolved.ok) throw new Error("fixture resolution failed");
  return {
    fixtureRef: read.value!.replay!.fixtureRef,
    fixtureDigest: read.value!.replay!.fixtureDigest!,
    entries: resolved.value.entries,
    proof: resolved.value.causalProof,
  };
}

async function walkFiles(dir: string, out: string[] = []): Promise<string[]> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) await walkFiles(path, out);
      else out.push(path);
    }
  } catch {
    // directory may not exist (the fake model writes no checkout files)
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "causal capture: one captured request crosses the real repair loop to PR/review intent with a bound proof and zero limitations",
  // True macOS slice: the concrete verifier's embedded sandbox-exec seatbelt
  // profile exists and is supported only on macOS (never skipped on this
  // Mac — only explicit non-macOS CI ignores).
  ignore: Deno.build.os !== "darwin",
  fn: async () => {
    const toy = await makeToyRepo("positive");
    const rig = await makeCausalRig(toy, "positive", {
      concrete: true,
    });
    try {
      // Resolve the composed fixture BEFORE the positive run and commit its
      // exact bytes into the toy candidate (identical permanent fixture).
      const fixture = await resolveComposedFixture(rig);
      assert.notEqual(
        fixture.proof,
        undefined,
        "the concrete verifier must bind a proof",
      );
      const proof = fixture.proof;
      if (proof !== undefined) {
        assert.equal(proof.verifier, GATEWAY_CAUSAL_VERIFIER_ID);
        assert.equal(proof.consumerCommandId, CAUSAL_CONSUMER_COMMAND_ID);
        assert.equal(
          proof.proofRef,
          gatewayCausalProofRef(INCIDENT_A, CAPTURE_ID_A, proof.bundleDigest),
        );
        // Observed execution evidence, distinct from the expected-matcher
        // identity: the concrete verifier actually executed the committed
        // consumer twice and both runs failed for the intended specific
        // failure. The expected-failure identity is a classification label,
        // never an observed execution signature.
        assert.equal(
          proof.expectedFailureIdentity,
          await deriveExpectedFailureIdentity(EXPECTED_FAILURE),
        );
        for (
          const observation of [
            proof.originalObservation,
            proof.sanitizedObservation,
          ]
        ) {
          assert.equal(observation.intended, true);
          assert.match(observation.outputDigest, /^[0-9a-f]{64}$/);
          assert.deepEqual(observation.observedTestIds, [TEST_ID]);
          assert.equal(observation.exitCode, 1);
        }
      }
      const candidateSha = await commitCandidateFixture(toy, fixture.entries);
      assert.notEqual(candidateSha, toy.originalSha);
      rig.setCandidateHead(candidateSha);
      const unrelatedSha = await commitUnrelated(toy);
      assert.notEqual(unrelatedSha, candidateSha);

      const outcome1 = await rig.run();
      assert.equal(outcome1.status, "idle", JSON.stringify(outcome1));
      const state = await rig.snapshot();

      // The incident advanced past missing_evidence through the real loop.
      assert.equal(state.incidents.length, 1);
      const incident = state.work.find((work) =>
        work.source.kind === "incident"
      )!;
      assert.ok(incident, "incident work item must exist");
      assert.equal(incident.related.incidentId, INCIDENT_A);
      assert.equal(incident.failingRevision, toy.originalSha);
      assert.equal(incident.nextStep, "review");
      assert.equal(incident.wait?.reason, "review_pending");
      assert.equal(incident.target.head, candidateSha);
      assert.ok(incident.target.pr !== null, "PR published");

      // Exactly one sequential implementation session for the incident.
      assert.equal(rig.sessions.length, 1);
      assert.equal(rig.sessions[0]!.closeCalls, 1);

      // PR/review publication intent through the fake GitHub transport.
      assert.equal(rig.github.publishedHeads.length, 1);
      assert.equal(rig.github.publishedHeads[0], candidateSha);
      assert.ok(
        rig.github.calls.includes(`createPr:${incident.target.pr}`),
        "PR created",
      );
      assert.ok(
        rig.github.calls.includes("requestReview"),
        "review requested",
      );

      // A durable ReplayResultV1 with exact identities and limitations [].
      assert.equal(state.replays.length, 1);
      const replay = state.replays[0]!;
      assert.equal(replay.repository.owner, REPO.owner);
      assert.equal(replay.repository.name, REPO.name);
      assert.equal(replay.repository.installationId, REPO.installationId);
      assert.equal(replay.original.revision, toy.originalSha);
      assert.equal(replay.original.outcome, "failed");
      assert.equal(replay.original.failure?.intended, true);
      assert.equal(replay.candidate.revision, candidateSha);
      assert.equal(replay.candidate.outcome, "passed");
      assert.equal(replay.fixture.ref, fixture.fixtureRef);
      assert.equal(replay.fixture.digest, fixture.fixtureDigest);
      assert.deepEqual(replay.fixture.testIds, [TEST_ID]);
      assert.equal(replay.commands.replay, GATEWAY_COMMAND);
      assert.equal(replay.commands.test, TEST_COMMAND);
      assert.deepEqual(replay.limitations, []);
      assert.ok(replay.id.length > 0);

      // The retained evidence carries the composed replay identity.
      assert.equal(state.evidence.length, 1);
      assert.equal(state.evidence[0]!.replay?.commandId, GATEWAY_COMMAND);

      // Runtime evidence: the real before-failure and after-pass executions.
      const targetRuns = rig.replayRuntime.runs.filter((run) =>
        run.input.executable === "deno"
      );
      assert.ok(targetRuns.length >= 2, "before + after executions");
      const afterRun = targetRuns[targetRuns.length - 1]!;
      // Every before execution runs the configured replay command at the
      // exact original revision and fails for the intended reason.
      for (const run of targetRuns.slice(0, -1)) {
        assert.deepEqual(run.input.args, ["task", "replay"]);
        assert.equal(run.exitCode, 1, "original revision must fail");
        assert.ok(run.outputText.includes(TEST_ID_MARKER));
        assert.ok(
          run.outputText.includes("stream terminated unexpectedly"),
          "original failure is for the intended reason",
        );
      }
      // The final execution is the candidate's ordinary deno task test.
      assert.deepEqual(afterRun.input.args, ["task", "test"]);
      assert.equal(afterRun.exitCode, 0, "candidate task test must pass");
      assert.ok(afterRun.outputText.includes(TEST_ID_MARKER));

      // The exact composed bundle ran through the concrete verifier: the
      // private original request/upstream and the sanitized bundle both
      // executed the SAME committed consumer at the original SHA under the
      // embedded fixed sandbox-exec seatbelt profile (DENO/SNAPSHOT/CACHE
      // realpath-resolved substitution parameters, cwd = the snapshot) and
      // both failed for the intended specific failure. Each run has its OWN
      // home/cache and sees only its OWN snapshot.
      const verifierRuns = rig.replayRuntime.runs.filter((run) =>
        run.input.executable === CAUSAL_SANDBOX_EXEC_PATH
      );
      assert.ok(verifierRuns.length >= 2, "original + sanitized consumer runs");
      const snapshotParams = verifierRuns.map((run) => {
        const args = run.input.args;
        for (let index = 0; index < args.length - 1; index += 1) {
          if (
            args[index] === "-D" && args[index + 1]!.startsWith("SNAPSHOT=")
          ) {
            return args[index + 1]!.slice("SNAPSHOT=".length);
          }
        }
        return null;
      });
      assert.ok(
        snapshotParams.every((value) =>
          value !== null && value.startsWith("/")
        ),
        "realpath-resolved SNAPSHOT parameters",
      );
      assert.equal(
        new Set(snapshotParams).size,
        verifierRuns.length,
        "each consumer run sees only its own snapshot",
      );
      for (const run of verifierRuns) {
        const args = run.input.args;
        assert.equal(args[0], "-p", "fixed embedded seatbelt profile");
        assert.ok(
          args.includes("--no-config") && args.includes("--no-remote"),
          "fixed no-config/no-remote consumer protocol",
        );
        assert.equal(
          args[args.length - 1],
          `${run.input.cwd}/scripts/replay.ts`,
          "the fixed bound consumer at its own snapshot path",
        );
        assert.ok(
          !args.includes("task"),
          "verifier never runs deno task",
        );
        assert.equal(run.exitCode, 1, "consumer must fail at original SHA");
        assert.ok(run.outputText.includes(TEST_ID_MARKER));
        assert.ok(
          run.outputText.includes("stream terminated unexpectedly"),
          "consumer failure is the intended specific failure",
        );
      }
      const [firstConsumer, secondConsumer] = verifierRuns;
      assert.notEqual(firstConsumer!.input.cwd, secondConsumer!.input.cwd);
      assert.notEqual(
        firstConsumer!.input.env.HOME,
        secondConsumer!.input.env.HOME,
        "no shared home between original and sanitized executions",
      );
      assert.notEqual(
        firstConsumer!.input.env.DENO_DIR,
        secondConsumer!.input.env.DENO_DIR,
        "no shared cache between original and sanitized executions",
      );
      assert.ok(
        firstConsumer!.input.env.HOME.includes("home-original"),
        "original run home is its own",
      );
      assert.ok(
        secondConsumer!.input.env.HOME.includes("home-sanitized"),
        "sanitized run home is its own",
      );

      // The identical permanent fixture ran through the candidate's ordinary
      // deno task test and passed: the committed bytes equal the composed
      // fixture bytes exactly.
      for (const entry of fixture.entries) {
        const committed = await gitRun(
          toy.root,
          ["show", `${candidateSha}:${entry.path}`],
          toy.env,
        );
        assert.ok(
          committed.ok,
          `fixture path missing in candidate: ${entry.path}`,
        );
        assert.deepEqual(
          new TextEncoder().encode(committed.stdout),
          entry.bytes,
          `candidate ${entry.path} must byte-match the composed fixture`,
        );
      }

      // The private sentinel never appears in committed fixture bytes, the
      // candidate Git tree, fake model/session input, public evidence/state
      // or the composed fixture bytes.
      const treeGrep = await gitRun(
        toy.root,
        ["grep", "-l", SENTINEL, candidateSha, "--", "."],
        toy.env,
      );
      assert.ok(
        treeGrep.code !== 0,
        `sentinel leaked into the candidate tree: ${treeGrep.stdout}`,
      );
      assert.ok(!JSON.stringify(fixture.entries).includes(SENTINEL));
      assert.ok(!JSON.stringify(state).includes(SENTINEL));
      assert.ok(
        !JSON.stringify(rig.sessions[0]!.sent).includes(SENTINEL),
        "sentinel leaked into fake model/session input",
      );
      const checkoutFiles = await walkFiles(`${rig.ctx.tmp}/model-checkout`);
      for (const file of checkoutFiles) {
        const text = await Deno.readTextFile(file);
        assert.ok(
          !text.includes(SENTINEL),
          `sentinel leaked into model checkout: ${file}`,
        );
      }

      // Read-only producer transport; one retained encrypted artifact.
      rig.transport.assertReadOnly([INDEX_PATH, REPLAY_PATH]);
      rig.transport.assertNoWriteEndpoints();
      const storeStats = await rig.gatewayStore.stats();
      assert.ok(storeStats.ok && storeStats.value.count === 1);
    } finally {
      await rig.cleanup();
      await toy.cleanup();
    }
  },
});

Deno.test(
  "causal capture: no verifier/proof keeps the redacted fixture blocked at missing_evidence",
  async () => {
    const toy = await makeToyRepo("noverifier");
    const rig = await makeCausalRig(toy, "noverifier");
    try {
      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));
      const state = await rig.snapshot();
      const incident = state.work.find((work) =>
        work.source.kind === "incident"
      )!;
      assert.equal(incident.nextStep, "blocked");
      assert.equal(incident.blocker?.kind, "missing_evidence");
      assert.equal(rig.sessions.length, 0, "no implementation admitted");
      assert.equal(state.replays.length, 0, "no fabricated clean replay");
      assert.equal(
        rig.github.calls.some((call) =>
          call === "createPr" || call.startsWith("push:")
        ),
        false,
        "no publication without a bound proof",
      );
      // The fixture stays redacted and the loop's before-run recorded the
      // truthful limitation.
      assert.equal(
        rig.replayRuntime.runs.filter((run) => run.input.executable === "deno")
          .length,
        1,
        "one bound redacted before-run, no other target command",
      );
    } finally {
      await rig.cleanup();
      await toy.cleanup();
    }
  },
);

Deno.test({
  name:
    "causal capture: mismatched proof identities (bundle digest, original SHA) stay blocked as missing evidence",
  ignore: Deno.build.os !== "darwin",
  fn: async () => {
    const variants: Array<{
      name: string;
      verifier: (m: GatewayCausalProofV1) => GatewayCausalProofV1 | null;
    }> = [
      {
        name: "wrong bundle digest",
        verifier: (proof) => ({
          ...proof,
          bundleDigest: asFixtureDigest("d".repeat(64)),
        }),
      },
      {
        name: "wrong original SHA",
        verifier: (proof) => ({
          ...proof,
          originalGitSha: asGitSha("2".repeat(40)),
        }),
      },
    ];
    for (const variant of variants) {
      const slug = `mismatch-${variant.name.replaceAll(" ", "-")}`;
      const toy = await makeToyRepo(slug);
      const rig = await makeCausalRig(toy, slug, {
        concrete: true,
        mutateProof: variant.verifier,
      });
      try {
        const first = await rig.run();
        assert.equal(first.status, "idle", JSON.stringify(first));
        const state = await rig.snapshot();
        const incident = state.work.find((work) =>
          work.source.kind === "incident"
        )!;
        assert.equal(
          incident.nextStep,
          "blocked",
          `${variant.name} must stay blocked`,
        );
        assert.equal(
          incident.blocker?.kind,
          "missing_evidence",
          `${variant.name} must block on missing evidence`,
        );
        assert.equal(rig.sessions.length, 0, "no implementation admitted");
        assert.equal(state.replays.length, 0, "no clean replay fabricated");
      } finally {
        await rig.cleanup();
        await toy.cleanup();
      }
    }
  },
});

Deno.test({
  name:
    "causal capture: a redaction-damaged (text-dependent) capture cannot be causally proved and stays blocked",
  ignore: Deno.build.os !== "darwin",
  fn: async () => {
    const toy = await makeToyRepo("textdamage");
    const rig = await makeCausalRig(toy, "textdamage", {
      concrete: true,
      capture: {
        completed: true,
        bodyInput:
          `{"model":"synthetic-model","input":"${TRIGGER}","stream":true}`,
      },
    });
    try {
      // The verifier refuses a proof when the sanitized fixture loses the
      // private trigger: the fixture cannot reproduce the original failure.
      const fixture = await resolveComposedFixture(rig);
      assert.equal(
        fixture.proof,
        undefined,
        "redaction-damaged fixture must carry no trusted proof",
      );
      // The private trigger and sentinel stay out of the composed fixture.
      assert.ok(!JSON.stringify(fixture.entries).includes(TRIGGER));
      assert.ok(!JSON.stringify(fixture.entries).includes(SENTINEL));

      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));
      const state = await rig.snapshot();
      const incident = state.work.find((work) =>
        work.source.kind === "incident"
      )!;
      assert.equal(incident.nextStep, "blocked");
      assert.equal(incident.blocker?.kind, "missing_evidence");
      assert.equal(rig.sessions.length, 0);
      assert.equal(state.replays.length, 0);
    } finally {
      await rig.cleanup();
      await toy.cleanup();
    }
  },
});

Deno.test({
  name:
    "causal capture: an unrelated candidate failure never publishes and never fabricates a clean replay",
  ignore: Deno.build.os !== "darwin",
  fn: async () => {
    const toy = await makeToyRepo("unrelated");
    const rig = await makeCausalRig(toy, "unrelated", {
      concrete: true,
    });
    try {
      const fixture = await resolveComposedFixture(rig);
      assert.notEqual(fixture.proof, undefined);
      await commitCandidateFixture(toy, fixture.entries);
      const unrelatedSha = await commitUnrelated(toy);
      rig.setCandidateHead(unrelatedSha);

      // Direct boundary evidence: the identical fixture fails INTENDED at the
      // exact original revision with zero limitations, and the unrelated
      // revision never matches the expected failure.
      const deps = composeRepairHost(rig.options);
      const beforeRunExact = await (deps.replay as ReplayPortImpl).runReplay({
        taskId: "incident:gateway-causal-0001" as WorkItemId,
        repository: REPO,
        revision: toy.originalSha,
        commandId: GATEWAY_COMMAND,
        fixtureRef: fixture.fixtureRef,
        fixtureDigest: fixture.fixtureDigest,
        testIds: [TEST_ID],
        outputLimitBytes: 262_144,
      });
      assert.ok(beforeRunExact.ok, JSON.stringify(beforeRunExact));
      if (beforeRunExact.ok) {
        assert.equal(beforeRunExact.value.outcome, "failed");
        assert.equal(beforeRunExact.value.failure?.intended, true);
        assert.deepEqual(beforeRunExact.value.limitations, []);
      }
      const unrelatedRun = await (deps.replay as ReplayPortImpl).runReplay({
        taskId: "incident:gateway-causal-0001" as WorkItemId,
        repository: REPO,
        revision: unrelatedSha,
        commandId: TEST_COMMAND,
        fixtureRef: fixture.fixtureRef,
        fixtureDigest: fixture.fixtureDigest,
        testIds: [TEST_ID],
        outputLimitBytes: 262_144,
      });
      assert.ok(unrelatedRun.ok, JSON.stringify(unrelatedRun));
      if (unrelatedRun.ok) {
        assert.equal(unrelatedRun.value.outcome, "failed");
        assert.equal(unrelatedRun.value.failure?.intended, false);
      }

      // The full loop with the unrelated head: no publication, no fabricated
      // clean replay, and no review request; the record stays non-terminal.
      const first = await rig.run();
      assert.ok(
        first.status === "idle" || first.status === "step_limit",
        JSON.stringify(first),
      );
      const state = await rig.snapshot();
      const incident = state.work.find((work) =>
        work.source.kind === "incident"
      )!;
      assert.notEqual(incident.nextStep, "review", "never reviewed");
      assert.ok(rig.sessions.length >= 1, "implementation attempted");
      assert.equal(state.replays.length, 0);
      assert.equal(rig.github.publishedHeads.length, 0, "never published");
      assert.equal(
        rig.github.calls.some((call) => call === "requestReview"),
        false,
        "no review request for an unrelated failure",
      );
    } finally {
      await rig.cleanup();
      await toy.cleanup();
    }
  },
});
