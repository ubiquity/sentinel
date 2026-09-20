/**
 * Wave C composed local lifecycle acceptance (MASTER-PLAN.md §9.1 items 1–2)
 * through the ACTUAL host-runner seams (`src/host/run.ts`) composed over
 * real module constructors, injected fake external transports and disposable
 * REAL local Git repositories.
 *
 * ONE composed trusted host drives the whole repair lifecycle:
 *
 *   runComposedRepairHost(options, { deadline, stepLimit })
 *     → runRepairEntrypoint(composeRepairHost(options), ...)
 *
 * with: the real GatewayIncidentAdapter + real LocalArtifactStore +
 * GatewayReplayComposition over a recording scripted producer transport; the
 * real ReplayPortImpl (credential-free git, disposable scratch clones, real
 * `deno task test` executions at exact revisions); the real
 * CodexImplementationPort with an injected in-process fake Codex session and
 * a trusted-host receipt verifier that certifies ONLY the app-server
 * evidence the session itself acknowledged (gpt-reserve / max / completed);
 * the real GitStateStore (repair + release roles on one disposable bare
 * remote) with the real RollingStartBudget/DurableGitHubCooldownGate; and
 * the recording FakeGithub port (exact-head merge, per-head PR numbers) with
 * a second eligible issue work item injected through the real issue intake.
 *
 * Scope covered:
 * - unresolved incident discovery (real adapter over the producer wire) and
 *   retained evidence/replay composition (authenticated decrypt →
 *   structural sanitizer → deterministic trusted fixture);
 * - before-failure fixture path AS FAR AS THE TRUTHFUL REDACTION CONTRACT
 *   PERMITS: the composed gateway fixture is provenance-redacted, so a real
 *   replay of the exact original revision fails for the intended reason AND
 *   carries the truthful `fixture_redacted` limitation; the repair loop's
 *   bound fixture-metadata consumer runs the replay and blocks on that
 *   limitation — no implementation is invented and no gate is weakened. The SAME composed
 *   ReplayPortImpl is then invoked directly at the exact original and toy
 *   candidate revisions to prove the redacted before-failure and
 *   after-pass outcomes truthfully (the after pass carries the SAME
 *   redaction limitation, never a fabricated clean replay); the clean
 *   non-redacted before/after proof is owned by the m03 module suite with a
 *   trusted non-redacted fixture bundle.
 * - one implementation result per issue work item (real Codex port,
 *   injected session/verifier/checkout seams — NO model call, NO network),
 *   deterministic PR publication, pending review, a SECOND eligible work
 *   item advanced by the SAME single writer while the first review waits
 *   (sequential sessions; no duplicate review request or extra budget
 *   charge on observation), later completed review bound to the EXACT head,
 *   exact-head merge, and one open release request per merged item;
 * - deterministic release promotion/monitoring/acceptance through the real
 *   runReleaseEntrypoint over the composeReleaseHost dependency set (with
 *   the trusted host clock-advancing waiter, the same integration-helper
 *   pattern) and the authenticated fixture-bound GitHub build-receipt wire
 *   (immutable receipt archive, scripted fetch on api.github.com only) and
 *   the scripted Deno platform (204 promotion, exact identity proof,
 *   60×30s continuous samples, accepted record);
 * - issue/delivery bookkeeping: the accepted request's issue is closed
 *   (closure-only retry semantics) and the record reaches `done`; the
 *   second (receipt-less) request stays in its typed unavailable wait and the
 *   redaction-limited incident stays blocked on missing evidence;
 * - the truthful release-receipt boundary: the ONLY authentic build receipt
 *   available in this harness is the immutable fixture receipt bound to the
 *   fixture producer commit, so requests for any other merged revision
 *   cannot resolve a receipt (the composed release host reports the typed
 *   waiting detail and performs zero Deno platform calls/promotions) — a
 *   live authentic GitHub receipt for the exact merged SHA is the recorded
 *   activation boundary, never invented here.
 *
 * Every external transport is the injected fake: no real model, network,
 * GitHub, Deno Deploy or credential is used; every outbound call is recorded
 * and asserted to be GET-only against the frozen producer/index paths (no
 * claim/ack/defer), api.github.com/objects.githubusercontent.com for the
 * fixture wire, and the scripted Deno hosts for the platform.
 */
import assert from "node:assert/strict";

import { artifactRef } from "../../src/adapters/gateway/incident-adapter.ts";
import { GatewayReplayComposition } from "../../src/adapters/gateway/replay-composition.ts";
import type { GatewayAuthProviderV1 } from "../../src/adapters/gateway/http.ts";
import {
  type ArtifactStoreLimitsV1,
  LocalArtifactStore,
} from "../../src/adapters/gateway/store.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { CommandId, WorkItemId } from "../../src/contracts/brands.ts";
import type {
  MergeOutcomeV1,
  MergeRequestV1,
  PortResultV1,
  PullRequestCreateV1,
  PullRequestPublishV1,
} from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import { parseRepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { ReleaseRecordV1 } from "../../src/contracts/release.ts";
import type { ReleaseCycleResultV1 } from "../../src/release/controller.ts";
import { DenoReleaseRESTClient } from "../../src/release/port.ts";
import { GithubBuildReceiptResolver } from "../../src/release/build-receipt-resolver.ts";
import type { ReleaseEntrypointDepsV1 } from "../../src/release-main.ts";
import { runReleaseEntrypoint } from "../../src/release-main.ts";
import { markerProofParser } from "../../src/replay/fixture.ts";
import type { ReplayRuntimeV1 } from "../../src/replay/runtime.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import { ReplayPortImpl } from "../../src/replay/port.ts";
import type { CodexSessionV1 } from "../../src/repair/codex-transport.ts";
import type { CodexServerNotificationV1 } from "../../src/repair/codex-transport.ts";
import { CodexImplementationPort } from "../../src/repair/model-port.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import type { RepairHostOptionsV1 } from "../../src/host/repair.ts";
import { composeRepairHost } from "../../src/host/repair.ts";
import type { ReleaseHostOptionsV1 } from "../../src/host/release.ts";
import { composeReleaseHost } from "../../src/host/release.ts";
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
  acceptedEvent,
  asTransport,
  DEP_0,
  promoteRoute,
  ScriptedTransport,
  stabilityPolicy,
  storeAt,
  targetConfig,
  terminalEvent,
  TestClock,
} from "../release/helpers.ts";
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
  exactCandidateLifecycle,
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
const EXPECTED_FAILURE = {
  reason: "fixture reproduced the recorded upstream failure",
  match: { kind: "contains" as const, text: "stream terminated unexpectedly" },
};

/** Immutable fixture truth (see tests/fixtures/release/build-receipt-upload-v1.json). */
const RECEIPT_FIXTURE = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../fixtures/release/build-receipt-upload-v1.json",
      import.meta.url,
    ),
  ),
) as {
  producerCommit: string;
  workflowBlobSha: string;
  archiveSize: number;
  archiveDigest: string;
  archiveBase64: string;
};

const PRODUCER_COMMIT = RECEIPT_FIXTURE.producerCommit as GitSha;
const WORKFLOW_SHA = RECEIPT_FIXTURE.workflowBlobSha as GitSha;
const ARCHIVE_BYTES = Uint8Array.from(
  atob(RECEIPT_FIXTURE.archiveBase64),
  (character) => character.charCodeAt(0),
);
const ARCHIVE_SIZE = RECEIPT_FIXTURE.archiveSize;
const ARCHIVE_DIGEST = RECEIPT_FIXTURE.archiveDigest;

const REPO_FULL = "ubiquity/ai.ubq.fi";
const REPO_ID = 111;
const WORKFLOW_ID = 9999;
const RUN_ID = 12345;
const ATTEMPT = 2;
const BASE_BRANCH = "development";
const STORAGE_URL =
  "https://objects.githubusercontent.com/github-production-release-asset/123/zip?X-Amz-Signature=deadbeef";
const ARTIFACT_ID = 9001;
const TARGET_NAME = `sentinel-build-receipt-${RUN_ID}-${ATTEMPT}`;
const ISSUE1_REVISION_ID = "synthetic-r123";

const GATEWAY_LIMITS: ArtifactStoreLimitsV1 = {
  totalMaxBytes: 1_000_000,
  artifactMaxBytes: 100_000,
  retentionMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
};

// ---------------------------------------------------------------------------
// Producer capture crafting (independent of the decryptor: same frozen
// HKDF/AES-GCM/gzip framing and HMAC identities over public synthetic bytes).
// ---------------------------------------------------------------------------

const RETAINED_NAMESPACE = "uos-sentinel-replay-v1";
const RETAINED_FINGERPRINT_NAMESPACE = "uos-sentinel-replay-v2:fingerprint";
const RETAINED_CASE_GROUP_NAMESPACE = "uos-sentinel-replay-v1:case-group";
const TEXT_ENCODER = new TextEncoder();
const RETAINED_TTL_MS = 48 * 60 * 60 * 1_000;

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

/** One captured gateway incident bound to the real toy original SHA. */
async function craftCapture(
  keyBytes: Uint8Array<ArrayBuffer>,
  originalSha: GitSha,
  capturedAtMs: number,
): Promise<{
  manifest: Record<string, unknown>;
  chunks: string[];
  digest: string;
}> {
  const upstream = {
    version: 1,
    attempts: [{
      provider: "chatgpt_codex",
      status: 200,
      content_type: "text/event-stream",
      chunks_base64: [standardBase64(TEXT_ENCODER.encode(
        'data: {"type":"response.created","response":{"id":"fixture_id_1"}}\n\n',
      ))],
      terminal: "eof",
    }],
    attempts_truncated: false,
    bytes_truncated: false,
    chunks_truncated: false,
  };
  const body = TEXT_ENCODER.encode(
    '{"model":"synthetic-model","input":"public regression fixture","stream":true}',
  );
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
    request_id: "synthetic-request-2",
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
  };
}

// ---------------------------------------------------------------------------
// Real temporary toy target repository (credential-free; original/candidate).
// The permanent regression test is committed in the toy at BOTH revisions and
// reads the sanitized gateway fixture entries (fixed protocol vocabulary), so
// the ReplayPort can execute the configured command at the exact original and
// candidate revisions inside disposable clones of this local source.
// ---------------------------------------------------------------------------

function toyApp(original: boolean): string {
  return original
    ? `/** Toy gateway stream handler (original). */
export function handleStreamTrace(
  _request: unknown,
  upstream: { attempts: { terminal: string; chunks_base64: string[] }[] },
): { status: number; body: string; completed: boolean; payload: string } {
  const attempt = upstream.attempts[0];
  const chunkText = new TextDecoder().decode(
    Uint8Array.from(atob(attempt.chunks_base64[0] ?? ""), (c) => c.charCodeAt(0)),
  );
  // ORIGINAL BUG: an SSE stream that ends (eof) without the completion
  // terminator is treated as a server failure.
  const completed = chunkText.includes('"type":"response.completed"') ||
    chunkText.includes("[DONE]");
  if (!completed) {
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
`
    : `/** Toy gateway stream handler (candidate). */
export function handleStreamTrace(
  _request: unknown,
  upstream: { attempts: { terminal: string; chunks_base64: string[] }[] },
): { status: number; body: string; completed: boolean; payload: string } {
  const attempt = upstream.attempts[0];
  const chunkText = new TextDecoder().decode(
    Uint8Array.from(atob(attempt.chunks_base64[0] ?? ""), (c) => c.charCodeAt(0)),
  );
  // CANDIDATE FIX: the recorded upstream ends after the final data line
  // without a separate terminator; that is a complete stream, not a failure.
  return {
    status: 200,
    body: JSON.stringify({ payload: chunkText.slice(0, 80) }),
    completed: true,
    payload: chunkText.slice(0, 80),
  };
}
`;
}

function toyRegressionTest(): string {
  return `import assert from "node:assert/strict";
import { handleStreamTrace } from "../src/app.ts";

Deno.test("gateway: stream termination honors recorded upstream", async () => {
  console.log("sentinel-replay-test:gateway:stream-termination");
  const base =
    "tests/fixtures/gateway-replay/${INCIDENT_A}/${CAPTURE_ID_A}";
  const request = JSON.parse(
    await Deno.readTextFile(base + "/request.json"),
  );
  const upstream = JSON.parse(
    await Deno.readTextFile(base + "/upstream.json"),
  );
  assert.equal(JSON.parse(request.body).model, "synthetic-model");
  const outcome = handleStreamTrace(request, upstream);
  const body = await outcome.body;
  assert.equal(
    outcome.status,
    200,
    "expected 200 but got " + outcome.status + ": " + body,
  );
  assert.deepEqual(JSON.parse(body), { payload: outcome.payload });
});
`;
}

const TOY_DENO_JSON = JSON.stringify(
  {
    tasks: {
      test: "deno test --allow-read=tests/,src/ tests/",
    },
  },
  null,
  2,
) + "\n";

interface ToyRepoV1 {
  root: string;
  env: Record<string, string>;
  originalSha: GitSha;
  candidateSha: GitSha;
  cleanup(): Promise<void>;
}

async function makeToyRepo(prefix: string): Promise<ToyRepoV1> {
  const root = await Deno.makeTempDir({
    prefix: `sentinel-composed-lifecycle-toy-${prefix}-`,
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
      "src/app.ts": toyApp(true),
      "tests/regression_test.ts": toyRegressionTest(),
    },
    "toy original: missing terminator produces 502",
  );
  const originalSha = await revParse(root, env);
  await commitWith(
    root,
    env,
    { "src/app.ts": toyApp(false) },
    "toy candidate: tolerate missing terminator",
  );
  const candidateSha = await revParse(root, env);
  return {
    root,
    env,
    originalSha,
    candidateSha,
    cleanup: async () => {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// Injected fake external transports (recording, no product logic).
// ---------------------------------------------------------------------------

/** In-process fake Codex app-server session (exact protocol surface). */
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
          model: "gpt-reserve",
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

/**
 * The trusted-host receipt verifier: certifies ONLY the app-server evidence
 * the fake session itself acknowledged (thread metadata + completed turn).
 * A mismatch returns null, which keeps the default fail-closed policy active.
 */
function sessionVerifier(
  evidence: {
    threadModel: string | null;
    threadModelProvider: string | null;
    threadEffort: string | null;
    terminal: { status: string | null };
  },
):
  | { provider: string; observedModel: string; observedReasoning: string }
  | null {
  if (
    evidence.threadModel === "gpt-reserve" &&
    evidence.threadEffort === "max" &&
    evidence.terminal.status === "completed"
  ) {
    return {
      provider: evidence.threadModelProvider ?? "sentinel-host",
      observedModel: "gpt-reserve",
      observedReasoning: "max",
    };
  }
  return null;
}

/** One deterministic candidate identity per implementation call. */
class ScriptedCandidateRegistry {
  private index = 0;
  constructor(
    private readonly heads: readonly GitSha[],
    private readonly changedPaths: readonly string[],
  ) {}

  next(): { head: GitSha; changedPaths: string[] } {
    const head = this.heads[Math.min(this.index, this.heads.length - 1)]!;
    this.index++;
    return { head, changedPaths: [...this.changedPaths] };
  }
}

/** Exact-head fake GitHub: each head gets its own PR number, and a merge
 * returns the EXACT requested head/merge sha (never a stale shortcut). The
 * inherited lifecycle maps own the PR/ref observations, so create and merge
 * delegate to super and every read observes the same exact objects. */
class ExactHeadFakeGithub extends FakeGithub {
  readonly mergedHeads: GitSha[] = [];

  override async createPullRequest(
    request: PullRequestCreateV1,
  ): Promise<PortResultV1<PullRequestPublishV1>> {
    const published = await super.createPullRequest(request);
    // Keep the exact per-head PR allocation in the call recording; the
    // inherited lifecycle fake already allocated it deterministically.
    if (published.ok && published.value.number !== null) {
      this.calls.push(`createPr:${published.value.number}`);
    }
    return published;
  }

  override async mergePullRequest(
    request: MergeRequestV1,
  ): Promise<PortResultV1<MergeOutcomeV1>> {
    this.mergedHeads.push(request.expectedHead);
    // The inherited lifecycle merge closes the exact requested PR on the exact
    // requested head; the merge receipt is never the global last push.
    return await super.mergePullRequest(request);
  }
}

/** Recording wrapper over the REAL Deno replay runtime (no product logic). */
class RecordingReplayRuntime implements ReplayRuntimeV1 {
  readonly runs: {
    executable: string;
    args: string[];
    cwd: string;
    outcome: string | null;
    exitCode: number | null;
    outputText: string;
  }[] = [];
  constructor(private readonly inner: DenoReplayRuntime) {}

  async run(input: Parameters<ReplayRuntimeV1["run"]>[0]) {
    const result = await this.inner.run(input);
    const outputText = new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr);
    this.runs.push({
      executable: input.executable,
      args: [...input.args],
      cwd: input.cwd,
      outcome: result.outcome,
      exitCode: result.exitCode,
      outputText,
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

function composedConfig(
  repository: RepositoryIdentityV1,
): RepositoryConfigV1 {
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
          args: ["task", "test"],
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

interface RepairRigV1 {
  ctx: Awaited<ReturnType<typeof makeIntegrationCtx>>;
  clock: FakeClock;
  store: ReturnType<typeof createRepairStateStore>;
  configs: RepositoryConfigV1[];
  github: ExactHeadFakeGithub;
  transport: ReturnType<typeof recordingTransport>;
  gatewayStore: LocalArtifactStore;
  fingerprint: string;
  candidateRegistry: ScriptedCandidateRegistry;
  sessions: FakeCodexSession[];
  replayRuntime: RecordingReplayRuntime;
  options: RepairHostOptionsV1;
  run(
    deadlineMs?: number,
  ): Promise<Awaited<ReturnType<typeof runComposedRepairHost>>>;
  snapshot(): Promise<RepairStateSnapshotV1>;
  cleanup(): Promise<void>;
}

async function makeRepairRig(
  toy: ToyRepoV1,
  prefix: string,
): Promise<RepairRigV1> {
  const ctx = await makeIntegrationCtx(`composed-${prefix}`);
  const clock = new FakeClock(T0);
  const store = createRepairStateStore({
    scratchDir: `${ctx.tmp}/scratch-repair`,
    remoteUrl: ctx.remoteUrl,
  });
  const configs = [composedConfig(REPO)];
  const github = new ExactHeadFakeGithub({
    baseSha: toy.originalSha,
    issues: [
      {
        number: 1,
        title: "composed issue one",
        body: "issue one body",
        createdAt: T0,
      },
      {
        number: 2,
        title: "composed issue two",
        body: "issue two body",
        createdAt: T0,
      },
    ],
    openIssues: [
      {
        number: 1,
        title: "composed issue one",
        body: "issue one body",
        createdAt: T0,
      },
      {
        number: 2,
        title: "composed issue two",
        body: "issue two body",
        createdAt: T0,
      },
    ],
    // Both produced candidates must be preserved before publication: the
    // explicit lifecycle asserts each exact base/head and the deterministic
    // preservation ref. No intentionally-missing-PR override in the positive
    // setup, so every read observes the same exact created PRs.
    candidateLifecycle: exactCandidateLifecycle(
      { base: toy.originalSha, head: PRODUCER_COMMIT },
      { base: toy.originalSha, head: toy.candidateSha },
    ),
  });
  const keyBytes = hexToBytes(
    JSON.parse(
      await Deno.readTextFile(
        new URL("../fixtures/gateway/producer-golden-v2.json", import.meta.url),
      ),
    ).syntheticKeyHex,
  );
  const capture = await craftCapture(keyBytes, toy.originalSha, T0);
  const row = makeIndexRow({
    incident_id: INCIDENT_A,
    fingerprint: capture.manifest.fingerprint,
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
    evidence_expires_at_ms: capture.manifest.expires_at_ms,
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

  const sessions: FakeCodexSession[] = [];
  const candidateRegistry = new ScriptedCandidateRegistry(
    [PRODUCER_COMMIT, toy.candidateSha],
    ["src/app.ts"],
  );
  const replayRuntime = new RecordingReplayRuntime(
    new DenoReplayRuntime(Deno.env.get("PATH") ?? "/usr/bin:/bin"),
  );
  const options: RepairHostOptionsV1 = {
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
      testIds: [TEST_ID],
      expectedFailure: EXPECTED_FAILURE,
    },
    replay: {
      source: { kind: "local", path: toy.root },
      scratchDir: `${ctx.tmp}/replay-scratch`,
      policy: {
        bundleScopes: ["tests/"],
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
          const candidate = candidateRegistry.next();
          return Promise.resolve({
            head: candidate.head,
            checkpointSha: null,
            changedPaths: candidate.changedPaths,
          });
        },
      },
      // Trusted-host commit seam: the in-process fake session produces no
      // real worktree, so the deterministic candidate identity comes from
      // the checkout resolver and the commit step is acknowledged.
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
    configs,
    github,
    transport,
    gatewayStore,
    fingerprint: capture.manifest.fingerprint as string,
    candidateRegistry,
    sessions,
    replayRuntime,
    options,
    // The positive rig must admit a full declared review bound (10 minutes)
    // plus the five-minute operation margin inside the loop deadline; 60
    // minutes stays under the fixed 120-minute ceiling and the 90-minute model
    // cutoff, and the clock is fake so it costs no real time.
    run: (deadlineMs = 60 * 60_000) =>
      runComposedRepairHost(options, {
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

// ---------------------------------------------------------------------------
// Composed release host fixture (fixture-bound receipt wire + scripted Deno).
// ---------------------------------------------------------------------------

function jsonBody(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface ScriptedFetchV1 {
  fetchImpl: typeof globalThis.fetch;
  calls: { url: URL }[];
}

function scriptedFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): ScriptedFetchV1 {
  const calls: { url: URL }[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url });
    return Promise.resolve(handler(url, init ?? {}));
  };
  return { fetchImpl: fetchImpl as typeof globalThis.fetch, calls };
}

function prPayload(number: number, revision: GitSha, head: GitSha) {
  return {
    number,
    state: "closed",
    merged: true,
    merge_commit_sha: revision,
    head: { sha: head },
    base: {
      ref: BASE_BRANCH,
      sha: "3".repeat(40),
      repo: { id: REPO_ID, full_name: REPO_FULL },
    },
  };
}

function runItem(revision: GitSha) {
  return {
    id: RUN_ID,
    run_attempt: ATTEMPT,
    event: "push",
    status: "completed",
    conclusion: "success",
    head_sha: revision,
    head_branch: BASE_BRANCH,
    workflow_id: WORKFLOW_ID,
    repository: { id: REPO_ID, full_name: REPO_FULL },
    head_repository: { id: REPO_ID, full_name: REPO_FULL },
  };
}

function receiptArtifact() {
  return {
    id: ARTIFACT_ID,
    name: TARGET_NAME,
    size_in_bytes: ARCHIVE_SIZE,
    digest: ARCHIVE_DIGEST,
    expired: false,
    expires_at: "2099-01-01T00:00:00Z",
    workflow_run: {
      id: RUN_ID,
      repository_id: REPO_ID,
      head_repository_id: REPO_ID,
      head_sha: PRODUCER_COMMIT,
      head_branch: BASE_BRANCH,
    },
  };
}

/**
 * Fixture-bound GitHub build-receipt wire. PR 7 (issue one, the fixture
 * producer commit) resolves the immutable receipt; PR 8 (issue two, the toy
 * candidate commit) has no matching push run for its revision, which is the
 * typed "absent" result (never a fabricated receipt).
 */
function receiptFetchHandler(
  toyCandidateSha: GitSha,
): (url: URL) => Response {
  return (url) => {
    const path = url.pathname;
    const revision = url.searchParams.get("head_sha") ??
      url.searchParams.get("ref") ?? "";
    if (path.endsWith("/pulls/7")) {
      return jsonBody(prPayload(7, PRODUCER_COMMIT, PRODUCER_COMMIT));
    }
    if (path.endsWith("/pulls/8")) {
      return jsonBody(prPayload(8, toyCandidateSha, toyCandidateSha));
    }
    if (path.endsWith("/contents/.github/workflows/deno-deploy.yml")) {
      return jsonBody({
        type: "file",
        path: ".github/workflows/deno-deploy.yml",
        sha: WORKFLOW_SHA,
      });
    }
    if (path.endsWith("/actions/workflows/deno-deploy.yml")) {
      return jsonBody({
        id: WORKFLOW_ID,
        path: ".github/workflows/deno-deploy.yml",
        name: "deno-deploy",
      });
    }
    if (/\/workflows\/[0-9]+\/runs$/.test(path)) {
      if (revision === PRODUCER_COMMIT) {
        return jsonBody({
          total_count: 1,
          workflow_runs: [runItem(PRODUCER_COMMIT)],
        });
      }
      return jsonBody({ total_count: 0, workflow_runs: [] });
    }
    if (path.endsWith(`/actions/runs/${RUN_ID}/attempts/${ATTEMPT}`)) {
      return jsonBody(runItem(PRODUCER_COMMIT));
    }
    if (path.endsWith(`/actions/runs/${RUN_ID}/artifacts`)) {
      return jsonBody({ total_count: 1, artifacts: [receiptArtifact()] });
    }
    if (path.endsWith(`/actions/artifacts/${ARTIFACT_ID}/zip`)) {
      return new Response(null, {
        status: 302,
        headers: { location: STORAGE_URL },
      });
    }
    if (path.endsWith("/github-production-release-asset/123/zip")) {
      return new Response(ARCHIVE_BYTES as BodyInit, { status: 200 });
    }
    if (path.endsWith(`/actions/runs/${RUN_ID}`)) {
      return jsonBody(runItem(PRODUCER_COMMIT));
    }
    assert.fail(`unexpected GitHub wire call: ${url.href}`);
  };
}

/** Stable deployment identities for the scripted Deno platform. */
function deployIdentity(
  revisionId: string,
  gitSha: GitSha,
): { gitSha: GitSha; revisionId: string } {
  return { gitSha, revisionId };
}

const PRIOR_IDENTITY = deployIdentity(DEP_0.revisionId, DEP_0.gitSha);
const ISSUE1_IDENTITY = deployIdentity(
  ISSUE1_REVISION_ID,
  PRODUCER_COMMIT,
);

/**
 * Real release host options over the shared ctx: release-role real Git state,
 * real DenoReleaseRESTClient over the scripted platform, and — when
 * `withResolver` — the authenticated fixture-bound resolver (the ONLY
 * authentic receipt available in this harness).
 */
function makeReleaseRig(
  ctx: Awaited<ReturnType<typeof makeIntegrationCtx>>,
  toyCandidateSha: GitSha,
  withResolver: boolean,
): {
  clock: TestClock;
  transport: ScriptedTransport;
  wire: ScriptedFetchV1;
  deps: ReleaseEntrypointDepsV1;
  options: ReleaseHostOptionsV1;
  run(): Promise<PortResultV1<ReleaseCycleResultV1>>;
  records(): Promise<ReleaseRecordV1[]>;
  promoteCalls(): number;
} {
  const config = targetConfig({ projectId: "ai-ubq-fi" });
  const transport = new ScriptedTransport(config);
  registerREST(transport, [PRIOR_IDENTITY, ISSUE1_IDENTITY]);
  transport.health();
  integrationLogRoute(transport, { accept: 100, fiveXx: 1 });
  promoteRoute(transport, ISSUE1_IDENTITY, {});
  const clock = new TestClock(T0);
  const store = storeAt(ctx, "composed-release", "release");
  const wire = scriptedFetch(receiptFetchHandler(toyCandidateSha));
  const resolver = withResolver
    ? {
      repository: REPO,
      environment: "production" as const,
      project: "ai-ubq-fi",
      baseBranch: BASE_BRANCH,
      workflowBlobSha: WORKFLOW_SHA,
      auth: {
        authorizationHeader: () => Promise.resolve(portOk("Bearer test-token")),
      },
      fetch: wire.fetchImpl,
      timeoutMs: 10_000,
    }
    : undefined;
  const options: ReleaseHostOptionsV1 = {
    clock,
    stateRead: store,
    stateWrite: store,
    repository: REPO,
    environment: "production",
    target: config,
    policy: stabilityPolicy(),
    deno: {
      transport: asTransport(transport),
      auth: {
        bearerToken: () => Promise.resolve(portOk("synthetic-token")),
      },
    },
    resolver,
  };
  const deps = composeReleaseHost(options);
  return {
    clock,
    transport,
    wire,
    deps,
    options,
    // The production release entrypoint waits on real 30-second timers.
    // Inject the trusted host's clock-advancing waiter (the exact existing
    // integration-helper pattern) so the complete 60×30s monitoring window
    // is exercised deterministically through the real entrypoint without a
    // 30-minute wall-clock run.
    run: () =>
      runReleaseEntrypoint({
        ...deps,
        wait: (durationMs) => {
          clock.advance(durationMs);
          return Promise.resolve();
        },
      }),
    records: async () => {
      const read = await store.readRelease();
      if (!read.ok || read.value.status !== "found") return [];
      return read.value.snapshot.releases;
    },
    promoteCalls: () =>
      transport.callCount("POST", /^\/v2\/revisions\/[^/]+\/promote$/),
  };
}

/** Exact self-consistent Deno REST contract for the composed project id. */
function registerREST(
  transport: ScriptedTransport,
  deployments: readonly { gitSha: GitSha; revisionId: string }[],
): void {
  transport.revisions = [...deployments];
  transport.route({
    method: "GET",
    pathname: "/v2/apps/ai-ubq-fi/revisions",
    respond: (url) => {
      if (url.searchParams.get("status") !== "succeeded") {
        return { kind: "reject" };
      }
      return {
        kind: "response",
        status: 200,
        body: JSON.stringify(
          deployments.map((identity) => ({
            id: identity.revisionId,
            status: "succeeded",
            labels: { "custom.branch": "main" },
            created_at: "2026-09-07T00:00:00.000Z",
          })),
        ),
      };
    },
  });
  for (const identity of deployments) {
    transport.route({
      method: "GET",
      pathname: `/v2/revisions/${identity.revisionId}`,
      respond: () => ({
        kind: "response",
        status: 200,
        body: JSON.stringify({
          id: identity.revisionId,
          status: "succeeded",
          labels: { "custom.branch": "main" },
        }),
      }),
    });
  }
}

/**
 * Exact revision-id → identity log cohort (the m05 module route only knows
 * the DEP_0/DEP_1 pair; this integration must serve the exact fixture-bound
 * revision ids or every window sample would be incomplete).
 */
function integrationLogRoute(
  transport: ScriptedTransport,
  options: { accept: number; fiveXx: number },
): void {
  const byRevisionId = new Map([
    [PRIOR_IDENTITY.revisionId, PRIOR_IDENTITY],
    [ISSUE1_IDENTITY.revisionId, ISSUE1_IDENTITY],
  ]);
  transport.any("GET", new RegExp("^/v2/apps/[^/]+/logs$"), (url) => {
    const revisionId = url.searchParams.get("revision_id") ?? "dep-0000";
    const start = Date.parse(url.searchParams.get("start") ?? "0");
    const identity = byRevisionId.get(revisionId) ?? PRIOR_IDENTITY;
    const logs: string[] = [];
    for (let i = 0; i < options.accept; i++) {
      logs.push(
        acceptedEvent({
          requestId: `${revisionId}-acc-${i}`,
          timestamp: start + i,
          identity,
        }),
      );
    }
    const failures = identity === PRIOR_IDENTITY ? 0 : options.fiveXx;
    for (let i = 0; i < failures; i++) {
      logs.push(
        terminalEvent({
          requestId: `${revisionId}-acc-${i}`,
          timestamp: start + i,
          identity,
          status: 502,
        }),
      );
    }
    for (let i = failures; i < options.accept; i++) {
      logs.push(
        terminalEvent({
          requestId: `${revisionId}-acc-${i}`,
          timestamp: start + i,
          identity,
          status: 200,
        }),
      );
    }
    return {
      kind: "response",
      status: 200,
      body: JSON.stringify({
        logs: logs.map((message, index) => ({
          timestamp: new Date(start + index).toISOString(),
          level: "info",
          message,
          revision_id: revisionId,
        })),
        next_cursor: null,
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

Deno.test(
  "composed host: exact capability identity and boundary preservation",
  async () => {
    const toy = await makeToyRepo("identity");
    const rig = await makeRepairRig(toy, "identity");
    try {
      const deps = composeRepairHost(rig.options);
      // The composition is BOTH the IncidentAdapter and the fixture-identity
      // source; the replay port resolves fixtures through that exact instance.
      assert.ok(deps.incidents instanceof GatewayReplayComposition);
      assert.equal(deps.fixtureIdentities, deps.incidents);
      assert.ok(deps.replay instanceof ReplayPortImpl);
      assert.ok(deps.model instanceof CodexImplementationPort);
      assert.ok(deps.budget instanceof RollingStartBudget);
      assert.equal(deps.clock, rig.options.clock);
      assert.equal(deps.state, rig.options.state);
      assert.equal(deps.github, rig.options.github);
      assert.equal(deps.githubCooldown, rig.options.githubCooldown);
      assert.equal(deps.controllerSha, SHA1);
      assert.equal(deps.configs.length, 1);
      // Constructing the factory performed no external effect whatsoever.
      assert.equal(rig.transport.requests.length, 0);
      assert.equal(rig.sessions.length, 0);
      assert.equal(rig.replayRuntime.runs.length, 0);
      assert.equal(rig.github.calls.length, 0);
    } finally {
      await rig.cleanup();
      await toy.cleanup();
    }
  },
);

Deno.test(
  "composed lifecycle: discovery, redacted replay boundary, one implementation, second item while review waits, exact-head merge, release requests, deterministic release acceptance and issue bookkeeping",
  async () => {
    const toy = await makeToyRepo("lifecycle");
    const rig = await makeRepairRig(toy, "lifecycle");
    try {
      const deps = composeRepairHost(rig.options);

      // ---- Run 1: everything through runComposedRepairHost. --------------
      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));

      const state1 = await rig.snapshot();
      // Ingested: one P1 incident + two issue work items (the second is the
      // eligible companion advanced while the first review waits).
      assert.equal(state1.incidents.length, 1);
      assert.equal(state1.incidents[0]!.fingerprint, rig.fingerprint);
      assert.equal(state1.work.length, 3);
      assert.equal(state1.work[0]!.nextStep, "blocked");
      assert.equal(state1.work[0]!.blocker?.kind, "missing_evidence");
      const incident = state1.work.find((work) =>
        work.source.kind === "incident"
      )!;
      assert.ok(incident);
      assert.equal(incident.related.incidentId, INCIDENT_A);
      assert.equal(incident.failingRevision, toy.originalSha);
      // Truthful redaction boundary: the bound fixture resolver reaches the
      // real replay port, which records the redaction limitation and blocks
      // before any implementation can be admitted. No clean replay result is
      // fabricated for the incident.
      assert.equal(incident.nextStep, "blocked");
      assert.equal(incident.blocker?.kind, "missing_evidence");
      assert.equal(
        rig.replayRuntime.runs.filter((run) => run.executable === "deno")
          .length,
        1,
        "the composed loop ran the redacted before replay once",
      );

      // The SAME composed chain is then invoked DIRECTLY to prove the
      // redacted before-failure boundary truthfully at the exact original
      // revision: readIncident → resolveTestIds → composed ReplayPortImpl.
      // This is direct-port evidence of the redaction contract alongside the
      // loop's bound fixture-metadata consumer; it is never mistaken for a
      // clean loop verification.
      const composedRead = await (deps.incidents as GatewayReplayComposition)
        .readIncident(INCIDENT_A);
      assert.ok(composedRead.ok, JSON.stringify(composedRead));
      assert.ok(composedRead.value !== null, JSON.stringify(composedRead));
      if (composedRead.ok && composedRead.value !== null) {
        const beforeIds = await (deps.incidents as GatewayReplayComposition)
          .resolveTestIds(
            composedRead.value.replay!.fixtureRef,
            composedRead.value.replay!.fixtureDigest!,
          );
        assert.ok(beforeIds.ok, JSON.stringify(beforeIds));
        const beforeRun = await (deps.replay as ReplayPortImpl).runReplay({
          taskId: "incident:toy-0001" as WorkItemId,
          repository: REPO,
          revision: toy.originalSha,
          commandId: GATEWAY_COMMAND,
          fixtureRef: composedRead.value.replay!.fixtureRef,
          fixtureDigest: composedRead.value.replay!.fixtureDigest!,
          testIds: [TEST_ID],
          outputLimitBytes: 262_144,
        });
        assert.ok(beforeRun.ok, JSON.stringify(beforeRun));
        if (beforeRun.ok) {
          assert.equal(beforeRun.value.outcome, "failed");
          assert.equal(beforeRun.value.exitCode, 1);
          assert.equal(beforeRun.value.failure?.intended, true);
          assert.deepEqual(beforeRun.value.limitations, ["fixture_redacted"]);
        }
      }
      const issueOne = state1.work.find((work) =>
        work.source.kind === "issue" && work.related.issueNumber === 1
      )!;
      const issueTwo = state1.work.find((work) =>
        work.source.kind === "issue" && work.related.issueNumber === 2
      )!;
      assert.ok(issueOne && issueTwo, "both issues are eligible work items");

      // Retained evidence: the composed replay identity (decrypt → sanitize
      // → deterministic fixture) is attached and the restricted store holds
      // exactly one encrypted artifact.
      assert.equal(state1.evidence.length, 1);
      const evidence = state1.evidence[0]!;
      assert.equal(evidence.incidentId, INCIDENT_A);
      assert.equal(evidence.failingRevision, toy.originalSha);
      assert.ok(evidence.replay, "composed replay metadata attached");
      assert.match(
        evidence.replay!.fixtureRef,
        new RegExp(
          `^fixture://gateway-replay/${INCIDENT_A}/${CAPTURE_ID_A}/[0-9a-f]{64}$`,
        ),
      );
      assert.equal(evidence.replay!.commandId, GATEWAY_COMMAND);
      const storeStats = await rig.gatewayStore.stats();
      assert.ok(
        storeStats.ok && storeStats.value.count === 1,
        "one retained encrypted artifact",
      );

      // The loop's redacted before-run and the DIRECT composed before-run
      // both execute at the exact original revision through the real
      // ReplayPortImpl. The recorded runtime captures two target commands
      // (`deno task test`) in disposable clones of the toy source.
      const targetRuns1 = rig.replayRuntime.runs.filter((run) =>
        run.executable === "deno"
      );
      assert.equal(targetRuns1.length, 2);
      const before = targetRuns1[1]!;
      assert.deepEqual(before.args, ["task", "test"]);
      assert.match(before.cwd, /sentinel-replay-/);
      assert.equal(before.exitCode, 1, "original revision must fail");
      assert.ok(before.outputText.includes(`sentinel-replay-test:${TEST_ID}`));
      assert.ok(
        before.outputText.includes("stream terminated unexpectedly"),
        "failure is for the intended reason",
      );

      // ONE implementation result for the first issue; the SECOND work item
      // advanced by the SAME single writer while the first review waits:
      // sequential session calls, one PR per exact head, one review request
      // each, and the durable budget charge for every start.
      assert.equal(rig.sessions.length, 2, "exactly two sequential sessions");
      assert.equal(rig.sessions[0]!.closeCalls, 1, "session settled");
      assert.equal(rig.sessions[1]!.closeCalls, 1, "session settled");
      assert.equal(issueOne.nextStep, "review");
      assert.equal(issueOne.wait?.reason, "review_pending");
      assert.equal(issueOne.target.head, PRODUCER_COMMIT);
      assert.equal(issueOne.target.pr, 7);
      assert.equal(issueOne.counters.reviewRounds, 1);
      assert.equal(issueTwo.nextStep, "review");
      assert.equal(issueTwo.wait?.reason, "review_pending");
      assert.equal(issueTwo.target.head, toy.candidateSha);
      assert.equal(issueTwo.target.pr, 8);
      assert.equal(issueTwo.counters.reviewRounds, 1);
      assert.equal(rig.github.pushes.length, 2);
      assert.deepEqual(rig.github.pushes.map((push) => push.sha), [
        PRODUCER_COMMIT,
        toy.candidateSha,
      ]);
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        2,
        "one review request per head, no duplicate on observation",
      );
      assert.equal(
        state1.reservations.filter((reservation) =>
          reservation.outcome === "submitted"
        ).length,
        4,
        "implementation + review for both items are charged exactly once",
      );
      assert.equal(
        state1.replays.length,
        0,
        "no clean replay result fabricated",
      );

      // Read-only producer transport: index + replay export only; never a
      // claim/ack/defer or other write endpoint.
      rig.transport.assertReadOnly([INDEX_PATH, REPLAY_PATH]);
      rig.transport.assertNoWriteEndpoints();

      // ---- The SAME composed ReplayPort at the toy candidate revision:
      // the truthful after-pass result (passed WITH the redaction limitation,
      // which the loop never accepts as a clean verification). ------------
      const testIds = await deps.fixtureIdentities?.resolveTestIds(
        evidence.replay!.fixtureRef,
        evidence.replay!.fixtureDigest!,
      );
      assert.ok(testIds?.ok, JSON.stringify(testIds));
      const after = await deps.replay.runReplay({
        taskId: incident.id as WorkItemId,
        repository: REPO,
        revision: toy.candidateSha,
        commandId: "test" as CommandId,
        fixtureRef: evidence.replay!.fixtureRef,
        fixtureDigest: evidence.replay!.fixtureDigest!,
        testIds: [...(testIds!.value as readonly string[])],
        outputLimitBytes: 262_144,
      });
      assert.ok(after.ok, JSON.stringify(after));
      if (after.ok) {
        assert.equal(after.value.outcome, "passed");
        assert.equal(after.value.exitCode, 0);
        assert.deepEqual(after.value.limitations, ["fixture_redacted"]);
      }
      const targetRuns2 = rig.replayRuntime.runs.filter((run) =>
        run.executable === "deno"
      );
      assert.equal(
        targetRuns2.length,
        3,
        "one loop before-run plus one direct before-run and one direct after-run through the same composed ReplayPort",
      );

      // ---- Run 2: the first review completes; issue one merges exactly. --
      rig.clock.advance(15 * 60_000 + 1);
      rig.github.reviewStatus = "completed";
      rig.github.reviewObservations = {
        status: "completed",
        requestId: "review-req-1",
        reviewer: "chatgpt-codex-connector[bot]",
        resultId: "result-1",
        completedAt: rig.clock.now(),
        observedHead: PRODUCER_COMMIT,
        observedBase: toy.originalSha,
        findings: [],
        summary: null,
        receivedAt: rig.clock.now() + 1,
      };
      const second = await rig.run();
      assert.equal(second.status, "idle", JSON.stringify(second));
      const state2 = await rig.snapshot();
      const issueOneAfter = state2.work.find((work) =>
        work.source.kind === "issue" && work.related.issueNumber === 1
      )!;
      const issueTwoAfter = state2.work.find((work) =>
        work.source.kind === "issue" && work.related.issueNumber === 2
      )!;
      // The first completed head merged exactly and waits at the release
      // acceptance consumer; a completed review bound to ANOTHER head never
      // advances issue two.
      assert.equal(issueOneAfter.nextStep, "delivery");
      assert.equal(issueOneAfter.wait?.reason, "unavailable");
      assert.equal(issueTwoAfter.nextStep, "review");
      assert.equal(issueTwoAfter.wait?.reason, "review_pending");
      assert.deepEqual(rig.github.mergedHeads, [PRODUCER_COMMIT]);
      assert.equal(state2.releaseRequests.length, 1);
      const requestOne = state2.releaseRequests[0]!;
      assert.equal(requestOne.revision, PRODUCER_COMMIT);
      assert.equal(requestOne.source.pullRequest, 7);
      assert.equal(requestOne.source.head, PRODUCER_COMMIT);
      assert.equal(requestOne.status, "open");

      // ---- Run 3: the second review completes; issue two merges exactly.
      // Its request can never resolve the immutable receipt (documented as
      // the truthful activation boundary below). --------------------------
      rig.clock.advance(15 * 60_000 + 1);
      rig.github.reviewObservations = {
        status: "completed",
        requestId: "review-req-1",
        reviewer: "chatgpt-codex-connector[bot]",
        resultId: "result-1",
        completedAt: rig.clock.now(),
        observedHead: toy.candidateSha,
        observedBase: toy.originalSha,
        findings: [],
        summary: null,
        receivedAt: rig.clock.now() + 1,
      };
      const third = await rig.run();
      assert.equal(third.status, "idle", JSON.stringify(third));
      const state3 = await rig.snapshot();
      assert.deepEqual(rig.github.mergedHeads, [
        PRODUCER_COMMIT,
        toy.candidateSha,
      ]);
      assert.equal(state3.releaseRequests.length, 2);
      const requestTwo = state3.releaseRequests.find((request) =>
        request.source.pullRequest === 8
      )!;
      assert.ok(requestTwo);
      assert.equal(requestTwo.revision, toy.candidateSha);
      assert.equal(requestTwo.status, "open");

      // ---- Composed release host WITHOUT a resolver (production default):
      // typed waiting, zero Deno platform calls, zero promotion, zero release
      // records — no authentic credential/receipt is wired into the harness.
      const noResolver = makeReleaseRig(rig.ctx, toy.candidateSha, false);
      const waiting = await noResolver.run();
      assert.ok(waiting.ok, JSON.stringify(waiting));
      if (waiting.ok) {
        assert.equal(waiting.value.status, "waiting");
        assert.equal(waiting.value.detail, "build receipt is unavailable");
      }
      assert.equal(
        noResolver.transport.calls.length,
        0,
        "no Deno platform call",
      );
      assert.equal(noResolver.promoteCalls(), 0, "no promotion attempt");
      assert.equal((await noResolver.records()).length, 0, "no release record");

      // ---- Composed release host WITH the authenticated fixture wire: the
      // first request (fixture producer commit) resolves the immutable
      // receipt, promotes (204), proves the exact managed identity and the
      // scheduled entrypoint completes the 60×30s monitoring window before
      // returning. --------------------------------------------------------
      const released = makeReleaseRig(rig.ctx, toy.candidateSha, true);
      assert.ok(released.deps.deno instanceof DenoReleaseRESTClient);
      assert.ok(
        released.deps.resolver instanceof GithubBuildReceiptResolver,
      );
      const begun = await released.run();
      assert.ok(begun.ok, JSON.stringify(begun));
      if (begun.ok) assert.equal(begun.value.status, "advanced");
      const done = await released.run();
      assert.ok(done.ok, JSON.stringify(done));
      assert.equal(released.promoteCalls(), 1, "exactly one promotion");
      let records = await released.records();
      assert.equal(records.length, 1);
      const accepted = records[0]!;
      assert.equal(accepted.requestId, requestOne.id);
      assert.equal(accepted.phase, "accepted");
      assert.equal(accepted.candidate.identity.gitSha, PRODUCER_COMMIT);
      assert.equal(accepted.candidate.identity.revisionId, ISSUE1_REVISION_ID);
      assert.equal(accepted.prior.identity.gitSha, DEP_0.gitSha);
      assert.equal(accepted.receipts.promote?.statusCode, 204);
      assert.ok(accepted.acceptance);
      assert.equal(accepted.acceptance!.samples.length, 60);
      assert.equal(accepted.acceptance!.baseline.length, 60);
      assert.equal(accepted.acceptance!.continuous, true);
      assert.equal(accepted.acceptance!.passed, true);
      assert.ok(
        released.transport.calls.every((call) =>
          call.host === "api.deno.com" ||
          call.host === "ai.ubq.fi" ||
          call.host.endsWith(".ubiquity-dao.deno.net")
        ),
        `unexpected Deno host: ${JSON.stringify(released.transport.calls[0])}`,
      );

      // Second cycle: the remaining request has no matching push run for its
      // revision, so the immutable receipt cannot bind (typed waiting/absent);
      // no promotion and no second record is fabricated.
      const secondCycle = await released.run();
      assert.ok(secondCycle.ok, JSON.stringify(secondCycle));
      if (secondCycle.ok) {
        assert.equal(
          secondCycle.value.status === "waiting" ||
            secondCycle.value.status === "idle",
          true,
          JSON.stringify(secondCycle.value),
        );
      }
      assert.equal(released.promoteCalls(), 1, "no second promotion");
      records = await released.records();
      assert.equal(records.length, 1, "no record for the receipt-less request");

      // ---- Run 4: the repair loop observes the accepted release and
      // performs the issue/delivery bookkeeping: the accepted request's issue
      // is closed (closure-only retry) and the record reaches `done`; the
      // receipt-less request stays in its typed unavailable wait while the
      // redaction-limited incident remains blocked on missing evidence. -----
      rig.clock.advance(5 * 60_000 + 1);
      const fourth = await rig.run();
      assert.equal(fourth.status, "idle", JSON.stringify(fourth));
      const state4 = await rig.snapshot();
      const issueOneFinal = state4.work.find((work) =>
        work.source.kind === "issue" && work.related.issueNumber === 1
      )!;
      const issueTwoFinal = state4.work.find((work) =>
        work.source.kind === "issue" && work.related.issueNumber === 2
      )!;
      const incidentFinal = state4.work.find((work) =>
        work.source.kind === "incident"
      )!;
      assert.equal(issueOneFinal.nextStep, "done");
      assert.ok(
        rig.github.calls.includes("closeIssue:1"),
        "issue closure bookkeeping happened",
      );
      assert.equal(issueTwoFinal.nextStep, "delivery");
      assert.equal(
        issueTwoFinal.wait?.reason,
        "unavailable",
        "typed wait at the release acceptance consumer",
      );
      assert.equal(incidentFinal.nextStep, "blocked");
      assert.equal(
        incidentFinal.blocker?.kind,
        "missing_evidence",
        "the redaction-limited incident stays blocked on missing evidence",
      );
      assert.equal(state4.releaseRequests.length, 2);
      // No model start for the incident or after acceptance.
      assert.equal(rig.sessions.length, 2);
      assert.equal(
        state4.reservations.filter((reservation) =>
          reservation.outcome === "submitted"
        ).length,
        4,
      );

      // Every interaction stayed on the injected fake ports/transports.
      assert.ok(
        rig.github.calls.every((call) =>
          /^listOpenIssues$|^readRef:|^readIssue:|^findPr:|^readPr:|^push:|^createPr(?::\d+)?$|^observeReview$|^requestReview$|^merge$|^closeIssue:/
            .test(call)
        ),
        `unexpected github calls: ${rig.github.calls.join(", ")}`,
      );
      assert.ok(
        released.wire.calls.every((call) =>
          call.url.host === "api.github.com" ||
          call.url.host === "objects.githubusercontent.com"
        ),
        "the receipt wire stayed on the scripted GitHub origins",
      );
      assert.ok(
        rig.sessions.every((session) => session.closeCalls === 1),
        "every fake session settled in-process",
      );
    } finally {
      await rig.cleanup();
      await toy.cleanup();
    }
  },
);
